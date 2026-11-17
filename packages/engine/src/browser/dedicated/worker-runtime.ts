import { createRuntimeBinding, installRuntimeHost, type RuntimeBinding } from '../../runtime-host.js';
import { isProjectData, previewDiagnostic, type RunPhase } from '../protocol.js';
import { WORKER_PROTOCOL, isWorkerEnvelope, prepareWorkerRunConfiguration, sameWorkerRun, type WorkerRunIdentity, type WorkerRunConfiguration } from './worker-protocol.js';
import { WorkerSessionLease } from './worker-session.js';
import { loadVerifiedWorkerEngine, type GodotInstance, type LoadedWorkerEngine, type VerifiedRelease } from '../verified-loader.js';
import { createWorkerPresentation, installPresentationHooks, type CanvasGeometry } from './worker-presentation.js';
import { createWorkerDom } from './worker-dom.js';
import {DOM_CLEANUP_COMMAND_LIMIT,isDomCleanupOperation} from './worker-dom-policy.js';
import { createWorkerAudioBridge } from './worker-audio.js';
import { createWorkerXRBridge } from './worker-xr.js';
import { WorkerBenchmark } from './worker-benchmark.js';
import { WorkerLogBudget } from './worker-log.js';
import {installNativeLifecycleGate, type NativeLifecycleGate, type NativeLifecycleModule} from '../lifecycle-gate.js';
import {assertArtifactSet,type ArtifactSet} from '../../artifact-set.js';
import {assertArtifactSetTarget,preloadArtifactSet} from '../artifact-input.js';

