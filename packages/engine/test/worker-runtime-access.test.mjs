import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createRuntimeAccessRelay, createWorkerRuntimeAccess, readAccessId} from '../dist/browser/dedicated/worker-runtime-access-transport.js';
import {interactionNow} from '../dist/browser/dedicated/worker-interaction.js';
import {createNativeInputScript, prepareInputScript, readInputScriptTerminal} from '../dist/browser/dedicated/worker-input-script.js';
import {MAX_RUNTIME_REQUEST_BYTES} from '../dist/browser/dedicated/worker-runtime-observation.js';
import {createNativeRuntimeCall, prepareRuntimeMethod, WorkerPreviewRunner} from '../dist/browser/dedicated/worker-runner.js';
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

async function runnerFixture(t, {properties = true, confirmed = properties, presentationBackend = 'direct', method = false,
  methodConfirmed = method, inputScript = false, inputScriptConfirmed = inputScript} = {}) {
  const asset = name => ({url: 'https://preview.example/' + name, sha256: '1'.repeat(64)});
  let port, header;
  const document = {location: {origin: 'https://editor.example'}, visibilityState: inputScript ? 'visible' : 'hidden',
    defaultView: {navigator: {userAgent: 'Mozilla/5.0 Chrome/154.0.0.0'}}, createElement() {
    return {ownerDocument: document, setAttribute() {}, remove() {}, contentWindow: {postMessage(connect, _origin, [host]) {
      port = host; const {type, editorOrigin, ...identity} = connect; header = identity;
      host.on('message', message => {
        if (message.type === 'run') for (const phase of RUN_PHASES.slice(1)) host.postMessage({...identity, type: 'phase', phase,
          ...(phase === 'running' ? {observationVersion: 1,
            ...(presentationBackend === 'direct' ? {runtimeWriteVersion: 1} : {}),
            ...(confirmed && presentationBackend === 'direct' ? {runtimePropertiesVersion: 1} : {}),
            ...(methodConfirmed && presentationBackend === 'direct' ? {runtimeCallVersion: 1} : {}),
            ...(inputScriptConfirmed ? {inputScriptVersion: 1} : {})} : {})});
        if (message.type === 'stop') host.postMessage({...identity, type: 'exit-report', engineOutcome: {kind: 'native-exit', code: 0},
          hostCleanup: {status: 'complete'}, sessionFacts: createSessionFacts({nativeExit: {code: 0}, hostCleanup: 'complete'})});
      });
      host.postMessage({...identity, type: 'connected'});
    }}};
  }};
  const container = {ownerDocument: document, append(frame) {queueMicrotask(() => frame.onload());}};
  const runner = new WorkerPreviewRunner({container, previewUrl: 'https://preview.example/', configuration: {presentationBackend},
    release: {releaseId: method ? methodRelease : 'release', profile: 'full-engine-v1', engineTarget: 'template_debug',
      runtimeAbi: {protocolVersion: 2, host: 1, audio: 1, presentation: 1, lifecycle: 1, observation: 1, runtimeWrite: 1,
        ...(properties ? {runtimeProperties: 1} : {}), ...(method ? {runtimeCall: 1} : {}), ...(inputScript ? {inputScript: 1, gameProbe: 1} : {})},
      execution: {...legacyExecution(), lifecycleAbi: 1}, engineJs: asset('engine.js'), engineWasm: asset('engine.wasm'),
      runtimeWorker: asset('runtime.js'), runtimeAudioWorklet: asset('audio.js')},
  });
  t.after(async () => {await runner.dispose(); port?.close();});
  const run = await runner.run({revision: 1, generation: 1, buildKey: 'build', pack: new Uint8Array([1]), manifest: {generation: 1}});
  return {runner, run, port, reply: (data, identity = header) => port.postMessage({...identity, ...data})};
}

test('Worker exit preserves only matching and validated runtime failure capture', async t => {
  const {runner, run, reply} = await runnerFixture(t);
  const exits = [];
  const exited = new Promise(resolve => runner.subscribe(event => {
    if (event.type !== 'exit') return;
    exits.push(event.report);
    resolve(event.report);
  }));
  const message = 'project failure';
  const diagnostic = {source: 'godotjs', message, stack: 'actual stack'};
  const report = {type: 'exit-report', engineOutcome: {kind: 'native-exit', code: 0}, hostCleanup: {status: 'complete'},
    sessionFacts: createSessionFacts({nativeExit: {code: 0}, hostCleanup: 'complete', runtimeSummary: 'sealed',
      entryCleanup: 'complete', failure: {kind: 'runtime', message}}), diagnostic, runtimeFailureCapture: 'observed'};
  reply({...report, workerId: 'older-worker', runtimeFailureCapture: 'settled_empty'});
  reply(report);
  reply({...report, runtimeFailureCapture: 'settled_empty'});
  const terminal = await exited;
  assert.equal(terminal.runId, run.runId);
  assert.equal(terminal.code, 0);
  assert.equal(terminal.reason, 'crashed');
  assert.equal(terminal.runtimeFailureCapture, 'observed');
  assert.deepEqual(terminal.diagnostic, diagnostic);
  assert.equal(exits.length, 1);
});

