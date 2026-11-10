import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { loadVerifiedEngine, validateRelease } from '../dist/verified-loader.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = text => new TextEncoder().encode(text);
const audio = raw('registerProcessor("godot-processor", class {});');
const position = raw('registerProcessor("godot-position", class {});');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { append = script => queueMicrotask(() => script.onload?.()), wasmGate, compressed = false } = {}) {
  const bytes = new Map(), blobs = new Map(), revoked = [], scripts = [], requests = [];
  const asset = (name, content) => {
    const url = `https://preview.test/${name}`;
    bytes.set(url, content);
    return { url, sha256: sha(content) };
  };
  const worklet = (name, content) => compressed
    ? { ...asset(`${name}.gz`, gzipSync(content)), encoding: 'gzip', decodedSha256: sha(content), decodedBytes: content.length }
    : asset(name, content);
  const release = { releaseId: 'full-1', profile: 'full',
    engineJs: asset('godot.js', raw('/* engine */')), engineWasm: asset('godot.wasm', new Uint8Array([0, 97, 115, 109])),
    worklets: [worklet('godot.audio.worklet.js', audio), worklet('godot.audio.position.worklet.js', position)],
    allowedOrigins: ['https://preview.test'] };
  const network = t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input); requests.push(url);
    assert(bytes.has(url), `Unexpected network request: ${url}`);
    return new Response(bytes.get(url));
  }).mock;
  t.mock.method(URL, 'createObjectURL', blob => {
    const url = `blob:verified-${blobs.size}`; blobs.set(url, blob); return url;
  });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  class Engine {
    constructor() {
      this.config = { getModuleConfig(loadPath) {
        assert.equal(this, instanceConfig);
        return { preserved: true, locateFile(path) { return `${loadPath}/${path}`; } };
      } };
      const instanceConfig = this.config;
    }
    static load(basePath) {
      const response = fetch(`${basePath}.wasm`);
      return response.then(async result => {
        assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes.get(release.engineWasm.url));
        if (wasmGate) await wasmGate.promise;
      });
    }
  }
  const document = { defaultView: { Engine }, createElement() {
    const script = { removed: false, remove() { this.removed = true; } }; scripts.push(script); return script;
  }, head: { append } };
  return { release, bytes, blobs, revoked, scripts, requests, document, Engine, network };
}

test('worklets execute verified bytes through per-instance locateFile and survive until session disposal', async t => {
  const f = fixture(t, { compressed: true });
  const networkFetch = globalThis.fetch;
  const loaded = await loadVerifiedEngine(f.release, { document: f.document });
  assert.equal(globalThis.fetch, networkFetch, 'WASM adapter restores fetch synchronously');
  const engine = new loaded.Engine({}), untouched = new loaded.Engine({});
  const original = engine.config.getModuleConfig;
  loaded.installWorklets(engine);
  const installed = engine.config.getModuleConfig;
  loaded.installWorklets(engine);
  assert.equal(engine.config.getModuleConfig, installed, 'installation is idempotent');
  const module = engine.config.getModuleConfig('https://virtual.test/godot');
  assert.equal(module.preserved, true);
  for (const [name, expected] of [['audio.worklet.js', audio], ['audio.position.worklet.js', position]]) {
    const url = module.locateFile(`godot.${name}`);
    assert.match(url, /^blob:/);
    assert.deepEqual(new Uint8Array(await f.blobs.get(url).arrayBuffer()), expected);
  }
  assert.equal(module.locateFile('godot.side.wasm'), 'https://virtual.test/godot/godot.side.wasm');
  assert.equal(untouched.config.getModuleConfig('original').locateFile('godot.audio.worklet.js'), 'original/godot.audio.worklet.js');
  assert.equal(f.requests.length, 4, 'there is exactly one download per declared asset');
  assert.equal(f.revoked.length, 0, 'worklets may be loaded after init');
  loaded.dispose(); loaded.dispose();
  assert.equal(engine.config.getModuleConfig, original);
  assert.equal(new Set(f.revoked).size, 3);
  assert.equal(f.revoked.length, 3);
  assert.throws(() => module.locateFile('godot.audio.worklet.js'), /E_ENGINE_DISPOSED/);
  assert.throws(() => loaded.installWorklets(engine), /E_ENGINE_DISPOSED/);
  assert(f.scripts[0].removed);
});

test('a changed worklet digest prevents any engine script from executing', async t => {
  const f = fixture(t);
  f.bytes.set(f.release.worklets[0].url, raw('unverified replacement'));
  await assert.rejects(loadVerifiedEngine(f.release, { document: f.document }), /E_ASSET_HASH/);
  assert.equal(f.scripts.length, 0);
  assert.equal(f.blobs.size, 0);
});

