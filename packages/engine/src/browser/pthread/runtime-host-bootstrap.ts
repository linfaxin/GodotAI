import {createRuntimeBinding,type RuntimeDiagnostic as HostDiagnostic,type RuntimeRole} from '../../runtime-host.js';
import {installNativeLifecycleGate,type NativeLifecycleModule} from '../lifecycle-gate.js';
type RuntimeBinding=ReturnType<typeof createRuntimeBinding>;
type RuntimePacket={type:'role'|'epoch'|'closing'|'progress'|'diagnostic'|'project'|'summary'|'log'|'command-receipt'};
/** Serialized into a fresh realm. Every dependency is an explicit argument. */
export function installWorkerRuntimeHost(sessionId: string, workerId: number, factory:typeof createRuntimeBinding, lifecycleFactory?:typeof installNativeLifecycleGate): void {
  const scope = globalThis as unknown as {
    __godotjsRuntimeHost?: RuntimeBinding;
    __godotjsInstallLifecycle?: (module: NativeLifecycleModule) => void;
    postMessage(value: unknown): void;
    addEventListener(type: string, listener: (event: MessageEvent) => void, options?: boolean): void;
  };
  let role:RuntimeRole='host',sequence=0,lastProgress=-Infinity,projectSerial=0,projectBytes=0,lastCommand=0;
  const projects=new Map<number,number>();
  const byteLength=(text:string):number=>{let size=0;for(const character of text){const code=character.codePointAt(0)!;size+=code<128?1:code<2048?2:code<65536?3:4;}return size;};
  const send=(type:RuntimePacket['type'],data?:unknown,extra:object={}):boolean=>{
    try{scope.postMessage({__godotjsRuntime:2,sessionId,workerId,type,role,...extra,...(data===undefined?{}:{data})});return true;}catch{return false;}
  };
  const host=factory({sessionId,schedule:callback=>{void Promise.resolve().then(callback);},
    onRole(value){role=value;send('role');},
    onProgress(){if(role!=='engine')return;const time=Date.now();if(time-lastProgress<250)return;lastProgress=time;send('progress',undefined,{sequence:++sequence});},
    onDiagnostic(value){return send('diagnostic',value);},
    onLog(level,text){return send('log',{level,text});},
    onProject(value,serialized){
      const bytes=byteLength(serialized);
      if(projects.size>=64||projectBytes+bytes>1048576)return false;
      const ticket=++projectSerial;projects.set(ticket,bytes);projectBytes+=bytes;
      if(send('project',value,{sequence:ticket}))return true;
      projects.delete(ticket);projectBytes-=bytes;return false;
    },
    onSummary(value){send('summary',value);},
  });
  const begin=host.beginNativeEpoch.bind(host);
  host.beginNativeEpoch=epoch=>{begin(epoch);send('epoch',{epoch});};
  if(scope.__godotjsRuntimeHost)throw new Error('E_RUNTIME_HOST_IN_USE');
  scope.__godotjsRuntimeHost=host;
  const installedModules = new WeakSet<object>();
  scope.__godotjsInstallLifecycle = module => {
    if (installedModules.has(module)) return;
    if (!lifecycleFactory) throw Error('E_NATIVE_LIFECYCLE_HELPER');
    lifecycleFactory(module, host, {onBegin(){if(role==='engine')send('closing');},onError(error){
      const message=error instanceof Error?error.message:'Native cleanup tick failed';
      host.reportDiagnostic({kind:'runtime',message});
    }});
    installedModules.add(module);
  };
  const output=globalThis.console;
  const format=(value:unknown):string=>{
    if(typeof value==='string')return value.slice(0,4096);
    if(value===null||['undefined','number','boolean','bigint'].includes(typeof value))return String(value);
    if(typeof value==='function')return '[function]';if(typeof value==='symbol')return '[symbol]';
    try{const descriptor=Object.getOwnPropertyDescriptor(value,'message');if(descriptor&&'value'in descriptor&&typeof descriptor.value==='string')return descriptor.value.slice(0,4096);}catch{}
    return '[object]';
  };
  if(output)for(const name of ['log','info','debug','warn','error'] as const){
    const original=output[name];if(typeof original!=='function')continue;
    const wrapped=(...args:unknown[])=>{Reflect.apply(original,output,args);host.reportLog(name==='warn'?'warn':name==='error'?'error':'log',args.slice(0,20).map(format).join(' ').slice(0,4096));};
    Object.defineProperty(wrapped,'__godotjsConsoleForwarded',{value:true});output[name]=wrapped;
  }
  scope.addEventListener('message',event=>{
    const data=event.data;
    if(!data||data.__godotjsRuntime!==2||data.sessionId!==sessionId||!['project-command','project-receipt','drain'].includes(data.type))return;
    event.stopImmediatePropagation();
    if(data.type==='drain'){host.beginClose('session-stop');return;}
    if(data.type==='project-receipt'){
      const bytes=projects.get(data.sequence);if(bytes!==undefined){projects.delete(data.sequence);projectBytes-=bytes;}return;
    }
    if(role!=='engine'||!Number.isSafeInteger(data.sequence)||data.sequence<=lastCommand)return;
    lastCommand=data.sequence;
    host.receiveProjectCommand(data.data,()=>{send('command-receipt',undefined,{sequence:data.sequence});});
  },true);
  const ownText=(value:unknown,key:string):string|undefined=>{if(!value||typeof value!=='object')return;try{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value'in descriptor&&typeof descriptor.value==='string'?descriptor.value:undefined;}catch{return;}};
  const browserFailure=(diagnostic:HostDiagnostic)=>{
    // A native epoch can be logically sealed before its physical teardown.
    // Browser-global failures still belong to this live Worker/session control
    // channel; rejecting scoped project work must not hide those failures.
    const value:HostDiagnostic={kind:diagnostic.kind,message:diagnostic.message.slice(0,4096),
      ...(typeof diagnostic.stack==='string'?{stack:diagnostic.stack.slice(0,32768)}:{}),
      ...(typeof diagnostic.componentStack==='string'?{componentStack:diagnostic.componentStack.slice(0,8192)}:{})};
    if(!host.reportDiagnostic(value))send('diagnostic',value);
  };
  scope.addEventListener('error',event=>{const error=event as unknown as ErrorEvent;void Promise.resolve().then(()=>{if(!event.defaultPrevented)browserFailure({kind:'runtime',message:ownText(error.error,'message')??error.message??'Worker execution failed',stack:ownText(error.error,'stack')});});});
  scope.addEventListener('unhandledrejection',event=>{const rejection=event as unknown as PromiseRejectionEvent;void Promise.resolve().then(()=>{if(!event.defaultPrevented)browserFailure({kind:'runtime',message:ownText(rejection.reason,'message')??(typeof rejection.reason==='string'?rejection.reason:'Unhandled Worker rejection'),stack:ownText(rejection.reason,'stack')});});});
}

