import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntimeBinding,installRuntimeHost,getRuntimeHost} from '../dist/runtime-host.js';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const engine=(options={})=>createRuntimeBinding({sessionId:'test',role:'engine',...options});

test('one realm owner, idempotent old disposer cannot restore or clear another host',()=>{
 const scope={},a=engine(),dropA=installRuntimeHost(a,scope);
 assert.throws(()=>installRuntimeHost(engine(),scope),/E_RUNTIME_HOST_IN_USE/);
 dropA();const b=engine(),dropB=installRuntimeHost(b,scope);dropA();assert.equal(getRuntimeHost(scope),b);dropB();assert.throws(()=>getRuntimeHost(scope),/E_RUNTIME_HOST/);
});
test('entry services revoke with entry while session and replacement remain active',async()=>{
 const events=[],binding=engine({onProject:data=>{events.push(data);return true;}}),a=binding.openEntry();
 let reject;const pending=new Promise((_,no)=>{reject=no;});a.host.bindProjectCommand(()=>pending);
 binding.receiveProjectCommand({n:1});await flush();a.close();const b=binding.openEntry();let called=0;b.host.bindProjectCommand(()=>{called++;});
 reject(Error('old entry'));await flush();assert.equal(binding.failure,undefined);assert.equal(a.host.emitProjectEvent({n:2}),false);assert.throws(()=>a.host.bindProjectCommand(()=>{}),/E_RUNTIME_CLOSING/);
 binding.receiveProjectCommand({n:3});await flush();assert.equal(called,1);assert.equal(b.host.emitProjectEvent({n:4}),true);
});
test('FIFO rechecks handler and gate after every callback; old disposer is harmless',async()=>{
 const seen=[],binding=engine();binding.receiveProjectCommand({n:1});binding.receiveProjectCommand({n:2});
 const dropA=binding.bindProjectCommand(data=>{seen.push('A'+data.n);binding.bindProjectCommand(next=>{seen.push('B'+next.n);binding.drain();});dropA();});
 assert.deepEqual(seen,[]);await flush();assert.deepEqual(seen,['A1','B2']);assert.equal(binding.receiveProjectCommand({n:3}),false);
});
test('queue owns data snapshot, rejects getters and budgets actual UTF-8 bytes',async()=>{
 const binding=engine({maxCommands:2,maxCommandBytes:19}),seen=[],data={text:'汉'};let receipts=0;
 assert.equal(binding.receiveProjectCommand(data,()=>receipts++),true);data.text='mutated';
 assert.equal(binding.receiveProjectCommand({text:'汉'},()=>receipts++),false);
 let getter=false;assert.equal(binding.receiveProjectCommand({get x(){getter=true;return 1;}}),false);assert.equal(getter,false);
 binding.bindProjectCommand(data=>{seen.push(data.text);});await flush();assert.deepEqual(seen,['汉']);assert.equal(receipts,2);
});
test('receipt acknowledges dispatch rather than async work; rejection is observed once',async()=>{
 const diagnostics=[],binding=engine({onDiagnostic:item=>{diagnostics.push(item);return true;}});let reject,receipt=0;
 binding.bindProjectCommand(()=>new Promise((_,no)=>{reject=no;}));binding.receiveProjectCommand({x:1},()=>receipt++);await flush();assert.equal(receipt,1);
 reject(Error('async command'));await flush();assert.equal(diagnostics.length,1);assert.equal(binding.failure.message,'async command');assert.match(binding.failure.stack,/runtime-host.test.mjs/);
});
test('first fatal is synchronously latched despite failed transport; draining still records cleanup',()=>{
 const binding=engine({onDiagnostic:()=>false}),entry=binding.openEntry();
 assert.equal(binding.reportDiagnostic({kind:'mystery',message:'bad'}),false);
 assert.equal(binding.reportDiagnostic({kind:'runtime',message:'first'}),true);assert.equal(binding.emitProjectEvent({x:1}),false);
 entry.close();entry.reportCleanupFailure({kind:'runtime',message:'cleanup'});assert.equal(binding.failure.message,'first');assert.equal(entry.summary().cleanup,'failed');
 binding.settle();assert.equal(binding.reportDiagnostic({kind:'runtime',message:'late'}),false);
});
test('legacy clear only disposes its own slot, not a subsequent new subscription',async()=>{
 const binding=engine(),seen=[];binding.bindLegacyProjectCommand(()=>seen.push('legacy'));
 binding.bindProjectCommand(()=>{seen.push('new');});binding.bindLegacyProjectCommand(null);
 binding.receiveProjectCommand({x:1});await flush();assert.deepEqual(seen,['new']);
});
test('sealing native epoch publishes an owned summary and prevents late cleanup or native entry reuse',()=>{
 const summaries=[],binding=engine({onSummary:value=>summaries.push(value)});binding.beginNativeEpoch('epoch-A');const a=binding.openEntry();
 a.ready(true);a.close();a.cleanupComplete();binding.endNativeEpoch('epoch-A');assert.equal(a.canCleanup(),false);assert.equal(summaries[0].sealed,true);
 const copy=summaries[0];copy.entries[0].cleanup='failed';assert.equal(binding.snapshotSummary().entries[0].cleanup,'complete');
 binding.beginNativeEpoch('epoch-B');assert.equal(a.canCleanup(),false);const b=binding.openEntry();assert.equal(b.canCleanup(),true);assert.equal(a.host.emitProjectEvent({}),false);
});
test('script workers report diagnostics but cannot bind or emit project traffic',()=>{
 const binding=createRuntimeBinding({sessionId:'worker',role:'script-worker',onDiagnostic:()=>true,onProject:()=>true});
 assert.equal(binding.emitProjectEvent({}),false);assert.throws(()=>binding.bindProjectCommand(()=>{}),/E_RUNTIME_ROLE/);assert.equal(binding.reportDiagnostic({kind:'recoverable',message:'worker'}),true);
});
test('script workers own entry cleanup without gaining project traffic or engine progress',async()=>{
 let progressed=0,cleaned=false,finish;const complete=new Promise(resolve=>finish=resolve),binding=createRuntimeBinding({sessionId:'worker-lifetime',role:'script-worker',onProgress:()=>progressed++,onProject:()=>true});
 const entry=binding.openEntry();entry.lifetime.defer(async()=>{for(let i=0;i<8;i++)await Promise.resolve();cleaned=true;finish();});entry.ready();
 assert.equal(entry.host.role,'script-worker');assert.equal(entry.host.emitProjectEvent({}),false);assert.throws(()=>entry.host.bindProjectCommand(()=>{}),/E_RUNTIME_ROLE/);binding.markProgress();assert.equal(progressed,0);
 binding.beginClose();assert.equal((await binding.drainClose()).status,'pending');await complete;await flush();assert.equal(cleaned,true);assert.equal(binding.closeProgress().status,'complete');binding.endNativeEpoch('untracked');assert.equal(binding.snapshotSummary().entries[0].cleanup,'complete');
 assert.throws(()=>createRuntimeBinding({sessionId:'host-only',role:'host'}).openEntry(),/E_RUNTIME_ROLE/);
});
test('factory survives independent serialization without module closure dependencies',async()=>{
 const context=vm.createContext({});vm.runInContext('this.binding=('+createRuntimeBinding.toString()+')({sessionId:"serialized",role:"engine"});binding.beginNativeEpoch("epoch");const entry=binding.openEntry();entry.ready();entry.close();binding.endNativeEpoch("epoch");',context);
 assert.equal(context.binding.snapshotSummary().sealed,true);assert.equal(context.binding.snapshotSummary().entries[0].cleanup,'complete');
});

