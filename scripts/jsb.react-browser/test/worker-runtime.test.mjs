import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {factsFromRuntimeSummary,sessionExitReason} from '@godot-js/engine/session-facts';

// Execute the actual runtime/heartbeat with a deliberately slow native init.
// Only browser I/O and the native loader are replaced; no timer races or GPU.
const directory=fileURLToPath(new URL('../',import.meta.url));
const replacements={
 'verified-loader.js':`export async function loadVerifiedWorkerEngine(release,options){globalThis.__engineOptions=options;return {Engine:globalThis.__Engine,basePath:'engine',dispose(){}};}`,
 'worker-presentation.js':`export function createWorkerPresentation(options){let epoch=options.geometry.epoch;return {dispose(){},resize(value){epoch=Math.max(epoch,value.epoch);},ack(){globalThis.__presentationAcks=(globalThis.__presentationAcks??0)+1;},checkpoint(){return {geometryEpoch:epoch,outstanding:null};},setVisible(value){(globalThis.__visibility??=[]).push(value);},stats(){return {};}};}export function installPresentationHooks(){}`,
 'worker-dom.js':`export function createWorkerDom(options){globalThis.__domOptions=options;return {window:{},dispose(){},revokeInput(){},resize(){},applyHostState(){}};}`,
 'worker-audio.js':`export function createWorkerAudioBridge(){return {revoke(){globalThis.__audioRevoked=true;},beginDrain(){globalThis.__audioDraining=true;}};}`,
 'worker-xr.js':`export function createWorkerXRBridge(){return {active:false,dispose(){},snapshot(){return {};}};}`,
 'worker-browser.js':`export function installWorkerBrowserBridge(){return {dispose(){}};}`,
};
const code=(await build({stdin:{contents:'export {installWorkerRuntime} from "../../packages/engine/src/browser/dedicated/worker-runtime.ts";export {prepareWorkerRunConfiguration} from "../../packages/engine/src/browser/dedicated/worker-protocol.ts";export {isProjectData} from "../../packages/engine/src/browser/protocol.ts";',resolveDir:directory},bundle:true,write:false,format:'iife',globalName:'RuntimeUnderTest',platform:'browser',target:'es2022',plugins:[{name:'native-io',setup(builder){
 builder.onResolve({filter:/(verified-loader|worker-presentation|worker-dom|worker-audio|worker-xr|worker-browser)\.js$/},args=>({path:args.path.split('/').at(-1),namespace:'runtime-test'}));
 builder.onLoad({filter:/.*/,namespace:'runtime-test'},args=>({contents:replacements[args.path],loader:'js'}));
}}]})).outputFiles[0].text;
const flush=async()=>{for(let index=0;index<24;index++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};

for(const {name,budgets,texts,expected}of [
 {name:'higher configured count and byte limits',budgets:{maxLogMessages:1500,maxLogBytes:1000000},texts:Array(1501).fill('x'.repeat(256)),expected:Array(1500).fill('x'.repeat(256))},
 {name:'multibyte UTF-8 payloads',budgets:{maxLogMessages:100,maxLogBytes:6},texts:['汉汉','汉汉','汉汉'],expected:['汉汉']},
 {name:'rejected-log credit',budgets:{maxLogMessages:2,maxLogBytes:6},texts:['汉汉汉','汉','abc','x'],expected:['汉','abc']},
 {name:'zero configured count',budgets:{maxLogMessages:0,maxLogBytes:100},texts:['hidden'],expected:[]},
 {name:'zero configured bytes',budgets:{maxLogMessages:10,maxLogBytes:0},texts:['hidden'],expected:[]},
])test('Worker log forwarding honors '+name,async()=>{
 let resolveInit,engine;const initializing=new Promise(resolve=>resolveInit=resolve),listeners=new Map(),originalLogs=[];
 class Port{sent=[];onmessage=null;postMessage(value){this.sent.push(value);}start(){}}
 class Scope{addEventListener(type,fn){listeners.set(type,fn);}removeEventListener(type){listeners.delete(type);}}
 class Engine{constructor(){engine=this;this.config={getModuleConfig(){return {};}};}async preloadFile(){}init(){this.rtenv=this.config.getModuleConfig();return initializing;}requestQuit(){} }
 const scope=new Scope();scope.WorkerGlobalScope=Scope;
 const context=vm.createContext({console:{log:(...args)=>originalLogs.push(args),warn(){},error(){}},crypto,MessagePort:Port,ArrayBuffer,Uint8Array,TextEncoder,AbortController,DOMException,queueMicrotask,setInterval(){return 1;},clearInterval(){},__Engine:Engine});
 vm.runInContext(code,context);
 const prepared=await context.RuntimeUnderTest.prepareWorkerRunConfiguration(vm.runInContext('('+JSON.stringify({budgets})+')',context));
 const control=new Port(),data=new Port(),boot=Object.assign(vm.runInContext('({})',context),{protocolVersion:2,type:'worker-connect',runId:'log-test',revision:1,generation:1,buildKey:'pack',documentId:'doc',workerId:'worker',runConfigurationHash:prepared.hash,
  configuration:prepared.configuration,release:{runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}},pack:new Uint8Array([1]),canvas:{},geometry:{width:1,height:1,dpr:1,epoch:0},controlPort:control,dataPort:data});
 const uninstall=context.RuntimeUnderTest.installWorkerRuntime(scope);
 try{
  listeners.get('message')({data:boot});const deadline=Date.now()+2000;
  while(!engine?.rtenv){assert(Date.now()<deadline,JSON.stringify(control.sent));await flush();}
  context.texts=texts;vm.runInContext('for(const text of texts)console.log(text)',context);
  assert.deepEqual(control.sent.filter(m=>m.type==='log').map(m=>m.text),expected);assert.equal(originalLogs.length,texts.length,'local console remains independent');
  assert.equal(control.sent.some(m=>m.type==='worker-fatal'),false);
 }finally{control.onmessage?.({data:Object.assign(vm.runInContext('({})',context),boot,{type:'stop'})});resolveInit();await flush();uninstall();}
});

