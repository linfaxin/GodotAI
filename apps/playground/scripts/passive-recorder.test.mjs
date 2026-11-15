import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {installPassiveRecorder,PASSIVE_RECORDER_MAX_BYTES} from './browser-harness.mjs';

class RecorderContext extends EventEmitter{
 page={url:()=> 'http://recorder.test/'};
 async exposeBinding(){throw Error('A passive recorder must never expose a binding');}
 async addInitScript(fn,args){
  this.init=args;
  const context=this;
  this.realm=vm.createContext({TextEncoder,console:{debug(text){context.emit('console',{text:()=>text,page:()=>context.page,location:()=>({url:'http://recorder.test/',lineNumber:0,columnNumber:0})});}}});
  vm.runInContext('('+fn.toString()+')('+JSON.stringify(args)+')',this.realm);
 }
 run(source){return vm.runInContext(source,this.realm);}
}
test('passive recorder sends bounded plain JSON over console metadata with the binding-compatible callback signature',async()=>{
 const context=new RecorderContext(),records=[];
 const control=await installPassiveRecorder(context,'__record',(_source,...args)=>records.push({source:_source,args}));
 const returned=await context.run('__record({kind:"snapshot",text:"中文🎵",missing:undefined},42)');assert.equal(returned,undefined);
 assert.equal(records.length,1);assert.equal(records[0].source.page,context.page);assert.equal(records[0].source.location.url,'http://recorder.test/');assert.deepEqual(records[0].args,[{kind:'snapshot',text:'中文🎵'},42]);
 context.emit('console',{text:()=> 'ordinary console output'});assert.equal(records.length,1);await control.flush();
 await assert.rejects(installPassiveRecorder(context,'__record',()=>{}),/E_PASSIVE_RECORDER_DUPLICATE/);
 context.emit('close');assert.equal(context.listenerCount('console'),0);
});
test('oversize, cyclic, binary and accessor metadata become explicit recorder failures without invoking getters',async()=>{
 for(const source of ['__record("x".repeat('+PASSIVE_RECORDER_MAX_BYTES+'))','(()=>{const value={};value.self=value;return __record(value);})()','__record(new Uint8Array(8))','__record({get unsafe(){globalThis.getterCalled=true;return 1;}})']){
  const context=new RecorderContext(),errors=[],records=[];
  const control=await installPassiveRecorder(context,'__record',(_source,value)=>records.push(value),{onError:error=>errors.push(error)});
  await context.run(source);assert.equal(records.length,0);assert.equal(errors.length,1);assert.equal(context.run('globalThis.getterCalled'),undefined);assert.throws(()=>control.assertHealthy(),/E_PASSIVE_RECORDER/);control.dispose();
 }
});
test('callback failures remain explicit and flush waits for asynchronous Node callbacks without replying to the browser',async()=>{
 const context=new RecorderContext(),errors=[];
 const control=await installPassiveRecorder(context,'__record',async()=>{throw Error('recording failed');},{onError:error=>errors.push(error)});
 assert.equal(await context.run('__record({ok:true})'),undefined);await assert.rejects(control.flush(),/recording failed/);assert.equal(errors.length,1);control.dispose();
});