test('native epoch summary stays sealed against all late entry mutations',()=>{
 const binding=engine();binding.beginNativeEpoch('a');const entry=binding.openEntry();entry.close();binding.endNativeEpoch('a');
 const sealed=binding.snapshotSummary();entry.ready(false);entry.cleanupComplete();entry.cleanupUnconfirmed();entry.reportCleanupFailure({kind:'runtime',message:'late'});
 assert.deepEqual(binding.snapshotSummary(),sealed);assert.equal(binding.failure,undefined);
});
test('validation reentry cannot send, reserve data or resurrect a settled run',()=>{
 let emitted=0,acks=0;const binding=engine({onProject:()=>{emitted++;return true;}});
 const payload=new Proxy({x:1},{ownKeys(target){binding.drain();return Reflect.ownKeys(target);}});
 assert.equal(binding.emitProjectEvent(payload),false);assert.equal(emitted,0);
 const other=engine();const queued=new Proxy({x:1},{ownKeys(target){other.drain();return Reflect.ownKeys(target);}});
 assert.equal(other.receiveProjectCommand(queued,()=>acks++),false);assert.equal(acks,1);
 const final=engine(),item=new Proxy({kind:'runtime',message:'bad'},{ownKeys(target){final.settle();return Reflect.ownKeys(target);}});
 assert.equal(final.reportDiagnostic(item),false);assert.equal(final.failure,undefined);
});
test('owned JSON encoding never invokes inherited serializers or non-index array getters',()=>{
 const binding=engine({onProject:()=>true});let calls=0;
 Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){calls++;throw Error('inherited serializer');}});
 try{assert.equal(binding.emitProjectEvent({nested:[{x:1}]}),true);assert.equal(calls,0);}finally{delete Object.prototype.toJSON;}
 const items=[];Object.defineProperty(items,'4294967295',{enumerable:true,get(){calls++;return 1;}});
 assert.equal(binding.emitProjectEvent({items}),false);assert.equal(calls,0);
});
test('closing the dispatch owner cancels its remaining queue before a new entry can bind',async()=>{
 const binding=engine(),a=binding.openEntry(),seen=[];let acks=0;
 a.host.bindProjectCommand(value=>{seen.push('A'+value.n);a.close();const b=binding.openEntry();b.host.bindProjectCommand(next=>{seen.push('B'+next.n);});});
 binding.receiveProjectCommand({n:1},()=>acks++);binding.receiveProjectCommand({n:2},()=>acks++);await flush();assert.deepEqual(seen,['A1']);assert.equal(acks,2);
});

