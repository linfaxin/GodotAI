import assert from 'node:assert/strict';
import test from 'node:test';
import {createWorkerXRBridge} from '../dist/worker-xr.js';
import {createWorkerXRHost} from '../dist/worker-xr-host.js';
import {validXRFrame,validXRInputFrame,workerXRLimits} from '../dist/worker-xr-protocol.js';
const identity={runId:'xr-run',documentId:'xr-document',workerId:'xr-worker',runConfigurationHash:'a'.repeat(64),revision:1,generation:1,buildKey:'xr-build'};
const envelope=fields=>({...identity,protocolVersion:2,...fields});
const matrix=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const observed=(frameId=1)=>({epoch:1,frameId,time:10,timeOrigin:performance.timeOrigin,layerBytes:32,head:matrix(),views:[0,1].map(index=>({transform:matrix(),projection:matrix(),viewport:{x:index*2,y:0,width:2,height:2}})),inputs:[],visibility:'visible',bounds:[],frameRate:90,supportedFrameRates:[72,90]});
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
function port(){return{onmessage:null,sent:[],closed:false,start(){},close(){this.closed=true;},postMessage(message){this.sent.push(message);},receive(fields){this.onmessage?.({data:envelope(fields)});}};}
function fakeGL(){
 const gl={calls:[],textures:[],deleted:[],scissor:true,state:new Map()};let id=0;
 for(const name of ['MAX_TEXTURE_SIZE','MAX_ARRAY_TEXTURE_LAYERS','TEXTURE_2D_ARRAY','TEXTURE_2D','TEXTURE_BINDING_2D_ARRAY','TEXTURE_BINDING_2D','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','NEAREST','LINEAR','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','RGBA8','RGBA','UNSIGNED_BYTE','DEPTH_COMPONENT24','READ_FRAMEBUFFER_BINDING','DRAW_FRAMEBUFFER_BINDING','READ_BUFFER','SCISSOR_TEST','READ_FRAMEBUFFER','DRAW_FRAMEBUFFER','FRAMEBUFFER','COLOR_ATTACHMENT0','FRAMEBUFFER_COMPLETE','COLOR_BUFFER_BIT','BACK','VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','TEXTURE0','DEPTH_TEST','STENCIL_TEST','BLEND','TRIANGLE_STRIP'])gl[name]=++id;
 gl.state.set(gl.READ_FRAMEBUFFER_BINDING,{old:'read'});gl.state.set(gl.DRAW_FRAMEBUFFER_BINDING,{old:'draw'});gl.state.set(gl.READ_BUFFER,gl.BACK);
 Object.assign(gl,{getParameter:key=>key===gl.MAX_TEXTURE_SIZE?8192:key===gl.MAX_ARRAY_TEXTURE_LAYERS?4:gl.state.get(key)??null,
  createTexture(){const texture={id:++id};this.textures.push(texture);return texture;},deleteTexture(texture){this.deleted.push(texture);},bindTexture(){},texParameteri(){},texStorage2D(){},texStorage3D(){},
  createFramebuffer:()=>({id:++id}),deleteFramebuffer(){},isEnabled:()=>gl.scissor,disable(value){if(value===this.SCISSOR_TEST)this.scissor=false;},enable(value){if(value===this.SCISSOR_TEST)this.scissor=true;},
  bindFramebuffer(target,value){if(target===this.READ_FRAMEBUFFER)this.state.set(this.READ_FRAMEBUFFER_BINDING,value);else this.state.set(this.DRAW_FRAMEBUFFER_BINDING,value);},readBuffer(value){this.state.set(this.READ_BUFFER,value);},
  framebufferTextureLayer(...args){this.calls.push(['layer',...args]);},framebufferTexture2D(...args){this.calls.push(['2d',...args]);},checkFramebufferStatus(){return this.FRAMEBUFFER_COMPLETE;},blitFramebuffer(...args){this.calls.push(['blit',...args]);},flush(){},
  createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,deleteShader(){},createProgram:()=>({}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,deleteProgram(){},createVertexArray:()=>({}),deleteVertexArray(){},getUniformLocation:()=>({}),
  makeXRCompatible:async()=>{},activeTexture(){},texImage2D(){},useProgram(){},bindVertexArray(){},viewport(){},uniform4f(){},drawArrays(){},
 });return gl;
}
function workerFixture(limits){const channel=port(),gl=fakeGL(),nativeTextures=new Map(),errors=[],changes=[];let next=0;
 const canvas={width:320,height:200,transferToImageBitmap(){return{width:this.width,height:this.height,close(){}};}};
 const bridge=createWorkerXRBridge(channel,{identity,canvas,limits,onError:error=>errors.push(error),onActiveChange:value=>changes.push(value)});
 const callbacks={started(){},ended(){},failed(){},input(){},simple(){},wakeMainLoop(){}};
 const graphics={gl,registerTexture(texture){const key=++next;nativeTextures.set(key,texture);return key;},releaseTexture(key,texture){nativeTextures.delete(key);gl.deleteTexture(texture);}};
 const initialize=()=>bridge.initialize({mode:'immersive-vr',requiredFeatures:[],optionalFeatures:[],referenceSpaces:['local']},callbacks,graphics);
 return{bridge,channel,gl,canvas,callbacks,graphics,nativeTextures,errors,changes,initialize};
}

test('XR pose DTOs bound all view, controller, hand and numeric data',()=>{
 const frame=observed(),limits=workerXRLimits();assert.equal(validXRFrame(frame,limits),true);
 for(const changed of [{...frame,head:[NaN,...matrix().slice(1)]},{...frame,views:[...frame.views,...frame.views,...frame.views]},
  {...frame,views:[{...frame.views[0],viewport:{x:0,y:0,width:0,height:2}}]},{...frame,bounds:new Array(771).fill(0)}])assert.equal(validXRFrame(changed,limits),false);
 assert.throws(()=>workerXRLimits({maxViews:5}),/E_XR_LIMIT/);
});

test('Worker exposes real local native GL handles and GPU blits one atlas under a single frame credit',async()=>{
 const f=workerFixture();try{f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  assert.equal(f.bridge.active,true);assert.equal(f.bridge.getViewCount(),2);assert.deepEqual(f.bridge.getRenderTargetSize(),[2,2]);assert.equal(f.nativeTextures.has(f.bridge.getColorTexture()),true);assert.equal(f.nativeTextures.has(f.bridge.getDepthTexture()),true);
  let renders=0;const render=()=>{renders++;f.bridge.requestAnimationFrame(render);};f.bridge.requestAnimationFrame(render);await flush();
  assert.equal(renders,1,'next native RAF must not recursively consume the current ticket');assert.equal(f.gl.calls.filter(call=>call[0]==='blit').length,2);
  assert.equal(f.channel.sent.filter(message=>message.type==='xr-bitmap').length,1);assert.equal(f.bridge.snapshot().outstandingFrames,1);assert.equal(f.canvas.width,4);assert.equal(f.gl.scissor,true);assert.equal(f.gl.state.get(f.gl.READ_BUFFER),f.gl.BACK);
  f.channel.receive({type:'xr-frame',epoch:1,frame:observed(2)});await flush();assert.equal(renders,1);
  f.channel.receive({type:'xr-frame-ack',epoch:0,frameId:1});assert.equal(f.bridge.snapshot().outstandingFrames,1);
  f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:1});f.channel.receive({type:'xr-frame',epoch:1,frame:observed(2)});await flush();assert.equal(renders,2);
  f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:2});f.channel.receive({type:'xr-frame',epoch:1,frame:observed(1)});await flush();assert.equal(renders,2,'old frame replay must not render');
  assert.deepEqual(f.errors,[]);
 }finally{f.bridge.dispose();}assert.equal(f.nativeTextures.size,0);assert.equal(f.canvas.width,320);assert.deepEqual(f.changes,[true,false]);
});

