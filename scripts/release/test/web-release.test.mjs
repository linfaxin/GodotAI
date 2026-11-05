import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildRelease } from '../build-web-release.mjs';
import { verifyRelease } from '../verify-web-release.mjs';
import { publishRelease, verifyCDN } from '../publish-web-release.mjs';
import { pinRelease } from '../pin-web-release.mjs';
import { collectBrowserEvidence } from '../collect-browser-evidence.mjs';
import { buildBrowserEngine, snapshotBrowserSources } from '../../test/build-browser-engine.mjs';
import { canonical, digest, inspectRelease, json, writeJson, identity, hashSiteRuntimeFiles } from '../web-release-utils.mjs';

async function fixture(t, certifiedSource = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'web-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(path, contents) { const target = resolve(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents); return target; }
  const engine = resolve(root, 'engine'); await mkdir(engine);
  await file('engine/godot.js', '/* fixture engine, already-patched audio: godotjs-audio-lifecycle-v1 */ navigator.serviceWorker.getRegistration().then(GodotPWA.updateState.bind(null, cb));');
  for (const name of ['godot.audio.worklet.js', 'godot.audio.position.worklet.js']) await file(`engine/${name}`, '/* fixture engine */');
  await file('engine/godot.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const archive = resolve(root, 'engine.zip');
  const zipped = spawnSync('zip', ['-q', archive, 'godot.js', 'godot.wasm', 'godot.audio.worklet.js', 'godot.audio.position.worklet.js'], { cwd: engine });
  assert.equal(zipped.status, 0, 'zip is available');
  const source = { commit: 'a'.repeat(40), inputs: { 'source.cpp': digest('fixture source') } }; source.snapshotHash = digest(canonical(source.inputs));
  const recipe = { command: 'scons', args: ['threads=no', 'dlink_enabled=no', 'platform=web', 'use_quickjs_ng=no'] };
  const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', status: certifiedSource ? 'built' : 'existing-development', source, godotSource: source, recipe, recipeSha256: digest(canonical(recipe)), builder: { sha256: digest('fixture builder') }, toolchains: { emscripten: 'fixture only' }, versionEvidence: { sha256: digest('fixture header') }, godotVersion: '4.6.1.fixture', engineTarget: 'template_debug', template: { path: archive, sha256: digest(await readFile(archive)) } };
  await writeJson(resolve(root, 'engine-report.json'), report);
  const config = {
    sdk: { development: await file('sdk-development.js', 'exports.sdk="development";'), production: await file('sdk-production.js', 'exports.sdk="production";') },
    types: resolve(root, 'types'), contracts: await file('contracts.mjs', 'export const fixture=true;'), bootstrap: await file('bootstrap.json', '{}'),
    compiler: { js: await file('esbuild.js', '/* compiler fixture */'), wasm: await file('esbuild.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), typescript: await file('typescript.js', 'var ts={version:"fixture"};') },
    metadata: { runtimeAbi: 'godot-react/1', nativeBridgeAbi: 'godot-react-native/1', react: { react: '19.3.1', reconciler: '0.34.0', scheduler: '0.28.0' }, profiles: [{ id: 'core-ui-v1', version: 1, hash: digest('fixture profile') }], specifiers: { react: 'res://vendor/react.js' } },
  };
  await file('types/node_modules/@godot-js/react/dist/index.d.ts', 'export declare const fixture:true;');
  await writeJson(resolve(root, 'assets.json'), config);
  return { root, config, report, dir: resolve(root, 'release'), configuration: { 'engine-report': resolve(root, 'engine-report.json'), assets: resolve(root, 'assets.json'), out: resolve(root, 'release'), development: !certifiedSource } };
}

test('existing template stays development and cannot become certified by a flag', async t => {
  const f = await fixture(t);
  const recorded = resolve(f.root, 'recorded.json');
  await buildBrowserEngine({ 'existing-template': f.report.template.path, out: recorded, development: true, 'godot-version': '4.6.1', target: 'template_debug' });
  const result = await buildRelease({ ...f.configuration, 'engine-report': recorded });
  assert.equal(result.sourceCertified, false); assert.equal(result.certified, false);
  assert.equal((await inspectRelease(f.dir)).engine.target, 'template_debug');
  await assert.rejects(buildRelease({ ...f.configuration, development: false }), /E_RELEASE_SOURCE/);
  await assert.rejects(buildBrowserEngine({ 'existing-template': f.report.template.path, out: recorded }), /E_BROWSER_UNCERTIFIED/);
});

test('native source snapshot includes SCsub preset bundles while excluding unrelated generated outputs', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'browser-source-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/out'), { recursive: true });
  await mkdir(resolve(root, 'scripts/jsb.react/dist'), { recursive: true });
  for (const name of ['jsb.runtime.bundle.js', 'jsb.editor.bundle.js', 'jsb.runtime.bundle.d.ts', 'jsb.runtime.bundle.js.map', 'jsb.editor.bundle.d.ts', 'jsb.editor.bundle.js.map']) await writeFile(resolve(root, 'scripts/out', name), `actual preset ${name}`);
  await writeFile(resolve(root, 'scripts/out/unrelated.log'), 'not a native input');
  await writeFile(resolve(root, 'scripts/jsb.react/dist/index.js'), 'not embedded by SCsub');
  const snapshot = await snapshotBrowserSources(root, { module: true });
  assert.equal(Object.keys(snapshot.inputs).length, 6);
  assert(snapshot.inputs['scripts/out/jsb.runtime.bundle.js']);
  assert(snapshot.inputs['scripts/out/jsb.editor.bundle.js.map']);
  assert.equal(snapshot.snapshotHash, digest(canonical(snapshot.inputs)));
});

