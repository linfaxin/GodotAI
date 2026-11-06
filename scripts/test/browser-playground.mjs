#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveBrowserSite } from './browser-server.mjs';
import { options, digest, within, inspectRelease, canonical, hashSiteRuntimeFiles } from '../release/web-release-utils.mjs';
import { browserDriver } from './browser-launch.mjs';
import { verifyWorkbench } from './browser-workbench.mjs';
import { verifyDemos } from './browser-demos.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = options(process.argv.slice(2), ['--smoke-only', '--authenticated-gate']);
const site = resolve(args.site ?? resolve(repo, '../work/browser-implementation/site'));
const out = resolve(args.out ?? resolve(repo, '../work/browser-implementation/integration'));
await mkdir(out, { recursive: true });
const driver = await browserDriver();
const gated = !!args['authenticated-gate'];
// A synthetic test-session cookie, never an access bypass for a deployed Site.
const fixtureCookie = { name: 'godot_fixture_session', value: 'owner', httpOnly: true, sameSite: 'Lax', path: '/' };
const authorize = gated ? request => request.headers.cookie?.split(';').some(part => part.trim() === `${fixtureCookie.name}=${fixtureCookie.value}`) === true : undefined;
const server = await serveBrowserSite({ root: site, authorize });
const previewServer = await serveBrowserSite({ root: site, host: gated ? '127.0.0.1' : 'localhost', authorize,
  ...(gated ? { corsOrigin: server.url, headers: { 'Access-Control-Allow-Credentials': 'true' } } : {}) });
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
const browser = await driver.type.launch(driver.launchOptions);
const context = await browser.newContext({ viewport: { width: 1512, height: 1040 } });
const permittedOrigins = new Set([server.url, previewServer.url]);
const externalRequests = [];
await context.route('**/*', route => { const url = new URL(route.request().url()); if (/^https?:$/.test(url.protocol) && !permittedOrigins.has(url.origin)) { externalRequests.push(url.href); return route.abort(); } return route.continue(); });
const page = await context.newPage();
await context.route('**/app-config.json', async route => { const response = await route.fetch(); const config = await response.json(); return route.fulfill({ response, json: { ...config, previewUrl: previewServer.url + '/preview.html' } }); });
const logs = [], pageErrors = [], requests = [];
page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', error => { pageErrors.push(String(error)); logs.push({ type: 'pageerror', text: error.stack ?? String(error) }); });
context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
page.on('requestfailed', request => logs.push({ type: 'requestfailed', text: request.url() + ': ' + request.failure()?.errorText }));
await page.addInitScript(()=>addEventListener('unhandledrejection',event=>console.error('UNHANDLED_STACK '+(event.reason?.stack??String(event.reason)))));
const report = { status: 'running', browser: browser.version(), browserFamily: driver.name, checks: [], startedAt: new Date().toISOString() };
const pass = (name, details = {}) => report.checks.push({ name, status: 'passed', ...details });
async function siteArtifacts() {
  return hashSiteRuntimeFiles(site);
}
let initialSiteArtifacts, initialRelease;
try {
  initialRelease = await inspectRelease(resolve(site, 'release'));
  initialSiteArtifacts = await siteArtifacts();
  if (gated) {
    assert.equal((await fetch(server.url + '/release/release.json', { method: 'HEAD' })).status, 401);
    assert.equal((await fetch(previewServer.url + '/release/release.json', { method: 'HEAD' })).status, 401);
    await context.addCookies([{ ...fixtureCookie, url: server.url, path: undefined }]);
  }
  await page.goto(server.url);
  await page.waitForFunction(() => window.playground?.ready || window.playground?.errors?.length, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => playground.ready), true, await page.evaluate(() => playground.errors.join('\n')));
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  pass('runtime-release-and-verified-browser-toolchain-load');
  await page.waitForFunction(() => document.getElementById('status').textContent === '运行中', null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => playground.runs.length), 1);
  pass('default-demo-automatically-runs-on-open');
  if (gated) {
    assert.equal(await page.evaluate(name => document.cookie.includes(name), fixtureCookie.name), false, 'Session cookie must be HttpOnly');
    const { build } = createRequire(resolve(repo, 'scripts/jsb.react-build/package.json'))('esbuild');
    const module = await build({ stdin: { contents: `export {loadRuntimeRelease} from ${JSON.stringify(resolve(repo, 'scripts/jsb.react-browser/src/release.ts'))};export {fetchVerifiedAsset} from ${JSON.stringify(resolve(repo, 'scripts/jsb.react-browser/src/verified-loader.ts'))};`, resolveDir: repo }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(module.outputFiles[0].contents).toString('base64');
    const js = initialRelease.files.find(file => file.kind === 'engine-js'), wasm = initialRelease.files.find(file => file.kind === 'engine-wasm');
    const auth = await page.evaluate(async ({ moduleUrl, editor, other, js, wasm }) => {
      const library = await import(moduleUrl);
      const same = await library.loadRuntimeRelease(editor + '/release/release.json');
      const sameJs = await library.fetchVerifiedAsset({ ...js, url: editor + '/release/' + js.path });
      const sameWasm = await library.fetchVerifiedAsset({ ...wasm, url: editor + '/release/' + wasm.path });
      // Cookies ignore ports. Include is the positive control that proves this
      // sibling origin could receive the site cookie, but the real APIs omit it.
      const control = await fetch(other + '/release/release.json?include-control=1', { credentials: 'include' });
      const rejected = [];
      for (const load of [() => library.loadRuntimeRelease(other + '/release/release.json?cross-origin-probe=1'),
        () => library.fetchVerifiedAsset({ ...js, url: other + '/release/' + js.path + '?cross-origin-probe=1' }),
        () => library.fetchVerifiedAsset({ ...wasm, url: other + '/release/' + wasm.path + '?cross-origin-probe=1' })]) {
        try { await load(); rejected.push('unexpected-success'); } catch (error) { rejected.push(String(error)); }
      }
      return { releaseId: same.release.id, jsBytes: sameJs.length, wasmBytes: sameWasm.length, controlStatus: control.status, rejected };
    }, { moduleUrl, editor: server.url, other: previewServer.url, js, wasm });
    assert.equal(auth.releaseId, initialRelease.id); assert.equal(auth.controlStatus, 200);
    assert(auth.jsBytes > 0 && auth.wasmBytes > 0);
    assert.match(auth.rejected[0], /E_RELEASE_HTTP.*401/);
    assert(auth.rejected.slice(1).every(error => /E_ASSET_HTTP.*401/.test(error)));
    const negative = previewServer.requests.filter(request => request.url.includes('cross-origin-probe=1'));
    assert.equal(negative.length, 3); assert(negative.every(request => request.status === 401 && !request.cookiePresent));
    assert(previewServer.requests.some(request => request.url.includes('include-control=1') && request.status === 200 && request.cookiePresent));
    report.authenticationGate = { topology: 'same-site separate-origin: two 127.0.0.1 ports', httpOnly: true, sameSite: 'Lax', editorOrigin: server.url, previewOrigin: previewServer.url, ...auth, probeModuleSha256: digest(module.outputFiles[0].contents) };
    pass('http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', { decodedWasmBytes: auth.wasmBytes });
    pass('cross-origin-cdn-does-not-receive-site-cookie', { rejected: negative.length, credentialsIncludeControl: 200 });
  }
  await page.evaluate(url => playground.setPreviewUrl(url), previewServer.url + '/preview.html');
  // Keep the small counter as the stable compiler/editor regression fixture.
  // The richer default and other demos get their own real interaction checks.
  assert(await page.evaluate(() => '/src/game.ts' in playground.exportProject().files));
  await page.evaluate(() => playground.loadExample('counter'));
  assert.equal(await page.locator('#files [data-path="/package.json"]').count(),0);
  assert.equal(await page.locator('#open-package-json').count(),0);
  assert.equal(await page.evaluate(()=>typeof playground.setDependencies),'undefined');
  pass('fixed-builtins-without-editable-dependency-manifest');
  const checked = await page.evaluate(() => playground.check());
  report.initialTypes = { diagnostics: checked.diagnostics, unresolved: checked.resolution?.typeGraph?.unresolved };
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics, null, 2));
  assert.equal(checked.resolution.builtins.clsx,'2.1.1');assert.equal(checked.resolution.policyId,'builtin-v1');assert.equal(checked.resolution.lock,undefined);
  assert(checked.resolution.runtimeGraph.entries.length > 0);
  pass('multifile-builtins-and-full-types', { resolutionHash: checked.resolution.hash });
  if (!args['smoke-only']) {
    const source=await page.evaluate(()=>playground.exportProject().files['/src/model.ts']);
    await page.evaluate(source=>playground.setFile('/src/model.ts',source+'\nimport { unstable_now } from "scheduler";\nconst __builtinScheduler: number = unstable_now();\n'),source);
    const schedulerTypes=await page.evaluate(()=>playground.check());assert.equal(schedulerTypes.ok,true,JSON.stringify(schedulerTypes.diagnostics));
    await page.evaluate(source=>playground.setFile('/src/model.ts',source),source);
    pass('builtin-scheduler-types-without-network');
  }
  await page.evaluate(() => playground.run());
  await page.waitForFunction(() => playground.events.some(event => event.type === 'log' && event.text.includes('PLAYGROUND_COUNTER') && event.text.includes('"text":"Count: 0"')), null, { timeout: 90000 });
  await page.frameLocator('iframe').locator('canvas').click({ position: { x: 170, y: 45 } });
  await page.waitForFunction(() => playground.events.some(event => event.type === 'log' && event.text.includes('"text":"Count: 1"')), null, { timeout: 15000 });
  const first = await page.evaluate(() => ({ buildKey: playground.lastArtifact.buildKey, generation: playground.lastArtifact.generation, hash: playground.lastArtifact.manifest.sourceSnapshotHash }));
  await page.screenshot({ path: resolve(out, 'playground.png'), fullPage: true });
  pass('real-cross-origin-godot-counter-click', first);
  if (!args['smoke-only']) report.checks.push(...await verifyWorkbench(page,out));
  if (gated) {
    for (const kind of ['engine-js', 'engine-wasm']) {
      const file = initialRelease.files.find(file => file.kind === kind);
      assert(previewServer.requests.some(request => request.url === '/release/' + file.path && request.status === 200 && request.cookiePresent), `${kind} must boot through the authenticated preview origin`);
    }
  }
  const artifactEvidence = await page.evaluate(async () => {
    const artifact = playground.lastArtifact, hashes = {}, maps = [];
    const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    for (const [uri, bytes] of artifact.files) {
      hashes[uri] = await sha(bytes);
      if (uri.endsWith('.map')) {
        const map = JSON.parse(new TextDecoder().decode(bytes));
        maps.push({ uri, sha256: hashes[uri], sealedSha256: artifact.manifest.artifacts[uri]?.sha256, version: map.version, sources: map.sources, mappings: typeof map.mappings === 'string' && map.mappings.length > 0 });
      }
    }
    return { generation: artifact.generation, buildKey: artifact.buildKey, packSha256: await sha(artifact.pack), files: hashes, maps };
  });
  assert(artifactEvidence.maps.length >= 2);
  for (const map of artifactEvidence.maps) { assert.equal(map.sha256, map.sealedSha256); assert.equal(map.version, 3); assert(map.mappings && map.sources.length > 0); }
  assert(artifactEvidence.maps.some(map => map.sources.some(source => source.includes('Counter.tsx'))));
  report.generatedArtifacts = artifactEvidence;
  pass('browser-generated-source-maps-sealed-and-readable', { maps: artifactEvidence.maps });
  if (!args['smoke-only']) {
    const source = await page.evaluate(() => playground.exportProject().files['/src/Counter.tsx']);
    await page.evaluate(source => playground.setFile('/src/Counter.tsx', source.replace('React.useState(0)', 'React.useState(10)')), source);
    await page.evaluate(() => playground.editor.focus());await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => playground.events.some(event => event.type === 'log' && event.text.includes('"text":"Count: 10"')), null, { timeout: 90000 });
    const second = await page.evaluate(() => playground.lastArtifact.buildKey);
    assert.notEqual(second, first.buildKey);
    pass('edit-rebuild-new-generation');
    const before = await page.evaluate(() => playground.exportProject());
    await page.evaluate(() => playground.setFile('/src/model.ts', 'export function caption(count: number): string { return 123; }'));
    const bad = await page.evaluate(() => playground.check());
    assert.equal(bad.ok, false); assert(bad.diagnostics.some(item => item.category === 'error'));
    const refused = await page.evaluate(() => playground.run().then(() => '', error => String(error)));
    assert.match(refused, /E_TYPESCRIPT/);
    assert.equal(await page.locator('iframe').count(), 1, 'Type failure retains the last working preview');
    await page.locator('#files .file').filter({hasText:'model.ts'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#source .squiggly-error').length>0);
    pass('semantic-errors-block-run-and-preserve-preview');
    await page.evaluate(project => playground.importProject(project), before);
    await page.evaluate(() => playground.run());
    const exit = await page.evaluate(() => playground.stop());
    assert.equal(exit.reason, 'clean-exit'); assert.equal(exit.code, 0);
    assert.equal(await page.locator('iframe').count(), 0);
    pass('clean-engine-exit-and-project-roundtrip');
    await page.evaluate(() => playground.setFile('/src/model.ts', 'export function caption(count: number): string { return "Saved: " + count; }'));
    await page.waitForFunction(() => document.getElementById('saved').textContent === '已自动保存');
    await page.reload();
    await page.waitForFunction(() => window.playground?.ready || window.playground?.errors?.length, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => playground.ready), true);
    assert.match(await page.evaluate(() => playground.exportProject().files['/src/model.ts']), /Saved:/);
    await page.waitForFunction(() => document.getElementById('status').textContent === '运行中', null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => playground.runs.length), 1);
    pass('indexeddb-project-recovery-and-automatic-run');
    await page.evaluate(url => playground.setPreviewUrl(url), previewServer.url + '/preview.html');
    const dev = await page.evaluate(() => playground.exportProject()); dev.config.mode = 'development';
    await page.evaluate(project => playground.importProject(project), dev);
    const devRun = await page.evaluate(() => playground.runs.at(-1));
    await page.waitForFunction(runId => playground.events.some(event => event.runId === runId && event.type === 'log' && event.text.includes('GODOT_REACT_BOOT_REPORT')), devRun.runId, { timeout: 90000 });
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    pass('development-sdk-real-web-boot');
    const mediaSource = await readFile(resolve(repo, 'scripts/test/fixtures/browser-media.tsx'), 'utf8');
    const image = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(2, 1), context = canvas.getContext('2d');
      context.fillStyle = '#f00'; context.fillRect(0, 0, 1, 1); context.fillStyle = '#0f0'; context.fillRect(1, 0, 1, 1);
      return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    });
    const media = { config: { ...dev.config, mode: 'production', profileId: 'ui-media-v1', dependencies: {}, assets: { marker: { source: '/assets/marker.png', type: 'Texture2D' } } }, files: { '/src/App.tsx': mediaSource, '/assets/marker.png': image }, selected: '/src/App.tsx' };
    await page.evaluate(project => playground.importProject(project), media);
    const mediaRun = await page.evaluate(() => playground.runs.at(-1));
    await page.waitForFunction(runId => playground.events.some(event => event.runId === runId && event.type === 'log' && event.text.includes('PLAYGROUND_MEDIA') && event.text.includes('"controlled":false')), mediaRun.runId, { timeout: 30000 });
    const mediaEvents = await page.evaluate(runId => playground.events.filter(event => event.runId === runId), mediaRun.runId);
    assert(mediaEvents.some(event => event.text?.includes('"margin":12') && event.text?.includes('"value":42.5')));
    assert(mediaEvents.some(event => event.text?.includes('"margin":4') && event.text?.includes('"value":7.25')));
    assert(!mediaEvents.some(event => event.type === 'log' && event.level === 'error'));
    await page.screenshot({ path: resolve(out, 'media.png'), fullPage: true });
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    pass('png-ui-media-native-controls-and-controlled-baseline');
    const physicsSource = await readFile(resolve(repo, 'tests/react/physics/src/Physics.tsx'), 'utf8');
    const floor = await readFile(resolve(repo, 'tests/react/physics/assets/floor-shape.tres'), 'utf8');
    const actor = await readFile(resolve(repo, 'tests/react/physics/assets/actor-shape.tres'), 'utf8');
    const physics = { config: { ...dev.config, mode: 'production', profileId: 'behavior-physics-v1', dependencies: {}, assets: { floorShape: { source: '/assets/floor-shape.tres', type: 'RectangleShape2D' }, actorShape: { source: '/assets/actor-shape.tres', type: 'CapsuleShape2D' } } }, files: { '/src/App.tsx': physicsSource, '/assets/floor-shape.tres': floor, '/assets/actor-shape.tres': actor }, selected: '/src/App.tsx' };
    await page.evaluate(project => playground.importProject(project), physics);
    const physicsRun = await page.evaluate(() => playground.runs.at(-1));
    await page.waitForFunction(runId => playground.events.some(event => event.runId === runId && event.type === 'log' && event.text.includes('GODOT_REACT_PHYSICS_BEHAVIOR_OK')), physicsRun.runId, { timeout: 45000 });
    assert(await page.evaluate(runId => playground.events.some(event => event.runId === runId && event.text?.includes('GODOT_REACT_PHYSICS_STALE_TOKEN_OK')), physicsRun.runId));
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    pass('real-web-physics-collision-and-stale-command-rejection');
    report.checks.push(...await verifyDemos(page, out));
    await page.click('#share');
    await page.waitForURL(url => url.hash.startsWith('#project='));
    await page.reload();
    await page.waitForFunction(() => window.playground?.ready, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => playground.exportProject().config.profileId), 'behavior-physics-v1');
    assert.equal(await page.locator('iframe').count(), 0, 'Shared projects require an explicit Run');
    pass('compressed-share-restores-without-autorun');
    await page.evaluate(url => playground.setPreviewUrl(url), previewServer.url + '/preview.html');
    await page.locator('#files .file').filter({hasText:'App.tsx'}).click({button:'right'});await page.click('#rename-file');
    await page.fill('#filename', '/src/Renamed.tsx'); await page.locator('#file-form button').click();
    assert.equal(await page.evaluate(() => playground.exportProject().config.entry), '/src/Renamed.tsx');
    await page.click('#new-file'); await page.fill('#filename', '/src/Fresh.ts'); await page.locator('#file-form button').click();
    assert.equal(await page.evaluate(() => playground.exportProject().files['/src/Fresh.ts']), '');
    assert(await page.evaluate(() => '/src/Renamed.tsx' in playground.exportProject().files));
    await page.locator('#files .file').filter({hasText:'Fresh.ts'}).click({button:'right'});await page.click('#delete-file');
    assert.equal(await page.evaluate(() => '/src/Fresh.ts' in playground.exportProject().files), false);
    pass('rename-entry-then-create-and-delete-file');
    const preserved = await page.evaluate(() => playground.exportProject());
    const rejectedImport = await page.evaluate(async () => {
      const invalid = playground.exportProject(); invalid.files['/bad.bin'] = { length: 4294967295 };
      return playground.importProject(invalid).then(() => '', error => String(error));
    });
    assert.match(rejectedImport, /E_PROJECT_DOCUMENT/);
    assert.deepEqual(await page.evaluate(() => playground.exportProject()), preserved);
    pass('invalid-project-import-refused-before-allocation');
    const multiSource = `import * as React from 'react'; import {Label} from '@godot-js/react'; export default function App(props:{message:string}) { React.useLayoutEffect(() => console.log('ENTRY_SELECTED ' + props.message), []); return <Label text={props.message}/>; }`;
    await page.evaluate(project => playground.importProject(project), { config: { schemaVersion: 1, entry: '/src/Z.tsx', dependencies: {}, mode: 'production', profileId: 'core-ui-v1', entries: { z: { module: '/src/Z.tsx', props: { message: 'chosen' } }, a: { module: '/src/A.tsx', props: { message: 'wrong' } } } }, files: { '/src/Z.tsx': multiSource, '/src/A.tsx': multiSource }, selected: '/src/Z.tsx' });
    const multiRun = await page.evaluate(() => playground.runs.at(-1));
    await page.waitForFunction(runId => playground.events.some(event => event.runId === runId && event.text?.includes('ENTRY_SELECTED chosen')), multiRun.runId, { timeout: 30000 });
    assert(!await page.evaluate(runId => playground.events.some(event => event.runId === runId && event.text?.includes('ENTRY_SELECTED wrong')), multiRun.runId));
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    pass('multi-entry-launches-configured-primary-with-props');
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests,[]);assert(requests.every(request=>!/^https?:/.test(request.url)||permittedOrigins.has(new URL(request.url).origin)));
  assert(server.requests.every(request => ['GET', 'HEAD'].includes(request.method)));
  assert(!server.requests.some(request => /\.pck(?:\?|$)/.test(request.url)));
  pass('static-only-no-runtime-node-npm-or-pack-server');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); report.stack = error.stack; process.exitCode = 1;
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.state = await page.evaluate(() => window.playground && { ready: playground.ready, revision: playground.revision, diagnostics: playground.diagnostics, errors: playground.errors, events: playground.events.slice(-80), runs: playground.runs }).catch(() => null);
  report.logs = logs; report.pageErrors = pageErrors; report.network = requests;
  report.externalRequests=externalRequests;
  report.staticRequests = server.requests;
  if (gated) report.previewStaticRequests = previewServer.requests;
  try {
    const release = await inspectRelease(resolve(site, 'release'));
    report.runtimeRelease = release.id;
    assert.equal(release.id, initialRelease?.id, 'Runtime release must not change during validation');
    report.artifactHashes = {};
    for (const file of release.files) {
      const actual = digest(await readFile(within(resolve(site, 'release'), file.path)));
      assert.equal(actual, file.sha256, `Actual release bytes differ: ${file.path}`);
      report.artifactHashes[file.path] = actual;
    }
    report.siteArtifactHashes = await siteArtifacts();
    assert.equal(canonical(report.siteArtifactHashes), canonical(initialSiteArtifacts), 'Static runtime templates must not change during validation');
    for (const path of ['index.html', 'main.js', 'compiler-worker.js', 'types-worker.js', 'preview.html', 'preview.js']) assert(report.siteArtifactHashes[path], `Missing validated static template ${path}`);
    report.scope = { browser: ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'Playwright WebKit (Linux)' })[driver.name] + ' ' + report.browser, sdkModes: report.checks.some(check => check.name === 'development-sdk-real-web-boot') ? ['production', 'development'] : ['production'], profiles: ['core-ui-v1', ...(report.checks.some(check => check.name === 'png-ui-media-native-controls-and-controlled-baseline') ? ['ui-media-v1'] : []), ...(report.checks.some(check => check.name === 'real-web-physics-collision-and-stale-command-rejection') ? ['behavior-physics-v1'] : [])], engineTarget: release.engine.target, threads: false, crossOriginIsolated: false, audio: 'Dummy' };
  } catch (error) { report.status = 'failed'; report.failure = String(error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server.close(); await previewServer.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.map(item => item.name), failure: report.failure, report: resolve(out, 'report.json') }));
}
