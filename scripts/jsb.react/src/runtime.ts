import * as React from "react";
import createReconciler from "./reconciler";
import type { NativeKey, RootState, BootVerificationReportV1, CleanupReceipt, CommitTicket, NativeAppliedReceipt, LayoutPublishedReceipt, AssetRef, TemplatePlanV1 } from "./contracts";
import { validateTemplatePlan, validateNativeKey } from "./contracts";
import { HOST_SCHEMA, getHostSchema, getProfileSchema, orderedPropertyNames, validateValue, canonicalFields, validateHostProps } from "./schema";
import type { NativePort, RuntimePhase } from "./native-port";
import { nativeKeyId } from "./native-port";
import { NativeInterfaceRegistry, nativeInterfaceSchema, getNativeInterfaceToken, normalizeNativeInterfaceProps, type NativeInterfaceToken } from "./native-interfaces";
import { configureScheduler, drainScheduler, scheduleHostTimeout, cancelHostTimeout } from "./scheduler";

type Props = Readonly<Record<string, unknown>>;
type Schema = (typeof HOST_SCHEMA)[keyof typeof HOST_SCHEMA];
type Validated = ReturnType<typeof validateHostProps>;
type Parent = HostRecord | Container;
interface Container { readonly kind: "container"; root: ReactRoot; key: NativeKey; children: HostRecord[]; draft: HostRecord[] | null }
interface HostRecord {
  readonly kind: "host"; id: string; root: ReactRoot; type: string; prepared: Props;
  current: Props | null; validated: Validated | null; children: HostRecord[]; draft: HostRecord[] | null;
  preparedChildren: HostRecord[]; parent: Parent | null; key: NativeKey | null;
  status: "prepared" | "materialized" | "published" | "retiring" | "freed" | "lost";
  events: Map<string,{callback:(...args:unknown[])=>void;disconnect:()=>void}>;
  handle: NodeReadHandle; hidden: boolean;hiddenVisible?:boolean;nativeInterfaceToken?:NativeInterfaceToken;
  template?:{instance:string;nodeId:string;ownerId:string|null;rootId:string;local:boolean};
}
export interface NodeReadHandle<K extends string = string> {
  readonly id: string; readonly type: K; readonly nativeKey: NativeKey;
  isValid(): boolean;
  read<T = unknown>(property: string): T;
  readPosition(): Readonly<{x:number;y:number}>;
  readVelocity(): Readonly<{x:number;y:number}>;
}
export interface FrameCommands<K extends string = string> extends NodeReadHandle<K> {
  readonly writableFields: readonly string[];
  command<T=unknown>(name:string,...args:readonly unknown[]):T;
  setPosition(value:Readonly<{x:number;y:number}>):void;
  setVelocity(value:Readonly<{x:number;y:number}>):void;
  moveAndSlide():boolean;
}
export type NodeRef<K extends string = string> = React.RefObject<NodeReadHandle<K> | null>;
export interface FrameOptions { readonly writes?: readonly string[]; readonly priority?:number; readonly active?:boolean }
export interface RuntimeDiagnostic {
  readonly code:string;readonly message:string;readonly path:string;readonly hostId:string;readonly type:string;
  readonly entryId:string;readonly generation:string;readonly rootInstance:string;readonly nativeKey:NativeKey;
}
interface FrameRegistration { id:string; ref:NodeRef; phase:"process"|"physics"|"input"; options:FrameOptions; callback:(node:FrameCommands,delta:number|unknown)=>unknown; version:number;target?:HostRecord }
interface ReadyRegistration {id:string;ref:NodeRef;callback:(node:NodeReadHandle)=>void|(()=>void); target?:string;cleanup?:()=>void}
interface AssetState {requiresCommit:boolean;status:"pending"|"ready"|"error";descriptor:AssetRef;value?:AssetRef;error?:unknown;promise:Promise<AssetRef>;resolve:(value:AssetRef)=>void;reject:(error:unknown)=>void}
export interface ReactRootOptions {
  entryId?:string; generation:string; rootId?:string; rootInstance?:string; mode?:"development"|"production";
  maxWork?:number; budgetMs?:number; onError?:(error:unknown)=>void; onBoot?:(report:BootVerificationReportV1)=>void;
  onDiagnostic?:(diagnostic:RuntimeDiagnostic)=>void;
  profileId?:string;
  nativeScriptProfiles?:Readonly<Record<string,{type:string;script:string;schemaHash?:string}>>;
  assets?:Readonly<Record<string,{uri?:string;path?:string;type:string}>>;
}
const handles = new WeakMap<object,HostRecord>();
const RootContext = React.createContext<ReactRoot|null>(null);
const templateMetadata=new WeakMap<object,{instance:string;nodeId:string;ownerId:string|null;rootId:string;local:boolean}>();
let rootSerial=0;
const roots=new Set<ReactRoot>();
const ownedKey=(value:unknown):NativeKey=>Object.freeze({...validateNativeKey(value)});
const reconcilerMicrotasks:Array<()=>void>=[];
const failure=(code:string,message:string):Error=>Object.assign(new Error(`${code}: ${message}`),{code});
const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
const snapshot=(value:unknown):any=>{
  if(value===null||typeof value!=="object")return value;
  if(Array.isArray(value))return Object.freeze(value.map(snapshot));
  const out:Record<string,unknown>={};for(const [key,item]of Object.entries(value))out[key]=snapshot(item);return Object.freeze(out);
};
function schema(type:string,profileId="core-ui-v1"):Schema{return getHostSchema(type,profileId);}
function property(type:string,name:string,profileId="core-ui-v1"):any {
  const result=(schema(type,profileId).properties as Record<string,unknown>)[name];
  if(!result)throw failure("E_PROPERTY_UNSUPPORTED",`${type}.${name} is not a readable property`);
  return result;
}
function hostChildren(parent:Parent):HostRecord[]{return parent.draft??(parent.kind==="host"&&parent.status==="prepared"?parent.preparedChildren:parent.children);}
function writableChildren(parent:Parent):HostRecord[]{
  if(parent.kind==="host"&&parent.status==="prepared")return parent.preparedChildren;
  return parent.draft??(parent.draft=[...parent.children]);
}
function keyFor(parent:Parent):NativeKey|null{return parent.kind==="container"?parent.key:parent.key;}
function getRecord(handle:NodeReadHandle|null):HostRecord|undefined{return handle?handles.get(handle as object):undefined;}
export const RuntimeContext = RootContext;

