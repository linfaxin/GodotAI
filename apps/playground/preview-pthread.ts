import {PREVIEW_PROTOCOL,RUN_PHASES,isIdentity,isProjectData,normalizedOrigin,previewDiagnostic,sameRun,type RunIdentity,type RunPhase} from '@godot-js/engine/browser/protocol';
import {loadVerifiedEngine,type GodotInstance,type LoadedEngine,type VerifiedRelease} from '@godot-js/engine/browser/verified-loader';
import {BrowserEngineSession,runtimeDiagnostic,type RuntimeDiagnostic,type SessionCleanupReceipt} from '@godot-js/engine/browser/engine-session';
import {assertCompiledRelease,nativeAudioEnabled,type ReleaseContext} from './src/release-context';
import {verifyPreviewReleaseContext} from './src/preview-release-context';
import {suppressBrowserSave} from './src/browser-shortcuts';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
suppressBrowserSave(window);

const configuredOrigin=new URL(location.href).searchParams.get('editorOrigin');
const editorOrigin=configuredOrigin?normalizedOrigin(configuredOrigin):undefined;
let connected=false;
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.isTrusted&&editorOrigin&&parent!==window)parent.postMessage({type:'godotjs-preview-escape',protocolVersion:PREVIEW_PROTOCOL},editorOrigin);});
addEventListener('message',event=>{
 const data=event.data;
 if(!editorOrigin||connected||event.origin!==editorOrigin||event.source!==parent||!data||data.type!=='connect'||data.protocolVersion!==PREVIEW_PROTOCOL||data.editorOrigin!==editorOrigin||!isIdentity(data)||event.ports.length!==1)return;
 connected=true;document.getElementById('connection-status')!.hidden=true;startSession(data,event.ports[0]);
});

