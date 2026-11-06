const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const React = require('react');
const SDK = require('../dist');
const schema = require('../dist/schema');
const contracts = require('../dist/contracts');
const { MockNativePort } = require('../dist/testing');

test('game-2d is the immutable additive union and preserves every existing profile identity', () => {
  const profile = schema.getProfileSchema('game-2d-v1');
  assert.equal(profile.profile.version, 1);
  assert.equal(profile.profile.hosts.length, 17);
  assert.deepEqual(new Set(profile.profile.hosts), new Set([
    ...Object.keys(schema.HOST_SCHEMA), ...Object.keys(schema.MEDIA_HOST_SCHEMA), ...Object.keys(schema.PHYSICS_HOST_SCHEMA),
  ]));
  assert.deepEqual(new Set(profile.profile.resources), new Set([
    'Resource', 'CanvasItemMaterial', 'Texture2D', 'ImageTexture', 'CompressedTexture2D',
    'CircleShape2D', 'RectangleShape2D', 'CapsuleShape2D',
  ]));
  assert.equal(profile.profile.resources.length, 8);
  assert.deepEqual(profile.profile.features, { ...schema.CORE_PROFILE.features, media: true, physics: true });
  for (const source of [schema.HOST_SCHEMA, schema.MEDIA_HOST_SCHEMA, schema.PHYSICS_HOST_SCHEMA]) {
    for (const [name, definition] of Object.entries(source)) assert.equal(profile.hosts[name], definition);
  }
  for (const value of [profile, profile.hosts, profile.profile, profile.profile.hosts, profile.profile.resources, profile.profile.features]) assert(Object.isFrozen(value));
  contracts.validateCapabilityProfile(profile.profile);
  assert.deepEqual(schema.game2dProfileReference(), schema.profileReference('game-2d-v1'));
  const identities = {
    'core-ui-v1': '2807c96de6bd7f87174263262ec5c9d1a8f473a1e5620175f2edf179cb58eae5',
    'ui-media-v1': '5323afc67db82301a6237a6f64d25872ddda340731842796c6d5833a31307da7',
    'behavior-physics-v1': '9c21f0cf123005826d3277547d1d5871b336b931606f353e45afa704ef5827a8',
    'game-2d-v1': schema.GAME_2D_PROFILE_HASH,
  };
  for (const [id, hash] of Object.entries(identities)) {
    assert.equal(schema.profileReference(id).hash, hash);
    assert.equal(createHash('sha256').update(schema.schemaFingerprintInput(id)).digest('hex'), hash);
  }
  assert.throws(() => schema.getHostSchema('Sprite2D', 'behavior-physics-v1'), /E_HOST_UNSUPPORTED/);
  assert.throws(() => schema.getHostSchema('CharacterBody2D', 'ui-media-v1'), /E_HOST_UNSUPPORTED/);
});

test('unified resource properties retain their type, scope and ownership restrictions', () => {
  const context = { profileId: 'game-2d-v1' };
  assert.equal(schema.validateHostProps('Sprite2D', { texture: SDK.asset('image', 'Texture2D') }, context).controlled.texture.type, 'Texture2D');
  assert.equal(schema.validateHostProps('CollisionShape2D', { shape: SDK.asset('shape', 'CircleShape2D') }, context).controlled.shape.type, 'CircleShape2D');
  assert.throws(() => schema.validateHostProps('Sprite2D', { texture: SDK.asset('shape', 'CircleShape2D') }, context), /E_PROPERTY_VALUE/);
  assert.throws(() => schema.validateHostProps('CollisionShape2D', { shape: SDK.asset('image', 'Texture2D') }, context), /E_PROPERTY_VALUE/);
  assert.throws(() => schema.validateHostProps('Sprite2D', { texture: { ...SDK.asset('image', 'Texture2D'), scope: 'instance' } }, context), /E_PROFILE_UNSUPPORTED/);
  assert.throws(() => schema.validateHostProps('CharacterBody2D', { velocity: SDK.vec2(1, 0), engineOwned: ['velocity'] }, context), /E_PROPERTY_OWNER_CONFLICT/);
  assert.throws(() => schema.getHostSchema('Area2D', 'game-2d-v1'), /E_HOST_UNSUPPORTED/);
});

