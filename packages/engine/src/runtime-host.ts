/** Pure runtime services: no DOM, Node, compiler or framework imports. */
export type RuntimeRole = 'host'|'engine'|'script-worker';
export type ProjectValue = null|boolean|number|string|ProjectValue[]|{[key:string]:ProjectValue};
export type ProjectData = {[key:string]:ProjectValue};
export interface RuntimeDiagnostic {kind:'caught'|'recoverable'|'uncaught'|'runtime';message:string;stack?:string;componentStack?:string}
export type ProjectCommandHandler=(data:ProjectData)=>void|PromiseLike<void>;
export interface RuntimeHost {
 readonly apiVersion:1;readonly sessionId:string;readonly role:RuntimeRole;
 reportDiagnostic(value:RuntimeDiagnostic):boolean;
 emitProjectEvent(value:ProjectData):boolean;
 bindProjectCommand(handler:ProjectCommandHandler):()=>void;
}
export interface EntrySummary {entryId:string;state:'starting'|'ready'|'closed';cleanup:'pending'|'complete'|'failed'|'unconfirmed'|'not-applicable'}
export interface RuntimeSummary {schemaVersion:1;epoch:string;sealed:boolean;failure?:RuntimeDiagnostic;entries:EntrySummary[];overflow:boolean}
export interface RuntimeEntryScope {
 readonly entryId:string;readonly host:RuntimeHost;
 ready(hasCleanup?:boolean):void;close():void;canCleanup():boolean;cleanupComplete():void;cleanupUnconfirmed():void;
 reportCleanupFailure(value:RuntimeDiagnostic):void;summary():EntrySummary;
}
export interface RuntimeBindingOptions {
 sessionId:string;role?:RuntimeRole;schedule?:(callback:()=>void)=>void;
 onDiagnostic?:(value:RuntimeDiagnostic)=>boolean|void;onProject?:(value:ProjectData,serialized:string)=>boolean|void;
 onRole?:(role:RuntimeRole)=>void;onProgress?:()=>void;
 onLog?:(level:'log'|'warn'|'error',text:string)=>boolean|void;onSummary?:(summary:RuntimeSummary)=>void;
 maxCommands?:number;maxCommandBytes?:number;maxMessageBytes?:number;maxEntries?:number;
}
export interface RuntimeBinding extends RuntimeHost {
 readonly failure:RuntimeDiagnostic|undefined;
 assignRole(role:RuntimeRole):void;markProgress():void;reportProgress(frame?:number,phase?:string):void;
 reportLog(level:'log'|'warn'|'error',text:string):boolean;projectEvent(value:unknown):boolean;
 bindLegacyProjectCommand(callback:((json:string)=>void)|null):void;
 receiveProjectCommand(value:unknown,receipt?:()=>void):boolean;
 openEntry():RuntimeEntryScope;beginNativeEpoch(epoch:string):void;endNativeEpoch(epoch:string):void;
 snapshotSummary():RuntimeSummary;drain():void;settle():void;
}

/** pthread bootstrap serializes this exact function. All runtime helpers must
 * remain inside it; transport and scheduling are injected, never imported. */