test('disposing a command handler before entry close cannot transfer its pending commands',async()=>{
 const binding=engine(),a=binding.openEntry(),seen=[];let acks=0;
 const dispose=a.host.bindProjectCommand(value=>seen.push('A'+value.n));
 binding.receiveProjectCommand({n:1},()=>acks++);dispose();a.close();
 const b=binding.openEntry();b.host.bindProjectCommand(value=>seen.push('B'+value.n));
 await flush();assert.deepEqual(seen,[]);assert.equal(acks,1);
 binding.receiveProjectCommand({n:2},()=>acks++);await flush();assert.deepEqual(seen,['B2']);assert.equal(acks,2);
});

test('handoff before old entry close cancels only old commands and preserves new commands',async()=>{
 const binding=engine(),a=binding.openEntry(),seen=[],acks=[];
 a.host.bindProjectCommand(value=>{
  seen.push('A'+value.n);
  const b=binding.openEntry();b.host.bindProjectCommand(next=>seen.push('B'+next.n));
  binding.receiveProjectCommand({n:3},()=>acks.push(3));a.close();
 });
 binding.receiveProjectCommand({n:1},()=>acks.push(1));binding.receiveProjectCommand({n:2},()=>acks.push(2));
 await flush();assert.deepEqual(seen,['A1','B3']);assert.deepEqual(acks.sort(),[1,2,3]);
});

test('handler replacement within the same entry preserves FIFO and the new binding',async()=>{
 const binding=engine(),entry=binding.openEntry(),seen=[];let dispose;
 dispose=entry.host.bindProjectCommand(value=>{
  seen.push('A'+value.n);entry.host.bindProjectCommand(next=>seen.push('B'+next.n));dispose();
 });
 binding.receiveProjectCommand({n:1});binding.receiveProjectCommand({n:2});await flush();assert.deepEqual(seen,['A1','B2']);
});

