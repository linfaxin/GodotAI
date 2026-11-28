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

export function verifyDiagnosticRepair(report, first) {
  const repair = report.repair;
  assert(repair, 'Missing diagnostic repair evidence');
  function readSummer(key, op) {
    const call = report.calls.find(call => call.callId === repair[key]);
    assert.equal(call?.request.op, op, 'Unexpected repair operation for ' + key);
    assert.equal(call.reply.ok, true);
    assert.equal(call.reply.status, 'done');
    const data = call.reply.result.data;
    assert.equal(data.projectId, first.projectId);
    return data;
  }

  const original = report.calls.find(call => call.callId === repair.original);
  assert.equal(original?.request.method, 'wait_for_event');
  assert.equal(original.reply.ok, true);
  const {outcome, run} = original.reply.result;
  assert.equal(outcome, 'reached');
  assert.equal(run.projectId, first.projectId);
  assert.equal(run.state, 'running');
  assertSameRun(run, repair.stillRunning);
  assert.equal(repair.stillRunning.state, 'running');
  assert.notEqual(first.run.runId, run.runId);

  const broken = readSummer('invalidCheck', 'engine.get_script_errors');
  const repaired = readSummer('repairedCheck', 'engine.get_script_errors');
  for (const check of [broken, repaired]) {
    assert.equal(check.path, 'res://src/Player.ts');
    assert.equal(check.status, 'completed');
    assert.equal(check.diagnostics.observed, true);
  }
  assert(broken.diagnostics.items.some(item => item.code === 2322 && item.location?.file === '/src/Player.ts' &&
    item.location.line === 2 && item.location.column === 7), 'Script check did not locate TS2322');
  assert(run.revision < broken.editorRevision && broken.editorRevision < first.editorRevision);
  const failed = readSummer('failed', 'engine.get_diagnostics');
  assert.equal(failed.editorRevision, broken.editorRevision);
  assert.equal(failed.build.status, 'failed');
  assert(hash.test(broken.sourceHash));
  assert.equal(failed.build.sourceHash, broken.sourceHash);
  assert.equal(failed.run, null);

  assert.equal(repaired.editorRevision, first.editorRevision);
  assert.equal(repaired.diagnostics.counts.error, 0, 'Script check still reports errors after repair');
  assert.equal(repaired.sourceHash, first.sourceHash);
  assert.notEqual(first.sourceHash, broken.sourceHash);
  const launched = readSummer('launched', 'engine.get_diagnostics');
  assert.equal(launched.editorRevision, first.editorRevision);
  assert.equal(launched.build.status, 'succeeded');
  assert.equal(launched.build.sourceHash, first.sourceHash);
  assert.equal(launched.build.attemptId, first.attemptId);
  assertSameRun(first.run, launched.run.identity);
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
    verifyDiagnosticRepair(report, first);
  const contextOp = 'engine.get_project_context';
  const contextCalls = report.calls.filter(({request: {op, input}}) =>
    op === contextOp && Array.isArray(input?.include) && input.include.includes('capabilities'));
  assert.equal(contextCalls.length, 3, 'Expected three capability query receipts');
  const [beforePlay, running, stopped] = contextCalls.map(({callId}) => {
    const {index, data} = read(callId, contextOp);
    assert.equal(data.projectId, first.projectId);
    assert(data.capabilityDetails, 'Missing capability details');
    return {index, activeRunId: data.activeRunId, details: data.capabilityDetails};
  });
  const firstPlayIndex = report.calls.findIndex(call => call.request.op === 'engine.play');
  assert(beforePlay.index < firstPlayIndex, 'Expected a capability query before the first Play');
  assert(stopped.index > verified[1].waitIndex && stopped.index < verified[2].cursorIndex,
    'Expected a capability query after exit');
  for (const query of [beforePlay, stopped]) {
    assert.equal(query.activeRunId, null);
    assert.equal(query.details.run, null);
  }
  const {operations} = beforePlay.details;
  assert(operations.includes('engine.game_probe') && operations.includes('engine.game_input'));
  assert.deepEqual(running.details.operations, operations);
  assert.deepEqual(stopped.details.operations, operations);
  const {run, pendingAttemptId} = running.details;
  assert.equal(pendingAttemptId, null);
  assert.equal(running.activeRunId, first.run.runId);
  assert.equal(run?.runId, first.run.runId);
  assert.equal(run.projectId, first.projectId);
  assert.equal(run.revision, first.editorRevision);
  assert.equal(run.releaseId, first.releaseId);
  assert.equal(run.state, 'running');
  for (const capability of [run.capabilities.gameProbe, run.capabilities.inputScript]) {
    assert.equal(capability.supported, true);
    assert.equal(capability.ready, true);
  }
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
  assert(running.index > verified[0].waitIndex && running.index < before.probe.index,
    'Expected a capability query after startup and before the first probe');
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