test('slow native initialization cannot make heartbeat memory observation terminate the Worker',async()=>{
 let resolveInit,engine,heap,reads=0;
 const initializing=new Promise(resolve=>{resolveInit=resolve;});
 const timers=[],listeners=new Map();
 class Port{sent=[];onmessage=null;postMessage(value){this.sent.push(value);}start(){}}
 class Scope{addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);}removeEventListener(type,callback){listeners.get(type)?.delete(callback);}close(){}}
 const scope=new Scope();scope.WorkerGlobalScope=Scope;
 scope._jsbb_={get u8(){reads++;if(!heap)throw Error('wasmMemory is undefined');return heap;}};
 scope.performance={get memory(){throw Error('Optional browser heap counter unavailable');}};
 class Engine{
  constructor(){engine=this;this.config={getModuleConfig(){return {};}};}
  async preloadFile(){}
  init(){this.rtenv=this.config.getModuleConfig();return initializing;}
  async start(){}
  requestQuit(){}
 }
 const context=vm.createContext({console:{log(){},warn(){},error(){}},crypto,MessagePort:Port,ArrayBuffer,Uint8Array,TextEncoder,AbortController,DOMException,queueMicrotask,
  setInterval(callback){timers.push(callback);return timers.length;},clearInterval(){},__Engine:Engine});
 vm.runInContext(code,context);
 const configuration=(await context.RuntimeUnderTest.prepareWorkerRunConfiguration(vm.runInContext('({})',context)));
 const control=new Port(),data=new Port();
 const boot=Object.assign(vm.runInContext('({})',context),{protocolVersion:2,type:'worker-connect',documentUrl:'https://preview.test/app/preview.html',runId:'slow-init',revision:1,buildKey:'pack',generation:1,documentId:'doc',workerId:'worker',runConfigurationHash:configuration.hash,
  configuration:configuration.configuration,release:{runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}},pack:new Uint8Array([1]),canvas:{},geometry:{width:1,height:1,left:0,top:0,dpr:1,epoch:0},controlPort:control,dataPort:data});
 const uninstall=context.RuntimeUnderTest.installWorkerRuntime(scope);
 try{
  for(const callback of listeners.get('message'))callback({data:boot});
  const deadline=Date.now()+2000;while(!engine?.rtenv){assert(Date.now()<deadline,JSON.stringify(control.sent));await flush();}
  assert.equal(context.__engineOptions.baseUrl,boot.documentUrl);assert.equal(context.__domOptions.baseUrl,boot.documentUrl);
  const heartbeat=()=>{timers[0]();return control.sent.filter(message=>message.type==='worker-heartbeat').at(-1);};
  for(let index=0;index<2;index++){
   const observed=heartbeat();assert.equal(observed.memory.wasmMemoryCapacityBytes,null);
   assert.equal(observed.memory.memoryBufferKind,'unavailable');assert.equal(observed.memory.jsHeapUsedBytes,null);
  }
  assert.equal(reads,2);assert.equal(control.sent.some(message=>message.type==='worker-fatal'),false);
  heap=new Uint8Array(64);assert.equal(heartbeat().memory.wasmMemoryCapacityBytes,64);
  const before=reads;engine.rtenv.HEAPU8=new Uint8Array(128);
  assert.equal(heartbeat().memory.wasmMemoryCapacityBytes,128);assert.equal(reads,before,'the ready Module heap must avoid the early JSBB getter');
  engine.rtenv.HEAPU8=new Uint8Array(256);assert.equal(heartbeat().memory.wasmMemoryCapacityPeakBytes,256);
  engine.rtenv.HEAPU8=new Uint8Array(32);const smaller=heartbeat();
  assert.equal(smaller.memory.wasmMemoryCapacityBytes,32);assert.equal(smaller.memory.wasmMemoryCapacityPeakBytes,256);
  resolveInit();await flush();assert(control.sent.some(message=>message.type==='phase'&&message.phase==='running'));
  assert.equal(control.sent.some(message=>message.type==='worker-fatal'),false);
  const consumed=[];scope.__godotjsSetProjectCommand(raw=>{assert.equal(control.sent.filter(m=>m.type==='project-command-receipt').length,0);consumed.push(JSON.parse(raw));});
  const command=Object.assign(vm.runInContext('({})',context),boot,{type:'project-command',commandSequence:1,data:vm.runInContext('({type:"native-command",value:7})',context)});
  control.onmessage({data:command});await flush();assert.deepEqual(consumed,[{type:'native-command',value:7}]);assert.equal(control.sent.filter(m=>m.type==='project-command-receipt').length,1);
  control.onmessage({data:command});assert.equal(consumed.length,1);assert.equal(control.sent.filter(m=>m.type==='project-command-receipt').length,1,'duplicate sequence never re-enters the consumer');
  const input=fields=>data.onmessage({data:Object.assign(vm.runInContext('({})',context),boot,fields)});
  input({type:'geometry',dataSequence:7,geometry:{width:2,height:1,dpr:1,epoch:1}});
  const geometryReceipt=data.sent.find(m=>m.type==='data-receipt'&&m.dataSequence===7);assert.equal(geometryReceipt.presentationCheckpoint.geometryEpoch,1);assert.equal(geometryReceipt.presentationCheckpoint.outstanding,null);
  input({type:'present-ack',dataSequence:8,runId:boot.runId,frameId:1,resizeEpoch:0});assert.equal(context.__presentationAcks,1);assert.equal(data.sent.find(m=>m.type==='data-receipt'&&m.dataSequence===8).presentationCheckpoint.geometryEpoch,1);
 }finally{
  control.onmessage?.({data:Object.assign(vm.runInContext('({})',context),boot,{type:'stop'})});resolveInit();await flush();uninstall();
 }
});

