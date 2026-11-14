import assert from 'node:assert/strict';
import test from 'node:test';
import {
 WORKER_PROTOCOL,DEFAULT_WORKER_RUN_CONFIGURATION,freezeWorkerRunConfiguration,
 canonicalWorkerRunConfiguration,hashWorkerRunConfiguration,prepareWorkerRunConfiguration,
 isWorkerRunIdentity,freezeWorkerRunIdentity,sameWorkerRun,isWorkerEnvelope,
} from '../dist/worker-protocol.js';

const identity={runId:'run',revision:1,buildKey:'build',generation:'generation',documentId:'doc',workerId:'worker',runConfigurationHash:'a'.repeat(64)};

test('configuration identity is canonical, private and immutable across caller mutation',async()=>{
 const input={...DEFAULT_WORKER_RUN_CONFIGURATION,budgets:{maxInputEvents:12,maxCanvasPixels:64000}};
 const frozen=freezeWorkerRunConfiguration(input),before=await hashWorkerRunConfiguration(frozen);
 input.presentationBackend='bitmap';input.budgets.maxInputEvents=999;
 assert.equal(frozen.presentationBackend,'direct');assert.equal(frozen.budgets.maxInputEvents,12);
 assert.throws(()=>{frozen.budgets.maxInputEvents=13;},TypeError);
 assert.equal(await hashWorkerRunConfiguration(frozen),before);
 assert.equal(await hashWorkerRunConfiguration({...frozen,budgets:{maxCanvasPixels:64000,maxInputEvents:12}}),before);
 assert.notEqual(await hashWorkerRunConfiguration({...frozen,presentationBackend:'bitmap'}),before);
 assert.notEqual(await hashWorkerRunConfiguration({...frozen,presentationAbiVersion:2}),before);
 assert.equal(canonicalWorkerRunConfiguration(frozen),canonicalWorkerRunConfiguration({...frozen,budgets:{maxCanvasPixels:64000,maxInputEvents:12}}));
});

test('partial configuration merges budgets without mutating shared defaults',async()=>{
 const {configuration,hash}=await prepareWorkerRunConfiguration({presentationBackend:'bitmap',budgets:{maxInputEvents:8}});
 assert.equal(configuration.presentationBackend,'bitmap');assert.equal(configuration.budgets.maxInputEvents,8);
 assert.equal(configuration.budgets.cleanupTimeoutMs,1000);assert.equal(DEFAULT_WORKER_RUN_CONFIGURATION.budgets.maxInputEvents,1024);
 assert.match(hash,/^[a-f0-9]{64}$/);assert.equal(hash,await hashWorkerRunConfiguration(configuration));
 const defaults=await prepareWorkerRunConfiguration();assert.equal(defaults.configuration.runtimeProtocolVersion,2);
});

test('invalid and accessor-bearing configurations fail before invoking getters',async()=>{
 let reads=0;const getters={...DEFAULT_WORKER_RUN_CONFIGURATION,get budgets(){reads++;return {};}};
 assert.throws(()=>freezeWorkerRunConfiguration(getters),/E_WORKER_CONFIGURATION/);assert.equal(reads,0);
 await assert.rejects(prepareWorkerRunConfiguration({get budgets(){reads++;return {};}}),/E_WORKER_CONFIGURATION/);assert.equal(reads,0);
 for(const invalid of [
  {...DEFAULT_WORKER_RUN_CONFIGURATION,extra:1},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,executionBackend:'iframe'},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,runtimeProtocolVersion:1},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,audioAbiVersion:0},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,budgets:{limit:Infinity}},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,budgets:{limit:-1}},
  {...DEFAULT_WORKER_RUN_CONFIGURATION,budgets:{limit:1.5}},
 ])assert.throws(()=>freezeWorkerRunConfiguration(invalid),/E_WORKER_CONFIGURATION/);
 const hidden={...DEFAULT_WORKER_RUN_CONFIGURATION};Object.defineProperty(hidden,'secret',{value:1});
 assert.throws(()=>freezeWorkerRunConfiguration(hidden),/E_WORKER_CONFIGURATION/);
});

test('known budgets reject unusable limits before allocating runtime resources',async()=>{
 for(const key of ['hostSetupTimeoutMs','cleanupTimeoutMs']){
  for(const limit of [0,2147483648])await assert.rejects(prepareWorkerRunConfiguration({budgets:{[key]:limit}}),/E_WORKER_CONFIGURATION_BUDGETS/);
  assert.equal((await prepareWorkerRunConfiguration({budgets:{[key]:2147483647}})).configuration.budgets[key],2147483647);
 }
 for(const key of ['maxCanvasDimension','maxCanvasPixels','maxDpr','audioSampleBytes','audioPcmBytes','maxInputEvents','maxHostCommands','maxPresentationBytes']){
  await assert.rejects(prepareWorkerRunConfiguration({budgets:{[key]:0}}),/E_WORKER_CONFIGURATION_BUDGETS/);
  assert.equal((await prepareWorkerRunConfiguration({budgets:{[key]:1}})).configuration.budgets[key],1);
 }
 for(const limit of [0,2])await assert.rejects(prepareWorkerRunConfiguration({budgets:{bitmapCredits:limit}}),/E_WORKER_CONFIGURATION_BUDGETS/);
 assert.equal((await prepareWorkerRunConfiguration()).configuration.budgets.maxPresentationBytes,268435456);
});

test('all Worker identities are checked, and exit snapshots retain no extra payload',()=>{
 assert.equal(isWorkerRunIdentity(identity),true);assert.equal(sameWorkerRun(identity,{...identity}),true);
 for(const key of ['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash']){
  const changed={...identity,[key]:key==='revision'?2:key==='runConfigurationHash'?'b'.repeat(64):'other'};
  assert.equal(sameWorkerRun(identity,changed),false,key);
 }
 for(const invalid of [{...identity,workerId:''},{...identity,revision:Infinity},{...identity,runConfigurationHash:'bad'},null])assert.equal(isWorkerRunIdentity(invalid),false);
 const privateSnapshot=freezeWorkerRunIdentity({...identity,payload:new Uint8Array(1024)});
 assert.equal(Object.hasOwn(privateSnapshot,'payload'),false);assert.equal(Object.isFrozen(privateSnapshot),true);
});

test('header validation permits independent channel DTOs without claiming payload validation',()=>{
 assert.equal(WORKER_PROTOCOL,2);
 assert.equal(isWorkerEnvelope({...identity,protocolVersion:2,type:'custom-host-message',payload:{arbitrary:'channel validates this'}}),true);
 assert.equal(isWorkerEnvelope({...identity,protocolVersion:1,type:'heartbeat'}),false);
 assert.equal(isWorkerEnvelope({...identity,protocolVersion:2,type:''}),false);
 let reads=0;assert.equal(isWorkerEnvelope({...identity,protocolVersion:2,get type(){reads++;return 'stop';}}),false);assert.equal(reads,0);
});
