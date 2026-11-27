import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {realpathSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isWorkerRunIdentity, sameWorkerRun} from '@godot-js/engine/browser/dedicated/worker-protocol';
import inputCases from './fixtures/summer-input-cases.json' with {type: 'json'};
import {verifyCleanExit} from './verify-worker-exit.mjs';

const hash = /^[a-f0-9]{64}$/;
const stages = ['play.started', 'play.stopped', 'play.started', 'play.stopped'];

function assertSameRun(expected, observed) {
  assert(isWorkerRunIdentity(expected) && isWorkerRunIdentity(observed), 'Incomplete Worker identity');
  assert(sameWorkerRun(expected, observed), 'Evidence belongs to a different Worker session');
}

export function verifyLifecycleCleanExit(run, exit) {
  assertSameRun(run, exit?.report);
  verifyCleanExit(run, exit);
}

export function verifyDiagnosticRepair(report, first, startIndex, waitIndex) {
  const repair = report.repair;
  assert(repair, 'Missing diagnostic repair evidence');
  let previous = -1;
  function read(key, op, min = previous) {
    const index = report.calls.findIndex(call => call.callId === repair[key]);
    assert(index > min, 'Missing or out-of-order repair call: ' + key);
    const {request, reply} = report.calls[index];
    const operation = request.op ?? request.method;
    assert(operation === op || op === 'check' && operation === 'engine.get_script_errors', 'Unexpected repair operation for ' + key);
    assert.equal(reply.ok, true);
    previous = index;
    const data = request.op ? reply.result.data : reply.result;
    if (operation === 'engine.get_script_errors') {
      assert.equal(request.input?.path, 'res://src/Player.ts');
      assert.equal(data.path, request.input.path);
      assert.equal(data.status, 'completed');
      assert.equal(data.diagnostics.observed, true);
    }
    return data;
  }
  const initial = read('initial', 'engine.play');
  const original = read('original', 'wait_for_event');
  assert.equal(initial.accepted, true);
  assert.equal(original.outcome, 'reached');
  assert.equal(original.run.attemptId, initial.attemptId);
  assert.equal(original.run.state, 'running');
  assertSameRun(original.run, repair.stillRunning);
  assert.equal(repair.stillRunning.state, 'running');
  const invalidCheck = read('invalidCheck', 'check');
  const invalid = read('invalid', 'engine.get_diagnostics');
  const rejected = read('rejected', 'engine.play');
  const noSession = read('noSession', 'wait_for_event');
  const failed = read('failed', 'engine.get_diagnostics');
  const repairedCheck = read('repairedCheck', 'check');
  const repaired = read('repaired', 'engine.get_diagnostics');
  assert(previous < startIndex, 'Repair check must precede Play');
  const launched = read('launched', 'engine.get_diagnostics', waitIndex);
  const project = first.projectId;
  for (const record of [initial, invalidCheck, invalid, rejected, failed, repairedCheck, repaired, launched])
    assert.equal(record.projectId, project);
  for (const record of [invalidCheck, rejected, failed]) assert.equal(record.editorRevision, invalid.editorRevision);
  for (const record of [repairedCheck, repaired, launched]) assert.equal(record.editorRevision, first.editorRevision);
  assert(initial.editorRevision < invalid.editorRevision && invalid.editorRevision < first.editorRevision);
  assert(hash.test(invalidCheck.sourceHash));
  assert.equal(invalid.check.sourceHash, invalidCheck.sourceHash);
  assert.equal(invalid.run, null);
  assert(invalid.check.diagnostics.observed);
  assert(invalid.check.diagnostics.items.some(item => item.code === 2322 &&
    item.location?.file === '/src/Player.ts' && item.location.line === 2), 'Missing located TS2322');
  assert.equal(rejected.accepted, true);
  assert.equal(noSession.outcome, 'no_session');
  assert.equal(noSession.run, undefined);
  assert.equal(noSession.build.attemptId, rejected.attemptId);
  assert.equal(failed.build.attemptId, rejected.attemptId);
  assert.equal(failed.build.status, 'failed');
  assert.equal(failed.build.sourceHash, invalidCheck.sourceHash);
  assert(failed.build.diagnostics.items.some(item => item.code === 2322));
  assert.equal(failed.run, null);
  assert.equal(repaired.check.diagnostics.observed, true);
  assert.equal(repaired.check.diagnostics.counts.error, 0);
  assert.notEqual(first.sourceHash, invalidCheck.sourceHash);
  for (const record of [repaired.check, repairedCheck, launched.check, launched.build])
    assert.equal(record.sourceHash, first.sourceHash);
  assert.equal(launched.check.diagnostics.observed, true);
  assert.equal(launched.check.diagnostics.counts.error, 0);
  assert.equal(launched.build.attemptId, first.attemptId);
  assertSameRun(first.run, launched.run.identity);
  assert.notEqual(first.run.runId, original.run.runId);
}

