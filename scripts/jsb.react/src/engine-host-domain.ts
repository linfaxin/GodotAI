import type {EngineRoot} from './engine';
import type {EngineComponentDomain,EngineHostContext} from './engine-component-runtime';
import {resolveEngineAsset,engineAssetValue,engineNodeValue,tryEngineHandleNode} from './engine-component-runtime';
import {nativeCall} from './engine-native';
import type {AssetRef} from './contracts';
declare const require:(name:string)=>any;

interface NativeHostOperations {
 abi:string;read(scope:unknown,node:object,name:string,value?:unknown,phase?:string):unknown;
 write(scope:unknown,node:object,name:string,value:unknown,phase:string):unknown;
 invoke(scope:unknown,node:object,name:string,args:readonly unknown[],phase:string):unknown;
 touch(scope:unknown,node:object):void;forget(scope:unknown,node:object):void;
 registerAsset(scope:unknown,id:string,resource:unknown):void;
 finalize(scope:unknown):void;quiesceScope(scope:unknown):void;disposeScope(scope:unknown):void;connect(scope:unknown,node:object,name:string,callback:(...args:unknown[])=>void):number;disconnect(scope:unknown,id:number):void;
}
interface ScopeState {scope:unknown;worldId:string;api:NativeHostOperations;active:boolean;closed:boolean;dirty:boolean;nodes:Set<object>;signals:Map<object,Set<()=>void>>}
const scopes=new WeakMap<EngineRoot,ScopeState>();
function api():NativeHostOperations|undefined {try{const value=require('godot-jsb').internal.native_host_operations;return value?.abi==='godot-engine-host-operations/1'?value:undefined;}catch{return undefined;}}
function state(root:EngineRoot,node?:object,readonly=false):ScopeState|undefined {
 const provider=api();if(!provider)return undefined;
 const context=readonly?root.nativeReadOperationContext(node!):root.nativeOperationContext(node);let current=scopes.get(root);
 if(!current){current={scope:context.scope,worldId:context.worldId,api:provider,active:true,closed:false,dirty:false,nodes:new Set(),signals:new Map()};scopes.set(root,current);}
 // Native External capabilities have no portable JavaScript equality semantics
 // (QuickJS uses an opaque VM tag). The root is the JS lifetime key; C++ checks
 // the cached token's environment, scope and live claim for every operation.
 if(current.closed||current.worldId!==context.worldId)throw Error('E_ENGINE_HOST_SCOPE: renderer scope changed');
 if(!readonly&&!current.active)throw Error('E_ENGINE_HOST_QUIESCING: only cleanup reads are admitted');
 if(node&&!current.nodes.has(node)){if(!readonly)provider.touch(current.scope,node);current.nodes.add(node);}
 return current;
}
/** DTO encoding is shared in shape with the retained format adapter, without
 * importing its renderer, NodeKeys, root registry or VM wrapper pins. */