async function hostRuntimeFixture({onStart,onQuit,managed=false,waitPhase='running',allowFatal=false}={}){
 const listeners=new Map(),consoleErrors=[],events=[],tasks=[];
 class Port{sent=[];onmessage=null;postMessage(value){this.sent.push(value);}start(){}}
 class Scope{
  addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);}
  removeEventListener(name,callback){listeners.get(name)?.delete(callback);}
  close(){this.closed=true;}
 }
 const scope=new Scope();scope.WorkerGlobalScope=Scope;let engine;
 class Engine{
  constructor(options){engine=this;this.options=options;this.config={getModuleConfig(){return {HEAPU8:new Uint8Array(64)};}};}
  async preloadFile(){}
  async init(){this.rtenv=this.config.getModuleConfig();scope.__godotjsRuntimeHost.beginNativeEpoch('test-native-epoch');if(managed){this.rtenv.godotjsLifecycleVersion=1;this.rtenv._godotjs_release_exit=()=>events.push('release');this.rtenv.godotjsReleaseExit=this.rtenv._godotjs_release_exit;scope.__godotjsInstallLifecycle(this.rtenv);}}
  async start(){await onStart?.(scope,this,clone);}
  requestQuit(){events.push('quit');if(onQuit)return onQuit(scope,this);scope.__godotjsRuntimeHost.endNativeEpoch('test-native-epoch');this.options.onExit(0);}
 }
 const context=vm.createContext({console:{log(){},warn(){},error:value=>consoleErrors.push(String(value))},crypto,MessagePort:Port,ArrayBuffer,Uint8Array,TextEncoder,AbortController,DOMException,queueMicrotask,
  setInterval(callback){tasks.push(callback);return tasks.length;},clearInterval(){},__Engine:Engine});
 vm.runInContext(code,context);const clone=value=>vm.runInContext('('+JSON.stringify(value)+')',context);
 const prepared=await context.RuntimeUnderTest.prepareWorkerRunConfiguration(clone({}));
 const control=new Port(),data=new Port();
 const boot=Object.assign(clone({}),{protocolVersion:2,type:'worker-connect',runId:'host-runtime',revision:1,buildKey:'pack',generation:1,documentId:'doc',workerId:'worker',runConfigurationHash:prepared.hash,
  configuration:prepared.configuration,release:{runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1,...(managed?{lifecycle:1}:{})}},pack:new Uint8Array([1]),canvas:{},geometry:{width:1,height:1,dpr:1,epoch:0},controlPort:control,dataPort:data});
 const uninstall=context.RuntimeUnderTest.installWorkerRuntime(scope);
 const connect=[...listeners.get('message')][0];connect({data:boot});
 const deadline=Date.now()+2000;while(!control.sent.some(m=>m.type==='worker-fatal'||(m.type==='phase'&&m.phase===waitPhase))){assert(Date.now()<deadline,JSON.stringify(control.sent));await flush();}
 if(!allowFatal)assert.equal(control.sent.some(m=>m.type==='worker-fatal'),false,JSON.stringify(control.sent));
 assert(scope.__godotjsRuntimeHost,JSON.stringify({messages:control.sent,events,keys:Object.keys(scope)}));
 return {scope,context,control,data,clone,events,consoleErrors,get engine(){return engine;},
  heartbeat(){tasks[0]();return control.sent.filter(message=>message.type==='worker-heartbeat').at(-1);},
  event(name,value){for(const listener of [...listeners.get(name)??[]])listener(value);},
  command(sequence,value){control.onmessage({data:Object.assign(clone({}),boot,{type:'project-command',commandSequence:sequence,data:clone(value)})});},
  input(fields){data.onmessage({data:Object.assign(clone({}),boot,fields)});},
  stop(){control.onmessage?.({data:Object.assign(clone({}),boot,{type:'stop'})});},
  async cleanup(){if(!scope.closed)control.onmessage?.({data:Object.assign(clone({}),boot,{type:'stop'})});await flush();uninstall();}};
}

