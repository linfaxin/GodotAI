import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installWasmMemoryObserver,editorObservation} from './browser-engine-performance.mjs';

// A real valid module exporting one memory, min=1/max=2 pages, no imports.
const binary=Uint8Array.from([0,97,115,109,1,0,0,0,5,4,1,1,1,2,7,10,1,6,109,101,109,111,114,121,2,0]);
assert(WebAssembly.validate(binary));
function fixture({weakRefs=true}={}){
 const context=vm.createContext({bytes:binary.slice(),Response,performance});
 if(!weakRefs)context.WeakRef=undefined;
 const native=vm.runInContext('({instantiate:WebAssembly.instantiate,instantiateStreaming:WebAssembly.instantiateStreaming,Instance:WebAssembly.Instance,Module:WebAssembly.Module,Memory:WebAssembly.Memory,Promise})',context);
 vm.runInContext('('+installWasmMemoryObserver.toString()+')()',context);
 return{context,native,run:source=>vm.runInContext(source,context),snapshot:()=>JSON.parse(JSON.stringify(vm.runInContext('__enginePerformanceWasmMemoryObserver.snapshot()',context)))};
}

test('WASM memory observer preserves real bytes/Module instantiation and tracks actual grow capacity',async()=>{
 const f=fixture(),before=[...f.context.bytes];
 const bytesPromise=f.run('WebAssembly.instantiate(bytes,{})');assert(bytesPromise instanceof f.native.Promise);
 const pair=await bytesPromise;assert(pair.module instanceof f.native.Module);assert(pair.instance instanceof f.native.Instance);assert(pair.instance.exports.memory instanceof f.native.Memory);
 let observed=f.snapshot();assert.equal(observed.observedInstances,1);assert.equal(observed.memories[0].initialCapacityBytes,65536);assert.equal(observed.wasmMemoryCapacityPeakBytes,65536);assert.deepEqual(observed.memories[0].exportNames,['memory']);
 assert.equal(pair.instance.exports.memory.grow(1),1);
 observed=f.snapshot();assert.equal(observed.memories[0].currentCapacityBytes,131072);assert.equal(observed.memories[0].capacityPeakBytes,131072);
 f.context.compiled=pair.module;
 const instance=await f.run('WebAssembly.instantiate.call({receiver:"forwarded"},compiled,{})');assert(instance instanceof f.native.Instance);
 observed=f.snapshot();assert.equal(observed.observedInstances,2);assert.equal(observed.observedMemories,2);assert.equal(observed.currentCapacityBytes,196608);assert.equal(observed.wasmMemoryCapacityPeakBytes,196608);
 assert.deepEqual([...f.context.bytes],before);assert.deepEqual(observed.errors,[]);
 // Snapshots contain only scalar metadata; actual instances/memories are never exported.
 assert(observed.memories.every(memory=>!Object.hasOwn(memory,'reference')&&!Object.hasOwn(memory,'instance')));
 f.run('__enginePerformanceWasmMemoryObserver.restore()');assert.equal(f.run('WebAssembly.instantiate'),f.native.instantiate);
});

test('streaming observation returns a real native instance and leaves input bytes intact',async()=>{
 const f=fixture(),before=[...f.context.bytes];
 const pair=await f.run('WebAssembly.instantiateStreaming(Promise.resolve(new Response(bytes,{headers:{"content-type":"application/wasm"}})),{})');
 assert(pair.instance instanceof f.native.Instance);assert(pair.instance.exports.memory instanceof f.native.Memory);assert.equal(pair.instance.exports.memory.buffer.byteLength,65536);
 const observed=f.snapshot();assert(observed.installedMethods.includes('instantiateStreaming'));assert.equal(observed.observedInstances,1);assert.equal(observed.memories[0].capacityPeakBytes,65536);assert.deepEqual(observed.errors,[]);assert.deepEqual([...f.context.bytes],before);
});

