import * as React from 'react';
import ReconcilerFactory from './reconciler';
import {drainScheduler} from './scheduler';
import {mapEngineStack} from './engine-source-map';
import {captureValue, nativeAlive, nativeCall, nativeIdentity, propertyDescriptions, signalDescriptions, sameValue, type CapturedValue, type PropertyDescription} from './engine-native';

declare const require: (name: string) => any;
export type NativeConstructor<T extends object = any> = new (...args: any[]) => T;
type Equal<X,Y,A,B> = (<T>()=>T extends X?1:2) extends (<T>()=>T extends Y?1:2) ? A : B;
type WritableKeys<T> = {[K in keyof T]-?: Equal<{[P in K]:T[P]}, {-readonly[P in K]:T[P]}, K, never>}[keyof T];
type PropertyKeys<T> = {[K in WritableKeys<T>]-?: T[K] extends (...args: any[])=>any ? never : K}[WritableKeys<T>];
/** Native property names. A method-only GodotJS field such as Node.name is valid here. */
export type NativeProperties<T> = Partial<Pick<T, PropertyKeys<T>>> & {name?: string};
type SignalCallback<T> = T extends {emit: (...args: infer A)=>any} ? (...args: A)=>void : never;
export type NativeEvents<T> = {[K in keyof T as SignalCallback<T[K]> extends never ? never : K]?: SignalCallback<T[K]>};
export interface EngineNodeProps<C extends NativeConstructor = NativeConstructor> {
  ctor: C;
  args?: ConstructorParameters<C>;
  native?: NativeProperties<NoInfer<InstanceType<C>>>;
  on?: NativeEvents<NoInfer<InstanceType<C>>>;
  children?: React.ReactNode;
  ref?: React.Ref<InstanceType<C>>;
}
export interface AdoptedNodeProps<N extends object = any> {
  object: N;
  ownership: 'adopt';
  native?: NativeProperties<N>;
  on?: NativeEvents<N>;
  children?: React.ReactNode;
  ref?: React.Ref<N>;
}
export interface EngineErrorInfo { kind:'uncaught'|'caught'|'recoverable'|'runtime'; componentStack?:string; stack?:string }
export interface EngineRootOptions {
  godot?: any;
  strictMode?: boolean;
  autoProcess?: boolean;
  budgetMs?: number;
  maxWork?: number;
  onError?: (error: unknown, info:EngineErrorInfo)=>void;
  /** Native name -> public GodotJS name, primarily for camel-case bindings. */
  publicName?: (nativeName: string)=>string;
  className?: (nativeName: string)=>string;
}
export interface EngineStats {
  state: 'running'|'disposing'|'disposed';
  prepared: number; created: number; adopted: number; freed: number; invalidations: number;
  commits: number; connections: number; disconnects: number; liveRecords: number;
  processHooks: number; physicsHooks: number; portals: number;
}
type NodeProps = EngineNodeProps | AdoptedNodeProps;
interface EventSlot { callback: (...args:any[])=>void; callable: any; active: boolean }
interface Instance {
  kind: 'instance'; root: EngineRoot; props: NodeProps; native?: any; identity?: string;
  children: Instance[]; parent?: Parent; disposed: boolean; invalidated: boolean; hidden: boolean; attached: boolean;
  defaults: Map<string, CapturedValue>; values: Map<string, CapturedValue>; properties?: Map<string, PropertyDescription>;
  signals?: Map<string,string>;
  events: Map<string, EventSlot>;
}
interface Container {kind:'container';root:EngineRoot;native:any;identity:string;children:Instance[]}
type Parent = Instance|Container;
const Context = React.createContext<EngineRoot|null>(null);
const owners = new WeakMap<object, Instance>();
const mounts = new WeakMap<object, EngineRoot>();
const noop = ()=>{};
const emptyContext = {};
const error = (code: string, text: string) => new Error(`${code}: ${text}`);
// One renderer owns the React scheduler ingress. Individual roots never replace
// scheduler configuration or discard another root's queued work.
const rendererMicrotasks: Array<()=>void> = [];
const rendererTimers = new Map<number,{at:number;callback:()=>void}>();
let rendererTimerSerial=0;
let rendererDepth=0;
let settlingDeferred=false;
const deferredRoots=new Set<EngineRoot>();
function rendererCall<T>(callback:()=>T):T {rendererDepth++;try{return callback();}finally{rendererDepth--;}}

