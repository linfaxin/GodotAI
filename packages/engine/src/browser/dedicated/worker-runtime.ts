import { createRuntimeBinding, installRuntimeHost, type RuntimeBinding } from '../../runtime-host.js';
import { isProjectData, previewDiagnostic, type RunPhase } from '../protocol.js';
import { WORKER_PROTOCOL, isWorkerEnvelope, prepareWorkerRunConfiguration, sameWorkerRun, type WorkerRunIdentity, type WorkerRunConfiguration } from './worker-protocol.js';
import { canSettleEmptyRuntimeFailureCapture, WorkerSessionLease } from './worker-session.js';
import { loadVerifiedWorkerEngine, type GodotInstance, type LoadedWorkerEngine, type VerifiedRelease } from '../verified-loader.js';
import { createWorkerPresentation, drawingBufferSize, installPresentationHooks, type CanvasGeometry } from './worker-presentation.js';
import { createWorkerDom } from './worker-dom.js';
import {DOM_CLEANUP_COMMAND_LIMIT,isDomCleanupOperation} from './worker-dom-policy.js';
import { createWorkerAudioBridge } from './worker-audio.js';
import { createWorkerXRBridge } from './worker-xr.js';
import { WorkerBenchmark } from './worker-benchmark.js';
import { WorkerLogBudget } from './worker-log.js';
import {installNativeLifecycleGate, type NativeLifecycleGate, type NativeLifecycleModule} from '../lifecycle-gate.js';
import {assertArtifactSet,type ArtifactSet} from '../../artifact-set.js';
import {assertArtifactSetTarget,preloadArtifactSet} from '../artifact-input.js';
import {createWorkerCapture, createWorkerGesture} from './worker-observation.js';
import {createInteractionResultSender, INTERACTION_VERSION, interactionNow, readGesture, supportsWorkerInteraction,
  undispatched, validInteractionId, validInteractionSequence, type CapturedFrame, type InteractionError} from './worker-interaction.js';
import {createNativeRuntimeSampler, installRuntimeObservationHooks, observationError,
  RUNTIME_OBSERVATION_VERSION, supportsWorkerObservation, type ObservationError} from './worker-runtime-observation.js';
import {createWorkerObservationRequests, readRuntimeObservationRequest,
  type RuntimeObservationReply} from './worker-runtime-observation-transport.js';
import {createNativeRuntimeWriter, RUNTIME_WRITE_VERSION, runtimeWriteError, supportsWorkerRuntimeWrite,
  type RuntimeSetError} from './worker-runtime-write.js';
import {createWorkerRuntimeAccess, readAccessId, runtimeAccessFamily} from './worker-runtime-access-transport.js';
import {createNativeRuntimeProperties, RUNTIME_PROPERTIES_VERSION, supportsWorkerRuntimeProperties,
  runtimePropertiesError, type PropertyCommand, type AccessErrorCode} from './worker-runtime-properties.js';
import {createNativeRuntimeCall, RUNTIME_CALL_VERSION, supportsWorkerRuntimeCall, runtimeMethodError, type MethodCommand} from './worker-runtime-call.js';

import {createNativeGameProbe, gameProbeError, GAME_PROBE_VERSION, readGameProbeRequest, readGameProbeSequence, supportsGameProbe,
  type GameProbeData, type GameProbeError} from './worker-game-probe.js';
