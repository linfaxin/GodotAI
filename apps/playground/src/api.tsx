import * as React from "react";
import { AudioStreamPlayer, asset, useAsset, useNodeRef, useProcess } from "@godot-js/react";

export interface PointerAction {x:number;y:number;button:number}
export interface InputState {keys:Set<string>;pressed:Set<string>;actions:Set<string>;requests:Set<string>;pointer:{x:number;y:number};down:boolean;clicks:PointerAction[];releases:PointerAction[];wheel:number;imported?:unknown}
export interface ModelPart {id:string;name:string;position:Readonly<{x:number;y:number;z:number}>;rotation:Readonly<{x:number;y:number;z:number}>;scale:Readonly<{x:number;y:number;z:number}>;shapeId?:string}
export interface DemoServices {
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