test('a malformed optional failure capture does not strand a clean Worker exit', async t => {
  const {runner, reply} = await runnerFixture(t);
  const exited = new Promise(resolve => runner.subscribe(event => {
    if (event.type === 'exit') resolve(event.report);
  }));
  reply({type: 'exit-report', engineOutcome: {kind: 'native-exit', code: 0}, hostCleanup: {status: 'complete'},
    sessionFacts: createSessionFacts({nativeExit: {code: 0}, hostCleanup: 'complete', runtimeSummary: 'sealed', entryCleanup: 'complete'}),
    runtimeFailureCapture: 'observed'});
  const terminal = await exited;
  assert.equal(terminal.reason, 'clean-exit');
  assert.equal(terminal.runtimeFailureCapture, undefined);
});

const script = {actionName: 'move_right', pressOffset: 0, releaseOffset: 4};
const completedScript = {kind: 'completed', source: 'native', base: '9007199254740993',
  down: {physics: '9007199254740993', iteration: 18}, up: {physics: '9007199254740997', iteration: 19},
  releaseStepCompleted: true, finishedIteration: 19};

test('input scripts preserve exact frame evidence and reject malformed or unbounded commands', () => {
  const command = {runId: 'run', ...script};
  for (const fields of [{actionName: '界'.repeat(43)}, {actionName: 'x\0y'}, {actionName: '\ud800'},
    {releaseOffset: 0}, {releaseOffset: 121}, {pressOffset: 1.5}, {timeoutMs: 0}, {timeoutMs: 30001}, {strength: 1},
    {requireUnscaled60Hz: false}, {requireUnscaled60Hz: 60}])
    assert.equal(prepareInputScript({...command, ...fields}).error.code, 'invalid_input');
  assert.equal(prepareInputScript(command, AbortSignal.abort()).error.code, 'cancelled');
  assert.deepEqual(readInputScriptTerminal(completedScript, script), completedScript);
  assert.equal(readInputScriptTerminal({...completedScript, up: {...completedScript.up, physics: completedScript.base}}, script), undefined);
  assert.equal(readInputScriptTerminal({...completedScript, releaseStepCompleted: false}, script), undefined);
  const guarded = prepareInputScript({...command, requireUnscaled60Hz: true});
  assert.equal(guarded.ok, true);
  assert.deepEqual(guarded.command, {...script, requireUnscaled60Hz: true});
  assert.deepEqual(readInputScriptTerminal(completedScript, guarded.command), completedScript);
});

test('native input staging receives the unchanged monotonic deadline in the exchange buffer', () => {
  const memory = new Uint8Array(8192), start = 8;
  const deadline = interactionNow() + 5000;
  const runtime = createNativeInputScript({HEAPU8:memory,
    _godotjs_input_script_abi:()=>1, _godotjs_input_script_buffer:()=>start,
    _godotjs_input_script_stage(sequence, length, remaining) {
      assert.equal(sequence, 3);
      assert(remaining > 0 && remaining <= 5000000);
      const bytes = memory.subarray(start, start + length);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {...script, deadline});
      return 1;
    },
    _godotjs_input_script_cancel() {}, _godotjs_input_script_take() {return 0;},
  });
  assert.equal(runtime.stage({command:script,sequence:3,deadline}), true);
});

test('input cancellation keeps the original slot until a matching terminal retires it', async t => {
  const {runner, run, port, reply} = await runnerFixture(t, {inputScript: true});
  const command = {runId: run.runId, ...script};
  assert.deepEqual(runner.inputScriptState(run.runId), {supported: true, ready: true});
  const oldTemplate = await runner.runGameInputScript({runId: run.runId, keycode: 4194321, physical: true,
    pressOffset: 0, releaseOffset: 4});
  assert.equal(oldTemplate.error.code, 'unsupported');
  assert.equal(oldTemplate.receipt, undefined);
  const oldHold = await runner.runGameInputScript({...command, requireUnscaled60Hz: true});
  assert.equal(oldHold.error.code, 'unsupported');
  assert.equal(oldHold.receipt, undefined);
  const abort = new AbortController();
  const posted = once(port, 'message');
  const pending = runner.runGameInputScript(command, abort.signal);
  const [{requestId, sequence, releaseId, type}] = await posted;
  assert.equal(type, 'input-script-request');
  const cancelled = once(port, 'message');
  abort.abort();
  assert.equal((await cancelled)[0].type, 'input-script-cancel');
  const outcome = await pending;
  assert.equal(outcome.outcome, 'outcome_unknown');
  const terminal = {type: 'input-script-terminal', releaseId, sequence, requestId, terminal: completedScript};
  reply({...terminal, releaseId: 'old-release'});
  reply({...terminal, sequence: sequence + 1});
  await delay(15);
  assert.equal((await runner.runGameInputScript(command)).error.code, 'busy');
  reply(terminal);
  await delay(15);
  const next = once(port, 'message');
  const result = runner.runGameInputScript(command);
  const [request] = await next;
  assert.equal(request.sequence, sequence + 1);
  reply({...terminal, sequence: request.sequence, requestId: request.requestId});
  assert.deepEqual((await result).result, completedScript);
  assert.equal(outcome.outcome, 'outcome_unknown');
});

