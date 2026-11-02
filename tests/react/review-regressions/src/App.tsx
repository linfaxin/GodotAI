import * as React from "react";
import { Node, Node2D, Label, CanvasLayer, useNodeRef, useProcess, usePhysicsProcess, useInput, useNativeReady, type NodeReadHandle } from "@godot-js/react";

let changeActor:(version:number|null)=>void;
let changeInitial:(text:string)=>void;
let blockScene:()=>void;
let resolveScene:()=>void;
const state = {
  parentRenders:0, process:0, physics:0, input:0,
  actor:null as NodeReadHandle|null,
  ready:[] as string[], cleanup:[] as {id:string;valid:boolean}[],
  visible:null as NodeReadHandle|null, hidden:null as NodeReadHandle|null,
  layer:null as NodeReadHandle|null, hud:null as NodeReadHandle|null, loading:null as NodeReadHandle|null,
};
function Actor({nodeRef}:{nodeRef:React.RefObject<NodeReadHandle<"Node2D">|null>}) {
  const [version,set] = React.useState<number|null>(0);changeActor=set;
  return version===null ? null : <Node2D key={version} name="Actor" ref={nodeRef} engineOwned={["position"]} />;
}
function Scene() {
  const [blocked,set] = React.useState(false);
  const task = React.useMemo(() => {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};},[]);
  resolveScene=task.resolve;
  blockScene=()=>set(true);
  if(blocked)React.use(task.promise);
  return <Node name="Group">
    <Label name="Visible" text="old scene" ref={node=>{if(node)state.visible=node;}} />
    <Label name="Hidden" initial={{visible:false}} ref={node=>{if(node)state.hidden=node;}} />
    <Node name="Nested"><CanvasLayer name="Layer" ref={node=>{if(node)state.layer=node;}}>
      <Label name="HUD" text="hud" ref={node=>{if(node)state.hud=node;}} />
    </CanvasLayer></Node>
  </Node>;
}
function Initial() {
  const [text,set] = React.useState("before");changeInitial=set;
  return <Label name="Initial" initial={{text}} />;
}
export default function App() {
  state.parentRenders++;
  const actor=useNodeRef<"Node2D">();
  useProcess(actor,{writes:["position"]},commands=>{state.process++;commands.setPosition({x:state.process,y:0});});
  usePhysicsProcess(actor,{},()=>{state.physics++;});
  useInput(actor,()=>{state.input++;});
  useNativeReady(actor,node=>{state.actor=node;state.ready.push(node.id);return()=>{state.cleanup.push({id:node.id,valid:node.isValid()});};});
  return <Node name="App">
    <Actor nodeRef={actor} /><Initial />
    <React.Suspense fallback={<Label name="Loading" ref={node=>{state.loading=node;}} text="loading" />}><Scene /></React.Suspense>
  </Node>;
}
export const review={state,changeActor:(version:number|null)=>changeActor(version),changeInitial:(text:string)=>changeInitial(text),blockScene:()=>blockScene(),resolveScene:()=>resolveScene()};
