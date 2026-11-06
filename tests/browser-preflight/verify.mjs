import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './serve.mjs';

const site = resolve(process.argv[2] ?? '../work/browser-preflight/site');
const out = resolve(process.argv[3] ?? '../work/browser-preflight/results');
const playwright = process.env.PLAYWRIGHT_MODULE;
if (!playwright) throw Error('Set PLAYWRIGHT_MODULE to an installed playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
await mkdir(out, { recursive: true });
const service = await serve(site);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1150, height: 1100 } });
const logs = [], errors = [], network = [];
page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => network.push({ url: request.url(), method: request.method() }));
page.on('requestfailed', request => logs.push({ type: 'requestfailed', text: `${request.url()}: ${request.failure()?.errorText}` }));
const report = { status: 'running', checks: [], browser: browser.version(), startedAt: new Date().toISOString() };
const check = (name, detail) => report.checks.push({ name, status: 'passed', ...detail });
try {
  await page.goto(service.url + (process.env.LOCAL_COMPILER === '1' ? '/?local=1' : '/'));
  await page.waitForFunction(() => window.preflight?.run && document.getElementById('status').textContent === '就绪');
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  check('no-cross-origin-isolation');
  const negative = await page.evaluate(async () => {
    try { await preflight.compile('export default function App( { return <'); return null; }
    catch (error) { return { message: String(error), diagnostics: error.diagnostics }; }
  });
  assert(negative?.diagnostics?.[0]?.location);
  check('browser-tsx-syntax-diagnostic', { diagnostic: negative.diagnostics[0] });
  const unsupported = await page.evaluate(async () => {
    try { await preflight.compile('import fs from "node:fs"; export default fs;'); return null; }
    catch (error) { return String(error); }
  });
  assert(unsupported?.includes('E_PREFLIGHT_IMPORT'));
  check('node-builtin-import-rejected');
  await page.evaluate(() => preflight.run());
  const compiler = await page.evaluate(() => preflight.compiler);
  assert.equal(compiler.location, 'browser-worker');
  assert.equal(compiler.crossOriginIsolated, false);
  assert(compiler.sourceMap.sources.some(source => source.endsWith('Counter.tsx')));
  assert(compiler.sourceMap.mappings.length > 0);
  assert(compiler.fetched.some(file => file.url === 'https://cdn.jsdelivr.net/npm/clsx@2.1.1/dist/clsx.mjs'));
  check('browser-worker-tsx-and-pinned-jsdelivr-npm', { compiler });
  await page.waitForFunction(() => preflight.errors.length || preflight.events.some(e => e.text?.includes('GODOT_REACT_BOOT_REPORT')), null, { timeout: 90000 });
  assert.deepEqual(await page.evaluate(() => preflight.errors), []);
  const bootText = await page.evaluate(() => preflight.events.find(e => e.text?.includes('GODOT_REACT_BOOT_REPORT')).text);
  const boot = JSON.parse(bootText.slice(bootText.indexOf('GODOT_REACT_BOOT_REPORT') + 'GODOT_REACT_BOOT_REPORT'.length).trim());
  assert(boot.layoutPublished > 0);
  assert.equal(boot.treeAudit.matches, true);
  assert.deepEqual(boot.unexpectedErrors, []);
  assert.deepEqual(boot.startupAssets.failures, []);
  check('real-godot-wasm-boot', { boot });
  await page.waitForFunction(() => preflight.events.some(e => e.text?.includes('"text":"Count: 0"')), null, { timeout: 15000 });
  await page.screenshot({ path: resolve(out, 'counter-before.png'), fullPage: true });
  await page.frameLocator('iframe').locator('canvas').click({ position: { x: 170, y: 45 } });
  await page.waitForFunction(() => preflight.events.some(e => e.text?.includes('"text":"Count: 1"')), null, { timeout: 15000 });
  check('real-canvas-click-updates-native-label');
  await page.screenshot({ path: resolve(out, 'counter-after.png'), fullPage: true });
  await page.locator('#source').fill((await page.locator('#source').inputValue()).replace('React.useState(0)', 'React.useState(10)'));
  await page.evaluate(() => preflight.run());
  await page.waitForFunction(() => preflight.errors.length || preflight.runs.length === 2 && preflight.runs[1].events.some(e => e.text?.includes('GODOT_REACT_BOOT_REPORT')), null, { timeout: 90000 });
  assert.deepEqual(await page.evaluate(() => preflight.errors), []);
  await page.waitForFunction(() => preflight.runs[1].events.some(e => e.text?.includes('"text":"Count: 10"')), null, { timeout: 15000 });
  const runs = await page.evaluate(() => preflight.runs);
  assert.notEqual(runs[0].generation, runs[1].generation);
  assert(runs[0].events.some(e => e.type === 'exited' && e.code === 0));
  check('edit-and-restart-fresh-generation', { generations: runs.map(run => run.generation) });
  await page.frameLocator('iframe').locator('canvas').click({ position: { x: 170, y: 45 } });
  await page.waitForFunction(() => preflight.runs[1].events.some(e => e.text?.includes('"text":"Count: 11"')), null, { timeout: 15000 });
  await page.evaluate(() => preflight.stop());
  assert(await page.evaluate(() => preflight.runs[1].events.some(e => e.type === 'exited' && e.code === 0)));
  check('clean-engine-exit');
  assert.deepEqual(await page.evaluate(() => preflight.errors), []);
  assert.deepEqual(errors, []);
  assert(service.requests.every(req => ['GET', 'HEAD'].includes(req.method)));
  check('static-server-only-no-runtime-node');
  assert(!service.requests.some(req => /\.pck(?:\?|$)/.test(req.url)));
  check('browser-generated-pck-without-pack-server');
  const rejection = await page.evaluate(async () => {
    const result = await preflight.compile(document.getElementById('source').value);
    const offset = result.packIndex[result.manifest.modules.app.uri].offset;
    new Uint8Array(result.pack)[offset] ^= 1; // Corrupt actual packed bytes after sealing.
    const child = document.createElement('iframe'); child.src = './preview.html';
    const events = [];
    const onMessage = event => { if (event.origin === location.origin && event.source === child.contentWindow) events.push(event.data); };
    window.addEventListener('message', onMessage);
    await new Promise(resolve => { child.onload = resolve; document.getElementById('preview').append(child); });
    child.contentWindow.postMessage({ type: 'run', result }, location.origin);
    try {
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 30000;
        const timer = setInterval(() => {
          if (events.some(event => event.type === 'exited')) { clearInterval(timer); resolve(); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(Error('Tamper rejection timed out')); }
        }, 50);
      });
      return events;
    } finally { window.removeEventListener('message', onMessage); child.remove(); }
  });
  assert(rejection.some(event => event.text?.includes('E_ARTIFACT_HASH')));
  assert(rejection.some(event => event.type === 'exited' && event.code === 1));
  assert(!rejection.some(event => event.text?.includes('GODOT_REACT_BOOT_REPORT')));
  assert.deepEqual(errors, []);
  check('sealed-module-tampering-rejected', { events: rejection });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); report.stack = error.stack;
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.state = await page.evaluate(() => JSON.parse(JSON.stringify(window.preflight))).catch(() => null);
  report.logs = logs; report.pageErrors = errors; report.network = network; report.staticRequests = service.requests;
  report.artifactHashes = {};
  for (const file of ['assets/godot.wasm', 'assets/godot.js', 'assets/runtime.json', 'compiler.js']) {
    try { report.artifactHashes[file] = createHash('sha256').update(await readFile(resolve(site, file))).digest('hex'); } catch {}
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await service.close();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.map(c => c.name), failure: report.failure, report: resolve(out, 'report.json') }));
}
