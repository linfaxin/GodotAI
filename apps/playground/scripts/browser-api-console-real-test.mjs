import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultTestDirectory, launchBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {consoleElement as element, invokeConsole, submitConsole, consoleResult, summerResult, readConsolePng} from './api-console-browser-helpers.mjs';

const scope = 'actual-product-api-console';
const reportFile = path.resolve(process.env.PLAYGROUND_API_CONSOLE_REAL_REPORT ?? 'work/api-console-real/report.json');
const timeout = Number(process.env.PLAYGROUND_API_CONSOLE_TIMEOUT ?? 120_000);
assert(Number.isSafeInteger(timeout) && timeout > 0);
await runReportedBrowserTest({scope, reportFile, run: async test => {
  test.checkpoint({engineExecuted: false});
  const directory = path.resolve(defaultTestDirectory());
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory, {worker: true});
  assert.equal(site.engineTarget, 'template_debug', 'The API console case requires Full/debug');
  assert.equal(release.runtimeAbi?.observation, 1, 'Runtime observation ABI 1 required');
  assert.equal(release.runtimeAbi?.runtimeProperties, 1, 'Runtime properties ABI 1 required');
  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const options = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, options), preview = createStaticServer(directory, options);
  test.defer(() => close(editor)); test.defer(() => close(preview));
  await Promise.all([listen(editor), listen(preview)]);
  const browser = await launchBrowser({browser: 'chromium', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']});
  test.defer(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  await page.addInitScript(() => {
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (window.apiConsoleHoldCheck && message?.kind === 'check') {
        window.apiConsoleReleaseCheck = () => postMessage.call(this, message, ...args);
        return;
      }
      return postMessage.call(this, message, ...args);
    };
  });
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  const calls = [], images = [], runs = [];
  // Retain partial evidence if a later UI assertion fails.
  test.checkpoint({calls, images, runs});
  let engineExecuted = false;
  const call = async (operationId, input) => {
    const value = await invokeConsole(page, operationId, input, {timeout});
    calls.push({operationId, input, ...value}); return value.reply;
  };
  const draftInput = async () => JSON.parse(await element(page, 'input').inputValue());
  async function callDraft(operationId) {
    const input = await draftInput();
    const value = await submitConsole(page, operationId, {timeout});
    calls.push({operationId, input, ...value}); return value;
  }
  async function fillFrom(sourceCallId, operationId, field, selection) {
    await element(page, 'operation').selectOption(operationId);
    await element(page, 'history').locator(`[data-call-id="${sourceCallId}"] [data-action="view-history"]`).click();
    await element(page, field).selectOption(selection);
    await element(page, 'use-result').click();
    assert.equal(await element(page, 'client-error').textContent(), '');
  }
  async function loadLesson(lesson, step) {
    const lessons = page.locator('.api-console-lessons');
    if (!await lessons.evaluate(node => node.open)) await lessons.locator('summary').click();
    await lessons.locator(`[data-lesson-id="${lesson}"][data-step-id="${step}"]`).click();
  }
  const treeSources = new Map();
  const readContext = () => page.evaluate(() => window.godotPlayground.get_project_context().result);
  async function ready() {
    await page.waitForFunction(() => window.godotPlayground?.get_project_context().result.capabilities.play === 'available', undefined, {timeout});
  }
  async function openExample() {
    const before = await readContext();
    await element(page, 'open-example').click();
    await page.waitForFunction(previous => {
      const context = window.godotPlayground.get_project_context().result;
      return context.projectId && context.projectId !== previous;
    }, before.projectId, {timeout});
    await ready();
    // Explicit example opening prepares a project; it must not launch that project.
    const current = await readContext();
    if (current.activeRunId) {
      const run = await page.evaluate(id => window.godotPlayground.get_run({runId: id}).result, current.activeRunId);
      assert(run.projectId !== current.projectId || run.state === 'exited' || run.state === 'stopping');
    }
  }
  async function play() {
    const played = summerResult(await call('engine.play', {}));
    assert.equal(played.accepted, true); assert.equal(played.state, 'pending'); assert.equal(played.run, null);
    const wait = consoleResult(await call('wait_for_event', {attemptId: played.attemptId, until: 'running', timeoutMs: 60000}));
    assert.equal(wait.outcome, 'reached'); assert(wait.run?.runId);
    const run = wait.run;
    assert.equal(run.attemptId, played.attemptId); assert.equal(run.release.releaseId, release.id);
    assert.equal(run.release.descriptorSha256, descriptorHash);
    assert.deepEqual(run.configuration, {executionBackend: 'worker', presentationBackend: 'direct'});
    const build = await page.evaluate(attemptId => window.godotPlayground.get_build({attemptId}).result, played.attemptId);
    assert.match(build.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(build.preview.runId, run.runId);
    runs.push({runId: run.runId, attemptId: played.attemptId, sourceHash: build.sourceHash,
      identity: Object.fromEntries(['runId', 'revision', 'buildKey', 'generation', 'documentId', 'workerId', 'runConfigurationHash'].map(key => [key, run[key]]))});
    const running = summerResult(await call('engine.is_running', {}));
    assert.equal(running.playing, true); assert.equal(running.capturedRunId, run.runId);
    await page.waitForFunction(runId => window.godotPlayground.get_run({runId}).result?.runtimeProperties?.ready === true, run.runId, {timeout});
    const capabilities = await element(page, 'context').innerText();
    assert.match(capabilities, /截图与输入\s+可用/);
    assert.match(capabilities, /公开属性访问\s+可用/);
    return run;
  }
  async function player(runId) {
    const tree = summerResult(await call('engine.get_runtime_tree', {depth: 3, limit: 500}));
    treeSources.set(runId, calls.at(-1).callId);
    assert.equal(tree.run.runId, runId);
    for (const key of ['runId', 'revision', 'buildKey', 'generation', 'documentId', 'workerId', 'runConfigurationHash']) assert.notEqual(tree.run[key], undefined, key);
    const targets = tree.nodes.filter(node => node.name === 'Player' && node.type === 'Node2D');
    assert.equal(targets.length, 1);
    return {runId, path: targets[0].path, expectedInstanceId: targets[0].instanceId};
  }
  async function position(target, expectedX) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = summerResult(await call('engine.inspect_runtime_node', {path: target.path}));
      assert.equal(value.run.runId, target.runId); assert.equal(value.node.instanceId, target.expectedInstanceId);
      const point = value.properties.find(item => item.name === 'position').value;
      if (point.x === expectedX) { assert.equal(point.y, 256); return value; }
      assert(Date.now() < deadline, 'Player did not reach x=' + expectedX + ': ' + JSON.stringify(point));
    }
  }
  async function capture(name, target, {x, health}) {
    const frame = summerResult(await call('engine.screenshot', {target: 'game'}));
    assert.equal(frame.run.runId, target.runId); assert.equal(frame.releaseId, release.id);
    assert.equal(frame.bytes.kind, 'ArrayBuffer'); assert(frame.bytes.byteLength > 0);
    const png = await readConsolePng(page);
    assert.deepEqual(x === 64 ? png.pixels.initialMarker : png.pixels.movedMarker, [255, 255, 255, 255]);
    assert.deepEqual(png.pixels.health40, [0, 255, 0, 255]);
    assert.deepEqual(png.pixels.health100, health === 100 ? [0, 255, 0, 255] : [0, 0, 0, 255]);
    const bytes = Buffer.from(png.bytes), filename = path.join(path.dirname(reportFile), name + '.png');
    await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, bytes);
    const image = {name, filename, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      width: png.width, height: png.height, frame};
    images.push(image); return image;
  }
  async function stop(runId) {
    const stopped = summerResult(await call('engine.stop', {}));
    assert(stopped.runs.some(item => item.runId === runId), JSON.stringify(stopped));
    const waited = consoleResult(await call('wait_for_event', {runId, until: 'exited', timeoutMs: 10000}));
    assert.equal(waited.outcome, 'reached'); assert.equal(waited.run.runId, runId);
    const exit = waited.run.exit;
    assert.equal(exit.evidence, 'host-report'); assert.equal(exit.report.reason, 'clean-exit');
    assert.equal(exit.report.sessionFacts.nativeExit.code, 0); assert.equal(exit.report.sessionFacts.hostCleanup, 'complete');
    runs.find(run => run.runId === runId).exit = exit;
  }
  async function values(target) {
    await fillFrom(treeSources.get(target.runId), 'describe_runtime_properties', 'source-node', target.path);
    assert.deepEqual(await draftInput(), {...target, names: ['health', 'move_step']});
    const {reply: describe, callId} = await callDraft('describe_runtime_properties');
    assert.equal(describe.ok, true); assert.equal(describe.receipt.run.runId, target.runId);
    const properties = describe.result.properties.map(item => {
      assert.equal(item.status, 'found'); return {name: item.name, expectedType: item.descriptor.type};
    });
    await fillFrom(callId, 'read_runtime_properties', 'source-properties', properties.map(property => property.name));
    assert.deepEqual(await draftInput(), {...target, properties});
    const {reply} = await callDraft('read_runtime_properties');
    assert.equal(reply.ok, true); assert.equal(reply.receipt.run.runId, target.runId);
    const result = consoleResult(reply); assert.equal(result.outcome, 'completed');
    return Object.fromEntries(result.properties.map(item => {assert.equal(item.status, 'value'); return [item.name, item.value.value];}));
  }

  test.stage = 'run';
  await page.goto(`http://127.0.0.1:${editor.address().port}${prefix}?project=native&presentationBackend=direct&previewOrigin=${encodeURIComponent(`http://127.0.0.1:${preview.address().port}${prefix}`)}`, {waitUntil: 'domcontentloaded'});
  await ready(); await page.locator('#left-mode-api').click();
  await test.step('summer-position-through-page', async () => {
    await openExample();
    await call('engine.get_project_context', {});
    const run = await play(), target = await player(run.runId);
    await position(target, 64);
    await capture('position-before', target, {x: 64, health: 100});
    await fillFrom(treeSources.get(run.runId), 'engine.runtime_set', 'source-node', target.path);
    await loadLesson('summer-position', 'set-position');
    assert.deepEqual(await draftInput(), {path: target.path, property: 'position', value: 'Vector2(192, 256)'});
    const written = summerResult((await callDraft('engine.runtime_set')).reply);
    assert.equal(written.payload.result.outcome, 'applied'); assert.equal(written.payload.result.writeEntered, true);
    await position(target, 192); await capture('position-after', target, {x: 192, health: 100});
    await stop(run.runId);
    engineExecuted = true; test.checkpoint({engineExecuted});
  });
  await test.step('mixed-properties-input-restart-through-page', async () => {
    const current = await readContext();
    const checked = consoleResult(await call('check', {projectId: current.projectId, expectedEditorRevision: current.editorRevision}));
    assert.equal(checked.status, 'completed'); assert.equal(checked.diagnostics.counts.error, 0);
    const first = await play(), target = await player(first.runId);
    assert.deepEqual(await values(target), {health: 100, move_step: 64});
    await call('engine.runtime_set', {path: target.path, property: 'health', value: 40});
    assert.equal((await values(target)).health, 40);
    await call('engine.runtime_set', {path: target.path, property: 'move_step', value: 128});
    assert.equal((await values(target)).move_step, 128);
    for (const code of ['ArrowDown', 'ArrowRight']) {
      const input = consoleResult(await call('game_input', {runId: first.runId, gesture: {kind: 'key_tap', code}}));
      const waited = consoleResult(await call('wait_for_input', {runId: first.runId, operationId: input.operationId, timeoutMs: 5000}));
      assert.equal(waited.operation.status, 'dispatched'); assert.equal(waited.operation.down, 'dispatched'); assert.equal(waited.operation.up, 'dispatched');
    }
    await position(target, 192); await capture('properties-moved', target, {x: 192, health: 40});
    await stop(first.runId);
    const second = await play(), next = await player(second.runId);
    assert.notEqual(second.runId, first.runId);
    assert.equal(runs.find(run => run.runId === second.runId).sourceHash, runs.find(run => run.runId === first.runId).sourceHash);
    const historyIds = () => element(page, 'history').locator('[data-call-id]').evaluateAll(rows => rows.map(row => row.dataset.callId));
    const historyBeforeStaleWrite = await historyIds();
    await loadLesson('gameplay-properties', 'set-health');
    assert.deepEqual(await draftInput(), {path: target.path, property: 'health', value: 40});
    await element(page, 'execute').click();
    assert.match(await element(page, 'client-error').textContent(), /目标已变化/);
    assert.deepEqual(await historyIds(), historyBeforeStaleWrite, 'A lesson must keep the old draft target until an explicit update');
    assert.deepEqual(await values(next), {health: 100, move_step: 64}); await position(next, 64);
    const stale = await call('read_runtime_properties', {...target, properties: [{name: 'health', expectedType: 'int'}]});
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'run_ended');
    await capture('properties-restarted', next, {x: 64, health: 100}); await stop(second.runId);
    engineExecuted = true; test.checkpoint({engineExecuted});
  }, {after: ['summer-position-through-page']});
  await test.step('toolbar-stops-replay-during-source-check-without-an-active-run', async () => {
    const before = await readContext();
    assert.equal(before.activeRunId, null);
    assert.equal(await page.locator('#stop').isDisabled(), true);
    await page.evaluate(() => {window.apiConsoleHoldCheck = true;});
    await page.locator('#debug-tab').click();
    await page.locator('#agent-replay').click();
    await page.waitForFunction(() => typeof window.apiConsoleReleaseCheck === 'function', undefined, {timeout});
    assert.equal(await page.locator('#stop').isEnabled(), true);
    assert.equal(await page.locator('#agent-stop').isEnabled(), true);
    await page.locator('#stop').click();
    assert.match(await page.locator('#agent-status').textContent(), /正在取消/);
    assert.equal(await element(page, 'execute').isDisabled(), true);
    await page.evaluate(() => {window.apiConsoleHoldCheck = false;window.apiConsoleReleaseCheck();});
    await page.getByText('已取消自动验证；退出状态见运行记录', {exact: true}).waitFor({timeout});
    assert.equal((await readContext()).latestBuildAttemptId, before.latestBuildAttemptId);
    assert.equal(await page.locator('#stop').isDisabled(), true);
    assert.equal(await element(page, 'execute').isEnabled(), true);
  }, {after: ['mixed-properties-input-restart-through-page']});
  await test.step('existing-strict-properties-replay', async () => {
    await page.locator('#agent-runtime-properties').click();
    await page.waitForFunction(() => document.querySelector('#agent-status')?.textContent?.includes('已验证公开属性、玩法变化、重启恢复和两次完整退出'), undefined, {timeout});
    const evidence = JSON.parse(await page.locator('#agent-properties-evidence').textContent());
    assert(evidence); calls.push({operationId: 'existing-runtime-properties-replay', evidence});
  }, {after: ['toolbar-stops-replay-during-source-check-without-an-active-run']});
  const operations = [...new Set(calls.map(call => call.operationId).filter(id => id !== 'existing-runtime-properties-replay'))].sort();
  await test.step('fourteen-operation-coverage-and-clean-exits', async () => {
    assert.deepEqual(operations, [
      'engine.get_project_context', 'engine.play', 'engine.stop', 'engine.is_running', 'engine.get_runtime_tree',
      'engine.inspect_runtime_node', 'engine.runtime_set', 'engine.screenshot', 'check', 'wait_for_event',
      'describe_runtime_properties', 'read_runtime_properties', 'game_input', 'wait_for_input',
    ].sort());
    assert.equal(runs.length, 3);
    for (const run of runs) {
      assert.match(run.sourceHash, /^[a-f0-9]{64}$/);
      assert.equal(run.exit.evidence, 'host-report');
      assert.equal(run.exit.report.sessionFacts.nativeExit.code, 0);
      assert.equal(run.exit.report.sessionFacts.hostCleanup, 'complete');
    }
  }, {after: ['existing-strict-properties-replay']});
  assert.deepEqual(errors, []);
  return withAcceptanceContext({status: 'passed', scope, engineExecuted, operations, calls, images, runs,
    profile: release.runtimeProfile, releaseId: release.id, descriptorHash, candidateId}, {directory, browser});
}});
