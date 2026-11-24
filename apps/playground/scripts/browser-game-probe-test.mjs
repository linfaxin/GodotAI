import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer, closeBrowserTestServer} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, invokeConsole, submitConsole,
  consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';

const scope = 'playground-game-probe';
const reportFile = path.resolve(process.env.PLAYGROUND_GAME_PROBE_REPORT ?? 'work/game-probe/report.json');
const operation = 'engine.game_probe', timeout = 120_000, player = '/root/Main/Player';

function rejectResultSends({type, count}) {
  const send = MessagePort.prototype.postMessage;
  globalThis.gameProbeRejectedSends = [];
  MessagePort.prototype.postMessage = function (message, ...transfer) {
    if (message?.type === type) {
      const rejected = globalThis.gameProbeRejectedSends;
      rejected.push({requestId: message.requestId, transferred: transfer[0]?.length ?? 0});
      if (rejected.length === count) MessagePort.prototype.postMessage = send;
      throw new DOMException('Injected capture result send failure', 'DataCloneError');
    }
    return send.call(this, message, ...transfer);
  };
}

await runReportedBrowserTest({scope, reportFile, run: async test => {
  const directory = defaultTestDirectory();
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory, {worker: true});
  assert.equal(site.engineTarget, 'template_debug');
  const available = release.runtimeAbi?.gameProbe === 1;
  if (process.env.PLAYGROUND_GAME_PROBE_CASE)
    assert.equal(available, process.env.PLAYGROUND_GAME_PROBE_CASE === 'supported');
  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const options = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, options), preview = createStaticServer(directory, options);
  test.defer(() => closeBrowserTestServer(editor)); test.defer(() => closeBrowserTestServer(preview));
  await Promise.all([listenBrowserTestServer(editor), listenBrowserTestServer(preview)]);
  const browser = await launchBrowser({browser: 'chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  test.defer(() => browser.close());
  const browserContext = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await browserContext.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    window.probeDispatches = [];
    MessagePort.prototype.postMessage = function (value, ...transfers) {
      if (value?.type === 'game-probe-request') {
        window.probeDispatches.push({requestId: value.requestId, runId: value.runId});
        window.replayLastProbe = () => {
          if (performance.timeOrigin + performance.now() >= value.deadline) return false;
          send.call(this, value, ...transfers);
          return true;
        };
      }
      return send.call(this, value, ...transfers);
    };
  });
  await page.goto(`http://127.0.0.1:${editor.address().port}${prefix}?project=native&presentationBackend=direct&previewOrigin=${encodeURIComponent(`http://127.0.0.1:${preview.address().port}${prefix}`)}`);
  const ready = () => page.waitForFunction(() => window.godotPlayground?.get_project_context().result.capabilities.play === 'available', undefined, {timeout});
  await ready();
  const call = (method, input) => page.evaluate(({method, input}) => window.godotPlayground[method](input), {method, input});
  const context = () => page.evaluate(() => window.godotPlayground.get_project_context().result);
  const dispatches = () => page.evaluate(() => window.probeDispatches);
  const previewFrame = () => {
    const frame = page.frames().find(frame => frame.url().startsWith(`http://127.0.0.1:${preview.address().port}/`));
    assert(frame, 'The running preview iframe must be available');
    return frame;
  };
  const runs = [], pngs = [], lessonSteps = [];
  test.stage = 'run';
  test.checkpoint({engineExecuted: false, available, runs, pngs, lessonSteps});

  async function start() {
    const input = await context();
    const started = consoleResult(await call('play', {projectId: input.projectId, expectedEditorRevision: input.editorRevision}));
    const running = consoleResult(await call('wait_for_event', {attemptId: started.attemptId, until: 'running', timeoutMs: 60000}));
    return recordRun(started.attemptId, running);
  }

  async function recordRun(attemptId, {run, outcome}) {
    assert.equal(outcome, 'reached');
    assert.equal(run.release.releaseId, release.id);
    const build = consoleResult(await call('get_build', {attemptId}));
    const record = {run, sourceHash: build.sourceHash};
    runs.push(record);
    test.checkpoint({engineExecuted: true, runs, pngs});
    return record;
  }

  function recordCleanExit(record, exit) {
    assert.equal(exit.outcome, 'reached');
    assert.equal(exit.run.runId, record.run.runId);
    assert.equal(exit.run.exit.evidence, 'host-report');
    assert.equal(exit.run.exit.report.sessionFacts.nativeExit.code, 0);
    assert.equal(exit.run.exit.report.sessionFacts.hostCleanup, 'complete');
    record.exit = exit.run.exit;
  }

  async function lesson(step, operationId, source) {
    const panel = element(page, 'lessons');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    const sent = (await dispatches()).length;
    await panel.locator(`[data-lesson-id="game-probe"][data-step-id="${step}"]`).click();
    if (source) {
      await viewConsoleCall(page, source.callId);
      if (source.field) await element(page, source.field).selectOption(source.value);
      await element(page, 'use-result').click();
    }
    assert.equal((await dispatches()).length, sent, 'Filling a lesson draft must make no probe request');
    const {callId, reply} = await submitConsole(page, operationId, {timeout});
    const result = operationId.startsWith('engine.') ? summerResult(reply) : consoleResult(reply);
    lessonSteps.push(step);
    return {callId, result};
  }

  async function startLesson(playStep, waitStep) {
    const played = await lesson(playStep, 'engine.play');
    const running = await lesson(waitStep, 'wait_for_event', played);
    return recordRun(played.result.attemptId, running.result);
  }

  async function stopLesson(record, stopStep, waitStep) {
    const stopped = await lesson(stopStep, 'engine.stop');
    const exited = await lesson(waitStep, 'wait_for_event', {...stopped, field: 'source-run', value: record.run.runId});
    recordCleanExit(record, exited.result);
  }

  async function identify(step) {
    const tree = await lesson(step, 'engine.get_runtime_tree');
    const node = tree.result.nodes.find(node => node.path === player);
    assert(node, 'Player not present in the actual running tree');
    return {callId: tree.callId, field: 'source-node', value: player, instanceId: node.instanceId};
  }

  async function observe(record, target, step, name, x) {
    const sent = (await dispatches()).length;
    const {result} = await lesson(step, operation, target);
    assert.equal(result.mode, 'rendered');
    assert.equal(result.run.runId, record.run.runId);
    assert.equal(result.releaseId, release.id);
    assert.equal(result.image.renderSerial, result.frame.renderSerial);
    assert.equal(result.properties[0].instanceId, target.instanceId);
    assert.deepEqual(result.properties[0].value, {x, y: 256});
    assert.equal((await dispatches()).length, sent + 1);
    const png = await readConsolePng(page);
    const white = [255, 255, 255, 255], red = [255, 0, 0, 255];
    assert.deepEqual(png.pixels.initialMarker, x === 64 ? white : red);
    assert.deepEqual(png.pixels.movedMarker, x === 192 ? white : red);
    const file = path.join(path.dirname(reportFile), name + '.png');
    await mkdir(path.dirname(file), {recursive: true});
    const bytes = Buffer.from(png.bytes);
    await writeFile(file, bytes);
    pngs.push({file, sha256: createHash('sha256').update(bytes).digest('hex'),
      run: result.run, instanceId: target.instanceId, frame: result.frame, pixels: png.pixels});
    return result.frame.renderSerial;
  }

  async function runtimeWorker() {
    for (const worker of page.workers()) {
      if (await worker.evaluate(() => !!globalThis.__godotjsRuntimeHost).catch(() => false)) return worker;
    }
    assert.fail('The actual running Dedicated Worker must be available');
  }

  async function checkResultRecovery(runId) {
    const targets = [['Worker', await runtimeWorker()], ['Host', previewFrame()]];
    const cases = [
      ['screenshot', {}, 'capture-result', 'capture_failed', 1],
      ['game_probe', {screenshot: false}, 'game-probe-result', 'probe_failed', 0],
      ['game_probe', {screenshot: true}, 'game-probe-result', 'probe_failed', 1],
    ];
    for (const [hop, target] of targets) {
      for (const [method, input, type, code, transferred] of cases) {
        await target.evaluate(rejectResultSends, {type, count: 1});
        const failed = await call(method, {runId, timeoutMs: 5000, ...input});
        assert.equal(failed.error?.code, code, JSON.stringify({hop, method, input, error: failed.error}));
        if (method === 'game_probe') assert.equal(failed.error.reason, 'dispatch_failed');
        const rejected = await target.evaluate(() => globalThis.gameProbeRejectedSends);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].transferred, transferred);
        const recovered = consoleResult(await call(method, {runId, timeoutMs: 5000, ...input}));
        assert.equal(recovered.run.runId, runId);
      }
    }
  }

  async function checkResultDeadline(runId) {
    const {reply, delayed} = await page.evaluate(async runId => {
      const read = DataView.prototype.getUint32;
      const timeoutMs = 1000;
      let delayed = false;
      DataView.prototype.getUint32 = function (offset, ...args) {
        const value = read.call(this, offset, ...args);
        // Delay the editor's PNG validation after receipt, so the request timer
        // and result handler contend on the same thread over the deadline.
        if (!delayed && offset === 12 && value === 0x49484452 && read.call(this, 0) === 0x89504e47) {
          delayed = true;
          const until = performance.now() + timeoutMs + 50;
          while (performance.now() < until) { /* Simulate slow validation. */ }
        }
        return value;
      };
      try {
        const reply = await window.godotPlayground.game_probe({runId, maxDimension: 64, timeoutMs});
        return {reply, delayed};
      } finally { DataView.prototype.getUint32 = read; }
    }, runId);
    assert(delayed, 'The PNG must reach result validation before the deadline');
    assert.equal(reply.error?.code, 'timeout');
    assert.equal(reply.receipt.run.runId, runId);
    assert.equal(consoleResult(await call('game_probe', {runId, maxDimension: 64})).run.runId, runId);
  }

  const lessonCheck = available ? 'same-frame-playground-lesson' : 'older-template-zero-dispatch';
  await test.step(lessonCheck, async () => {
    await openConsoleOperation(page, operation);
    const previous = (await context()).projectId;
    await element(page, 'open-example').click();
    await page.waitForFunction(id => window.godotPlayground.get_project_context().result.projectId !== id, previous);
    await ready();
    const record = available ? await startLesson('play', 'wait') : await start();
    const {runId} = record.run;
    const capability = consoleResult(await call('get_run', {runId})).gameProbe;
    assert.equal(capability.supported, available);
    assert.equal(capability.ready, available);
    if (!available) {
      assert.equal((await call('game_probe', {runId, screenshot: false})).error.code, 'unsupported');
      assert.equal((await invokeConsole(page, operation, {props: [player + ':position']}, {timeout})).reply.error.code, 'unsupported');
      const shot = summerResult((await invokeConsole(page, 'engine.screenshot', {target: 'game'}, {timeout})).reply);
      assert.equal(shot.run.runId, runId);
      assert.deepEqual((await readConsolePng(page)).pixels.initialMarker, [255, 255, 255, 255]);
      assert.deepEqual(await dispatches(), []);
      consoleResult(await call('stop', {runId}));
      recordCleanExit(record, consoleResult(await call('wait_for_event', {runId, until: 'exited', timeoutMs: 10000})));
      return;
    }

    const target = await identify('tree');
    const before = await observe(record, target, 'before', 'before', 64);
    const {requestId} = (await dispatches()).at(-1);
    const preview = previewFrame();
    assert.equal(await preview.evaluate(() => window.replayLastProbe()), true);
    const afterReplay = await page.evaluate(async runId => {
      if (!window.replayLastProbe()) throw Error('The original probe must still be within its deadline');
      return window.godotPlayground.game_probe({runId, screenshot: false});
    }, runId);
    assert.equal(consoleResult(afterReplay).mode, 'state', 'A completed request replay must leave the capture slot free');
    const forwarded = await preview.evaluate(id => window.probeDispatches.filter(request => request.requestId === id).length, requestId);
    assert.equal(forwarded, 1, 'The Host must forward a completed request ID only once');
    await lesson('move', 'engine.runtime_set', target);
    assert(await observe(record, target, 'after', 'after', 192) > before);
    const state = consoleResult(await call('game_probe', {runId, screenshot: false, props: [{path: player, property: 'position'}]}));
    assert.equal(state.image, null);
    assert.equal(state.frame.renderSerial, undefined);
    assert.deepEqual(state.properties[0].value, {x: 192, y: 256});
    await checkResultRecovery(runId);
    await checkResultDeadline(runId);
    await stopLesson(record, 'stop', 'exit');
    assert.equal((await call('game_probe', {runId})).error.code, 'run_ended');

    const restarted = await startLesson('restart', 'wait-new');
    assert.notEqual(restarted.run.runId, runId);
    assert.equal(restarted.sourceHash, record.sourceHash);
    await observe(restarted, await identify('tree-new'), 'reset', 'restart', 64);
    await stopLesson(restarted, 'stop-new', 'exit-new');
  });
  if (available) await test.step('undeliverable-results-retire-the-run', async () => {
    for (const hop of ['Worker', 'Host']) {
      const record = await start();
      const {runId} = record.run;
      const target = hop === 'Worker' ? await runtimeWorker() : previewFrame();
      await target.evaluate(rejectResultSends, {type: 'game-probe-result', count: 2});
      const result = await call('game_probe', {runId, screenshot: false, timeoutMs: 10000});
      assert.equal(result.error?.code, 'run_ended', JSON.stringify({hop, error: result.error}));
      const exit = consoleResult(await call('wait_for_event', {runId, until: 'exited', timeoutMs: 10000}));
      assert.equal(exit.outcome, 'reached');
      assert.equal(exit.run.exit.evidence, 'host-report');
      assert.equal(exit.run.exit.report.sessionFacts.failure?.message, 'E_INTERACTION_RESULT_TRANSPORT');
      assert.equal(exit.run.exit.report.sessionFacts.hostCleanup, 'complete');
      record.exit = exit.run.exit;
    }
  }, {after: [lessonCheck]});
  await test.step('no-page-errors', () => assert.deepEqual(errors, []));
  return withAcceptanceContext({status: 'passed', scope, engineExecuted: runs.length > 0, available,
    runs, pngs, lessonSteps, candidateId, descriptorHash, releaseId: release.id}, {directory, browser});
}});
