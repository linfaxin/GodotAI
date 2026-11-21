import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {runInNewContext} from 'node:vm';
import {legacyExecution} from '../dist/execution.js';
import {createSessionFacts} from '../dist/session-facts.js';
import {RUN_PHASES} from '../dist/browser/protocol.js';
import {WorkerPreviewRunner, prepareRuntimeObservation} from '../dist/browser/dedicated/worker-runner.js';
import {interactionNow} from '../dist/browser/dedicated/worker-interaction.js';
import {
  createNativeRuntimeSampler, installRuntimeObservationHooks, observationOk, readRuntimeObservationResult,
} from '../dist/browser/dedicated/worker-runtime-observation.js';
import {
  createRuntimeObservationRelay, createWorkerObservationRequests,
} from '../dist/browser/dedicated/worker-runtime-observation-transport.js';
import {createNativeRuntimeWriter, prepareRuntimeSet, readRuntimeWriteResult, runtimeWriteError} from '../dist/browser/dedicated/worker-runtime-write.js';
import {createRuntimeWriteRelay, createWorkerRuntimeWrites, readRuntimeWriteId} from '../dist/browser/dedicated/worker-runtime-write-transport.js';

const root = {name: 'runtime', path: '/runtime', parentPath: null, type: 'Window', instanceId: '9007199254740993'};
const player = {name: '玩家', path: '/runtime/玩家', parentPath: '/runtime', type: 'Node2D', instanceId: '9007199254740995'};
const tree = {kind: 'tree', depth: 1, limit: 2};
const inspect = {kind: 'node', path: player.path, properties: ['position', 'visible']};
const nodes = {nodes: [root, player], truncated: false};
const properties = {node: player, properties: [{name: 'position', value: {x: 64, y: 0}}, {name: 'visible', value: false}]};
const request = (requestId, timeout = 1000) => ({requestId, deadline: interactionNow() + timeout, query: tree});

test('runtime input norms and error ordering are shared with Playground callers', () => {
  assert.deepEqual(prepareRuntimeObservation('tree', {runId: 'run', depth: 0, limit: 1}), {
    ok: true, result: {runId: 'run', timeoutMs: 5000, query: {kind: 'tree', depth: 0, limit: 1}},
  });
  for (const path of ['runtime/player', '/', '//runtime', '/runtime/', '/runtime/../player', '/runtime/%player', '/runtime/player:position', '/r/' + '🙂'.repeat(513)]) {
    assert.equal(prepareRuntimeObservation('node', {runId: 'r', path, properties: ['position']}).error.code, 'invalid_input');
  }
  const signal = AbortSignal.abort();
  assert.equal(prepareRuntimeObservation('node', {runId: 'r', ...inspect}, signal).error.code, 'cancelled');
  assert.equal(prepareRuntimeObservation('node', {runId: 'r', ...inspect, properties: ['position', 'position']}, signal).error.code, 'invalid_input');
  assert.equal(prepareRuntimeObservation('tree', {runId: 'r'}, {aborted: false}).error.code, 'invalid_input');
});

test('result DTOs retain exact identities and a partial observation without inventing values', () => {
  const partial = {node: player, properties: [{name: 'position', unavailable: 'non_finite'}, properties.properties[1]]};
  assert.deepEqual(readRuntimeObservationResult(inspect, observationOk(partial)), observationOk(partial));
  assert.equal(readRuntimeObservationResult(inspect, observationOk({...partial, node: {...player, instanceId: 9007199254740992}})), undefined);
  assert.equal(readRuntimeObservationResult(inspect, observationOk({...partial, properties: [{name: 'position', value: {x: NaN, y: 0}}, partial.properties[1]]})), undefined);
  assert.deepEqual(readRuntimeObservationResult({kind: 'tree', depth: 0, limit: 1}, observationOk({nodes: [root], truncated: false})),
    observationOk({nodes: [root], truncated: false}));
  assert.equal(readRuntimeObservationResult({...tree, depth: 0}, observationOk(nodes)), undefined);
  assert.equal(readRuntimeObservationResult(tree, observationOk({nodes: [player, root], truncated: false})), undefined);
});

