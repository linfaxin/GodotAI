import * as React from 'react';
import ReconcilerFactory from './reconciler';
import {drainScheduler} from './scheduler';
import {mapEngineStack} from './engine-source-map';
import {captureValue, nativeAlive, nativeCall, nativeIdentity, propertyDescriptions, signalDescriptions, sameValue, sequence, writeNativeProperty, type NativePropertyWriter, type CapturedValue, type PropertyDescription} from './engine-native';

declare const require: (name: string) => any;
export type NativeConstructor<T extends object = any> = new (...args: any[]) => T;
type Equal<X,Y,A,B> = (<T>()=>T extends X?1:2) extends (<T>()=>T extends Y?1:2) ? A : B;
type WritableKeys<T> = {[K in keyof T]-?: Equal<{[P in K]:T[P]}, {-readonly[P in K]:T[P]}, K, never>}[keyof T];
type PropertyKeys<T> = {[K in WritableKeys<T>]-?: T[K] extends (...args: any[])=>any ? never : K}[WritableKeys<T>];
export type NativeProperties<T> = Partial<Pick<T, PropertyKeys<T>>> & {name?: string};
type SignalCallback<T> = T extends {emit: (...args: infer A)=>any} ? (...args: A)=>void : never;
export type NativeEvents<T> = {[K in keyof T as SignalCallback<T[K]> extends never ? never : K]?: SignalCallback<T[K]>};
export type ChildScope = 'react-managed'|'native-owned-opaque';
interface CommonNodeProps<T> {
  /** Public children are either reconciled by React or entirely native owned. */
  childScope?: ChildScope;
  native?: NativeProperties<T>;
  on?: NativeEvents<T>;
  children?: React.ReactNode;
  ref?: React.Ref<T>;
}
export interface EngineNodeProps<C extends NativeConstructor = NativeConstructor> extends CommonNodeProps<NoInfer<InstanceType<C>>> {
  ctor: C;
  args?: ConstructorParameters<C>;
  object?: never;
  ownership?: never;
}
export interface AdoptedNodeProps<N extends object = any> extends CommonNodeProps<NoInfer<N>> {
  object: N;
  ownership: 'adopt';
  ctor?: never;
  args?: never;
}
export interface EngineErrorInfo { kind:'uncaught'|'caught'|'recoverable'|'runtime'; componentStack?:string; stack?:string }
/** Structural project services injected by the bootstrap. The renderer does not
 * load the browser SDK or infer an entry from a process-wide global. */
export interface EngineRuntimeHost {
  readonly apiVersion: 1;
  readonly sessionId: string;
  readonly role: 'host'|'engine'|'script-worker';
  reportDiagnostic(value:{kind:'caught'|'recoverable'|'uncaught'|'runtime';message:string;stack?:string;componentStack?:string}):boolean;
  emitProjectEvent(value:Readonly<Record<string,unknown>>):boolean;
  bindProjectCommand(handler:(data:Record<string,unknown>)=>void|Promise<void>):()=>void;
}
export interface EngineSessionOptions {
  /** Additional engine-owned stage check. A true result never overrides physics. */
  canCommit?: ()=>boolean;
  /** Optional wakeup notification. Native release always uses the internal checkpoint. */
  requestPump?: ()=>void;
  /** Native host override; the engine bridge try_set_property is used by default. */
  writeProperty?: NativePropertyWriter;
}
export interface EngineRootOptions {
  godot?: any;
  session?: EngineSession;
  strictMode?: boolean;
  autoProcess?: boolean;
  budgetMs?: number;
  maxWork?: number;
  onError?: (error: unknown, info:EngineErrorInfo)=>void;
  publicName?: (nativeName: string)=>string;
  className?: (nativeName: string)=>string;
  runtimeHost?: EngineRuntimeHost;
}
export interface EngineStats {
  state: 'running'|'faulted'|'disposing'|'disposed';
  prepared: number; created: number; adopted: number; freed: number; invalidations: number;
  releaseRequested: number; pendingReleases: number; orphaned: number;
  commits: number; connections: number; disconnects: number; liveRecords: number;
  processHooks: number; physicsHooks: number; portals: number;
  cleanExit: boolean;
}
type NodeProps = EngineNodeProps | AdoptedNodeProps;
type Status = 'materialized'|'published'|'retiring'|'release-requested'|'freed';
interface EventSlot { callback: (...args:any[])=>void; callable: any; active: boolean }
interface Instance {
  kind: 'instance'; root: EngineRoot; props: NodeProps; native?: any; identity?: string;
  children: Instance[]; parent?: Parent; status?: Status; invalidated: boolean; attached: boolean;
  scope: ChildScope; hidden: boolean; published: boolean; deletionReceipt: boolean; orphaned: boolean;
  wasInsideTree: boolean; args: CapturedValue[];
  defaults: Map<string, CapturedValue>; values: Map<string, CapturedValue>; applied: Map<string, CapturedValue>; properties?: Map<string, PropertyDescription>;
  events: Map<string, EventSlot>; dependents: Set<Container>;
}
interface Container {kind:'container';root:EngineRoot;native:any;identity:string;children:Instance[];owner?:Instance}
type Parent = Instance|Container;
interface HiddenValue { identity:string; value:CapturedValue; root:EngineRoot; owner?:Instance }
const Context = React.createContext<EngineRoot|null>(null);
const owners = new WeakMap<object, Instance>();
const mounts = new WeakMap<object, Container>();
const sessions = new WeakMap<object, EngineSession>();
const noop = ()=>{};
const emptyContext = {};
const error = (code:string,text:string)=>new Error(`${code}: ${text}`);
// The pinned reconciler and scheduler are singletons in this JavaScript realm.
const rendererMicrotasks:Array<()=>void> = [];
const rendererTimers = new Map<number,{at:number;callback:()=>void}>();
let rendererTimerSerial=0, rendererDepth=0, realmPhysicsDepth=0;
function rendererCall<T>(callback:()=>T):T { rendererDepth++;try{return callback();}finally{rendererDepth--;} }
function nativeChildren(object:any):any[] { return sequence(nativeCall(object,'get_children')); }
function alive(godot:any,object:any,identity:string):boolean { try{return nativeAlive(godot,object)&&nativeIdentity(object)===identity;}catch{return false;} }

