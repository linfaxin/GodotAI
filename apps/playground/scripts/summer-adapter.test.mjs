import assert from 'node:assert/strict';
import test from 'node:test';
import {createSummerDispatcher, parseSummerValue, SUMMER_COMPATIBILITY} from '../src/summer-adapter.ts';

const identity = {runId: 'run-1', revision: 7, buildKey: 'build-1', generation: 1, documentId: 'doc-1', workerId: 'worker-1', runConfigurationHash: 'a'.repeat(64)};
const target = {path: '/root/Main/Player', instanceId: '12345', name: 'Player', type: 'Node2D', parentPath: '/root/Main'};
const frame = {process: '120', physics: '119', drawn: '118'};
const releaseId = 'b'.repeat(64);
const error = (code, source = 'native') => ({ok: false, error: {code, message: code, source}});
const ok = result => ({ok: true, result});
function fixture() {
  const context = {projectId: 'project-1', editorRevision: 7, activeRunId: identity.runId, pendingAttemptId: null};
  const calls = [];
  const state = {properties: {supported: true, ready: true, version: 1}, legacy: {supported: true, ready: true},
    writeReply: undefined, oldWriteReply: undefined, beforeTree: undefined};
  let sequence = 0;
  const receipt = input => ({requestId: identity.runId + ':' + ++sequence, accessSequence: sequence, run: {...identity, runId: input.runId}, releaseId,
    path: input.path, expectedInstanceId: input.expectedInstanceId});
  const record = (name, input) => calls.push({name, input});
  const backend = {
    captureContext() {return {...context};},
    getProjectContext() {record('context'); return ok({...context});},
    play(input) {record('play', input); return ok({attemptId: 'build-17'});},
    cancelLaunch(input) {record('cancel', input);},
    getBuild(input) {record('build', input); return ok({preview: {status: 'session-created', runId: 'derived-old'}});},
    getRun(input) {record('run', input); return ok({state: 'running', runtimeProperties: {...state.properties}, runtimeWrite: {...state.legacy}});},
    stop(input) {record('stop', input); return ok({status: 'stopping', runId: input.runId});},
    async getRuntimeTree(input) {record('tree', input); await state.beforeTree?.(); return ok({run: {...identity, runId: input.runId}, releaseId, requestId: 'query-1', sampleSeq: 1, nodes: [target], truncated: false});},
    async inspectRuntimeNode(input) {record('inspect', input); return ok({run: {...identity, runId: input.runId}, releaseId, node: target, properties: [], requestId: 'query-2', sampleSeq: 2});},
    async describeRuntimeProperties(input) {
      record('describe', input);
      const name = input.names[0], type = name === 'health' ? 'int' : name === 'move_step' ? 'float' : name === 'position' ? 'vector2' : name === 'enabled' ? 'bool' : 'string';
      return {ok: true, receipt: receipt(input), result: {mode: 'names', frame, scan: {metadataEntriesVisited: 1, inheritanceLevelsVisited: 1, truncated: false, reasons: []},
        properties: [{name, status: 'found', descriptor: {name, declaredType: {variantType: 2, name: type}, type, origin: 'godotjs_export',
          readAccess: {status: 'candidate'}, writeAccess: {status: 'candidate'}, readMayExecuteScript: true, writeMayExecuteScript: true, shadowedExport: false}}]}};
    },
    async writeRuntimeProperty(input) {record('write', input); return state.writeReply ?? {ok: true, receipt: receipt(input), result: {property: input.property,
      requestedValue: input.value, outcome: 'applied', phase: 'readback', writeEntered: true, frame,
      beforeValue: {type: input.value.type, value: input.value.type === 'int' ? 100 : input.value.value}, comparisonValue: input.value, observedValue: input.value}};},
    async runtimeSet(input) {record('legacy', input); return state.oldWriteReply ?? ok({requestId: 'old:1', run: identity, releaseId,
      path: input.path, expectedInstanceId: input.expectedInstanceId, property: 'position', requestedValue: input.value, outcome: 'applied', observedValue: input.value});},
    async screenshot(input) {record('screenshot', input); return ok({run: identity, releaseId, bytes: new Uint8Array([137,80,78,71]).buffer});},
  };
  return {context, state, calls, backend, dispatch: createSummerDispatcher(backend)};
}

