import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {canonical, digest, siteIdentity} from './site-evidence.mjs';
import {operationResult, checkUnknownAction, checkProbeImageFrame, parseProbePosition} from './summer-native-receipt.mjs';

const profile = 'full-engine-v1';
const target = 'template_debug';
const siteFields = ['candidateId', 'descriptorHash', 'releaseId', 'siteHash'];
const playerPath = '/root/Main/Player';
const position = x => ({x, y: 256});
const frameRequest = action => ({
  action: 'script', clock: 'frame', wait: true,
  events: [
    {at_frame: 0, type: 'action', action, pressed: true},
    {at_frame: 4, type: 'action', action, pressed: false},
  ],
});
const requests = {
  frameOffsets: frameRequest('move_right'),
  holdMilliseconds: {action: 'script', events: [{at_frame: 0, type: 'action', action: 'jump', hold_ms: 50}]},
  unknownAction: frameRequest('__godotai_missing_input_action__'),
};
const hashPattern = /^[a-f0-9]{64}$/;
const fields = (object, names) => Object.fromEntries(names.map(name => [name, object[name]]));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function optionalReport(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const relative = name => {
  const normalized = name.replaceAll('\\', '/');
  assert(normalized.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':')), name);
  return normalized;
};
const evidenceFile = async (directory, name) => {
  const file = path.join(directory, relative(name));
  assert.equal(await realpath(file), file, 'Evidence must be present without symlinks: ' + name);
  return file;
};

async function fileIdentity(file) {
  const bytes = await readFile(file);
  return {bytes: bytes.length, sha256: digest(bytes)};
}

async function verifyCandidate(root, variant) {
  const supported = variant === 'new';
  const templateDir = path.join(root, 'templates', variant);
  const artifact = await readJson(path.join(templateDir, 'artifact.json'));
  assert.equal(artifact.kind, 'godotjs-browser-engine-artifact');
  for (const name of ['engine-report.json', 'engine-report.original.json', 'engine-template.zip', 'build.log'])
    assert.deepEqual(await fileIdentity(await evidenceFile(templateDir, name)), artifact.files[name], variant + ' ' + name);
  const template = await readJson(path.join(templateDir, 'engine-report.json'));
  assert.equal(template.template.path, 'engine-template.zip');
  assert.equal(template.template.sha256, artifact.files[template.template.path].sha256);
  assert.equal(template.sourceCertified, true);
  assert.equal(template.engineTarget, target);

  const siteDir = path.join(root, 'sites', variant);
  const site = await readJson(path.join(siteDir, 'manifest.json'));
  const release = await readJson(path.join(siteDir, 'engine-release.json'));
  const identity = await siteIdentity(siteDir);
  assert.deepEqual(fields(site, ['runtimeProfile', 'engineTarget', 'engineReleaseId']), {
    runtimeProfile: profile, engineTarget: target, engineReleaseId: release.id,
  });
  assert.equal(site.runtime.executionBackend, 'worker');
  assert.equal(release.runtimeAbi.gameProbe, 1);
  assert.equal(release.runtimeAbi.inputScript === 1, supported);
  assert.equal(release.build.engineTemplateSha256, template.template.sha256);
  assert.equal(release.build.engineReportSha256, artifact.files['engine-report.json'].sha256);
  const sdk = release.build.sdkBuild;
  return {sha256: template.template.sha256, runtimeAbi: release.runtimeAbi, sourceCommit: template.source.commit,
    sdkHash: sdk.outputSnapshotHash, sdkSourceHash: sdk.sourceSnapshotHash, reportHash: release.build.engineReportSha256,
    report: 'templates/' + variant + '/engine-report.json', ...fields(identity, siteFields)};
}

function byId(calls, id) {
  const matches = calls.filter(call => call.callId === id);
  assert.equal(matches.length, 1, 'Missing or ambiguous call: ' + id);
  return matches[0];
}

function heldTicks(input, run, releaseId) {
  assert.equal(input.ok, true);
  assert.deepEqual(input.receipt.run, run);
  assert.equal(input.receipt.releaseId, releaseId);
  const {kind, releaseStepCompleted, base, down, up} = input.result;
  assert(kind === 'completed' && releaseStepCompleted);
  assert.equal(BigInt(down.physics), BigInt(base));
  return Number(BigInt(up.physics) - BigInt(down.physics));
}

