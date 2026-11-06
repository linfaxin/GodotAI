const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const SDK = require('../dist');
const { MockNativePort } = require('../dist/testing');

function setup() {
  const port = new MockNativePort(), container = port.createContainer();
  const loaded = [], released = [], created = [];
  const originalCreate = port.create.bind(port), originalLoad = port.loadAsset.bind(port);
  port.create = type => { created.push(type); return originalCreate(type); };
  port.loadAsset = (path, type) => { loaded.push(path); return originalLoad(path, type); };
  port.releaseAsset = id => released.push(id);
  port.assets.set('res://texture.tres', {}); port.assets.set('res://shape.tres', {});
  const root = SDK.createRoot(port, container, { generation: 'game2d-assets', profileId: 'game-2d-v1', assets: {
    texture: { uri: 'res://texture.tres', type: 'Texture2D' }, shape: { uri: 'res://shape.tres', type: 'CircleShape2D' },
  } });
  function World() {
    const texture = SDK.useAsset(SDK.asset('texture', 'Texture2D'));
    const shape = SDK.useAsset(SDK.asset('shape', 'CircleShape2D'));
    return React.createElement(SDK.CharacterBody2D, null,
      React.createElement(SDK.CollisionShape2D, { shape }), React.createElement(SDK.Sprite2D, { texture }));
  }
  const scene = React.createElement(React.Suspense, { fallback: React.createElement(SDK.Label, { text: 'Loading' }) }, React.createElement(World));
  return { root, port, container, loaded, released, created, scene };
}
async function pumpUntil(root, predicate) {
  for (let attempt = 0; !predicate() && attempt < 25; attempt++) {
    root.pump(); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(predicate(), 'mixed asset scene did not reach its expected state');
}

test('cancel before the first asset pump never materializes a physical world or loads retired jobs', async () => {
  const { root, loaded, released, created, scene } = setup();
  try {
    root.preloadAssets(['texture', 'shape']); root.render(scene);
    assert.equal(loaded.length, 0, 'preloading schedules work; it does not load outside a pump');
    root.shutdown();
    await new Promise(resolve => setTimeout(resolve, 25)); root.pump();
    assert.equal(loaded.length, 0); assert.equal(released.length, 0);
    assert(!created.includes('CharacterBody2D'));
    assert.equal(root.getStats().assetRefs, 0); assert.equal(root.getStats().hostRecords, 0);
  } finally { root.shutdown(); }
});

test('cold mixed resources publish the world only after loading and stay cached until root shutdown', async () => {
  const { root, port, loaded, released, created, scene } = setup();
  try {
    root.preloadAssets(['texture', 'shape']); root.render(scene);
    assert.equal(loaded.length, 0); assert(!created.includes('CharacterBody2D'));
    root.physics(1 / 60); assert(!created.includes('CharacterBody2D'));
    await pumpUntil(root, () => created.includes('CharacterBody2D'));
    assert.deepEqual(loaded.sort(), ['res://shape.tres', 'res://texture.tres']);
    assert.equal(root.getStats().assetRefs, 2);
    root.render(null);
    assert.equal(root.getStats().hostRecords, 0); assert.equal(root.getStats().assetRefs, 2);
    assert.equal(released.length, 0, 'unmounting the actor preserves shared root assets');
    root.shutdown();
    assert.deepEqual(released.sort(), ['res://shape.tres', 'res://texture.tres']);
    assert.equal(root.getStats().assetRefs, 0); assert.equal(port.liveCount(), 1);
  } finally { root.shutdown(); }
});

test('failed native shape loading never publishes a partially textured physical body', async () => {
  const { root, port, loaded, released, created, scene } = setup();
  let caught = false;
  class Boundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { assert.match(String(error), /E_ASSET_MISSING/); caught = true; }
    render() { return this.state.failed ? React.createElement(SDK.Label, { text: 'Asset unavailable' }) : this.props.children; }
  }
  try {
    // The first image succeeds, but the native shape load fails. This differs
    // from malformed source assets being rejected before starting an engine.
    port.assets.delete('res://shape.tres');
    root.preloadAssets(['texture', 'shape']); root.render(React.createElement(Boundary, null, scene));
    await pumpUntil(root, () => caught);
    assert(!created.includes('CharacterBody2D'));
    assert.equal(loaded.length, 2);
    root.shutdown(); assert.deepEqual(released, ['res://texture.tres']);
    assert.equal(root.getStats().hostRecords, 0); assert.equal(root.getStats().assetRefs, 0);
  } finally { root.shutdown(); }
});
