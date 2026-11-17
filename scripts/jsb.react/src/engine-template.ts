/** Expanded templates for the direct renderer. Native allocations and local
 * scene duplication happen only through the renderer's commit integrations. */
import * as React from 'react';
import type {EngineRoot} from './engine';
import {nativeCall,nativeIdentity,writeNativeProperty} from './engine-native';
import {createEngineNodeIntegration} from './engine-node-integration';
import {createEngineHostElement,resolveEngineAsset,engineComponentServices,type NodeReadHandle} from './engine-component-runtime';
import {validateTemplatePlan,type TemplatePlanV1,type TemplateResourceV1,type AssetRef} from './contracts';

declare const require:(name:string)=>any;
interface ResourceScopes {
 readonly abi:1;
 open(root:object):unknown;
 remap(scope:unknown,resource:unknown):unknown;
 finish(scope:unknown):boolean;
 close(scope:unknown):boolean;
}
interface TemplateInstance {
 owner?:EngineRoot;
 nativeRoot?:any;
 rootIdentity?:string;
 nodes:Map<string,any>;
 resources:Map<string,unknown>;
 resourceRefs:Map<string,AssetRef>;
 scope?:unknown;
 api?:ResourceScopes;
 finished:boolean;
 closed:boolean;
}
const failure=(code:string,message:string)=>Error(code+': '+message);
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function resourceApi():ResourceScopes {
 const api=require('godot-jsb').internal.resource_scopes;
 if(api?.abi!==1||['open','remap','finish','close'].some(name=>typeof api[name]!=='function'))throw failure('E_LOCAL_RESOURCE_ABI','This template requires the matching native resource scope implementation');
 return api;
}
function close(instance:TemplateInstance):void {
 if(instance.closed)return;instance.closed=true;
 try{if(instance.scope!==undefined)instance.api!.close(instance.scope);}finally{instance.scope=undefined;instance.nodes.clear();instance.resources.clear();instance.resourceRefs.clear();instance.nativeRoot=undefined;}
}
function resolve(instance:TemplateInstance,plan:ReadonlyMap<string,TemplateResourceV1>,owner:EngineRoot,descriptor:AssetRef):unknown {
 if(instance.closed||instance.owner!==owner)throw failure('E_TEMPLATE_SCOPE','Template instance is closed or belongs to another root');
 const definition=plan.get(descriptor.id);
 if(!definition)return resolveEngineAsset(owner,descriptor);
 if(descriptor.type!==definition.type)throw failure('E_TEMPLATE_RESOURCE','Resource type differs from the template descriptor');
 let source=instance.resources.get(definition.resourceId);
 if(!source){
  const registered=engineComponentServices(owner).options.assets?.[definition.resourceId];
  if(registered){
   if(registered.type!==definition.type||(registered.uri??registered.path??definition.resourceId)!==definition.uri)throw failure('E_TEMPLATE_RESOURCE','Template resource differs from the registered manifest');
   source=resolveEngineAsset(owner,{kind:'asset',id:definition.resourceId,type:definition.type,scope:'shared'});
  }else {const loader=owner.godot[owner.typeName('ResourceLoader')];source=nativeCall(loader,'load',definition.uri);}
  if(!source||!nativeCall(source,'is_class',definition.type))throw failure('E_TEMPLATE_RESOURCE','Missing or incompatible resource '+definition.uri);
  instance.resources.set(definition.resourceId,source);
 }
 if(descriptor.scope==='instance'){
  if(definition.sharingPolicy!=='instance'||instance.scope===undefined)throw failure('E_LOCAL_RESOURCE_SCOPE','Instance resources require a declared native template scope');
  const local=instance.api!.remap(instance.scope,source);
  instance.resourceRefs.set(nativeIdentity(local),Object.freeze({...descriptor,scope:'instance'}));
  return local;
 }
 instance.resourceRefs.set(nativeIdentity(source),Object.freeze({...descriptor,scope:'shared'}));
 return source;
}
function localInitial(input:Readonly<Record<string,unknown>>,resources:ReadonlyMap<string,TemplateResourceV1>):Readonly<Record<string,unknown>> {
 return Object.fromEntries(Object.entries(input).map(([name,value])=>{
  const asset=value as Partial<AssetRef>|null;
  return [name,asset?.kind==='asset'&&asset.id&&resources.get(asset.id)?.sharingPolicy==='instance'?Object.freeze({...asset,scope:'instance'}):value];
 }));
}

