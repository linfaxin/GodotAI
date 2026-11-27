import assert from 'node:assert/strict';
import test from 'node:test';
import {createDebugRecorder} from '../src/debug-api.ts';
import {createPlaygroundApi} from '../src/playground-api.ts';
import {createSummerDispatcher} from '../src/summer-adapter.ts';

const testOptions = {timeout: 5_000};

function fixture(t) {
  let now = 0;
  const recorder = createDebugRecorder(() => now);
  const playground = createPlaygroundApi(recorder, {
    supportsProject: () => true, check: () => undefined, play: () => undefined, stopRun: () => undefined,
    summerCall: (...args) => dispatch(...args),
  });
  const dispatch = createSummerDispatcher({
    captureContext() { throw Error('Lifecycle events must not read editor context'); },
    recentLifecycleEvents: playground.recentLifecycleEvents,
    waitLifecycleEvents: playground.waitLifecycleEvents,
  });
  t.after(playground.disposeWaits);
  return {
    recorder, playground, at(value) {now = value;},
    call(op, input = {}, signal) {return playground.api.summer_call({op: 'engine.' + op, input}, signal);},
  };
}

function begin(recorder, index, projectId = 'original') {
  const buildKey = 'b'.repeat(64), revision = 7;
  const attemptId = recorder.startBuild(projectId, revision);
  recorder.recordCompileResponse(attemptId, {
    variant: 'single-pack', pack: new Uint8Array([1]), diagnostics: [],
    manifest: {variant: 'single-pack', buildKey, artifactId: 'a'.repeat(64)}, sourceHash: 'c'.repeat(64),
  });
  recorder.beginPreview(attemptId);
  const run = {runId: 'run-' + index, revision, buildKey, generation: index,
    documentId: 'document-' + index, workerId: 'worker-' + index, runConfigurationHash: 'd'.repeat(64)};
  recorder.registerPreview(attemptId, {generation: run.generation,
    release: {releaseId: 'e'.repeat(64), engineProfile: 'full-engine-v1', descriptorSha256: 'f'.repeat(64)},
    configuration: {executionBackend: 'worker', presentationBackend: 'direct'},
  });
  recorder.recordRunEvent({type: 'state', state: 'loading-frame', ...run});
  return {run, attemptId};
}

function started(recorder, run) {recorder.recordRunEvent({type: 'state', state: 'running', ...run});}
function stopped(recorder, run) {
  recorder.recordRunEvent({type: 'state', state: 'exited', ...run});
  recorder.recordRunEvent({type: 'exit', report: {...run, reason: 'forced-frame-disposal'}});
}
function data(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result.data;
}
const cursor = page => ({since: page.next_seq, stream_id: page.stream_id});

test('a cursor taken before Play finds both coalesced transitions and preserves the original project', testOptions, async t => {
  const f = fixture(t);
  const start = cursor(data(await f.call('recent_events')));
  const pending = f.call('wait_for_event', start);
  const {run, attemptId} = begin(f.recorder, 1);
  started(f.recorder, {...run, workerId: 'foreign'});
  started(f.recorder, run);
  started(f.recorder, run);
  f.recorder.setContext({projectId: 'other', editorRevision: 9});
  stopped(f.recorder, run);
  stopped(f.recorder, run);
  const page = data(await pending);
  assert.deepEqual(page.events.map(event => [event.kind, event.data.projectId, event.data.attemptId, event.data.run]), [
    ['play.started', 'original', attemptId, run],
    ['play.stopped', 'original', attemptId, run],
  ]);
  assert.deepEqual(page.events[1].data.exit, {evidence: 'editor-local', reason: 'forced-frame-disposal'});
  assert.equal(page.events[1].data.startedObserved, true);
  assert.deepEqual(data(await f.call('wait_for_event', start)).events, page.events);
});

test('only creation of a Worker can produce a stopped event for a failed launch', testOptions, async t => {
  const f = fixture(t);
  const attempt = f.recorder.startBuild('original', 7);
  f.recorder.recordCompileResponse(attempt, {cancelled: true});
  assert.equal(data(await f.call('recent_events')).last_seq, 0);
  const {run} = begin(f.recorder, 1);
  f.recorder.recordRunEvent({type: 'state', state: 'exited', ...run});
  assert.equal(data(await f.call('recent_events')).last_seq, 0);
  stopped(f.recorder, run);
  const [event] = data(await f.call('recent_events')).events;
  assert.equal(event.kind, 'play.stopped');
  assert.equal(event.data.startedObserved, false);
});