test('cancelled background XR dispatch rechecks the epoch before touching native engine or GL',async()=>{
 const f=workerFixture(),tasks=[];let cancelled=0,renders=0;
 try{f.bridge.setFrameDispatcher(task=>{tasks.push(task);return()=>{cancelled++;};});f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  f.bridge.requestAnimationFrame(()=>renders++);assert.equal(tasks.length,1);f.bridge.uninitialize();tasks[0]();await flush();
  assert.equal(renders,0);assert.equal(cancelled,1);assert.equal(f.channel.sent.filter(message=>message.type==='xr-bitmap').length,0);assert.equal(f.bridge.getTransformForView(-1),null);
 }finally{f.bridge.dispose();}
});

test('bounded view-count cache preserves native handles and the first target dimensions across changes',async()=>{
 const f=workerFixture();try{f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  const stereo=f.bridge.getColorTexture(),render=()=>{f.bridge.requestAnimationFrame(render);};f.bridge.requestAnimationFrame(render);await flush();f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:1});
  const mono={...observed(2),views:[{...observed().views[0],viewport:{x:0,y:0,width:4,height:4}}]};f.channel.receive({type:'xr-frame',epoch:1,frame:mono});await flush();
  assert.notEqual(f.bridge.getColorTexture(),stereo);assert.deepEqual(f.bridge.getRenderTargetSize(),[2,2]);assert.equal(f.nativeTextures.size,4);f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:2});
  f.channel.receive({type:'xr-frame',epoch:1,frame:observed(3)});await flush();assert.equal(f.bridge.getColorTexture(),stereo);assert.equal(f.nativeTextures.size,4);assert.deepEqual(f.bridge.snapshot().cachedViewCounts,[2,1]);assert.deepEqual(f.errors,[]);
 }finally{f.bridge.dispose();}assert.equal(f.nativeTextures.size,0);
});