test('default Worker installs a scoped RuntimeHost before the first project statement and drains queued commands once',async()=>{
 let entry,received=[];
 const f=await hostRuntimeFixture({onStart(scope){
  assert.equal(scope.__godotjsRuntimeHost.apiVersion,1);entry=scope.__godotjsRuntimeHost.openEntry();entry.ready();
 }});
 try{
  f.command(1,{value:1});await flush();assert.equal(f.control.sent.filter(m=>m.type==='project-command-receipt').length,0,'queued input is not consumed before a handler exists');
  entry.host.bindProjectCommand(value=>received.push(value.value));assert.deepEqual(received,[],'registration never re-enters a native callback');
  await flush();assert.deepEqual(received,[1]);assert.equal(f.control.sent.filter(m=>m.type==='project-command-receipt').length,1);
  f.command(1,{value:99});await flush();assert.deepEqual(received,[1]);
  assert.equal(entry.host.emitProjectEvent(f.clone({type:'host-roundtrip'})),true);assert(f.control.sent.some(m=>m.type==='project'&&m.data.type==='host-roundtrip'));
  entry.close();entry.cleanupComplete();
 }finally{await f.cleanup();}
});

test('a fatal is latched before a synchronous native zero and survives the terminal summary',async()=>{
 const f=await hostRuntimeFixture();
 try{
  const host=f.scope.__godotjsRuntimeHost;
  assert.equal(host.reportDiagnostic(f.clone({kind:'runtime',message:'fatal-on-native-stack'})),true);
  assert.equal(host.failure.message,'fatal-on-native-stack');assert.equal(f.events.length,0,'requestQuit must wait for the safe checkpoint');
  f.engine.requestQuit();await flush();
  const terminal=f.control.sent.find(m=>m.type==='native-exit');assert.equal(terminal.code,0);assert.equal(terminal.runtimeSummary.failure.message,'fatal-on-native-stack');
  assert.equal(f.control.sent.filter(m=>m.type==='worker-fatal').length,1);assert.equal(f.events.length,1,'deferred quit cannot re-enter an already-exited engine');
 }finally{await f.cleanup();}
});