const set = (property = 'health', value = 40, extra = {}) => ({op: 'engine.runtime_set', input: {path: target.path, property, value, ...extra}});

test('unsupported and malformed parameters are rejected before any backend call', async () => {
  const {dispatch, calls} = fixture();
  const cases = [
    [{op: 'engine.game_probe'}, 'unsupported'],
    [{op: 'engine.play', input: {focus: false}}, 'unsupported'],
    [{op: 'engine.get_runtime_tree', input: {maxCharacters: 4000}}, 'unsupported'],
    [{op: 'engine.get_runtime_tree', input: {depth: 0}}, 'invalid_input'],
    [{op: 'engine.get_runtime_tree', input: {depth: 9}}, 'unsupported'],
    [{op: 'engine.inspect_runtime_node', input: {path: target.path, properties: ['health']}}, 'invalid_input'],
    [{op: 'engine.inspect_runtime_node', input: {path: target.path, instance: 'main'}}, 'invalid_input'],
    [{op: 'engine.screenshot'}, 'invalid_input'],
    [{op: 'engine.screenshot', input: {target: 0}}, 'invalid_input'],
    [{op: 'engine.screenshot', input: {target: 'scene'}}, 'unsupported'],
    [set('health', 40, {field: ''}), 'unsupported'],
    [set('script', 'anything'), 'unsupported'],
    [set('health', Infinity), 'invalid_input'],
    [set('health', 40, {instance: 'other'}), 'unsupported'],
    [{op: 'engine.play', input: []}, 'invalid_input'],
  ];
  for (const [input, code] of cases) assert.equal((await dispatch(input)).error.code, code, JSON.stringify(input));
  let getters = 0;
  assert.equal((await dispatch({get op() {getters++; return 'engine.play';}})).error.code, 'invalid_input');
  assert.equal(getters, 0);
  assert.deepEqual(calls, []);
});

test('tree uses Summer subset defaults and inspect never invokes script getters', async () => {
  const {dispatch, calls} = fixture();
  assert.equal((await dispatch({op: 'engine.get_runtime_tree'})).ok, true);
  assert.deepEqual(calls.find(call => call.name === 'tree').input, {runId: identity.runId, depth: 3, limit: 500});
  const inspected = await dispatch({op: 'engine.inspect_runtime_node', input: {path: target.path}});
  assert.equal(inspected.ok, true);
  assert.deepEqual(calls.find(call => call.name === 'inspect').input, {runId: identity.runId, path: target.path, properties: ['position', 'rotation', 'visible']});
  assert.equal(calls.some(call => call.name === 'describe' || call.name === 'write'), false);
  const image = await dispatch({op: 'engine.screenshot', input: {target: 'game'}});
  assert.deepEqual(new Uint8Array(image.result.data.bytes), new Uint8Array([137,80,78,71]));
  assert.deepEqual(image.result.godotai.compatibility, SUMMER_COMPATIBILITY);
});

test('new property writes discover type, preserve receipts and bind the original run across awaits', async () => {
  const {dispatch, context, state, calls} = fixture();
  state.beforeTree = async () => {context.activeRunId = 'replacement'; context.editorRevision++;};
  const response = await dispatch(set());
  assert.equal(response.ok, true);
  assert.equal(response.result.data.route, 'runtime_properties');
  assert.deepEqual(response.result.data.payload.result.beforeValue, {type: 'int', value: 100});
  for (const call of calls.filter(call => ['tree','describe','write'].includes(call.name))) assert.equal(call.input.runId, identity.runId);
  assert.deepEqual(calls.find(call => call.name === 'write').input.value, {type: 'int', value: 40});
  assert.equal(calls.some(call => call.name === 'legacy'), false);
});