/** Generic node sugar over the actual Godot constructor, not a host whitelist. */
export function EngineNode<C extends NativeConstructor = NativeConstructor>(props: EngineNodeProps<C>|AdoptedNodeProps<InstanceType<C>>): React.ReactElement { return React.createElement('godot-engine-node', props as any); }
export function createNativeComponent<C extends NativeConstructor>(ctor: C): (props: Omit<EngineNodeProps<C>, 'ctor'>)=>React.ReactElement {
  const component = (props: Omit<EngineNodeProps<C>,'ctor'>) => React.createElement(EngineNode as any, {...props, ctor});
  Object.defineProperty(component, 'displayName', {value: `Godot(${ctor.name || 'Node'})`});
  return component;
}
export function useFrame(phase: 'process'|'physics', callback: (delta:number)=>void): void {
  const root = React.useContext(Context);
  if (!root) throw error('E_ENGINE_CONTEXT','useFrame requires an engine root');
  const latest = React.useRef(callback); latest.current = callback;
  React.useLayoutEffect(()=>root.subscribeFrame(phase, delta=>latest.current(delta)),[root,phase]);
}

export class EngineRoot {
  private static sharedRenderer: any;
  readonly godot: any;
  readonly options: EngineRootOptions;
  readonly container: Container;
  private state: EngineStats['state'] = 'running';
  private committing = false;
  private pumping = false;
  private executing = false;
  private phase: 'process'|'physics'|undefined;
  private pendingRender: {element:React.ReactNode}|undefined;
  private signalDepth = 0;
  private nativeSignalDepth = 0;
  private pendingShutdown = false;
  private fiber: any;
  private renderer: any;
  private readonly errors: unknown[] = [];
  private readonly records = new Set<Instance>();
  private readonly portals = new Map<object, Container>();
  private readonly frames = {process: new Set<(delta:number)=>void>(), physics: new Set<(delta:number)=>void>()};
  private readonly microtasks: Array<()=>void> = [];
  private readonly automatic: Array<()=>void> = [];
  private readonly counters = {prepared:0,created:0,adopted:0,freed:0,invalidations:0,commits:0,connections:0,disconnects:0};
  private readonly publicName: (name:string)=>string;
  private readonly className: (name:string)=>string;
  constructor(containerNativeNode: object, options: EngineRootOptions = {}) {
    this.options = options; this.godot = options.godot ?? require('godot');
    if (!nativeAlive(this.godot,containerNativeNode) || !nativeCall(containerNativeNode,'is_class','Node')) throw error('E_ENGINE_CONTAINER','Expected a live native Node');
    if (mounts.has(containerNativeNode) || owners.has(containerNativeNode)) throw error('E_ENGINE_OWNERSHIP','Node is already managed by a root');
    mounts.set(containerNativeNode,this);
    this.container = {kind:'container',root:this,native:containerNativeNode,identity:nativeIdentity(containerNativeNode),children:[]};
    let names: any;
    try { names = require('godot-jsb').internal.names; } catch { /* Injected test engines use native naming. */ }
    this.publicName = options.publicName ?? (names ? (name:string)=>names.get_member(name) : (name:string)=>name);
    this.className = options.className ?? (names ? (name:string)=>names.get_class(name) : (name:string)=>name);
    this.renderer = EngineRoot.sharedRenderer ??= EngineRoot.createRenderer();
    const report = (kind:EngineErrorInfo['kind'])=>(value:unknown,info?:{componentStack?:string})=>this.report(value,{kind,componentStack:info?.componentStack});
    this.fiber = this.renderer.createContainer(this.container,1,null,!!options.strictMode,null,'godot-',report('uncaught'),report('caught'),report('recoverable'),null);
    if (options.autoProcess !== false) {
      try { this.installAutomaticProcessing(); } catch(value) { this.shutdown(); throw value; }
    }
  }
  private report(value: unknown, info:EngineErrorInfo={kind:'runtime'}): void {
    this.errors.push(value);
    try{
      const stack=(value as {stack?:unknown})?.stack;
      if(typeof stack==='string')info={...info,stack:mapEngineStack(stack,file=>{
        const access=this.godot[this.className('FileAccess')];
        return access&&nativeCall(access,'file_exists',file)?String(nativeCall(access,'get_file_as_string',file)):undefined;
      })};
    }catch{ /* A failed diagnostic lookup cannot replace the original failure. */ }
    try{if(this.options.onError)this.options.onError(value,info);else (info.kind==='caught'||info.kind==='recoverable'?console.warn:console.error)(value);}
    catch(callbackError){this.errors.push(callbackError);console.error(callbackError);}
  }
  getErrors(): readonly unknown[] {return [...this.errors];}
  getStats(): EngineStats {return {...this.counters,state:this.state,liveRecords:this.records.size,processHooks:this.frames.process.size,physicsHooks:this.frames.physics.size,portals:this.portals.size};}
  private identityAlive(object:any,identity:string): boolean {try{return nativeAlive(this.godot,object)&&nativeIdentity(object)===identity;}catch{return false;}}
  private valid(record: Instance): boolean {
    if (record.disposed || record.invalidated || !record.native || !record.identity) return false;
    let valid=this.identityAlive(record.native,record.identity);
    if (valid&&record.attached&&record.parent) {
      const parent=record.parent;
      const target=parent.native;
      if(parent.kind==='instance'&&!this.valid(parent))valid=false;
      else if(parent.kind==='container'&&!this.identityAlive(parent.native,parent.identity))valid=false;
      else if(target&&nativeCall(record.native,'get_parent')!==target)valid=false;
    }
    if(!valid){record.invalidated=true;this.counters.invalidations++;this.disconnect(record);if(owners.get(record.native)===record)owners.delete(record.native);}
    return valid;
  }
  private static createRenderer(): any {
    let priority=0;
    return ReconcilerFactory({
      rendererVersion:'0.2.0',rendererPackageName:'@godot-js/react/engine',supportsMutation:true,supportsPersistence:false,supportsHydration:false,isPrimaryRenderer:true,
      getRootHostContext:()=>emptyContext,getChildHostContext:()=>emptyContext,getPublicInstance:(record:Instance)=>{if(!record.root.valid(record))throw error('E_ENGINE_REF','Native instance is unavailable');return record.native;},
      prepareForCommit:(container:Container)=>{container.root.committing=true;return null;},resetAfterCommit:(container:Container)=>{container.root.committing=false;container.root.counters.commits++;},preparePortalMount:noop,
      createInstance:(_type:string,props:NodeProps,container:Container)=>{const root=container.root;root.counters.prepared++;return {kind:'instance',root,props,children:[],disposed:false,invalidated:false,hidden:false,attached:false,defaults:new Map(),values:new Map(),events:new Map()};},
      appendInitialChild:(parent:Instance,child:Instance)=>{parent.children.push(child);child.parent=parent;},finalizeInitialChildren:()=>false,
      shouldSetTextContent:()=>false,createTextInstance:()=>{throw error('E_ENGINE_TEXT','Use a native Label or RichTextLabel text property');},
      appendChild:(parent:Instance,child:Instance)=>parent.root.append(parent,child),appendChildToContainer:(parent:Container,child:Instance)=>parent.root.append(parent,child),
      insertBefore:(parent:Instance,child:Instance,before:Instance)=>parent.root.append(parent,child,before),insertInContainerBefore:(parent:Container,child:Instance,before:Instance)=>parent.root.append(parent,child,before),
      removeChild:(parent:Instance,child:Instance)=>parent.root.remove(parent,child),removeChildFromContainer:(parent:Container,child:Instance)=>parent.root.remove(parent,child),
      commitUpdate:(record:Instance,_type:string,_old:NodeProps,next:NodeProps)=>record.root.update(record,next),commitTextUpdate:noop,commitMount:noop,resetTextContent:noop,
      clearContainer:(container:Container)=>{for(const child of [...container.children])container.root.remove(container,child);return false;},detachDeletedInstance:noop,
      hideInstance:(record:Instance)=>record.root.visibility(record,true),unhideInstance:(record:Instance)=>record.root.visibility(record,false),hideTextInstance:noop,unhideTextInstance:noop,
      scheduleTimeout:(callback:()=>void,delay:number)=>{const id=++rendererTimerSerial;rendererTimers.set(id,{at:Date.now()+Math.max(0,delay),callback});return id;},cancelTimeout:(id:number)=>rendererTimers.delete(id),noTimeout:-1,
      supportsMicrotasks:true,scheduleMicrotask:(callback:()=>void)=>rendererMicrotasks.push(callback),
      setCurrentUpdatePriority:(value:number)=>priority=value,getCurrentUpdatePriority:()=>priority,resolveUpdatePriority:()=>priority||32,
      resolveEventType:()=>null,resolveEventTimeStamp:()=>-1.1,trackSchedulerEvent:noop,requestPostPaintCallback:noop,shouldAttemptEagerTransition:()=>false,
      maySuspendCommit:()=>false,maySuspendCommitOnUpdate:()=>false,maySuspendCommitInSyncRender:()=>false,preloadInstance:()=>true,startSuspendingCommit:noop,suspendInstance:noop,suspendOnActiveViewTransition:noop,waitForCommitToBeReady:()=>null,
      NotPendingTransition:null,HostTransitionContext:React.createContext(null),resetFormInstance:noop,supportsTestSelectors:false,supportsResources:false,supportsSingletons:false,
    } as any);
  }
  private make(record: Instance): any {
    if(record.disposed)throw error('E_ENGINE_DISPOSED','Cannot reuse a retired host');
    if(record.native)return record.native;
    if(!this.committing)throw error('E_ENGINE_COMMIT','Native nodes are created only during commit');
    const props=record.props;
    let object:any;
    if('object'in props){
      if(props.ownership!=='adopt')throw error('E_ENGINE_OWNERSHIP','Existing objects require explicit adopt ownership');
      object=props.object;
      if(nativeCall(object,'get_parent'))throw error('E_ENGINE_OWNERSHIP','Adopted nodes must be detached before adoption');
    }else{if(typeof props.ctor!=='function')throw error('E_ENGINE_CONSTRUCTOR','Expected a Godot Node constructor');object=new props.ctor(...props.args??[]);}
    if(!nativeAlive(this.godot,object)||!nativeCall(object,'is_class','Node'))throw error('E_ENGINE_NODE','EngineNode requires a native Node');
    if(owners.has(object)||mounts.has(object))throw error('E_ENGINE_OWNERSHIP','Native node already belongs to a root');
    record.native=object;record.identity=nativeIdentity(object);owners.set(object,record);this.records.add(record);
    if('object'in props)this.counters.adopted++;else this.counters.created++;
    try {
      record.properties=propertyDescriptions(object,this.publicName);
      this.apply(record,props);
      for(const child of record.children){nativeCall(object,'add_child',this.make(child));child.attached=true;}
      return object;
    }catch(value){this.retire(record);throw value;}
  }
  private property(record:Instance,key:string): PropertyDescription {
    let property=record.properties?.get(key);
    if(!property&&record.native){record.properties=propertyDescriptions(record.native,this.publicName);property=record.properties.get(key);}
    if(!property)throw error('E_ENGINE_PROPERTY',`Unknown native property ${key}`);
    if(property.usage & (1<<28))throw error('E_ENGINE_PROPERTY',`Read-only native property ${key}`);
    return property;
  }
  private apply(record:Instance,next:NodeProps): void {
    if(!record.native||record.invalidated)return;
    const wanted=new Map<string,unknown>();
    for(const [key,value]of Object.entries(next.native??{})){if(value===undefined)continue;const property=this.property(record,key);if(wanted.has(property.nativeName))throw error('E_ENGINE_PROPERTY',`Duplicate aliases for ${property.nativeName}`);wanted.set(property.nativeName,value);}
    for(const [name]of record.values)if(!wanted.has(name)){nativeCall(record.native,'set',name,record.defaults.get(name)!.value);record.values.delete(name);record.defaults.delete(name);}
    for(const [name,value]of wanted){const captured=captureValue(this.godot,value,this.className),previous=record.values.get(name);if(!previous||!sameValue(previous,captured)){if(!record.defaults.has(name))record.defaults.set(name,captureValue(this.godot,nativeCall(record.native,'get',name),this.className));nativeCall(record.native,'set',name,value);record.values.set(name,captured);}}
    record.signals=signalDescriptions(record.native,this.publicName);
    const events=new Map<string,unknown>();
    for(const [key,callback]of Object.entries(next.on??{})){
      if(callback===undefined)continue;
      const name=record.signals?.get(key);if(!name)throw error('E_ENGINE_SIGNAL',`Unknown native signal ${key}`);
      if(events.has(name))throw error('E_ENGINE_SIGNAL',`Duplicate aliases for ${name}`);
      events.set(name,callback);
    }
    for(const [name,slot]of [...record.events])if(!events.has(name)){this.disconnectSlot(record,name,slot);record.events.delete(name);}
    for(const [name,callback]of events){
      if(typeof callback!=='function')throw error('E_ENGINE_SIGNAL',`Signal ${name} requires a function`);
      const current=record.events.get(name);if(current){current.callback=callback as (...args:any[])=>void;continue;}
      const slot:EventSlot={callback:callback as (...args:any[])=>void,callable:undefined,active:true};
      slot.callable=this.godot.Callable.create((...args:any[])=>{
        if(!slot.active||this.state!=='running'||!this.valid(record))return;
        const invoke=()=>{if(!slot.active||this.state!=='running'||!this.valid(record))return;this.signalDepth++;try{rendererCall(()=>this.renderer.flushSyncFromReconciler(()=>slot.callback(...args)));}catch(value){this.report(value);}finally{this.signalDepth--;if(!this.signalDepth&&this.pendingShutdown)this.shutdown();}};
        if(rendererDepth||this.signalDepth||this.committing||this.executing||this.phase==='physics'){this.microtasks.push(invoke);deferredRoots.add(this);}else {this.nativeSignalDepth++;try{invoke();if(this.pendingRender||this.microtasks.length)this.pump();}finally{this.nativeSignalDepth--;}}
      });
      if(nativeCall(record.native,'connect',name,slot.callable)!==0)throw error('E_ENGINE_SIGNAL',`Cannot connect signal ${name}`);
      record.events.set(name,slot);this.counters.connections++;
    }
    if(record.hidden&&record.properties?.has('visible'))nativeCall(record.native,'set','visible',false);
  }
  private update(record:Instance,next:NodeProps): void {
    if(('ctor'in next)!==('ctor'in record.props)||('ctor'in next&&'ctor'in record.props&&next.ctor!==record.props.ctor)||('object'in next&&'object'in record.props&&next.object!==record.props.object))throw error('E_ENGINE_CONSTRUCTOR','Change a React key when changing the native constructor/object');
    if(this.valid(record))this.apply(record,next);record.props=next;
  }
  private append(parent:Parent,child:Instance,before?:Instance): void {
    if(parent.kind==='instance'&&parent.native&&!this.valid(parent))return;
    const target=parent.kind==='container'?parent.native:this.make(parent);
    if(parent.kind==='container'&&!this.identityAlive(target,parent.identity))throw error('E_ENGINE_CONTAINER','Native mount has been released');
    if(child.native&&!this.valid(child))return;
    const object=this.make(child);
    if(child.parent&&child.parent!==parent)child.parent.children=child.parent.children.filter(item=>item!==child);
    parent.children=parent.children.filter(item=>item!==child);const at=before?parent.children.indexOf(before):-1;
    parent.children.splice(at<0?parent.children.length:at,0,child);child.parent=parent;
    const previous=nativeCall(object,'get_parent');if(previous&&previous!==target)nativeCall(previous,'remove_child',object);if(previous!==target)nativeCall(target,'add_child',object);
    child.attached=true;
    if(before?.native&&nativeAlive(this.godot,before.native)){
      const oldIndex=Number(nativeCall(object,'get_index')),nextIndex=Number(nativeCall(before.native,'get_index'));
      nativeCall(target,'move_child',object,nextIndex-(oldIndex<nextIndex?1:0));
    }else nativeCall(target,'move_child',object,-1);
  }
  private disconnectSlot(record:Instance,name:string,slot:EventSlot):void {
    slot.active=false;
    if(record.native&&record.identity&&this.identityAlive(record.native,record.identity)&&nativeCall(record.native,'is_connected',name,slot.callable))nativeCall(record.native,'disconnect',name,slot.callable);
    this.counters.disconnects++;
  }
  private disconnect(record:Instance):void {for(const [name,slot]of record.events)this.disconnectSlot(record,name,slot);record.events.clear();}
  private retire(record:Instance):void {
    if(record.disposed)return;
    const live=this.valid(record);this.disconnect(record);
    for(const child of [...record.children])this.retire(child);record.children.length=0;
    record.disposed=true;
    if(live){const inside=nativeCall(record.native,'is_inside_tree');const parent=nativeCall(record.native,'get_parent');if(parent)nativeCall(parent,'remove_child',record.native);nativeCall(record.native,inside||this.nativeSignalDepth?'queue_free':'free');this.counters.freed++;}
    if(record.native&&owners.get(record.native)===record)owners.delete(record.native);record.defaults.clear();record.values.clear();this.records.delete(record);
  }
  private remove(parent:Parent,child:Instance):void {parent.children=parent.children.filter(item=>item!==child);this.retire(child);}
  private visibility(record:Instance,hidden:boolean):void {
    if(!this.valid(record))return;
    if(record.properties?.has('visible')){
      if(hidden&&!record.hidden&&!record.defaults.has('__visibility'))record.defaults.set('__visibility',captureValue(this.godot,nativeCall(record.native,'get','visible'),this.className));
      if(!hidden){const target=record.values.get('visible')??record.defaults.get('__visibility');if(target)nativeCall(record.native,'set','visible',target.value);record.defaults.delete('__visibility');}
      else nativeCall(record.native,'set','visible',false);
    }
    record.hidden=hidden;
  }
  render(element:React.ReactNode):void {
    if(this.state!=='running')throw error('E_ENGINE_DISPOSED','Root is closed');
    if(rendererDepth||this.committing||this.executing||this.signalDepth||this.phase==='physics'){this.pendingRender={element};deferredRoots.add(this);return;}
    this.executing=true;
    try{rendererCall(()=>this.renderer.flushSyncFromReconciler(()=>this.renderer.updateContainerSync(React.createElement(Context.Provider,{value:this},element),this.fiber,null,null)));}finally{this.executing=false;}
    if(this.pendingShutdown)this.shutdown();else this.pump();
  }
  pump():void {
    if(this.state==='disposed'||this.pumping||rendererDepth||this.committing||this.executing||this.phase==='physics')return;this.pumping=true;
    try{
      const limit=this.options.maxWork??1000;let work=0;
      for(let pass=0;pass<10;pass++){
        EngineRoot.settleDeferred();
        if(this.pendingShutdown){this.shutdown();break;}
        if(this.pendingRender&&this.state==='running'){const pending=this.pendingRender;this.pendingRender=undefined;this.render(pending.element);}
        for(const [id,timer]of rendererTimers)if(timer.at<=Date.now()){rendererTimers.delete(id);rendererCall(timer.callback);}
        while(rendererMicrotasks.length){if(++work>limit)throw error('E_ENGINE_BUDGET','React microtasks did not settle');rendererCall(rendererMicrotasks.shift()!);}
        while(this.microtasks.length){if(++work>limit)throw error('E_ENGINE_BUDGET','React microtasks did not settle');this.microtasks.shift()!();}
        const passive=rendererCall(()=>{drainScheduler(this.options.budgetMs??5,limit);return this.renderer.flushPassiveEffects();});
        if(!this.microtasks.length&&!rendererMicrotasks.length&&!this.pendingRender&&!this.pendingShutdown&&!deferredRoots.size&&!passive)break;
      }
      for(const record of this.records)this.valid(record);
    }catch(value){this.report(value);throw value;}finally{this.pumping=false;}
  }
  private static settleDeferred():void {
    if(settlingDeferred)return;settlingDeferred=true;
    try{for(const root of [...deferredRoots]){
      if(root.phase==='physics'||root.signalDepth||root.committing||root.executing)continue;
      deferredRoots.delete(root);
      if(root.pendingShutdown)root.shutdown();
      else if(root.pendingRender&&root.state==='running'){const pending=root.pendingRender;root.pendingRender=undefined;root.render(pending.element);}
      else if(root.microtasks.length)root.pump();
    }}finally{settlingDeferred=false;}
  }
  subscribeFrame(phase:'process'|'physics',callback:(delta:number)=>void):()=>void {
    if(this.state!=='running')throw error('E_ENGINE_DISPOSED','Cannot subscribe to a closed root');this.frames[phase].add(callback);
    return()=>{this.frames[phase].delete(callback);};
  }
  private frame(phase:'process'|'physics',delta:number):void {
    if(this.state!=='running')return;if(phase==='process')this.pump();if(this.state!=='running')return;
    const previous=this.phase;this.phase=phase;
    try{for(const callback of [...this.frames[phase]])if(this.state==='running'&&!this.pendingShutdown&&this.frames[phase].has(callback))try{callback(delta);}catch(value){this.report(value);}}finally{this.phase=previous;if(this.pendingShutdown&&phase!=='physics')this.shutdown();}
  }
  process(delta:number):void {this.frame('process',delta);}
  physics(delta:number):void {this.frame('physics',delta);}
  portal(element:React.ReactNode,target:object,key:React.Key='portal'):React.ReactPortal {
    if(this.state!=='running'||!nativeAlive(this.godot,target)||!nativeCall(target,'is_class','Node'))throw error('E_ENGINE_PORTAL','Expected a live native mount');
    const owner=mounts.get(target);if(owner&&owner!==this)throw error('E_ENGINE_OWNERSHIP','Portal mount belongs to another root');
    if(owners.has(target))throw error('E_ENGINE_OWNERSHIP','Use a separate borrowed mount, not a React-owned node');
    let container=this.portals.get(target);if(!container){container={kind:'container',root:this,native:target,identity:nativeIdentity(target),children:[]};this.portals.set(target,container);mounts.set(target,this);}
    return this.renderer.createPortal(element,container,null,key);
  }
  unmount():void {if(this.state==='running')this.render(null);}
  shutdown():void {
    if(this.state!=='running')return;
    if(rendererDepth||this.signalDepth||this.committing||this.executing||this.phase==='physics'){this.pendingShutdown=true;this.pendingRender=undefined;deferredRoots.add(this);return;}
    this.pendingShutdown=false;this.state='disposing';
    try{
      rendererCall(()=>this.renderer.flushSyncFromReconciler(()=>this.renderer.updateContainerSync(null,this.fiber,null,null)));this.pump();
    }catch(value){this.report(value);}finally{
      for(const record of [...this.records])try{this.retire(record);}catch(value){this.report(value);}
      for(const unsubscribe of this.automatic.splice(0))try{unsubscribe();}catch(value){this.report(value);}
      this.frames.process.clear();this.frames.physics.clear();this.microtasks.length=0;this.pendingRender=undefined;
      if(mounts.get(this.container.native)===this)mounts.delete(this.container.native);for(const target of this.portals.keys())if(mounts.get(target)===this)mounts.delete(target);this.portals.clear();deferredRoots.delete(this);this.state='disposed';
    }
  }
  private installAutomaticProcessing():void {
    if(!nativeCall(this.container.native,'is_inside_tree'))throw error('E_ENGINE_AUTOPROCESS','Mount must be in SceneTree, or use autoProcess:false');
    const tree=nativeCall(this.container.native,'get_tree');
    for(const [signal,callback]of [['process_frame',()=>this.process(Number(nativeCall(this.container.native,'get_process_delta_time')))],['physics_frame',()=>this.physics(Number(nativeCall(this.container.native,'get_physics_process_delta_time')))]] as const){
      const callable=this.godot.Callable.create(()=>{if(this.state!=='running')return;if(!this.identityAlive(this.container.native,this.container.identity)){this.shutdown();return;}callback();});
      if(nativeCall(tree,'connect',signal,callable)!==0)throw error('E_ENGINE_AUTOPROCESS',`Cannot connect ${signal}`);
      this.automatic.push(()=>{if(nativeAlive(this.godot,tree)&&nativeCall(tree,'is_connected',signal,callable))nativeCall(tree,'disconnect',signal,callable);});
    }
  }
}
export function createRoot(containerNativeNode: object, options: EngineRootOptions = {}): EngineRoot {return new EngineRoot(containerNativeNode,options);}