function encode(root:EngineRoot,value:any,codec?:string,depth=0,context?:EngineHostContext):any {
 if(depth>64)throw Error('E_ENGINE_HOST_CODEC: value nesting exceeded');
 if(value==null||typeof value!=='object')return value;
 const node=tryEngineHandleNode(value,root);if(node)return node;
 if(value.kind==='asset')return resolveEngineAsset(root,value as AssetRef,context);
 if(Array.isArray(value)){
  if(codec==='vector2Array'||codec==='vector3Array'||codec==='colorArray')return {kind:codec==='vector2Array'?'PackedVector2Array':codec==='vector3Array'?'PackedVector3Array':'PackedColorArray',values:value.map(item=>encode(root,item,undefined,depth+1,context))};
  return value.map(item=>encode(root,item,codec==='vector2iArray'?'vector2i':undefined,depth+1,context));
 }
 // Native wrappers are passed through; the provider resolves their generation
 // and verifies every Node against its opaque authoritative claim scope.
 if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return value;
 const nested=(item:any)=>encode(root,item,undefined,depth+1,context);
 if(value.position&&value.size&&!value.kind)return {kind:codec==='aabb'||'z'in value.position?'AABB':'Rect2',position:nested(value.position),size:nested(value.size)};
 if(value.basis&&value.origin&&!value.kind)return {kind:'z'in value.origin?'Transform3D':'Transform2D',basis:Object.fromEntries(Object.entries(value.basis).map(([key,item])=>[key,nested(item)])),origin:nested(value.origin)};
 if(typeof value.w==='number'&&typeof value.x==='number'&&!value.kind)return {kind:'Quaternion',...value};
 if(typeof value.x==='number'&&typeof value.y==='number'&&!value.kind)return {kind:codec==='vector2i'?'Vector2i':codec==='vector3i'?'Vector3i':'z'in value?'Vector3':'Vector2',...value};
 if(typeof value.r==='number'&&typeof value.a==='number'&&!value.kind)return {kind:'Color',...value};
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,nested(item)]));
}
function decode(root:EngineRoot,value:any,depth=0,context?:EngineHostContext):any {
 if(depth>64)throw Error('E_ENGINE_HOST_CODEC: result nesting exceeded');
 if(value==null||typeof value!=='object')return value;
 if(Array.isArray(value))return Object.freeze(value.map(item=>decode(root,item,depth+1,context)));
 if(typeof(value.is_class??value.isClass)==='function'){
  if(nativeCall(value,'is_class','Resource'))return context?.readAsset?.(root,value)??engineAssetValue(root,value);
  if(nativeCall(value,'is_class','Node'))return engineNodeValue(root,value);
 }
 const result=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='kind'||!['Vector2','Vector2i','Vector3','Vector3i','Quaternion','Color','Rect2','AABB','Transform2D','Transform3D'].includes(value.kind)).map(([key,item])=>[key,decode(root,item,depth+1,context)]));
 return Object.freeze(result);
}
export const engineHostDomain:EngineComponentDomain={
 registerAsset(root,descriptor,resource){const current=state(root);if(!current)return;if(typeof current.api.registerAsset!=='function')throw Error('E_ENGINE_HOST_API: native asset registration is unavailable');current.api.registerAsset(current.scope,descriptor.id,resource);},
 read(root,node,property,context){const current=state(root,node,true);if(!current)return undefined;return {value:decode(root,current.api.read(current.scope,node,property.nativeName),0,context)};},
 write(root,node,property,value,context){const current=state(root,node);if(!current)return false;if(!root.session.hasPermission())throw Error('E_ENGINE_HOST_PHASE: property writes require a commit');current.api.write(current.scope,node,property.nativeName,encode(root,value,property.codec,0,context),'safe');current.dirty=true;return true;},
 invoke(root,node,command,args,context){const current=state(root,node);if(!current)return undefined;return {value:decode(root,current.api.invoke(current.scope,node,command.nativeName,args.map((item,index)=>encode(root,item,command.arguments[index],0,context)),command.phase),0,context)};},
 connect(root,node,signal,callback){
  const current=state(root,node);if(!current)return undefined;
  if(typeof current.api.connect!=='function')throw Error('E_ENGINE_HOST_API: native signal registration is unavailable');
  const id=current.api.connect(current.scope,node,signal.nativeName,(...args)=>{if(current.active&&root.isNativeOwned(node))callback(...args.map(value=>decode(root,value)));});
  let active=true;const dispose=()=>{if(!active)return;active=false;current.signals.get(node)?.delete(dispose);if(root.nativeCleanupAvailable())current.api.disconnect(current.scope,id);};
  let list=current.signals.get(node);if(!list)current.signals.set(node,list=new Set());list.add(dispose);return dispose;
 },
 afterCommit(root){const current=scopes.get(root);if(current?.active&&current.dirty){current.api.finalize(current.scope);current.dirty=false;}},
 disposeNode(root,node){const current=scopes.get(root);if(!current)return;for(const dispose of current.signals.get(node)??[])dispose();current.signals.delete(node);if(!current.closed&&current.nodes.delete(node)&&root.nativeCleanupAvailable())current.api.forget(current.scope,node);},
 quiesceRoot(root){const current=scopes.get(root);if(!current||!current.active||current.closed)return;current.active=false;for(const list of current.signals.values())for(const dispose of list)dispose();current.signals.clear();if(root.nativeCleanupAvailable())current.api.quiesceScope(current.scope);},
 disposeRoot(root){const current=scopes.get(root);if(!current||current.closed)return;current.active=false;current.closed=true;for(const list of current.signals.values())for(const dispose of list)dispose();current.signals.clear();if(root.nativeCleanupAvailable())current.api.disposeScope(current.scope);current.nodes.clear();},
};
