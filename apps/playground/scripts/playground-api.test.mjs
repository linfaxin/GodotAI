import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlaygroundApi} from '../src/playground-api.ts';
import {createDebugRecorder, debugFailure} from '../src/debug-api.ts';

const release = {releaseId: 'a'.repeat(64), engineProfile: 'full-engine-v1', descriptorSha256: 'b'.repeat(64)};
const configuration = {executionBackend: 'worker', presentationBackend: 'direct'};
const projectId = 'project', editorRevision = 7;
const request = {projectId, expectedEditorRevision: editorRevision};
const sourceHash = 'c'.repeat(64), buildKey = 'd'.repeat(64), artifactId = 'e'.repeat(64);
const typeError = {category: 'error', code: 2322, message: 'Type mismatch', file: '/src/start.ts', line: 4, column: 6};
const unwrap = response => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};

function fixture(beforeCheck = () => {}, observation) {
  const recorder = createDebugRecorder();
  const calls = {check: 0, play: 0, stop: []};
  const agent = createPlaygroundApi(recorder, {
    supportsProject: () => true,
    check: async () => {
      calls.check++;
      const check = recorder.startCheck(projectId, editorRevision);
      await beforeCheck(calls.check);
      return recorder.finishCheck(check, {diagnostics: [typeError], sourceHash});
    },
    play: () => {
      calls.play++;
      return recorder.startBuild(projectId, editorRevision);
    },
    stopRun: id => {
      calls.stop.push(id);
      return Promise.resolve();
    },
    observation: () => observation,
  });
  recorder.setContext({projectId, editorRevision, release: {status: 'available', value: release},
    preview: {status: 'available', value: configuration}});
  const {api} = agent;
  function start(attemptId = unwrap(api.play(request)).attemptId, revision = editorRevision) {
    const variant = 'single-pack';
    recorder.recordCompileResponse(attemptId, {variant, pack: new Uint8Array([1]),
      manifest: {variant, buildKey, artifactId}, diagnostics: [], sourceHash});
    recorder.beginPreview(attemptId);
    const identity = {runId: 'run-' + attemptId, generation: 'generation-' + attemptId,
      documentId: 'doc-' + attemptId, workerId: 'worker-' + attemptId, revision, buildKey, runConfigurationHash: 'f'.repeat(64)};
    recorder.registerPreview(attemptId, {generation: identity.generation, release, configuration});
    const state = state => recorder.recordRunEvent({type: 'state', state, ...identity});
    const exit = () => recorder.recordRunEvent({type: 'exit', report: {...identity, reason: 'forced-frame-disposal'}});
    state('loading-frame');
    return {identity, state, exit};
  }
  return {recorder, api, agent, calls, start};
}

test('check admission, original revision, and diagnostic projection preserve source facts', async () => {
  const {recorder, api, calls} = fixture();
  assert.equal((await api.check({...request, expectedEditorRevision: 6})).error.code, 'revision_conflict');
  assert.equal(api.play({...request, projectId: 'previous'}).error.code, 'revision_conflict');
  assert.deepEqual(calls, {check: 0, play: 0, stop: []});

  const completed = unwrap(await api.check(request));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.scope, 'typecheck');
  assert.equal(completed.sourceHash, sourceHash);
  assert.equal(completed.diagnostics.items[0].code, 2322);
  const recordInput = {projectId, editorRevision, checkId: completed.checkId};
  const projected = unwrap(api.get_diagnostics({...recordInput, path: 'res://other.ts'}));
  assert.equal(projected.check.diagnostics.counts.error, 1);
  assert.deepEqual(projected.check.diagnostics.items, []);
  assert.equal(calls.check, 1);

  const first = recorder.startCheck(projectId, editorRevision);
  recorder.setContext({editorRevision: 8});
  const next = recorder.startCheck(projectId, 8);
  recorder.finishCheck(next, {diagnostics: [], sourceHash});
  const late = recorder.finishCheck(first, undefined, debugFailure('check-request', Error('Worker lost')));
  assert.equal(late.status, 'failed');
  assert.equal(late.sourceHash, undefined);
  assert.equal(late.diagnostics.observed, false);
  assert.equal(unwrap(api.get_diagnostics({projectId, editorRevision: 8})).check.checkId, next.checkId);
  assert.equal(unwrap(api.get_diagnostics({...recordInput, checkId: late.checkId})).check.error.stage, 'check-request');

  const rejected = recorder.finishCheck(recorder.startCheck(projectId, 8),
    {error: 'Error: E_SOURCE_SYNC: failed', diagnostics: [typeError]});
  assert.equal(rejected.error.diagnostic.code, 'E_SOURCE_SYNC');
  assert.equal(rejected.diagnostics.observed, false);
});