export class ReactRoot {
  readonly nativeInterfaces:NativeInterfaceRegistry;
  readonly port:NativePort;readonly options:ReactRootOptions;readonly container:Container;
  readonly rootId:string;readonly rootInstance:string;state:RootState="booting";
  private readonly fiber:any;
  private frameSerial=0;private serial=0;private commit=0;private operationEpoch=0;private depth=0;private phase:RuntimePhase="idle";
  private commitAuditError:unknown;
  private pendingMutation=false;private pendingPublication=false;private currentSetter:{record:HostRecord;signal?:string}|null=null;
  private readonly records=new Map<string,HostRecord>();private readonly byNative=new Map<string,HostRecord>();
  private readonly touched=new Set<Parent>();private readonly retiring=new Set<HostRecord>();
  private readonly microtasks:Array<()=>void>=[];private readonly eventQueue:Array<{record:HostRecord;event:string;args:unknown[];echo:boolean}>=[];
  private readonly frames=new Map<string,FrameRegistration>();private readonly frameChanges=new Map<string,FrameRegistration|null>();
  private readonly readies=new Map<string,ReadyRegistration>();private readonly readyChanges=new Map<string,ReadyRegistration|null>();
  private readonly assets=new Map<string,AssetState>();private readonly assetJobs:string[]=[];
  private readonly publicationReceipts:Array<NativeAppliedReceipt|LayoutPublishedReceipt>=[];
  private readonly receipts:CleanupReceipt[]=[];private readonly errors:unknown[]=[];private bootSent=false;
  private readonly diagnostics:RuntimeDiagnostic[]=[];private readonly pendingDiagnostics:RuntimeDiagnostic[]=[];
  private readonly templateRecords=new Map<string,Map<string,HostRecord>>();
  private readonly localizedAssets=new Map<string,{descriptor:AssetRef;instance:string}>();
  private readonly localizedScopes=new Set<string>();
  private readonly newlyMaterialized=new Set<HostRecord>();private assetCommitRequired=0;
  private closingPort=false;
  constructor(port:NativePort,container:NativeKey,options:ReactRootOptions){
    for(const active of roots)if(active.state!=="disposed")throw failure("E_MULTIPLE_ROOTS_UNSUPPORTED","Only one active React Root is supported per JavaScript realm; compose scenes under that root or dispose it before starting another entry");
    getProfileSchema(options.profileId??"core-ui-v1");
    if(!options.generation)throw failure("E_GENERATION_MISMATCH","A generation is required");
    this.port=port;this.options=snapshot(options);this.rootId=options.rootId??options.entryId??"app";
    this.rootInstance=options.rootInstance??`${this.rootId}:${++rootSerial}`;
    this.nativeInterfaces=new NativeInterfaceRegistry({isAlive:key=>(this.state==="booting"||this.state==="running")&&port.isAlive(key),enqueue:fn=>this.queueMicrotask(fn),onError:error=>this.report(error),send:port.nativeRpc?(key,method,args,peerId)=>this.runWork("safe",()=>port.nativeRpc!(key,method,args,peerId)):undefined});
    this.container={kind:"container",root:this,key:ownedKey(container),children:[],draft:null};
    if(port.children(container).length)throw failure("E_FOREIGN_MUTATION","Launch container must have no public business children");
    const report=(error:unknown)=>this.report(error);
    this.fiber=reconciler.createContainer(this.container,1,null,options.mode==="development",null,"",(error:unknown)=>{if(this.state!=="disposing"){this.state="faulted";this.operationEpoch++;this.nativeInterfaces.dispose();}this.report(error);},report,report,null);
    roots.add(this);configureScheduler({requestPump:()=>{}});
  }
  render(element:React.ReactNode):void {
    this.assertRunning();
    const wrapped=React.createElement(RootContext.Provider,{value:this},React.createElement(React.Suspense,{fallback:null},element));
    this.runWork(this.state==="booting"?"initial":"safe",()=>{
      reconciler.flushSyncFromReconciler(()=>reconciler.updateContainerSync(wrapped,this.fiber,null,null));
    });
    if(this.state==="booting")this.state="running";
    this.flush();
  }
  /** Explicit full barrier; needed for tests and controlled shutdown, still native-gated. */
  flush():void {
    if(this.state==="disposed")return;
    this.runWork(this.phase==="initial"?"initial":"safe",()=>this.settle());
  }
  pump(_delta?:number):void {
    if(this.state==="disposed")return;if(this.state==="faulted")throw failure("E_ROOT_FAULT",String(this.errors[this.errors.length-1]??"Root is faulted"));
    this.runWork("safe",()=>{
      this.takeInvalidations();this.loadAssets();this.drainMicrotasks();drainScheduler(this.options.budgetMs??5,this.maxWork);
      this.settle();this.audit();this.boot();
    });
  }
  process(delta:number):void{this.dispatchFrame("process",delta);}
  physics(delta:number):void{this.dispatchFrame("physics",delta);}
  input(event:unknown):void{this.dispatchFrame("input",event);}
  shutdown(_reason="requested"):void {
    if(this.state==="disposed"||this.state==="disposing")return;
    this.state="quiescing";this.operationEpoch++;this.nativeInterfaces.dispose();this.eventQueue.length=0;this.commitAuditError=undefined;
    const attempt=(callback:()=>void)=>{try{callback();}catch(error){this.report(error);}};
    attempt(()=>this.port.quiesce?.());let forced=false;
    try {this.runWork("cleanup",()=>{
      this.state="disposing";
      attempt(()=>reconciler.flushSyncFromReconciler(()=>reconciler.updateContainerSync(null,this.fiber,null,null)));
      attempt(()=>this.drainMicrotasks());attempt(()=>this.finishPublication());
      attempt(()=>{let iterations=0;while(reconciler.flushPassiveEffects()){if(++iterations>this.maxWork)throw failure("E_PUMP_BUDGET","Shutdown effects did not settle");this.drainMicrotasks();this.finishPublication();}});
      if(roots.size===1){attempt(()=>drainScheduler(this.options.budgetMs??5,this.maxWork));attempt(()=>{while(reconciler.flushPassiveEffects()){this.drainMicrotasks();this.finishPublication();}});}
      attempt(()=>this.releaseRetired());
      for(const record of [...this.records.values()])if(record.status!=="freed")attempt(()=>{this.retire(record);this.retiring.add(record);});
      attempt(()=>this.releaseRetired());
      for(const ready of this.readies.values())attempt(()=>this.clearReady(ready));
      this.readies.clear();this.frames.clear();this.frameChanges.clear();this.readyChanges.clear();
      for(const asset of this.assets.values())if(asset.value)attempt(()=>this.port.releaseAsset?.(asset.value!.id));
      this.assets.clear();this.assetJobs.length=0;
      if(this.records.size&&this.port.forceClose){this.port.forceClose();forced=true;for(const record of this.records.values())record.status="freed";this.records.clear();this.byNative.clear();this.retiring.clear();this.templateRecords.clear();this.localizedAssets.clear();this.localizedScopes.clear();}
    });
      if(!forced){if(this.depth>0)this.closingPort=true;else this.port.close?.();}
      this.state="disposed";roots.delete(this);this.microtasks.length=0;this.eventQueue.length=0;
    }catch(error){this.state="faulted";this.operationEpoch++;this.report(error);throw error;}
  }
  get maxWork():number{return this.options.maxWork??1000;}
  getStats(){return Object.freeze({state:this.state,commitId:this.commit,hostRecords:this.records.size,retiring:this.retiring.size,eventSlots:[...this.records.values()].reduce((n,r)=>n+r.events.size,0),frameSubscriptions:this.frames.size,readySubscriptions:this.readies.size,queuedEvents:this.eventQueue.length,queuedMicrotasks:this.microtasks.length,assetRefs:this.assets.size,errors:this.errors.length});}
  getNativeOperationResults(){return this.port.getNativeOperationResults?.()??[];}
  getPublicationReceipts():readonly (NativeAppliedReceipt|LayoutPublishedReceipt)[]{return this.publicationReceipts.map(x=>snapshot(x));}
  getCleanupReceipts():readonly CleanupReceipt[]{return this.receipts.map(x=>snapshot(x));}
  getErrors():readonly unknown[]{return [...this.errors];}
  getDiagnostics():readonly RuntimeDiagnostic[]{return [...this.diagnostics];}
  getHostGraph(){return [...this.records.values()].filter(x=>x.status==="published").map(x=>({id:x.id,type:x.type,key:x.key,children:x.children.map(c=>c.id),name:x.validated?.name}));}
  create(type:string,props:Props):HostRecord {
    schema(type,this.options.profileId);const meta=props.__reactTemplate;
    let metadata:HostRecord["template"];
    if(meta!==undefined){if(!meta||typeof meta!=="object"||!templateMetadata.has(meta))throw failure("E_TEMPLATE_METADATA","Untrusted template metadata");metadata=templateMetadata.get(meta)!;props=Object.fromEntries(Object.entries(props).filter(([key])=>key!=="__reactTemplate"));}
    const nativeInterfaceToken=getNativeInterfaceToken(props);props=normalizeNativeInterfaceProps(props,type);
    const normalized=validateHostProps(type as any,props as any,this.validationContext(metadata?.local));if(nativeInterfaceToken&&Object.keys(nativeInterfaceSchema(nativeInterfaceToken).rpc).length&&!normalized.name)throw failure("E_RPC_PATH","RPC endpoints require an explicit stable name");this.prepareAssets(normalized);
    const record={} as HostRecord;
    Object.assign(record,{kind:"host",id:`h${++this.serial}`,root:this,type,prepared:Object.freeze({...props}),current:null,validated:normalized,children:[],draft:null,preparedChildren:[],parent:null,key:null,status:"prepared",events:new Map(),hidden:false});
    const handle=Object.freeze({id:record.id,type,get nativeKey(){if(!record.key)throw failure("E_NATIVE_NOT_READY","Node is not materialized");return Object.freeze({...record.key});},isValid:()=>!!record.key&&record.status!=="lost"&&record.status!=="freed"&&this.port.isAlive(record.key),read:<T>(name:string)=>this.read(record,name) as T,readPosition:()=>this.read(record,"position"),readVelocity:()=>this.read(record,"velocity")}) as NodeReadHandle;
    record.handle=handle;record.template=metadata;record.nativeInterfaceToken=nativeInterfaceToken;handles.set(handle,record);return record;
  }
  materialize(record:HostRecord,parentType?:string):NativeKey {
    if(record.key)return record.key;
    this.assertGate();
    const validated=validateHostProps(record.type as any,record.prepared as any,{...this.validationContext(record.template?.local),parentType} as any);
    record.validated=validated;
    const profile=validated.nativeScriptProfile?this.options.nativeScriptProfiles?.[validated.nativeScriptProfile]:undefined;
    if(validated.nativeScriptProfile&&(!profile||profile.type!==record.type||record.nativeInterfaceToken&&profile.schemaHash!==record.nativeInterfaceToken.schemaHash))throw failure("E_NATIVE_INTERFACE","Uncertified construction profile");
    record.key=ownedKey(this.port.create(record.type,profile?.script));record.status="materialized";
    if(record.nativeInterfaceToken){if(!this.port.nativeIdentity)throw failure("E_NATIVE_ABI","nativeIdentity required");this.nativeInterfaces.bind(this.port.nativeIdentity(record.key),record.key,record.nativeInterfaceToken,record.handle);}
    this.records.set(record.id,record);this.byNative.set(nativeKeyId(record.key),record);this.newlyMaterialized.add(record);
    if(record.template){let map=this.templateRecords.get(record.template.instance);if(!map){map=new Map();this.templateRecords.set(record.template.instance,map);}map.set(record.template.nodeId,record);}
    this.port.set(record.key,"name",validated.name??`${record.type}_${record.id}`);
    const desired={...validated.baseline,...validated.controlled};for(const name of orderedPropertyNames(record.type,this.options.profileId))if(name in desired)this.set(record,name,desired[name]);
    record.current=record.prepared;this.bindEvents(record,validated.events as any);
    const children=record.preparedChildren;this.checkNames(children);
    children.forEach((child,index)=>{child.parent=record;const key=this.materialize(child,record.type);this.port.append(record.key!,key,index);});
    record.draft=[...children];this.touched.add(record);
    if(record.template&&record.template.nodeId===record.template.rootId){this.bindTemplateOwners(record.template.instance);if(this.localizedScopes.has(record.template.instance)){if(!this.port.finishAssetScope)throw failure("E_NATIVE_ABI","finishAssetScope unavailable");this.port.finishAssetScope(record.template.instance);}}
    return record.key;
  }
  append(parent:Parent,child:HostRecord,before?:HostRecord):void {
    this.assertGate();if(child.key&&child.nativeInterfaceToken&&child.parent&&child.parent!==parent)throw failure("E_RPC_PATH","Native-interface hosts require a stable parent; change key");const list=writableChildren(parent);const old=list.indexOf(child);if(old>=0)list.splice(old,1);
    const index=before?list.indexOf(before):-1;list.splice(index<0?list.length:index,0,child);this.checkNames(list);
    const key=keyFor(parent);child.parent=parent;
    if(key){const native=this.materialize(child,parent.kind==="host"?parent.type:undefined);this.refreshVisibility(child);this.port.append(key,native,list.indexOf(child));}
    this.touched.add(parent);
  }
  remove(parent:Parent,child:HostRecord):void {
    this.assertGate();const list=writableChildren(parent);const index=list.indexOf(child);if(index>=0)list.splice(index,1);
    this.retire(child);const key=keyFor(parent);
    if(key&&child.key&&this.port.isAlive(key)&&this.port.isAlive(child.key)){const actual=this.port.info(child.key).parent;if(actual&&nativeKeyId(actual)===nativeKeyId(key))this.port.remove(key,child.key);else if(this.state!=="disposing")throw failure("E_FOREIGN_MUTATION","Deletion target changed parent");}
    this.retiring.add(child);child.parent=null;this.touched.add(parent);
  }
  update(record:HostRecord,props:Props):void {
    this.assertGate();
    if(props.__reactTemplate!==undefined)props=Object.fromEntries(Object.entries(props).filter(([key])=>key!=="__reactTemplate"));
    const token=getNativeInterfaceToken(props);if(token!==record.nativeInterfaceToken&&(token?.profile!==record.nativeInterfaceToken?.profile||token?.schemaHash!==record.nativeInterfaceToken?.schemaHash))throw failure("E_NATIVE_INTERFACE","Construction token is fixed; change key");props=normalizeNativeInterfaceProps(props,record.type);
    const validated=validateHostProps(record.type as any,props as any,{...this.validationContext(record.template?.local),previous:record.validated,parentType:record.parent?.kind==="host"?record.parent.type:undefined} as any);
    this.prepareAssets(validated);
    const previous=record.validated!;
    const changed=new Set<string>();for(const name of new Set([...Object.keys(previous.controlled),...Object.keys(validated.controlled)]))if(!equal(validated.controlled[name],previous.controlled[name]))for(const field of canonicalFields(record.type,[name],undefined,this.options.profileId))changed.add(field);
    const desired={...previous.baseline,...validated.controlled};for(const name of orderedPropertyNames(record.type,this.options.profileId))if(name!=="name"&&name in desired&&canonicalFields(record.type,[name],undefined,this.options.profileId).some(field=>changed.has(field)))this.set(record,name,desired[name]);
    record.prepared=Object.freeze({...props});record.validated={...validated,baseline:previous.baseline};this.touched.add(record);
    if(this.options.mode==="development")for(const diagnostic of validated.diagnostics)this.pendingDiagnostics.push(snapshot({...diagnostic,hostId:record.id,type:record.type,entryId:this.options.entryId??this.rootId,generation:this.options.generation,rootInstance:this.rootInstance,nativeKey:record.key!}));
  }
  beginMutation():void{this.assertGate();this.port.setOperationContext?.({...this.ticket(),commitId:this.commit+1},this.operationEpoch);this.pendingMutation=true;this.newlyMaterialized.clear();}
  mutationApplied():void{try{this.port.audit?.();this.publicationReceipts.push({ticket:{...this.ticket(),commitId:this.commit+1},barrier:"nativeApplied"});}catch(error){this.report(error);if(this.state!=="disposing"){this.state="faulted";this.operationEpoch++;this.nativeInterfaces.dispose();this.commitAuditError=error;}}this.pendingMutation=false;this.pendingPublication=true;}
  queueMicrotask(callback:()=>void):void{this.microtasks.push(callback);}
  registerFrame(value:FrameRegistration):void{if(value.options.priority!==undefined&&!Number.isFinite(value.options.priority))throw failure("E_FRAME_OPTIONS","Priority must be finite");if(value.options.active!==undefined&&typeof value.options.active!=="boolean")throw failure("E_FRAME_OPTIONS","active must be boolean");const existing=this.frames.get(value.id);this.frameChanges.set(value.id,{...value,version:existing?.version??++this.frameSerial,options:Object.freeze({...value.options,writes:Object.freeze([...(value.options.writes??[])])})});this.pendingPublication=true;}
  unregisterFrame(id:string):void{this.frameChanges.set(id,null);this.pendingPublication=true;}
  registerReady(value:ReadyRegistration):void{this.readyChanges.set(value.id,value);this.pendingPublication=true;}
  unregisterReady(id:string):void{this.readyChanges.set(id,null);this.pendingPublication=true;}
  preloadAssets(ids:readonly string[]):void{for(const id of ids){const source=this.options.assets?.[id];if(!source)throw failure("E_ASSET_UNREGISTERED",id);try{this.readAsset(asset(id,source.type),false);}catch(error){if(!error||typeof (error as any).then!=="function")throw error;}}}
  readAsset(descriptor:AssetRef,requiresCommit=true):AssetRef {
    descriptor=validateValue("assetRef",descriptor) as AssetRef;const source=this.options.assets?.[descriptor.id];if(source&&source.type!==descriptor.type)throw failure("E_ASSET_TYPE",descriptor.id);
    const id=descriptor.id;let entry=this.assets.get(id);
    if(!entry){let resolve!:(v:AssetRef)=>void,reject!:(e:unknown)=>void;const promise=new Promise<AssetRef>((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});entry={requiresCommit,status:"pending",descriptor,promise,resolve,reject};this.assets.set(id,entry);this.assetJobs.push(id);}
    if(entry.descriptor.type!==descriptor.type)throw failure("E_ASSET_TYPE",id);
    if(requiresCommit)entry.requiresCommit=true;
    if(entry.status==="error")throw entry.error;if(entry.status==="pending")throw entry.promise;return entry.descriptor;
  }
  prepareHost(type:string,props:Props,templateToken?:object):void{this.prepareAssets(validateHostProps(type,normalizeNativeInterfaceProps(props,type),this.validationContext(templateToken?templateMetadata.get(templateToken)?.local:false)));}
  private validationContext(allowInstanceResources=false){return {allowedNativeScriptProfiles:Object.keys(this.options.nativeScriptProfiles??{}),profileId:this.options.profileId??"core-ui-v1",allowInstanceResources};}
  audit():void {
    this.port.audit?.();
    const visit=(parent:Parent):void=>{
      const key=keyFor(parent);if(!key||!this.port.isAlive(key))throw failure("E_NATIVE_LOST",`Lost parent in ${this.rootId}`);
      const expected=parent.children.filter(x=>x.status==="published");const actual=this.port.children(key);
      if(actual.length!==expected.length||actual.some((value,i)=>!expected[i]?.key||nativeKeyId(value)!==nativeKeyId(expected[i].key!)))throw failure("E_FOREIGN_MUTATION",`Public node children differ for ${parent.kind==="host"?parent.id:"root"}`);
      for(const record of expected){const info=this.port.info(record.key!);const wanted=record.validated?.name??`${record.type}_${record.id}`;if(info.type!==record.type||info.name!==wanted)throw failure("E_FOREIGN_MUTATION",`Native identity differs for ${record.id}`);visit(record);}
    };visit(this.container);
  }
  private ticket():CommitTicket{return {rootId:this.rootId,rootInstance:this.rootInstance,commitId:this.commit,buildGeneration:this.options.generation};}
  private checkNames(children:HostRecord[]):void{const names=new Set<string>();for(const child of children){const name=child.validated?.name??`${child.type}_${child.id}`;if(names.has(name))throw failure("E_DUPLICATE_NAME",name);names.add(name);}}
  private set(record:HostRecord,name:string,value:unknown):void {
    if(value===undefined)return;const item=property(record.type,name,this.options.profileId);this.currentSetter={record};
    if(name==="visible"&&this.isHidden(record)){record.hiddenVisible=value as boolean;value=false;}
    if(value&&typeof value==="object"&&(value as any).kind==="asset"){const descriptor=value as AssetRef;this.readAsset(descriptor);value=this.assets.get(descriptor.id)!.value;if(descriptor.scope==="instance"){const template=record.template;const templateRoot=template&&this.templateRecords.get(template.instance)?.get(template.rootId);if(!template?.local||!templateRoot?.key||!this.port.localizeAsset)throw failure("E_ASSET_SCOPE","Instance resources require a certified detached template root");value=this.port.localizeAsset((value as AssetRef).id,template.instance,templateRoot.key);this.localizedScopes.add(template.instance);this.localizedAssets.set((value as AssetRef).id,{descriptor:snapshot(descriptor),instance:template.instance});}}
    try{this.port.set(record.key!,item.nativeName,value);}finally{this.currentSetter=null;}
  }
  private read(record:HostRecord,name:string):unknown{
    if(!record.key||record.status==="freed"||record.status==="lost"||!this.port.isAlive(record.key))throw failure("E_NATIVE_LOST",record.id);
    const item=property(record.type,name,this.options.profileId);return this.wrapValue(this.port.read(record.key,item.nativeName));
  }
  private bindEvents(record:HostRecord,events:Record<string,unknown>):void {
    for(const [name,slot]of record.events)if(typeof events[name]!=="function"){slot.disconnect();record.events.delete(name);}
    for(const [name,callback]of Object.entries(events))if(typeof callback==="function"){
      const old=record.events.get(name);if(old){old.callback=callback as any;continue;}
      const signal=(schema(record.type,this.options.profileId).signals as Record<string,any>)[name];if(!signal)throw failure("E_SIGNAL_UNSUPPORTED",name);
      const slot={callback:callback as (...args:unknown[])=>void,disconnect:()=>{}};
      slot.disconnect=this.port.connect(record.key!,signal.nativeName,(...args)=>{
        if(record.status!=="published"&&record.status!=="materialized")return;
        const echo=this.currentSetter?.record===record&&signal.echo==="suppress";
        this.eventQueue.push({record,event:name,args,echo});
      });record.events.set(name,slot);
    }
  }
  private finishPublication():void {
    if(this.pendingMutation||this.state==="faulted")return;
    if(this.pendingPublication){this.commit++;this.port.setOperationContext?.(this.ticket(),this.operationEpoch);for(const parent of this.touched){if(parent.draft){parent.children=parent.draft;parent.draft=null;}if(parent.kind==="host"&&parent.status!=="retiring"&&parent.status!=="lost"){parent.current=parent.prepared;parent.status="published";this.bindEvents(parent,parent.validated!.events as any);}}this.touched.clear();this.pendingPublication=false;this.newlyMaterialized.clear();this.publicationReceipts.push({ticket:this.ticket(),barrier:"layoutPublished"});}
    for(const [id,value]of this.frameChanges){if(value)this.frames.set(id,value);else this.frames.delete(id);}this.frameChanges.clear();
    // Refs can change in a child commit without rendering the component that owns the Hook.
    // Validate every candidate lease before publishing any of the refreshed bindings.
    const targets=new Map<FrameRegistration,HostRecord|undefined>();
    for(const registration of this.frames.values()){const record=getRecord(registration.ref.current);if(record&&record.root!==this)throw failure("E_FOREIGN_REF","Frame target belongs to another root");targets.set(registration,record?.status==="published"?record:undefined);}
    const writers=new Map<string,string>(),hostWriters=new Set<HostRecord>();for(const registration of this.frames.values()){
      const record=targets.get(registration);if(!record||registration.options.active===false)continue;
      const fields=canonicalFields(record.type,registration.options.writes??[],record.parent?.kind==="host"?record.parent.type:undefined,this.options.profileId);if(fields.length){
        const reserved=new Set(record.validated!.engineOwned);if(fields.some(x=>!reserved.has(x)))throw failure("E_PROPERTY_OWNER_CONFLICT",`Frame writes not reserved on ${record.id}`);
        if(hostWriters.has(record))throw failure("E_PROPERTY_WRITER_CONFLICT",`Only one writing frame registration is supported for ${record.id}`);hostWriters.add(record);
        for(const field of fields){const key=`${nativeKeyId(record.key!)}:${field}`;if(writers.has(key)&&writers.get(key)!==registration.id)throw failure("E_PROPERTY_WRITER_CONFLICT",`Multiple writers for ${record.id}.${field}`);writers.set(key,registration.id);}
      }
    }
    for(const [registration,target]of targets)registration.target=target;
    for(const [id,value]of this.readyChanges){const old=this.readies.get(id);if(value){if(old){value.target=old.target;value.cleanup=old.cleanup;}this.readies.set(id,value);}else{this.readies.delete(id);if(old)this.clearReady(old);}}this.readyChanges.clear();
    this.notifyReady();
    for(const diagnostic of this.pendingDiagnostics.splice(0)){this.diagnostics.push(diagnostic);try{if(this.options.onDiagnostic)this.options.onDiagnostic(diagnostic);else console.warn("GODOT_REACT_DIAGNOSTIC",JSON.stringify(diagnostic));}catch(error){this.report(error);}}
  }
  private retire(record:HostRecord):void{if(record.status==="freed"||record.status==="retiring")return;record.status="retiring";if(record.key)this.nativeInterfaces.unbind(record.key);for(const slot of record.events.values())slot.disconnect();record.events.clear();for(const child of hostChildren(record))this.retire(child);}
  private settle():void{
    for(let turn=0;turn<this.maxWork;turn++){
      if(this.state==="faulted")throw this.commitAuditError??this.errors[this.errors.length-1]??failure("E_ROOT_FAULT","Root faulted");
      this.drainMicrotasks();this.finishPublication();
      let passives=0;while(reconciler.flushPassiveEffects()){if(++passives>this.maxWork)throw failure("E_PUMP_BUDGET","Passive effects did not settle");this.finishPublication();this.drainMicrotasks();}
      this.finishPublication();this.releaseRetired();this.notifyReady();
      if(this.eventQueue.length)this.flushEvents();
      this.restoreControlledState();
      if(!this.eventQueue.length&&!this.microtasks.length&&!this.pendingPublication&&!this.retiring.size&&!this.frameChanges.size&&!this.readyChanges.size)return;
    }
    throw failure("E_PUMP_BUDGET","Application work did not settle");
  }
  private releaseRetired():void {
    if(!this.retiring.size)return;const ids=[...this.retiring].map(x=>x.id);const retirementBatch=`${this.rootInstance}:${this.commit}:${this.receipts.length}`;
    this.cleanupReadyTargets();
    const dispose=(record:HostRecord):void=>{for(const child of hostChildren(record))dispose(child);record.status="freed";if(record.key)this.byNative.delete(nativeKeyId(record.key));if(record.template){if(record.template.nodeId===record.template.rootId&&this.localizedScopes.delete(record.template.instance)){this.port.releaseAssetScope?.(record.template.instance);for(const [id,asset]of this.localizedAssets)if(asset.instance===record.template.instance)this.localizedAssets.delete(id);}const map=this.templateRecords.get(record.template.instance);map?.delete(record.template.nodeId);if(!map?.size)this.templateRecords.delete(record.template.instance);}this.records.delete(record.id);record.children=[];record.preparedChildren=[];record.draft=null;};
    for(const record of this.retiring){if(record.status==="freed")continue;if(record.key&&this.port.isAlive(record.key))this.port.free(record.key,retirementBatch);dispose(record);}
    this.receipts.push({ticket:this.ticket(),barrier:"passiveSettled",retirementBatch,roots:ids,passiveSequence:this.receipts.length+1});this.retiring.clear();
  }
  private restoreControlledState():void {
    if(this.state!=="running"&&this.state!=="booting")return;
    for(const record of this.records.values())if(record.type==="Button"&&record.status==="published"&&record.key&&record.validated&&Object.hasOwn(record.validated.controlled,"buttonPressed")){
      const desired=record.validated.controlled.buttonPressed;
      if(this.port.read(record.key,"button_pressed")!==desired)this.set(record,"buttonPressed",desired);
    }
  }
  private flushEvents():void{let n=0;while(this.eventQueue.length){if(++n>this.maxWork)throw failure("E_EVENT_LOOP","Event budget exceeded");const event=this.eventQueue.shift()!;if(event.echo||event.record.status!=="published"||!event.record.key||!this.port.isAlive(event.record.key)||this.state==="disposing"||this.state==="quiescing")continue;const slot=event.record.events.get(event.event);if(slot)reconciler.flushSyncFromReconciler(()=>slot.callback(...event.args.map(value=>this.wrapValue(value))));this.finishPublication();}}
  private clearReady(registration:ReadyRegistration):void{const cleanup=registration.cleanup;registration.cleanup=undefined;registration.target=undefined;cleanup?.();}
  private cleanupReadyTargets():void{for(const registration of this.readies.values())if(registration.target){const record=this.byNative.get(registration.target);if(!record||record.status!=="published"||getRecord(registration.ref.current)!==record||!record.key||!this.port.isAlive(record.key))this.clearReady(registration);}}
  private notifyReady():void{this.cleanupReadyTargets();if(this.state!=="running"&&this.state!=="booting")return;for(const registration of this.readies.values()){
    const record=getRecord(registration.ref.current);if(!record?.key||record.status!=="published")continue;
    const key=nativeKeyId(record.key);if(registration.target===key)continue;
    if(this.port.info(record.key).ready===false)continue;
    registration.target=key;const cleanup=registration.callback(record.handle);registration.cleanup=typeof cleanup==="function"?cleanup:undefined;
  }}
  private isHidden(record:HostRecord):boolean{for(let item:Parent|null=record;item?.kind==="host";item=item.parent)if(item.hidden)return true;return false;}
  private refreshVisibility(record:HostRecord):void{
    if(record.key&&schema(record.type,this.options.profileId).properties.visible){
      if(this.isHidden(record)){if(record.hiddenVisible===undefined)record.hiddenVisible=this.port.read(record.key,"visible") as boolean;if(this.port.read(record.key,"visible")!==false)this.port.set(record.key,"visible",false);}
      else if(record.hiddenVisible!==undefined){const visible=record.validated?.controlled.visible??record.hiddenVisible;this.port.set(record.key,"visible",visible);record.hiddenVisible=undefined;}
    }
    for(const child of hostChildren(record))this.refreshVisibility(child);
  }
  setHidden(record:HostRecord,hidden:boolean):void{this.assertGate();record.hidden=hidden;this.refreshVisibility(record);}
  private dispatchFrame(phase:"process"|"physics"|"input",value:unknown):void {
    if(this.state!=="running")return;
    this.runWork(phase,()=>{
      const order=new Map<HostRecord,number>();const visit=(parent:Parent):void=>{for(const record of parent.children){order.set(record,order.size);visit(record);}};visit(this.container);
      const list=[...this.frames.values()].filter(x=>x.phase===phase&&x.options.active!==false).sort((a,b)=>(a.options.priority??0)-(b.options.priority??0)||(order.get(a.target!)??Infinity)-(order.get(b.target!)??Infinity)||a.version-b.version);
      for(const registration of list){const record=registration.target;if(!record||registration.ref.current!==record.handle||record.status!=="published"||!record.key||!this.port.isAlive(record.key)||this.port.info(record.key).insideTree===false)continue;
        const fields=canonicalFields(record.type,registration.options.writes??[],record.parent?.kind==="host"?record.parent.type:undefined,this.options.profileId);let alive=true;const dispatchKey=record.key;const epoch=this.operationEpoch;
        const check=()=>{if(!alive||this.phase!==phase||this.state!=="running"||record.status!=="published"||this.operationEpoch!==epoch||record.key!==dispatchKey||!this.port.isAlive(dispatchKey))throw failure("E_STALE_COMMAND","Commands escaped their dispatch");};
        const command=<T>(name:string,...args:unknown[]):T=>{check();const spec=(schema(record.type,this.options.profileId).commands as Record<string,any>)[name];if(!spec||spec.phase!==phase)throw failure("E_COMMAND_UNSUPPORTED",name);const effects=canonicalFields(record.type,spec.effects,undefined,this.options.profileId);if(effects.some(x=>!fields.includes(x)))throw failure("E_PROPERTY_OWNER_CONFLICT",name);if(!this.port.command)throw failure("E_COMMAND_UNSUPPORTED","Backend has no command channel");if(args.length!==spec.arguments.length)throw failure("E_VALUE","Command argument count mismatch");const values=args.map((value,index)=>validateValue(spec.arguments[index],value,`$command.${name}[${index}]`));return this.wrapValue(this.port.command(dispatchKey,spec.nativeName,values)) as T;};
        const commands=Object.freeze({...record.handle,id:record.id,type:record.type,nativeKey:ownedKey(dispatchKey),isValid:()=>record.handle.isValid(),read:<T>(name:string)=>{check();return record.handle.read<T>(name);},readPosition:()=>{check();return record.handle.readPosition();},readVelocity:()=>{check();return record.handle.readVelocity();},writableFields:Object.freeze(fields),command,setPosition:(v:unknown)=>command("setPosition",v),setVelocity:(v:unknown)=>command("setVelocity",v),moveAndSlide:()=>command<boolean>("moveAndSlide")}) as FrameCommands;
        try{const result=registration.callback(commands,value as any);if(result&&typeof(result as any).then==="function"){Promise.resolve(result).catch(error=>this.report(error));throw failure("E_ASYNC_FRAME","Frame callbacks must be synchronous");}}finally{alive=false;}
      }
    });
  }
  private wrapValue(value:unknown):unknown{if(value&&typeof value==="object"&&(value as any).kind==="NodeId"){const record=this.byNative.get(nativeKeyId((value as any).key));return record?.handle??snapshot(value);}if(value&&typeof value==="object"&&(value as any).kind==="asset"){const local=this.localizedAssets.get((value as any).id);if(local)return local.descriptor;for(const entry of this.assets.values())if(entry.value?.id===(value as any).id)return entry.descriptor;}if(Array.isArray(value))return Object.freeze(value.map(x=>this.wrapValue(x)));return snapshot(value);}
  private prepareAssets(value:Validated):void{for(const property of [...Object.values(value.baseline),...Object.values(value.controlled)])if(property&&typeof property==="object"&&"kind"in property&&property.kind==="asset")this.readAsset(property as AssetRef);}
  private bindTemplateOwners(instance:string):void{const map=this.templateRecords.get(instance);if(!map)return;for(const record of map.values()){const ownerId=record.template?.ownerId;if(ownerId){const owner=map.get(ownerId);if(!record.key||!owner?.key)throw failure("E_TEMPLATE_OWNER","Missing template owner");if(!this.port.setOwner)throw failure("E_NATIVE_ABI","Template owners require a backend setOwner operation");this.port.setOwner(record.key,owner.key);}}}
  private loadAssets():void{for(const id of this.assetJobs.splice(0)){const asset=this.assets.get(id);if(!asset||asset.status!=="pending")continue;try{const source=this.options.assets?.[id];if(!source||!this.port.loadAsset)throw failure("E_ASSET_UNREGISTERED",id);const value=this.port.loadAsset(source.uri??source.path??id,source.type);asset.value=snapshot(value) as AssetRef;asset.status="ready";if(asset.requiresCommit)this.assetCommitRequired=this.commit+1;asset.resolve(asset.value);}catch(error){asset.status="error";asset.error=error;asset.reject(error);}}}
  private takeInvalidations():void{for(const item of this.port.takeInvalidations?.()??[]){const record=this.byNative.get(nativeKeyId(item.key));if(record&&record.status!=="freed"&&record.status!=="retiring"&&!item.expected){record.status="lost";throw failure("E_FOREIGN_MUTATION",`Externally lost ${record.id}`);}}}
  private drainMicrotasks():void{let n=0;while(reconcilerMicrotasks.length||this.microtasks.length){if(++n>this.maxWork)throw failure("E_PUMP_BUDGET","Sync lane did not settle");(reconcilerMicrotasks.shift()??this.microtasks.shift())!();this.finishPublication();}}
  private boot():void{if(this.bootSent||this.state!=="running"||this.commit<this.assetCommitRequired||[...this.assets.values()].some(x=>x.status==="pending"))return;this.audit();this.bootSent=true;this.options.onBoot?.({schemaVersion:1,kind:"sdk-boot-verification-v1",scope:"framework-boot-smoke",entryId:this.options.entryId??this.rootId,generation:this.options.generation,rootInstance:this.rootInstance,runtimeAbi:"godot-react/1",nativeBridgeAbi:"godot-react-native/1",profile:this.options.profileId??"core-ui-v1",layoutPublished:this.commit,treeAudit:{matches:true,businessNodes:this.records.size},startupAssets:{requested:[...this.assets.keys()],ready:[...this.assets].filter(([,v])=>v.status==="ready").map(([id])=>id),failures:[...this.assets].filter(([,v])=>v.status==="error").map(([id])=>id)},unexpectedErrors:this.errors.map(String)});}
  private report(error:unknown):void{this.errors.push(error);try{this.options.onError?.(error);}catch(loggerError){this.errors.push(loggerError);}}
  private assertRunning():void{if(this.state==="disposed"||this.state==="disposing"||this.state==="quiescing"||this.state==="faulted")throw failure("E_ROOT_STATE",this.state);}
  private assertGate():void{if(this.phase==="idle"||this.phase==="physics"||this.phase==="process"||this.phase==="input")throw failure("E_PHASE",`Native structural mutation in ${this.phase}`);}
  private runWork<T>(phase:Exclude<RuntimePhase,"idle">,callback:()=>T):T{
    const outer=this.depth===0;const previous=this.phase;if(outer){this.port.setOperationContext?.(this.ticket(),this.operationEpoch);this.port.beginStage(phase);this.phase=phase;}
    this.depth++;
    try{const result=callback();if(outer){if(this.commitAuditError){const error=this.commitAuditError;this.commitAuditError=undefined;throw error;}this.finishPublication();}return result;}catch(error){if(this.state!=="disposing"){this.state="faulted";this.operationEpoch++;this.nativeInterfaces.dispose();}this.report(error);throw error;}finally{this.depth--;if(outer){this.port.endStage();this.phase=previous;if(this.closingPort){this.closingPort=false;this.port.close?.();}}}
  }
}

