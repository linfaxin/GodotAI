import assert from 'node:assert/strict';
import test from 'node:test';
import {CONSOLE_OPERATIONS, getConsoleOperation} from '../src/workbench/api-console-catalog.ts';
import {SUMMER_OPERATION_SPECS, SUMMER_TREE_LIMITS, SUMMER_COMPATIBILITY, SUMMER_REFERENCE} from '../src/summer-operation-spec.ts';
import {createSummerDispatcher} from '../src/summer-adapter.ts';

const summerIds = ['engine.get_project_context', 'engine.get_diagnostics', 'engine.play', 'engine.stop', 'engine.is_running', 'engine.recent_events', 'engine.wait_for_event',
  'engine.get_runtime_tree', 'engine.inspect_runtime_node', 'engine.runtime_set', 'engine.runtime_call', 'engine.screenshot', 'engine.game_probe', 'engine.game_input'];
const localIds = ['describe_runtime_methods', 'check', 'wait_for_event', 'describe_runtime_properties', 'read_runtime_properties', 'game_input', 'wait_for_input'];
const cancellable = new Set(['engine.get_runtime_tree', 'engine.inspect_runtime_node', 'engine.runtime_set', 'engine.runtime_call', 'engine.screenshot', 'engine.game_probe', 'engine.game_input',
  'engine.wait_for_event', 'wait_for_event', 'describe_runtime_methods', 'describe_runtime_properties', 'read_runtime_properties', 'wait_for_input']);
const operation = id => {
  const item = getConsoleOperation(id);
  assert.ok(item, id);
  return item;
};

test('the console exposes fourteen Summer operations and seven local helpers', () => {
  assert.deepEqual(CONSOLE_OPERATIONS.map(item => item.id), [...summerIds, ...localIds]);
  assert.deepEqual(CONSOLE_OPERATIONS.filter(item => item.family === 'summer').map(item => item.id), summerIds);
  assert.deepEqual(CONSOLE_OPERATIONS.filter(item => item.family === 'local').map(item => item.id), localIds);
  assert.equal(new Set(CONSOLE_OPERATIONS.map(item => item.id)).size, 21);
  assert.equal(operation('engine.get_diagnostics').binding, 'none');
  assert.deepEqual(operation('engine.get_diagnostics').createPreset(), {input: {}, missing: []});
  for (const item of CONSOLE_OPERATIONS) {
    assert.equal(item.acceptsSignal, cancellable.has(item.id), item.id);
    assert.equal(item.resultKind, item.id === 'engine.screenshot' ? 'game-screenshot' : item.id === 'engine.game_probe' ? 'game-probe' : 'json');
    assert.ok(item.description && item.parameters && item.limitations.length, item.id);
  }
  for (const id of ['summer_call', 'get_run', 'write_runtime_property', '__proto__', 'constructor'])
    assert.equal(getConsoleOperation(id), undefined, id);
  assert.equal(SUMMER_REFERENCE.version, '4.9.2');
  assert.deepEqual(SUMMER_COMPATIBILITY, {input: 'subset', semantics: 'partial', payload: 'godotai-typed-v1', summerNativeFixture: false});
});

test('all routes preserve the raw input, return and signal contract without validating or coercing it', () => {
  const calls = [], response = {ok: false, error: {code: 'invalid_input'}};
  const api = Object.fromEntries(['summer_call', ...localIds].map(name => [name, (...args) => {
    calls.push({name, args});
    return response;
  }]));
  const input = Object.freeze({not_a_supported_parameter: true}), signal = new AbortController().signal;
  for (const item of CONSOLE_OPERATIONS) {
    calls.length = 0;
    assert.equal(item.invoke(api, input, signal), response, item.id);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.name, item.family === 'summer' ? 'summer_call' : item.id);
    assert.equal(call.args.length, item.acceptsSignal ? 2 : 1, item.id);
    if (item.family === 'summer') {
      assert.deepEqual(Object.keys(call.args[0]), ['op', 'input']);
      assert.equal(call.args[0].op, item.id);
      assert.equal(call.args[0].input, input);
    } else assert.equal(call.args[0], input);
    if (item.acceptsSignal) assert.equal(call.args[1], signal);
  }
  // JSON primitives also reach the authoritative endpoint, rather than becoming an empty object.
  operation('check').invoke(api, null);
  assert.equal(calls.at(-1).args[0], null);
});

