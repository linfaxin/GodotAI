import { isPreviewDiagnostic, isProjectData, previewDiagnostic, type PreviewDiagnostic } from './protocol.js';
import { WORKER_PROTOCOL, isWorkerEnvelope, prepareWorkerRunConfiguration, sameWorkerRun, type WorkerRunIdentity, type WorkerRunConfiguration } from './worker-protocol.js';
import { WorkerSessionLease, WorkerExitLedger, WorkerHeartbeat, boundedWorkerCleanup, type WorkerEngineOutcome } from './worker-session.js';
import { fetchVerifiedAsset, loadVerifiedRuntimeWorker, type VerifiedRelease } from './verified-loader.js';
import { createPresentationHost, type CanvasGeometry } from './worker-presentation.js';
import { createInputHost } from './worker-dom-host.js';
import { WorkerAudioHost } from './worker-audio-host.js';
import { createWorkerBrowserHost } from './worker-browser.js';
import { createWorkerXRHost } from './worker-xr-host.js';
import { WorkerProjectCommandCredits,workerProjectCommandBytes } from './worker-project-channel.js';

export interface WorkerPreviewHostOptions {
  canvas: HTMLCanvasElement;
  /** App policy may verify a mirrored release before any runtime resource loads. */
  verifyRelease?(release: VerifiedRelease, manifest: unknown, signal: AbortSignal): Promise<void>;
  onSnapshot?(snapshot: Readonly<Record<string, unknown>>): void;
}

/** One iframe owns exactly one Worker run. Revocation is independent of channel
 * FIFO, and hard termination does not depend on cooperative native shutdown. */
