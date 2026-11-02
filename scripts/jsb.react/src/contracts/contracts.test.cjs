'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const dist = process.env.GODOT_REACT_TEST_DIST || path.resolve(__dirname, '../../dist');
const c = require(path.join(dist, 'contracts/index.js'));
const s = require(path.join(dist, 'schema/index.js'));
const hash = '0'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
function rejects(fn, code) { assert.throws(fn, error => error instanceof c.ContractError && (!code || error.code === code)); }
function fixture() {
  return clone(require('./fixtures/runtime-manifest-v1.json'));
}

test('NativeKey preserves all 32-bit revision bits and rejects packed JS numbers', () => {
  const sharedKey = require('./fixtures/native-key-v1.json');
  assert.equal(c.validateNativeKey(sharedKey).revision, 0xffffffff);
  const key = c.validateNativeKey({ slot: 1, revision: 0xffffffff });
  assert.equal(c.nativeKeyString(key), '1:4294967295');
  assert(c.nativeKeyEquals(key, { slot: 1, revision: 0xffffffff }));
  for (const bad of [9007199254740992, { slot: -1, revision: 1 }, { slot: 0, revision: 0 }, { slot: 0x80000000, revision: 1 }, { slot: 0, revision: 1, pointer: 123 }]) rejects(() => c.validateNativeKey(bad));
});

test('res URIs are canonical and cannot escape or ambiguously encode paths', () => {
  c.assertCanonicalResPath('res://assets/My 场景.tscn');
  for (const bad of ['file:///tmp/x', 'res://', 'res://a/../b', 'res://a//b', 'res://./x', 'res://a\\b', 'res://a%2fb', 'res://a?b', 'res://a#b', 'res://a:stream', 'res://a\nb', 'res://a\rb', 'res://a\tb', 'res://a\x7fb']) rejects(() => c.assertCanonicalResPath(bad), c.ERROR_CODES.INVALID_PATH);
});

test('canonical JSON is stable and rejects cycles, accessors and unsupported data', () => {
  assert.equal(c.canonicalJson({ z: 1, a: { b: 2, a: true } }), '{"a":{"a":true,"b":2},"z":1}');
  const cyclic = {}; cyclic.x = cyclic;
  for (const bad of [cyclic, { bad: undefined }, { bad: NaN }, { bad: () => {} }, [, 1]]) rejects(() => c.canonicalJson(bad));
  let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { invoked = true; return 1; } });
  rejects(() => c.canonicalJson(accessor)); assert.equal(invoked, false);
  const arrayAccessor = []; Object.defineProperty(arrayAccessor, 0, { enumerable: true, get() { invoked = true; return 1; } });
  rejects(() => c.canonicalJson(arrayAccessor)); assert.equal(invoked, false);
  const extraArray = [1]; extraArray.extra = 2; rejects(() => c.canonicalJson(extraArray));
  const hidden = { slot: 0, revision: 1 }; Object.defineProperty(hidden, 'secret', { value: 1 }); rejects(() => c.validateNativeKey(hidden));
  const frozen = c.immutableData({ a: { b: 1 } }); assert(Object.isFrozen(frozen.a));
});

test('manifest validates three dependency graphs and shared ABI instead of accepting arbitrary JSON', () => {
  const good = fixture(); assert.equal(c.validateManifest(good), good);
  c.assertCompatibility(good, { profileHash: s.CORE_PROFILE_HASH });
  const unknown = clone(good); unknown.unrecognized = true; rejects(() => c.validateManifest(unknown), c.ERROR_CODES.UNKNOWN_FIELD);
  const dependency = clone(good); dependency.modules.app.dependencies.push('missing'); rejects(() => c.validateManifest(dependency));
  const identity = clone(good); identity.nativeScripts = {}; rejects(() => c.validateManifest(identity));
  const output = clone(good); delete output.artifacts[output.modules.app.uri]; rejects(() => c.validateManifest(output));
  const mismatched = clone(good); mismatched.artifacts[mismatched.modules.app.uri].sha256 = '1'.repeat(64); rejects(() => c.validateManifest(mismatched), c.ERROR_CODES.INVALID_HASH);
  const nativeOutput = clone(good); delete nativeOutput.artifacts[nativeOutput.nativeScripts.app.output]; rejects(() => c.validateManifest(nativeOutput));
  const abi = clone(good); abi.runtimeAbi = 'other'; rejects(() => c.assertCompatibility(abi), c.ERROR_CODES.ABI);
  const react = clone(good); react.react.react = '0.0.0'; rejects(() => c.assertCompatibility(react), c.ERROR_CODES.ABI);
  const generation = clone(good); rejects(() => c.validateManifest(generation, { expectedGeneration: 'g2' }), c.ERROR_CODES.GENERATION);
  const collision = clone(good); collision.artifacts['res://.godot/GodotJS/react-build/g1/app.js'] = { sha256: hash, owner: 'compiler', kind: 'runtime' }; rejects(() => c.validateManifest(collision), c.ERROR_CODES.INVALID_PATH);
});

