import {isWorkerEnvelope,sameWorkerRun,WORKER_PROTOCOL} from './worker-protocol.js';
import {workerXRLimits,validXRFrame,validXRInputFrame,validXRSessionOptions,type WorkerXRHostOptions,type WorkerXRPort,type WorkerXRFrame,type WorkerXRInputFrame,type WorkerXRSessionState,type WorkerXRSessionOptions,type WorkerXRInput} from './worker-xr-protocol.js';
export type {WorkerXRHostOptions} from './worker-xr-protocol.js';

/** Window owns the actual browser session and its compositor GL context. The
 * engine stays in its Worker; received pixels are GPU-uploaded into the next
 * real XR animation callback, never drawn outside that callback's lifetime. */
export function createWorkerXRHost(port:WorkerXRPort,options:WorkerXRHostOptions){
 const limits=workerXRLimits(options.limits),xr=(navigator as any).xr;
 let closed=false,active=false,epoch=0,generation=0,frameSerial=0,session:any,space:any,layer:any,gl:WebGL2RenderingContext|undefined;
 let pending:WorkerXRSessionOptions|undefined,button:HTMLButtonElement|undefined,raf:number|undefined,setupTimer:ReturnType<typeof setTimeout>|undefined;
 let last:WorkerXRInputFrame|undefined,ticket:{epoch:number;frameId:number;kind:'render'|'tick'}|undefined,bitmap:ImageBitmap|undefined,bitmapFrame=0;
 let texture:WebGLTexture|undefined,program:WebGLProgram|undefined,vao:WebGLVertexArrayObject|undefined,uvRect:WebGLUniformLocation|null=null,uvClamp:WebGLUniformLocation|null=null;
 let referenceType='',features='',blendMode='',started=false,textureBytes=0,textureViews=0,bitmapBytes=0,uploadedWidth=0,uploadedHeight=0,presented=0,dropped=0,ended=true;
 let workerBytes=0;
 let endPromise:Promise<void>=Promise.resolve(),setupPromise:Promise<void>=Promise.resolve(),disposePromise:Promise<void>|undefined,cleanupFailure:unknown;const operations=new Set<Promise<void>>(),endingSessions=new Set<Promise<void>>(),rateOperations=new Set<Promise<void>>(),supportOperations=new Set<Promise<void>>(),sources=new Map<any,{id:number;touch:number}>(),removers:Array<()=>void>=[],queries=new Map<number,{timer:ReturnType<typeof setTimeout>}>();
 const pendingOperations=()=>operations.size+endingSessions.size+rateOperations.size+supportOperations.size;
 function track(operation:Promise<void>,owner:Set<Promise<void>>){owner.add(operation);void operation.finally(()=>owner.delete(operation)).catch(()=>{});}
 const send=(fields:object)=>{if(!closed)port.postMessage({...options.identity,protocolVersion:WORKER_PROTOCOL,...fields});};
 const error=(value:unknown)=>options.onError?.(value instanceof Error?value:Error(String(value)));
 function removeButton(){button?.remove();button=undefined;}
 function listen(target:any,name:string,callback:(event:any)=>void){target.addEventListener(name,callback);removers.push(()=>target.removeEventListener(name,callback));}
 function clearGraphics(){bitmap?.close();bitmap=undefined;bitmapBytes=0;ticket=undefined;if(gl){if(texture)gl.deleteTexture(texture);if(program)gl.deleteProgram(program);if(vao)gl.deleteVertexArray(vao);}texture=undefined;program=undefined;vao=undefined;uvRect=uvClamp=null;textureBytes=textureViews=uploadedWidth=uploadedHeight=workerBytes=0;layer=undefined;gl=undefined;}
 function layerCapacity():number{
  const width=layer?.framebufferWidth,height=layer?.framebufferHeight,pixels=width*height,bytes=pixels*4;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>limits.maxDimension||height>limits.maxDimension||!Number.isSafeInteger(bytes)||pixels>limits.maxPixels)throw Error('E_XR_FRAMEBUFFER_BUDGET');
  if(workerBytes+textureBytes+bitmapBytes+bytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');return bytes;
 }
 function stopSession(notify:boolean,observedEnd=false){
  generation++;pending=undefined;removeButton();clearTimeout(setupTimer);setupTimer=undefined;
  if(session&&raf!==undefined)session.cancelAnimationFrame(raf);raf=undefined;
  for(const remove of removers.splice(0))remove();const old=session,ownedGL=gl;session=undefined;space=undefined;sources.clear();last=undefined;started=false;
  const wasActive=active,closingEpoch=epoch;active=false;clearGraphics();
  const releaseContext=()=>{ownedGL?.getExtension?.('WEBGL_lose_context')?.loseContext();};
  if(old){if(observedEnd){ended=true;releaseContext();endPromise=Promise.resolve();}else{
   // Register ownership before either the browser API or an outside callback
   // can reenter close/dispose. Never replace a pending end with an empty join.
   ended=false;let complete!:()=>void,reject!:(failure:unknown)=>void;
   const nativeEnd=new Promise<void>((resolve,fail)=>{complete=resolve;reject=fail;});
   const ending=nativeEnd.then(()=>{ended=true;}).finally(releaseContext);endPromise=ending;endingSessions.add(ending);
   void ending.then(()=>endingSessions.delete(ending),failure=>{endingSessions.delete(ending);cleanupFailure??=failure;error(failure);});
   try{void Promise.resolve(old.end()).then(complete,reject);}catch(failure){reject(failure);}
  }}
  else releaseContext();
  if(wasActive)options.onActiveChange?.(false);
  if(notify)send({type:'xr-ended',epoch:closingEpoch});
 }
 function fail(value:unknown){const message=value instanceof Error?value.message:String(value);stopSession(false);send({type:'xr-failed',epoch,message:message.slice(0,4096)});}
 function shader(type:number,source:string){const object=gl!.createShader(type);if(!object)throw Error('E_XR_SHADER_ALLOC');gl!.shaderSource(object,source);gl!.compileShader(object);if(!gl!.getShaderParameter(object,gl!.COMPILE_STATUS)){const detail=gl!.getShaderInfoLog(object);gl!.deleteShader(object);throw Error('E_XR_SHADER: '+detail);}return object;}
 function initializeContext(){
  const canvas=document.createElement('canvas'),context=canvas.getContext('webgl2',{alpha:true,depth:false,stencil:false,antialias:false,premultipliedAlpha:false,xrCompatible:true} as WebGLContextAttributes);
  if(!context)throw Error('E_XR_HOST_WEBGL2');gl=context;
 }
 function initializeGraphics(){
  if(!gl)throw Error('E_XR_HOST_WEBGL2');
  const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nprecision highp float;uniform vec4 rect;out vec2 uv;void main(){vec2 p=vec2(float(gl_VertexID&1),float(gl_VertexID>>1));uv=vec2(mix(rect.x,rect.z,p.x),mix(rect.y,rect.w,p.y));gl_Position=vec4(p*2.0-1.0,0,1);}');
  let fragment:WebGLShader|undefined;
  try{fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;uniform sampler2D image;uniform vec4 clampRect;in vec2 uv;out vec4 color;void main(){color=texture(image,clamp(uv,clampRect.xy,clampRect.zw));}');program=gl.createProgram()??undefined;if(!program)throw Error('E_XR_PROGRAM_ALLOC');gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('E_XR_PROGRAM_LINK');}
  finally{gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);}
  texture=gl.createTexture()??undefined;vao=gl.createVertexArray()??undefined;if(!texture||!vao)throw Error('E_XR_HOST_ALLOC');
  gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);uvRect=gl.getUniformLocation(program!,'rect');uvClamp=gl.getUniformLocation(program!,'clampRect');
 }
 function sourceIds(){
  const current=new Set(Array.from(session.inputSources??[]));for(const source of sources.keys())if(!current.has(source))sources.delete(source);
  for(const source of current){if(sources.has(source))continue;const input=source as any;
   let id=input.targetRayMode==='tracked-pointer'&&input.handedness==='left'?0:input.targetRayMode==='tracked-pointer'&&input.handedness==='right'?1:-1;
   const used=new Set([...sources.values()].map(value=>value.id));if(id<0||used.has(id)){id=-1;for(let candidate=2;candidate<16;candidate++)if(!used.has(candidate)){id=candidate;break;}}if(id<0)continue;
   let touch=-1;if(input.targetRayMode==='screen'){const usedTouches=new Set([...sources.values()].map(value=>value.touch));for(let candidate=0;candidate<5;candidate++)if(!usedTouches.has(candidate)){touch=candidate;break;}}
   sources.set(source,{id,touch});
  }
 }
 const matrix=(value:ArrayLike<number>)=>Array.from(value);
 function boundedList(value:unknown,max:number,label:string):any[]{const list=Array.from((value??[]) as Iterable<unknown>);if(list.length>max)throw Error('E_XR_'+label+'_BUDGET');return list;}
 const boundsGeometry=()=>boundedList(space?.boundsGeometry,256,'BOUNDS').flatMap((point:any)=>[point.x,point.y,point.z]);
 const frameRates=()=>boundedList(session?.supportedFrameRates,64,'FRAME_RATES') as number[];
 const sessionState=():WorkerXRSessionState=>({visibility:session?.visibilityState??'',bounds:boundsGeometry(),frameRate:session?.frameRate??0,supportedFrameRates:frameRates()});
 function snapshot(time:number,xrFrame:any):WorkerXRFrame|null;
 function snapshot(time:number,xrFrame:any,inputEvent:true):WorkerXRInputFrame|null;
 function snapshot(time:number,xrFrame:any,inputEvent=false):WorkerXRInputFrame|null{
  // Input-event frames may legally reject getViewerPose(). Only getPose()
  // and the event's actual controller/hand data are needed by the native ABI.
  const pose=inputEvent?null:xrFrame.getViewerPose(space);if(!pose&&!inputEvent)return null;sourceIds();
  const inputs:WorkerXRInput[]=[];
  for(const [source,key]of sources){const target=xrFrame.getPose(source.targetRaySpace,space);if(!target)continue;const grip=source.gripSpace?xrFrame.getPose(source.gripSpace,space):null;
   let handJoints:number[]|null=null,handRadii:number[]|null=null;
   if(source.hand&&source.hand.size===25&&typeof xrFrame.fillPoses==='function'&&typeof xrFrame.fillJointRadii==='function'){
    const joints=new Float32Array(400),radii=new Float32Array(25);if(xrFrame.fillPoses(source.hand.values(),space,joints)&&xrFrame.fillJointRadii(source.hand.values(),radii)){handJoints=matrix(joints);handRadii=matrix(radii);}
   }
   inputs.push({id:key.id,target:matrix(target.transform.matrix),targetRayMode:source.targetRayMode==='gaze'?1:source.targetRayMode==='tracked-pointer'?2:source.targetRayMode==='screen'?3:0,touchIndex:key.touch,grip:grip?matrix(grip.transform.matrix):null,standardMapping:source.gamepad?.mapping==='xr-standard',buttons:Array.from(source.gamepad?.buttons??[]).slice(0,10).map((button:any)=>button.value),axes:Array.from(source.gamepad?.axes??[]).slice(0,10) as number[],handJoints,handRadii});
  }
  const result:WorkerXRInputFrame={epoch,frameId:++frameSerial,time,timeOrigin:performance.timeOrigin,layerBytes:layerCapacity(),head:pose?matrix(pose.transform.matrix):null,views:pose?boundedList(pose.views,limits.maxViews,'VIEWS').map((view:any)=>({transform:matrix(view.transform.matrix),projection:matrix(view.projectionMatrix),viewport:(()=>{const rect=layer.getViewport(view);return{x:rect.x,y:rect.y,width:rect.width,height:rect.height};})()})):[],inputs,visibility:session.visibilityState??'',bounds:boundsGeometry(),frameRate:session.frameRate??0,supportedFrameRates:frameRates()};
  if(!(inputEvent?validXRInputFrame(result,limits):validXRFrame(result,limits)))throw Error('E_XR_HOST_FRAME_BUDGET');return result;
 }
 function present(xrFrame:any){
  if(!gl||!program||!texture||!vao)return;
  const pose=xrFrame.getViewerPose(space);
  if(bitmap){
   try{if(pose){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);textureBytes=bitmapBytes;uploadedWidth=bitmap.width;uploadedHeight=bitmap.height;textureViews=last!.views.length;}}
   finally{bitmap.close();bitmap=undefined;bitmapBytes=0;const released=ticket;ticket=undefined;if(released)send({type:'xr-frame-ack',...released});}
  }
  if(!textureBytes)return;
  if(!pose||pose.views.length!==textureViews)return;
  gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);gl.useProgram(program);gl.bindVertexArray(vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
  for(let index=0;index<pose.views.length;index++){const rect=layer.getViewport(pose.views[index]);gl.viewport(rect.x,rect.y,rect.width,rect.height);gl.uniform4f(uvRect,index/pose.views.length,1,(index+1)/pose.views.length,0);gl.uniform4f(uvClamp,index/pose.views.length+.5/uploadedWidth,.5/uploadedHeight,(index+1)/pose.views.length-.5/uploadedWidth,1-.5/uploadedHeight);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);}
  presented++;
 }
 function onFrame(token:number,time:number,xrFrame:any){
  if(closed||token!==generation||!session)return;
  try{
   layerCapacity();
   present(xrFrame);
   if(!ticket){const observed=snapshot(time,xrFrame)??snapshot(time,xrFrame,true);if(observed){last=observed;const kind=observed.head?'render':'tick';ticket={epoch,frameId:observed.frameId,kind};send({type:kind==='render'?'xr-frame':'xr-tick',epoch,frame:observed});}}
   raf=session.requestAnimationFrame((nextTime:number,nextFrame:any)=>onFrame(token,nextTime,nextFrame));
  }catch(failure){fail(failure);}
 }
 function requestFromGesture(event?:Event):boolean{
  if(closed||!pending||session)return false;
  if(pending.mode!=='inline'&&!(navigator as any).userActivation?.isActive&&event?.isTrusted!==true)return false;
  const settings=pending;pending=undefined;removeButton();const token=generation;
  // requestSession MUST be called before yielding the real activation task.
  let request:Promise<any>,lateEndFailure=false;try{request=xr.requestSession(settings.mode,{requiredFeatures:settings.requiredFeatures,optionalFeatures:settings.optionalFeatures});}catch(failure){fail(failure);return false;}
  setupPromise=Promise.resolve(request).then(async acquired=>{
   if(closed||token!==generation){try{await acquired.end();}catch(failure){lateEndFailure=true;throw failure;}return;}
   session=acquired;ended=false;listen(acquired,'end',()=>{if(session===acquired){stopSession(true,true);}});
   initializeContext();await (gl as WebGL2RenderingContext&{makeXRCompatible():Promise<void>}).makeXRCompatible();if(closed||token!==generation)return;initializeGraphics();
   const Layer=(globalThis as any).XRWebGLLayer;if(typeof Layer!=='function')throw Error('E_XR_WEBGL_LAYER');layer=new Layer(acquired,gl,{alpha:true,depth:false,stencil:false,antialias:false});
   layerCapacity();
   acquired.updateRenderState({baseLayer:layer});let failure:unknown;
   for(const type of settings.referenceSpaces){
    if(closed||token!==generation||session!==acquired)return;
    try{
     const acquiredSpace=await acquired.requestReferenceSpace(type);
     if(closed||token!==generation||session!==acquired)return;
     space=acquiredSpace;referenceType=type;break;
    }catch(value){if(closed||token!==generation||session!==acquired)return;failure=value;}
   }
   if(closed||token!==generation)return;if(!space)throw failure??Error('E_XR_REFERENCE_SPACE');
   const enabled=boundedList(acquired.enabledFeatures,64,'FEATURES');if(enabled.some(value=>typeof value!=='string'||value.length>128))throw Error('E_XR_FEATURES_BUDGET');features=enabled.join(',');blendMode=acquired.environmentBlendMode??'';
   listen(acquired,'visibilitychange',()=>{const state=sessionState();if(last)last={...last,...state};send({type:'xr-simple-event',epoch,name:'visibility_state_changed',state,frame:last??null});});
   listen(space,'reset',()=>{try{const state=sessionState();if(last)last={...last,...state};send({type:'xr-simple-event',epoch,name:'reference_space_reset',state,frame:last??null});}catch(value){fail(value);}});
   for(const [index,name]of ['selectstart','selectend','squeezestart','squeezeend'].entries())listen(acquired,name,event=>{if(closed||session!==acquired||token!==generation)return;try{const observed=snapshot(performance.now(),event.frame,true),id=sources.get(event.inputSource)?.id;if(observed&&id!==undefined)send({type:'xr-input-event',epoch,eventType:index,inputId:id,frame:observed});}catch(value){fail(value);}});
   const layerBytes=layerCapacity();started=active=true;clearTimeout(setupTimer);setupTimer=undefined;options.onActiveChange?.(true);
   if(closed||token!==generation||session!==acquired)return;
   send({type:'xr-started',epoch,referenceSpace:referenceType,features,blendMode,layerBytes,state:sessionState(),frame:null});
   raf=acquired.requestAnimationFrame((time:number,frame:any)=>onFrame(token,time,frame));
  }).catch(failure=>{if(token===generation&&!closed)fail(failure);else if(lateEndFailure){cleanupFailure=failure;error(failure);throw failure;}});
  const operation=setupPromise;operations.add(operation);void operation.finally(()=>operations.delete(operation)).catch(()=>{});return true;
 }
 port.onmessage=event=>{
  const raw=event.data;if(!isWorkerEnvelope(raw)||!sameWorkerRun(raw,options.identity)||closed){(raw?.bitmap as ImageBitmap|undefined)?.close?.();return;}const m=raw as any;
  if(m.type==='xr-ready'){send({type:'xr-availability',supported:!!xr});return;}
  if(m.type==='xr-support-query'){
   if(!Number.isSafeInteger(m.requestId)||queries.has(m.requestId)||pendingOperations()>=limits.maxPendingQueries||!['inline','immersive-vr','immersive-ar'].includes(m.mode)){send({type:'xr-support-result',requestId:m.requestId,supported:false});return;}
   const finish=(supported:boolean)=>{if(queries.get(m.requestId)!==query)return;clearTimeout(query.timer);queries.delete(m.requestId);send({type:'xr-support-result',requestId:m.requestId,supported});};
   const query={timer:setTimeout(()=>finish(false),limits.setupTimeoutMs)};queries.set(m.requestId,query);
   const operation=Promise.resolve().then(()=>{if(closed||queries.get(m.requestId)!==query)return false;return xr?.isSessionSupported(m.mode)??false;}).then(value=>finish(value===true),()=>finish(false));
   // A logical query timeout does not retire an unresolved browser operation.
   track(operation,supportOperations);return;
  }
  if(m.type==='xr-initialize'){
   if(!Number.isSafeInteger(m.epoch)||m.epoch<=epoch||!validXRSessionOptions(m.settings)||pendingOperations()>=limits.maxPendingQueries){send({type:'xr-failed',epoch:m.epoch,message:'Invalid XR request or XR session resource budget exceeded'});return;}
   stopSession(false);epoch=m.epoch;pending=m.settings;
   if(!xr){fail(Error('WebXR is unavailable in this Window'));return;}
   setupTimer=setTimeout(()=>fail(Error('E_XR_SESSION_SETUP_TIMEOUT')),limits.setupTimeoutMs);
   if(m.settings.mode==='inline'||(navigator as any).userActivation?.isActive)requestFromGesture();
   else{button=document.createElement('button');button.type='button';button.textContent='Enter XR';button.style.cssText='position:fixed;z-index:10000;left:50%;top:24px;transform:translateX(-50%);padding:12px 24px';button.onclick=event=>{let gestureError:unknown,gestureFailed=false;try{options.onGesture?.(event);}catch(value){gestureFailed=true;gestureError=value;}requestFromGesture(event);if(gestureFailed)error(gestureError);};(options.buttonRoot??document.body).append(button);}return;
  }
  if(m.type==='xr-end'&&m.epoch===epoch){const endingEpoch=epoch;stopSession(false);const endingGeneration=generation;void Promise.all([endPromise,...operations,...rateOperations,...endingSessions]).then(()=>{if(!closed&&epoch===endingEpoch&&generation===endingGeneration)send({type:'xr-ended',epoch:endingEpoch});}).catch(error);return;}
  const rateResult=(status:'settled'|'busy')=>{if(Number.isSafeInteger(m.requestId)&&m.requestId>0)send({type:'xr-rate-result',epoch:m.epoch,requestId:m.requestId,status});};
  if(m.epoch!==epoch){m.bitmap?.close?.();if(m.type==='xr-update-rate')rateResult('settled');return;}
  if(m.type==='xr-tick-done'){
   if(ticket?.kind==='tick'&&ticket.frameId===m.frameId){const released=ticket;ticket=undefined;send({type:'xr-frame-ack',...released});}return;
  }
  if(m.type==='xr-bitmap'){
   if(!ticket||ticket.kind!=='render'||ticket.frameId!==m.frameId||bitmap||!m.bitmap||m.width!==m.bitmap.width||m.height!==m.bitmap.height||!Number.isSafeInteger(m.width)||!Number.isSafeInteger(m.height)||m.width<1||m.height<1||m.width>limits.maxDimension||m.height>limits.maxDimension||m.width*m.height>limits.maxPixels||m.width*m.height*8>limits.maxBytes||m.viewCount!==last?.views.length){m.bitmap?.close?.();dropped++;return;}
   try{
    const bytes=m.width*m.height*4,layerBytes=layerCapacity();
    if(!Number.isSafeInteger(m.workerBytes)||m.workerBytes<bytes*3||m.workerBytes+Math.max(textureBytes,bytes)+bytes+layerBytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');
    workerBytes=m.workerBytes;bitmap=m.bitmap;bitmapBytes=bytes;bitmapFrame=m.frameId;
   }catch(value){m.bitmap.close();dropped++;fail(value);}
  }else if(m.type==='xr-update-rate'){
   if(!session||!Number.isFinite(m.rate)||m.rate<=0||m.rate>1000||typeof session.updateTargetFrameRate!=='function'){rateResult('settled');return;}
   if(pendingOperations()>=limits.maxPendingQueries){if(Number.isSafeInteger(m.requestId)&&m.requestId>0)rateResult('busy');else error(Error('E_XR_RATE_BACKPRESSURE'));return;}
   const token=generation,owned=session,current=()=>!closed&&token===generation&&session===owned;
   const operation=Promise.resolve().then(()=>{if(current())return owned.updateTargetFrameRate(m.rate);}).then(()=>{
    if(!current())return;const state=sessionState();if(last)last={...last,...state};send({type:'xr-simple-event',epoch,name:'display_refresh_rate_changed',state,frame:last??null});
   }).catch(failure=>{if(current())error(failure);});
   rateOperations.add(operation);
   const retire=()=>{rateOperations.delete(operation);rateResult('settled');};void operation.then(retire,retire).catch(error);
  }
 };
 port.start();send({type:'xr-availability',supported:!!xr});
 return {get active(){return active;},requestFromGesture,
  snapshot:()=>({active,sessionEpoch:epoch,gpuBytes:textureBytes+(layer?layer.framebufferWidth*layer.framebufferHeight*4:0),bitmapBytes,workerReservedBytes:workerBytes,presented,dropped,outstandingFrames:ticket?1:0,pendingBitmapFrame:bitmapFrame,pendingSessionRequest:!!pending,sessionEnded:ended&&!session&&!operations.size&&!endingSessions.size&&!rateOperations.size,closingSessions:endingSessions.size,pendingSessionOperations:operations.size+rateOperations.size,pendingRateOperations:rateOperations.size,pendingSupportOperations:supportOperations.size,poseObservation:'actual-window-xr-frame',memoryScope:'owned-texture-and-declared-layer-capacity; Worker reservation checked together'}),
  close(){const hadSession=!!session,closingEpoch=epoch;stopSession(false);return Promise.all([endPromise,...operations,...rateOperations,...supportOperations,...endingSessions]).then(()=>{if(cleanupFailure)throw cleanupFailure;if(hadSession&&epoch===closingEpoch)send({type:'xr-ended',epoch:closingEpoch});});},
  dispose(){
   if(disposePromise)return disposePromise;
   let complete!:()=>void,reject!:(failure:unknown)=>void;
   disposePromise=new Promise<void>((resolve,fail)=>{complete=resolve;reject=fail;});void disposePromise.catch(()=>{});
   const hadSession=!!session,closingEpoch=epoch;closed=true;
   try{stopSession(false);}catch(failure){cleanupFailure??=failure;}
   for(const query of queries.values())clearTimeout(query.timer);queries.clear();
   // Keep the fenced receiver until actual end settles, so late transferred
   // bitmaps are explicitly closed. A cleanup timeout never fabricates ended.
   const drain=async()=>{try{
    while(pendingOperations())await Promise.allSettled([...operations,...rateOperations,...supportOperations,...endingSessions]);
    if(cleanupFailure)throw cleanupFailure;
    if(hadSession)port.postMessage({...options.identity,protocolVersion:WORKER_PROTOCOL,type:'xr-ended',epoch:closingEpoch});
   }finally{port.onmessage=null;port.close();}};
   void drain().then(complete,reject);return disposePromise;
  },
 };
}
