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
  const original = {...run, projectId, runId: 'original', revision: 1, state: 'running'};
  const first = {run, sourceHash, projectId, editorRevision: 3, attemptId: 'new'};
  const error = {code: 2322, location: {file: '/src/Player.ts', line: 2, column: 7}};
  const diagnostics = {observed: true, items: [error]};
  const script = {projectId, path: 'res://src/Player.ts', status: 'completed'};
  const steps = [
    ['original', 'wait_for_event', {outcome: 'reached', run: original}],
    ['invalidCheck', 'engine.get_script_errors', {...script, editorRevision: 2, sourceHash: brokenHash, diagnostics}],
    ['failed', 'engine.get_diagnostics', {projectId, editorRevision: 2,
      build: {status: 'failed', sourceHash: brokenHash}, run: null}],
    ['repairedCheck', 'engine.get_script_errors', {...script, editorRevision: 3, sourceHash,
      diagnostics: {observed: true, counts: {error: 0}}}],
    ['launched', 'engine.get_diagnostics', {projectId, editorRevision: 3,
      build: {attemptId: 'new', status: 'succeeded', sourceHash}, run: {identity: run}}],
  ];
  const evidence = {repair: {...Object.fromEntries(steps.map(([id]) => [id, id])), stillRunning: original},
    calls: steps.map(([callId, op, data]) => ({callId, request: op.startsWith('engine.') ? {op} : {method: op},
      reply: {ok: true, status: 'done', result: op.startsWith('engine.') ? {data} : data}}))};
  verifyDiagnosticRepair(evidence, first);
  verifyDiagnosticRepair({...evidence, calls: [...evidence.calls].reverse()}, first);
  for (const [id, update, message] of [
    ['invalidCheck', data => {data.diagnostics.items[0].location.file = '/src/Other.ts';}, /did not locate TS2322/],
    ['failed', data => {data.run = {identity: original};}],
    ['repairedCheck', data => {data.diagnostics.counts.error = 1;}, /still reports errors/],
    ['launched', data => {data.build.sourceHash = brokenHash;}],
  ]) {
    const edited = structuredClone(evidence);
    update(edited.calls.find(call => call.callId === id).reply.result.data);
    assert.throws(() => verifyDiagnosticRepair(edited, first), message);
  }
});
