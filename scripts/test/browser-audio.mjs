/** Real WebAudio startup/teardown regression probe, including the unpatched
 * baseline. Audio output is not audible-certified in headless Chromium.
 * The production preview's Dummy default is intentionally unchanged. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patchOptionalPwa } from '../release/patch-web-optional-pwa.mjs';
import { patchAudioLifecycle } from '../release/patch-web-audio-lifecycle.mjs';
import { browserDriver } from './browser-launch.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { build } = createRequire(resolve(repo, 'scripts/jsb.react-build/package.json'))('esbuild');
const localRequire = createRequire(resolve(repo, 'scripts/jsb.react-browser/package.json'));
const fixtureSite = resolve(process.env.PREFLIGHT_SITE ?? resolve(repo, '../work/browser-preflight/site'));
const driver = await browserDriver();
const output = resolve(process.env.AUDIO_REPORT ?? resolve(repo, '../work/browser-audio/report.json'));
const temp = await mkdtemp(resolve(tmpdir(), 'godot-browser-audio-'));
const requests = [], checks = [], cases = [];
const report = { status: 'running', testedAt: new Date().toISOString(), checks, cases, audibleOutputVerified: false,
  scope: driver.name + ' single-thread WebAudio driver context/worklet startup and teardown; no sample-playback or other-browser claim.' };
let server, browser, browserServer;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const baseline = patchOptionalPwa(await readFile(resolve(fixtureSite, 'assets/godot.js'), 'utf8'));
  const patched = patchAudioLifecycle(baseline.code);
  await writeFile(resolve(temp, 'baseline.js'), baseline.code);
  await writeFile(resolve(temp, 'patched.js'), patched.code);
  await build({ entryPoints: [resolve(repo, 'scripts/test/fixtures/audio-preview.ts')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(temp, 'audio.js') });
  await writeFile(resolve(temp, 'audio.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; object-src 'none'; base-uri 'none'"><style>button{position:fixed;top:0;z-index:2}#start{left:0}#stop{left:240px}</style><button id="start" disabled>Start audio with gesture</button><button id="stop">Stop</button><canvas id="canvas" width="640" height="360"></canvas><script type="module" src="/audio.js"></script>`);
  await writeFile(resolve(temp, 'compiler.js'), (await readFile(resolve(fixtureSite, 'compiler.js'), 'utf8')).replace('https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js', './spark-md5.min.js'));
  const routes = { '/': resolve(temp, 'index.html'), '/main.js': resolve(temp, 'main.js'), '/audio.html': resolve(temp, 'audio.html'), '/audio.js': resolve(temp, 'audio.js'), '/compiler.js': resolve(temp, 'compiler.js'), '/pck.js': resolve(fixtureSite, 'pck.js'), '/spark-md5.min.js': localRequire.resolve('spark-md5/spark-md5.min.js') };
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ host: req.headers.host, path });
    try {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      let file = routes[path];
      if (/^\/(baseline|patched|broken)\/godot\.js$/.test(path)) file = resolve(temp, path.startsWith('/baseline/') ? 'baseline.js' : 'patched.js');
      if (/^\/(baseline|patched|broken)\/godot\.wasm$/.test(path)) file = resolve(fixtureSite, 'assets/godot.wasm');
      if (/^\/(baseline|patched|broken)\/godot\.audio\.(position\.)?worklet\.js$/.test(path)) {
        // Force the worklet continuation to run after immediate native teardown.
        await new Promise(resolve => setTimeout(resolve, 400));
        if (path === '/broken/godot.audio.worklet.js') { res.writeHead(404).end(); return; }
        file = resolve(fixtureSite, 'assets', path.slice(path.lastIndexOf('/') + 1));
      }
      if (!file && path.startsWith('/assets/')) { const candidate = resolve(fixtureSite, '.' + path); if (!candidate.startsWith(resolve(fixtureSite, 'assets') + sep)) throw Error('path'); file = candidate; }
      if (!file) { res.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  const editorOrigin = `http://127.0.0.1:${port}`, previewOrigin = `http://localhost:${port}`;
  const wasmHash = hash(await readFile(resolve(fixtureSite, 'assets/godot.wasm')));
  const release = prefix => ({ releaseId: `audio-${prefix}`, profile: 'audio-lifecycle-probe', releaseCertified: false,
    engineJs: { url: `${previewOrigin}/${prefix}/godot.js`, sha256: hash(prefix === 'baseline' ? baseline.code : patched.code) },
    engineWasm: { url: `${previewOrigin}/${prefix}/godot.wasm`, sha256: wasmHash }, allowedOrigins: [previewOrigin] });
  report.engineBytes = { baselineJs: hash(baseline.code), patchedJs: hash(patched.code), wasm: wasmHash,
    worklet: hash(await readFile(resolve(fixtureSite, 'assets/godot.audio.worklet.js'))), positionWorklet: hash(await readFile(resolve(fixtureSite, 'assets/godot.audio.position.worklet.js'))) };
  report.jsGluePatches = [baseline.patchId, patched.patchId];
  await writeFile(resolve(temp, 'main.js'), `
    window.fixtureReady=false;window.compiled=undefined;
    window.compile=()=>new Promise((resolve,reject)=>{const worker=new Worker('/compiler.js?local=1');worker.onmessage=({data})=>{worker.terminate();data.ok?resolve(data.result):reject(Error(data.error))};worker.onerror=e=>reject(Error(e.message));worker.postMessage({id:1,source:"import * as React from 'react';import {Label} from '@godot-js/react';export default function App(){return <Label text='Audio driver probe'/>}"})});
    window.prepare=async(release,mode)=>{document.querySelector('iframe')?.remove();const result=window.compiled??=await window.compile();const pack=new Uint8Array(result.pack.slice(0));if(mode==='boot-failure')pack[result.packIndex[result.manifest.modules.app.uri].offset]^=1;const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.setAttribute('allow','autoplay');frame.src=${JSON.stringify(previewOrigin + '/audio.html?editorOrigin=')}+encodeURIComponent(location.origin);await new Promise(resolve=>{frame.onload=resolve;document.body.append(frame)});frame.contentWindow.postMessage({type:'prepare-audio-probe',release,pack,mode},${JSON.stringify(previewOrigin)});};
    window.fixtureReady=true;
  `);
  await writeFile(resolve(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><title>WebAudio lifecycle probe</title><style>iframe{width:680px;height:430px}</style><script type="module" src="/main.js"></script>');
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
  browserServer = await driver.type.launchServer(driver.launchOptions);
  browser = await driver.type.connect(browserServer.wsEndpoint()); report.browser = browser.version(); report.browserFamily = driver.name;
  const page = await browser.newPage();
  await page.goto(editorOrigin); await page.waitForFunction(() => window.fixtureReady);
  async function runCase(prefix, mode, expected, iteration = 0) {
    await page.evaluate(({ release, mode }) => window.prepare(release, mode), { release: release(prefix), mode });
    const child = await (await page.$('iframe')).contentFrame();
    await child.waitForFunction(() => window.audioProbe?.snapshot().ready, null, { timeout: 30_000 });
    await child.locator('#start').click();
    try {
    if (expected === 'baseline-race') {
      await child.waitForFunction(() => window.audioProbe.snapshot().invalidContextAttempts > 0, null, { timeout: 5000 });
    } else if (mode === 'normal') {
      if (prefix === 'broken') await child.waitForFunction(() => window.audioProbe.snapshot().errors.length > 0, null, { timeout: 5000 });
      else await child.waitForFunction(() => {const s=window.audioProbe.snapshot();return s.nodesCreated>0&&s.contextStates.every(state=>state==='running')}, null, { timeout: 5000 });
      await child.locator('#stop').click();
    }
    if (expected !== 'baseline-race') await child.waitForFunction(() => window.audioProbe.snapshot().exits.length > 0 && window.audioProbe.snapshot().contextStates.every(state => state === 'closed'), null, { timeout: 10_000 });
    } catch (error) { cases.push({ prefix, mode, iteration, failedWait: String(error), ...await child.evaluate(() => window.audioProbe.snapshot()) }); throw error; }
    const snapshot = await child.evaluate(() => window.audioProbe.snapshot());
    cases.push({ prefix, mode, iteration, ...snapshot });
    assert.equal(snapshot.userActivationAtClick, true, 'AudioContext startup must be entered through a genuine user gesture');
    assert.equal(snapshot.contextsCreated, 1);
    if (expected === 'baseline-race') {
      assert.ok(snapshot.invalidContextAttempts > 0);
      assert.ok(snapshot.errors.some(error => /AudioWorkletNode|BaseAudioContext/.test(error)));
      checks.push({ name: 'unpatched-startup-failure-race-reproduced', status: 'passed' });
    } else {
      assert.equal(snapshot.invalidContextAttempts, 0);
      assert.equal(snapshot.closeCalls, 1);
      assert.deepEqual(snapshot.contextStates, ['closed']);
      assert.equal(snapshot.exits[0], mode === 'boot-failure' ? 1 : 0);
      if (prefix === 'broken') assert.ok(snapshot.errors.length > 0, 'Unexpected worklet load failures must remain observable');
      else assert.deepEqual(snapshot.errors, []);
      if (mode === 'normal' && prefix !== 'broken') { assert.ok(snapshot.nodesCreated > 0); assert.equal(snapshot.nodesDisconnected, snapshot.nodesCreated); assert.equal(snapshot.portsClosed, snapshot.nodesCreated); }
    }
  }
  await runCase('baseline', 'boot-failure', 'baseline-race');
  await runCase('patched', 'normal', 'clean');
  checks.push({ name: 'user-gesture-webaudio-context-worklet-and-clean-exit', status: 'passed' });
  await runCase('patched', 'boot-failure', 'clean');
  checks.push({ name: 'immediate-boot-failure-no-late-worklet-construction', status: 'passed' });
  await runCase('patched', 'immediate-stop', 'clean');
  checks.push({ name: 'immediate-stop-during-addmodule-closes-context', status: 'passed' });
  for (let i = 0; i < 5; i++) await runCase('patched', i % 2 ? 'immediate-stop' : 'normal', 'clean', i + 1);
  checks.push({ name: 'fresh-frame-repeat-audio-lifecycle', status: 'passed', runs: 5 });
  await runCase('broken', 'normal', 'observable-error');
  checks.push({ name: 'genuine-worklet-load-failure-remains-observable', status: 'passed' });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
finally {
  report.requests = requests;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close();
  if (browserServer) await browserServer.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, browser: report.browser, checks, report: output }));
