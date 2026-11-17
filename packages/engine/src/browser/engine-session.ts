import {PTHREAD_CLASSIC_BOOTSTRAP_SOURCE,PTHREAD_MODULE_BOOTSTRAP_SOURCE} from './pthread/runtime-bootstrap-source.js';
import {isProjectData, previewDiagnostic, type PreviewDiagnostic, type RunIdentity} from './protocol.js';
import {createRuntimeBinding, type RuntimeBinding, type RuntimeSummary, type RuntimeDiagnostic as HostDiagnostic} from '../runtime-host.js';
import {isRuntimeSummary, factsFromRuntimeSummaries, type SessionFacts} from '../session-facts.js';
import {installNativeLifecycleGate, type NativeLifecycleModule} from './lifecycle-gate.js';

export type EngineExecutionModel = 'window' | 'dedicated-worker' | 'proxy-pthread';
export type RuntimeRole = 'host' | 'engine' | 'script-worker';
export interface RuntimeDiagnostic {
  kind?: string; message: string; stack?: string; componentStack?: string;
  workerId?:number; workerRole?:RuntimeRole;
}
export interface SessionCleanupReceipt {
  mode: 'clean' | 'forced';
  status?: 'complete' | 'failed' | 'timed-out';
  workers: number; terminatedWorkers: number;
  audioContexts: number; closedAudioContexts: number;
  clearedTimers: number; removedListeners: number;
  mediaStreams?:number; mediaTracks?:number; stoppedMediaTracks?:number;
  networkResources?:number; closedNetworkResources?:number;
  messagePorts?:number; closedMessagePorts?:number;
  glContexts?:number; glLossRequested?:number; lostGlContexts?:number;
  errors: string[];
}
export interface BrowserEngineSessionOptions {
  identity: RunIdentity;
  executionModel?: EngineExecutionModel;
  requiresCrossOriginIsolation?: boolean;
  hostResourceAbi?:1;
  scope?: typeof globalThis;
  onProgress?: (progress: {workerId: number; sequence: number; role: 'engine'}) => void;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  onProject?: (data: Record<string, unknown>) => void;
  onLog?: (level:'log'|'warn'|'error',text:string)=>void;
  onWorkerRole?: (role: {workerId: number; role: RuntimeRole}) => void;
  cleanupTimeoutMs?: number;
  onSummary?: (summary:RuntimeSummary) => void;
  onClosing?: () => void;
}

interface RuntimePacket {
  __godotjsRuntime: 2; sessionId: string; workerId: number;
  type: 'role' | 'progress' | 'diagnostic' | 'project' | 'log' | 'epoch' | 'summary' | 'command-receipt' | 'closing';
  role: RuntimeRole; sequence?: number; data?: unknown;
}
interface WorkerRecord {
  worker: Worker; id: number; role?: RuntimeRole; sequence: number; listener: EventListener; url: string;
  epochs: Set<string>; summaries: Map<string,RuntimeSummary>;
  commands: Map<number,number>; commandBytes:number;
}

export {installWorkerRuntimeHost} from './pthread/runtime-host-bootstrap.js';
/** Prebuilt closed code plus data-only configuration. No function serialization. */
export function runtimeWorkerBootstrap(url:string,sessionId:string,workerId:number,module=false):string {
  const configuration=JSON.stringify({url,sessionId,workerId});
  return `globalThis.__godotjsRuntimeBootstrapConfig = ${configuration};\n`+(module?PTHREAD_MODULE_BOOTSTRAP_SOURCE:PTHREAD_CLASSIC_BOOTSTRAP_SOURCE);
}

const owners = new WeakMap<object, BrowserEngineSession>();

/** Owns the entire browser execution scope, including Emscripten's pthread pool.
 * One preview browsing context hosts one session; UI/compiler workers are elsewhere. */
