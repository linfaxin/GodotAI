import * as React from 'react';
import {EngineNode,getCurrentEngineRoot,useFrame,type EngineRoot,type NativeConstructor} from './engine';
import {nativeCall,nativeIdentity,nativeAlive,sequence} from './engine-native';
import {createEngineNodeIntegration,engineNodeIntegration,type EngineNodeIntegration} from './engine-node-integration';
import {getHostSchema,validateHostProps,orderedPropertyNames,canonicalFields,validateValue,valuesEqual,type PropertySchema,type CommandSchema,type SignalSchema,type ValidatedHostProps} from './schema';
import type {AssetRef} from './contracts';
import {nativeInterfaceSchema,type NativeInterfaceToken} from './native-interface-contracts';
import {registerNodeCapability} from './node-capability';
import {engineHostDomain} from './engine-host-domain';
declare const require:(name:string)=>any;

export interface EngineComponentDomain {
 read?(root:EngineRoot,node:any,property:PropertySchema,context?:EngineHostContext):{value:unknown}|undefined;
 write?(root:EngineRoot,node:any,property:PropertySchema,value:unknown,context?:EngineHostContext):boolean;
 invoke?(root:EngineRoot,node:any,command:CommandSchema,args:readonly unknown[],context?:EngineHostContext):{value:unknown}|undefined;
 connect?(root:EngineRoot,node:any,signal:SignalSchema,callback:(...args:unknown[])=>void):(()=>void)|undefined;
 disposeNode?(root:EngineRoot,node:any):void;
 afterCommit?(root:EngineRoot):void;
 registerAsset?(root:EngineRoot,descriptor:AssetRef,resource:unknown):void;
 quiesceRoot?(root:EngineRoot):void;
 disposeRoot?(root:EngineRoot):void;
}
export interface EngineComponentOptions {
 mode?:'development'|'production';
 profileId?:string;
 assets?:Readonly<Record<string,{uri?:string;path?:string;type:string}>>;
 nativeScriptProfiles?:Readonly<Record<string,{type:string;script:string;schemaHash?:string}>>;
 domain?:EngineComponentDomain;
}
export interface EngineComponentServices {
 readonly root:EngineRoot;readonly options:EngineComponentOptions;
 dispose():void;preloadAssets(ids:readonly string[]):void;
 assetStatus():{requested:string[];ready:string[];failures:string[]};
 getDiagnostics():readonly Readonly<Record<string,unknown>>[];
}
export interface NodeReadHandle<K extends string=string> {
 readonly id:string;readonly type:K;readonly nativeKey:Readonly<{worldId:string;objectId:string}>;
 isValid():boolean;read<T=unknown>(property:string):T;
 readPosition():NodeVector<K>;readVelocity():NodeVector<K>;
}
export type NodeVector<K extends string=string>=string extends K?Readonly<{x:number;y:number;z?:number}>:K extends `${string}3D`?Readonly<{x:number;y:number;z:number}>:Readonly<{x:number;y:number}>;
export type NodeRef<K extends string=string>=React.RefObject<NodeReadHandle<K>|null>;
export interface FrameOptions {readonly writes?:readonly string[];readonly priority?:number;readonly active?:boolean;readonly inputPhase?:'raw'|'unhandled'}
export interface FrameCommands<K extends string=string> extends NodeReadHandle<K> {
 readonly writableFields:readonly string[];command<T=unknown>(name:string,...args:readonly unknown[]):T;
 setPosition(value:NodeVector<K>):void;setVelocity(value:NodeVector<K>):void;moveAndSlide():boolean;
}
export interface EngineHostContext {
 templateInitial?:Readonly<Record<string,unknown>>;allowInstanceResources?:boolean;parentType?:string;
 resolveAsset?(root:EngineRoot,asset:AssetRef):unknown;
 readAsset?(root:EngineRoot,resource:unknown):AssetRef|undefined;
}
interface HostState {root:EngineRoot;type:string;node:any;handle:NodeReadHandle;validated?:ValidatedHostProps;context:EngineHostContext;events:Map<string,{callback?:((...args:any[])=>unknown);dispose:()=>void}>;active:boolean;writing?:boolean}
interface FrameRegistration {state:HostState|undefined;ref:NodeRef;phase:'process'|'physics'|'input';options:FrameOptions;callback:(commands:FrameCommands,value:any)=>unknown;order:number}
interface Services extends EngineComponentServices {assets:Map<string,unknown>;assetTypes:Map<string,string>;nativeScripts:Map<string,{script:unknown;ctor:NativeConstructor}>;controlledDirty:Set<HostState>;requested:Set<string>;failures:Set<string>;frames:Set<FrameRegistration>;serial:number;active:boolean;unsubscribe:Array<()=>void>;diagnostics:Readonly<Record<string,unknown>>[]}
const services=new WeakMap<EngineRoot,Services>(),handles=new WeakMap<object,HostState>();
const nodeStates=new WeakMap<object,HostState>();
const ParentTypeContext=React.createContext<string|undefined>(undefined);
const failure=(code:string,message:string)=>Error(code+': '+message);
const virtual=(name:string)=>name.startsWith('__react_');
function service(root:EngineRoot):Services {let value=services.get(root);if(!value){configureEngineComponents(root,{});value=services.get(root)!;}return value;}
export function configureEngineComponents(root:EngineRoot,options:EngineComponentOptions={}):EngineComponentServices {
 options={...options,domain:options.domain??engineHostDomain};
 if(services.has(root))throw failure('E_ENGINE_COMPONENTS','Component services are already configured');
 if(root.getCloseProgress().status!=='open')throw failure('E_ENGINE_COMPONENTS','A closing root cannot configure component services');
 getHostSchema('Node',options.profileId);
 const value:Services={root,options:Object.freeze({...options}),assets:new Map(),assetTypes:new Map(),nativeScripts:new Map(),controlledDirty:new Set(),requested:new Set(),failures:new Set(),frames:new Set(),serial:0,active:true,unsubscribe:[],diagnostics:[],
  dispose(){if(!value.active)return;value.active=false;for(const dispose of value.unsubscribe.splice(0))dispose();value.frames.clear();value.controlledDirty.clear();options.domain?.quiesceRoot?.(root);},
  preloadAssets(ids){if(!value.active)throw failure('E_ENGINE_CLOSING','New asset requests are closed');for(const id of ids){const source=options.assets?.[id];if(!source)throw failure('E_ASSET_UNREGISTERED',id);resolveAsset(root,{kind:'asset',id,type:source.type,scope:'shared'});}},
  assetStatus(){return {requested:[...value.requested],ready:[...value.assets.keys()],failures:[...value.failures]};},
  getDiagnostics(){return [...value.diagnostics];},
 };
 services.set(root,value);value.unsubscribe.push(root.onShutdown(()=>value.dispose()));
 const detachLogical=root.onLogicalDispose(()=>{value.dispose();try{options.domain?.disposeRoot?.(root);}finally{value.assets.clear();value.assetTypes.clear();value.nativeScripts.clear();services.delete(root);}});
 if(options.domain?.afterCommit)value.unsubscribe.push(root.onCommit(()=>options.domain!.afterCommit!(root)));
 value.unsubscribe.push(root.onMaintenance(()=>restoreControlled(value)));
 value.unsubscribe.push(root.subscribeFrame('process',delta=>dispatchFrames(value,'process',delta)),root.subscribeFrame('physics',delta=>dispatchFrames(value,'physics',delta)));
 try{
  for(const [name,profile]of Object.entries(options.nativeScriptProfiles??{})){
   if(!profile.script.startsWith('res://')||!profile.script.endsWith('.ts')||profile.script.slice(6).split('/').some(part=>!part||part==='.'||part==='..')||/[\\\x00-\x1f]/.test(profile.script))throw failure('E_NATIVE_INTERFACE','A canonical generated TypeScript Script path is required');
   const script=nativeCall(root.godot[root.typeName('ResourceLoader')],'load',profile.script,'Script');
   if(!script||!nativeCall(script,'is_class','Script'))throw failure('E_NATIVE_INTERFACE','Native Script resource could not be loaded');
   const module='res://.godot/GodotJS/'+profile.script.slice(6,-3)+'.js',ctor=require(module)?.default;
   if(typeof ctor!=='function')throw failure('E_NATIVE_INTERFACE','Native Script module has no constructor');
   value.nativeScripts.set(name,{script,ctor});
  }
 }catch(error){value.dispose();detachLogical();try{options.domain?.disposeRoot?.(root);}finally{value.nativeScripts.clear();value.assets.clear();value.assetTypes.clear();services.delete(root);}throw error;}
 return value;
}
export function engineComponentServices(root:EngineRoot):EngineComponentServices {return service(root);}
function resolveAsset(root:EngineRoot,descriptor:AssetRef,context?:EngineHostContext):any {
 if(context?.resolveAsset)return context.resolveAsset(root,descriptor);
 if(descriptor.scope==='instance')throw failure('E_ASSET_SCOPE','Instance resources require a template resource scope');
 const value=service(root),source=value.options.assets?.[descriptor.id];value.requested.add(descriptor.id);
 if(value.assets.has(descriptor.id)&&(source?.type??value.assetTypes.get(descriptor.id))===descriptor.type)return value.assets.get(descriptor.id);
 if(!value.active)throw failure('E_ENGINE_CLOSING','New asset requests are closed');
 if(!source||source.type!==descriptor.type)throw failure('E_ASSET_UNREGISTERED',descriptor.id);
 try {const loader=root.godot[root.typeName('ResourceLoader')],resource=nativeCall(loader,'load',source.uri??source.path??descriptor.id);
  if(!resource||!nativeCall(resource,'is_class',descriptor.type))throw failure('E_ASSET_TYPE',descriptor.id);
  value.options.domain?.registerAsset?.(root,descriptor,resource);value.assets.set(descriptor.id,resource);return resource;
 }catch(error){value.failures.add(descriptor.id);throw error;}
}
export function resolveEngineAsset(root:EngineRoot,descriptor:AssetRef,context?:EngineHostContext):unknown {return resolveAsset(root,descriptor,context);}
export function engineAssetValue(root:EngineRoot,resource:any):AssetRef|null {
 if(!resource)return null;if(!nativeCall(resource,'is_class','Resource'))throw failure('E_ASSET_TYPE','A native Resource is required');
 const value=service(root);for(const [id,stored]of value.assets)if(stored===resource)return asset(id,value.options.assets?.[id]?.type??value.assetTypes.get(id)!);
 const id='@native:'+root.session.frameEpoch+':'+nativeIdentity(resource),type=String(nativeCall(resource,'get_class'));
 value.assets.set(id,resource);value.assetTypes.set(id,type);return asset(id,type);
}
export function engineNodeValue(root:EngineRoot,node:any):NodeReadHandle|Readonly<{kind:'unmanaged-node';objectId:string}>|null {
 if(!node)return null;const state=nodeStates.get(node);if(state&&state.root===root&&state.handle.isValid())return state.handle;
 return Object.freeze({kind:'unmanaged-node',objectId:nativeIdentity(node)});
}
/** Converts certified DTOs into the direct GodotJS Variant constructors. */
export function toEngineValue(root:EngineRoot,codec:string,value:any,context?:EngineHostContext):any {
 if(value==null)return value;
 if(value&&typeof value==='object'&&value.kind==='asset')return resolveAsset(root,value,context);
 const construct=(name:string,...args:any[])=>{const ctor=root.godot[root.typeName(name)];if(typeof ctor!=='function')throw failure('E_ENGINE_CODEC',name+' is unavailable');return new ctor(...args);};
 if(codec==='vector2'||codec==='vector2i')return construct(codec==='vector2'?'Vector2':'Vector2i',value.x,value.y);
 if(codec==='vector3'||codec==='vector3i')return construct(codec==='vector3'?'Vector3':'Vector3i',value.x,value.y,value.z);
 if(codec==='color')return construct('Color',value.r,value.g,value.b,value.a);
 if(codec==='quaternion')return construct('Quaternion',value.x,value.y,value.z,value.w);
 if(codec==='rect2'||codec==='aabb')return construct(codec==='rect2'?'Rect2':'AABB',toEngineValue(root,codec==='rect2'?'vector2':'vector3',value.position,context),toEngineValue(root,codec==='rect2'?'vector2':'vector3',value.size,context));
 if(codec==='transform2d')return construct('Transform2D',toEngineValue(root,'vector2',value.basis.x),toEngineValue(root,'vector2',value.basis.y),toEngineValue(root,'vector2',value.origin));
 if(codec==='transform3d'){const basis=construct('Basis',...['x','y','z'].map(key=>toEngineValue(root,'vector3',value.basis[key])));return construct('Transform3D',basis,toEngineValue(root,'vector3',value.origin));}
 if(codec==='vector2Array'||codec==='vector3Array'||codec==='vector2iArray')return construct(codec==='vector3Array'?'PackedVector3Array':codec==='vector2Array'?'PackedVector2Array':'Array',value.map((item:any)=>toEngineValue(root,codec==='vector3Array'?'vector3':codec==='vector2Array'?'vector2':'vector2i',item)));
 if(Array.isArray(value))return value.map(item=>item?.kind==='asset'?resolveAsset(root,item,context):item);
 return value;
}
export function fromEngineValue(root:EngineRoot,codec:string,value:any,context?:EngineHostContext):any {
 if(value==null)return value;
 if(codec==='assetRef')return context?.readAsset?.(root,value)??engineAssetValue(root,value);
 if(codec==='vector2'||codec==='vector2i')return Object.freeze({x:value.x,y:value.y});
 if(codec==='vector3'||codec==='vector3i')return Object.freeze({x:value.x,y:value.y,z:value.z});
 if(codec==='color')return Object.freeze({r:value.r,g:value.g,b:value.b,a:value.a});
 if(codec==='quaternion')return Object.freeze({x:value.x,y:value.y,z:value.z,w:value.w});
 if(codec==='rect2'||codec==='aabb')return Object.freeze({position:fromEngineValue(root,codec==='rect2'?'vector2':'vector3',value.position),size:fromEngineValue(root,codec==='rect2'?'vector2':'vector3',value.size)});
 if(codec.endsWith('Array'))return Object.freeze(sequence(value).map(item=>fromEngineValue(root,codec==='vector3Array'?'vector3':codec==='vector2Array'?'vector2':codec==='vector2iArray'?'vector2i':'unknown',item)));
 return value;
}
export function enginePropertyValues(root:EngineRoot,type:string,values:Readonly<Record<string,unknown>>,context?:EngineHostContext):Record<string,unknown> {
 const schema=getHostSchema(type,service(root).options.profileId),result:Record<string,unknown>={};
 for(const [name,value]of Object.entries(values)){const property=schema.properties[name];if(!property)throw failure('E_PROPERTY_UNSUPPORTED',type+'.'+name);if(virtual(property.nativeName))throw failure('E_ENGINE_COMPAT_UNSUPPORTED',property.nativeName);result[property.nativeName]=toEngineValue(root,property.codec,value,context);}
 return result;
}
function read(state:HostState,name:string):any {
 if(!state.active||!state.root.isNativeReadable(state.node))throw failure('E_ENGINE_REF','Host is no longer readable');
 const property=getHostSchema(state.type,service(state.root).options.profileId).properties[name];if(!property)throw failure('E_PROPERTY_UNSUPPORTED',state.type+'.'+name);
 const domain=service(state.root).options.domain,result=domain?.read?.(state.root,state.node,property,state.context);if(result)return result.value;
 if(virtual(property.nativeName))throw failure('E_ENGINE_COMPAT_UNSUPPORTED',property.nativeName);
 return fromEngineValue(state.root,property.codec,nativeCall(state.node,'get',property.nativeName),state.context);
}
function write(state:HostState,property:PropertySchema,value:any):void {
 if(!state.root.isNativeOwned(state.node))throw failure('E_ENGINE_STRUCTURE','Cannot write a transferred host');
 state.writing=true;
 try {
 const resolved=value?.kind==='asset'?resolveAsset(state.root,value,state.context):value;
 if(service(state.root).options.domain?.write?.(state.root,state.node,property,resolved,state.context))return;
 if(virtual(property.nativeName))throw failure('E_ENGINE_COMPAT_UNSUPPORTED',property.nativeName);
 state.root.writeProperty(state.node,property.nativeName,toEngineValue(state.root,property.codec,resolved,state.context));
 }finally{state.writing=false;}
}
const controlledFields:Readonly<Record<string,{field:string;signal:string}>>={TextureProgressBar:{field:'value',signal:'onValueChanged'},TextureButton:{field:'buttonPressed',signal:'onToggled'},ProgressBar:{field:'value',signal:'onValueChanged'},Button:{field:'buttonPressed',signal:'onToggled'},LineEdit:{field:'text',signal:'onTextChanged'},HSlider:{field:'value',signal:'onValueChanged'},CheckBox:{field:'buttonPressed',signal:'onToggled'},SpinBox:{field:'value',signal:'onValueChanged'},OptionButton:{field:'selected',signal:'onItemSelected'}};
function restoreControlled(value:Services):void {
 if(!value.active){value.controlledDirty.clear();return;}
 const dirty=[...value.controlledDirty];value.controlledDirty.clear();
 for(const state of dirty){
  if(!value.active||!state.active||!state.root.isNativeOwned(state.node))continue;
  const spec=controlledFields[state.type],validated=state.validated;
  if(!spec||!validated||!Object.hasOwn(validated.controlled,spec.field))continue;
  try{
   const desired=validated.controlled[spec.field],actual=read(state,spec.field),step=validated.controlled.step??validated.baseline.step;
   const quantized=['HSlider','SpinBox','ProgressBar','TextureProgressBar'].includes(state.type)&&spec.field==='value'&&typeof step==='number'&&step>0&&typeof actual==='number'&&typeof desired==='number'&&Math.abs(actual-desired)<=Math.max(1e-12*Math.max(1,Math.abs(desired)),step*1e-9);
   if(!quantized&&!valuesEqual(actual,desired))write(state,getHostSchema(state.type,value.options.profileId).properties[spec.field]!,desired);
  }catch(error){state.root.failSession(error);}
 }
}
function setRef(ref:React.ForwardedRef<NodeReadHandle>|undefined,value:NodeReadHandle|null):void {if(typeof ref==='function')ref(value);else if(ref)ref.current=value;}
export function engineHandleNode(handle:NodeReadHandle,root?:EngineRoot):any {const state=handles.get(handle);if(!state||root&&state.root!==root||!handle.isValid())throw failure('E_ENGINE_REF','Unknown or stale host handle');return state.node;}
export function tryEngineHandleNode(handle:unknown,root?:EngineRoot):any|undefined {if(!handle||typeof handle!=='object'||!handles.has(handle))return undefined;return engineHandleNode(handle as NodeReadHandle,root);}
function apply(state:HostState,props:Record<string,any>,initial:boolean):void {
 const value=service(state.root),token=props.nativeInterface as NativeInterfaceToken|undefined;if(token)nativeInterfaceSchema(token);
 const plain={...props};delete plain.nativeInterface;
 const validated=validateHostProps(state.type,plain,{previous:state.validated,profileId:value.options.profileId,parentType:state.context.parentType,templateInitial:state.context.templateInitial,allowInstanceResources:state.context.allowInstanceResources,allowedNativeScriptProfiles:Object.keys(value.options.nativeScriptProfiles??{})});
 const desired={...(initial?validated.baseline:{}),...validated.controlled};
 if(initial&&validated.name)desired.name=validated.name;
 if(!initial)for(const name of Object.keys(state.validated?.controlled??{}))if(!Object.hasOwn(validated.controlled,name))desired[name]=validated.baseline[name];
 const schema=getHostSchema(state.type,value.options.profileId);
 for(const name of orderedPropertyNames(state.type,value.options.profileId))if(Object.hasOwn(desired,name)){
  if(!initial&&valuesEqual(state.validated?.controlled[name],validated.controlled[name])&&Object.hasOwn(validated.controlled,name))continue;
  if(desired.layout!=null&&(name==='position'||name==='size')&&schema.properties.customMinimumSize)continue;
  write(state,schema.properties[name]!,desired[name]);
 }
 const wantedEvents=new Map<string,((...args:any[])=>unknown)|undefined>(Object.entries(validated.events)),controlled=controlledFields[state.type];
 if(controlled&&Object.hasOwn(validated.controlled,controlled.field)&&schema.signals[controlled.signal]&&!wantedEvents.has(controlled.signal))wantedEvents.set(controlled.signal,undefined);
 for(const [name,event]of [...state.events])if(!wantedEvents.has(name)){event.dispose();state.events.delete(name);}
 for(const [name,callback]of wantedEvents){
  const existing=state.events.get(name);if(existing){existing.callback=callback;continue;}
  const signal=schema.signals[name]!,slot={callback,dispose:()=>{}};
  const deliver=(...args:any[])=>{if(state.writing&&signal.echo==='suppress')return;const snapshot=args.map((item,index)=>fromEngineValue(state.root,signal.parameters[index]??'unknown',item));state.root.enqueueNativeCallback(()=>{if(!state.active||!state.root.isNativeOwned(state.node))return;if(controlled?.signal===name)value.controlledDirty.add(state);try{if(slot.callback)state.root.dispatchEvent(()=>slot.callback!(...snapshot));}catch(error){state.root.recordError(error);}});};
  const custom=value.options.domain?.connect?.(state.root,state.node,signal,deliver);
  if(custom)slot.dispose=custom;else {if(virtual(signal.nativeName))throw failure('E_ENGINE_COMPAT_UNSUPPORTED',signal.nativeName);const callable=state.root.godot.Callable.create(deliver);if(nativeCall(state.node,'connect',signal.nativeName,callable)!==0)throw failure('E_ENGINE_SIGNAL',signal.nativeName);slot.dispose=()=>{if(nativeAlive(state.root.godot,state.node)&&nativeCall(state.node,'is_connected',signal.nativeName,callable))nativeCall(state.node,'disconnect',signal.nativeName,callable);};}
  state.events.set(name,slot);
 }
 state.validated=validated;
 if(value.options.mode==='development')for(const diagnostic of validated.diagnostics)value.diagnostics.push(Object.freeze({...diagnostic,hostId:state.handle.id,type:state.type,nativeKey:state.handle.nativeKey}));
}
interface HostElementProps {type:string;values:Record<string,any>;forwardedRef?:React.ForwardedRef<NodeReadHandle>;integration?:EngineNodeIntegration;context?:EngineHostContext}
function HostElement({type,values,forwardedRef,integration,context:inputContext={}}:HostElementProps):React.ReactElement {
 const parentType=React.useContext(ParentTypeContext),context={...inputContext,parentType:inputContext.parentType??parentType};
 const root=useRoot(),value=service(root),schema=getHostSchema(type,value.options.profileId),state=React.useRef<HostState|undefined>(undefined);
 const token=values.nativeInterface as NativeInterfaceToken|undefined;if(token)nativeInterfaceSchema(token);
 const plain={...values};delete plain.nativeInterface;
 validateHostProps(type,plain,{previous:state.current?.validated,profileId:value.options.profileId,parentType:context.parentType,templateInitial:context.templateInitial,allowInstanceResources:context.allowInstanceResources,allowedNativeScriptProfiles:Object.keys(value.options.nativeScriptProfiles??{})});
 if(token&&Object.keys(nativeInterfaceSchema(token).rpc).length&&!values.name)throw failure('E_RPC_PATH','RPC endpoints require an explicit stable name');
 const profileName=token?.profile??values.nativeScriptProfile,profile=profileName?value.options.nativeScriptProfiles?.[profileName]:undefined;
 if(profileName&&(!profile||profile.type!==type||token&&profile.schemaHash!==token.schemaHash))throw failure('E_NATIVE_INTERFACE','Native construction profile is not registered');
 const ctor=profile?value.nativeScripts.get(profileName!)?.ctor:root.godot[root.typeName(schema.nativeType)];if(typeof ctor!=='function')throw failure('E_ENGINE_CONSTRUCTOR',schema.nativeType);
 const hooks=integration?engineNodeIntegration(integration):undefined;
 const adapter=createEngineNodeIntegration({
  afterCreate(owner,node){
   const dispose=hooks?.afterCreate?.(owner,node);
   try {
   const world=String((()=>{try{return require('godot-jsb').internal.native_runtime.worldId;}catch{return owner.session.frameEpoch;}})());
   const current={} as HostState;
   const handle:NodeReadHandle=Object.freeze({id:nativeIdentity(node),type,nativeKey:Object.freeze({worldId:world,objectId:nativeIdentity(node)}),isValid:()=>current.active&&owner.isNativeReadable(node),read:<T>(name:string)=>read(current,name) as T,readPosition:()=>read(current,'position'),readVelocity:()=>read(current,schema.properties.velocity?'velocity':'linearVelocity')});
   Object.assign(current,{root:owner,type,node,handle,context,events:new Map(),active:true});state.current=current;handles.set(handle,current);nodeStates.set(node,current);registerNodeCapability(handle,()=>engineHandleNode(handle,owner));
   return()=>{current.active=false;value.controlledDirty.delete(current);value.options.domain?.disposeNode?.(owner,node);for(const event of current.events.values())event.dispose();current.events.clear();nodeStates.delete(node);dispose?.();};
   }catch(error){dispose?.();throw error;}
  },
  apply(owner,node,initial){const current=state.current!;current.context=context;apply(current,values,initial);hooks?.apply?.(owner,node,initial);},
  afterSubtree:hooks?.afterSubtree,
 });
 React.useImperativeHandle(forwardedRef,()=>state.current!.handle);
 return React.createElement(EngineNode as any,{ctor,nativeInterface:token,__engineIntegration:adapter,children:React.createElement(ParentTypeContext.Provider,{value:type},values.children)});
}
export function createEngineHostElement(type:string,props:Record<string,any>,ref?:React.ForwardedRef<NodeReadHandle>,integration?:EngineNodeIntegration,context?:EngineHostContext):React.ReactElement {
 return React.createElement(HostElement,{type,values:props,forwardedRef:ref,integration,context});
}
export function useRoot():EngineRoot {const root=getCurrentEngineRoot();if(!root)throw failure('E_ENGINE_CONTEXT','A component requires an engine root');return root;}
export const useRuntime=useRoot;
export function useNodeRef<K extends string>():NodeRef<K> {useRoot();return React.useRef<NodeReadHandle<K>|null>(null);}
function dispatchFrames(value:Services,phase:FrameRegistration['phase'],payload:any,inputPhase='raw'):void {
 if(!value.active)return;
 validateFrames(value);
 const list=[...value.frames].filter(item=>item.phase===phase&&item.options.active!==false&&(phase!=='input'||(item.options.inputPhase??'raw')===inputPhase)).sort((a,b)=>(a.options.priority??0)-(b.options.priority??0)||a.order-b.order);
 for(const item of list){const state=item.ref.current?handles.get(item.ref.current):undefined;item.state=state;if(!state?.active||!state.handle.isValid())continue;
  if(typeof state.node.is_inside_tree==='function'&&!nativeCall(state.node,'is_inside_tree'))continue;
  const release=phase==='input'&&inputPhase==='raw'&&(payload?.type==='InputReset'||payload?.pressed===false||payload?.type==='InputModifiers'||payload?.type==='InputEventJoypadMotion'&&payload.axis_value===0);
  if(!release&&typeof(state.node.can_process??state.node.canProcess)==='function'&&!nativeCall(state.node,'can_process'))continue;
  const fields=canonicalFields(state.type,item.options.writes??[],state.context.parentType,value.options.profileId),reserved=state.validated!.engineOwned;if(fields.some(field=>!reserved.includes(field)))throw failure('E_PROPERTY_OWNER_CONFLICT','Frame writes must be reserved by engineOwned');
  let active=true;const check=()=>{if(!active||!value.active||!state.handle.isValid())throw failure('E_STALE_COMMAND','Commands escaped their dispatch');};
  const command=<T>(name:string,...args:unknown[]):T=>{check();const schema=getHostSchema(state.type,value.options.profileId),spec=schema.commands[name];if(!spec||spec.phase!==phase)throw failure('E_COMMAND_UNSUPPORTED',name);if(canonicalFields(state.type,spec.effects,undefined,value.options.profileId).some(field=>!fields.includes(field)))throw failure('E_PROPERTY_OWNER_CONFLICT',name);if(args.length!==spec.arguments.length)throw failure('E_VALUE','Command argument count mismatch');
   const checked=args.map((arg,index)=>validateValue(spec.arguments[index]!,arg));const resolved=checked.map(arg=>(arg as any)?.kind==='asset'?resolveAsset(state.root,arg as AssetRef,state.context):arg),custom=value.options.domain?.invoke?.(state.root,state.node,spec,resolved,state.context);if(custom)return custom.value as T;
   if(virtual(spec.nativeName))throw failure('E_ENGINE_COMPAT_UNSUPPORTED',spec.nativeName);return fromEngineValue(state.root,spec.result??'unknown',nativeCall(state.node,spec.nativeName,...resolved.map((arg,index)=>toEngineValue(state.root,spec.arguments[index]!,arg,state.context)))) as T;
  };
  const schema=getHostSchema(state.type,value.options.profileId),commands=Object.freeze({...state.handle,writableFields:fields,read:<T>(name:string)=>{check();return state.handle.read<T>(name);},readPosition:()=>{check();return state.handle.readPosition();},readVelocity:()=>{check();return state.handle.readVelocity();},command,setPosition:(v:unknown)=>command(schema.commands.setPosition?'setPosition':'setPosition3D',v),setVelocity:(v:unknown)=>command(schema.commands.setVelocity?'setVelocity':schema.commands.setVelocity3D?'setVelocity3D':'setLinearVelocity',v),moveAndSlide:()=>command<boolean>('moveAndSlide')}) as FrameCommands;
  try {const result=item.callback(commands,payload);if(result&&typeof(result as any).then==='function'){void Promise.resolve(result).catch(error=>value.root.recordError(error));throw failure('E_ASYNC_FRAME','Frame callbacks must be synchronous');}}finally{active=false;}
 }
}
function validateFrames(value:Services):void {
 const writers=new Set<HostState>();
 for(const item of value.frames){const state=item.ref.current?handles.get(item.ref.current):undefined;if(state&&state.root!==value.root)throw failure('E_FOREIGN_REF','Frame target belongs to another root');if(!state?.active||item.options.active===false)continue;
  const fields=canonicalFields(state.type,item.options.writes??[],state.context.parentType,value.options.profileId);if(!fields.length)continue;
  if(fields.some(field=>!state.validated!.engineOwned.includes(field)))throw failure('E_PROPERTY_OWNER_CONFLICT','Frame writes must be reserved by engineOwned');
  if(writers.has(state))throw failure('E_PROPERTY_WRITER_CONFLICT','Only one writing frame registration is supported per host');writers.add(state);
 }
}
function useDispatch<K extends string>(phase:FrameRegistration['phase'],ref:NodeRef<K>,options:FrameOptions,callback:(commands:FrameCommands<K>,value:any)=>unknown):void {
 const root=useRoot(),value=service(root);if(options.priority!==undefined&&!Number.isFinite(options.priority))throw failure('E_FRAME_OPTIONS','Priority must be finite');if(options.active!==undefined&&typeof options.active!=='boolean')throw failure('E_FRAME_OPTIONS','active must be boolean');if(options.inputPhase!==undefined&&!['raw','unhandled'].includes(options.inputPhase))throw failure('E_INPUT_PHASE','Unknown input channel');
 React.useLayoutEffect(()=>{const item:FrameRegistration={ref:ref as NodeRef,phase,options:Object.freeze({...options,writes:Object.freeze([...(options.writes??[])])}),callback:callback as any,order:++value.serial,state:undefined};value.frames.add(item);try{validateFrames(value);}catch(error){value.frames.delete(item);throw error;}return()=>{value.frames.delete(item);};});
}
type SyncCallback<F extends (...args:any[])=>unknown>=F&([Extract<ReturnType<F>,PromiseLike<unknown>>] extends [never]?unknown:never);
export function useProcess<K extends string,F extends (commands:FrameCommands<K>,delta:number)=>unknown>(ref:NodeRef<K>,options:FrameOptions,callback:SyncCallback<F>):void {useDispatch('process',ref,options,callback);}
export function usePhysicsProcess<K extends string,F extends (commands:FrameCommands<K>,delta:number)=>unknown>(ref:NodeRef<K>,options:FrameOptions,callback:SyncCallback<F>):void {useDispatch('physics',ref,options,callback);}
export function useInput<K extends string,F extends (commands:FrameCommands<K>,event:any)=>unknown>(ref:NodeRef<K>,callback:SyncCallback<F>,options:FrameOptions={}):void {useDispatch('input',ref,options,callback);}
export function snapshotEngineInput(event:unknown):unknown {
 if(!event||typeof event!=='object')return event;
 const source=event as Record<string,any>,dto:Record<string,unknown>={};
 try{dto.type=nativeCall(event,'get_class');}catch{dto.type=typeof source.type==='string'?source.type:'InputEvent';}
 for(const name of ['device','index','pressure','double_click','pressed','echo','keycode','physical_keycode','unicode','button_index','button_mask','factor','axis','axis_value','action','strength','position','global_position','relative','velocity','shift_pressed','alt_pressed','ctrl_pressed','meta_pressed']){
  let item;try{item=source[name]??source[name.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())];}catch{continue;}
  if(typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))dto[name]=item;
  else if(item&&typeof item.x==='number'&&typeof item.y==='number')dto[name]=Object.freeze({x:item.x,y:item.y});
 }
 return Object.freeze(dto);
}
export function dispatchEngineInput(root:EngineRoot,event:unknown,unhandled=false):void {const value=services.get(root);if(value)dispatchFrames(value,'input',snapshotEngineInput(event),unhandled?'unhandled':'raw');}
export function useUnhandledInput<K extends string,F extends (commands:FrameCommands<K>,event:any)=>unknown>(ref:NodeRef<K>,callback:SyncCallback<F>,options:FrameOptions={}):void {useInput(ref,callback,{...options,inputPhase:'unhandled'});}
export function useNativeReady<K extends string>(ref:NodeRef<K>,callback:(node:NodeReadHandle<K>)=>void|(()=>void)):void {
 const root=useRoot(),latest=React.useRef(callback),registration=React.useRef<{target:NodeReadHandle<K>|null;cleanup?:()=>void}>({target:null});
 const clear=()=>{const cleanup=registration.current.cleanup;registration.current.cleanup=undefined;registration.current.target=null;cleanup?.();};
 const refresh=()=>{const target=ref.current?.isValid()?ref.current:null;if(registration.current.target===target)return;clear();registration.current.target=target;if(target){const cleanup=latest.current(target);if(cleanup)registration.current.cleanup=cleanup;}};
 React.useLayoutEffect(()=>{latest.current=callback;refresh();});
 React.useLayoutEffect(()=>root.onReferencesPublished(refresh),[root,ref]);
 React.useLayoutEffect(()=>clear,[]);
}
export function asset<T extends string>(id:string,type:T,scope:'shared'|'instance'='shared'):AssetRef<T> {return Object.freeze({kind:'asset',id,type,scope});}
export function useAsset<T extends string>(descriptor:AssetRef<T>):AssetRef<T> {
 const root=useRoot(),value=service(root);if(!value.requested.has(descriptor.id)){value.requested.add(descriptor.id);root.enqueueNativeCallback(()=>{try{resolveAsset(root,descriptor);}catch(error){root.recordError(error);}});}return descriptor;
}
