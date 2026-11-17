/** Native interfaces for the direct engine renderer. No NativePort runtime. */
import * as React from 'react';
import * as Engine from './engine';
import {nativeCall,nativeIdentity} from './engine-native';
import {nativeInterfaceSchema,snapshotNativeDTO,encodeNativeRpcArguments,nativeInterfaceCodec as codec,nativeInterfaceFailure as fail,nativeInterfaceDataObject as dataObject,type NativeInterfaceToken,type NativeInterfaceHandlers,type NativeCallback,type NativeRpcContext,type SynchronousNativeHandlers} from './native-interface-contracts';
import {registerNativeEndpoint,unregisterNativeEndpoint} from './native-interface-dispatch';
export {defineNativeInterface,validateNativeInterfaceSchema,nativeInterfaceSchemaHash,nativeInterfaceSchema,snapshotNativeDTO,encodeNativeRpcArguments} from './native-interface-contracts';
export type {NativeInterfaceToken,NativeInterfaceSchema,NativeInterfaceHandlers,SynchronousNativeHandlers,NativeRpcContext,NativeDTO} from './native-interface-contracts';
export {dispatchNativeInterface} from './native-interface-dispatch';
declare const require:(name:string)=>any;

export interface EngineInterfaceRoot {
 readonly godot:any;
 isNativeOwned(node:object):boolean;
 enqueueNativeCallback(callback:()=>void):void;
 onShutdown(callback:()=>void):()=>void;
 recordError(error:unknown):void;
}
interface Binding {node:any;identity:string;token:NativeInterfaceToken;active:boolean;ready:boolean;delivered:boolean;registration?:{lease:object;handlers:NativeInterfaceHandlers;ref?:React.RefObject<any>};drop():void}
interface Registration {ref:React.RefObject<any>;token:NativeInterfaceToken;handlers:NativeInterfaceHandlers;active:boolean;binding?:Binding;drop?:()=>void}
let endpointSerial=0;
const registries=new WeakMap<object,EngineNativeInterfaceRegistry>();