test('Godot snapshot preserves required misc/dist and nested directories with output-like names', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'godot-source-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['misc/dist/html/full-size.html', 'thirdparty/tool/bin/source.py', 'thirdparty/tool/out/schema.h', 'bin/build.wasm']) {
    await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), 'source fixture');
  }
  const snapshot = await snapshotBrowserSources(root);
  assert(snapshot.inputs['misc/dist/html/full-size.html']);
  assert(snapshot.inputs['thirdparty/tool/bin/source.py']);
  assert(snapshot.inputs['thirdparty/tool/out/schema.h']);
  assert.equal(snapshot.inputs['bin/build.wasm'], undefined);
});

test('release seals all bytes, maps declarations and emits an importable TypeScript module', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  assert.equal(release.id, release.runtimeRelease);
  assert.equal(release.typesRoot, '/node_modules/@types');
  assert.equal(release.jsGluePatches[0].changed, true);
  assert.equal(release.files.find(file => file.kind === 'engine-wasm').encoding, 'gzip');
  assert.equal(release.files.find(file => file.kind === 'engine-wasm').decodedBytes, 8);
  assert(release.files.some(file => file.virtualPath === '/node_modules/@godot-js/react/dist/index.d.ts'));
  for (const file of release.files.filter(file => file.kind === 'type')) {
    assert.match(file.path, /^types\/[a-f0-9]{64}\.txt$/, 'Declaration URLs must survive static-host dependency/source filters');
    assert(!file.path.includes('node_modules'));
    assert.equal(await readFile(resolve(f.dir, file.path), 'utf8'), 'export declare const fixture:true;');
  }
  const typescript = await import(pathToFileURL(resolve(f.dir, release.typescriptUrl)));
  assert.equal(typescript.default.version, 'fixture');
  const original = release.id; await buildRelease(f.configuration);
  assert.equal((await inspectRelease(f.dir)).id, original, 'same immutable inputs have same release identity');
  await writeFile(resolve(f.dir, 'assets/godot.js'), 'changed');
  await assert.rejects(inspectRelease(f.dir), /E_RELEASE_INTEGRITY/);
});

test('descriptor and recipe tampering are rejected', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const release = await json(resolve(f.dir, 'release.json')); release.engine.threads = true;
  await writeJson(resolve(f.dir, 'release.json'), release);
  await assert.rejects(inspectRelease(f.dir), /E_RELEASE_IDENTITY/);
});

test('encoded WASM verifies decoded bytes and raw mode is development-only', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const path = resolve(f.dir, 'release.json'), release = await json(path);
  release.files.find(file => file.kind === 'engine-wasm').decodedSha256 = digest('different decoded WASM');
  release.id = release.runtimeRelease = identity(release);
  await writeJson(path, release);
  await assert.rejects(inspectRelease(f.dir), /Decoded WASM bytes differ/);
  await buildRelease({ ...f.configuration, 'raw-wasm': true });
  assert.equal((await inspectRelease(f.dir)).files.find(file => file.kind === 'engine-wasm').path, 'assets/godot.wasm');
  const formal = await fixture(t, true);
  await assert.rejects(buildRelease({ ...formal.configuration, 'raw-wasm': true }), /E_RELEASE_ENCODING/);
});

