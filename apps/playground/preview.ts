import { PREVIEW_PROTOCOL, RUN_PHASES, isIdentity, normalizedOrigin, previewDiagnostic, sameRun, type RunIdentity, type RunPhase } from '../../scripts/jsb.react-browser/src/protocol.js';
import { loadVerifiedEngine, type GodotInstance, type LoadedEngine, type VerifiedRelease } from '../../scripts/jsb.react-browser/src/verified-loader.js';

// The parent is on a different origin. Its origin is configured in this fixed
// preview document URL and verified against both event.origin and event.source.
const configuredOrigin = new URL(location.href).searchParams.get('editorOrigin');
const editorOrigin = configuredOrigin ? normalizedOrigin(configuredOrigin) : undefined;
let connected = false;
addEventListener('keydown', event => {
  if (event.key === 'Escape' && event.isTrusted && editorOrigin && parent !== window)
    parent.postMessage({ type: 'godotjs-preview-escape', protocolVersion: PREVIEW_PROTOCOL }, editorOrigin);
});
addEventListener('message', event => {
  const data = event.data;
  if (!editorOrigin || connected || event.origin !== editorOrigin || event.source !== parent || !data || data.type !== 'connect' ||
      data.protocolVersion !== PREVIEW_PROTOCOL || data.editorOrigin !== editorOrigin || !isIdentity(data) || event.ports.length !== 1) return;
  connected = true;
  document.getElementById('connection-status')!.hidden = true;
  startSession(data, event.ports[0]);
});

function startSession(identity: RunIdentity, port: MessagePort): void {
  let engine: GodotInstance | undefined, loaded: LoadedEngine | undefined;
  let started = false, exited = false, cleaned = false, quitRequested = false;
  const aborter = new AbortController();
  const post = port.postMessage.bind(port);
  const send = (data: object) => { if (!exited) post({ ...identity, protocolVersion: PREVIEW_PROTOCOL, ...data }); };
  const phase = (value: RunPhase) => { if (!aborter.signal.aborted) send({ type: 'phase', phase: value }); };
  const check = () => { if (aborter.signal.aborted) throw aborter.signal.reason; };
  let logs = 0, logBytes = 0;
  // Never stringify arbitrary user objects: getters/toJSON may throw or loop.
  const text = (args: unknown[]) => args.slice(0, 20).map(value => {
    if (typeof value === 'string') return value.slice(0, 4096);
    if (value === null || ['undefined', 'number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
    return '[object]';
  }).join(' ').slice(0, 4096);
  const log = (level: 'log' | 'warn' | 'error', args: unknown[]) => {
    const message = text(args);
    if (++logs <= 1000 && (logBytes += message.length) <= 256_000) send({ type: 'log', level, text: message });
  };
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => { originalConsole[level](...args); log(level, args); };
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 250);
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    clearInterval(heartbeat); loaded?.dispose(); loaded = undefined;
    port.onmessage = null;
    removeEventListener('error', onBrowserError); removeEventListener('unhandledrejection', onRejectedPromise);
    for (const level of ['log', 'warn', 'error'] as const) console[level] = originalConsole[level];
    if ((globalThis as any).__godotjsReportReactError === onReactError) delete (globalThis as any).__godotjsReportReactError;
  };
  const requestQuit = () => { if (engine && !quitRequested) { quitRequested = true; engine.requestQuit(); } };
  const fatal = (error: unknown, location?: { message?: string; filename?: string; line?: number; column?: number }, source:'browser'|'godotjs'='browser') => {
    if (exited) return;
    const diagnostic = previewDiagnostic(error, location);
    diagnostic.source=source;
    send({ type: 'fatal', text: diagnostic.message, diagnostic });
    exited = true;
    aborter.abort(new DOMException('Preview failed', 'AbortError'));
    try { requestQuit(); } catch { /* Parent always disposes the frame. */ }
    cleanup();
  };
  const onBrowserError = (event: ErrorEvent) => {
    if (exited) return;
    fatal(event.error, { message: event.message, filename: event.filename, line: event.lineno, column: event.colno });
    // The parent now owns this failure and its original stack. Consume the
    // browser default report, rather than emitting a second unhandled error.
    event.preventDefault();
  };
  const onRejectedPromise = (event: PromiseRejectionEvent) => {
    if (aborter.signal.aborted) return;
    fatal(event.reason);
    event.preventDefault();
  };
  const onReactError = (raw: unknown): boolean => {
    if (exited || cleaned || typeof raw !== 'string' || raw.length > 65536) return false;
    let value: {kind?:string;message?:string;stack?:string;componentStack?:string};
    try { value=JSON.parse(raw); } catch { return false; }
    if (!value || typeof value.message !== 'string') return false;
    const error={message:value.message,stack:typeof value.stack==='string'&&value.stack?value.stack:typeof value.componentStack==='string'?value.componentStack:''};
    if(value.kind==='caught'||value.kind==='recoverable')log('warn',[error.message,error.stack]);
    else queueMicrotask(()=>{if(!exited&&!cleaned)fatal(error,undefined,'godotjs');});
    return true;
  };
  (globalThis as any).__godotjsReportReactError=onReactError;
  addEventListener('error', onBrowserError);
  addEventListener('unhandledrejection', onRejectedPromise);
  port.onmessage = event => {
    const data = event.data;
    if (!isIdentity(data) || !sameRun(data, identity) || data.protocolVersion !== PREVIEW_PROTOCOL) return;
    if (data.type === 'stop') {
      aborter.abort(new DOMException('Stopped', 'AbortError'));
      try { requestQuit(); } catch (error) { fatal(error); }
      if (!engine) cleanup();
      // No synthetic exited=0: only Engine.onExit proves a cooperative exit.
      return;
    }
    if (data.type !== 'run' || started) return;
    started = true;
    void boot(data.release, data.artifact?.pack);
  };
  port.start();
  send({ type: 'connected' });
  async function boot(release: VerifiedRelease, pack: unknown): Promise<void> {
    try {
      if (!(pack instanceof Uint8Array) || !pack.byteLength || pack.byteLength > 64 * 1024 * 1024) throw new Error('E_ARTIFACT_PACK');
      phase(RUN_PHASES[0]); check();
      const result = await loadVerifiedEngine(release, { signal: aborter.signal });
      // A cooperative stop may precede the loader resolving; release late assets.
      if (aborter.signal.aborted || exited) { result.dispose(); return; }
      loaded = result; check();
      engine = new loaded.Engine({ canvas: document.getElementById('canvas'), executable: loaded.basePath,
        persistentPaths: [], persistentDrops: false, serviceWorker: '', focusCanvas: false,
        onPrint: (...args: unknown[]) => log('log', args), onPrintError: (...args: unknown[]) => log('error', args),
        onExit: (code: number) => {
          if (exited) return;
          send({ type: 'exited', code }); exited = true; cleanup();
        },
      });
      loaded.installWorklets(engine);
      phase('preloading'); await engine.preloadFile(pack, '/application.pck'); check();
      phase('initializing'); await engine.init(); check();
      phase('starting'); await engine.start({ args: release.profile==='full-engine-v1'
        ? ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility']
        : ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility', '--audio-driver', 'Dummy'] }); check();
      if (exited) return;
      phase('waiting-ready');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); check();
      if (exited) return;
      // This is an engine-start observation, never a certification of user code.
      phase('running');
    } catch (error) { if (!aborter.signal.aborted) fatal(error); }
  }
}