/** One session owns stage permission and scheduling for every root in its realm. */
export class EngineSession {
  readonly godot:any;
  readonly options:EngineSessionOptions;
  private readonly roots=new Set<EngineRoot>();
  private readonly hiddenValues=new Map<any,HiddenValue>();
  private permission=0;
  private pumping=false;
  private scheduled=false;
  private releaseCheckpoint=false;
  private nativeDepth=0;
  private callbackDepth=0;
  private validation=new Map<Instance,boolean>();
  private visibilityDirty=false;
  constructor(godot:any,options:EngineSessionOptions={}) { this.godot=godot;this.options=options; }
  static for(godot:any):EngineSession {
    let session=sessions.get(godot);
    if(!session){session=new EngineSession(godot);sessions.set(godot,session);}
    return session;
  }
  /** React phase permission never authorizes otherwise illegal raw Godot calls. */
  canCommit():boolean {
    if(realmPhysicsDepth)return false;
    const engine=this.godot.Engine??this.godot.engine;
    const check=engine?.is_in_physics_frame??engine?.isInPhysicsFrame;
    try {
      if(typeof check==='function'&&check.call(engine))return false;
      return this.options.canCommit?.()!==false;
    }catch{return false;}
  }
  hasPermission():boolean {return this.permission>0&&this.canCommit();}
  runSafe<T>(callback:()=>T):T|undefined {
    if(!this.canCommit())return undefined;
    this.permission++;
    try{return callback();}finally{this.permission--;}
  }
  /** Hosts may use this around engine physics callbacks, including other roots. */
  runPhysics<T>(callback:()=>T):T {realmPhysicsDepth++;try{return callback();}finally{realmPhysicsDepth--;}}
  /** Native callbacks can enqueue work, but releasing their native stack is deferred. */
  runNativeCallback<T>(callback:()=>T):T {
    this.nativeDepth++;
    try{return callback();}finally{this.nativeDepth--;this.requestPump();}
  }
  register(root:EngineRoot):void {
    // Multiple EngineSession objects for one native world would split permission.
    const established=sessions.get(this.godot);
    if(established&&established!==this&&established.roots.size)throw error('E_ENGINE_SESSION','A native world already has an active session');
    sessions.set(this.godot,this);this.roots.add(root);
  }
  requestPump():void {
    if(this.scheduled)return;
    this.scheduled=true;
    // Only this private browser microtask can authorize destruction. An explicit
    // pump(), including one in a raw Godot signal callback, cannot attest that
    // the enclosing JS/WASM/native stack has returned.
    void Promise.resolve().then(()=>{
      this.scheduled=false;
      if(!this.roots.size||!this.canCommit())return;
      this.releaseCheckpoint=true;
      try{this.pump();}catch(value){for(const root of this.roots)root.failSession(value);}
      finally{this.releaseCheckpoint=false;}
    });
    this.options.requestPump?.();
  }
  invalidateValidation():void {this.validation.clear();}
  validate(record:Instance):boolean {
    const cached=this.validation.get(record);if(cached!==undefined)return cached;
    let valid=!record.invalidated&&!record.orphaned&&record.status!=='freed'&&!!record.native&&!!record.identity&&alive(this.godot,record.native,record.identity);
    if(valid&&record.attached&&record.parent){
      const parent=record.parent;
      valid=parent.kind==='instance'?this.validate(parent):alive(this.godot,parent.native,parent.identity);
      if(valid)valid=nativeCall(record.native,'get_parent')===parent.native;
    }
    if(valid&&record.status==='retiring'&&!record.attached)valid=!nativeCall(record.native,'get_parent');
    this.validation.set(record,valid);
    return valid;
  }
  markVisibilityDirty():void {this.visibilityDirty=true;}
  refreshVisibility():void {
    if(!this.visibilityDirty)return;
    this.visibilityDirty=false;
    const wanted=new Set<any>(),visited=new Set<any>();
    const visit=(object:any,hidden:boolean,root:EngineRoot)=>{
      if(visited.has(object)||!nativeAlive(this.godot,object))return;
      visited.add(object);
      const record=owners.get(object);
      if(record?.orphaned)return;
      hidden=hidden||!!record?.hidden;
      if(hidden){
        const properties=record?.properties??propertyDescriptions(object,root.memberName);
        if(properties.has('visible')){
          wanted.add(object);
          const previous=this.hiddenValues.get(object);
          if(!previous)this.hiddenValues.set(object,{identity:nativeIdentity(object),value:captureValue(this.godot,nativeCall(object,'get','visible'),root.typeName),root,owner:record??this.owningAncestor(object)});
          root.writeProperty(object,'visible',false);
        }
      }
      for(const child of nativeChildren(object))visit(child,hidden,root);
    };
    const entries:Array<{object:any;root:EngineRoot}>=[];
    for(const root of this.roots){
      entries.push({object:root.container.native,root});
      for(const container of root.portalContainers())entries.push({object:container.native,root});
    }
    // Native ancestors first; overlapping portal mounts are visited just once.
    const depth=(object:any)=>{if(!nativeAlive(this.godot,object))return 0;let n=0;const seen=new Set<any>();for(let parent=nativeCall(object,'get_parent');parent;parent=nativeCall(parent,'get_parent')){if(seen.has(parent))break;seen.add(parent);n++;}return n;};
    entries.sort((a,b)=>depth(a.object)-depth(b.object));
    for(const entry of entries)visit(entry.object,false,entry.root);
    for(const [object,stored]of this.hiddenValues){
      if(wanted.has(object))continue;
      this.hiddenValues.delete(object);
      if(!alive(this.godot,object,stored.identity)||stored.owner?.orphaned||owners.get(object)?.orphaned)continue;
      const target=owners.get(object)?.values.get('visible')??stored.value;
      stored.root.writeProperty(object,'visible',target.value);
    }
  }
  hiddenBaseline(object:any):CapturedValue|undefined {return this.hiddenValues.get(object)?.value;}
  updateHiddenBaseline(object:any,value:CapturedValue):void {const stored=this.hiddenValues.get(object);if(stored)stored.value=value;}
  isHidden(object:any):boolean {return this.hiddenValues.has(object);}
  owningAncestor(object:any):Instance|undefined {
    const visited=new Set<any>();
    for(let parent=nativeCall(object,'get_parent');parent;parent=nativeCall(parent,'get_parent')){
      if(visited.has(parent))throw error('E_ENGINE_CYCLE','Cyclic native ancestry');
      visited.add(parent);const owner=owners.get(parent);if(owner)return owner;
    }
    return undefined;
  }
  registerPortalDependency(owner:Instance,container:Container):void {
    if(owner.root!==container.root){
      const pending=[container.root],visited=new Set<EngineRoot>();
      while(pending.length){
        const root=pending.pop()!;
        if(root===owner.root)throw error('E_ENGINE_PORTAL_CYCLE','Portal owner dependencies must be acyclic');
        if(visited.has(root))continue;visited.add(root);
        for(const next of root.dependencyRoots())pending.push(next);
      }
    }
    owner.dependents.add(container);
  }
  pump():void {
    if(this.pumping||rendererDepth||this.callbackDepth||!this.canCommit())return;
    this.runSafe(()=>{
      this.pumping=true;
      try{
        let remaining=Math.max(1,...[...this.roots].map(root=>root.options.maxWork??1000));
        for(let pass=0;pass<100;pass++){
          this.invalidateValidation();
          let work=false;
          for(const root of [...this.roots]){root.reapReleased();root.audit();work=root.performPending()||work;}
          for(const [id,timer]of rendererTimers)if(timer.at<=Date.now()){
            rendererTimers.delete(id);rendererCall(timer.callback);work=true;
            if(--remaining<0)throw error('E_ENGINE_BUDGET','Renderer timers did not settle');
          }
          while(rendererMicrotasks.length){
            if(--remaining<0)throw error('E_ENGINE_BUDGET','React microtasks did not settle');
            rendererCall(rendererMicrotasks.shift()!);work=true;
          }
          for(const root of [...this.roots])while(root.hasEvents()){
            if(--remaining<0)throw error('E_ENGINE_BUDGET','Signal callbacks did not settle');
            this.callbackDepth++;try{root.deliverEvent();}finally{this.callbackDepth--;}
            work=true;
          }
          const budget=Math.min(5,...[...this.roots].map(root=>root.options.budgetMs??5));
          this.invalidateValidation();
          const tasks=rendererCall(()=>drainScheduler(budget,Math.max(1,remaining)));
          remaining-=tasks;work=!!tasks||work;
          const passive=rendererCall(()=>EngineRoot.flushPassiveEffects());
          work=passive||work;
          this.refreshVisibility();
          this.invalidateValidation();
          for(const root of [...this.roots]){
            root.audit();root.closeDependentPortals();
            if(!this.nativeDepth)root.releaseRetired();
            root.finishShutdown();
            if(!this.releaseCheckpoint&&root.hasRetirements())this.requestPump();
          }
          if(!work&&!rendererMicrotasks.length&&![...this.roots].some(root=>root.hasPending()))break;
          if(remaining<0)throw error('E_ENGINE_BUDGET','React work did not settle');
        }
      }finally{this.pumping=false;}
    });
  }
  releaseAllowed():boolean {return this.releaseCheckpoint&&this.hasPermission()&&!rendererDepth&&!this.nativeDepth&&!this.callbackDepth;}
  forget(root:EngineRoot):void {this.roots.delete(root);this.invalidateValidation();}
}