test('native observation handshake verifies exports and reads a replacement heap after sampling', () => {
  const page = 65536;
  const pointer = 32;
  const memory = new WebAssembly.Memory({initial: 2});
  const module = {
    get HEAPU8() { return new Uint8Array(memory.buffer); },
    _godotjs_runtime_observation_abi: () => 1,
    _godotjs_runtime_observation_buffer: () => pointer,
    _godotjs_runtime_observation_sample(length) {
      assert.deepEqual(JSON.parse(new TextDecoder().decode(this.HEAPU8.subarray(pointer, pointer + length))), inspect);
      const old = this.HEAPU8;
      memory.grow(1);
      assert.equal(old.byteLength, 0);
      const output = new TextEncoder().encode(JSON.stringify(observationOk(properties)));
      this.HEAPU8.set(output, pointer);
      return output.byteLength;
    },
  };
  // Emscripten exports are standalone functions. The stub also accepts that ABI.
  module._godotjs_runtime_observation_sample = module._godotjs_runtime_observation_sample.bind(module);
  const sampler = createNativeRuntimeSampler(module);
  assert.deepEqual(sampler(inspect), observationOk(properties));
  assert.throws(() => createNativeRuntimeSampler({...module, _godotjs_runtime_observation_abi: () => 2}), /E_RUNTIME_OBSERVATION_ABI/);
  assert.throws(() => createNativeRuntimeSampler({...module, _godotjs_runtime_observation_sample: undefined}), /E_RUNTIME_OBSERVATION_ABI/);
  assert.throws(() => createNativeRuntimeSampler({...module, _godotjs_runtime_observation_buffer: () => page * 3 - 1}), /E_RUNTIME_OBSERVATION_BUFFER/);
  assert.equal(createNativeRuntimeSampler({...module, _godotjs_runtime_observation_sample: () => page + 1})(inspect).error.code, 'observation_failed');
});

test('only a native loop end admits sampling, after existing hooks and with no render submission', () => {
  const order = [], replies = [];
  const worker = createWorkerObservationRequests(() => {
    order.push('sample');
    return observationOk(nodes);
  }, reply => replies.push(reply));
  const module = {
    godotWorkerEndIteration: () => order.push('previous-end'),
    postMainLoop: () => order.push('previous-post'),
  };
  const remove = installRuntimeObservationHooks(module, worker.observe);
  module.postMainLoop();
  module.godotWorkerEndIteration(1, 0); module.postMainLoop();
  worker.request(request('first'));
  module.postMainLoop();
  assert.equal(replies.length, 0);
  module.godotWorkerEndIteration(2, 0); module.postMainLoop();
  assert.deepEqual(order, ['previous-post', 'previous-end', 'previous-post', 'previous-post', 'previous-end', 'previous-post', 'sample']);
  assert.deepEqual(replies, [{requestId: 'first', result: observationOk(nodes), sampleSeq: 1}]);
  worker.request(request('stopping'));
  module.godotWorkerEndIteration(3, 0);
  worker.stop();
  module.postMainLoop();
  assert.equal(replies.at(-1).result.error.code, 'run_ended');
  assert.equal(order.filter(value => value === 'sample').length, 1);
  remove();
  assert.equal(module.postMainLoop(), order.length);
});

test('worker observation is retired on reentrant stop and does not consume a success sequence', () => {
  const replies = [];
  let stops = true;
  const worker = createWorkerObservationRequests(() => {
    if (stops) worker.stop();
    return observationOk(nodes);
  }, reply => replies.push(reply));
  worker.request(request('stop'));
  worker.request(request('busy'));
  worker.observe();
  stops = false;
  worker.request(request('next'));
  worker.cancel('stop');
  worker.observe();
  assert.deepEqual(replies.map(reply => [reply.requestId, reply.result.error?.code, reply.sampleSeq]), [
    ['busy', 'busy', undefined], ['stop', 'run_ended', undefined], ['next', undefined, 1],
  ]);
});

