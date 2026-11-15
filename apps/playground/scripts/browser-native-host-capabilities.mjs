/** Native Godot -> unchanged Worker/Host ABI -> actual local browser APIs.
 * This producer never supplies a browser API result and never certifies hardware. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '@godot-js/react-browser/pck';
import {buildWorkerFeatureHarness} from './browser-2d-features-test.mjs';
import {launchTestBrowser,installPassiveRecorder,observedWorkerSessions,withAcceptanceContext,isBrowserConsoleWarning,defaultTestDirectory} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runtimeTestContext} from './runtime-test-context.mjs';
import {siteIdentity,canonical} from './site-evidence.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';
import {assertWorkerCapabilityProbeReport} from './worker-capability-ledger.mjs';
import {assertWorkerCandidate} from './worker-candidate.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const producerPath='apps/playground/scripts/browser-native-host-capabilities.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),encode=value=>new TextEncoder().encode(value);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const HOST_CAPABILITIES=Object.freeze(['clipboard','fullscreen','pointer-lock','downloads','url-open']);
const marker='NATIVE_HOST_CAPABILITY';

export function nativeHostFixture({capability,negative=false,token,popupUrl,naming='snake',gesture='mouse',activationDelayMs=6500,sdkMode='production',sdkVendor}={}){
 if(![...HOST_CAPABILITIES,'inventory'].includes(capability)||!['snake','camel'].includes(naming)||!['mouse','keyboard'].includes(gesture)||typeof token!=='string'||!/^native-host-[a-z0-9-]+$/.test(token)||!Number.isSafeInteger(activationDelayMs)||activationDelayMs<6500||!['production','development'].includes(sdkMode)||!(sdkVendor instanceof Uint8Array)||!sdkVendor.length)throw Error('E_NATIVE_HOST_FIXTURE');
 const url=new URL(popupUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('E_NATIVE_HOST_LOCAL_URL');
 const config={capability,negative,token,popupUrl:url.href,gesture,activationDelayMs,sdkMode};
 const source=`const SDK=require('res://.godot/GodotJS/.playground/host-vendor.js');if(typeof SDK.React?.createElement!=='function'||typeof SDK.engineReact?.createRoot!=='function')throw Error('E_NATIVE_HOST_SDK');const G=require('godot'),J=require('godot-jsb'),names=J.internal.names,C=${JSON.stringify(config)};
const T=name=>G[names.get_class(name)],call=(object,name,...args)=>object[names.get_member(name)](...args),get=(object,name)=>call(object,'get',name);
const log=(stage,value={})=>console.log('${marker} '+JSON.stringify({stage,capability:C.capability,...value}));
exports.default=class NativeHostProbe extends T('Node2D'){
 _ready(){this.frames=0;this.invoked=false;this.finishing=false;this.cleanupFrames=0;
  this.host=call(T('JavaScriptBridge'),'get_interface','window');
  this.command=call(T('JavaScriptBridge'),'create_callback',T('Callable').create(args=>{try{const message=JSON.parse(call(args,'get',0));if(message.type!=='native-host-probe')return;if(message.operation==='finish')this.finish();else if(message.operation==='clipboard-read'){this.readRequested=true;this.readPolls=0;}}catch(error){log('error',{message:String(error)});this.finish();}}));
  call(this.host,'call','__godotjsSetProjectCommand',this.command);call(this,'set_process_input',true);log('ready',{sdkMode:C.sdkMode});
  if(C.negative)setTimeout(()=>this.invoke('native-delayed-no-gesture'),C.activationDelayMs);
 }
 _input(event){if(this.invoked||C.negative||this.finishing)return;const expected=C.gesture==='keyboard'?'InputEventKey':'InputEventMouseButton';if(call(event,'is_class',expected)&&get(event,'pressed'))this.invoke('native-'+C.gesture+'-input');}
 invoke(origin){if(this.invoked||this.finishing)return;this.invoked=true;log('requested',{origin,requestedAtUnixMs:Date.now()});try{
  if(C.capability==='clipboard')call(T('DisplayServer'),'clipboard_set',C.token);
  else if(C.capability==='fullscreen')call(T('DisplayServer'),'window_set_mode',3);
  else if(C.capability==='pointer-lock')call(T('Input'),'set','mouse_mode',2);
  else if(C.capability==='downloads'){const bytes=new(T('PackedByteArray'))();for(const value of 'download:'+C.token)call(bytes,'push_back',value.charCodeAt(0));call(T('JavaScriptBridge'),'download_buffer',bytes,'native-host-probe.txt','text/plain');}
  else if(C.capability==='url-open')log('native-return',{code:call(T('OS'),'shell_open',C.popupUrl)});
  log('native-invoked');
 }catch(error){log('error',{message:String(error)});}}
 _process(){if(this.done)return;this.frames++;
  if(this.readRequested){const value=call(T('DisplayServer'),'clipboard_get');if(value===C.token||++this.readPolls>120){log('clipboard-native-cache',{matchesSynthetic:value===C.token});this.readRequested=false;}}
  if(this.invoked&&this.frames%15===0)log('native-state',{fullscreen:call(T('DisplayServer'),'window_get_mode')===3,pointerLocked:get(T('Input'),'mouse_mode')===2});
  if(this.finishing&&++this.cleanupFrames>=15){this.done=true;log('finished',{fullscreen:call(T('DisplayServer'),'window_get_mode')===3,pointerLocked:get(T('Input'),'mouse_mode')===2});call(call(this,'get_tree'),'quit',0);}
 }
 finish(){if(this.finishing)return;this.finishing=true;if(C.capability==='fullscreen')call(T('DisplayServer'),'window_set_mode',0);if(C.capability==='pointer-lock')call(T('Input'),'set','mouse_mode',0);this.clear();}
 clear(){if(this.host){call(this.host,'call','__godotjsSetProjectCommand',null);this.host=null;}this.command=null;}
 _exit_tree(){this.clear();}
};`;
 return new Map([
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="Native host capability probe"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[audio]\ndriver/driver="Dummy"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled='+String(naming==='camel')+'\n')],
  ['res://main.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://NativeHostProbe.ts" id="1"]\n[node name="NativeHostProbe" type="Node2D"]\nscript=ExtResource("1")\n')],
  ['res://.godot/GodotJS/.playground/host-vendor.js',sdkVendor],['res://NativeHostProbe.ts',encode('export default class NativeHostProbe {}\n')],['res://.godot/GodotJS/NativeHostProbe.js',encode(source)],['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
 ]);
}

/** A passive wrapper preserves the real API result/rejection. It records only
 * synthetic-token equality, never clipboard contents or pre-existing data. */