export function verifyLifecycleCalls(report) {
  const calls = new Map(report.calls.map((call, index) => [call.callId, {...call, index}]));
  assert.equal(calls.size, report.calls.length, 'Duplicate call ID');
  function read(id, op) {
    const call = calls.get(id);
    assert.equal(call?.request.op, op, 'Unexpected operation for ' + id);
    assert.equal(call.reply.ok, true, 'Operation did not succeed: ' + id);
    assert.equal(call.reply.status, 'done');
    return {...call, data: call.reply.result.data};
  }

  assert.equal(report.phases.length, stages.length);
  const verified = [];
  let streamId, previousIndex = -1, previousEvent = 0;
  for (const [index, phase] of report.phases.entries()) {
    const kind = stages[index], starting = kind === 'play.started';
    const cursor = read(phase.cursorCallId, 'engine.recent_events');
    const action = read(phase.actionCallId, starting ? 'engine.play' : 'engine.stop');
    assert(cursor.index > previousIndex && cursor.index < action.index);
    assert.equal(action.data.accepted, true);
    streamId ??= cursor.data.stream_id;
    assert(typeof streamId === 'string' && streamId.length > 0);
    assert.equal(cursor.data.stream_id, streamId);
    const previousStart = verified.at(-1);
    const matches = event => event.kind === kind && (starting
      ? event.data.attemptId === action.data.attemptId && event.data.projectId === action.data.projectId &&
        event.data.editorRevision === action.data.editorRevision
      : event.data.run.runId === previousStart.event.data.run.runId);
    let since = cursor.data.next_seq, callIndex = action.index, matched;
    assert(Number.isSafeInteger(since) && since >= previousEvent);
    assert(phase.waitCallIds.length > 0);
    for (const id of phase.waitCallIds) {
      const wait = read(id, 'engine.wait_for_event'), input = wait.request.input;
      assert(wait.index > callIndex && !matched, 'Unexpected wait after matching the target');
      assert.deepEqual(input.kinds, [kind]);
      assert.equal(input.stream_id, streamId);
      assert.equal(wait.data.stream_id, streamId);
      assert.equal(input.since, since);
      assert.equal(wait.data.since, since);
      assert.equal(wait.data.gap, undefined);
      assert.equal(wait.data.matched, true);
      assert.equal(wait.data.timed_out, false);
      let lastSeq = since;
      for (const event of wait.data.events) {
        assert(Number.isSafeInteger(event.seq) && event.seq > lastSeq && event.seq <= wait.data.next_seq);
        assert.equal(event.kind, kind);
        assert(isWorkerRunIdentity(event.data.run), 'Incomplete Worker identity in event');
        lastSeq = event.seq;
      }
      assert(wait.data.events.length > 0 && Number.isSafeInteger(wait.data.next_seq));
      matched = wait.data.events.find(matches);
      since = wait.data.next_seq;
      callIndex = wait.index;
    }
    assert(matched && matched.seq === phase.matchedSeq && matched.seq > previousEvent, 'Missing lifecycle event for target');
    assert.equal(matched.data.releaseId, report.releaseId);
    assert(hash.test(matched.data.sourceHash));
    if (!starting) {
      const prior = previousStart.event.data;
      const target = action.data.runs.find(item => item.runId === prior.run.runId);
      assert(target?.receipt.ok, 'Stop receipt did not capture the expected run');
      assert.equal(target.receipt.result.runId, prior.run.runId);
      assertSameRun(prior.run, matched.data.run);
      for (const field of ['projectId', 'editorRevision', 'attemptId', 'sourceHash', 'artifactId'])
        assert.equal(matched.data[field], prior[field]);
      assert.equal(matched.data.startedObserved, true);
      verifyLifecycleCleanExit(prior.run, phase.exit);
      const {failure, ...facts} = phase.exit.report.sessionFacts;
      assert.deepEqual(matched.data.exit, {evidence: phase.exit.evidence, reason: phase.exit.report.reason,
        facts: {...facts, failureObserved: failure !== undefined}});
    }
    verified.push({event: matched, cursorIndex: cursor.index, waitIndex: callIndex});
    previousIndex = callIndex;
    previousEvent = matched.seq;
  }

  const first = verified[0].event.data, second = verified[2].event.data;
  if (report.repair || report.calls.some(call => call.request.op === 'engine.get_diagnostics'))
    verifyDiagnosticRepair(report, first, verified[0].cursorIndex, verified[0].waitIndex);
  assert.equal(first.sourceHash, second.sourceHash);
  for (const field of ['runId', 'documentId', 'workerId']) assert.notEqual(first.run[field], second.run[field]);
  assert.deepEqual(report.pngs.map(sample => sample.file), ['before.png', 'after.png', 'restart.png']);
  const [before, after, reset] = report.pngs.map((sample, index) => {
    const run = index < 2 ? first.run : second.run;
    const probe = read(sample.callId, 'engine.game_probe');
    assertSameRun(run, probe.data.run);
    assert.equal(probe.data.releaseId, report.releaseId);
    const frame = probe.data.frame;
    for (const field of ['iteration', 'renderSerial']) {
      assert(Number.isSafeInteger(frame[field]) && frame[field] > 0);
      assert.equal(probe.data.image[field], frame[field]);
    }
    assert.deepEqual(sample.frame, frame);
    const player = probe.data.properties.find(prop => prop.path === '/root/Main/Player' && prop.property === 'position');
    assert.deepEqual(player?.value, {x: [64, 128, 64][index], y: 256});
    assert.deepEqual(sample.position, player.value);
    assert.equal(sample.width, probe.data.image.width);
    assert.equal(sample.height, probe.data.image.height);
    assert.equal(sample.byteLength, probe.data.image.bytes?.byteLength);
    assert(hash.test(sample.sha256));
    const startIndex = index < 2 ? 0 : 2;
    assert(probe.index > verified[startIndex].waitIndex && probe.index < verified[startIndex + 1].cursorIndex);
    return {probe, player};
  });
  const motion = read(report.inputCallId, 'engine.game_input');
  assert.deepEqual({clock: 'frame', wait: true, ...motion.request.input}, inputCases.frameOffsets);
  assert.equal(motion.data.ok, true);
  assertSameRun(first.run, motion.data.receipt.run);
  assert.equal(motion.data.receipt.releaseId, report.releaseId);
  const {kind, base, down, up, releaseStepCompleted, finishedIteration} = motion.data.result;
  assert.equal(kind, 'completed');
  assert.equal(releaseStepCompleted, true);
  assert.equal(BigInt(down.physics), BigInt(base));
  assert.equal(BigInt(up.physics) - BigInt(down.physics), 4n);
  assert(before.probe.index < motion.index && motion.index < after.probe.index);
  assert.equal(before.player.instanceId, after.player.instanceId);
  assert(after.probe.data.frame.iteration > finishedIteration);
  assert(reset.probe.index > after.probe.index);
}

