import * as React from "react";
import { Node2D, Sprite2D, ColorRect, CanvasModulate, PointLight2D, LightOccluder2D, useNodeRef, useProcess, color, vec2 } from "@godot-js/react";
import { useDemo, useResource } from "@playground/api";

function Lamp({index}:{index:number}){
  const texture=useResource("light","Texture2D"),demo=useDemo(),ref=useNodeRef<"PointLight2D">(),t=React.useRef(index*2);
  useProcess(ref,{writes:["position"]},(commands,dt)=>{
    t.current+=dt*demo.controls.speed;
    commands.setPosition(index===0?demo.input.pointer:vec2(480+Math.sin(t.current)*280,330+Math.cos(t.current*.7)*190));
  });
  return <PointLight2D ref={ref} name={`Lamp${index}`} texture={texture} color={index===0?color(.2,.9,1):index===1?color(1,.25,.6):color(1,.68,.3)}
    energy={demo.controls.energy} textureScale={.68} shadowEnabled={demo.controls.shadows>0} engineOwned={["position"]}/>;
}
function Pillar({index}:{index:number}){
  const shape=useResource("occluder","OccluderPolygon2D"),demo=useDemo(),ref=useNodeRef<"Node2D">(),base=vec2(260+(index%3)*220,235+Math.floor(index/3)*230);
  const position=React.useRef(base);
  useProcess(ref,{writes:["position"]},commands=>{
    const p=demo.input.pointer;
    if(demo.input.down&&Math.hypot(p.x-position.current.x,p.y-position.current.y)<65)position.current={...p};
    commands.setPosition(position.current);
  });
  return <Node2D ref={ref} name={`Pillar${index}`} initial={{position:base}} engineOwned={["position"]}>
    <ColorRect position={vec2(-30,-30)} size={vec2(60,60)} color={color(.45,.55,.7)}/><LightOccluder2D occluder={shape}/>
  </Node2D>;
}
export default function LightRoom(){
  const floor=useResource("floor","Texture2D"),demo=useDemo(),ref=useNodeRef<"Node2D">();
  useProcess(ref,{},()=>demo.stats({lights:3,occluders:6,shadows:demo.controls.shadows>0}));
  return <Node2D name="LightRoom" ref={ref}>
    <Sprite2D name="Floor" texture={floor} position={vec2(480,320)} scale={vec2(7.5,5)} modulate={color(.48,.54,.65)}/>
    <CanvasModulate color={color(.09,.12,.2)}/>
    {[0,1,2,3,4,5].map(index=><Pillar key={index} index={index}/>)}
    {[0,1,2].map(index=><Lamp key={index} index={index}/>)}
  </Node2D>;
}
