/** Host ABI 1 services which WindowNavigator exposes but WorkerNavigator does
 * not. MIDI and PWA objects are local handles with host-event state mirrors.
 * The exposed surface matches Godot's MIDI-input and PWA discovery/update
 * calls; it does not claim the complete WebMIDI or ServiceWorker browser APIs.
 * vibrate/postMessage enqueue work; only asynchronous replies contain native
 * results. All handles, requests, events and payloads have per-run bounds. */
export interface HostServiceCommand { version:1; operation:string; request?:number; value?:any }
export interface HostServiceState { version:1; sequence:number; request?:number; result?:any; error?:string; event?:string; value?:any }
export interface HostServicesOptions { onError?:(error:Error)=>void; maxHandles?:number; maxPending?:number; maxEventBytes?:number }
const text=(error:unknown)=>error instanceof Error?error.message.slice(0,4096):String(error).slice(0,4096);
function budgets(options:HostServicesOptions){const values={handles:options.maxHandles??64,pending:options.maxPending??128,bytes:options.maxEventBytes??65536};for(const v of Object.values(values))if(!Number.isSafeInteger(v)||v<1||v>1024*1024)throw RangeError('E_WORKER_SERVICE_BUDGET');return values;}
function plain(value:any,max:number){const encoded=JSON.stringify(value);if(encoded===undefined||encoded.length>max)throw RangeError('E_WORKER_SERVICE_PAYLOAD');return JSON.parse(encoded);}
class Mirror extends EventTarget { emit(type:string,fields:Record<string,unknown>={}){const event=new Event(type);for(const[key,value]of Object.entries(fields))Object.defineProperty(event,key,{value});this.dispatchEvent(event);const handler=(this as any)['on'+type];if(typeof handler==='function')handler.call(this,event);} }

