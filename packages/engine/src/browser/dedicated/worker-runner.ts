import { createSessionFacts, isSessionFacts, sessionExitReason, type SessionFacts, type SessionExitReason } from '../../session-facts.js';
import { DEFAULT_DEADLINES, RUN_PHASES, isIdentity, isPreviewDiagnostic, isProjectData, normalizedOrigin, previewDiagnostic,
  type BrowserArtifact, type ExitReport, type PhaseDeadlines, type RunnerEvent, type RunnerState } from '../protocol.js';
import { resolveVerifiedRelease, type VerifiedRelease } from '../verified-loader.js';
import { WORKER_PROTOCOL, prepareWorkerRunConfiguration, isWorkerEnvelope, sameWorkerRun,
  type WorkerRunIdentity, type WorkerRunConfiguration } from './worker-protocol.js';
import { isWorkerEngineOutcome, isWorkerHostCleanupOutcome, type WorkerEngineOutcome, type WorkerHostCleanupOutcome } from './worker-session.js';
import { WorkerProjectCommandCredits,workerProjectCommandBytes } from './worker-project-channel.js';
import { WorkerLogBudget } from './worker-log.js';
import {captureBrowserArtifact,browserArtifactTransfers} from '../artifact-input.js';
import {
  INPUT_RECEIPT_MS, INPUT_START_MS, INTERACTION_VERSION, inputStatus, interactionError, interactionNow,
  interactionOk, isCapturedFrame, readGesture, readInputEvidence, undispatched, validInteractionId,
  type GameInput, type GameScreenshot, type InputEvidence, type InputReceipt, type InteractionError,
  type InteractionResult, type ScreenshotInput, type WaitForInput,
} from './worker-interaction.js';
import {
  RUNTIME_OBSERVATION_VERSION, observationError, observationOk, prepareRuntimeObservation, readRuntimeObservationReply,
  supportsWorkerObservation, type ObservationResult, type RuntimeNodeInput, type RuntimeNodeSnapshot,
  type RuntimeObservationQuery, type RuntimeObservationState, type RuntimeTreeInput, type RuntimeTreeSnapshot,
} from './worker-runtime-observation.js';
export {supportsWorkerInteraction} from './worker-interaction.js';
export type {GameGesture, GameInput, GameScreenshot, InputReceipt, InteractionResult, ScreenshotInput, WaitForInput} from './worker-interaction.js';
export {prepareRuntimeObservation, supportsWorkerObservation} from './worker-runtime-observation.js';
export type {ObservationError, ObservationResult, PreparedRuntimeObservation, RuntimeNodeInput, RuntimeNodeSnapshot,
  RuntimeObservationState, RuntimeObservedNode, RuntimeObservedProperty, RuntimePropertySample,
  RuntimeTreeInput, RuntimeTreeSnapshot} from './worker-runtime-observation.js';
const now = () => performance.now();
const MAX_WAIT_MS = 60_000;
const MAX_RECEIPTS = 32;
const MAX_INPUT_WAITERS = 16;
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

interface InputRecord {
  receipt: InputReceipt;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}
interface CaptureRequest {
  id: string;
  deadline: number;
  finish(result: InteractionResult<GameScreenshot>): void;
}
type ObservationSnapshot = RuntimeTreeSnapshot | RuntimeNodeSnapshot;
interface ObservationRequest {
  id: string;
  deadline: number;
  query: RuntimeObservationQuery;
  finish(result: ObservationResult<ObservationSnapshot>): boolean;
}

export interface WorkerPreviewRunnerOptions {
  container: HTMLElement;
  previewUrl: string;
  release: VerifiedRelease;
  configuration?: Partial<WorkerRunConfiguration>;
  editorOrigin?: string;
  deadlines?: Partial<PhaseDeadlines>;
}
export interface WorkerRunResult extends WorkerRunIdentity { state: 'running'; releaseId: string }
export type WorkerObservedExit = Omit<ExitReport, 'reason' | 'cleanup' | 'sessionFacts'> & WorkerRunIdentity & {
  reason: SessionExitReason;
  engineOutcome: Readonly<WorkerEngineOutcome>;
  hostCleanup: Readonly<WorkerHostCleanupOutcome>;
  sessionFacts: SessionFacts;
};
export type WorkerLocalExit = Omit<ExitReport, 'reason' | 'cleanup' | 'sessionFacts' | 'code'> & WorkerRunIdentity & {
  reason: 'crashed' | 'forced-frame-disposal';
  code?: never;
  engineOutcome?: never;
  hostCleanup?: never;
  sessionFacts?: never;
};
export type WorkerRunnerExit = WorkerObservedExit | WorkerLocalExit;
export type WorkerRunnerEvent =
  | (Exclude<RunnerEvent, {type: 'exit'}> & WorkerRunIdentity)
  | {type: 'exit'; report: WorkerRunnerExit};
