import * as React from 'react';
import {EngineNode,useFrame,type NativeConstructor} from '@godot-js/react/engine';
declare const require:(name:string)=>any;
const G=require('godot');
export interface PointerAction {x:number;y:number;button:number}
export interface InputState {keys:Set<string>;pressed:Set<string>;actions:Set<string>;requests:Set<string>;pointer:{x:number;y:number};down:boolean;clicks:PointerAction[];releases:PointerAction[];wheel:number;imported?:unknown}
export interface ModelPart {id:string;name:string;position:{x:number;y:number;z:number};rotation:{x:number;y:number;z:number};scale:{x:number;y:number;z:number};shapeId?:string}
export interface DemoServices {controls:Readonly<Record<string,number>>;input:InputState;stats:(stats:Record<string,number|string|boolean>)=>void;sound:(name:'jump'|'coin'|'land')=>void;models:Readonly<Record<string,readonly ModelPart[]>>;exportJSON:(name:string,data:unknown)=>void}
const Services=React.createContext<DemoServices|null>(null);
const emptyInput=():InputState=>({keys:new Set(),pressed:new Set(),actions:new Set(),requests:new Set(),pointer:{x:480,y:320},down:false,clicks:[],releases:[],wheel:0});
let activeInput:InputState|undefined;
export const vec2=(x=0,y=0)=>new G.Vector2(x,y);
export const vec3=(x=0,y=0,z=0)=>new G.Vector3(x,y,z);
export const color=(r:number,g:number,b:number,a=1)=>new G.Color(r,g,b,a);
export const v2=(value:{x:number;y:number})=>vec2(value.x,value.y);
export const v3=(value:{x:number;y:number;z:number})=>vec3(value.x,value.y,value.z);
export function useDemo():DemoServices {const services=React.useContext(Services);if(!services)throw Error('Demo hooks require withDemo');return services;}
export function useNodeRef<K extends string=string>():React.RefObject<any>{return React.useRef<any>(null);}
export function useProcess(ref:React.RefObject<any>,callback:(node:any,delta:number)=>void){useFrame('process',delta=>{if(ref.current&&G.is_instance_valid(ref.current))callback(ref.current,delta);});}
export function usePhysicsProcess(ref:React.RefObject<any>,callback:(node:any,delta:number)=>void){useFrame('physics',delta=>{if(ref.current&&G.is_instance_valid(ref.current))callback(ref.current,delta);});}

