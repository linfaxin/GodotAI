import type {WorkerRunIdentity} from './worker-protocol.js';
export interface WorkerXRPort {onmessage:((event:MessageEvent)=>void)|null;postMessage(message:unknown,transfer?:Transferable[]):void;start():void;close():void}
export interface WorkerXRLimits {maxViews:number;maxPixels:number;maxDimension:number;maxBytes:number;maxPendingQueries:number;setupTimeoutMs:number}
export const DEFAULT_WORKER_XR_LIMITS:Readonly<WorkerXRLimits>=Object.freeze({maxViews:4,maxPixels:16777216,maxDimension:8192,maxBytes:268435456,maxPendingQueries:16,setupTimeoutMs:15000});
export interface WorkerXRView {transform:number[];projection:number[];viewport:{x:number;y:number;width:number;height:number}}
export interface WorkerXRInput {id:number;target:number[];targetRayMode:number;touchIndex:number;grip:number[]|null;standardMapping:boolean;buttons:number[];axes:number[];handJoints:number[]|null;handRadii:number[]|null}
export interface WorkerXRFrame {epoch:number;frameId:number;time:number;timeOrigin:number;layerBytes:number;head:number[];views:WorkerXRView[];inputs:WorkerXRInput[];visibility:string;bounds:number[];frameRate:number;supportedFrameRates:number[]}
export interface WorkerXRInputFrame extends Omit<WorkerXRFrame,'head'> {head:number[]|null}
export type WorkerXRSessionState=Pick<WorkerXRFrame,'visibility'|'bounds'|'frameRate'|'supportedFrameRates'>;
export interface WorkerXRSessionOptions {mode:string;requiredFeatures:string[];optionalFeatures:string[];referenceSpaces:string[]}
export interface WorkerXRNativeGraphics {gl:WebGL2RenderingContext;registerTexture(texture:WebGLTexture):number;releaseTexture(id:number,texture:WebGLTexture):void}
export interface WorkerXRCallbacks {started(referenceSpace:string,features:string,blendMode:string):void;ended():void;failed(message:string):void;input(type:number,id:number):void;simple(name:string):void;wakeMainLoop():void}
export interface WorkerXRBridgeOptions {identity:WorkerRunIdentity;canvas:OffscreenCanvas;limits?:Partial<WorkerXRLimits>;onActiveChange?(active:boolean):void;onError?(error:Error):void}
export interface WorkerXRHostOptions {identity:WorkerRunIdentity;limits?:Partial<WorkerXRLimits>;buttonRoot?:HTMLElement;onGesture?(event:Event):void;onActiveChange?(active:boolean):void;onError?(error:Error):void}
export function workerXRLimits(overrides:Partial<WorkerXRLimits>={}):WorkerXRLimits{
 const limits={...DEFAULT_WORKER_XR_LIMITS,...overrides};for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1)throw Error('E_XR_LIMIT');
 if(limits.maxViews>4||limits.maxPendingQueries>64||limits.setupTimeoutMs>2147483647)throw Error('E_XR_LIMIT');return limits;
}
export const xrFloats=(value:unknown,length:number):value is number[]=>Array.isArray(value)&&value.length===length&&value.every(item=>typeof item==='number'&&Number.isFinite(item));
const integer=(value:unknown,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max;
export function validXRSessionOptions(value:unknown):value is WorkerXRSessionOptions{
 const item=value as WorkerXRSessionOptions;return !!item&&['inline','immersive-vr','immersive-ar'].includes(item.mode)&&[item.requiredFeatures,item.optionalFeatures,item.referenceSpaces].every(array=>Array.isArray(array)&&array.length<=64&&array.every(entry=>typeof entry==='string'&&entry.length>0&&entry.length<=128))&&item.referenceSpaces.length>0;
}
function validXRObservation(value:unknown,limits:WorkerXRLimits,inputEvent:boolean):value is WorkerXRInputFrame{
 const frame=value as WorkerXRInputFrame;if(!frame||!integer(frame.epoch)||!integer(frame.frameId)||!Number.isFinite(frame.time)||!Number.isFinite(frame.timeOrigin)||!Array.isArray(frame.views)||frame.views.length>limits.maxViews||!(inputEvent&&frame.head===null&&frame.views.length===0)&&(!xrFloats(frame.head,16)||frame.views.length<1)||!Array.isArray(frame.inputs)||frame.inputs.length>16||!Array.isArray(frame.bounds)||frame.bounds.length>768||frame.bounds.length%3!==0||!frame.bounds.every(Number.isFinite)||typeof frame.visibility!=='string'||frame.visibility.length>64||!Number.isFinite(frame.frameRate)||!Array.isArray(frame.supportedFrameRates)||frame.supportedFrameRates.length>64||!frame.supportedFrameRates.every(Number.isFinite))return false;
 if(!integer(frame.layerBytes,limits.maxBytes)||frame.layerBytes<1)return false;
 for(const view of frame.views){const rect=view?.viewport;if(!xrFloats(view?.transform,16)||!xrFloats(view?.projection,16)||!rect||!integer(rect.x,limits.maxDimension)||!integer(rect.y,limits.maxDimension)||!integer(rect.width,limits.maxDimension)||!integer(rect.height,limits.maxDimension)||!rect.width||!rect.height)return false;}
 const ids=new Set<number>();for(const input of frame.inputs){if(!input||!integer(input.id,15)||ids.has(input.id)||!xrFloats(input.target,16)||!integer(input.targetRayMode,3)||!Number.isInteger(input.touchIndex)||input.touchIndex< -1||input.touchIndex>4||input.grip!==null&&!xrFloats(input.grip,16)||typeof input.standardMapping!=='boolean'||!Array.isArray(input.buttons)||input.buttons.length>10||!input.buttons.every(Number.isFinite)||!Array.isArray(input.axes)||input.axes.length>10||!input.axes.every(Number.isFinite)||input.handJoints!==null&&!xrFloats(input.handJoints,400)||input.handRadii!==null&&!xrFloats(input.handRadii,25))return false;ids.add(input.id);}
 return true;
}
export function validXRFrame(value:unknown,limits:WorkerXRLimits):value is WorkerXRFrame{return validXRObservation(value,limits,false);}
export function validXRInputFrame(value:unknown,limits:WorkerXRLimits):value is WorkerXRInputFrame{return validXRObservation(value,limits,true);}
export function validXRSessionState(value:unknown):value is WorkerXRSessionState{
 const state=value as WorkerXRSessionState;return !!state&&typeof state.visibility==='string'&&state.visibility.length<=64&&Array.isArray(state.bounds)&&state.bounds.length<=768&&state.bounds.length%3===0&&state.bounds.every(Number.isFinite)&&Number.isFinite(state.frameRate)&&Array.isArray(state.supportedFrameRates)&&state.supportedFrameRates.length<=64&&state.supportedFrameRates.every(Number.isFinite);
}