test('early commands belong to the first entry and closed entry gaps reject old traffic',async()=>{
 const binding=engine(),seen=[];let acks=0;
 binding.receiveProjectCommand({n:1},()=>acks++);const a=binding.openEntry();a.close();
 assert.equal(binding.receiveProjectCommand({n:2},()=>acks++),false);
 const b=binding.openEntry();binding.receiveProjectCommand({n:3},()=>acks++);b.host.bindProjectCommand(value=>seen.push(value.n));
 await flush();assert.deepEqual(seen,[3]);assert.equal(acks,3);
});

test('cleanup failure cannot be downgraded by completion, readiness or pending reassessment',()=>{
 const binding=engine(),entry=binding.openEntry();entry.ready(true);entry.close();
 entry.reportCleanupFailure({kind:'runtime',message:'cleanup failed'});
 entry.cleanupComplete();entry.ready(false);entry.cleanupUnconfirmed();
 assert.equal(entry.summary().cleanup,'failed');assert.equal(binding.failure.message,'cleanup failed');
 binding.endNativeEpoch('untracked');assert.equal(binding.snapshotSummary().entries[0].cleanup,'failed');
});

test('forced settlement is not evidence of native epoch seal and sealed sources reject late diagnostics',()=>{
 const forced=engine();forced.beginNativeEpoch('forced');forced.settle();assert.equal(forced.snapshotSummary().sealed,false);
 const normal=engine();normal.beginNativeEpoch('normal');normal.endNativeEpoch('normal');assert.equal(normal.reportDiagnostic({kind:'runtime',message:'after native release'}),false);assert.equal(normal.failure,undefined);
});

test('native Error stack formatting does not evaluate an application message accessor',async()=>{
 let calls=0;const failure=new Error('original');Object.defineProperty(failure,'message',{get(){calls++;return 'custom';}});
 const binding=engine();binding.bindProjectCommand(()=>{throw failure;});binding.receiveProjectCommand({});await flush();assert.equal(calls,0);assert.equal(binding.failure.message,'Project command failed');
});

test('session close broadcasts cancellation before independent entry cleanup and waits for owned promises',async()=>{
 const events=[],binding=engine(),a=binding.openEntry(),b=binding.openEntry();let resolve;
 a.lifetime.onCancel(()=>events.push('cancel-a'));b.lifetime.onCancel(()=>events.push('cancel-b'));
 a.lifetime.defer(()=>{events.push('cleanup-a');return new Promise(accept=>resolve=accept);});
 b.lifetime.defer(()=>events.push('cleanup-b'));a.finishStartup();b.finishStartup();
 binding.beginClose();assert.equal(a.lifetime.cancelled,true);assert.equal(b.lifetime.cancelled,true);
 const first=await binding.drainClose();assert.deepEqual(events,['cancel-a','cancel-b','cleanup-a','cleanup-b']);assert.equal(first.status,'pending');assert.equal(first.pendingCleanups,1);
 binding.beginClose();resolve();await flush();assert.equal(binding.closeProgress().status,'complete');assert.equal(events.filter(value=>value==='cleanup-a').length,1);
});

test('entry cleanup is LIFO, continues after a failure, and registration disposers cannot remove claimed jobs',async()=>{
 const events=[],binding=engine(),entry=binding.openEntry();
 const remove=entry.lifetime.defer(()=>events.push('first'));
 entry.lifetime.defer(()=>{events.push('second');throw Error('cleanup failed');});
 entry.finishStartup();entry.close();remove();await flush();
 assert.deepEqual(events,['second','first']);assert.equal(binding.closeProgress().status,'failed');assert.equal(binding.failure.message,'cleanup failed');
 assert.throws(()=>entry.lifetime.defer(()=>{}),/E_RUNTIME_CLOSING/);
});

test('bounded close progress keeps pending startup and admits only its captured late cleanup while native is alive',async()=>{
 const binding=engine(),entry=binding.openEntry();let cleanup=0;
 binding.beginClose();const pending=await binding.drainClose();assert.equal(pending.pendingStartup,1);assert.equal(pending.status,'pending');
 entry.finishStartup(()=>{cleanup++;});await flush();assert.equal(cleanup,1);assert.equal(binding.closeProgress().status,'complete');
 const other=engine(),late=other.openEntry();other.beginClose();other.endNativeEpoch('untracked');late.finishStartup(()=>cleanup++);
 assert.equal(cleanup,1);assert.equal(other.closeProgress().status,'unconfirmed');assert.equal(other.closeProgress().canNativeCleanup,false);
});

