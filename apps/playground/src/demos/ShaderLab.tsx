import {EngineNode} from "@godot-js/react/engine";
import * as G from "godot";
import {withDemo, useNodeRef, useProcess, color, vec2, useDemo, useResource} from "@playground/api";
import * as React from "react";

// The shockwave/warp treatment adapts the official screen-space shader demos.
// Every panel is a real Godot canvas shader with independent instance uniforms.
function Panel({index,title}:{index:number;title:string}) {
  const material=useResource(`shader-${index}`,"ShaderMaterial");
  const ref=useNodeRef<"ColorRect">(),demo=useDemo();
  useProcess(ref, node=>{
    node.set_instance_shader_parameter("intensity", demo.controls.intensity);
    node.set_instance_shader_parameter("speed", demo.controls.speed);
    node.set_instance_shader_parameter("pointer_x", demo.input.pointer.x/960);
    node.set_instance_shader_parameter("pointer_y", demo.input.pointer.y/640);
    node.set_instance_shader_parameter("effect", demo.controls.effect);
  });
  return <EngineNode ctor={G.ColorRect} ref={ref} native={{name: title, position: vec2(20+index*313,90), size: vec2(293,500), material: material, color: color(1,1,1)}} />;
}
function ShaderLab(){
  const demo=useDemo(),ref=useNodeRef<"Node2D">(),elapsed=React.useRef(0);
  useProcess(ref, (_,dt)=>{elapsed.current+=dt;if(elapsed.current>.3){elapsed.current=0;demo.stats({panels:3,intensity:demo.controls.intensity,effect:demo.controls.effect,shaderIntensity:Number(_.get_node("Plasma").get_instance_shader_parameter("intensity"))});}});
  return <EngineNode ctor={G.Node2D} ref={ref} native={{name: "ShaderLab"}}><Panel index={0} title="Plasma"/><Panel index={1} title="Portal"/><Panel index={2} title="Hologram"/></EngineNode>;
}
export default withDemo(ShaderLab);