export function createWorkerHostServicesHost(options:HostServicesOptions&{navigator:Navigator;sendState:(state:HostServiceState)=>void}){
 const budget=budgets(options),navigator=options.navigator as any;
 let closed=false,sequence=0,pending=0,serial=0;const acknowledgements=new Set<number>(),listeners:Array<()=>void>=[];
 const operations=new Set<Promise<void>>(),closingInputs=new Set<Promise<void>>();let cleanupPromise:Promise<void>|undefined,cleanupFailure:unknown;
 const midi=new Map<string,any>(),midiIds=new WeakMap<object,string>(),midiListeners=new Map<string,()=>void>(),registrations=new Map<string,any>(),workers=new Map<string,any>(),workerIds=new WeakMap<object,string>(),registrationIds=new WeakMap<object,string>();
 const report=(error:unknown)=>{try{options.onError?.(Error(text(error)));}catch{}};
 function send(state:Omit<HostServiceState,'version'|'sequence'>,event=false){if(closed)return;if(event&&acknowledgements.size>=budget.pending){fatal(Error('E_WORKER_SERVICE_EVENT_BACKPRESSURE'));return;}const id=++sequence;if(event)acknowledgements.add(id);try{options.sendState({version:1,sequence:id,...state});}catch(error){fatal(error);}}
 function listen(target:any,type:string,callback:EventListener){target.addEventListener(type,callback);listeners.push(()=>target.removeEventListener(type,callback));}
 function closeInput(input:any):Promise<void>{
  const operation=Promise.resolve().then(()=>input.close?.()).then(()=>{});closingInputs.add(operation);
  void operation.then(()=>closingInputs.delete(operation),error=>{if(closed)cleanupFailure??=error;closingInputs.delete(operation);});return operation;
 }
 function cleanup():Promise<void>{
  if(cleanupPromise)return cleanupPromise;closed=true;
  for(const remove of midiListeners.values())remove();midiListeners.clear();for(const remove of listeners.splice(0))remove();
  for(const input of midi.values())void closeInput(input);midi.clear();registrations.clear();workers.clear();acknowledgements.clear();
  cleanupPromise=(async()=>{
   // A pending grant/open may create another close after the first snapshot.
   // The owning Host bounds this drain with its independent cleanup deadline.
   while(operations.size||closingInputs.size)await Promise.allSettled([...operations,...closingInputs]);
   if(cleanupFailure)throw cleanupFailure;
  })();void cleanupPromise.catch(()=>{});return cleanupPromise;
 }
 function fatal(error:unknown){if(closed)return;report(error);try{options.sendState({version:1,sequence:++sequence,event:'fatal',error:text(error)});}catch{}void cleanup();}
 function workerDTO(worker:any):any{if(!worker)return null;let id=workerIds.get(worker);if(!id){if(workers.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');id='sw-'+(++serial);workerIds.set(worker,id);workers.set(id,worker);const key=id;listen(worker,'statechange',()=>send({event:'pwa-worker-state',value:{id:key,state:worker.state}},true));}return{id,state:String(worker.state),scriptURL:String(worker.scriptURL??'').slice(0,8192)};}
 function registrationDTO(registration:any):any{if(!registration)return null;let id=registrationIds.get(registration);if(!id){if(registrations.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');id='reg-'+(++serial);registrationIds.set(registration,id);registrations.set(id,registration);listen(registration,'updatefound',()=>{try{send({event:'pwa-updatefound',value:registrationDTO(registration)},true);}catch(error){fatal(error);}});}return{id,scope:String(registration.scope??'').slice(0,8192),active:workerDTO(registration.active),waiting:workerDTO(registration.waiting),installing:workerDTO(registration.installing)};}
 async function execute(command:HostServiceCommand){const value=command.value;
  switch(command.operation){
   case 'vibrate':{if(typeof navigator.vibrate!=='function')throw Error('E_WORKER_VIBRATE_UNAVAILABLE');const pattern=value?.pattern;if(!(typeof pattern==='number'&&Number.isSafeInteger(pattern)&&pattern>=0&&pattern<=60000)&&!(Array.isArray(pattern)&&pattern.length<=128&&pattern.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=60000)))throw RangeError('E_WORKER_VIBRATE_PATTERN');return navigator.vibrate(pattern);}
   case 'midi-access':{if(typeof navigator.requestMIDIAccess!=='function')throw Error('E_WORKER_MIDI_UNAVAILABLE');const access=await navigator.requestMIDIAccess(plain(value??{},budget.bytes));if(closed){await Promise.allSettled(Array.from(access.inputs.values(),closeInput));return;}const inputs=[];for(const input of access.inputs.values()){let id=midiIds.get(input);if(!id){if(midi.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');id='midi-'+(++serial);midiIds.set(input,id);midi.set(id,input);}inputs.push({id,name:String(input.name??'').slice(0,1024),manufacturer:String(input.manufacturer??'').slice(0,1024),version:String(input.version??'').slice(0,256),state:input.state,connection:input.connection,type:'input'});}return{sysexEnabled:!!access.sysexEnabled,inputs};}
   case 'midi-listen':{const input=midi.get(value?.id);if(!input)throw Error('E_WORKER_MIDI_HANDLE');midiListeners.get(value.id)?.();midiListeners.delete(value.id);if(value.enabled){const callback=(event:any)=>{const data=new Uint8Array(event.data);if(data.byteLength>budget.bytes){fatal(Error('E_WORKER_MIDI_BYTES'));return;}send({event:'midi-message',value:{id:value.id,data,receivedTime:Number(event.receivedTime??event.timeStamp??0)}},true);};input.addEventListener('midimessage',callback);midiListeners.set(value.id,()=>input.removeEventListener('midimessage',callback));}return null;}
   case 'midi-open':case 'midi-close':{const input=midi.get(value?.id);if(!input)throw Error('E_WORKER_MIDI_HANDLE');
    try{if(command.operation==='midi-open')await input.open();else await closeInput(input);}
    finally{if(closed&&command.operation==='midi-open')await closeInput(input);}
    if(closed)return;return{state:input.state,connection:input.connection};}
   case 'pwa-registration':{if(!navigator.serviceWorker)throw Error('E_WORKER_PWA_UNAVAILABLE');if(value?.scope!==undefined&&(typeof value.scope!=='string'||value.scope.length>8192))throw Error('E_WORKER_PWA_SCOPE');const registration=await navigator.serviceWorker.getRegistration(value?.scope);if(closed)return;return registrationDTO(registration);}
   case 'pwa-post':{const worker=workers.get(value?.id);if(!worker)throw Error('E_WORKER_PWA_HANDLE');worker.postMessage(plain(value.message,budget.bytes));return null;}
   default:throw Error('E_WORKER_SERVICE_OPERATION');
  }
 }
 send({event:'capabilities',value:{midi:typeof navigator.requestMIDIAccess==='function',vibrate:typeof navigator.vibrate==='function',pwa:!!navigator.serviceWorker}});
 return{handleCommand(command:HostServiceCommand){if(!command||command.version!==1||typeof command.operation!=='string')return false;if(closed)return true;if(command.operation==='ack'){acknowledgements.delete(command.value);return true;}if(command.operation==='dispose'){void cleanup();return true;}if(!Number.isSafeInteger(command.request)||(command.request as number)<1){fatal(Error('E_WORKER_SERVICE_REQUEST'));return true;}if(pending>=budget.pending){fatal(Error('E_WORKER_SERVICE_COMMAND_BACKPRESSURE'));return true;}
  pending++;const operation=execute(command).then(result=>send({request:command.request,result}),error=>send({request:command.request,error:text(error)}));operations.add(operation);void operation.finally(()=>{pending--;operations.delete(operation);});return true;
 },dispose:cleanup};
}

export function createWorkerHostServicesClient(options:HostServicesOptions&{navigator:Record<string,unknown>;sendCommand:(command:HostServiceCommand)=>void}){
 const budget=budgets(options),navigator=options.navigator;let closed=false,serial=0,lastSequence=0;
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>(),previous=new Map<string,PropertyDescriptor|undefined>(),owned=new Map<string,unknown>();
 const inputs=new Map<string,MidiInput>(),workers=new Map<string,PwaWorker>(),registrations=new Map<string,PwaRegistration>();
 const report=(error:unknown)=>{try{options.onError?.(Error(text(error)));}catch{}};
 function request(operation:string,value?:any):Promise<any>{if(closed)return Promise.reject(Error('E_WORKER_SERVICE_DISPOSED'));if(pending.size>=budget.pending)return Promise.reject(RangeError('E_WORKER_SERVICE_COMMAND_BACKPRESSURE'));const id=++serial;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});try{options.sendCommand({version:1,operation,request:id,value});}catch(error){pending.delete(id);reject(error);}});}
 function install(key:string,value:unknown,available:boolean){if(!previous.has(key))previous.set(key,Object.getOwnPropertyDescriptor(navigator,key));if(available){Object.defineProperty(navigator,key,{configurable:true,writable:true,value});owned.set(key,value);}else if(owned.has(key)){delete navigator[key];owned.delete(key);}}
 function fire(operation:string,value?:any){void request(operation,value).catch(error=>{if(!closed)report(error);});}
 class MidiInput extends Mirror {
  id:string;name:string;manufacturer:string;version:string;state:string;connection:string;type='input';#callbacks=new Map<EventListenerOrEventListenerObject,{capture:boolean;abort?:()=>void;signal?:AbortSignal}>();
  constructor(value:any){super();Object.assign(this,value);this.id=value.id;this.name=value.name;this.manufacturer=value.manufacturer;this.version=value.version;this.state=value.state;this.connection=value.connection;}
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:boolean|AddEventListenerOptions){if(type!=='midimessage'||!callback){super.addEventListener(type,callback,options);return;}const settings=typeof options==='boolean'?{capture:options}:options??{};if(settings.signal?.aborted)return;const first=this.#callbacks.size===0;if(!this.#callbacks.has(callback)){const abort=()=>this.removeEventListener(type,callback,settings);this.#callbacks.set(callback,{capture:!!settings.capture,abort,signal:settings.signal});settings.signal?.addEventListener('abort',abort,{once:true});}super.addEventListener(type,callback,options);if(first)fire('midi-listen',{id:this.id,enabled:true});}
  override removeEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:boolean|EventListenerOptions){super.removeEventListener(type,callback,options);if(type!=='midimessage'||!callback)return;const item=this.#callbacks.get(callback);if(!item)return;item.signal?.removeEventListener('abort',item.abort!);this.#callbacks.delete(callback);if(!this.#callbacks.size)fire('midi-listen',{id:this.id,enabled:false});}
  async open(){Object.assign(this,await request('midi-open',{id:this.id}));return this;}
  async close(){Object.assign(this,await request('midi-close',{id:this.id}));return this;}
  release(){for(const[callback,item]of this.#callbacks){item.signal?.removeEventListener('abort',item.abort!);super.removeEventListener('midimessage',callback,item.capture);}this.#callbacks.clear();}
 }
 class PwaWorker extends Mirror {id:string;state:string;scriptURL:string;constructor(value:any){super();this.id=value.id;this.state=value.state;this.scriptURL=value.scriptURL;}postMessage(message:unknown){fire('pwa-post',{id:this.id,message:plain(message,budget.bytes)});}}
 function worker(value:any):PwaWorker|null{if(!value)return null;let result=workers.get(value.id);if(!result){if(workers.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');result=new PwaWorker(value);workers.set(value.id,result);}else Object.assign(result,value);return result;}
 class PwaRegistration extends Mirror {id:string;scope:string;active:PwaWorker|null=null;waiting:PwaWorker|null=null;installing:PwaWorker|null=null;constructor(value:any){super();this.id=value.id;this.scope=value.scope;}update(value:any){this.active=worker(value.active);this.waiting=worker(value.waiting);this.installing=worker(value.installing);return this;}}
 function registration(value:any):PwaRegistration|undefined{if(!value)return undefined;let result=registrations.get(value.id);if(!result){if(registrations.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');result=new PwaRegistration(value);registrations.set(value.id,result);}return result.update(value);}
 const requestMIDIAccess=async(settings?:unknown)=>{const value=await request('midi-access',plain(settings??{},budget.bytes)),access=new Mirror() as Mirror&{inputs:Map<string,MidiInput>;sysexEnabled:boolean};access.inputs=new Map();access.sysexEnabled=value.sysexEnabled;for(const info of value.inputs){let input=inputs.get(info.id);if(!input){if(inputs.size>=budget.handles)throw RangeError('E_WORKER_SERVICE_HANDLES');input=new MidiInput(info);inputs.set(info.id,input);}else Object.assign(input,info);access.inputs.set(info.id,input);}return access;};
 const vibrate=(pattern:unknown)=>{void request('vibrate',{pattern}).then(result=>{if(!result&&!closed)report(Error('E_WORKER_VIBRATE_DECLINED'));},error=>{if(!closed)report(error);});};
 const serviceWorker={getRegistration:async(scope?:string)=>registration(await request('pwa-registration',{scope}))};
 function release(){for(const entry of pending.values())entry.reject(Error('E_WORKER_SERVICE_DISPOSED'));pending.clear();for(const input of inputs.values())input.release();inputs.clear();workers.clear();registrations.clear();for(const[key,descriptor]of previous){if(navigator[key]!==owned.get(key))continue;if(descriptor)Object.defineProperty(navigator,key,descriptor);else delete navigator[key];}owned.clear();}
 return{applyState(state:HostServiceState){if(!state||state.version!==1||!Number.isSafeInteger(state.sequence)||state.sequence<=lastSequence||closed)return false;lastSequence=state.sequence;
   if(state.request!==undefined){const entry=pending.get(state.request);if(entry){pending.delete(state.request);if(state.error)entry.reject(Error(state.error));else entry.resolve(state.result);}return true;}
   try{switch(state.event){case 'capabilities':install('requestMIDIAccess',requestMIDIAccess,!!state.value?.midi);install('vibrate',vibrate,!!state.value?.vibrate);install('serviceWorker',serviceWorker,!!state.value?.pwa);break;
    case 'midi-message':{const input=inputs.get(state.value?.id),data=state.value?.data;if(!input)break;if(!(data instanceof Uint8Array)||data.byteLength>budget.bytes)throw Error('E_WORKER_MIDI_BYTES');input.emit('midimessage',{data,receivedTime:state.value.receivedTime});break;}
    case 'pwa-updatefound':registration(state.value)?.emit('updatefound');break;
    case 'pwa-worker-state':{const item=workers.get(state.value?.id);if(item){item.state=state.value.state;item.emit('statechange');}break;}
    case 'fatal':throw Error(state.error??'E_WORKER_SERVICE_FATAL');default:return false;
   }}catch(error){report(error);closed=true;release();}finally{if(state.event!=='capabilities')try{options.sendCommand({version:1,operation:'ack',value:state.sequence});}catch{}}
   return true;
  },dispose(){if(closed)return;try{options.sendCommand({version:1,operation:'dispose'});}catch{}closed=true;release();}};
}
