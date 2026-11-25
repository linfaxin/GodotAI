import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, openConsoleOperation, viewConsoleCall, invokeConsole, submitConsole,
  consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';
import {SUMMER_OPERATION_SPECS} from '../src/summer-operation-spec.ts';

const scope = 'playground-input-script';
const reportFile = path.resolve(process.env.PLAYGROUND_INPUT_SCRIPT_REPORT ?? 'work/input-script/report.json');
const expected = process.env.PLAYGROUND_INPUT_SCRIPT_CASE;
const operation = 'engine.game_input';
const pathToPlayer = '/root/Main/Player';
const timeout = 120000;
const runKeys = ['runId', 'revision', 'buildKey', 'generation', 'documentId', 'workerId', 'runConfigurationHash'];
const identity = value => Object.fromEntries(runKeys.map(key => [key, value[key]]));

await runReportedBrowserTest({scope, reportFile, run: async test => {
  const directory = defaultTestDirectory();
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory, {worker: true});
  assert(['supported', 'unsupported'].includes(expected), 'Set PLAYGROUND_INPUT_SCRIPT_CASE to supported or unsupported');
  const supported = expected === 'supported';
  assert.equal(release.runtimeAbi?.inputScript === 1, supported);
  assert.equal(release.runtimeAbi?.gameProbe, 1);
  assert.equal(site.engineTarget, 'template_debug');
  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const options = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, options), preview = createStaticServer(directory, options);
  test.defer(() => close(editor)); test.defer(() => close(preview));
  await Promise.all([listen(editor), listen(preview)]);

  const browser = await launchBrowser({browser: 'chromium', headless: true, args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  ]});
  test.defer(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && /WebGL|GL_INVALID/i.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.inputScriptDispatches = [];
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (packet, ...args) {
      if (packet?.type === 'input-script-request' || packet?.type === 'input-request')
        window.inputScriptDispatches.push({type: packet.type, runId: packet.runId});
      return send.call(this, packet, ...args);
    };
  });
  const origin = 'http://127.0.0.1:' + preview.address().port + prefix;
  await page.goto('http://127.0.0.1:' + editor.address().port + prefix +
    '?project=native&presentationBackend=direct&previewOrigin=' + encodeURIComponent(origin));
  test.stage = 'run';

  const runs = [], pngs = [], calls = [], inputEvidence = {};
  let engineExecuted = false, scriptExecuted = false;
  const inputMessages = () => page.evaluate(() => window.inputScriptDispatches);
  const api = (method, input) => page.evaluate(({method, input}) => window.godotPlayground[method](input), {method, input});
  const ready = () => page.waitForFunction(() => window.godotPlayground?.get_project_context().result.capabilities.play === 'available');
  const checkpoint = () => test.checkpoint({engineExecuted, scriptExecuted, supported, runs, pngs, calls, inputEvidence});
  checkpoint();
  await ready();
  async function openSample(op) {
    const previous = consoleResult(await api('get_project_context')).projectId;
    await openConsoleOperation(page, op);
    await element(page, 'open-example').click();
    await page.waitForFunction(id => window.godotPlayground.get_project_context().result.projectId !== id, previous);
    await ready();
  }
  async function lesson(step, op, source, stoppedRunId) {
    const panel = element(page, 'lessons');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    const sent = (await inputMessages()).length;
    await panel.locator('[data-lesson-id="input-script"][data-step-id="' + step + '"]').click();
    if (source) {
      await viewConsoleCall(page, source.callId);
      if (stoppedRunId) await element(page, 'source-run').selectOption(stoppedRunId);
      await element(page, 'use-result').click();
    }
    assert.equal((await inputMessages()).length, sent, 'Filling a lesson must not send inputs');
    const {callId, reply} = await submitConsole(page, op, {timeout});
    const result = op.startsWith('engine.') ? summerResult(reply) : consoleResult(reply);
    calls.push({step, op, callId});
    return {callId, result};
  }
  async function recordRun(attemptId, waiting) {
    assert.equal(waiting.outcome, 'reached', JSON.stringify(waiting));
    const {run} = waiting;
    assert.equal(run.attemptId, attemptId);
    assert.equal(run.release.releaseId, release.id);
    assert.equal(run.configuration.presentationBackend, 'direct');
    await page.waitForFunction(async ({runId, supported}) => {
      const api = window.godotPlayground;
      const main = (await api.summer_call({op: 'engine.is_running'})).result?.data;
      if (!main?.playing || main.capturedRunId !== runId || main.pendingAttemptId !== null) return false;
      const current = api.get_run({runId}).result;
      return current?.state === 'running' && current.gameProbe?.ready === true &&
        current.inputScript?.supported === supported && current.inputScript.ready === supported;
    }, {runId: run.runId, supported}, {timeout: 30000});
    const build = consoleResult(await api('get_build', {attemptId}));
    assert.equal(build.status, 'succeeded');
    assert.equal(build.diagnostics.counts.error, 0);
    assert.equal(build.artifact.artifactId, run.artifact.artifactId);
    if (supported) assert.equal(build.compilerIdentity.target.naming, 'snake');
    assert.match(build.sourceHash, /^[a-f0-9]{64}$/);
    const record = {run, sourceHash: build.sourceHash, build};
    runs.push(record);
    engineExecuted = true;
    checkpoint();
    return record;
  }
  function recordExit(record, waiting) {
    assert.equal(waiting.outcome, 'reached', JSON.stringify(waiting));
    assert.equal(waiting.run.runId, record.run.runId);
    const exit = waiting.run.exit;
    assert.equal(exit.evidence, 'host-report');
    assert.equal(exit.report.sessionFacts.nativeExit.code, 0);
    assert.equal(exit.report.sessionFacts.hostCleanup, 'complete');
    assert.notEqual(exit.report.sessionFacts.forcedTerminationIssued, true);
    record.exit = exit;
    checkpoint();
  }
  async function capture(record, step, x, fileName) {
    const captured = await lesson(step, 'engine.game_probe');
    const {result} = captured;
    assert.deepEqual(identity(result.run), identity(record.run));
    assert.equal(result.releaseId, release.id);
    assert.deepEqual(result.properties[0].value, {x, y: 256});
    assert.equal(result.image.iteration, result.frame.iteration);
    assert.equal(result.image.renderSerial, result.frame.renderSerial);
    const png = await readConsolePng(page, captured.callId);
    const red = [255, 0, 0, 255], white = [255, 255, 255, 255];
    assert.deepEqual(png.pixels.initialMarker, x === 64 ? white : red);
    assert.deepEqual(png.pixels.inputMarker, x === 128 ? white : red);
    const file = path.join(path.dirname(reportFile), fileName + '.png'), bytes = Buffer.from(png.bytes);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, bytes);
    pngs.push({file: path.basename(file), callId: captured.callId, sha256: createHash('sha256').update(bytes).digest('hex'),
      run: result.run, frame: result.frame, position: result.properties[0].value,
      playerInstanceId: result.properties[0].instanceId, pixels: png.pixels});
    checkpoint();
    return captured;
  }

  if (supported) await test.step('complete-input-lesson', async () => {
    await openSample(operation);
    const play = await lesson('input-play', 'engine.play');
    const first = await recordRun(play.result.attemptId, (await lesson('input-ready', 'wait_for_event', play)).result);
    const before = await capture(first, 'input-before', 64, 'before');
    const startCount = (await inputMessages()).length;
    const scripted = (await lesson('input-execute', operation, before)).result;
    assert.deepEqual((await inputMessages()).slice(startCount), [{type: 'input-script-request', runId: first.run.runId}]);
    assert.deepEqual(identity(scripted.receipt.run), identity(first.run));
    assert.equal(scripted.receipt.releaseId, release.id);
    assert.equal(scripted.result.kind, 'completed');
    assert.equal(BigInt(scripted.result.down.physics) - BigInt(scripted.result.base), 0n);
    assert.equal(BigInt(scripted.result.up.physics) - BigInt(scripted.result.base), 4n);
    inputEvidence.completed = scripted;
    scriptExecuted = true;
    const after = await capture(first, 'input-after', 128, 'after');
    assert.equal(after.result.properties[0].instanceId, before.result.properties[0].instanceId);
    assert(after.result.frame.iteration > scripted.result.finishedIteration);
    const stop = await lesson('input-stop', 'engine.stop', after);
    recordExit(first, (await lesson('input-exit', 'wait_for_event', stop, first.run.runId)).result);

    const restart = await lesson('input-restart', 'engine.play');
    const second = await recordRun(restart.result.attemptId, (await lesson('input-ready-new', 'wait_for_event', restart)).result);
    assert.notEqual(first.run.runId, second.run.runId);
    assert.equal(first.sourceHash, second.sourceHash);
    const reset = await capture(second, 'input-reset', 64, 'restart');
    const seen = (await inputMessages()).length;
    const panel = element(page, 'lessons');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    await panel.locator('[data-lesson-id="input-script"][data-step-id="input-execute"]').click();
    await viewConsoleCall(page, before.callId);
    await element(page, 'use-result').click();
    assert.match(await element(page, 'client-error').textContent(), /稳定运行/);
    await element(page, 'execute').click();
    assert.equal((await inputMessages()).length, seen);
    const oldInputCall = calls.find(call => call.step === 'input-execute').callId;
    await element(page, 'history').locator('[data-call-id="' + oldInputCall + '"] [data-action="load-history"]').click();
    await element(page, 'update-target').click();
    assert.match(await element(page, 'client-error').textContent(), /运行历史/);
    await element(page, 'execute').click();
    assert.match(await element(page, 'client-error').textContent(), /历史回执/);
    assert.equal((await inputMessages()).length, seen);
    const current = consoleResult(await api('game_probe', {runId: second.run.runId,
      props: [{path: pathToPlayer, property: 'position'}], screenshot: false}));
    assert.equal(current.properties[0].value.x, 64);
    inputEvidence.staleTarget = {sourceRunId: first.run.runId, activeRunId: second.run.runId,
      scriptDispatchCount: (await inputMessages()).length - seen, position: current.properties[0].value};
    await viewConsoleCall(page, reset.callId);
    await element(page, 'use-result').click();
    assert.equal((await inputMessages()).length, seen);
    const replacement = summerResult((await submitConsole(page, operation, {timeout})).reply);
    assert.deepEqual((await inputMessages()).slice(seen), [{type: 'input-script-request', runId: second.run.runId}]);
    assert.deepEqual(identity(replacement.receipt.run), identity(second.run));
    assert.equal(replacement.result.kind, 'completed');
    inputEvidence.reboundToCurrentReceipt = replacement;
    const stopNew = await lesson('input-stop-new', 'engine.stop', reset);
    recordExit(second, (await lesson('input-exit-new', 'wait_for_event', stopNew, second.run.runId)).result);
  });
  else await test.step('previous-template-uses-existing-input', async () => {
    await openConsoleOperation(page, operation);
    assert(await element(page, 'open-example').isDisabled());
    await openSample('engine.game_probe');
    const {attemptId} = summerResult((await invokeConsole(page, 'engine.play', {})).reply);
    const record = await recordRun(attemptId, consoleResult(await api('wait_for_event', {attemptId, until: 'running', timeoutMs: 60000})));
    const runId = record.run.runId;
    const startCount = (await inputMessages()).length;
    const reply = await api('summer_call', {op: operation, input: SUMMER_OPERATION_SPECS[operation].defaultInput});
    assert.equal(reply.error?.code, 'unsupported', JSON.stringify(reply));
    const direct = await api('run_game_input_script', {runId, actionName: 'move_right', pressOffset: 0, releaseOffset: 4});
    assert.equal(direct.error?.code, 'unsupported', JSON.stringify(direct));
    assert.equal((await inputMessages()).length, startCount);
    const {operationId} = consoleResult(await api('game_input', {runId, gesture: {kind: 'key_tap', code: 'ArrowRight'}}));
    const input = consoleResult(await api('wait_for_input', {runId, operationId, timeoutMs: 5000}));
    assert.equal(input.operation.status, 'dispatched', JSON.stringify(input));
    const graphics = consoleResult(await api('game_probe', {runId,
      props: [{path: pathToPlayer, property: 'position'}]}));
    assert.equal(graphics.properties[0].value.x, 128);
    inputEvidence.previousTemplate = {runId, summerError: reply.error.code, directError: direct.error.code,
      scriptDispatchCount: (await inputMessages()).slice(startCount).filter(packet => packet.type === 'input-script-request').length,
      gesture: input.operation, position: graphics.properties[0].value};
    consoleResult(await api('stop', {runId}));
    recordExit(record, consoleResult(await api('wait_for_event', {runId, until: 'exited', timeoutMs: 10000})));
  });
  assert.deepEqual(errors, []);
  return withAcceptanceContext({status: 'passed', scope, engineExecuted, scriptExecuted, supported,
    runs, pngs, calls, inputEvidence, candidateId, descriptorHash, releaseId: release.id}, {directory, browser});
}});
