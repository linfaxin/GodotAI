import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import test from 'node:test';

const source=await readFile(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');

// Browser-like asynchronous postMessage delivery across independent JS realms.
// The host intentionally has no bridge engine or native callbacks.
function network() {
  const pending=[],workers=new Map(),realms=new Map(),received=[],nativeTransfers=[],progress=[];
  const quiet={log(){},warn(){},error(){},assert:console.assert};
  const PThread={pthreads:{},unusedWorkers:[],getNewWorker(){return this.unusedWorkers.shift();}};
  const host=createContext({console:quiet,PThread,ENVIRONMENT_IS_PTHREAD:false});
  runInContext(source,host);
  function realm(id,role,parent=0) {
    const outboundListeners=[],inboundListeners=[];
    const worker={pthread_ptr:id,addEventListener(name,callback){if(name==='message')outboundListeners.push(callback);},postMessage(data){const snapshot=structuredClone(data);pending.push(()=>inboundListeners.forEach(callback=>callback({data:snapshot,stopImmediatePropagation(){}})));}};
    PThread.pthreads[id]=worker;workers.set(id,worker);
    const context=createContext({console:quiet,ENVIRONMENT_IS_PTHREAD:true,
      addEventListener(name,callback){if(name==='message')inboundListeners.push(callback);},
      postMessage(data){const snapshot=structuredClone(data);pending.push(()=>outboundListeners.forEach(callback=>callback({data:snapshot,stopImmediatePropagation(){}})));},
      __godotjsRuntimeHost:{assignRole(value){progress.push(['role',id,value]);},markProgress(){progress.push(['frame',id]);}},
    });
    runInContext(source,context);host._jsbb_.install_pthread_worker_listener_hook();
    const values=new Map();let index=8;
    const stack={EnterScope(){},ExitScope(){},GetValue(position){return values.get(position);},Push(value){const position=index++;values.set(position,value);return position;}};
    context._jsbb_.ConfigureThread(role==='engine'?1:2,id,parent);
    context._jsbb_.engine={stack,Release(){}};
    context._jsbb_.interop={
      worker_get_or_add_native_transfer(channel,env,transfer,position){nativeTransfers.push({source:id,channel,env,transfer,value:values.get(position)});return nativeTransfers.length-1;},
      on_worker_message(sender,position,transfer){received.push({target:id,kind:'parent-message',sender,transfer,data:values.get(position)});},
      on_worker_message_from_pthread(sender,position,transfer){received.push({target:id,kind:transfer===0?'ready':'child-message',sender,transfer,data:values.get(position)});},
    };
    const entry={context,values,role,parent,worker,send(channel,value,transfer,toParent=false){const position=stack.Push(value);return context._jsbb_.PostMessage(channel,id*100,position,transfer,0,toParent);}};
    realms.set(id,entry);return entry;
  }
  function drain(){let turns=0;while(pending.length){assert(++turns<1000,'network did not settle');pending.shift()();}for(const entry of realms.values())entry.context._jsbb_.FlushPendingWorkerMessages();}
  return {host,realm,drain,received,nativeTransfers,progress,pending,workers};
}

test('pthread engine sends to child and receives ready, plain replies and Variant receipts without a page engine',()=>{
  const n=network(),engine=n.realm(41,'engine'),child=n.realm(42,'script-worker',41);n.drain();
  assert.equal(n.host._jsbb_.engine,undefined);
  assert.equal(engine.send(42,'hello',1),0);n.drain();
  assert.deepEqual(n.received.shift(),{target:42,kind:'parent-message',sender:41,transfer:1,data:'hello'});
  assert.equal(child.send(42,undefined,0,true),0);n.drain();
  assert.deepEqual(n.received.shift(),{target:41,kind:'ready',sender:42,transfer:0,data:undefined});
  assert.equal(child.send(42,'reply',2,true),0);n.drain();
  assert.deepEqual(n.received.shift(),{target:41,kind:'child-message',sender:42,transfer:2,data:'reply'});
  const value=runInContext('({[jsbb_opaque]:123})',child.context);
  assert.equal(child.send(42,value,3,true),0);n.drain();
  assert.equal(n.nativeTransfers.length,1);
  assert.deepEqual({...n.nativeTransfers[0],value:undefined},{source:42,channel:42,env:4200,transfer:3,value:undefined});
  assert.deepEqual({...n.received.shift().data},{__jsb_type:'transfer',data:0});
  assert(n.progress.some(item=>item[0]==='frame'&&item[1]===41));
  assert(!n.progress.some(item=>item[0]==='frame'&&item[1]===42));
});

test('script workers may own children without confusing child and parent directions',()=>{
  const n=network(),engine=n.realm(41,'engine'),child=n.realm(42,'script-worker',41),grandchild=n.realm(43,'script-worker',42);n.drain();
  child.send(43,'nested',10);n.drain();grandchild.send(43,'nested-reply',11,true);n.drain();child.send(42,'outer-reply',12,true);n.drain();
  assert.deepEqual(n.received.map(({target,kind,sender,data})=>({target,kind,sender,data})),[
    {target:43,kind:'parent-message',sender:42,data:'nested'},
    {target:42,kind:'child-message',sender:43,data:'nested-reply'},
    {target:41,kind:'child-message',sender:42,data:'outer-reply'},
  ]);
});

test('host rejects spoofed senders and unrelated child targets',()=>{
  const n=network(),a=n.realm(41,'engine');n.realm(42,'script-worker',41);const foreign=n.realm(51,'engine');n.drain();
  foreign.send(42,'foreign',1);n.drain();assert.deepEqual(n.received,[]);
  const route={source:41,target:42,channel:42,epoch:a.context._jsbb_._runtime.epoch,direction:'to-child'};
  assert.equal(n.host._jsbb_.relay_worker_message({__jsbMessage:true,version:1,transfer_id:2,data:'spoof',route},n.workers.get(51)),false);
  assert.equal(n.host._jsbb_.relay_worker_message({__jsbMessage:true,version:1,transfer_id:2,data:'spoof',route:{...route,epoch:'stale'}},n.workers.get(41)),false);
  n.drain();assert.deepEqual(n.received,[]);
});

test('message sent before child registration is held until its explicit role is registered',()=>{
  const n=network(),engine=n.realm(41,'engine');n.drain();engine.send(42,'early',7);n.drain();assert.deepEqual(n.received,[]);
  n.realm(42,'script-worker',41);n.drain();assert.equal(n.received[0].data,'early');assert.equal(n.received[0].target,42);
});

test('disposal drops late target-epoch messages and clears pending references',()=>{
  const n=network(),engine=n.realm(41,'engine'),child=n.realm(42,'script-worker',41);n.drain();
  engine.send(42,'late',1);while(n.pending.length)n.pending.shift()();
  const oldEpoch=child.context._jsbb_._runtime.epoch;
  child.context._jsbb_.FreeEngine(0);n.drain();
  assert.equal(child.context._jsbb_._pending_worker_messages.length,0);
  child.context._jsbb_.ConfigureThread(2,42,41);n.drain();
  assert.notEqual(child.context._jsbb_._runtime.epoch,oldEpoch);
  assert.deepEqual(n.received,[]);
});

test('host router installs from the Emscripten library postset without jsbi_init on the page',async()=>{
  const library=await readFile(new URL('../../js/library_godotjs_jsbi.js',import.meta.url),'utf8');
  let methods;const listeners=[];
  const context=createContext({console,LibraryManager:{library:{}},mergeInto(_target,value){methods=value;},autoAddDeps(){},PThread:{pthreads:{7:{pthread_ptr:7,addEventListener(...args){listeners.push(args);}}},getNewWorker(){}}});
  runInContext(source,context);runInContext(library,context);
  runInContext(methods.$GodotJSWorkerRouter__postset,context);
  assert.equal(listeners.length,1);assert.equal(context._jsbb_.engine,undefined);
});


test('unknown roles and impossible parent identity are rejected before registration',()=>{
  const n=network();
  assert.throws(()=>n.host._jsbb_.ConfigureThread(9,1,0),/E_WORKER_ROLE/);
  assert.throws(()=>n.host._jsbb_.ConfigureThread(2,42,42),/E_WORKER_ROLE/);
  assert.throws(()=>n.host._jsbb_.ConfigureThread(2,0,0),/E_WORKER_ROLE/);
});


test('new engine allocation does not dispatch queued messages before handlers are installed',()=>{
  const n=network(),engine=n.realm(41,'engine'),child=n.realm(42,'script-worker',41);n.drain();
  child.context._jsbb_.engine=undefined;
  engine.send(42,'before-initialization',17);
  while(n.pending.length)n.pending.shift()();
  child.context._jsbb_.NewEngine(4200);
  assert.deepEqual(n.received,[]);
  assert.equal(child.context._jsbb_._pending_worker_messages.length,1);
  child.context._jsbb_.FlushPendingWorkerMessages();
  assert.equal(n.received.length,1);assert.equal(n.received[0].transfer,17);
});


test('native error logging reaches the runtime host without becoming a fatal diagnostic',()=>{
  const logs=[],diagnostics=[];
  const context=createContext({console:{...console,error(){}},UTF8ToString:()=> '[JSWorker][Error] callback failed',__godotjsRuntimeHost:{reportLog:(...args)=>logs.push(args),reportDiagnostic:value=>diagnostics.push(value)}});
  runInContext(source,context);context._jsbb_.error(123);
  assert.deepEqual(logs,[['error','[JSWorker][Error] callback failed']]);assert.deepEqual(diagnostics,[]);
});


test('a pooled browser Worker can initialize a fresh pthread after releasing the old engine',()=>{
  const errors=[],packets=[];
  const context=createContext({console:{...console,error:(...args)=>errors.push(args)},ENVIRONMENT_IS_PTHREAD:true,postMessage:packet=>packets.push(packet),addEventListener(){},GodotRuntime:{get_func:()=>()=>{}},UTF8ToString(){},stringToUTF8(){},lengthBytesUTF8(){},_malloc(){},_free(){}});
  runInContext(source,context);
  const options={runtime_role:2,thread_id:42,parent_thread_id:41,debug_build:false,bridge_logging:false};
  context._jsbb_.init(options);context._jsbb_.NewEngine(1);
  const firstEpoch=context._jsbb_._runtime.epoch;
  assert.throws(()=>context._jsbb_.init(options),/E_WORKER_ACTIVE_ENGINE_REINITIALIZATION/);
  context._jsbb_.FreeEngine(0);context._jsbb_.ConfigureThread(2,42,41);
  assert.doesNotThrow(()=>context._jsbb_.init(options));context._jsbb_.NewEngine(2);
  assert.notEqual(context._jsbb_._runtime.epoch,firstEpoch);assert.deepEqual(errors,[]);
  assert(packets.some(packet=>packet.action==='unregister'));
  context._jsbb_.FreeEngine(0);
});


test('native errors are forwarded once through a marked console wrapper and retain fallback after replacement',()=>{
  const logs=[];
  const reportLog=(...args)=>logs.push(args);
  const wrapped=(text)=>reportLog('error',text);
  Object.defineProperty(wrapped,'__godotjsConsoleForwarded',{value:true});
  const scopeConsole={...console,error:wrapped};
  const context=createContext({console:scopeConsole,UTF8ToString:()=> 'native error',__godotjsRuntimeHost:{reportLog}});
  runInContext(source,context);context._jsbb_.error(123);
  assert.deepEqual(logs,[['error','native error']]);
  scopeConsole.error=()=>{};context._jsbb_.error(456);
  assert.deepEqual(logs,[['error','native error'],['error','native error']]);
});