export function observeNativeHost({token}){
 const record=value=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;void globalThis.__recordNativeHost?.({...value,documentUrl:location.pathname,at:performance.now(),runId:session?.runId,documentId:session?.documentId,workerId:session?.workerId,runConfigurationHash:session?.runConfigurationHash});};
 const wrap=(object,name,operation,inspect=()=>({}))=>{const native=object?.[name];if(typeof native!=='function')return;object[name]=function(...args){record({operation,phase:'called',activation:navigator.userActivation?.isActive??false,...inspect(args)});try{const result=Reflect.apply(native,this,args);if(result?.then)return result.then(value=>{record({operation,phase:'resolved',...inspect(args,value)});return value;},error=>{record({operation,phase:'rejected',error:String(error?.message??error).slice(0,500)});throw error;});record({operation,phase:'returned'});return result;}catch(error){record({operation,phase:'rejected',error:String(error?.message??error).slice(0,500)});throw error;}};};
 wrap(navigator.clipboard,'writeText','clipboard-write',args=>({matchesSynthetic:args[0]===token}));
 wrap(navigator.clipboard,'readText','clipboard-read',(_args,value)=>({matchesSynthetic:value===token}));
 wrap(HTMLCanvasElement.prototype,'requestFullscreen','fullscreen');wrap(HTMLCanvasElement.prototype,'requestPointerLock','pointer-lock');
 wrap(Document.prototype,'exitFullscreen','exit-fullscreen');wrap(Document.prototype,'exitPointerLock','pointer-unlock');
 wrap(window,'open','url-open',args=>({localTarget:(()=>{try{return new URL(String(args[0]),location.href).hostname===location.hostname;}catch{return false;}})()}));
 for(const type of ['fullscreenchange','pointerlockchange'])document.addEventListener(type,()=>record({operation:type,phase:'state',active:type==='fullscreenchange'?!!document.fullscreenElement:!!document.pointerLockElement}));
 const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),downloadUrls=new Set();
 URL.createObjectURL=function(blob){const url=create(blob);if(blob instanceof Blob&&blob.type==='text/plain'){downloadUrls.add(url);record({operation:'download-url',phase:'created',bytes:blob.size});}return url;};
 URL.revokeObjectURL=function(url){if(downloadUrls.delete(url))record({operation:'download-url',phase:'revoked'});return revoke(url);};
 addEventListener('pagehide',()=>record({operation:'pagehide',phase:'cleanup',fullscreen:!!document.fullscreenElement,pointerLocked:!!document.pointerLockElement,ownedDownloadUrls:downloadUrls.size}));
 setTimeout(()=>record({operation:'activation-after-delay',phase:'state',activation:navigator.userActivation?.isActive??false}),6500);
 record({operation:'inventory',phase:'browser',secureContext:isSecureContext,clipboard:!!navigator.clipboard,fullscreenEnabled:document.fullscreenEnabled,gamepads:Array.from(navigator.getGamepads?.()??[]).filter(Boolean).length,midiApi:typeof navigator.requestMIDIAccess==='function',ttsVoices:globalThis.speechSynthesis?.getVoices?.().length??0,vibrateApi:typeof navigator.vibrate==='function'});
}