test('relay keeps physical credit through logical expiry and recovers after the receipt', async t => {
  const replies = [], packets = [];
  const relay = createRuntimeObservationRelay(packet => packets.push(packet), reply => replies.push(reply));
  t.after(relay.dispose);
  relay.request(request('old', 20));
  await delay(35);
  assert.equal(replies.at(-1).result.error.code, 'timeout');
  relay.request(request('unconfirmed-delivery'));
  assert.equal(replies.at(-1).result.error.code, 'busy');
  assert.equal(packets.length, 1);
  relay.receipt(1);
  relay.request(request('new'));
  relay.reply({requestId: 'old', result: observationOk(nodes), sampleSeq: 1});
  relay.request(request('while-new'));
  assert.equal(packets.length, 2);
  relay.reply({requestId: 'new', result: observationOk(nodes), sampleSeq: 2});
  assert.deepEqual(replies.at(-1), {requestId: 'new', result: observationOk(nodes), sampleSeq: 2});
  relay.request(request('after-result'));
  assert.equal(packets.length, 3);
});

test('relay bounds cancellation packets and rejects a reply for a retired logical request', t => {
  const replies = [], packets = [];
  const relay = createRuntimeObservationRelay(packet => packets.push(packet), reply => replies.push(reply));
  t.after(relay.dispose);
  relay.request(request('first'));
  relay.receipt(1);
  relay.cancel('first');
  relay.cancel('first');
  relay.request(request('second'));
  relay.receipt(3);
  relay.cancel('second');
  assert.deepEqual(packets.map(packet => packet.type), [
    'runtime-observation-request', 'runtime-observation-cancel', 'runtime-observation-request',
  ]);
  relay.receipt(2);
  relay.request(request('third'));
  relay.reply({requestId: 'second', result: observationOk(nodes), sampleSeq: 1});
  assert.deepEqual(replies, []);
  relay.stop();
  assert.equal(replies[0].requestId, 'third');
  assert.equal(replies[0].result.error.code, 'run_ended');
});

async function runnerFixture(t, {advertised = true, confirmed = advertised, write = false, writesConfirmed = write,
  presentationBackend = 'direct'} = {}) {
  const asset = name => ({url: 'https://preview.example/' + name, sha256: '1'.repeat(64)});
  const runtimeAbi = {protocolVersion: 2, host: 1, audio: 1, presentation: 1,
    ...(advertised ? {observation: 1, lifecycle: 1} : {}), ...(write ? {runtimeWrite: 1} : {})};
  let port, identity;
  const document = {
    location: {origin: 'https://editor.example'},
    visibilityState: 'hidden',
    createElement() {
      return {ownerDocument: document, setAttribute() {}, remove() {}, contentWindow: {
        postMessage(connect, _origin, [host]) {
          port = host;
          const {type, editorOrigin, ...header} = connect;
          identity = header;
          host.on('message', message => {
            if (message.type === 'run') {
              for (const phase of RUN_PHASES.slice(1)) host.postMessage({...header, type: 'phase', phase,
                ...(phase === 'running' && confirmed ? {observationVersion: 1} : {}),
                ...(phase === 'running' && writesConfirmed && presentationBackend === 'direct' ? {runtimeWriteVersion: 1} : {})});
            }
            if (message.type === 'stop') host.postMessage({...header, type: 'exit-report',
              engineOutcome: {kind: 'native-exit', code: 0}, hostCleanup: {status: 'complete'},
              sessionFacts: createSessionFacts({nativeExit: {code: 0}, hostCleanup: 'complete'}),
            });
          });
          host.postMessage({...header, type: 'connected'});
        },
      }};
    },
  };
  const container = {ownerDocument: document, append(frame) {queueMicrotask(() => frame.onload());}};
  const runner = new WorkerPreviewRunner({container, previewUrl: 'https://preview.example/',
    configuration: {presentationBackend}, release: {releaseId: 'test-release', profile: 'full-engine-v1', engineTarget: 'template_debug', runtimeAbi,
      execution: {...legacyExecution(), ...(advertised ? {lifecycleAbi: 1} : {})}, engineJs: asset('engine.js'),
      engineWasm: asset('engine.wasm'), runtimeWorker: asset('runtime.worker.js'), runtimeAudioWorklet: asset('worklet.js')},
  });
  t.after(async () => { await runner.dispose(); port?.close(); });
  const artifact = {generation: 1, revision: 1, buildKey: 'key', pack: new Uint8Array([1]), manifest: {generation: 1}};
  const run = await runner.run(artifact);
  return {runner, run, port, reply: (fields, header = identity) => port.postMessage({...header, type: 'runtime-observation-result', ...fields})};
}

