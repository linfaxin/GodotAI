import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('../../',import.meta.url));
const replacements={
 'verified-loader.js':'export function loadVerifiedWorkerEngine(...args){return globalThis.__load(...args);}',
 'worker-presentation.js':'export function createWorkerPresentation(){return {dispose(){},resize(){},ack(){},checkpoint(){return {};},setVisible(){},stats(){return {};}};}export function installPresentationHooks(){}',
 'worker-dom.js':'export function createWorkerDom(){return {window:{},dispose(){},revokeInput(){},resize(){},applyHostState(){}};}',
 'worker-audio.js':'export function createWorkerAudioBridge(){return {revoke(){}};}',
 'worker-xr.js':'export function createWorkerXRBridge(){return {active:false,dispose(){},snapshot(){return {};}};}',
 'worker-browser.js':'export function installWorkerBrowserBridge(){return {dispose(){}};}',
};
const code=(await build({stdin:{contents:'export {installWorkerRuntime} from "./src/worker-runtime.ts";export {prepareWorkerRunConfiguration,isWorkerEnvelope} from "./src/worker-protocol.ts";',resolveDir:directory},bundle:true,write:false,format:'iife',globalName:'Runtime',platform:'browser',target:'es2022',plugins:[{name:'lifecycle-io',setup(builder){
 builder.onResolve({filter:/(verified-loader|worker-presentation|worker-dom|worker-audio|worker-xr|worker-browser)\.js$/},args=>({path:args.path.split('/').at(-1),namespace:'lifecycle'}));
 builder.onLoad({filter:/.*/,namespace:'lifecycle'},args=>({contents:replacements[args.path],loader:'js'}));
}}]})).outputFiles[0].text;
export const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
// Actual production runtime; only native loading and browser I/O are doubles.
export async function fixture(load){
 const listeners=new Map(),timers=new Set();let timer=0;const console={log(){},warn(){},error(){}},originalLog=console.log;
 class Port{sent=[];onmessage=null;postMessage(value){this.sent.push(value);}start(){}}
 class Scope{closed=0;addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);}removeEventListener(name,fn){listeners.get(name)?.delete(fn);}close(){this.closed++;}}
 const scope=new Scope();scope.WorkerGlobalScope=Scope;
 const sandbox={console,crypto,MessagePort:Port,ArrayBuffer,Uint8Array,TextEncoder,AbortController,DOMException,queueMicrotask,__load:load,setInterval(){const id=++timer;timers.add(id);return id;},clearInterval:id=>timers.delete(id)};
 const context=vm.createContext(sandbox);vm.runInContext(code,context);const clone=value=>vm.runInContext('('+JSON.stringify(value)+')',context),prepared=await context.Runtime.prepareWorkerRunConfiguration(clone({}));
 const identity={runId:'preview-lifecycle',revision:1,generation:1,buildKey:'pack',documentId:'doc',workerId:'worker',runConfigurationHash:prepared.hash},control=new Port(),data=new Port();
 const boot=Object.assign(clone({...identity,protocolVersion:2,type:'worker-connect'}),{configuration:prepared.configuration,release:{runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}},pack:new Uint8Array([1]),canvas:{},geometry:{width:1,height:1,dpr:1,epoch:0},controlPort:control,dataPort:data});
 assert(context.Runtime.isWorkerEnvelope(boot),JSON.stringify(boot));
 const uninstall=context.Runtime.installWorkerRuntime(scope);
 return{scope,sandbox,context,control,messages:control.sent,timers,originalLog,run(){for(const fn of listeners.get('message'))fn({data:boot});},stop(){control.onmessage?.({data:clone({...identity,protocolVersion:2,type:'stop'})});},event(name,value){for(const fn of [...listeners.get(name)??[]])fn(value);},error(message){return vm.runInContext('new Error('+JSON.stringify(message)+')',context);},uninstall};
}
export function loaded({onQuit=()=>{},dispose=()=>{}}={}){return {basePath:'engine',dispose,Engine:class{constructor(c){this.hooks=c;this.config={getModuleConfig(){return {};}};}async preloadFile(){}async init(){this.rtenv=this.config.getModuleConfig();}async start(){}requestQuit(){onQuit(this.hooks);}}};}
export async function until(predicate,detail=()=> 'Worker did not reach expected state'){const deadline=Date.now()+2000;while(!predicate()){assert(Date.now()<deadline,detail());await flush();}}
export async function running(f){f.run();await until(()=>f.messages.some(m=>m.phase==='running'),()=>JSON.stringify(f.messages));}
