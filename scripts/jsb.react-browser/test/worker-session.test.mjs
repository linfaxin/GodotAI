import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkerSessionLease,WorkerExitLedger,boundedWorkerCleanup,WorkerHeartbeat,isWorkerEngineOutcome,isWorkerHostCleanupOutcome} from '../dist/worker-session.js';
const identity={runId:'run',revision:1,buildKey:'build',generation:'gen',documentId:'doc',workerId:'worker',runConfigurationHash:'a'.repeat(64)};
const wait=ms=>new Promise(done=>setTimeout(done,ms));

test('cancellation fences resource construction and disposes preparation completing late',async()=>{
 const lease=new WorkerSessionLease(),reason=new DOMException('Replaced','AbortError');let resolvePreparation,released=0,created=0;
 const resource={id:'late-context'};
 const pending=lease.create(()=>{created++;return new Promise(resolve=>{resolvePreparation=resolve;});},async value=>{assert.equal(value,resource);released++;});
 assert.equal(lease.cancel(reason),true);assert.equal(lease.cancel(Error('later')),false);
 resolvePreparation(resource);await assert.rejects(pending,error=>error===reason);
 assert.equal(released,1);assert.equal(created,1);assert.equal(lease.active,false);
 await assert.rejects(lease.create(()=>{created++;return {};},()=>{}),error=>error===reason);assert.equal(created,1);
});

test('resources from an already-created promise are not lost when lease was cancelled',async()=>{
 const lease=new WorkerSessionLease();lease.cancel();let released=0;
 await assert.rejects(lease.retain(Promise.resolve({id:1}),()=>{released++;}),error=>error.name==='AbortError');
 assert.equal(released,1);
 const live=new WorkerSessionLease(),value={id:2};assert.equal(await live.retain(value,()=>assert.fail('live resource must not be released')),value);
});

test('native exit and host cleanup settle once, independently of arrival order',()=>{
 for(const order of ['engine-first','cleanup-first']){
  const ledger=new WorkerExitLedger({...identity,payload:'must not retain'});
  if(order==='engine-first'){assert.equal(ledger.recordEngine({kind:'native-exit',code:0}),undefined);ledger.recordCleanup({status:'complete'});}
  else{assert.equal(ledger.recordCleanup({status:'complete'}),undefined);ledger.recordEngine({kind:'native-exit',code:0});}
  const report=ledger.report;assert.equal(report.reason,'clean-exit');assert.equal(report.code,0);assert.equal(Object.hasOwn(report,'payload'),false);
  assert.equal(ledger.recordEngine({kind:'terminate-issued'}),report);assert.equal(ledger.recordCleanup({status:'timed-out'}),report);
  assert.equal(Object.isFrozen(report),true);assert.equal(Object.isFrozen(report.hostCleanup),true);
 }
});

test('forced termination cannot become native exit zero or conceal cleanup failure',()=>{
 const ledger=new WorkerExitLedger(identity);ledger.recordEngine({kind:'terminate-issued'});ledger.recordCleanup({status:'timed-out',detail:'close pending'});
 assert.equal(ledger.report.reason,'forced-worker-termination');assert.equal(Object.hasOwn(ledger.report,'code'),false);assert.equal(ledger.report.hostCleanup.status,'timed-out');
 const zero=new WorkerExitLedger(identity);zero.recordEngine({kind:'native-exit',code:0});zero.recordCleanup({status:'failed',detail:'audio close failed'});assert.equal(zero.report.reason,'host-cleanup-failed');
 const lost=new WorkerExitLedger(identity);lost.recordEngine({kind:'host-lost'});lost.recordCleanup({status:'timed-out'});assert.equal(lost.report.reason,'host-lost');
 const crashed=new WorkerExitLedger(identity);crashed.recordEngine({kind:'native-exit',code:9});crashed.recordCleanup({status:'complete'});assert.equal(crashed.report.reason,'crashed');assert.equal(crashed.report.code,9);
});