test('ordinary native error output is forwarded once and remains nonfatal after host installation',async()=>{
 const f=await hostRuntimeFixture();try{
  vm.runInContext('console.error("native error text")',f.context);
  assert.equal(f.control.sent.filter(m=>m.type==='log'&&m.text==='native error text').length,1);
  assert.equal(vm.runInContext('console.error.__godotjsConsoleForwarded',f.context),true);
  assert.equal(f.control.sent.some(m=>m.type==='worker-fatal'),false);
 }finally{await f.cleanup();}
});

test('Worker project admission uses the owned serialization without invoking project toJSON accessors',async()=>{
 const f=await hostRuntimeFixture();try{
  vm.runInContext('globalThis.serializerReads=0;Object.defineProperty(Object.prototype,"toJSON",{configurable:true,get(){serializerReads++;throw Error("project serializer ran");}})',f.context);
  const value=f.clone({type:'safe-owned-event',items:['汉',1]});
  assert.equal(f.scope.__godotjsRuntimeHost.emitProjectEvent(value),true);
  assert.equal(vm.runInContext('serializerReads',f.context),0);
  assert(f.control.sent.some(message=>message.type==='project'&&message.data.type==='safe-owned-event'));
 }finally{vm.runInContext('delete Object.prototype.toJSON',f.context);await f.cleanup();}
});