/** One root owns endpoint admission; shutdown revokes it before native release. */
export class EngineNativeInterfaceRegistry {
 private readonly bindings=new Map<object,Binding>();
 private readonly refs=new Set<Registration>();
 private active=true;
 private detach:()=>void;
 constructor(private readonly root:EngineInterfaceRoot,readonly worldId:string){
  if(typeof worldId!=='string'||!worldId||worldId.length>256)fail('A native world identity is required');
  this.detach=root.onShutdown(()=>this.dispose());
 }
 bind(node:any,token:NativeInterfaceToken):()=>void {
  const schema=nativeInterfaceSchema(token);
  if(!this.active||!this.root.isNativeOwned(node)||this.bindings.has(node))fail('Endpoint must belong to the active engine root');
  if(!nativeCall(node,'is_class',schema.nativeLeaf))fail('Endpoint does not inherit its declared native class');
  const identity='ni1:'+this.worldId+':'+nativeIdentity(node)+':'+(++endpointSerial);
  const binding:Binding={node,identity,token,active:true,ready:false,delivered:false,drop:()=>{}};
  registerNativeEndpoint(identity,binding,(profile,hash,method,args,context)=>this.dispatch(binding,profile,hash,method,args,context));
  const drop=()=>{
   if(!binding.active)return;binding.active=false;binding.registration=undefined;
   unregisterNativeEndpoint(identity,binding);if(this.bindings.get(node)===binding)this.bindings.delete(node);
   for(const registration of this.refs)if(registration.binding===binding){registration.drop?.();registration.drop=undefined;registration.binding=undefined;}
  };
  binding.drop=drop;this.bindings.set(node,binding);
  try {
   // Set before add_child can synchronously deliver the generated _ready stub.
   nativeCall(node,'set_meta','__godot_react_identity',identity);
   this.root.enqueueNativeCallback(()=>this.refreshRefs());
  }catch(error){drop();throw error;}
  return drop;
 }
 commitRef(ref:React.RefObject<any>,token:NativeInterfaceToken,handlers:NativeInterfaceHandlers):()=>void {
  if(!this.active||[...this.refs].some(item=>item.ref===ref))fail('Only one live handler registration is allowed per ref');
  const schema=nativeInterfaceSchema(token),data=dataObject(handlers,'handlers');
  for(const [name,callback]of Object.entries(data))if(typeof callback!=='function'||(!schema.callbacks.includes(name as NativeCallback)&&!Object.hasOwn(schema.rpc,name)))fail('Undeclared native handler '+name);
  const registration:Registration={ref,token,handlers:Object.freeze({...handlers}),active:true};this.refs.add(registration);
  try{this.refresh(registration);}catch(error){this.refs.delete(registration);throw error;}
  return()=>{registration.active=false;registration.drop?.();this.refs.delete(registration);};
 }
 send(node:object|null,token:NativeInterfaceToken,method:string,args:readonly unknown[],peerId?:number):Readonly<{localError:number}>{
  node=this.refNode(node);
  const binding=node?this.bindings.get(node):undefined;
  if(!binding||!this.live(binding)||binding.token.profile!==token.profile||binding.token.schemaHash!==token.schemaHash)fail('RPC target is no longer live');
  if(peerId!==undefined&&(!Number.isSafeInteger(peerId)||peerId<=0||peerId>2147483647))fail('Invalid RPC peer');
  const wire=encodeNativeRpcArguments(token,method,args);
  const result=peerId===undefined?nativeCall(node,'rpc',method,...wire):nativeCall(node,'rpc_id',peerId,method,...wire);
  const localError=Number(result);if(!Number.isSafeInteger(localError)||localError<0)fail('Native RPC returned an invalid Error code');
  return Object.freeze({localError});
 }
 dispose():void {
  if(!this.active)return;this.active=false;
  for(const item of this.refs){item.active=false;item.drop?.();}this.refs.clear();
  for(const binding of [...this.bindings.values()])binding.drop();
  this.detach?.();
 }
 private live(binding:Binding):boolean{return this.active&&binding.active&&this.bindings.get(binding.node)===binding&&this.root.isNativeOwned(binding.node);}
 private refreshRefs():void {if(this.active)for(const registration of this.refs)this.refresh(registration);}
 private refresh(registration:Registration):void {
  if(!registration.active||!this.active)return;
  const node=this.refNode(registration.ref.current),binding=node?this.bindings.get(node):undefined;
  if(binding===registration.binding&&(!node||binding))return;
  registration.drop?.();registration.binding=undefined;registration.drop=undefined;
  if(!node)return;
  if(!binding||!this.live(binding))fail('Handler ref belongs to a foreign root or expired endpoint');
  if(binding.token.profile!==registration.token.profile||binding.token.schemaHash!==registration.token.schemaHash)fail('Handler schema differs from construction token');
  if(binding.registration)fail('Endpoint already has handlers');
  const lease={};binding.registration={lease,handlers:registration.handlers,ref:registration.ref};registration.binding=binding;
  registration.drop=()=>{if(binding.registration?.lease===lease)binding.registration=undefined;};
  if(binding.ready&&!binding.delivered)this.enqueue(binding,'_ready',[]);
 }
 private dispatch(binding:Binding,profile:string,hash:string,method:string,args:readonly unknown[],context?:NativeRpcContext):boolean {
  if(!this.live(binding)||binding.token.profile!==profile||binding.token.schemaHash!==hash)return false;
  try{
   const schema=nativeInterfaceSchema(binding.token);let copied:readonly unknown[];
   if(Object.hasOwn(schema.rpc,method)){
    const spec=schema.rpc[method];if(!Array.isArray(args)||args.length!==spec.arguments.length)fail('RPC argument count mismatch');
    const senderPeerId=context?.senderPeerId??0;
    if(!Number.isSafeInteger(senderPeerId)||senderPeerId<0||senderPeerId>2147483647)fail('Invalid RPC sender context');
    copied=Object.freeze([...args.map((value,index)=>codec(value,spec.arguments[index],true)),Object.freeze({senderPeerId})]);
   }else{
    if(!schema.callbacks.includes(method as NativeCallback))fail('Undeclared native callback');
    if(method==='_ready'){if(args.length)fail('_ready takes no arguments');if(binding.ready)return true;binding.ready=true;copied=[];}
    else if(method==='_process'||method==='_physics_process'){if(args.length!==1||typeof args[0]!=='number'||!Number.isFinite(args[0])||args[0]<0)fail('Invalid frame delta');copied=Object.freeze([args[0]]);}
    else {if(args.length!==1)fail('Input callback takes one DTO');copied=Object.freeze([snapshotNativeDTO(args[0])]);}
   }
   if(binding.registration)this.enqueue(binding,method,copied);return true;
  }catch(error){this.root.recordError(error);return false;}
 }
 private enqueue(binding:Binding,method:string,args:readonly unknown[]):void {
  this.root.enqueueNativeCallback(()=>{
   if(!this.live(binding)||(method==='_ready'&&binding.delivered))return;
   const registration=binding.registration;
   if(registration?.ref&&this.refNode(registration.ref.current)!==binding.node)return;
   const callback=registration?.handlers[method];if(!callback)return;
   if(method==='_ready')binding.delivered=true;
   try{
    const result=callback(...args);
    if(result&&typeof (result as any).then==='function'){
     binding.drop();void Promise.resolve(result).catch(error=>this.root.recordError(error));fail('Native handlers must be synchronous; endpoint revoked');
    }
   }catch(error){this.root.recordError(error);}
  });
 }
 private refNode(value:object|null):any {
  if(!value)return null;
  // Typed components mint read handles; raw EngineNode refs stay on the small
  // direct-renderer path. Only the component registry can unwrap a handle.
  if(Object.hasOwn(value,'nativeKey'))return require('./engine-component-runtime').tryEngineHandleNode(value,this.root)??value;
  return value;
 }
}