test('compressed worklets require both the transport and decoded integrity digest', async t => {
  const f = fixture(t, { compressed: true });
  f.release.worklets[0].decodedSha256 = '0'.repeat(64);
  await assert.rejects(loadVerifiedEngine(f.release, { document: f.document }), /E_ASSET_DECODED_HASH/);
  assert.equal(f.scripts.length, 0);
});

test('worklet declarations share origin policy and reject ambiguous or unsupported names', async t => {
  const f = fixture(t);
  const release = { ...f.release, worklets: [{ ...f.release.worklets[0], url: 'https://other.test/godot.audio.worklet.js' }] };
  assert.throws(() => validateRelease(release), /E_RELEASE_ORIGIN/);
  assert.throws(() => validateRelease({ ...f.release, worklets: [f.release.worklets[0], f.release.worklets[0]] }), /E_RELEASE_WORKLET_DUPLICATE/);
  assert.throws(() => validateRelease({ ...f.release, worklets: [{ ...f.release.worklets[0], name: '../godot.audio.worklet.js' }] }), /E_RELEASE_WORKLET_NAME/);
  assert.throws(() => validateRelease({ ...f.release, worklets: [{ ...f.release.worklets[0], name: 'unknown.js' }] }), /E_RELEASE_WORKLET_NAME/);
});

test('legacy releases without worklets keep their original configuration', async t => {
  const f = fixture(t); delete f.release.worklets;
  const loaded = await loadVerifiedEngine(f.release, { document: f.document });
  loaded.installWorklets({});
  assert.equal(f.requests.length, 2);
  loaded.dispose();
});

test('unsupported instance hooks and undeclared worklets fail closed', async t => {
  const f = fixture(t); f.release.worklets.pop();
  const loaded = await loadVerifiedEngine(f.release, { document: f.document });
  assert.throws(() => loaded.installWorklets({}), /E_ENGINE_WORKLET_API/);
  const engine = new loaded.Engine({}); loaded.installWorklets(engine);
  assert.throws(() => engine.config.getModuleConfig('virtual').locateFile('godot.audio.position.worklet.js'), /E_ENGINE_WORKLET_MISSING/);
  loaded.dispose();
});

test('cancelling script load revokes every URL and ignores a late load callback', async t => {
  const appended = deferred();
  const f = fixture(t, { append(script) { appended.resolve(script.onload); } });
  const controller = new AbortController();
  const pending = loadVerifiedEngine(f.release, { document: f.document, signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel script/);
  const lateLoad = await appended.promise;
  controller.abort(new Error('cancel script'));
  lateLoad();
  await rejected;
  assert.equal(f.revoked.length, 3);
  assert(f.scripts[0].removed);
  assert.equal(f.scripts[0].onload, null);
});

test('cancelling during WASM initialization cleans URLs before a late loader resolution', async t => {
  const gate = deferred(), f = fixture(t, { wasmGate: gate });
  const controller = new AbortController();
  const pending = loadVerifiedEngine(f.release, { document: f.document, signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel wasm/);
  while (!f.scripts.length || f.scripts[0].onload) await flush();
  await flush();
  controller.abort(new Error('cancel wasm'));
  assert.equal(f.revoked.length, 3);
  gate.resolve(); await rejected;
  assert.equal(f.revoked.length, 3);
});

test('post-load cancellation restores instance hooks and disposes worklets exactly once', async t => {
  const f = fixture(t), controller = new AbortController();
  const loaded = await loadVerifiedEngine(f.release, { document: f.document, signal: controller.signal });
  const engine = new loaded.Engine({}), original = engine.config.getModuleConfig;
  loaded.installWorklets(engine);
  controller.abort(); loaded.dispose();
  assert.equal(engine.config.getModuleConfig, original);
  assert.equal(f.revoked.length, 3);
});

const sdkConfig = `${process.env.GODOT_SDK_ROOT ?? '/workspace/.godotai-sdk/godot-4.6.1'}/platform/web/js/engine/config.js`;
test('adapter matches the actual unmodified Godot 4.6.1 Config factory', { skip: !existsSync(sdkConfig) }, async t => {
  const f = fixture(t);
  const Config = vm.runInNewContext(`${readFileSync(sdkConfig, 'utf8')}\nInternalConfig;`, { console, WebAssembly });
  const config = new Config({ executable: 'godot' }), original = config.getModuleConfig;
  const loaded = await loadVerifiedEngine(f.release, { document: f.document });
  loaded.installWorklets({ config });
  const module = config.getModuleConfig('/verified/godot', new Response());
  assert.match(module.locateFile('godot.audio.worklet.js'), /^blob:/);
  assert.match(module.locateFile('godot.audio.position.worklet.js'), /^blob:/);
  assert.equal(module.locateFile('godot.wasm'), '/verified/godot.wasm');
  assert.equal(module.locateFile('extension.wasm'), 'extension.wasm');
  loaded.dispose();
  assert.equal(config.getModuleConfig, original);
  assert.equal(Object.hasOwn(config, 'getModuleConfig'), false, 'prototype method is restored without an own shadow');
});