test('large array events remain consumable and their receipts restore all project credits',async()=>{
 const f=await hostRuntimeFixture();
 try{
  const binding=f.scope.__godotjsRuntimeHost,payload={type:'snapshot',ids:Array(25000).fill(0),padding:''};
  payload.padding='x'.repeat(262144-new TextEncoder().encode(JSON.stringify(payload)).byteLength);
  for(let index=0;index<4;index++)assert.equal(binding.emitProjectEvent(f.clone(payload)),true);
  assert.equal(f.heartbeat().memory.projectChannel.bytes,1048576);
  assert.equal(binding.emitProjectEvent(f.clone({type:'small-normal'})),false,'unconsumed events still enforce their byte budget');
  const delivered=f.control.sent.filter(message=>message.type==='project');assert.equal(delivered.length,4);
  for(const message of delivered){
   assert.equal(f.context.RuntimeUnderTest.isProjectData(message.data),true,'the downstream validator must accept every admitted dense array');
   assert.equal(message.data.ids.length,25000);
   f.control.onmessage({data:f.clone({...message,type:'project-receipt',data:undefined})});
  }
  assert.equal(f.heartbeat().memory.projectChannel.pending,0);assert.equal(f.heartbeat().memory.projectChannel.bytes,0);
  assert.equal(binding.emitProjectEvent(f.clone({type:'small-normal'})),true);
  const normal=f.control.sent.filter(message=>message.type==='project').at(-1);
  assert.equal(f.context.RuntimeUnderTest.isProjectData(normal.data),true);
  f.control.onmessage({data:f.clone({...normal,type:'project-receipt',data:undefined})});
  assert.equal(f.heartbeat().memory.projectChannel.pending,0);
 }finally{await f.cleanup();}
});


test('a browser teardown error after the native seal is reported independently before native zero',async()=>{
 const f=await hostRuntimeFixture();try{
  const binding=f.scope.__godotjsRuntimeHost;binding.endNativeEpoch('test-native-epoch');
  const sealed=JSON.stringify(binding.snapshotSummary());assert.equal(binding.snapshotSummary().sealed,true);
  let prevented=0;f.event('error',{error:vm.runInContext('new Error("physical teardown failed")',f.context),message:'physical teardown failed',filename:'engine.js',lineno:17,colno:2,preventDefault(){prevented++;}});
  const fatal=f.control.sent.find(message=>message.type==='worker-fatal');assert(fatal,'a sealed project source must not swallow the outer runtime error');
  assert.equal(fatal.diagnostic.message,'physical teardown failed');assert.equal(fatal.diagnostic.filename,'engine.js');assert.equal(prevented,1);
  assert.equal(binding.failure,undefined);assert.equal(JSON.stringify(binding.snapshotSummary()),sealed,'the previously sealed source summary stays immutable');
  f.engine.requestQuit();await flush();
  const terminal=f.control.sent.find(message=>message.type==='native-exit');assert.equal(terminal.code,0);assert.equal(terminal.runtimeSummary.failure,undefined);
  const summary=JSON.parse(JSON.stringify(terminal.runtimeSummary));
  const facts=factsFromRuntimeSummary(summary,{nativeExit:{code:terminal.code},hostCleanup:'complete',failure:{kind:'runtime',message:fatal.diagnostic.message}});
  assert.equal(sessionExitReason(facts),'crashed');assert.equal(f.control.sent.filter(message=>message.type==='worker-fatal').length,1);
 }finally{await f.cleanup();}
});