test('Runner enforces support, request and complete session identities on the public path', async t => {
  const {runner, run, port, reply} = await runnerFixture(t);
  const input = {runId: run.runId, depth: 1, limit: 2, timeoutMs: 1000};
  assert.deepEqual(runner.observationState(run.runId), {supported: true, ready: true, version: 1});
  assert.equal((await runner.getRuntimeTree({...input, runId: 'foreign'})).error.code, 'not_found');
  const posted = once(port, 'message');
  const pending = runner.getRuntimeTree(input);
  assert.equal((await runner.getRuntimeTree(input)).error.code, 'busy');
  const [{requestId, type}] = await posted;
  assert.equal(type, 'runtime-observation-request');
  reply({requestId, result: observationOk(nodes), sampleSeq: 1}, {...run, protocolVersion: 2, workerId: 'foreign'});
  reply({requestId: 'wrong-request', result: observationOk(nodes), sampleSeq: 2});
  reply({requestId, result: observationOk(nodes), sampleSeq: 3});
  const result = await pending;
  assert.equal(result.result.requestId, requestId);
  assert.equal(result.result.sampleSeq, 3);
  assert.equal(result.result.run.runId, run.runId);
  assert.deepEqual(result.result.nodes, nodes.nodes);
  const next = runner.getRuntimeTree(input);
  const stopped = runner.stopRun(run.runId);
  assert.equal((await next).error.code, 'run_ended');
  await stopped;
  assert.equal((await runner.getRuntimeTree(input)).error.code, 'run_ended');
  assert.deepEqual(runner.observationState(run.runId), {supported: true, ready: false, version: 1});
});

test('observation cancellation preserves the outcome established by stopping', async t => {
  const {runner, run} = await runnerFixture(t);
  const input = {runId: run.runId};
  const beforeStop = new AbortController();
  const cancelled = runner.getRuntimeTree(input, beforeStop.signal);
  beforeStop.abort();
  assert.equal((await cancelled).error.code, 'cancelled');

  const duringStop = new AbortController();
  const unsubscribe = runner.subscribe(event => {
    if (event.type === 'state' && event.state === 'stopping') duringStop.abort();
  });
  t.after(unsubscribe);
  const pending = runner.getRuntimeTree(input, duringStop.signal);
  const stopped = runner.stopRun(run.runId);
  assert.equal(duringStop.signal.aborted, true);
  assert.equal((await pending).error.code, 'run_ended');
  await stopped;
});

test('an old runner release continues playback without offering runtime observation', async t => {
  const {runner, run} = await runnerFixture(t, {advertised: false});
  assert.deepEqual(runner.observationState(run.runId), {supported: false, ready: false});
  assert.equal((await runner.getRuntimeTree({runId: run.runId})).error.code, 'unsupported');
});