test('browser certification binds every candidate asset and cannot certify an old template', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  assert.equal(release.sourceCertified, true); assert.equal(release.certified, false);
  assert.equal(release.target.sourceCommit, f.report.source.commit);
  const evidence = { status: 'passed', runtimeRelease: release.id, checks: [{ name: 'fixture-only-no-real-browser-claim', status: 'passed' }], artifactHashes: Object.fromEntries(release.files.filter(file => file.kind !== 'attestation').map(file => [file.path, file.sha256])) };
  const path = resolve(f.root, 'validation.json'); await writeJson(path, evidence);
  await buildRelease({ ...f.configuration, 'validation-report': path });
  assert.equal((await inspectRelease(f.dir, { requireCertified: true })).id, release.id, 'certification binds the existing candidate identity');
  delete evidence.artifactHashes[release.files.find(file => file.kind === 'engine-wasm').path]; await writeJson(path, evidence);
  await assert.rejects(buildRelease({ ...f.configuration, 'validation-report': path }), /E_RELEASE_VALIDATION/);
});

test('unchanged file hashes cannot certify changed profile or target metadata', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  const validation = { status: 'passed', runtimeRelease: release.id, checks: [{ name: 'fixture-only', status: 'passed' }], artifactHashes: Object.fromEntries(release.files.filter(file => file.kind !== 'attestation').map(file => [file.path, file.sha256])) };
  const validationPath = resolve(f.root, 'validation.json'); await writeJson(validationPath, validation);
  f.config.metadata.profiles[0].hash = digest('changed profile metadata with same artifact files');
  await writeJson(f.configuration.assets, f.config);
  await assert.rejects(buildRelease({ ...f.configuration, 'validation-report': validationPath }), /exact runtimeRelease/);
});

test('npm pack is installed and verified in a real external consumer', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const result = await verifyRelease({ dir: f.dir, 'pack-out': resolve(f.root, 'packs') });
  assert.equal(result.status, 'verified'); assert.equal(result.externalConsumer, true);
  assert.equal(result.cdnVerified, false); assert.equal(result.certified, false);
  assert((await readFile(result.tarball)).length > 0);
});

test('CDN verification detects changed bytes and changed descriptor', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const descriptor = await inspectRelease(f.dir);
  let tamper;
  const fetcher = async url => {
    const path = decodeURIComponent(url.pathname).replace('/candidate/', '');
    let bytes = await readFile(resolve(f.dir, path));
    if (tamper === path) bytes = Buffer.from('changed');
    return new Response(bytes);
  };
  assert.equal(await verifyCDN({ baseUrl: 'https://cdn.invalid/candidate/', descriptor, fetcher }), true);
  tamper = descriptor.files.find(file => file.kind === 'engine-wasm').path; await assert.rejects(verifyCDN({ baseUrl: 'https://cdn.invalid/candidate/', descriptor, fetcher }), /E_RELEASE_CDN/);
});

test('uncertified publish refuses before accessing registry and writes a truthful report', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const path = resolve(f.root, 'publish.json');
  await assert.rejects(publishRelease({ dir: f.dir, report: path, registry: 'https://do-not-contact.invalid/' }), /E_RELEASE_UNCERTIFIED/);
  const report = await json(path); assert.equal(report.status, 'failed'); assert.equal(report.phase, 'prepare'); assert.equal(report.published, false); assert.equal(report.cdnVerified, false);
});

test('static application pins the full final descriptor including evidence', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const site = resolve(f.root, 'site');
  await writeJson(resolve(site, 'app-config.json'), { previewUrl: 'https://preview.invalid/preview.html' });
  const result = await pinRelease({ site, release: f.dir });
  const config = await json(resolve(site, 'app-config.json'));
  assert.equal(config.expectedReleaseId, (await inspectRelease(f.dir)).id);
  assert.equal(config.expectedDescriptorSha256, digest(await readFile(resolve(f.dir, 'release.json'))));
  assert.equal(result.descriptorSha256, config.expectedDescriptorSha256);
  assert.equal(config.previewUrl, 'https://preview.invalid/preview.html');
});

