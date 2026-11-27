import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyLifecycleCleanExit} from './verify-lifecycle-events.mjs';

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
