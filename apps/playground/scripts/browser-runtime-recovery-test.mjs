import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sameWorkerRun} from '@godot-js/engine/browser/dedicated/worker-protocol';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, submitConsole,
  consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';
import {verifyCleanExit} from './verify-worker-exit.mjs';
import {RUNTIME_RECOVERY_ERROR, RUNTIME_RECOVERY_PLAYER_PATH, RUNTIME_RECOVERY_START_FILE} from '../src/runtime-recovery-demo.ts';

const scope = 'playground-runtime-recovery';
const reportFile = path.resolve(process.env.PLAYGROUND_RUNTIME_RECOVERY_REPORT ?? 'work/runtime-recovery/report.json');

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
  const browserContext = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await browserContext.newPage();
  page.setDefaultTimeout(125_000);
  const pageErrors = [], previewDocuments = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.request().isNavigationRequest() && url.origin === previewOrigin && url.pathname.endsWith('/preview.html'))
      previewDocuments.push({url: response.url(), status: response.status()});
  });


  const report = {runs: [], pngs: [], editorOrigin, previewOrigin, previewDocuments,
    releaseId: release.id, candidateId, descriptorHash, engineExecuted: false};
  const publicCall = (method, input) => page.evaluate(({method, input}) => window.godotPlayground[method](input), {method, input});
  const summerCall = async (op, input) => summerResult(await publicCall('summer_call', {op, input}));
  const editorReady = () => page.waitForFunction(() =>
    window.godotPlayground?.get_project_context().result.capabilities.play === 'available');

  async function prepareLesson(step, source) {
    const panel = element(page, 'lessons');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    await panel.locator('[data-lesson-id="runtime-recovery"][data-step-id="' + step + '"]').click();
    if (source) {
      await viewConsoleCall(page, source.callId);
      await element(page, 'use-result').click();
    }
  }

  async function lesson(step, operation, source) {
    await prepareLesson(step, source);
    const {callId, reply} = await submitConsole(page, operation);
    return {callId, result: summerResult(reply)};
  }

  async function waitFor(target, until) {
    const value = consoleResult(await publicCall('wait_for_event', {...target, until, timeoutMs: 60_000}));
    assert.equal(value.outcome, 'reached', JSON.stringify(value));
    return value;
  }

  async function play(step, until) {
    const {result} = await lesson(step, 'engine.play');
    assert.equal(result.accepted, true);
    const {run, build} = await waitFor({attemptId: result.attemptId}, until);
    assert.equal(run.attemptId, result.attemptId);
    assert.equal(run.projectId, result.projectId);
    assert.equal(run.revision, result.editorRevision);
    assert.equal(run.release.releaseId, release.id);
    assert.equal(run.buildKey, build.artifact.buildKey);
    report.engineExecuted = true;
    const evidence = {attemptId: build.attemptId, sourceHash: build.sourceHash, run};
    report.runs.push(evidence);
    test.checkpoint(report);
    return evidence;
  }

  async function waitUntilPlayable(runId) {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const {capabilityDetails: {pendingAttemptId, run}} =
        await summerCall('engine.get_project_context', {include: ['capabilities']});
      if (pendingAttemptId === null && run?.runId === runId && run.state === 'running' &&
          run.capabilities.gameProbe?.ready && run.capabilities.inputScript?.ready) return;
      assert(performance.now() < deadline, 'Probe and input did not become ready for ' + runId);
      await delay(50);
    }
  }

  async function capture(step, expected, file, x) {
    const call = await lesson(step, 'engine.game_probe');
    const {run, mode, properties, frame, image} = call.result;
    assert(sameWorkerRun(run, expected), 'Probe belongs to a different Worker');
    assert.equal(mode, 'rendered');
    const position = properties.find(item => item.path === RUNTIME_RECOVERY_PLAYER_PATH && item.property === 'position')?.value;
    assert.deepEqual(position, {x, y: 256});
    assert.equal(image.iteration, frame.iteration);
    assert.equal(image.renderSerial, frame.renderSerial);
    const png = await readConsolePng(page, call.callId), bytes = Buffer.from(png.bytes);
    assert.equal(png.width, image.width);
    assert.equal(png.height, image.height);
    await mkdir(path.dirname(reportFile), {recursive: true});
    await writeFile(path.join(path.dirname(reportFile), file), bytes);
    report.pngs.push({file, callId: call.callId, sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length, width: png.width, height: png.height, position, frame});
    test.checkpoint(report);
    return call;
  }

  async function verifyStopped(evidence) {
    const {runId} = evidence.run;
    const {run} = await waitFor({runId}, 'exited');
    verifyCleanExit(evidence.run, run.exit);
    evidence.run = run;
    test.checkpoint(report);
  }

  await page.goto(editorOrigin + prefix +
    '?project=native&presentationBackend=direct&previewOrigin=' + encodeURIComponent(previewOrigin + prefix));
  test.stage = 'run';
  await test.step('runtime-recovery-lesson', async () => {
    await editorReady();
    const original = consoleResult(await publicCall('get_project_context'));
    await openConsoleOperation(page, 'engine.get_debugger_errors');
    await element(page, 'open-example').click();
    await page.waitForFunction(previous => window.godotPlayground.get_project_context().result.projectId !== previous, original.projectId);
    await editorReady();
    assert.equal(consoleResult(await publicCall('get_project_context')).latestBuildAttemptId, null);
    await openConsoleOperation(page, 'engine.get_debugger_errors');

    const failed = await play('play-failure', 'exited');
    assert.equal(failed.run.exit.evidence, 'host-report');
    assert(sameWorkerRun(failed.run, failed.run.exit.report));
    assert.equal(failed.run.exit.report.runtimeFailureCapture, 'observed');
    assert.equal(failed.run.exit.report.reason, 'crashed');
    const {result: error} = await lesson('read-error', 'engine.get_debugger_errors');
    assert.equal(error.status, 'observed');
    assert.equal(error.projectId, failed.run.projectId);
    assert.equal(error.editorRevision, failed.run.revision);
    assert.equal(error.runId, failed.run.runId);
    assert.deepEqual(error.build, {attemptId: failed.attemptId, sourceHash: failed.sourceHash});
    assert.deepEqual(error.entries, [{source: 'runtime-binding', diagnostic: failed.run.exit.report.diagnostic}]);
    assert.equal(error.entries[0].diagnostic.message, RUNTIME_RECOVERY_ERROR);
    report.debuggerResult = error;

    const source = await lesson('read-source', 'engine.read_file');
    const {path: scriptPath, content, sha256, projectId, editorRevision} = source.result;
    assert.equal(scriptPath, 'res:/' + RUNTIME_RECOVERY_START_FILE);
    assert.equal(projectId, failed.run.projectId);
    assert.equal(editorRevision, failed.run.revision);
    assert.equal(sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(content.split('const startupBroken = true;').length, 2);
    const repaired = content.replace('const startupBroken = true;', 'const startupBroken = false;');
    await prepareLesson('write-source', source);
    const guarded = JSON.parse(await element(page, 'input').inputValue());
    assert.deepEqual(guarded, {path: scriptPath, expected_sha256: sha256, projectId, expectedEditorRevision: editorRevision});
    const stale = await publicCall('summer_call', {op: 'engine.write_file', input: {
      ...guarded, content: repaired, expected_sha256: (sha256[0] === '0' ? '1' : '0') + sha256.slice(1),
    }});
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'revision_conflict');
    assert.deepEqual(await summerCall('engine.read_file', {path: scriptPath}), source.result);
    await element(page, 'input').fill(JSON.stringify({...guarded, content: repaired}));
    const write = summerResult((await submitConsole(page, 'engine.write_file')).reply);
    assert.deepEqual(write, {path: scriptPath, projectId, editorRevision: editorRevision + 1,
      sha256: createHash('sha256').update(repaired).digest('hex'), bytes: Buffer.byteLength(repaired)});
    const {result: check} = await lesson('check-source', 'engine.get_script_errors');
    assert.equal(check.status, 'completed');
    assert.equal(check.editorRevision, write.editorRevision);
    assert.equal(check.path, scriptPath);
    assert.equal(check.diagnostics.counts.error, 0);
    report.sourceRepair = {before: {path: scriptPath, sha256, projectId, editorRevision}, write,
      staleError: stale.error.code, check: {checkId: check.checkId, sourceHash: check.sourceHash, editorRevision: check.editorRevision}};

    const fixed = await play('play-fixed', 'running');
    assert.equal(fixed.run.projectId, failed.run.projectId);
    assert(fixed.run.revision > failed.run.revision);
    assert.equal(fixed.run.revision, write.editorRevision);
    assert.equal(fixed.sourceHash, check.sourceHash);
    assert.notEqual(fixed.sourceHash, failed.sourceHash);
    const history = consoleResult(await publicCall('get_run', {runId: error.runId}));
    assert(sameWorkerRun(history, failed.run));
    assert.deepEqual(history.exit, failed.run.exit);

    await waitUntilPlayable(fixed.run.runId);
    const before = await capture('recovery-before', fixed.run, 'before.png', 64);
    const {result: input} = await lesson('recovery-input', 'engine.game_input', before);
    assert.equal(input.ok, true);
    assert(sameWorkerRun(input.receipt.run, fixed.run));
    const {kind, base, down, up, releaseStepCompleted, finishedIteration} = input.result;
    assert.equal(kind, 'completed');
    assert.equal(releaseStepCompleted, true);
    assert.equal(BigInt(down.physics), BigInt(base));
    assert.equal(BigInt(up.physics) - BigInt(down.physics), 4n);
    const after = await capture('recovery-after', fixed.run, 'after.png', 128);
    assert(after.result.frame.iteration > finishedIteration);
    report.input = input;
    const stopped = await lesson('stop-fixed', 'engine.stop', after);
    assert.equal(stopped.result.accepted, true);
    await verifyStopped(fixed);
    const settled = await summerCall('engine.get_debugger_errors', {});
    assert.equal(settled.status, 'no_reported_error');
    assert.equal(settled.runId, fixed.run.runId);

    const restarted = await play('recovery-restart', 'running');
    assert.equal(restarted.run.projectId, fixed.run.projectId);
    assert.equal(restarted.run.revision, fixed.run.revision);
    assert.equal(restarted.sourceHash, fixed.sourceHash);
    for (const field of ['runId', 'generation', 'workerId', 'documentId']) {
      assert.equal(new Set(report.runs.map(({run}) => run[field])).size, 3, field);
    }
    await waitUntilPlayable(restarted.run.runId);
    await capture('recovery-reset', restarted.run, 'restart.png', 64);
    await page.locator('#stop').click();
    await verifyStopped(restarted);
    assert(previewDocuments.length >= 3 && previewDocuments.every(({url, status}) =>
      status === 200 && new URL(url).searchParams.get('editorOrigin') === editorOrigin));
    assert.deepEqual(pageErrors, []);
  });
  if (test.steps.some(step => step.status !== 'passed')) return report;
  return withAcceptanceContext({...report, status: 'passed'}, {directory, browser});
}});
