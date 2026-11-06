import * as React from "react";
import { Node3D, MeshInstance3D, RigidBody3D, StaticBody3D, CollisionShape3D, Camera3D, DirectionalLight3D, WorldEnvironment, useNodeRef, useProcess, usePhysicsProcess } from "@godot-js/react";
import { useDemo, useResource, useModelParts, vec3, type ModelPart } from "@playground/api";

// Jummit's MIT destruction algorithm: replace the intact mesh with its
// pre-fractured pieces and apply physical impulses. Convex hulls are baked offline.
const centers=[vec3(-3,2,0),vec3(0,2,0),vec3(3,2,0)];
interface Motion {distance:number;settled:Set<string>}
function Shard({part,index,target,motion}:{part:ModelPart;index:number;target:number;motion:Motion}){
  const mesh=useResource(part.id,"Mesh"),shape=useResource(part.shapeId!,"ConvexPolygonShape3D"),material=useResource(target===0?"material-violet":target===1?"material-mint":"material-gold","StandardMaterial3D");
  const ref=useNodeRef<"RigidBody3D">(),demo=useDemo(),launched=React.useRef(false),center=centers[target];
  usePhysicsProcess(ref,{writes:["position","rotation","linearVelocity","angularVelocity","sleeping"]},commands=>{
    if(!launched.current){launched.current=true;const p=part.position,power=demo.controls.power,length=Math.hypot(p.x,p.y+.9,p.z)||1;commands.command("applyCentralImpulse",vec3(p.x/length*power,(p.y+.9)/length*power,p.z/length*power));commands.command("setAngularVelocity",vec3(index*.3-1,2,index*.2));}
    const p=commands.read<{x:number;y:number;z:number}>("position");motion.distance=Math.max(motion.distance,Math.hypot(p.x-center.x,p.z-center.z));
    const id=`${target}-${part.id}`;if(commands.read<boolean>("sleeping"))motion.settled.add(id);else motion.settled.delete(id);
  });
  return <RigidBody3D ref={ref} name={`Shard_${target}_${index}`} mass={.65} gravityScale={demo.controls.gravity} linearDamp={.15} angularDamp={.2}
    initial={{position:vec3(center.x+part.position.x,center.y+part.position.y,part.position.z),rotation:part.rotation}} engineOwned={["position","rotation","linearVelocity","angularVelocity","sleeping"]}>
    <MeshInstance3D mesh={mesh} materialOverride={material} scale={part.scale}/><CollisionShape3D shape={shape} scale={part.scale}/>
  </RigidBody3D>;
}
export default function DestructionLab(){
  const demo=useDemo(),parts=useModelParts("shards"),camera=useNodeRef<"Camera3D">(),box=useResource("box-mesh","Mesh"),floor=useResource("floor-mesh","Mesh"),ground=useResource("floor-shape","BoxShape3D"),material=useResource("material-dark","StandardMaterial3D"),sky=useResource("sky","Environment");
  const [broken,setBroken]=React.useState<boolean[]>([false,false,false]),[epoch,setEpoch]=React.useState(0),motion=React.useRef<Motion>({distance:0,settled:new Set()});
  const colors=[useResource("material-violet","StandardMaterial3D"),useResource("material-mint","StandardMaterial3D"),useResource("material-gold","StandardMaterial3D")];
  useProcess(camera,{},commands=>{
    if(demo.input.requests.has("explode")||demo.input.actions.has("Space")){setBroken([true,true,true]);demo.sound("land");}
    if(demo.input.requests.has("reset")||demo.input.actions.has("KeyR")){setBroken([false,false,false]);setEpoch(n=>n+1);motion.current={distance:0,settled:new Set()};}
    for(const click of demo.input.clicks.filter(c=>c.button===1)){
      const point={x:click.x,y:click.y},o=commands.command<{x:number;y:number;z:number}>("projectRayOrigin",point),d=commands.command<{x:number;y:number;z:number}>("projectRayNormal",point),t=-o.z/d.z;
      const x=o.x+d.x*t,y=o.y+d.y*t;const target=centers.findIndex(p=>Math.abs(x-p.x)<1.3&&Math.abs(y-p.y)<1.4);if(target>=0){setBroken(old=>old.map((value,i)=>value||i===target));demo.sound("land");}
    }
    demo.stats({kind:"destruction",broken:broken.filter(Boolean).length,bodies:broken.filter(Boolean).length*parts.length,spread:+motion.current.distance.toFixed(2),settled:motion.current.settled.size});
  });
  return <Node3D name="DestructionLab"><WorldEnvironment environment={sky}/><DirectionalLight3D rotation={vec3(-1,-.5,0)} lightEnergy={1.3} shadowEnabled/>
    <StaticBody3D position={vec3(0,-.25,0)}><CollisionShape3D shape={ground}/><MeshInstance3D mesh={floor} materialOverride={material}/></StaticBody3D>
    {centers.map((center,target)=>broken[target]?<Node3D key={`${epoch}-${target}`}>{parts.map((part,index)=><Shard key={part.id} part={part} index={index} target={target} motion={motion.current}/>)}</Node3D>:<MeshInstance3D key={`intact-${target}`} mesh={box} materialOverride={colors[target]} position={center} scale={vec3(2,2,2)}/>)}
    <Camera3D name="Camera" ref={camera} current fov={50} position={vec3(10,8,14)} rotation={vec3(-.43,.62,0)}/>
  </Node3D>;
}