function verifyBrowser(report, supported) {
  const {browser, runConfiguration, publicCalls, inputEvidence, releaseId, pngs} = report;
  assert(report.status === 'passed' && report.engineExecuted && report.scriptExecuted === supported);
  assert(browser.name === 'chromium' && runConfiguration.presentationBackend === 'direct');
  assert(report.steps.length && report.steps.every(step => step.status === 'passed'));
  const call = id => byId(publicCalls, id);
  assert.deepEqual(pngs.map(sample => sample.position), (supported ? [64, 128, 64] : [128]).map(position));
  for (const sample of pngs) {
    const probe = supported ? byId(report.calls, sample.callId).replyProjection.result.data : call(sample.callId).reply.result;
    assert.deepEqual(fields(probe, ['run', 'frame', 'releaseId']), {run: sample.run, frame: sample.frame, releaseId});
    assert.deepEqual(probe.properties[0].value, sample.position);
  }
  if (!supported) {
    const old = inputEvidence.previousTemplate;
    assert.equal(old.scriptDispatchCount, 0);
    assert.equal(call(old.facadeCallId).reply.error.code, 'unsupported');
    assert.equal(call(old.directCallId).reply.error.code, 'unsupported');
    assert.equal(call(old.waitCallId).reply.result.operation.status, 'dispatched');
    return null;
  }

  const [before, after, reset] = pngs;
  const tutorial = byId(report.calls, inputEvidence.completedCallId);
  assert.deepEqual(tutorial.request, {op: 'engine.game_input', input: {action: 'script', events: requests.frameOffsets.events}});
  assert.deepEqual(before.run, after.run);
  assert.equal(before.playerInstanceId, after.playerInstanceId);
  assert.notEqual(before.run.runId, reset.run.runId);
  assert.equal(heldTicks(tutorial.replyProjection.result.data, before.run, releaseId), 4);

  const {publicFrameOffsets: offsets, holdMilliseconds: hold, unknownAction: unknown, stopped} = inputEvidence;
  for (const [id, input] of [[offsets.callId, requests.frameOffsets], [hold.callId, requests.holdMilliseconds],
    [unknown.callId, requests.unknownAction], [stopped.facadeCallId, requests.frameOffsets]]) {
    assert.deepEqual(call(id).request, {method: 'summer_call', input: {op: 'engine.game_input', input}});
  }
  const publicTicks = heldTicks(call(offsets.callId).reply.result.data, offsets.run, releaseId);
  assert.equal(publicTicks, 4);
  const held = call(hold.callId).reply.error;
  assert.equal(held.code, 'unsupported');
  assert.equal(held.details.godotai.parameter, 'events[0].hold_ms');
  assert.deepEqual(hold.dispatches, []);
  const rejected = call(unknown.callId).reply.error;
  assert.equal(rejected.code, 'unknown_action');
  const rejection = rejected.details.godotai.receipt;
  assert.deepEqual(rejection.receipt.run, unknown.run, 'Unknown-action receipt belongs to a different run');
  assert.equal(rejection.receipt.releaseId, releaseId, 'Unknown-action receipt belongs to a different release');
  assert.deepEqual(unknown.dispatches, [{type: 'input-script-request', runId: unknown.run.runId}], 'Expected one unknown-action dispatch to the sampled run');
  assert.equal(rejection.outcome, 'not_executed');
  assert.deepEqual(rejection.terminal, {kind: 'not_executed', source: 'native', reason: 'unknown_action'});
  const noRun = call(stopped.facadeCallId).reply.error;
  assert.equal(noRun.code, 'not_ready');
  assert.equal(call(stopped.directCallId).reply.error.code, 'run_ended');
  assert.equal(call(stopped.mainCallId).reply.result.data.playing, false);
  assert.deepEqual(stopped.dispatches, []);
  for (const [evidence, start, end] of [[offsets, 128, 192], [hold, 64, 64], [unknown, 64, 64]]) {
    const samples = [evidence.beforeCallId, evidence.afterCallId].map(id => call(id).reply.result);
    assert(samples.every(sample => sample.releaseId === releaseId));
    assert.deepEqual(samples.map(sample => sample.run), [evidence.run, evidence.run]);
    assert.equal(samples[0].properties[0].instanceId, samples[1].properties[0].instanceId);
    assert.deepEqual(samples.map(sample => sample.properties[0].value), [position(start), position(end)]);
  }
  return {heldTicks: publicTicks, positions: [before.position, after.position, reset.position],
    hold: held.code, unknown: rejected.code, stopped: noRun.code};
}