test('cursors are scoped and pages advance across filtering and prefix eviction', testOptions, async t => {
  const f = fixture(t);
  for (let index = 1; index <= 257; index++) {
    const {run} = begin(f.recorder, index);
    started(f.recorder, run);
    stopped(f.recorder, run);
  }
  const head = data(await f.call('recent_events', {limit: 1, kinds: ['play.started']}));
  assert.equal(head.last_seq, 514);
  assert.equal(head.next_seq, 514);
  assert.equal(head.count, 0);
  assert.equal(head.gap, undefined);
  const page = data(await f.call('recent_events', {limit: 1, since: 0, kinds: ['play.stopped']}));
  assert.deepEqual(page.gap, {from_seq: 1, to_seq: 2});
  assert.equal(page.next_seq, 4);
  assert.equal(page.truncated, true);
  assert.deepEqual(data(await f.call('recent_events', {...cursor(page), limit: 1, kinds: ['play.stopped']}))
    .events.map(event => event.seq), [6]);
  assert.equal((await fixture(t).call('recent_events', {since: 0, stream_id: page.stream_id})).error.code, 'invalid_cursor');
  assert.equal((await f.call('wait_for_event', {since: 515})).error.code, 'invalid_cursor');
  f.at(600_000);
  const empty = data(await f.call('recent_events', {limit: 2}));
  assert.deepEqual(empty.gap, {from_seq: 513, to_seq: 514});
  assert.equal(empty.last_seq, 514);
  assert.equal(empty.next_seq, 514);
});

test('a late wake still sees deadline-inclusive observations and leaves later observations for the next call', testOptions, async t => {
  const f = fixture(t);
  const pending = f.call('wait_for_event', {timeout_seconds: 1});
  const {run} = begin(f.recorder, 1);
  f.at(999);
  started(f.recorder, run);
  f.at(1000);
  stopped(f.recorder, run);
  f.at(1001);
  started(f.recorder, begin(f.recorder, 2).run);
  f.recorder.notify();
  const result = data(await pending);
  assert.deepEqual(result.events.map(event => event.seq), [1, 2]);
  assert.equal(result.next_seq, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(data(await f.call('recent_events', cursor(result))).events.map(event => event.seq), [3]);

  const next = f.call('wait_for_event', {...cursor(result), since: 3, timeout_seconds: 1});
  f.at(2002);
  stopped(f.recorder, f.recorder.api.getRun('run-2').result);
  f.recorder.notify();
  const expired = data(await next);
  assert.equal(expired.timed_out, true);
  assert.equal(expired.next_seq, 3);
  assert.equal(expired.truncated, false);
  assert.deepEqual(data(await f.call('recent_events', cursor(expired))).events.map(event => event.seq), [4]);
});

test('an eviction watermark that crossed the deadline preserves the last provable cursor', testOptions, async t => {
  const f = fixture(t);
  const pending = f.call('wait_for_event', {since: 0, timeout_seconds: 1});
  const {run} = begin(f.recorder, 1);
  started(f.recorder, run);
  f.at(1001);
  stopped(f.recorder, run);
  f.at(601_001);
  f.recorder.notify();
  const result = data(await pending);
  assert.equal(result.timed_out, true);
  assert.deepEqual(result.gap, {from_seq: 1, to_seq: 2});
  assert.equal(result.next_seq, 0);
  assert.equal(data(await f.call('recent_events', cursor(result))).next_seq, 2);
});

test('cancel wins before notification commits, and lifecycle and local waits share the page budget', testOptions, async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const pending = f.call('wait_for_event', {}, abort.signal);
  const {run, attemptId} = begin(f.recorder, 1);
  started(f.recorder, run);
  abort.abort();
  assert.equal((await pending).error.code, 'cancelled');
  const page = data(await f.call('recent_events'));
  assert.equal(page.events[0].data.attemptId, attemptId);
  const local = f.playground.api.wait_for_event({runId: run.runId, until: 'exited'});
  const queued = Array.from({length: 15}, () => f.call('wait_for_event'));
  assert.equal((await f.call('wait_for_event')).error.code, 'busy');
  f.playground.cancelWaits();
  for (const result of await Promise.all([local, ...queued])) assert.equal(result.error.code, 'cancelled');
  const after = f.call('wait_for_event');
  f.playground.disposeWaits();
  assert.equal((await after).error.code, 'cancelled');
  assert.equal((await f.call('wait_for_event')).error.code, 'cancelled');
  assert.equal((await f.playground.api.wait_for_event({runId: run.runId, until: 'exited'})).error.code, 'cancelled');
});

test('validates limits, kinds and optional stream binding before dispatch', testOptions, async t => {
  const f = fixture(t);
  for (const [input, code] of [
    [{since: Number.MAX_SAFE_INTEGER + 1}, 'invalid_input'], [{limit: 0}, 'invalid_input'],
    [{limit: null}, 'invalid_input'], [{kinds: ['bad']}, 'invalid_input'], [{kinds: ['script.error']}, 'unsupported'],
    [{stream_id: 'missing-since'}, 'invalid_input'],
  ]) assert.equal((await f.call('recent_events', input)).error.code, code);
  assert.equal((await f.call('wait_for_event', {match: {requestId: 'any'}})).error.code, 'unsupported');
  assert.equal((await f.call('wait_for_event', {timeout_seconds: Infinity})).error.code, 'invalid_input');
});
