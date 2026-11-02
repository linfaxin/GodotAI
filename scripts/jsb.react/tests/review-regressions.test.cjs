const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const SDK = require('../dist');
const { MockNativePort } = require('../dist/testing');
const { execFileSync } = require('node:child_process');
const h = React.createElement;

function setup(options = {}) {
  const port = new MockNativePort();
  const container = port.createContainer();
  return { port, container, root: SDK.createRoot(port, container, { generation: 'review-regressions', ...options }) };
}

test('development Suspense works without a global performance object and does not install one', () => {
  const script = `
    delete globalThis.performance;
    const React=require('react'),SDK=require('./dist'),{MockNativePort}=require('./dist/testing');
    const assert=require('node:assert/strict'),h=React.createElement;
    (async()=>{
      const port=new MockNativePort(),container=port.createContainer(),root=SDK.createRoot(port,container,{generation:'no-browser-performance',mode:'development'});
      let resolve,block;const waiting=new Promise(r=>resolve=r);
      function Child(){const [blocked,set]=React.useState(false);block=set;if(blocked)React.use(waiting);return h(SDK.Label,{name:'Content'});}
      try{root.render(h(React.Suspense,{fallback:h(SDK.Label,{name:'Loading'})},h(Child)));
        block(true);root.flush();root.pump();await new Promise(r=>setTimeout(r,350));root.pump();
        assert(port.children(container).some(key=>port.info(key).name==='Loading'));
        resolve();await new Promise(r=>setTimeout(r,100));root.pump();assert.equal(root.state,'running');
        assert.equal(globalThis.performance,undefined);assert.deepEqual(root.getErrors(),[]);
      }finally{root.shutdown();resolve();}
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  execFileSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 10000 });
});

for (const phase of ['process', 'physics', 'input']) {
  test(`${phase} Hook follows a forwarded ref through independent child mounts and key changes`, () => {
    const { root } = setup({ profileId: 'behavior-physics-v1' });
    let change, renders = 0, ticks = 0;
    const seen = [];
    function Child({ nodeRef }) {
      const [version, set] = React.useState(null); change = set;
      return version === null ? null : h(SDK.CharacterBody2D, {
        key: version, ref: nodeRef, engineOwned: ['position', 'velocity'],
      });
    }
    function Parent() {
      renders++;
      const ref = SDK.useNodeRef();
      const callback = commands => {
        ticks++; seen.push(commands.id);
        if (phase === 'process') commands.setPosition({ x: ticks, y: 0 });
        if (phase === 'physics') commands.setVelocity({ x: ticks, y: 0 });
      };
      if (phase === 'input') SDK.useInput(ref, callback);
      else (phase === 'process' ? SDK.useProcess : SDK.usePhysicsProcess)(ref, {
        writes: [phase === 'process' ? 'position' : 'velocity'],
      }, callback);
      return h(Child, { nodeRef: ref });
    }
    try {
      root.render(h(Parent)); root[phase](phase === 'input' ? {} : .01);
      assert.equal(ticks, 0);
      for (const version of [0, 1]) {
        change(version); root.flush(); root.pump(); root[phase](phase === 'input' ? {} : .01);
      }
      assert.equal(renders, 1); assert.equal(ticks, 2); assert.notEqual(seen[0], seen[1]);
    } finally { root.shutdown(); }
  });
}

test('ref rebinding validates the new host ownership before any frame command', () => {
  const { root } = setup(); let change, ticks = 0;
  function Child({ nodeRef }) {
    const [version, set] = React.useState(0); change = set;
    return h(SDK.Node2D, { key: version, ref: nodeRef, engineOwned: version ? [] : ['position'] });
  }
  function Parent() {
    const ref = SDK.useNodeRef(); SDK.useProcess(ref, { writes: ['position'] }, () => ticks++);
    return h(Child, { nodeRef: ref });
  }
  try {
    root.render(h(Parent)); root.process(.01); change(1);
    assert.throws(() => { root.flush(); root.pump(); }, /E_PROPERTY_OWNER_CONFLICT/);
    root.process(.01); assert.equal(ticks, 1); assert.equal(root.state, 'faulted');
  } finally { root.shutdown(); }
});

test('NativeReady cleans a removed child while its handle is alive and binds a later child', () => {
  const { root } = setup(); let change; const events = [];
  function Child({ nodeRef }) {
    const [version, set] = React.useState(0); change = set;
    return version === null ? null : h(SDK.Label, { key: version, ref: nodeRef, text: `v${version}` });
  }
  function Parent() {
    const ref = SDK.useNodeRef();
    SDK.useNativeReady(ref, node => {
      events.push(['ready', node.read('text')]);
      return () => events.push(['cleanup', node.isValid(), node.read('text')]);
    });
    return h(Child, { nodeRef: ref });
  }
  try {
    root.render(h(Parent)); change(null); root.flush(); root.pump();
    assert.deepEqual(events, [['ready', 'v0'], ['cleanup', true, 'v0']]);
    assert.equal(root.getStats().hostRecords, 0);
    change(1); root.flush(); root.pump(); root.shutdown();
    assert.deepEqual(events.slice(2), [['ready', 'v1'], ['cleanup', true, 'v1']]);
  } finally { root.shutdown(); }
});

test('a throwing NativeReady cleanup is revoked before invocation and is never repeated', () => {
  const { root } = setup(); let change, cleanups = 0;
  function App() {
    const [on, set] = React.useState(true); change = set;
    const ref = SDK.useNodeRef(); SDK.useNativeReady(ref, () => () => { cleanups++; throw Error('ready cleanup failed'); });
    return on ? h(SDK.Node, { ref }) : null;
  }
  root.render(h(App)); change(false);
  assert.throws(() => { root.flush(); root.pump(); }, /ready cleanup failed/);
  root.shutdown(); assert.equal(cleanups, 1);
});

test('Suspense hides Node descendants and independent CanvasLayers, then restores their values', async () => {
  const { root, port, container } = setup(); let block, resolve;
  const waiting = new Promise(r => resolve = r);
  function Scene() {
    const [blocked, set] = React.useState(false); block = set;
    if (blocked) React.use(waiting);
    return h(SDK.Node, { name: 'Group' },
      h(SDK.Label, { name: 'Visible', text: 'old scene' }),
      h(SDK.Label, { name: 'InitiallyHidden', initial: { visible: false } }),
      h(SDK.Node, { name: 'Nested' }, h(SDK.CanvasLayer, { name: 'Layer' }, h(SDK.Label, { name: 'HUD' }))));
  }
  const find = (parent, name) => port.children(parent).find(key => port.info(key).name === name);
  try {
    root.render(h(React.Suspense, { fallback: h(SDK.Label, { name: 'Loading' }) }, h(Scene)));
    const group = find(container, 'Group'), visible = find(group, 'Visible'), hidden = find(group, 'InitiallyHidden');
    const layer = find(find(group, 'Nested'), 'Layer'), hud = find(layer, 'HUD');
    block(true); root.flush(); root.pump(); await new Promise(r => setTimeout(r, 350)); root.pump();
    assert(find(container, 'Loading'));
    for (const key of [visible, hidden, layer, hud]) assert.equal(port.read(key, 'visible'), false);
    resolve();
    for (let i = 0; i < 5 && find(container, 'Loading'); i++) { await new Promise(r => setTimeout(r, 100)); root.pump(); }
    assert.equal(find(container, 'Loading'), undefined);
    for (const key of [visible, layer, hud]) assert.equal(port.read(key, 'visible'), true);
    assert.equal(port.read(hidden, 'visible'), false);
  } finally { root.shutdown(); resolve(); }
});

test('a host rejects disjoint frame writers even across process and physics phases', () => {
  const { root } = setup({ profileId: 'behavior-physics-v1' });
  function App() {
    const ref = SDK.useNodeRef();
    SDK.useProcess(ref, { writes: ['position'] }, () => {});
    SDK.usePhysicsProcess(ref, { writes: ['velocity'] }, () => {});
    return h(SDK.CharacterBody2D, { ref, engineOwned: ['position', 'velocity'] });
  }
  try { assert.throws(() => root.render(h(App)), /E_PROPERTY_WRITER_CONFLICT/); }
  finally { root.shutdown(); }
});

test('initial changes emit development diagnostics without changing the baseline or faulting', () => {
  const received = [];
  const { root, port, container } = setup({ mode: 'development', onDiagnostic: d => received.push(d) });
  function App({ text }) { return h(SDK.Label, { name: 'Text', initial: { text } }); }
  try {
    root.render(h(App, { text: 'before' })); root.render(h(App, { text: 'after' }));
    assert.equal(port.read(port.children(container)[0], 'text'), 'before');
    assert.equal(received.length, 1); assert.match(received[0].message, /change key/);
    assert.equal(received[0].hostId, root.getHostGraph()[0].id);
    assert.equal(received[0].generation, 'review-regressions'); assert(Object.isFrozen(received[0]));
    assert.deepEqual(root.getDiagnostics(), received); assert.deepEqual(root.getErrors(), []);
    assert.equal(root.state, 'running');
  } finally { root.shutdown(); }
});

test('initial change diagnostics use the development console by default and stay quiet in production', () => {
  const original = console.warn, warnings = []; console.warn = (...args) => warnings.push(args);
  try {
    for (const mode of ['development', 'production']) {
      const { root } = setup({ mode });
      try { root.render(h(SDK.Label, { initial: { text: 'before' } })); root.render(h(SDK.Label, { initial: { text: 'after' } })); }
      finally { root.shutdown(); }
    }
    assert.equal(warnings.length, 1); assert.equal(warnings[0][0], 'GODOT_REACT_DIAGNOSTIC');
  } finally { console.warn = original; }
});