test('Worker disposal wakes the native main loop so a queued quit can finish outside XR',()=>{
 const f=workerFixture();let wakes=0;f.callbacks.wakeMainLoop=()=>wakes++;
 f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});assert.equal(wakes,1);
 f.bridge.dispose();assert.equal(wakes,2);f.bridge.dispose();assert.equal(wakes,2);
});

test('XR input event ABI sees its actual event-frame mirror and restores the last render pose',()=>{
 const f=workerFixture();try{let seen;f.callbacks.input=(type,id)=>{seen={type,id,input:f.bridge.getInputSource(id)};};f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  const frame={...observed(2),inputs:[{id:0,target:matrix(),targetRayMode:2,touchIndex:-1,grip:matrix(),standardMapping:true,buttons:[.5],axes:[.25],handJoints:new Array(400).fill(0),handRadii:new Array(25).fill(.01)}]};
  f.channel.receive({type:'xr-input-event',epoch:1,eventType:0,inputId:0,frame});assert.equal(seen.type,0);assert.equal(seen.input.buttons[0],.5);assert.equal(seen.input.handJoints.length,400);assert.equal(f.bridge.getInputSource(0),null);
 }finally{f.bridge.dispose();}
});

test('select and squeeze events retain actual controller pose during head tracking loss without inventing a viewer',()=>{
 const f=workerFixture(),seen=[];try{
  f.callbacks.input=(type,id)=>seen.push({type,id,target:f.bridge.getInputSource(id)?.target,head:f.bridge.getTransformForView(-1),projection:f.bridge.getProjectionForView(0)});
  f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  const target=matrix();target[12]=.75;const frame={...observed(2),head:null,views:[],inputs:[{id:0,target,targetRayMode:2,touchIndex:-1,grip:null,standardMapping:true,buttons:[1],axes:[0],handJoints:null,handRadii:null}]};
  assert.equal(validXRFrame(frame,workerXRLimits()),false);assert.equal(validXRInputFrame(frame,workerXRLimits()),true);
  for(let eventType=0;eventType<4;eventType++)f.channel.receive({type:'xr-input-event',epoch:1,eventType,inputId:0,frame});
  assert.deepEqual(seen.map(value=>value.type),[0,1,2,3]);assert(seen.every(value=>value.target[12]===.75&&value.head===null&&value.projection===null));
  assert.deepEqual(f.bridge.getTransformForView(-1),matrix());assert.equal(f.bridge.getInputSource(0),null);
 }finally{f.bridge.dispose();}
});

