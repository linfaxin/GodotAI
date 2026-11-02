import * as React from "react";
import { Node2D, defineNativeInterface, useNativeInterface, useNodeRef, type NativeInterfaceSchema } from "@godot-js/react";
import schema from "./interface.json";

const endpointInterface=defineNativeInterface("endpoint",schema as NativeInterfaceSchema);
export const events:Array<{method:string;args:readonly unknown[];handlerRound:number}>=[];
export const frames={process:0,physics:0,input:0};
export const lifecycle={renders:0,layoutMounts:0,layoutCleanups:0};
export let endpoint:ReturnType<typeof useNativeInterface>|undefined;
export let wrongEndpoint:ReturnType<typeof useNativeInterface>|undefined;
export function WrongEndpoint() {
  const ref=useNodeRef<"Node2D">(),sender=useNativeInterface(ref,endpointInterface,{});
  React.useLayoutEffect(()=>{wrongEndpoint=sender;return()=>{wrongEndpoint=undefined;};},[sender]);
  return <Node2D ref={ref} name="WrongEndpoint" nativeInterface={endpointInterface}/>;
}
export default function App({round=0,wrong=false}:{round?:number;wrong?:boolean}) {
  lifecycle.renders++;
  const ref=useNodeRef<"Node2D">();
  const handlers=Object.fromEntries(["_ready","_process","_physics_process","_input","rpcPing","rpcReply","rpcAuthority","rpcLocal","rpcUnreliable","rpcMissingChannel"].map(method=>[method,(...args:readonly unknown[])=>{
    if(method==="_process")frames.process++;if(method==="_physics_process")frames.physics++;if(method==="_input")frames.input++;
    if(method!=="_process"&&method!=="_physics_process")events.push({method,args,handlerRound:round});
  }]));
  const sender=useNativeInterface(ref,endpointInterface,handlers);
  React.useLayoutEffect(()=>{lifecycle.layoutMounts++;return()=>{lifecycle.layoutCleanups++;};},[]);
  React.useLayoutEffect(()=>{endpoint=sender;return()=>{endpoint=undefined;};},[sender]);
  return <><Node2D ref={ref} name="Endpoint" nativeInterface={endpointInterface}/>{wrong?<WrongEndpoint/>:null}</>;
}
