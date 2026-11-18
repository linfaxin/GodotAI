import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {prepareCompilerEnvironmentInput} from '../dist/environment.js';
import {createCompilerEnvironment} from '../dist/compiler.js';
import {canonicalEngineApi} from '@godot-js/engine/api';
import {createEngineIdentity, nativeEngineIdentityInputs} from '@godot-js/engine/identities';
import {nativeReleaseFixture, sealRelease, digest} from '../../engine/test/fixtures/native-release.mjs';
import {engineApiFixture} from '../../engine/test/fixtures/engine-api-fixture.mjs';

const encode = value => new TextEncoder().encode(value);
async function fixture({version = '4.6.1.stable.custom_build', ir = true, camel = false} = {}) {
  const f = await nativeReleaseFixture();
  f.manifest.engine.version = version;
  const setIr = (naming, profile) => {
    const api = engineApiFixture(); api.engineVersion = version; api.bindingVersion = 'binding/1'; api.namingVersion = 'naming/1'; api.bindingNaming = naming; api.modules = ['GodotJS'];
    profile.ir = f.asset('api/' + naming + '-ir.json', JSON.stringify(api)); profile.actualAPIHash = digest(canonicalEngineApi(api));
    return api;
  };
  if (ir) setIr('snake', f.manifest.api.namingProfiles.snake);
  else delete f.manifest.api.namingProfiles.snake.ir;
  Object.assign(f.manifest.api, f.manifest.api.namingProfiles.snake);
  if (!ir) delete f.manifest.api.ir;
  if (camel) {
    const profile = structuredClone(f.manifest.api.namingProfiles.snake);
    if (ir) setIr('camel', profile);
    f.manifest.api.namingProfiles.camel = profile;
  }
  f.reseal = async () => {f.manifest.engineId = await createEngineIdentity(nativeEngineIdentityInputs(f.manifest)); sealRelease(f.manifest); return encode(JSON.stringify(f.manifest));};
  f.bytes = await f.reseal();
  f.read = [];
  f.options = (extra = {}) => ({descriptorBytes: f.bytes, naming: 'snake', selection: {kind: 'engine'},
    readRawAsset: async (asset, options) => {f.read.push({path: asset.path, options}); assert(f.files.has(asset.path)); return new Uint8Array(f.files.get(asset.path));}, ...extra});
  return f;
}

test('engine and complete SDK modes own actual base bytes without forcing an extension', async () => {
  const f = await fixture(), base = await prepareCompilerEnvironmentInput(f.options());
  assert.equal(base.facts.api.status, 'available'); assert.equal(base.api.bindingNaming, 'snake');
  assert.equal(base.facts.release.descriptorSha256, digest(f.bytes));
  assert.equal(base.facts.resources.status, 'available'); assert.equal(base.facts.resources.target.features.engineId, f.manifest.engineId);
  assert.equal(base.facts.assetReadLimits.maxStoredBytes, 64 * 1024 * 1024);
  assert.equal(base.input.vendor, undefined); assert.deepEqual(Object.keys(base.input.runtimeModules), []);
  assert.equal(base.input.target.extensionId, undefined); assert.equal(base.facts.requiredExtensionId, undefined);
  assert(f.read.every(item => !item.path.includes('vendor') && !item.path.includes('.playground/react')));
  assert(Object.isFrozen(base.facts.resources.target.features));
  for (const mode of ['development', 'production']) {
    const prepared = await prepareCompilerEnvironmentInput(f.options({selection: {kind: 'sdk', mode}}));
    assert.equal(prepared.facts.requiredExtensionId, f.manifest.extensionId);
    assert.equal(prepared.input.target.extensionId, f.manifest.extensionId);
    assert.deepEqual(Object.keys(prepared.input.runtimeModules), Object.keys(f.manifest.sdk.runtimeModules));
    assert.deepEqual(prepared.input.vendor, new Uint8Array(f.files.get(f.manifest.sdk.vendors[mode].path)));
    prepared.input.vendor.fill(0);
    assert.notDeepEqual(prepared.input.vendor, f.files.get(f.manifest.sdk.vendors[mode].path));
  }
  const input = {...base.input, declarations: {...base.input.declarations, '/host.d.ts': 'export const host: number;'}, moduleDeclarations: {...base.input.moduleDeclarations, '@host/demo': '/host.d.ts'},
    runtimeModules: {...base.input.runtimeModules, '@host/demo': encode('exports.host=1;')}, target: {...base.input.target, compatibilityAdapter: 'explicit-host/1'}};
  const env = await createCompilerEnvironment(input);
  assert.equal(env.identity.target.compatibilityAdapter, 'explicit-host/1'); assert.equal(base.facts.baseRuntimeModules.length, 0);
  assert.equal(env.runtimeModules['@host/demo'].length, input.runtimeModules['@host/demo'].length);
});

