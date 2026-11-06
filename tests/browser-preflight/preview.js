const send = data => parent.postMessage(data, location.origin);
let engine;
const text = args => args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
// Browser-backend user console calls may bypass Engine.onPrint.
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { original(...args); send({ type: level === 'error' ? 'error' : 'log', text: text(args) }); };
}
window.addEventListener('error', event => send({ type: 'error', text: event.message }));
window.addEventListener('unhandledrejection', event => send({ type: 'error', text: String(event.reason) }));
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data.type === 'stop') { engine?.requestQuit(); return; }
  if (event.data.type !== 'run' || engine) return;
  try {
    engine = new Engine({ canvas: document.getElementById('canvas'), executable: './assets/godot', persistentPaths: [],
      onPrint: (...args) => send({ type: 'log', text: text(args) }),
      onPrintError: (...args) => send({ type: 'error', text: text(args) }),
      onExit: code => send({ type: 'exited', code }),
    });
    // Standard export templates reject --path. Build the project pack in the
    // browser instead; no Godot exporter or server-generated PCK is involved.
    await engine.preloadFile(event.data.result.pack, '/application.pck');
    await engine.init('./assets/godot');
    await engine.start({ args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility', '--audio-driver', 'Dummy'] });
    send({ type: 'started', generation: event.data.result.generation, crossOriginIsolated });
  } catch (error) { send({ type: 'error', text: String(error) }); }
});
