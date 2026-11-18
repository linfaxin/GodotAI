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
const now = () => performance.now();

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
  async run(artifact: BrowserArtifact): Promise<WorkerRunResult> {
    if (this.disposed) throw Error('E_RUNNER_DISPOSED');
    if (!artifact.artifactSet&&(!(artifact.pack instanceof Uint8Array) || !artifact.pack.byteLength || artifact.pack.byteLength > 64 * 1024 * 1024)) throw Error('E_ARTIFACT_PACK');
    if (!isIdentity({ runId: 'validate', ...artifact }) || !artifact.manifest || typeof artifact.manifest !== 'object' || (artifact.manifest as { generation?: unknown }).generation !== artifact.generation) throw Error('E_ARTIFACT_GENERATION');
    const manifest = artifact.manifest as { engineReleaseId?: unknown; engineProfile?: unknown };
    if (manifest.engineReleaseId !== undefined && manifest.engineReleaseId !== this.release.releaseId) throw Error('E_ARTIFACT_ENGINE_RELEASE');
    if (manifest.engineProfile !== undefined && manifest.engineProfile !== this.release.profile) throw Error('E_ARTIFACT_ENGINE_PROFILE');
    const sequence = ++this.sequence;
    const snapshot = await captureBrowserArtifact(artifact,this.release,this.release.artifactReceiptVersion!==2);
    const frozen = await prepareWorkerRunConfiguration(this.options.configuration ?? {});
    // A slower, superseded hash must never stop the newer active session.
    if (sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
    await this.stopActive();
    if (sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
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
      commands:new WorkerProjectCommandCredits(frozen.configuration.budgets.maxProjectEvents!,frozen.configuration.budgets.maxProjectBytes!),commandSequence:0,resolveRun, rejectRun, exit, resolveExit };
    this.active = s;
    s.onVisibility=()=>{if(this.live(s)&&this.options.container.ownerDocument.visibilityState!=='hidden')s.lastWorkerBeat=now();};
    this.options.container.ownerDocument.addEventListener?.('visibilitychange',s.onVisibility);
    s.port.onmessage = event => {
      if (!this.live(s) || !isWorkerEnvelope(event.data) || !sameWorkerRun(event.data, identity)) return;
      const m: any = event.data;
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
    if (!this.transition(s, 'stopping')) return;
    if (before === 'loading-frame' || before === 'handshaking') { this.finishLocal(s, 'forced-frame-disposal', 'Cancelled before host connection'); return; }
    try { s.port.postMessage({ ...s.identity, protocolVersion: WORKER_PROTOCOL, type: 'stop', cause, detail }); }
    catch { this.finishLocal(s, 'forced-frame-disposal', 'Worker host stop channel unavailable'); }
  }
  private stopActive(): Promise<WorkerRunnerExit | undefined> { const s = this.active; if (!s) return Promise.resolve(undefined); this.beginStop(s); return s.exit; }
  async stop(): Promise<WorkerRunnerExit | undefined> { ++this.sequence; return this.stopActive(); }
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
