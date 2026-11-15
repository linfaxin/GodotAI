import {isProjectData, previewDiagnostic, type PreviewDiagnostic, type RunIdentity} from './protocol.js';

export type EngineExecutionModel = 'window' | 'dedicated-worker' | 'proxy-pthread';
export type RuntimeRole = 'host' | 'engine' | 'script-worker';
export interface RuntimeDiagnostic {
  kind?: string; message: string; stack?: string; componentStack?: string;
  workerId?:number; workerRole?:RuntimeRole;
}
export interface SessionCleanupReceipt {
  mode: 'clean' | 'forced';
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
  scope?: typeof globalThis;
  onProgress?: (progress: {workerId: number; sequence: number; role: 'engine'}) => void;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  onProject?: (data: Record<string, unknown>) => void;
  onLog?: (level:'log'|'warn'|'error',text:string)=>void;
  onWorkerRole?: (role: {workerId: number; role: RuntimeRole}) => void;
}

interface RuntimePacket {
  __godotjsRuntime: 1; sessionId: string; workerId: number;
  type: 'role' | 'progress' | 'diagnostic' | 'project' | 'log';
  role: RuntimeRole; sequence?: number; data?: unknown;
}
interface WorkerRecord {worker: Worker; id: number; role?: RuntimeRole; sequence: number; listener: EventListener; url: string}
interface RuntimeHost {
  readonly sessionId: string;
  readonly role: RuntimeRole;
  assignRole(role: RuntimeRole): void;
  markProgress(): void;
  reportProgress(frame?:number,phase?:string): void;
  reportDiagnostic(value: unknown): boolean;
  reportLog(level:'log'|'warn'|'error',text:string):boolean;
  projectEvent(value: unknown): boolean;
  emitProjectEvent(value: unknown): boolean;
  bindProjectCommand(callback: unknown): void;
}

