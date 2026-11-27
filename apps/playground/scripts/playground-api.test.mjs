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

function fixture(beforeCheck = () => {}, observation, runtimeWrite, runtimeProperties) {
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
    runtimeWrite: () => runtimeWrite,
    runtimeProperties: () => runtimeProperties,
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

test('runtime_set validates inputs and only forwards writes for the requested live run', async () => {
  const writes = [];
  const {api, agent, start} = fixture(undefined, undefined, {
    runtimeWriteState: () => ({supported: true, ready: true, version: 1}),
    async setRuntimeProperty(input, signal) {
      writes.push({input, signal});
      return {ok: true, result: {outcome: 'applied', observedValue: input.value}};
    },
  });
  const run = start();
  run.state('running');
  const {runId} = run.identity;
  const input = {runId, path: '/root/Player', expectedInstanceId: '9007199254740993',
    property: 'position', value: {x: 192, y: 256}};
  const trace = [];
  agent.subscribe(call => trace.push(call));
  assert.deepEqual(api.get_run({runId}).result.runtimeWrite, {supported: true, ready: true, version: 1});
  assert.equal((await api.runtime_set({...input, property: 'visible'})).error.code, 'invalid_input');
  let getterCalls = 0;
  assert.equal((await api.runtime_set({...input, value: {get x() { return ++getterCalls; }, y: 256}})).error.code, 'invalid_input');
  assert.equal(getterCalls, 0);
  assert.deepEqual(trace.at(-1).input, {omitted: true});
  assert.equal((await api.runtime_set({...input, runId: 'other'})).error.code, 'not_found');
  assert.equal((await api.runtime_set(input, AbortSignal.abort())).error.code, 'cancelled');
  const reply = unwrap(await api.runtime_set(input));
  assert.deepEqual(reply.observedValue, input.value);
  assert.deepEqual(writes, [{input: {...input, timeoutMs: 5000}, signal: undefined}]);
  run.exit();
  assert.equal((await api.runtime_set(input)).error.code, 'run_ended');
  assert.equal(writes.length, 1);
});

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

test('script check scopes raw diagnostics before truncation and retains the original project check', async () => {
  const recorder = createDebugRecorder();
  const otherErrors = Array.from({length: 110}, () => ({...typeError, file: '/src/other.ts'}));
  let checks = 0, finish;
  const agent = createPlaygroundApi(recorder, {
    supportsProject: () => true,
    hasScript: path => path === typeError.file,
    check(path) {
      const context = recorder.api.getContext().result;
      const request = recorder.startCheck(context.projectId, context.editorRevision);
      checks++;
      return new Promise(resolve => {finish = response => resolve(recorder.finishCheck(request, response, undefined, path));});
    },
    play: () => assert.fail('Script checking must not start a build'),
    stopRun: () => assert.fail('Script checking must not stop a run'),
  });
  assert.equal((await agent.getScriptErrors(typeError.file)).error.code, 'not_ready');
  recorder.setContext({projectId, editorRevision, release: {status: 'available', value: release}});
  assert.equal((await agent.getScriptErrors('/src/missing.ts')).error.code, 'not_found');
  assert.equal(checks, 0);

  const pending = agent.getScriptErrors(typeError.file);
  recorder.setContext({editorRevision: 8});
  finish({diagnostics: [...otherErrors, typeError], sourceHash});
  const scoped = unwrap(await pending);
  assert.equal(scoped.editorRevision, editorRevision);
  assert.equal(scoped.sourceHash, sourceHash);
  assert.equal(scoped.path, 'res://src/start.ts');
  assert.deepEqual(scoped.diagnostics, {observed: true, counts: {error: 1, warning: 0, info: 0}, omittedCount: 0,
    items: [{severity: 'error', code: 2322, message: typeError.message, location: {file: typeError.file, line: 4, column: 6}}]});
  const retained = recorder.getCheck(scoped.checkId);
  assert.equal(retained.diagnostics.counts.error, 111);
  assert(retained.diagnostics.items.every(item => item.location.file === '/src/other.ts'));

  const clean = agent.getScriptErrors(typeError.file);
  finish({diagnostics: otherErrors, sourceHash});
  assert.equal(unwrap(await clean).diagnostics.counts.error, 0);
  const failed = agent.getScriptErrors(typeError.file);
  finish({error: 'Worker reported an error'});
  assert.equal(unwrap(await failed).status, 'failed');
  assert.equal(unwrap(await failed).diagnostics.observed, false);
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

test('Summer diagnostics follows the newest attempt for the captured editor version', () => {
  const {agent, api, recorder, calls, start} = fixture();
  recorder.setContext({editorRevision: null});
  assert.equal(agent.getSummerDiagnostics().error.code, 'not_ready');
  recorder.setContext({editorRevision});
  assert.deepEqual(unwrap(agent.getSummerDiagnostics()), {projectId, editorRevision, check: null, build: null, run: null});
  const attemptId = recorder.startBuild(projectId, editorRevision);
  const original = start(attemptId);
  original.state('running');
  assert.equal(unwrap(agent.getSummerDiagnostics()).run.identity.runId, original.identity.runId);
  assert.equal(unwrap(api.get_diagnostics({projectId, editorRevision})).run, null);
  const newer = recorder.startBuild(projectId, editorRevision);
  const pending = unwrap(agent.getSummerDiagnostics());
  assert.equal(pending.build.attemptId, newer);
  assert.equal(pending.build.status, 'pending');
  assert.equal(pending.build.diagnostics.observed, false);
  assert.equal(pending.build.diagnostics.counts, undefined);
  assert.equal(pending.run, null);
  recorder.recordCompileResponse(newer, {diagnostics: [typeError]});
  assert.equal(unwrap(agent.getSummerDiagnostics()).build.status, 'failed');
  assert.equal(unwrap(agent.getSummerDiagnostics()).run, null);
  assert.equal(unwrap(api.get_run({runId: original.identity.runId})).state, 'running');

  const previous = recorder.startCheck(projectId, editorRevision);
  recorder.setContext({editorRevision: editorRevision + 1});
  const repaired = recorder.startCheck(projectId, editorRevision + 1);
  recorder.finishCheck(repaired, {diagnostics: [], sourceHash});
  recorder.finishCheck(previous, {diagnostics: [typeError], sourceHash});
  const scoped = unwrap(agent.getSummerDiagnostics());
  assert.equal(scoped.check.checkId, repaired.checkId);
  assert.equal(scoped.check.diagnostics.counts.error, 0);
  assert.equal(scoped.build, null);
  assert.equal(scoped.run, null);
  recorder.setContext({projectId: 'another-project'});
  assert.equal(unwrap(agent.getSummerDiagnostics()).check, null);
  assert.deepEqual(calls, {check: 0, play: 0, stop: []});
});

test('Summer diagnostics preserves source counts, retained order and exit evidence without leaking stacks', () => {
  const {agent, api, recorder, start} = fixture();
  const report = [typeError, {...typeError, code: 9000}];
  const input = [{...typeError, category: 'warning'}, ...report,
    ...Array.from({length: 100}, () => ({...typeError, category: 'info'}))];
  recorder.finishCheck(recorder.startCheck(projectId, editorRevision), {diagnostics: input, sourceHash});
  const attemptId = recorder.startBuild(projectId, editorRevision);
  const original = start(attemptId);
  original.state('exited');
  assert.equal(unwrap(agent.getSummerDiagnostics()).run.exit, null);
  recorder.recordRunEvent({type: 'exit', report: {...original.identity, reason: 'crashed',
    diagnostic: {source: 'browser', message: 'Worker crashed', stack: 'retained only on the run', filename: '/src/start.ts', line: 4}}});
  const data = unwrap(agent.getSummerDiagnostics());
  assert.equal(data.run.availability, 'retained');
  assert.deepEqual(data.run.identity, original.identity);
  assert.equal(data.run.artifactId, artifactId);
  assert.equal(data.run.exit.evidence, 'editor-local');
  assert.equal(data.run.exit.reason, 'crashed');
  assert.equal(data.run.exit.diagnostic.line, 4);
  assert.equal(Object.hasOwn(data.run.exit.diagnostic, 'stack'), false);
  assert.equal(unwrap(api.get_run({runId: original.identity.runId})).exit.report.diagnostic.stack, 'retained only on the run');
  assert.deepEqual(data.check.diagnostics.counts, {warning: 1, error: 2, info: 100});
  assert.equal(data.check.diagnostics.omittedCount, 3);
  assert.deepEqual(data.check.diagnostics.items.slice(0, 3).map(item => [item.severity, item.code]),
    [['error', 2322], ['error', 9000], ['warning', 2322]]);
  assert.equal(unwrap(api.get_diagnostics({projectId, editorRevision})).check.diagnostics.items[0].severity, 'warning');
  assert.equal(data.build.diagnostics.counts.error, 0);

  for (let revision = editorRevision + 1; revision <= editorRevision + 2; revision++) {
    start(recorder.startBuild(projectId, revision), revision).exit();
  }
  assert.deepEqual(unwrap(agent.getSummerDiagnostics()).run, {availability: 'unavailable', runId: original.identity.runId, attemptId});
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


test('new property methods validate and bind the requested retained run before backend access', async () => {
  const calls = [];
  const backend = {
    runtimePropertiesState: () => ({supported: true, ready: true, version: 1}),
    describeRuntimeProperties: async value => {calls.push(['describe', value]); return {ok: true, result: {mode: 'enumerate'}};},
    readRuntimeProperties: async value => {calls.push(['read', value]); return {ok: true, result: {outcome: 'completed'}};},
    writeRuntimeProperty: async value => {calls.push(['write', value]); return {ok: true, result: {outcome: 'applied'}};},
  };
  const {api, start} = fixture(undefined, undefined, undefined, backend);
  const run = start(); run.state('running');
  const target = {runId: run.identity.runId, path: '/root/Player', expectedInstanceId: '33'};
  assert.equal(api.get_run({runId: target.runId}).result.runtimeProperties.ready, true);
  assert.equal((await api.read_runtime_properties({...target, properties: []})).error.code, 'invalid_input');
  assert.equal((await api.describe_runtime_properties({...target, runId: 'foreign'})).error.code, 'not_found');
  assert.equal((await api.write_runtime_property({...target, property: 'health', value: {type: 'int', value: 1.5}})).error.code, 'invalid_input');
  assert.equal((await api.read_runtime_properties({...target, properties: [{name: 'health', expectedType: 'int'}]}, AbortSignal.abort())).error.code, 'cancelled');
  assert.equal(calls.length, 0);
  await api.describe_runtime_properties(target);
  await api.read_runtime_properties({...target, properties: [{name: 'health', expectedType: 'int'}]});
  await api.write_runtime_property({...target, property: 'health', value: {type: 'int', value: 40}});
  assert.deepEqual(calls.map(([kind]) => kind), ['describe', 'read', 'write']);
  for (const [,input] of calls) {
    assert.equal(input.runId, target.runId); assert.equal(input.timeoutMs, 5000);
    assert.equal(Object.hasOwn(input, 'kind'), false);
  }
  run.exit();
  assert.equal((await api.describe_runtime_properties(target)).error.code, 'run_ended');
  assert.equal(calls.length, 3);
});

test('missing property backend reports an explicit unsupported capability', async () => {
  const {api, start} = fixture(); const run = start(); run.state('running');
  assert.deepEqual(api.get_run({runId: run.identity.runId}).result.runtimeProperties, {supported: false, ready: false});
  assert.equal((await api.describe_runtime_properties({runId: run.identity.runId, path: '/root/Player', expectedInstanceId: '33'})).error.code, 'unsupported');
});

test('property tracing never calls inherited array hooks or rejected input accessors', async () => {
  let getters = 0;
  class Names extends Array {
    get every() {getters++; throw Error('every');}
    get [Symbol.iterator]() {getters++; throw Error('iterator');}
    get toJSON() {getters++; throw Error('toJSON');}
  }
  const inputs = [], trace = [];
  const backend = {describeRuntimeProperties: async input => {inputs.push(input); return {ok: true, result: {mode: 'names'}};}};
  const {api, agent, start} = fixture(undefined, undefined, undefined, backend);
  const run = start();run.state('running');
  const unsubscribe = agent.subscribe(call => trace.push(call));
  const target = {runId: run.identity.runId, path: '/root/Player', expectedInstanceId: '33'};
  assert.equal((await api.describe_runtime_properties({...target, names: new Names('health')})).ok, true);
  assert.deepEqual(inputs[0].names, ['health']);
  assert.deepEqual(trace[0].input.names, ['health']);
  const rejected = {...target, get names() {getters++; return ['health'];}};
  assert.equal((await api.describe_runtime_properties(rejected)).error.code, 'invalid_input');
  assert.deepEqual(trace.at(-1).input, {omitted: true});
  assert.equal(getters, 0);
  unsubscribe();
});