export function startWorkerPreviewHost(identity: WorkerRunIdentity, editorPort: MessagePort, options: WorkerPreviewHostOptions) {
  const lease = new WorkerSessionLease(), loaderAbort = new AbortController(), ledger = new WorkerExitLedger(identity);
  const heartbeat = new WorkerHeartbeat(performance.now());
  let started = false, ending = false, finalized = false, running = false;
  let configuration: Readonly<WorkerRunConfiguration> | undefined;
  let runtime: Awaited<ReturnType<typeof loadVerifiedRuntimeWorker>> | undefined;
  let control: MessagePort | undefined, data: MessagePort | undefined;
  let presentation: ReturnType<typeof createPresentationHost> | undefined;
  let input: ReturnType<typeof createInputHost> | undefined, browser: ReturnType<typeof createWorkerBrowserHost> | undefined;
  let inputCleanup:Promise<void>|undefined;
  let audio: WorkerAudioHost | undefined;
  let xr: ReturnType<typeof createWorkerXRHost> | undefined, xrCleanup: Promise<void> | undefined;
  let workletUrl: string | undefined;
  let stopTimeoutMs = 1800, cleanupTimeoutMs = 900, stopTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | undefined, geometryEpoch = 0;
  let diagnostic: PreviewDiagnostic | undefined, memory: unknown = null, workerState = 'uncreated';
  let projectRuntime: 'godot' | 'react' | null = null, dataSequence = 0;
  const pendingData = new Set<number>();
  const pendingPresentationData = new Set<number>();
  let projectCommands:WorkerProjectCommandCredits|undefined;
  const workerErrors: string[] = [], glErrors: string[] = [];
  let snapshot: Readonly<Record<string, unknown>>;
  let terminalReport: Readonly<Record<string, unknown>> | undefined;
  let cleanupFault: unknown;
  const disposeSafely = (action: () => void) => { try { action(); } catch (error) { cleanupFault ??= error; } };
  const closeInput=()=>{
    if(inputCleanup||!input)return;
    try{inputCleanup=Promise.resolve(input.dispose());}catch(error){cleanupFault??=error;inputCleanup=Promise.reject(error);}
    void inputCleanup.catch(error=>{cleanupFault??=error;});
  };
  const closeXR = () => {
    if(xrCleanup || !xr)return;
    try { xrCleanup=xr.dispose(); } catch(error){cleanupFault??=error;xrCleanup=Promise.reject(error);}
    void xrCleanup.catch(error=>{cleanupFault??=error;});
  };
  const ownedPorts = new Set<MessagePort>();
  const post = (fields: object) => { if (!finalized) editorPort.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, ...fields }); };
  const toWorker = (fields: object) => control?.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, ...fields });
  const toData = (fields: object) => {
    if (!lease.active || !data) return;
    if (pendingData.size >= (configuration?.budgets.maxInputEvents ?? 1024)) { fail(Error('E_WORKER_INPUT_BACKPRESSURE')); return; }
    const sequence = ++dataSequence; pendingData.add(sequence);
    const type=(fields as {type?:unknown}).type;if(type==='geometry'||type==='present-ack')pendingPresentationData.add(sequence);
    try{data.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, dataSequence: sequence, ...fields });}
    catch(error){pendingData.delete(sequence);pendingPresentationData.delete(sequence);throw error;}
  };
  function publish(): void {
    snapshot = Object.freeze({ schemaVersion: 1, ...identity, executionBackend: 'worker', presentationBackend: configuration?.presentationBackend ?? null,
      workerState, runtime: projectRuntime, runConfiguration: configuration ?? null, closing: ending, memory,
      workerErrors: [...workerErrors], glErrors: [...glErrors], errorObservationScope: 'engine-logs-and-worker-events',
      audio: audio?.snapshot() ?? null, presentationHost: presentation?.stats?.() ?? null,
      projectCommands:projectCommands?.snapshot()??null,
      xr: xr?.snapshot() ?? null, exit: terminalReport ?? ledger.report ?? null });
    try { options.onSnapshot?.(snapshot); } catch { /* Observers do not own lifecycle control. */ }
  }
  function geometry(): CanvasGeometry {
    const rect = (options.canvas.parentElement ?? options.canvas).getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, configuration?.budgets.maxDpr ?? 4);
    return { width: Math.max(0, rect.width), height: Math.max(0, rect.height), left: rect.left, top: rect.top, dpr, epoch: ++geometryEpoch };
  }
  function resize(): void {
    if (!lease.active || !presentation || xr?.active) return;
    try { const next = geometry(); presentation.resize(next); input?.resize(next); toData({ type: 'geometry', geometry: next }); }
    catch (error) { fail(error); }
  }
  function fail(error: unknown): void {
    if (finalized || ending) return;
    diagnostic = previewDiagnostic(error);
    stop('runtime-failed', diagnostic.message);
  }
  function workerFailure(error: unknown): void {
    if(finalized)return;
    const observed=previewDiagnostic(error);diagnostic??=observed;
    if(workerErrors.length<64)workerErrors.push(observed.message);
    // Retain unexpected shutdown failures even after actions were revoked.
    fail(error);
  }
  async function finalize(outcome: WorkerEngineOutcome): Promise<void> {
    if (finalized) return;
    // Mark finalization before awaits. Multiple native/errors/deadline paths
    // cannot create a second cleanup or adoption window.
    finalized = true; ending = true; running = false; lease.cancel(); heartbeat.close();
    projectCommands?.clear();
    pendingData.clear();pendingPresentationData.clear();
    clearTimeout(stopTimer); clearInterval(watchdog); observer?.disconnect();
    removeEventListener('resize', resize); removeEventListener('visibilitychange', visibility);
    removeEventListener('pagehide', pagehide);
    loaderAbort.abort(new DOMException('Worker host closed', 'AbortError'));
    disposeSafely(()=>audio?.mute()); closeInput(); disposeSafely(()=>browser?.dispose()); disposeSafely(()=>presentation?.dispose());
    closeXR();
    if (runtime) { disposeSafely(()=>runtime!.dispose()); runtime = undefined; workerState = outcome.kind === 'native-exit' ? 'native-exited' : 'terminated'; }
    else workerState = 'uncreated';
    ledger.recordEngine(outcome); publish();
    const cleanup = await boundedWorkerCleanup(async () => {
      try {
        const results=await Promise.allSettled([outcome.kind === 'native-exit' && outcome.code === 0 ? audio?.close() : audio?.forceClose(), xrCleanup,inputCleanup]);
        const rejected=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
        if(cleanupFault)throw cleanupFault;if(rejected)throw rejected.reason;
      }
      finally {
        for (const port of ownedPorts) { port.onmessage = null; port.close(); } ownedPorts.clear();
        if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = undefined; }
      }
    }, cleanupTimeoutMs);
    // Closing MessagePorts/Blob URLs remains safe when audio close timed out.
    for (const port of ownedPorts) { port.onmessage = null; port.close(); } ownedPorts.clear();
    if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = undefined; }
    const outcomeReport = ledger.recordCleanup(cleanup)!;
    const report = { ...outcomeReport, ...(diagnostic && outcomeReport.reason === 'clean-exit' ? { reason: 'crashed' } : {}) };
    terminalReport = report; publish();
    editorPort.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, type: 'exit-report', ...report, ...(diagnostic ? { diagnostic } : {}) });
    editorPort.onmessage = null; editorPort.close();
  }
  function terminate(detail?: string): void {
    if (finalized) return;
    const existed = !!runtime;
    if (runtime) { runtime.worker.terminate(); workerState = 'terminated'; }
    if (detail && !diagnostic) diagnostic = previewDiagnostic(detail);
    void finalize(existed ? { kind: 'terminate-issued' } : { kind: 'startup-failed', detail });
  }
  function stop(cause = 'stopped', detail?: string): void {
    if (ending || finalized) return;
    ending = true; lease.cancel(); heartbeat.close(); disposeSafely(()=>audio?.mute());
    if(runtime)stopTimer = setTimeout(() => terminate(detail), stopTimeoutMs);
    // Browser requests cease at the fence; audio is muted synchronously before
    // asking the Worker to quit. stop() also flushes the old audio epoch.
    closeInput(); disposeSafely(()=>browser?.dispose()); observer?.disconnect(); disposeSafely(()=>presentation?.dispose());
    closeXR();
    void audio?.stop().catch(() => {});
    publish();
    if (!runtime) { loaderAbort.abort(new DOMException('Stopped', 'AbortError')); void finalize({ kind: 'startup-failed', detail: detail ?? cause }); return; }
    try { toWorker({ type: 'stop', cause, detail }); }
    catch { terminate(detail); }
  }
  const watchdog = setInterval(() => {
    if (!ending && running && heartbeat.timedOut(performance.now(), 5000)) stop('unresponsive', 'Worker heartbeat stopped');
  }, 250);
  function visibility(): void {
    if (!lease.active) return;
    if (document.hidden) heartbeat.suspend();
    else {
      const resumeEpoch = heartbeat.beginResume(performance.now());
      post({ type: 'visibility', visible: true, resumeEpoch }); toWorker({ type: 'resume', resumeEpoch });
    }
    toData({ type: 'host-state', state: { type: 'dom-state', visible: !document.hidden } });
  }
  function pagehide(): void { audio?.mute(); runtime?.worker.terminate(); workerState = runtime ? 'terminated' : 'uncreated'; stop('host-pagehide'); }
  addEventListener('pagehide', pagehide); addEventListener('visibilitychange', visibility); addEventListener('resize', resize);
  editorPort.onmessage = event => {
    const raw = event.data;
    if (!isWorkerEnvelope(raw) || !sameWorkerRun(raw, identity)) return;
    const m: any = raw;
    if (m.type === 'stop') { stop(m.cause, m.detail); return; }
    if (!lease.active) return;
    if(m.type==='project-receipt'&&Number.isSafeInteger(m.projectSequence)){toWorker({type:'project-receipt',projectSequence:m.projectSequence});return;}
    if (m.type === 'project-command' && running && isProjectData(m.data)) {
      if(!projectCommands?.reserve(m.commandSequence,workerProjectCommandBytes(m.data))){fail(Error('E_WORKER_PROJECT_COMMAND_BACKPRESSURE'));return;}
      try{toWorker({type:'project-command',commandSequence:m.commandSequence,data:m.data});publish();}catch(error){projectCommands.release(m.commandSequence);fail(error);}return;
    }
    if (m.type !== 'run' || started) return;
    started = true; void boot(m);
  };
  editorPort.start(); post({ type: 'connected' }); publish();
  async function boot(message: any): Promise<void> {
    try {
      const frozen = await prepareWorkerRunConfiguration(message.configuration); lease.assertActive();
      configuration = frozen.configuration;
      projectCommands=new WorkerProjectCommandCredits(configuration.budgets.maxProjectEvents!,configuration.budgets.maxProjectBytes!);
      projectRuntime = message.artifact?.manifest?.runtime === 'godot' ? 'godot' : message.artifact?.manifest?.runtime === 'react' ? 'react' : null;
      if (frozen.hash !== identity.runConfigurationHash) throw Error('E_WORKER_CONFIGURATION_HASH');
      const release = message.release as VerifiedRelease;
      if (!release.runtimeAbi || !release.runtimeWorker || !release.runtimeAudioWorklet) throw Error('E_WORKER_RELEASE_ABI');
      if (release.runtimeAbi.host !== configuration.hostAbiVersion || release.runtimeAbi.audio !== configuration.audioAbiVersion || release.runtimeAbi.presentation !== configuration.presentationAbiVersion) throw Error('E_WORKER_RELEASE_ABI');
      if (!(message.artifact?.pack instanceof Uint8Array) || !message.artifact.pack.byteLength || message.artifact.pack.byteLength > 64 * 1024 * 1024) throw Error('E_ARTIFACT_PACK');
      stopTimeoutMs = Number.isFinite(message.stopTimeoutMs) ? Math.max(1, Math.min(10000, message.stopTimeoutMs)) : 2500;
      cleanupTimeoutMs = Number.isFinite(message.cleanupTimeoutMs) ? Math.max(1, Math.min(configuration.budgets.cleanupTimeoutMs, message.cleanupTimeoutMs)) : Math.max(1, configuration.budgets.cleanupTimeoutMs);
      if (options.verifyRelease) { await options.verifyRelease(release, message.artifact.manifest, loaderAbort.signal); lease.assertActive(); }
      const worklet = await fetchVerifiedAsset(release.runtimeAudioWorklet, { signal: loaderAbort.signal, maxBytes: release.maxAssetBytes, cachePolicy: release.cachePolicy }); lease.assertActive();
      workletUrl = URL.createObjectURL(new Blob([worklet.slice().buffer], { type: 'text/javascript' }));
      runtime = await lease.retain(loadVerifiedRuntimeWorker(release.runtimeWorker, { signal: loaderAbort.signal, maxBytes: release.maxAssetBytes, allowedOrigins: release.allowedOrigins, cachePolicy: release.cachePolicy }), resource => resource.dispose()); lease.assertActive();
      workerState = 'created';
      const channels = Array.from({ length: 6 }, () => new MessageChannel());
      for (const channel of channels) { ownedPorts.add(channel.port1); ownedPorts.add(channel.port2); }
      control = channels[0].port1; data = channels[1].port1;
      const initial = geometry();
      presentation = createPresentationHost({ runId: identity.runId, canvas: options.canvas, geometry: initial, mode: configuration.presentationBackend,
        limits: { maxDimension: configuration.budgets.maxCanvasDimension, maxPixels: configuration.budgets.maxCanvasPixels, maxAggregateBytes: configuration.budgets.maxPresentationBytes },
        sendAck: ack => toData(ack), onFatal: fail,benchmarkTimings:configuration.budgets.benchmarkTimingSamples>0 });
      audio = new WorkerAudioHost(channels[2].port1, channels[3].port1, { runId: identity.runId, audioEpoch: 1, workletUrl,
        limits: { sampleBytes: configuration.budgets.audioSampleBytes, pcmBytes: configuration.budgets.audioPcmBytes }, timeoutMs: configuration.budgets.hostSetupTimeoutMs, onError: fail });
      browser = createWorkerBrowserHost({ port: channels[4].port1, onError: fail });
      xr = createWorkerXRHost(channels[5].port1, { identity, buttonRoot: options.canvas.parentElement ?? undefined,
        limits: { maxPixels: configuration.budgets.maxCanvasPixels, maxDimension: configuration.budgets.maxCanvasDimension,
          maxBytes: configuration.budgets.maxPresentationBytes, setupTimeoutMs: configuration.budgets.hostSetupTimeoutMs },
        onGesture: () => { if(lease.active)void audio?.resumeFromGesture().catch(fail); },
        onActiveChange: active => { if (!lease.active) return; if (!active) resize(); publish(); }, onError: fail });
      input = createInputHost({ canvas: options.canvas, geometry: initial, sendInput: packet => toData({ type: 'input', packet }),
        sendState: state => toData({ type: 'host-state', state }), onGesture: () => { if(lease.active)void audio?.resumeFromGesture().catch(fail); }, onError: fail,benchmarkTimings:configuration.budgets.benchmarkTimingSamples>0 });
      control.onmessage = event => {
        const raw = event.data;
        if (!isWorkerEnvelope(raw) || !sameWorkerRun(raw, identity) || finalized) return;
        const m: any = raw;
        if(m.type==='project-command-receipt'&&Number.isSafeInteger(m.commandSequence)){
          if(projectCommands?.release(m.commandSequence)){post({type:'project-command-receipt',commandSequence:m.commandSequence});publish();}return;
        }
        if (m.type === 'native-exit' && Number.isSafeInteger(m.code)) { memory = m.memory ?? memory; void finalize({ kind: 'native-exit', code: m.code }); return; }
        if (m.type === 'worker-termination-required') { terminate('Native startup cannot be cooperatively cleaned'); return; }
        if (m.type === 'worker-fatal') {
          const reported = isPreviewDiagnostic(m.diagnostic) ? m.diagnostic : previewDiagnostic(m.detail);
          diagnostic ??= reported;
          if(workerErrors.length<64)workerErrors.push(reported.message);
          stop('runtime-failed', m.detail); return;
        }
        // Closing revokes actions and project data, but retains bounded native
        // shutdown diagnostics until the genuine exit/termination receipt.
        if (m.type === 'log' && ['log', 'warn', 'error'].includes(m.level) && typeof m.text === 'string' && m.text.length <= 4096) {
          if (/\b(?:WebGL|OpenGL|INVALID_OPERATION|INVALID_FRAMEBUFFER_OPERATION|GL_INVALID)\b/i.test(m.text) && m.level !== 'log' && glErrors.length < 64) glErrors.push(m.text);
          post(m); return;
        }
        if (!lease.active) return;
        if (m.type === 'worker-heartbeat' || m.type === 'worker-resume-ack') {
          const accepted = m.type === 'worker-resume-ack' ? heartbeat.acknowledgeResume(m, performance.now()) : heartbeat.accept(m, performance.now());
          if (accepted) { memory = m.memory ?? memory; post({ type: 'worker-heartbeat', sequence: m.sequence, resumeEpoch: m.resumeEpoch }); publish(); }
        } else if (m.type === 'worker-metrics') { memory = m.memory; publish(); }
        else if (m.type === 'phase') { if (m.phase === 'running') { running = true; workerState = 'running'; } post(m); publish(); }
        else if (m.type === 'project' && isProjectData(m.data)) post(m);
      };
      data.onmessage = event => {
        const raw = event.data;
        if (!isWorkerEnvelope(raw) || !sameWorkerRun(raw, identity)) { (raw?.bitmap as ImageBitmap | undefined)?.close?.(); return; }
        const m: any = raw;
        if (m.type === 'data-receipt') {
          if(Number.isSafeInteger(m.dataSequence)&&pendingData.delete(m.dataSequence)&&pendingPresentationData.delete(m.dataSequence))presentation?.observeWorkerCheckpoint(m.presentationCheckpoint,m.dataSequence);
          return;
        }
        if (!lease.active) { m.bitmap?.close?.(); return; }
        if (m.type === 'present-frame') presentation?.consume(m);
        else if (m.type === 'host-command') {
          try { if (m.command?.type === 'dom-command') input?.command(m.command); }
          catch (error) { fail(error); }
          finally { toData({ type: 'host-command-receipt', commandSequence: m.commandSequence }); }
        }
      };
      runtime.worker.onerror = event => { event.preventDefault(); workerFailure(event.error ?? event.message); };
      runtime.worker.onmessageerror = () => workerFailure(Error('E_WORKER_MESSAGE_DECODE'));
      control.start(); data.start();
      observer = new ResizeObserver(resize); observer.observe(options.canvas);
      if(options.canvas.parentElement)observer.observe(options.canvas.parentElement);
      lease.assertActive();
      const pack: Uint8Array = message.artifact.pack;
      runtime.worker.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, type: 'worker-connect', configuration, release,
        documentUrl: globalThis.location?.href, pack, canvas: presentation.offscreen, geometry: initial, controlPort: channels[0].port2, dataPort: channels[1].port2,
        audioCommandPort: channels[2].port2, audioPcmPort: channels[3].port2, browserPort: channels[4].port2, xrPort: channels[5].port2 },
      [pack.buffer as ArrayBuffer, presentation.offscreen, ...channels.map(channel => channel.port2)]);
      for (const channel of channels) ownedPorts.delete(channel.port2);
      workerState = 'booting'; visibility(); publish();
    } catch (error) { if (lease.active) { diagnostic = previewDiagnostic(error); void finalize({ kind: 'startup-failed', detail: diagnostic.message }); } }
  }
  return { stop, get snapshot() { return snapshot; } };
}