test('an out-of-order check is queryable when returned and does not supersede a newer default', async () => {
  let finishFirst;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  const {api} = fixture(sequence => sequence === 1 ? gate : undefined);
  const pending = api.check(request);
  const completed = [];
  for (let index = 0; index < 16; index++) completed.push(unwrap(await api.check(request)));
  finishFirst();

  const late = unwrap(await pending);
  const query = {projectId, editorRevision};
  assert.equal(unwrap(api.get_diagnostics({...query, checkId: late.checkId})).check.checkId, late.checkId);
  assert.equal(unwrap(api.get_diagnostics(query)).check.checkId, completed.at(-1).checkId);
  assert.equal(api.get_diagnostics({...query, checkId: completed[0].checkId}).error.code, 'not_found');
});

test('attempt waits bind their own run, while exit requires a receipt', async () => {
  const {recorder, api, start} = fixture();
  const attemptId = unwrap(api.play(request)).attemptId;
  const pending = api.wait_for_event({attemptId, until: 'running'});
  const first = start(attemptId);
  first.state('running');
  const ready = unwrap(await pending);
  assert.equal(ready.build.attemptId, attemptId);
  assert.equal(ready.run.runId, first.identity.runId);
  assert.equal(unwrap(await api.wait_for_event({runId: first.identity.runId, until: 'running'})).outcome, 'reached');

  let settled = false;
  const exit = api.wait_for_event({runId: first.identity.runId, until: 'exited'}).then(value => { settled = true; return value; });
  first.state('exited');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  first.exit();
  assert.equal(unwrap(await exit).run.exit.evidence, 'editor-local');
  assert.equal(unwrap(await api.wait_for_event({attemptId, until: 'running'})).outcome, 'exited_before_condition');

  const second = start();
  second.state('running');
  recorder.recordRunEvent({type: 'log', ...second.identity, level: 'error', text: 'an untrusted message'});
  const diagnostic = unwrap(api.get_diagnostics({projectId, editorRevision, runId: second.identity.runId}));
  assert.equal(diagnostic.run.observed, false);
  assert.equal(diagnostic.build.attemptId, diagnostic.run.attemptId);
  assert.equal(api.get_diagnostics({projectId, editorRevision, attemptId, runId: second.identity.runId}).error.code, 'revision_conflict');
});

test('wait pins an accepted attempt across eviction and settles failures without a session', async () => {
  const {recorder, api} = fixture();
  const attemptId = unwrap(api.play(request)).attemptId;
  const pending = api.wait_for_event({attemptId, until: 'running'});
  for (let index = 0; index < 20; index++) recorder.startBuild(projectId, editorRevision);
  assert.equal(unwrap(api.get_build({attemptId})).status, 'pending');
  recorder.recordCompileResponse(attemptId, {diagnostics: [typeError]});
  const observed = unwrap(await pending);
  assert.equal(observed.outcome, 'no_session');
  assert.equal(observed.build.status, 'failed');
  assert.equal(observed.run, undefined);
  assert.equal(api.get_build({attemptId}).error.code, 'not_found');
});