/** Observe real channel traffic without starting ports, changing packets or
 * supplying a result. Only fullscreen request metadata/error is retained. */
export function observeNativeHostPorts(){
 const keys=['runId','documentId','workerId','runConfigurationHash'];
 const record=value=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;void globalThis.__recordNativeHost?.({...value,observedAtUnixMs:Date.now(),documentUrl:location.pathname,runId:session?.runId,documentId:session?.documentId,workerId:session?.workerId,runConfigurationHash:session?.runConfigurationHash});};
 const NativeChannel=globalThis.MessageChannel,prototype=globalThis.MessagePort?.prototype,descriptor=prototype&&Object.getOwnPropertyDescriptor(prototype,'postMessage');
 if(typeof NativeChannel!=='function'||typeof descriptor?.value!=='function'){record({operation:'host-port-observer',phase:'unavailable'});return;}
 const pending=new WeakMap();let portSerial=0;
 const envelope=packet=>packet?.protocolVersion===2&&keys.every(key=>typeof packet[key]==='string'&&packet[key])?Object.fromEntries(keys.map(key=>[key,packet[key]])):null;
 const incoming=(port,packet)=>{
  const identity=envelope(packet),command=packet?.command,state=pending.get(port);
  if(!state||!identity||packet.type!=='host-command'||command?.type!=='dom-command'||command.operation!=='fullscreen'||!Number.isSafeInteger(command.requestId)||command.requestId<1||!Number.isSafeInteger(packet.commandSequence)||packet.commandSequence<1)return;
  state.requests.set(command.requestId,{identity,commandSequence:packet.commandSequence});
  record({operation:'host-fullscreen-command',phase:'received',portId:state.id,packet:{...identity,protocolVersion:2,type:'host-command',commandSequence:packet.commandSequence,command:{type:'dom-command',operation:'fullscreen',requestId:command.requestId}}});
 };
 let ObservedChannel;
 ObservedChannel=new Proxy(NativeChannel,{construct(target,args,newTarget){
  const channel=Reflect.construct(target,args,newTarget===ObservedChannel?target:newTarget);
  for(const port of [channel.port1,channel.port2]){pending.set(port,{id:'host-port-'+(++portSerial),requests:new Map()});port.addEventListener('message',event=>incoming(port,event.data));}
  return channel;
 }});
 globalThis.MessageChannel=ObservedChannel;
 Object.defineProperty(prototype,'postMessage',{...descriptor,value:new Proxy(descriptor.value,{apply(target,self,args){
  const result=Reflect.apply(target,self,args); // The native send must succeed first.
  const packet=args[0],identity=envelope(packet),state=pending.get(self),reply=packet?.state,request=state?.requests.get(reply?.requestId);
  if(identity&&request&&packet.type==='host-state'&&reply?.type==='dom-state'&&keys.every(key=>identity[key]===request.identity[key])){
   state.requests.delete(reply.requestId);
   record({operation:'host-fullscreen-reply',phase:'sent',portId:state.id,packet:{...identity,protocolVersion:2,type:'host-state',state:{type:'dom-state',requestId:reply.requestId,...(typeof reply.error==='string'?{error:reply.error.slice(0,1024)}:{})}}});
  }
  return result;
 }})});
}

const controllerSource=`fetch('/__host_options.json').then(r=>r.json()).then(options=>globalThis.__startWorkerFeatureFixture(options)).catch(error=>{globalThis.__recordNativeHostState({bootError:String(error.stack||error)});});
let cursor=0;setInterval(()=>{const state=globalThis.__features;if(!state)return;const events=state.events.slice(cursor);cursor=state.events.length;globalThis.__recordNativeHostState({identity:state.identity,state:state.state,events,exit:state.exit,fullscreen:!!document.fullscreenElement,pointerLocked:!!document.pointerLockElement});},50);`;

