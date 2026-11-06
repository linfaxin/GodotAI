import type { NativeKey } from "./contracts";
import { GAME_2D_HOST_SCHEMA, SHOWCASE_HOST_SCHEMA } from "./schema";
import type { NativePort, NativeInfo, RuntimePhase, NativeInvalidation } from "./native-port";
import { nativeKeyId } from "./native-port";
interface MockNode {key:NativeKey;type:string;name:string;parent:MockNode|null;children:MockNode[];owner:MockNode|null;props:Record<string,unknown>;alive:boolean;signals:Map<string,Set<(...args:unknown[])=>void>>}
export class MockNativePort implements NativePort {
  private readonly foundations=new Set<string>();
  private serial=0;private stage:RuntimePhase="idle";
  private nodes=new Map<string,MockNode>();private invalidations:NativeInvalidation[]=[];
  readonly calls:Array<{op:string;key?:NativeKey;phase:RuntimePhase;value?:unknown}>=[];
  readonly assets=new Map<string,unknown>();
  private readonly localAssets=new Map<string,unknown>();
  localizeAsset(id:string,instance:string,root:NativeKey):unknown{this.requireStage();this.node(root);const key=`${instance}:${id}`;if(!this.localAssets.has(key))this.localAssets.set(key,Object.freeze({kind:"asset",id:`@scope/${key}`,type:"CanvasItemMaterial",scope:instance}));this.calls.push({op:"localize",phase:this.stage,value:{id,instance,root}});return this.localAssets.get(key);}
  finishAssetScope(instance:string):void{this.requireStage();this.calls.push({op:"finishScope",phase:this.stage,value:instance});}
  releaseAssetScope(instance:string):void{this.requireStage();for(const id of this.localAssets.keys())if(id.startsWith(`${instance}:`))this.localAssets.delete(id);this.calls.push({op:"releaseScope",phase:this.stage,value:instance});}
  createContainer(name="App"):NativeKey{const key=this.allocate("Node");this.node(key).name=name;this.foundations.add(nativeKeyId(key));return key;}
  private allocate(type:string):NativeKey{
    const key=Object.freeze({slot:++this.serial,revision:1});const schema=(GAME_2D_HOST_SCHEMA as Record<string,any>)[type]??SHOWCASE_HOST_SCHEMA[type];
    const props:Record<string,unknown>={};if(schema)for(const value of Object.values(schema.properties) as any[])props[value.nativeName]=value.defaultValue;
    this.nodes.set(nativeKeyId(key),{key,type,name:type,parent:null,children:[],owner:null,props,alive:true,signals:new Map()});return key;
  }
  private node(key:NativeKey):MockNode{const value=this.nodes.get(nativeKeyId(key));if(!value?.alive)throw new Error(`E_NATIVE_LOST: ${nativeKeyId(key)}`);return value;}
  private requireStage(){if(this.stage==="idle")throw new Error("E_PHASE: mock native operation outside gate");}
  create(type:string):NativeKey{this.requireStage();const key=this.allocate(type);this.calls.push({op:"create",key,phase:this.stage});return key;}
  read(key:NativeKey,name:string):unknown{return name==="name"?this.node(key).name:this.node(key).props[name];}
  set(key:NativeKey,name:string,value:unknown):void{this.requireStage();const n=this.node(key),old=n.props[name];if(name==="name")n.name=String(value);if(name==="button_pressed"&&value===true&&n.props.toggle_mode!==true)return;if(name==="toggle_mode"&&value===false)n.props.button_pressed=false;n.props[name]=value;this.calls.push({op:"set",key,phase:this.stage,value:{name,value}});if(name==="button_pressed"&&old!==value)this.emit(key,"toggled",value);}
  append(parentKey:NativeKey,childKey:NativeKey,index:number):void{this.requireStage();const parent=this.node(parentKey),child=this.node(childKey);if(child.parent){const previous=child.parent.children;previous.splice(previous.indexOf(child),1);}index=Math.max(0,Math.min(index,parent.children.length));parent.children.splice(index,0,child);child.parent=parent;this.calls.push({op:"append",key:childKey,phase:this.stage,value:index});}
  remove(parentKey:NativeKey,childKey:NativeKey):void{this.requireStage();const parent=this.node(parentKey),child=this.node(childKey);if(child.parent!==parent)throw new Error("E_PARENT: wrong parent");parent.children.splice(parent.children.indexOf(child),1);child.parent=null;this.calls.push({op:"remove",key:childKey,phase:this.stage});}
  free(key:NativeKey):void{this.requireStage();const node=this.node(key);if(node.parent)throw new Error("E_NATIVE_FREE: detach before freeing");this.freeNode(node,true);}
  forceClose():void{this.requireStage();const detachForeign=(node:MockNode):void=>{for(const child of [...node.children]){if(this.foundations.has(nativeKeyId(child.key))){node.children.splice(node.children.indexOf(child),1);child.parent=null;}else detachForeign(child);}};for(const node of [...this.nodes.values()])if(node.alive&&!this.foundations.has(nativeKeyId(node.key))){detachForeign(node);this.freeNode(node,true);}this.calls.push({op:"forceClose",phase:this.stage});}
  quiesce():void{this.calls.push({op:"quiesce",phase:this.stage});}
  close():void{this.calls.push({op:"close",phase:this.stage});}
  externalFree(key:NativeKey):void{this.freeNode(this.node(key),false);}
  private freeNode(n:MockNode,expected:boolean):void{for(const c of [...n.children])this.freeNode(c,expected);if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.alive=false;n.signals.clear();this.invalidations.push({key:n.key,expected,reason:expected?"expected-free":"external-free"});this.calls.push({op:"free",key:n.key,phase:this.stage});}
  setOwner(key:NativeKey,owner:NativeKey|null):void{this.requireStage();this.node(key).owner=owner?this.node(owner):null;}
  children(key:NativeKey):readonly NativeKey[]{return this.node(key).children.map(x=>x.key);}
  info(key:NativeKey):NativeInfo{const n=this.node(key);return {type:n.type,name:n.name,parent:n.parent?.key??null,alive:n.alive,insideTree:true,ready:true};}
  nativeIdentity(key:NativeKey):string{return String(this.node(key).key.slot);}
  nativeRpc(key:NativeKey,method:string,args:readonly unknown[],peerId?:number):number{this.requireStage();this.node(key);this.calls.push({op:"rpc",key,phase:this.stage,value:{method,args,peerId}});return 0;}
  isAlive(key:NativeKey):boolean{return this.nodes.get(nativeKeyId(key))?.alive===true;}
  connect(key:NativeKey,name:string,callback:(...args:unknown[])=>void):()=>void{const n=this.node(key);let set=n.signals.get(name);if(!set){set=new Set();n.signals.set(name,set);}set.add(callback);return()=>set!.delete(callback);}
  emit(key:NativeKey,name:string,...args:unknown[]):void{for(const cb of [...(this.node(key).signals.get(name)??[])])cb(...args);}
  beginStage(phase:Exclude<RuntimePhase,"idle">):void{if(this.stage!=="idle")throw new Error("E_PHASE: nested port gate");this.stage=phase;}
  endStage():void{this.stage="idle";}
  takeInvalidations():readonly NativeInvalidation[]{return this.invalidations.splice(0);}
  command(key:NativeKey,name:string,args:readonly unknown[]):unknown{this.requireStage();const n=this.node(key);if(name==="set_position")n.props.position=args[0];else if(name==="set_rotation")n.props.rotation=args[0];else if(name==="set_scale")n.props.scale=args[0];else if(name==="set_velocity")n.props.velocity=args[0];else if(name==="move_and_slide"){this.calls.push({op:"command",key,phase:this.stage,value:{name,args}});return false;}else if(name==="grab_focus")this.emit(key,"focus_entered");else throw new Error(`E_COMMAND_UNSUPPORTED: ${name}`);this.calls.push({op:"command",key,phase:this.stage,value:{name,args}});return undefined;}
  loadAsset(path:string,type:string):unknown{this.requireStage();if(!this.assets.has(path))throw new Error(`E_ASSET_MISSING: ${path}`);return Object.freeze({kind:"asset",id:path,type,scope:"shared"});}
  releaseAsset(_id:string):void{}
  liveCount():number{return [...this.nodes.values()].filter(x=>x.alive).length;}
  connectionCount():number{return [...this.nodes.values()].reduce((n,node)=>n+[...node.signals.values()].reduce((k,set)=>k+set.size,0),0);}
}
export function createTestRootOptions(generation="test-generation"){return {generation,entryId:"test",mode:"production" as const};}