test('a fatal from the first entry drains cooperatively before start resolves and quits at a safe point',async()=>{
 const order=[];let entry;
 const f=await hostRuntimeFixture({managed:true,allowFatal:true,onStart(scope,engine,clone){
  entry=scope.__godotjsRuntimeHost.openEntry();entry.finishStartup();
  entry.lifetime.onCancel(()=>order.push('cancel'));entry.lifetime.defer(()=>order.push('cleanup'));
  scope.__godotjsRuntimeHost.reportDiagnostic(clone({kind:'runtime',message:'first entry failed'}));
  assert(!order.includes('quit'),'fatal must not re-enter native start');order.push('callback-returned');
  throw new DOMException('E_START_ABORT','AbortError');
 },onQuit(_scope,engine){order.push('quit');engine.rtenv.godotjsBeginExit();}});
 try{
  await flush();assert.equal(f.context.__audioDraining,true);assert.equal(f.context.__audioRevoked,undefined);
  assert(order.indexOf('quit')>order.indexOf('callback-returned'));assert(order.includes('cancel'));assert(order.includes('cleanup'));
  assert.equal(f.control.sent.filter(m=>m.type==='worker-fatal').length,1);
  assert.equal(f.scope.__godotjsRuntimeHost.failure.message,'first entry failed');
  assert(!f.control.sent.some(m=>m.type==='worker-termination-required'||m.phase==='running'));
  f.scope.__godotjsRuntimeHost.endNativeEpoch('test-native-epoch');f.engine.options.onExit(0);await flush();
  const terminal=f.control.sent.find(m=>m.type==='native-exit');assert.equal(terminal.runtimeSummary.failure.message,'first entry failed');assert.equal(terminal.runtimeSummary.entries[0].cleanup,'complete');
 }finally{await f.cleanup();}
});

test('stop during pending native start preserves cleanup receipts and suppresses late business work',async()=>{
 let resolveStart;const start=new Promise(resolve=>resolveStart=resolve);let cleanups=0;
 const f=await hostRuntimeFixture({managed:true,waitPhase:'starting',onStart(scope){const entry=scope.__godotjsRuntimeHost.openEntry();entry.finishStartup();entry.lifetime.defer(()=>{cleanups++;});return start;},
  onQuit(_scope,engine){engine.rtenv.godotjsBeginExit();}});
 try{
  f.stop();f.command(7,{type:'late-command'});f.input({type:'host-state',dataSequence:8,state:{visible:true}});resolveStart();await flush();
  assert.equal(cleanups,1);assert.equal(f.context.__audioDraining,true);assert.equal(f.context.__audioRevoked,undefined);
  assert(f.control.sent.some(m=>m.type==='project-command-receipt'&&m.commandSequence===7));assert(f.data.sent.some(m=>m.type==='data-receipt'&&m.dataSequence===8));
  assert.equal(f.context.__visibility.at(-1),false);assert(!f.control.sent.some(m=>m.type==='worker-fatal'||m.type==='worker-termination-required'||m.phase==='running'));
  f.scope.__godotjsRuntimeHost.endNativeEpoch('test-native-epoch');f.engine.options.onExit(0);await flush();
 }finally{resolveStart();await f.cleanup();}
});

