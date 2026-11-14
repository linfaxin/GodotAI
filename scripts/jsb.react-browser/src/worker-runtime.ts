import { isProjectData, previewDiagnostic, type RunPhase } from './protocol.js';
import { WORKER_PROTOCOL, isWorkerEnvelope, prepareWorkerRunConfiguration, sameWorkerRun, type WorkerRunIdentity, type WorkerRunConfiguration } from './worker-protocol.js';
import { WorkerSessionLease } from './worker-session.js';
import { loadVerifiedWorkerEngine, type GodotInstance, type LoadedWorkerEngine, type VerifiedRelease } from './verified-loader.js';
import { createWorkerPresentation, installPresentationHooks, type CanvasGeometry } from './worker-presentation.js';
import { createWorkerDom } from './worker-dom.js';
import { createWorkerAudioBridge } from './worker-audio.js';
import { createWorkerXRBridge } from './worker-xr.js';
import { WorkerBenchmark } from './worker-benchmark.js';
import { WorkerLogBudget } from './worker-log.js';

interface RuntimeScope {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  [key: string]: any;
}
interface WorkerBoot extends WorkerRunIdentity {
  protocolVersion: 2; type: 'worker-connect'; release: VerifiedRelease; configuration: WorkerRunConfiguration;
  pack: Uint8Array; canvas: OffscreenCanvas; geometry: CanvasGeometry; documentUrl?: string;
  controlPort: MessagePort; dataPort: MessagePort; audioCommandPort: MessagePort; audioPcmPort: MessagePort; browserPort: MessagePort; xrPort: MessagePort;
}

/** Entrypoint for a self-contained classic Dedicated Worker bundle. No DOM or
 * shared memory is needed; React remains in the same realm as native handles. */
export function installWorkerRuntime(scope: RuntimeScope = globalThis): () => void {
  if(typeof scope.WorkerGlobalScope!=='function'||!(scope instanceof scope.WorkerGlobalScope))throw Error('E_WORKER_REALM');
  let connected = false;
  const connect = (event: MessageEvent) => {
    const data = event.data;
    if (connected || !isWorkerEnvelope(data) || data.type !== 'worker-connect') return;
    connected = true;
    void runWorker(data as unknown as WorkerBoot, scope);
  };
  scope.addEventListener('message', connect);
  return () => scope.removeEventListener('message', connect);
}

