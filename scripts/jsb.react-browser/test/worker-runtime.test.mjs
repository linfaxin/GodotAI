import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Execute the actual runtime/heartbeat with a deliberately slow native init.
// Only browser I/O and the native loader are replaced; no timer races or GPU.
const directory=fileURLToPath(new URL('../',import.meta.url));
const replacements={
 'verified-loader.js':`export async function loadVerifiedWorkerEngine(release,options){globalThis.__engineOptions=options;return {Engine:globalThis.__Engine,basePath:'engine',dispose(){}};}`,
 'worker-presentation.js':`export function createWorkerPresentation(options){let epoch=options.geometry.epoch;return {dispose(){},resize(value){epoch=Math.max(epoch,value.epoch);},ack(){globalThis.__presentationAcks=(globalThis.__presentationAcks??0)+1;},checkpoint(){return {geometryEpoch:epoch,outstanding:null};},setVisible(){},stats(){return {};}};}export function installPresentationHooks(){}`,
 'worker-dom.js':`export function createWorkerDom(options){globalThis.__domOptions=options;return {window:{},dispose(){},revokeInput(){},resize(){},applyHostState(){}};}`,
 'worker-audio.js':`export function createWorkerAudioBridge(){return {revoke(){}};}`,
 'worker-xr.js':`export function createWorkerXRBridge(){return {active:false,dispose(){},snapshot(){return {};}};}`,
 'worker-browser.js':`export function installWorkerBrowserBridge(){return {dispose(){}};}`,
};
const code=(await build({stdin:{contents:'export {installWorkerRuntime} from "./src/worker-runtime.ts";export {prepareWorkerRunConfiguration} from "./src/worker-protocol.ts";',resolveDir:directory},bundle:true,write:false,format:'iife',globalName:'RuntimeUnderTest',platform:'browser',target:'es2022',plugins:[{name:'native-io',setup(builder){
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
  control.onmessage({data:command});assert.deepEqual(consumed,[{type:'native-command',value:7}]);assert.equal(control.sent.filter(m=>m.type==='project-command-receipt').length,1);
  control.onmessage({data:command});assert.equal(consumed.length,1);assert.equal(control.sent.filter(m=>m.type==='project-command-receipt').length,1,'duplicate sequence never re-enters the consumer');
  const input=fields=>data.onmessage({data:Object.assign(vm.runInContext('({})',context),boot,fields)});
  input({type:'geometry',dataSequence:7,geometry:{width:2,height:1,dpr:1,epoch:1}});
  const geometryReceipt=data.sent.find(m=>m.type==='data-receipt'&&m.dataSequence===7);assert.equal(geometryReceipt.presentationCheckpoint.geometryEpoch,1);assert.equal(geometryReceipt.presentationCheckpoint.outstanding,null);
  input({type:'present-ack',dataSequence:8,runId:boot.runId,frameId:1,resizeEpoch:0});assert.equal(context.__presentationAcks,1);assert.equal(data.sent.find(m=>m.type==='data-receipt'&&m.dataSequence===8).presentationCheckpoint.geometryEpoch,1);
 }finally{
  control.onmessage?.({data:Object.assign(vm.runInContext('({})',context),boot,{type:'stop'})});resolveInit();await flush();uninstall();
 }
});