test('native compile rejection, streaming rejection identity and non-constructibility remain observable',async()=>{
 const f=fixture();let expected;
 try{await Reflect.apply(f.native.instantiate,undefined,[Uint8Array.from([0,1])]);}catch(error){expected=error;}
 await assert.rejects(f.run('WebAssembly.instantiate(new Uint8Array([0,1]))'),error=>error.name===expected.name&&error.message===expected.message);
 f.context.sentinel=new Error('original streaming rejection');
 await assert.rejects(f.run('WebAssembly.instantiateStreaming(Promise.reject(sentinel),{})'),error=>error===f.context.sentinel);
 assert.throws(()=>f.run('new WebAssembly.instantiate(bytes)'),error=>error.name==='TypeError');
 assert.equal(f.run('WebAssembly.instantiate.name'),f.native.instantiate.name);assert.equal(f.run('WebAssembly.instantiate.length'),f.native.instantiate.length);
 assert.equal(f.snapshot().observedMemories,0);assert.deepEqual(f.snapshot().errors,[]);
});

test('without WeakRef the observer leaves native instantiation untouched and reports no capacity',()=>{
 const f=fixture({weakRefs:false}),observed=f.snapshot();assert.equal(f.run('WebAssembly.instantiate'),f.native.instantiate);assert.equal(observed.weakRefsSupported,false);assert.deepEqual(observed.installedMethods,[]);assert.equal(observed.wasmMemoryCapacityPeakBytes,null);
});


test('observer uses a real imported/exported Memory without changing imports or memory contents',async()=>{
 const imported=Uint8Array.from([0,97,115,109,1,0,0,0,2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,1,1,2,7,10,1,6,109,101,109,111,114,121,2,0]);assert(WebAssembly.validate(imported));
 const f=fixture();f.context.importedBytes=imported;f.run('globalThis.memory=new WebAssembly.Memory({initial:1,maximum:2});new Uint8Array(memory.buffer).set([7,8,9]);globalThis.imports={env:{memory}}');
 const pair=await f.run('WebAssembly.instantiate(importedBytes,imports)');assert.equal(pair.instance.exports.memory,f.context.memory);assert.equal(f.context.imports.env.memory,f.context.memory);assert.deepEqual([...new Uint8Array(f.context.memory.buffer,0,3)],[7,8,9]);assert.equal(f.snapshot().wasmMemoryCapacityPeakBytes,65536);
});


test('a genuinely observed zero-page Memory reports zero rather than unavailable',async()=>{
 const f=fixture(),zero=binary.slice();zero[12]=0;zero[13]=1;assert(WebAssembly.validate(zero));f.context.zero=zero;
 const result=await f.run('WebAssembly.instantiate(zero)');assert.equal(result.instance.exports.memory.buffer.byteLength,0);const observed=f.snapshot();assert.equal(observed.observedMemories,1);assert.equal(observed.wasmMemoryCapacityPeakBytes,0);assert.equal(observed.memories[0].capacityPeakBytes,0);
});

test('performance observer rejects unexpected exit after running and preserves phase evidence',()=>{
 let tick,clock=0;
 const state={project:{demoId:'shader'},ready:true,engine:{state:'running'},events:[]};
 const context=vm.createContext({performance:{now:()=>++clock},setInterval:callback=>{tick=callback;},state});
 vm.runInContext('globalThis.window=globalThis;window.top=window;globalThis.__playgroundWorkbench={inspect:()=>state}',context);
 vm.runInContext('('+editorObservation.toString()+')({demoId:"shader",settleMs:1000})',context);
 tick();assert.equal(context.__enginePerformanceObservation.error,null);
 state.engine.state='exited';tick();
 assert.equal(context.__enginePerformanceObservation.error.kind,'unexpected-exit');
 assert.deepEqual(Array.from(context.__enginePerformanceObservation.phases,entry=>entry.state),['running','exited']);
});

test('performance observer accepts an intentional stop after the measurement window',()=>{
 let tick,clock=0;
 const state={project:{demoId:'shader'},ready:true,engine:{state:'running'},events:[]};
 const context=vm.createContext({performance:{now:()=>++clock},setInterval:callback=>{tick=callback;},state});
 vm.runInContext('globalThis.window=globalThis;window.top=window;globalThis.__playgroundWorkbench={inspect:()=>state}',context);
 vm.runInContext('('+editorObservation.toString()+')({demoId:"shader",settleMs:1000})',context);
 tick();context.__enginePerformanceObservation.shutdownRequested=true;
 state.engine.state='exited';tick();
 assert.equal(context.__enginePerformanceObservation.error,null);
 assert.deepEqual(Array.from(context.__enginePerformanceObservation.phases,entry=>entry.state),['running','exited']);
});