import {scheduleRuntimeWriteDeadline} from './worker-runtime-write-transport.js';
import {createNativeInputScript, INPUT_SCRIPT_VERSION, matchesInputScript, noInputScript, readInputScriptKey,
  readInputScriptRequest, supportsInputScript, type InputScriptKey, type InputScriptRequest,
  type InputScriptTerminal} from './worker-input-script.js';

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
  // Leave the native frame or teardown callback before reporting a fatal transport failure.
  const sendInteractionResult = createInteractionResultSender(post, error => queueMicrotask(() => fatal(error)));
  const supportsInteraction = supportsWorkerInteraction(boot.release, boot.configuration.presentationBackend, scope.navigator?.userAgent ?? '');
  const inputScriptSupported = supportsInputScript(boot.release, boot.configuration.presentationBackend, scope.navigator?.userAgent ?? '');
  let nativeInputScript: ReturnType<typeof createNativeInputScript> | undefined;
  let inputScript: InputScriptRequest | undefined;
  let inputScriptTimer: (() => void) | undefined;
  let lastInputScriptSequence = 0;
  function postInputScript(key: InputScriptKey, terminal: InputScriptTerminal) {
    post({type: 'input-script-terminal', releaseId: key.releaseId, requestId: key.requestId, sequence: key.sequence, terminal});
  }
  function drainInputScript() {
    if (!inputScript || !nativeInputScript || nativeExited || closed) return;
    try {
      const terminal = nativeInputScript.take(inputScript);
      if (!terminal) return;
      const request = inputScript;
      inputScript = undefined;
      inputScriptTimer?.();
      inputScriptTimer = undefined;
      postInputScript(request, terminal);
    } catch (error) { fatal(error); }
  }
  function cancelInputScript(request: InputScriptRequest, reason: 'cancelled' | 'timeout' | 'run_ended' | 'hidden') {
    if (inputScript !== request || nativeExited || closed) return;
    try {
      nativeInputScript?.cancel(request.sequence, reason);
      drainInputScript();
    } catch (error) { fatal(error); }
  }
  function receiveInputScript(message: Record<string, unknown>) {
    const key = readInputScriptKey(message, identity.runId, boot.release.releaseId);
    if (!key) return;
    if (message.type === 'input-script-cancel') {
      if (inputScript && matchesInputScript(inputScript, key)) cancelInputScript(inputScript,
        interactionNow() >= inputScript.deadline ? 'timeout' : message.hidden === true ? 'hidden' : 'cancelled');
      return;
    }
    if (key.sequence <= lastInputScriptSequence) return;
    lastInputScriptSequence = key.sequence;
    const request = readInputScriptRequest(message, key);
    const reason = !request ? 'invalid_input' : !lease.active || stopping || nativeExited || closed ? 'run_ended' :
      !nativeStarted ? 'not_ready' : !inputScriptSupported || !nativeInputScript ? 'unsupported' :
      !('actionName' in request.command) && !nativeInputScript.devices ? 'unsupported' :
      'requireUnscaled60Hz' in request.command && !nativeInputScript.holdMilliseconds ? 'unsupported' :
      request.deadline <= interactionNow() ? 'timeout' : inputScript ? 'busy' : undefined;
    try {
      if (reason || !request || !nativeInputScript) {
        postInputScript(key, noInputScript('worker', reason ?? 'not_ready'));
        return;
      }
      const geometryEpoch = 'button' in request.command ? request.command.geometryEpoch ?? presentation?.geometry.epoch : undefined;
      if (!nativeInputScript.stage(request, geometryEpoch)) {
        postInputScript(key, noInputScript('worker', 'not_ready'));
        return;
      }
      inputScript = request;
      inputScriptTimer = scheduleRuntimeWriteDeadline(request.deadline, () => cancelInputScript(request, 'timeout'));
      drainInputScript();
    } catch (error) { fatal(error); }
  }
  const declaresObservation = supportsWorkerObservation(boot.release);
  let sampleNativeObservation: ReturnType<typeof createNativeRuntimeSampler> | undefined;
  let removeObservationHooks: (() => void) | undefined;
  const observationRejection = (): ObservationError | undefined => !lease.active || stopping || closed || nativeExited ? 'run_ended' :
    !nativeStarted ? 'not_ready' : sampleNativeObservation ? undefined : 'unsupported';
  const postObservation = (response: RuntimeObservationReply) => {
    try { post({type: 'runtime-observation-result', ...response}); }
    catch { /* A lost observer is retired by the Host deadline or run close. */ }
  };
  const observation = createWorkerObservationRequests(query => {
    const rejection = observationRejection();
    return rejection ? observationError(rejection) : sampleNativeObservation!(query);
  }, postObservation);
  const supportsWrite = supportsWorkerRuntimeWrite(boot.release, boot.configuration.presentationBackend);
  let writeNativeProperty: ReturnType<typeof createNativeRuntimeWriter> | undefined;
  const writeUnavailable = (): AccessErrorCode | undefined => !lease.active || stopping || closed || nativeExited ? 'run_ended' :
    !nativeStarted ? 'not_ready' : !supportsWrite || !writeNativeProperty ? 'unsupported' : undefined;
  const supportsProperties = supportsWorkerRuntimeProperties(boot.release, boot.configuration.presentationBackend);
  let accessNativeProperties: ReturnType<typeof createNativeRuntimeProperties> | undefined;
  const propertiesUnavailable = (): AccessErrorCode | undefined => !lease.active || stopping || closed || nativeExited ? 'run_ended' :
    !nativeStarted ? 'not_ready' : !supportsProperties || !accessNativeProperties ? 'unsupported' : undefined;
  const supportsCall = supportsWorkerRuntimeCall(boot.release, boot.configuration.presentationBackend);
  let nativeCall: ReturnType<typeof createNativeRuntimeCall> | undefined;
  const callUnavailable = (): AccessErrorCode | undefined => !lease.active || stopping || closed || nativeExited ? 'run_ended' :
    !nativeStarted ? 'not_ready' : !supportsCall || !nativeCall ? 'unsupported' : undefined;
  const runScope = JSON.stringify([identity.runId, boot.release.releaseId]);
  const runtimeAccess = createWorkerRuntimeAccess(request => {
    if (request.family === 'method') {
      const rejected = callUnavailable();
      if (rejected) return runtimeMethodError(rejected as 'run_ended' | 'not_ready' | 'unsupported', 'worker');
      const command = request.command as MethodCommand;
      // Account for the public method tokens and the outer receipt before
      // asking native to fit its reply into the shared result buffer.
      const correlation = {requestId: request.requestId, accessSequence: request.sequence, run: identity,
        releaseId: boot.release.releaseId, path: command.path, expectedInstanceId: command.expectedInstanceId, method: command.method};
      const tokenBytes = command.kind === 'describe' ? (command.limit ?? 1) *
        new TextEncoder().encode(JSON.stringify({version: 1, runId: identity.runId, releaseId: boot.release.releaseId, returnType: 'string', stamp: ''})).byteLength : 0;
      const overhead = new TextEncoder().encode(JSON.stringify(correlation)).byteLength + tokenBytes + 128;
      return nativeCall!(command, request.deadline, runScope, 65_536 - overhead);
    }
    if (request.family === 'write') {
      const rejected = writeUnavailable();
      return rejected ? runtimeWriteError(rejected as RuntimeSetError) : writeNativeProperty!(request.command as Parameters<NonNullable<typeof writeNativeProperty>>[0], request.deadline);
    }
    const rejected = propertiesUnavailable();
    if (rejected) return runtimePropertiesError(rejected, 'worker');
    const command = request.command as PropertyCommand;
    const receipt = {requestId: request.requestId, accessSequence: request.sequence, run: identity,
      releaseId: boot.release.releaseId, path: command.path, expectedInstanceId: command.expectedInstanceId};
    const overhead = new TextEncoder().encode(JSON.stringify(receipt)).byteLength + 11 + 1024;
    return accessNativeProperties!(command, request.deadline, 65536 - overhead);
  }, response => {
    const {family, sequence, ...payload} = response;
    try { post(family === 'write' ? {type: 'runtime-write-result', ...payload, writeSequence: sequence} :
      {type: 'runtime-' + family + '-result', ...payload, accessSequence: sequence}); }
    catch { /* The runner retains execution uncertainty at its original deadline. */ }
  });
  const probeAvailable = supportsGameProbe(boot.release, boot.configuration.presentationBackend);
  let lastProbeSequence = 0;
  let nativeProbe: ReturnType<typeof createNativeGameProbe> | undefined;
  type ProbeSample = Extract<NonNullable<ReturnType<NonNullable<typeof nativeProbe>['take']>>, {ok: true}>['result'];
  let probeRequest: (NonNullable<ReturnType<typeof readGameProbeRequest>> & {
    minGeometryEpoch: number;
    stopTimer?: () => void;
    sample?: ProbeSample;
    failure?: ReturnType<typeof gameProbeError>;
  }) | undefined;

  function postProbe(requestId: string, result: {ok: true; result: GameProbeData} | ReturnType<typeof gameProbeError>) {
    const image = result.ok ? result.result.image : null;
    sendInteractionResult({type: 'game-probe-result', requestId, result},
      {result: result.ok ? gameProbeError('probe_failed', 'dispatch_failed') : result}, image ? [image.bytes] : []);
  }

  function postCapture(requestId: string, frame: CapturedFrame | undefined, error: InteractionError | undefined) {
    sendInteractionResult({type: 'capture-result', requestId, frame, error},
      {error: error ?? 'capture_failed'}, frame ? [frame.bytes] : []);
  }

  function finishProbe(requestId: string, result: Parameters<typeof postProbe>[1]) {
    if (probeRequest?.requestId !== requestId) return;
    probeRequest.stopTimer?.();
    probeRequest = undefined;
    queueMicrotask(() => {
      if (!probeRequest && !closed && !nativeExited) nativeProbe?.clear();
    });
    postProbe(requestId, result);
  }

  function cancelProbe(code: GameProbeError) {
    const request = probeRequest;
    if (!request) return;
    request.failure ??= gameProbeError(code);
    if (request.query.screenshot) capture.finishProbe(request.requestId, code === 'run_ended' || code === 'cancelled' ||
      code === 'timeout' ? code : 'capture_failed');
    else finishProbe(request.requestId, request.failure);
  }

  function takeProbe() {
    const request = probeRequest;
    if (!request || request.sample || request.failure || !nativeProbe) return;
    try {
      const result = nativeProbe.take(request.query);
      if (!result) return;
      if (!result.ok) {
        request.failure = result;
        cancelProbe(result.error.code);
      } else if (request.query.screenshot) {
        request.sample = result.result;
        capture.finishProbe(request.requestId);
      } else {
        const {iteration, properties, tree} = result.result;
        finishProbe(request.requestId, {ok: true, result: {mode: 'state', frame: {iteration}, image: null, properties, tree}});
      }
    } catch { cancelProbe('probe_failed'); }
  }

  let interactionReady = false;
  const interactionRejection = () => !lease.active || stopping || closed || nativeExited ? 'run_ended' :
    !interactionReady || xr?.active || dom?.document.hidden ? 'not_ready' : undefined;
  const capture = createWorkerCapture(boot.canvas, () => !interactionRejection(),
    (requestId, frame, error, kind) => {
      if (kind !== 'probe') {
        postCapture(requestId, frame, error);
        return;
      }
      const current = probeRequest;
      if (current?.requestId !== requestId) return;
      const sample = current.sample;
      if (current.failure || error || !frame || !sample ||
          sample.iteration !== frame.iteration || sample.renderSerial !== frame.renderSerial) {
        finishProbe(requestId, current.failure ?? gameProbeError(error ?? 'probe_failed'));
        return;
      }
      const {iteration, renderSerial, properties, tree} = sample;
      finishProbe(requestId, {ok: true, result: {mode: 'rendered', frame: {iteration, renderSerial}, image: frame, properties, tree}});
    },
    estimated => !!presentation && (presentation.stats().aggregateEstimatedBytes ?? Infinity) + estimated <=
      (boot.configuration.budgets.maxPresentationBytes ?? 0),
    () => { try { applyLatestGeometry(); } catch (error) { fatal(error); } });
  const gestures = createWorkerGesture(
    (operationId, evidence) => post({type: 'input-result', operationId, evidence}),
    gesture => interactionRejection() ??
      (gesture.kind === 'primary_click' && gesture.geometryEpoch !== presentation?.geometry.epoch ? 'geometry_conflict' : undefined),
    (gesture, down) => dom?.dispatchGesture(gesture, down) ?? false,
  );
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
  const phase = (value: RunPhase) => {
    assertStarting();
    post({type: 'phase', phase: value, ...(value === 'running' && supportsInteraction ? {interactionVersion: INTERACTION_VERSION} : {}),
      ...(value === 'running' && inputScriptSupported && nativeInputScript ? {inputScriptVersion: INPUT_SCRIPT_VERSION,
        ...(nativeInputScript.devices ? {inputScriptDevices: true} : {}),
        ...(nativeInputScript.holdMilliseconds ? {inputScriptHoldMilliseconds: true} : {})} : {}),
      ...(value === 'running' && sampleNativeObservation ? {observationVersion: RUNTIME_OBSERVATION_VERSION} : {}),
      ...(value === 'running' && supportsWrite && writeNativeProperty ? {runtimeWriteVersion: RUNTIME_WRITE_VERSION} : {}),
      ...(value === 'running' && supportsProperties && accessNativeProperties ? {runtimePropertiesVersion: RUNTIME_PROPERTIES_VERSION} : {}),
      ...(value === 'running' && supportsCall && nativeCall ? {runtimeCallVersion: RUNTIME_CALL_VERSION} : {}),
      ...(value === 'running' && nativeProbe ? {gameProbeVersion: GAME_PROBE_VERSION} : {})});
  };
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
  let commandSequence = 0, latestGeometry: CanvasGeometry | undefined, deferredGeometrySequence: number | undefined;
  function acknowledgeData(dataSequence: number, withCheckpoint = false) {
    dataPost({type: 'data-receipt', dataSequence,
      ...(withCheckpoint && presentation ? {presentationCheckpoint: presentation.checkpoint()} : {})});
  }
  function applyLatestGeometry() {
    if (!latestGeometry || !presentation || !dom || !lease.active || stopping || xr?.active) return;
    if (presentation.resize(latestGeometry, capture.reservedBytes) === false && capture.reservedBytes) return;
    dom.resize(latestGeometry);
    latestGeometry = undefined;
    if (deferredGeometrySequence !== undefined) {
      const sequence = deferredGeometrySequence;
      deferredGeometrySequence = undefined;
      acknowledgeData(sequence, true);
    }
  }
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
    removeObservationHooks?.();
    inputScriptTimer?.();
    presentation?.dispose(); dom?.dispose(); browser?.dispose(); xr?.dispose(); loaded?.dispose();
    pendingHostCommands.clear();pendingCleanupHostCommands.clear();
    scope.removeEventListener('error', onError); scope.removeEventListener('unhandledrejection', onRejection);
    for (const level of ['log', 'warn', 'error'] as const) console[level] = originals[level];
  };
  const fatal = (error: unknown, source: 'browser' | 'godotjs' = 'browser',
    location?: { message?: string; filename?: string; line?: number; column?: number }, fromRuntimeBinding = false) => {
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
    post({ type: 'worker-fatal', diagnostic, detail: diagnostic.message,
      ...(fromRuntimeBinding ? {runtimeFailureCapture: 'observed'} : {}) });
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
    // Check whether this exact Promise was returned or thrown by a runtime call.
    if (supportsCall && scope._jsbb_?.IsRuntimeCallValue?.(event.promise) === true) {
      event.preventDefault();
      return;
    }
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
    attempt(()=>cancelProbe('run_ended'));
    attempt(()=>capture.stop());
    attempt(()=>observation.stop());
    attempt(()=>runtimeAccess.stop());
    const activeInputScript = inputScript;
    if (activeInputScript) queueMicrotask(() => cancelInputScript(activeInputScript, 'run_ended'));
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
    } else if (m.type === 'input-script-request' || m.type === 'input-script-cancel') {
      receiveInputScript(m);
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
    const family = runtimeAccessFamily(m.type);
    if (family && !m.type.endsWith('-result')) {
      const id = readAccessId(family, m, identity.runId);
      if (id && m.type.endsWith('-cancel')) runtimeAccess.cancel(id);
      else if (id) runtimeAccess.request(id, m, family === 'write' ? writeUnavailable() : family === 'method' ? callUnavailable() : propertiesUnavailable());
      if (Number.isSafeInteger(m.dataSequence)) acknowledgeData(m.dataSequence);
      return;
    }
    if (m.type === 'runtime-observation-request' || m.type === 'runtime-observation-cancel') {
      if (validInteractionId(m.requestId)) {
        if (m.type === 'runtime-observation-cancel') observation.cancel(m.requestId);
        else {
          const request = readRuntimeObservationRequest(m);
          const rejection = observationRejection();
          if (request && !rejection) observation.request(request);
          else postObservation({requestId: m.requestId, result: observationError(!request ? 'invalid_input' : rejection!)});
        }
      }
      if (Number.isSafeInteger(m.dataSequence)) acknowledgeData(m.dataSequence);
      return;
    }
    if (m.type === 'game-probe-request' || m.type === 'game-probe-cancel') {
      try {
        if (m.type === 'game-probe-cancel' && probeRequest?.requestId === m.requestId) cancelProbe('cancelled');
        const sequence = m.type === 'game-probe-request' ? readGameProbeSequence(m.requestId, identity.runId) : undefined;
        if (sequence !== undefined && sequence > lastProbeSequence) {
          lastProbeSequence = sequence;
          const request = readGameProbeRequest(m);
          const minGeometryEpoch = m.minGeometryEpoch;
          const error = !request || request.query.screenshot && !validInteractionSequence(minGeometryEpoch) ? 'invalid_input' :
            !lease.active || stopping || nativeExited ? 'run_ended' :
            !nativeStarted ? 'not_ready' : !nativeProbe || !supportsInteraction ? 'unsupported' :
            request.deadline <= interactionNow() ? 'timeout' :
            probeRequest || request.query.screenshot && capture.busy ? 'busy' :
            request.query.screenshot ? interactionRejection() : undefined;
          if (error) postProbe(m.requestId, gameProbeError(error));
          else if (request && nativeProbe) {
            probeRequest = {...request, minGeometryEpoch: minGeometryEpoch ?? 0};
            if (!request.query.screenshot)
              probeRequest.stopTimer = scheduleRuntimeWriteDeadline(request.deadline, () => cancelProbe('timeout'));
            else capture.request(request.requestId, request.deadline, 'probe', request.query.maxDimension);
            if (probeRequest?.requestId === request.requestId && !nativeProbe.stage(request.query, request.deadline))
              cancelProbe(interactionNow() >= request.deadline ? 'timeout' : 'not_ready');
          }
        }
      } catch { cancelProbe('probe_failed'); }
      if (Number.isSafeInteger(m.dataSequence)) acknowledgeData(m.dataSequence);
      return;
    }
    const rejection = m.type === 'capture-request' || m.type === 'input-request' ? interactionRejection() : undefined;
    if (rejection) {
      if (m.type === 'capture-request' && validInteractionId(m.requestId)) postCapture(m.requestId, undefined, rejection);
      if (m.type === 'input-request' && validInteractionId(m.operationId)) post({type: 'input-result', operationId: m.operationId, evidence: undispatched(rejection)});
    }
    const cleanupPacket=['host-command-receipt','present-ack','host-result'].includes(m.type)||(m.type==='host-state'&&m.state?.requestId!==undefined);
    if((stopping&&!cleanupPacket)||(binding?.snapshotSummary().sealed&&m.type!=='host-command-receipt')){
      if(Number.isSafeInteger(m.dataSequence))dataPost({type:'data-receipt',dataSequence:m.dataSequence});return;
    }
    if(!lease.active){
      if(m.type==='host-command-receipt')receiveHostCommandReceipt(m.commandSequence);
      if(Number.isSafeInteger(m.dataSequence))dataPost({type:'data-receipt',dataSequence:m.dataSequence});
      return;
    }
    let deferReceipt = false;
    try {
      if (m.type === 'host-command-receipt') { receiveHostCommandReceipt(m.commandSequence); }
      else if (m.type === 'present-ack') presentation?.ack(m as any);
      else if (m.type === 'input') { benchmark?.inputReceived(m.packet);const accepted=dom?.dispatchInput(m.packet as any)??false;benchmark?.inputDispatched(m.packet.sequence,accepted); }
      else if (m.type === 'geometry') {
        if (deferredGeometrySequence !== undefined) acknowledgeData(deferredGeometrySequence);
        deferredGeometrySequence = undefined;
        latestGeometry = m.geometry;
        applyLatestGeometry();
        // Keep one receipt for the newest deferred resize so the Host retires
        // its geometry reservations only after the Worker applies that size.
        if (latestGeometry && capture.reservedBytes && Number.isSafeInteger(m.dataSequence)) {
          deferredGeometrySequence = m.dataSequence;
          deferReceipt = true;
        }
      }
      else if (m.type === 'capture-request' && !rejection && validInteractionId(m.requestId) && Number.isFinite(m.deadline)) {
        capture.request(m.requestId, m.deadline);
      }
      else if (m.type === 'capture-cancel' && validInteractionId(m.requestId)) capture.cancel(m.requestId);
      else if (m.type === 'input-request' && !rejection && validInteractionId(m.operationId) &&
        validInteractionSequence(m.sequence) && Number.isFinite(m.deadline)) {
        const gesture = readGesture(m.gesture);
        if (gesture) gestures.perform(m.operationId, m.sequence, m.deadline, gesture);
      }
      else if (m.type === 'host-state') {
        if (dom) dom.applyHostState(m.state);
        else if (pendingHostStates.length < 32) pendingHostStates.push(m.state);
        else throw Error('E_WORKER_HOST_STATE_BUDGET');
        if (!stopping&&typeof m.state?.visible === 'boolean') presentation?.setVisible(m.state.visible && !xr?.active);
      }
      else if (m.type === 'host-result') dom?.applyHostState(m as any);
    } catch (error) { fatal(error); }
    finally {
      if (!deferReceipt && Number.isSafeInteger(m.dataSequence)) acknowledgeData(m.dataSequence, m.type === 'geometry' || m.type === 'present-ack');
    }
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
        if(!active)applyLatestGeometry();
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
    applyLatestGeometry();
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
        else fatal({message:diagnostic.message,stack:diagnostic.stack??diagnostic.componentStack},
          pendingFatalSource??'godotjs',pendingFatalLocation,pendingFatalSource===undefined);
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
      onExit: (code: number) => {
        if (nativeExited) return;
        nativeExited = true;
        gestures.exit();
        cancelProbe('run_ended');
        capture.stop();
        observation.stop();
        runtimeAccess.stop();
        const runtimeSummary = binding?.snapshotSummary();
        post({type: 'native-exit', code, memory: metrics(), runtimeSummary,
          ...(!failed && canSettleEmptyRuntimeFailureCapture(runtimeSummary, code) ? {runtimeFailureCapture: 'settled_empty'} : {})});
        release(); scope.close?.();
      },
    });
    const config = (engine as any).config;
    if (!config || typeof config.getModuleConfig !== 'function') throw Error('E_WORKER_MODULE_CONFIG');
    const original = config.getModuleConfig;
    config.getModuleConfig = function (...args: unknown[]) {
      const value = original.apply(this, args);
      if (inputScriptSupported) value.godotInputScriptTerminal = () => {
        if (inputScript) queueMicrotask(drainInputScript);
      };
      if (inputScriptSupported) value.godotInputScriptClickFits = (epoch: number, x: number, y: number) =>
        !latestGeometry && !interactionRejection() && (epoch >>> 0) === presentation?.geometry.epoch &&
        x < boot.canvas.width && y < boot.canvas.height;
      if (probeAvailable && supportsInteraction) {
        value.godotGameProbeMayFreeze = () => {
          const geometry = presentation?.geometry;
          if (!probeRequest?.query.screenshot || probeRequest.failure || !geometry || interactionRejection() ||
              geometry.epoch < probeRequest.minGeometryEpoch) return false;
          const {maxCanvasDimension, maxCanvasPixels} = boot.configuration.budgets;
          const size = drawingBufferSize(geometry, {maxDimension: maxCanvasDimension, maxPixels: maxCanvasPixels});
          const gl = (boot.canvas as OffscreenCanvas & {GLctxObject?: {GLctx?: WebGL2RenderingContext}}).GLctxObject?.GLctx;
          return !!gl && !gl.isContextLost() && size.width === boot.canvas.width && size.height === boot.canvas.height &&
            gl.drawingBufferWidth === size.width && gl.drawingBufferHeight === size.height;
        };
        value.godotGameProbeFreeze = (iteration: number, serial: number) => !!probeRequest && !!presentation &&
          capture.freezeProbe(probeRequest.requestId, iteration, serial, presentation.geometry);
      }
      module = value; installPresentationHooks(value, presentation!, supportsInteraction ? capture.frame : undefined);
      if (declaresObservation) {
        removeObservationHooks?.();
        removeObservationHooks = installRuntimeObservationHooks(value, () => {
          takeProbe();
          runtimeAccess.execute();
          observation.observe();
        });
      }
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
    if (declaresObservation) {
      if (!module || !removeObservationHooks) throw Error('E_RUNTIME_OBSERVATION_ABI');
      sampleNativeObservation = createNativeRuntimeSampler(module);
      if (boot.release.runtimeAbi?.runtimeWrite === RUNTIME_WRITE_VERSION) writeNativeProperty = createNativeRuntimeWriter(module);
      if (boot.release.runtimeAbi?.runtimeProperties === RUNTIME_PROPERTIES_VERSION) accessNativeProperties = createNativeRuntimeProperties(module);
      if (boot.release.runtimeAbi?.runtimeCall === RUNTIME_CALL_VERSION) nativeCall = createNativeRuntimeCall(module);
    }
    if (probeAvailable && supportsInteraction) nativeProbe = createNativeGameProbe(module!);
    if (boot.release.runtimeAbi?.inputScript === INPUT_SCRIPT_VERSION) nativeInputScript = createNativeInputScript(module!);
    phase('starting'); await engine.start({ args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility'] }); assertStarting();
    nativeStarted=true;
    if(managedClose&&!lifecycleGate)throw Error('E_NATIVE_LIFECYCLE_ABI: matching native hook was not installed');
    if(stopping)return;
    // Engine.start resolves only after native resume/setup2/start, not callMain.
    phase('waiting-ready'); await Promise.resolve(); assertStarting(); interactionReady = supportsInteraction; phase('running');
    post({ type: 'worker-metrics', memory: metrics() });
  } catch (error) {
    if(closed||nativeExited)return;
    if(stopping||!lease.active||aborter.signal.aborted){
      if(!canCooperativelyClose())post({type:'worker-termination-required',stage:'cancelled-startup'});
    }else fatal(error);
  }
}