export class BrowserEngineSession {
  readonly identity: RunIdentity;
  readonly executionModel: EngineExecutionModel;
  private readonly scope: typeof globalThis;
  private readonly restore: Array<() => void> = [];
  private readonly workers = new Map<Worker, WorkerRecord>();
  private readonly contexts = new Set<AudioContext>();
  private readonly canvases = new Set<HTMLCanvasElement>();
  private readonly media = new Set<MediaStream>();
  private readonly network = new Set<{close:()=>unknown;[key:string]:unknown}>();
  private readonly ports = new Set<MessagePort>();
  private readonly gl = new Set<WebGLRenderingContext|WebGL2RenderingContext>();
  private readonly timers = new Map<unknown, 'timeout' | 'interval'>();
  private readonly cleanupTimers=new Set<ReturnType<typeof globalThis.setTimeout>>();
  private readonly listeners: Array<{target:EventTarget;type:string;listener:EventListenerOrEventListenerObject;capture:boolean}> = [];
  private readonly resources: Array<() => void> = [];
  private module?: {PThread?: {terminateAllThreads?:()=>void}; [key:string]:unknown};
  private stopped = false;
  private workerSerial = 0;
  private cleanup?: Promise<SessionCleanupReceipt>;
  private localBinding?:RuntimeBinding;
  private readonly localEpochs=new Set<string>();
  private readonly localSummaries=new Map<string,RuntimeSummary>();
  private observationOverflow=false;
  private readonly summaryWaiters=new Set<()=>void>();
  private draining=false;
  private commandSerial=0;
  private failure?:HostDiagnostic;
  private readonly options: BrowserEngineSessionOptions;
  // Captured before the session instruments timers. Its finalization deadline
  // must still work after business timers have been revoked.
  private readonly deadlineSet = globalThis.setTimeout.bind(globalThis);
  private readonly deadlineClear = globalThis.clearTimeout.bind(globalThis);

  constructor(options: BrowserEngineSessionOptions) {
    this.options = options; this.identity = {...options.identity};
    if(options.cleanupTimeoutMs!==undefined&&(!Number.isSafeInteger(options.cleanupTimeoutMs)||options.cleanupTimeoutMs<1||options.cleanupTimeoutMs>2147483647))throw new Error('E_SESSION_CLEANUP_TIMEOUT');
    this.scope = options.scope ?? globalThis;
    this.executionModel = options.executionModel ?? 'window';
    if (owners.has(this.scope)) throw new Error('E_SESSION_CONTEXT_IN_USE');
    if (options.requiresCrossOriginIsolation && (!this.scope.crossOriginIsolated || typeof this.scope.SharedArrayBuffer !== 'function')) throw new Error('E_SESSION_REQUIRES_ISOLATION');
    owners.set(this.scope, this);
    try {this.installRuntimeHost(); this.installWorkers(); this.installAudio(); if(options.hostResourceAbi!==1){this.installChannelsAndGraphics(); this.installMediaAndNetwork();} this.installTimers(); this.installListeners();}
    catch (error) {for (const undo of this.restore.reverse()) undo(); owners.delete(this.scope); throw error;}
  }