const identityKeys=['runId','documentId','workerId','runConfigurationHash'];
export function hasNativeFullscreenDenial(native,browser){
 const requested=native.find(value=>value.stage==='requested'&&value.capability==='fullscreen'&&value.origin==='native-delayed-no-gesture'&&Number.isFinite(value.requestedAtUnixMs));
 if(!requested)return false;
 const valid=value=>value.packet?.protocolVersion===2&&identityKeys.every(key=>typeof value[key]==='string'&&value[key]&&value.packet[key]===value[key]);
 return browser.some(command=>command.operation==='host-fullscreen-command'&&command.phase==='received'&&valid(command)&&command.packet.type==='host-command'&&command.packet.command?.type==='dom-command'&&command.packet.command.operation==='fullscreen'&&Number.isSafeInteger(command.packet.command.requestId)&&command.packet.command.requestId>0&&Number.isSafeInteger(command.packet.commandSequence)&&command.packet.commandSequence>0&&typeof command.portId==='string'&&command.portId&&Number.isFinite(command.observedAtUnixMs)&&command.observedAtUnixMs>=requested.requestedAtUnixMs&&browser.some(reply=>reply.operation==='host-fullscreen-reply'&&reply.phase==='sent'&&valid(reply)&&reply.portId===command.portId&&identityKeys.every(key=>reply[key]===command[key])&&reply.packet.type==='host-state'&&reply.packet.state?.type==='dom-state'&&reply.packet.state.requestId===command.packet.command.requestId&&reply.packet.state.error==='E_WORKER_USER_ACTIVATION_REQUIRED'&&Number.isFinite(reply.observedAtUnixMs)&&reply.observedAtUnixMs>=command.observedAtUnixMs));
}
/** A case cannot pass from browser effects alone or from another fixture's
 * terminal snapshot. Dummy audio still has to retire its real zero-device host. */
export function assertNativeHostSession(session,entry,{presentationBackend,sdkMode}={}){
 assert(session,'Exactly one real fixture Worker session is required');
 for(const key of identityKeys){assert.equal(typeof session[key],'string');assert(session[key]);assert.equal(entry.exit?.[key],session[key],'Terminal identity '+key);}
 assert.match(session.runConfigurationHash,/^[a-f0-9]{64}$/);
 assert.equal(runConfigurationHash(session.runConfiguration),session.runConfigurationHash);
 assert.equal(session.runConfiguration.presentationBackend,presentationBackend);
 assert.equal(session.executionBackend,'worker');assert.equal(session.runtime,'godot');assert.equal(session.buildKey,entry.packSha256);
 assert(entry.states.some(state=>identityKeys.every(key=>state.identity?.[key]===session[key])),'Real controller identity is required');
 assert.equal(session.workerState,'native-exited');assert.equal(session.exit?.engineOutcome?.kind,'native-exit');assert.equal(session.exit.engineOutcome.code,0);
 assert.equal(session.exit.hostCleanup?.status,'complete');assert.equal(entry.exit.hostCleanup?.status,'complete');
 assert.equal(canonical(session.exit.engineOutcome),canonical(entry.exit.engineOutcome));
 assert(['clean-exit',...(entry.negative?['crashed']:[])].includes(session.exit.reason),'Unexpected or forced terminal state');
 assert.equal(session.exit.reason,entry.exit.reason);
 const errors=session.workerErrors??[];
 assert(Array.isArray(errors));assert(errors.every(error=>entry.negative&&String(error).includes('E_WORKER_USER_ACTIVATION_REQUIRED')),'Unexpected Worker error');
 assert.deepEqual(session.glErrors,[]);
 assert.equal(session.audio?.driver,'Dummy');assert.equal(session.audio?.kind,'dummy');assert.equal(session.audio?.closed,true);
 for(const key of ['contextsCreated','contextsClosed','liveNodes','transferredChunksOwned','latePackets'])assert.equal(session.audio[key],0,'Retired Dummy audio '+key);
 assert(entry.native.some(value=>value.stage==='ready'&&value.sdkMode===sdkMode),'Selected candidate SDK must really execute');
 assert.equal(entry.sdkMode,sdkMode);assert.equal(entry.sdkVendor?.sdkMode,sdkMode);assert.match(entry.sdkVendor?.sha256??'',/^[a-f0-9]{64}$/);
}

