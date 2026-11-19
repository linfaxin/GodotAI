import assert from 'node:assert/strict';
import test from 'node:test';
import {createDebugRecorder, debugFailure} from '../src/debug-api.ts';

const release = {releaseId: 'a'.repeat(64), engineProfile: 'full-engine-v1', descriptorSha256: 'b'.repeat(64)};
const configuration = {executionBackend: 'worker', presentationBackend: 'direct'};
const sourceHash = 'c'.repeat(64);
const artifact = {variant: 'single-pack', buildKey: 'd'.repeat(64), artifactId: 'e'.repeat(64)};

function compileResponse(diagnostics = []) {
  return {
    variant: artifact.variant,
    manifest: {...artifact},
    pack: new Uint8Array([1]),
    sourceHash,
    diagnostics,
  };
}

function unwrap(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}

function expectError(response, code) {
  assert.equal(response.ok, false);
  assert.equal(response.error.code, code);
}

function prepare(recorder, name, {projectId = 'native', revision = 7, diagnostics = []} = {}) {
  const attemptId = recorder.startBuild(projectId, revision);
  recorder.recordCompileResponse(attemptId, compileResponse(diagnostics));
  recorder.beginPreview(attemptId);
  const identity = {
    runId: 'run-' + name, generation: 'generation-' + name, revision, buildKey: artifact.buildKey,
    documentId: 'document-' + name, workerId: 'worker-' + name, runConfigurationHash: 'f'.repeat(64),
  };
  const releaseAssociation = recorder.registerPreview(attemptId, {generation: identity.generation, release, configuration});
  return {attemptId, identity, releaseAssociation};
}

function enter(recorder, run, state) {
  recorder.recordRunEvent({type: 'state', state, ...run.identity});
}

function log(recorder, run, text, level = 'log') {
  recorder.recordRunEvent({type: 'log', text, level, untrusted: true, ...run.identity});
}

function localExit(recorder, run) {
  enter(recorder, run, 'exited');
  recorder.recordRunEvent({type: 'exit', report: {...run.identity, reason: 'forced-frame-disposal'}});
}

test('context queries read owned page snapshots across loading, shell, failure and verified preview', async () => {
  const recorder = createDebugRecorder();
  const {api} = recorder;
  assert.equal(api.schemaVersion, 1);
  assert.deepEqual(unwrap(api.getContext()), {
    projectId: null, editorRevision: null, release: {status: 'loading'}, preview: {status: 'loading'},
    latestBuildAttemptId: null, activeRunId: null, lastExitedRunId: null,
  });
  let notifications = 0;
  const unsubscribe = recorder.subscribe(() => notifications++);
  recorder.setContext({projectId: 'native', editorRevision: 2, preview: {status: 'unsupported', reason: 'shell-only'}});
  assert.equal(unwrap(api.getContext()).preview.status, 'unsupported');
  const attemptId = recorder.startBuild('native', 2);
  assert.equal(unwrap(api.getBuild(attemptId)).preview, undefined);
  recorder.setContext({release: {status: 'failed', error: debugFailure('release', new Error('unavailable'))}});
  assert.equal(unwrap(api.getContext()).release.error.diagnostic.message, 'unavailable');
  const contextInput = {release: {status: 'available', value: {...release}}, preview: {status: 'available', value: configuration}};
  recorder.setContext(contextInput);
  contextInput.release.value.releaseId = 'mutated';
  const result = unwrap(api.getContext());
  result.release.value.releaseId = 'mutated again';
  assert.equal(unwrap(api.getContext()).release.value.releaseId, release.releaseId);
  assert.equal(unwrap(api.getContext()).latestBuildAttemptId, attemptId);
  await Promise.resolve();
  assert.equal(notifications, 1);
  unsubscribe();
  recorder.setContext({editorRevision: 3});
  await Promise.resolve();
  assert.equal(notifications, 1);
  expectError(api.getRun(null), 'invalid_input');
  expectError(api.getBuild('missing'), 'not_found');
});