test('the Runner refuses to publish a running phase when support was advertised but not confirmed', async t => {
  await assert.rejects(runnerFixture(t, {confirmed: false}), /E_RUN_ENDED/);
});

const position = {x: 192, y: 256};
const command = {path: player.path, expectedInstanceId: player.instanceId, property: 'position', value: position};
const writeId = writeSequence => ({requestId: 'demo:' + writeSequence, writeSequence});
const writePacket = (timeout = 1000) => ({command, deadline: interactionNow() + timeout});
const applied = {ok: true, result: {outcome: 'applied', observedValue: position}};

test('write validation owns data and rejects bad identities, values and accessors', () => {
  const input = {runId: 'demo', ...command, value: {...position}};
  const prepared = prepareRuntimeSet(input);
  input.value.x = 0;
  assert.deepEqual(prepared.result.command, command);
  for (const invalid of [
    {value: {x: Infinity, y: 0}}, {value: {x: 0, y: 0, z: 0}}, {value: {get x() { assert.fail(); }, y: 0}},
    {expectedInstanceId: '18446744073709551616'}, {expectedInstanceId: '01'}, {expectedInstanceId: 3},
    {path: '/runtime/../Player'}, {property: 'rotation'}, {timeoutMs: 30001},
  ]) assert.equal(prepareRuntimeSet({...input, ...invalid}).error.code, 'invalid_input');
  assert.equal(prepareRuntimeSet(input, AbortSignal.abort()).error.code, 'cancelled');
  assert.equal(readRuntimeWriteId({requestId: 'demo:3', writeSequence: 4}, 'demo'), undefined);
  assert.equal(readRuntimeWriteResult({ok: true, result: {outcome: 'applied', observedValue: {x: NaN, y: 0}}}), undefined);
});

test('write accepts plain objects created in a different realm', () => {
  const input = {runId: 'demo', ...command};
  const foreign = runInNewContext('JSON.parse(text)', {text: JSON.stringify(input)});
  assert.deepEqual(prepareRuntimeSet(foreign), prepareRuntimeSet(input));
  assert.deepEqual(prepareRuntimeSet({...input, value: foreign.value}), prepareRuntimeSet(input));
  const instance = runInNewContext('Object.assign(new class TestPosition {}, position)', {position});
  assert.equal(prepareRuntimeSet({...input, value: instance}).error.code, 'invalid_input');
});

test('native write checks the deadline before entering WASM and reads back from a grown heap', () => {
  const pointer = 64, memory = new WebAssembly.Memory({initial: 2});
  let calls = 0;
  const module = {
    get HEAPU8() { return new Uint8Array(memory.buffer); },
    _godotjs_runtime_observation_buffer: () => pointer,
    _godotjs_runtime_write_abi: () => 1,
    _godotjs_runtime_write_execute(bytes) {
      calls++;
      assert.deepEqual(JSON.parse(new TextDecoder().decode(module.HEAPU8.subarray(pointer, pointer + bytes))), command);
      memory.grow(1);
      const data = new TextEncoder().encode(JSON.stringify(applied));
      module.HEAPU8.set(data, pointer);
      return data.length;
    },
  };
  const write = createNativeRuntimeWriter(module);
  assert.deepEqual(write(command, interactionNow() - 1), runtimeWriteError('timeout'));
  assert.deepEqual(write(command, interactionNow() + 1000), applied);
  assert.equal(calls, 1);
  assert.throws(() => createNativeRuntimeWriter({...module, _godotjs_runtime_write_abi: () => 2}), /E_RUNTIME_WRITE_ABI/);
  const malformed = createNativeRuntimeWriter({...module, _godotjs_runtime_write_execute: () => 0});
  assert.deepEqual(malformed(command, interactionNow() + 1000).result, {outcome: 'unconfirmed', reason: 'readback_failed'});
});

