import type * as React from 'react';
import type {NativeConstructor} from '@godot-js/react/engine';
export interface PointerAction {x:number;y:number;button:number}
export interface InputState {keys:Set<string>;pressed:Set<string>;actions:Set<string>;requests:Set<string>;pointer:{x:number;y:number};down:boolean;clicks:PointerAction[];releases:PointerAction[];wheel:number;imported?:unknown}
export interface ModelPart {id:string;name:string;position:{x:number;y:number;z:number};rotation:{x:number;y:number;z:number};scale:{x:number;y:number;z:number};shapeId?:string}
export interface DemoServices {controls:Readonly<Record<string,number>>;input:InputState;stats:(stats:Record<string,number|string|boolean>)=>void;sound:(name:'jump'|'coin'|'land')=>void;models:Readonly<Record<string,readonly ModelPart[]>>;exportJSON:(name:string,data:unknown)=>void}
export function useDemo():DemoServices;
export function useResource<T extends string>(id:string,type:T):any;
export function useModelParts(id:string):readonly ModelPart[];
export function vec2(x?:number,y?:number):any;
export function vec3(x?:number,y?:number,z?:number):any;
export function color(r:number,g:number,b:number,a?:number):any;
export function v2(value:{x:number;y:number}):any;
export function v3(value:{x:number;y:number;z:number}):any;
export function useNodeRef<K extends string=string>():React.RefObject<any>;
export function useProcess(ref:React.RefObject<any>,callback:(node:any,delta:number)=>void):void;
export function usePhysicsProcess(ref:React.RefObject<any>,callback:(node:any,delta:number)=>void):void;
export function Native(props:{ctor:NativeConstructor;initial?:Record<string,unknown>;native?:Record<string,unknown>;ref?:React.Ref<any>;children?:React.ReactNode}):React.ReactElement;
export function withDemo(component:React.ComponentType):React.ComponentType<{controls?:Record<string,number>}>;