test('build results separate a known empty diagnostic list from cancellation and request failure', () => {
  const recorder = createDebugRecorder();
  const {api} = recorder;
  const succeeded = recorder.startBuild('native', 2);
  recorder.recordCompileResponse(succeeded, {
    ...compileResponse(),
    environmentFacts: {release, naming: 'snake', selection: {kind: 'engine'}, api: {status: 'available'}, secret: 'ignored'},
    compilerIdentity: {target: {engineProfile: 'full-engine-v1'}, declarations: sourceHash},
  });
  const passed = unwrap(api.getBuild(succeeded));
  assert.equal(passed.status, 'succeeded');
  assert.deepEqual(passed.artifact, artifact);
  assert.deepEqual(passed.diagnostics, {observed: true, counts: {error: 0, warning: 0, info: 0}, items: [], omittedCount: 0});
  assert.equal(passed.environmentFacts.naming, 'snake');
  assert.equal(passed.environmentFacts.secret, undefined);
  assert.equal(passed.compilerIdentity.declarations, sourceHash);
  assert.equal(passed.pack, undefined);
  recorder.skipPreview(succeeded);
  assert.equal(unwrap(api.getBuild(succeeded)).preview.status, 'skipped');

  const cancelled = recorder.startBuild('native', 2);
  recorder.recordCompileResponse(cancelled, {cancelled: true, diagnostics: [], sourceHash});
  recorder.skipPreview(cancelled);
  assert.deepEqual(unwrap(api.getBuild(cancelled)), {
    attemptId: cancelled, projectId: 'native', editorRevision: 2, status: 'cancelled', sourceHash,
    diagnostics: {observed: false, items: [], omittedCount: 0}, preview: {status: 'not-requested'},
  });

  const refused = recorder.startBuild('native', 2);
  recorder.failBuild(refused, debugFailure('compile-request', new Error('Worker channel closed')));
  recorder.recordCompileResponse(refused, compileResponse());
  const failed = unwrap(api.getBuild(refused));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.stage, 'compile-request');
  assert.equal(failed.error.diagnostic.message, 'Worker channel closed');
  assert.equal(failed.diagnostics.observed, false);
});

test('diagnostics bound retained UTF-8 JSON and keep known source locations and counts', () => {
  const recorder = createDebugRecorder();
  const attemptId = recorder.startBuild('native', 2);
  recorder.recordCompileResponse(attemptId, {
    error: '构建失败'.repeat(3500),
    diagnostics: [
      {category: 'error', message: '字'.repeat(24000), code: 2322, file: '/start.ts', line: 2, column: 3},
      {category: 'error', message: 'No compiler environment', code: 0, line: 0, column: 0},
      {category: 'error', message: 'Invalid JSON', code: 0, file: '/data.json', line: 3, column: 8},
      ...Array.from({length: 120}, () => ({category: 'warning', message: '文'.repeat(1500)})),
      {category: 'info', message: 'Last item'},
    ],
  });
  const build = unwrap(recorder.api.getBuild(attemptId));
  assert.equal(build.status, 'failed');
  assert.equal(build.artifact, undefined);
  const {diagnostics} = build;
  assert.deepEqual(diagnostics.counts, {error: 3, warning: 120, info: 1});
  assert.deepEqual(diagnostics.items[0], {
    severity: 'error', code: 2322, location: {file: '/start.ts', line: 2, column: 3}, omitted: true,
  });
  assert.deepEqual(diagnostics.items[1], {severity: 'error', message: 'No compiler environment'});
  assert.deepEqual(diagnostics.items[2].location, {file: '/data.json', line: 3, column: 8});
  assert(diagnostics.items.length <= 100);
  assert.equal(build.error.diagnostic.omitted, true);
  assert(Buffer.byteLength(JSON.stringify({diagnostics, error: build.error})) <= 64 * 1024);
  assert.equal(diagnostics.omittedCount, 124 - diagnostics.items.length);
});

test('failure diagnostics retain structured codes and the leading codes of legacy engine errors', () => {
  const recorder = createDebugRecorder();
  const attemptId = recorder.startBuild('native', 2);
  recorder.recordCompileResponse(attemptId, {
    error: 'Resource target unavailable', errorCode: 'E_RESOURCE_CONVERTER_TARGET',
    diagnostics: [{category: 'error', message: 'Resource target unavailable', code: 'E_RESOURCE_CONVERTER_TARGET', line: 0, column: 0}],
  });
  const build = unwrap(recorder.api.getBuild(attemptId));
  assert.equal(build.error.diagnostic.code, 'E_RESOURCE_CONVERTER_TARGET');
  assert.equal(build.diagnostics.items[0].code, build.error.diagnostic.code);
  assert.equal(build.diagnostics.items[0].location, undefined);
  assert.equal(debugFailure('compile', 'Error: E_SOURCE_SYNC: mismatch').diagnostic.code, 'E_SOURCE_SYNC');
  assert.equal(debugFailure('release', new Error('E_RELEASE_CONTEXT_REQUIRED')).diagnostic.code, 'E_RELEASE_CONTEXT_REQUIRED');
  assert.equal(debugFailure('compile-request', Error('Worker mentioned E_SOURCE_SYNC: mismatch')).diagnostic.code, undefined);
  const structured = Object.assign(new Error('E_TEXT_ONLY: details'), {code: 'E_STRUCTURED'});
  assert.equal(debugFailure('preview-prepare', structured).diagnostic.code, 'E_STRUCTURED');
});