test('cleanup ticks progress after entry close and sealing revokes hooks without inventing native exit proof',async()=>{
 const binding=engine(),entry=binding.openEntry();let ticks=0,seals=0,resolve;
 entry.onCleanupTick(()=>{ticks++;if(ticks===3)resolve?.();});entry.onNativeSeal(()=>seals++);
 entry.lifetime.defer(()=>new Promise(accept=>resolve=accept));entry.finishStartup();binding.beginClose();
 for(let pass=0;pass<3;pass++)await binding.drainClose();await flush();assert.equal(binding.closeProgress().status,'complete');
 const before=ticks;binding.settle();await binding.drainClose();assert.equal(ticks,before);assert.equal(seals,1);assert.equal(binding.snapshotSummary().sealed,false);
});

test('serialized runtime factory owns lifetime callbacks and finite close progress without module helpers',async()=>{
 const context=vm.createContext({});
 vm.runInContext(`this.binding=(${createRuntimeBinding.toString()})({sessionId:'serialized-close',role:'engine'});
  this.events=[];const entry=binding.openEntry();entry.lifetime.onCancel(()=>events.push('cancel'));
  entry.lifetime.defer(async()=>{await Promise.resolve();events.push('cleanup');});entry.finishStartup();binding.beginClose();`,context);
 await context.binding.drainClose();await flush();assert.deepEqual([...context.events],['cancel','cleanup']);assert.equal(context.binding.closeProgress().status,'complete');
});

test('business draining closes admission before coordinated cleanup starts without revoking the native cleanup lease',()=>{
 const binding=engine(),entry=binding.openEntry();entry.finishStartup();
 assert.equal(binding.closeProgress().accepting,true);binding.drain();
 const progress=binding.closeProgress();assert.equal(progress.accepting,false);assert.equal(progress.closing,false);assert.equal(progress.canNativeCleanup,true);assert.equal(entry.canCleanup(),true);
 binding.beginClose();assert.equal(binding.closeProgress().closing,true);
});

test('owned entry participants receive coordinated cancel, cleanup ticks and seal without public host lifecycle methods',async()=>{
 const binding=engine(),entry=binding.openEntry(),events=[];let resolve,ticks=0;
 const participant={beginClose(){events.push('begin');},tick(){events.push('tick');if(++ticks===3)resolve?.();},seal(){events.push('seal');},close(){events.push('close');return new Promise(accept=>resolve=accept);}};
 assert.equal(binding.attachEntryCleanup(entry.host,participant),true);assert.equal(binding.attachEntryCleanup(entry.host,participant),true);
 assert.equal('attachEntryCleanup' in entry.host,false);entry.finishStartup();binding.beginClose();
 for(let pass=0;pass<3;pass++)await binding.drainClose();await flush();
 assert.equal(events.filter(value=>value==='begin').length,1);assert.equal(events.filter(value=>value==='close').length,1);assert.equal(binding.closeProgress().status,'complete');
 binding.endNativeEpoch('untracked');assert.equal(events.filter(value=>value==='seal').length,0,'Completed resources retire their epoch callbacks');
});

test('cleanup budgets count owned jobs rather than cumulative registrations',async()=>{
 const binding=engine(),entry=binding.openEntry();entry.finishStartup();let calls=0;
 for(let i=0;i<512;i++){const remove=entry.lifetime.defer(()=>calls++);remove();remove();}
 assert.equal(binding.closeProgress().pendingCleanups,0);
 for(let i=0;i<128;i++)entry.lifetime.defer(()=>calls++);
 assert.throws(()=>entry.lifetime.defer(()=>{}),/E_RUNTIME_CLEANUP_BUDGET/,'Live registrations remain bounded');
 binding.beginClose();await flush();assert.equal(calls,128);assert.equal(binding.closeProgress().status,'complete');
});

