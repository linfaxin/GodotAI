import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
function runtime(){
 const memory=new WebAssembly.Memory({initial:1,maximum:4});
 const context=vm.createContext({console,TextEncoder,TextDecoder,wasmMemory:memory});
 context.HEAPU8=new Uint8Array(memory.buffer);context.HEAP8=new Int8Array(memory.buffer);
 context.HEAP32=new Int32Array(memory.buffer);context.HEAPF64=new Float64Array(memory.buffer);
 vm.runInContext(source,context);
 vm.runInContext(`_jsbb_.wasmop={_malloc(size){return 128},_free(){}};globalThis.value='';
 globalThis.engine={_stack:{GetValue(){return value},Push(value){return value}}};`,context);
 return {context,run:code=>vm.runInContext(code,context)};
}
test('runtime scalar primitives do not invoke replaced coercion globals',()=>{
 const {context,run}=runtime();
 run('globalThis.Number=()=>{throw Error("coercion")};globalThis.Boolean=()=>{throw Error("coercion")};globalThis.String=()=>{throw Error("coercion")};');
 context.value=1.5;assert.equal(run('jsbb_Engine.prototype.RuntimeNumberValue.call(engine,0)'),1.5);
 context.value=true;assert.equal(run('jsbb_Engine.prototype.RuntimeBooleanValue.call(engine,0)'),true);
 context.value={valueOf(){throw Error('coercion')}};assert(Number.isNaN(run('jsbb_Engine.prototype.RuntimeNumberValue.call(engine,0)')));
});
test('runtime strings preserve embedded NUL and reject malformed or excessive unicode',()=>{
 const {context,run}=runtime();
 for(const value of ['', 'a\0b','Player 你好','😀', '\ufeffa' + Array.from({length:32},(_,index)=>String.fromCharCode(index)).join('') + 'b 😀𐐷\n']){
  context.value=value;
  const pointer=run('jsbb_Engine.prototype.RuntimeToCStringLen.call(engine,8,0)');
  const length=context.HEAP32[2];assert.equal(length,new TextEncoder().encode(value).length);
  assert.equal(run(`jsbb_Engine.prototype.RuntimeNewString.call(engine,${pointer},${length})`),value);
 }
 for(const value of ['\ud800','\udc00','a\ud800b','x'.repeat(1025),'你'.repeat(342)]){
  context.value=value;assert.equal(run('jsbb_Engine.prototype.RuntimeToCStringLen.call(engine,8,0)'),0);
  assert(context.HEAP32[2]<0);
 }
});
test('runtime call tracks returned and thrown Promises without reading properties and filters only their rejections',()=>{
 const {context,run}=runtime();
 const listeners=[];
 context.addEventListener=(...args)=>listeners.push(args);
 context.console={...console,warn(){}};
 run(`
  globalThis.forwarded=0;
  _jsbb_.interop={unhandled_rejection(){forwarded++}};
  globalThis.callEngine=new jsbb_Engine(0,1);
  globalThis.returned=Promise.resolve(1);
  globalThis.thrown=Promise.resolve(2);
  Object.defineProperties(returned,{
   then:{get(){throw Error('read then')}},
   constructor:{get(){throw Error('read constructor')}}
  });
  const receiver=callEngine.stack.Push({});
  const method=callEngine.stack.Push(()=>returned);
  const throwingMethod=callEngine.stack.Push(()=>{throw thrown});
  callEngine.SetHostPromiseRejectionTracker(1,0);
  globalThis.result=callEngine.stack.GetValue(callEngine.RuntimeCall(receiver,method,0,0));
  globalThis.exceptionStatus=callEngine.RuntimeCall(receiver,throwingMethod,0,0);
 `);
 assert.equal(context.result,context.returned);
 assert.equal(context.exceptionStatus,-1);
 assert(run('_jsbb_.IsRuntimeCallValue(returned)'));
 assert(run('_jsbb_.IsRuntimeCallValue(thrown)'));
 assert(!run('_jsbb_.IsRuntimeCallValue(Promise.resolve(2))'));
 assert.equal(listeners.length,1);
 const [type,listener]=listeners[0];
 assert.equal(type,'unhandledrejection');
 let prevented=0;
 for(const promise of [context.returned,context.thrown]) {
  listener({promise, get reason(){throw Error('read rejected reason')}, preventDefault(){prevented++}});
 }
 assert.equal(prevented,2);
 assert.equal(context.forwarded,0);
 listener({promise:Promise.resolve(2), reason:'unrelated', preventDefault(){prevented++}});
 assert.equal(prevented,2);
 assert.equal(context.forwarded,1);
});
