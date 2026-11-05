// Real Web backend negative fixture. Requires a site prepared with the rebuilt
// engine; Node orchestrates Chromium but never compiles or executes authored TSX.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';

const site = resolve(process.argv[2] ?? '../work/browser-preflight/site');
const out = resolve(process.argv[3] ?? '../work/browser-preflight/source-maps');
if (!process.env.PLAYWRIGHT_MODULE) throw Error('Set PLAYWRIGHT_MODULE to playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const source = await readFile(new URL('./SourceMapProbe.tsx', import.meta.url), 'utf8');
const authorLine = source.split('\n').findIndex(line => line.includes('PREFLIGHT_SOURCE_MAP_AUTHOR_THROW')) + 1;
const authorColumn = source.split('\n')[authorLine - 1].indexOf('new Error') + 1;
const expectedLocation = `res://src/SourceMapProbe.tsx:${authorLine}:${authorColumn}`;
let engineEvidence;
if (process.env.ENGINE_BUILD_REPORT) {
  const build = JSON.parse(await readFile(process.env.ENGINE_BUILD_REPORT, 'utf8'));
  assert.equal(build.status, 'built', 'The requested engine build must finish successfully');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(await readFile(build.template.path)), build.template.sha256, 'Engine archive changed after the build report');
  const members = execFileSync('unzip', ['-Z1', build.template.path], { encoding: 'utf8' }).trim().split('\n');
  const assets = {};
  for (const name of ['godot.js', 'godot.wasm']) {
    const member = members.find(path => path === name || path.endsWith('/' + name));
    assert(member, `Missing ${name} in the built archive`);
    const expected = digest(execFileSync('unzip', ['-p', build.template.path, member], { maxBuffer: 128 * 1024 * 1024 }));
    const actual = digest(await readFile(resolve(site, 'assets', name)));
    assert.equal(actual, expected, `Prepared site ${name} must match the rebuilt template`);
    assets[name] = actual;
  }
  engineEvidence = { report: resolve(process.env.ENGINE_BUILD_REPORT), sourceSnapshotHash: build.source.snapshotHash, godotSourceSnapshotHash: build.godotSource.snapshotHash, recipeSha256: build.recipeSha256, archiveSha256: build.template.sha256, engineTarget: build.engineTarget, godotVersion: build.godotVersion, assets };
}
await mkdir(out, { recursive: true });
const service = await serve(site);
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK ??= '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
});
const report = { status: 'running', passed: false, browser: browser.version(), authorLine, authorColumn, expectedLocation, engine: engineEvidence, checks: [], logs: [], scope: 'Actual browser JS backend; no release certification implied' };
try {
  const page = await browser.newPage();
  page.on('console', event => report.logs.push(event.text()));
  await page.goto(service.url + (process.env.LOCAL_COMPILER === '1' ? '/?local=1' : '/'));
  report.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
  assert.equal(report.crossOriginIsolated, false, 'Single-thread source-map probe must not depend on cross-origin isolation');
  await page.waitForFunction(() => window.preflight?.compile);
  for (const [name, minify, sourceMapProbe] of [['caught', false, 'caught'], ['compressed', true, 'caught'], ['uncaught', false, 'uncaught']]) {
    const events = await page.evaluate(async ({ source, minify, sourceMapProbe }) => {
      const worker = new Worker('./compiler.js' + location.search);
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Source-map browser compilation timed out')), 60000);
        worker.onmessage = ({ data }) => { clearTimeout(timeout); data.ok ? resolve(data.result) : reject(Error(data.error)); };
        worker.onerror = event => { clearTimeout(timeout); reject(Error(event.message)); };
        worker.postMessage({ id: 1, source, options: { minify, sourceMapProbe, sourcefile: 'src/SourceMapProbe.tsx' } });
      }).finally(() => worker.terminate());
      const frame = document.createElement('iframe'), events = [];
      frame.src = './preview.html';
      const onMessage = event => { if (event.origin === location.origin && event.source === frame.contentWindow) events.push(event.data); };
      window.addEventListener('message', onMessage);
      try {
        await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
        frame.contentWindow.postMessage({ type: 'run', result }, location.origin);
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 60000;
          const timer = setInterval(() => {
            if (events.some(event => event.text?.includes('PREFLIGHT_SOURCE_MAP_AUTHOR_THROW')) && (sourceMapProbe === 'caught' || events.some(event => event.type === 'exited'))) { clearInterval(timer); resolve(); }
            else if (Date.now() > deadline) { clearInterval(timer); reject(Error('Native source-map fixture timed out: ' + JSON.stringify(events))); }
          }, 30);
        });
        if (sourceMapProbe === 'caught') {
          frame.contentWindow.postMessage({ type: 'stop' }, location.origin);
          await new Promise((resolve, reject) => {
            const deadline = Date.now() + 10000;
            const timer = setInterval(() => { if (events.some(event => event.type === 'exited')) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(Error('Source-map engine did not exit')); } }, 30);
          });
        }
        return events;
      } finally { window.removeEventListener('message', onMessage); frame.remove(); }
    }, { source, minify, sourceMapProbe });
    const log = events.map(event => event.text ?? '').join('\n');
    await writeFile(resolve(out, name + '.json'), JSON.stringify(events, null, 2));
    if (sourceMapProbe === 'caught') {
      const line = events.find(event => event.text?.includes('PREFLIGHT_SOURCE_MAP '))?.text;
      assert(line, 'Missing native formatter record');
      const record = JSON.parse(line.slice(line.indexOf('PREFLIGHT_SOURCE_MAP ') + 'PREFLIGHT_SOURCE_MAP '.length));
      assert.match(record.raw, /res:\/\/.*entry\.js:\d+:\d+/, 'Web eval must identify the generated module and columns');
      if (minify) assert.match(record.raw, /res:\/\/.*entry\.js:1:\d+/, 'Compressed fixture must exercise the native wrapper first-line column offset');
      assert(record.mapped.includes(expectedLocation), `Native map must identify the exact normalized authored path, line and column: ${expectedLocation}`);
      assert(events.some(event => event.type === 'exited' && event.code === 0), 'Caught-error fixture must exit cleanly');
      report.checks.push({ name, status: 'passed', passed: true, expectedLocation, exitCode: 0, ...record });
    } else {
      assert(log.includes(expectedLocation), `Uncaught native error must map to the exact normalized authored path, line and column: ${expectedLocation}`);
      assert.match(log, /failed to attach module .*generated\/react\/entries\/app\.js/, 'The uncaught fixture must reach the native module-load error path');
      assert(events.some(event => event.type === 'exited' && event.code === 0), 'Intentional native error fixture must still exit cleanly');
      report.checks.push({ name, status: 'passed', passed: true, expectedLocation, nativeUncaughtErrorVerified: true, exitCode: 0 });
    }
  }
  report.passed = true;
  report.status = 'passed';
} finally {
  if (!report.passed) report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await service.close();
}
console.log(JSON.stringify({ passed: report.passed, expectedLocation, checks: report.checks.map(check => check.name) }));
