import type {AssetRef} from "@godot-js/react";
export interface PointerAction {x:number;y:number;button:number}
export interface InputState {keys:Set<string>;pressed:Set<string>;actions:Set<string>;requests:Set<string>;pointer:{x:number;y:number};down:boolean;clicks:PointerAction[];releases:PointerAction[];wheel:number;imported?:unknown}
export interface ModelPart {id:string;name:string;position:Readonly<{x:number;y:number;z:number}>;rotation:Readonly<{x:number;y:number;z:number}>;scale:Readonly<{x:number;y:number;z:number}>;shapeId?:string}
export interface DemoServices {controls:Readonly<Record<string,number>>;input:InputState;stats:(stats:Record<string,number|string|boolean>)=>void;sound:(name:"jump"|"coin"|"land")=>void;models:Readonly<Record<string,readonly ModelPart[]>>;exportJSON:(name:string,data:unknown)=>void}
export function useDemo():DemoServices;
export function vec3(x?:number,y?:number,z?:number):{x:number;y:number;z:number};
export function useResource<T extends string>(id:string,type:T):AssetRef<T>;
export function useModelParts(id:string):readonly ModelPart[];