interface RuntimeScope {
  __godotjsRuntimeHost?: RuntimeBinding;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  [key: string]: any;
}
interface WorkerBoot extends WorkerRunIdentity {
  protocolVersion: 2; type: 'worker-connect'; release: VerifiedRelease; configuration: WorkerRunConfiguration;
  pack: Uint8Array; canvas: OffscreenCanvas; geometry: CanvasGeometry; documentUrl?: string;
  artifactSet?:ArtifactSet;
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
  let module: Record<string, any> | undefined;
  let binding:RuntimeBinding|undefined,uninstallHost:(()=>void)|undefined;
  let lifecycleGate:NativeLifecycleGate|undefined;
  const managedClose=boot.release.runtimeAbi?.lifecycle===1||boot.release.execution?.lifecycleAbi===1;
  let stopping=false,nativeStarted=false,quitScheduled=false;
  let pendingFatalSource:'browser'|'godotjs'|undefined;
  let pendingFatalLocation:{message?:string;filename?:string;line?:number;column?:number}|undefined;
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
  for (const level of ['log', 'warn', 'error'] as const) {
    const forward=(...args:unknown[])=>{originals[level](...args);log(level,args);};
    Object.defineProperty(forward,'__godotjsConsoleForwarded',{value:true});console[level]=forward;
  }
  const assertStarting = () => { lease.assertActive(); if(stopping||closed||nativeExited)throw new DOMException('Worker startup cancelled','AbortError'); };
  const phase = (value: RunPhase) => { assertStarting(); post({ type: 'phase', phase: value }); };
  let presentation: ReturnType<typeof createWorkerPresentation> | undefined;
  let dom: ReturnType<typeof createWorkerDom> | undefined;
  let audio: ReturnType<typeof createWorkerAudioBridge> | undefined;
  let browser: { dispose(): void; beginDrain?(): void } | undefined;
  let xr: ReturnType<typeof createWorkerXRBridge> | undefined;
  let benchmark:WorkerBenchmark|undefined;
  const pendingHostStates: any[] = [];
  const pendingHostCommands = new Set<number>();
  const pendingCleanupHostCommands = new Set<number>();
  const receiveHostCommandReceipt=(sequence:number)=>{if(pendingHostCommands.delete(sequence))pendingCleanupHostCommands.delete(sequence);};
  let commandSequence = 0, latestGeometry: CanvasGeometry | undefined;
  let projectSequence = 0, pendingProjectBytes = 0, droppedProjectMessages = 0;
  const pendingProjects = new Map<number, number>();
  const cancelNativeStart = () => { try { module?.godotWorkerCancelStart?.(); } catch { /* The host owns hard termination. */ } };
  const requestNativeQuit = () => {
    if(quitScheduled)return;quitScheduled=true;
    // A fatal can originate on a native callback stack, including start().
    // Broadcast cancellation now, then enter native only at a JS safe point.
    void Promise.resolve().then(()=>{
      if(closed||nativeExited||binding?.snapshotSummary().sealed)return;
      try{engine?.requestQuit();}catch(error){post({type:'worker-stop-error',detail:text([error])});}
    });
  };
  const canCooperativelyClose = () => managedClose&&(nativeStarted||!!(lifecycleGate&&binding?.snapshotSummary().entries.length));
  const release = () => {
    if (closed) return; closed = true; lease.cancel(); lifecycleGate?.dispose();binding?.settle();uninstallHost?.();clearInterval(heartbeat);
    presentation?.dispose(); dom?.dispose(); browser?.dispose(); xr?.dispose(); loaded?.dispose();
    pendingHostCommands.clear();pendingCleanupHostCommands.clear();
    scope.removeEventListener('error', onError); scope.removeEventListener('unhandledrejection', onRejection);
    for (const level of ['log', 'warn', 'error'] as const) console[level] = originals[level];
  };
  const fatal = (error: unknown, source: 'browser' | 'godotjs' = 'browser', location?: { message?: string; filename?: string; line?: number; column?: number }) => {
    if (closed || nativeExited || failed) return;
    const diagnostic = previewDiagnostic(error, location); diagnostic.source = source;
    // The binding reserves the first fatal slot synchronously. Returning from
    // native code may deliver onExit(0) before the safe-point quit callback.
    if(binding&&!binding.failure){
      pendingFatalSource=source;pendingFatalLocation=location;
      let accepted=false;
      try{accepted=binding.reportDiagnostic({kind:'runtime',message:diagnostic.message,...(diagnostic.stack?{stack:diagnostic.stack}:{})});}
      finally{pendingFatalSource=undefined;pendingFatalLocation=undefined;}
      if(accepted)return;
      // Native teardown may fail after its logical epoch was sealed. Keep
      // that browser/runtime failure outside the immutable source summary.

    }
    failed = true;
    post({ type: 'worker-fatal', diagnostic, detail: diagnostic.message });
    if(canCooperativelyClose()){beginStopping('runtime-failed');return;}
    binding?.drain();lease.cancel(error);audio?.revoke();dom?.revokeInput();
    // Never re-enter an application/native callback merely to request exit.
    void Promise.resolve().then(()=>{
      if(closed||nativeExited)return;
      aborter.abort(error);cancelNativeStart();presentation?.dispose();xr?.dispose();
      requestNativeQuit();
    });
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
  function beginStopping(reason:string,requestQuit=true):void {
    if(stopping||closed||nativeExited)return;
    stopping=true;
    const attempt=(cleanup:()=>void)=>{try{cleanup();}catch(error){try{fatal(error);}catch{/* A lost diagnostic channel cannot block the remaining cleanup. */}}};
    if(canCooperativelyClose()){
      attempt(()=>binding?.beginClose(reason));attempt(()=>dom?.revokeInput());attempt(()=>audio?.beginDrain());
      attempt(()=>browser?.beginDrain?.());attempt(()=>presentation?.setVisible(false));attempt(()=>lifecycleGate?.beginClose(reason));
      if(requestQuit)requestNativeQuit();
      return;
    }
    lease.cancel();binding?.beginClose(reason);audio?.revoke();dom?.revokeInput();
    aborter.abort(new DOMException('Stopped','AbortError'));presentation?.dispose();xr?.dispose();cancelNativeStart();
    if(requestQuit)requestNativeQuit();
    if(!module||!engine)post({type:'worker-termination-required',stage:'before-native-start'});
  }
  control.onmessage = event => {
    if (!isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity)) return;
    const m: any = event.data;
    if (m.type === 'stop') {
      beginStopping(typeof m.cause==='string'?m.cause:'session-stop');
    } else if (!closed && m.type === 'project-receipt' && Number.isSafeInteger(m.projectSequence)) {
      const bytes = pendingProjects.get(m.projectSequence); if(bytes!==undefined){pendingProjects.delete(m.projectSequence);pendingProjectBytes-=bytes;}
    } else if (!closed && m.type === 'project-command' && isProjectData(m.data)) {
      if(!Number.isSafeInteger(m.commandSequence)||m.commandSequence<=lastProjectCommand)return;
      lastProjectCommand=m.commandSequence;
      const receipt=()=>post({type:'project-command-receipt',commandSequence:m.commandSequence});
      if(lease.active&&!stopping&&binding)binding.receiveProjectCommand(m.data,receipt);else receipt();
    } else if (lease.active && m.type === 'resume' && Number.isSafeInteger(m.resumeEpoch) && Number(m.resumeEpoch) > resumeEpoch) {
      resumeEpoch = Number(m.resumeEpoch); beatSequence = 0;
      post({ type: 'worker-resume-ack', sequence: ++beatSequence, resumeEpoch });
    }
  };
  data.onmessage = event => {
    if (!isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity) || closed) return;
    const m: any = event.data;
    const cleanupPacket=['host-command-receipt','present-ack','host-result'].includes(m.type)||(m.type==='host-state'&&m.state?.requestId!==undefined);
    if((stopping&&!cleanupPacket)||(binding?.snapshotSummary().sealed&&m.type!=='host-command-receipt')){
      if(Number.isSafeInteger(m.dataSequence))dataPost({type:'data-receipt',dataSequence:m.dataSequence});return;
    }
    if(!lease.active){
      if(m.type==='host-command-receipt')receiveHostCommandReceipt(m.commandSequence);
      if(Number.isSafeInteger(m.dataSequence))dataPost({type:'data-receipt',dataSequence:m.dataSequence});
      return;
    }
    try {
      if (m.type === 'host-command-receipt') { receiveHostCommandReceipt(m.commandSequence); }
      else if (m.type === 'present-ack') presentation?.ack(m as any);
      else if (m.type === 'input') { benchmark?.inputReceived(m.packet);const accepted=dom?.dispatchInput(m.packet as any)??false;benchmark?.inputDispatched(m.packet.sequence,accepted); }
      else if (m.type === 'geometry') { if (presentation && dom && !xr?.active) { presentation.resize(m.geometry); dom.resize(m.geometry); } else latestGeometry = m.geometry; }
      else if (m.type === 'host-state') {
        if (dom) dom.applyHostState(m.state);
        else if (pendingHostStates.length < 32) pendingHostStates.push(m.state);
        else throw Error('E_WORKER_HOST_STATE_BUDGET');
        if (!stopping&&typeof m.state?.visible === 'boolean') presentation?.setVisible(m.state.visible && !xr?.active);
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
    const artifactSet=boot.artifactSet?await assertArtifactSet(boot.artifactSet):undefined;
    if(artifactSet)assertArtifactSetTarget(artifactSet,boot.release);
    lease.assertActive();
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
        if(!lease.active||stopping)return;
        presentation?.setVisible(!active && scope.document?.visibilityState !== 'hidden');
        if(!active && latestGeometry){presentation?.resize(latestGeometry);dom?.resize(latestGeometry);latestGeometry=undefined;}
      }, onError: fatal });
    scope.__godotWorkerXR = xr;
    dom = createWorkerDom({ canvas: boot.canvas, geometry: boot.geometry, baseUrl: boot.documentUrl, scope, sendHostCommand: command => {
      const cleanup=managedClose&&stopping&&isDomCleanupOperation(command.operation);
      if(closed||binding?.snapshotSummary().sealed||(!lease.active&&!cleanup)||(stopping&&!cleanup))throw Error('E_WORKER_DOM_CLOSED');
      const pending=cleanup?pendingCleanupHostCommands.size:pendingHostCommands.size-pendingCleanupHostCommands.size;
      if(pending>=(cleanup?DOM_CLEANUP_COMMAND_LIMIT:boot.configuration.budgets.maxHostCommands))throw Error(cleanup?'E_WORKER_HOST_CLEANUP_BACKPRESSURE':'E_WORKER_HOST_COMMAND_BACKPRESSURE');
      const sequence = ++commandSequence; pendingHostCommands.add(sequence);
      if(cleanup)pendingCleanupHostCommands.add(sequence);
      try{dataPost({ type: 'host-command', command, commandSequence: sequence });}
      catch(error){receiveHostCommandReceipt(sequence);throw error;}
    } });
    if (latestGeometry && !xr.active) { presentation.resize(latestGeometry); dom.resize(latestGeometry); latestGeometry=undefined; }
    for (const state of pendingHostStates.splice(0)) dom.applyHostState(state);
    audio = createWorkerAudioBridge(boot.audioCommandPort, boot.audioPcmPort, { runId: identity.runId, audioEpoch: 1, onError: fatal });
    scope.__godotWorkerAudio = audio;
    const publish = (key: string, value: unknown) => { scope[key] = value; if (dom?.window) (dom.window as any)[key] = value; };
    if(benchmark)publish('__godotjsBenchmarkInput',(event:unknown,code:unknown)=>lease.active&&typeof event==='string'&&typeof code==='string'&&benchmark!.nativeInputConsumed(event,code));
    binding=createRuntimeBinding({sessionId:identity.runId,role:'engine',
      maxCommands:boot.configuration.budgets.maxProjectEvents,maxCommandBytes:boot.configuration.budgets.maxProjectBytes,
      schedule:callback=>{void Promise.resolve().then(callback);},
      onDiagnostic:diagnostic=>{
        if(diagnostic.kind==='caught'||diagnostic.kind==='recoverable')log('warn',[diagnostic.message,diagnostic.stack??diagnostic.componentStack??'']);
        else fatal({message:diagnostic.message,stack:diagnostic.stack??diagnostic.componentStack},pendingFatalSource??'godotjs',pendingFatalLocation);
        return true;
      },
      onLog:(level,message)=>{log(level,[message]);return true;},
      onProject:(value,serialized)=>{
        if(!lease.active)return false;
        const bytes=new TextEncoder().encode(serialized).byteLength;
        if(pendingProjects.size>=boot.configuration.budgets.maxProjectEvents||pendingProjectBytes+bytes>boot.configuration.budgets.maxProjectBytes){droppedProjectMessages++;return false;}
        const sequence=++projectSequence;pendingProjects.set(sequence,bytes);pendingProjectBytes+=bytes;
        post({type:'project',data:value,projectSequence:sequence});return true;
      },
      onSummary:summary=>post({type:'runtime-summary',runtimeSummary:summary}),
    });
    uninstallHost=installRuntimeHost(binding,scope);
    const previousLifecycle=Object.getOwnPropertyDescriptor(scope,'__godotjsInstallLifecycle');
    const installLifecycle=(nativeModule:NativeLifecycleModule)=>{
      if(!managedClose)return;
      if(lifecycleGate)return;
      lifecycleGate=installNativeLifecycleGate(nativeModule,binding!,{
        onBegin(){nativeStarted=true;beginStopping('native-quit',false);post({type:'worker-closing'});},
        onError:error=>fatal(error),
      });
    };
    Object.defineProperty(scope,'__godotjsInstallLifecycle',{configurable:true,writable:true,value:installLifecycle});
    const removeHost=uninstallHost;
    uninstallHost=()=>{removeHost?.();if(scope.__godotjsInstallLifecycle===installLifecycle){if(previousLifecycle)Object.defineProperty(scope,'__godotjsInstallLifecycle',previousLifecycle);else delete scope.__godotjsInstallLifecycle;}};
    // JavaScriptBridge's window proxy and direct project code reach one owner.
    publish('__godotjsRuntimeHost',binding);
    publish('__godotjsProjectEvent',(raw:unknown)=>{
      if(typeof raw!=='string'||raw.length>262144)return false;
      try{return binding!.emitProjectEvent(JSON.parse(raw));}catch{return false;}
    });
    publish('__godotjsSetProjectCommand',(callback:unknown)=>binding!.bindLegacyProjectCommand(typeof callback==='function'?callback as (json:string)=>void:null));
    publish('__godotjsReportReactError',(raw:unknown)=>{
      if(typeof raw!=='string'||raw.length>65536)return false;
      try{return binding!.reportDiagnostic(JSON.parse(raw));}catch{return false;}
    });
    // WebSocket, fetch, timers and React execute in this Worker directly.
    const broker = await import('./worker-browser.js'); lease.assertActive();
    browser = broker.installWorkerBrowserBridge(boot.browserPort, { runId: identity.runId, scope, onError: fatal });
    phase('downloading');
    loaded = await lease.retain(loadVerifiedWorkerEngine(boot.release, { signal: aborter.signal, baseUrl: boot.documentUrl }), result => result.dispose());
    engine = new loaded.Engine({ canvas: boot.canvas, executable: loaded.basePath, persistentPaths: [], persistentDrops: false,
      serviceWorker: '', focusCanvas: false, canvasResizePolicy: 0,
      onPrint: (...args: unknown[]) => log('log', args), onPrintError: (...args: unknown[]) => log('error', args),
      onExit: (code: number) => { if (nativeExited) return; nativeExited = true; post({ type: 'native-exit', code, memory: metrics(),runtimeSummary:binding?.snapshotSummary() }); release(); scope.close?.(); },
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
    phase('preloading');
    if(artifactSet)await preloadArtifactSet(engine,artifactSet,assertStarting);
    else await engine.preloadFile(boot.pack, '/application.pck');
    assertStarting();
    phase('initializing'); await engine.init(); assertStarting();
    module = (engine as any).rtenv ?? module;
    if(managedClose&&typeof module?._godotjs_release_exit!=='function')throw Error('E_NATIVE_LIFECYCLE_ABI: native pre-exit export is missing');
    phase('starting'); await engine.start({ args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility'] }); assertStarting();
    nativeStarted=true;
    if(managedClose&&!lifecycleGate)throw Error('E_NATIVE_LIFECYCLE_ABI: matching native hook was not installed');
    if(stopping)return;
    // Engine.start resolves only after native resume/setup2/start, not callMain.
    phase('waiting-ready'); await Promise.resolve(); assertStarting(); phase('running');
    post({ type: 'worker-metrics', memory: metrics() });
  } catch (error) {
    if(closed||nativeExited)return;
    if(stopping||!lease.active||aborter.signal.aborted){
      if(!canCooperativelyClose())post({type:'worker-termination-required',stage:'cancelled-startup'});
    }else fatal(error);
  }
}