async function hostFixture({acquire,viewerPose=true,endReady,onGesture,onActiveChange,compatible,limits,layerWidth=4,layerHeight=2}={}){
 const saved=Object.fromEntries(['navigator','document','XRWebGLLayer'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),channel=port(),gl=fakeGL(),buttons=[],errors=[];let requests=0,frameCallback;
 if(compatible)gl.makeXRCompatible=()=>compatible;
 const space=new EventTarget();space.boundsGeometry=[];
 const session=new EventTarget();Object.assign(session,{inputSources:[],visibilityState:'visible',enabledFeatures:['local-floor'],environmentBlendMode:'opaque',frameRate:90,supportedFrameRates:[90],endCalls:0,
  updateRenderState(){},requestReferenceSpace:async()=>space,requestAnimationFrame(callback){frameCallback=callback;return 1;},cancelAnimationFrame(){frameCallback=undefined;},async end(){this.endCalls++;if(endReady)await endReady;},});
 const activation={isActive:false};Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userActivation:activation,xr:{isSessionSupported:async()=>true,requestSession(){requests++;return typeof acquire==='function'?acquire():acquire??Promise.resolve(session);}}}});
 Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{append(button){buttons.push(button);}},createElement(name){if(name==='canvas')return{getContext:()=>gl};return{style:{},remove(){this.removed=true;}};}}});
 Object.defineProperty(globalThis,'XRWebGLLayer',{configurable:true,value:class{constructor(){this.framebuffer={};this.framebufferWidth=layerWidth;this.framebufferHeight=layerHeight;}getViewport(view){return{x:view.index*2,y:0,width:2,height:2};}}});
 const host=createWorkerXRHost(channel,{identity,limits,onGesture,onActiveChange,onError:value=>errors.push(value)});
 const initialize=()=>channel.receive({type:'xr-initialize',epoch:1,settings:{mode:'immersive-vr',requiredFeatures:[],optionalFeatures:[],referenceSpaces:['local']}});
 const frame=()=>frameCallback?.(10,{getViewerPose:()=>viewerPose?{transform:{matrix:matrix()},views:[0,1].map(index=>({index,transform:{matrix:matrix()},projectionMatrix:matrix()}))}:null,getPose:()=>null});
 return {host,channel,gl,session,buttons,activation,errors,initialize,frame,get requests(){return requests;},async cleanup(){try{await host.dispose();}finally{for(const [key,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}};
}

test('normal XR end cancels a pending refresh-rate request without a fatal Host error',async()=>{
 const gate=deferred(),f=await hostFixture();try{
  f.session.updateTargetFrameRate=()=>gate.promise;f.session.end=async()=>{f.session.endCalls++;gate.reject(new DOMException('session ended','InvalidStateError'));};
  f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();
  f.channel.receive({type:'xr-update-rate',epoch:1,rate:90});await flush();assert.equal(f.host.snapshot().pendingRateOperations,1);
  f.channel.receive({type:'xr-end',epoch:1});await flush();assert.deepEqual(f.errors,[]);assert.equal(f.host.snapshot().pendingRateOperations,0);assert.equal(f.channel.sent.filter(m=>m.type==='xr-ended').length,1);
 }finally{gate.resolve();await f.cleanup();}
});
test('old refresh-rate rejection cannot fail a new session and current failures remain observable',async()=>{
 const gate=deferred(),queue=[],f=await hostFixture({acquire:()=>Promise.resolve(queue.shift())});
 const current=new EventTarget();Object.assign(current,f.session);f.session.updateTargetFrameRate=()=>gate.promise;queue.push(f.session,current);
 try{
  f.activation.isActive=true;f.initialize();await flush();f.channel.receive({type:'xr-update-rate',epoch:1,rate:90});await flush();
  f.channel.receive({type:'xr-end',epoch:1});f.channel.receive({type:'xr-initialize',epoch:3,settings:{mode:'immersive-vr',requiredFeatures:[],optionalFeatures:[],referenceSpaces:['local']}});await flush();assert.equal(f.host.active,true);
  gate.reject(Error('retired rate failure'));await flush();assert.deepEqual(f.errors,[]);assert.equal(f.host.active,true);
  current.updateTargetFrameRate=()=>Promise.reject(Error('current rate failure'));f.channel.receive({type:'xr-update-rate',epoch:3,rate:90});await flush();assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/current rate failure/);
 }finally{gate.resolve();await f.cleanup();}
});
test('refresh-rate invocation is fenced before its microtask and pending calls retain bounded ownership',async()=>{
 const gate=deferred(),f=await hostFixture({limits:{maxPendingQueries:1}});let calls=0;
 try{
  f.session.updateTargetFrameRate=()=>{calls++;return gate.promise;};f.activation.isActive=true;f.initialize();await flush();
  for(let i=0;i<16;i++)f.channel.receive({type:'xr-update-rate',epoch:1,rate:90});await flush();assert.equal(calls,1);assert.equal(f.host.snapshot().pendingRateOperations,1);
  let finished=false;const closing=f.host.dispose().then(()=>{finished=true;});await flush();assert.equal(finished,false);gate.resolve();await closing;
 }finally{gate.resolve();await f.cleanup();}
 const after=await hostFixture();let lateCalls=0;
 try{after.session.updateTargetFrameRate=async()=>{lateCalls++;};after.activation.isActive=true;after.initialize();await flush();after.channel.receive({type:'xr-update-rate',epoch:1,rate:90});await after.host.dispose();assert.equal(lateCalls,0);}finally{await after.cleanup();}
});
test('support timeout does not retire pending browser-query credit and disposal fences invocation',async()=>{
 const gate=deferred(),f=await hostFixture({limits:{maxPendingQueries:1,setupTimeoutMs:5}});let calls=0;
 try{
  navigator.xr.isSessionSupported=()=>{calls++;return gate.promise;};f.channel.receive({type:'xr-support-query',requestId:1,mode:'immersive-vr'});await flush();await new Promise(r=>setTimeout(r,10));
  assert.equal(f.channel.sent.filter(m=>m.type==='xr-support-result').length,1);assert.equal(f.host.snapshot().pendingSupportOperations,1);
  f.channel.receive({type:'xr-support-query',requestId:2,mode:'immersive-vr'});await flush();assert.equal(calls,1);let done=false;const closing=f.host.dispose().then(()=>{done=true;});await flush();assert.equal(done,false);gate.resolve(false);await closing;
 }finally{gate.resolve(false);await f.cleanup();}
 const after=await hostFixture();let lateCalls=0;try{navigator.xr.isSessionSupported=async()=>{lateCalls++;return true;};after.channel.receive({type:'xr-support-query',requestId:1,mode:'immersive-vr'});await after.host.dispose();assert.equal(lateCalls,0);}finally{await after.cleanup();}
});
test('a late support result cannot consume a reused logical query after its timeout',async()=>{
 const first=deferred(),second=deferred(),f=await hostFixture({limits:{maxPendingQueries:2,setupTimeoutMs:5}});let calls=0;
 try{
  navigator.xr.isSessionSupported=()=>++calls===1?first.promise:second.promise;f.channel.receive({type:'xr-support-query',requestId:1,mode:'immersive-vr'});await flush();await new Promise(r=>setTimeout(r,10));
  f.channel.receive({type:'xr-support-query',requestId:1,mode:'immersive-vr'});await flush();first.resolve(true);await flush();assert.equal(f.channel.sent.filter(m=>m.type==='xr-support-result').length,1);
  second.resolve(false);await flush();const results=f.channel.sent.filter(m=>m.type==='xr-support-result');assert.equal(results.length,2);assert.equal(results[1].supported,false);
 }finally{first.resolve(false);second.resolve(false);await f.cleanup();}
});

for(const outcome of ['resolve','reject'])test(`retired XR reference ${outcome} cannot mutate or request fallback spaces in the new session`,async()=>{
 const old=deferred(),queue=[],f=await hostFixture({acquire:()=>Promise.resolve(queue.shift())});
 const calls=[],currentSpace=new EventTarget();currentSpace.boundsGeometry=[];let nextFrame;
 const current=new EventTarget();Object.assign(current,f.session,{requestReferenceSpace:async()=>currentSpace,requestAnimationFrame(callback){nextFrame=callback;return 1;},cancelAnimationFrame(){nextFrame=undefined;}});
 f.session.requestReferenceSpace=type=>{calls.push(type);return old.promise;};queue.push(f.session,current);
 const initialize=epoch=>f.channel.receive({type:'xr-initialize',epoch,settings:{mode:'inline',requiredFeatures:[],optionalFeatures:[],referenceSpaces:['local','viewer']}});
 try{
  initialize(1);await flush();assert.deepEqual(calls,['local']);f.channel.receive({type:'xr-end',epoch:1});initialize(3);await flush();assert.equal(f.host.active,true);
  if(outcome==='resolve')old.resolve(new EventTarget());else old.reject(Error('old reference cancelled'));
  await flush();assert.deepEqual(calls,['local'],'cancellation also fences fallback attempts');
  nextFrame(10,{getViewerPose(space){assert.equal(space,currentSpace);return null;},getPose(){return null;}});
  assert.equal(f.host.active,true);assert.equal(f.channel.sent.filter(m=>m.type==='xr-failed').length,0);
 }finally{old.resolve();await f.cleanup();}
});

test('XR rejects a Host layer above byte budget before announcing the session active',async()=>{
 const f=await hostFixture({limits:{maxBytes:1048576},layerWidth:1024,layerHeight:1024});
 try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();
  assert.equal(f.host.active,false);assert.equal(f.channel.sent.filter(m=>m.type==='xr-started').length,0);assert.match(f.channel.sent.find(m=>m.type==='xr-failed').message,/PRESENTATION_BUDGET/);assert.equal(f.session.endCalls,1);assert.equal(f.host.snapshot().gpuBytes,0);
 }finally{await f.cleanup();}
});
test('Worker XR admission includes actual Host layer and reserved canvas bytes before texture allocation',()=>{
 const f=workerFixture({maxBytes:260223});
 try{f.initialize();const frame={...observed(),layerBytes:4096};f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame});
  assert.equal(f.bridge.active,false);assert.equal(f.nativeTextures.size,0);assert.match(f.errors[0].message,/PRESENTATION_BUDGET/);
 }finally{f.bridge.dispose();}
});
test('Host XR checks combined Worker, bitmap, upload and actual layer capacities on arrival',async()=>{
 const f=await hostFixture({limits:{maxBytes:1048576},layerWidth:64,layerHeight:64});let closed=0;
 try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();f.frame();const frame=f.channel.sent.find(m=>m.type==='xr-frame');
  f.channel.receive({type:'xr-bitmap',epoch:1,frameId:frame.frame.frameId,width:4,height:2,viewCount:2,workerBytes:1048576-16384-32,bitmap:{width:4,height:2,close(){closed++;}}});
  assert.equal(closed,1);assert.equal(f.host.active,false);assert.match(f.channel.sent.find(m=>m.type==='xr-failed').message,/PRESENTATION_BUDGET/);
 }finally{await f.cleanup();}
});

