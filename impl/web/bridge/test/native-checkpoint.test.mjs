import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
function fixture(){
 const events=[],diagnostics=[];
 const context=vm.createContext({console:{log(){},warn(){},error(){},trace(){},assert:console.assert},events,diagnostics});
 vm.runInContext(source,context);
 vm.runInContext(`
  let ticket=0;
  this.Module={
   _jsni_native_checkpoint_enter(opaque){events.push(['enter',opaque]);return ++ticket;},
   _jsni_native_checkpoint_leave(opaque,id){events.push(['leave',opaque,id]);}
  };
  globalThis.__godotjsRuntimeHost={reportDiagnostic(value){diagnostics.push(value);}};
  _jsbb_.interop={gc_callback(){}};
  _jsbb_.NewEngine(19);
  this.raw=_jsbb_.engine;this.native=_jsbb_.GetEngine(0);
 `,context);
 return {context,events,diagnostics};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('owner checkpoint starts after native return and never spans an await',async()=>{
 const {context,events}=fixture();
 vm.runInContext(`
  events.push(['initial',_jsbb_.CanDestroyCheckpoint(0)]);
  const cb=raw.stack.Push(()=>{
   events.push(['callback',_jsbb_.CanDestroyCheckpoint(0)]);
   Promise.resolve().then(()=>events.push(['after-await',_jsbb_.CanDestroyCheckpoint(0)]));
  });
  events.push(['accepted',_jsbb_.ScheduleCheckpoint(0,cb)]);
  raw.stack.SetValue(cb,undefined);
  events.push(['native-return',_jsbb_.CanDestroyCheckpoint(0)]);
 `,context);
 assert.deepEqual(events.map(e=>Array.from(e)),[['initial',false],['accepted',true],['native-return',false]]);
 await flush();
 assert.deepEqual(events.map(e=>Array.from(e)),[['initial',false],['accepted',true],['native-return',false],['enter',19],['callback',true],['leave',19,1],['after-await',false]]);
});

test('native callbacks, constructors and getters cannot reuse an active owner ticket',async()=>{
 const {context,events}=fixture();
 vm.runInContext(`
  Module.godotjsScheduleCleanupCheckpoint(()=>{
   const check=()=>events.push(['nested',_jsbb_.CanDestroyCheckpoint(0)]);
   native.Call(0,raw.stack.Push(check),0,0);
   native.CallAsConstructor(raw.stack.Push(function(){check();}),0,0);
   native.GetProperty(raw.stack.Push({get current(){check();return 1;}}),raw.stack.Push('current'));
   events.push(['owner-restored',_jsbb_.CanDestroyCheckpoint(0)]);
  });
 `,context);
 await flush();
 assert.deepEqual(events.map(e=>Array.from(e)),[['enter',19],['nested',false],['nested',false],['nested',false],['owner-restored',true],['leave',19,1]]);
});

test('exceptions release the native ticket before diagnostics and later checkpoints',async()=>{
 const {context,events,diagnostics}=fixture();
 vm.runInContext(`Module.godotjsScheduleCleanupCheckpoint(()=>{throw Error('checkpoint-test');});`,context);
 await flush();
 assert.equal(diagnostics.length,1);assert.match(diagnostics[0].message,/checkpoint-test/);
 assert.equal(vm.runInContext('_jsbb_.CanDestroyCheckpoint(0)',context),false);
 vm.runInContext(`Module.godotjsScheduleCleanupCheckpoint(()=>events.push(['again',_jsbb_.CanDestroyCheckpoint(0)]));`,context);
 await flush();assert.deepEqual(events.map(e=>Array.from(e)),[['enter',19],['leave',19,1],['enter',19],['again',true],['leave',19,2]]);
});

test('logical seal and replacement reject queued callbacks from an older isolate',async()=>{
 const {context,events}=fixture();
 vm.runInContext(`
  Module.godotjsScheduleCleanupCheckpoint(()=>events.push(['old']));
  raw.SealNative();_jsbb_.engine=new jsbb_Engine(0,27);
  _jsbb_.engine.ScheduleCheckpoint(()=>events.push(['new',_jsbb_.CanDestroyCheckpoint(0)]));
 `,context);
 await flush();assert.deepEqual(events.map(e=>Array.from(e)),[['enter',27],['new',true],['leave',27,1]]);
 assert.equal(vm.runInContext('raw.ScheduleCheckpoint(()=>{})',context),false);
});

test('ABI is published only when both actual native exports exist',()=>{
 const {context}=fixture();
 vm.runInContext(`delete Module._jsni_native_checkpoint_enter;`,context);
 assert.equal(vm.runInContext('_jsbb_.engine.ScheduleCheckpoint(()=>{})',context),false);
 const missing=vm.createContext({console:{log(){},warn(){},error(){},trace(){},assert:console.assert},Module:{}});
 vm.runInContext(source,missing);vm.runInContext('_jsbb_.NewEngine(1)',missing);
 assert.equal(missing.Module.godotjsCheckpointAbi,undefined);
});
