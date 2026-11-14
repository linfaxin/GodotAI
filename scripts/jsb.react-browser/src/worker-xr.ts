import {isWorkerEnvelope,sameWorkerRun,WORKER_PROTOCOL} from './worker-protocol.js';
import {workerXRLimits,validXRFrame,validXRInputFrame,validXRSessionState,validXRSessionOptions,type WorkerXRBridgeOptions,type WorkerXRNativeGraphics,type WorkerXRCallbacks,type WorkerXRPort,type WorkerXRFrame,type WorkerXRInputFrame,type WorkerXRSessionState,type WorkerXRSessionOptions} from './worker-xr-protocol.js';
export type {WorkerXRBridgeOptions,WorkerXRNativeGraphics,WorkerXRCallbacks} from './worker-xr-protocol.js';

/** No XRSession crosses realms. Native synchronous imports read the most
 * recently received host observation, never a synthesized browser session. */
export function createWorkerXRBridge(port:WorkerXRPort,options:WorkerXRBridgeOptions){
 const limits=workerXRLimits(options.limits);let closed=false,active=false,initializing=false,supported=false,epoch=0,requestId=0,lastFrameId=0;
 let graphics:WorkerXRNativeGraphics|undefined,callbacks:WorkerXRCallbacks|undefined,frame:WorkerXRInputFrame|undefined;
 let pendingRAF:FrameRequestCallback|undefined,ticket:{epoch:number;frameId:number;kind:'render'|'tick'}|undefined,submitted=false,inFrame=false;
 let sessionState:WorkerXRSessionState|undefined,nonRenderingTicks=0,retired:{epoch:number;handlers:WorkerXRCallbacks}|undefined;
 let scheduled=false,cancelScheduled:(()=>void)|undefined;
 let dispatchFrame:(task:()=>void)=>void|(()=>void)=task=>{let cancelled=false;queueMicrotask(()=>{if(!cancelled)task();});return()=>{cancelled=true;};};
 let color:WebGLTexture|undefined,depth:WebGLTexture|undefined,read:WebGLFramebuffer|undefined,colorId=0,depthId=0,width=0,height=0,views=0;
 const targets=new Map<number,{color:WebGLTexture;depth:WebGLTexture;colorId:number;depthId:number}>();let lockedWidth=0,lockedHeight=0,cachedTextureBytes=0;
 let gpuBytes=0,bitmapBytes=0,frames=0,dropped=0;const queries=new Map<number,{callback:(supported:boolean)=>void;timer:ReturnType<typeof setTimeout>}>();
 let hostLayerBytes=0,hostUploadBytes=0,canvasReservedBytes=0;
 let rateInFlight:{epoch:number;requestId:number}|undefined,latestRate:{epoch:number;rate:number}|undefined,rateBackpressure=0;
 const originalSize={width:options.canvas.width,height:options.canvas.height};
 const send=(fields:object,transfer:Transferable[]=[])=>{if(!closed)port.postMessage({...options.identity,protocolVersion:WORKER_PROTOCOL,...fields},transfer);};
 function fail(error:unknown){const value=error instanceof Error?error:Error(String(error));const handler=callbacks;uninitialize();handler?.failed(value.message);options.onError?.(value);}
 function releaseTargets(){if(!graphics)return;const {gl}=graphics;for(const target of targets.values()){graphics.releaseTexture(target.colorId,target.color);graphics.releaseTexture(target.depthId,target.depth);}targets.clear();if(read)gl.deleteFramebuffer(read);color=depth=undefined;read=undefined;colorId=depthId=0;gpuBytes=cachedTextureBytes=hostLayerBytes=hostUploadBytes=canvasReservedBytes=0;width=height=views=lockedWidth=lockedHeight=0;}
 function deactivate(){const wasActive=active;active=initializing=false;latestRate=undefined;cancelScheduled?.();cancelScheduled=undefined;scheduled=false;pendingRAF=undefined;frame=undefined;sessionState=undefined;ticket=undefined;lastFrameId=0;bitmapBytes=0;releaseTargets();if(wasActive){options.canvas.width=originalSize.width;options.canvas.height=originalSize.height;options.onActiveChange?.(false);}}
 function flushRate(){
  if(closed||!active||rateInFlight||!latestRate)return;
  const next=latestRate;latestRate=undefined;if(next.epoch!==epoch)return;
  const ticket={epoch,requestId:++requestId};rateInFlight=ticket;
  try{send({type:'xr-update-rate',...ticket,rate:next.rate});}catch(failure){rateInFlight=undefined;fail(failure);}
 }
 function allocate(snapshot:WorkerXRFrame){
  if(!graphics)throw Error('E_XR_NATIVE_GRAPHICS');const {gl}=graphics;
  const nextWidth=lockedWidth||Math.max(...snapshot.views.map(view=>view.viewport.width)),nextHeight=lockedHeight||Math.max(...snapshot.views.map(view=>view.viewport.height)),nextViews=snapshot.views.length;
  const existing=targets.get(nextViews),atlasWidth=nextWidth*nextViews,pixels=atlasWidth*nextHeight,textureBytes=existing?0:pixels*8;
  // Cached native handles remain valid for Godot's GLuint->RID cache. Canvas,
  // bitmap and Window upload/layer capacity share the remaining admission.
  const nextCanvasBytes=Math.max(canvasReservedBytes,pixels*4),nextUploadBytes=Math.max(hostUploadBytes,pixels*4);
  if(atlasWidth>limits.maxDimension||nextHeight>limits.maxDimension||pixels>limits.maxPixels||cachedTextureBytes+textureBytes+nextCanvasBytes+pixels*4+nextUploadBytes+snapshot.layerBytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');
  if(nextWidth>gl.getParameter(gl.MAX_TEXTURE_SIZE)||nextHeight>gl.getParameter(gl.MAX_TEXTURE_SIZE)||nextViews>gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))throw Error('E_XR_TEXTURE_LIMIT');
  const target=nextViews>1?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D,oldBinding=gl.getParameter(nextViews>1?gl.TEXTURE_BINDING_2D_ARRAY:gl.TEXTURE_BINDING_2D);
  const created:Array<{texture:WebGLTexture;id:number}>=[];
  const create=(format:number)=>{const texture=gl.createTexture();if(!texture)throw Error('E_XR_TEXTURE_ALLOC');const allocation={texture,id:0};created.push(allocation);gl.bindTexture(target,texture);gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(nextViews>1)gl.texStorage3D(target,1,format,nextWidth,nextHeight,nextViews);else gl.texStorage2D(target,1,format,nextWidth,nextHeight);allocation.id=graphics!.registerTexture(texture);return allocation;};
  let selected=existing;
  try{if(!selected){const nextColor=create(gl.RGBA8),nextDepth=create(gl.DEPTH_COMPONENT24);if(!read)read=gl.createFramebuffer()??undefined;if(!read)throw Error('E_XR_FRAMEBUFFER_ALLOC');selected={color:nextColor.texture,depth:nextDepth.texture,colorId:nextColor.id,depthId:nextDepth.id};targets.set(nextViews,selected);cachedTextureBytes+=textureBytes;}}
  catch(error){for(const value of created)if(value.id)graphics.releaseTexture(value.id,value.texture);else gl.deleteTexture(value.texture);throw error;}finally{gl.bindTexture(target,oldBinding);}
  color=selected.color;depth=selected.depth;colorId=selected.colorId;depthId=selected.depthId;width=lockedWidth=nextWidth;height=lockedHeight=nextHeight;views=nextViews;gpuBytes=cachedTextureBytes+pixels*4;
  hostLayerBytes=snapshot.layerBytes;hostUploadBytes=nextUploadBytes;canvasReservedBytes=nextCanvasBytes;
  if(options.canvas.width!==atlasWidth)options.canvas.width=atlasWidth;if(options.canvas.height!==height)options.canvas.height=height;
 }
 function submit(){
  if(!active||!frame?.head||!ticket||ticket.kind!=='render'||!graphics||!color||!read)return;
  const {gl}=graphics,oldRead=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),oldDraw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),oldReadBuffer=gl.getParameter(gl.READ_BUFFER),scissor=gl.isEnabled(gl.SCISSOR_TEST);
  let bitmap:ImageBitmap|undefined;
  try{
   gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
   for(let index=0;index<views;index++){
    if(views>1)gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,color,0,index);else gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,color,0);
    if(gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('E_XR_READ_FRAMEBUFFER');
    gl.blitFramebuffer(0,0,width,height,index*width,0,(index+1)*width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
   }
   gl.flush();bitmap=options.canvas.transferToImageBitmap();bitmapBytes=bitmap.width*bitmap.height*4;
   send({type:'xr-bitmap',...ticket,width:bitmap.width,height:bitmap.height,viewCount:views,workerBytes:cachedTextureBytes+canvasReservedBytes,bitmap},[bitmap]);bitmap=undefined;frames++;
  }finally{bitmap?.close();gl.bindFramebuffer(gl.READ_FRAMEBUFFER,oldRead);gl.readBuffer(oldReadBuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,oldDraw);if(scissor)gl.enable(gl.SCISSOR_TEST);}
 }
 function runFrame(){
  if(!active||!pendingRAF||!frame||!ticket||submitted||inFrame||scheduled)return;
  const expectedEpoch=epoch,expectedFrame=ticket.frameId;scheduled=true;
  const cancel=dispatchFrame(()=>{
   scheduled=false;cancelScheduled=undefined;
   if(closed||!active||epoch!==expectedEpoch||ticket?.frameId!==expectedFrame||submitted||!frame||!pendingRAF)return;
   const callback=pendingRAF;pendingRAF=undefined;submitted=true;inFrame=true;
   try{callback(frame.time+frame.timeOrigin-performance.timeOrigin);if(active&&ticket?.frameId===expectedFrame){if(ticket.kind==='tick'){nonRenderingTicks++;send({type:'xr-tick-done',epoch:ticket.epoch,frameId:ticket.frameId});}else submit();}}catch(error){fail(error);}finally{inFrame=false;}
  });if(scheduled&&typeof cancel==='function')cancelScheduled=cancel;
 }
 function acceptFrame(value:unknown,kind:'render'|'tick'='render'){
  if(!active||!(kind==='render'?validXRFrame(value,limits):validXRInputFrame(value,limits)&&(value as WorkerXRInputFrame).head===null)||ticket)return false;
  const observation=value as WorkerXRInputFrame;if(observation.epoch!==epoch||observation.frameId<=lastFrameId)return false;
  if(cachedTextureBytes+canvasReservedBytes+hostUploadBytes+observation.layerBytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');hostLayerBytes=observation.layerBytes;
  frame=observation;sessionState=observation;lastFrameId=observation.frameId;ticket={epoch,frameId:observation.frameId,kind};submitted=false;if(kind==='render')allocate(value as WorkerXRFrame);runFrame();return true;
 }
 function uninitialize(){if(closed||!active&&!initializing)return;const oldEpoch=epoch;if(callbacks)retired={epoch:oldEpoch,handlers:callbacks};epoch++;deactivate();send({type:'xr-end',epoch:oldEpoch});}
 port.onmessage=event=>{
  const message=event.data;if(!isWorkerEnvelope(message)||!sameWorkerRun(message,options.identity)||closed){(message?.bitmap as ImageBitmap|undefined)?.close?.();return;}
  const m=message as any;
  try{
   if(m.type==='xr-availability'){supported=m.supported===true;return;}
   if(m.type==='xr-support-result'){const query=queries.get(m.requestId);if(query){queries.delete(m.requestId);clearTimeout(query.timer);query.callback(m.supported===true);}return;}
   if(m.type==='xr-rate-result'){
    if(!rateInFlight||m.epoch!==rateInFlight.epoch||m.requestId!==rateInFlight.requestId||!['settled','busy'].includes(m.status))return;
    rateInFlight=undefined;if(m.status==='busy')rateBackpressure++;flushRate();return;
   }
   if(m.type==='xr-ended'&&retired&&retired.epoch===m.epoch&&!active&&!initializing){const ended=retired.handlers;retired=undefined;ended.ended();return;}
   if(m.epoch!==epoch)return;
   if(m.type==='xr-started'){
    if(active||!callbacks||typeof m.referenceSpace!=='string'||m.referenceSpace.length>128||typeof m.features!=='string'||m.features.length>8192||typeof m.blendMode!=='string'||m.blendMode.length>64||m.frame!==null&&!validXRInputFrame(m.frame,limits)||!validXRSessionState(m.state??m.frame))throw Error('E_XR_START_MESSAGE');
    const first=m.frame as WorkerXRInputFrame|null,layerBytes=m.layerBytes??first?.layerBytes;
    if(!Number.isSafeInteger(layerBytes)||layerBytes<1||layerBytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');
    canvasReservedBytes=options.canvas.width*options.canvas.height*4;hostLayerBytes=layerBytes;
    if(!Number.isSafeInteger(canvasReservedBytes)||canvasReservedBytes+hostLayerBytes>limits.maxBytes)throw Error('E_XR_PRESENTATION_BUDGET');
    sessionState=m.state??first;active=true;initializing=false;options.onActiveChange?.(true);frame=first??undefined;if(first?.head)allocate(first as WorkerXRFrame);callbacks.wakeMainLoop();callbacks.started(m.referenceSpace,m.features,m.blendMode);if(first)acceptFrame(first,first.head?'render':'tick');
   }else if(m.type==='xr-frame'){if(!acceptFrame(m.frame))dropped++;}
   else if(m.type==='xr-tick'){if(!acceptFrame(m.frame,'tick'))dropped++;}
   else if(m.type==='xr-frame-ack'&&ticket&&ticket.epoch===m.epoch&&ticket.frameId===m.frameId){ticket=undefined;bitmapBytes=0;}
   else if(m.type==='xr-input-event'){
    if(!active)return;
    if(!validXRInputFrame(m.frame,limits)||!Number.isInteger(m.eventType)||m.eventType<0||m.eventType>3||!Number.isInteger(m.inputId)||m.inputId<0||m.inputId>15)return;
    const previous=frame;sessionState=m.frame;frame=m.frame;try{callbacks?.input(m.eventType,m.inputId);}finally{frame=previous;}
   }else if(m.type==='xr-simple-event'){
    if(!active)return;
    if(validXRSessionState(m.state))sessionState=m.state;
    if(validXRInputFrame(m.frame,limits))frame=m.frame;
    if(['visibility_state_changed','reference_space_reset','display_refresh_rate_changed'].includes(m.name))callbacks?.simple(m.name);
   }else if(m.type==='xr-ended'&&(active||initializing)){deactivate();callbacks?.ended();}
   else if(m.type==='xr-failed'&&(active||initializing)){deactivate();callbacks?.failed(typeof m.message==='string'?m.message.slice(0,4096):'XR session failed');}
  }catch(error){fail(error);}
 };
 port.start();send({type:'xr-ready'});
 return {
  get active(){return active;},isSupported:()=>supported,
  isSessionSupported(mode:string,callback:(supported:boolean)=>void){if(closed||queries.size>=limits.maxPendingQueries){callback(false);return;}const id=++requestId,timer=setTimeout(()=>{const query=queries.get(id);if(query){queries.delete(id);query.callback(false);}},limits.setupTimeoutMs);queries.set(id,{callback,timer});send({type:'xr-support-query',requestId:id,mode});},
  initialize(settings:WorkerXRSessionOptions,handlers:WorkerXRCallbacks,nativeGraphics:WorkerXRNativeGraphics){if(closed||active||initializing||!validXRSessionOptions(settings)){handlers.failed('Invalid or duplicate XR initialization');return;}retired=undefined;graphics=nativeGraphics;callbacks=handlers;initializing=true;epoch++;send({type:'xr-initialize',epoch,settings});},
  uninitialize,
  setFrameDispatcher(dispatcher:(task:()=>void)=>void|(()=>void)){dispatchFrame=dispatcher;},
  requestAnimationFrame(callback:FrameRequestCallback){if(pendingRAF)throw Error('E_XR_RAF_BACKPRESSURE');pendingRAF=callback;runFrame();},
  getViewCount:()=>active&&frame?frame.views.length||1:1,
  getRenderTargetSize:()=>active&&color?[width,height]:null,
  getTransformForView:(index:number)=>active&&frame?(index<0?frame.head:frame.views[index]?.transform??null):null,
  getProjectionForView:(index:number)=>active&&frame?frame.views[index]?.projection??null:null,
  getColorTexture:()=>active&&frame?.head?colorId:0,getDepthTexture:()=>active&&frame?.head?depthId:0,getVelocityTexture:()=>0,
  getInputSource:(id:number)=>active?frame?.inputs.find(input=>input.id===id)??null:null,
  getVisibilityState:()=>active?sessionState?.visibility??frame?.visibility??'':'',getBoundsGeometry:()=>active?sessionState?.bounds??frame?.bounds??[]:[],
  getFrameRate:()=>active?sessionState?.frameRate??frame?.frameRate??0:0,getSupportedFrameRates:()=>active?sessionState?.supportedFrameRates??frame?.supportedFrameRates??[]:[],
  updateTargetFrameRate(rate:number){if(active&&Number.isFinite(rate)&&rate>0&&rate<=1000){latestRate={epoch,rate};flushRate();}},
  snapshot:()=>({active,hasViewerPose:!!frame?.head,sessionEpoch:epoch,gpuBytes,bitmapBytes,hostLayerBytes,reservedPresentationBytes:cachedTextureBytes+canvasReservedBytes+hostUploadBytes+bitmapBytes+hostLayerBytes,frames,nonRenderingTicks,dropped,pendingQueries:queries.size,pendingRateRequests:rateInFlight?1:0,queuedRateUpdates:latestRate?1:0,rateBackpressure,outstandingFrames:ticket?1:0,cachedViewCounts:[...targets.keys()],targetSizePolicy:'first-host-view-size-fixed-per-session',poseObservation:'latest-host-frame',timestampOrigin:'worker-performance-time-origin'}),
  dispose(){if(closed)return;const wasActive=active;uninitialize();closed=true;rateInFlight=latestRate=undefined;if(wasActive)callbacks?.wakeMainLoop();for(const query of queries.values())clearTimeout(query.timer);queries.clear();port.onmessage=null;port.close();},
 };
}