export function EngineNode<C extends NativeConstructor>(props:EngineNodeProps<C>):React.ReactElement;
export function EngineNode<N extends object>(props:AdoptedNodeProps<N>):React.ReactElement;
// React.createElement erases an unspecialized generic component. Keep its
// constructor/adoption union available; JSX and explicit props instantiation
// retain the relationship between ctor/object and native/on/ref.
export function EngineNode<C extends NativeConstructor = NativeConstructor,N extends object = any>(props:EngineNodeProps<C>|AdoptedNodeProps<N>):React.ReactElement;
export function EngineNode(props:EngineNodeProps|AdoptedNodeProps):React.ReactElement {
  return React.createElement('godot-engine-node',props as any);
}
export function createNativeComponent<C extends NativeConstructor>(ctor:C):(props:Omit<EngineNodeProps<C>,'ctor'>)=>React.ReactElement {
  const component=(props:Omit<EngineNodeProps<C>,'ctor'>)=>React.createElement(EngineNode as any,{...props,ctor});
  Object.defineProperty(component,'displayName',{value:`Godot(${ctor.name||'Node'})`});return component;
}
export function useFrame(phase:'process'|'physics',callback:(delta:number)=>void):void {
  const root=React.useContext(Context);
  if(!root)throw error('E_ENGINE_CONTEXT','useFrame requires an engine root');
  const latest=React.useRef(callback);
  // A suspended/abandoned render must not replace the active native callback.
  React.useLayoutEffect(()=>{latest.current=callback;});
  React.useLayoutEffect(()=>root.subscribeFrame(phase,delta=>latest.current(delta)),[root,phase]);
}

/** Returns the services of this root's entry, including an absent native host. */
export function useRuntimeHost():EngineRuntimeHost|undefined {
  const root=React.useContext(Context);
  if(!root)throw error('E_ENGINE_CONTEXT','useRuntimeHost requires an engine root');
  return root.options.runtimeHost;
}

