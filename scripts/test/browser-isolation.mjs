/** Real cross-site preview/verified-loader probe. No runtime compile endpoint.
 * Usage: PLAYWRIGHT_MODULE=... node scripts/test/browser-isolation.mjs
 * Optional: PREFLIGHT_SITE, CHROMIUM, ISOLATION_REPORT, --skip-loop.
 * A Node watchdog bounds the infinite-loop probe; its result is browser-specific. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { patchOptionalPwa } from '../release/patch-web-optional-pwa.mjs';
import { browserDriver } from './browser-launch.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(repo, 'scripts/jsb.react-build/package.json'));
const { build } = require('esbuild');
const browserRequire = createRequire(resolve(repo, 'scripts/jsb.react-browser/package.json'));
const fixtureSite = resolve(process.env.PREFLIGHT_SITE ?? resolve(repo, '../work/browser-preflight/site'));
const driver = await browserDriver();
const output = resolve(process.env.ISOLATION_REPORT ?? resolve(repo, '../work/browser-isolation/report.json'));
const temp = await mkdtemp(resolve(tmpdir(), 'godot-browser-isolation-'));
const requests = [], failures = [], checks = [];
let previewService, editorService, browserServer, browser, page;
const heartbeat = Number(process.env.PROBE_HEARTBEAT_MS ?? 5000);
const report = { status: 'running', testedAt: new Date().toISOString(), checks, failures, supportClaim: 'Observed browser only; iframe disposal does not guarantee cross-browser preemption.' };
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Watchdog: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
};
async function serve(originHost, routes) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ host: req.headers.host, path });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      let file = routes[path];
      if (!file && path.startsWith('/assets/')) {
        const candidate = resolve(fixtureSite, '.' + decodeURIComponent(path));
        if (!candidate.startsWith(resolve(fixtureSite, 'assets') + sep)) throw Error('path');
        file = candidate;
      }
      if (!file) { res.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  return { server, origin: `http://${originHost}:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
try {
  await build({ entryPoints: [resolve(repo, 'apps/playground/preview.ts')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(temp, 'preview.js') });
  const html = await readFile(resolve(repo, 'apps/playground/preview.html'), 'utf8');
  await writeFile(resolve(temp, 'preview.html'), html);
  const patched = patchOptionalPwa(await readFile(resolve(fixtureSite, 'assets/godot.js'), 'utf8'));
  await writeFile(resolve(temp, 'godot.js'), patched.code);
  report.jsGluePatches = [patched.patchId];
  const rawWasm = await readFile(resolve(fixtureSite, 'assets/godot.wasm'));
  const gzipInput = process.argv.includes('--gzip');
  const existingGzip = gzipInput ? await readFile(resolve(fixtureSite, 'assets/godot.wasm.gz')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }) : undefined;
  const wasmBytes = gzipInput ? existingGzip ?? gzipSync(rawWasm, { level: 9 }) : rawWasm;
  const wasmName = gzipInput ? 'godot.wasm.gz' : 'godot.wasm';
  await writeFile(resolve(temp, wasmName), wasmBytes);
  previewService = await serve('localhost', { '/preview.html': resolve(temp, 'preview.html'), '/preview.js': resolve(temp, 'preview.js'), '/assets/godot.js': resolve(temp, 'godot.js'), ['/assets/' + wasmName]: resolve(temp, wasmName) });
  const release = { releaseId: 'local-isolation-probe', profile: 'core-ui-v1', releaseCertified: false,
    engineJs: { url: previewService.origin + '/assets/godot.js', sha256: createHash('sha256').update(await readFile(resolve(temp, 'godot.js'))).digest('hex') },
    engineWasm: { url: previewService.origin + '/assets/' + wasmName, sha256: createHash('sha256').update(wasmBytes).digest('hex'),
      ...(gzipInput ? { encoding: 'gzip', decodedSha256: createHash('sha256').update(rawWasm).digest('hex'), decodedBytes: rawWasm.length } : {}) },
    allowedOrigins: [previewService.origin] };
  report.engineArtifactHashes = { 'assets/godot.js': release.engineJs.sha256, ['assets/' + wasmName]: release.engineWasm.sha256 };
  report.engineDecodedSha256 = createHash('sha256').update(rawWasm).digest('hex');
  const fixtureRelease = await readFile(resolve(fixtureSite, 'fixture-release.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (fixtureRelease) {
    const descriptor = JSON.parse(fixtureRelease);
    for (const [path, hash] of Object.entries(report.engineArtifactHashes)) assert.equal(descriptor.files.find(file => file.path === path)?.sha256, hash, 'Fixture engine must match the pinned release');
    report.runtimeRelease = descriptor.id;
  }
  // The compiler fixture is copied unchanged except its MD5 dependency is served
  // locally. npm/CDN resolution is covered by the original preflight, not here.
  const compiler = (await readFile(resolve(fixtureSite, 'compiler.js'), 'utf8')).replace('https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js', './spark-md5.min.js');
  await writeFile(resolve(temp, 'compiler.js'), compiler);
  const main = `import { PreviewRunner } from ${JSON.stringify(resolve(repo, 'scripts/jsb.react-browser/src/runner.ts'))};
    const release = ${JSON.stringify(release)};
    window.events=[]; window.logs=[]; window.ticks=0; setInterval(()=>window.ticks++,20);
    window.makeRunner=(descriptor=release)=> { window.runner=new PreviewRunner({container:document.body,previewUrl:${JSON.stringify(previewService.origin + '/preview.html')},release:descriptor,deadlines:{heartbeat:${heartbeat},stopping:1000}}); window.runner.subscribe(event=>{window.events.push(event);if(event.type==='log')window.logs.push(event.text)}); return window.runner; };
    window.makeRunner();
    window.compile=source=>new Promise((resolve,reject)=>{ const worker=new Worker('./compiler.js?local=1'); worker.onmessage=({data})=>{worker.terminate();if(data.ok){const result=data.result;resolve({revision:'probe',buildKey:result.manifest.sourceSnapshotHash,generation:result.generation,manifest:result.manifest,pack:new Uint8Array(result.pack)})}else reject(Error(data.error))};worker.onerror=e=>{worker.terminate();reject(Error(e.message))};worker.postMessage({id:1,source})});
    window.start=async source=>{const artifact=await window.compile(source);window.events=[];window.logs=[];window.lastArtifact=artifact;return window.runner.run(artifact)};
    window.corrupt=async()=>{await window.runner.dispose();window.makeRunner({...release,engineWasm:{...release.engineWasm,sha256:'0'.repeat(64)}});return window.runner.run(window.lastArtifact)};
  `;
  await build({ stdin: { contents: main, resolveDir: repo }, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(temp, 'main.js') });
  await writeFile(resolve(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Isolation probe</title><style>iframe{width:640px;height:360px}</style><script type="module" src="./main.js"></script>');
  editorService = await serve('127.0.0.1', { '/': resolve(temp, 'index.html'), '/main.js': resolve(temp, 'main.js'), '/compiler.js': resolve(temp, 'compiler.js'), '/pck.js': resolve(fixtureSite, 'pck.js'), '/spark-md5.min.js': browserRequire.resolve('spark-md5/spark-md5.min.js') });
  report.editorOrigin = editorService.origin; report.previewOrigin = previewService.origin;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
  browserServer = await driver.type.launchServer(driver.launchOptions);
  browser = await driver.type.connect(browserServer.wsEndpoint());
  report.browserFamily = driver.name;
  report.browser = browser.version();
  page = await browser.newPage();
  page.on('pageerror', error => failures.push(String(error)));
  const network = [];
  page.on('request', request => network.push(request.url()));
  await page.goto(editorService.origin);
  await page.waitForFunction(() => window.runner);
  const source = `import * as React from 'react'; import { Label } from '@godot-js/react'; export default function App(){ React.useEffect(()=>{try{parent.document.body;console.log('ORIGIN_FAILED')}catch{console.log('ORIGIN_BLOCKED')}},[]);return <Label text="Isolated preview"/> }`;
  await bounded(page.evaluate(source => window.start(source), source), 90_000, 'real Godot boot');
  await page.waitForFunction(() => window.logs.some(log => log.includes('ORIGIN_BLOCKED')));
  assert.ok(!(await page.evaluate(() => window.logs.some(log => log.includes('ORIGIN_FAILED')))));
  checks.push({ name: 'real-cross-site-origin-and-preview-csp', status: 'passed' });
  const engineRequests = network.filter(url => url === release.engineWasm.url);
  assert.equal(engineRequests.length, 1, 'WASM must only be fetched once: execution consumes the verified bytes');
  assert.equal(network.filter(url => url === release.engineJs.url).length, 1);
  if (gzipInput) {
    assert.equal(network.filter(url => url === previewService.origin + '/assets/godot.wasm').length, 0);
    checks.push({ name: 'explicit-gzip-engine-integrity-and-virtual-wasm-no-refetch', status: 'passed', encodedBytes: wasmBytes.length, decodedBytes: rawWasm.length });
  }
  checks.push({ name: 'verified-godot-js-wasm-no-refetch', status: 'passed', wasmNetworkRequests: engineRequests.length, releaseCertified: false });
  const exit = await page.evaluate(() => window.runner.stop());
  report.normalExit = exit ?? null;
  report.normalEvents = await page.evaluate(() => window.events);
  assert.equal(exit.reason, 'clean-exit'); assert.equal(exit.code, 0);
  checks.push({ name: 'real-cooperative-exit', status: 'passed' });
  const corrupt = await page.evaluate(() => window.corrupt().then(() => '', error => error.message));
  assert.match(corrupt, /E_ASSET_HASH/);
  checks.push({ name: 'corrupt-wasm-rejected-before-engine-init', status: 'passed' });
  if (!process.argv.includes('--skip-loop')) {
    await page.evaluate(async () => { await window.runner.dispose(); window.makeRunner(); window.events=[]; });
    const loopSource = `import * as React from 'react';import {Label} from '@godot-js/react';export default function App(){React.useEffect(()=>{const loop=event=>{if(event.data?.type==='probe-sync-loop'){while(true){}}};globalThis.addEventListener('message',loop);return()=>globalThis.removeEventListener('message',loop)},[]);return <Label text="loop armed"/>}`;
    // Enter running before triggering the synchronous project loop: startup has
    // its own, longer phase deadline, while running uses the heartbeat window.
    await bounded(page.evaluate(async source => { const artifact = await window.compile(source); await window.runner.run(artifact); }, loopSource), 60_000, 'start armed loop fixture');
    const ticks = await page.evaluate(() => window.ticks);
    try {
      await bounded(page.evaluate(origin => document.querySelector('iframe').contentWindow.postMessage({ type: 'probe-sync-loop' }, origin), previewService.origin), 1000, 'trigger synchronous loop');
      await bounded(page.waitForFunction(() => window.events.some(event => event.type === 'exit' && event.report.reason === 'unresponsive'), null, { timeout: 8000 }), 10_000, 'parent response to child infinite loop');
      const after = await bounded(page.evaluate(() => ({ ticks: window.ticks, state: window.runner.state })), 1000, 'parent remains responsive');
      assert.ok(after.ticks > ticks + 10); assert.equal(after.state, 'exited');
      checks.push({ name: 'cross-site-sync-loop-parent-heartbeat-and-frame-disposal', status: 'passed', ticksAdvanced: after.ticks - ticks, scope: report.browser });
    } catch (error) {
      checks.push({ name: 'cross-site-sync-loop-parent-heartbeat-and-frame-disposal', status: 'unsupported', detail: String(error), scope: report.browser });
      report.unresponsiveIsolationGate = false;
      throw error;
    }
  } else checks.push({ name: 'cross-site-sync-loop-parent-heartbeat-and-frame-disposal', status: 'not-run' });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
finally {
  if (page && report.status !== 'passed') report.lastEvents = await bounded(page.evaluate(() => window.events), 1000, 'failure telemetry').catch(() => []);
  report.requests = requests;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (browser) await bounded(browser.close(), 2000, 'browser close').catch(() => browserServer?.process().kill('SIGKILL'));
  if (browserServer) await bounded(browserServer.close(), 2000, 'browser server close').catch(() => browserServer.process().kill('SIGKILL'));
  await previewService?.close(); await editorService?.close(); await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, browser: report.browser, checks: report.checks, report: output }));
