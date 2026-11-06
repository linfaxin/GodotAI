import * as React from "react";
import { Node2D, ColorRect, useNodeRef, useProcess, color, vec2 } from "@godot-js/react";
import { useDemo, useResource } from "@playground/api";

// The shockwave/warp treatment adapts the official screen-space shader demos.
// Every panel is a real Godot canvas shader with independent instance uniforms.
function Panel({index,title}:{index:number;title:string}) {
  const material=useResource(`shader-${index}`,"ShaderMaterial");
  const ref=useNodeRef<"ColorRect">(),demo=useDemo();
  useProcess(ref,{writes:["shaderParameters"]},commands=>{
    commands.command("setShaderFloat","intensity",demo.controls.intensity);
    commands.command("setShaderFloat","speed",demo.controls.speed);
    commands.command("setShaderFloat","pointer_x",demo.input.pointer.x/960);
    commands.command("setShaderFloat","pointer_y",demo.input.pointer.y/640);
    commands.command("setShaderFloat","effect",demo.controls.effect);
  });
  return <ColorRect ref={ref} name={title} position={vec2(20+index*313,90)} size={vec2(293,500)}
    material={material} color={color(1,1,1)} engineOwned={["shaderParameters"]}/>;
}
export default function ShaderLab(){
  const demo=useDemo(),ref=useNodeRef<"Node2D">(),elapsed=React.useRef(0);
  useProcess(ref,{},(_,dt)=>{elapsed.current+=dt;if(elapsed.current>.3){elapsed.current=0;demo.stats({panels:3,intensity:demo.controls.intensity,effect:demo.controls.effect});}});
  return <Node2D name="ShaderLab" ref={ref}><Panel index={0} title="Plasma"/><Panel index={1} title="Portal"/><Panel index={2} title="Hologram"/></Node2D>;
}