function startSession(identity:RunIdentity,port:MessagePort):void {
 let engine:GodotInstance|undefined,loaded:LoadedEngine|undefined,runtime:BrowserEngineSession|undefined;
 let started=false,exited=false,cleaned=false,quitRequested=false,seenEngineProgress=false;
 let cleanupPromise:Promise<SessionCleanupReceipt>|undefined;
 let projectCommand:((json:string)=>void)|undefined;
 let readyResolve:(()=>void)|undefined,readyReject:((reason:unknown)=>void)|undefined;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 const aborter=new AbortController(),globals=globalThis as any;
 aborter.signal.addEventListener('abort',()=>readyReject?.(aborter.signal.reason),{once:true});
 const post=(data:object)=>{try{port.postMessage({...identity,protocolVersion:PREVIEW_PROTOCOL,...data});}catch{/* The parent may already have retired this session. */}};
 const terminal=(data:object)=>{post(data);port.close();};
 const send=(data:object)=>{if(!exited)post(data);};
 const phase=(value:RunPhase)=>{if(!aborter.signal.aborted)send({type:'phase',phase:value});};
 const check=()=>{if(aborter.signal.aborted)throw aborter.signal.reason;};
 let logs=0,logBytes=0;
 const text=(args:unknown[])=>args.slice(0,20).map(value=>typeof value==='string'?value.slice(0,4096):value===null||['undefined','number','boolean','bigint'].includes(typeof value)?String(value):'[object]').join(' ').slice(0,4096);
 const log=(level:'log'|'warn'|'error',args:unknown[])=>{const message=text(args);if(++logs<=1000&&(logBytes+=message.length)<=256000)send({type:'log',level,text:message});};
 const originalConsole={log:console.log,warn:console.warn,error:console.error};
 for(const level of ['log','warn','error'] as const)console[level]=(...args:unknown[])=>{originalConsole[level](...args);log(level,args);};
 const heartbeat=setInterval(()=>send({type:'heartbeat'}),250);
 const projectEvent=(raw:unknown)=>{if(exited||cleaned)return;try{const data=typeof raw==='string'?JSON.parse(raw):raw;if(isProjectData(data))send({type:'project',data});}catch{}};
 const bindProject=(callback:unknown)=>{projectCommand=typeof callback==='function'?callback as (json:string)=>void:undefined;};
 globals.__godotjsProjectEvent=projectEvent;globals.__godotjsSetProjectCommand=bindProject;
 const cleanup=(mode:'clean'|'forced'):Promise<SessionCleanupReceipt>=>{
  if(cleanupPromise)return cleanupPromise;
  cleaned=true;clearInterval(heartbeat);port.onmessage=null;
  removeEventListener('error',onBrowserError);removeEventListener('unhandledrejection',onRejectedPromise);removeEventListener('blur',onBlur);
  for(const level of ['log','warn','error'] as const)console[level]=originalConsole[level];
  if(globals.__godotjsReportReactError===onReactError)delete globals.__godotjsReportReactError;
  if(globals.__godotjsProjectEvent===projectEvent)delete globals.__godotjsProjectEvent;
  if(globals.__godotjsSetProjectCommand===bindProject)delete globals.__godotjsSetProjectCommand;
  projectCommand=undefined;
  const owned=runtime;runtime=undefined;
  const empty:SessionCleanupReceipt={mode,workers:0,terminatedWorkers:0,audioContexts:0,closedAudioContexts:0,clearedTimers:0,removedListeners:0,errors:[]};
  cleanupPromise=(owned?owned.dispose(mode):Promise.resolve(empty)).then(receipt=>{try{loaded?.dispose();}catch(error){if(receipt.errors.length<64)receipt.errors.push(previewDiagnostic(error).message);}loaded=undefined;return receipt;});
  return cleanupPromise;
 };
 const requestQuit=()=>{if(engine&&!quitRequested){quitRequested=true;engine.requestQuit();}};
 const fatal=(error:unknown,location?:{message?:string;filename?:string;line?:number;column?:number},source:'browser'|'godotjs'='browser')=>{
  if(exited||cleaned)return;
  const diagnostic=previewDiagnostic(error,location);diagnostic.source=source;
  exited=true;aborter.abort(new DOMException('Preview failed','AbortError'));
  // A fault does not call back into a potentially stuck application pthread.
  if(runtime?.executionModel==='window')try{requestQuit();}catch{/* Legacy Window runs have no application pthread to stop. */}
  void cleanup('forced').then(receipt=>terminal({type:'fatal',text:diagnostic.message,diagnostic,cleanup:receipt}));
 };
 const onBrowserError=(event:ErrorEvent)=>{if(exited||cleaned)return;fatal(event.error,{message:event.message,filename:event.filename,line:event.lineno,column:event.colno});event.preventDefault();};
 const onRejectedPromise=(event:PromiseRejectionEvent)=>{if(aborter.signal.aborted)return;fatal(event.reason);event.preventDefault();};
 const command=(data:Record<string,unknown>)=>{if(runtime?.command(data))return;projectCommand?.(JSON.stringify(data));};
 const onBlur=()=>{if(!aborter.signal.aborted)try{command({type:'clear-input'});}catch(error){fatal(error);}};
 const diagnostic=(value:RuntimeDiagnostic):boolean=>{
  if(exited||cleaned)return false;
  if(value.kind==='caught'||value.kind==='recoverable')log('warn',[value.message,value.stack??value.componentStack??'']);
  else queueMicrotask(()=>{if(!exited&&!cleaned){const item=runtimeDiagnostic(value);fatal({message:item.message,stack:item.stack},undefined,'godotjs');}});
  return true;
 };
 const onReactError=(raw:unknown):boolean=>{if(typeof raw!=='string'||raw.length>65536)return false;try{const value=JSON.parse(raw);if(!value||typeof value.message!=='string')return false;return diagnostic(value);}catch{return false;}};
 globals.__godotjsReportReactError=onReactError;
 addEventListener('error',onBrowserError);addEventListener('unhandledrejection',onRejectedPromise);addEventListener('blur',onBlur);
 const forceStop=()=>{
  if(exited||cleaned)return;
  exited=true;aborter.abort(new DOMException('Engine session terminated','AbortError'));
  void cleanup('forced').then(receipt=>terminal({type:'terminated',cleanup:receipt}));
 };
 port.onmessage=event=>{
  const data=event.data;
  if(!isIdentity(data as unknown)||!sameRun(data,identity)||data.protocolVersion!==PREVIEW_PROTOCOL)return;
  if(data.type==='force-stop'){forceStop();return;}
  if(data.type==='project-command'&&!exited&&!aborter.signal.aborted&&isProjectData(data.data)){try{command(data.data);}catch(error){fatal(error);}return;}
  if(data.type==='stop'){
   aborter.abort(new DOMException('Stopped','AbortError'));
   try{requestQuit();}catch(error){fatal(error);}
   if(!engine)forceStop();
   return;
  }
  if(data.type!=='run'||started)return;
  started=true;void boot(data.release,data.artifact?.pack,data.artifact?.manifest,data.artifact?.packSha256,data.artifact?.buildKey,data.artifact?.artifactId,data.artifact?.compatibility==='legacy-artifact-v1');
 };
 port.start();send({type:'connected'});
 async function boot(release:VerifiedRelease,pack:unknown,manifest:unknown,packSha256?:unknown,buildKey?:string,artifactId?:string,allowLegacyArtifacts=false):Promise<void>{
  try{
   if(!(pack instanceof Uint8Array)||!pack.byteLength||pack.byteLength>64*1024*1024)throw Error('E_ARTIFACT_PACK');
   if(packSha256!==undefined){const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pack.slice().buffer)),value=>value.toString(16).padStart(2,'0')).join('');if(digest!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');}
   const context=(release as VerifiedRelease&{releaseContext?:ReleaseContext}).releaseContext;
   if(context){if(context.engineReleaseId!==release.releaseId||context.engineProfile!==release.profile)throw Error('E_PREVIEW_RELEASE_CONTEXT');assertCompiledRelease(context,manifest);}
   phase(RUN_PHASES[0]);check();
   if(context){await verifyPreviewReleaseContext(context,{signal:aborter.signal,artifactManifest:manifest,artifactPack:pack,artifactBuildKey:buildKey,artifactId,allowLegacyArtifacts});check();}
   else {
    const metadata=manifest as {artifactReceipt?:unknown;artifactId?:string;buildKey?:string}|undefined;
    if(artifactId!==undefined&&metadata?.artifactId!==undefined&&artifactId!==metadata.artifactId)throw Error('E_ARTIFACT_IDENTITY');
    if(buildKey!==undefined&&metadata?.buildKey!==undefined&&buildKey!==metadata.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
    await assertArtifactReceipt(metadata?.artifactReceipt,{pack,buildKey,artifactId,allowLegacy:allowLegacyArtifacts&&release.artifactReceiptVersion!==2});
   }
   check();
   const execution=release.execution;
   runtime=new BrowserEngineSession({identity,executionModel:execution?.executionModel??'window',requiresCrossOriginIsolation:execution?.requiresCrossOriginIsolation,
    onProgress:progress=>{if(exited||cleaned)return;seenEngineProgress=true;send({type:'engine-progress',...progress});readyResolve?.();},
    onDiagnostic:diagnostic,onProject:data=>projectEvent(data),onLog:(level,text)=>log(level,[text]),
    onWorkerRole:value=>log('log',[`GODOTJS_WORKER_ROLE ${value.role} ${value.workerId}`]),
   });
   const result=await loadVerifiedEngine(release,{signal:aborter.signal});
   if(aborter.signal.aborted||exited){result.dispose();return;}
   loaded=result;check();
   engine=new loaded.Engine({canvas:document.getElementById('canvas'),executable:loaded.basePath,persistentPaths:[],persistentDrops:false,serviceWorker:'',focusCanvas:false,
    onPrint:(...args:unknown[])=>log('log',args),onPrintError:(...args:unknown[])=>log('error',args),
    onExit:(code:number)=>{if(exited)return;exited=true;void cleanup('clean').then(receipt=>terminal({type:'exited',code,cleanup:receipt}));},
   });
   (loaded.installRuntimeAssets??loaded.installWorklets).call(loaded,engine);
   phase('preloading');await engine.preloadFile(pack,'/application.pck');check();
   phase('initializing');await engine.init();runtime?.attachEngine(engine);check();
   phase('starting');await engine.start({args:nativeAudioEnabled(release.profile)?['--main-pack','/application.pck','--rendering-method','gl_compatibility']:['--main-pack','/application.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});check();
   if(exited)return;phase('waiting-ready');
   if(execution&&execution.executionModel!=='window'){if(!seenEngineProgress)await ready;}
   else await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
   check();if(exited)return;phase('running');
  }catch(error){if(!aborter.signal.aborted)fatal(error);}
 }
}