test('ledger validates runtime DTOs without invoking attacker accessors',()=>{
 let reads=0;assert.equal(isWorkerEngineOutcome({kind:'native-exit',get code(){reads++;return 0;}}),false);assert.equal(reads,0);
 assert.equal(isWorkerEngineOutcome({kind:'native-exit',code:Infinity}),false);assert.equal(isWorkerHostCleanupOutcome({status:'complete',detail:'unexpected'}),false);
 const ledger=new WorkerExitLedger(identity);assert.throws(()=>ledger.recordEngine({kind:'unknown'}),/E_WORKER_ENGINE_OUTCOME/);assert.throws(()=>ledger.recordCleanup({status:'unknown'}),/E_WORKER_HOST_CLEANUP/);
});

test('bounded cleanup resolves failure and timeout while handling a late rejection',async()=>{
 assert.deepEqual(await boundedWorkerCleanup(()=>{},100),{status:'complete'});
 assert.deepEqual(await boundedWorkerCleanup(()=>{throw Error('close failed');},100),{status:'failed',detail:'close failed'});
 let rejectLate,signal;
 const result=await boundedWorkerCleanup(value=>{signal=value;return new Promise((resolve,reject)=>{rejectLate=reject;});},10);
 assert.equal(result.status,'timed-out');assert.equal(signal.aborted,true);
 rejectLate(Error('settles after deadline'));await wait(5);assert.equal(result.status,'timed-out');
 for(const limit of [0,-1,Infinity,2147483648])assert.throws(()=>boundedWorkerCleanup(()=>{},limit),/E_WORKER_CLEANUP_TIMEOUT/);
});

test('heartbeat cannot use old epochs, duplicates or suspended traffic to restore liveness',()=>{
 const heartbeat=new WorkerHeartbeat(0);
 assert.equal(heartbeat.accept({sequence:0,resumeEpoch:0},5),true);
 assert.equal(heartbeat.accept({sequence:0,resumeEpoch:0},50),false);assert.equal(heartbeat.timedOut(16,10),true);
 heartbeat.suspend();assert.equal(heartbeat.timedOut(100000,10),false);assert.equal(heartbeat.accept({sequence:1,resumeEpoch:0},100000),false);
 const epoch=heartbeat.beginResume(100000);assert.equal(epoch,1);assert.equal(heartbeat.beginResume(100005),epoch);
 assert.equal(heartbeat.accept({sequence:99,resumeEpoch:0},100006),false);assert.equal(heartbeat.accept({sequence:0,resumeEpoch:epoch},100007),false);
 assert.equal(heartbeat.acknowledgeResume({sequence:0,resumeEpoch:0},100008),false);
 assert.equal(heartbeat.acknowledgeResume({sequence:0,resumeEpoch:epoch},100008),true);
 assert.equal(heartbeat.accept({sequence:1,resumeEpoch:epoch},100009),true);assert.equal(heartbeat.timedOut(100015,10),false);
 heartbeat.close();assert.equal(heartbeat.accept({sequence:2,resumeEpoch:epoch},100020),false);assert.equal(heartbeat.timedOut(200000,10),false);assert.throws(()=>heartbeat.beginResume(200000),/E_WORKER_HEARTBEAT_CLOSED/);
});

test('resume handshake itself has a bounded liveness window',()=>{
 const heartbeat=new WorkerHeartbeat(10);heartbeat.suspend();heartbeat.beginResume(1000);
 assert.equal(heartbeat.timedOut(1005,10),false);assert.equal(heartbeat.timedOut(1011,10),true);
 assert.equal(heartbeat.acknowledgeResume({sequence:-1,resumeEpoch:1},1012),false);
 assert.equal(heartbeat.acknowledgeResume({sequence:1,resumeEpoch:1},999),false);
 assert.equal(heartbeat.accept(null,1013),false);
});