test('worker write deduplication, preflight expiry and reentrant stop preserve actual execution', () => {
  const replies = [];
  let calls = 0;
  const worker = createWorkerRuntimeWrites(() => {
    calls++;
    worker.stop();
    return applied;
  }, reply => replies.push(reply));
  worker.request(writeId(1), writePacket(-1));
  worker.execute();
  worker.request(writeId(2), writePacket());
  worker.cancel(writeId(2));
  worker.request(writeId(3), writePacket());
  worker.request(writeId(3), {...writePacket(), dataSequence: 19});
  worker.execute();
  worker.request(writeId(3), {...writePacket(), dataSequence: 20});
  worker.execute();
  worker.request(writeId(4), writePacket());
  worker.stop();
  worker.execute();
  assert.equal(calls, 1);
  assert.deepEqual(replies.map(reply => [reply.writeSequence, reply.result.error?.code ?? reply.result.result.outcome]),
    [[1, 'timeout'], [2, 'cancelled'], [3, 'applied'], [4, 'run_ended']]);
});

test('an early Worker timer keeps the write queued until the absolute deadline', t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.timers.enable({apis: ['setTimeout']});
  const replies = [];
  let calls = 0;
  const worker = createWorkerRuntimeWrites(() => {
    calls++;
    return applied;
  }, reply => replies.push(reply));

  worker.request(writeId(1), writePacket(100));
  elapsed = 99.5;
  t.mock.timers.tick(100);
  assert.deepEqual(replies, []);
  worker.execute();
  assert.deepEqual(replies, [{...writeId(1), result: applied}]);
  elapsed = 100;
  t.mock.timers.tick(1);
  assert.equal(replies.length, 1);

  worker.request(writeId(2), writePacket(100));
  elapsed = 199.5;
  t.mock.timers.tick(100);
  assert.equal(replies.length, 1);
  elapsed = 200;
  t.mock.timers.tick(1);
  worker.execute();
  assert.deepEqual(replies.at(-1), {...writeId(2), result: runtimeWriteError('timeout')});
  assert.equal(replies.length, 2);
  assert.equal(calls, 1);
});

test('write relay recovers from lost results without releasing another request’s physical credit', async t => {
  const packets = [], replies = [];
  const relay = createRuntimeWriteRelay(packet => packets.push(packet), reply => replies.push(reply));
  t.after(relay.dispose);
  relay.request(writeId(1), writePacket(10));
  await delay(25);
  relay.request(writeId(2), writePacket());
  assert.equal(replies.at(-1).result.error.code, 'busy');
  relay.receipt(1);
  relay.request(writeId(3), writePacket());
  relay.request(writeId(3), writePacket());
  relay.reply(writeId(1), applied);
  relay.reply(writeId(3), {ok: true, result: {outcome: 'applied'}});
  relay.cancel(writeId(3));
  relay.cancel(writeId(3));
  assert.deepEqual(packets.map(packet => [packet.writeSequence, packet.type]),
    [[1, 'runtime-write-request'], [3, 'runtime-write-request'], [3, 'runtime-write-cancel']]);
  relay.reply(writeId(3), applied);
  relay.request(writeId(4), writePacket());
  assert.deepEqual(replies.at(-1), {...writeId(3), result: applied});
  assert.equal(packets.at(-1).writeSequence, 4);
});