/** Constructor-independent React sugar; all node operations use the engine renderer. */
export function Native({ctor,initial,native,ref,children}:{ctor:NativeConstructor;initial?:Record<string,unknown>;native?:Record<string,unknown>;ref?:React.Ref<any>;children?:React.ReactNode}){
 const first=React.useRef(initial),reference=React.useRef(ref);reference.current=ref;
 const assign=React.useCallback((object:any)=>{if(object)for(const [key,value]of Object.entries(first.current??{})){const name=key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),sample=object.get(name);object.set(name,sample instanceof G.Vector3?v3(value as any):sample instanceof G.Vector2?v2(value as any):value);}const target=reference.current;if(typeof target==='function')return target(object);if(target)target.current=object;},[]);
 return <EngineNode ctor={ctor} native={native} ref={assign}>{children}</EngineNode>;
}
interface Manifest {assets:Record<string,{uri:string;type:string}>;models:Record<string,ModelPart[]>}
let manifest:Manifest|undefined;
function resources():Manifest{
 if(manifest)return manifest;
 if(!G.ProjectSettings.load_resource_pack('res://.playground/demo-resources.pck',false))throw Error('Demo resource pack could not be mounted');
 return manifest=JSON.parse(G.FileAccess.get_file_as_string('res://.playground/demo-manifest.json'));
}
const loaded=new Map<string,any>();
export function useResource<T extends string>(id:string,type:T):any{
 return React.useMemo(()=>{const asset=resources().assets[id];if(!asset)throw Error('Unknown demo resource: '+id);let object=loaded.get(id);if(!object){object=G.ResourceLoader.load(asset.uri);if(!object||!object.is_class(type))throw Error('Could not load '+type+': '+id);loaded.set(id,object);}return object;},[id,type]);
}
export function useModelParts(id:string):readonly ModelPart[]{const parts=useDemo().models[id];if(!parts?.length)throw Error('Unknown model: '+id);return parts;}
export function clearDemoInput(){if(!activeInput)return;const input=activeInput;input.keys.clear();input.pressed.clear();input.actions.clear();input.down=false;input.clicks.length=0;input.releases.length=0;input.wheel=0;}
/** Called by the native input Node after the bootstrap has dispatched every frame subscriber. */
export function finishDemoInput(phase:'process'|'physics'){
 const input=activeInput;if(!input)return;
 if(phase==='physics'){input.pressed.clear();return;}
 input.actions.clear();input.requests.clear();input.clicks.length=0;input.releases.length=0;input.wheel=0;
}
export function forwardDemoInput(event:any){
 const input=activeInput;if(!input)return;const kind=String(event.get_class());
 if(kind==='InputEventKey'){
  const key=Number(event.physical_keycode||event.keycode),code=key===32?'Space':key>=65&&key<=90?'Key'+String.fromCharCode(key):key>=48&&key<=57?'Digit'+(key-48):({4194312:'Delete',4194319:'ArrowLeft',4194321:'ArrowRight',4194320:'ArrowUp',4194322:'ArrowDown'} as Record<number,string>)[key]??'';
  if(code){if(event.pressed){input.keys.add(code);if(!event.echo){input.pressed.add(code);input.actions.add(code);}}else input.keys.delete(code);}
 }
 if(kind==='InputEventMouseMotion'||kind==='InputEventMouseButton'){
  input.pointer={x:event.position.x,y:event.position.y};if(kind==='InputEventMouseButton'){const button=Number(event.button_index);if(button===1)input.down=event.pressed;if(button===4||button===5){if(event.pressed)input.wheel+=button===4?-1:1;}else{const list=event.pressed?input.clicks:input.releases;if(list.length<32)list.push({...input.pointer,button});}}
 }
}
function transport(){
 if(!G.OS.has_feature('web'))return undefined;
 const window=G.JavaScriptBridge.get_interface('window');
 return {send(value:unknown){window.call('__godotjsProjectEvent',JSON.stringify(value));},listen(callback:(value:any)=>void){const native=G.JavaScriptBridge.create_callback(G.Callable.create((args:any)=>{const raw=args.get(0);if(typeof raw==='string'&&raw.length<=262144)callback(JSON.parse(raw));}));window.call('__godotjsSetProjectCommand',native);return ()=>{if(native)window.call('__godotjsSetProjectCommand',null);};}};
}
export function withDemo(Component:React.ComponentType):React.ComponentType<{controls?:Record<string,number>}>{
 return function PlaygroundDemo({controls:initial={}}){
  const [controls,setControls]=React.useState(initial),state=React.useRef<{input:InputState;stats:Record<string,unknown>;frames:number;elapsed:number;sounds:string[]}>({input:emptyInput(),stats:{},frames:0,elapsed:0,sounds:[]}).current;
  const channel=React.useMemo(transport,[]),players=React.useRef<Record<string,any>>({}),data=resources();
  activeInput=state.input;
  const inputCtor=React.useMemo(()=>{G.ResourceLoader.load('res://.playground/demo-input.ts');return require('res://.godot/GodotJS/.playground/demo-input.js').default;},[]);
  React.useEffect(()=>{const unsubscribe=channel?.listen(command=>{if(command.type==='controls')setControls(command.controls);else if(command.type==='action'&&typeof command.action==='string')state.input.requests.add(command.action);else if(command.type==='import-data')state.input.imported=command.data;else if(command.type==='clear-input')clearDemoInput();});return()=>{unsubscribe?.();if(activeInput===state.input)activeInput=undefined;};},[]);
  useFrame('process',delta=>{state.frames++;state.elapsed+=delta;for(const name of state.sounds.splice(0))players.current[name]?.play();if(state.elapsed>=.1){channel?.send({type:'stats',state:'running',frames:state.frames,fps:Math.round(1/Math.max(delta,.001)),stats:state.stats});state.elapsed=0;}});
  const services:DemoServices={controls,input:state.input,models:data.models,stats:stats=>{state.stats=stats;},sound:name=>{if(state.sounds.length<16)state.sounds.push(name);},exportJSON:(name,value)=>channel?.send({type:'export-data',name,data:value})};
  return <Services.Provider value={services}><EngineNode ctor={inputCtor}/><Component/>{(['jump','coin','land'] as const).map(name=><DemoSound key={name} name={name} reference={players.current}/>)}</Services.Provider>;
 };
}
function DemoSound({name,reference}:{name:string;reference:Record<string,any>}){const stream=useResource('sound-'+name,'AudioStream');return <EngineNode ctor={G.AudioStreamPlayer} native={{stream,volume_db:-16}} ref={node=>{reference[name]=node;}}/>;}