test('immersive XR uses only its dedicated Enter XR button and cancellation removes it',async()=>{
 const f=await hostFixture();try{f.initialize();await flush();assert.equal(f.requests,0);assert.equal(f.buttons.length,1);assert.equal(f.buttons[0].textContent,'Enter XR');assert.equal(f.host.requestFromGesture(),false);assert.equal(f.requests,0);
  await f.host.dispose();assert.equal(f.buttons[0].removed,true);assert.equal(f.requests,0);
 }finally{await f.cleanup();}
});

test('Enter XR synchronously resumes gesture-owned hosts before requesting the session and reports callback errors',async()=>{
 let f,calls=0;f=await hostFixture({onGesture:event=>{assert.equal(event.isTrusted,true);assert.equal(f.requests,0);calls++;}});
 try{f.initialize();f.buttons[0].onclick({isTrusted:true});assert.equal(calls,1);assert.equal(f.requests,1);assert.deepEqual(f.errors,[]);}finally{await f.cleanup();}
 const broken=await hostFixture({onGesture:()=>{throw Error('actual audio resume failure');}});
 try{broken.initialize();broken.buttons[0].onclick({isTrusted:true});assert.equal(broken.requests,1,'callback exception must not defer a gesture-gated XR request to an unrelated event');assert.equal(broken.errors.length,1);assert.match(broken.errors[0].message,/actual audio resume failure/);}finally{await broken.cleanup();}
});