test('new runtime errors and unknown results never fall back to a second setter', async () => {
  const {dispatch, state, calls} = fixture();
  state.writeReply = error('busy');
  let response = await dispatch(set());
  assert.equal(response.error.code, 'busy');
  assert.equal(response.error.source, 'native');
  assert.deepEqual(response.error.details.godotai.backendError, state.writeReply.error);
  state.writeReply = {ok: true, receipt: {requestId: 'test'}, result: {property: 'health', requestedValue: {type: 'int', value: 40},
    outcome: 'unconfirmed', reason: 'timeout', evidence: {phase: 'unknown', writeEntered: 'unknown'}}};
  response = await dispatch(set());
  assert.equal(response.error.code, 'outcome_unknown');
  assert.equal(response.error.retry, 'no');
  assert.equal(response.error.details.godotai.receipt.result.outcome, 'unconfirmed');
  assert.equal(Object.hasOwn(response.error.details.godotai.receipt.result, 'applied'), false);
  assert.equal(calls.filter(call => call.name === 'write').length, 2);
  assert.equal(calls.some(call => call.name === 'legacy'), false);
});

test('only an explicitly unsupported new capability permits the legacy route without fabricated fields', async () => {
  const {dispatch, state, calls} = fixture();
  for (const properties of [{supported: null, ready: false}, {supported: true, ready: false}]) {
    state.properties = properties;
    assert.equal((await dispatch(set('position', 'Vector2(192, 256)'))).error.code, 'not_ready');
  }
  assert.equal(calls.some(call => ['tree','legacy','write'].includes(call.name)), false);
  state.properties = {supported: false, ready: false};
  const response = await dispatch(set('position', 'Vector2(192, 256)'));
  assert.equal(response.result.data.route, 'legacy_write');
  assert.equal(Object.hasOwn(response.result.data.payload.result, 'beforeValue'), false);
  assert.equal(Object.hasOwn(response.result.data.payload.result, 'frame'), false);
  assert.equal(calls.filter(call => call.name === 'legacy').length, 1);
  assert.equal(calls.some(call => call.name === 'describe'), false);
  assert.equal((await dispatch(set('health', 40))).error.code, 'unsupported');
});

test('stop cancels the captured attempt and stops only its owned and captured runs', async () => {
  const {backend, dispatch, context, calls} = fixture();
  context.pendingAttemptId = 'pending-old';
  backend.cancelLaunch = attemptId => {calls.push({name: 'cancel', input: attemptId}); context.activeRunId = 'new-run'; context.pendingAttemptId = 'new-attempt';};
  const response = await dispatch({op: 'engine.stop'});
  assert.deepEqual(calls.filter(call => call.name === 'stop').map(call => call.input.runId), [identity.runId, 'derived-old']);
  assert.equal(response.result.data.cancelledAttemptId, 'pending-old');
  assert.equal(response.result.data.capturedRunId, identity.runId);
  assert.equal(response.result.data.pendingAttemptId, 'pending-old');
  assert.equal(response.result.data.no_target, false);
});

test('play reports an accepted attempt and preserves the local frozen-editor semantics', async () => {
  const {dispatch, calls} = fixture();
  const response = await dispatch({op: 'engine.play', input: {instance: 'main'}});
  assert.deepEqual(response.result.data, {accepted: true, state: 'pending', attemptId: 'build-17', run: null, projectId: 'project-1', editorRevision: 7});
  assert.deepEqual(calls, [{name: 'play', input: {projectId: 'project-1', expectedEditorRevision: 7}}]);
});

test('literal parsing is type-directed and never coerces scalar strings or evaluates expressions', () => {
  assert.deepEqual(parseSummerValue('string', 'Vector2(1, 2)'), {type: 'string', value: 'Vector2(1, 2)'});
  assert.deepEqual(parseSummerValue('vector2', 'Vector2(+1e2, -.5)'), {type: 'vector2', value: {x: 100, y: -0.5}});
  for (const value of ['Vector2(1,2);alert(1)', 'Vector2(1,2)\n', 'Vector2(NaN,1)', 'Vector2(1e999,2)', 'Vector3(1,2,3)', {x:1,y:2}]) assert.equal(parseSummerValue('vector2', value), undefined);
  assert.equal(parseSummerValue('int', '40'), undefined);
  assert.equal(parseSummerValue('bool', 1), undefined);
});