/** This function is serialized into each pthread bootstrap. Keep it closure-free. */
export function installWorkerRuntimeHost(sessionId: string, workerId: number): void {
  const scope = globalThis as unknown as {
    __godotjsRuntimeHost?: RuntimeHost;
    postMessage(value: unknown): void;
    addEventListener(type: string, listener: (event: MessageEvent) => void, options?: boolean): void;
  };
  let role: RuntimeRole | undefined, sequence = 0, lastProgress = -Infinity;
  let command: ((json: string) => void) | undefined;
  const pending: string[] = [];
  const send = (type: RuntimePacket['type'], data?: unknown, extra: object = {}): boolean => {
    if (!role) return false;
    try {scope.postMessage({__godotjsRuntime: 1, sessionId, workerId, type, role, ...extra, ...(data === undefined ? {} : {data})}); return true;}
    catch {return false;}
  };
  const host: RuntimeHost = {
    sessionId,
    get role(){return role??'host';},
    assignRole(value) {
      if (!['host','engine','script-worker'].includes(value)) throw new Error('E_RUNTIME_ROLE');
      if (role && role !== value) throw new Error('E_RUNTIME_ROLE_REASSIGN');
      if (role === value) return;
      role = value; send('role');
    },
    markProgress() {
      // Native Environment.update calls this; a timer is not engine progress.
      if (role !== 'engine') return;
      const time = Date.now();
      if (time - lastProgress < 250) return;
      lastProgress = time; send('progress', undefined, {sequence: ++sequence});
    },
    reportProgress() {host.markProgress();},
    reportDiagnostic(value) {
      if (role !== 'engine'&&role!=='script-worker') return false;
      try {
        const data = typeof value === 'string' ? JSON.parse(value) : value;
        if (!data || typeof data !== 'object' || typeof (data as {message?:unknown}).message !== 'string') return false;
        const item = data as RuntimeDiagnostic;
        return send('diagnostic', {kind:item.kind, message:item.message.slice(0,4096), stack:typeof item.stack==='string'?item.stack.slice(0,32768):undefined, componentStack:typeof item.componentStack==='string'?item.componentStack.slice(0,8192):undefined});
      } catch {return false;}
    },
    reportLog(level,text){if(!['log','warn','error'].includes(level)||typeof text!=='string')return false;return send('log',{level,text:text.slice(0,4096)});},
    projectEvent(value) {
      if (role !== 'engine') return false;
      try {return send('project', typeof value === 'string' ? JSON.parse(value) : value);} catch {return false;}
    },
    emitProjectEvent(value) {return host.projectEvent(value);},
    bindProjectCommand(callback) {
      command = typeof callback === 'function' ? callback as (json:string)=>void : undefined;
      if (command) for (const item of pending.splice(0)) command(item);
    },
  };
  scope.__godotjsRuntimeHost = host;
  // Application console calls execute in the Worker realm. Preserve DevTools
  // output and deliver the same bounded text through the owned host channel.
  const output=globalThis.console;
  const format=(value:unknown):string=>{
    if(typeof value==='string')return value.slice(0,4096);
    if(value===null||['undefined','number','boolean','bigint'].includes(typeof value))return String(value);
    if(typeof value==='function')return '[function]';
    if(typeof value==='symbol')return '[symbol]';
    try{const descriptor=Object.getOwnPropertyDescriptor(value,'message');if(descriptor&&'value'in descriptor&&typeof descriptor.value==='string')return descriptor.value.slice(0,4096);}catch{/* Do not invoke application getters or serializers. */}
    return '[object]';
  };
  if(output)for(const name of ['log','info','debug','warn','error'] as const){
    const original=output[name];if(typeof original!=='function')continue;
    const wrapped=(...args:unknown[])=>{
      Reflect.apply(original,output,args);
      host.reportLog(name==='warn'?'warn':name==='error'?'error':'log',args.slice(0,20).map(format).join(' ').slice(0,4096));
    };
    Object.defineProperty(wrapped,'__godotjsConsoleForwarded',{value:true});
    output[name]=wrapped;
  }
  scope.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.__godotjsRuntime !== 1 || data.sessionId !== sessionId || data.type !== 'project-command') return;
    // Do not intercept Emscripten or GodotJS native transfer messages.
    event.stopImmediatePropagation();
    if (role !== 'engine' || typeof data.json !== 'string' || data.json.length > 262144) return;
    if (command) command(data.json); else if (pending.length < 64) pending.push(data.json);
  }, true);
  const ownText=(value:unknown,key:string):string|undefined=>{if(!value||typeof value!=='object')return;try{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value'in descriptor&&typeof descriptor.value==='string'?descriptor.value:undefined;}catch{return;}};
  scope.addEventListener('error',event=>{
    const error=event as unknown as ErrorEvent;
    void Promise.resolve().then(()=>{if(!event.defaultPrevented)host.reportDiagnostic({kind:'runtime',message:ownText(error.error,'message')??error.message??'Worker execution failed',stack:ownText(error.error,'stack')});});
  });
  scope.addEventListener('unhandledrejection',event=>{
    const rejection=event as unknown as PromiseRejectionEvent;
    void Promise.resolve().then(()=>{if(!event.defaultPrevented)host.reportDiagnostic({kind:'runtime',message:ownText(rejection.reason,'message')??(typeof rejection.reason==='string'?rejection.reason:'Unhandled Worker rejection'),stack:ownText(rejection.reason,'stack')});});
  });
}

export function runtimeWorkerBootstrap(url: string, sessionId: string, workerId: number, module = false): string {
  const install = `(${installWorkerRuntimeHost.toString()})(${JSON.stringify(sessionId)},${workerId});\n`;
  return install + (module ? `await import(${JSON.stringify(url)});\n` : `importScripts(${JSON.stringify(url)});\n`);
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
  private readonly listeners: Array<{target:EventTarget;type:string;listener:EventListenerOrEventListenerObject;capture:boolean}> = [];
  private readonly resources: Array<() => void> = [];
  private module?: {PThread?: {terminateAllThreads?:()=>void}; [key:string]:unknown};
  private stopped = false;
  private workerSerial = 0;
  private cleanup?: Promise<SessionCleanupReceipt>;
  private localCommand?: (json:string)=>void;
  private readonly options: BrowserEngineSessionOptions;

  constructor(options: BrowserEngineSessionOptions) {
    this.options = options; this.identity = {...options.identity};
    this.scope = options.scope ?? globalThis;
    this.executionModel = options.executionModel ?? 'window';
    if (owners.has(this.scope)) throw new Error('E_SESSION_CONTEXT_IN_USE');
    if (options.requiresCrossOriginIsolation && (!this.scope.crossOriginIsolated || typeof this.scope.SharedArrayBuffer !== 'function')) throw new Error('E_SESSION_REQUIRES_ISOLATION');
    owners.set(this.scope, this);
    try {this.installRuntimeHost(); this.installWorkers(); this.installAudio(); this.installChannelsAndGraphics(); this.installMediaAndNetwork(); this.installTimers(); this.installListeners();}
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

  private installRuntimeHost(): void {
    let localRole:RuntimeRole='host',lastProgress=-Infinity,sequence=0;
    const local: RuntimeHost = {
      sessionId:this.identity.runId,
      get role(){return localRole;},
      assignRole:role=>{if(role!=='host'&&this.executionModel!=='window')throw new Error('E_SESSION_ENGINE_ON_HOST');localRole=role;},
      markProgress:()=>{if(localRole!=='engine'||this.stopped)return;const time=Date.now();if(time-lastProgress<250)return;lastProgress=time;this.options.onProgress?.({workerId:0,sequence:++sequence,role:'engine'});},
      reportProgress:()=>local.markProgress(),
      reportDiagnostic:value=>this.report(value),
      reportLog:(level,text)=>{if(this.stopped||typeof text!=='string'||!['log','warn','error'].includes(level))return false;this.options.onLog?.(level,text.slice(0,4096));return true;},
      projectEvent:value=>this.project(value),
      emitProjectEvent:value=>this.project(value),
      bindProjectCommand:callback=>{this.localCommand=typeof callback==='function'?callback as (json:string)=>void:undefined;},
    };
    this.replace(this.scope,'__godotjsRuntimeHost',local);
  }

  private installWorkers(): void {
    const Original = this.scope.Worker;
    if (typeof Original !== 'function') return;
    const owner = this;
    const Wrapped = function (this: Worker, script: string | URL, options?: WorkerOptions): Worker {
      if (!new.target) throw new TypeError('Worker constructor requires new');
      if (owner.stopped) throw new Error('E_SESSION_DISPOSED');
      const id = ++owner.workerSerial;
      const originalUrl = new URL(String(script), owner.scope.location?.href).href;
      const url = owner.scope.URL.createObjectURL(new Blob([runtimeWorkerBootstrap(originalUrl,owner.identity.runId,id,options?.type==='module')],{type:'text/javascript'}));
      let worker: Worker;
      try {worker = new Original(url,options);} catch (error) {owner.scope.URL.revokeObjectURL(url); throw error;}
      const listener: EventListener = event => owner.receive(worker,event as MessageEvent);
      const record: WorkerRecord = {worker,id,sequence:0,listener,url};
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
    if (!packet || packet.__godotjsRuntime !== 1) return;
    event.stopImmediatePropagation();
    const record = this.workers.get(worker);
    if (this.stopped || !record || packet.sessionId !== this.identity.runId || packet.workerId !== record.id || !['host','engine','script-worker'].includes(packet.role)) return;
    if (packet.type === 'role') {
      if (record.role && record.role !== packet.role) return;
      record.role = packet.role; this.options.onWorkerRole?.({workerId:record.id,role:packet.role}); return;
    }
    if(!record.role||packet.role!==record.role)return;
    if(packet.type==='diagnostic'&&(record.role==='engine'||record.role==='script-worker')){this.report(packet.data,{workerId:record.id,workerRole:record.role});return;}
    if(packet.type==='log'&&(record.role==='engine'||record.role==='script-worker')){
      if(isProjectData(packet.data)&&['log','warn','error'].includes(String(packet.data.level))&&typeof packet.data.text==='string')this.options.onLog?.(packet.data.level as 'log'|'warn'|'error',packet.data.text.slice(0,4096));
      return;
    }
    if (record.role !== 'engine' || packet.role !== 'engine') return;
    if (packet.type === 'progress') {
      if (!Number.isSafeInteger(packet.sequence) || packet.sequence! <= record.sequence) return;
      record.sequence=packet.sequence!; this.options.onProgress?.({workerId:record.id,sequence:record.sequence,role:'engine'});
    } else if (packet.type === 'project') this.project(packet.data);
  }

  private report(value: unknown,source?:{workerId:number;workerRole:RuntimeRole}): boolean {
    if (this.stopped) return false;
    try {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      if (!isProjectData(data) || typeof data.message !== 'string' || data.message.length > 4096) return false;
      const item: RuntimeDiagnostic={message:data.message,...source};
      if(typeof data.kind==='string')item.kind=data.kind;
      if(typeof data.stack==='string')item.stack=data.stack.slice(0,32768);
      if(typeof data.componentStack==='string')item.componentStack=data.componentStack.slice(0,8192);
      this.options.onDiagnostic?.(item); return true;
    } catch {return false;}
  }
  private project(value: unknown): boolean {
    if (this.stopped) return false;
    try {const data=typeof value==='string'?JSON.parse(value):value;if(!isProjectData(data))return false;this.options.onProject?.(data);return true;} catch {return false;}
  }

  private installAudio(): void {
    for (const key of ['AudioContext','webkitAudioContext']) {
      const Original=(this.scope as unknown as Record<string,unknown>)[key];
      if (typeof Original!=='function') continue;
      const owner=this;
      const Wrapped=function (this:AudioContext,...args:unknown[]) {if(!new.target)throw new TypeError('AudioContext constructor requires new');const context=Reflect.construct(Original,args) as AudioContext;owner.contexts.add(context);return context;};
      Wrapped.prototype=Original.prototype;Object.setPrototypeOf(Wrapped,Original);this.replace(this.scope,key,Wrapped);
    }
    // Browser audio activation belongs on the Window that receives the trusted
    // gesture. A proxied application pthread cannot consume that activation.
    if(typeof this.scope.addEventListener==='function'){
      const resume=(event:Event)=>{
        if(this.stopped||!event.isTrusted)return;
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

  private installTimers(): void {
    const owner=this;
    for (const [name,kind] of [['setTimeout','timeout'],['setInterval','interval']] as const) {
      const original=this.scope[name];if(typeof original!=='function')continue;
      const wrapped=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{
        if(owner.stopped)return 0;
        let handle: unknown;
        const invoke=typeof handler==='function'?()=>{if(kind==='timeout')owner.timers.delete(handle);if(!owner.stopped)Reflect.apply(handler,owner.scope,args);}:handler;
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
        if(owner.stopped)throw new Error('E_SESSION_DISPOSED');
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
        const stream=await original.call(this,constraints);
        if(owner.stopped){for(const track of stream.getTracks())track.stop();throw new DOMException('Engine session ended before media became available','AbortError');}
        owner.media.add(stream);return stream;
      });
    }
    const track=(value:unknown)=>{
      const resource=value as {close:()=>unknown;[key:string]:unknown};
      if(!resource||typeof resource.close!=='function')return;
      if(owner.stopped){resource.close();return;}
      owner.network.add(resource);
    };
    for(const name of ['WebSocket','RTCPeerConnection'] as const){
      const Original=(this.scope as unknown as Record<string,unknown>)[name];if(typeof Original!=='function')continue;
      const Wrapped=function(this:unknown,...args:unknown[]){
        if(!new.target)throw new TypeError(name+' constructor requires new');
        if(owner.stopped)throw new Error('E_SESSION_DISPOSED');
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
    if(module)this.module=module;
    const canvas=(engine as {config?:{canvas?:HTMLCanvasElement}})?.config?.canvas;
    if(canvas)this.ownCanvas(canvas);
  }

  command(data: Record<string,unknown>): boolean {
    if(this.stopped||!isProjectData(data))return false;
    const json=JSON.stringify(data);
    if(this.executionModel==='window'&&this.localCommand){this.localCommand(json);return true;}
    let sent=false;
    for(const record of this.workers.values())if(record.role==='engine'){record.worker.postMessage({__godotjsRuntime:1,sessionId:this.identity.runId,type:'project-command',json});sent=true;}
    return sent;
  }

  getStats(): {workers:number;engineWorkers:number;scriptWorkers:number;audioContexts:number;messagePorts:number;glContexts:number;stopped:boolean} {
    return {workers:this.workers.size,engineWorkers:[...this.workers.values()].filter(item=>item.role==='engine').length,scriptWorkers:[...this.workers.values()].filter(item=>item.role==='script-worker').length,audioContexts:this.contexts.size,messagePorts:this.ports.size,glContexts:this.gl.size,stopped:this.stopped};
  }

  dispose(mode:'clean'|'forced'='forced'): Promise<SessionCleanupReceipt> {
    if(this.cleanup)return this.cleanup;
    this.stopped=true;
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
    this.restore.length=0;this.localCommand=undefined;
    if(owners.get(this.scope)===this)owners.delete(this.scope);
    this.module=undefined;this.workers.clear();this.listeners.length=0;this.canvases.clear();
    const audio=[...this.contexts];this.contexts.clear();
    this.cleanup=Promise.all(audio.map(async context=>{
      try{context.onstatechange=null;if(context.state!=='closed')await context.close();receipt.closedAudioContexts++;}catch(error){if(receipt.errors.length<64)receipt.errors.push(previewDiagnostic(error).message);}
    })).then(()=>receipt);
    return this.cleanup;
  }
}

export function runtimeDiagnostic(value: RuntimeDiagnostic): PreviewDiagnostic {
  return {source:'godotjs',message:value.message,...(value.stack?{stack:value.stack}:{}),...(!value.stack&&value.componentStack?{stack:value.componentStack}:{})};
}