test('activation cannot silently accept old wire field names or an unready generation', () => {
  c.validateActiveDescriptor({ schemaVersion: 1, generation: 'g1', manifestPath: 'res://generated/react/manifests/g1.json', manifestSha256: hash, state: 'READY' });
  rejects(() => c.validateActiveDescriptor({ schemaVersion: 1, generation: 'g1', manifest: 'res://m.json', manifestSha256: hash, state: 'READY' }), c.ERROR_CODES.UNKNOWN_FIELD);
  rejects(() => c.validateActiveDescriptor({ schemaVersion: 1, generation: 'g1', manifestPath: 'res://m.json', manifestSha256: hash, state: 'EMITTED' }), c.ERROR_CODES.BUILD_NOT_READY);
});

test('template topology, owner ancestry, names and resource policy are checked', () => {
  const source = { source: 'res://assets/Panel.tscn', line: 0, column: 0 };
  const template = { schemaVersion: 1, assetId: 'panel', source: source.source, sourceHash: hash, snapshotHash: hash, profile: 'template-t0', rootId: 'root', nodes: [
    { nodeId: 'root', nativeType: 'Node2D', parentId: null, siblingOrder: 0, name: 'Panel', initial: {}, ownerId: null, source },
    { nodeId: 'child', nativeType: 'Node2D', parentId: 'root', siblingOrder: 0, name: 'Child', initial: {}, ownerId: 'root', source },
  ], resources: [] };
  c.validateTemplatePlan(template);
  const owner = clone(template); owner.nodes[1].ownerId = 'child'; rejects(() => c.validateTemplatePlan(owner));
  const missing = clone(template); missing.nodes[1].parentId = 'absent'; rejects(() => c.validateTemplatePlan(missing));
  const cycle = clone(template); cycle.nodes[0].parentId = 'child'; rejects(() => c.validateTemplatePlan(cycle));
  const order = clone(template); order.nodes[1].siblingOrder = 2; rejects(() => c.validateTemplatePlan(order));
  const script = clone(template); script.nodes[1].script = 'res://evil.ts'; rejects(() => c.validateTemplatePlan(script), c.ERROR_CODES.UNKNOWN_FIELD);
  const local = clone(template); local.resources.push({ resourceId: 'r', type: 'Resource', uri: 'res://r.tres', sha256: hash, dependencies: [], sharingPolicy: 'local' }); rejects(() => c.validateTemplatePlan(local), c.ERROR_CODES.IMPORT_LOCAL_RESOURCE);
});

test('core profile hash covers real schema and preserves actual native constructor baselines', () => {
  const digest = crypto.createHash('sha256').update(s.schemaFingerprintInput()).digest('hex');
  assert.equal(digest, s.CORE_PROFILE_HASH);
  assert.equal(s.getHostSchema('Label').properties.mouseFilter.defaultValue, 2);
  assert.equal(s.getHostSchema('Label').properties.sizeFlagsVertical.defaultValue, 4);
  assert.equal(s.getHostSchema('VBoxContainer').properties.mouseFilter.defaultValue, 1);
  assert.equal(s.publicPropertyName('Control', 'custom_minimum_size'), 'customMinimumSize');
  rejects(() => s.getHostSchema('UnknownPluginNode'), c.ERROR_CODES.HOST);
});