const noop=()=>{};let updatePriority=0;
const reconciler=createReconciler({
 rendererVersion:"0.1.0",rendererPackageName:"@godot-js/react",supportsMutation:true,supportsPersistence:false,supportsHydration:false,isPrimaryRenderer:true,
 getRootHostContext:()=>({}),getChildHostContext:(_context:unknown,type:string)=>({parentType:type}),getPublicInstance:(record:HostRecord)=>record.handle,
 prepareForCommit:(container:Container)=>{container.root.beginMutation();return null;},resetAfterCommit:(container:Container)=>container.root.mutationApplied(),preparePortalMount:noop,
 createInstance:(type:string,props:Props,container:Container)=>container.root.create(type,props),appendInitialChild:(parent:HostRecord,child:HostRecord)=>parent.preparedChildren.push(child),finalizeInitialChildren:()=>false,
 shouldSetTextContent:()=>false,createTextInstance:()=>{throw failure("E_TEXT_CHILD","Use Label.text for text children");},
 appendChild:(p:HostRecord,c:HostRecord)=>p.root.append(p,c),appendChildToContainer:(p:Container,c:HostRecord)=>p.root.append(p,c),insertBefore:(p:HostRecord,c:HostRecord,b:HostRecord)=>p.root.append(p,c,b),insertInContainerBefore:(p:Container,c:HostRecord,b:HostRecord)=>p.root.append(p,c,b),
 removeChild:(p:HostRecord,c:HostRecord)=>p.root.remove(p,c),removeChildFromContainer:(p:Container,c:HostRecord)=>p.root.remove(p,c),commitUpdate:(record:HostRecord,_type:string,_old:Props,next:Props)=>record.root.update(record,next),
 commitTextUpdate:()=>{throw failure("E_TEXT_CHILD","Text instances are unsupported");},commitMount:noop,resetTextContent:noop,
 clearContainer:(container:Container)=>{if(container.children.length)for(const child of [...container.children])container.root.remove(container,child);return false;},detachDeletedInstance:noop,
 hideInstance:(record:HostRecord)=>record.root.setHidden(record,true),unhideInstance:(record:HostRecord)=>record.root.setHidden(record,false),hideTextInstance:noop,unhideTextInstance:noop,
 scheduleTimeout:(fn:()=>void,delay:number)=>scheduleHostTimeout(fn,delay),cancelTimeout:(id:number)=>cancelHostTimeout(id),noTimeout:-1,
 supportsMicrotasks:true,scheduleMicrotask:(fn:()=>void)=>{reconcilerMicrotasks.push(fn);},
 setCurrentUpdatePriority:(p:number)=>{updatePriority=p;},getCurrentUpdatePriority:()=>updatePriority,resolveUpdatePriority:()=>updatePriority||32,
 resolveEventType:()=>null,resolveEventTimeStamp:()=>-1.1,trackSchedulerEvent:noop,requestPostPaintCallback:noop,shouldAttemptEagerTransition:()=>false,maySuspendCommit:()=>false,maySuspendCommitOnUpdate:()=>false,maySuspendCommitInSyncRender:()=>false,
 preloadInstance:()=>true,startSuspendingCommit:noop,suspendInstance:noop,suspendOnActiveViewTransition:noop,waitForCommitToBeReady:()=>null,NotPendingTransition:null,HostTransitionContext:React.createContext(null),resetFormInstance:noop,supportsTestSelectors:false,supportsResources:false,supportsSingletons:false,
});
export function createRoot(port:NativePort,container:NativeKey,options:ReactRootOptions):ReactRoot{return new ReactRoot(port,container,options);}
export function useRuntime():ReactRoot{const root=React.useContext(RootContext);if(!root)throw failure("E_ROOT_CONTEXT","Godot Hooks require an application root");return root;}
export function useNodeRef<K extends string>():NodeRef<K>{useRuntime();return React.useRef<NodeReadHandle<K>|null>(null);}
function useFrame<K extends string>(phase:FrameRegistration["phase"],ref:NodeRef<K>,options:FrameOptions,callback:(commands:FrameCommands<K>,delta:any)=>unknown):void{
 const root=useRuntime(),id=React.useId();
 React.useLayoutEffect(()=>{root.registerFrame({id,ref:ref as NodeRef,phase,options,callback:callback as any,version:0});return()=>root.unregisterFrame(id);});
}
export function useProcess<K extends string,F extends (commands:FrameCommands<K>,delta:number)=>unknown>(ref:NodeRef<K>,options:FrameOptions,callback:F&([Extract<ReturnType<F>,PromiseLike<unknown>>] extends [never]?unknown:never)):void{useFrame("process",ref,options,callback);}
export function usePhysicsProcess<K extends string,F extends (commands:FrameCommands<K>,delta:number)=>unknown>(ref:NodeRef<K>,options:FrameOptions,callback:F&([Extract<ReturnType<F>,PromiseLike<unknown>>] extends [never]?unknown:never)):void{useFrame("physics",ref,options,callback);}
export function useInput<K extends string,F extends (commands:FrameCommands<K>,event:unknown)=>unknown>(ref:NodeRef<K>,callback:F&([Extract<ReturnType<F>,PromiseLike<unknown>>] extends [never]?unknown:never),options:FrameOptions={}):void{useFrame("input",ref,options,callback);}
export function useNativeReady<K extends string>(ref:NodeRef<K>,callback:(node:NodeReadHandle<K>)=>void|(()=>void)):void{
 const root=useRuntime(),id=React.useId();React.useLayoutEffect(()=>{root.registerReady({id,ref:ref as NodeRef,callback:callback as any});return()=>root.unregisterReady(id);});
}
export function asset<T extends string>(id:string,type:T):AssetRef<T>{return Object.freeze({kind:"asset",id,type,scope:"shared"});}
export function useAsset<T extends string>(descriptor:AssetRef<T>):AssetRef<T>{return useRuntime().readAsset(descriptor) as AssetRef<T>;}
export function vec2(x:number,y:number):Readonly<{x:number;y:number}>{if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError("Vector2 requires finite numbers");return Object.freeze({x,y});}
export function color(r:number,g:number,b:number,a=1):Readonly<{r:number;g:number;b:number;a:number}>{if(![r,g,b,a].every(Number.isFinite))throw new TypeError("Color requires finite numbers");return Object.freeze({r,g,b,a});}

