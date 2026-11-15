import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '@godot-js/react-browser/pck';
import {buildWorkerFeatureHarness} from './browser-2d-features-test.mjs';
import {launchTestBrowser,observedWorkerSessions,browserLaunchEvidence,installPassiveRecorder} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runtimeTestContext} from './runtime-test-context.mjs';
import {siteIdentity} from './site-evidence.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),encode=value=>new TextEncoder().encode(value);

// Only the XR device provider is virtual. Godot's real WebXRInterface,
// XROrigin3D/XRCamera3D, GLES3 resources, native callbacks and mesh draw run in
// the production Worker. This is explicitly not a headset acceptance result.
function installDevelopmentXRProvider(){
 const unit=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],projection=[1,0,0,0,0,1,0,0,0,0,-1.0001,-1,0,0,-.100005,0];
 const observation=globalThis.__virtualXR={settingsTier:'virtual-xr-provider',hardwareValidated:false,frames:0,presentedFrames:0,redPixelsPeak:0,initialNoPoseFrames:0,trackingLossFrames:0,recoveredFrames:0,headlessDraws:0,recoveredRedPixelsPeak:0,center:[],errors:[],sessionsStarted:0,sessionsEnded:0};
 addEventListener('click',event=>{if(event.isTrusted&&event.target instanceof HTMLButtonElement&&event.target.textContent==='Enter XR')observation.enterXRButtonClicked=true;},true);
 const publish=()=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;return globalThis.__recordVirtualXR?.({...observation,runId:session?.runId,documentId:session?.documentId,workerId:session?.workerId,runConfigurationHash:session?.runConfigurationHash});};
 let layer,inFrame=false;const noViewerPose=()=>observation.frames<=24||observation.frames>=55&&observation.frames<=68;
 const nativeGetContext=HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext=function(type,settings){const gl=nativeGetContext.call(this,type,settings);if(type==='webgl2'&&settings?.xrCompatible&&gl){gl.makeXRCompatible=async()=>{};const nativeDraw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{if(!inFrame)throw Error('XR host draw escaped the actual provider frame callback');if(noViewerPose()){observation.headlessDraws++;throw Error('XR compositor draw during actual viewer tracking loss');}nativeDraw(...args);};}return gl;};
 class DevelopmentSession extends EventTarget{
  constructor(){super();this.visibilityState='visible';this.enabledFeatures=['hand-tracking'];this.environmentBlendMode='opaque';this.frameRate=90;this.supportedFrameRates=[72,90];this.ended=false;
   this.hand=new Map(Array.from({length:25},(_,index)=>['joint-'+index,{index}]));
   this.inputSources=[{targetRayMode:'tracked-pointer',handedness:'left',targetRaySpace:{kind:'target'},gripSpace:{kind:'grip'},gamepad:{mapping:'xr-standard',buttons:[{value:.5}],axes:[.25]},hand:this.hand}];observation.sessionsStarted++;
  }
  async requestReferenceSpace(){const space=new EventTarget();space.boundsGeometry=[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:0,y:0,z:1}];return space;}
  updateRenderState(){}async updateTargetFrameRate(rate){this.frameRate=rate;}
  cancelAnimationFrame(id){cancelAnimationFrame(id);}
  async end(){if(this.ended)return;this.ended=true;observation.sessionsEnded++;if(layer){if(layer.pendingRead)layer.gl.deleteSync(layer.pendingRead);layer.gl.deleteBuffer(layer.readback);layer.gl.deleteFramebuffer(layer.framebuffer);layer.gl.deleteTexture(layer.texture);}this.dispatchEvent(new Event('end'));await publish();}
  requestAnimationFrame(callback){return requestAnimationFrame(time=>{
   if(this.ended)return;inFrame=true;
   const frame={getViewerPose(){if(!inFrame)throw Error('Expired provider frame');if(noViewerPose())return null;return{transform:{matrix:unit},views:[{transform:{matrix:unit},projectionMatrix:projection}]};},getPose(){return{transform:{matrix:unit}};},fillPoses(_joints,_space,array){for(let index=0;index<25;index++)array.set(unit,index*16);return true;},fillJointRadii(_joints,array){array.fill(.01);return true;}};
   try{observation.frames++;if(observation.frames<=24)observation.initialNoPoseFrames++;else if(observation.frames>=55&&observation.frames<=68)observation.trackingLossFrames++;else if(observation.frames>68)observation.recoveredFrames++;if(observation.frames===15||observation.frames===16){const event=new Event(observation.frames===15?'selectstart':'selectend');Object.assign(event,{frame,inputSource:this.inputSources[0]});this.dispatchEvent(event);}
    callback(time,frame);
    if(layer&&!this.ended){const {gl}=layer;gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);const pixels=layer.pixels;
     if(layer.pendingRead){const status=gl.clientWaitSync(layer.pendingRead,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED){gl.bindBuffer(gl.PIXEL_PACK_BUFFER,layer.readback);gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,pixels);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);gl.deleteSync(layer.pendingRead);layer.pendingRead=null;let red=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index]>180&&pixels[index+1]<80&&pixels[index+2]<80)red++;observation.redPixelsPeak=Math.max(observation.redPixelsPeak,red);if(observation.frames>72)observation.recoveredRedPixelsPeak=Math.max(observation.recoveredRedPixelsPeak,red);if(red)observation.presentedFrames++;observation.center=Array.from(pixels.slice((64*128+64)*4,(64*128+64)*4+4));}else if(status===gl.WAIT_FAILED)throw Error('GPU observation fence failed');}
     if(!layer.pendingRead){gl.bindBuffer(gl.PIXEL_PACK_BUFFER,layer.readback);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,0);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);layer.pendingRead=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!layer.pendingRead)throw Error('GPU observation fence allocation failed');gl.flush();}
     const error=gl.getError();if(error!==gl.NO_ERROR)observation.errors.push('GL '+error);}
    if(observation.frames%10===0)void publish();
   }catch(error){observation.errors.push(String(error.stack||error));}finally{inFrame=false;}
  });}
 }
 Object.defineProperty(navigator,'xr',{configurable:true,value:{isSessionSupported:async mode=>mode==='immersive-ar',requestSession:async mode=>{if(mode!=='immersive-ar')throw Error('Development provider only models mono immersive-ar');if(!navigator.userActivation?.isActive)throw Error('XR request escaped the real trusted Enter XR gesture');observation.requestGestureObserved=true;return new DevelopmentSession();}}});
 globalThis.XRWebGLLayer=class{constructor(_session,gl){this.gl=gl;this.framebufferWidth=this.framebufferHeight=128;this.pixels=new Uint8Array(128*128*4);this.readback=gl.createBuffer();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,this.readback);gl.bufferData(gl.PIXEL_PACK_BUFFER,this.pixels.length,gl.STREAM_COPY);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,128,128);this.framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.texture,0);layer=this;}getViewport(){return{x:0,y:0,width:128,height:128};}};
}

