import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {reactBootstrap} from '../dist/core/react-startup.js';

const source=ts.transpileModule(reactBootstrap('res://App.js','default',{}),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
function fixture({shutdownError,accepted=true}={}){
 const events=[];let options,opened=false,scopeClosed=false,epochAlive=true;
 const host={sessionId:'entry',reportDiagnostic(value){events.push(['diagnostic',value]);return accepted;}};
 const scope={host,ready(cleanup){events.push(['ready',cleanup]);},close(){scopeClosed=true;events.push(['close']);},canCleanup(){return epochAlive;},cleanupComplete(){events.push(['complete']);},cleanupUnconfirmed(){events.push(['unconfirmed']);},reportCleanupFailure(value){events.push(['cleanup-error',value]);}};
 const root={render(){},flush(){},shutdown(){assert(scopeClosed);events.push(['shutdown']);if(shutdownError)throw shutdownError;},getStats(){return {state:'disposed',cleanExit:true};}};
 const G={Node:class{},OS:{has_feature(){return false;}}};
 const context={exports:{},console:{error:value=>events.push(['error',value]),warn:value=>events.push(['warn',value])},
  __godotjsRuntimeHost:{openEntry(){opened=true;return scope;}},require(name){
   if(name==='godot')return G;if(name==='godot-jsb')return {internal:{names:{get_member:name=>name,get_class:name=>name}}};
   if(name.endsWith('/react/index.js'))return {isValidElement(){return false;},createElement(component,props){return {component,props};}};
   if(name.endsWith('/@godot-js/react/engine/index.js'))return {createRoot(_mount,value){options=value;return root;}};
   assert.equal(name,'res://App.js');assert(opened,'scope must exist before project module executes');return {default:function App(){}};
  }};
 vm.runInNewContext(source,context);
 return {app:new context.exports.default(),context,events,host,root,get options(){return options;},seal(){epochAlive=false;}};
}

const require=createRequire(import.meta.url);
const EngineReact=require('@godot-js/react/engine');
const React=createRequire(require.resolve('@godot-js/react/engine'))('react');
const nativeFixture=require('../../jsb.react/tests/engine-native-fixture.cjs');
const runtimeSource=ts.transpileModule(readFileSync(new URL('../../../packages/engine/src/runtime-host.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function actualFixture(createApp){
 const native=nativeFixture(),diagnostics=[];let root;
 const App=createApp({React,EngineNode:EngineReact.EngineNode,native,getRoot:()=>root});
 const context={exports:{},console,require(name){
  if(name==='godot')return native.godot;
  if(name==='godot-jsb')return {internal:{names:{get_member:name=>name,get_class:name=>name}}};
  if(name.endsWith('/react/index.js'))return React;
  if(name.endsWith('/@godot-js/react/engine/index.js'))return {createRoot(mount,options){root=native.drive(EngineReact.createRoot(mount,{...options,godot:native.godot}));return root;}};
  assert.equal(name,'res://App.js');return {default:App};
 }};
 // Payload validation and generated diagnostics must share the actual realm.
 vm.runInNewContext(runtimeSource,context);
 const binding=context.exports.createRuntimeBinding({sessionId:'react-entry',role:'engine',onDiagnostic:value=>diagnostics.push(value)});
 binding.beginNativeEpoch('native-epoch');context.__godotjsRuntimeHost=binding;context.exports={};
 vm.runInNewContext(source,context);
 const app=new context.exports.default();native.tree.add_child(app);app._ready();
 return {native,app,binding,diagnostics,get root(){return root;}};
}

test('React bootstrap injects and reports through its captured entry host',async()=>{
 const f=fixture();f.app._ready();assert.equal(f.options.runtimeHost,f.host);
 f.context.__godotjsRuntimeHost={reportDiagnostic(){throw Error('replacement must not be used');}};
 f.options.onError(vm.runInNewContext('new Error("recoverable")',f.context),{kind:'recoverable'});
 assert.equal(f.events.find(([kind])=>kind==='diagnostic')[1].message,'recoverable');
 assert.match(f.events.find(([kind])=>kind==='diagnostic')[1].stack,/recoverable/);
 assert.equal(f.events.some(([kind])=>kind==='close'),false);
 f.app._exit_tree();f.app._exit_tree();await flush();assert.equal(f.events.filter(([kind])=>kind==='shutdown').length,1);
 const diagnostics=f.events.filter(([kind])=>kind==='diagnostic').length;f.options.onError(Error('old root'),{kind:'runtime'});
 assert.equal(f.events.filter(([kind])=>kind==='diagnostic').length,diagnostics);
});

test('React stack fallback does not indirectly execute Error accessors',()=>{
 for(const field of ['message','name','stack']){
  const f=fixture();f.app._ready();let reads=0;
  const failure=vm.runInNewContext('new Error("intrinsic-accessor")',f.context);
  const deferredStack=typeof Object.getOwnPropertyDescriptor(failure,'stack')?.get==='function';
  Object.defineProperty(failure,field,{configurable:true,get(){reads++;return 'project accessor';}});
  f.options.onError(failure,{kind:'caught'});
  assert.equal(reads,0);const stack=f.events.find(([kind])=>kind==='diagnostic')[1].stack;
  if(deferredStack||field==='stack')assert.equal(stack,undefined);else assert.match(stack,/intrinsic-accessor/);
  f.app._exit_tree();
 }
});

test('React cleanup failure survives business revocation and is never marked complete',async()=>{
 const f=fixture({shutdownError:Error('shutdown failed')});f.app._ready();f.app._exit_tree();await flush();
 const failure=f.events.find(([kind])=>kind==='cleanup-error');assert(failure);assert.equal(failure[1].message,'shutdown failed');
 assert.equal(f.events.some(([kind])=>kind==='complete'),false);
});

test('React bootstrap requires strict diagnostic acceptance and does not clean a sealed epoch',async()=>{
 const f=fixture({accepted:undefined});f.app._ready();
 f.host.reportDiagnostic=value=>{f.events.push(['diagnostic',value]);return undefined;};
 f.options.onError(Error('warning'),{kind:'caught'});assert(f.events.some(([kind])=>kind==='warn'));
 f.seal();f.app._exit_tree();await flush();assert(f.events.some(([kind])=>kind==='unconfirmed'));
 assert.equal(f.events.some(([kind])=>kind==='shutdown'),false);
});

test('a later native release checkpoint retains its teardown error reporter',async()=>{
 let releases=0;
 const f=actualFixture(({React,EngineNode,native,getRoot})=>{
  class BrokenLabel extends native.Label {
   queue_free(){assert.equal(getRoot().session.releaseAllowed(),true);releases++;throw Error('deferred native release failed');}
  }
  return ()=>React.createElement(EngineNode,{ctor:BrokenLabel});
 });
 await flush();f.native.setPhysics(true);f.app._exit_tree();await flush();
 assert.equal(releases,0);assert.equal(f.app.closing,true);
 assert.equal(f.binding.snapshotSummary().entries[0].state,'closed');
 assert.equal(f.app.entryScope.canCleanup(),true);
 f.native.setPhysics(false);f.root.pump();await flush();
 assert.equal(releases,1);assert.equal(f.root.getStats().cleanExit,false);
 assert.equal(f.binding.failure?.message,'deferred native release failed');
 assert.equal(f.diagnostics.length,1);
 assert.equal(f.binding.snapshotSummary().entries[0].cleanup,'failed');
 f.binding.endNativeEpoch('native-epoch');
});

test('an actual effect cleanup failure never becomes successful entry cleanup',async()=>{
 const f=actualFixture(({React})=>function App(){React.useEffect(()=>()=>{throw Error('effect cleanup failed');},[]);return null;});
 await flush();f.app._exit_tree();await flush();
 assert.equal(f.root.getStats().state,'disposed');
 assert(f.root.getErrors().some(error=>error.message==='effect cleanup failed'));
 assert.equal(f.binding.failure?.message,'effect cleanup failed');
 assert.equal(f.binding.snapshotSummary().entries[0].cleanup,'failed');
 f.binding.endNativeEpoch('native-epoch');
});

test('completed roots ignore stale callbacks after an initially deferred shutdown',async()=>{
 const f=actualFixture(({React,EngineNode,native})=>()=>React.createElement(EngineNode,{ctor:native.Label}));
 await flush();f.native.setPhysics(true);f.app._exit_tree();await flush();
 assert.equal(f.app.closing,true);
 f.native.setPhysics(false);f.root.pump();await f.native.flushDeletes();
 assert.equal(f.root.getStats().state,'disposed');
 f.root.options.onError(Error('old root business callback'),{kind:'runtime'});
 assert.equal(f.binding.failure,undefined);assert.equal(f.diagnostics.length,0);
 assert.equal(f.app.closing,false);
 f.binding.endNativeEpoch('native-epoch');
});

test('teardown reporting neither inspects native state after seal nor recurses through failed stats',async()=>{
 const sealed=fixture();let inspections=0;
 sealed.root.getStats=()=>{inspections++;return {state:'disposing',cleanExit:true};};
 sealed.app._ready();sealed.app._exit_tree();await flush();
 const beforeSeal=inspections;sealed.seal();
 sealed.options.onError(Error('after seal'),{kind:'runtime'});
 assert.equal(inspections,beforeSeal);assert.equal(sealed.app.closing,false);
 assert.equal(sealed.events.some(([kind])=>kind==='cleanup-error'),false);

 const pending=fixture();pending.root.getStats=()=>({state:'disposing',cleanExit:true});
 pending.app._ready();pending.app._exit_tree();await flush();
 let failedInspections=0;pending.root.getStats=()=>{failedInspections++;throw Error('stats failed');};
 pending.options.onError(Error('native cleanup failed'),{kind:'runtime'});
 assert.equal(failedInspections,1);
 assert.equal(pending.events.find(([kind])=>kind==='cleanup-error')[1].message,'native cleanup failed');
});