test('managed stop reserves bounded DOM release credits independently of saturated business commands',async()=>{
 let entry,complete;
 const f=await hostRuntimeFixture({managed:true,onStart(scope){
  entry=scope.__godotjsRuntimeHost.openEntry();entry.finishStartup();
  entry.lifetime.defer(()=>{
   const send=f.context.__domOptions.sendHostCommand;
   for(let i=1;i<=16;i++)send({type:'dom-command',operation:'remove',target:'element-'+i});
   for(const operation of ['pointer-unlock','exit-fullscreen','tts-cancel','drop-release'])send({type:'dom-command',operation});
   return new Promise(resolve=>complete=resolve);
  });
 },onQuit(_scope,engine){engine.rtenv.godotjsBeginExit();}});
 try{
  const send=f.context.__domOptions.sendHostCommand,limit=512;
  for(let i=0;i<limit;i++)send({type:'dom-command',operation:'title',value:'busy'});
  assert.throws(()=>send({type:'dom-command',operation:'title',value:'over-budget'}),/E_WORKER_HOST_COMMAND_BACKPRESSURE/);
  f.stop();await flush();
  const cleanup=f.data.sent.filter(m=>m.type==='host-command'&&m.command.operation!=='title');assert.equal(cleanup.length,20);
  assert.equal(entry.summary().cleanup,'pending');assert.equal(f.scope.__godotjsRuntimeHost.failure,undefined);
  assert.throws(()=>send({type:'dom-command',operation:'title'}),/E_WORKER_DOM_CLOSED/);
  const release=()=>send({type:'dom-command',operation:'pointer-unlock'});
  assert.throws(release,/E_WORKER_HOST_CLEANUP_BACKPRESSURE/);
  f.input({type:'host-command-receipt',commandSequence:cleanup[0].commandSequence,runId:'old-run'});
  f.input({type:'host-command-receipt',commandSequence:10000});
  f.input({type:'host-command-receipt',commandSequence:f.data.sent.find(m=>m.type==='host-command').commandSequence});
  assert.throws(release,/E_WORKER_HOST_CLEANUP_BACKPRESSURE/,'Old, unknown and ordinary receipts cannot return cleanup credit');
  f.input({type:'host-command-receipt',commandSequence:cleanup[0].commandSequence});release();
  f.input({type:'host-command-receipt',commandSequence:cleanup[0].commandSequence});
  assert.throws(release,/E_WORKER_HOST_CLEANUP_BACKPRESSURE/,'A duplicate receipt cannot return credit twice');
  for(const message of f.data.sent.filter(m=>m.type==='host-command'&&m.command.operation!=='title'))f.input({type:'host-command-receipt',commandSequence:message.commandSequence});
  complete();await flush();f.engine.rtenv.godotjsCleanupTick();await flush();
  assert.equal(entry.summary().cleanup,'complete');assert(f.events.includes('release'));
  assert(!f.control.sent.some(m=>m.type==='worker-fatal'));
  f.scope.__godotjsRuntimeHost.endNativeEpoch('test-native-epoch');f.engine.options.onExit(0);await flush();
  const terminal=f.control.sent.find(m=>m.type==='native-exit');assert.equal(terminal.runtimeSummary.entries[0].cleanup,'complete');
  assert.throws(release,/E_WORKER_DOM_CLOSED/);
 }finally{complete?.();await f.cleanup();}
});

test('a failed DOM cleanup transport send returns its reserved credit',async()=>{
 const f=await hostRuntimeFixture({managed:true,onQuit(){}});
 try{
  f.stop();await flush();const send=f.context.__domOptions.sendHostCommand,post=f.data.postMessage;
  f.data.postMessage=()=>{throw Error('DOM transport unavailable');};
  assert.throws(()=>send({type:'dom-command',operation:'pointer-unlock'}),/DOM transport unavailable/);
  f.data.postMessage=post;
  for(let i=0;i<20;i++)assert.doesNotThrow(()=>send({type:'dom-command',operation:'pointer-unlock'}));
  assert.throws(()=>send({type:'dom-command',operation:'pointer-unlock'}),/E_WORKER_HOST_CLEANUP_BACKPRESSURE/);
 }finally{await f.cleanup();}
});

test('native self quit during start treats the startup abort as cancellation',async()=>{
 const f=await hostRuntimeFixture({managed:true,waitPhase:'starting',onStart(_scope,engine){engine.rtenv.godotjsBeginExit();throw new DOMException('E_START_ABORT','AbortError');}});
 try{
  await flush();assert(f.control.sent.some(m=>m.type==='worker-closing'));assert(!f.control.sent.some(m=>m.type==='worker-fatal'||m.type==='worker-termination-required'||m.phase==='running'));
  assert(!f.events.includes('quit'),'native self quit needs no second requestQuit');
  f.scope.__godotjsRuntimeHost.endNativeEpoch('test-native-epoch');f.engine.options.onExit(0);await flush();
 }finally{await f.cleanup();}
});