  private replace(target: object, name: PropertyKey, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, {configurable:true, writable:true, value});
    this.restore.push(() => {
      if (Object.getOwnPropertyDescriptor(target,name)?.value !== value) return;
      if (previous) Object.defineProperty(target,name,previous); else Reflect.deleteProperty(target,name);
    });
  }

  private installRuntimeHost():void {
    if((this.scope as unknown as {__godotjsRuntimeHost?:unknown}).__godotjsRuntimeHost)throw new Error('E_RUNTIME_HOST_IN_USE');
    let lastProgress=-Infinity,sequence=0;
    const local=createRuntimeBinding({sessionId:this.identity.runId,
      schedule:callback=>{void Promise.resolve().then(callback);},
      onRole:role=>{if(role!=='host'&&this.executionModel!=='window')throw new Error('E_SESSION_ENGINE_ON_HOST');},
      onProgress:()=>{if(this.localBinding?.role!=='engine'||this.stopped||this.draining)return;const time=Date.now();if(time-lastProgress<250)return;lastProgress=time;this.options.onProgress?.({workerId:0,sequence:++sequence,role:'engine'});},
      onDiagnostic:value=>this.report(value),onProject:value=>this.project(value),
      onLog:(level,text)=>{if(this.stopped)return false;this.options.onLog?.(level,text);return true;},
      onSummary:summary=>{if(!this.localEpochs.has(summary.epoch))return;this.localSummaries.set(summary.epoch,summary);this.options.onSummary?.(summary);this.notifySummaries();},
    });
    const begin=local.beginNativeEpoch.bind(local);
    local.beginNativeEpoch=epoch=>{
      begin(epoch);
      if(this.localEpochs.has(epoch))return;
      if(this.localEpochs.size>=256){this.observationOverflow=true;return;}
      this.localEpochs.add(epoch);
    };
    this.localBinding=local;
    this.replace(this.scope,'__godotjsRuntimeHost',local);
    if(this.executionModel==='window'){
      const installed=new WeakSet<object>();
      this.replace(this.scope,'__godotjsInstallLifecycle',(module:NativeLifecycleModule)=>{
        if(installed.has(module))return;
        const gate=installNativeLifecycleGate(module,local,{
          onBegin:()=>{this.beginDrain();this.options.onClosing?.();},
          onError:value=>{const diagnostic=previewDiagnostic(value);this.report({kind:'runtime',message:diagnostic.message,...(diagnostic.stack?{stack:diagnostic.stack}:{})});},
        });
        installed.add(module);this.resources.push(()=>gate.dispose());
      });
    }
  }

  private installWorkers(): void {
    const Original = this.scope.Worker;
    if (typeof Original !== 'function') return;
    const owner = this;
    const Wrapped = function (this: Worker, script: string | URL, options?: WorkerOptions): Worker {
      if (!new.target) throw new TypeError('Worker constructor requires new');
      if (owner.stopped || owner.draining) throw new Error('E_SESSION_DISPOSED');
      const id = ++owner.workerSerial;
      const originalUrl = new URL(String(script), owner.scope.location?.href).href;
      const url = owner.scope.URL.createObjectURL(new Blob([runtimeWorkerBootstrap(originalUrl,owner.identity.runId,id,options?.type==='module')],{type:'text/javascript'}));
      let worker: Worker;
      try {worker = new Original(url,options);} catch (error) {owner.scope.URL.revokeObjectURL(url); throw error;}
      const listener: EventListener = event => owner.receive(worker,event as MessageEvent);
      const record: WorkerRecord = {worker,id,sequence:0,listener,url,epochs:new Set(),summaries:new Map(),commands:new Map(),commandBytes:0};
      owner.workers.set(worker,record);
      worker.addEventListener('message',listener,true);
      return worker;
    } as unknown as typeof Worker;
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped,Original);
    this.replace(this.scope,'Worker',Wrapped);
  }

  private receive(worker: Worker, event: MessageEvent): void {
    const packet = event.data as RuntimePacket;
    if (!packet || packet.__godotjsRuntime !== 2) return;
    event.stopImmediatePropagation();
    const record = this.workers.get(worker);
    if (this.stopped || !record || packet.sessionId !== this.identity.runId || packet.workerId !== record.id || !['host','engine','script-worker'].includes(packet.role)) return;
    if (packet.type === 'role') {
      if (record.role && record.role !== packet.role) return;
      record.role = packet.role; this.options.onWorkerRole?.({workerId:record.id,role:packet.role}); return;
    }
    if(!record.role||packet.role!==record.role)return;
    if(packet.type==='epoch'){
      if(isProjectData(packet.data)&&typeof packet.data.epoch==='string'&&packet.data.epoch.length>0&&packet.data.epoch.length<=256&&!record.epochs.has(packet.data.epoch)){
        if(record.epochs.size>=256)this.observationOverflow=true;
        else record.epochs.add(packet.data.epoch);
      }
      return;
    }
    if(packet.type==='summary'){
      if(!isRuntimeSummary(packet.data)||!record.epochs.has(packet.data.epoch))return;
      const previous=record.summaries.get(packet.data.epoch);if(previous?.sealed)return;
      record.summaries.set(packet.data.epoch,packet.data);this.options.onSummary?.(packet.data);this.notifySummaries();return;
    }
    if(packet.type==='diagnostic'&&(record.role==='engine'||record.role==='script-worker')){this.report(packet.data,{workerId:record.id,workerRole:record.role});return;}
    if(packet.type==='log'&&(record.role==='engine'||record.role==='script-worker')){
      if(isProjectData(packet.data)&&['log','warn','error'].includes(String(packet.data.level))&&typeof packet.data.text==='string')this.options.onLog?.(packet.data.level as 'log'|'warn'|'error',packet.data.text.slice(0,4096));
      return;
    }
    if(record.role!=='engine')return;
    if(packet.type==='closing'){this.beginDrain();this.options.onClosing?.();return;}
    if(packet.type==='command-receipt'){
      const bytes=record.commands.get(packet.sequence!);if(bytes!==undefined){record.commands.delete(packet.sequence!);record.commandBytes-=bytes;}return;
    }
    if(packet.type==='progress'){
      if(this.draining)return;
      if(!Number.isSafeInteger(packet.sequence)||packet.sequence!<=record.sequence)return;
      record.sequence=packet.sequence!;this.options.onProgress?.({workerId:record.id,sequence:record.sequence,role:'engine'});
    }else if(packet.type==='project'){
      try{this.project(packet.data);}finally{if(Number.isSafeInteger(packet.sequence)&&packet.sequence!>0)record.worker.postMessage({__godotjsRuntime:2,sessionId:this.identity.runId,type:'project-receipt',sequence:packet.sequence});}
    }
  }

  private notifySummaries():void {for(const notify of [...this.summaryWaiters])notify();}

  /** Stop business traffic while preserving the control/final-summary channel. */
  beginDrain():void {
    if(this.stopped||this.draining)return;this.draining=true;this.localBinding?.beginClose('session-stop');
    for(const record of this.workers.values())try{record.worker.postMessage({__godotjsRuntime:2,sessionId:this.identity.runId,type:'drain'});}catch{}
  }

  get hasRuntimeObservation():boolean {return this.localEpochs.size>0||[...this.workers.values()].some(record=>record.epochs.size>0);}

  private allSourcesSealed():boolean {
    if(this.observationOverflow)return false;
    let sources=0;
    for(const epoch of this.localEpochs){sources++;if(!this.localSummaries.get(epoch)?.sealed)return false;}
    for(const record of this.workers.values()){
      if((record.role==='engine'||record.role==='script-worker')&&!record.epochs.size)return false;
      for(const epoch of record.epochs){sources++;if(!record.summaries.get(epoch)?.sealed)return false;}
    }
    return sources>0;
  }

  sessionFacts(input:Partial<Omit<SessionFacts,'schemaVersion'|'runtimeSummary'|'entryCleanup'>>={}):SessionFacts {
    const summaries=[...this.localSummaries.values(),...[...this.workers.values()].flatMap(record=>[...record.summaries.values()])];
    // The host can latch a browser failure before native teardown reports its
    // own error. Preserve that first failure rather than replacing its facts.
    const failure=input.failure??this.failure;
    return factsFromRuntimeSummaries(summaries,{...input,...(failure?{failure}:{}),allSourcesSealed:this.allSourcesSealed()});
  }

  /** Never destroy a pthread pool until its pre-exit epoch summaries arrive or
   * the observation deadline expires. An absent summary remains unconfirmed. */
  waitForRuntimeSummary(timeoutMs=500):Promise<void> {
    if(this.allSourcesSealed()||this.stopped)return Promise.resolve();
    return new Promise(resolve=>{
      const finish=()=>{this.deadlineClear(timer);this.summaryWaiters.delete(check);resolve();};
      const check=()=>{if(this.allSourcesSealed()||this.stopped)finish();};
      const timer=this.deadlineSet(finish,timeoutMs);this.summaryWaiters.add(check);check();
    });
  }

  private report(value: unknown,source?:{workerId:number;workerRole:RuntimeRole}): boolean {
    if (this.stopped) return false;
    try {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      if (!isProjectData(data) || typeof data.message !== 'string' || data.message.length > 4096) return false;
      if(!['caught','recoverable','uncaught','runtime'].includes(String(data.kind)))return false;
      const item: RuntimeDiagnostic={message:data.message,...source};
      if(typeof data.kind==='string')item.kind=data.kind;
      if(typeof data.stack==='string')item.stack=data.stack.slice(0,32768);
      if(typeof data.componentStack==='string')item.componentStack=data.componentStack.slice(0,8192);
      if((item.kind==='uncaught'||item.kind==='runtime')&&!this.failure){this.failure={kind:item.kind,message:item.message,...(item.stack?{stack:item.stack}:{}),...(item.componentStack?{componentStack:item.componentStack}:{})};this.beginDrain();}
      this.options.onDiagnostic?.(item); return true;
    } catch {return false;}
  }
  private project(value: unknown): boolean {
    if (this.stopped||this.draining) return false;
    try {const data=typeof value==='string'?JSON.parse(value):value;if(!isProjectData(data))return false;this.options.onProject?.(data);return true;} catch {return false;}
  }

  private installAudio(): void {
    for (const key of this.options.hostResourceAbi===1?[]:['AudioContext','webkitAudioContext']) {
      const Original=(this.scope as unknown as Record<string,unknown>)[key];
      if (typeof Original!=='function') continue;
      const owner=this;
      const Wrapped=function (this:AudioContext,...args:unknown[]) {if(!new.target)throw new TypeError('AudioContext constructor requires new');if(owner.stopped||owner.draining)throw new Error('E_SESSION_DISPOSED');const context=Reflect.construct(Original,args) as AudioContext;owner.contexts.add(context);return context;};
      Wrapped.prototype=Original.prototype;Object.setPrototypeOf(Wrapped,Original);this.replace(this.scope,key,Wrapped);
    }
    // Browser audio activation belongs on the Window that receives the trusted
    // gesture. A proxied application pthread cannot consume that activation.
    if(typeof this.scope.addEventListener==='function'){
      const resume=(event:Event)=>{
        if(this.stopped||this.draining||!event.isTrusted)return;
        const failed=(error:unknown)=>{if(!this.stopped)this.options.onLog?.('warn','Audio resume failed: '+previewDiagnostic(error).message);};
        const native=this.module?.resumeAudio;
        if(typeof native==='function'){
          try{const result=Reflect.apply(native,this.module,[]);if(result&&typeof result.then==='function')void Promise.resolve(result).catch(failed);}catch(error){failed(error);}
        }else for(const context of this.contexts)if(context.state==='suspended')try{void context.resume().catch(failed);}catch(error){failed(error);}
      };
      for(const type of ['pointerdown','keydown','touchend']){
        this.scope.addEventListener(type,resume,{capture:true,passive:true});
        this.resources.push(()=>this.scope.removeEventListener(type,resume,true));
      }
    }
  }

  /** Installed before init so asynchronous native creation retains its owner,
   * including media arriving after the run has closed. */
  installResourceOwner(engine:unknown):void {
    if(this.options.hostResourceAbi!==1)return;
    const config=(engine as {config?:{getModuleConfig?:(...args:unknown[])=>Record<string,unknown>}})?.config;
    if(!config||typeof config.getModuleConfig!=='function')throw Error('E_HOST_RESOURCE_API');
    const original=config.getModuleConfig,owner=this;
    this.replace(config,'getModuleConfig',function(this:typeof config,...args:unknown[]){
      const module=original.apply(this,args);
      module.godotjsOwnResource=(kind:string,value:unknown)=>owner.ownResource(kind,value);
      module.godotjsScheduleCleanup=(callback:()=>void)=>owner.scheduleNativeCleanup(callback);
      return module;
    });
  }

  private scheduleNativeCleanup(callback:()=>void):void {
    if(this.stopped)return;
    if(typeof callback!=='function'||this.cleanupTimers.size>=64)throw Error('E_HOST_CLEANUP_SCHEDULE_LIMIT');
    const timer=this.deadlineSet(()=>{this.cleanupTimers.delete(timer);if(!this.stopped)callback();},0);
    this.cleanupTimers.add(timer);
  }

  private ownResource(kind:string,value:unknown):boolean {
    if(!value)return false;
    const closed=this.stopped||this.draining;
    const late=(dispose:()=>unknown)=>{
      try{const pending=dispose();if(pending&&typeof (pending as Promise<unknown>).then==='function')void Promise.resolve(pending).catch(error=>this.options.onLog?.('warn','Late resource cleanup failed: '+previewDiagnostic(error).message));}
      catch(error){this.options.onLog?.('warn','Late resource cleanup failed: '+previewDiagnostic(error).message);}
      return false;
    };
    switch(kind){
      case 'audio': {const resource=value as AudioContext;if(closed)return late(()=>resource.state==='closed'?undefined:resource.close());this.contexts.add(resource);return true;}
      case 'media': {const resource=value as MediaStream;if(closed)return late(()=>{for(const track of resource.getTracks())track.stop();});this.media.add(resource);return true;}
      case 'network': {const resource=value as {close:()=>unknown;[key:string]:unknown};if(closed)return late(()=>resource.close());this.network.add(resource);return true;}
      case 'port': {const resource=value as MessagePort;if(closed)return late(()=>resource.close());this.ports.add(resource);return true;}
      case 'gl': {const resource=value as WebGLRenderingContext;if(closed)return late(()=>resource.getExtension('WEBGL_lose_context')?.loseContext());this.gl.add(resource);return true;}
      default: throw Error('E_HOST_RESOURCE_KIND');
    }
  }

  private installTimers(): void {
    const owner=this;
    for (const [name,kind] of [['setTimeout','timeout'],['setInterval','interval']] as const) {
      const original=this.scope[name];if(typeof original!=='function')continue;
      const wrapped=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{
        if(owner.stopped||owner.draining)return 0;
        let handle: unknown;
        const invoke=typeof handler==='function'?()=>{if(kind==='timeout')owner.timers.delete(handle);if(!owner.stopped&&!owner.draining)Reflect.apply(handler,owner.scope,args);}:handler;
        handle=original.call(owner.scope,invoke,timeout,...(typeof handler==='function'?[]:args));owner.timers.set(handle,kind);return handle;
      });
      this.replace(this.scope,name,wrapped);
    }
    for(const name of ['clearTimeout','clearInterval'] as const){
      const original=this.scope[name];if(typeof original!=='function')continue;
      this.replace(this.scope,name,(handle:number|undefined)=>{owner.timers.delete(handle);return original.call(owner.scope,handle);});
    }
  }

  private ownCanvas(canvas:HTMLCanvasElement):void {
    if(this.canvases.has(canvas))return;
    this.canvases.add(canvas);this.resources.push(()=>{canvas.width=0;canvas.height=0;canvas.remove();});
  }

  private installChannelsAndGraphics():void {
    const owner=this;
    for(const name of ['MessageChannel','AudioWorkletNode'] as const){
      const Original=(this.scope as unknown as Record<string,unknown>)[name];if(typeof Original!=='function')continue;
      const Wrapped=function(this:unknown,...args:unknown[]){
        if(!new.target)throw new TypeError(name+' constructor requires new');
        if(owner.stopped||owner.draining)throw new Error('E_SESSION_DISPOSED');
        const value=Reflect.construct(Original,args) as MessageChannel&AudioWorkletNode;
        for(const port of name==='MessageChannel'?[value.port1,value.port2]:[value.port])if(port&&typeof port.close==='function')owner.ports.add(port);
        return value;
      };
      Wrapped.prototype=Original.prototype;Object.setPrototypeOf(Wrapped,Original);this.replace(this.scope,name,Wrapped);
    }
    const proto=this.scope.HTMLCanvasElement?.prototype;
    if(proto&&typeof proto.getContext==='function'){
      const original=proto.getContext;
      const wrapped=function(this:HTMLCanvasElement,...args:unknown[]){
        const context=Reflect.apply(original,this,args) as WebGLRenderingContext|null;
        if(!owner.stopped&&context&&['webgl','webgl2','experimental-webgl'].includes(String(args[0]))&&typeof context.getExtension==='function'){
          owner.gl.add(context);owner.ownCanvas(this);
        }
        return context;
      };
      this.replace(proto,'getContext',wrapped);
    }
  }

  private installMediaAndNetwork():void {
    const owner=this,devices=this.scope.navigator?.mediaDevices;
    if(devices&&typeof devices.getUserMedia==='function'){
      const original=devices.getUserMedia;
      this.replace(devices,'getUserMedia',async function(this:MediaDevices,constraints:MediaStreamConstraints){
        if(owner.stopped||owner.draining)throw new DOMException('Engine session is closing','AbortError');
        const stream=await original.call(this,constraints);
        if(owner.stopped||owner.draining){for(const track of stream.getTracks())track.stop();throw new DOMException('Engine session ended before media became available','AbortError');}
        owner.media.add(stream);return stream;
      });
    }
    const track=(value:unknown)=>{
      const resource=value as {close:()=>unknown;[key:string]:unknown};
      if(!resource||typeof resource.close!=='function')return;
      if(owner.stopped||owner.draining){resource.close();return;}
      owner.network.add(resource);
    };
    for(const name of ['WebSocket','RTCPeerConnection'] as const){
      const Original=(this.scope as unknown as Record<string,unknown>)[name];if(typeof Original!=='function')continue;
      const Wrapped=function(this:unknown,...args:unknown[]){
        if(!new.target)throw new TypeError(name+' constructor requires new');
        if(owner.stopped||owner.draining)throw new Error('E_SESSION_DISPOSED');
        const resource=Reflect.construct(Original,args) as RTCPeerConnection;track(resource);
        if(name==='RTCPeerConnection'){
          const create=resource.createDataChannel;
          if(typeof create==='function')owner.replace(resource,'createDataChannel',function(this:RTCPeerConnection,...parameters:Parameters<RTCPeerConnection['createDataChannel']>){const channel=create.apply(this,parameters);track(channel);return channel;});
          const remote=(event:RTCDataChannelEvent)=>track(event.channel);
          resource.addEventListener('datachannel',remote);
          owner.resources.push(()=>resource.removeEventListener('datachannel',remote));
        }
        return resource;
      };
      Wrapped.prototype=Original.prototype;Object.setPrototypeOf(Wrapped,Original);this.replace(this.scope,name,Wrapped);
    }
  }

  private installListeners(): void {
    const proto=this.scope.EventTarget?.prototype;if(!proto)return;
    const original=proto.addEventListener,remove=proto.removeEventListener,owner=this;
    const wrapped: typeof original=function(this:EventTarget,type,listener,options){
      original.call(this,type,listener,options);
      if(listener&&!owner.stopped){const capture=typeof options==='boolean'?options:!!options?.capture;if(!owner.listeners.some(item=>item.target===this&&item.type===type&&item.listener===listener&&item.capture===capture))owner.listeners.push({target:this,type,listener,capture});}
    };
    this.replace(proto,'addEventListener',wrapped);
    const wrappedRemove:typeof remove=function(this:EventTarget,type,listener,options){
      remove.call(this,type,listener,options);
      const capture=typeof options==='boolean'?options:!!options?.capture;
      const at=owner.listeners.findIndex(item=>item.target===this&&item.type===type&&item.listener===listener&&item.capture===capture);
      if(at>=0)owner.listeners.splice(at,1);
    };
    this.replace(proto,'removeEventListener',wrappedRemove);
    this.resources.push(()=>{for(const item of owner.listeners)remove.call(item.target,item.type,item.listener,item.capture);});
  }

  attachEngine(engine: unknown): void {
    if(this.stopped)throw new Error('E_SESSION_DISPOSED');
    const module=(engine as {rtenv?:BrowserEngineSession['module']})?.rtenv;
    if(this.options.hostResourceAbi===1&&module?.godotjsHostResourceAbi!==1)throw Error('E_HOST_RESOURCE_ABI');
    if(module)this.module=module;
    const canvas=(engine as {config?:{canvas?:HTMLCanvasElement}})?.config?.canvas;
    if(canvas)this.ownCanvas(canvas);
  }

  legacyProjectEvent(value:unknown):boolean {return this.localBinding?.projectEvent(value)??false;}
  bindLegacyProjectCommand(callback:((json:string)=>void)|null):void {this.localBinding?.bindLegacyProjectCommand(callback);}

  command(data:Record<string,unknown>):boolean {
    if(this.stopped||this.draining||!isProjectData(data))return false;
    const json=JSON.stringify(data),bytes=new TextEncoder().encode(json).byteLength,snapshot=JSON.parse(json) as Record<string,unknown>;
    if(this.executionModel==='window')return this.localBinding?.receiveProjectCommand(snapshot)??false;
    const record=[...this.workers.values()].find(value=>value.role==='engine');
    if(!record||record.commands.size>=64||record.commandBytes+bytes>1048576)return false;
    const sequence=++this.commandSerial;record.commands.set(sequence,bytes);record.commandBytes+=bytes;
    try{record.worker.postMessage({__godotjsRuntime:2,sessionId:this.identity.runId,type:'project-command',sequence,data:snapshot});return true;}
    catch{record.commands.delete(sequence);record.commandBytes-=bytes;return false;}
  }

  getStats(): {workers:number;engineWorkers:number;scriptWorkers:number;audioContexts:number;messagePorts:number;glContexts:number;stopped:boolean} {
    return {workers:this.workers.size,engineWorkers:[...this.workers.values()].filter(item=>item.role==='engine').length,scriptWorkers:[...this.workers.values()].filter(item=>item.role==='script-worker').length,audioContexts:this.contexts.size,messagePorts:this.ports.size,glContexts:this.gl.size,stopped:this.stopped};
  }

  dispose(mode:'clean'|'forced'='forced'): Promise<SessionCleanupReceipt> {
    if(this.cleanup)return this.cleanup;
    this.beginDrain();this.stopped=true;this.localBinding?.settle();this.notifySummaries();
    const tracks=[...this.media].flatMap(stream=>stream.getTracks());
    const receipt:SessionCleanupReceipt={mode,workers:this.workers.size,terminatedWorkers:0,audioContexts:this.contexts.size,closedAudioContexts:0,clearedTimers:0,removedListeners:this.listeners.length,mediaStreams:this.media.size,mediaTracks:tracks.length,stoppedMediaTracks:0,networkResources:this.network.size,closedNetworkResources:0,messagePorts:this.ports.size,closedMessagePorts:0,glContexts:this.gl.size,glLossRequested:0,lostGlContexts:0,errors:[]};
    const safely=(callback:()=>void)=>{try{callback();}catch(error){if(receipt.errors.length<64)receipt.errors.push(previewDiagnostic(error).message);}};
    safely(()=>this.module?.PThread?.terminateAllThreads?.());
    for(const record of this.workers.values()){
      safely(()=>record.worker.removeEventListener('message',record.listener,true));
      safely(()=>{record.worker.terminate();receipt.terminatedWorkers++;});
      safely(()=>this.scope.URL.revokeObjectURL(record.url));
    }
    for(const [handle,kind]of this.timers){safely(()=>{if(kind==='timeout')this.scope.clearTimeout(handle as number);else this.scope.clearInterval(handle as number);receipt.clearedTimers++;});}
    this.timers.clear();
    for(const timer of this.cleanupTimers)this.deadlineClear(timer);
    this.cleanupTimers.clear();
    // Remove host callbacks before close()/stop() can synchronously dispatch.
    for(const dispose of this.resources.splice(0))safely(dispose);
    for(const port of this.ports)safely(()=>{port.onmessage=null;port.onmessageerror=null;port.close();receipt.closedMessagePorts!++;});
    for(const context of this.gl)safely(()=>{
      if(!context.isContextLost()){
        const extension=context.getExtension('WEBGL_lose_context');
        if(extension){extension.loseContext();receipt.glLossRequested!++;}
      }
      if(context.isContextLost())receipt.lostGlContexts!++;
      else throw new Error('E_SESSION_GL_LOSS_UNCONFIRMED');
    });
    this.ports.clear();this.gl.clear();
    for(const track of tracks)safely(()=>{if(track.readyState!=='ended')track.stop();receipt.stoppedMediaTracks!++;});
    for(const resource of this.network){
      for(const name of ['onopen','onclose','onerror','onmessage','onicecandidate','oniceconnectionstatechange','onconnectionstatechange','ondatachannel','onnegotiationneeded','onsignalingstatechange','onbufferedamountlow'])if(name in resource)safely(()=>{resource[name]=null;});
      safely(()=>{resource.close();receipt.closedNetworkResources!++;});
    }
    this.media.clear();this.network.clear();
    for(const undo of this.restore.reverse())safely(undo);
    this.restore.length=0;this.localBinding=undefined;
    if(owners.get(this.scope)===this)owners.delete(this.scope);
    this.module=undefined;this.workers.clear();this.listeners.length=0;this.canvases.clear();
    const audio=[...this.contexts];this.contexts.clear();
    this.cleanup=new Promise(resolve=>{
      let settled=false;
      const finish=(status:NonNullable<SessionCleanupReceipt['status']>)=>{
        if(settled)return;settled=true;this.deadlineClear(timer);receipt.status=status;resolve(receipt);
      };
      const timer=this.deadlineSet(()=>{
        if(receipt.errors.length<64)receipt.errors.push('E_SESSION_CLEANUP_TIMEOUT: Audio cleanup deadline exceeded');
        finish('timed-out');
      },this.options.cleanupTimeoutMs??1000);
      void Promise.all(audio.map(async context=>{
        try{context.onstatechange=null;if(context.state!=='closed')await context.close();return {closed:true};}
        catch(error){return {closed:false,error:previewDiagnostic(error).message};}
      })).then(results=>{
        // Late close/rejection is observed, but cannot rewrite a published receipt.
        if(settled)return;
        for(const result of results){if(result.closed)receipt.closedAudioContexts++;else if(receipt.errors.length<64)receipt.errors.push(result.error!);}
        finish(receipt.errors.length?'failed':'complete');
      });
    });
    return this.cleanup;
  }
}

export function runtimeDiagnostic(value: RuntimeDiagnostic): PreviewDiagnostic {
  return {source:'godotjs',message:value.message,...(value.stack?{stack:value.stack}:{}),...(!value.stack&&value.componentStack?{stack:value.componentStack}:{})};
}
