// P0 only: directly binds React to GodotJS. No legacy NativePort or internal.react.
import * as React from 'react';
import ReconcilerModule from '../../../../scripts/jsb.react/dist/reconciler.development.js';
import {drainScheduler,configureScheduler,scheduleHostTimeout,cancelHostTimeout} from '../../../../scripts/jsb.react/dist/scheduler.js';

type Props={ctor:new()=>any;native?:Record<string,any>;on?:Record<string,(...args:any[])=>void>;children?:React.ReactNode};
type Instance={kind:'instance';root:DirectRoot;props:Props;native?:any;children:Instance[];defaults:Map<string,any>;events:Map<string,{callable:any;callback:Function}>;parent?:Instance|Container;disposed:boolean;invalidated?:boolean};
type Container={kind:'container';root:DirectRoot;native:any;children:Instance[]};
const context=React.createContext<DirectRoot|null>(null),noop=()=>{};
const hostContext={};
const call=(o:any,n:string,...args:any[])=>{const fn=o[n]??o[n.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())];return fn.apply(o,args);};
const factory=(ReconcilerModule as any).default??ReconcilerModule;
let priority=0;
const microtasks:Array<()=>void>=[];
const reconciler=factory({
 rendererVersion:'0.0.0-p0',rendererPackageName:'@godot-js/p0-direct',supportsMutation:true,supportsPersistence:false,supportsHydration:false,isPrimaryRenderer:true,
 getRootHostContext:()=>hostContext,getChildHostContext:()=>hostContext,getPublicInstance:(v:Instance)=>{if(!v.native)throw Error('Ref before native commit');return v.native;},
 prepareForCommit:(c:Container)=>{c.root.committing=true;return null;},resetAfterCommit:(c:Container)=>{c.root.committing=false;c.root.stats.commits++;},preparePortalMount:noop,
 createInstance:(_type:string,props:Props,c:Container)=>{c.root.stats.prepared++;return {kind:'instance',root:c.root,props,children:[],defaults:new Map(),events:new Map(),disposed:false};},
 appendInitialChild:(p:Instance,c:Instance)=>{p.children.push(c);c.parent=p;},finalizeInitialChildren:()=>false,
 shouldSetTextContent:()=>false,createTextInstance:()=>{throw Error('P0 use native Label.text');},
 appendChild:(p:Instance,c:Instance)=>p.root.append(p,c),appendChildToContainer:(p:Container,c:Instance)=>p.root.append(p,c),
 insertBefore:(p:Instance,c:Instance,b:Instance)=>p.root.append(p,c,b),insertInContainerBefore:(p:Container,c:Instance,b:Instance)=>p.root.append(p,c,b),
 removeChild:(p:Instance,c:Instance)=>p.root.remove(p,c),removeChildFromContainer:(p:Container,c:Instance)=>p.root.remove(p,c),
 commitUpdate:(v:Instance,_type:string,_old:Props,next:Props)=>v.root.update(v,next),commitTextUpdate:noop,commitMount:noop,resetTextContent:noop,
 clearContainer:(c:Container)=>{for(const v of [...c.children])c.root.remove(c,v);return false;},detachDeletedInstance:noop,
 hideInstance:(v:Instance)=>{if(v.native&&v.root.alive(v.native)&&'visible'in v.native)v.native.visible=false;},
 unhideInstance:(v:Instance)=>{if(v.native&&v.root.alive(v.native)&&'visible'in v.native)v.native.visible=v.props.native?.visible??true;},hideTextInstance:noop,unhideTextInstance:noop,
 scheduleTimeout:scheduleHostTimeout,cancelTimeout:cancelHostTimeout,noTimeout:-1,supportsMicrotasks:true,scheduleMicrotask:(fn:()=>void)=>microtasks.push(fn),
 setCurrentUpdatePriority:(v:number)=>priority=v,getCurrentUpdatePriority:()=>priority,resolveUpdatePriority:()=>priority||32,
 resolveEventType:()=>null,resolveEventTimeStamp:()=>-1.1,trackSchedulerEvent:noop,requestPostPaintCallback:noop,shouldAttemptEagerTransition:()=>false,
 maySuspendCommit:()=>false,maySuspendCommitOnUpdate:()=>false,maySuspendCommitInSyncRender:()=>false,preloadInstance:()=>true,startSuspendingCommit:noop,suspendInstance:noop,suspendOnActiveViewTransition:noop,waitForCommitToBeReady:()=>null,
 NotPendingTransition:null,HostTransitionContext:React.createContext(null),resetFormInstance:noop,supportsTestSelectors:false,supportsResources:false,supportsSingletons:false,
});

export function EngineNode(props:Props&{ref?:React.Ref<any>}){return React.createElement('native',props);}
export function useFrame(phase:'process'|'physics',callback:(delta:number)=>void){const root=React.useContext(context);if(!root)throw Error('Missing direct root');const latest=React.useRef(callback);latest.current=callback;React.useLayoutEffect(()=>{const fn=(dt:number)=>latest.current(dt);root.frames[phase].add(fn);return()=>{root.frames[phase].delete(fn);};},[root,phase]);}

