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
export type RuntimeCleanup=()=>void|PromiseLike<void>;
/** Cooperative entry lifetime; intentionally independent of DOM AbortSignal. */
export interface EntryLifetime {
 readonly cancelled:boolean;
 onCancel(callback:()=>void):()=>void;
 defer(cleanup:RuntimeCleanup):()=>void;
}
/** Internal renderer/resource participant; no framework or native types leak here. */
export interface RuntimeCleanupParticipant {
 beginClose():void;tick():void;seal():void;close():void|PromiseLike<void>;
}
export interface RuntimeCloseProgress {
 status:'pending'|'complete'|'failed'|'unconfirmed';closing:boolean;accepting:boolean;canNativeCleanup:boolean;
 pendingStartup:number;pendingCleanups:number;entries:EntrySummary[];
}
export interface RuntimeEntryScope {
 readonly entryId:string;readonly host:RuntimeHost;readonly lifetime:EntryLifetime;
 ready(hasCleanup?:boolean):void;close():void;canCleanup():boolean;cleanupComplete():void;cleanupUnconfirmed():void;
 finishStartup(cleanup?:RuntimeCleanup):void;
 onNativeSeal(callback:()=>void):()=>void;onCleanupTick(callback:()=>void):()=>void;
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
 beginClose(reason?:string):void;drainClose():Promise<RuntimeCloseProgress>;closeProgress():RuntimeCloseProgress;
 attachEntryCleanup(host:RuntimeHost,participant:RuntimeCleanupParticipant):boolean;
 detachEntryCleanup(host:RuntimeHost,participant:RuntimeCleanupParticipant):boolean;
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
 type Cleanup={callback:RuntimeCleanup;active:boolean;done:boolean;retire?:()=>void};
 type Entry={summary:EntrySummary;generation:number;closed:boolean;startupPending:boolean;legacyCleanup:boolean;
  cleanups:Cleanup[];running?:Cleanup;cancelCallbacks:Set<()=>void>;sealCallbacks:Set<()=>void>;tickCallbacks:Set<()=>void>};
 let entries=new Map<string,Entry>();
 type Participant={entry:Entry;cleanup:Cleanup;retire:()=>void};
 const hostEntries=new WeakMap<object,Entry>(),participantEntries=new WeakMap<object,Participant>();
 let closing=false,closeScheduled=false,closePumping=false,closeRepeat=false;
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
 const failureFrom=(error:unknown,entry?:Entry,teardown=false)=>{
  let message='Project command failed',stack:string|undefined;
  if(typeof error==='string')message=error;
  else if(error&&typeof error==='object')try{const d=Object.getOwnPropertyDescriptors(error);if(d.message&&'value'in d.message&&typeof d.message.value==='string')message=d.message.value;if(d.stack&&'value'in d.stack&&typeof d.stack.value==='string')stack=d.stack.value;else if(intrinsicStackGetter&&d.stack?.get===intrinsicStackGetter&&(!d.message||('value'in d.message&&typeof d.message.value==='string'))&&(!d.name||('value'in d.name&&typeof d.name.value==='string'))){const captured=intrinsicStackGetter.call(error);if(typeof captured==='string')stack=captured;}}catch{/* Never invoke application getters. */}
  report({kind:'runtime',message,...(stack?{stack}:{})},entry,teardown);
 };
 const entryAlive=(entry:Entry)=>phase!=='settled'&&epochAlive&&entry.generation===generation;
 const retireCleanup=(entry:Entry,item:Cleanup)=>{
  item.active=false;const index=entry.cleanups.indexOf(item);if(index>=0)entry.cleanups.splice(index,1);
  const retire=item.retire;item.retire=undefined;retire?.();
 };
 const cleanupFailure=(error:unknown,entry:Entry)=>{if(!entryAlive(entry))return;entry.summary.cleanup='failed';failureFrom(error,entry,true);};
 const refreshCleanup=(entry:Entry)=>{
  if(!entryAlive(entry)||entry.summary.cleanup==='failed')return;
  const pending=entry.startupPending||entry.legacyCleanup||entry.cleanups.some(item=>item.active&&!item.done);
  entry.summary.cleanup=pending?'pending':entry.closed?'complete':'not-applicable';
 };
 const closeProgress=():RuntimeCloseProgress=>{
  let pendingStartup=0,pendingCleanups=0,failed=false,unconfirmed=false,open=false;
  for(const entry of entries.values()){
   pendingStartup+=Number(entry.startupPending);pendingCleanups+=Number(entry.legacyCleanup)+entry.cleanups.filter(item=>item.active&&!item.done).length+(entry.closed?entry.cancelCallbacks.size:0);
   failed||=entry.summary.cleanup==='failed';unconfirmed||=entry.summary.cleanup==='unconfirmed';open||=!entry.closed;
  }
  const canNativeCleanup=phase!=='settled'&&epochAlive;
  const pending=open||pendingStartup>0||pendingCleanups>0;
  return {status:!canNativeCleanup&&(pending||unconfirmed)?'unconfirmed':pending?'pending':failed?'failed':unconfirmed?'unconfirmed':'complete',
   closing,accepting:phase==='active'&&epochAlive,canNativeCleanup,pendingStartup,pendingCleanups,entries:summary().entries};
 };
 const requestClose=()=>{
  if(closeScheduled||closePumping||phase==='settled'||!epochAlive)return;closeScheduled=true;
  try{schedule(()=>{closeScheduled=false;runClosePass();});}catch(error){closeScheduled=false;for(const entry of entries.values())if(entry.closed)cleanupFailure(error,entry);}
 };
 const runClosePass=()=>{
  if(closePumping||phase==='settled'||!epochAlive)return;closePumping=true;
  try{
   const current=[...entries.values()].filter(entry=>entry.closed&&entryAlive(entry));
   // Broadcast cancellation to every entry before awaiting any entry's LIFO cleanup.
   for(const entry of current)for(const callback of [...entry.cancelCallbacks]){
    if(!entry.cancelCallbacks.delete(callback))continue;if(!entryAlive(entry))break;
    try{callback();}catch(error){cleanupFailure(error,entry);}
   }
   for(const entry of current){
    if(!entryAlive(entry))continue;
    for(const callback of [...entry.tickCallbacks]){if(!entryAlive(entry))break;if(!entry.tickCallbacks.has(callback))continue;try{callback();}catch(error){cleanupFailure(error,entry);}}
   }
   let work=0;
   for(const entry of current){
    if(!entryAlive(entry)||entry.running)continue;
    for(const item of [...entry.cleanups].reverse()){
     if(!item.active||item.done)continue;if(++work>128){closeRepeat=true;break;}
     item.done=true;entry.running=item;
     try{
      const result=item.callback();
      if(result!==null&&(typeof result==='object'||typeof result==='function')){
       item.done=false;
       void Promise.resolve(result).then(()=>{
        item.done=true;entry.running=undefined;retireCleanup(entry,item);if(!entryAlive(entry))return;refreshCleanup(entry);requestClose();
       },error=>{
        item.done=true;entry.running=undefined;retireCleanup(entry,item);if(!entryAlive(entry))return;cleanupFailure(error,entry);requestClose();
       });
       break;
      }
     }catch(error){cleanupFailure(error,entry);}
     entry.running=undefined;retireCleanup(entry,item);
    }
    refreshCleanup(entry);
   }
  }finally{closePumping=false;if(closeRepeat){closeRepeat=false;requestClose();}}
 };
 const closeEntry=(entry:Entry)=>{
  if(entry.closed||!entryAlive(entry))return;entry.closed=true;entry.summary.state='closed';
  if(binding?.entry===entry)binding=undefined;dropQueue(item=>item.entry===entry);refreshCleanup(entry);requestClose();
 };
 const sealEntries=()=>{
  for(const entry of entries.values()){
   if(entry.summary.cleanup!=='failed'&&(entry.startupPending||entry.legacyCleanup||entry.cleanups.some(item=>item.active&&!item.done)))entry.summary.cleanup='unconfirmed';
   entry.cancelCallbacks.clear();entry.tickCallbacks.clear();
   for(const callback of [...entry.sealCallbacks]){if(!entry.sealCallbacks.delete(callback))continue;try{callback();}catch{/* Sealing cannot reenter released native state. */}}
  }
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
 const publicHost=(entry?:Entry):RuntimeHost=>{const value=Object.freeze({apiVersion:1 as const,sessionId:options.sessionId,get role(){return role;},reportDiagnostic:(v:RuntimeDiagnostic)=>report(v,entry),emitProjectEvent:(v:ProjectData)=>emit(v,entry),bindProjectCommand:(h:ProjectCommandHandler)=>bind(h,entry)});if(entry)hostEntries.set(value,entry);return value;};
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
   const entry:Entry={summary:{entryId:String(++serial),state:'starting',cleanup:'pending'},generation,closed:false,startupPending:true,legacyCleanup:false,
    cleanups:[],cancelCallbacks:new Set(),sealCallbacks:new Set(),tickCallbacks:new Set()};entries.set(entry.summary.entryId,entry);
   if(!binding){commandEntry=entry;claimQueue(entry);}
   const registerCleanup=(callback:RuntimeCleanup,lateStartup=false)=>{
    if(typeof callback!=='function')return fail('E_RUNTIME_CLEANUP');
    if(!entryAlive(entry)||(!lateStartup&&entry.closed))return fail('E_RUNTIME_CLOSING');
    if(entry.cleanups.length>=128)return fail('E_RUNTIME_CLEANUP_BUDGET');
    const item:Cleanup={callback,active:true,done:false};entry.cleanups.push(item);entry.legacyCleanup=false;refreshCleanup(entry);if(entry.closed)requestClose();
    return ()=>{if(!entry.closed){retireCleanup(entry,item);refreshCleanup(entry);}};
   };
   const lifetime:EntryLifetime=Object.freeze({get cancelled(){return entry.closed||!entryAlive(entry);},
    onCancel(callback:()=>void){if(typeof callback!=='function')return fail('E_RUNTIME_CANCEL_CALLBACK');if(!entryAlive(entry)||entry.closed)return fail('E_RUNTIME_CLOSING');
     const slot=()=>callback();entry.cancelCallbacks.add(slot);return ()=>{if(!entry.closed)entry.cancelCallbacks.delete(slot);};},
    defer:(callback:RuntimeCleanup)=>registerCleanup(callback),
   });
   return {
    entryId:entry.summary.entryId,host:publicHost(entry),lifetime,
    ready(hasCleanup=false){if(!entryAlive(entry))return;entry.startupPending=false;if(!entry.closed)entry.summary.state='ready';entry.legacyCleanup=hasCleanup&&!entry.cleanups.some(item=>item.active);refreshCleanup(entry);},
    finishStartup(cleanup){if(!entryAlive(entry))return;if(!entry.startupPending)return fail('E_RUNTIME_STARTUP_SETTLED');
     if(cleanup!==undefined&&typeof cleanup!=='function')return fail('E_RUNTIME_CLEANUP');entry.startupPending=false;entry.legacyCleanup=false;
     if(!entry.closed)entry.summary.state='ready';if(cleanup)registerCleanup(cleanup,true);refreshCleanup(entry);if(entry.closed)requestClose();},
    close(){closeEntry(entry);},
    onNativeSeal(callback){if(typeof callback!=='function')return fail('E_RUNTIME_SEAL_CALLBACK');if(!entryAlive(entry)){callback();return ()=>{};}const slot=()=>callback();entry.sealCallbacks.add(slot);return ()=>{entry.sealCallbacks.delete(slot);};},
    onCleanupTick(callback){if(typeof callback!=='function')return fail('E_RUNTIME_TICK_CALLBACK');if(!entryAlive(entry))return ()=>{};const slot=()=>callback();entry.tickCallbacks.add(slot);return ()=>{entry.tickCallbacks.delete(slot);};},
    canCleanup(){return phase!=='settled'&&epochAlive&&entry.generation===generation;},
    cleanupComplete(){if(entry.generation===generation&&epochAlive&&entry.summary.cleanup!=='failed'){entry.legacyCleanup=false;entry.summary.cleanup='complete';}},
    cleanupUnconfirmed(){if(entry.generation===generation&&epochAlive&&entry.summary.cleanup!=='failed')entry.summary.cleanup='unconfirmed';},
    reportCleanupFailure(value){if(entry.generation!==generation||!epochAlive||phase==='settled')return;entry.summary.cleanup='failed';report(value,entry,true);},
    summary(){return {...entry.summary};},
   };
  },
   beginNativeEpoch(value){if(typeof value!=='string'||!value||value.length>256)fail('E_RUNTIME_EPOCH');if(epoch===value&&epochAlive)return;if(phase==='settled')return;if(epochAlive){if(epoch!=='untracked')runtime.endNativeEpoch(epoch);else if(entries.size){epochAlive=false;sealEntries();}}epoch=value;epochAlive=true;epochSealed=false;sealedSummary=undefined;generation++;entries=new Map();overflow=false;binding=undefined;commandEntry=undefined;dropQueue();},
  endNativeEpoch(value){if(value!==epoch||!epochAlive)return;epochAlive=false;epochSealed=true;binding=undefined;dropQueue();sealEntries();for(const entry of entries.values())if(entry.summary.cleanup==='pending')entry.summary.cleanup='unconfirmed';sealedSummary=summary();try{options.onSummary?.(summary());}catch{/* Missing summary remains unconfirmed at owner. */}},
  snapshotSummary:summary,
  drain(){if(phase==='settled')return;phase='draining';binding=undefined;dropQueue();},
  settle(){runtime.drain();phase='settled';epochAlive=false;sealEntries();},
  beginClose(){if(phase==='settled'||!epochAlive)return;closing=true;runtime.drain();for(const entry of entries.values())closeEntry(entry);requestClose();},
  async drainClose(){runClosePass();await Promise.resolve();runClosePass();return closeProgress();},
  closeProgress,
  attachEntryCleanup(host,participant){
   const entry=hostEntries.get(host);if(!entry||!active(entry)||!participant||typeof participant!=='object')return false;
   const previous=participantEntries.get(participant);if(previous)return previous.entry===entry;
   let callbacks:{beginClose:()=>void;tick:()=>void;seal:()=>void;close:RuntimeCleanup};
   try{
    const descriptors=Object.getOwnPropertyDescriptors(participant),values:Record<string,Function>={};
    for(const key of ['beginClose','tick','seal','close']){const descriptor=descriptors[key];if(!descriptor||!('value'in descriptor)||typeof descriptor.value!=='function')return false;values[key]=descriptor.value;}
    callbacks={beginClose:()=>values.beginClose!.call(participant),tick:()=>values.tick!.call(participant),seal:()=>values.seal!.call(participant),close:()=>values.close!.call(participant)};
   }catch{return false;}
   if(!active(entry)||entry.cleanups.length>=128)return false;
   const cleanup:Cleanup={callback:callbacks.close,active:true,done:false};
   const registration:Participant={entry,cleanup,retire:()=>{
    if(participantEntries.get(participant)===registration)participantEntries.delete(participant);
    entry.cancelCallbacks.delete(callbacks.beginClose);entry.tickCallbacks.delete(callbacks.tick);entry.sealCallbacks.delete(callbacks.seal);
   }};
   cleanup.retire=registration.retire;participantEntries.set(participant,registration);
   entry.cancelCallbacks.add(callbacks.beginClose);entry.tickCallbacks.add(callbacks.tick);entry.sealCallbacks.add(callbacks.seal);
   entry.cleanups.push(cleanup);entry.legacyCleanup=false;refreshCleanup(entry);return true;
  },
  detachEntryCleanup(host,participant){
   const entry=hostEntries.get(host),registration=participantEntries.get(participant);
   if(!entry||registration?.entry!==entry)return false;
   // An already claimed async close stays charged until its Promise settles.
   if(entry.running===registration.cleanup)registration.retire();else retireCleanup(entry,registration.cleanup);
   refreshCleanup(entry);return true;
  },
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
