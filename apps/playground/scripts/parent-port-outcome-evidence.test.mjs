import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {MessagePort,MessageChannel} from 'node:worker_threads';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {installParentPortReceiptObserver,assertParentPortOutcomeEvidence,observeParentPortMessages} from './parent-port-outcome-evidence.mjs';

const identity={runId:'actual-run',revision:0,buildKey:'actual-build',generation:'actual-generation',documentId:'actual-document',workerId:'actual-worker',runConfigurationHash:'a'.repeat(64)};
const parentURL='http://editor.test/';
const snapshot=()=>({...identity,workerState:'running',exit:null,audio:{closed:false,liveNodes:2},workerErrors:['EXPECTED_FAILURE']});
const receipt=()=>({...identity,protocolVersion:2,type:'exit-report',reason:'forced-worker-termination',engineOutcome:{kind:'terminate-issued'},hostCleanup:{status:'complete'}});
const observation=()=>({schemaVersion:1,source:'parent-port',parentURL,portId:'native-port:1',connected:{...identity,protocolVersion:2,type:'connected'},connectedSequence:1,receiptSequence:3,connectedAtMs:1,receiptAtMs:2,receipt:receipt()});
class Context extends EventEmitter{
 scripts=[];
 async addInitScript(fn,arg){this.scripts.push({fn,arg});}
 push(value){const {prefix}=this.scripts[0].arg;this.emit('console',{text:()=>prefix+JSON.stringify({schemaVersion:1,type:'record',args:[value]}),page:()=>({url:()=>parentURL}),location:()=>({url:parentURL})});}
}
async function setup(){const context=new Context(),observer=await installParentPortReceiptObserver(context);return{context,observer};}
const clone=value=>JSON.parse(JSON.stringify(value));