test('unconfirmed input cleanup stops the original run after the bounded drain', async t => {
  const {runner, run, port} = await runnerFixture(t, {inputScript: true});
  const command = {runId: run.runId, ...script};
  const packets = [];
  port.on('message', message => packets.push(message));
  const exited = new Promise(resolve => {
    const unsubscribe = runner.subscribe(event => {
      if (event.type === 'exit') {unsubscribe(); resolve(event.report);}
    });
  });
  const result = await runner.runGameInputScript({...command, timeoutMs: 50});
  assert.equal(result.outcome, 'outcome_unknown');
  assert.equal(result.receipt.run.runId, run.runId);
  assert.equal((await runner.runGameInputScript(command)).error.code, 'busy');
  assert.equal((await exited).runId, run.runId);
  assert.deepEqual(packets.map(message => [message.type, message.runId]), [
    ['input-script-request', run.runId], ['input-script-cancel', run.runId], ['stop', run.runId],
  ]);
  assert.equal((await runner.runGameInputScript(command)).error.code, 'run_ended');
});

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

const methodContract = JSON.parse(readFileSync(new URL('../../../tests/project/tests/runtime/runtime-call-contract.json', import.meta.url)));
const methodTarget = methodContract.target;
const methodStamp = 'f'.repeat(64);
const methodRelease = 'dev-preview';
const methodResponse = {ok: true, result: {outcome: 'returned', callEntered: true, entryFrame: methodContract.entryFrame, value: methodContract.value}};
const methodDescription = {ok: true, result: {truncated: false, methods: [{
  method: methodContract.method, parameterTypes: methodContract.parameterTypes, returnType: methodContract.returnType, methodStamp,
}]}};

test('runtime call shares queue sequence, binds the result, and ignores mismatched terminal messages', async t => {
  const {runner, run, port, reply} = await runnerFixture(t, {method: true});
  const target = {...methodTarget, runId: run.runId};
  assert.equal(runner.runtimeCallState(run.runId).ready, true);
  let posted = once(port, 'message');
  const discovery = runner.describeRuntimeMethods({...target, method: methodContract.method});
  const [query] = await posted;
  assert.equal(query.type, 'runtime-method-request');
  assert.equal((await runner.setRuntimeProperty({runId: run.runId, ...write})).error.code, 'busy');
  reply({type: 'runtime-method-result', requestId: query.requestId, accessSequence: query.accessSequence, kind: 'describe', result: methodDescription});
  const descriptor = (await discovery).result.methods[0];
  assert.deepEqual(descriptor.methodToken, {version:1, runId:run.runId, releaseId:methodRelease, returnType:'int', stamp:methodStamp});
  posted = once(port, 'message');
  const pending = runner.callRuntimeMethod({...target, method: descriptor.method, methodToken: descriptor.methodToken, args: methodContract.args});
  const [request] = await posted;
  const result = {type:'runtime-method-result', requestId: request.requestId, accessSequence: request.accessSequence, kind:'invoke'};
  assert.equal(request.accessSequence, 2);
  assert.equal(request.command.methodStamp, methodStamp);
  assert.equal(request.command.expectedReturnType, 'int');
  reply({...result, kind: 'describe', result: methodDescription});
  reply({...result, result: {...methodResponse, result: {...methodResponse.result, value: {type:'float', value:75}}}});
  reply({...result, result: methodResponse});
  const record = await pending;
  assert.deepEqual(record.result, methodResponse.result);
  assert.equal(record.receipt.expectedInstanceId, methodTarget.expectedInstanceId);
  assert.equal(record.receipt.method, descriptor.method);
  assert.equal((await runner.callRuntimeMethod({...target, method: descriptor.method,
    methodToken: {...descriptor.methodToken, runId:'old-run'}, args: methodContract.args})).error.code, 'binding_changed');
  assert.equal((await runner.callRuntimeMethod({...target, method: descriptor.method,
    methodToken: {...descriptor.methodToken, releaseId:'other-preview'}, args: methodContract.args})).error.code, 'binding_changed');
});

