import {EngineNode} from "@godot-js/react/engine";
import * as G from "godot";
import {Native, withDemo, v2, v3, useNodeRef, useProcess, usePhysicsProcess, useDemo, useResource, useModelParts, vec3, type ModelPart} from "@playground/api";
import * as React from "react";

// Jummit's MIT destruction algorithm: replace the intact mesh with its
// pre-fractured pieces and apply physical impulses. Convex hulls are baked offline.
const centers=[vec3(-3,2,0),vec3(0,2,0),vec3(3,2,0)];
interface Motion {distance:number;settled:Set<string>}
function Shard({part,index,target,motion}:{part:ModelPart;index:number;target:number;motion:Motion}){
  const mesh=useResource(part.id,"Mesh"),shape=useResource(part.shapeId!,"ConvexPolygonShape3D"),material=useResource(target===0?"material-violet":target===1?"material-mint":"material-gold","StandardMaterial3D");
  const ref=useNodeRef<"RigidBody3D">(),demo=useDemo(),launched=React.useRef(false),center=centers[target];
  usePhysicsProcess(ref, node=>{
    if(!launched.current){launched.current=true;const p=part.position,power=demo.controls.power,length=Math.hypot(p.x,p.y+.9,p.z)||1;node.apply_central_impulse(vec3(p.x/length*power,(p.y+.9)/length*power,p.z/length*power));(node.angular_velocity = vec3(index*.3-1,2,index*.2));}
    const p=node.position;motion.distance=Math.max(motion.distance,Math.hypot(p.x-center.x,p.z-center.z));
    const id=`${target}-${part.id}`;if(node.sleeping)motion.settled.add(id);else motion.settled.delete(id);
  });
  return <Native ctor={G.RigidBody3D} ref={ref} initial={{position:vec3(center.x+part.position.x,center.y+part.position.y,part.position.z),rotation:part.rotation}} native={{name: `Shard_${target}_${index}`, mass: .65, gravity_scale: demo.controls.gravity, linear_damp: .15, angular_damp: .2}}>
    <EngineNode ctor={G.MeshInstance3D} native={{mesh: mesh, material_override: material, scale: v3(part.scale)}} /><EngineNode ctor={G.CollisionShape3D} native={{shape: shape, scale: v3(part.scale)}} />
  </Native>;
}
function DestructionLab(){
  const demo=useDemo(),parts=useModelParts("shards"),camera=useNodeRef<"Camera3D">(),box=useResource("box-mesh","Mesh"),floor=useResource("floor-mesh","Mesh"),ground=useResource("floor-shape","BoxShape3D"),material=useResource("material-dark","StandardMaterial3D"),sky=useResource("sky","Environment");
  const [broken,setBroken]=React.useState<boolean[]>([false,false,false]),[epoch,setEpoch]=React.useState(0),motion=React.useRef<Motion>({distance:0,settled:new Set()});
  const colors=[useResource("material-violet","StandardMaterial3D"),useResource("material-mint","StandardMaterial3D"),useResource("material-gold","StandardMaterial3D")];
  useProcess(camera, node=>{
    if(demo.input.requests.has("explode")||demo.input.actions.has("Space")){setBroken([true,true,true]);demo.sound("land");}
    if(demo.input.requests.has("reset")||demo.input.actions.has("KeyR")){setBroken([false,false,false]);setEpoch(n=>n+1);motion.current={distance:0,settled:new Set()};}
    for(const click of demo.input.clicks.filter(c=>c.button===1)){
      const point={x:click.x,y:click.y},o=node.project_ray_origin(v2(point)),d=node.project_ray_normal(v2(point)),t=-o.z/d.z;
      const x=o.x+d.x*t,y=o.y+d.y*t;const target=centers.findIndex(p=>Math.abs(x-p.x)<1.3&&Math.abs(y-p.y)<1.4);if(target>=0){setBroken(old=>old.map((value,i)=>value||i===target));demo.sound("land");}
    }
    demo.stats({kind:"destruction",broken:broken.filter(Boolean).length,bodies:broken.filter(Boolean).length*parts.length,spread:+motion.current.distance.toFixed(2),settled:motion.current.settled.size,nativeBodies:Number(node.get_parent().find_children("Shard_*","RigidBody3D",true,false).size()),nativeNodes:Number(node.get_parent().get_child_count())});
  });
  return <EngineNode ctor={G.Node3D} native={{name: "DestructionLab"}}><EngineNode ctor={G.WorldEnvironment} native={{environment: sky}} /><EngineNode ctor={G.DirectionalLight3D} native={{rotation: vec3(-1,-.5,0), light_energy: 1.3, shadow_enabled: true}} />
    <EngineNode ctor={G.StaticBody3D} native={{position: vec3(0,-.25,0)}}><EngineNode ctor={G.CollisionShape3D} native={{shape: ground}} /><EngineNode ctor={G.MeshInstance3D} native={{mesh: floor, material_override: material}} /></EngineNode>
    {centers.map((center,target)=>broken[target]?<EngineNode ctor={G.Node3D} key={`${epoch}-${target}`}>{parts.map((part,index)=><Shard key={part.id} part={part} index={index} target={target} motion={motion.current}/>)}</EngineNode>:<EngineNode ctor={G.MeshInstance3D} key={`intact-${target}`} native={{mesh: box, material_override: colors[target], position: v3(center), scale: vec3(2,2,2)}} />)}
    <EngineNode ctor={G.Camera3D} ref={camera} native={{name: "Camera", current: true, fov: 50, position: vec3(10,8,14), rotation: vec3(-.43,.62,0)}} />
  </EngineNode>;
}
export default withDemo(DestructionLab);
