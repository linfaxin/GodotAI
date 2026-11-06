#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { options, writeJson, hashSiteRuntimeFiles, canonical } from '../release/web-release-utils.mjs';
import { serveBrowserSite } from './browser-server.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configuration = options(process.argv.slice(2));
const site = resolve(configuration.site ?? resolve(repository, '../work/browser-implementation/site'));
const out = resolve(configuration.out ?? resolve(repository, '../work/browser-implementation/stress'));
const iterations = Number(configuration.iterations ?? 100), failures = Number(configuration.failures ?? 20);
for (const [key, value] of [['iterations', iterations], ['failures', failures]]) if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw Error(`Invalid --${key}`);
await mkdir(out, { recursive: true });
let playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  try { playwrightModule = createRequire(import.meta.url).resolve('playwright-core/index.mjs'); }
  catch { playwrightModule = resolve(repository, '../work/browser-preflight/tools/node_modules/playwright-core/index.mjs'); }
}
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);
const editor = await serveBrowserSite({ root: site, host: '127.0.0.1' });
const preview = await serveBrowserSite({ root: site, host: 'localhost' });
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await context.route('**/app-config.json', async route => { const response=await route.fetch();const config=await response.json();return route.fulfill({response,json:{...config,previewUrl:preview.url+'/preview.html'}}); });
page.setDefaultTimeout(90000);
const pageErrors = [], consoleErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('console', event => { if (event.type() === 'error') { consoleErrors.push(event.text()); if (consoleErrors.length > 100) consoleErrors.shift(); } });
const report = {
  status: 'running', browser: browser.version(), startedAt: new Date().toISOString(),
  requested: { iterations, failures }, checks: [], cycles: [], failureCycles: [], samples: [],
  limitations: [
    'Parent-page JS heap and DOM counters do not measure the native heap or every cross-site renderer.',
    'Native counts and logs, when available, are observed diagnostics rather than a memory-zero-leak certificate.',
    'A removed iframe and a clean native exit are recorded as different outcomes.',
    'Code-only differential checks cover this selected browser/UI tuple, not backend-wide V8/QuickJS parity.',
  ],
};
const pass = (name, details = {}) => report.checks.push({ name, status: 'passed', ...details });
const seenRuns = new Set();
const initialSiteArtifacts = await hashSiteRuntimeFiles(site);
let cdp;
try { cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); } catch { /* Optional observation, not a correctness gate. */ }
async function sample(stage) {
  const result = { stage, elapsedMs: Date.now() - Date.parse(report.startedAt), scope: 'editor-page-only' };
  try {
    if (cdp) {
      const performance = await cdp.send('Performance.getMetrics');
      result.metrics = Object.fromEntries(performance.metrics.filter(metric => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Documents', 'Frames', 'Nodes', 'JSEventListeners'].includes(metric.name)).map(metric => [metric.name, metric.value]));
      result.dom = await cdp.send('Memory.getDOMCounters');
    }
    result.page = await page.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, nativeDiagnostics: window.playground?.nativeDiagnostics ?? null }));
  } catch (error) { result.unavailable = String(error); }
  report.samples.push(result);
}
async function runArtifact() {
  const started = Date.now();
  const result = await page.evaluate(() => playground.runArtifact());
  assert(result.runId && !seenRuns.has(result.runId), 'Every engine instance has a fresh runId');
  seenRuns.add(result.runId);
  await page.waitForFunction(runId => playground.events.some(event => event.type === 'log' && event.runId === runId && /GODOT_REACT_BOOT_REPORT/.test(event.text)), result.runId);
  return { ...result, startedMs: Date.now() - started };
}
async function nativeObservation(runId) {
  return page.evaluate(runId => {
    const records = playground.events.filter(event => event.type === 'log' && event.runId === runId && /GODOT_REACT_BOOT_REPORT|native.*(?:count|registry|diagnostic)|(?:count|registry|diagnostic).*native|orphan.*StringName|ObjectDB.*leak/i.test(event.text));
    return records.slice(-10).map(record => ({ level: record.level, text: record.text }));
  }, runId);
}
async function stopRun(run, { clean = true } = {}) {
  const exit = await page.evaluate(() => playground.stop());
  assert(exit && exit.runId === run.runId, 'Exit report belongs to the engine being stopped');
  if (clean) { assert.equal(exit.reason, 'clean-exit'); assert.equal(exit.code, 0); }
  assert.equal(await page.locator('iframe').count(), 0, 'Stop disposes the preview browsing context');
  return exit;
}
async function checkpoint() {
  await writeJson(resolve(out, 'report.json'), report);
  console.log(JSON.stringify({ status: report.status, completedRuns: report.cycles.length, completedFailures: report.failureCycles.length, report: resolve(out, 'report.json') }));
}
try {
  await page.goto(editor.url);
  await page.waitForFunction(() => window.playground?.ready || window.playground?.errors?.length, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => playground.ready), true, await page.evaluate(() => playground.errors.join('\n')));
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  assert.equal(await page.evaluate(() => typeof playground.runArtifact), 'function', 'App must expose the artifact-reuse test hook');
  await page.evaluate(url => playground.setPreviewUrl(url), preview.url + '/preview.html');
  await page.evaluate(() => playground.loadExample('counter'));
  const initialTypes = await page.evaluate(() => playground.check());
  assert.equal(initialTypes.ok, true, `Initial counter must type check: ${JSON.stringify(initialTypes.diagnostics)}`);
  const first = await page.evaluate(() => playground.run());
  report.scope = await page.evaluate(() => {
    const project = playground.exportProject(), release = playground.release;
    return { browserEngine: 'Chromium', sdkModes: [project.config.mode], profiles: [project.config.profileId], threads: release.engine.threads,
      engineTarget: release.engine.engineTarget ?? release.engine.target, godotVersion: release.engine.godotVersion, crossOriginIsolated };
  });
  report.scope.audio = /["']--audio-driver["']\s*,\s*["']Dummy["']/.test(await readFile(resolve(site, 'preview.js'), 'utf8')) ? 'Dummy' : 'engine-default; audible output unverified';
  const baseline = await page.evaluate(() => ({ buildKey: playground.lastArtifact.buildKey, sourceHash: playground.lastArtifact.manifest.sourceSnapshotHash, source: playground.exportProject().files['/src/Counter.tsx'] }));
  await page.waitForFunction(runId => playground.events.some(event => event.type === 'log' && event.runId === runId && event.text.includes('"text":"Count: 0"')), first.runId);
  await page.frameLocator('iframe').locator('canvas').click({ position: { x: 170, y: 45 } });
  await page.waitForFunction(runId => playground.events.some(event => event.type === 'log' && event.runId === runId && event.text.includes('"text":"Count: 1"')), first.runId);
  assert.match(baseline.source, /React\.useState\(0\)/);
  await page.evaluate(source => playground.setFile('/src/Counter.tsx', source.replace('React.useState(0)', 'React.useState(7)')), baseline.source);
  const changed = await page.evaluate(() => playground.run());
  await page.waitForFunction(runId => playground.events.some(event => event.type === 'log' && event.runId === runId && event.text.includes('"text":"Count: 7"')), changed.runId);
  const difference = await page.evaluate(runId => ({ buildKey: playground.lastArtifact.buildKey, sourceHash: playground.lastArtifact.manifest.sourceSnapshotHash, oldExit: playground.events.find(event => event.type === 'exit' && event.report.runId === runId)?.report }), first.runId);
  assert.notEqual(difference.buildKey, baseline.buildKey); assert.notEqual(difference.sourceHash, baseline.sourceHash);
  assert.equal(difference.oldExit?.reason, 'clean-exit');
  await stopRun(changed);
  pass('code-only-edit-real-native-label-differential', { before: { buildKey: baseline.buildKey, sourceHash: baseline.sourceHash }, after: difference });
  await sample('before-repeated-runs');
  for (let index = 0; index < iterations; index++) {
    const run = await runArtifact(), exit = await stopRun(run), observations = await nativeObservation(run.runId);
    report.cycles.push({ index, runId: run.runId, generation: run.generation, buildKey: run.buildKey, startupMs: run.startedMs, exit, nativeDiagnostics: observations });
    if ((index + 1) % 10 === 0 || index === iterations - 1) { await sample(`run-${index + 1}`); await checkpoint(); }
  }
  pass('repeated-artifact-real-engine-run-clean-exit', { iterations: report.cycles.length, uniqueRunIds: new Set(report.cycles.map(cycle => cycle.runId)).size, compilationPerCycle: false });
  for (let index = 0; index < failures; index++) {
    if (index % 2 === 0) {
      const run = await runArtifact();
      const source = await page.evaluate(() => playground.exportProject().files['/src/App.tsx']);
      await page.evaluate(source => playground.setFile('/src/App.tsx', source + '\nconst __stress_semantic_error__: string = 123;\n'), source);
      const rejected = await page.evaluate(() => playground.run().then(() => ({ accepted: true }), error => ({ accepted: false, error: String(error) })));
      assert.equal(rejected.accepted, false); assert.match(rejected.error, /E_TYPESCRIPT/);
      assert.equal(await page.locator('iframe').count(), 1, 'Failed compilation keeps the active preview');
      assert.equal(await page.evaluate(runId => playground.events.some(event => event.type === 'exit' && event.report.runId === runId), run.runId), false);
      await page.evaluate(source => playground.setFile('/src/App.tsx', source), source);
      report.failureCycles.push({ index, kind: 'semantic-build-refused', activeRunId: run.runId, rejected, exit: await stopRun(run) });
    } else {
      const before = await page.evaluate(() => playground.events.filter(event => event.type === 'state' && event.state === 'loading-frame').map(event => event.runId));
      await page.evaluate(() => { window.__stressPendingRun = playground.runArtifact().then(result => ({ resolved: true, runId: result.runId }), error => ({ resolved: false, error: String(error) })); });
      await page.waitForFunction(before => playground.events.some(event => event.type === 'state' && event.state === 'loading-frame' && !before.includes(event.runId)), before);
      const runId = await page.evaluate(before => [...playground.events].reverse().find(event => event.type === 'state' && event.state === 'loading-frame' && !before.includes(event.runId)).runId, before);
      const exit = await page.evaluate(() => playground.stop());
      const pending = await page.evaluate(() => window.__stressPendingRun);
      assert.equal(exit?.runId, runId); assert.equal(await page.locator('iframe').count(), 0);
      assert(['clean-exit', 'forced-frame-disposal', 'unresponsive'].includes(exit.reason), `Unexpected cancellation exit ${exit.reason}`);
      report.failureCycles.push({ index, kind: 'cancel-engine-startup', runId, exit, pending });
    }
    if ((index + 1) % 5 === 0 || index === failures - 1) await checkpoint();
  }
  pass('failed-build-retention-and-startup-cancellation', { cases: report.failureCycles.length, categories: report.failureCycles.reduce((counts, item) => { counts[item.kind] = (counts[item.kind] ?? 0) + 1; return counts; }, {}) });
  await sample('after-failure-cycles');
  assert.deepEqual(pageErrors, []);
  assert([...editor.requests, ...preview.requests].every(request => ['GET', 'HEAD'].includes(request.method)));
  pass('no-page-unhandled-errors-and-static-get-head-only');
  report.nativeMemoryConclusion = 'Not certified: no complete native heap/registry allocation ledger is exposed by this test API.';
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); report.stack = error.stack; process.exitCode = 1;
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await page.evaluate(() => window.playground?.stop()).catch(() => {});
  report.pageErrors = pageErrors; report.consoleErrors = consoleErrors;
  report.finalState = await page.evaluate(() => window.playground && { revision: playground.revision, diagnostics: playground.diagnostics, runs: playground.runs.map(run => ({ runId: run.runId, generation: run.generation, buildKey: run.buildKey, exit: run.exit })), errors: playground.errors, events: playground.events.slice(-50) }).catch(() => null);
  try { const release = JSON.parse(await readFile(resolve(site, 'release/release.json'), 'utf8')); report.runtimeRelease = release.id; report.releaseCertified = release.certified; } catch {}
  report.siteArtifactHashes = await hashSiteRuntimeFiles(site);
  if (canonical(report.siteArtifactHashes) !== canonical(initialSiteArtifacts)) { report.status = 'failed'; report.evidenceError = 'Static application/preview/worker bytes changed during lifecycle validation'; report.failure ??= report.evidenceError; process.exitCode = 1; }
  report.staticRequests = { editor: editor.requests, preview: preview.requests };
  report.finishedAt = new Date().toISOString();
  await writeJson(resolve(out, 'report.json'), report);
  await browser.close(); await editor.close(); await preview.close();
  console.log(JSON.stringify({ status: report.status, completedRuns: report.cycles.length, completedFailures: report.failureCycles.length, failure: report.failure, nativeMemoryConclusion: report.nativeMemoryConclusion, report: resolve(out, 'report.json') }));
}