export function assessNativeHostCase(capability,{negative=false,native=[],browser=[],downloads=[],popupHits=0,exit,logs=[]}={}){
 if(!HOST_CAPABILITIES.includes(capability))throw Error('E_NATIVE_HOST_CASE');
 const requested=native.some(value=>value.stage==='requested'),finished=native.findLast(value=>value.stage==='finished');
 const clean=exit?.reason==='clean-exit'&&exit.engineOutcome?.kind==='native-exit'&&exit.engineOutcome.code===0&&exit.hostCleanup?.status==='complete';
 const denialText=JSON.stringify(exit??{})+' '+logs.join('\n')+' '+native.map(value=>JSON.stringify(value)).join('\n');
 const failed=native.find(value=>value.stage==='error'&&!(negative&&String(value.message).includes('E_WORKER_USER_ACTIVATION_REQUIRED')));
 if(failed)return{status:'failed',reason:failed.message};
 if(negative){
  const denied=capability==='fullscreen'?hasNativeFullscreenDenial(native,browser):/E_WORKER_USER_ACTIVATION_REQUIRED/.test(denialText),actual=browser.filter(value=>value.operation===capability&&value.phase==='called');
  const retired=exit?.hostCleanup?.status==='complete'&&exit.engineOutcome?.kind==='native-exit'&&exit.engineOutcome.code===0&&['clean-exit','crashed'].includes(exit.reason);
  return requested&&denied&&retired&&actual.length===0&&browser.some(value=>value.operation==='activation-after-delay'&&value.activation===false)?{status:'passed',checks:{nativeCalled:true,activationCleared:true,rejectedWithoutBrowserCall:true,nativeExitAndHostCleanup:true}}:{status:'blocked',reason:'Native denial, inactive host, no real privileged call and complete retirement must all be observed'};
 }
 let effect=false;
 if(capability==='clipboard')effect=['clipboard-write','clipboard-read'].every(operation=>browser.some(value=>value.operation===operation&&value.phase==='resolved'&&value.matchesSynthetic===true))&&native.some(value=>value.stage==='clipboard-native-cache'&&value.matchesSynthetic);
 if(capability==='fullscreen')effect=browser.some(value=>value.operation==='fullscreenchange'&&value.active)&&native.some(value=>value.stage==='native-state'&&value.fullscreen)&&browser.some(value=>value.operation==='fullscreenchange'&&!value.active)&&finished?.fullscreen===false;
 if(capability==='pointer-lock')effect=browser.some(value=>value.operation==='pointerlockchange'&&value.active)&&native.some(value=>value.stage==='native-state'&&value.pointerLocked)&&browser.some(value=>value.operation==='pointerlockchange'&&!value.active)&&finished?.pointerLocked===false;
 if(capability==='downloads')effect=downloads.some(value=>value.matchesSynthetic)&&browser.some(value=>value.operation==='download-url'&&value.phase==='created')&&browser.some(value=>value.operation==='download-url'&&value.phase==='revoked');
 if(capability==='url-open')effect=popupHits>0&&browser.some(value=>value.operation==='url-open'&&value.phase==='called'&&value.activation===true&&value.localTarget);
 return requested&&effect&&clean?{status:'passed',checks:{nativeCalled:true,realBrowserEffect:true,actualCleanup:true,nativeExitAndHostCleanup:true}}:{status:'blocked',reason:'Real API effect/state/cleanup not fully observed; this is not original-platform non-support'};
}

/** A ledger-compatible fragment is emitted only from complete observed cases.
 * It is still subject to the independent exact-site acceptance receipt. */
export function buildNativeHostProbe(enriched,capability,entries,producer){
 const supported=entries.length>0&&entries.every(entry=>entry.status==='passed');
 const probe={schemaVersion:3,kind:'worker-capability-probe',testMode:'real-engine',capability,classification:'bridged',status:supported&&enriched.browser?.settingsTier==='default'?'passed':'blocked',executionBackend:'worker',producer,
  observations:{supported,native:entries.flatMap(entry=>entry.native),browser:entries.flatMap(entry=>entry.browser),cases:entries.map(entry=>({negative:entry.negative,status:entry.status,packSha256:entry.packSha256,sdkVendor:entry.sdkVendor,popupHits:entry.popupHits,downloads:entry.downloads,exit:entry.exit}))},
  checks:supported?{realGodotCalls:true,realHostEffects:true,cleanup:true,identityBound:true,selectedSdkExecuted:true}:{},sessions:entries.flatMap(entry=>entry.sessions)};
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash','acceptanceBatchId','browser','runConfiguration','runConfigurationHash','presentationBackend','naming','sdkMode','harness'])probe[key]=enriched[key];
 return probe;
}
export function blockedNativeHostHardware(inventory){
 return ['midi','gamepad','tts','vibrate'].map(capability=>({capability,status:'blocked',classification:'pending-bridge',cause:'device-lifecycle-not-measured',reason:'No actual device/native-event and retirement contract was measured; API presence is not a pass',observations:inventory.map(value=>({gamepads:value.gamepads,midiApi:value.midiApi,ttsVoices:value.ttsVoices,vibrateApi:value.vibrateApi}))}));
}

