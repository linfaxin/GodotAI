import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntimeAccessRelay, createWorkerRuntimeAccess, readAccessId} from '../dist/browser/dedicated/worker-runtime-access-transport.js';
import {interactionNow} from '../dist/browser/dedicated/worker-interaction.js';
import {WorkerPreviewRunner} from '../dist/browser/dedicated/worker-runner.js';
import {legacyExecution} from '../dist/execution.js';
import {createSessionFacts} from '../dist/session-facts.js';
import {RUN_PHASES} from '../dist/browser/protocol.js';

const path = '/root/Main/Player', expectedInstanceId = '9007199254740993';
const read = {kind: 'read', path, expectedInstanceId, properties: [{name: 'health', expectedType: 'int'}]};
const write = {path, expectedInstanceId, property: 'position', value: {x: 64, y: 256}};
const frame = {process: '123', physics: '122', drawn: '121'};
const readResult = {ok: true, result: {outcome: 'completed', frame,
  properties: [{name: 'health', expectedType: 'int', status: 'value', readEntered: true, value: {type: 'int', value: 100}}]}};
const legacyResult = {ok: true, result: {outcome: 'applied', observedValue: write.value}};
const id = (family, sequence, runId = 'run') => ({family, sequence, requestId: runId + ':' + sequence});
const packet = (command, timeout = 1000) => ({command, deadline: interactionNow() + timeout});

test('one Worker sequence and execution slot covers both message families', () => {
  const replies = [], calls = [];
  const worker = createWorkerRuntimeAccess(request => {
    calls.push(request.family);
    worker.stop(); // Adopted synchronous execution cannot be relabelled as a queued request.
    return request.family === 'write' ? legacyResult : readResult;
  }, reply => replies.push(reply));
  worker.request(id('write', 1), packet(write));
  worker.request(id('property', 1), packet(read)); // cross-family replay
  worker.request(id('property', 2), packet(read));
  assert.equal(replies.at(-1).result.error.code, 'busy');
  worker.execute();
  worker.request(id('property', 3), packet(read));
  worker.execute();
  worker.request(id('write', 3), packet(write));
  worker.execute();
  assert.deepEqual(calls, ['write', 'property']);
  assert.deepEqual(replies.map(reply => [reply.family, reply.sequence]), [['property', 2], ['write', 1], ['property', 3]]);
});

test('queued cancellation, deadline and stop never enter the executor', () => {
  const replies = [];
  const worker = createWorkerRuntimeAccess(() => assert.fail('unexpected execution'), reply => replies.push(reply));
  worker.request(id('property', 1), packet(read, -1));
  worker.request(id('property', 2), packet(read));
  worker.cancel(id('write', 2));
  worker.cancel(id('property', 2));
  worker.request(id('write', 3), packet(write));
  worker.stop(); worker.execute();
  assert.deepEqual(replies.map(reply => reply.result.error.code), ['timeout', 'cancelled', 'run_ended']);
  assert.equal(readAccessId('property', {requestId: 'run:4', accessSequence: 5}, 'run'), undefined);
});

test('relay owns request and cancel deliveries separately across expiration and late results', t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const packets = [], replies = [];
  const relay = createRuntimeAccessRelay(packet => {packets.push(packet); return packets.length;}, reply => replies.push(reply));
  t.after(relay.dispose);
  relay.request(id('write', 1), packet(write, 10));
  elapsed = 11;
  relay.request(id('property', 2), packet(read));
  assert.equal(replies.at(-1).result.error.code, 'busy');
  relay.receipt(1);
  relay.request(id('property', 3), packet(read));
  relay.cancel(id('property', 3));
  relay.reply(id('property', 3), readResult, 'write');
  relay.request(id('write', 4), packet(write));
  assert.equal(replies.at(-1).result.error.code, 'busy');
  relay.reply(id('property', 3), readResult, 'read');
  relay.request(id('write', 5), packet(write));
  relay.cancel(id('write', 5)); // older cancel still physically in flight
  assert.equal(packets.length, 4);
  relay.receipt(3);
  relay.cancel(id('write', 5));
  assert.equal(packets.length, 5);
  relay.reply(id('property', 3), readResult, 'read'); // cannot free current delivery
  relay.reply(id('write', 5), legacyResult);
  assert.deepEqual(packets.map(p => p.type), ['runtime-write-request', 'runtime-property-request', 'runtime-property-cancel', 'runtime-write-request', 'runtime-write-cancel']);
  assert.equal(replies.at(-1).sequence, 5);
});

