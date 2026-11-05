import { loadVerifiedEngine, type GodotInstance } from '../../jsb.react-browser/src/verified-loader.js';

// A test-only audio profile. The production preview continues to use Dummy.
const stats = { ready: false, contextsCreated: 0, closeCalls: 0, resumeCalls: 0,
  nodeAttempts: 0, nodesCreated: 0, nodesDisconnected: 0, portsClosed: 0, invalidContextAttempts: 0,
  userActivationAtClick: false, startReturned: false, errors: [] as string[], logs: [] as string[], exits: [] as number[] };
const contexts: AudioContext[] = [];
const scope = window as unknown as { AudioContext: typeof AudioContext; AudioWorkletNode: typeof AudioWorkletNode; audioProbe: unknown };
const NativeContext = scope.AudioContext;
scope.AudioContext = new Proxy(NativeContext, { construct(target, args) {
  const context = Reflect.construct(target, args) as AudioContext;
  contexts.push(context); stats.contextsCreated++;
  const close = context.close.bind(context), resume = context.resume.bind(context);
  context.close = () => { stats.closeCalls++; return close(); };
  context.resume = () => { stats.resumeCalls++; return resume(); };
  return context;
} });
const NativeWorklet = scope.AudioWorkletNode;
scope.AudioWorkletNode = new Proxy(NativeWorklet, { construct(target, args) {
  stats.nodeAttempts++;
  if (!args[0] || args[0].state === 'closed') stats.invalidContextAttempts++;
  const node = Reflect.construct(target, args) as AudioWorkletNode;
  stats.nodesCreated++;
  const disconnect = node.disconnect.bind(node);
  const closePort = node.port.close.bind(node.port);
  node.disconnect = (() => { stats.nodesDisconnected++; disconnect(); }) as typeof node.disconnect;
  node.port.close = () => { stats.portsClosed++; closePort(); };
  return node;
} });
scope.audioProbe = { snapshot: () => ({ ...stats, contextStates: contexts.map(context => context.state) }) };
addEventListener('error', event => stats.errors.push(event.message));
addEventListener('unhandledrejection', event => stats.errors.push(String(event.reason)));
let engine: GodotInstance | undefined;
const start = document.getElementById('start') as HTMLButtonElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
const origin = new URL(location.href).searchParams.get('editorOrigin');
let configured = false;
addEventListener('message', event => {
  if (configured || event.source !== parent || event.origin !== origin || event.data?.type !== 'prepare-audio-probe') return;
  configured = true;
  void prepare(event.data).catch(error => stats.errors.push(String(error)));
});
async function prepare(data: { release: Parameters<typeof loadVerifiedEngine>[0]; pack: Uint8Array; mode: string }): Promise<void> {
  const loaded = await loadVerifiedEngine(data.release);
  engine = new loaded.Engine({ canvas: document.getElementById('canvas'), executable: loaded.basePath, persistentPaths: [], serviceWorker: '',
    onPrint: (...args: unknown[]) => stats.logs.push(args.map(String).join(' ')),
    onPrintError: (...args: unknown[]) => stats.logs.push(args.map(String).join(' ')),
    onExit: (code: number) => stats.exits.push(code),
  });
  await engine.preloadFile(data.pack, '/application.pck');
  await engine.init();
  stats.ready = true; start.disabled = false;
  start.onclick = () => {
    start.disabled = true;
    stats.userActivationAtClick = navigator.userActivation.isActive;
    void engine!.start({ args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility', '--audio-driver', 'AudioWorklet'] }).then(() => {
      stats.startReturned = true;
      if (data.mode === 'immediate-stop') engine!.requestQuit();
    }).catch(error => stats.errors.push(String(error)));
  };
  stop.onclick = () => engine!.requestQuit();
}
