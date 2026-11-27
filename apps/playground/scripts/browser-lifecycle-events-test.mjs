import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sameWorkerRun} from '@godot-js/engine/browser/dedicated/worker-protocol';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, submitConsole,
  consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';
import {verifyLifecycleCalls} from './verify-lifecycle-events.mjs';
import {createInputScriptDemo} from '../src/input-script-demo.ts';

const scope = 'playground-lifecycle-events';
const reportFile = path.resolve(process.env.PLAYGROUND_LIFECYCLE_REPORT ?? 'work/lifecycle-events/report.json');
const ops = {recent: 'engine.recent_events', wait: 'engine.wait_for_event', play: 'engine.play',
  stop: 'engine.stop', probe: 'engine.game_probe', input: 'engine.game_input', diagnostics: 'engine.get_diagnostics'};
const repairLesson = 'diagnostic-repair';
const playerFile = '/src/Player.ts';

await runReportedBrowserTest({scope, reportFile, run: async test => {
  const directory = defaultTestDirectory();
  assert(process.env.PLAYGROUND_ACCEPTANCE_CONTEXT, 'Create a candidate context using seal-site-acceptance --begin');
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory, {worker: true});
  assert.equal(site.engineTarget, 'template_debug');
  assert.equal(release.runtimeAbi?.gameProbe, 1);
  assert.equal(release.runtimeAbi?.inputScript, 1);
  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const options = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, options), preview = createStaticServer(directory, options);
  test.defer(() => close(editor));
  test.defer(() => close(preview));
  await Promise.all([listen(editor), listen(preview)]);

  const origin = server => 'http://127.0.0.1:' + server.address().port;
  const editorOrigin = origin(editor), previewOrigin = origin(preview);
  const browser = await launchBrowser({browser: 'chromium', headless: true, args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  ]});
  test.defer(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(60_000);
  const errors = [], previewDocuments = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.request().isNavigationRequest() && url.origin === previewOrigin && url.pathname.endsWith('/preview.html'))
      previewDocuments.push({url: response.url(), status: response.status()});
  });

  const report = {calls: [], phases: [], pngs: [], editorOrigin, previewOrigin, previewDocuments,
    releaseId: release.id, candidateId, descriptorHash, engineExecuted: false};
  const checkpoint = () => test.checkpoint(report);
  const publicCall = (method, input) => page.evaluate(({method, input}) => window.godotPlayground[method](input), {method, input});
  const selectReady = () => page.waitForFunction(() =>
    window.godotPlayground?.get_project_context().result.capabilities.play === 'available');
  async function loadLesson(step, source, lessonId) {
    const panel = element(page, 'lessons');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    const rows = () => element(page, 'history').locator('[data-call-id]').evaluateAll(nodes => nodes.map(node => node.dataset.callId));
    const original = await rows();
    await panel.locator(`[data-lesson-id="${lessonId}"][data-step-id="${step}"]`).click();
    if (source) {
      await viewConsoleCall(page, source.callId);
      await element(page, 'use-result').click();
    }
    assert.deepEqual(await rows(), original, 'Loading a lesson or filling its draft must not execute an API');
  }
  async function lesson(step, op, source, lessonId = 'lifecycle-events') {
    await loadLesson(step, source, lessonId);
    if (op === 'check') await element(page, 'update-target').click();
    // The lesson uses small pages. The UI projection retains every JSON field
    // of these replies, while PNG bytes are collected from their attachments.
    const {callId, reply} = await submitConsole(page, op, {timeout: 65_000});
    const request = JSON.parse(await element(page, 'call-request').textContent());
    const entry = {callId, request, reply, result: op.startsWith('engine.') ? summerResult(reply) : consoleResult(reply)};
    report.calls.push({callId, request, reply});
    checkpoint();
    return entry;
  }
  async function editPlayer(source) {
    const {editorRevision} = consoleResult(await publicCall('get_project_context'));
    await page.locator(`#tabs [data-file-tab="${playerFile}"]`).click();
    await page.locator('#source .monaco-editor').click({position: {x: 105, y: 30}});
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(source);
    await page.waitForFunction(revision => window.godotPlayground.get_project_context().result.editorRevision > revision, editorRevision);
    await openConsoleOperation(page, ops.diagnostics);
  }
  async function prepareRepair() {
    const teach = (step, op, source) => lesson(step, op, source, repairLesson);
    const initial = await teach('play-original', ops.play);
    const original = await teach('wait-original', 'wait_for_event', initial);
    assert.equal(original.result.outcome, 'reached');
    assert.equal(original.result.run.state, 'running');
    report.engineExecuted = true;
    const source = createInputScriptDemo(release.runtimeProfile).files[playerFile];
    await editPlayer(source.replace('\n', '\nconst step: number = "bad";\n'));
    const invalidCheck = await teach('check-broken', 'check');
    const invalid = await teach('read-broken', ops.diagnostics);
    assert.equal(invalid.result.editorRevision, invalidCheck.result.editorRevision);
    assert.equal(invalid.result.check.sourceHash, invalidCheck.result.sourceHash);
    assert(invalid.result.check.diagnostics.items.some(item => item.code === 2322 && item.location?.file === playerFile && item.location.line === 2));
    assert.equal(invalid.result.run, null);
    const rejected = await teach('play-broken', ops.play);
    const noSession = await teach('wait-broken', 'wait_for_event', rejected);
    assert.equal(noSession.result.outcome, 'no_session');
    assert.equal(noSession.result.run, undefined);
    const failed = await teach('read-failed-build', ops.diagnostics);
    assert.equal(failed.result.build.attemptId, rejected.result.attemptId);
    assert.equal(failed.result.build.status, 'failed');
    assert(failed.result.build.diagnostics.items.some(item => item.code === 2322));
    assert.equal(failed.result.run, null);
    const stillRunning = consoleResult(await publicCall('get_run', {runId: original.result.run.runId}));
    assert(sameWorkerRun(stillRunning, original.result.run));
    assert.equal(stillRunning.state, 'running');
    await editPlayer(source);
    const repairedCheck = await teach('check-repaired', 'check');
    const repaired = await teach('read-repaired', ops.diagnostics);
    assert.equal(repaired.result.editorRevision, repairedCheck.result.editorRevision);
    assert(repaired.result.editorRevision > invalid.result.editorRevision);
    assert.equal(repaired.result.check.diagnostics.observed, true);
    assert.equal(repaired.result.check.diagnostics.counts.error, 0);
    assert.equal(repaired.result.check.sourceHash, repairedCheck.result.sourceHash);
    assert.notEqual(repaired.result.check.sourceHash, invalid.result.check.sourceHash);
    return repaired.result;
  }
  async function waitForTarget(step, cursor, action, matches) {
    const wait = await lesson(step, ops.wait, cursor);
    const matched = wait.result.events.find(matches);
    assert(matched, `Expected lifecycle event for ${step}`);
    return {matched, phase: {cursorCallId: cursor.callId, actionCallId: action.callId,
      waitCallIds: [wait.callId], matchedSeq: matched.seq}};
  }
  async function waitUntilReady(runId) {
    await page.waitForFunction(async runId => {
      const api = window.godotPlayground;
      const main = (await api.summer_call({op: 'engine.is_running'})).result?.data;
      if (!main?.playing || main.capturedRunId !== runId || main.pendingAttemptId !== null) return false;
      const current = api.get_run({runId}).result;
      return current?.state === 'running' && current.gameProbe?.ready && current.inputScript?.ready;
    }, runId);
  }
  async function start({cursorStep, playStep, waitStep}) {
    const cursor = await lesson(cursorStep, ops.recent);
    const action = await lesson(playStep, ops.play);
    const {matched, phase} = await waitForTarget(waitStep, cursor, action, event =>
      event.kind === 'play.started' && event.data.attemptId === action.result.attemptId &&
      event.data.projectId === action.result.projectId && event.data.editorRevision === action.result.editorRevision);
    await waitUntilReady(matched.data.run.runId);
    const live = consoleResult(await publicCall('get_run', {runId: matched.data.run.runId}));
    assert(sameWorkerRun(live, matched.data.run));
    report.engineExecuted = true;
    report.phases.push(phase);
    checkpoint();
    return matched.data;
  }
  async function stop({cursorStep, stopStep, waitStep}, run, sample) {
    const cursor = await lesson(cursorStep, ops.recent);
    const action = await lesson(stopStep, ops.stop, sample);
    assert(action.result.runs.some(target => target.runId === run.runId && target.receipt.ok));
    const {matched, phase} = await waitForTarget(waitStep, cursor, action, event =>
      event.kind === 'play.stopped' && event.data.run.runId === run.runId);
    assert(sameWorkerRun(run, matched.data.run));
    const exited = consoleResult(await publicCall('get_run', {runId: run.runId}));
    phase.exit = exited.exit;
    report.phases.push(phase);
    checkpoint();
  }
  async function capture(step, file) {
    const sample = await lesson(step, ops.probe);
    const png = await readConsolePng(page, sample.callId), bytes = Buffer.from(png.bytes);
    await mkdir(path.dirname(reportFile), {recursive: true});
    await writeFile(path.join(path.dirname(reportFile), file), bytes);
    report.pngs.push({
      file, callId: sample.callId, sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length, width: png.width, height: png.height,
      position: sample.result.properties[0].value, frame: sample.result.frame,
    });
    checkpoint();
    return sample;
  }

  await page.goto(editorOrigin + prefix +
    '?project=native&presentationBackend=direct&previewOrigin=' + encodeURIComponent(previewOrigin + prefix));
  test.stage = 'run';
  await test.step('lifecycle-lesson', async () => {
    await selectReady();
    const previous = consoleResult(await publicCall('get_project_context')).projectId;
    await openConsoleOperation(page, ops.diagnostics);
    await element(page, 'open-example').click();
    await page.waitForFunction(previous => window.godotPlayground.get_project_context().result.projectId !== previous, previous);
    await selectReady();
    const repaired = await prepareRepair();

    const first = await start({cursorStep: 'cursor-start', playStep: 'play', waitStep: 'started'});
    const {result: launched} = await lesson('read-repaired-run', ops.diagnostics, undefined, repairLesson);
    assert.equal(first.projectId, repaired.projectId);
    assert.equal(first.editorRevision, repaired.editorRevision);
    assert.equal(first.sourceHash, repaired.check.sourceHash);
    assert.equal(launched.build.attemptId, first.attemptId);
    assert.equal(launched.build.sourceHash, first.sourceHash);
    assert(sameWorkerRun(first.run, launched.run.identity));
    const before = await capture('before', 'before.png');
    report.inputCallId = (await lesson('move', ops.input, before)).callId;
    const after = await capture('after', 'after.png');
    await stop({cursorStep: 'cursor-stop', stopStep: 'stop', waitStep: 'stopped'}, first.run, after);

    const {run: second} = await start({cursorStep: 'cursor-restart', playStep: 'restart', waitStep: 'restarted'});
    const reset = await capture('reset', 'restart.png');
    await stop({cursorStep: 'cursor-final-stop', stopStep: 'final-stop', waitStep: 'final-stopped'}, second, reset);
    verifyLifecycleCalls(report);
    assert.deepEqual(errors, []);
  });

  if (test.steps.some(step => step.status !== 'passed')) return report;
  return withAcceptanceContext({...report, status: 'passed'}, {directory, browser});
}});