test('waits reject invalid cancellation signals and release references after genuine aborts', async () => {
  const {recorder, api} = fixture();
  const attemptId = unwrap(api.play(request)).attemptId;
  const input = {attemptId, until: 'running'};
  for (const invalid of [null, {}, new EventTarget(), {aborted: true}]) {
    assert.equal((await api.wait_for_event(input, invalid)).error.code, 'invalid_input');
  }

  const controller = new AbortController();
  const pending = api.wait_for_event(input, controller.signal);
  for (let index = 0; index < 20; index++) recorder.startBuild(projectId, editorRevision);
  assert.equal(unwrap(api.get_build({attemptId})).status, 'pending');
  controller.abort();
  assert.equal((await pending).error.code, 'cancelled');
  assert.equal(api.get_build({attemptId}).error.code, 'not_found');
  assert.equal((await api.wait_for_event(input, controller.signal)).error.code, 'cancelled');
});

test('wait timeouts and cancellation leave operations alone, and stopping checks the run ID', async () => {
  const {api, agent, calls, start} = fixture();
  const first = start();
  const runId = first.identity.runId;
  assert.equal(unwrap(await api.wait_for_event({runId, until: 'running', timeoutMs: 5})).outcome, 'timeout');
  assert.equal(unwrap(api.get_run({runId})).state, 'loading-frame');
  const pending = api.wait_for_event({runId, until: 'running'});
  agent.cancelWaits();
  assert.equal((await pending).error.code, 'cancelled');
  assert.equal(api.stop({runId: 'unknown'}).error.code, 'not_found');
  assert.equal(unwrap(api.stop({runId})).status, 'stopping');
  assert.deepEqual(calls.stop, [runId]);
  first.exit();
  const next = start();
  next.state('running');
  assert.equal(unwrap(api.stop({runId})).status, 'exited');
  assert.deepEqual(calls.stop, [runId]);
  assert.equal(unwrap(api.get_run({runId: next.identity.runId})).state, 'running');
});

test('runtime observation validates input before abort and checks retained ownership before dispatch', async () => {
  const observed = [];
  const {api, start} = fixture(undefined, {
    observationState: () => ({supported: true, ready: true, version: 1}),
    async getRuntimeTree(input) {
      observed.push(input.runId);
      return {ok: true, result: {nodes: []}};
    },
    async inspectRuntimeNode(input) {
      observed.push(input.runId);
      return {ok: false, error: {code: 'node_not_found', message: 'missing node'}};
    },
  });
  const first = start();
  first.state('running');
  const {runId} = first.identity;
  const node = {runId, path: '/root/Main/Player', properties: ['position']};
  const cancelled = AbortSignal.abort();
  assert.equal((await api.get_runtime_tree({runId: 'unknown', depth: -1}, cancelled)).error.code, 'invalid_input');
  assert.equal((await api.get_runtime_tree({runId: 'unknown'}, cancelled)).error.code, 'cancelled');
  assert.equal((await api.get_runtime_tree({runId: 'unknown'})).error.code, 'not_found');
  assert.equal((await api.inspect_runtime_node({...node, properties: ['script']})).error.code, 'invalid_input');
  assert.deepEqual(observed, []);

  const run = unwrap(api.get_run({runId}));
  assert.deepEqual(run.observation, {supported: true, ready: true, version: 1});
  assert.deepEqual(run.interaction, {supported: false, ready: false});
  assert.deepEqual(unwrap(await api.get_runtime_tree({runId})), {nodes: []});
  assert.equal((await api.inspect_runtime_node(node)).error.code, 'node_not_found');
  first.state('stopping');
  assert.equal((await api.inspect_runtime_node(node)).error.code, 'run_ended');
  first.exit();
  assert.equal((await api.get_runtime_tree({runId})).error.code, 'run_ended');
  for (let index = 0; index < 4; index++) start().exit();
  assert.equal((await api.get_runtime_tree({runId})).error.code, 'not_found');
  assert.deepEqual(observed, [runId, runId]);
});

test('runtime observation reports unsupported for a known run without an observation backend', async () => {
  const {api, start} = fixture();
  const run = start();
  run.state('running');
  const {runId} = run.identity;
  assert.deepEqual(unwrap(api.get_run({runId})).observation, {supported: false, ready: false});
  assert.equal((await api.get_runtime_tree({runId})).error.code, 'unsupported');
});