test('configuration and descriptor bytes are captured before the first await and original abort stays effective', async () => {
  const f = await fixture(), options = f.options(), original = f.bytes.slice();
  const pending = prepareCompilerEnvironmentInput(options);
  options.descriptorBytes.fill(0); options.naming = 'camel'; options.selection.kind = 'sdk'; options.selection.mode = 'development'; options.readRawAsset = () => {throw Error('replacement reader');}; options.assetReadLimits = {maxStoredBytes: 1};
  const prepared = await pending;
  assert.equal(prepared.facts.release.descriptorSha256, digest(original)); assert.equal(prepared.facts.selection.kind, 'engine');
  let entered, release;
  const arrived = new Promise(resolve => entered = resolve), response = new Promise(resolve => release = resolve);
  const g = await fixture(), controller = new AbortController(), reason = Error('cancel selected input');
  const init = g.options({signal: controller.signal, readRawAsset: async (asset, options) => {entered({asset, options}); return response;}});
  const cancelled = prepareCompilerEnvironmentInput(init), read = await arrived;
  init.signal = new AbortController().signal; assert.equal(read.options.signal, controller.signal);
  controller.abort(reason); release(g.files.get(read.asset.path));
  await assert.rejects(cancelled, error => error === reason);
});

test('naming profiles use their own IR and absent IR remains distinct from provided invalid data', async () => {
  const f = await fixture({camel: true});
  const camel = await prepareCompilerEnvironmentInput(f.options({naming: 'camel'})); assert.equal(camel.api.bindingNaming, 'camel');
  delete f.manifest.api.namingProfiles.camel.ir; f.bytes = await f.reseal();
  const noCamelIr = await prepareCompilerEnvironmentInput(f.options({naming: 'camel'})); assert.equal(noCamelIr.facts.api.status, 'unknown'); assert.equal(noCamelIr.api, undefined);
  const unknown = await fixture({ir: false}); assert.equal((await prepareCompilerEnvironmentInput(unknown.options())).facts.api.status, 'unknown');
  const malformed = await fixture(); malformed.manifest.api.namingProfiles.snake.ir = malformed.asset('api/bad.json', '{invalid'); malformed.bytes = await malformed.reseal();
  await assert.rejects(prepareCompilerEnvironmentInput(malformed.options()), /E_COMPILER_API/);
  const mismatch = await fixture();
  const asset = mismatch.manifest.api.namingProfiles.snake.ir, body = JSON.parse(Buffer.from(mismatch.files.get(asset.path)).toString()); body.bindingNaming = 'camel';
  mismatch.manifest.api.namingProfiles.snake.ir = mismatch.asset(asset.path, JSON.stringify(body)); mismatch.manifest.api.ir = mismatch.manifest.api.namingProfiles.snake.ir; mismatch.bytes = await mismatch.reseal();
  await assert.rejects(prepareCompilerEnvironmentInput(mismatch.options()), /E_COMPILER_API_TARGET/);
  const broken = await fixture();
  await assert.rejects(prepareCompilerEnvironmentInput(broken.options({readRawAsset: async asset => asset.path.includes('ir.json') ? encode('corrupt') : broken.files.get(asset.path)})), /E_ASSET_LENGTH|E_ASSET_HASH/);
  await assert.rejects(prepareCompilerEnvironmentInput((await fixture()).options({naming: 'camel'})), /E_COMPILER_NAMING/);
});

test('compressed snapshots are decoded once and unsupported engines have no guessed resource target', async () => {
  const f = await fixture(), profile = f.manifest.api.namingProfiles.snake;
  const decoded = f.files.get(profile.typeSnapshot.path), stored = new Uint8Array(gzipSync(decoded));
  profile.typeSnapshot = {...f.asset('types.json.gz', stored), encoding: 'gzip', decodedSha256: digest(decoded), decodedBytes: decoded.length};
  f.manifest.payloads[profile.typeSnapshot.path] = profile.typeSnapshot;
  f.manifest.api.typeSnapshot = profile.typeSnapshot;
  f.bytes = await f.reseal();
  const result = await prepareCompilerEnvironmentInput(f.options()); assert.equal(result.input.declarations['/godot/index.d.ts'], f.types['/godot/index.d.ts']);
  await assert.rejects(prepareCompilerEnvironmentInput(f.options({readRawAsset: async asset => asset.encoding ? decoded : f.files.get(asset.path)})), /E_ASSET_LENGTH|E_ASSET_HASH/);
  for (const version of ['4.6.3.stable', '4.6.10.stable', 'unknown']) {
    const newer = await fixture({version}); const base = await prepareCompilerEnvironmentInput(newer.options()); assert.equal(base.facts.resources.status, 'unknown');
  }
});

test('invalid selected modes and SDK declaration/runtime mismatches reject rather than falling back', async () => {
  const f = await fixture();
  await assert.rejects(prepareCompilerEnvironmentInput(f.options({selection: {kind: 'sdk', mode: 'unknown'}})), /E_COMPILER_SELECTION/);
  delete f.manifest.sdk.vendors.development; f.bytes = await f.reseal();
  await assert.rejects(prepareCompilerEnvironmentInput(f.options({selection: {kind: 'sdk', mode: 'development'}})), /E_IDENTITY_EXTENSION|E_COMPILER_SDK_MODE/);
});