test('an explicit join retains the original incomplete snapshot and copies the actual full raw receipt without inventing audio/state/code',async()=>{
 const {context,observer}=await setup(),old=snapshot(),before=clone(old),raw=observation();context.push(raw);
 const joined=await observer.join(old);joined.expectedFailure={marker:'EXPLICIT_REPORT_ANNOTATION'};
 assert.equal(joined.audio,old.audio);assert.equal(joined.workerState,'running');assert.equal(joined.audio.closed,false);
 assert.deepEqual(old,before);assert.equal(joined.terminalObservation.snapshot.exit,null);
 assert.deepEqual(joined.exit,raw.receipt);assert(!Object.hasOwn(joined.exit,'code'));
 assert.doesNotThrow(()=>assertParentPortOutcomeEvidence(clone(joined)));
 const read=observer.readObservations();read[0].receipt.reason='forged';assert.equal(observer.readObservations()[0].receipt.reason,'forced-worker-termination');context.emit('close');
});
test('a delayed parent receipt can complete a join while the iframe snapshot remains permanently unchanged',async()=>{
 const {context,observer}=await setup(),old=snapshot(),timer=setTimeout(()=>context.push(observation()),5);
 try{const joined=await observer.join(old,{timeoutMs:1000,pollMs:2});assert.equal(old.exit,null);assert.equal(old.audio.closed,false);assert.equal(joined.exit.reason,'forced-worker-termination');assert.doesNotThrow(()=>assertParentPortOutcomeEvidence(joined));}finally{clearTimeout(timer);context.emit('close');}
});
test('a missing parent receipt times out; failed real cleanup stays failed rather than being turned into a completion',async()=>{
 const {context,observer}=await setup();await assert.rejects(observer.join(snapshot(),{timeoutMs:8,pollMs:1}),/without actual parent-port receipt/);
 const bad=observation();bad.receipt.hostCleanup={status:'timed-out',detail:'actual close stalled'};context.push(bad);
 await assert.rejects(observer.join(snapshot()),/actual Host cleanup failed/);assert.equal(observer.readObservations()[0].receipt.hostCleanup.status,'timed-out');context.emit('close');
});
test('independent validation rejects changes to any of seven identities, raw receipt, original snapshot, state, audio or ordering',async()=>{
 const {context,observer}=await setup();context.push(observation());const joined=await observer.join(snapshot());
 const changes=[
  ...Object.keys(identity).map(key=>value=>{value.terminalObservation.connected[key]='stale';}),
  ...Object.keys(identity).map(key=>value=>{value.terminalObservation.receipt[key]='stale';}),
  value=>{value.exit.reason='clean-exit';},value=>{value.audio.closed=true;},value=>{value.workerState='terminated';},
  value=>{value.terminalObservation.snapshot.audio.closed=true;},value=>{value.terminalObservation.receiptSequence=1;},
  value=>{value.terminalObservation.receipt.type='exited';},value=>{value.terminalObservation.receipt.protocolVersion=1;},
  value=>{value.terminalObservation.receiptAtMs=0;},value=>{value.terminalObservation.joinedAtMs=0;},
  value=>{value.terminalObservation.source='iframe-console';},value=>{delete value.terminalObservation.snapshot;},
 ];
 assert.throws(()=>assertParentPortOutcomeEvidence(snapshot()),/missing explicit/);
 for(const change of changes){const value=clone(joined);change(value);assert.throws(()=>assertParentPortOutcomeEvidence(value),/E_PARENT_PORT_OUTCOME/);}
 context.emit('close');
});
test('an existing actual exit cannot silently be replaced by a conflicting parent receipt',async()=>{
 const {context,observer}=await setup();context.push(observation());const old=snapshot();old.exit={...receipt(),engineOutcome:{kind:'native-exit',code:0},code:0,reason:'clean-exit'};
 await assert.rejects(observer.join(old),/existing snapshot exit disagrees/);assert.equal(old.exit.code,0);context.emit('close');
});
test('Native receipts preserve their actual exit code and do not require rewriting an earlier running snapshot',async()=>{
 const {context,observer}=await setup(),raw=observation();raw.receipt={...receipt(),reason:'crashed',engineOutcome:{kind:'native-exit',code:17},code:17};context.push(raw);
 const joined=await observer.join(snapshot());assert.equal(joined.exit.code,17);assert.equal(joined.workerState,'running');assert.doesNotThrow(()=>assertParentPortOutcomeEvidence(joined));context.emit('close');
});
test('the browser hook does not instrument a child/pseudo-window',()=>{
 let accessed=false;const realm={parent:{}};Object.defineProperty(realm,'MessagePort',{get(){accessed=true;throw Error('child must not touch native prototype');}});
 vm.runInNewContext('('+observeParentPortMessages.toString()+')({recorderName:"record"})',realm);assert.equal(accessed,false);
});
test('the observer event model rejects port rebind, cross-port identity reuse, stale envelopes and synthetic targets',()=>{
 // A protocol event model isolates filter branches. This is not a claim that
 // JavaScript can manufacture isTrusted browser events. Actual browser/native
 // delivery is captured by the separately preserved work diagnostic.
 const callbacks=new WeakMap(),handlers=new WeakMap(),records=[];
 class Port{}
 Object.defineProperty(Port.prototype,'onmessage',{configurable:true,enumerable:true,get(){return handlers.get(this);},set(value){handlers.set(this,value);}});
 const realm={MessagePort:Port,EventTarget:{prototype:{addEventListener(type,callback){callbacks.set(this,callback);}}},crypto:webcrypto,performance,structuredClone,location:{href:parentURL},record:value=>records.push(value)};
 vm.runInNewContext('globalThis.parent=globalThis;('+observeParentPortMessages.toString()+')({recorderName:"record"})',realm);
 const port=new Port();port.onmessage=()=>{};
 const emit=(p,data,extra={})=>callbacks.get(p)({isTrusted:true,target:p,currentTarget:p,data,...extra});
 emit(port,receipt());assert.equal(records.length,0,'exit without connected is not proof');
 emit(port,{...identity,protocolVersion:2,type:'connected'});
 for(const key of Object.keys(identity))emit(port,{...receipt(),[key]:'stale'});
 emit(port,receipt(),{isTrusted:false});emit(port,receipt(),{target:{}});emit(port,receipt(),{currentTarget:{}});assert.equal(records.length,0);
 emit(port,receipt());assert.equal(records.length,1);assert.deepEqual(clone(records[0].receipt),receipt());
 const duplicate=new Port();duplicate.onmessage=()=>{};emit(duplicate,{...identity,protocolVersion:2,type:'connected'});assert.equal(records.at(-1).source,'parent-port-observer-error');
 const count=records.length;emit(duplicate,receipt());assert.equal(records.length,count,'reused port cannot supply a receipt');
 emit(port,{...identity,protocolVersion:2,type:'connected'});assert.equal(records.at(-1).source,'parent-port-observer-error');
 const after=records.length;emit(port,receipt());assert.equal(records.length,after,'rebound port cannot supply another receipt');
});
test('real Node MessagePort delivery keeps native brands/getter/product handler; untrusted Node and synthetic events are not browser receipts',async()=>{
 // Node's genuine port events are isTrusted=false. This tests native port
 // behavior and the rejection guard, not positive browser delivery. The work
 // browser probe separately exercises actual isTrusted browser port events.
 const before=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage'),records=[],realm={MessagePort,EventTarget,crypto:webcrypto,performance,structuredClone,location:{href:parentURL},record:value=>records.push(value)};
 vm.runInNewContext('globalThis.parent=globalThis;('+observeParentPortMessages.toString()+')({recorderName:"record"})',realm);
 const channel=new MessageChannel();let calls=0;
 try{
  const descriptor=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage');assert.equal(descriptor.get,before.get);assert.equal(descriptor.enumerable,before.enumerable);assert.equal(descriptor.configurable,before.configurable);
  assert.equal(MessagePort.prototype.constructor,MessagePort);assert.throws(()=>Reflect.apply(descriptor.get,{},[]),TypeError);
  const handler=event=>{assert.equal(event.target,channel.port1);calls++;};channel.port1.onmessage=handler;assert.equal(channel.port1.onmessage,handler);assert(channel.port1 instanceof MessagePort);
  const done=new Promise(resolve=>channel.port1.addEventListener('message',()=>{if(calls===2)resolve();}));
  channel.port2.postMessage({...identity,protocolVersion:2,type:'connected'});channel.port2.postMessage(receipt());await done;
  channel.port1.dispatchEvent(new MessageEvent('message',{data:receipt()}));assert.equal(calls,3);assert.deepEqual(records,[]);
 }finally{channel.port1.close();channel.port2.close();Object.defineProperty(MessagePort.prototype,'onmessage',before);}
});
test('an invalid native receiver fails the original interface brand before any listener or WeakMap side effect',()=>{
 const before=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage'),nativeAdd=EventTarget.prototype.addEventListener,nativeHasRef=MessagePort.prototype.hasRef;
 const effects={listeners:0,has:0,set:0};
 class TrackedWeakMap extends WeakMap{
  has(value){effects.has++;return super.has(value);}
  set(key,value){effects.set++;return super.set(key,value);}
 }
 // Node's onmessage accessors accept all EventTargets, unlike the browser's
 // MessagePort-branded accessors. Model that stricter accessor with a genuine,
 // read-only native MessagePort brand check; the receiver below is a real
 // EventTarget that would otherwise accept the observer's native listener.
 Object.defineProperty(MessagePort.prototype,'onmessage',{...before,
  get(){Reflect.apply(nativeHasRef,this,[]);return Reflect.apply(before.get,this,[]);},
  set(value){Reflect.apply(nativeHasRef,this,[]);return Reflect.apply(before.set,this,[value]);},
 });
 const realm={MessagePort,EventTarget:{prototype:{addEventListener(...args){effects.listeners++;return Reflect.apply(nativeAdd,this,args);}}},WeakMap:TrackedWeakMap,crypto:webcrypto,performance,structuredClone,location:{href:parentURL},record(){}};
 try{
  vm.runInNewContext('globalThis.parent=globalThis;('+observeParentPortMessages.toString()+')({recorderName:"record"})',realm);
  const setter=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage').set;
  for(const receiver of [new EventTarget(),{},null])assert.throws(()=>Reflect.apply(setter,receiver,[()=>{}]),TypeError);
  assert.deepEqual(effects,{listeners:0,has:0,set:0});
 }finally{Object.defineProperty(MessagePort.prototype,'onmessage',before);}
});