test('missing template sources stay absent and are explained, never replaced by plausible IDs', () => {
  for (const id of ['engine.inspect_runtime_node', 'engine.runtime_set', 'check', 'wait_for_event',
    'describe_runtime_properties', 'read_runtime_properties', 'game_input', 'wait_for_input']) {
    const preset = operation(id).createPreset();
    assert.ok(preset.missing.length, id);
    assert.doesNotMatch(JSON.stringify(preset.input), /\$\{|run-1|project-1|实际节点路径/);
    for (const key of ['runId', 'attemptId', 'path', 'expectedInstanceId', 'operationId', 'projectId', 'expectedEditorRevision'])
      assert.equal(Object.hasOwn(preset.input, key), false, id + '.' + key);
  }
  assert.deepEqual(operation('engine.get_runtime_tree').createPreset(), {input: {depth: 3, limit: 500}, missing: []});
  assert.deepEqual(operation('engine.screenshot').createPreset(), {input: {target: 'game'}, missing: []});
});

test('templates derive identities from explicit sources and retain paired input receipts', () => {
  const context = {
    editorProjectId: 'editor-project', editorRevision: 13, activeRunId: 'ambient-run', pendingAttemptId: 'ambient-attempt',
    target: {runId: 'selected-run', path: '/root/Main/Player', expectedInstanceId: '12345'},
    properties: [{name: 'health', type: 'int'}, {name: 'position', type: 'vector2'}],
    input: {runId: 'receipt-run', operationId: 'receipt-operation'},
  };
  assert.deepEqual(operation('check').createPreset(context), {input: {projectId: 'editor-project', expectedEditorRevision: 13}, missing: []});
  const described = operation('describe_runtime_properties').createPreset(context);
  assert.deepEqual(described, {input: {names: ['health', 'move_step'], ...context.target}, missing: []});
  assert.deepEqual(operation('read_runtime_properties').createPreset(context), {
    input: {...context.target, properties: [{name: 'health', expectedType: 'int'}, {name: 'position', expectedType: 'vector2'}]}, missing: [],
  });
  assert.deepEqual(operation('wait_for_input').createPreset(context), {input: {...context.input, timeoutMs: 5000}, missing: []});
  assert.deepEqual(operation('wait_for_input').createPreset({activeRunId: 'replacement'}),
    {input: {timeoutMs: 5000}, missing: ['同一次 game_input 的 runId/operationId']});
  const summerWrite = operation('engine.runtime_set').createPreset(context);
  assert.deepEqual(summerWrite, {input: {property: 'position', value: 'Vector2(192, 256)', path: context.target.path}, missing: []});
  for (const key of ['runId', 'expectedInstanceId', 'field']) assert.equal(Object.hasOwn(summerWrite.input, key), false);
  assert.equal(operation('game_input').createPreset(context).input.runId, 'selected-run');
  assert.equal(operation('game_input').createPreset({...context, runId: 'explicit-run'}).input.runId, 'explicit-run');
});

test('wait templates select exactly one explicit identity and support the second launch and original exit', () => {
  const ambient = {pendingAttemptId: 'other-attempt', activeRunId: 'other-run'};
  assert.deepEqual(operation('wait_for_event').createPreset({...ambient, attemptId: 'second-play'}),
    {input: {until: 'running', timeoutMs: 60000, attemptId: 'second-play'}, missing: []});
  assert.deepEqual(operation('wait_for_event').createPreset({...ambient, runId: 'stopped-run', until: 'exited'}),
    {input: {until: 'exited', timeoutMs: 10000, runId: 'stopped-run'}, missing: []});
  assert.deepEqual(operation('wait_for_event').createPreset(ambient),
    {input: {until: 'running', timeoutMs: 60000, attemptId: 'other-attempt'}, missing: []});
});

test('editing a preset never mutates the next operation template or the shared whitelist', () => {
  const context = {target: {runId: 'run', path: '/root/Main/Player', expectedInstanceId: '7'}, properties: [{name: 'health', type: 'int'}]};
  const describe = operation('describe_runtime_properties').createPreset(context);
  describe.input.names.push('private');
  assert.deepEqual(operation('describe_runtime_properties').createPreset(context).input.names, ['health', 'move_step']);
  operation('game_input').createPreset(context).input.gesture.code = 'NotAKey';
  assert.equal(operation('game_input').createPreset(context).input.gesture.code, 'ArrowRight');
  operation('read_runtime_properties').createPreset(context).input.properties[0].name = 'private';
  assert.equal(operation('read_runtime_properties').createPreset(context).input.properties[0].name, 'health');
  for (const id of summerIds) {
    assert.ok(Object.isFrozen(SUMMER_OPERATION_SPECS[id].allowed));
    assert.equal(operation(id).parameters, SUMMER_OPERATION_SPECS[id].parameters);
  }
});

test('every catalogued unsupported Summer field is rejected by the real adapter before backend access', async () => {
  let backendCalls = 0;
  const backend = new Proxy({}, {get() {backendCalls++; throw Error('backend must not be accessed');}});
  const dispatch = createSummerDispatcher(backend);
  for (const [op, spec] of Object.entries(SUMMER_OPERATION_SPECS)) {
    for (const field of spec.unsupported) {
      const result = await dispatch({op, input: {[field]: null}});
      assert.equal(result.ok, false, op + '.' + field);
      assert.equal(result.error.code, 'unsupported');
      assert.equal(result.error.details.godotai.parameter, field);
    }
  }
  assert.equal(backendCalls, 0);
});

test('runtime tree defaults and supported limits share the adapter data without changing rejection semantics', async () => {
  const calls = [];
  const dispatch = createSummerDispatcher({
    captureContext: () => ({projectId: 'project', editorRevision: 1, activeRunId: 'run', pendingAttemptId: null}),
    getRun: () => ({ok: true, result: {state: 'running'}}),
    getRuntimeTree: async input => {calls.push(input); return {ok: true, result: {nodes: [], run: {runId: 'run'}}};},
  });
  const result = await dispatch({op: 'engine.get_runtime_tree'});
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {runId: 'run', ...SUMMER_OPERATION_SPECS['engine.get_runtime_tree'].defaultInput});
  for (const key of ['depth', 'limit']) {
    const bounds = SUMMER_TREE_LIMITS[key];
    for (const [value, code] of [[bounds.min - 1, 'invalid_input'], [bounds.max + 1, 'unsupported']]) {
      const rejected = await dispatch({op: 'engine.get_runtime_tree', input: {[key]: value}});
      assert.equal(rejected.error.code, code);
      assert.equal(calls.length, 1);
    }
    assert.equal((await dispatch({op: 'engine.get_runtime_tree', input: {[key]: bounds.max}})).ok, true);
    calls.splice(1);
  }
});