test('aggregate evidence binds exact release, real file bytes, static templates and engine-map provenance', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir), site = resolve(f.root, 'site');
  await cp(f.dir, resolve(site, 'release'), { recursive: true });
  for (const name of ['index.html', 'main.js', 'compiler-worker.js', 'types-worker.js', 'preview.html', 'preview.js']) await writeFile(resolve(site, name), `/* fixture ${name} */`);
  const browser = 'unit-fixture-only', checks = [{ name: 'fixture-not-browser-execution', status: 'passed' }];
  const integration = { status: 'passed', runtimeRelease: release.id, browser, checks,
    artifactHashes: Object.fromEntries(await Promise.all(release.files.map(async file => [file.path, digest(await readFile(resolve(f.dir, file.path)))]))),
    siteArtifactHashes: await hashSiteRuntimeFiles(site), generatedArtifacts: { maps: Array.from({ length: 2 }, () => ({ sha256: digest('fixture map'), sealedSha256: digest('fixture map'), version: 3, mappings: true })) } };
  const stress = { status: 'passed', runtimeRelease: release.id, browser, checks,
    siteArtifactHashes: integration.siteArtifactHashes,
    cycles: Array.from({ length: 100 }, (_, index) => ({ runId: `fixture-${index}`, exit: { runId: `fixture-${index}`, reason: 'clean-exit', code: 0 } })),
    failureCycles: Array.from({ length: 20 }, (_, index) => index % 2
      ? { kind: 'cancel-engine-startup', runId: `cancel-${index}`, exit: { runId: `cancel-${index}`, reason: 'forced-frame-disposal' } }
      : { kind: 'semantic-build-refused', activeRunId: `semantic-${index}`, rejected: { accepted: false }, exit: { runId: `semantic-${index}`, reason: 'clean-exit', code: 0 } }) };
  const maps = { status: 'passed', browser, checks: ['caught', 'compressed', 'uncaught'].map(name => ({ name, status: 'passed' })), engine: {
    archiveSha256: f.report.template.sha256, sourceSnapshotHash: f.report.source.snapshotHash, godotSourceSnapshotHash: f.report.godotSource.snapshotHash, recipeSha256: f.report.recipeSha256,
    assets: { 'godot.js': digest(await readFile(resolve(f.root, 'engine/godot.js'))), 'godot.wasm': digest(await readFile(resolve(f.root, 'engine/godot.wasm'))) } } };
  const configuration = { site, 'engine-report': f.configuration['engine-report'], out: resolve(f.root, 'acceptance.json') };
  for (const [name, report] of [['integration', integration], ['stress', stress], ['source-maps', maps]]) { configuration[name] = resolve(f.root, `${name}.json`); await writeJson(configuration[name], report); }
  assert.equal((await collectBrowserEvidence(configuration)).runtimeRelease, release.id);
  const authenticated = { ...integration, checks: ['http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', 'cross-origin-cdn-does-not-receive-site-cookie'].map(name => ({ name, status: 'passed' })) };
  configuration['authenticated-report'] = resolve(f.root, 'authenticated.json'); await writeJson(configuration['authenticated-report'], authenticated);
  assert.equal((await collectBrowserEvidence(configuration)).scope.authenticatedAssets.crossOriginCredentialsOmitted, true);
  authenticated.runtimeRelease = digest('different authenticated release'); await writeJson(configuration['authenticated-report'], authenticated);
  await assert.rejects(collectBrowserEvidence(configuration), /same release and actual browser/);
  authenticated.runtimeRelease = release.id; await writeJson(configuration['authenticated-report'], authenticated);
  stress.runtimeRelease = digest('different release'); await writeJson(configuration.stress, stress);
  await assert.rejects(collectBrowserEvidence(configuration), /exact runtimeRelease/);
  stress.runtimeRelease = release.id; await writeJson(configuration.stress, stress);
  maps.engine.archiveSha256 = digest('different template'); await writeJson(configuration['source-maps'], maps);
  await assert.rejects(collectBrowserEvidence(configuration), /exact built archive/);
  maps.engine.archiveSha256 = f.report.template.sha256; await writeJson(configuration['source-maps'], maps);
  await writeFile(resolve(site, 'preview.js'), 'changed after passing integration');
  await assert.rejects(collectBrowserEvidence(configuration), /templates changed/);
});