export async function runNativeHostCapabilities({directory,out='work/worker-migration/native-host-capabilities',timeout=120000,presentationBackend='direct',naming='snake',sdkMode='production',capabilities=HOST_CAPABILITIES}={}){
 directory=path.resolve(directory??defaultTestDirectory({worker:true}));out=path.resolve(out);
 if(out===directory||out.startsWith(directory+path.sep))throw Error('E_HOST_PROBE_OUTPUT_INSIDE_CANDIDATE');
 if(process.env.BROWSER_HEADLESS==='0')throw Error('E_HOST_CLIPBOARD_REQUIRES_ISOLATED_HEADLESS');
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>120000)throw Error('E_HOST_PROBE_TIMEOUT');
 if(!['direct','bitmap'].includes(presentationBackend)||!['snake','camel'].includes(naming)||!['production','development'].includes(sdkMode)||!Array.isArray(capabilities)||!capabilities.length||new Set(capabilities).size!==capabilities.length||capabilities.some(value=>!HOST_CAPABILITIES.includes(value)))throw Error('E_HOST_PROBE_OPTIONS');
 await mkdir(out,{recursive:true});const release=JSON.parse(await readFile(path.join(directory,'engine-release.json'))),site=JSON.parse(await readFile(path.join(directory,'manifest.json'))),candidate=await siteIdentity(directory);assertWorkerCandidate(site,release,candidate.payloads);
 const vendorAsset=release.sdk?.vendors?.[sdkMode];if(!vendorAsset||vendorAsset.sdkMode!==sdkMode||typeof vendorAsset.path!=='string'||vendorAsset.path.includes('..')||path.isAbsolute(vendorAsset.path))throw Error('E_NATIVE_HOST_SDK_DESCRIPTOR');
 const sdkVendor=await readFile(path.join(directory,vendorAsset.path));if(hash(sdkVendor)!==vendorAsset.sha256||sdkVendor.length!==vendorAsset.bytes)throw Error('E_NATIVE_HOST_SDK_HASH');
 const producer={path:producerPath,sha256:hash(await readFile(path.join(repository,producerPath)))},harness=await buildWorkerFeatureHarness(release);
 let browser,pack,bootOptions,active;
 const staticEditor=createStaticServer(directory),preview=createStaticServer(directory),editor=createServer((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');let route;
  if(url.pathname==='/__host_popup'){if(active&&url.searchParams.get('token')===active.token)active.popupHits++;route={type:'text/html',bytes:'<!doctype html><title>Local native capability popup</title><p>Local test only</p>'};}
  else route={ '/__native_host.html':{type:'text/html',bytes:'<!doctype html><link rel="icon" href="data:,"><style>html,body{margin:0}#feature-host{width:320px;height:240px}iframe{width:100%;height:100%;border:0}</style><div id="feature-host"></div><script src="/__native_host.js"></script><script src="/__native_host_controller.js"></script>'},'/__native_host.js':{type:'text/javascript',bytes:harness.bytes},'/__native_host_controller.js':{type:'text/javascript',bytes:controllerSource},'/__host_options.json':{type:'application/json',bytes:JSON.stringify(bootOptions)},'/fixture.pck':{type:'application/octet-stream',bytes:pack}}[url.pathname];
  if(route){response.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);return;}staticEditor.emit('request',request,response);
 });
 const report={schemaVersion:3,kind:'native-worker-host-capabilities',status:'running',testMode:'real-engine',executionBackend:'worker',presentationBackend,naming,sdkMode,producer,harness:harness.identity,controllerSourceSha256:hash(controllerSource),observerSourceSha256:hash(String(observeNativeHost)),hardwareValidated:false,clipboardIsolation:'fresh-headless-browser-context; synthetic overwrite before read; no clipboard contents recorded',cases:[],blockedHardware:[]};
 const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const wait=async(predicate,label,limit=timeout)=>{const end=Date.now()+limit;while(Date.now()<end){const value=predicate();if(value)return value;await sleep(25);}throw Error('E_HOST_PROBE_TIMEOUT: '+label);};
 try{
  await Promise.all([listen(editor),listen(preview)]);const editorRoot=`http://127.0.0.1:${editor.address().port}/`,previewRoot=`http://127.0.0.1:${preview.address().port}/`,releaseContext=await runtimeTestContext(directory,editorRoot),asset=value=>({...value,url:new URL(value.path,previewRoot).href});
  const verified={releaseId:release.id,profile:release.runtimeProfile,releaseContext,engineJs:asset(release.engine.javascript),engineWasm:asset(release.engine.wasm),worklets:(release.engine.worklets??[]).map(value=>({...asset(value),name:value.path.split('/').at(-1)})),runtimeAbi:release.runtimeAbi,runtimeWorker:asset({...site.runtime.assets[site.runtime.entry],path:site.runtime.entry}),runtimeAudioWorklet:asset({...site.runtime.assets[site.runtime.audioWorklet],path:site.runtime.audioWorklet}),allowedOrigins:[new URL(previewRoot).origin]};
  browser=await launchTestBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const capability of capabilities)for(const negative of ['fullscreen','pointer-lock','url-open'].includes(capability)?[false,true]:[false]){
   const token='native-host-'+randomUUID(),popupUrl=new URL('__host_popup?token='+token,editorRoot).href,files=nativeHostFixture({capability,negative,token,popupUrl,naming,sdkMode,sdkVendor,gesture:capability==='fullscreen'?'keyboard':'mouse'});pack=packProject(files,{maxBytes:64*1024*1024}).pack;
   console.error('[native-host] '+capability+' '+(negative?'no-gesture':'trusted-input')+' starting');
   const entry=active={capability,negative,token,native:[],browser:[],downloads:[],popupHits:0,logs:[],states:[],errors:[],consoleErrors:[],warnings:[],popupPages:[],sdkMode,sdkVendor:{...vendorAsset},packSha256:hash(pack),resourceSha256:Object.fromEntries([...files].map(([name,bytes])=>[name,hash(bytes)]))};
   const context=await browser.newContext({viewport:{width:320,height:240},acceptDownloads:true});let page,cdp;
   try{
    await context.route('**/*',route=>{const url=new URL(route.request().url());return !['http:','https:'].includes(url.protocol)||['127.0.0.1','localhost','[::1]'].includes(url.hostname)?route.continue():route.abort('blockedbyclient');});
    await installPassiveRecorder(context,'__recordNativeHost',(_source,value)=>entry.browser.push(value));
    await installPassiveRecorder(context,'__recordNativeHostState',(_source,value)=>{entry.states.push(value);for(const raw of value.events??[]){entry.logs.push(raw);if(/^ERROR(?:\s|:)/.test(raw)&&!(negative&&raw.includes('E_WORKER_USER_ACTIVATION_REQUIRED')))entry.errors.push(raw);if(/(?:^|\n)\s*(?:ERROR\s+)?(?:WARNING:|\[WARN\])/.test(raw))entry.warnings.push(raw);const index=raw.indexOf(marker+' ');if(index>=0){try{entry.native.push(JSON.parse(raw.slice(index+marker.length+1)));}catch{entry.errors.push('Malformed native probe record');}}}if(value.exit)entry.exit=value.exit;if(value.bootError)entry.errors.push(value.bootError);});
    await context.addInitScript(observeNativeHostPorts);await context.addInitScript(observeNativeHost,{token});page=await context.newPage();cdp=await context.newCDPSession(page);
    context.on('page',popup=>{if(popup!==page)entry.popupPages.push(popup);});page.on('pageerror',error=>entry.errors.push(String(error)));page.on('console',event=>{const text=event.text();if(isBrowserConsoleWarning(event.type(),text))entry.warnings.push(text);else if(event.type()==='error'){entry.consoleErrors.push(text);if(!(negative&&text.includes('E_WORKER_USER_ACTIVATION_REQUIRED')))entry.errors.push(text);}});
    page.on('download',download=>{void(async()=>{try{const filename=await download.path(),bytes=await readFile(filename);entry.downloads.push({suggestedFilename:download.suggestedFilename(),sha256:hash(bytes),bytes:bytes.length,matchesSynthetic:bytes.equals(Buffer.from('download:'+token))});}catch(error){entry.errors.push(String(error));}})();});
    bootOptions={release:verified,manifest:{runtime:'godot',engineProfile:release.runtimeProfile,engineReleaseId:release.id,releaseContext},previewUrl:new URL('preview.html',previewRoot).href,presentationBackend,timeout};
    await page.goto(editorRoot+'__native_host.html');await wait(()=>entry.native.some(value=>value.stage==='ready')||entry.exit||entry.errors.length,'native ready');
    const interrupted=()=>entry.exit||entry.errors.length||entry.browser.some(value=>value.phase==='rejected')||(capability==='fullscreen'?hasNativeFullscreenDenial(entry.native,entry.browser):entry.logs.some(value=>value.includes('E_WORKER_USER_ACTIVATION_REQUIRED')));
    const command=async operation=>{const result=await cdp.send('Runtime.evaluate',{expression:'globalThis.__features?.runner.command('+JSON.stringify({type:'native-host-probe',operation})+')',userGesture:false,returnByValue:true});if(result.exceptionDetails||result.result?.value!==true)throw Error('E_HOST_PROBE_COMMAND');};
    if(!entry.exit&&!entry.errors.length){
     if(negative){await wait(()=>interrupted(),'native no-gesture rejection');}
     else{
      const canvas=page.frameLocator('#feature-host iframe').locator('canvas');await canvas.click({position:{x:80,y:80}});if(capability==='fullscreen')await page.keyboard.press('Enter');
      await wait(()=>entry.native.some(value=>value.stage==='requested')||interrupted(),'trusted native input');
      if(capability==='clipboard'){await wait(()=>entry.browser.some(value=>value.operation==='clipboard-write'&&value.phase==='resolved'&&value.matchesSynthetic)||interrupted(),'synthetic clipboard write');if(!interrupted())await command('clipboard-read');await wait(()=>entry.browser.some(value=>value.operation==='clipboard-read'&&value.phase==='resolved'&&value.matchesSynthetic)||interrupted(),'real clipboard read');}
      else if(capability==='downloads')await wait(()=>entry.downloads.length||interrupted(),'actual browser download');
      else if(capability==='url-open')await wait(()=>entry.popupHits||interrupted(),'local native popup request');
      else await wait(()=>entry.native.some(value=>value.stage==='native-state'&&(capability==='fullscreen'?value.fullscreen:value.pointerLocked))||interrupted(),'native state mirror');
     }
     if(!entry.exit)await command('finish');await wait(()=>entry.exit||entry.errors.length,'native exit and host cleanup');
     if(entry.exit)await wait(()=>observedWorkerSessions(browser).some(value=>value.buildKey===entry.packSha256&&value.exit)||entry.errors.length,'terminal host snapshot');
    }
   }catch(error){entry.errors.push(String(error?.stack??error));}
   finally{for(const popup of entry.popupPages)await popup.close().catch(()=>{});await cdp?.detach().catch(()=>{});await context.close();}
   const matches=observedWorkerSessions(browser).filter(value=>value.buildKey===entry.packSha256);entry.sessions=matches;const session=matches.length===1?matches[0]:undefined;
   try{assertNativeHostSession(session,entry,{presentationBackend,sdkMode});}catch(error){entry.errors.push(String(error?.message??error));}
   const result=assessNativeHostCase(capability,{...entry,browser:entry.browser.filter(value=>session&&['runId','documentId','workerId','runConfigurationHash'].every(key=>value[key]===session[key]))});entry.status=entry.errors.length?'failed':entry.warnings.length?'blocked':result.status;entry.reason=entry.warnings.length?'Actual browser warnings prevent strict capability acceptance':result.reason;entry.checks=result.checks??{};delete entry.token;delete entry.popupPages;report.cases.push(entry);
   const progressFile=path.join(out,'report.progress.json'),temporary=progressFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(report,null,2)+'\n');await rename(temporary,progressFile);console.error('[native-host] '+capability+' '+(negative?'no-gesture':'trusted-input')+' '+entry.status+(entry.reason?' '+entry.reason:''));
  }
  const inventory=report.cases.flatMap(entry=>entry.browser).filter(value=>value.operation==='inventory');
  report.blockedHardware=blockedNativeHostHardware(inventory);
  assert.deepEqual(await siteIdentity(directory),candidate,'Candidate bytes must remain unchanged');
  const enriched=await withAcceptanceContext(report,{directory,browser});Object.assign(report,enriched);report.capabilityProbes=[];report.capabilityCases=[];
  for(const capability of capabilities){
   const entries=report.cases.filter(entry=>entry.capability===capability),probe=buildNativeHostProbe(enriched,capability,entries,producer);
   const rawName=capability+'.raw.json',rawBytes=Buffer.from(JSON.stringify({capability,entries},null,2)+'\n');await writeFile(path.join(out,rawName),rawBytes);
   const probeName=capability+'.probe.json',probeBytes=Buffer.from(JSON.stringify(probe,null,2)+'\n');await writeFile(path.join(out,probeName),probeBytes);
   const item={capability,classification:'bridged',status:probe.status,browser:probe.browser,executionBackend:'worker',presentationBackend,naming,sdkMode,sessions:probe.sessions,probe:{path:probeName,sha256:hash(probeBytes),bytes:probeBytes.length},evidence:[{path:rawName,sha256:hash(rawBytes),bytes:rawBytes.length}]};
   // Structural validation uses observed candidate identity and actual producer
   // bytes. This does not manufacture an independent site acceptance receipt.
   if(probe.status==='passed'){
    const sourceContext=process.env.PLAYGROUND_ACCEPTANCE_CONTEXT?JSON.parse(await readFile(process.env.PLAYGROUND_ACCEPTANCE_CONTEXT,'utf8')):{...enriched,testSources:{[producer.path]:producer.sha256}};
    assertWorkerCapabilityProbeReport(sourceContext,item,probe);
   }
   report.capabilityCases.push(item);report.capabilityProbes.push({capability,status:probe.status,path:probeName,sha256:hash(probeBytes)});
  }
  report.status=report.cases.some(entry=>entry.status==='failed')?'failed':'blocked';report.headlessStatus=report.cases.every(entry=>entry.status==='passed')?'passed':'blocked';
 }catch(error){report.status='failed';report.error=String(error?.stack??error);throw error;}
 finally{await browser?.close();await Promise.all([editor,preview].map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
 try{const report=await runNativeHostCapabilities({directory:argument('--site'),out:argument('--out'),timeout:argument('--timeout-ms')===undefined?120000:Number(argument('--timeout-ms')),presentationBackend:argument('--presentation')??process.env.PLAYGROUND_PRESENTATION_BACKEND??'direct',naming:argument('--naming')??'snake',sdkMode:argument('--sdk-mode')??'production'});console.log(JSON.stringify({status:report.status,headlessStatus:report.headlessStatus,hardwareValidated:false}));if(report.headlessStatus!=='passed')process.exitCode=1;}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
