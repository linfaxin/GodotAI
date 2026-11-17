import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
function fixture(){
 const packets=[],native=[],attempts=[];
 const context=vm.createContext({structuredClone,ArrayBuffer,SharedArrayBuffer,Uint8Array,Map,Set,console:{log(){},warn(){},error(){},trace(){},assert:console.assert},
  ENVIRONMENT_IS_PTHREAD:true,postMessage:(packet,transfer=[])=>packets.push(structuredClone(packet,{transfer})),addEventListener(){}});
 vm.runInContext(source,context);
 vm.runInContext(`_jsbb_.ConfigureThread(1,41,0);_jsbb_.interop={gc_callback(){}};_jsbb_.NewEngine(19);`,context);
 const opaqueKey=vm.runInContext('jsbb_opaque',context);
 context._jsbb_.interop.worker_get_or_add_native_transfer=(channel,opaque,id,position)=>{const value=context._jsbb_.engine.stack.GetValue(position);attempts.push(value);if(typeof value?.[opaqueKey]!=='number')return -5;native.push({channel,opaque,id,value});return native.length-1;};
 packets.length=0;
 const bridge=context._jsbb_,engine=bridge.engine;
 function prepare(value,id=1){return bridge.PrepareMessage(42,123,engine.stack.Push(value),id,0,false);}
 return {context,packets,native,attempts,bridge,engine,prepare};
}

test('the Environment transfer token is distinct from the current Isolate identity',()=>{
 const f=fixture(),node=vm.runInContext('({[jsbb_opaque]:456})',f.context);
 assert.equal(f.engine.opaque,19);
 const ticket=f.prepare(node);assert(ticket>0);assert.equal(f.native[0].opaque,123);
 assert(f.bridge.PublishMessage(ticket));assert.equal(f.packets[0].data.__jsb_type,'transfer');
});

test('prepare owns a snapshot and cannot publish before native source finalization',()=>{
 const f=fixture(),input=vm.runInContext('({bytes:new Uint8Array([1,2,3]),nested:{value:7}})',f.context);
 let reads=0;Object.defineProperty(input,'getter',{enumerable:true,get(){reads++;return 'snapshot';}});
 const ticket=f.prepare(input);assert(ticket>0);assert.deepEqual(f.packets,[]);
 const staged=f.bridge._prepared_worker_messages.get(ticket).packet;
 const readsAtPrepare=reads;input.bytes[0]=99;input.nested.value=88;
 assert(f.bridge.PublishMessage(ticket));assert.equal(reads,readsAtPrepare,'publish cannot execute sender getters');
 assert.deepEqual(Array.from(f.packets[0].data.bytes),[1,2,3]);assert.equal(f.packets[0].data.nested.value,7);
 assert.equal(input.bytes.buffer.byteLength,3,'source buffer remains owned by the caller');
 assert.equal(staged.data.bytes.buffer.byteLength,0,'publication transfers the staged buffer instead of copying it');
 assert.equal(f.bridge.PublishMessage(ticket),false,'publish consumes its ticket exactly once');
});

test('owned publication deduplicates aliased cyclic collection buffers and preserves shared buffers',()=>{
 const f=fixture();
 const value=vm.runInContext(`(()=>{const buffer=new ArrayBuffer(16),shared=new SharedArrayBuffer(8),value={buffer,view:new Uint8Array(buffer),shared:new Uint8Array(shared)};value.self=value;value.map=new Map([[buffer,value.view]]);value.set=new Set([value.view,buffer]);return value;})()`,f.context);
 const ticket=f.prepare(value),staged=f.bridge._prepared_worker_messages.get(ticket);
 assert.equal(staged.buffers.length,1);assert(f.bridge.PublishMessage(ticket));
 assert.equal(value.buffer.byteLength,16);assert.equal(staged.packet.data.buffer.byteLength,0);
 const received=f.packets[0].data;assert.equal(received.self,received);assert.equal(received.buffer,received.view.buffer);
 assert.equal(received.map.get(received.buffer),received.view);assert(received.set.has(received.buffer));
 value.shared[0]=9;assert.equal(received.shared[0],9);
});

test('clone rejection retains the original DataCloneError before native transfer-out',()=>{
 const f=fixture();
 const value=vm.runInContext('({node:{[jsbb_opaque]:456},uncloneable(){}})',f.context);
 const ticket=f.prepare(value);
 assert.equal(ticket,0);assert.equal(f.native.length,1,'native transfer receipt may be prepared without source finalization');
 assert(!f.attempts.some(value=>typeof value==='function'),'clone rejection must not attempt native conversion of a JS function');
 assert.equal(f.engine.stack.GetValue(7).name,'DataCloneError');assert.deepEqual(f.packets,[]);
 assert.equal(f.bridge._prepared_worker_messages.size,0);
});

test('discard and epoch seal release staged packets and reject replay',()=>{
 const f=fixture(),first=f.prepare({buffer:new ArrayBuffer(1024)}),second=f.prepare('second',2);
 assert.equal(f.bridge._prepared_worker_messages.size,2);
 f.bridge.DiscardMessage(first);f.bridge.DiscardMessage(first);assert.equal(f.bridge.PublishMessage(first),false);
 f.bridge.SealNativeEpoch(0);assert.equal(f.bridge._prepared_worker_messages.size,0);assert.equal(f.bridge.PublishMessage(second),false);
 assert.equal(f.packets.filter(p=>p.__jsbMessage).length,0);
});

test('reentrant epoch closure during clone cannot leave an admitted staged packet',()=>{
 const f=fixture();const value={};
 Object.defineProperty(value,'close',{enumerable:true,get(){f.bridge.SealNativeEpoch(0);return 1;}});
 assert.equal(f.prepare(value),0);assert.equal(f.bridge._prepared_worker_messages.size,0);
 assert.equal(f.packets.filter(p=>p.__jsbMessage).length,0);
});

test('staged ticket exhaustion never reuses an older packet identity',()=>{
 const f=fixture();f.bridge._next_prepared_worker_message=0xffffffff;
 const ticket=f.prepare('last');assert.equal(ticket,0xffffffff);assert.equal(f.prepare('overflow',2),0);
 assert.match(String(f.engine.stack.GetValue(7)),/TICKET_EXHAUSTED/);
 assert(f.bridge.PublishMessage(ticket));assert.equal(f.bridge.PublishMessage(ticket),false);
});