test('late acquired browser session is ended before host disposal can report completion',async()=>{
 const acquired=deferred(),ended=deferred(),f=await hostFixture({acquire:acquired.promise});let endCalls=0,complete=false;
 try{f.initialize();f.activation.isActive=true;assert.equal(f.host.requestFromGesture(),true);const stopping=f.host.dispose().then(()=>complete=true);await flush();assert.equal(complete,false);
  acquired.resolve({end(){endCalls++;return ended.promise;}});await flush();assert.equal(endCalls,1);assert.equal(complete,false);ended.resolve();await stopping;assert.equal(complete,true);
 }finally{ended.resolve();await f.cleanup();}
});

test('host retains actual XRSession.end cleanup and does not fabricate a viewer pose',async()=>{
 const ended=deferred(),f=await hostFixture({viewerPose:false,endReady:ended.promise});let complete=false;
 try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();f.frame();await flush();assert.equal(f.host.active,true);assert.equal(f.channel.sent.find(message=>message.type==='xr-started').frame,null);assert.equal(f.channel.sent.find(message=>message.type==='xr-tick').frame.head,null);
  const stopping=f.host.dispose().then(()=>complete=true);await flush();assert.equal(f.session.endCalls,1);assert.equal(complete,false);assert.equal(f.channel.sent.some(message=>message.type==='xr-ended'),false,'Session.end still pending cannot announce ended');ended.resolve();await stopping;assert.equal(complete,true);assert.equal(f.channel.sent.filter(message=>message.type==='xr-ended').length,1);
 }finally{ended.resolve();await f.cleanup();}
});

test('Window input-source event frames never require getViewerPose and preserve all four native events',async()=>{
 const f=await hostFixture();try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();f.frame();await flush();assert.equal(f.host.active,true,JSON.stringify({messages:f.channel.sent,errors:f.errors.map(String)}));
  const source={targetRayMode:'tracked-pointer',handedness:'left',targetRaySpace:{},gamepad:{mapping:'xr-standard',buttons:[{value:1}],axes:[.2]}};f.session.inputSources=[source];
  for(const name of ['selectstart','selectend','squeezestart','squeezeend']){
   const event=new Event(name);Object.assign(event,{inputSource:source,frame:{getViewerPose(){throw Error('getViewerPose is invalid on this real input-event frame');},getPose(){return{transform:{matrix:matrix()}};}}});f.session.dispatchEvent(event);
  }
  const events=f.channel.sent.filter(message=>message.type==='xr-input-event');assert.equal(events.length,4);assert.deepEqual(events.map(message=>message.eventType),[0,1,2,3]);
  assert(events.every(message=>message.frame.head===null&&message.frame.views.length===0&&message.frame.inputs[0].buttons[0]===1));assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('failed end of a late acquired XR session rejects cleanup instead of reporting complete',async()=>{
 const acquired=deferred(),f=await hostFixture({acquire:acquired.promise});
 try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();const stopping=f.host.dispose();
  acquired.resolve({end:async()=>{throw Error('actual session end failed');}});await assert.rejects(stopping,/actual session end failed/);
  assert.equal(f.errors.length,1);
 }finally{try{await f.cleanup();}catch{/* The deliberately failed disposal remains failed. */}}
});


test('session starts before first viewer pose; bounded no-pose ticks advance native RAF without allocating or submitting pixels',async()=>{
 const f=workerFixture();let ticks=0;
 try{f.callbacks.started=()=>{assert.equal(f.bridge.getRenderTargetSize(),null);assert.equal(f.bridge.getTransformForView(-1),null);};f.initialize();
  f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',layerBytes:32,state:observed(),frame:null});
  const render=()=>{ticks++;if(!f.bridge.getTransformForView(-1)){assert.equal(f.bridge.getColorTexture(),0);assert.equal(f.bridge.getDepthTexture(),0);}f.bridge.requestAnimationFrame(render);};f.bridge.requestAnimationFrame(render);
  for(let id=1;id<=6;id++){f.channel.receive({type:'xr-tick',epoch:1,frame:{...observed(id),head:null,views:[]}});await flush();assert.equal(ticks,id);assert.equal(f.channel.sent.filter(m=>m.type==='xr-tick-done').length,id);f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:id});}
  assert.equal(f.nativeTextures.size,0);assert.equal(f.gl.calls.length,0);assert.equal(f.channel.sent.filter(m=>m.type==='xr-bitmap').length,0);
  f.channel.receive({type:'xr-frame',epoch:1,frame:observed(7)});await flush();const texture=f.bridge.getColorTexture();assert(texture>0);assert.equal(ticks,7);assert.equal(f.bridge.snapshot().frames,1);f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:7});
  f.channel.receive({type:'xr-tick',epoch:1,frame:{...observed(8),head:null,views:[]}});await flush();assert.equal(ticks,8);assert.equal(f.bridge.getColorTexture(),0);assert.equal(f.nativeTextures.size,2);assert.equal(f.bridge.snapshot().frames,1);f.channel.receive({type:'xr-frame-ack',epoch:1,frameId:8});
  f.channel.receive({type:'xr-frame',epoch:1,frame:observed(9)});await flush();assert.equal(f.bridge.getColorTexture(),texture);assert.equal(ticks,9);assert.equal(f.bridge.snapshot().nonRenderingTicks,7);
 }finally{f.bridge.dispose();}assert.equal(f.nativeTextures.size,0);assert.equal(f.bridge.snapshot().outstandingFrames,0);
});

