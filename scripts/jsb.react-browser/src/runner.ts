import { DEFAULT_DEADLINES, PREVIEW_PROTOCOL, RUN_PHASES, isPreviewEnvelope, isProjectData, normalizedOrigin, sameRun,
  type BrowserArtifact, type ExitReport, type PhaseDeadlines, type PreviewDiagnostic, type RunIdentity, type RunnerEvent, type RunnerState } from './protocol.js';
import { validateRelease, type VerifiedRelease } from './verified-loader.js';

export interface PreviewRunnerOptions {
  container: HTMLElement;
  previewUrl: string;
  release: VerifiedRelease;
  editorOrigin?: string;
  deadlines?: Partial<PhaseDeadlines>;
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
}

/** A fresh browsing context per run. Timeout disposal is best effort: browsers
 * do not guarantee that an iframe's synchronous loop leaves the parent runnable. */
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
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
    for (const [phase, value] of Object.entries(this.deadlines)) {
      if (!Number.isFinite(value) || value < 0 || (phase !== 'running' && value === 0)) throw new Error(`E_RUNNER_DEADLINE: ${phase}`);
    }
  }
  get state(): RunnerState { return this.currentState; }
  subscribe(listener: (event: RunnerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: RunnerEvent): void { for (const listener of [...this.listeners]) { try { listener(event); } catch { /* UI listeners cannot break disposal. */ } } }
  private current(session: Session, state = session.state, epoch = session.transitionEpoch): boolean {
    return this.active === session && !session.settled && session.state === state && session.transitionEpoch === epoch;
  }
  private transition(session: Session, state: RunnerState): boolean {
    if (!this.current(session)) return false;
    clearTimeout(session.phaseTimer);
    session.phaseTimer = undefined;
    const epoch = ++session.transitionEpoch;
    session.state = this.currentState = state;
    if (state === 'running') session.lastHeartbeat = Date.now();
    this.emit({ type: 'state', state, ...session.identity });
    // State listeners may synchronously stop, replace, or dispose this run.
    if (!this.current(session, state, epoch)) return false;
    const timeout = state === 'idle' || state === 'exited' ? 0 : this.deadlines[state];
    if (timeout) session.phaseTimer = setTimeout(() => {
      if (!this.current(session, state, epoch)) return;
      if (state === 'stopping') {
        const responsive = Date.now() - session.lastHeartbeat < this.deadlines.heartbeat;
        this.finish(session, responsive ? 'forced-frame-disposal' : 'unresponsive', undefined, 'Cooperative stop timed out; frame removed.');
      } else this.finish(session, 'unresponsive', undefined, `Deadline exceeded during ${state}; frame removed.`);
    }, timeout);
    return true;
  }
  private finish(session: Session, reason: ExitReport['reason'], code?: number, detail?: string, diagnostic?: PreviewDiagnostic): ExitReport {
    if (session.exitReport) return session.exitReport;
    const report: ExitReport = { ...session.identity, reason, ...(code === undefined ? {} : { code }), ...(detail ? { detail: detail.slice(0, 4096) } : {}), ...(diagnostic ? { diagnostic } : {}) };
    session.exitReport = report;
    session.settled = true;
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
    if (!(artifact.pack instanceof Uint8Array) || artifact.pack.byteLength === 0 || artifact.pack.byteLength > 64 * 1024 * 1024) throw new Error('E_ARTIFACT_PACK');
    if (!artifact.manifest || typeof artifact.manifest !== 'object' || (artifact.manifest as { generation?: unknown }).generation !== artifact.generation) throw new Error('E_ARTIFACT_GENERATION');
    const manifest = artifact.manifest as { engineReleaseId?: unknown; engineProfile?: unknown };
    if (manifest.engineReleaseId !== undefined && manifest.engineReleaseId !== this.options.release.releaseId) throw new Error('E_ARTIFACT_ENGINE_RELEASE');
    if (manifest.engineProfile !== undefined && manifest.engineProfile !== this.options.release.profile) throw new Error('E_ARTIFACT_ENGINE_PROFILE');
    const sequence = ++this.sequence;
    const snapshot = { ...artifact, manifest: structuredClone(artifact.manifest), pack: artifact.pack.slice() };
    await this.stopActive();
    if (sequence !== this.sequence || this.disposed) throw new DOMException('Superseded', 'AbortError');
    const identity: RunIdentity = { runId: crypto.randomUUID(), revision: snapshot.revision, buildKey: snapshot.buildKey, generation: snapshot.generation };
    // Validate outgoing identities with the same schema used at the trust boundary.
    if (!isPreviewEnvelope({ protocolVersion: PREVIEW_PROTOCOL, type: 'connected', ...identity })) throw new Error('E_ARTIFACT_IDENTITY');
    const frame = this.options.container.ownerDocument.createElement('iframe');
    frame.title = 'Godot preview';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
    frame.setAttribute('allow', 'autoplay');
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
    const session: Session = { identity, frame, port: channel.port1, peer: channel.port2, state: 'loading-frame', transitionEpoch: 0, lastHeartbeat: Date.now(),
      runPromise, resolveRun, rejectRun, exitPromise, resolveExit, settled: false, logCount: 0, logBytes: 0 };
    this.active = session;
    channel.port1.onmessage = event => {
      if (this.active !== session || session.settled || !isPreviewEnvelope(event.data) || !sameRun(event.data, identity)) return;
      const message = event.data;
      if (message.type === 'heartbeat') { session.lastHeartbeat = Date.now(); return; }
      if (message.type === 'connected' && session.state === 'handshaking') {
        session.lastHeartbeat = Date.now();
        if (!this.transition(session, 'downloading')) return;
        // Transfer a private snapshot so compiling/saving cannot mutate an active pack.
        try { channel.port1.postMessage({ protocolVersion: PREVIEW_PROTOCOL, type: 'run', ...identity, release: this.options.release,
          artifact: snapshot }, [snapshot.pack.buffer]); }
        catch { this.finish(session, 'crashed', undefined, 'Could not send the project to the preview.'); }
      } else if (message.type === 'phase' && session.state !== 'stopping') {
        const current = RUN_PHASES.indexOf(session.state as typeof RUN_PHASES[number]);
        const next = RUN_PHASES.indexOf(message.phase!);
        if (next !== current + 1) return;
        if (!this.transition(session, message.phase!)) return;
        if (message.phase === 'running') {
          const epoch = session.transitionEpoch;
          session.heartbeatTimer = setInterval(() => {
            if (this.current(session, 'running', epoch) && Date.now() - session.lastHeartbeat > this.deadlines.heartbeat) this.finish(session, 'unresponsive', undefined, 'Preview heartbeat stopped; frame removed.');
          }, Math.max(10, Math.min(500, this.deadlines.heartbeat / 2)));
          session.resolveRun({ ...identity, state: 'running', releaseId: this.options.release.releaseId });
        }
      } else if (message.type === 'log') {
        if (++session.logCount > 1000 || (session.logBytes += message.text!.length) > 256_000) return;
        this.emit({ type: 'log', ...identity, level: message.level!, text: message.text!, untrusted: true });
      } else if(message.type==='project'&&session.state==='running'){
        this.emit({type:'project',...identity,data:message.data!});
      } else if (message.type === 'fatal') this.finish(session, 'crashed', undefined, message.text, message.diagnostic);
      else if (message.type === 'exited') this.finish(session, message.code === 0 ? 'clean-exit' : 'crashed', message.code);
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
    if (session.state !== 'stopping') {
      const priorState = session.state;
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
    const session=this.active;if(!session||session.settled||session.state!=='running'||!isProjectData(data))return false;
    session.port.postMessage({protocolVersion:PREVIEW_PROTOCOL,type:'project-command',...session.identity,data});return true;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); this.listeners.clear(); }
}