test('props reject unknown setters, raw text, invalid codecs and resource capability bypass', () => {
  const props = s.validateHostProps('Button', { text: 'Run', disabled: false, onPressed() {}, children: [null, false] });
  assert.equal(props.controlled.text, 'Run'); assert.equal(typeof props.events.onPressed, 'function');
  for (const bad of [{ text: 42 }, { queueFree() {} }, { onMadeUp() {} }, { children: 'implicit text' }, { children: 1 }, { children: { $$typeof: Symbol('fake') } }, { mouseFilter: 99 }, { material: { instantiate() {} } }]) rejects(() => s.validateHostProps('Button', bad));
  for (const bad of [{ x: Infinity, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, { x: 1, y: 2, z: 3 }, [1, 2]]) rejects(() => s.validateValue('vector2', bad));
  rejects(() => s.validateHostProps('Node2D', { material: { kind: 'asset', id: 'mat', type: 'CanvasItemMaterial', scope: 'instance' } }), c.ERROR_CODES.PROFILE);
});

test('React dev key warning accessors are ignored without reading them', () => {
  const props = { text: 'ok' }; Object.defineProperty(props, 'key', { get() { throw Error('React reserved key getter was read'); } });
  assert.equal(s.validateHostProps('Label', props).controlled.text, 'ok');
});

test('construction modes compare alias sets by content and block controlled writer conflicts', () => {
  const old = s.validateHostProps('Node2D', { name: 'Player', engineOwned: ['position'], initial: { position: { x: 1, y: 2 } } });
  const next = s.validateHostProps('Node2D', { name: 'Player', engineOwned: ['scale', 'rotation'], initial: { position: { x: 1, y: 2 } } }, { previous: old });
  assert.deepEqual(next.engineOwned, ['transform2d']); assert.equal(next.diagnostics.length, 0);
  rejects(() => s.validateHostProps('Node2D', { engineOwned: ['position'], scale: { x: 2, y: 2 } }), c.ERROR_CODES.OWNER);
  rejects(() => s.validateHostProps('Node2D', { name: 'Changed', engineOwned: ['position'] }, { previous: old }), c.ERROR_CODES.CONSTRUCTION);
  rejects(() => s.validateHostProps('Node2D', { name: 'Player' }, { previous: old }), c.ERROR_CODES.CONSTRUCTION);
  assert.deepEqual(s.intrinsicFields('Button', 'VBoxContainer'), ['focus', 'layout.position', 'layout.size']);
});

test('prop reset uses immutable baseline, not last engine state or changed initial', () => {
  const old = s.validateHostProps('Label', { initial: { text: 'instance' }, text: 'controlled' }, { templateInitial: { text: 'template' } });
  const next = s.validateHostProps('Label', { initial: { text: 'ignored change' } }, { previous: old });
  assert.equal(next.baseline.text, 'instance'); assert.equal(next.initial.text, 'instance'); assert.equal(next.diagnostics[0].code, c.ERROR_CODES.INITIAL);
  assert.deepEqual(s.diffHostProps('Label', old, next), [{ publicName: 'text', nativeName: 'text', value: 'instance', reset: true }]);
  const fresh = s.validateHostProps('Label', {}, { templateInitial: { text: 'template' } }); assert.equal(fresh.baseline.text, 'template');
  const defaults = s.validateHostProps('Label', {}); assert.equal(defaults.baseline.text, '');
});

test('native operation and cleanup receipts require exact bound shapes and verified effects', () => {
  const ticket = { rootId: 'app', rootInstance: 'run-1', commitId: 1, buildGeneration: 'g1' }, key = { slot: 1, revision: 1 };
  c.validateNativeOperation({ opId: 'op1', ticket, opcode: 'append', parent: key, child: { slot: 2, revision: 1 } });
  rejects(() => c.validateNativeOperation({ opId: 'op1', ticket, opcode: 'free', target: key, child: key }), c.ERROR_CODES.UNKNOWN_FIELD);
  rejects(() => c.validateNativeOpResult({ opId: 'op1', status: 'applied', verification: 'none' }), c.ERROR_CODES.NATIVE_OP);
  c.validateCleanupReceipt({ ticket, barrier: 'passiveSettled', retirementBatch: 'b1', roots: ['a'], passiveSequence: 1 });
  rejects(() => c.validateCleanupReceipt({ ticket, barrier: 'layoutPublished', retirementBatch: 'b1', roots: ['a'], passiveSequence: 1 }));
  c.assertRootTransition('running', 'quiescing'); rejects(() => c.assertRootTransition('disposed', 'running'));
});

test('boot success includes real publication, topology, assets and error evidence', () => {
  const report = { schemaVersion: 1, kind: 'sdk-boot-verification-v1', scope: 'framework-boot-smoke', entryId: 'app', generation: 'g1', rootInstance: 'run1', runtimeAbi: c.RUNTIME_ABI, nativeBridgeAbi: c.NATIVE_BRIDGE_ABI, profile: s.CORE_PROFILE.id, layoutPublished: 1, treeAudit: { matches: true, businessNodes: 8 }, startupAssets: { requested: ['mat'], ready: ['mat'], failures: [] }, unexpectedErrors: [] };
  c.assertBootSucceeded(report);
  const missing = clone(report); missing.startupAssets.ready = []; rejects(() => c.assertBootSucceeded(missing), c.ERROR_CODES.BUILD_NOT_READY);
  const error = clone(report); error.unexpectedErrors.push('native error'); rejects(() => c.assertBootSucceeded(error), c.ERROR_CODES.BUILD_NOT_READY);
  const tree = clone(report); tree.treeAudit.matches = false; rejects(() => c.assertBootSucceeded(tree), c.ERROR_CODES.BUILD_NOT_READY);
});


test('physics extensions require explicit profile and certify aliases, native defaults and effect phases', () => {
  const profileId = 'behavior-physics-v1';
  rejects(() => s.getHostSchema('CharacterBody2D'), c.ERROR_CODES.HOST);
  rejects(() => s.getProfileSchema('unregistered'), c.ERROR_CODES.PROFILE);
  const profile = s.getProfileSchema(profileId);
  assert.equal(profile.profile.features.physics, true);
  assert.equal(s.getProfileSchema().profile.features.physics, false);
  assert.equal(crypto.createHash('sha256').update(s.schemaFingerprintInput(profileId)).digest('hex'), s.BEHAVIOR_PHYSICS_PROFILE_HASH);
  const body = s.getHostSchema('CharacterBody2D', profileId);
  assert.equal(body.commands.moveAndSlide.phase, 'physics');
  assert.deepEqual(body.commands.moveAndSlide.effects, ['transform2d', 'velocity']);
  assert.equal(body.properties.maxSlides.defaultValue, 4);
  assert.equal(body.properties.floorSnapLength.defaultValue, 1);
  assert.equal(s.publicPropertyName('CharacterBody2D', 'up_direction', profileId), 'upDirection');
  const props = s.validateHostProps('CharacterBody2D', { engineOwned: ['position', 'velocity'], upDirection: { x: 0, y: -10 }, initial: { position: { x: 0, y: -50 } } }, { profileId });
  assert.deepEqual(props.engineOwned, ['transform2d', 'velocity']);
  assert.deepEqual(props.controlled.upDirection, { x: 0, y: -1 });
  rejects(() => s.validateHostProps('CharacterBody2D', { maxSlides: 0 }, { profileId }), c.ERROR_CODES.VALUE);
  rejects(() => s.validateHostProps('CharacterBody2D', { upDirection: { x: 0, y: 0 } }, { profileId }), c.ERROR_CODES.VALUE);
  rejects(() => s.validateHostProps('CharacterBody2D', { velocity: { x: 1, y: 2 }, engineOwned: ['velocity'] }, { profileId }), c.ERROR_CODES.OWNER);
  const shape = { kind: 'asset', id: 'shape', type: 'CapsuleShape2D' };
  assert.equal(s.validateHostProps('CollisionShape2D', { shape }, { profileId }).controlled.shape.id, 'shape');
  rejects(() => s.validateHostProps('CollisionShape2D', { shape: { ...shape, type: 'Script' } }, { profileId }), c.ERROR_CODES.VALUE);
  const old = s.validateHostProps('StaticBody2D', { constantAngularVelocity: 1 }, { profileId });
  const next = s.validateHostProps('StaticBody2D', {}, { profileId, previous: old });
  assert.equal(s.diffHostProps('StaticBody2D', old, next, profileId)[0].value, 0);
});

test('native script profile certifications bind to actual manifest source identities', () => {
  const manifest = fixture();
  manifest.nativeScriptProfiles = { certified: { type: 'Node2D', script: manifest.nativeScripts.app.source, schemaHash: hash } };
  c.validateManifest(manifest);
  const wrong = clone(manifest); wrong.nativeScriptProfiles.certified.script = 'res://unowned.ts';
  rejects(() => c.validateManifest(wrong), c.ERROR_CODES.PROFILE);
  const invalid = clone(manifest); invalid.nativeScriptProfiles.certified.schemaHash = 'invalid';
  rejects(() => c.validateManifest(invalid), c.ERROR_CODES.INVALID_HASH);
  const unknown = clone(manifest); unknown.nativeScriptProfiles.certified.extra = true;
  rejects(() => c.validateManifest(unknown), c.ERROR_CODES.UNKNOWN_FIELD);
});

test('local resources require both an explicit plan profile and a trusted host capability', () => {
  const source = { source: 'res://assets/Panel.tscn', line: 0, column: 0 };
  const resource = { resourceId: 'material', type: 'CanvasItemMaterial', uri: 'res://material.tres', sha256: hash, dependencies: [], sharingPolicy: 'instance' };
  const plan = { schemaVersion: 1, assetId: 'panel', source: source.source, sourceHash: hash, snapshotHash: hash, profile: 'template-t0', rootId: 'root', nodes: [{ nodeId: 'root', nativeType: 'Node2D', parentId: null, siblingOrder: 0, name: 'Panel', initial: {}, ownerId: null, source }], resources: [resource] };
  rejects(() => c.validateTemplatePlan(plan), c.ERROR_CODES.IMPORT_LOCAL_RESOURCE);
  plan.profile = 'template-structural-v1'; rejects(() => c.validateTemplatePlan(plan), c.ERROR_CODES.IMPORT_LOCAL_RESOURCE);
  resource.sharingPolicy = 'shared'; c.validateTemplatePlan(plan); resource.sharingPolicy = 'instance';
  plan.profile = 'template-local-v1'; c.validateTemplatePlan(plan);
  const material = { kind: 'asset', id: 'material', type: 'CanvasItemMaterial', scope: 'instance' };
  rejects(() => s.validateHostProps('Node2D', { material }), c.ERROR_CODES.PROFILE);
  assert.equal(s.validateHostProps('Node2D', { material }, { allowInstanceResources: true }).controlled.material.scope, 'instance');
  assert.equal(s.validateInitialProperties('Node2D', { material }, '$.initial', undefined, true).material.scope, 'instance');
});


test('publication, dispatch capability and lease DTOs enforce barriers and bound capabilities', () => {
  const ticket = { rootId: 'root', rootInstance: 'i', commitId: 1, buildGeneration: 'g' };
  c.validatePublicationReceipt({ ticket, barrier: 'nativeApplied' });
  c.validatePublicationReceipt({ ticket, barrier: 'layoutPublished' });
  rejects(() => c.validatePublicationReceipt({ ticket, barrier: 'layoutPublished', retirementBatch: 'wrong' }), c.ERROR_CODES.UNKNOWN_FIELD);
  rejects(() => c.validatePublicationReceipt({ ticket, barrier: 'passiveSettled' }));
  const lease = { id: 'lease', version: 1, hostId: 'h', hookId: 'hook', phase: 'physics', canonicalFields: ['transform2d', 'velocity'] };
  c.validatePropertyLease(lease);
  rejects(() => c.validatePropertyLease({ ...lease, canonicalFields: ['velocity', 'transform2d'] }), c.ERROR_CODES.OWNER);
  const cap = { rootInstance: 'i', target: { slot: 1, revision: 0xffffffff }, hookId: 'hook', leaseId: 'lease', leaseVersion: 1, operationEpoch: 0, dispatchToken: 'dispatch', phase: 'physics' };
  c.validateDispatchCapability(cap);
  rejects(() => c.validateDispatchCapability({ ...cap, phase: 'layout' }), c.ERROR_CODES.PHASE);
  const batch = { id: 'batch', ticket, roots: ['h'], nativeKeys: [cap.target] };
  c.validateRetirementBatch(batch);
  rejects(() => c.validateRetirementBatch({ ...batch, nativeKeys: [cap.target, cap.target] }));
  c.validateCapabilityProfile(s.CORE_PROFILE); c.validateCapabilityProfile(s.BEHAVIOR_PHYSICS_PROFILE);
  rejects(() => c.validateCapabilityProfile({ ...s.CORE_PROFILE, features: { physics: 'yes' } }), c.ERROR_CODES.PROFILE);
});


test('Button setter dependency order and effect aliases match native BaseButton semantics', () => {
  const names = s.orderedPropertyNames('Button');
  assert(names.indexOf('toggleMode') < names.indexOf('buttonPressed'));
  assert.deepEqual(s.canonicalFields('Button', ['toggleMode', 'buttonPressed']), ['button.state']);
  rejects(() => s.validateHostProps('Button', { buttonPressed: true }), c.ERROR_CODES.VALUE);
  rejects(() => s.validateHostProps('Button', { initial: { buttonPressed: true } }), c.ERROR_CODES.VALUE);
  const enabled = s.validateHostProps('Button', { buttonPressed: true, toggleMode: true });
  assert.equal(enabled.controlled.buttonPressed, true);
  s.validateHostProps('Button', { initial: { buttonPressed: true }, toggleMode: true });
  rejects(() => s.validateHostProps('Button', { engineOwned: ['buttonPressed'], toggleMode: true }), c.ERROR_CODES.OWNER);
  const initial = s.validateHostProps('Button', { initial: { toggleMode: true, buttonPressed: true } });
  s.validateHostProps('Button', { initial: { toggleMode: true, buttonPressed: true }, toggleMode: false }, { previous: initial });
});
