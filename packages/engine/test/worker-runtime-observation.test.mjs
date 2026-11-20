import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
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

async function runnerFixture(t, {advertised = true, confirmed = advertised} = {}) {
  const asset = name => ({url: 'https://preview.example/' + name, sha256: '1'.repeat(64)});
  const runtimeAbi = {protocolVersion: 2, host: 1, audio: 1, presentation: 1,
    ...(advertised ? {observation: 1, lifecycle: 1} : {})};
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
                ...(phase === 'running' && confirmed ? {observationVersion: 1} : {})});
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
    release: {releaseId: 'test-release', profile: 'full-engine-v1', runtimeAbi,
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
