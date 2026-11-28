import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionFacts, factsFromRuntimeSummary, factsFromRuntimeSummaries, isRuntimeSummary,
  isSessionFacts, runtimeSummaryCleanup, sessionExitReason,
} from '../dist/session-facts.js';
import {canSettleEmptyRuntimeFailureCapture} from '../dist/browser/dedicated/worker-session.js';

const fatal = (message = 'fatal') => ({kind: 'runtime', message});
const entry = (cleanup = 'complete', state = 'closed') => ({entryId: 'entry-1', state, cleanup});
const summary = (overrides = {}) => ({schemaVersion: 1, epoch: 'native-1', sealed: true, entries: [entry()], overflow: false, ...overrides});
const complete = (overrides = {}) => factsFromRuntimeSummary(summary(), {nativeExit: {code: 0}, hostCleanup: 'complete', ...overrides});

test('complete exit requires both a sealed runtime observation and successful registered cleanup', () => {
  assert.equal(sessionExitReason(complete()), 'clean-exit');
  assert.equal(sessionExitReason(factsFromRuntimeSummary(summary({entries: []}), {nativeExit: {code: 0}, hostCleanup: 'complete'})), 'clean-exit');
  assert.equal(runtimeSummaryCleanup(summary({entries: []})), 'not-applicable');
  for (const observation of [undefined, summary({sealed: false}), summary({overflow: true}), summary({entries: [entry('pending', 'starting')]}), summary({entries: [entry('complete', 'ready')]})]) {
    assert.equal(sessionExitReason(factsFromRuntimeSummary(observation, {nativeExit: {code: 0}, hostCleanup: 'complete'})), 'cleanup-unconfirmed');
  }
  assert.equal(sessionExitReason(createSessionFacts()), 'cleanup-unconfirmed');
});

test('fatal and forced termination remain independent of a late native exit zero', () => {
  const failure = fatal('first observed failure');
  const facts = complete({failure, forcedTerminationIssued: true});
  assert.equal(sessionExitReason(facts), 'crashed');
  assert.equal(facts.forcedTerminationIssued, true);
  assert.deepEqual(facts.nativeExit, {code: 0});
  assert.equal(sessionExitReason(complete({forcedTerminationIssued: true})), 'forced-worker-termination');
  assert.equal(sessionExitReason(complete({nativeExit: {code: 12}})), 'crashed');
  assert.equal(sessionExitReason(factsFromRuntimeSummary(summary({failure: fatal('late summary')}), {failure, nativeExit: {code: 0}, hostCleanup: 'complete'})), 'crashed');
  assert.equal(factsFromRuntimeSummary(summary({failure: fatal('later')}), {failure}).failure.message, failure.message);
});

test('cleanup failure and missing observations do not become successful exit zero', () => {
  assert.equal(sessionExitReason(factsFromRuntimeSummary(summary({entries: [entry('failed')]}), {nativeExit: {code: 0}, hostCleanup: 'complete'})), 'crashed');
  assert.equal(sessionExitReason(complete({hostCleanup: 'failed'})), 'host-cleanup-failed');
  assert.equal(sessionExitReason(complete({hostCleanup: 'timed-out'})), 'host-cleanup-failed');
  assert.equal(sessionExitReason(complete({hostCleanup: 'unconfirmed'})), 'cleanup-unconfirmed');
  assert.equal(sessionExitReason(createSessionFacts({runtimeSummary: 'not-tracked', nativeExit: {code: 0}, hostCleanup: 'complete', entryCleanup: 'not-applicable'})), 'cleanup-unconfirmed');
});

test('the source inventory must be complete before multiple native epochs certify a session', () => {
  const engine = summary(), worker = summary({epoch: 'script-worker-1', entries: []});
  const facts = {nativeExit: {code: 0}, hostCleanup: 'complete'};
  assert.equal(sessionExitReason(factsFromRuntimeSummaries([engine, worker], {...facts, allSourcesSealed: true})), 'clean-exit');
  assert.equal(sessionExitReason(factsFromRuntimeSummaries([engine], {...facts, allSourcesSealed: false})), 'cleanup-unconfirmed');
  assert.equal(sessionExitReason(factsFromRuntimeSummaries([], {...facts, allSourcesSealed: true})), 'cleanup-unconfirmed');
  assert.equal(sessionExitReason(factsFromRuntimeSummaries([engine, {...worker, failure: fatal('worker failed')}], {...facts, allSourcesSealed: true})), 'crashed');
});

test('facts own frozen copies and never replace their first failure with mutable producer state', () => {
  const failure = fatal(), nativeExit = {code: 0};
  const facts = complete({failure, nativeExit});
  failure.message = 'changed'; nativeExit.code = 7;
  assert.equal(facts.failure.message, 'fatal'); assert.equal(facts.nativeExit.code, 0);
  assert(Object.isFrozen(facts)); assert(Object.isFrozen(facts.failure)); assert(Object.isFrozen(facts.nativeExit));
  assert.throws(() => {facts.failure.message = 'changed';}, TypeError);
});

test('wire validation rejects accessors, unknown fields, malformed enums and forged summaries without running getters', () => {
  let reads = 0;
  const getter = {get kind() {reads++; return 'runtime';}, message: 'no'};
  assert.equal(isSessionFacts({...complete(), failure: getter}), false);
  assert.equal(isRuntimeSummary(summary({failure: getter})), false);
  const enumObject = {toString() {reads++; return 'sealed';}};
  assert.equal(isSessionFacts({...complete(), runtimeSummary: enumObject}), false);
  const accessorEntries = []; Object.defineProperty(accessorEntries, '0', {enumerable: true, get() {reads++; return entry();}});
  assert.equal(isRuntimeSummary(summary({entries: accessorEntries})), false);
  assert.equal(reads, 0);
  for (const value of [{...complete(), unexpected: true}, {...complete(), nativeExit: {code: 0, other: true}}, {...complete(), failure: {kind: 'caught', message: 'not fatal'}}, {...complete(), schemaVersion: 2}]) assert.equal(isSessionFacts(value), false);
  for (const value of [summary({entries: [entry(), entry()]}), summary({entries: Array(129).fill(entry())}), summary({epoch: ''}), summary({failure: {kind: 'unknown', message: 'no'}}), summary({entries: [{...entry(), extra: true}]}), summary({entries: new Array(1)})]) assert.equal(isRuntimeSummary(value), false);
  assert.throws(() => createSessionFacts({nativeExit: {code: NaN}}), /E_SESSION_FACTS/);
  assert.throws(() => factsFromRuntimeSummary(summary({schemaVersion: 2})), /E_RUNTIME_SUMMARY/);
});

test('an empty failure capture requires a sealed native epoch', () => {
  assert.equal(canSettleEmptyRuntimeFailureCapture(summary(), 0), true);
  assert.equal(canSettleEmptyRuntimeFailureCapture(summary(), 1), false);
  for (const state of [undefined, summary({epoch: 'untracked'}), summary({sealed: false}), summary({overflow: true}), summary({failure: fatal()})]) {
    assert.equal(canSettleEmptyRuntimeFailureCapture(state, 0), false);
  }
});