export function nativeXRFixture({initializationDelayMs=6500}={}){
 if(!Number.isSafeInteger(initializationDelayMs)||initializationDelayMs<0||initializationDelayMs>30000)throw Error('E_XR_FIXTURE_INITIALIZATION_DELAY');
 const source=`const G=require('godot'),J=require('godot-jsb'),names=J.internal.names;
const T=name=>G[names.get_class(name)],call=(object,name,...args)=>object[names.get_member(name)](...args),set=(object,name,value)=>call(object,'set',name,value),make=name=>new(T(name))(),check=(value,message)=>{if(!value)throw Error(message);};
exports.default=class NativeXRProbe extends T('Node3D'){
 _ready(){this.started=false;this.frames=0;this.stopping=false;this.cleanupFrames=0;this.signals=[];this.checks={};try{
 this.xr=call(T('XRServer'),'find_interface','WebXR');check(this.xr,'Actual native WebXRInterface');
 const signal=(name,fn)=>{const callback=T('Callable').create(fn);call(this.xr,'connect',name,callback);this.signals.push([name,callback]);};
 signal('session_supported',(mode,supported)=>{try{check(mode==='immersive-ar'&&supported,'Real host support callback');this.checks.supportCallback=true;setTimeout(()=>{try{check(call(this.xr,'initialize'),'Native XR initialize');console.log('NATIVE_XR_REQUESTED');}catch(error){this.finish(error);}},${initializationDelayMs});}catch(error){this.finish(error);}});
 signal('session_started',()=>{try{this.started=true;set(call(this,'get_viewport'),'use_xr',true);this.checks.startedCallback=true;setTimeout(()=>{try{check(this.frames>=3,'SceneTree advances during initial actual no-viewer-pose frames');this.checks.headlessNativeTimer=true;console.log('NATIVE_XR_HEADLESS_TICK '+this.frames);}catch(error){this.finish(error);}},150);console.log('NATIVE_XR_STARTED');}catch(error){this.finish(error);}});
 signal('session_failed',message=>this.finish(Error(message)));signal('selectstart',id=>{this.checks.inputCallback=id===0;});signal('display_refresh_rate_changed',()=>{this.checks.rateCallback=true;});
 const origin=make('XROrigin3D'),camera=make('XRCamera3D');call(origin,'add_child',camera);set(camera,'current',true);call(this,'add_child',origin);
 const mesh=make('MeshInstance3D'),box=make('BoxMesh'),material=make('StandardMaterial3D');set(material,'shading_mode',0);set(material,'albedo_color',new(T('Color'))(1,0,0,1));set(mesh,'mesh',box);set(mesh,'material_override',material);set(mesh,'position',new(T('Vector3'))(0,0,-3));call(this,'add_child',mesh);
 set(this.xr,'session_mode','immersive-ar');set(this.xr,'requested_reference_space_types','local');set(this.xr,'optional_features','hand-tracking');call(this.xr,'is_session_supported','immersive-ar');
 }catch(error){this.finish(error);}}
 _process(){if(this.done)return;if(this.stopping){if(++this.cleanupFrames>=10){this.done=true;console.log('NATIVE_XR_RESULT '+JSON.stringify({status:'passed',checks:this.checks,frames:this.frames}));call(call(this,'get_tree'),'quit',0);}return;}if(!this.started)return;
 try{this.frames++;if(this.frames===20){check(call(this.xr,'get','visibility_state')==='visible','Native visibility mirror');check(call(this.xr,'get_display_refresh_rate')===90,'Native frame rate mirror');check(Number(call(call(this.xr,'get_available_display_refresh_rates'),'size'))===2,'Native supported rates');check(Number(call(call(this.xr,'get_play_area'),'size'))===3,'Native reference bounds');check(call(this.xr,'is_input_source_active',0),'Native input/hand tracking update');call(this.xr,'set_display_refresh_rate',72);this.checks.getterMirrors=true;}
 if(this.frames>=80){check(this.checks.inputCallback,'Native select input signal');check(this.checks.rateCallback,'Native rate-change callback');check(this.checks.headlessNativeTimer,'Native timer while initial viewer pose is absent');for(const [name,callback]of this.signals)call(this.xr,'disconnect',name,callback);this.signals=[];set(call(this,'get_viewport'),'use_xr',false);call(this.xr,'uninitialize');check(!call(this.xr,'is_initialized'),'Native uninitialize');this.checks.uninitialized=true;
 while(call(this,'get_child_count'))call(call(this,'get_child',0),'free');this.xr=null;this.stopping=true;console.log('NATIVE_XR_UNINITIALIZED');}
 }catch(error){this.finish(error);}}
 finish(error){if(this.done)return;this.done=true;console.log('NATIVE_XR_RESULT '+JSON.stringify({status:'failed',error:String(error.stack||error),checks:this.checks}));call(call(this,'get_tree'),'quit',1);}
};`;
 return new Map([
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="Native Worker WebXR acceptance"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0,0,0,1)\n[audio]\ndriver/driver="Dummy"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled=false\n')],
  ['res://main.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://NativeXRProbe.ts" id="1"]\n[node name="NativeXRProbe" type="Node3D"]\nscript=ExtResource("1")\n')],
  ['res://NativeXRProbe.ts',encode('export default class NativeXRProbe {}\n')],['res://.godot/GodotJS/NativeXRProbe.js',encode(source)],['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
 ]);
}

