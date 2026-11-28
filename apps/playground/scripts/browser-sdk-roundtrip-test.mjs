import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sameWorkerRun} from '@godot-js/engine/browser/dedicated/worker-protocol';
import {createPackedConsumer} from '../../../packages/project-tools/test/fixtures/packed-consumer.mjs';
import {runtimeRecoveryFixture, RUNTIME_RECOVERY_ASSET_FILE as assetFile, RUNTIME_RECOVERY_START_FILE as startFile,
  RUNTIME_RECOVERY_ERROR as failureMarker, RUNTIME_RECOVERY_PLAYER_PATH as player, RUNTIME_RECOVERY_PATCH as patch} from '../src/runtime-recovery-demo.ts';
import {consoleResult} from './api-console-browser-helpers.mjs';
import {defaultTestDirectory, launchBrowser, observedWorkerSessions, observedWorkerOutcomes, withAcceptanceContext} from './browser-harness.mjs';
import {runReportedBrowserTest, listenBrowserTestServer as listen, closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {createStaticServer} from './serve.mjs';

const scope = 'packed-sdk-runtime-recovery-and-roundtrip';
const reportFile = path.resolve(process.env.PLAYGROUND_SDK_ROUNDTRIP_REPORT ?? 'work/sdk-roundtrip/report.json');
const evidenceDir = path.dirname(reportFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const resourcePath = 'res:/' + assetFile;

function assertCleanExit(identity, exit) {
  assert(exit && sameWorkerRun(identity, exit), 'Expected terminal for the exact Worker run');
  assert.equal(exit.reason, 'clean-exit');
  assert.deepEqual(exit.engineOutcome, {kind: 'native-exit', code: 0});
  assert.equal(exit.hostCleanup?.status, 'complete');
  assert.equal(exit.sessionFacts?.nativeExit?.code, 0);
  assert.equal(exit.sessionFacts?.hostCleanup, 'complete');
  assert.equal(exit.sessionFacts?.forcedTerminationIssued, false);
  assert.equal(exit.sessionFacts?.failure, undefined);
  assert.equal(exit.runtimeFailureCapture, 'settled_empty');
}

function assertConversion(build, source, engineId) {
  assert.equal(build.importReceipts.length, 1);
  const [receipt] = build.importReceipts;
  assert.equal(receipt.resource, resourcePath);
  assert.equal(receipt.converter.id, 'godotjs/png-ctex');
  assert.equal(receipt.converter.output.resourceType, 'CompressedTexture2D');
  assert.equal(receipt.target.resourceAbi, 'godot-4.6.1-resources-v2');
  assert.equal(receipt.target.features.engineId, engineId);
  assert.equal(receipt.sources.find(input => input.path === resourcePath)?.sha256, sha256(Buffer.from(source)));
  const original = build.outputOverlay.find(entry => entry.path === resourcePath);
  assert.equal(original?.disposition, 'unchanged');
  assert.equal(original?.outputHash, receipt.sources.find(input => input.path === resourcePath).sha256);
  for (const output of receipt.outputs) {
    assert.equal(build.outputOverlay.find(entry => entry.path === output.path)?.outputHash, output.sha256);
  }
  assert(receipt.outputs.some(output => output.path.endsWith('.ctex')));
  assert(receipt.outputs.some(output => output.path === resourcePath + '.import'));
  return receipt;
}

function assertInput(identity, response, nextFrame) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert(sameWorkerRun(response.receipt.run, identity));
  assert.equal(BigInt(response.result.up.physics) - BigInt(response.result.down.physics), 4n);
  assert(nextFrame.iteration > response.result.finishedIteration);
}

// Both the installed SDK and the Playground return ownership of full PNG bytes.
// Decode those bytes in the independent browser context and save the originals.
async function sampleGame(page, {runId, playground, label}) {
  return page.evaluate(async ({runId, playground, player, patch, label}) => {
    const query = {runId, props: [{path: player, property: 'position'}]};
    const reply = await (playground ? globalThis.godotPlayground.game_probe(query) :
      globalThis.engineContractsRoundtrip.runner.gameProbe(query));
    if (!reply.ok || reply.result.mode !== 'rendered') throw Error(label + ': ' + JSON.stringify(reply));
    const {bytes, ...image} = reply.result.image;
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    try {
      if (bitmap.width !== image.width || bitmap.height !== image.height) throw Error('PNG dimensions differ from Probe');
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(bitmap, 0, 0);
      const x = Math.floor(patch.x * bitmap.width / 960);
      const y = Math.floor(patch.y * bitmap.height / 640);
      const pixels = [...context.getImageData(x - 1, y - 1, 3, 3).data];
      return {...reply.result, image: {...image, bytes: [...new Uint8Array(bytes)]}, pixels, samplePoint: {x, y}};
    } finally { bitmap.close(); }
  }, {runId, playground, player, patch, label});
}

async function recordSample(page, identity, label, x, rgb, playground = false) {
  const {image: {bytes, ...image}, pixels, ...sample} = await sampleGame(page, {runId: identity.runId, playground, label});
  assert(sameWorkerRun(identity, sample.run), label);
  assert.equal(sample.releaseId, identity.releaseId ?? identity.release.releaseId, label);
  assert.deepEqual(sample.properties[0]?.value, {x, y: 256}, label);
  assert.equal(sample.properties[0]?.path, player, label);
  assert.equal(image.mimeType, 'image/png', label);
  assert.equal(image.renderSerial, sample.frame.renderSerial, label);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    assert(pixels.slice(offset, offset + 3).every((value, channel) => Math.abs(value - rgb[channel]) <= 3),
      label + ' expected texture ' + JSON.stringify(rgb) + ', sampled ' + JSON.stringify(pixels.slice(offset, offset + 4)));
    assert.equal(pixels[offset + 3], 255, label);
  }
  const png = Buffer.from(bytes), file = label + '.png';
  await writeFile(path.join(evidenceDir, file), png);
  return {...sample, texture: {expectedRgb: rgb, pixels}, image: {...image, file, sha256: sha256(png), byteLength: png.length}};
}