async function verifyNative(directory, native, cases, playground) {
  assert.equal(native.toolkit.version, '4.9.2');
  assert.equal(native.toolkit.commit, '5d0bc70c6228a2f718485913449f20482434b47b');
  if (native.stage !== 'run') return 'partial';
  assert.equal(native.editor.version, '0.8.8');
  assert(hashPattern.test(native.editor.binary.sha256) && hashPattern.test(native.toolkit.cliSha256));
  assert.deepEqual(native.cleanupErrors, []);
  for (const call of native.calls) {
    for (const stream of ['stdout', 'stderr']) await readFile(await evidenceFile(directory, call[stream]));
  }

  async function operation(ref, name, op, input, success = true) {
    const stream = success ? 'stdout' : 'stderr';
    const call = native.calls.find(item => relative(item[stream]) === relative(ref));
    assert.equal(call?.name, name, ref);
    assert.equal(call.code, success ? 0 : 1);
    assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--input') + 1]), input);
    const reply = await readJson(await evidenceFile(directory, ref));
    return operationResult(reply, op, success);
  }

  async function readRun(runId) {
    const run = native.runs.find(item => item.runId === runId);
    const data = await readFile(await evidenceFile(directory, run.trace), 'utf8');
    const rows = data.trimEnd().split('\n').map(line => JSON.parse(line));
    assert(rows.every(row => row.runId === runId && row.pid === run.instance.pid && row.physicsTicksPerSecond === 60));
    assert.deepEqual(rows[0], run.ready);
    assert.deepEqual(rows[0].position, position(64));
    return {run, rows};
  }

  async function scriptEdges(collected, input) {
    const receipt = await operation(collected.call, 'game-input', 'SimulateInputScript', input);
    assert.deepEqual(receipt, collected.receipt);
    assert(receipt.completed === true && receipt.applied === input.events.length);
    assert.deepEqual(receipt.rejected, []);
    const {run, rows} = await readRun(collected.runId);
    const edges = rows.filter(row => row.action === input.events[0].action);
    assert.deepEqual(edges, [collected.pressed, collected.released]);
    const [pressed, released] = edges;
    assert(pressed.edge === 'pressed' && released.edge === 'released');
    const ticks = released.physicsFrame - pressed.physicsFrame;
    assert(Number.isSafeInteger(ticks) && ticks > 0);
    assert.equal(ticks, released.heldTicks);
    return {ticks, pressed, released, run, scheduledDelta: receipt.last_frame - receipt.first_frame};
  }

  const frame = native.cases.frameOffsets;
  if (['passed', 'difference'].includes(frame.status)) {
    const {ticks, pressed, released, scheduledDelta} = await scriptEdges(frame, requests.frameOffsets);
    const restart = await readRun(frame.restartRunId);
    assert.notEqual(frame.runId, frame.restartRunId);
    assert.equal(native.images.length, 3);
    const positions = [pressed.position, released.position, restart.run.ready.position];
    const runIds = [frame.runId, frame.runId, frame.restartRunId];
    for (const [index, sample] of native.images.entries()) {
      const raw = await operation(sample.call, 'game-probe', 'GameProbe',
        {instance: 'main', props: [playerPath + ':position'], screenshot: true, max_dim: 512});
      checkProbeImageFrame(raw);
      assert.equal(sample.runId, runIds[index]);
      assert.deepEqual([sample.frame, sample.imageFrame, sample.rawPosition],
        [raw.frame, raw.image_frame, raw.values[playerPath + ':position']]);
      assert.deepEqual(sample.position, parseProbePosition(sample.rawPosition));
      assert.deepEqual(sample.position, positions[index]);
    }
    assert(native.images[0].frame.physics_frames < pressed.physicsFrame);
    assert(native.images[1].frame.physics_frames >= released.physicsFrame);
    const displacement = released.position.x - pressed.position.x;
    const matched = frame.status === 'passed' && ticks === playground.heldTicks &&
      scheduledDelta === 4 && canonical(positions) === canonical(playground.positions);
    Object.assign(cases.frameOffsets, {summer: matched ? 'passed' : 'difference', heldTicks: ticks,
      positions, displacement, scheduledDelta,
      comparison: matched ? 'same_observed_held_ticks_displacement_and_reset' : 'different_observed_timing_or_movement'});
  } else cases.frameOffsets.summer = frame.status;

  for (const [name, key] of [['holdMillisecondsDefault', 'summerDefault'], ['holdMillisecondsFixed', 'summerFixed']]) {
    const collected = native.cases[name];
    const result = {status: collected.status, reason: collected.error};
    if (collected.status === 'passed') {
      const {ticks, run} = await scriptEdges(collected, requests.holdMilliseconds);
      result.heldTicks = ticks;
      if (name === 'holdMillisecondsFixed') {
        assert(![frame.runId, frame.restartRunId].includes(run.runId));
        const launch = await operation(run.play, 'play', 'PlayGame', {scene: 'res://main.tscn', instance: 'main', focus: true, fixed_fps: 60});
        assert(launch.determinism.applied && launch.determinism.fixed_fps === 60);
        assert.equal(launch.runtimeFreshness.pid, run.instance.pid);
      } else assert.equal(run.runId, frame.restartRunId);
    }
    cases.holdMilliseconds[key] = result;
  }
  const {summerDefault, summerFixed} = cases.holdMilliseconds;
  if (summerDefault.status === 'passed' && summerFixed.status === 'passed')
    cases.holdMilliseconds.comparison = 'summer_applies_request_playground_rejects_before_dispatch';

  for (const [name, input, reason, comparison] of [
    ['unknownAction', requests.unknownAction, 'all_rejected', 'both_reject_unknown_action'],
    ['notRunning', requests.frameOffsets, 'game_not_running', 'both_reject_when_no_game_is_running'],
  ]) {
    const collected = native.cases[name];
    cases[name].summer = collected.status;
    if (collected.status === 'passed') {
      const receipt = await operation(collected.call, 'game-input', 'SimulateInputScript', input, false);
      if (collected.receipt) assert.deepEqual(receipt, collected.receipt);
      assert.equal(receipt.failure_reason, reason);
      if (name === 'unknownAction') checkUnknownAction(receipt, input.events);
      cases[name].nativeCode = reason;
      cases[name].comparison = comparison;
    }
  }

  const statuses = [cases.frameOffsets.summer, summerDefault.status, summerFixed.status, cases.unknownAction.summer, cases.notRunning.summer];
  if (statuses.includes('failed') || native.status === 'failed' || native.error) return 'failed';
  if (statuses.includes('difference') || native.status === 'difference') return 'difference';
  if (statuses.every(status => status === 'passed') && native.status === 'passed') return 'passed';
  return 'partial';
}