async function runnerFixture(t, {properties = true, confirmed = properties, presentationBackend = 'direct'} = {}) {
  const asset = name => ({url: 'https://preview.example/' + name, sha256: '1'.repeat(64)});
  let port, header;
  const document = {location: {origin: 'https://editor.example'}, visibilityState: 'hidden', createElement() {
    return {ownerDocument: document, setAttribute() {}, remove() {}, contentWindow: {postMessage(connect, _origin, [host]) {
      port = host; const {type, editorOrigin, ...identity} = connect; header = identity;
      host.on('message', message => {
        if (message.type === 'run') for (const phase of RUN_PHASES.slice(1)) host.postMessage({...identity, type: 'phase', phase,
          ...(phase === 'running' ? {observationVersion: 1,
            ...(presentationBackend === 'direct' ? {runtimeWriteVersion: 1} : {}),
            ...(confirmed && presentationBackend === 'direct' ? {runtimePropertiesVersion: 1} : {})} : {})});
        if (message.type === 'stop') host.postMessage({...identity, type: 'exit-report', engineOutcome: {kind: 'native-exit', code: 0},
          hostCleanup: {status: 'complete'}, sessionFacts: createSessionFacts({nativeExit: {code: 0}, hostCleanup: 'complete'})});
      });
      host.postMessage({...identity, type: 'connected'});
    }}};
  }};
  const container = {ownerDocument: document, append(frame) {queueMicrotask(() => frame.onload());}};
  const runner = new WorkerPreviewRunner({container, previewUrl: 'https://preview.example/', configuration: {presentationBackend},
    release: {releaseId: 'release', profile: 'full-engine-v1', engineTarget: 'template_debug',
      runtimeAbi: {protocolVersion: 2, host: 1, audio: 1, presentation: 1, lifecycle: 1, observation: 1, runtimeWrite: 1, ...(properties ? {runtimeProperties: 1} : {})},
      execution: {...legacyExecution(), lifecycleAbi: 1}, engineJs: asset('engine.js'), engineWasm: asset('engine.wasm'),
      runtimeWorker: asset('runtime.js'), runtimeAudioWorklet: asset('audio.js')},
  });
  t.after(async () => {await runner.dispose(); port?.close();});
  const run = await runner.run({revision: 1, generation: 1, buildKey: 'build', pack: new Uint8Array([1]), manifest: {generation: 1}});
  return {runner, run, port, reply: (data, identity = header) => port.postMessage({...identity, ...data})};
}

test('Runner property calls preserve correlation and share the legacy write sequence', async t => {
  const {runner, run, port, reply} = await runnerFixture(t);
  assert.equal(runner.runtimePropertiesState(run.runId).ready, true);
  const posted = once(port, 'message');
  const pending = runner.readRuntimeProperties({runId: run.runId, path, expectedInstanceId, properties: read.properties});
  assert.equal((await runner.setRuntimeProperty({runId: run.runId, ...write})).error.code, 'busy');
  const [request] = await posted;
  assert.equal(request.accessSequence, 1);
  reply({type: 'runtime-property-result', ...request, type: 'runtime-property-result', kind: 'read', result: readResult}, {...run, protocolVersion: 2, workerId: 'foreign'});
  reply({type: 'runtime-property-result', requestId: request.requestId, accessSequence: 1, kind: 'write', result: readResult});
  reply({type: 'runtime-property-result', requestId: request.requestId, accessSequence: 1, kind: 'read', result: readResult});
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.receipt.run.runId, run.runId);
  assert.equal(result.receipt.expectedInstanceId, expectedInstanceId);
  assert.deepEqual(result.result, readResult.result);
  const nextPosted = once(port, 'message');
  const legacy = runner.setRuntimeProperty({runId: run.runId, ...write});
  const [next] = await nextPosted;
  assert.equal(next.writeSequence, 2);
  reply({type: 'runtime-write-result', requestId: next.requestId, writeSequence: next.writeSequence, result: legacyResult});
  assert.equal((await legacy).result.outcome, 'applied');
});

test('Runner cancellation retains uncertainty and the shared slot until matching retirement', async t => {
  const {runner, run, port, reply} = await runnerFixture(t);
  const controller = new AbortController();
  const posted = once(port, 'message');
  const pending = runner.readRuntimeProperties({runId: run.runId, path, expectedInstanceId, properties: read.properties}, controller.signal);
  const [request] = await posted;
  const cancelPosted = once(port, 'message'); controller.abort();
  assert.equal((await cancelPosted)[0].type, 'runtime-property-cancel');
  const result = await pending;
  assert.equal(result.result.outcome, 'unconfirmed');
  assert.deepEqual(result.result.evidence, {phase: 'unknown'});
  assert.equal((await runner.setRuntimeProperty({runId: run.runId, ...write})).error.code, 'busy');
  reply({type: 'runtime-property-result', requestId: request.requestId, accessSequence: request.accessSequence, kind: 'read', result: readResult});
  await delay(10);
  const nextPosted = once(port, 'message');
  const next = runner.readRuntimeProperties({runId: run.runId, path, expectedInstanceId, properties: read.properties, timeoutMs: 5});
  await nextPosted;
  assert.equal((await next).result.reason, 'timeout');
  const final = runner.readRuntimeProperties({runId: run.runId, path, expectedInstanceId, properties: read.properties});
  const stop = runner.stopRun(run.runId);
  assert.equal((await final).result.reason, 'run_ended'); await stop;
  assert.equal((await runner.readRuntimeProperties({runId: run.runId, path, expectedInstanceId, properties: read.properties})).error.code, 'run_ended');
});

test('old releases and bitmap sessions do not offer property access; handshake mismatch fails', async t => {
  const old = await runnerFixture(t, {properties: false});
  assert.deepEqual(old.runner.runtimePropertiesState(old.run.runId), {supported: false, ready: false});
  assert.equal((await old.runner.readRuntimeProperties({runId: old.run.runId, path, expectedInstanceId, properties: read.properties})).error.code, 'unsupported');
  const bitmap = await runnerFixture(t, {presentationBackend: 'bitmap'});
  assert.equal(bitmap.runner.runtimePropertiesState(bitmap.run.runId).supported, false);
  await assert.rejects(runnerFixture(t, {confirmed: false}), /E_RUN_ENDED/);
});