test('runtime call cancellation preserves uncertainty and cannot release the shared slot via a stale reply', async t => {
  const {runner, run, port, reply} = await runnerFixture(t, {method: true});
  const target = {...methodTarget, runId: run.runId, method: methodContract.method, args: methodContract.args,
    methodToken: {version:1, runId:run.runId, releaseId:methodRelease, returnType:'int', stamp:methodStamp}};
  const abort = new AbortController();
  const posted = once(port, 'message');
  const pending = runner.callRuntimeMethod(target, abort.signal);
  const [request] = await posted;
  const cancelled = once(port, 'message');
  abort.abort();
  assert.equal((await cancelled)[0].type, 'runtime-method-cancel');
  const record = await pending;
  assert.deepEqual(record.result, {outcome:'unconfirmed', callEntered:'unknown', reason:'cancelled'});
  reply({type:'runtime-method-result', requestId:request.requestId, accessSequence:request.accessSequence+1, kind:'invoke', result:methodResponse});
  assert.equal((await runner.readRuntimeProperties({...target, properties:read.properties, method:undefined,
    methodToken:undefined, args:undefined})).ok, false);
  assert.equal((await runner.setRuntimeProperty({runId:run.runId, ...write})).error.code, 'busy');
  reply({type:'runtime-method-result', requestId:request.requestId, accessSequence:request.accessSequence, kind:'invoke', result:methodResponse});
  await delay(10);
  assert.equal(record.result.outcome, 'unconfirmed');
  const gone = runner.callRuntimeMethod({...target, timeoutMs: 5});
  assert.equal((await gone).result.reason, 'timeout');
});

test('native method bridge passes only remaining budget and validates returned scalar type', () => {
  let calls = 0, mode = 'good';
  const module = {HEAPU8: new Uint8Array(70_000), _godotjs_runtime_observation_buffer:()=>8, _godotjs_runtime_call_abi:()=>1,
    _godotjs_runtime_call_execute(size, remaining) {
      calls++;
      assert(remaining > 0 && remaining <= 5000_000);
      const request = JSON.parse(new TextDecoder().decode(thisHeap.subarray(8, 8 + size)));
      assert.equal(request.runScope, 'test');
      assert.equal(request.expectedInstanceId, methodTarget.expectedInstanceId);
      const reply = mode === 'good' ? methodResponse : {...methodResponse, result:{...methodResponse.result, value:{type:'bool',value:true}}};
      const bytes = new TextEncoder().encode(JSON.stringify(reply)); thisHeap.set(bytes,8); return bytes.length;
    },
  };
  const thisHeap = module.HEAPU8;
  const native = createNativeRuntimeCall(module);
  const input = {...methodTarget, method:methodContract.method, args:methodContract.args,
    methodToken:{version:1,runId:methodTarget.runId,releaseId:methodRelease,returnType:'int',stamp:methodStamp}};
  const {result: {command}} = prepareRuntimeMethod('invoke', input, methodRelease);
  assert.equal(native(command, interactionNow(), 'test', 60_000).error.code, 'timeout');
  assert.equal(calls, 0);
  assert.deepEqual(native(command, interactionNow()+1000, 'test', 60_000), methodResponse);
  mode = 'wrong';
  assert.equal(native(command, interactionNow()+1000, 'test', 60_000).result.outcome, 'unconfirmed');
});

test('method preparation validates the complete native UTF-8 request and rejects a null limit', () => {
  const method = methodContract.method;
  const methodToken = {version:1,runId:methodTarget.runId,releaseId:methodRelease,returnType:'int',stamp:methodStamp};
  const input = {...methodTarget,method,methodToken,args:[
    {type:'string',value:'你'.repeat(333)},
    {type:'string',value:'"'.repeat(500)},
    {type:'string',value:'a'.repeat(1000)},
    {type:'string',value:''},
  ]};
  const accepted = prepareRuntimeMethod('invoke', input, methodRelease);
  assert.equal(accepted.ok,true);
  const wire = {...accepted.result.command,runScope:JSON.stringify([methodTarget.runId,methodRelease]),outputBudgetBytes:65536};
  input.args.at(-1).value = 'a'.repeat(MAX_RUNTIME_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(wire)));
  assert.equal(prepareRuntimeMethod('invoke', input, methodRelease).ok,true);
  input.args.at(-1).value += 'a';
  assert.deepEqual(prepareRuntimeMethod('invoke', input, methodRelease),{ok:false,error:{code:'bad_args',source:'sdk',message:'bad_args'}});
  assert.equal(prepareRuntimeMethod('describe', {...methodTarget,limit:null}, methodRelease).error.code,'invalid_input');
  assert.equal(prepareRuntimeMethod('describe', methodTarget, methodRelease).result.command.limit,32);
});