await runReportedBrowserTest({scope, reportFile, run: async test => {
  const directory = defaultTestDirectory();
  const {site, release, candidateId, descriptorHash} = await test.preflight(directory);
  const requestedTarget = {profile: 'full-engine-v1', target: 'template_debug', executionBackend: 'worker',
    presentationBackend: 'direct', browser: 'chromium', gameProbe: 1, inputScript: 1};
  const report = {cases: [], requestedTarget, engineExecuted: false, releaseId: release.id, candidateId, descriptorHash};
  test.checkpoint(report);
  if (release.runtimeProfile !== requestedTarget.profile || site.engineTarget !== requestedTarget.target ||
      site.schemaVersion !== 3 || site.executionModel !== 'window' || site.runtime?.executionBackend !== 'worker' ||
      !site.runtime.presentationBackends.includes('direct') ||
      release.runtimeAbi?.gameProbe !== 1 || release.runtimeAbi?.inputScript !== 1) {
    return {...report, status: 'blocked', reason: 'A Full/debug single-thread Dedicated Worker Direct candidate with Probe and Input Script ABI 1 is required'};
  }
  assert(process.env.PLAYGROUND_ACCEPTANCE_CONTEXT, 'Create a candidate context using seal-site-acceptance --begin');
  const contextIdentity = JSON.parse(await readFile(process.env.PLAYGROUND_ACCEPTANCE_CONTEXT, 'utf8'));
  assert.equal(contextIdentity.profile, release.runtimeProfile);
  assert.equal(contextIdentity.releaseId, release.id);
  assert.equal(contextIdentity.candidateId, candidateId);
  assert.equal(contextIdentity.descriptorHash, descriptorHash);
  await mkdir(evidenceDir, {recursive: true});

  const prefix = site.publicAssets ? '/releases/' + candidateId + '/' : '/';
  const serverOptions = {urlPrefix: prefix, publicImmutable: site.publicAssets === true};
  const editor = createStaticServer(directory, serverOptions), preview = createStaticServer(directory, serverOptions);
  test.defer(() => close(editor));
  test.defer(() => close(preview));
  test.stage = 'consumer-install';
  const consumer = await createPackedConsumer({browser: true});
  test.defer(consumer.dispose);
  const caller = createStaticServer(consumer.directory);
  test.defer(() => close(caller));
  await Promise.all([listen(editor), listen(preview), listen(caller)]);
  const origin = server => 'http://127.0.0.1:' + server.address().port;
  const editorRoot = origin(editor) + prefix, previewRoot = origin(preview) + prefix;
  const callerRoot = origin(caller) + '/consumer.html';
  const options = {releaseRoot: editorRoot, previewUrl: previewRoot + 'preview.html',
    configuration: {budgets: {maxCanvasDimension: 2048}}};
  report.deployment = {callerOrigin: origin(caller), editorRoot, previewRoot};
  report.sdk = {packageArtifacts: consumer.packageArtifacts, browserBundleSha256: sha256(consumer.browserBundle),
    browserInputs: consumer.browserInputs.map(filename => path.relative(consumer.directory, filename))};
  report.pageErrors = [];

  test.stage = 'browser';
  const browser = await launchBrowser({browser: 'chromium', headless: true, args: [
    '--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  ]});
  test.defer(() => browser.close());
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  test.defer(() => context.close());
  async function independentPage() {
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.setDefaultTimeout(60_000);
    await page.goto(callerRoot);
    await page.evaluate(options => globalThis.engineContractsConsumer.openRoundtrip(options), options);
    return page;
  }
  const {document, repairedSource, replacementPng} = runtimeRecoveryFixture(release.runtimeProfile);
  const originalPng = document.files[assetFile];
  const original = await independentPage();
  const invoke = (page, method, input) => page.evaluate(({method, input}) =>
    globalThis.engineContractsRoundtrip[method](input), {method, input});
  const querySdk = (page, method, input) => page.evaluate(({method, input}) =>
    globalThis.engineContractsRoundtrip.runner[method](input), {method, input});
  const queryPlayground = (page, method, input) => page.evaluate(({method, input}) =>
    globalThis.godotPlayground[method](input), {method, input});
  const findExits = (events, identity) => events.filter(event => event.type === 'exit' && sameWorkerRun(event.report, identity));

  async function verifyPlay(page, identity, label, rgb, playground = false) {
    await page.bringToFront();
    if (playground) {
      await page.waitForFunction(runId => {
        const reply = globalThis.godotPlayground.get_run({runId});
        return reply.result?.state === 'running' && reply.result.gameProbe?.ready && reply.result.inputScript?.ready;
      }, identity.runId);
    } else {
      await page.waitForFunction(runId => {
        const runner = globalThis.engineContractsRoundtrip.runner;
        return runner.state === 'running' && runner.gameProbeState(runId).ready && runner.inputScriptState(runId).ready;
      }, identity.runId);
    }
    const before = await recordSample(page, identity, label + '-before', 64, rgb, playground);
    const request = {runId: identity.runId, actionName: 'move_right', pressOffset: 0, releaseOffset: 4};
    const input = await (playground ? queryPlayground(page, 'run_game_input_script', request) : querySdk(page, 'runGameInputScript', request));
    assert.equal(input.ok, true, JSON.stringify(input));
    const after = await recordSample(page, identity, label + '-after', 128, rgb, playground);
    assertInput(identity, input, after.frame);
    assert.equal(before.properties[0].instanceId, after.properties[0].instanceId);
    return {before, input, after};
  }
  async function stopSdk(page, identity) {
    const exit = await querySdk(page, 'stopRun', identity.runId);
    assertCleanExit(identity, exit);
    const exits = await page.evaluate(runId => globalThis.engineContractsRoundtrip.events.filter(
      event => event.type === 'exit' && event.report.runId === runId), identity.runId);
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0].report, exit);
    return exit;
  }

  let failed, repaired, failureRun, replaced, portable;
  test.stage = 'run';
  await test.step('independent-failure-and-repair', async () => {
    failed = await invoke(original, 'open', document);
    assert.match(failed.rejection, /^E_RUN_ENDED:/);
    assert.equal(failed.run, undefined);
    assert(!failed.build.diagnostics.some(item => item.category === 'error'));
    assert.equal(failed.build.facts.release.releaseId, release.id);
    assert.equal(failed.build.facts.release.descriptorSha256, descriptorHash);
    failureRun = failed.events.find(event => event.type === 'state' && event.state === 'loading-frame');
    assert(failureRun, 'The valid failing build must create a Worker run');
    assert.equal(failureRun.revision, failed.revision);
    assert.equal(failureRun.generation, failed.revision);
    assert.equal(failureRun.buildKey, failed.build.buildKey);
    const failedExits = findExits(failed.events, failureRun);
    assert.equal(failedExits.length, 1);
    const [failure] = failedExits;
    assert.equal(failure.report.sessionFacts?.failure?.kind, 'runtime');
    assert.equal(failure.report.runtimeFailureCapture, 'observed');
    assert.match(failure.report.diagnostic.message, new RegExp(failureMarker));
    report.engineExecuted = true;
    report.cases.push({name: 'startup-failure', revision: failed.revision, build: failed.build, terminal: failure.report});

    const delta = {baseRevision: failed.revision, changed: {[startFile]: repairedSource}};
    repaired = await invoke(original, 'change', delta);
    assert(repaired.run, repaired.rejection);
    assert(repaired.revision > failed.revision);
    assert.equal(repaired.run.buildKey, repaired.build.buildKey);
    assert.notEqual(repaired.build.sourceHash, failed.build.sourceHash);
    assert.notEqual(repaired.run.runId, failureRun.runId);
    const staleBase = await original.evaluate(async delta => {
      const client = globalThis.engineContractsRoundtrip, before = client.events.length;
      try { await client.change(delta); }
      catch (error) { return {code: error.code, message: error.message, events: client.events.slice(before)}; }
      throw Error('A stale base revision was accepted');
    }, delta);
    assert.equal(staleBase.code, 'E_PROJECT_REVISION_CONFLICT');
    assert(!staleBase.events.some(event => event.type === 'state' && event.state === 'loading-frame'));
    const retainedFailure = await original.evaluate(runId => globalThis.engineContractsRoundtrip.events.find(
      event => event.type === 'exit' && event.report.runId === runId).report, failureRun.runId);
    assert.deepEqual(retainedFailure, failure.report);
    const stale = await querySdk(original, 'gameProbe', {runId: failureRun.runId, screenshot: false});
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'run_ended');
    const play = await verifyPlay(original, repaired.run, 'sdk-repaired', patch.original);
    report.cases.push({name: 'source-repair', revision: repaired.revision, build: repaired.build, run: repaired.run,
      staleBase, staleRun: stale, priorFailureRunId: retainedFailure.runId, play});
  });
  await test.step('independent-resource-replacement', async () => {
    const missingSource = await invoke(original, 'rejectResource', {remove: assetFile});
    const missingProducer = await invoke(original, 'rejectResource', {withoutProducer: true});
    assert.equal(missingSource.error.code, 'E_RESOURCE_CONVERTER');
    assert.match(missingSource.error.message, /Missing conversion source/);
    assert.equal(missingProducer.error.code, 'E_RESOURCE_CONVERTER');
    assert.match(missingProducer.error.message, /Converter is not registered/);
    for (const failure of [missingSource, missingProducer]) {
      assert.equal(failure.revision, repaired.revision);
      assert(!failure.events.some(event => event.type === 'exit' || event.type === 'state' && event.state === 'loading-frame'));
    }
    const retained = await recordSample(original, repaired.run, 'sdk-after-rejected-builds', 128, patch.original);
    replaced = await invoke(original, 'change', {baseRevision: repaired.revision, changed: {[assetFile]: replacementPng}});
    assert(replaced.run, replaced.rejection);
    assert.equal(replaced.run.buildKey, replaced.build.buildKey);
    const repairedExits = findExits(replaced.events, repaired.run);
    assert.equal(repairedExits.length, 1);
    assertCleanExit(repaired.run, repairedExits[0].report);
    const previousReceipt = assertConversion(repaired.build, originalPng, release.engineId);
    const receipt = assertConversion(replaced.build, replacementPng, release.engineId);
    assert.deepEqual(receipt.converter, previousReceipt.converter);
    assert.equal(receipt.parameterHash, previousReceipt.parameterHash);
    assert.notDeepEqual(receipt.outputs, previousReceipt.outputs);
    for (const key of ['sourceHash', 'buildKey', 'artifactId', 'packSha256']) assert.notEqual(repaired.build[key], replaced.build[key]);
    const play = await verifyPlay(original, replaced.run, 'sdk-replaced', patch.replacement);
    report.cases.push({name: 'resource-replacement', revision: replaced.revision, build: replaced.build,
      missingSource, missingProducer, retained, play, previousExit: repairedExits[0].report, terminal: await stopSdk(original, replaced.run)});
  }, {after: ['independent-failure-and-repair']});
  await test.step('independent-portable-document', async () => {
    portable = await invoke(original, 'export');
    const json = JSON.parse(portable);
    assert.equal(json.schemaVersion, 4);
    assert.equal(json.engineProfile, release.runtimeProfile);
    assert.deepEqual(json.launch, document.launch);
    assert.deepEqual(json.resourceImports, document.resourceImports);
    assert.deepEqual(json.files, {...document.files, [startFile]: repairedSource, [assetFile]: replacementPng});
    assert(!Object.hasOwn(json, 'importReceipts'));
    const file = 'sdk-roundtrip-project.json';
    await writeFile(path.join(evidenceDir, file), portable);
    report.document = {file, sha256: sha256(portable), sourceHash: replaced.build.sourceHash, launch: json.launch, resourceImports: json.resourceImports};
    const fresh = await independentPage();
    const imported = await invoke(fresh, 'open', portable);
    assert.equal(imported.revision, 1);
    assert(imported.run, imported.rejection);
    assert.notEqual(imported.run.runId, replaced.run.runId);
    assert.notEqual(imported.run.documentId, replaced.run.documentId);
    const receipt = assertConversion(imported.build, replacementPng, release.engineId);
    assert.deepEqual(receipt, replaced.build.importReceipts[0]);
    for (const key of ['sourceHash', 'buildKey', 'artifactId', 'packSha256']) assert.equal(imported.build[key], replaced.build[key]);
    const play = await verifyPlay(fresh, imported.run, 'sdk-reimported', patch.replacement);
    report.cases.push({name: 'empty-workspace-reimport', revision: imported.revision, build: imported.build, play,
      terminal: await stopSdk(fresh, imported.run)});
    await fresh.close();
  }, {after: ['independent-resource-replacement']});
  await test.step('playground-import-same-bytes', async () => {
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.setDefaultTimeout(60_000);
    await page.goto(editorRoot + '?project=native&presentationBackend=direct&previewOrigin=' + encodeURIComponent(previewRoot));
    await page.waitForFunction(() => globalThis.godotPlayground?.get_project_context().result.capabilities.play === 'available');
    const originalContext = consoleResult(await queryPlayground(page, 'get_project_context'));
    await page.locator('#import').setInputFiles({
      name: 'sdk-roundtrip-project.json', mimeType: 'application/json', buffer: Buffer.from(portable),
    });
    await page.waitForFunction(previous => {
      const {result} = globalThis.godotPlayground.get_project_context();
      if (result.projectId === previous || !result.activeRunId) return false;
      const run = globalThis.godotPlayground.get_run({runId: result.activeRunId}).result;
      return run?.projectId === result.projectId && run?.state === 'running';
    }, originalContext.projectId);
    const current = consoleResult(await queryPlayground(page, 'get_project_context'));
    const run = consoleResult(await queryPlayground(page, 'get_run', {runId: current.activeRunId}));
    const build = consoleResult(await queryPlayground(page, 'get_build', {attemptId: run.attemptId}));
    assert.equal(build.projectId, current.projectId);
    assert.equal(build.editorRevision, current.editorRevision);
    assert.equal(build.artifact.buildKey, run.buildKey);
    assert.equal(run.release.releaseId, release.id);
    const play = await verifyPlay(page, run, 'playground-imported', patch.replacement, true);
    consoleResult(await queryPlayground(page, 'stop', {runId: run.runId}));
    const exited = consoleResult(await queryPlayground(page, 'wait_for_event', {runId: run.runId, until: 'exited', timeoutMs: 60_000}));
    assert.equal(exited.outcome, 'reached');
    assert.equal(exited.run.exit.evidence, 'host-report');
    assertCleanExit(run, exited.run.exit.report);
    report.cases.push({name: 'playground-import', documentSha256: sha256(portable), build, play, terminal: exited.run.exit.report});
    await page.close();
  }, {after: ['independent-portable-document']});

  assert.deepEqual(report.pageErrors, []);
  report.outcomes = observedWorkerOutcomes(browser);
  if (test.steps.every(step => step.status === 'passed')) {
    return withAcceptanceContext({...report, status: 'passed'}, {directory, browser});
  }
  return {...report, status: 'failed', sessions: observedWorkerSessions(browser)};
}});