function verifyReport(reportPath, contextPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'playground-lifecycle-events');
  assert.equal(report.engineExecuted, true);
  assert(report.steps.length && report.steps.every(step => step.status === 'passed'));
  assert.equal(report.profile, 'full-engine-v1');
  assert.equal(report.browser.name, 'chromium');
  assert.equal(report.runConfiguration.presentationBackend, 'direct');
  for (const field of ['candidateId', 'descriptorHash', 'releaseId', 'siteHash', 'acceptanceBatchId']) {
    assert(typeof context[field] === 'string' && context[field].length > 0);
    assert.equal(report[field], context[field]);
  }
  assert.notEqual(report.editorOrigin, report.previewOrigin);
  assert(report.previewDocuments.length >= 2, 'Both runs must load a preview document');
  for (const response of report.previewDocuments) {
    const url = new URL(response.url);
    assert.equal(url.origin, report.previewOrigin);
    assert(url.pathname.endsWith('/preview.html'));
    assert.equal(url.searchParams.get('editorOrigin'), report.editorOrigin);
    assert.equal(response.status, 200);
  }
  verifyLifecycleCalls(report);
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', [
    fileURLToPath(new URL('./verify-summer-pixels.py', import.meta.url)), '--playground-report', reportPath,
  ], {encoding: 'utf8'}));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportPath, contextPath] = process.argv.slice(2);
  assert(reportPath && contextPath, 'Usage: node verify-lifecycle-events.mjs REPORT SITE_START');
  console.log(JSON.stringify(verifyReport(path.resolve(reportPath), path.resolve(contextPath)), null, 2));
}
