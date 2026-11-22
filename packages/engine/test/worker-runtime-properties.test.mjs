import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {interactionNow} from '../dist/browser/dedicated/worker-interaction.js';
import {prepareRuntimeProperties, readPropertyCommand, readRuntimeValue, readNativePropertyResult,
  runtimePropertiesError, runtimePropertiesUnconfirmed, createNativeRuntimeProperties,
  supportsWorkerRuntimeProperties} from '../dist/browser/dedicated/worker-runtime-properties.js';

const target = {runId: 'run-1', path: '/root/Main/Player', expectedInstanceId: '9007199254740993'};
const frame = {process: '120', physics: '119', drawn: '118'};
const write = {kind: 'write', path: target.path, expectedInstanceId: target.expectedInstanceId, property: 'health', value: {type: 'int', value: 40}};
const read = {kind: 'read', path: target.path, expectedInstanceId: target.expectedInstanceId,
  properties: [{name: 'health', expectedType: 'int'}, {name: 'name', expectedType: 'string'}, {name: 'enabled', expectedType: 'bool'}]};
const applied = {ok: true, result: {property: 'health', requestedValue: write.value, outcome: 'applied', phase: 'readback', writeEntered: true,
  beforeValue: {type: 'int', value: 100}, comparisonValue: write.value, observedValue: write.value, frame}};