test('mock construction supplies media defaults before React setters run', () => {
  const port = new MockNativePort();
  port.beginStage('initial');
  try {
    const sprite = port.create('Sprite2D');
    const progress = port.create('ProgressBar');
    const body = port.create('CharacterBody2D');
    assert.equal(port.read(sprite, 'centered'), true);
    assert.equal(port.read(sprite, 'texture'), null);
    assert.equal(port.read(progress, 'max_value'), 100);
    assert.equal(port.read(progress, 'step'), 0);
    assert.deepEqual(port.read(body, 'up_direction'), { x: 0, y: -1 });
  } finally { port.endStage(); }
});

test('mixed hosts preserve body identity during texture and HUD updates and retire stale commands', async () => {
  const port = new MockNativePort(), container = port.createContainer();
  const assets = {
    first: { uri: 'res://first.tres', type: 'Texture2D' },
    second: { uri: 'res://second.tres', type: 'Texture2D' },
    shape: { uri: 'res://shape.tres', type: 'CircleShape2D' },
  };
  for (const item of Object.values(assets)) port.assets.set(item.uri, {});
  const root = SDK.createRoot(port, container, { generation: 'mixed', profileId: 'game-2d-v1', assets });
  let update, reset, handle, stale;
  function App() {
    const [alternate, setAlternate] = React.useState(false);
    const [round, setRound] = React.useState(0);
    update = setAlternate; reset = () => setRound(value => value + 1);
    const body = SDK.useNodeRef();
    const texture = SDK.useAsset(SDK.asset(alternate ? 'second' : 'first', 'Texture2D'));
    const shape = SDK.useAsset(SDK.asset('shape', 'CircleShape2D'));
    React.useLayoutEffect(() => { handle = body.current; });
    SDK.usePhysicsProcess(body, { writes: ['position', 'velocity'] }, commands => {
      stale = commands; commands.setVelocity(SDK.vec2(0, 12)); commands.moveAndSlide();
    });
    return React.createElement(SDK.Node, { name: 'world' },
      React.createElement(SDK.CharacterBody2D, { key: round, ref: body, name: 'actor', engineOwned: ['position', 'velocity'] },
        React.createElement(SDK.CollisionShape2D, { shape }), React.createElement(SDK.Sprite2D, { name: 'sprite', texture })),
      React.createElement(SDK.CanvasLayer, { name: 'hud' }, React.createElement(SDK.ProgressBar, { value: alternate ? 75 : 25 })));
  }
  try {
    root.preloadAssets(Object.keys(assets)); root.pump(); root.render(React.createElement(App));
    for (let attempt = 0; !handle && attempt < 5; attempt++) { root.pump(); await new Promise(resolve => setTimeout(resolve, 100)); }
    assert(handle);
    const firstBody = handle;
    const sprite = port.children(firstBody.nativeKey).find(key => port.info(key).name === 'sprite');
    assert.equal(port.read(sprite, 'centered'), true);
    assert.deepEqual(port.read(sprite, 'offset'), { x: 0, y: 0 });
    root.physics(1 / 60);
    assert.deepEqual(firstBody.readVelocity(), { x: 0, y: 12 });
    update(true); root.flush(); root.pump();
    assert.equal(handle, firstBody);
    assert.deepEqual(handle.readVelocity(), { x: 0, y: 12 });
    assert.equal(port.read(sprite, 'texture').id, 'res://second.tres');
    assert.throws(() => stale.setVelocity(SDK.vec2(0, 20)), /E_STALE_COMMAND/);
    reset(); root.flush(); root.pump();
    assert.notEqual(handle, firstBody); assert.equal(firstBody.isValid(), false);
    assert.equal(root.getErrors().length, 0);
  } finally { root.shutdown(); }
  assert.equal(port.liveCount(), 1); assert.equal(port.connectionCount(), 0);
});
