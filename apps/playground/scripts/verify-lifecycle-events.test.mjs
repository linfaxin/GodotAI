import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyDiagnosticRepair, verifyLifecycleCleanExit} from './verify-lifecycle-events.mjs';

test('exit verification rejects a Worker identity field missing from both receipts', () => {
  const run = {runId: 'run', documentId: 'document', workerId: 'worker', revision: 1, generation: 1,
    buildKey: 'build', runConfigurationHash: 'f'.repeat(64)};
  const exit = {evidence: 'host-report', report: {...run, reason: 'clean-exit', sessionFacts: {
    schemaVersion: 1, nativeExit: {code: 0}, hostCleanup: 'complete', forcedTerminationIssued: false,
    runtimeSummary: 'sealed', entryCleanup: 'complete',
  }}};
  verifyLifecycleCleanExit(run, exit);
  delete run.workerId;
  delete exit.report.workerId;
  assert.throws(() => verifyLifecycleCleanExit(run, exit), /Incomplete Worker identity/);
});

test('repair verification binds diagnostics and recovered run to the recorded versions', () => {
  const brokenHash = 'b'.repeat(64), sourceHash = 'c'.repeat(64), projectId = 'project';
  const run = {runId: 'run', documentId: 'document', workerId: 'worker', revision: 3, generation: 2,
    buildKey: 'build', runConfigurationHash: 'f'.repeat(64)};
  const original = {...run, runId: 'original', revision: 1, attemptId: 'initial', state: 'running'};
  const first = {run, sourceHash, projectId, editorRevision: 3, attemptId: 'new'};
  const error = {code: 2322, location: {file: '/src/Player.ts', line: 2}};
  const diagnostics = {observed: true, items: [error]};
  const broken = {projectId, editorRevision: 2, checkId: 'bad', sourceHash: brokenHash};
  const repaired = {projectId, editorRevision: 3, checkId: 'good', sourceHash};
  const check = {...repaired, diagnostics: {observed: true, counts: {error: 0}}};
  const steps = [
    ['initial', 'engine.play', {projectId, editorRevision: 1, accepted: true, attemptId: 'initial'}],
    ['original', 'wait_for_event', {outcome: 'reached', run: original}],
    ['invalidCheck', 'check', broken],
    ['invalid', 'engine.get_diagnostics', {...broken, check: {...broken, checkId: 'latest-bad', diagnostics}, run: null}],
    ['rejected', 'engine.play', {...broken, accepted: true, attemptId: 'failed'}],
    ['noSession', 'wait_for_event', {outcome: 'no_session', build: {attemptId: 'failed'}}],
    ['failed', 'engine.get_diagnostics', {...broken,
      build: {attemptId: 'failed', status: 'failed', sourceHash: brokenHash, diagnostics}, run: null}],
    ['repairedCheck', 'check', repaired],
    ['repaired', 'engine.get_diagnostics', {...repaired, check: {...check, checkId: 'latest-good'}}],
    ['cursor', 'engine.recent_events', {}],
    ['start', 'engine.wait_for_event', {}],
    ['launched', 'engine.get_diagnostics', {...repaired, check: {...check, checkId: 'build-check'},
      build: {attemptId: 'new', sourceHash}, run: {identity: run}}],
  ];
  const evidence = {repair: {...Object.fromEntries(steps.map(([id]) => [id, id])), stillRunning: original},
    calls: steps.map(([callId, op, data]) => ({callId, request: op.startsWith('engine.') ? {op} : {method: op},
      reply: {ok: true, result: op.startsWith('engine.') ? {data} : data}}))};
  verifyDiagnosticRepair(evidence, first, 9, 10);
  for (const [index, update] of [
    [3, data => {data.check.diagnostics.items[0].location.line = 4;}],
    [6, data => {data.run = {identity: original};}],
    [11, data => {data.build.sourceHash = brokenHash;}],
  ]) {
    const edited = structuredClone(evidence);
    update(edited.calls[index].reply.result.data);
    assert.throws(() => verifyDiagnosticRepair(edited, first, 9, 10));
  }
});
