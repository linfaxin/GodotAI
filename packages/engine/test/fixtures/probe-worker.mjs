import vm from 'node:vm';
import {sharedMemoryGrowthWorker} from '../../dist/browser/shared-memory-growth.js';

/** Executes the real probe Worker function with real WebAssembly in Node.
 * Browser tests separately cover structured cloning and engine-specific growth. */
export function installProbeWorker(t,{mode='normal',urls=true}={}){
 const workers=[],created=[],revoked=[];
 for(const [name,value]of Object.entries({crossOriginIsolated:true,Worker:class{
  constructor(url){this.url=url;this.terminated=0;workers.push(this);const worker=this;
   this.scope={WebAssembly,Uint8Array,Error,postMessage(data){queueMicrotask(()=>worker.onmessage?.({data}));}};this.scope.globalThis=this.scope;
   vm.runInNewContext('('+sharedMemoryGrowthWorker.toString()+')()',this.scope);
  }
  postMessage(data){queueMicrotask(()=>{
   if(mode==='silent')return;
   if(mode==='failure'&&data.type==='grown'){this.onmessage?.({data:{__godotjsSharedMemoryProbe:1,type:'failed',detail:'retained-worker-page-count'}});return;}
   this.scope.onmessage({data});
  });}
  terminate(){this.terminated++;}
 }})){
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else delete globalThis[name];});
 }
 if(urls){t.mock.method(URL,'createObjectURL',blob=>{const url='blob:probe-'+created.length;created.push({url,blob});return url;});t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));}
 return {workers,created,revoked};
}