export async function runNativeWorkerXRAcceptance({directory,out,timeout=120000,initializationDelayMs=6500}={}){
 directory=path.resolve(directory);out=path.resolve(out??'work/worker-migration/xr-native');if(out===directory||out.startsWith(directory+path.sep))throw Error('E_XR_OUTPUT_INSIDE_CANDIDATE');await mkdir(out,{recursive:true});
 const release=JSON.parse(await readFile(path.join(directory,'engine-release.json'),'utf8')),site=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));assert.equal(release.runtimeProfile,'full-engine-v1');assert.equal(site.schemaVersion,3);
 const candidate=await siteIdentity(directory),harness=await buildWorkerFeatureHarness(release),files=nativeXRFixture({initializationDelayMs}),pack=packProject(files).pack;
 let bootOptions;
 const staticEditor=createStaticServer(directory),preview=createStaticServer(directory),editor=createServer((request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname,route=pathname==='/__native_xr.html'?{type:'text/html',bytes:'<!doctype html><link rel="icon" href="data:,"><style>html,body{margin:0}#feature-host{width:320px;height:240px}iframe{width:100%;height:100%;border:0}</style><div id="feature-host"></div><script src="/__native_xr.js"></script><script src="/__native_xr_boot.js"></script>'}:pathname==='/__native_xr.js'?{type:'text/javascript',bytes:harness.bytes}:pathname==='/__native_xr_options.json'?{type:'application/json',bytes:JSON.stringify(bootOptions)}:pathname==='/__native_xr_boot.js'?{type:'text/javascript',bytes:'const timer=setInterval(()=>{const state=globalThis.__features;if(state?.events.some(value=>value.includes("NATIVE_XR_REQUESTED"))){clearInterval(timer);void globalThis.__recordXRBootState({requested:true});}else if(typeof state?.exitCode==="number"){clearInterval(timer);void globalThis.__recordXRBootState({error:JSON.stringify(state.events)});}},20);fetch("/__native_xr_options.json").then(response=>response.json()).then(options=>globalThis.__startWorkerFeatureFixture(options)).catch(error=>{clearInterval(timer);void globalThis.__recordXRBootState({error:String(error.stack||error)});});'}:pathname==='/fixture.pck'?{type:'application/octet-stream',bytes:pack}:null;
  if(route)response.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);else staticEditor.emit('request',request,response);
 });
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;
 const report={schemaVersion:1,suite:'native-worker-webxr',status:'running',settingsTier:'virtual-xr-provider',hardwareValidated:false,initializationDelayMs,provider:'mono-immersive-ar-with-controller-and-hands',providerSourceSha256:hash(String(installDevelopmentXRProvider)),candidateId:candidate.candidateId,siteHash:candidate.siteHash,engineReleaseId:release.id,harness:harness.identity,packSha256:hash(pack),sourceAssets:Object.fromEntries([...files].map(([name,bytes])=>[name,hash(bytes)])),observations:[],errors:[],warnings:[]};
 try{await Promise.all([listen(editor),listen(preview)]);const editorRoot=`http://127.0.0.1:${editor.address().port}/`,previewRoot=`http://127.0.0.1:${preview.address().port}/`,releaseContext=await runtimeTestContext(directory,editorRoot),asset=value=>({...value,url:new URL(value.path,previewRoot).href});
  const verified={releaseId:release.id,profile:release.runtimeProfile,releaseContext,engineJs:asset(release.engine.javascript),engineWasm:asset(release.engine.wasm),worklets:(release.engine.worklets??[]).map(value=>({...asset(value),name:value.path.split('/').at(-1)})),runtimeAbi:release.runtimeAbi,runtimeWorker:asset({...site.runtime.assets[site.runtime.entry],path:site.runtime.entry}),runtimeAudioWorklet:asset({...site.runtime.assets[site.runtime.audioWorklet],path:site.runtime.audioWorklet}),allowedOrigins:[new URL(previewRoot).origin]};
  browser=await launchTestBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});const context=await browser.newContext({viewport:{width:320,height:240}});
  report.browser={name:browser.browserType().name(),version:browser.version(),...browserLaunchEvidence(browser)};
  let resolveRequested,rejectRequested;const requested=new Promise((resolve,reject)=>{resolveRequested=resolve;rejectRequested=reject;});void requested.catch(()=>{});
  await installPassiveRecorder(context,'__recordXRBootState',(_source,value)=>{if(value.error)rejectRequested(Error(value.error));else if(value.requested)resolveRequested();});
  await installPassiveRecorder(context,'__recordVirtualXR',(_source,value)=>report.observations.push(value));await context.addInitScript(installDevelopmentXRProvider);page=await context.newPage();page.on('pageerror',error=>report.errors.push(String(error)));page.on('console',event=>{if(event.type()==='error')report.errors.push(event.text());if(event.type()==='warning')report.warnings.push(event.text());});
  bootOptions={release:verified,manifest:{runtime:'godot',engineProfile:release.runtimeProfile,engineReleaseId:release.id,releaseContext},previewUrl:new URL('preview.html',previewRoot).href,presentationBackend:'direct',timeout};
  await page.goto(editorRoot+'__native_xr.html');let requestedTimer;try{await Promise.race([requested,new Promise((_,reject)=>{requestedTimer=setTimeout(()=>reject(Error('Native XR initialization was not requested')),timeout);})]);}finally{clearTimeout(requestedTimer);}await new Promise(resolve=>setTimeout(resolve,300));
  if(report.observations.some(value=>value.sessionsStarted>0))report.activationBranch='already-active-real-gesture';
  else{const frame=page.frameLocator('#feature-host iframe');await frame.getByRole('button',{name:'Enter XR',exact:true}).click({timeout});report.activationBranch='dedicated-enter-xr-button';}
  if(initializationDelayMs>=6500)assert.equal(report.activationBranch,'dedicated-enter-xr-button','Delayed fixture explicitly verifies the dedicated trusted-gesture branch');
  await page.waitForFunction(()=>globalThis.__features.exitCode!==null,null,{timeout});report.native=await page.evaluate(()=>({events:__features.events,warnings:__features.warnings,exitCode:__features.exitCode,exit:__features.exit,identity:__features.identity}));
  assert.equal(report.native.exitCode,0,JSON.stringify(report.native));assert.equal(report.native.exit.reason,'clean-exit');assert.equal(report.native.exit.engineOutcome.kind,'native-exit');assert.equal(report.native.exit.hostCleanup.status,'complete');
  const result=report.native.events.find(value=>value.includes('NATIVE_XR_RESULT '));assert(result);report.result=JSON.parse(result.slice(result.indexOf('NATIVE_XR_RESULT ')+'NATIVE_XR_RESULT '.length));assert.equal(report.result.status,'passed');assert(['supportCallback','startedCallback','getterMirrors','inputCallback','rateCallback','headlessNativeTimer','uninitialized'].every(name=>report.result.checks[name]===true));
  report.nativeErrorLines=report.native.events.filter(value=>/^ERROR /.test(value));report.nativeWarningLines=report.native.events.filter(value=>/(?:^|\n)\s*(?:ERROR\s+)?(?:WARNING:|\[WARN\])/.test(value));assert.deepEqual(report.nativeErrorLines,[]);assert.deepEqual(report.nativeWarningLines,[]);assert.deepEqual(report.native.warnings,[]);
  const observed=report.observations.findLast(value=>value.sessionsEnded===1);assert(observed,'Actual provider session must end');for(const key of ['runId','documentId','workerId','runConfigurationHash'])assert.equal(observed[key],report.native.identity[key]);assert.equal(observed.requestGestureObserved,true);assert(observed.redPixelsPeak>100,'The actual native mesh must reach the XR layer framebuffer');assert(observed.presentedFrames>10);assert.equal(observed.initialNoPoseFrames,24);assert.equal(observed.trackingLossFrames,14);assert(observed.recoveredFrames>5);assert.equal(observed.headlessDraws,0);assert(observed.recoveredRedPixelsPeak>100,'Native red mesh must recover after a second real tracking loss');assert.deepEqual(observed.errors,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.warnings,[]);
  if(initializationDelayMs>=6500)assert.equal(observed.enterXRButtonClicked,true);
  report.session=observedWorkerSessions(browser).find(value=>value.runId===report.native.identity.runId);assert.equal(report.session?.xr?.sessionEnded,true);assert.deepEqual(await siteIdentity(directory),candidate);report.status='passed';
 }catch(error){report.status='failed';report.error=String(error.stack??error);report.failureState=await page?.evaluate(()=>({events:globalThis.__features?.events,exit:globalThis.__features?.exit,state:globalThis.__features?.state})).catch(()=>undefined);throw error;}finally{await browser?.close();await Promise.all([editor,preview].map(server=>new Promise(resolve=>server.close(resolve))));await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};try{const report=await runNativeWorkerXRAcceptance({directory:argument('--site')??process.env.PLAYGROUND_TEST_DIRECTORY,out:argument('--out')});console.log(JSON.stringify({status:report.status,hardwareValidated:false,settingsTier:report.settingsTier}));}catch(error){console.error(error.stack??error);process.exitCode=1;}}