export class DirectRoot {
 readonly stats={prepared:0,created:0,freed:0,invalidations:0,commits:0,connections:0,disconnects:0};
 readonly errors:any[]=[];readonly frames={process:new Set<(dt:number)=>void>(),physics:new Set<(dt:number)=>void>()};
 readonly container:Container;readonly portals:Container[]=[];committing=false;private fiber:any;
 constructor(readonly G:any,native:any){this.container={kind:'container',root:this,native,children:[]};const err=(e:any)=>this.errors.push(String(e));this.fiber=reconciler.createContainer(this.container,1,null,true,null,'p0-',err,err,err,null);configureScheduler({requestPump:noop});}
 alive(o:any){try{return !!this.G.is_instance_valid(o);}catch{return false;}}
 private make(v:Instance):any {
  if(v.disposed)throw Error('Reused disposed record');if(v.native)return v.native;if(!this.committing)throw Error('Native allocation outside commit');
  const node=new v.props.ctor();v.native=node;this.stats.created++;this.apply(v,{},v.props);
  for(const child of v.children)call(node,'add_child',this.make(child));return node;
 }
 private apply(v:Instance,previous:Partial<Props>,next:Props){
  if(!this.alive(v.native)){if(!v.invalidated)this.stats.invalidations++;v.invalidated=true;return;}
  // Use native property access. Some valid properties (Node.name has USAGE_NONE)
  // are intentionally absent from JS prototypes; assignment would silently add an expando.
  for(const name of Object.keys(previous.native??{}))if(!Object.hasOwn(next.native??{},name)){call(v.native,'set',name,v.defaults.get(name));v.defaults.delete(name);}
  for(const [name,value]of Object.entries(next.native??{}))if(!Object.is(previous.native?.[name],value)){if(!v.defaults.has(name))v.defaults.set(name,call(v.native,'get',name));call(v.native,'set',name,value);}
  for(const [name,slot]of [...v.events])if(!Object.hasOwn(next.on??{},name)){if(call(v.native,'is_connected',name,slot.callable))call(v.native,'disconnect',name,slot.callable);v.events.delete(name);this.stats.disconnects++;}
  for(const [name,callback]of Object.entries(next.on??{})){const current=v.events.get(name);if(current){current.callback=callback;continue;}const slot={callback,callable:undefined as any};slot.callable=this.G.Callable.create((...args:any[])=>slot.callback(...args));const result=call(v.native,'connect',name,slot.callable);if(result!==0)throw Error('Signal connection rejected: '+name);v.events.set(name,slot);this.stats.connections++;}
 }
 update(v:Instance,next:Props){this.apply(v,v.props,next);v.props=next;}
 append(parent:Instance|Container,child:Instance,before?:Instance){
  const target=parent.kind==='container'?parent.native:this.make(parent),node=this.make(child);
  if(child.parent&&child.parent!==parent)child.parent.children=child.parent.children.filter(v=>v!==child);
  parent.children=parent.children.filter(v=>v!==child);const at=before?parent.children.indexOf(before):-1;parent.children.splice(at<0?parent.children.length:at,0,child);child.parent=parent;
  const old=call(node,'get_parent');if(old&&old!==target)call(old,'remove_child',node);if(old!==target)call(target,'add_child',node);
  if(before?.native)call(target,'move_child',node,call(before.native,'get_index'));
 }
 private disconnectTree(v:Instance){if(v.disposed)return;v.disposed=true;for(const child of v.children)this.disconnectTree(child);if(v.native&&this.alive(v.native))for(const [name,slot]of v.events){if(call(v.native,'is_connected',name,slot.callable))call(v.native,'disconnect',name,slot.callable);this.stats.disconnects++;}v.events.clear();}
 remove(parent:Instance|Container,v:Instance){if(v.disposed)return;parent.children=parent.children.filter(c=>c!==v);this.disconnectTree(v);if(!v.native||!this.alive(v.native))return;const inside=call(v.native,'is_inside_tree'),actual=call(v.native,'get_parent');if(actual)call(actual,'remove_child',v.native);const count=(r:Instance):number=>(r.native&&this.alive(r.native)?1:0)+r.children.reduce((n,c)=>n+count(c),0);this.stats.freed+=count(v);call(v.native,inside?'queue_free':'free');}
 render(element:React.ReactNode){reconciler.flushSyncFromReconciler(()=>reconciler.updateContainerSync(React.createElement(context.Provider,{value:this},element),this.fiber,null,null));this.pump();}
 pump(){for(let i=0;i<10;i++){while(microtasks.length)microtasks.shift()!();drainScheduler(10,100);reconciler.flushPassiveEffects();}}
 process(dt:number){this.pump();for(const fn of [...this.frames.process])fn(dt);}
 physics(dt:number){for(const fn of [...this.frames.physics])fn(dt);}
 portal(element:React.ReactNode,target:any,key='portal'){let c=this.portals.find(c=>c.native===target);if(!c){c={kind:'container',root:this,native:target,children:[]};this.portals.push(c);}return reconciler.createPortal(element,c,null,key);}
}