interface Session {
  identity: WorkerRunIdentity; frame: HTMLIFrameElement; port: MessagePort; peer?: MessagePort;
  state: RunnerState; epoch: number; settled: boolean; lastWorkerBeat: number;
  beatSequence: number; resumeEpoch: number; logs: WorkerLogBudget;
  projectQueue: Array<{ data: Record<string, unknown>; projectSequence?: number }>; projectBytes: number;
  commands:WorkerProjectCommandCredits;commandSequence:number;
  interactionVersion?: number;
  capture?: CaptureRequest;
  observation?: ObservationRequest;
  observationSampleSeq: number;
  input?: InputRecord;
  inputSequence: number;
  failure?: ReturnType<typeof previewDiagnostic>;
  timer?: ReturnType<typeof setTimeout>; watchdog?: ReturnType<typeof setInterval>;
  onVisibility?: () => void;
  resolveRun(value: WorkerRunResult): void; rejectRun(error: Error): void;
  exit: Promise<WorkerRunnerExit>; resolveExit(value: WorkerRunnerExit): void; report?: WorkerRunnerExit;
}

/** Protocol 2 never accepts a protocol 1 frame. The iframe owns termination;
 * removing an unreachable iframe is reported separately from Worker termination. */
export class WorkerPreviewRunner {
  readonly editorOrigin: string;
  readonly previewOrigin: string;
  private readonly deadlines: PhaseDeadlines;
  private readonly listeners = new Set<(event: WorkerRunnerEvent) => void>();
  private readonly inputRecords = new Map<string, InputRecord>();
  private readonly interactionVersions = new Map<string, boolean | null>();
  private readonly observationVersions = new Map<string, boolean | null>();
  private inputWaiters = 0;
  private active?: Session;
  private sequence = 0;
  private disposed = false;
  private currentState: RunnerState = 'idle';
  private readonly release: VerifiedRelease;
  private readonly previewUrl: string;
  constructor(private readonly options: WorkerPreviewRunnerOptions) {
    this.editorOrigin = normalizedOrigin(options.editorOrigin ?? options.container.ownerDocument.location.origin);
    this.previewOrigin = normalizedOrigin(options.previewUrl);
    if (this.editorOrigin === this.previewOrigin) throw Error('E_PREVIEW_REQUIRES_SEPARATE_ORIGIN');
    const release = resolveVerifiedRelease(options.release, options.previewUrl);
    if (!options.release.runtimeAbi || !options.release.runtimeWorker || !options.release.runtimeAudioWorklet) throw Error('E_WORKER_RELEASE_ABI');
    this.release = structuredClone(release);
    this.previewUrl = options.previewUrl;
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
    for (const [phase, value] of Object.entries(this.deadlines)) {
      if (!Number.isFinite(value) || value < 0 || (phase !== 'running' && value === 0)) throw Error(`E_RUNNER_DEADLINE: ${phase}`);
    }
  }
  get state(): RunnerState { return this.currentState; }
  subscribe(listener: (event: WorkerRunnerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: WorkerRunnerEvent): void { for (const listener of [...this.listeners]) { try { listener(event); } catch { /* UI isolation. */ } } }
  private live(s: Session): boolean { return this.active === s && !s.settled; }
  private transition(s: Session, state: RunnerState): boolean {
    if (!this.live(s)) return false;
    clearTimeout(s.timer);
    const epoch = ++s.epoch;
    this.currentState = s.state = state;
    this.emit({ type: 'state', state, ...s.identity });
    if (!this.live(s) || epoch !== s.epoch) return false;
    const delay = state === 'idle' || state === 'exited' ? 0 : this.deadlines[state];
    if (delay) s.timer = setTimeout(() => {
      if (!this.live(s) || epoch !== s.epoch) return;
      // Give the live host its own bounded termination window before removal.
      if (state !== 'stopping') this.beginStop(s, 'unresponsive', `Deadline exceeded during ${state}`);
      else this.finishLocal(s, 'forced-frame-disposal', 'Host termination receipt unavailable; frame removed.');
    }, delay);
    return true;
  }
  private finishLocal(s: Session, reason: WorkerLocalExit['reason'], detail?: string): WorkerRunnerExit {
    return this.finish(s, { ...s.identity, reason, ...(detail ? { detail: detail.slice(0, 4096) } : {}), ...(s.failure ? { diagnostic: s.failure } : {}) });
  }
  private finish(s: Session, report: WorkerRunnerExit): WorkerRunnerExit {
    if (s.report) return s.report;
    s.report = report; s.settled = true; ++s.epoch;
    s.capture?.finish(interactionError('run_ended'));
    s.observation?.finish(observationError('run_ended'));
    if (s.input) this.settleInput(s.input, {down: 'unconfirmed', up: 'unconfirmed', reason: 'run_ended'});
    s.projectQueue.length=0;s.projectBytes=0;s.commands.clear();
    clearTimeout(s.timer); clearInterval(s.watchdog);
    if(s.onVisibility)this.options.container.ownerDocument.removeEventListener?.('visibilitychange',s.onVisibility);
    s.port.onmessage = null; s.port.close(); s.peer?.close();
    s.frame.onload = s.frame.onerror = null; s.frame.remove();
    if (this.active === s) { this.active = undefined; this.currentState = 'exited'; }
    s.rejectRun(Error(`E_RUN_ENDED: ${report.reason}${report.detail ? ': ' + report.detail : ''}`));
    s.resolveExit(report);
    this.emit({ type: 'state', state: 'exited', ...s.identity }); this.emit({ type: 'exit', report });
    return report;
  }
  /** Aborting launch preparation has no effect on an already created session. */
  async run(artifact: BrowserArtifact, {signal}: {signal?: AbortSignal} = {}): Promise<WorkerRunResult> {
    if (this.disposed) throw Error('E_RUNNER_DISPOSED');
    if (signal?.aborted) throw new DOMException('Superseded', 'AbortError');
    if (!artifact.artifactSet&&(!(artifact.pack instanceof Uint8Array) || !artifact.pack.byteLength || artifact.pack.byteLength > 64 * 1024 * 1024)) throw Error('E_ARTIFACT_PACK');
    if (!isIdentity({ runId: 'validate', ...artifact }) || !artifact.manifest || typeof artifact.manifest !== 'object' || (artifact.manifest as { generation?: unknown }).generation !== artifact.generation) throw Error('E_ARTIFACT_GENERATION');
    const manifest = artifact.manifest as { engineReleaseId?: unknown; engineProfile?: unknown };
    if (manifest.engineReleaseId !== undefined && manifest.engineReleaseId !== this.release.releaseId) throw Error('E_ARTIFACT_ENGINE_RELEASE');
    if (manifest.engineProfile !== undefined && manifest.engineProfile !== this.release.profile) throw Error('E_ARTIFACT_ENGINE_PROFILE');
    const sequence = ++this.sequence;
    const snapshot = await captureBrowserArtifact(artifact,this.release,this.release.artifactReceiptVersion!==2);
    const frozen = await prepareWorkerRunConfiguration(this.options.configuration ?? {});
    // A slower, superseded hash must never stop the newer active session.
    if (signal?.aborted || sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
    await this.stopActive();
    if (signal?.aborted || sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
    const identity: WorkerRunIdentity = { runId: crypto.randomUUID(), revision: snapshot.revision, buildKey: snapshot.buildKey, generation: snapshot.generation,
      documentId: crypto.randomUUID(), workerId: crypto.randomUUID(), runConfigurationHash: frozen.hash };
    const frame = this.options.container.ownerDocument.createElement('iframe');
    frame.title = 'Godot Worker preview';
    // The host bridges still enforce user activation and resource budgets.
    // Delegate their browser permissions across the separate preview origin.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-downloads allow-popups');
    const features = ['autoplay', 'fullscreen', 'microphone', 'midi', 'xr-spatial-tracking', 'clipboard-read', 'clipboard-write'];
    const policy = (frame as HTMLIFrameElement & { featurePolicy?: { features?(): string[] } }).featurePolicy;
    const recognized = policy?.features?.();
    const userAgent = frame.ownerDocument?.defaultView?.navigator.userAgent ?? '';
    // Gecko has no policy introspection and ignores these other declarations
    // with console warnings. Omitting ignored tokens preserves its API behavior.
    const delegated = recognized ? features.filter(feature => recognized.includes(feature))
      : /\bFirefox\/\d/.test(userAgent) ? ['fullscreen', 'microphone'] : features;
    frame.setAttribute('allow', delegated.join('; ')); frame.setAttribute('referrerpolicy', 'no-referrer');
    const url = new URL(this.previewUrl); url.searchParams.set('editorOrigin', this.editorOrigin); frame.src = url.href;
    const channel = new MessageChannel();
    let resolveRun!: Session['resolveRun'], rejectRun!: Session['rejectRun'], resolveExit!: Session['resolveExit'];
    const promise = new Promise<WorkerRunResult>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; }); void promise.catch(() => {});
    const exit = new Promise<WorkerRunnerExit>(resolve => { resolveExit = resolve; });
    const s: Session = { identity, frame, port: channel.port1, peer: channel.port2, state: 'loading-frame', epoch: 0, settled: false,
      lastWorkerBeat: now(), beatSequence: -1, resumeEpoch: 0, logs: new WorkerLogBudget(frozen.configuration.budgets), projectQueue: [], projectBytes: 0,
      commands:new WorkerProjectCommandCredits(frozen.configuration.budgets.maxProjectEvents!,frozen.configuration.budgets.maxProjectBytes!),commandSequence:0,
      inputSequence: 0, observationSampleSeq: 0, resolveRun, rejectRun, exit, resolveExit };
    this.active = s;
    this.interactionVersions.set(identity.runId, null);
    if (this.interactionVersions.size > MAX_RECEIPTS) this.interactionVersions.delete(this.interactionVersions.keys().next().value!);
    this.observationVersions.set(identity.runId, null);
    if (this.observationVersions.size > MAX_RECEIPTS) this.observationVersions.delete(this.observationVersions.keys().next().value!);
    s.onVisibility=()=>{if(this.live(s)&&this.options.container.ownerDocument.visibilityState!=='hidden')s.lastWorkerBeat=now();};
    this.options.container.ownerDocument.addEventListener?.('visibilitychange',s.onVisibility);
    s.port.onmessage = event => {
      if (!this.live(s) || !isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity)) return;
      const m: any = event.data;
      if (m.type === 'runtime-observation-result') {
        const current = s.observation;
        if (!current || m.requestId !== current.id) return;
        if (s.state !== 'running') { current.finish(observationError('run_ended')); return; }
        if (interactionNow() >= current.deadline) { current.finish(observationError('timeout')); return; }
        const response = readRuntimeObservationReply(current.query, m);
        if (!response.ok) { current.finish(response); return; }
        if (response.result.sampleSeq <= s.observationSampleSeq) {
          current.finish(observationError('observation_failed'));
          return;
        }
        s.observationSampleSeq = response.result.sampleSeq;
        current.finish(observationOk({...response.result, requestId: current.id, run: {...s.identity}, releaseId: this.release.releaseId}));
        return;
      }
      if (m.type === 'capture-result' && s.capture && m.requestId === s.capture.id) {
        const current = s.capture;
        s.capture = undefined;
        if (s.state !== 'running') current.finish(interactionError('run_ended'));
        else if (interactionNow() >= current.deadline) current.finish(interactionError('timeout'));
        else if (isCapturedFrame(m.frame)) current.finish(interactionOk({...m.frame, requestId: current.id,
          run: {...s.identity}, releaseId: this.release.releaseId}));
        else {
          const error: InteractionError = ['timeout', 'cancelled', 'unsupported', 'not_ready', 'busy', 'run_ended'].includes(m.error) ? m.error : 'capture_failed';
          current.finish(interactionError(error));
        }
        return;
      }
      if (m.type === 'input-result' && s.input && m.operationId === s.input.receipt.operationId) {
        const evidence = readInputEvidence(m.evidence);
        if (evidence) {
          this.expireInput(s.input);
          this.settleInput(s.input, evidence);
          s.input = undefined;
        }
        return;
      }
      if(m.type==='project-command-receipt'&&Number.isSafeInteger(m.commandSequence)){s.commands.release(m.commandSequence);return;}
      if (m.type === 'worker-heartbeat') {
        if (!Number.isSafeInteger(m.sequence) || m.sequence < 0 || m.resumeEpoch !== s.resumeEpoch || m.sequence <= s.beatSequence) return;
        s.resumeEpoch = m.resumeEpoch; s.beatSequence = m.sequence; s.lastWorkerBeat = now(); return;
      }
      if (m.type === 'visibility' && m.visible === true && Number.isSafeInteger(m.resumeEpoch) && m.resumeEpoch > s.resumeEpoch) {
        s.resumeEpoch = m.resumeEpoch; s.beatSequence = -1; s.lastWorkerBeat = now(); return;
      }
      if (m.type === 'connected' && s.state === 'handshaking') {
        if (!this.transition(s, 'downloading')) return;
        s.port.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, type: 'run', release: this.release,
          configuration: frozen.configuration, artifact: snapshot, stopTimeoutMs: Math.max(1, Math.floor(this.deadlines.stopping * 0.6)),
          cleanupTimeoutMs: Math.max(1, Math.min(frozen.configuration.budgets.cleanupTimeoutMs, Math.floor(this.deadlines.stopping * 0.3))) }, browserArtifactTransfers(snapshot));
      } else if (m.type === 'worker-closing') {
        this.beginStop(s, 'stopped', 'Native exit is preparing project cleanup');
      } else if (m.type === 'phase' && RUN_PHASES.includes(s.state as typeof RUN_PHASES[number])) {
        if (RUN_PHASES.indexOf(m.phase) !== RUN_PHASES.indexOf(s.state as typeof RUN_PHASES[number]) + 1) return;
        if (m.phase === 'running') {
          const observationVersion = supportsWorkerObservation(this.release) ? RUNTIME_OBSERVATION_VERSION : undefined;
          if (m.observationVersion !== observationVersion) {
            this.beginStop(s, 'runtime-failed', 'Runtime observation ABI does not match the release');
            return;
          }
          this.observationVersions.set(identity.runId, observationVersion !== undefined);
          if (m.interactionVersion === INTERACTION_VERSION && frozen.configuration.presentationBackend === 'direct')
            s.interactionVersion = INTERACTION_VERSION;
          this.interactionVersions.set(identity.runId, s.interactionVersion === INTERACTION_VERSION);
        }
        if (!this.transition(s, m.phase)) return;
        if (m.phase === 'running') {
          s.lastWorkerBeat = now();
          s.watchdog = setInterval(() => {
            if (this.live(s) && s.state === 'running' && this.options.container.ownerDocument.visibilityState !== 'hidden' && now() - s.lastWorkerBeat > this.deadlines.heartbeat)
              this.beginStop(s, 'unresponsive', 'Worker heartbeat stopped');
          }, Math.max(10, Math.min(500, this.deadlines.heartbeat / 2)));
          s.resolveRun({ ...identity, state: 'running', releaseId: this.release.releaseId });
          for(const queued of s.projectQueue.splice(0)){
            if(!this.live(s)||s.state!=='running')break;
            this.emit({type:'project',...identity,data:queued.data});
            if(this.live(s)&&s.state==='running'&&queued.projectSequence!==undefined)s.port.postMessage({...identity,protocolVersion:WORKER_PROTOCOL,type:'project-receipt',projectSequence:queued.projectSequence});
          }
          s.projectBytes=0;
        }
      } else if (m.type === 'log') {
        if (!['log', 'warn', 'error'].includes(m.level) || typeof m.text !== 'string' || m.text.length > 4096 || !s.logs.admit(m.text)) return;
        this.emit({ type: 'log', ...identity, level: m.level, text: m.text, untrusted: true });
      } else if (m.type === 'project' && isProjectData(m.data)) {
        if(s.state==='running'){
          this.emit({type:'project',...identity,data:m.data});
          if(this.live(s)&&Number.isSafeInteger(m.projectSequence))s.port.postMessage({...identity,protocolVersion:WORKER_PROTOCOL,type:'project-receipt',projectSequence:m.projectSequence});
        } else if(RUN_PHASES.includes(s.state as typeof RUN_PHASES[number])){
          const bytes=new TextEncoder().encode(JSON.stringify(m.data)).byteLength;
          if(s.projectQueue.length>=frozen.configuration.budgets.maxProjectEvents||s.projectBytes+bytes>frozen.configuration.budgets.maxProjectBytes){this.beginStop(s,'project-backpressure','Startup project event budget exceeded');return;}
          s.projectBytes+=bytes;s.projectQueue.push({data:m.data,projectSequence:Number.isSafeInteger(m.projectSequence)?m.projectSequence:undefined});
        }
      }
      else if (m.type === 'exit-report') {
        const outcome = m.engineOutcome, cleanup = m.hostCleanup, facts=m.sessionFacts;
        if (m.detail !== undefined && (typeof m.detail !== 'string' || m.detail.length > 4096)) return;
        if (!isWorkerEngineOutcome(outcome) || !isWorkerHostCleanupOutcome(cleanup) || !isSessionFacts(facts)) return;
        // Outer projections cannot contradict the sealed terminal facts.
        if(cleanup.status!==facts.hostCleanup || (outcome.kind==='native-exit' ? facts.nativeExit?.code!==outcome.code : facts.nativeExit!==undefined) || (outcome.kind==='terminate-issued')!==facts.forcedTerminationIssued)return;
        const retained=createSessionFacts({...facts,...(s.failure?{failure:facts.failure??{kind:'runtime',message:s.failure.message,...(s.failure.stack?{stack:s.failure.stack}:{})}}:{})});
        const reported=isPreviewDiagnostic(m.diagnostic)?m.diagnostic:retained.failure?{source:'godotjs' as const,message:retained.failure.message,...(retained.failure.stack?{stack:retained.failure.stack}:{})}:undefined;
        this.finish(s,{...s.identity,reason:sessionExitReason(retained),...(retained.nativeExit?{code:retained.nativeExit.code}:{}),...(m.detail?{detail:m.detail}:{}),
          engineOutcome:Object.freeze({...outcome}),hostCleanup:Object.freeze({...cleanup}),sessionFacts:retained,...(reported?{diagnostic:reported}:{})});
      }
    };
    s.port.start();
    frame.onload = () => {
      if (!this.live(s) || s.state !== 'loading-frame' || !this.transition(s, 'handshaking')) return;
      try {
        if (!frame.contentWindow || !s.peer) throw Error('E_PREVIEW_WINDOW');
        frame.contentWindow.postMessage({ ...identity, protocolVersion: WORKER_PROTOCOL, type: 'connect', editorOrigin: this.editorOrigin }, this.previewOrigin, [s.peer]); s.peer = undefined;
      } catch { this.finishLocal(s, 'crashed', 'Could not connect to the Worker host'); }
    };
    frame.onerror = () => this.finishLocal(s, 'crashed', 'Worker host document failed to load');
    if (this.transition(s, 'loading-frame')) { try { this.options.container.append(frame); } catch { this.finishLocal(s, 'crashed', 'Could not attach Worker host'); } }
    return promise;
  }
  private beginStop(s: Session, cause = 'stopped', detail?: string): void {
    if (!this.live(s) || s.state === 'stopping') return;
    if(cause!=='stopped')s.failure=previewDiagnostic(detail??cause);
    const before = s.state;
    s.observation?.finish(observationError('run_ended'));
    if (!this.transition(s, 'stopping')) return;
    s.capture?.finish(interactionError('run_ended'));
    if (before === 'loading-frame' || before === 'handshaking') { this.finishLocal(s, 'forced-frame-disposal', 'Cancelled before host connection'); return; }
    try { s.port.postMessage({ ...s.identity, protocolVersion: WORKER_PROTOCOL, type: 'stop', cause, detail }); }
    catch { this.finishLocal(s, 'forced-frame-disposal', 'Worker host stop channel unavailable'); }
  }
  private stopActive(): Promise<WorkerRunnerExit | undefined> { const s = this.active; if (!s) return Promise.resolve(undefined); this.beginStop(s); return s.exit; }
  async stop(): Promise<WorkerRunnerExit | undefined> { ++this.sequence; return this.stopActive(); }
  stopRun(runId: string): Promise<WorkerRunnerExit> | undefined {
    const session = this.active;
    if (!session || session.identity.runId !== runId) return undefined;
    this.beginStop(session);
    return session.exit;
  }
  interactionSupport(runId: string): 'available' | 'not_ready' | 'unsupported' | 'run_ended' | 'not_found' {
    const s = this.active;
    if (s?.identity.runId !== runId) return this.interactionVersions.has(runId) ? 'run_ended' : 'not_found';
    if (s.state === 'stopping' || s.report) return 'run_ended';
    if (s.state !== 'running') return 'not_ready';
    return s.interactionVersion === INTERACTION_VERSION ? 'available' : 'unsupported';
  }
  interactionState(runId: string): {supported: boolean | null; ready: boolean} {
    return {supported: this.interactionVersions.get(runId) ?? null, ready: this.interactionSupport(runId) === 'available'};
  }
  private observationSupport(runId: string): 'available' | 'not_ready' | 'unsupported' | 'run_ended' | 'not_found' {
    const session = this.active;
    if (session?.identity.runId !== runId) return this.observationVersions.has(runId) ? 'run_ended' : 'not_found';
    if (session.state === 'stopping' || session.settled) return 'run_ended';
    if (session.state !== 'running') return 'not_ready';
    return this.observationVersions.get(runId) === true ? 'available' : 'unsupported';
  }
  observationState(runId: string): RuntimeObservationState {
    const supported = this.observationVersions.get(runId) ?? null;
    return {supported, ready: this.observationSupport(runId) === 'available',
      ...(supported ? {version: RUNTIME_OBSERVATION_VERSION} : {})};
  }
  getRuntimeTree(input: RuntimeTreeInput, signal?: AbortSignal): Promise<ObservationResult<RuntimeTreeSnapshot>> {
    return this.observeRuntime('tree', input, signal);
  }
  inspectRuntimeNode(input: RuntimeNodeInput, signal?: AbortSignal): Promise<ObservationResult<RuntimeNodeSnapshot>> {
    return this.observeRuntime('node', input, signal);
  }
  private observeRuntime(kind: 'tree', input: RuntimeTreeInput, signal?: AbortSignal): Promise<ObservationResult<RuntimeTreeSnapshot>>;
  private observeRuntime(kind: 'node', input: RuntimeNodeInput, signal?: AbortSignal): Promise<ObservationResult<RuntimeNodeSnapshot>>;
  private observeRuntime(kind: RuntimeObservationQuery['kind'], input: RuntimeTreeInput | RuntimeNodeInput, signal?: AbortSignal):
    Promise<ObservationResult<ObservationSnapshot>> {
    const prepared = prepareRuntimeObservation(kind, input, signal);
    if (!prepared.ok) return Promise.resolve(prepared);
    const {runId, query, timeoutMs} = prepared.result;
    const support = this.observationSupport(runId);
    if (support !== 'available') return Promise.resolve(observationError(support));
    const session = this.active!;
    if (session.observation) return Promise.resolve(observationError('busy'));
    const id = crypto.randomUUID(), deadline = interactionNow() + timeoutMs;
    const envelope = {...session.identity, protocolVersion: WORKER_PROTOCOL, requestId: id};
    return new Promise(resolve => {
      const finish = (result: ObservationResult<ObservationSnapshot>): boolean => {
        if (session.observation?.id !== id) return false;
        session.observation = undefined;
        clearTimeout(timer);
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort);
        resolve(result);
        return true;
      };
      const onAbort = () => {
        if (!finish(observationError('cancelled'))) return;
        try { session.port.postMessage({...envelope, type: 'runtime-observation-cancel'}); }
        catch { /* Host and Worker still retire the expired request independently. */ }
      };
      const timer = setTimeout(() => finish(observationError('timeout')), timeoutMs);
      session.observation = {id, deadline, query, finish};
      if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, {once: true});
      try { session.port.postMessage({...envelope, type: 'runtime-observation-request', query, deadline}); }
      catch { finish(observationError('observation_failed')); }
    });
  }
  screenshot(input: ScreenshotInput, signal?: AbortSignal): Promise<InteractionResult<GameScreenshot>> {
    const {runId, timeoutMs = 5000} = input ?? {};
    if (!validInteractionId(runId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS)
      return Promise.resolve(interactionError('invalid_input'));
    try { if (signal !== undefined && readAborted.call(signal)) return Promise.resolve(interactionError('cancelled')); }
    catch { return Promise.resolve(interactionError('invalid_input')); }
    const support = this.interactionSupport(runId);
    if (support !== 'available') return Promise.resolve(interactionError(support));
    const s = this.active!;
    if (s.capture) return Promise.resolve(interactionError('busy'));
    const id = crypto.randomUUID(), deadline = interactionNow() + timeoutMs;
    return new Promise(resolve => {
      const onAbort = () => {
        finish(interactionError('cancelled'));
        if (s.capture?.id !== id) return;
        try { s.port.postMessage({...s.identity, protocolVersion: WORKER_PROTOCOL, type: 'capture-cancel', requestId: id}); }
        catch { /* The capture deadline bounds work after a lost cancellation. */ }
      };
      const timer = setTimeout(() => finish(interactionError('timeout')), timeoutMs);
      let settled = false;
      const finish = (result: InteractionResult<GameScreenshot>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort);
        resolve(result);
      };
      s.capture = {id, deadline, finish};
      if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, {once: true});
      try { s.port.postMessage({...s.identity, protocolVersion: WORKER_PROTOCOL, type: 'capture-request', requestId: id, deadline}); }
      catch { s.capture = undefined; finish(interactionError('capture_failed')); }
    });
  }
  gameInput(input: GameInput): InteractionResult<{operationId: string}> {
    const gesture = readGesture(input?.gesture);
    if (!gesture || !validInteractionId(input?.runId)) return interactionError('invalid_input');
    const support = this.interactionSupport(input.runId);
    if (support !== 'available') return interactionError(support);
    const s = this.active!;
    if (s.input) return interactionError('busy');
    const operationId = crypto.randomUUID(), started = interactionNow();
    const receipt: InputReceipt = {operationId, run: {...s.identity}, status: 'pending',
      down: 'unconfirmed', up: 'unconfirmed', nativeConsumption: 'unconfirmed'};
    const record: InputRecord = {receipt, deadline: started + INPUT_RECEIPT_MS, waiters: new Set(),
      timer: setTimeout(() => this.expireInput(record), INPUT_RECEIPT_MS)};
    s.input = record;
    this.inputRecords.set(operationId, record);
    try {
      s.port.postMessage({...s.identity, protocolVersion: WORKER_PROTOCOL, type: 'input-request',
        operationId, sequence: ++s.inputSequence, gesture, deadline: started + INPUT_START_MS});
    } catch {
      s.input = undefined;
      this.settleInput(record, undispatched('transport'));
    }
    return interactionOk({operationId});
  }
  waitForInput(input: WaitForInput, signal?: AbortSignal): Promise<InteractionResult<{outcome: 'settled' | 'pending' | 'timeout'; operation: InputReceipt}>> {
    const {runId, operationId, timeoutMs = 5000} = input ?? {};
    if (!validInteractionId(runId) || !validInteractionId(operationId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS)
      return Promise.resolve(interactionError('invalid_input'));
    try { if (signal !== undefined && readAborted.call(signal)) return Promise.resolve(interactionError('cancelled')); }
    catch { return Promise.resolve(interactionError('invalid_input')); }
    const record = this.inputRecords.get(operationId);
    if (!record || record.receipt.run.runId !== runId) return Promise.resolve(interactionError('not_found'));
    this.expireInput(record);
    const status = () => ({outcome: record.receipt.status === 'pending' ? 'pending' as const : 'settled' as const,
      operation: {...record.receipt, run: {...record.receipt.run}}});
    if (timeoutMs === 0 || record.receipt.status !== 'pending') return Promise.resolve(interactionOk(status()));
    if (this.inputWaiters >= MAX_INPUT_WAITERS) return Promise.resolve(interactionError('busy'));
    return new Promise(resolve => {
      const finish = (result: Awaited<ReturnType<WorkerPreviewRunner['waitForInput']>>) => {
        if (!record.waiters.delete(onSettlement)) return;
        this.inputWaiters--;
        clearTimeout(timer);
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort);
        resolve(result);
      };
      const onSettlement = () => finish(interactionOk(status()));
      const onAbort = () => finish(interactionError('cancelled'));
      const timer = setTimeout(() => {
        this.expireInput(record);
        const snapshot = status();
        finish(interactionOk({...snapshot, outcome: snapshot.outcome === 'pending' ? 'timeout' : 'settled'}));
      }, timeoutMs);
      this.inputWaiters++;
      record.waiters.add(onSettlement);
      if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, {once: true});
    });
  }
  private expireInput(record: InputRecord) {
    if (interactionNow() >= record.deadline)
      this.settleInput(record, {down: 'unconfirmed', up: 'unconfirmed'});
  }
  private settleInput(record: InputRecord, evidence: InputEvidence) {
    if (record.receipt.status !== 'pending') return;
    clearTimeout(record.timer);
    record.receipt = {...record.receipt, ...evidence, status: inputStatus(evidence)};
    for (const notify of record.waiters) notify();
    while (this.inputRecords.size > MAX_RECEIPTS) {
      const oldest = this.inputRecords.keys().next().value;
      if (oldest === undefined) break;
      this.inputRecords.delete(oldest);
    }
  }
  command(data: Record<string, unknown>): boolean {
    const s = this.active; if (!s || !this.live(s) || s.state !== 'running' || !isProjectData(data)) return false;
    let snapshot:Record<string,unknown>,bytes:number;
    try{snapshot=structuredClone(data);bytes=workerProjectCommandBytes(snapshot);}catch{return false;}
    const commandSequence=s.commandSequence+1;if(!s.commands.reserve(commandSequence,bytes))return false;
    s.commandSequence=commandSequence;
    try{s.port.postMessage({...s.identity,protocolVersion:WORKER_PROTOCOL,type:'project-command',commandSequence,data:snapshot});return true;}
    catch{s.commands.release(commandSequence);return false;}
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); this.listeners.clear(); }
}