export class EngineRoot {
  private static sharedRenderer:any;
  readonly godot:any;
  readonly options:EngineRootOptions;
  readonly session:EngineSession;
  readonly container:Container;
  readonly memberName:(name:string)=>string;
  readonly typeName:(name:string)=>string;
  private state:EngineStats['state']='running';
  private committing=false;
  private pendingRender:{element:React.ReactNode}|undefined;
  private pendingShutdown=false;
  private shutdownStarted=false;
  private fiber:any;
  private renderer:any;
  private readonly errors:unknown[]=[];
  private readonly records=new Set<Instance>();
  private readonly portals=new Map<object,Container>();
  private readonly frames={process:new Set<(delta:number)=>void>(),physics:new Set<(delta:number)=>void>()};
  private readonly events:Array<()=>void>=[];
  private readonly automatic:Array<()=>void>=[];
  private readonly counters={prepared:0,created:0,adopted:0,freed:0,invalidations:0,releaseRequested:0,orphaned:0,commits:0,connections:0,disconnects:0};
  private cleanExit=true;
  constructor(containerNativeNode:object,options:EngineRootOptions={}) {
    this.options=options;this.godot=options.godot??options.session?.godot??require('godot');
    this.session=options.session??EngineSession.for(this.godot);
    if(this.session.godot!==this.godot)throw error('E_ENGINE_SESSION','Root and session must share one native world');
    if(!nativeAlive(this.godot,containerNativeNode)||!nativeCall(containerNativeNode,'is_class','Node'))throw error('E_ENGINE_CONTAINER','Expected a live native Node');
    if(mounts.has(containerNativeNode)||owners.has(containerNativeNode))throw error('E_ENGINE_OWNERSHIP','Node is already managed');
    if(this.session.owningAncestor(containerNativeNode))throw error('E_ENGINE_NESTED_ROOT','Use a registered portal beneath an owned native subtree');
    this.container={kind:'container',root:this,native:containerNativeNode,identity:nativeIdentity(containerNativeNode),children:[]};
    let names:any;try{names=require('godot-jsb').internal.names;}catch{}
    this.memberName=options.publicName??(names?(name:string)=>names.get_member(name):(name:string)=>name);
    this.typeName=options.className??(names?(name:string)=>names.get_class(name):(name:string)=>name);
    this.renderer=EngineRoot.sharedRenderer??=EngineRoot.createRenderer();
    const report=(kind:EngineErrorInfo['kind'])=>(value:unknown,info?:{componentStack?:string})=>this.recordError(value,{kind,componentStack:info?.componentStack});
    this.fiber=this.renderer.createContainer(this.container,1,null,!!options.strictMode,null,'godot-',report('uncaught'),report('caught'),report('recoverable'),null);
    this.session.register(this);mounts.set(containerNativeNode,this.container);
    if(options.autoProcess!==false)try{this.installAutomaticProcessing();}catch(value){this.shutdown();throw value;}
  }
  recordError(value:unknown,info:EngineErrorInfo={kind:'runtime'}):void {
    this.errors.push(value);
    try{
      const stack=(value as {stack?:unknown})?.stack;
      if(typeof stack==='string')info={...info,stack:mapEngineStack(stack,file=>{
        const access=this.godot[this.typeName('FileAccess')];
        return access&&nativeCall(access,'file_exists',file)?String(nativeCall(access,'get_file_as_string',file)):undefined;
      })};
    }catch{}
    try{if(this.options.onError)this.options.onError(value,info);else (info.kind==='caught'||info.kind==='recoverable'?console.warn:console.error)(value);}catch(callbackError){this.errors.push(callbackError);}
  }
  private fault(value:unknown):void {
    if(this.state==='disposed')return;
    if(!this.pendingShutdown)this.recordError(value);
    this.cleanExit=false;this.state=this.shutdownStarted?'disposing':'faulted';this.pendingShutdown=true;this.pendingRender=undefined;
    this.session.requestPump();
  }
  /** A session checkpoint failure cannot leave a running, clean root. */
  failSession(value:unknown):void {if(this.pendingShutdown)this.recordError(value);this.fault(value);}
  getErrors():readonly unknown[] {return [...this.errors];}
  getStats():EngineStats {
    this.reapReleased();
    return {...this.counters,state:this.state,pendingReleases:[...this.records].filter(r=>r.status==='release-requested').length,
      liveRecords:[...this.records].filter(r=>r.status!=='release-requested'&&r.status!=='freed'&&!r.orphaned).length,
      processHooks:this.frames.process.size,physicsHooks:this.frames.physics.size,portals:this.portals.size,cleanExit:this.cleanExit};
  }
  portalContainers():Iterable<Container> {return this.portals.values();}
  dependencyRoots():Iterable<EngineRoot> {return new Set([...this.records].flatMap(record=>[...record.dependents].map(container=>container.root)).filter(root=>root!==this));}
  writeProperty(object:any,name:string,value:unknown):unknown {
    return this.mutation(()=>{
      const owner=owners.get(object)??this.session.owningAncestor(object);
      if(owner&&!this.session.validate(owner)){
        owner.root.orphanIsland(owner,'Native ownership changed during a callback/setter');
        throw error('E_ENGINE_STRUCTURE','Cannot write a transferred ownership island');
      }
      return writeNativeProperty(this.godot,object,name,value,this.session.options.writeProperty).value;
    });
  }
  private requirePermission():void {if(!this.session.hasPermission())throw error('E_ENGINE_PHASE','React mutation requires a session safe point');}
  private mutation<T>(callback:()=>T):T {
    try{this.requirePermission();this.session.invalidateValidation();return callback();}catch(value){this.fault(value);throw value;}
  }
  private valid(record:Instance):boolean {return this.session.validate(record);}
  private static createRenderer():any {
    let priority=0;
    return ReconcilerFactory({
      rendererVersion:'0.3.0',rendererPackageName:'@godot-js/react/engine',supportsMutation:true,supportsPersistence:false,supportsHydration:false,isPrimaryRenderer:true,
      getRootHostContext:()=>emptyContext,getChildHostContext:()=>emptyContext,
      getPublicInstance:(record:Instance)=>{record.root.session.invalidateValidation();if(!record.root.valid(record))throw error('E_ENGINE_REF','Native instance is unavailable');record.published=true;if(record.status==='materialized')record.status='published';return record.native;},
      prepareForCommit:(container:Container)=>{container.root.requirePermission();container.root.committing=true;return null;},
      resetAfterCommit:(container:Container)=>{const root=container.root;root.committing=false;root.counters.commits++;for(const record of root.records)if(record.status==='materialized'){record.published=true;record.status='published';}root.session.markVisibilityDirty();root.session.refreshVisibility();},
      preparePortalMount:noop,
      createInstance:(_type:string,props:NodeProps,container:Container)=>{
        const root=container.root;root.counters.prepared++;
        const scope=props.childScope??'react-managed';
        if(scope!=='react-managed'&&scope!=='native-owned-opaque')throw error('E_ENGINE_SCOPE','Unknown child scope');
        return {kind:'instance',root,props,scope,children:[],invalidated:false,attached:false,hidden:false,published:false,deletionReceipt:false,orphaned:false,wasInsideTree:false,args:[],defaults:new Map(),values:new Map(),applied:new Map(),events:new Map(),dependents:new Set()};
      },
      appendInitialChild:(parent:Instance,child:Instance)=>{
        if(parent.scope==='native-owned-opaque')throw error('E_ENGINE_OPAQUE','Use a borrowed portal to insert React content into an opaque subtree');
        parent.children.push(child);child.parent=parent;
      },
      finalizeInitialChildren:()=>false,shouldSetTextContent:()=>false,
      createTextInstance:()=>{throw error('E_ENGINE_TEXT','Use a native text property');},
      appendChild:(parent:Instance,child:Instance)=>parent.root.mutation(()=>parent.root.append(parent,child)),
      appendChildToContainer:(parent:Container,child:Instance)=>parent.root.mutation(()=>parent.root.append(parent,child)),
      insertBefore:(parent:Instance,child:Instance,before:Instance)=>parent.root.mutation(()=>parent.root.append(parent,child,before)),
      insertInContainerBefore:(parent:Container,child:Instance,before:Instance)=>parent.root.mutation(()=>parent.root.append(parent,child,before)),
      removeChild:(parent:Instance,child:Instance)=>parent.root.mutation(()=>parent.root.remove(parent,child)),
      removeChildFromContainer:(parent:Container,child:Instance)=>parent.root.mutation(()=>parent.root.remove(parent,child)),
      commitUpdate:(record:Instance,_type:string,_old:NodeProps,next:NodeProps)=>record.root.mutation(()=>record.root.update(record,next)),
      commitTextUpdate:noop,commitMount:noop,resetTextContent:noop,
      clearContainer:(container:Container)=>{for(const child of [...container.children])container.root.mutation(()=>container.root.remove(container,child));return false;},
      // Pinned reconciler invokes this during passive deletion traversal. Never free here.
      detachDeletedInstance:(record:Instance)=>{record.deletionReceipt=true;record.root.session.requestPump();},
      hideInstance:(record:Instance)=>{record.hidden=true;record.root.session.markVisibilityDirty();},
      unhideInstance:(record:Instance)=>{record.hidden=false;record.root.session.markVisibilityDirty();},
      hideTextInstance:noop,unhideTextInstance:noop,
      scheduleTimeout:(callback:()=>void,delay:number)=>{const id=++rendererTimerSerial;rendererTimers.set(id,{at:Date.now()+Math.max(0,delay),callback});return id;},
      cancelTimeout:(id:number)=>rendererTimers.delete(id),noTimeout:-1,
      supportsMicrotasks:true,scheduleMicrotask:(callback:()=>void)=>rendererMicrotasks.push(callback),
      setCurrentUpdatePriority:(value:number)=>priority=value,getCurrentUpdatePriority:()=>priority,resolveUpdatePriority:()=>priority||32,
      resolveEventType:()=>null,resolveEventTimeStamp:()=>-1.1,trackSchedulerEvent:noop,requestPostPaintCallback:noop,shouldAttemptEagerTransition:()=>false,
      maySuspendCommit:()=>false,maySuspendCommitOnUpdate:()=>false,maySuspendCommitInSyncRender:()=>false,preloadInstance:()=>true,startSuspendingCommit:noop,suspendInstance:noop,suspendOnActiveViewTransition:noop,waitForCommitToBeReady:()=>null,
      NotPendingTransition:null,HostTransitionContext:React.createContext(null),resetFormInstance:noop,supportsTestSelectors:false,supportsResources:false,supportsSingletons:false,
    } as any);
  }
  static flushPassiveEffects():boolean {return !!EngineRoot.sharedRenderer?.flushPassiveEffects();}
  private make(record:Instance):any {
    if(record.status==='retiring'||record.status==='freed')throw error('E_ENGINE_DISPOSED','Cannot reuse a retired host');
    if(record.native)return record.native;
    if(!this.committing)throw error('E_ENGINE_COMMIT','Native allocation requires commit');
    const props=record.props;let object:any;
    if('object'in props){
      if(props.ownership!=='adopt')throw error('E_ENGINE_OWNERSHIP','Existing objects require adopt');
      object=props.object;
      if(nativeCall(object,'get_parent'))throw error('E_ENGINE_OWNERSHIP','Adopted nodes must be detached');
    }else{
      if(typeof props.ctor!=='function')throw error('E_ENGINE_CONSTRUCTOR','Expected a native constructor');
      record.args=(props.args??[]).map(value=>captureValue(this.godot,value,this.typeName));
      object=new props.ctor(...props.args??[]);
    }
    if(!nativeAlive(this.godot,object)||!nativeCall(object,'is_class','Node'))throw error('E_ENGINE_NODE','EngineNode requires a native Node');
    if(owners.has(object)||mounts.has(object))throw error('E_ENGINE_OWNERSHIP','Node already belongs to a root');
    record.native=object;record.identity=nativeIdentity(object);record.status='materialized';owners.set(object,record);this.records.add(record);
    if('object'in props)this.counters.adopted++;else this.counters.created++;
    try{
      record.properties=propertyDescriptions(object,this.memberName);this.apply(record,props);
      if(record.scope==='react-managed'&&nativeChildren(object).length)throw error('E_ENGINE_STRUCTURE','Composite native children require native-owned-opaque scope');
      for(const child of record.children){nativeCall(object,'add_child',this.make(child));child.attached=true;}
      return object;
    }catch(value){this.markRetiring(record);throw value;}
  }
  private property(record:Instance,key:string):PropertyDescription {
    let property=record.properties?.get(key);
    if(!property&&record.native){record.properties=propertyDescriptions(record.native,this.memberName);property=record.properties.get(key);}
    if(!property)throw error('E_ENGINE_PROPERTY',`Unknown native property ${key}`);
    if(property.usage&(1<<28))throw error('E_ENGINE_PROPERTY',`Read-only native property ${key}`);
    return property;
  }
  private apply(record:Instance,next:NodeProps):void {
    if(!record.native||record.orphaned)return;
    const wanted=new Map<string,unknown>();
    for(const [key,value]of Object.entries(next.native??{})){
      if(value===undefined)continue;
      const property=this.property(record,key);
      if(wanted.has(property.nativeName))throw error('E_ENGINE_PROPERTY',`Duplicate aliases for ${property.nativeName}`);
      wanted.set(property.nativeName,value);
    }
    for(const [name]of record.values)if(!wanted.has(name)){
      const baseline=record.defaults.get(name)!;
      this.writeProperty(record.native,name,baseline.value);
      if(name==='visible')this.session.updateHiddenBaseline(record.native,baseline);
      record.values.delete(name);record.applied.delete(name);record.defaults.delete(name);
    }
    for(const [name,value]of wanted){
      const captured=captureValue(this.godot,value,this.typeName);
      if(!record.defaults.has(name))record.defaults.set(name,name==='visible'?(this.session.hiddenBaseline(record.native)??captureValue(this.godot,nativeCall(record.native,'get',name),this.typeName)):captureValue(this.godot,nativeCall(record.native,'get',name),this.typeName));
      const actual=captureValue(this.godot,nativeCall(record.native,'get',name),this.typeName);
      // Declaration is reconciled at a host commit, never continuously each frame.
      const unchanged=sameValue(actual,captured)||(!!record.values.get(name)&&!!record.applied.get(name)&&sameValue(record.values.get(name)!,captured)&&sameValue(record.applied.get(name)!,actual));
      if(!(name==='visible'&&this.session.isHidden(record.native))&&!unchanged){
        const stored=this.writeProperty(record.native,name,value);
        record.applied.set(name,captureValue(this.godot,stored,this.typeName));
      }else record.applied.set(name,actual);
      record.values.set(name,captured);
    }
    const signals=signalDescriptions(record.native,this.memberName),events=new Map<string,unknown>();
    for(const [key,callback]of Object.entries(next.on??{})){
      if(callback===undefined)continue;
      const name=signals.get(key);if(!name)throw error('E_ENGINE_SIGNAL',`Unknown signal ${key}`);
      if(events.has(name))throw error('E_ENGINE_SIGNAL',`Duplicate aliases for ${name}`);
      if(typeof callback!=='function')throw error('E_ENGINE_SIGNAL',`Signal ${name} requires a function`);
      events.set(name,callback);
    }
    for(const [name,slot]of [...record.events])if(!events.has(name)){this.disconnectSlot(record,name,slot);record.events.delete(name);}
    for(const [name,callback]of events){
      const current=record.events.get(name);if(current){current.callback=callback as (...args:any[])=>void;continue;}
      const slot:EventSlot={callback:callback as (...args:any[])=>void,callable:undefined,active:true};
      slot.callable=this.godot.Callable.create((...args:any[])=>this.session.runNativeCallback(()=>{
        if(!slot.active||this.state!=='running'||!this.valid(record))return;
        const values=args.map(value=>captureValue(this.godot,value,this.typeName).value);
        this.events.push(()=>{if(slot.active&&this.state==='running'&&this.valid(record))try{slot.callback(...values);}catch(value){this.recordError(value);}});
      }));
      if(nativeCall(record.native,'connect',name,slot.callable)!==0)throw error('E_ENGINE_SIGNAL',`Cannot connect ${name}`);
      record.events.set(name,slot);this.counters.connections++;
    }
    this.session.markVisibilityDirty();
  }
  private update(record:Instance,next:NodeProps):void {
    if(record.orphaned||record.status==='retiring')return;
    if(('ctor'in next)!==('ctor'in record.props)||('ctor'in next&&'ctor'in record.props&&next.ctor!==record.props.ctor)||('object'in next&&'object'in record.props&&next.object!==record.props.object))throw error('E_ENGINE_CONSTRUCTOR','Change key when changing the constructor/object');
    if((next.childScope??'react-managed')!==record.scope)throw error('E_ENGINE_SCOPE','Change key when changing child scope');
    const args='args'in next?next.args??[]:[];
    if(args.length!==record.args.length||args.some((value,index)=>!sameValue(record.args[index],captureValue(this.godot,value,this.typeName))))throw error('E_ENGINE_ARGUMENTS','Change key when changing constructor args');
    if(!this.valid(record)){this.orphanIsland(record,'Native identity or parent changed');return;}
    this.apply(record,next);record.props=next;
  }
  private append(parent:Parent,child:Instance,before?:Instance):void {
    if(parent.kind==='instance'&&parent.scope==='native-owned-opaque')throw error('E_ENGINE_OPAQUE','React children require a borrowed portal');
    if(parent.kind==='instance'&&parent.native&&!this.valid(parent)){this.orphanIsland(parent,'Native parent changed');return;}
    const target=parent.kind==='container'?parent.native:this.make(parent);
    if(parent.kind==='container'&&!alive(this.godot,target,parent.identity))throw error('E_ENGINE_CONTAINER','Native mount has been released');
    if(child.native&&!this.valid(child)){this.orphanIsland(child,'Native child changed');return;}
    const object=this.make(child);
    if(child.parent&&child.parent!==parent)child.parent.children=child.parent.children.filter(item=>item!==child);
    parent.children=parent.children.filter(item=>item!==child);
    const at=before?parent.children.indexOf(before):-1;
    parent.children.splice(at<0?parent.children.length:at,0,child);child.parent=parent;
    const previous=nativeCall(object,'get_parent');
    if(previous&&previous!==target)nativeCall(previous,'remove_child',object);
    if(previous!==target)nativeCall(target,'add_child',object);
    child.attached=true;child.wasInsideTree=!!nativeCall(object,'is_inside_tree');
    if(before?.native&&nativeAlive(this.godot,before.native)){
      const oldIndex=Number(nativeCall(object,'get_index')),nextIndex=Number(nativeCall(before.native,'get_index'));
      nativeCall(target,'move_child',object,nextIndex-(oldIndex<nextIndex?1:0));
    }else nativeCall(target,'move_child',object,-1);
    this.session.invalidateValidation();
  }
  private disconnectSlot(record:Instance,name:string,slot:EventSlot):void {
    slot.active=false;
    if(record.native&&record.identity&&alive(this.godot,record.native,record.identity)&&nativeCall(record.native,'is_connected',name,slot.callable))nativeCall(record.native,'disconnect',name,slot.callable);
    this.counters.disconnects++;
  }
  private disconnect(record:Instance):void {for(const [name,slot]of record.events)this.disconnectSlot(record,name,slot);record.events.clear();}
  private markRetiring(record:Instance):void {
    if(record.status==='freed'||record.status==='release-requested')return;
    if(record.status)record.status='retiring';
    if(record.native&&record.identity&&alive(this.godot,record.native,record.identity))record.wasInsideTree=record.wasInsideTree||!!nativeCall(record.native,'is_inside_tree');
    this.disconnect(record);
    for(const child of record.children)this.markRetiring(child);
  }
  private remove(parent:Parent,child:Instance):void {
    this.auditRecord(child);
    parent.children=parent.children.filter(item=>item!==child);
    this.markRetiring(child);
    if(child.native&&!child.orphaned&&child.identity&&alive(this.godot,child.native,child.identity)){
      child.wasInsideTree=child.wasInsideTree||!!nativeCall(child.native,'is_inside_tree');
      this.detachRetiring(child);
    }
    this.session.invalidateValidation();this.session.markVisibilityDirty();
  }
  private detachRetiring(record:Instance):void {
    this.session.invalidateValidation();this.auditRecord(record);
    if(record.orphaned)return;
    const parent=nativeCall(record.native,'get_parent');
    if(parent&&(!record.attached||parent!==record.parent?.native)){
      this.orphanIsland(record,'Retiring node acquired a foreign parent');return;
    }
    // remove_child emits native callbacks. A callback may transfer this node,
    // replace its identity or free it; inspect the returned state before any
    // later destruction instead of detaching it from a newly acquired owner.
    record.attached=false;
    if(parent)nativeCall(parent,'remove_child',record.native);
    this.session.invalidateValidation();this.auditRecord(record);
  }
  private auditRecord(record:Instance):void {
    if(!record.native||record.orphaned||record.status==='freed'||record.status==='release-requested')return;
    if(!this.valid(record)){this.orphanIsland(record,'Native identity or parent changed');return;}
    if(record.scope==='react-managed'){
      const expected=record.children.filter(child=>child.attached&&!child.orphaned&&child.native).map(child=>child.native);
      const actual=nativeChildren(record.native);
      if(actual.length!==expected.length||actual.some((object,index)=>object!==expected[index]))this.orphanIsland(record,'Unregistered public child or native order change');
    }
  }
  audit():void {
    if(this.state==='disposed')return;
    if(alive(this.godot,this.container.native,this.container.identity)){
      const enclosing=this.session.owningAncestor(this.container.native);
      if(enclosing&&enclosing.root!==this){
        enclosing.root.orphanIsland(enclosing,'An unregistered root mount entered this ownership island');
        for(const child of this.container.children)this.orphanIsland(child,'Borrowed root mount was moved beneath an owned subtree');
        this.fault(error('E_ENGINE_NESTED_ROOT','Borrowed root mount was moved without registration'));
      }
    }
    for(const container of this.portals.values())if(container.owner&&!container.owner.orphaned&&alive(this.godot,container.native,container.identity)){
      if(this.session.owningAncestor(container.native)!==container.owner){
        for(const child of container.children)this.orphanIsland(child,'Registered portal mount left its opaque owner');
        this.fault(error('E_ENGINE_PORTAL','Registered portal mount changed native ownership'));
      }
    }
    for(const record of this.records)this.auditRecord(record);
  }
  private orphanIsland(record:Instance,reason:string):void {
    if(record.orphaned)return;
    let island=record;
    while(island.parent?.kind==='instance')island=island.parent;
    // React removes retiring children from the live child list before native
    // release. They still belong to the same ownership island; omitting them
    // would retry a failed free and could starve the browser with microtasks.
    const retiredChildren=new Map<Instance,Instance[]>(),visited=new Set<Instance>();
    for(const item of this.records)if(item.parent?.kind==='instance'){
      const children=retiredChildren.get(item.parent)??[];children.push(item);retiredChildren.set(item.parent,children);
    }
    const mark=(item:Instance)=>{
      if(visited.has(item))return;visited.add(item);
      if(!item.orphaned){item.orphaned=true;item.invalidated=true;this.counters.invalidations++;this.counters.orphaned++;this.disconnect(item);}
      if(item.native&&owners.get(item.native)===item)owners.delete(item.native);
      for(const child of item.children)mark(child);
      for(const child of retiredChildren.get(item)??[])mark(child);
      for(const container of item.dependents)for(const child of container.children)container.root.orphanIsland(child,'Opaque owner was transferred externally');
    };
    mark(island);this.cleanExit=false;
    this.fault(error('E_ENGINE_STRUCTURE',`${reason}; retained ownership island ${island.identity??'unmaterialized'}`));
  }
  closeDependentPortals():void {
    for(const record of this.records)if(record.status==='retiring'||record.orphaned)for(const container of record.dependents){
      if(container.children.some(child=>child.status!=='retiring'&&child.status!=='release-requested'&&child.status!=='freed'))container.root.requestShutdown();
    }
  }
  private descendantsSettled(record:Instance):boolean {
    for(const child of record.children){
      if(child.status&&child.status!=='freed'&&child.status!=='release-requested'&&!child.orphaned)return false;
    }
    for(const container of record.dependents){
      if(container.children.some(child=>child.status!=='freed'&&child.status!=='release-requested'&&!child.orphaned))return false;
      // Native queued children must actually be gone before their owner cascades free.
      if(container.children.some(child=>child.native&&child.identity&&alive(this.godot,child.native,child.identity)))return false;
    }
    return true;
  }
  releaseRetired():void {
    if(!this.session.releaseAllowed())return;
    const list=[...this.records].reverse();
    for(const record of list){
      if(record.status!=='retiring')continue;
      if(record.published&&!record.deletionReceipt)continue;
      if(!this.descendantsSettled(record))continue;
      if(record.orphaned){this.forgetRecord(record,false);continue;}
      this.session.invalidateValidation();this.auditRecord(record);
      if(record.orphaned){this.forgetRecord(record,false);continue;}
      if(!record.native||!record.identity||!alive(this.godot,record.native,record.identity)){this.forgetRecord(record,false);continue;}
      try{
        this.detachRetiring(record);
        if(record.orphaned){this.forgetRecord(record,false);continue;}
        nativeCall(record.native,record.wasInsideTree?'queue_free':'free');
        if(!record.wasInsideTree&&alive(this.godot,record.native,record.identity))throw error('E_ENGINE_RELEASE','Native free returned without confirming destruction');
        this.counters.releaseRequested++;record.status='release-requested';
        record.defaults.clear();record.values.clear();record.applied.clear();
      }catch(value){
        this.recordError(value);
        // Native mutation is not transactional. Never retry an uncertain free
        // or release an ancestor that may still own a partially changed island.
        this.orphanIsland(record,'Native release failed; session teardown is required');
      }
    }
    this.reapReleased();
  }
  reapReleased():void {
    for(const record of [...this.records])if(record.status==='release-requested'&&record.native&&record.identity&&!alive(this.godot,record.native,record.identity))this.forgetRecord(record,true);
  }
  hasRetirements():boolean {return [...this.records].some(record=>record.status==='retiring');}
  private forgetRecord(record:Instance,freed:boolean):void {
    if(record.status==='freed')return;
    record.status='freed';if(freed)this.counters.freed++;
    if(record.native&&owners.get(record.native)===record)owners.delete(record.native);
    record.defaults.clear();record.values.clear();record.applied.clear();this.records.delete(record);
    for(const container of record.dependents){container.owner=undefined;}
    record.dependents.clear();
  }
  /** Enqueue a render. flush()/pump() or the engine's next safe point performs it. */
  render(element:React.ReactNode):void {
    if(this.state!=='running'||this.pendingShutdown)throw error('E_ENGINE_DISPOSED','Root is closed');
    this.pendingRender={element};this.session.requestPump();
  }
  flush():void {this.session.pump();}
  pump():void {this.session.pump();}
  hasPending():boolean {return !!this.pendingRender||(!this.shutdownStarted&&this.pendingShutdown);}
  hasEvents():boolean {return !!this.events.length;}
  deliverEvent():void {this.events.shift()?.();}
  performPending():boolean {
    if(this.state==='disposed')return false;
    if(this.pendingShutdown&&!this.shutdownStarted){
      this.shutdownStarted=true;this.state='disposing';this.pendingRender=undefined;
      try{rendererCall(()=>this.renderer.flushSyncFromReconciler(()=>this.renderer.updateContainerSync(null,this.fiber,null,null)));}
      catch(value){this.cleanExit=false;this.recordError(value);}
      return true;
    }
    if(!this.pendingRender||this.state!=='running')return false;
    const pending=this.pendingRender;this.pendingRender=undefined;
    try{rendererCall(()=>this.renderer.flushSyncFromReconciler(()=>this.renderer.updateContainerSync(React.createElement(Context.Provider,{value:this},pending.element),this.fiber,null,null)));}
    catch(value){this.fault(value);}
    return true;
  }
  subscribeFrame(phase:'process'|'physics',callback:(delta:number)=>void):()=>void {
    if(this.state!=='running')throw error('E_ENGINE_DISPOSED','Cannot subscribe to a closed root');
    this.frames[phase].add(callback);return()=>{this.frames[phase].delete(callback);};
  }
  private frame(phase:'process'|'physics',delta:number):void {
    if(this.state!=='running')return;
    if(phase==='process')this.session.pump();
    if(this.state!=='running')return;
    const run=()=>{for(const callback of [...this.frames[phase]])if(this.state==='running'&&!this.pendingShutdown&&this.frames[phase].has(callback))try{callback(delta);}catch(value){this.recordError(value);}};
    if(phase==='physics')this.session.runPhysics(run);else run();
  }
  process(delta:number):void {this.frame('process',delta);}
  physics(delta:number):void {this.frame('physics',delta);}
  portal(element:React.ReactNode,target:object,key:React.Key='portal'):React.ReactPortal {
    if(this.state!=='running'||!nativeAlive(this.godot,target)||!nativeCall(target,'is_class','Node'))throw error('E_ENGINE_PORTAL','Expected a live native mount');
    const reserved=mounts.get(target);if(reserved&&reserved.root!==this)throw error('E_ENGINE_OWNERSHIP','Portal mount belongs to another root');
    if(owners.has(target))throw error('E_ENGINE_OWNERSHIP','Use a borrowed child mount, not an owned node');
    let container=this.portals.get(target);
    if(!container){
      const owner=this.session.owningAncestor(target);
      if(owner&&owner.scope!=='native-owned-opaque')throw error('E_ENGINE_PORTAL','Borrowed mount beneath an owned node requires opaque child scope');
      if(owner&&owner.root.session!==this.session)throw error('E_ENGINE_SESSION','Portal and owner must share a session');
      container={kind:'container',root:this,native:target,identity:nativeIdentity(target),children:[],owner};
      // Native ancestry is acyclic; owned nodes cannot be reused as mounts/children.
      if(owner)this.session.registerPortalDependency(owner,container);
      this.portals.set(target,container);mounts.set(target,container);
    }
    return this.renderer.createPortal(element,container,null,key);
  }
  unmount():void {if(this.state==='running')this.render(null);}
  requestShutdown():void {if(this.state!=='disposed'){this.pendingShutdown=true;this.pendingRender=undefined;this.session.requestPump();}}
  shutdown():void {this.requestShutdown();this.session.pump();}
  finishShutdown():void {
    if(!this.shutdownStarted||this.state==='disposed')return;
    for(const record of this.records)if(record.status==='materialized'&&!record.published)this.markRetiring(record);
    if([...this.records].some(record=>record.status!=='release-requested'&&record.status!=='freed'))return;
    for(const unsubscribe of this.automatic.splice(0))try{unsubscribe();}catch(value){this.cleanExit=false;this.recordError(value);}
    this.frames.process.clear();this.frames.physics.clear();this.events.length=0;
    if(mounts.get(this.container.native)===this.container)mounts.delete(this.container.native);
    for(const [target,container]of this.portals){if(mounts.get(target)===container)mounts.delete(target);container.owner?.dependents.delete(container);}
    this.portals.clear();this.state='disposed';this.session.forget(this);
  }
  private installAutomaticProcessing():void {
    if(!nativeCall(this.container.native,'is_inside_tree'))throw error('E_ENGINE_AUTOPROCESS','Mount must be in SceneTree, or use autoProcess:false');
    const tree=nativeCall(this.container.native,'get_tree');
    for(const [signal,callback]of [['process_frame',()=>this.process(Number(nativeCall(this.container.native,'get_process_delta_time')))],['physics_frame',()=>this.physics(Number(nativeCall(this.container.native,'get_physics_process_delta_time')))]] as const){
      const callable=this.godot.Callable.create(()=>this.session.runNativeCallback(()=>{
        if(this.state!=='running')return;
        if(!alive(this.godot,this.container.native,this.container.identity)){this.requestShutdown();return;}
        callback();
      }));
      if(nativeCall(tree,'connect',signal,callable)!==0)throw error('E_ENGINE_AUTOPROCESS',`Cannot connect ${signal}`);
      this.automatic.push(()=>{if(nativeAlive(this.godot,tree)&&nativeCall(tree,'is_connected',signal,callable))nativeCall(tree,'disconnect',signal,callable);});
    }
  }
}
export function createRoot(containerNativeNode:object,options:EngineRootOptions={}):EngineRoot {return new EngineRoot(containerNativeNode,options);}
