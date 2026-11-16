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