test('headless Window frame credit is retired only by its matching real tick completion',async()=>{
 const f=await hostFixture({viewerPose:false});try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();
  f.frame();f.frame();assert.equal(f.channel.sent.filter(m=>m.type==='xr-tick').length,1);const tick=f.channel.sent.find(m=>m.type==='xr-tick');
  f.channel.receive({type:'xr-tick-done',epoch:0,frameId:tick.frame.frameId});f.frame();assert.equal(f.channel.sent.filter(m=>m.type==='xr-tick').length,1);
  f.channel.receive({type:'xr-tick-done',epoch:1,frameId:tick.frame.frameId});f.frame();assert.equal(f.channel.sent.filter(m=>m.type==='xr-tick').length,2);assert.equal(f.host.snapshot().presented,0);assert.equal(f.host.snapshot().gpuBytes,32);
 }finally{await f.cleanup();}assert.equal(f.host.snapshot().outstandingFrames,0);
});

test('XR shader resources are created only after actual context compatibility and cancelled setup rejection is clean',async()=>{
 const compatible=deferred(),f=await hostFixture({compatible:compatible.promise});try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();assert.equal(f.gl.textures.length,0);
  const stopping=f.host.dispose();compatible.reject(Error('context compatibility cancelled by real session end'));await stopping;assert.deepEqual(f.errors,[]);
 }finally{await f.cleanup();}
});

test('explicit native uninitialize emits actual ended only after browser end and rejects a retired callback after a fresh initialization',async()=>{
 const end=deferred(),f=await hostFixture({endReady:end.promise});try{f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();f.channel.receive({type:'xr-end',epoch:1});await flush();assert.equal(f.channel.sent.some(m=>m.type==='xr-ended'),false);end.resolve();await flush();assert.equal(f.channel.sent.filter(m=>m.type==='xr-ended').length,1);}finally{end.resolve();await f.cleanup();}
 const w=workerFixture();let ended=0;try{w.callbacks.ended=()=>ended++;w.initialize();w.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});w.bridge.uninitialize();w.channel.receive({type:'xr-ended',epoch:1});assert.equal(ended,1);w.channel.receive({type:'xr-ended',epoch:1});assert.equal(ended,1);w.initialize();w.channel.receive({type:'xr-ended',epoch:1});assert.equal(ended,1);}finally{w.bridge.dispose();}
});

for(const reenter of ['inactive-callback','native-end'])test(`XR disposal owns native end before reentry from ${reenter}`,async()=>{
 const end=deferred();let f,nested,settled=false;
 f=await hostFixture({endReady:end.promise,onActiveChange(active){if(!active&&reenter==='inactive-callback')nested=f.host.dispose();}});
 try{
  f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();
  if(reenter==='native-end')f.session.end=()=>{f.session.endCalls++;nested=f.host.dispose();return end.promise;};
  const closing=f.host.close();await flush();assert.ok(nested);assert.equal(nested,f.host.dispose());nested.then(()=>{settled=true;});
  await flush();assert.equal(settled,false);assert.equal(f.session.endCalls,1);assert.equal(f.host.snapshot().closingSessions,1);assert.equal(f.host.snapshot().sessionEnded,false);
  assert.equal(f.channel.sent.some(m=>m.type==='xr-ended'),false);assert.equal(f.channel.closed,false);
  end.resolve();await Promise.all([nested,closing]);assert.equal(settled,true);assert.equal(f.channel.closed,true);assert.equal(f.host.snapshot().sessionEnded,true);
 }finally{end.resolve();await f.cleanup();}
});

