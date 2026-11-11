import {EngineNode} from "@godot-js/react/engine";
import * as G from "godot";
import {Native, withDemo, v2, useNodeRef, useProcess, color, vec2, useDemo, useResource} from "@playground/api";
import * as React from "react";

function Lamp({index}:{index:number}){
  const texture=useResource("light","Texture2D"),demo=useDemo(),ref=useNodeRef<"PointLight2D">(),t=React.useRef(index*2);
  useProcess(ref, (node,dt)=>{
    t.current+=dt*demo.controls.speed;
    (node.position = v2(index===0?demo.input.pointer:vec2(480+Math.sin(t.current)*280,330+Math.cos(t.current*.7)*190)));
  });
  return <EngineNode ctor={G.PointLight2D} ref={ref} native={{name: `Lamp${index}`, texture: texture, color: index===0?color(.2,.9,1):index===1?color(1,.25,.6):color(1,.68,.3), energy: demo.controls.energy, texture_scale: .68, shadow_enabled: demo.controls.shadows>0}} />;
}
function Pillar({index}:{index:number}){
  const shape=useResource("occluder","OccluderPolygon2D"),demo=useDemo(),ref=useNodeRef<"Node2D">(),base=vec2(260+(index%3)*220,235+Math.floor(index/3)*230);
  const position=React.useRef(base);
  useProcess(ref, node=>{
    const p=demo.input.pointer;
    if(demo.input.down&&Math.hypot(p.x-position.current.x,p.y-position.current.y)<65)position.current={...p};
    (node.position = v2(position.current));
  });
  return <Native ctor={G.Node2D} ref={ref} initial={{position:base}} native={{name: `Pillar${index}`}}>
    <EngineNode ctor={G.ColorRect} native={{position: vec2(-30,-30), size: vec2(60,60), color: color(.45,.55,.7)}} /><EngineNode ctor={G.LightOccluder2D} native={{occluder: shape}} />
  </Native>;
}
function LightRoom(){
  const floor=useResource("floor","Texture2D"),demo=useDemo(),ref=useNodeRef<"Node2D">();
  useProcess(ref, ()=>demo.stats({lights:3,occluders:6,shadows:demo.controls.shadows>0}));
  return <EngineNode ctor={G.Node2D} ref={ref} native={{name: "LightRoom"}}>
    <EngineNode ctor={G.Sprite2D} native={{name: "Floor", texture: floor, position: vec2(480,320), scale: vec2(7.5,5), modulate: color(.48,.54,.65)}} />
    <EngineNode ctor={G.CanvasModulate} native={{color: color(.09,.12,.2)}} />
    {[0,1,2,3,4,5].map(index=><Pillar key={index} index={index}/>)}
    {[0,1,2].map(index=><Lamp key={index} index={index}/>)}
  </EngineNode>;
}
export default withDemo(LightRoom);