export function createRuntimeBinding(options:RuntimeBindingOptions):RuntimeBinding {
 const fail=(code:string):never=>{throw Error(code);};
 const roles=['host','engine','script-worker'];
 const intrinsicStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;
 if(!options.sessionId||options.sessionId.length>256||(options.role!==undefined&&!roles.includes(options.role)))fail('E_RUNTIME_HOST');
 const limit=(value:number|undefined,fallback:number,max=2147483647)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)fail('E_RUNTIME_BUDGET');return n;};
 const maxCommands=limit(options.maxCommands,64),maxBytes=limit(options.maxCommandBytes,1048576),maxMessage=limit(options.maxMessageBytes,262144),maxEntries=limit(options.maxEntries,128,128);
 const schedule=options.schedule??((callback:()=>void)=>{void Promise.resolve().then(callback);});
 let phase:'active'|'draining'|'settled'='active',role:RuntimeRole=options.role??'host',assigned=options.role!==undefined;
 let epoch='untracked',epochAlive=true,epochSealed=false,generation=0,serial=0,overflow=false,failure:RuntimeDiagnostic|undefined,sealedSummary:RuntimeSummary|undefined;
 const settled=()=>phase==='settled';
 type Entry={summary:EntrySummary;generation:number;closed:boolean};
 let entries=new Map<string,Entry>();
 let binding:{handler:ProjectCommandHandler;entry?:Entry}|undefined,legacyDrop:(()=>void)|undefined,commandEntry:Entry|undefined;
 type QueuedCommand={data:ProjectData;bytes:number;receipt?:()=>void;entry?:Entry};
 const queue:QueuedCommand[]=[];
 let queuedBytes=0,scheduled=false,pumping=false;
 const ownRecord=(value:unknown):value is Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))return false;const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;};
 const utf8=(text:string)=>{let n=0;for(const ch of text){const cp=ch.codePointAt(0)!;n+=cp<128?1:cp<2048?2:cp<65536?3:4;}return n;};
 const encode=(value:ProjectValue):string=>{
  if(value===null)return 'null';if(typeof value==='string')return JSON.stringify(value);if(typeof value==='number'||typeof value==='boolean')return String(value);
  const parts:string[]=[];if(Array.isArray(value)){for(let i=0;i<value.length;i++)parts.push(encode(value[i]!));return '['+parts.join(',')+']';}
  for(const key of Object.keys(value))parts.push(JSON.stringify(key)+':'+encode(value[key]!));return '{'+parts.join(',')+'}';
 };
 const snapshot=(value:unknown):{data:ProjectData;bytes:number;serialized:string}|undefined=>{
  try{
   let nodes=0,units=0;
   const copy=(item:unknown,depth:number):ProjectValue=>{
    if(depth>16||++nodes>32768)fail('E_RUNTIME_DATA');
    if(item===null||typeof item==='boolean')return item;
    if(typeof item==='number'){if(!Number.isFinite(item))fail('E_RUNTIME_DATA');return item;}
    if(typeof item==='string'){units+=item.length;if(units>maxMessage)fail('E_RUNTIME_DATA');return item;}
    if(!item||typeof item!=='object'||(!Array.isArray(item)&&!ownRecord(item)))return fail('E_RUNTIME_DATA');
    const array=Array.isArray(item),d=Object.getOwnPropertyDescriptors(item);
    if(Object.getOwnPropertySymbols(item).length)fail('E_RUNTIME_DATA');
    const a:ProjectValue[]=[],r:{[key:string]:ProjectValue}={};
    if(array){if((item as unknown[]).length>32768)fail('E_RUNTIME_DATA');for(let i=0;i<(item as unknown[]).length;i++){const p=d[String(i)];if(!p||!('value'in p)||!p.enumerable)fail('E_RUNTIME_DATA');a.push(copy(p.value,depth+1));}}
    for(const [key,p]of Object.entries(d)){
     if(array&&(key==='length'||(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<(item as unknown[]).length)))continue;
     units+=key.length+8;if(units>maxMessage||!('value'in p)||!p.enumerable||array)fail('E_RUNTIME_DATA');
     Object.defineProperty(r,key,{enumerable:true,writable:true,configurable:true,value:copy(p.value,depth+1)});
    }
    return array?a:r;
   };
   if(!ownRecord(value))return;
   const data=copy(value,0) as ProjectData,serialized=encode(data),bytes=utf8(serialized);if(bytes>maxMessage)return;return {data,bytes,serialized};
  }catch{return;}
 };
 const diagnostic=(value:unknown):RuntimeDiagnostic|undefined=>{
  try{
   if(!ownRecord(value))return;const d=Object.getOwnPropertyDescriptors(value),get=(key:string)=>{const p=d[key];return p&&'value'in p?p.value:undefined;};
   const kind=get('kind'),message=get('message');if(!['caught','recoverable','uncaught','runtime'].includes(kind)||typeof message!=='string')return;
   const result:RuntimeDiagnostic={kind,message:message.slice(0,4096)};
   for(const [key,max]of [['stack',32768],['componentStack',8192]] as const){const text=get(key);if(text!==undefined&&typeof text!=='string')return;if(typeof text==='string')result[key]=text.slice(0,max);}
   return result;
  }catch{return;}
 };
 const ack=(receipt:(()=>void)|undefined)=>{try{receipt?.();}catch{/* Lost transport cannot revive a run. */}};
 const dropQueue=(matches?:(item:QueuedCommand)=>boolean)=>{
  const dropped:QueuedCommand[]=[],retained:QueuedCommand[]=[];
  for(const item of queue)(!matches||matches(item)?dropped:retained).push(item);
  queue.length=0;queue.push(...retained);queuedBytes=retained.reduce((total,item)=>total+item.bytes,0);
  for(const item of dropped)ack(item.receipt);
 };
 const claimQueue=(entry:Entry)=>{for(const item of queue)if(!item.entry)item.entry=entry;};
 const active=(entry?:Entry)=>phase==='active'&&epochAlive&&(!entry||(!entry.closed&&entry.generation===generation));
 const report=(value:unknown,entry?:Entry,teardown=false):boolean=>{
  if(phase==='settled'||!epochAlive||(entry&&(entry.generation!==generation))||(!teardown&&entry&&entry.closed))return false;
  const observedGeneration=generation,item=diagnostic(value);if(!item||settled()||!epochAlive||generation!==observedGeneration||(entry&&(!epochAlive||entry.generation!==generation||(!teardown&&entry.closed))))return false;
  if(item.kind==='runtime'||item.kind==='uncaught'){
   if(failure)return true;failure=item;phase='draining';binding=undefined;dropQueue();
   try{options.onDiagnostic?.(item);}catch{/* The first fatal survives a failed transport. */}return true;
  }
  try{return !!options.onDiagnostic&&options.onDiagnostic(item)!==false;}catch{return false;}
 };
 const failureFrom=(error:unknown,entry?:Entry)=>{
  let message='Project command failed',stack:string|undefined;
  if(typeof error==='string')message=error;
  else if(error&&typeof error==='object')try{const d=Object.getOwnPropertyDescriptors(error);if(d.message&&'value'in d.message&&typeof d.message.value==='string')message=d.message.value;if(d.stack&&'value'in d.stack&&typeof d.stack.value==='string')stack=d.stack.value;else if(intrinsicStackGetter&&d.stack?.get===intrinsicStackGetter&&(!d.message||('value'in d.message&&typeof d.message.value==='string'))&&(!d.name||('value'in d.name&&typeof d.name.value==='string'))){const captured=intrinsicStackGetter.call(error);if(typeof captured==='string')stack=captured;}}catch{/* Never invoke application getters. */}
  report({kind:'runtime',message,...(stack?{stack}:{})},entry);
 };
 const pump=()=>{
  scheduled=false;if(pumping)return;pumping=true;
  try{let work=0;while(queue.length&&binding&&active(binding.entry)&&work++<64){
   const current=binding,item=queue.shift()!;queuedBytes-=item.bytes;
   if(item.entry!==current.entry){ack(item.receipt);continue;}
   try{const result=current.handler(item.data);if(result!==null&&(typeof result==='object'||typeof result==='function'))void Promise.resolve(result).catch(error=>failureFrom(error,current.entry));}
   catch(error){failureFrom(error,current.entry);}finally{ack(item.receipt);}
  }}finally{pumping=false;}
  if(queue.length&&binding&&active(binding.entry))requestPump();
 };
 const requestPump=()=>{if(scheduled||pumping)return;scheduled=true;try{schedule(pump);}catch{scheduled=false;failureFrom('Runtime scheduling failed');}};
 const bind=(handler:ProjectCommandHandler,entry?:Entry)=>{
  if(role!=='engine')fail('E_RUNTIME_ROLE');if(!active(entry))fail('E_RUNTIME_CLOSING');if(typeof handler!=='function')fail('E_RUNTIME_COMMAND_HANDLER');
  const current={handler,entry};binding=current;commandEntry=entry;if(entry)claimQueue(entry);
  dropQueue(item=>item.entry!==entry);requestPump();return ()=>{if(binding===current)binding=undefined;};
 };
 const emit=(value:ProjectData,entry?:Entry)=>{if(role!=='engine'||!active(entry)||!options.onProject)return false;const observedGeneration=generation,owned=snapshot(value);if(!owned||generation!==observedGeneration||!active(entry))return false;try{return options.onProject(owned.data,owned.serialized)!==false;}catch{return false;}};
 const publicHost=(entry?:Entry):RuntimeHost=>Object.freeze({apiVersion:1 as const,sessionId:options.sessionId,get role(){return role;},reportDiagnostic:(v:RuntimeDiagnostic)=>report(v,entry),emitProjectEvent:(v:ProjectData)=>emit(v,entry),bindProjectCommand:(h:ProjectCommandHandler)=>bind(h,entry)});
 const summary=():RuntimeSummary=>{const value=sealedSummary??{schemaVersion:1 as const,epoch,sealed:epochSealed,...(failure?{failure}:{}),entries:[...entries.values()].map(e=>e.summary),overflow};return {...value,...(value.failure?{failure:{...value.failure}}:{}),entries:value.entries.map(e=>({...e}))};};
 const host=publicHost();
 const runtime:RuntimeBinding={
  apiVersion:1,sessionId:options.sessionId,get role(){return role;},get failure(){return failure?{...failure}:undefined;},
  reportDiagnostic:host.reportDiagnostic,emitProjectEvent:host.emitProjectEvent,bindProjectCommand:host.bindProjectCommand,
  assignRole(value){if(!roles.includes(value))fail('E_RUNTIME_ROLE');if(assigned&&role!==value)fail('E_RUNTIME_ROLE_REASSIGN');const changed=!assigned||role!==value;if(changed)options.onRole?.(value);assigned=true;role=value;},
  markProgress(){if(phase!=='settled'&&epochAlive&&role==='engine')options.onProgress?.();},reportProgress(){runtime.markProgress();},
  reportLog(level,text){if(phase==='settled'||!['log','warn','error'].includes(level)||typeof text!=='string')return false;try{return !!options.onLog&&options.onLog(level,text.slice(0,4096))!==false;}catch{return false;}},
  projectEvent(value){try{return emit(typeof value==='string'?JSON.parse(value):value as ProjectData);}catch{return false;}},
  bindLegacyProjectCommand(callback){legacyDrop?.();legacyDrop=undefined;if(callback!==null){if(typeof callback!=='function')fail('E_RUNTIME_COMMAND_HANDLER');legacyDrop=bind(data=>callback(encode(data)));}},
  receiveProjectCommand(value,receipt){if(role!=='engine'||!active(commandEntry)){ack(receipt);return false;}const observedGeneration=generation,entry=commandEntry,owned=snapshot(value);if(!owned||generation!==observedGeneration||commandEntry!==entry||!active(entry)||queue.length>=maxCommands||queuedBytes+owned.bytes>maxBytes){ack(receipt);return false;}queue.push({...owned,receipt,entry});queuedBytes+=owned.bytes;requestPump();return true;},
  openEntry(){
   if(role!=='engine')fail('E_RUNTIME_ROLE');if(!active())fail('E_RUNTIME_CLOSING');if(entries.size>=maxEntries){overflow=true;fail('E_RUNTIME_ENTRY_BUDGET');}
   const entry:Entry={summary:{entryId:String(++serial),state:'starting',cleanup:'pending'},generation,closed:false};entries.set(entry.summary.entryId,entry);
   if(!binding){commandEntry=entry;claimQueue(entry);}
   return {
    entryId:entry.summary.entryId,host:publicHost(entry),
    ready(hasCleanup=false){if(entry.generation!==generation||!epochAlive)return;if(!entry.closed)entry.summary.state='ready';if(!hasCleanup&&entry.summary.cleanup!=='failed')entry.summary.cleanup=entry.closed?'complete':'not-applicable';},
    close(){if(entry.closed||entry.generation!==generation||!epochAlive)return;entry.closed=true;entry.summary.state='closed';if(binding?.entry===entry)binding=undefined;dropQueue(item=>item.entry===entry);if(entry.summary.cleanup==='not-applicable')entry.summary.cleanup='complete';},
    canCleanup(){return phase!=='settled'&&epochAlive&&entry.generation===generation;},
    cleanupComplete(){if(entry.generation===generation&&epochAlive&&entry.summary.cleanup!=='failed')entry.summary.cleanup='complete';},
    cleanupUnconfirmed(){if(entry.generation===generation&&epochAlive&&entry.summary.cleanup!=='failed')entry.summary.cleanup='unconfirmed';},
    reportCleanupFailure(value){if(entry.generation!==generation||!epochAlive||phase==='settled')return;entry.summary.cleanup='failed';report(value,entry,true);},
    summary(){return {...entry.summary};},
   };
  },
  beginNativeEpoch(value){if(typeof value!=='string'||!value||value.length>256)fail('E_RUNTIME_EPOCH');if(epoch===value&&epochAlive)return;if(phase==='settled')return;if(epoch!=='untracked'&&epochAlive)runtime.endNativeEpoch(epoch);epoch=value;epochAlive=true;epochSealed=false;sealedSummary=undefined;generation++;entries=new Map();overflow=false;binding=undefined;commandEntry=undefined;dropQueue();},
  endNativeEpoch(value){if(value!==epoch||!epochAlive)return;epochAlive=false;epochSealed=true;binding=undefined;dropQueue();for(const entry of entries.values())if(entry.summary.cleanup==='pending')entry.summary.cleanup='unconfirmed';sealedSummary=summary();try{options.onSummary?.(summary());}catch{/* Missing summary remains unconfirmed at owner. */}},
  snapshotSummary:summary,
  drain(){if(phase==='settled')return;phase='draining';binding=undefined;dropQueue();},
  settle(){runtime.drain();phase='settled';epochAlive=false;},
 };
 return runtime;
}

type RuntimeScope={__godotjsRuntimeHost?:RuntimeHost};
const owners=new WeakMap<object,object>();
/** One realm, one owner. Old disposal never restores a retired host. */
export function installRuntimeHost(host:RuntimeHost,scope:RuntimeScope=globalThis as RuntimeScope):()=>void {
 if(host.apiVersion!==1||!host.sessionId||!['host','engine','script-worker'].includes(host.role)||typeof host.reportDiagnostic!=='function')throw Error('E_RUNTIME_HOST');
 if(owners.has(scope)||scope.__godotjsRuntimeHost)throw Error('E_RUNTIME_HOST_IN_USE');
 const token={};owners.set(scope,token);scope.__godotjsRuntimeHost=host;
 return ()=>{if(owners.get(scope)!==token)return;owners.delete(scope);if(scope.__godotjsRuntimeHost===host)delete scope.__godotjsRuntimeHost;};
}
export function getRuntimeHost(scope:RuntimeScope=globalThis as RuntimeScope):RuntimeHost {const host=scope.__godotjsRuntimeHost;if(!host)throw Error('E_RUNTIME_HOST: No engine session is installed');return host;}