test('runner writes settle once across abort, deadline, stale messages and stop', async t => {
  const {runner, run, port, reply} = await runnerFixture(t, {write: true});
  const input = {runId: run.runId, ...command};
  assert.deepEqual(runner.runtimeWriteState(run.runId), {supported: true, ready: true, version: 1});
  assert.equal((await runner.setRuntimeProperty(input, AbortSignal.abort())).error.code, 'cancelled');
  const posted = once(port, 'message');
  const controller = new AbortController();
  const pending = runner.setRuntimeProperty(input, controller.signal);
  const [{requestId, writeSequence}] = await posted;
  const cancellation = once(port, 'message');
  controller.abort();
  assert.equal((await cancellation)[0].type, 'runtime-write-cancel');
  assert.equal((await pending).result.reason, 'cancelled');
  assert.equal((await runner.setRuntimeProperty(input)).error.code, 'busy');
  reply({type: 'runtime-write-result', requestId, writeSequence, result: applied});
  await delay(15);
  const postedNext = once(port, 'message');
  const next = runner.setRuntimeProperty({...input, timeoutMs: 30});
  const [nextPacket] = await postedNext;
  reply({type: 'runtime-write-result', requestId: nextPacket.requestId, writeSequence: nextPacket.writeSequence, result: applied},
    {...run, protocolVersion: 2, workerId: 'foreign'});
  assert.equal((await next).result.reason, 'timeout');
  const sent = once(port, 'message');
  const final = runner.setRuntimeProperty(input);
  const [last] = await sent;
  reply({type: 'runtime-write-result', requestId: last.requestId, writeSequence: last.writeSequence, result: applied});
  const result = await final;
  assert.equal(result.result.outcome, 'applied');
  assert.equal(result.result.run.runId, run.runId);
  assert.deepEqual(result.result.requestedValue, position);
  const stopping = runner.setRuntimeProperty(input);
  const exit = runner.stopRun(run.runId);
  assert.equal((await stopping).result.reason, 'run_ended');
  await exit;
  assert.equal((await runner.setRuntimeProperty(input)).error.code, 'run_ended');
});

test('an early runner timer leaves time for a matching write result', async t => {
  const {runner, run, port, reply} = await runnerFixture(t, {write: true});
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.timers.enable({apis: ['setTimeout']});

  const posted = once(port, 'message');
  const pending = runner.setRuntimeProperty({runId: run.runId, ...command, timeoutMs: 100});
  const [{requestId, writeSequence}] = await posted;
  let settled = false;
  void pending.then(() => { settled = true; });
  elapsed = 99.5;
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(settled, false);

  reply({type: 'runtime-write-result', requestId, writeSequence, result: applied});
  assert.equal((await pending).result.outcome, 'applied');
});

test('runner cancels only when the original signal aborts', async t => {
  const {runner, run, port} = await runnerFixture(t, {write: true});
  const controller = new AbortController();
  const types = [];
  port.on('message', packet => types.push(packet.type));
  const posted = once(port, 'message');
  let settled = false;
  const pending = runner.setRuntimeProperty({runId: run.runId, ...command}, controller.signal);
  void pending.then(() => { settled = true; });
  assert.equal((await posted)[0].type, 'runtime-write-request');
  controller.signal.dispatchEvent(new Event('abort'));
  await delay(0);
  assert.equal(controller.signal.aborted, false);
  assert.equal(settled, false);
  assert.deepEqual(types, ['runtime-write-request']);

  const cancellation = once(port, 'message', {signal: AbortSignal.timeout(1000)});
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  controller.abort();
  assert.equal((await cancellation)[0].type, 'runtime-write-cancel');
  assert.equal((await pending).result.reason, 'cancelled');
});

test('write availability reflects the advertised and negotiated ABI and presenter', async t => {
  const old = await runnerFixture(t);
  assert.deepEqual(old.runner.runtimeWriteState(old.run.runId), {supported: false, ready: false});
  assert.equal((await old.runner.setRuntimeProperty({runId: old.run.runId, ...command})).error.code, 'unsupported');
  const bitmap = await runnerFixture(t, {write: true, presentationBackend: 'bitmap'});
  assert.equal((await bitmap.runner.setRuntimeProperty({runId: bitmap.run.runId, ...command})).error.code, 'unsupported');
  await assert.rejects(runnerFixture(t, {write: true, writesConfirmed: false}), /E_RUN_ENDED/);
});
