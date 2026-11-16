import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
function fixture(){
 const calls=[],context=vm.createContext({console:{log(){},warn(){},error(){},trace(){},assert:console.assert}});
 vm.runInContext(source,context);
 context.calls=calls;
 vm.runInContext(`
  let internalSerial=0;
  _jsbb_.interop={
   call_function(opaque,callback,construct,base){calls.push(['call',opaque,construct]);_jsbb_.engine.stack.SetValue(base,undefined);},
   call_accessor(opaque,callback,key,result){calls.push(['accessor',opaque]);_jsbb_.engine.stack.SetValue(result,42);},
   generate_internal_data(opaque){calls.push(['allocate',opaque]);return ++internalSerial;},gc_callback(){}
  };
  function makeEngine(opaque){
   const engine=new jsbb_Engine(0,opaque);_jsbb_.engine=engine;
   const slot=engine.stack.Push(undefined),object={};
   const method=engine.stack.GetValue(engine.NewCFunction(1,slot,0));
   const ctor=engine.stack.GetValue(engine.NewClass(2,slot,1,0));
   const noop=engine.stack.GetValue(engine.NewNoopConstructor());
   engine.DefineLazyProperty(engine.stack.Push(object),engine.stack.Push('native'),3);
   engine.DefineLazyProperty(engine.stack.Push(object),engine.stack.Push('pending'),3);
   return {engine,method,ctor,noop,object};
  }
  this.first=makeEngine(13);
 `,context);
 return {context,calls};
}

test('logical native seal revokes methods, constructors and lazy access before physical release',()=>{
 const {context,calls}=fixture();
 assert.equal(vm.runInContext('first.object.native',context),42);
 vm.runInContext('first.method();new first.ctor();new first.noop();',context);
 const before=calls.length;
 vm.runInContext('_jsbb_.SealNativeEpoch(0)',context);
 assert.equal(vm.runInContext('!!first.engine.stack',context),true,'logical sealing must retain physical handles');
 for(const expression of ['first.method()','new first.ctor()','new first.noop()','first.object.pending']){
  assert.throws(()=>vm.runInContext(expression,context),/E_NATIVE_EPOCH_CLOSED/);
 }
 assert.equal(vm.runInContext('first.object.native',context),42,'already materialized metadata needs no native call');
 assert.equal(calls.length,before,'revoked wrappers never allocate internal data or enter native interop');
});

test('a replacement engine cannot revive captured wrappers from a sealed native epoch',()=>{
 const {context,calls}=fixture();
 vm.runInContext('_jsbb_.SealNativeEpoch(0);this.second=makeEngine(27);second.method();new second.ctor();',context);
 assert(calls.some(([name,opaque])=>name==='call'&&opaque===27));
 const before=calls.length;
 assert.throws(()=>vm.runInContext('first.method()',context),/E_NATIVE_EPOCH_CLOSED/);
 assert.equal(calls.length,before);
 assert.equal(vm.runInContext('second.object.native',context),42);
});

test('closing an entry does not seal its shared live native engine',async()=>{
 const {context,calls}=fixture();
 // Runtime ownership is distinct from the native bridge's logical lifetime.
 const {createRuntimeBinding}=await import('../../../../packages/engine/dist/runtime-host.js');
 const binding=createRuntimeBinding({sessionId:'shared',role:'engine'});
 binding.beginNativeEpoch('shared-native');const a=binding.openEntry(),b=binding.openEntry();a.ready();b.ready();a.close();
 vm.runInContext('first.method();',context);
 assert.equal(calls.at(-1)[0],'call');assert.equal(b.canCleanup(),true);
});

test('draining rejects new native JSWorkers before allocation while existing cleanup methods remain callable',()=>{
 const {context,calls}=fixture();context.closing=false;
 vm.runInContext(`
  globalThis.__godotjsRuntimeHost={closeProgress(){return {closing};}};
  _jsbb_.wasmop={UTF8ToString(){return 'JSWorker';}};
  this.WorkerConstructor=first.engine.stack.GetValue(first.engine.NewClass(4,first.engine.stack.Push(undefined),1,1));
  new WorkerConstructor();
 `,context);
 context.closing=true;const before=calls.length;
 assert.throws(()=>vm.runInContext('new WorkerConstructor()',context),/E_RUNTIME_CLOSING/);
 assert.equal(calls.length,before);
 vm.runInContext('first.method()',context);assert.equal(calls.length,before+1);
});

test('logical seal drops late native worker messages before stack entry or Variant restoration',()=>{
 const {context,calls}=fixture();
 vm.runInContext(`
  _jsbb_.interop.on_worker_message=()=>calls.push(['late-message']);
  _jsbb_.SealNativeEpoch(0);
  const message={data:{value:1},transfer_id:1,route:{source:1,target:0,targetEpoch:'host',epoch:'child',channel:1,direction:'to-child'}};
  _jsbb_.handle_message(message);_jsbb_.queue_worker_message(message);_jsbb_.FlushPendingWorkerMessages();
 `,context);
 assert.deepEqual(calls,[]);assert.equal(context._jsbb_._pending_worker_messages.length,0);
});