test('property admission snapshots cross-realm inputs and refuses accessors before reading them', () => {
  const input = runInNewContext('(' + JSON.stringify({...target, property: 'health', value: write.value}) + ')');
  const prepared = prepareRuntimeProperties('write', input);
  assert.equal(prepared.ok, true);
  input.value.value = 99;
  assert.equal(prepared.result.command.value.value, 40);
  let called = 0;
  const getter = {...target, get property() {called++; return 'health';}, value: write.value};
  assert.equal(prepareRuntimeProperties('write', getter).error.code, 'invalid_input');
  assert.equal(called, 0);
  assert.equal(prepareRuntimeProperties('read', {...target, properties: [{name: 'x', expectedType: 'float'}, {name: 'x', expectedType: 'float'}]}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', {...target, names: ['health'], limit: 1}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', {...target, names: ['health'], extra: true}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', {...target, expectedInstanceId: '18446744073709551616'}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', target, {aborted: false}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', target, AbortSignal.abort()).error.code, 'cancelled');
});

test('array admission copies own entries without calling inherited methods or iterators', () => {
  let calls = 0;
  class Names extends Array {
    get every() {calls++; throw Error('inherited every');}
    get [Symbol.iterator]() {calls++; throw Error('inherited iterator');}
    get toJSON() {calls++; throw Error('inherited toJSON');}
  }
  const names = new Names('health');
  const described = prepareRuntimeProperties('describe', {...target, names});
  assert.equal(described.ok, true);
  assert.deepEqual(described.result.command.names, ['health']);
  names[0] = 'changed';
  assert.deepEqual(described.result.command.names, ['health']);
  const properties = new Names({name: 'health', expectedType: 'int'});
  assert.equal(prepareRuntimeProperties('read', {...target, properties}).ok, true);
  assert.equal(calls, 0);
  const foreign = runInNewContext(`
    Object.defineProperty(Array.prototype, 'every', {get() {throw Error('foreign every');}});
    Object.defineProperty(Array.prototype, Symbol.iterator, {get() {throw Error('foreign iterator');}});
    Object.defineProperty(Array.prototype, 'toJSON', {get() {throw Error('foreign toJSON');}});
    ['health'];
  `);
  assert.deepEqual(prepareRuntimeProperties('describe', {...target, names: foreign}).result.command.names, ['health']);
  const accessor = ['health'];
  Object.defineProperty(accessor, '0', {get() {calls++; return 'health';}});
  assert.equal(prepareRuntimeProperties('describe', {...target, names: accessor}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeProperties('describe', {...target, names: new Array(1)}).error.code, 'invalid_input');
  assert.equal(calls, 0);
});

test('typed values preserve Unicode and NUL while rejecting coercion and unsafe precision', () => {
  for (const value of [{type: 'int', value: 1.2}, {type: 'int', value: 9007199254740992}, {type: 'bool', value: 1},
    {type: 'float', value: Infinity}, {type: 'float', value: new Number(1)}, {type: 'string', value: '\ud800'},
    {type: 'string', value: '😀'.repeat(257)}, {type: 'vector2', value: {x: 1, y: 2, z: 0}}]) assert.equal(readRuntimeValue(value), undefined);
  for (const value of [{type: 'string', value: 'a\0b你好😀'}, {type: 'int', value: Number.MAX_SAFE_INTEGER},
    {type: 'float', value: Number.MAX_VALUE}, {type: 'vector2', value: {x: 0.1, y: -0.5}}]) assert.deepEqual(readRuntimeValue(value), value);
  assert.equal(readPropertyCommand({...write, value: {type: 'string', value: '\x01'.repeat(1024)}}), undefined,
    'encoded request budget includes JSON escape expansion and internal metadata');
});

test('write receipts preserve uncertainty and require a matching request and actual comparison', () => {
  assert.deepEqual(readNativePropertyResult(write, applied), applied);
  const unconfirmed = runtimePropertiesUnconfirmed('write', 'timeout', write);
  assert.deepEqual(unconfirmed.result.evidence, {phase: 'unknown', writeEntered: 'unknown'});
  assert.deepEqual(readNativePropertyResult(write, unconfirmed), unconfirmed);
  assert.equal(readNativePropertyResult(write, {...applied, result: {...applied.result, requestedValue: {type: 'int', value: 41}}}), undefined);
  assert.equal(readNativePropertyResult(write, {...applied, result: {...applied.result, observedValue: {type: 'int', value: 39}}}), undefined);
  assert.equal(readNativePropertyResult(write, {ok: true, result: {...unconfirmed.result, evidence: {phase: 'unknown', writeEntered: false}}}), undefined);
  const notWritten = {ok: true, result: {property: 'health', requestedValue: write.value, outcome: 'not_written', phase: 'before_read',
    writeEntered: false, reason: 'getter_failed', frame}};
  assert.deepEqual(readNativePropertyResult(write, notWritten), notWritten);
  const clamped = {ok: true, result: {...applied.result, outcome: 'not_applied', observedValue: {type: 'int', value: 30}}};
  assert.deepEqual(readNativePropertyResult(write, clamped), clamped);
});

test('write comparisons stay tied to the requested scalar and every known before value has its declared type', () => {
  for (const [requested, changed] of [
    [{type: 'int', value: 40}, {type: 'int', value: 39}],
    [{type: 'float', value: 0.1}, {type: 'float', value: Math.fround(0.1)}],
    [{type: 'bool', value: true}, {type: 'bool', value: false}],
    [{type: 'string', value: 'a\0b'}, {type: 'string', value: 'a\0c'}],
  ]) {
    const command = {...write, value: requested};
    const reply = {ok: true, result: {...applied.result, requestedValue: requested, beforeValue: requested,
      comparisonValue: changed, observedValue: changed}};
    assert.equal(readNativePropertyResult(command, reply), undefined);
    reply.result.comparisonValue = requested;
    reply.result.outcome = 'not_applied';
    assert.deepEqual(readNativePropertyResult(command, reply), reply, 'a real clamp stays not_applied');
  }
  for (const phase of ['before_read', 'write', 'readback']) {
    const bad = {ok: true, result: {property: write.property, requestedValue: write.value, outcome: 'unconfirmed', reason: 'getter_failed',
      evidence: {phase, writeEntered: phase !== 'before_read', frame, beforeValue: {type: 'string', value: 'wrong'}}}};
    assert.equal(readNativePropertyResult(write, bad), undefined);
  }
  const notWritten = {ok: true, result: {property: write.property, requestedValue: write.value, outcome: 'not_written',
    phase: 'before_read', writeEntered: false, reason: 'output_budget', frame, beforeValue: {type: 'string', value: 'wrong'}}};
  assert.equal(readNativePropertyResult(write, notWritten), undefined);
});

test('native position comparisons allow one consistent real_t conversion and reject unrelated values', () => {
  const requested = {type: 'vector2', value: {x: 0.1, y: 0.2}};
  const rounded = {type: 'vector2', value: {x: Math.fround(0.1), y: Math.fround(0.2)}};
  const command = {...write, property: 'position', value: requested};
  for (const comparisonValue of [requested, rounded]) {
    const reply = {ok: true, result: {...applied.result, property: 'position', requestedValue: requested,
      beforeValue: {type: 'vector2', value: {x: 0, y: 0}}, comparisonValue, observedValue: comparisonValue}};
    assert.deepEqual(readNativePropertyResult(command, reply), reply);
    const bad = {type: 'vector2', value: {x: rounded.value.x, y: requested.value.y}};
    assert.equal(readNativePropertyResult(command, {ok: true, result: {...reply.result, comparisonValue: bad, observedValue: bad}}), undefined);
  }
});

test('batch reads retain completed prefix and distinguish unknown execution from not attempted', () => {
  const reply = {ok: true, result: {outcome: 'completed', frame, stopReason: 'getter_failed', properties: [
    {name: 'health', expectedType: 'int', status: 'value', readEntered: true, value: {type: 'int', value: 100}},
    {name: 'name', expectedType: 'string', status: 'unavailable', readEntered: true, reason: 'getter_failed'},
    {name: 'enabled', expectedType: 'bool', status: 'not_attempted', readEntered: false},
  ]}};
  assert.deepEqual(readNativePropertyResult(read, reply), reply);
  const result = readNativePropertyResult(read, reply);
  reply.result.properties[0].value.value = 99;
  assert.equal(result.result.properties[0].value.value, 100);
  assert.equal(readNativePropertyResult(read, {ok: true, result: {...reply.result, properties: reply.result.properties.slice().reverse()}}), undefined);
  const unknown = runtimePropertiesUnconfirmed('read', 'timeout', read);
  assert.deepEqual(unknown, {ok: true, result: {outcome: 'unconfirmed', reason: 'timeout', evidence: {phase: 'unknown'}}});
  assert.equal(readNativePropertyResult(read, {ok: true, result: {...unknown.result, evidence: {phase: 'unknown', properties: []}}}), undefined);
  for (const properties of [[], [{name: 'health', expectedType: 'int', status: 'not_attempted', readEntered: false}]]) {
    assert.equal(readNativePropertyResult(read, {ok: true, result: {...unknown.result, evidence: {phase: 'read', frame, properties}}}), undefined,
      'a known read phase requires evidence that at least one Get was entered');
  }
  assert.deepEqual(readNativePropertyResult(read, runtimePropertiesError('type_mismatch', 'native')), runtimePropertiesError('type_mismatch', 'native'));
});

test('named discovery distinguishes absent from unresolved, preserves order and truncation facts', () => {
  const command = {kind: 'describe', path: target.path, expectedInstanceId: target.expectedInstanceId, names: ['z', 'a']};
  const reply = {ok: true, result: {mode: 'names', frame, scan: {metadataEntriesVisited: 512, inheritanceLevelsVisited: 2,
    truncated: true, reasons: ['metadata_limit']}, properties: [{name: 'a', status: 'absent'}, {name: 'z', status: 'unresolved', reason: 'metadata_limit'}]}};
  assert.deepEqual(readNativePropertyResult(command, reply), reply);
  assert.equal(readNativePropertyResult(command, {ok: true, result: {...reply.result, properties: [reply.result.properties[1]]}}), undefined);
  assert.equal(readNativePropertyResult(command, {ok: true, result: {...reply.result, properties: reply.result.properties.slice().reverse()}}), undefined);
  assert.equal(readNativePropertyResult(command, {ok: true, result: {...reply.result, scan: {...reply.result.scan, truncated: false}}}), undefined);
  const unicode = {...command, names: ['😀', '\ue000']};
  const unicodeReply = {ok: true, result: {...reply.result, properties: [{name: '\ue000', status: 'absent'}, {name: '😀', status: 'absent'}]}};
  assert.deepEqual(readNativePropertyResult(unicode, unicodeReply), unicodeReply, 'native Godot sorts Unicode code points, not UTF-16 units');
});

test('discovered declaration types and unsupported script math paths are not fabricated', () => {
  const descriptor = {name: 'health', declaredType: {variantType: 2, name: 'int'}, type: 'int', origin: 'godotjs_export',
    readAccess: {status: 'candidate'}, writeAccess: {status: 'candidate'}, readMayExecuteScript: true, writeMayExecuteScript: true, shadowedExport: false};
  const command = {kind: 'describe', path: target.path, expectedInstanceId: target.expectedInstanceId, limit: 32};
  const reply = properties => ({ok: true, result: {mode: 'enumerate', frame,
    scan: {metadataEntriesVisited: 1, inheritanceLevelsVisited: 1, truncated: false, reasons: []}, properties}});
  assert.equal(readNativePropertyResult(command, reply([descriptor])).ok, true);
  assert.equal(readNativePropertyResult(command, reply([{...descriptor, type: 'float'}])), undefined);
  const math = {...descriptor, name: 'motion', declaredType: {variantType: 5, name: 'Vector2'}, type: 'vector2'};
  assert.equal(readNativePropertyResult(command, reply([math])), undefined);
  const unsupported = {status: 'unsupported', reason: 'unsupported_export_type'};
  assert.equal(readNativePropertyResult(command, reply([{...math, readAccess: unsupported, writeAccess: unsupported}])).ok, true);
});

test('native properties passes remaining budget, handles heap growth and never invents failed effects', () => {
  const pointer = 32, memory = new WebAssembly.Memory({initial: 2});
  let executions = 0;
  const module = {get HEAPU8() {return new Uint8Array(memory.buffer);}, _godotjs_runtime_properties_abi: () => 1,
    _godotjs_runtime_observation_buffer: () => pointer,
    _godotjs_runtime_properties_execute(length, micros) {
      executions++;
      assert(micros > 0 && micros <= 30_000_000);
      const input = JSON.parse(new TextDecoder().decode(this.HEAPU8.subarray(pointer, pointer + length)));
      assert.deepEqual(input, {...write, outputBudgetBytes: 60000});
      memory.grow(1);
      const bytes = new TextEncoder().encode(JSON.stringify(applied));
      this.HEAPU8.set(bytes, pointer);
      return bytes.length;
    }};
  module._godotjs_runtime_properties_execute = module._godotjs_runtime_properties_execute.bind(module);
  const execute = createNativeRuntimeProperties(module);
  assert.deepEqual(execute(write, interactionNow() + 1000, 60000), applied);
  assert.equal(execute(write, interactionNow() - 1, 60000).error.code, 'timeout');
  assert.equal(executions, 1);
  const broken = createNativeRuntimeProperties({...module, _godotjs_runtime_properties_execute() {throw Error('lost');}});
  assert.deepEqual(broken(write, interactionNow() + 1000).result.evidence, {phase: 'unknown', writeEntered: 'unknown'});
  assert.equal(broken(read, interactionNow() + 1000).result.outcome, 'unconfirmed');
  assert.throws(() => createNativeRuntimeProperties({...module, _godotjs_runtime_properties_abi: () => 2}), /E_RUNTIME_PROPERTIES_ABI/);
});

test('native receipt validation rejects nested accessors before JSON sizing', () => {
  let getters = 0;
  const hostileFrame = {get process() {getters++; return '1';}, physics: '1', drawn: '1'};
  assert.equal(readNativePropertyResult(write, {...applied, result: {...applied.result, frame: hostileFrame}}), undefined);
  assert.equal(getters, 0);
  class Results extends Array {
    get every() {getters++; throw Error('every');}
    get entries() {getters++; throw Error('entries');}
    get toJSON() {getters++; throw Error('toJSON');}
  }
  const reply = {ok: true, result: {outcome: 'completed', frame, properties: new Results(
    {name: 'health', expectedType: 'int', status: 'value', readEntered: true, value: {type: 'int', value: 100}},
    {name: 'name', expectedType: 'string', status: 'value', readEntered: true, value: {type: 'string', value: 'Player'}},
    {name: 'enabled', expectedType: 'bool', status: 'value', readEntered: true, value: {type: 'bool', value: true}},
  )}};
  assert.equal(readNativePropertyResult(read, reply).result.properties.length, 3);
  assert.equal(getters, 0);
});

test('a malformed native success becomes unknown execution rather than a false applied receipt', () => {
  const pointer = 32, heap = new Uint8Array(131072);
  const malformed = {ok: true, result: {...applied.result, comparisonValue: {type: 'int', value: 39}, observedValue: {type: 'int', value: 39}}};
  const native = createNativeRuntimeProperties({HEAPU8: heap, _godotjs_runtime_properties_abi: () => 1,
    _godotjs_runtime_observation_buffer: () => pointer,
    _godotjs_runtime_properties_execute() {
      const bytes = new TextEncoder().encode(JSON.stringify(malformed));
      heap.set(bytes, pointer);return bytes.length;
    }});
  const result = native(write, interactionNow() + 1000);
  assert.equal(result.result.outcome, 'unconfirmed');
  assert.deepEqual(result.result.evidence, {phase: 'unknown', writeEntered: 'unknown'});
});

test('property capability requires the new ABI and Direct presentation', () => {
  assert.equal(supportsWorkerRuntimeProperties({runtimeAbi: {runtimeProperties: 1}}, 'direct'), true);
  assert.equal(supportsWorkerRuntimeProperties({runtimeAbi: {runtimeWrite: 1}}, 'direct'), false);
  assert.equal(supportsWorkerRuntimeProperties({runtimeAbi: {runtimeProperties: 1}}, 'bitmap'), false);
});
