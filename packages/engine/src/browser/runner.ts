import { DEFAULT_DEADLINES, PREVIEW_PROTOCOL, RUN_PHASES, isPreviewEnvelope, isProjectData, normalizedOrigin, sameRun, sessionCleanupComplete,
  type BrowserArtifact, type ExitReport, type PhaseDeadlines, type PreviewDiagnostic, type RunIdentity, type RunnerEvent, type RunnerState } from './protocol.js';
import { validateRelease, type VerifiedRelease } from './verified-loader.js';
import type {SessionCleanupReceipt} from './engine-session.js';
import {assertArtifactReceipt} from '../identities.js';
import {sessionExitReason,type SessionFacts} from '../session-facts.js';
import {captureBrowserArtifact,browserArtifactTransfers} from './artifact-input.js';

const MAX_PROJECT_EVENTS=64,MAX_PROJECT_BYTES=1048576;

export interface PreviewRunnerOptions {
  container: HTMLElement;
  previewUrl: string;
  release: VerifiedRelease;
  editorOrigin?: string;
  deadlines?: Partial<PhaseDeadlines>;
  allowLegacyArtifacts?:boolean;
}
export interface RunResult extends RunIdentity { state: 'running'; releaseId: string }
interface Session {
  identity: RunIdentity;
  frame: HTMLIFrameElement;
  port: MessagePort;
  peer?: MessagePort;
  state: RunnerState;
  transitionEpoch: number;
  lastHeartbeat: number;
  lastEngineProgress: number;
  progress: Map<number,number>;
  forced?: {reason:ExitReport['reason'];detail:string};
  phaseTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  runPromise: Promise<RunResult>;
  resolveRun: (result: RunResult) => void;
  rejectRun: (error: Error) => void;
  exitPromise: Promise<ExitReport>;
  resolveExit: (report: ExitReport) => void;
  settled: boolean;
  exitReport?: ExitReport;
  logCount: number;
  logBytes: number;
  projectQueue: Array<{data:Record<string,unknown>;bytes:number}>;
  projectBytes: number;
  projectDraining: boolean;
}

/** A fresh host context per run. Worker executions must provide engine progress
 * independently of their host heartbeat, and acknowledge whole-session cleanup. */
export class PreviewRunner {
  readonly editorOrigin: string;
  readonly previewOrigin: string;
  private readonly options: PreviewRunnerOptions;
  private readonly deadlines: PhaseDeadlines;
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private active?: Session;
  private sequence = 0;
  private disposed = false;
  private currentState: RunnerState = 'idle';

