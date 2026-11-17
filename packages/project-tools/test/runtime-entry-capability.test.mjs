import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareEngineProject} from '../dist/engine-project.js';

const prepared=prepareEngineProject({files:{'/start.ts':'export function start(ctx:any){}'},launch:{kind:'script',module:'res://start.ts'}});
const generated=[...prepared.files].find(([path,bytes])=>path.endsWith('/engine-bootstrap.js')&&new TextDecoder().decode(bytes).includes('ProjectScriptBootstrap'));
const source=new TextDecoder().decode(generated[1]);
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('native script bootstrap installs the shared runtime and passes its actual local entry capability',async()=>{
 let handlers,registrations=0,contextValue,cleanups=0;
 const native={abi:1,lifecycleAbi:1,worldId:'world-1',environmentId:'env-1',setCleanupHandlers(...callbacks){assert.equal(registrations++,0);handlers=callbacks;}};
 const context={exports:{},console,require(name){
  if(name.endsWith('/native-modules/godot.js'))return {Node:class{}};
  if(name.endsWith('/native-modules/godot-jsb.js')||name==='godot-jsb')return {internal:{native_runtime:native}};
  return {start(ctx){contextValue=ctx;ctx.entry.assertActive(ctx.host);ctx.lifetime.defer(async()=>{await Promise.resolve();cleanups++;});}};
 }};
 vm.runInNewContext(source,context);const first=new context.exports.default();first._ready();
 assert(contextValue.entry);assert.equal(contextValue.entry.host,contextValue.host);
 const binding=context.__godotjsRuntimeHost;assert.equal(binding.isEntryCapability(contextValue.entry,contextValue.host),true);
 assert.equal(binding.snapshotSummary().epoch,'native:env-1');
 const second=new context.exports.default();second._ready();assert.equal(registrations,1,'One native driver owns every entry in this environment');
 handlers[0]();assert.equal(contextValue.lifetime.cancelled,true);handlers[1]();await flush();
 assert.equal(cleanups,2);assert.equal(handlers[1]().status,'complete');
 handlers[2]();assert.equal(binding.snapshotSummary().sealed,true);assert.equal(binding.isEntryCapability(contextValue.entry),false);
});

test('native bootstrap installs an entry on every native VM and rolls back failed driver installation',()=>{
 for(const lifecycleAbi of [undefined,0,1]){
  let calls=0,entry;
  const context={exports:{},console,require(name){
   if(name.endsWith('/native-modules/godot.js'))return {Node:class{}};
   if(name.endsWith('/native-modules/godot-jsb.js')||name==='godot-jsb')return {internal:{native_runtime:{abi:1,lifecycleAbi,worldId:'w',environmentId:'e',setCleanupHandlers(){calls++;throw Error('driver registration failed');}}}};
   return {start(ctx){entry=ctx.entry;}};
  }};
  vm.runInNewContext(source,context);const app=new context.exports.default();
  assert.throws(()=>app._ready(),/driver registration failed/);
  assert.equal(calls,1);assert.equal(context.__godotjsRuntimeHost,undefined);assert.equal(entry,undefined);
 }
});
