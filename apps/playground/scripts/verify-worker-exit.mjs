import assert from 'node:assert/strict';

const runFields = ['runId', 'revision', 'buildKey', 'generation', 'documentId', 'workerId', 'runConfigurationHash'];
const runIdentity = run => Object.fromEntries(runFields.map(field => [field, run[field]]));

export function verifyCleanExit(run, exit) {
  const {runId} = run;
  assert.equal(exit?.evidence, 'host-report', `Missing host exit receipt: ${runId}`);
  assert.deepEqual(runIdentity(exit.report ?? {}), runIdentity(run), 'Exit receipt belongs to a different Worker session');
  const facts = exit.report?.sessionFacts;
  // Apply the clean-exit conditions from packages/engine/src/session-facts.ts to the archived facts.
  assert.equal(facts?.schemaVersion, 1, `Missing or unsupported session facts: ${runId}`);
  assert.equal(facts.failure, undefined, `Runtime reported a failure: ${runId}`);
  assert.deepEqual(facts.nativeExit, {code: 0}, `Native exit did not succeed: ${runId}`);
  assert.equal(facts.hostCleanup, 'complete', `Host cleanup was incomplete: ${runId}`);
  assert.equal(facts.forcedTerminationIssued, false, `Expected a cooperative exit: ${runId}`);
  assert.equal(facts.runtimeSummary, 'sealed', `Runtime summary was not sealed: ${runId}`);
  assert(['complete', 'not-applicable'].includes(facts.entryCleanup), `Entry cleanup was incomplete: ${runId}`);
  assert.equal(exit.report.reason, 'clean-exit', `Expected a clean exit: ${runId}`);
}