  constructor(options: PreviewRunnerOptions) {
    this.options = options;
    this.editorOrigin = normalizedOrigin(options.editorOrigin ?? options.container.ownerDocument.location.origin);
    this.previewOrigin = normalizedOrigin(options.previewUrl);
    if (this.editorOrigin === this.previewOrigin) throw new Error('E_PREVIEW_REQUIRES_SEPARATE_ORIGIN');
    validateRelease(options.release, options.previewUrl);
    if(options.release.execution?.requiresCrossOriginIsolation&&!(options.container.ownerDocument.defaultView?.crossOriginIsolated??globalThis.crossOriginIsolated))throw new Error('E_EDITOR_REQUIRES_ISOLATION');
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
    for (const [phase, value] of Object.entries(this.deadlines)) {
      if (!Number.isFinite(value) || value < 0 || (phase !== 'running' && value === 0)) throw new Error(`E_RUNNER_DEADLINE: ${phase}`);
    }
  }
  get state(): RunnerState { return this.currentState; }
  getHealth(): {hostLastSeen:number;engineLastSeen:number;engineWorkers:number}|undefined {const s=this.active;return s?{hostLastSeen:s.lastHeartbeat,engineLastSeen:s.lastEngineProgress,engineWorkers:s.progress.size}:undefined;}
  private get workerExecution():boolean {return !!this.options.release.execution&&this.options.release.execution.executionModel!=='window';}
  subscribe(listener: (event: RunnerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: RunnerEvent): void { for (const listener of [...this.listeners]) { try { listener(event); } catch { /* UI listeners cannot break disposal. */ } } }
  private clearProjectEvents(session:Session):void {session.projectQueue.length=0;session.projectBytes=0;}
  private drainProjectEvents(session:Session):void {
    if(session.projectDraining||session.forced||!this.current(session,'running'))return;
    const epoch=session.transitionEpoch;
    session.projectDraining=true;
    try{
      while(!session.forced&&this.current(session,'running',epoch)&&session.projectQueue.length){
        const item=session.projectQueue.shift()!;session.projectBytes-=item.bytes;
        this.emit({type:'project',...session.identity,data:item.data});
      }
    }finally{session.projectDraining=false;}
  }
  private current(session: Session, state = session.state, epoch = session.transitionEpoch): boolean {
    return this.active === session && !session.settled && session.state === state && session.transitionEpoch === epoch;
  }
  private transition(session: Session, state: RunnerState): boolean {
    if (!this.current(session)) return false;
    clearTimeout(session.phaseTimer);
    session.phaseTimer = undefined;
    const epoch = ++session.transitionEpoch;
    session.state = this.currentState = state;
    if (state === 'running') session.lastHeartbeat = session.lastEngineProgress = Date.now();
    this.emit({ type: 'state', state, ...session.identity });
    // State listeners may synchronously stop, replace, or dispose this run.
    if (!this.current(session, state, epoch)) return false;
    const timeout = state === 'idle' || state === 'exited' ? 0 : this.deadlines[state];
    if (timeout) session.phaseTimer = setTimeout(() => {
      if (!this.current(session, state, epoch)) return;
      if(this.workerExecution){this.forceStop(session,state==='stopping'?'forced-session-termination':'unresponsive',`Deadline exceeded during ${state}.`);return;}
      if (state === 'stopping') {
        const responsive = Date.now() - session.lastHeartbeat < this.deadlines.heartbeat;
        this.finish(session, responsive ? 'forced-frame-disposal' : 'unresponsive', undefined, 'Cooperative stop timed out; frame removed.');
      } else this.finish(session, 'unresponsive', undefined, `Deadline exceeded during ${state}; frame removed.`);
    }, timeout);
    return true;
  }
  private forceStop(session:Session,reason:ExitReport['reason'],detail:string):void {
    if(!this.current(session)||session.forced)return;
    this.clearProjectEvents(session);
    clearTimeout(session.phaseTimer);clearInterval(session.heartbeatTimer);
    session.forced={reason,detail};
    try{session.port.postMessage({protocolVersion:PREVIEW_PROTOCOL,type:'force-stop',...session.identity});}
    catch{this.finish(session,'unresponsive',undefined,detail+' Host channel unavailable; cleanup unconfirmed.');return;}
    session.phaseTimer=setTimeout(()=>{if(this.current(session))this.finish(session,'unresponsive',undefined,detail+' Whole-session cleanup was not acknowledged; host frame removed.');},Math.min(1000,this.deadlines.stopping));
  }
  private finish(session: Session, reason: ExitReport['reason'], code?: number, detail?: string, diagnostic?: PreviewDiagnostic,cleanup?:SessionCleanupReceipt,sessionFacts?:SessionFacts): ExitReport {
    if (session.exitReport) return session.exitReport;
    if(sessionFacts){reason=sessionExitReason(sessionFacts);code=code??sessionFacts.nativeExit?.code;if(!diagnostic&&sessionFacts.failure)diagnostic={source:'godotjs',...sessionFacts.failure};}
    const report: ExitReport = { ...session.identity, reason, ...(code === undefined ? {} : { code }), ...(detail ? { detail: detail.slice(0, 4096) } : {}), ...(diagnostic ? { diagnostic } : {}),...(cleanup?{cleanup}:{}),...(sessionFacts?{sessionFacts}:{}) };
    session.exitReport = report;
    session.settled = true;
    this.clearProjectEvents(session);
    ++session.transitionEpoch;
    clearTimeout(session.phaseTimer);
    clearInterval(session.heartbeatTimer);
    session.port.onmessage = null;
    session.port.close();
    session.peer?.close();
    session.peer = undefined;
    session.frame.onload = session.frame.onerror = null;
    session.frame.remove();
    if (this.active === session) { this.active = undefined; this.currentState = 'exited'; }
    session.rejectRun(new Error(`E_RUN_ENDED: ${reason}${detail ? `: ${detail}` : ''}`));
    session.resolveExit(report);
    this.emit({ type: 'state', state: 'exited', ...session.identity });
    this.emit({ type: 'exit', report });
    return report;
  }
  async run(artifact: BrowserArtifact): Promise<RunResult> {
    if (this.disposed) throw new Error('E_RUNNER_DISPOSED');
    if (!artifact.artifactSet&&(!(artifact.pack instanceof Uint8Array) || artifact.pack.byteLength === 0 || artifact.pack.byteLength > 64 * 1024 * 1024)) throw new Error('E_ARTIFACT_PACK');
    if (!artifact.manifest || typeof artifact.manifest !== 'object' || (artifact.manifest as { generation?: unknown }).generation !== artifact.generation) throw new Error('E_ARTIFACT_GENERATION');
    if(artifact.packSha256!==undefined&&!/^[a-f0-9]{64}$/i.test(artifact.packSha256))throw new Error('E_ARTIFACT_PACK_HASH');
    if((artifact.manifest as {buildKey?:unknown}).buildKey!==undefined&&(artifact.manifest as {buildKey?:unknown}).buildKey!==artifact.buildKey)throw new Error('E_ARTIFACT_BUILD_KEY');
    if(artifact.artifactId!==undefined&&(artifact.manifest as {artifactId?:unknown}).artifactId!==undefined&&(artifact.manifest as {artifactId?:unknown}).artifactId!==artifact.artifactId)throw new Error('E_ARTIFACT_IDENTITY');
    const manifest = artifact.manifest as { engineReleaseId?: unknown; engineProfile?: unknown };
    if (manifest.engineReleaseId !== undefined && manifest.engineReleaseId !== this.options.release.releaseId) throw new Error('E_ARTIFACT_ENGINE_RELEASE');
    if (manifest.engineProfile !== undefined && manifest.engineProfile !== this.options.release.profile) throw new Error('E_ARTIFACT_ENGINE_PROFILE');
    const sequence = ++this.sequence;
    const allowLegacy=this.options.allowLegacyArtifacts===true&&this.options.release.artifactReceiptVersion!==2;
    const capture=captureBrowserArtifact(artifact,this.options.release,allowLegacy);
    // Retire the prior run synchronously, before receipt hashing yields. State
    // listeners may request this replacement while an old phase is emitting;
    // letting that phase continue would falsely resolve the retired run.
    const stopping=this.stopActive();
    const snapshot=await capture;
    delete snapshot.compatibility;
    if(allowLegacy&&!snapshot.artifactId){delete snapshot.artifactId;snapshot.compatibility='legacy-artifact-v1';}
    if(sequence!==this.sequence||this.disposed)throw new DOMException('Superseded','AbortError');
    await stopping;
    if (sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
    const identity: RunIdentity = { runId: crypto.randomUUID(), revision: snapshot.revision, buildKey: snapshot.buildKey, generation: snapshot.generation };
    // Validate outgoing identities with the same schema used at the trust boundary.
    if (!isPreviewEnvelope({ protocolVersion: PREVIEW_PROTOCOL, type: 'connected', ...identity })) throw new Error('E_ARTIFACT_IDENTITY');
    const frame = this.options.container.ownerDocument.createElement('iframe');
    frame.title = 'Godot preview';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
    frame.setAttribute('allow', this.options.release.execution?.requiresCrossOriginIsolation?'autoplay; cross-origin-isolated; fullscreen; xr-spatial-tracking':'autoplay');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const url = new URL(this.options.previewUrl);
    url.searchParams.set('editorOrigin', this.editorOrigin);
    frame.src = url.href;
    const channel = new MessageChannel();
    let resolveRun!: Session['resolveRun'], rejectRun!: Session['rejectRun'], resolveExit!: Session['resolveExit'];
    const runPromise = new Promise<RunResult>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    // A cancellation during iframe loading must not create an unhandled rejection.
    void runPromise.catch(() => {});
    const exitPromise = new Promise<ExitReport>(resolve => { resolveExit = resolve; });
    const session: Session = { identity, frame, port: channel.port1, peer: channel.port2, state: 'loading-frame', transitionEpoch: 0, lastHeartbeat: Date.now(),lastEngineProgress:0,progress:new Map(),
      runPromise, resolveRun, rejectRun, exitPromise, resolveExit, settled: false, logCount: 0, logBytes: 0,projectQueue:[],projectBytes:0,projectDraining:false };
    this.active = session;
    channel.port1.onmessage = event => {
      if (this.active !== session || session.settled || !isPreviewEnvelope(event.data) || !sameRun(event.data, identity)) return;
      const message = event.data;
      if (message.type === 'heartbeat') { session.lastHeartbeat = Date.now(); return; }
      if(message.type==='engine-progress'){
        const previous=session.progress.get(message.workerId!)??0;
        if(message.sequence!>previous){session.progress.set(message.workerId!,message.sequence!);session.lastEngineProgress=Date.now();}
        return;
      }
      if(message.type==='terminated'){
        const intent=session.forced;
        const complete=sessionCleanupComplete(message.cleanup!);
        this.finish(session,complete?(intent?.reason??'forced-session-termination'):'unresponsive',undefined,complete?(intent?.detail??'Host terminated the engine session.'):'Whole-session cleanup reported incomplete resources.',undefined,message.cleanup,message.sessionFacts);return;
      }
      if (message.type === 'connected' && session.state === 'handshaking') {
        session.lastHeartbeat = Date.now();
        if (!this.transition(session, 'downloading')) return;
        // Transfer a private snapshot so compiling/saving cannot mutate an active pack.
        try { channel.port1.postMessage({ protocolVersion: PREVIEW_PROTOCOL, type: 'run', ...identity, release: this.options.release,
          artifact: snapshot }, browserArtifactTransfers(snapshot)); }
        catch { this.finish(session, 'crashed', undefined, 'Could not send the project to the preview.'); }
      } else if (message.type === 'closing') {
        void this.stopActive();
      } else if (message.type === 'phase' && session.state !== 'stopping'&&!session.forced) {
        const current = RUN_PHASES.indexOf(session.state as typeof RUN_PHASES[number]);
        const next = RUN_PHASES.indexOf(message.phase!);
        if (next !== current + 1) return;
        if (!this.transition(session, message.phase!)) return;
        if (message.phase === 'running') {
          const epoch = session.transitionEpoch;
          session.heartbeatTimer = setInterval(() => {
            if(!this.current(session,'running',epoch))return;
            const time=Date.now();
            const hostStalled=time-session.lastHeartbeat>this.deadlines.heartbeat;
            const engineStalled=this.workerExecution&&time-session.lastEngineProgress>this.deadlines.heartbeat;
            if(hostStalled||engineStalled){
              if(this.workerExecution)this.forceStop(session,'unresponsive',engineStalled?'Engine progress stopped while the host was running.':'Preview host heartbeat stopped.');
              else this.finish(session,'unresponsive',undefined,'Preview heartbeat stopped; frame removed.');
            }
          }, Math.max(10, Math.min(500, this.deadlines.heartbeat / 2)));
          session.resolveRun({ ...identity, state: 'running', releaseId: this.options.release.releaseId });
          this.drainProjectEvents(session);
        }
      } else if (message.type === 'log') {
        if (++session.logCount > 1000 || (session.logBytes += message.text!.length) > 256_000) return;
        this.emit({ type: 'log', ...identity, level: message.level!, text: message.text!, untrusted: true });
      } else if(message.type==='project'&&!session.forced&&RUN_PHASES.includes(session.state as typeof RUN_PHASES[number])){
        const data=message.data!;
        let bytes:number;
        try{bytes=new TextEncoder().encode(JSON.stringify(data)).byteLength;}
        catch{this.forceStop(session,'crashed','Project event could not be queued.');return;}
        if(session.projectQueue.length>=MAX_PROJECT_EVENTS||session.projectBytes+bytes>MAX_PROJECT_BYTES){
          this.forceStop(session,'crashed','Startup project event budget exceeded.');return;
        }
        session.projectQueue.push({data,bytes});session.projectBytes+=bytes;
        this.drainProjectEvents(session);
      } else if (message.type === 'fatal') this.finish(session, 'crashed', undefined, message.text, message.diagnostic,message.cleanup,message.sessionFacts);
      else if (message.type === 'exited') {
        const cleanup=message.cleanup;
        const complete=!cleanup||sessionCleanupComplete(cleanup);
        this.finish(session,message.code===0&&complete?'clean-exit':'crashed',message.code,complete?undefined:'Engine exited but host cleanup was incomplete.',undefined,cleanup,message.sessionFacts);
      }
    };
    channel.port1.start();
    frame.onload = () => {
      if (this.active !== session || session.settled || session.state !== 'loading-frame') return;
      if (!this.transition(session, 'handshaking')) return;
      try {
        if (!frame.contentWindow || !session.peer) throw new Error('Missing preview window');
        frame.contentWindow.postMessage({ protocolVersion: PREVIEW_PROTOCOL, type: 'connect', ...identity, editorOrigin: this.editorOrigin }, this.previewOrigin, [session.peer]);
        session.peer = undefined; // Transferred to the preview; no longer ours.
      } catch { this.finish(session, 'crashed', undefined, 'Could not connect to the preview.'); }
    };
    frame.onerror = () => this.finish(session, 'crashed', undefined, 'Preview document failed to load.');
    if (this.transition(session, 'loading-frame')) {
      try { this.options.container.append(frame); }
      catch { this.finish(session, 'crashed', undefined, 'Could not attach the preview.'); }
    }
    return runPromise;
  }
  private stopActive(): Promise<ExitReport | undefined> {
    const session = this.active;
    if (!session) return Promise.resolve(undefined);
    if (session.state !== 'stopping'&&!session.forced) {
      const priorState = session.state;
      this.clearProjectEvents(session);
      if (!this.transition(session, 'stopping')) return session.exitPromise;
      if (priorState === 'loading-frame' || priorState === 'handshaking') {
        this.finish(session, 'forced-frame-disposal', undefined, 'Cancelled before engine startup.');
      } else {
        try { session.port.postMessage({ protocolVersion: PREVIEW_PROTOCOL, type: 'stop', ...session.identity }); }
        catch { this.finish(session, 'forced-frame-disposal', undefined, 'Preview stop channel was unavailable.'); }
      }
    }
    return session.exitPromise;
  }
  async stop(): Promise<ExitReport | undefined> { ++this.sequence; return this.stopActive(); }
  command(data:Record<string,unknown>):boolean {
    const session=this.active;if(!session||session.settled||session.forced||session.state!=='running'||!isProjectData(data))return false;
    session.port.postMessage({protocolVersion:PREVIEW_PROTOCOL,type:'project-command',...session.identity,data});return true;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); this.listeners.clear(); }
}