export function createTemplateComponent<P extends {name?:string;initial?:Readonly<Record<string,unknown>>}={name?:string;initial?:Readonly<Record<string,unknown>>}>(input:TemplatePlanV1):React.ForwardRefExoticComponent<React.PropsWithoutRef<P>&React.RefAttributes<NodeReadHandle>>{
 const plan=snapshot(validateTemplatePlan(input)) as TemplatePlanV1;const nodes=new Map(plan.nodes.map(n=>[n.nodeId,n]));
 const children=new Map<string,typeof plan.nodes>();
 for(const node of plan.nodes)if(node.parentId){const list=children.get(node.parentId)??[];children.set(node.parentId,[...list,node].sort((a,b)=>a.siblingOrder-b.siblingOrder));}
 const Component=React.forwardRef<NodeReadHandle,P>((props,ref)=>{
  const runtime=useRuntime();for(const resource of plan.resources)runtime.readAsset(asset(resource.resourceId,resource.type));
  const instance=React.useId();
  if((props as any).children!==undefined)throw failure("E_TEMPLATE_CHILDREN","Template children require a declared slot profile");
  const metadata=React.useMemo(()=>{const result=new Map<string,object>();for(const node of plan.nodes){const token={};templateMetadata.set(token,{instance,nodeId:node.nodeId,ownerId:node.ownerId,rootId:plan.rootId,local:plan.profile==="template-local-v1"});result.set(node.nodeId,token);}return result;},[instance]);
  const emit=(id:string):React.ReactElement=>{const node=nodes.get(id)!;const root=id===plan.rootId;const initial:Record<string,unknown>={...node.initial,...(root?props.initial:{})};for(const [name,value]of Object.entries(initial))if(value&&typeof value==="object"&&(value as AssetRef).kind==="asset"&&plan.resources.find(r=>r.resourceId===(value as AssetRef).id)?.sharingPolicy==="instance")initial[name]=Object.freeze({...value,scope:"instance"});const values:Record<string,unknown>={key:id,name:root?(props.name??`${node.name}_${instance.replace(/[^a-zA-Z0-9_]/g,"_")}`):node.name,initial,__reactTemplate:metadata.get(id)};
   if(root){for(const [name,value]of Object.entries(props))if(name!=="initial"&&name!=="name"&&name!=="children")values[name]=value;values.ref=ref;}
   const descendants=(children.get(id)??[]).map(n=>emit(n.nodeId));
   runtime.prepareHost(node.nativeType,Object.fromEntries(Object.entries(values).filter(([key])=>key!=="__reactTemplate"&&key!=="key")),metadata.get(id));
   return React.createElement(node.nativeType as React.ElementType,values,...descendants);
  };return emit(plan.rootId);
 });Component.displayName=`Template(${plan.assetId})`;return Component;
}