test('direct dispose caches its promise before inactive callback and preserves actual end failure',async()=>{
 const end=deferred();let f,nested;
 f=await hostFixture({endReady:end.promise,onActiveChange(active){if(!active)nested=f.host.dispose();}});
 try{
  f.initialize();f.activation.isActive=true;f.host.requestFromGesture();await flush();const closing=f.host.dispose();assert.equal(closing,nested);
  end.reject(Error('native end rejected'));await assert.rejects(closing,/native end rejected/);assert.equal(f.host.dispose(),closing);
  assert.equal(f.channel.closed,true);assert.equal(f.host.snapshot().sessionEnded,false);assert.equal(f.errors.length,1);
 }finally{try{await f.cleanup();}catch{}}
});

test('XR rate sender coalesces ten thousand updates and releases credit only for the exact response',()=>{
 const f=workerFixture();try{
  f.initialize();f.channel.receive({type:'xr-started',epoch:1,referenceSpace:'local',features:'',blendMode:'opaque',frame:observed()});
  for(let i=0;i<10000;i++)f.bridge.updateTargetFrameRate(i%2?90:72);
  const sent=()=>f.channel.sent.filter(m=>m.type==='xr-update-rate');assert.equal(sent().length,1);assert.equal(sent()[0].rate,72);
  assert.equal(f.bridge.snapshot().pendingRateRequests,1);assert.equal(f.bridge.snapshot().queuedRateUpdates,1);
  const first=sent()[0];for(const fields of [{requestId:first.requestId+1},{epoch:3},{status:'unknown'}])f.channel.receive({type:'xr-rate-result',epoch:1,requestId:first.requestId,status:'settled',...fields});
  assert.equal(sent().length,1);f.channel.receive({type:'xr-rate-result',epoch:1,requestId:first.requestId,status:'settled'});
  assert.equal(sent().length,2);assert.equal(sent()[1].rate,90);assert.equal(f.bridge.snapshot().queuedRateUpdates,0);
  f.channel.receive({type:'xr-rate-result',epoch:1,requestId:first.requestId,status:'settled'});assert.equal(f.bridge.snapshot().pendingRateRequests,1);
  f.channel.receive({type:'xr-rate-result',epoch:1,requestId:sent()[1].requestId,status:'busy'});assert.equal(f.bridge.snapshot().pendingRateRequests,0);assert.equal(f.bridge.snapshot().rateBackpressure,1);assert.deepEqual(f.errors,[]);
 }finally{f.bridge.dispose();}
});

test('rate ownership survives session retirement; old queued values cannot reach the new session',()=>{
 const f=workerFixture();try{
  const start=epoch=>f.channel.receive({type:'xr-started',epoch,referenceSpace:'local',features:'',blendMode:'opaque',frame:{...observed(),epoch}});
  const sent=()=>f.channel.sent.filter(m=>m.type==='xr-update-rate');f.initialize();start(1);f.bridge.updateTargetFrameRate(72);f.bridge.updateTargetFrameRate(80);const first=sent()[0];
  f.bridge.uninitialize();assert.equal(f.bridge.snapshot().queuedRateUpdates,0);f.initialize();start(3);f.bridge.updateTargetFrameRate(90);assert.equal(sent().length,1);
  f.channel.receive({type:'xr-rate-result',epoch:1,requestId:first.requestId,status:'settled'});assert.equal(sent().length,2);assert.equal(sent()[1].epoch,3);assert.equal(sent()[1].rate,90);
  f.bridge.updateTargetFrameRate(100);f.bridge.uninitialize();f.channel.receive({type:'xr-rate-result',epoch:3,requestId:sent()[1].requestId,status:'settled'});assert.equal(sent().length,2);assert.equal(f.bridge.snapshot().pendingRateRequests,0);
 }finally{f.bridge.dispose();}
});

test('Host rate receipts follow actual settlement and rejected admission does not fail the session',async()=>{
 const gate=deferred(),f=await hostFixture({limits:{maxPendingQueries:1}});let calls=0;
 try{
  f.session.updateTargetFrameRate=()=>{calls++;return gate.promise;};f.activation.isActive=true;f.initialize();await flush();
  f.channel.receive({type:'xr-update-rate',epoch:1,requestId:100,rate:72});await flush();assert.equal(calls,1);assert.equal(f.channel.sent.some(m=>m.type==='xr-rate-result'),false);
  f.channel.receive({type:'xr-update-rate',epoch:1,requestId:101,rate:90});assert.equal(f.channel.sent.find(m=>m.requestId===101).status,'busy');assert.deepEqual(f.errors,[]);
  f.channel.receive({type:'xr-update-rate',epoch:0,requestId:102,rate:90});assert.equal(f.channel.sent.find(m=>m.requestId===102).status,'settled');
  gate.resolve();await flush();assert.equal(f.host.snapshot().pendingRateOperations,0);assert.equal(f.channel.sent.find(m=>m.requestId===100).status,'settled');
  f.session.updateTargetFrameRate=undefined;f.channel.receive({type:'xr-update-rate',epoch:1,requestId:103,rate:90});assert.equal(f.channel.sent.find(m=>m.requestId===103).status,'settled');assert.equal(calls,1);
 }finally{gate.resolve();await f.cleanup();}
});