export function engineNativeInterfaces(root:EngineInterfaceRoot,worldId?:string):EngineNativeInterfaceRegistry {
 let registry=registries.get(root);
 if(!registry){
  const internal=worldId===undefined?require('godot-jsb').internal:undefined;
  const id=worldId??internal?.native_runtime?.worldId??internal?.acquire_renderer_world?.('engine');
  registry=new EngineNativeInterfaceRegistry(root,id);registries.set(root,registry);
 }
 return registry;
}
/** Called by renderer materialization, before the node enters its native tree. */
export function bindEngineNativeInterface(root:EngineInterfaceRoot,node:object,token:NativeInterfaceToken):()=>void {return engineNativeInterfaces(root).bind(node,token);}
export function useEngineNativeInterface<T extends object,H extends NativeInterfaceHandlers>(ref:React.RefObject<T|null>,token:NativeInterfaceToken,handlers:H&SynchronousNativeHandlers<H>):Readonly<{send(method:string,args:readonly unknown[],options?:{peerId?:number}):Readonly<{localError:number}>}> {
 const accessor=(Engine as unknown as {getCurrentEngineRoot?:()=>EngineInterfaceRoot|null}).getCurrentEngineRoot;
 const root=accessor?.();if(!root)fail('Native interface hooks require an engine root');
 const registry=engineNativeInterfaces(root);
 React.useLayoutEffect(()=>registry.commitRef(ref,token,handlers));
 return React.useMemo(()=>Object.freeze({send:(method:string,args:readonly unknown[],options?:{peerId?:number})=>registry.send(ref.current,token,method,args,options?.peerId)}),[registry,ref,token]);
}
