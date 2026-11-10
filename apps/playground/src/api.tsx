import * as React from "react";
import * as Hosts from "@godot-js/react";
import { AudioStreamPlayer, asset, useAsset, useNodeRef, useProcess } from "@godot-js/react";

export interface PointerAction {x:number;y:number;button:number}
export interface InputState {keys:Set<string>;pressed:Set<string>;actions:Set<string>;requests:Set<string>;pointer:{x:number;y:number};down:boolean;clicks:PointerAction[];releases:PointerAction[];wheel:number;imported?:unknown}
export interface ModelPart {id:string;name:string;position:Readonly<{x:number;y:number;z:number}>;rotation:Readonly<{x:number;y:number;z:number}>;scale:Readonly<{x:number;y:number;z:number}>;shapeId?:string}
export interface DemoServices {
  scenes?:Readonly<Record<string,import("./project-resources").SceneNodeSpec>>;
  controls:Readonly<Record<string,number>>;
  input:InputState;
  stats:(stats:Record<string,number|string|boolean>)=>void;
  sound:(name:"jump"|"coin"|"land")=>void;
  models:Readonly<Record<string,readonly ModelPart[]>>;
  exportJSON:(name:string,data:unknown)=>void;
}
export const Services=React.createContext<DemoServices|null>(null);
export const vec3=(x=0,y=0,z=0)=>({x,y,z});
export function useDemo():DemoServices {const value=React.useContext(Services);if(!value)throw new Error("Missing playground services");return value;}
export function useResource<T extends string>(id:string,type:T){return useAsset(asset(id,type));}
export function useModelParts(id:string):readonly ModelPart[]{const parts=useDemo().models[id];if(!parts?.length)throw Error(`Missing model parts: ${id}`);return parts;}
export function Sound({name,events}:{name:"jump"|"coin"|"land";events:string[]}){
  const stream=useResource(`sound-${name}`,"AudioStream"),ref=useNodeRef<"AudioStreamPlayer">();
  useProcess(ref,{writes:["playback"]},commands=>{const index=events.indexOf(name);if(index>=0){events.splice(index,1);commands.command("play",0);}});
  return <AudioStreamPlayer ref={ref} name={`Sound_${name}`} stream={stream} volumeDb={-16} engineOwned={["playback"]}/>;
}

/** Renders a validated project scene as React hosts, or as a bounded native instance. */
export function ProjectScene({name,overrides={},native=false}:{name:string;native?:boolean;overrides?:Readonly<Record<string,Readonly<Record<string,unknown>>>>}){
 const scenes=useDemo().scenes;
 if(native){if(Object.keys(overrides).length)throw Error('Native scene overrides use the scene command facade');return React.createElement(NativeProjectScene,{name});}
 const spec=scenes?.[name];if(!spec)throw Error(`Unknown project scene: ${name}`);
 function render(node:import("./project-resources").SceneNodeSpec,path:string):React.ReactNode{
  const props={...node.props,...overrides[path]};
  const Host=(Hosts as unknown as Record<string,React.ElementType>)[node.type];
  if(!Host)throw Error(`Unsupported project scene host: ${node.type}`);
  return React.createElement(Host,{...props,key:path},...(node.children??[]).map((child,index)=>render(child,path+'/'+(child.props?.name??index))));
 }
 return React.createElement(React.Fragment,{key:name},render(spec,String(spec.props?.name??'.')));
}

function NativeProjectScene({name}:{name:string}){const scene=useResource(name,"PackedScene");return React.createElement(Hosts.NativeScene,{scene});}