test('preparation rejection stays on its own successful build and leaves the current run intact', () => {
  const recorder = createDebugRecorder();
  recorder.setContext({projectId: 'native', editorRevision: 7});
  const older = prepare(recorder, 'older');
  enter(recorder, older, 'loading-frame');
  log(recorder, older, 'old project log');
  const tried = prepare(recorder, 'wrong-target');
  recorder.rejectPreview(tried.attemptId, debugFailure('preview-prepare', new Error('E_RUNTIME_TARGET_ENGINE: target mismatch')));
  tried.releaseAssociation();
  enter(recorder, tried, 'loading-frame');
  const build = unwrap(recorder.api.getBuild(tried.attemptId));
  assert.equal(build.status, 'succeeded');
  assert.equal(build.preview.status, 'rejected');
  assert.equal(build.preview.error.diagnostic.code, 'E_RUNTIME_TARGET_ENGINE');
  assert.equal(build.preview.runId, undefined);
  assert.equal(unwrap(recorder.api.getContext()).latestBuildAttemptId, tried.attemptId);
  assert.equal(unwrap(recorder.api.getContext()).activeRunId, older.identity.runId);
  expectError(recorder.api.getRun(tried.identity.runId), 'not_found');
  const page = unwrap(recorder.api.readRunEvents(older.identity.runId, {kinds: ['log']}));
  assert.deepEqual(page.items.map(item => item.event.text), ['old project log']);
});

test('overlapping preparations bind the first frame by all identity fields, and only exit settles a run', () => {
  const recorder = createDebugRecorder();
  recorder.setContext({projectId: 'native', editorRevision: 7});
  const first = prepare(recorder, 'first');
  const newer = prepare(recorder, 'newer');
  recorder.recordRunEvent({type: 'state', state: 'loading-frame', ...first.identity, buildKey: '0'.repeat(64)});
  expectError(recorder.api.getRun(first.identity.runId), 'not_found');
  enter(recorder, first, 'loading-frame');
  first.releaseAssociation();
  recorder.skipPreview(first.attemptId);
  recorder.rejectPreview(first.attemptId, debugFailure('preview-prepare', 'too late'));
  assert.deepEqual(unwrap(recorder.api.getBuild(first.attemptId)).preview, {status: 'session-created', runId: first.identity.runId});
  assert.equal(unwrap(recorder.api.getContext()).latestBuildAttemptId, newer.attemptId);

  enter(recorder, first, 'exited');
  assert.equal(unwrap(recorder.api.getContext()).activeRunId, first.identity.runId);
  assert.equal(unwrap(recorder.api.getRun(first.identity.runId)).exit, undefined);
  recorder.recordRunEvent({
    type: 'exit',
    report: {
      ...first.identity, reason: 'clean-exit', code: 0,
      engineOutcome: {kind: 'native-exit', code: 0}, hostCleanup: {status: 'complete'},
      sessionFacts: {schemaVersion: 1, nativeExit: {code: 0}, runtimeSummary: 'sealed', entryCleanup: 'complete',
        hostCleanup: 'complete', forcedTerminationIssued: false},
    },
  });
  localExit(recorder, first);
  const ended = unwrap(recorder.api.getRun(first.identity.runId));
  assert.equal(ended.exit.evidence, 'host-report');
  assert.equal(ended.exit.report.sessionFacts.entryCleanup, 'complete');
  assert.equal(unwrap(recorder.api.readRunEvents(first.identity.runId, {kinds: ['exit']})).items.length, 1);

  enter(recorder, newer, 'loading-frame');
  newer.releaseAssociation();
  recorder.recordRunEvent({type: 'log', level: 'error', text: 'wrong realm', untrusted: true, ...newer.identity, workerId: 'old'});
  log(recorder, newer, 'fresh');
  assert.equal(unwrap(recorder.api.getContext()).activeRunId, newer.identity.runId);
  assert.equal(unwrap(recorder.api.getContext()).lastExitedRunId, first.identity.runId);
  const events = unwrap(recorder.api.readRunEvents(newer.identity.runId, {kinds: ['log']}));
  assert.deepEqual(events.items.map(item => item.event.text), ['fresh']);
  localExit(recorder, newer);
  const forced = unwrap(recorder.api.getRun(newer.identity.runId)).exit;
  assert.equal(forced.evidence, 'editor-local');
  assert.equal(forced.report.sessionFacts, undefined);
  assert.equal(forced.report.code, undefined);
});