async function verify(root, summary) {
  const reports = path.join(root, 'reports');
  const results = {};
  for (const variant of ['new', 'old']) {
    const candidate = await verifyCandidate(root, variant);
    summary.templates[variant] = candidate;
    const preflight = await readJson(path.join(reports, variant, 'site-start.json'));
    assert.deepEqual(fields(preflight, siteFields), fields(candidate, siteFields));
    assert.equal(digest(canonical(preflight.payloads)), candidate.siteHash);
    assert(preflight.acceptanceBatchId);
    assert(Object.values(preflight.testSources).every(digest => hashPattern.test(digest)));
    const priorRuns = new Set();
    for (const name of [variant, 'replay-' + variant]) {
      const reportPath = 'reports/' + name + '/report.json';
      const report = await readJson(path.join(root, reportPath));
      assert.equal(report.acceptanceBatchId, preflight.acceptanceBatchId);
      assert.deepEqual(fields(report, siteFields), fields(candidate, siteFields));
      results[name] = verifyBrowser(report, variant === 'new');
      for (const {run} of report.runs) {
        assert(!priorRuns.has(run.runId), 'Replay reused an original run: ' + run.runId);
        priorRuns.add(run.runId);
      }
      summary.browser[name] = {status: report.status, ...fields(report, siteFields), acceptanceBatchId: report.acceptanceBatchId,
        browser: report.browser.version, positions: report.pngs.map(png => png.position), report: reportPath};
    }
  }
  assert.equal(summary.templates.old.sdkHash, summary.templates.new.sdkHash);
  assert.equal(summary.templates.old.sdkSourceHash, summary.templates.new.sdkSourceHash);
  assert.deepEqual(results.new, results['replay-new']);

  const g0Path = 'reports/g0/input-script-g0.json';
  const g0 = await readJson(path.join(root, g0Path));
  assert.equal(g0.status, 'passed');
  assert.equal(g0.engineExecuted, true);
  assert.equal(g0.engineReportSha256, summary.templates.new.reportHash);
  assert.equal(g0.templateSha256, summary.templates.new.sha256);
  assert.equal(g0.cases.length, 19);
  assert.equal(new Set(g0.cases.map(item => item.name)).size, 19);
  summary.g0 = {status: g0.status, cases: g0.cases.length, templateSha256: g0.templateSha256, report: g0Path};

  const manualPath = 'reports/manual-archive/report.json';
  const manual = await optionalReport(path.join(root, manualPath));
  summary.manual = {status: 'not_run'};
  if (manual) {
    assert.equal(manual.status, 'passed');
    assert.equal(manual.releaseId, summary.templates.new.releaseId);
    assert.deepEqual([manual.before, manual.after], [position(64), position(128)]);
    assert.equal(BigInt(manual.input.up.physics) - BigInt(manual.input.down.physics), 4n);
    assert.equal(manual.exit.report.sessionFacts.nativeExit.code, 0);
    summary.manual = {status: manual.status, releaseId: manual.releaseId, report: manualPath};
  }

  const pixelScript = fileURLToPath(new URL('./verify-summer-pixels.py', import.meta.url));
  const {stdout} = await promisify(execFile)(process.env.PYTHON ?? 'python3', [pixelScript, root]);
  const pixels = JSON.parse(stdout);
  assert.equal(pixels.status, 'passed');
  await writeFile(path.join(root, 'verification-pixels.json'), JSON.stringify(pixels, null, 2) + '\n');
  summary.pixels = 'verification-pixels.json';

  const playground = results.new;
  summary.cases = {
    frameOffsets: {playground: 'completed', playgroundHeldTicks: playground.heldTicks, summer: 'not_run'},
    holdMilliseconds: {playground: playground.hold, dispatches: 0, summerDefault: {status: 'not_run'}, summerFixed: {status: 'not_run'}},
    unknownAction: {playground: playground.unknown, summer: 'not_run'},
    notRunning: {playground: playground.stopped, summer: 'not_run'},
  };
  const nativePath = 'reports/summer-native/report.json';
  const native = await optionalReport(path.join(root, nativePath));
  if (!native) {
    summary.summer = {status: 'not_run'};
    return 'partial';
  }
  summary.summer = {status: native.status, stage: native.stage, report: nativePath, host: fields(native.host, ['platform', 'arch', 'node', 'runnerLabel']),
    editorVersion: native.editor?.version, toolkitVersion: native.toolkit.version,
    editorSha256: native.editor?.binary.sha256, interruption: native.cases.interruption.status};
  return verifyNative(path.join(reports, 'summer-native'), native, summary.cases, playground);
}

const args = process.argv.slice(2);
if (args.length > 1 || args[0] === '--help') {
  console.log('Usage: node verify-summer-compat.mjs [EVIDENCE_ROOT]');
  process.exit(args.length > 1 ? 1 : 0);
}
const root = await realpath(path.resolve(args[0] ?? '.'));
const summary = {status: 'failed', scope: 'Chromium Full Engine debug Dedicated Worker Direct', templates: {}, browser: {}};
try {
  summary.status = await verify(root, summary);
} catch (error) {
  summary.error = String(error.message ?? error).replaceAll(root + path.sep, '');
}
const output = JSON.stringify(summary, null, 2) + '\n';
await writeFile(path.join(root, 'verification-summary.json'), output);
process.stdout.write(output);
if (summary.status !== 'passed') process.exitCode = 1;
