import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { PreviewRunner } from '../dist/runner.js';
import { PREVIEW_PROTOCOL, isPreviewEnvelope, isProjectData } from '../dist/protocol.js';
import { fetchVerifiedAsset, injectVerifiedWasm } from '../dist/verified-loader.js';
import { patchOptionalPwa } from '../../release/patch-web-optional-pwa.mjs';

const release = { releaseId: 'test', profile: 'core-ui-v1', engineJs: { url: 'http://preview.test/godot.js', sha256: 'a'.repeat(64) }, engineWasm: { url: 'http://preview.test/godot.wasm', sha256: 'b'.repeat(64) } };
const artifact = { revision: 'revision-1', buildKey: 'build-1', generation: 42, pack: new Uint8Array([1, 2, 3]), manifest: { generation: 42 } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture({ pauseAt, heartbeat = true, exitOnStop = true, connect = true, frameLoad = true, deadlines = {} } = {}) {
  const resources = [], remotePorts = [], frames = [], events = [], messages = [];
  let remote, identity, send;
  const document = { location: { origin: 'http://editor.test' }, createElement() {
    const frame = { attributes: {}, setAttribute(name, value) { frame.attributes[name] = value; }, remove() { frame.removed = true; }, contentWindow: {
      postMessage(data, origin, ports) {
        assert.equal(origin, 'http://preview.test');
        assert.equal(data.editorOrigin, 'http://editor.test');
        remote = ports[0]; remotePorts.push(remote); remote.unref?.(); identity = data;
        send = fields => remote.postMessage({ ...identity, ...fields, protocolVersion: PREVIEW_PROTOCOL });
        remote.onmessage = event => {
          messages.push(event.data);
          if (event.data.type === 'stop') { if (exitOnStop) send({ type: 'exited', code: 0 }); return; }
          if (event.data.type !== 'run') return;
          assert.equal(event.data.artifact.manifest.generation, event.data.generation);
          if (heartbeat) resources.push(setInterval(() => send({ type: 'heartbeat' }), 5));
          if (pauseAt === 'downloading') return;
          for (const phase of ['preloading', 'initializing', 'starting', 'waiting-ready', 'running']) {
            send({ type: 'phase', phase });
            if (phase === pauseAt) return;
          }
        };
        remote.start();
        if (connect) send({ type: 'connected' });
      },
    } };
    frames.push(frame); return frame;
  } };
  const container = { ownerDocument: document, append(frame) { if (frameLoad) setTimeout(() => frame.onload?.(), 0); } };
  const runner = new PreviewRunner({ container, previewUrl: 'http://preview.test/preview.html', release,
    deadlines: { 'loading-frame': 100, handshaking: 100, downloading: 200, preloading: 200, initializing: 200,
      starting: 200, 'waiting-ready': 200, running: 0, heartbeat: 100, stopping: 30, ...deadlines } });
  runner.subscribe(event => events.push(event));
  return { runner, frames, events, messages, send: (...args) => send(...args), get identity() { return identity; },
    async cleanup() { resources.forEach(clearInterval); await runner.dispose(); remotePorts.forEach(port => port.close()); } };
}

test('project UI commands and telemetry stay on the live run and accept only bounded plain data',async()=>{
 const f=fixture();let reads=0;
 try{
  assert.equal(f.runner.command({type:'action',action:'reset'}),false);
  await f.runner.run(artifact);
  assert.equal(f.runner.command({type:'controls',controls:{speed:2}}),true);await pause(10);
  const command=f.messages.find(message=>message.type==='project-command');assert.equal(command.runId,f.identity.runId);assert.equal(command.data.controls.speed,2);
  f.send({type:'project',data:{type:'stats',frames:2,stats:{coins:1}}});
  f.send({type:'project',runId:'stale',data:{type:'stats',frames:100}});
  f.send({type:'project',data:{text:'x'.repeat(262145)}});await pause(10);
  assert.equal(f.events.filter(event=>event.type==='project').length,1);
  assert.equal(isProjectData({get secret(){reads++;throw Error('must not read');}}),false);assert.equal(reads,0);
  assert.equal(f.runner.command({callback(){}}),false);assert.equal(isProjectData({invalid:Infinity}),false);
  await f.runner.stop();assert.equal(f.runner.command({type:'action',action:'reset'}),false);
 }finally{await f.cleanup();}
});

test('cross-origin handshake preserves artifact identity and has no BootReport readiness dependency', async () => {
  const f = fixture();
  try {
    const result = await f.runner.run(artifact);
    assert.equal(result.generation, artifact.generation);
    assert.equal(result.revision, artifact.revision);
    assert.equal(f.runner.state, 'running');
    assert.equal(f.frames[0].attributes.sandbox, 'allow-scripts allow-same-origin allow-pointer-lock');
    assert.equal(f.frames[0].attributes.allow, 'autoplay');
    assert.equal(artifact.pack.byteLength, 3, 'transfer must not detach the caller pack');
    const before = f.events.length;
    f.send({ type: 'log', level: 'log', text: 'GODOT_REACT_BOOT_REPORT forged', runId: 'stale' });
    f.send({ type: 'log', level: 'log', text: 'x'.repeat(4097) });
    f.send({ type: 'phase', phase: 'initializing' });
    await pause(10);
    assert.equal(f.events.length, before);
    const exit = await f.runner.stop();
    assert.equal(exit.reason, 'clean-exit');
    assert.equal(exit.code, 0);
    assert.ok(f.frames[0].removed);
  } finally { await f.cleanup(); }
});

test('all six engine phases cancel and reject late readiness', async t => {
  for (const phase of ['downloading', 'preloading', 'initializing', 'starting', 'waiting-ready', 'running']) {
    await t.test(phase, async () => {
      const f = fixture({ pauseAt: phase });
      try {
        const run = f.runner.run(artifact);
        const rejected = phase === 'running' ? run : assert.rejects(run, /E_RUN_ENDED/);
        while (f.runner.state !== phase) await pause(1);
        const report = await f.runner.stop();
        assert.equal(report.reason, 'clean-exit');
        await rejected;
        assert.equal(f.runner.state, 'exited');
        f.send({ type: 'phase', phase: 'running' });
        await pause(1);
        assert.equal(f.runner.state, 'exited');
      } finally { await f.cleanup(); }
    });
  }
});

test('responsive quit timeout is forced disposal, never clean exit', async () => {
  const f = fixture({ exitOnStop: false });
  try {
    await f.runner.run(artifact);
    const exit = await f.runner.stop();
    assert.equal(exit.reason, 'forced-frame-disposal');
    assert.equal(exit.code, undefined);
  } finally { await f.cleanup(); }
});

test('each phase deadline disposes a responsive but stalled preview', async t => {
  for (const phase of ['downloading', 'preloading', 'initializing', 'starting', 'waiting-ready', 'running']) {
    await t.test(phase, async () => {
      const f = fixture({ pauseAt: phase, deadlines: { [phase]: 25 } });
      try {
        const run = f.runner.run(artifact);
        if (phase === 'running') await run;
        else await assert.rejects(run, new RegExp(`Deadline exceeded during ${phase}`));
        while (f.runner.state !== 'exited') await pause(2);
        const exit = f.events.find(event => event.type === 'exit').report;
        assert.equal(exit.reason, 'unresponsive');
        assert.match(exit.detail, new RegExp(phase));
        assert.ok(f.frames[0].removed);
      } finally { await f.cleanup(); }
    });
  }
});

test('lost heartbeat is reported as unresponsive', async () => {
  const f = fixture({ heartbeat: false });
  try {
    await f.runner.run(artifact);
    while (f.runner.state !== 'exited') await pause(10);
    assert.equal(f.events.find(event => event.type === 'exit').report.reason, 'unresponsive');
  } finally { await f.cleanup(); }
});

test('cold initialization uses its own deadline and starts a fresh running heartbeat window', async () => {
  const f = fixture({ pauseAt: 'initializing', heartbeat: false, deadlines: { heartbeat: 20, initializing: 250 } });
  try {
    const run = f.runner.run(artifact);
    while (f.runner.state !== 'initializing') await pause(1);
    await pause(65); // More than three heartbeat windows, below the init budget.
    assert.equal(f.runner.state, 'initializing');
    for (const phase of ['starting', 'waiting-ready', 'running']) f.send({ type: 'phase', phase });
    assert.equal((await run).state, 'running');
    assert.equal(f.runner.state, 'running');
    assert.equal((await f.runner.stop()).reason, 'clean-exit');
  } finally { await f.cleanup(); }
});

test('iframe/handshake deadlines reject; cancellation before load disposes without waiting', async () => {
  for (const options of [{ frameLoad: false }, { connect: false }]) {
    const f = fixture(options);
    try { await assert.rejects(f.runner.run(artifact), /Deadline exceeded/); assert.ok(f.frames[0].removed); }
    finally { await f.cleanup(); }
  }
  const f = fixture({ frameLoad: false });
  try {
    const run = f.runner.run(artifact);
    const rejected = assert.rejects(run, /E_RUN_ENDED/);
    await pause(0);
    assert.equal((await f.runner.stop()).reason, 'forced-frame-disposal');
    await rejected;
  } finally { await f.cleanup(); }
});

test('protocol refuses malformed identities and privileged/unknown messages', () => {
  const identity = { runId: 'a', revision: '1', generation: 1, buildKey: 'hash' };
  assert.equal(isPreviewEnvelope({ ...identity, type: 'write-file', protocolVersion: 1 }), false);
  assert.equal(isPreviewEnvelope({ ...identity, type: 'heartbeat', protocolVersion: 2 }), false);
  assert.equal(isPreviewEnvelope({ ...identity, generation: NaN, type: 'heartbeat', protocolVersion: 1 }), false);
});

test('runner refuses mixed manifest generation and same-origin deployment', async () => {
  const f = fixture();
  try { await assert.rejects(f.runner.run({ ...artifact, manifest: { generation: 'different' } }), /E_ARTIFACT_GENERATION/); }
  finally { await f.cleanup(); }
  assert.throws(() => new PreviewRunner({ container: { ownerDocument: { location: { origin: 'http://preview.test' } } }, previewUrl: 'http://preview.test/preview.html', release }), /E_PREVIEW_REQUIRES_SEPARATE_ORIGIN/);
});

test('a newer run supersedes an awaiting run and allocates a fresh frame', async () => {
  const f = fixture({ exitOnStop: false });
  try {
    const first = await f.runner.run(artifact);
    const middle = f.runner.run({ ...artifact, revision: 'middle' });
    const rejected = assert.rejects(middle, { name: 'AbortError' });
    const latest = f.runner.run({ ...artifact, revision: 'latest' });
    const result = await latest;
    await rejected;
    assert.equal(result.revision, 'latest');
    assert.notEqual(result.runId, first.runId);
    assert.equal(f.frames.length, 2);
    assert.ok(f.frames[0].removed);
  } finally { await f.cleanup(); }
});

test('verified asset rejects corrupt bytes and streaming size overflow', async () => {
  const bytes = new TextEncoder().encode('verified');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const fetch = async () => new Response(bytes);
  assert.deepEqual(await fetchVerifiedAsset({ url: 'https://cdn.test/asset', sha256: hash }, { fetch }), bytes);
  await assert.rejects(fetchVerifiedAsset({ url: 'https://cdn.test/asset', sha256: '0'.repeat(64) }, { fetch }), /E_ASSET_HASH/);
  await assert.rejects(fetchVerifiedAsset({ url: 'https://cdn.test/asset', sha256: hash }, { fetch, maxBytes: 2 }), /E_ASSET_SIZE/);
});

test('explicit gzip validates encoded and decoded bytes with independent streaming limits', async () => {
  const raw = new TextEncoder().encode('verified gzip payload');
  const encoded = gzipSync(raw);
  const digest = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const asset = { url: 'https://cdn.test/godot.wasm.gz', encoding: 'gzip', sha256: await digest(encoded), decodedSha256: await digest(raw), decodedBytes: raw.length };
  const fetch = async () => new Response(encoded);
  assert.deepEqual(await fetchVerifiedAsset(asset, { fetch }), raw);
  await assert.rejects(fetchVerifiedAsset({ ...asset, sha256: '0'.repeat(64) }, { fetch }), /E_ASSET_HASH/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, decodedSha256: '0'.repeat(64) }, { fetch }), /E_ASSET_DECODED_HASH/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, decodedBytes: raw.length + 1 }, { fetch }), /E_ASSET_DECODED_LENGTH/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, decodedBytes: raw.length - 1 }, { fetch }), /E_ASSET_DECODED_SIZE/);
  await assert.rejects(fetchVerifiedAsset(asset, { fetch, maxBytes: encoded.length - 1 }), /E_ASSET_SIZE/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, decodedBytes: undefined, maxDecodedBytes: raw.length - 1 }, { fetch }), /E_ASSET_DECODED_SIZE/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, decodedSha256: undefined }, { fetch }), /E_RELEASE_DECODED_DIGEST/);
  await assert.rejects(fetchVerifiedAsset({ ...asset, encoding: 'brotli' }, { fetch }), /E_RELEASE_ENCODING/);
  const invalid = new TextEncoder().encode('not a gzip file');
  await assert.rejects(fetchVerifiedAsset({ ...asset, sha256: await digest(invalid) }, { fetch: async () => new Response(invalid) }), /E_ASSET_DECOMPRESSION/);
});