async function runWorker(boot: WorkerBoot, scope: RuntimeScope): Promise<void> {
  const { controlPort: control, dataPort: data } = boot;
  if (!(control instanceof MessagePort) || !(data instanceof MessagePort)) return;
  const identity: WorkerRunIdentity = { runId: boot.runId, revision: boot.revision, buildKey: boot.buildKey, generation: boot.generation,
    documentId: boot.documentId, workerId: boot.workerId, runConfigurationHash: boot.runConfigurationHash };
  const lease = new WorkerSessionLease(), aborter = new AbortController();
  let engine: GodotInstance | undefined, loaded: LoadedWorkerEngine | undefined;
  let module: Record<string, any> | undefined, projectCommand: ((json: string) => void) | undefined;
  let lastProjectCommand=0;
  let nativeExited = false, resumeEpoch = 0, beatSequence = 0, closed = false, failed = false;
  let memoryPeak = 0, heapPeak = 0;
  const post = (fields: object, transfer: Transferable[] = []) => control.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, ...fields }, transfer);
  const dataPost = (fields: object, transfer: Transferable[] = []) => data.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, ...fields }, transfer);
  const text = (args: unknown[]) => args.slice(0, 20).map(value => typeof value === 'string' ? value.slice(0, 4096) : value === null || ['undefined', 'number', 'boolean', 'bigint'].includes(typeof value) ? String(value) : '[object]').join(' ').slice(0, 4096);
  const logs = new WorkerLogBudget(boot.configuration?.budgets??{});
  const log = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
    if (closed) return; const message = text(args);
    if (logs.admit(message)) post({ type: 'log', level, text: message });
  };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) console[level] = (...args) => { originals[level](...args); log(level, args); };
  const phase = (value: RunPhase) => { lease.assertActive(); post({ type: 'phase', phase: value }); };
  let presentation: ReturnType<typeof createWorkerPresentation> | undefined;
  let dom: ReturnType<typeof createWorkerDom> | undefined;
  let audio: ReturnType<typeof createWorkerAudioBridge> | undefined;
  let browser: { dispose(): void } | undefined;
  let xr: ReturnType<typeof createWorkerXRBridge> | undefined;
  let benchmark:WorkerBenchmark|undefined;
  const pendingHostStates: any[] = [];
  const pendingHostCommands = new Set<number>();
  let commandSequence = 0, latestGeometry: CanvasGeometry | undefined;
  let projectSequence = 0, pendingProjectBytes = 0, droppedProjectMessages = 0;
  const pendingProjects = new Map<number, number>();
  const cancelNativeStart = () => { try { module?.godotWorkerCancelStart?.(); } catch { /* The host owns hard termination. */ } };
  const release = () => {
    if (closed) return; closed = true; lease.cancel(); clearInterval(heartbeat);
    presentation?.dispose(); dom?.dispose(); browser?.dispose(); xr?.dispose(); loaded?.dispose();
    scope.removeEventListener('error', onError); scope.removeEventListener('unhandledrejection', onRejection);
    for (const level of ['log', 'warn', 'error'] as const) console[level] = originals[level];
  };
  const fatal = (error: unknown, source: 'browser' | 'godotjs' = 'browser', location?: { message?: string; filename?: string; line?: number; column?: number }) => {
    if (closed || nativeExited || failed) return;
    failed = true;
    const diagnostic = previewDiagnostic(error, location); diagnostic.source = source;
    post({ type: 'worker-fatal', diagnostic, detail: diagnostic.message });
    lease.cancel(error); audio?.revoke(); dom?.revokeInput(); aborter.abort(error); cancelNativeStart(); presentation?.dispose(); xr?.dispose();
    try { engine?.requestQuit(); } catch { /* Bounded termination follows at host. */ }
  };
  const onError = (event: ErrorEvent) => {
    if(closed||nativeExited||failed)return;
    fatal(event.error ?? event.message,'browser',{message:event.message,filename:event.filename,line:event.lineno,column:event.colno}); event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if(closed||nativeExited||failed)return;
    fatal(event.reason); event.preventDefault();
  };
  scope.addEventListener('error', onError); scope.addEventListener('unhandledrejection', onRejection);
  function metrics(): object {
    // Emscripten's JSBB heap accessor exists before wasmMemory is assigned.
    // Observation during a slow compile must stay unavailable, then recover.
    let buffer: ArrayBuffer | undefined;
    try { const value=module?.HEAPU8?.buffer;if(value instanceof ArrayBuffer)buffer=value; } catch { /* Native memory is not ready. */ }
    if(!buffer)try { const value=scope._jsbb_?.u8?.buffer;if(value instanceof ArrayBuffer)buffer=value; } catch { /* Early JSBB getter; retry next heartbeat. */ }
    const wasmBytes = buffer instanceof ArrayBuffer ? buffer.byteLength : null;
    if (wasmBytes !== null) memoryPeak = Math.max(memoryPeak, wasmBytes);
    let used: unknown;
    try { used=(scope.performance as Performance & { memory?: { usedJSHeapSize?: number } })?.memory?.usedJSHeapSize; } catch { /* Optional browser metric. */ }
    const heap = typeof used === 'number' && Number.isFinite(used) ? used : null;
    if (heap !== null) heapPeak = Math.max(heapPeak, heap);
    return { schemaVersion: 1, realmId: identity.workerId, workerId: identity.workerId, executionBackend: 'worker',
      wasmMemoryCapacityBytes: wasmBytes, wasmMemoryCapacityPeakBytes: memoryPeak || null,
      jsHeapUsedBytes: heap, jsHeapUsedPeakBytes: heap === null ? null : heapPeak,
      memoryBufferKind: buffer instanceof ArrayBuffer ? 'ArrayBuffer' : 'unavailable',
      projectChannel: { pending: pendingProjects.size, bytes: pendingProjectBytes, dropped: droppedProjectMessages }, presentation: presentation?.stats(), xr: xr?.snapshot(), ...(benchmark?{benchmark:benchmark.snapshot()}:{}) };
  }
  const heartbeat = setInterval(() => {
    if (closed || !lease.active) return;
    post({ type: 'worker-heartbeat', sequence: ++beatSequence, resumeEpoch, memory: metrics() });
  }, 250);
  control.onmessage = event => {
    if (!isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity)) return;
    const m: any = event.data;
    if (m.type === 'stop') {
      if (!lease.cancel()) return;
      audio?.revoke(); dom?.revokeInput(); aborter.abort(new DOMException('Stopped', 'AbortError')); presentation?.dispose(); xr?.dispose(); cancelNativeStart();
      try { engine?.requestQuit(); } catch (error) { post({ type: 'worker-stop-error', detail: text([error]) }); }
      // Partial native setup is disposed by Worker termination, not Main.cleanup.
      if (!module || !engine) post({ type: 'worker-termination-required', stage: 'before-native-start' });
    } else if (lease.active && m.type === 'project-receipt' && Number.isSafeInteger(m.projectSequence)) {
      const bytes = pendingProjects.get(m.projectSequence); if(bytes!==undefined){pendingProjects.delete(m.projectSequence);pendingProjectBytes-=bytes;}
    } else if (lease.active && m.type === 'project-command' && isProjectData(m.data)) {
      if(!Number.isSafeInteger(m.commandSequence)||m.commandSequence<=lastProjectCommand)return;
      lastProjectCommand=m.commandSequence;
      try { projectCommand?.(JSON.stringify(m.data)); } catch (error) { fatal(error); }
      finally{post({type:'project-command-receipt',commandSequence:m.commandSequence});}
    } else if (lease.active && m.type === 'resume' && Number.isSafeInteger(m.resumeEpoch) && Number(m.resumeEpoch) > resumeEpoch) {
      resumeEpoch = Number(m.resumeEpoch); beatSequence = 0;
      post({ type: 'worker-resume-ack', sequence: ++beatSequence, resumeEpoch });
    }
  };
  data.onmessage = event => {
    if (!isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity) || !lease.active) return;
    const m: any = event.data;
    try {
      if (m.type === 'host-command-receipt') { pendingHostCommands.delete(m.commandSequence); }
      else if (m.type === 'present-ack') presentation?.ack(m as any);
      else if (m.type === 'input') { benchmark?.inputReceived(m.packet);const accepted=dom?.dispatchInput(m.packet as any)??false;benchmark?.inputDispatched(m.packet.sequence,accepted); }
      else if (m.type === 'geometry') { if (presentation && dom && !xr?.active) { presentation.resize(m.geometry); dom.resize(m.geometry); } else latestGeometry = m.geometry; }
      else if (m.type === 'host-state') {
        if (dom) dom.applyHostState(m.state);
        else if (pendingHostStates.length < 32) pendingHostStates.push(m.state);
        else throw Error('E_WORKER_HOST_STATE_BUDGET');
        if (typeof m.state?.visible === 'boolean') presentation?.setVisible(m.state.visible && !xr?.active);
      }
      else if (m.type === 'host-result') dom?.applyHostState(m as any);
    } catch (error) { fatal(error); }
    finally { if (Number.isSafeInteger(m.dataSequence)) dataPost({ type: 'data-receipt', dataSequence: m.dataSequence,
      ...((m.type==='geometry'||m.type==='present-ack')&&presentation?{presentationCheckpoint:presentation.checkpoint()}:{}) }); }
  };
  control.start(); data.start();
  try {
    const frozen = await prepareWorkerRunConfiguration(boot.configuration); lease.assertActive();
    if (frozen.hash !== identity.runConfigurationHash || !boot.release.runtimeAbi || !(boot.pack instanceof Uint8Array) || !boot.pack.byteLength || boot.pack.byteLength > 64 * 1024 * 1024) throw Error('E_WORKER_BOOT');
    if (boot.configuration.hostAbiVersion !== 1 || boot.configuration.audioAbiVersion !== 1 || boot.configuration.presentationAbiVersion !== 1) throw Error('E_WORKER_ABI');
    if(boot.configuration.budgets.benchmarkTimingSamples)benchmark=new WorkerBenchmark(boot.configuration.budgets.benchmarkTimingSamples);
    const limits = { maxDimension: boot.configuration.budgets.maxCanvasDimension, maxPixels: boot.configuration.budgets.maxCanvasPixels, maxAggregateBytes: boot.configuration.budgets.maxPresentationBytes };
    presentation = createWorkerPresentation({ runId: identity.runId, canvas: boot.canvas, mode: boot.configuration.presentationBackend, geometry: boot.geometry, limits,
      sendFrame: frame => dataPost(frame, [frame.bitmap]), onFatal: fatal, isXRActive: () => xr?.active === true,
      resetDrawCredit: () => module?.godotWorkerResetDrawCredit?.(),benchmark });
    xr = createWorkerXRBridge(boot.xrPort, { identity, canvas: boot.canvas,
      limits: { maxPixels: boot.configuration.budgets.maxCanvasPixels, maxDimension: boot.configuration.budgets.maxCanvasDimension,
        maxBytes: boot.configuration.budgets.maxPresentationBytes, setupTimeoutMs: boot.configuration.budgets.hostSetupTimeoutMs },
      onActiveChange: active => {
        if(!lease.active)return;
        presentation?.setVisible(!active && scope.document?.visibilityState !== 'hidden');
        if(!active && latestGeometry){presentation?.resize(latestGeometry);dom?.resize(latestGeometry);latestGeometry=undefined;}
      }, onError: fatal });
    scope.__godotWorkerXR = xr;
    dom = createWorkerDom({ canvas: boot.canvas, geometry: boot.geometry, baseUrl: boot.documentUrl, scope, sendHostCommand: command => {
      if (pendingHostCommands.size >= boot.configuration.budgets.maxHostCommands) throw Error('E_WORKER_HOST_COMMAND_BACKPRESSURE');
      const sequence = ++commandSequence; pendingHostCommands.add(sequence);
      dataPost({ type: 'host-command', command, commandSequence: sequence });
    } });
    if (latestGeometry && !xr.active) { presentation.resize(latestGeometry); dom.resize(latestGeometry); latestGeometry=undefined; }
    for (const state of pendingHostStates.splice(0)) dom.applyHostState(state);
    audio = createWorkerAudioBridge(boot.audioCommandPort, boot.audioPcmPort, { runId: identity.runId, audioEpoch: 1, onError: fatal });
    scope.__godotWorkerAudio = audio;
    const publish = (key: string, value: unknown) => { scope[key] = value; if (dom?.window) (dom.window as any)[key] = value; };
    if(benchmark)publish('__godotjsBenchmarkInput',(event:unknown,code:unknown)=>lease.active&&typeof event==='string'&&typeof code==='string'&&benchmark!.nativeInputConsumed(event,code));
    publish('__godotjsProjectEvent', (raw: unknown) => {
      if (!lease.active || typeof raw !== 'string' || raw.length > 262144) return false;
      try {
        const value = JSON.parse(raw); if(!isProjectData(value))return false;
        const bytes = new TextEncoder().encode(raw).byteLength;
        if(pendingProjects.size>=boot.configuration.budgets.maxProjectEvents||pendingProjectBytes+bytes>boot.configuration.budgets.maxProjectBytes){droppedProjectMessages++;return false;}
        const sequence=++projectSequence;pendingProjects.set(sequence,bytes);pendingProjectBytes+=bytes;
        post({type:'project',data:value,projectSequence:sequence});return true;
      } catch { return false; }
    });
    publish('__godotjsSetProjectCommand', (callback: unknown) => { projectCommand = typeof callback === 'function' ? callback as (json: string) => void : undefined; });
    publish('__godotjsReportReactError', (raw: unknown) => {
      if (!lease.active || typeof raw !== 'string' || raw.length > 65536) return false;
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value.message !== 'string') return false;
        if (value.kind === 'caught' || value.kind === 'recoverable') log('warn', [value.message, value.stack]);
        else queueMicrotask(() => { if (lease.active) fatal({ message: value.message, stack: value.stack ?? value.componentStack }, 'godotjs'); });
        return true;
      } catch { return false; }
    });
    // WebSocket, fetch, timers and React execute in this Worker directly.
    const broker = await import('./worker-browser.js'); lease.assertActive();
    browser = broker.installWorkerBrowserBridge(boot.browserPort, { runId: identity.runId, scope, onError: fatal });
    phase('downloading');
    loaded = await lease.retain(loadVerifiedWorkerEngine(boot.release, { signal: aborter.signal, baseUrl: boot.documentUrl }), result => result.dispose());
    engine = new loaded.Engine({ canvas: boot.canvas, executable: loaded.basePath, persistentPaths: [], persistentDrops: false,
      serviceWorker: '', focusCanvas: false, canvasResizePolicy: 0,
      onPrint: (...args: unknown[]) => log('log', args), onPrintError: (...args: unknown[]) => log('error', args),
      onExit: (code: number) => { if (nativeExited) return; nativeExited = true; post({ type: 'native-exit', code, memory: metrics() }); release(); scope.close?.(); },
    });
    const config = (engine as any).config;
    if (!config || typeof config.getModuleConfig !== 'function') throw Error('E_WORKER_MODULE_CONFIG');
    const original = config.getModuleConfig;
    config.getModuleConfig = function (...args: unknown[]) {
      const value = original.apply(this, args);
      module = value; installPresentationHooks(value, presentation!);
      value.onRuntimeInitialized = (() => { const before = value.onRuntimeInitialized; return function (this: unknown, ...values: unknown[]) { if (typeof before === 'function') before.apply(this, values); }; })();
      return value;
    };
    phase('preloading'); await engine.preloadFile(boot.pack, '/application.pck'); lease.assertActive();
    phase('initializing'); await engine.init(); lease.assertActive();
    module = (engine as any).rtenv ?? module;
    phase('starting'); await engine.start({ args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility'] }); lease.assertActive();
    // Engine.start resolves only after native resume/setup2/start, not callMain.
    phase('waiting-ready'); await Promise.resolve(); lease.assertActive(); phase('running');
    post({ type: 'worker-metrics', memory: metrics() });
  } catch (error) { if (lease.active) fatal(error); else post({ type: 'worker-termination-required', stage: 'cancelled-startup' }); }
}
