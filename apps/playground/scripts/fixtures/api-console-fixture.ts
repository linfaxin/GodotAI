import {createApiConsoleSession, createConsoleGate} from '../../src/workbench/api-console-session.ts';
import type {PlaygroundApi} from '../../src/playground-api.ts';
import type {ConsoleEnvironment} from '../../src/workbench/api-console-types.ts';

export const consoleIdentity = {runId:'run-1',revision:7,buildKey:'build-1',generation:1,documentId:'doc-1',workerId:'worker-1',runConfigurationHash:'a'.repeat(64)};
export const consoleNode = {path:'/root/Main/Player',instanceId:'12345',type:'Node2D',name:'Player',parentPath:'/root/Main'};
export const consoleEnvironment: ConsoleEnvironment = {anchor:{editorProjectId:'project-1',editorRevision:7,activeRunId:'run-1',activeRunProjectId:'project-1',activeRunRevision:7,pendingAttemptId:null},activeRunState:'running'};
export const consoleScreenshot = () => ({requestId:'capture-1',run:{...consoleIdentity},releaseId:'b'.repeat(64),renderSerial:1,iteration:1,
  geometry:{epoch:1,width:960,height:640,devicePixelRatio:1},sourceWidth:960,sourceHeight:640,width:1,height:1,mimeType:'image/png',
  bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII='),value=>value.charCodeAt(0)).buffer});

/** Real session + controlled API, shared by controller, UI and browser fixtures. */
export function createConsoleFixture() {
  let environment = structuredClone(consoleEnvironment);
  const listeners = new Set<() => void>();
  const calls: {name:string;input:unknown;signal?:AbortSignal}[] = [];
  const replies = new Map<string, unknown | ((input: any, signal?: AbortSignal) => unknown)>();
  const ok = (result: unknown) => ({ok:true,result});
  const facade = (data: unknown) => ok({data,godotai:{compatibility:{input:'subset',semantics:'partial',payload:'godotai-typed-v1',summerNativeFixture:false}}});
  function invoke(name: string, input: any, signal?: AbortSignal): any {
    calls.push({name,input:structuredClone(input),signal});
    if (replies.has(name)) {const reply=replies.get(name);return typeof reply==='function'?reply(input,signal):reply;}
    if(name==='summer_call') {
      if(input.op==='engine.screenshot')return facade(consoleScreenshot());
      if(input.op==='engine.get_runtime_tree')return facade({run:{...consoleIdentity},nodes:[{...consoleNode}],releaseId:'b'.repeat(64)});
      if(input.op==='engine.play')return facade({accepted:true,state:'pending',attemptId:'build-1',run:null});
      if(input.op==='engine.stop')return facade({accepted:true,runs:[{runId:'run-1',receipt:ok({status:'stopping',runId:'run-1'})}],no_target:false});
      return facade({playing:true});
    }
    if(name==='check')return Promise.resolve(ok({status:'completed',diagnostics:{counts:{error:0},items:[]}}));
    if(name==='game_input')return ok({operationId:'input-1'});
    if(name==='wait_for_event')return Promise.resolve(ok({outcome:'reached',run:{...consoleIdentity,projectId:'project-1',attemptId:'build-1',state:input.until==='exited'?'exited':'running'}}));
    if(name==='wait_for_input')return Promise.resolve(ok({outcome:'settled',operation:{run:{...consoleIdentity},operationId:input.operationId,status:'dispatched',down:'dispatched',up:'dispatched',nativeConsumption:'unconfirmed'}}));
    return Promise.resolve({ok:true,receipt:{run:{...consoleIdentity},path:input.path,expectedInstanceId:input.expectedInstanceId},result:{mode:'names',properties:[{name:'health',status:'found',descriptor:{name:'health',type:'int'}}]}});
  }
  const methods=['summer_call','check','wait_for_event','describe_runtime_properties','describe_runtime_methods','read_runtime_properties','game_input','wait_for_input','get_run'];
  const api=Object.fromEntries(methods.map(name=>[name,(input:unknown,signal?:AbortSignal)=>invoke(name,input,signal)])) as unknown as PlaygroundApi;
  const gate=createConsoleGate();
  const hooks={readContext:()=>structuredClone(environment),subscribeContext:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    callSelectedMethod:(input:unknown,signal?:AbortSignal)=>Promise.resolve(invoke('summer_call',{op:'engine.runtime_call',input},signal)),
    openExample:async()=>environment.anchor.editorProjectId!};
  const session=createApiConsoleSession(api,hooks,gate);
  return {api,hooks,gate,session,calls,setReply(name:string,reply:unknown | ((input:any,signal?:AbortSignal)=>unknown)){replies.set(name,reply);},
    setContext(next:ConsoleEnvironment){environment=structuredClone(next);for(const listener of listeners)listener();}};
}