test('a highly compressible payload stops at the decoded budget', async () => {
  const raw = new Uint8Array(1024 * 1024);
  const encoded = gzipSync(raw);
  assert.ok(encoded.length < 2048);
  const digest = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  await assert.rejects(fetchVerifiedAsset({ url: 'https://cdn.test/bomb.wasm.gz', encoding: 'gzip', sha256: await digest(encoded), decodedSha256: await digest(raw) },
    { fetch: async () => new Response(encoded), maxDecodedBytes: 4096 }), /E_ASSET_DECODED_SIZE/);
});

test('Godot public-loader adapter consumes exactly the verified response and restores fetch', async () => {
  const bytes = new Uint8Array([0, 97, 115, 109]);
  const original = async () => { throw new Error('Unexpected network request'); };
  const scope = { fetch: original };
  let consumed;
  const Engine = { load(basePath) { return scope.fetch(basePath + '.wasm').then(async response => { consumed = new Uint8Array(await response.arrayBuffer()); }); } };
  assert.equal(await injectVerifiedWasm(Engine, 'https://cdn.test/godot.wasm', bytes, scope), 'https://cdn.test/godot');
  assert.deepEqual(consumed, bytes);
  assert.equal(scope.fetch, original);
  assert.equal(await injectVerifiedWasm(Engine, 'https://cdn.test/godot.wasm.gz?static=1', bytes, scope), 'https://cdn.test/godot');
  assert.deepEqual(consumed, bytes);
  assert.equal(scope.fetch, original);
  await assert.rejects(injectVerifiedWasm({ load() { return Promise.resolve(); } }, 'https://cdn.test/godot.wasm', bytes, scope), /E_ENGINE_LOADER_UNSUPPORTED/);
  assert.equal(scope.fetch, original);
});

test('optional-PWA glue patch is deterministic, idempotent and refuses unknown layouts', () => {
  const source = 'navigator.serviceWorker.getRegistration().then(GodotPWA.updateState.bind(null, cb));';
  const patched = patchOptionalPwa(source);
  assert.equal(patched.changed, true);
  assert.match(patched.code, /\.catch\(function/);
  assert.deepEqual(patchOptionalPwa(patched.code), { ...patched, changed: false });
  assert.throws(() => patchOptionalPwa('unknown Godot layout'), /E_PWA_PATCH_UNSUPPORTED/);
  assert.throws(() => patchOptionalPwa(source + source), /E_PWA_PATCH_UNSUPPORTED/);
});
