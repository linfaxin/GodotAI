import * as React from "react";
import type { NativeKey, NativeOpResult, CommitTicket, AssetRef } from "./contracts";
import { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS, assertCompatibility, validateNativeKey } from "./contracts";
import type { NativePort, RuntimePhase } from "./native-port";
import { snapshotNativeDTO } from "./native-interfaces";
import { getProfileSchema } from "./schema";
import { createRoot, type ReactRootOptions } from "./runtime";
declare const require:(name:string)=>any;
interface Bridge {
  descriptor?:{engine:string;godotVersion:string;nativeBridgeAbi:string};
  abi:number|string; openRoot(raw:unknown,id:string,instance:string,generation?:string):{cap:unknown;key:NativeKey};
  beginStage(cap:unknown,phase:string):void;endStage(cap:unknown):void;
  create(cap:unknown,type:string,profile?:string):NativeKey;read(cap:unknown,key:NativeKey,name:string):unknown;
  set(cap:unknown,key:NativeKey,name:string,value:unknown):unknown;append(cap:unknown,parent:NativeKey,child:NativeKey,index:number):void;
  remove(cap:unknown,parent:NativeKey,child:NativeKey):void;free(cap:unknown,key:NativeKey,retirementBatch?:string):void;
  children(cap:unknown,key:NativeKey):NativeKey[];info(cap:unknown,key:NativeKey):any;isAlive(cap:unknown,key:NativeKey):boolean;
  connect(cap:unknown,key:NativeKey,signal:string,callback:(...args:unknown[])=>void):number;disconnect(cap:unknown,id:number):void;
  audit?(cap:unknown):void;
  takeInvalidations(cap:unknown):any[];call?(cap:unknown,key:NativeKey,method:string,args:unknown[]):unknown;
  setOwner?(cap:unknown,key:NativeKey,owner:NativeKey|null):void;
  loadAsset?(cap:unknown,path:string,type:string):AssetRef;releaseAsset?(cap:unknown,id:string):void;
  nativeIdentity?(cap:unknown,key:NativeKey):string;
  nativeRpc?(cap:unknown,key:NativeKey,method:string,args:readonly unknown[],peerId?:number):number;
  localizeAsset?(cap:unknown,id:string,instance:string,root:NativeKey):unknown;
  finishAssetScope?(cap:unknown,instance:string):void;releaseAssetScope?(cap:unknown,instance:string):void;
  quiesceRoot?(cap:unknown):void;
  closeRoot?(cap:unknown,force?:boolean):void;shutdownRequested?(cap:unknown):boolean;
}
const encode=(value:unknown):unknown=>{
 if(value&&typeof value==="object"){
  if(Array.isArray(value))return value.map(encode);
  const v=value as Record<string,unknown>;
  if(v.position&&v.size&&!v.kind)return {kind:(v.position as any).z===undefined?"Rect2":"AABB",position:encode(v.position),size:encode(v.size)};
  if(v.basis&&v.origin&&!v.kind)return {kind:(v.origin as any).z===undefined?"Transform2D":"Transform3D",basis:Object.fromEntries(Object.entries(v.basis as object).map(([k,v])=>[k,encode(v)])),origin:encode(v.origin)};
  if(typeof v.w==="number"&&typeof v.x==="number"&&!v.kind)return {kind:"Quaternion",x:v.x,y:v.y,z:v.z,w:v.w};
  if(typeof v.x==="number"&&typeof v.y==="number"&&typeof v.z==="number"&&!v.kind)return {kind:"Vector3",x:v.x,y:v.y,z:v.z};
  if(typeof v.x==="number"&&typeof v.y==="number"&&!v.kind)return {kind:"Vector2",x:v.x,y:v.y};
  if(typeof v.r==="number"&&typeof v.g==="number"&&typeof v.b==="number"&&typeof v.a==="number"&&!v.kind)return {kind:"Color",r:v.r,g:v.g,b:v.b,a:v.a};
 }return value;
};
const decode=(value:unknown):any=>{
 if(value&&typeof value==="object"){
  if(Array.isArray(value))return Object.freeze(value.map(decode));
  const v=value as any;
  if(v.kind==="Rect2"||v.kind==="AABB")return Object.freeze({position:decode(v.position),size:decode(v.size)});
  if(v.kind==="Vector2"||v.kind==="Vector2i")return Object.freeze({x:v.x,y:v.y});
  if(v.kind==="Vector3"||v.kind==="Vector3i")return Object.freeze({x:v.x,y:v.y,z:v.z});
  if(v.kind==="Quaternion")return Object.freeze({x:v.x,y:v.y,z:v.z,w:v.w});
  if(v.kind==="Transform2D")return Object.freeze({origin:decode(v.origin),basis:Object.freeze({x:decode(v.basis.x),y:decode(v.basis.y)})});
  if(v.kind==="Transform3D")return Object.freeze({origin:decode(v.origin),basis:Object.freeze({x:decode(v.basis.x),y:decode(v.basis.y),z:decode(v.basis.z)})});
  if(v.kind==="Color")return Object.freeze({r:v.r,g:v.g,b:v.b,a:v.a});
  if(v.kind==="AssetRef")return Object.freeze({kind:"asset",id:v.id,type:v.type,scope:"shared"});
  return Object.freeze(Object.fromEntries(Object.entries(v).map(([key,item])=>[key,decode(item)])));
 }return value;
};
export function createGodotPort(nativeRoot:unknown,options:{rootId:string;rootInstance:string;generation?:string;bridge?:Bridge;openedRoot?:{cap:unknown;key:NativeKey}}):{port:NativePort;containerKey:NativeKey;shutdownRequested:()=>boolean}{
 const bridge:Bridge=options.bridge??require("godot-jsb").internal.react;
 if(!bridge||(bridge.abi!==1&&bridge.abi!==NATIVE_BRIDGE_ABI))throw new Error("E_NATIVE_ABI: GodotJS React bridge ABI 1 is required");
 for(const method of ["audit","quiesceRoot","closeRoot","takeInvalidations"] as const)if(typeof bridge[method]!=="function")throw new Error(`E_NATIVE_ABI: required bridge method ${method} is unavailable`);
 const opened=options.openedRoot??bridge.openRoot(nativeRoot,options.rootId,options.rootInstance,options.generation);const cap=opened.cap;
 let closed=false;let operation=0;let context:{ticket:CommitTicket;epoch:number}|undefined;const results:NativeOpResult[]=[];
 const record=<T>(name:string,verification:NativeOpResult["verification"],key:NativeKey|undefined,invoke:()=>T):T=>{
  const opId=`${context?.ticket.rootInstance??options.rootInstance}:c${context?.ticket.commitId??0}:e${context?.epoch??0}:${++operation}:${name}`;let result:NativeOpResult;
  try{const value=invoke();let diagnostic:unknown;try{if(value!==undefined)diagnostic=snapshotNativeDTO(value);}catch{}const resultKey=key??(name==="create"?value as NativeKey:undefined);result={opId,status:"applied",verification,...(resultKey?{nativeKey:Object.freeze({...resultKey})}:{}),...(diagnostic===undefined?{}:{value:diagnostic})};return value;}
  catch(error){const message=String(error),code=message.match(/E_[A-Z_]+/)?.[0];result={opId,status:code&&["E_NATIVE_LOST","E_ROOT_DISPOSED","E_ROOT_CAPABILITY"].includes(code)?"lost":"rejected",verification:"none",message,...(code?{code}:{}),...(key?{nativeKey:Object.freeze({...key})}:{})};throw error;}
  finally{results.push(Object.freeze(result!));if(results.length>256)results.shift();}
 };
 const port:NativePort={
  create:(type,profile)=>record("create","structure",undefined,()=>Object.freeze({...validateNativeKey(bridge.create(cap,type,profile))})),read:(key,name)=>decode(bridge.read(cap,key,name)),set:(key,name,value)=>record(`set.${name}`,"stored-state",key,()=>{const stored=bridge.set(cap,key,name,encode(value));if(stored===undefined)throw new Error(`E_NATIVE_ABI: ${name} setter returned no verified acknowledgement`);return decode(stored);}),
  append:(parent,child,index)=>record("append","structure",child,()=>bridge.append(cap,parent,child,index)),remove:(parent,child)=>record("remove","structure",child,()=>bridge.remove(cap,parent,child)),free:(key,batch)=>record("free","structure",key,()=>bridge.free(cap,key,batch)),
  setOwner:(key,owner)=>record("setOwner","structure",key,()=>{if(!bridge.setOwner)throw new Error("E_NATIVE_ABI: setOwner required");bridge.setOwner(cap,key,owner);}),
  children:key=>bridge.children(cap,key),info:key=>bridge.info(cap,key),isAlive:key=>!closed&&bridge.isAlive(cap,key),
  nativeIdentity:key=>{if(!bridge.nativeIdentity)throw new Error("E_NATIVE_ABI: nativeIdentity required");return bridge.nativeIdentity(cap,key);},
  nativeRpc:(key,method,args,peerId)=>{if(!bridge.nativeRpc)throw new Error("E_NATIVE_ABI: nativeRpc required");return bridge.nativeRpc(cap,key,method,args,peerId);},
  localizeAsset:(id,instance,root)=>{if(!bridge.localizeAsset)throw new Error("E_NATIVE_ABI: local assets unavailable");return decode(bridge.localizeAsset(cap,id,instance,root));},
  finishAssetScope:instance=>{if(!bridge.finishAssetScope)throw new Error("E_NATIVE_ABI: local asset scopes unavailable");bridge.finishAssetScope(cap,instance);},releaseAssetScope:instance=>bridge.releaseAssetScope?.(cap,instance),
  connect:(key,signal,callback)=>{const id=bridge.connect(cap,key,signal,(...args)=>callback(...args.map(decode)));let active=true;return()=>{if(active&&!closed){active=false;bridge.disconnect(cap,id);}};},
  beginStage:phase=>bridge.beginStage(cap,phase),endStage:()=>bridge.endStage(cap),takeInvalidations:()=>bridge.takeInvalidations(cap),setOperationContext:(ticket,epoch)=>{context={ticket:Object.freeze({...ticket}),epoch};},getNativeOperationResults:()=>Object.freeze([...results]),audit:()=>bridge.audit?.(cap),
  command:(key,method,args)=>record(`command.${method}`,"native-return",key,()=>{if(!bridge.call)throw new Error("E_NATIVE_ABI: command channel unavailable");return decode(bridge.call(cap,key,method,args.map(encode)));}),
  loadAsset:(path,type)=>{if(!bridge.loadAsset)throw new Error("E_NATIVE_ABI: asset channel unavailable");return decode(bridge.loadAsset(cap,path,type));},
  forceClose:()=>{if(!closed){bridge.closeRoot?.(cap,true);closed=true;}},
  releaseAsset:id=>bridge.releaseAsset?.(cap,id),quiesce:()=>{if(!bridge.quiesceRoot)throw new Error("E_NATIVE_ABI: quiesceRoot required");bridge.quiesceRoot(cap);},close:()=>{if(!closed){bridge.closeRoot?.(cap);closed=true;}},
 };
 return {port,containerKey:opened.key,shutdownRequested:()=>!closed&&!!bridge.shutdownRequested?.(cap)};
}
export interface ApplicationTicket {entryId:string;generation:string;runtimeAbi:string;nativeBridgeAbi?:string;rootInstance?:string;mode?:"development"|"production";manifest?:any;resources?:ReactRootOptions["assets"]}
export interface ApplicationOptions extends Partial<ReactRootOptions>{nativeOpenedRoot?:{cap:unknown;key:NativeKey}}
export function startApplication<P extends object>(nativeRoot:unknown,ticket:ApplicationTicket,Component:React.ComponentType<P>,props:P={} as P,options:ApplicationOptions={}){
 if(ticket.runtimeAbi!==RUNTIME_ABI)throw new Error(`E_RUNTIME_ABI: Expected ${RUNTIME_ABI}`);
 if(ticket.nativeBridgeAbi&&ticket.nativeBridgeAbi!==NATIVE_BRIDGE_ABI)throw new Error(`E_NATIVE_ABI: Expected ${NATIVE_BRIDGE_ABI}`);
 const {nativeOpenedRoot,...rootOptions}=options;
 if(ticket.manifest){const profile=getProfileSchema(ticket.manifest.profile?.id);assertCompatibility(ticket.manifest,{runtimeAbi:RUNTIME_ABI,nativeBridgeAbi:NATIVE_BRIDGE_ABI,react:REACT_VERSIONS,profileId:profile.profile.id,profileHash:profile.hash,generation:ticket.generation,mode:ticket.mode});if(rootOptions.profileId&&rootOptions.profileId!==profile.profile.id)throw new Error("E_PROFILE: root profile differs from manifest");}
 const bridge:Bridge=require("godot-jsb").internal.react;
 if(ticket.manifest){if(!bridge?.descriptor)throw new Error("E_NATIVE_ABI: missing native target descriptor");const descriptor=bridge.descriptor;if(descriptor.nativeBridgeAbi!==NATIVE_BRIDGE_ABI||descriptor.engine!==ticket.manifest.target.engine||descriptor.godotVersion!==ticket.manifest.target.godotVersion)throw new Error("E_NATIVE_ABI: compiled native target differs from manifest");}
 const rootInstance=ticket.rootInstance??`${ticket.entryId}:${Date.now()}`;
 const native=createGodotPort(nativeRoot,{rootId:ticket.entryId,rootInstance,generation:ticket.generation,openedRoot:nativeOpenedRoot,bridge});
 let root:ReturnType<typeof createRoot>|undefined;
 try {root=createRoot(native.port,native.containerKey,{...rootOptions,entryId:ticket.entryId,rootId:ticket.entryId,rootInstance,generation:ticket.generation,mode:ticket.mode??rootOptions.mode,profileId:ticket.manifest?.profile?.id??rootOptions.profileId,nativeScriptProfiles:ticket.manifest?.nativeScriptProfiles??rootOptions.nativeScriptProfiles,assets:ticket.manifest?.resources??ticket.resources??rootOptions.assets});
 const startup=ticket.manifest?.entries?.[ticket.entryId]?.startupAssets??[];root.preloadAssets(startup);
 root.render(React.createElement(Component,props));
 if(root.state==="faulted")throw root.getErrors()[0]??new Error("E_ROOT_FAULT");
 }catch(error){try{if(root)root.shutdown("startup-failure");else{native.port.quiesce?.();native.port.close?.();}}catch{}throw error;}
 const appRoot=root;
 const controller={root:appRoot,pump:(dt?:number)=>{if(native.shutdownRequested())controller.shutdown("publisher");else appRoot.pump(dt);},process:(dt:number)=>appRoot.process(dt),physics:(dt:number)=>appRoot.physics(dt),input:(event:unknown)=>appRoot.input(snapshotInputEvent(event)),render:(next:P)=>appRoot.render(React.createElement(Component,next)),shutdown:(reason?:string)=>appRoot.shutdown(reason)};
 return controller;
}

/** Reduces native InputEvent objects to immutable value data at the private adapter boundary. */
export function snapshotInputEvent(event:unknown):unknown {
 if(!event||typeof event!=="object")return event;
 const item=event as Record<string,any>;const dto:Record<string,unknown>={};
 const invoke=(name:string)=>{const camel=name.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());const fn=item[name]??item[camel];return typeof fn==="function"?fn.call(item):undefined;};
 dto.type=invoke("get_class")??"InputEvent";
 for(const name of ["device","index","pressure","double_click","pressed","echo","keycode","physical_keycode","unicode","button_index","button_mask","factor","axis","axis_value","action","strength","position","global_position","relative","velocity","shift_pressed","alt_pressed","ctrl_pressed","meta_pressed"]){let value;try{value=item[name]??item[name.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())];}catch{continue;}if(typeof value==="number"&&Number.isFinite(value)||typeof value==="string"||typeof value==="boolean")dto[name]=value;else if(value&&typeof value.x==="number"&&typeof value.y==="number")dto[name]=Object.freeze({x:value.x,y:value.y});}
 return Object.freeze(dto);
}