test('a preparing build survives record eviction when its first frame arrives and is later released with the run', () => {
  const recorder = createDebugRecorder();
  recorder.setContext({projectId: 'native', editorRevision: 7});
  const older = prepare(recorder, 'retained', {diagnostics: [{category: 'warning', message: 'Keep me', code: 14}]});
  const before = unwrap(recorder.api.getBuild(older.attemptId));
  for (let revision = 8; revision <= 23; revision++) recorder.startBuild('native', revision);
  expectError(recorder.api.getBuild(older.attemptId), 'not_found');
  enter(recorder, older, 'loading-frame');
  older.releaseAssociation();
  assert.deepEqual(unwrap(recorder.api.getBuild(older.attemptId)), {
    ...before, preview: {status: 'session-created', runId: older.identity.runId},
  });
  localExit(recorder, older);
  for (const name of ['replacement-1', 'replacement-2']) {
    const replacement = prepare(recorder, name);
    enter(recorder, replacement, 'loading-frame');
    replacement.releaseAssociation();
    localExit(recorder, replacement);
  }
  recorder.recordCompileResponse(older.attemptId, compileResponse());
  expectError(recorder.api.getRun(older.identity.runId), 'not_found');
  expectError(recorder.api.getBuild(older.attemptId), 'not_found');
});

test('event paging reports evicted prefixes, advances past filtered entries, and isolates page and run cursors', () => {
  const recorder = createDebugRecorder();
  const run = prepare(recorder, 'paging');
  enter(recorder, run, 'loading-frame');
  const {api} = recorder;
  const first = unwrap(api.readRunEvents(run.identity.runId, {limit: 1}));
  assert.equal(first.hasMore, false);
  assert.equal(first.items[0].seq, 1);
  for (let index = 0; index < 501; index++) log(recorder, run, 'log ' + index);
  const gap = unwrap(api.readRunEvents(run.identity.runId, {after: first.nextCursor, limit: 2}));
  assert.deepEqual(gap.gap, {fromSeq: 2, toSeq: 2});
  assert.equal(gap.oldestAvailableSeq, 3);
  assert.deepEqual(gap.items.map(item => item.seq), [3, 4]);
  assert.equal(gap.hasMore, true);
  const empty = unwrap(api.readRunEvents(run.identity.runId, {after: gap.nextCursor, kinds: ['exit']}));
  assert.equal(empty.items.length, 0);
  assert.equal(empty.hasMore, false);
  const firstFiltered = unwrap(api.readRunEvents(run.identity.runId, {kinds: ['state']}));
  assert.deepEqual(firstFiltered.gap, {fromSeq: 1, toSeq: 2});
  assert.equal(firstFiltered.nextCursor, empty.nextCursor);
  log(recorder, run, 'new warning', 'warn');
  const fresh = unwrap(api.readRunEvents(run.identity.runId, {after: empty.nextCursor, levels: ['warn']}));
  assert.deepEqual(fresh.items.map(item => item.event.text), ['new warning']);
  const foreign = createDebugRecorder();
  const otherPage = prepare(foreign, 'paging');
  enter(foreign, otherPage, 'loading-frame');
  expectError(foreign.api.readRunEvents(otherPage.identity.runId, {after: first.nextCursor}), 'invalid_cursor');
  expectError(api.readRunEvents(run.identity.runId, {after: first.nextCursor.replace(/1$/, '10000')}), 'invalid_cursor');
  expectError(api.readRunEvents(run.identity.runId, {limit: 101}), 'invalid_input');
  localExit(recorder, run);
  const next = prepare(recorder, 'next');
  enter(recorder, next, 'loading-frame');
  expectError(api.readRunEvents(next.identity.runId, {after: first.nextCursor}), 'invalid_cursor');
});

test('event storage measures UTF-8 bytes, replaces oversized payloads, and never returns mutable source data', () => {
  const recorder = createDebugRecorder();
  const run = prepare(recorder, 'size');
  enter(recorder, run, 'loading-frame');
  const data = {message: '字'.repeat(87375)};
  recorder.recordRunEvent({type: 'project', data, ...run.identity});
  const overflow = unwrap(recorder.api.readRunEvents(run.identity.runId, {kinds: ['project']}));
  assert.deepEqual(overflow.items, [{seq: 2, event: {type: 'project', source: 'project', omitted: true}}]);
  const owned = {nested: {value: 7}};
  recorder.recordRunEvent({type: 'project', data: owned, ...run.identity});
  owned.nested.value = 8;
  const query = () => unwrap(recorder.api.readRunEvents(run.identity.runId, {kinds: ['project'], after: overflow.nextCursor}));
  const item = query().items[0].event;
  item.data.nested.value = 9;
  assert.equal(query().items[0].event.data.nested.value, 7);
  for (let counter = 0; counter < 80; counter++) log(recorder, run, '字'.repeat(1400));
  const trimmed = unwrap(recorder.api.readRunEvents(run.identity.runId, {limit: 100}));
  assert(trimmed.gap.toSeq > 3);
  assert(Buffer.byteLength(JSON.stringify(trimmed.items)) <= 256 * 1024 + trimmed.items.length + 1);
  localExit(recorder, run);
  assert.equal(unwrap(recorder.api.getRun(run.identity.runId)).exit.report.reason, 'forced-frame-disposal');
});
