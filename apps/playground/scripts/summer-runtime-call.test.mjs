import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createSummerDispatcher} from '../src/summer-adapter.ts';

const contract = JSON.parse(readFileSync(new URL('../../../tests/project/tests/runtime/runtime-call-contract.json', import.meta.url)));
const {runId, path, expectedInstanceId} = contract.target;
const releaseId = '1'.repeat(64);
const identity = {runId, revision: 1, buildKey: 'build', generation: 1, documentId: 'doc', workerId: 'worker', runConfigurationHash: 'a'.repeat(64)};
const context = {projectId: 'test', editorRevision: 1, activeRunId: runId, pendingAttemptId: null};
const methodToken = {version:1, runId, releaseId, returnType:contract.returnType, stamp:'b'.repeat(64)};
const request = {op:'engine.runtime_call', input:{path,method:contract.method,args:[25]}};
const receipt = {accessSequence:1, requestId:runId+':1', run:identity, releaseId, path, expectedInstanceId, method:contract.method};
const returned = {ok:true, receipt, result:{outcome:'returned',callEntered:true,entryFrame:contract.entryFrame,value:contract.value}};

function fixture() {
  const calls = [];
  const state = {context:{...context}, run:{...identity,projectId:'test',releaseId,state:'running',runtimeCall:{supported:true,ready:true}},
    instanceId:expectedInstanceId, methodToken, result:returned};
  const backend = {
    context:()=>({...state.context}), run:()=>({ok:true,result:{...state.run}}),
    async tree(input, signal, deadline) {
      calls.push({stage:'resolve',input,signal,deadline});
      return {ok:true,result:{run:identity,releaseId,nodes:[{path,instanceId:state.instanceId}]}};
    },
    async describe(input, signal, deadline) {
      calls.push({stage:'describe',input,signal,deadline});
      state.afterDescribe?.();
      return {ok:true,receipt,result:{truncated:false,methods:[{method:contract.method,parameterTypes:contract.parameterTypes,returnType:contract.returnType,methodToken:state.methodToken}]}};
    },
    async invoke(input, signal, deadline) {
      calls.push({stage:'invoke',input,signal,deadline});
      if (input.expectedInstanceId !== state.instanceId) return {ok:false,error:{code:'node_changed',source:'native',message:'node changed'},receipt};
      if (input.methodToken.stamp !== state.methodToken.stamp) return {ok:false,error:{code:'binding_changed',source:'native',message:'binding changed'},receipt};
      return state.result;
    },
  };
  return {state,calls,dispatch:createSummerDispatcher({runtimeMethods:backend})};
}

test('Summer runtime_call shares one deadline and converts arguments from the exact descriptor', async () => {
  const {dispatch,calls} = fixture();
  const reply = await dispatch(request);
  assert.equal(reply.ok,true);
  assert.deepEqual(reply.result.data,{route:'runtime_call',payload:returned});
  assert.deepEqual(calls.map(call=>call.stage),['resolve','describe','invoke']);
  assert.equal(new Set(calls.map(call=>call.deadline)).size,1);
  assert.deepEqual(calls.at(-1).input,{...contract.target,method:contract.method,methodToken,args:contract.args});
});

test('Summer runtime_call does not retarget after project switch, or dispatch on an old release', async () => {
  const {dispatch,state,calls} = fixture();
  state.afterDescribe=()=>{state.context.projectId='other';};
  assert.equal((await dispatch(request)).error.code,'revision_conflict');
  assert.deepEqual(calls.map(call=>call.stage),['resolve','describe']);
  state.context.projectId='test';calls.length=0;
  state.run.runtimeCall={supported:false,ready:false};
  assert.equal((await dispatch(request)).error.code,'unsupported');
  assert.equal(calls.length,0);
});

test('Summer runtime_call preserves the full invoke receipt without fallback or retry', async () => {
  const {dispatch,state,calls} = fixture();
  for(const [result,code] of [
    [{outcome:'threw',callEntered:true,entryFrame:contract.entryFrame},'call_error'],
    [{outcome:'result_unavailable',callEntered:true,entryFrame:contract.entryFrame,reason:'output_budget'},'result_unavailable'],
    [{outcome:'unconfirmed',callEntered:'unknown',reason:'timeout'},'outcome_unknown'],
  ]) {
    state.result={ok:true,receipt,result};calls.length=0;
    const response=await dispatch(request);
    assert.equal(response.error.code,code);
    assert.equal(response.error.retry,'no');
    assert.deepEqual(response.error.details.godotai.receipt,state.result);
    assert.equal(calls.filter(call=>call.stage==='invoke').length,1);
  }
});

test('a Console selection invokes once with its original instance ID and registration token', async () => {
  const {dispatch,state,calls} = fixture();
  const selected = {...contract.target,method:contract.method,methodToken,parameterTypes:contract.parameterTypes};

  state.instanceId = '1234';
  assert.equal((await dispatch(request, undefined, selected)).error.code,'node_changed');
  assert.deepEqual(calls.map(call=>call.stage),['invoke']);
  assert.equal(calls[0].input.expectedInstanceId,expectedInstanceId);

  calls.length = 0;
  state.instanceId = expectedInstanceId;
  state.methodToken = {...methodToken,stamp:'c'.repeat(64)};
  assert.equal((await dispatch(request, undefined, selected)).error.code,'binding_changed');
  assert.deepEqual(calls.map(call=>call.stage),['invoke']);
  assert.deepEqual(calls[0].input.methodToken,methodToken);

  calls.length = 0;
  state.methodToken = methodToken;
  assert.equal((await dispatch(request, undefined, selected)).ok,true);
  assert.deepEqual(calls.map(call=>call.stage),['invoke']);
  assert.deepEqual(calls[0].input,{...contract.target,method:contract.method,methodToken,args:contract.args});
});