test('retired participants release callbacks and cannot detach another entry owner',async()=>{
 const binding=engine(),entry=binding.openEntry(),other=binding.openEntry();entry.finishStartup();other.finishStartup();
 let cancel=0,tick=0,seal=0,close=0;
 const resource={beginClose(){cancel++;},tick(){tick++;},seal(){seal++;},close(){close++;}};
 for(let i=0;i<512;i++){
  assert.equal(binding.attachEntryCleanup(entry.host,resource),true);
  assert.equal(binding.detachEntryCleanup(other.host,resource),false);
  assert.equal(binding.detachEntryCleanup({...entry.host},resource),false);
  assert.equal(binding.detachEntryCleanup(entry.host,resource),true);
 }
 assert.equal(binding.closeProgress().pendingCleanups,0);
 binding.beginClose();await binding.drainClose();binding.endNativeEpoch('untracked');
 assert.deepEqual({cancel,tick,seal,close},{cancel:0,tick:0,seal:0,close:0});
});

test('detaching a claimed participant does not certify its unsettled close Promise',async()=>{
 const binding=engine(),entry=binding.openEntry();let resolve;
 const resource={beginClose(){},tick(){},seal(){},close(){return new Promise(done=>resolve=done);}};
 binding.attachEntryCleanup(entry.host,resource);entry.finishStartup();binding.beginClose();await binding.drainClose();
 assert.equal(binding.detachEntryCleanup(entry.host,resource),true);
 assert.equal(binding.closeProgress().pendingCleanups,1);assert.equal(binding.closeProgress().status,'pending');
 resolve();await flush();assert.equal(binding.closeProgress().pendingCleanups,0);assert.equal(binding.closeProgress().status,'complete');
});

test('serialized factory supports participant retirement and slot reuse',async()=>{
 const context=vm.createContext({});
 vm.runInContext(`this.binding=(${createRuntimeBinding.toString()})({sessionId:'retirement',role:'engine'});
  const entry=binding.openEntry();entry.finishStartup();
  for(let i=0;i<512;i++){
   entry.lifetime.defer(()=>{})();
   const p={beginClose(){},tick(){},seal(){},close(){}};
   if(!binding.attachEntryCleanup(entry.host,p)||!binding.detachEntryCleanup(entry.host,p))throw Error('retirement failed');
  }
  binding.beginClose();`,context);
 await context.binding.drainClose();assert.equal(context.binding.closeProgress().status,'complete');
});

test('participant attachment rejects forged, foreign, retired and globally scoped hosts before running participant accessors',()=>{
 const binding=engine(),entry=binding.openEntry(),other=engine(),foreign=other.openEntry();let reads=0;
 const valid={beginClose(){},tick(){},seal(){},close(){}};
 assert.equal(binding.attachEntryCleanup(binding,valid),false);
 assert.equal(binding.attachEntryCleanup({...entry.host},valid),false);
 assert.equal(binding.attachEntryCleanup(foreign.host,valid),false);
 const getter={...valid};Object.defineProperty(getter,'close',{get(){reads++;return ()=>{};}});
 assert.equal(binding.attachEntryCleanup(entry.host,getter),false);assert.equal(reads,0);
 assert.equal(binding.attachEntryCleanup(entry.host,valid),true);
 assert.equal(binding.attachEntryCleanup(binding.openEntry().host,valid),false,'one participant has one entry owner');
 entry.finishStartup();entry.close();assert.equal(binding.attachEntryCleanup(entry.host,{...valid}),false);
 const live=binding.openEntry();binding.endNativeEpoch('untracked');assert.equal(binding.attachEntryCleanup(live.host,{...valid}),false);
});

test('serialized factory can attach a renderer participant using its own scoped host identity',async()=>{
 const context=vm.createContext({});
 vm.runInContext(`this.binding=(${createRuntimeBinding.toString()})({sessionId:'serialized-participant',role:'engine'});
  this.closed=0;const entry=binding.openEntry();
  this.attached=binding.attachEntryCleanup(entry.host,{beginClose(){},tick(){},seal(){},async close(){closed++;}});
  entry.finishStartup();binding.beginClose();`,context);
 assert.equal(context.attached,true);await context.binding.drainClose();await flush();
 assert.equal(context.closed,1);assert.equal(context.binding.closeProgress().status,'complete');
});
