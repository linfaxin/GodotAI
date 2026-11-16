import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareEngineProject} from '../dist/engine-project.js';
import {createRuntimeBinding} from '@godot-js/engine/runtime';

const prepared=prepareEngineProject({files:{'/start.ts':'export function start(ctx:any){}'},launch:{kind:'script',module:'res://start.ts'}});
const script=[...prepared.files].find(([path,bytes])=>path.endsWith('/engine-bootstrap.js')&&new TextDecoder().decode(bytes).includes('ProjectScriptBootstrap'));
assert(script);
const source=new TextDecoder().decode(script[1]);
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};

function fixture(start,{native=false}={}){
 const events=[],scopes=[];let epochAlive=true;
 const binding={openEntry(){
  const scope={closed:false,host:{sessionId:'current',reportDiagnostic(value){events.push(['diagnostic',value]);return true;}},
   ready(cleanup){events.push(['ready',cleanup]);},close(){scope.closed=true;events.push(['close']);},canCleanup(){return epochAlive;},
   cleanupComplete(){events.push(['complete']);},cleanupUnconfirmed(){events.push(['unconfirmed']);},reportCleanupFailure(value){events.push(['cleanup-error',value]);}};
  scopes.push(scope);events.push(['open']);return scope;
 }};
 const context={exports:{},console:{error:value=>events.push(['console',value])},require(name){
  if(name.endsWith('/native-modules/godot.js'))return {Node:class{}};
  assert(native||scopes.length,'entry scope must be created before the project module is loaded');
  return {start};
 },...(native?{}:{__godotjsRuntimeHost:binding})};
 vm.runInNewContext(source,context);
 return {app:new context.exports.default(),context,events,scopes,seal(){epochAlive=false;}};
}

test('generated script entry captures its own host and keeps native no-host cleanup valid',()=>{
 let host,cleanups=0;
 const f=fixture(ctx=>{host=ctx.host;return()=>cleanups++;});
 f.app._ready();assert.equal(host,f.scopes[0].host);
 f.app._exit_tree();f.app._exit_tree();assert.equal(cleanups,1);assert.equal(f.events.filter(([kind])=>kind==='complete').length,1);
 const native=fixture(ctx=>{assert.equal(ctx.host,undefined);return()=>cleanups++;},{native:true});
 native.app._ready();native.app._exit_tree();native.app._exit_tree();assert.equal(cleanups,2);
});

test('late start rejection cannot read a replacement global host or fault the next entry',async()=>{
 let reject;
 const pending=new Promise((_,failure)=>reject=failure),f=fixture(()=>pending);
 f.app._ready();f.app._exit_tree();
 let replacementCalls=0;f.context.__godotjsRuntimeHost={reportDiagnostic(){replacementCalls++;return true;}};
 reject(Error('old entry'));await flush();
 assert.equal(replacementCalls,0);assert.equal(f.events.some(([kind])=>kind==='diagnostic'),false);
});

test('late cleanup runs once while native epoch is alive and never after its seal',async()=>{
 for(const sealed of [false,true]){
  let resolve,cleanups=0;const pending=new Promise(accept=>resolve=accept),f=fixture(()=>pending);
  f.app._ready();f.app._exit_tree();if(sealed)f.seal();resolve(()=>cleanups++);await flush();
  f.app._exit_tree();assert.equal(cleanups,sealed?0:1);
  assert.equal(f.events.some(([kind])=>kind==='unconfirmed'),sealed);
 }
});

test('cleanup failures use the captured teardown channel after entry business is closed',()=>{
 const f=fixture(()=>()=>{assert(f.scopes[0].closed);throw Error('cleanup failed');});
 f.app._ready();f.app._exit_tree();
 const failure=f.events.find(([kind])=>kind==='cleanup-error');assert(failure);assert.equal(failure[1].message,'cleanup failed');
 assert.equal(f.events.some(([kind])=>kind==='complete'),false);
});

test('async startup failures report once and async cleanup is not reported complete',async()=>{
 let failure;const failed=fixture(()=>Promise.reject(failure));failure=vm.runInNewContext('new Error("startup failed")',failed.context);failed.app._ready();await flush();
 assert.equal(failed.events.filter(([kind])=>kind==='diagnostic').length,1);
 assert.equal(failed.events.find(([kind])=>kind==='diagnostic')[1].message,'startup failed');
 assert.match(failed.events.find(([kind])=>kind==='diagnostic')[1].stack,/startup failed/);
 const f=fixture(()=>()=>Promise.reject(Error('async cleanup failed')));f.app._ready();f.app._exit_tree();await flush();
 assert(f.events.some(([kind])=>kind==='unconfirmed'));assert(f.events.some(([kind])=>kind==='cleanup-error'));
 assert.equal(f.events.some(([kind])=>kind==='complete'),false);
});

test('generated diagnostics preserve intrinsic Error stacks without calling project accessors',async()=>{
 let getters=0;
 const thrown={get message(){getters++;throw Error('message getter');},get stack(){getters++;throw Error('stack getter');}};
 const f=fixture(()=>Promise.reject(thrown));f.app._ready();await flush();
 assert.equal(getters,0);assert.equal(f.events.filter(([kind])=>kind==='diagnostic').length,1);
 assert.equal(f.events.find(([kind])=>kind==='diagnostic')[1].message,'Script entry failed');
});

test('intrinsic stack fallback never evaluates own Error message/name or custom stack accessors',async()=>{
 for(const field of ['message','name','stack']){
  let failure,reads=0;const f=fixture(()=>Promise.reject(failure));
  failure=vm.runInNewContext('new Error("intrinsic-accessor")',f.context);
  const deferredStack=typeof Object.getOwnPropertyDescriptor(failure,'stack')?.get==='function';
  Object.defineProperty(failure,field,{configurable:true,get(){reads++;return 'project accessor';}});
  f.app._ready();await flush();
  assert.equal(reads,0,field+' accessor must not run indirectly through the native stack getter');
  assert.equal(f.events.filter(([kind])=>kind==='diagnostic').length,1);
  const stack=f.events.find(([kind])=>kind==='diagnostic')[1].stack;
  if(deferredStack||field==='stack')assert.equal(stack,undefined);else assert.match(stack,/intrinsic-accessor/);
 }
});

test('actual runtime binding receives generated entry cleanup facts and rejects stale entry traffic',async()=>{
 const events=[],summaries=[];
 const binding=createRuntimeBinding({sessionId:'real-binding',role:'engine',onProject:value=>{events.push(value);return true;},onDiagnostic:()=>true,onSummary:value=>summaries.push(value)});
 binding.beginNativeEpoch('native-epoch');let host,commands=0,cleanups=0;
 const context={exports:{},__godotjsRuntimeHost:binding,console,require:name=>name.endsWith('/native-modules/godot.js')?{Node:class{}}:{start:ctx=>{
  host=ctx.host;host.bindProjectCommand(()=>commands++);host.emitProjectEvent({kind:'started'});return()=>cleanups++;
 }}};
 vm.runInNewContext(source,context);const app=new context.exports.default();app._ready();
 assert.equal(binding.receiveProjectCommand({kind:'command'}),true);await flush();assert.equal(commands,1);assert.equal(events[0].kind,'started');
 app._exit_tree();app._exit_tree();assert.equal(cleanups,1);assert.equal(host.emitProjectEvent({kind:'stale'}),false);
 assert.throws(()=>host.bindProjectCommand(()=>{}),/E_RUNTIME_CLOSING/);
 binding.endNativeEpoch('native-epoch');assert.equal(summaries.length,1);assert.equal(summaries[0].entries[0].cleanup,'complete');
});