export function createTemplateComponent<P extends {name?:string;initial?:Readonly<Record<string,unknown>>}={name?:string;initial?:Readonly<Record<string,unknown>>}>(input:TemplatePlanV1):React.ForwardRefExoticComponent<React.PropsWithoutRef<P>&React.RefAttributes<NodeReadHandle>> {
 const plan=freeze(JSON.parse(JSON.stringify(validateTemplatePlan(input)))) as TemplatePlanV1;
 const nodes=new Map(plan.nodes.map(node=>[node.nodeId,node])),resources=new Map(plan.resources.map(resource=>[resource.resourceId,resource]));
 const children=new Map<string,typeof plan.nodes>();
 for(const node of plan.nodes)if(node.parentId)children.set(node.parentId,[...(children.get(node.parentId)??[]),node].sort((a,b)=>a.siblingOrder-b.siblingOrder));
 const Component=React.forwardRef<NodeReadHandle,P>((props,ref)=>{
  const serial=React.useId(),instance=React.useRef<TemplateInstance|undefined>(undefined);
  if(!instance.current)instance.current={nodes:new Map(),resources:new Map(),resourceRefs:new Map(),finished:false,closed:false};
  const state=instance.current;
  if((props as Record<string,unknown>).children!==undefined)throw failure('E_TEMPLATE_CHILDREN','Template children require a declared slot profile');
  const emit=(id:string):React.ReactElement=>{
   const definition=nodes.get(id)!,isRoot=id===plan.rootId,parent=definition.parentId?nodes.get(definition.parentId):undefined;
   const integration=createEngineNodeIntegration({
    afterCreate(owner,node){
     if(state.closed||state.owner&&state.owner!==owner||state.nodes.has(id))throw failure('E_TEMPLATE_SCOPE','Template node belongs to another committed instance');
     state.owner=owner;state.nodes.set(id,node);
     if(isRoot){state.nativeRoot=node;state.rootIdentity=nativeIdentity(node);if(plan.profile==='template-local-v1'){state.api=resourceApi();state.scope=state.api.open(node);}}
     return()=>{if(isRoot)close(state);else if(state.nodes.get(id)===node)state.nodes.delete(id);};
    },
    afterSubtree(owner,node){
     if(!isRoot||state.finished)return;
     if(state.owner!==owner||state.nativeRoot!==node||nativeIdentity(node)!==state.rootIdentity||state.nodes.size!==plan.nodes.length)throw failure('E_TEMPLATE_TOPOLOGY','Template materialization is incomplete');
     for(const item of plan.nodes)if(item.ownerId){const child=state.nodes.get(item.nodeId),nativeOwner=state.nodes.get(item.ownerId);if(!child||!nativeOwner)throw failure('E_TEMPLATE_OWNER','Template owner is not materialized');writeNativeProperty(owner.godot,child,'owner',nativeOwner);}
     if(state.scope!==undefined&&state.api!.finish(state.scope)!==true)throw failure('E_LOCAL_RESOURCE_SETUP','Native local-scene setup was cancelled');
     state.finished=true;
    },
   });
   const values:Record<string,any>={name:isRoot?(props.name??definition.name+'_'+serial.replace(/[^A-Za-z0-9_]/g,'_')):definition.name};
   if(isRoot){for(const [name,value]of Object.entries(props))if(!['initial','name','children'].includes(name))values[name]=value;if(props.initial)values.initial=localInitial(props.initial,resources);}
   values.children=(children.get(id)??[]).map(child=>emit(child.nodeId));
   const element=createEngineHostElement(definition.nativeType,values,isRoot?ref:undefined,integration,{
    templateInitial:localInitial(definition.initial,resources),allowInstanceResources:plan.profile==='template-local-v1',parentType:parent?.nativeType,
    resolveAsset:(owner,descriptor)=>resolve(state,resources,owner,descriptor),
    readAsset:(owner,resource)=>{if(state.owner!==owner||state.closed)throw failure('E_TEMPLATE_SCOPE','Template instance is closed or belongs to another root');return resource?state.resourceRefs.get(nativeIdentity(resource)):undefined;},
   });
   return React.cloneElement(element,{key:id});
  };
  return emit(plan.rootId);
 });
 Component.displayName='Template('+plan.assetId+')';return Component;
}
