import {EngineNode} from "@godot-js/react/engine";
import * as G from "godot";
import {Native, withDemo, v3, useNodeRef, useProcess, usePhysicsProcess, useDemo, useResource, useModelParts, vec3, type ModelPart} from "@playground/api";
import * as React from "react";

type V3={x:number;y:number;z:number};
interface RaceState {position:V3;heading:number;speed:number;steer:number;grounded:boolean;lap:number;checkpoint:number;time:number;best:number;reset:boolean;distance:number}
// Kenney's MIT arcade controller uses a hidden physics sphere and a separate
// animated car model. Forces adapt that architecture to the current GodotPhysics build.
const checkpoints=[vec3(10,0,-10),vec3(10,0,10),vec3(-10,0,10),vec3(-10,0,-10)];
function CarPart({part,state}:{part:ModelPart;state:RaceState}){
  const mesh=useResource(part.id,"Mesh"),ref=useNodeRef<"Node3D">(),phase=React.useRef(0);
  useProcess(ref, (node,dt)=>{
    phase.current=(phase.current+state.speed*dt*2)%(Math.PI*2);
    const wheel=part.name.startsWith("wheel"),front=part.name.includes("front");
    (node.rotation = vec3(part.rotation.x+(wheel?phase.current:0),part.rotation.y+(front?state.steer*.35:0),part.rotation.z+(part.name==="body"?-state.steer*Math.min(state.speed/30,.12):0)));
  });
  return <Native ctor={G.Node3D} ref={ref} initial={{position:part.position,rotation:part.rotation}} native={{name: part.name.replace(/-/g,"_")}}><EngineNode ctor={G.MeshInstance3D} native={{mesh: mesh, scale: v3(part.scale)}} /></Native>;
}
function CarModel({state}:{state:RaceState}){
  const parts=useModelParts("race-car"),ref=useNodeRef<"Node3D">();
  useProcess(ref, node=>{(node.position = vec3(state.position.x,state.position.y-.65,state.position.z));(node.rotation = vec3(0,state.heading,0));});
  return <EngineNode ctor={G.Node3D} ref={ref} native={{name: "CarModel"}}>{parts.map(part=><CarPart key={part.id} part={part} state={state}/>)}</EngineNode>;
}
function GroundProbe({state}:{state:RaceState}){
  const ref=useNodeRef<"RayCast3D">();
  usePhysicsProcess(ref, node=>{(node.position = v3(state.position));node.force_raycast_update();state.grounded=node.is_colliding();});
  return <EngineNode ctor={G.RayCast3D} ref={ref} native={{name: "GroundProbe", target_position: vec3(0,-1.1,0), collision_mask: 1}} />;
}
function Driver({state}:{state:RaceState}){
  const demo=useDemo(),ref=useNodeRef<"RigidBody3D">(),sphere=useResource("sphere-shape","SphereShape3D");
  usePhysicsProcess(ref, (node,dt)=>{
    const keys=demo.input.keys,throttle=Number(keys.has("KeyW")||keys.has("ArrowUp"))-Number(keys.has("KeyS")||keys.has("ArrowDown"));
    state.steer=Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft"));
    const p=node.position,v=node.linear_velocity;state.speed=Math.hypot(v.x,v.z);
    const moving=Math.min(1,Math.max(.15,state.speed/4));state.heading=(state.heading+state.steer*demo.controls.steering*moving*dt*(throttle<0?-1:1))%(Math.PI*2);
    if(state.grounded&&throttle)node.apply_central_force(vec3(Math.sin(state.heading)*throttle*demo.controls.acceleration,0,Math.cos(state.heading)*throttle*demo.controls.acceleration));
    if(state.speed>demo.controls.speed)(node.linear_velocity = vec3(v.x/state.speed*demo.controls.speed,v.y,v.z/state.speed*demo.controls.speed));
    if(keys.has("Space"))(node.linear_velocity = vec3(v.x*.9,v.y,v.z*.9));
    if(state.reset||demo.input.pressed.has("KeyR")||p.y < -5){(node.position = vec3(0,.9,-10));(node.linear_velocity = vec3());(node.angular_velocity = vec3());state.heading=Math.PI/2;state.reset=false;}
    state.distance+=Math.hypot(p.x-state.position.x,p.z-state.position.z);state.position=vec3(p.x,p.y,p.z);state.time+=dt;
    const next=checkpoints[state.checkpoint];if(Math.hypot(p.x-next.x,p.z-next.z)<3){state.checkpoint=(state.checkpoint+1)%4;if(state.checkpoint===0){state.lap++;state.best=state.best?Math.min(state.best,state.time):state.time;state.time=0;demo.sound("coin");}}
    demo.stats({kind:"racing",speed:+(state.speed*3.6).toFixed(1),distance:+state.distance.toFixed(1),grounded:state.grounded,laps:state.lap,checkpoint:state.checkpoint,time:+state.time.toFixed(1),best:+state.best.toFixed(1)});
  });
  return <Native ctor={G.RigidBody3D} ref={ref} initial={{position:vec3(0,.9,-10)}} native={{name: "VehicleSphere", collision_layer: 2, collision_mask: 1, linear_damp: .3, angular_damp: 1}}><EngineNode ctor={G.CollisionShape3D} native={{shape: sphere}} /></Native>;
}
function TrackTile({x,z,corner,rotation=0}:{x:number;z:number;corner:boolean;rotation?:number}){
  const mesh=useResource(corner?"race-track-corner":x===0&&z===-10?"race-track-finish":"race-track-straight","Mesh");
  return <EngineNode ctor={G.MeshInstance3D} native={{mesh: mesh, position: vec3(x,0,z), rotation: vec3(0,rotation*Math.PI/2,0)}} />;
}
function Barrier({position,size}:{position:V3;size:V3}){
  const box=useResource("box-mesh","Mesh"),shape=useResource("unit-shape","BoxShape3D"),material=useResource("material-violet","StandardMaterial3D");
  return <EngineNode ctor={G.StaticBody3D} native={{position: v3(position)}}><EngineNode ctor={G.CollisionShape3D} native={{shape: shape, scale: v3(size)}} /><EngineNode ctor={G.MeshInstance3D} native={{mesh: box, material_override: material, scale: v3(size)}} /></EngineNode>;
}
function Racing(){
  const demo=useDemo(),camera=useNodeRef<"Camera3D">(),sky=useResource("sky","Environment"),floor=useResource("floor-mesh","Mesh"),shape=useResource("floor-shape","BoxShape3D"),grass=useResource("material-mint","StandardMaterial3D"),forest=useResource("race-decoration-forest","Mesh");
  const state=React.useRef<RaceState>({position:vec3(0,.9,-10),heading:Math.PI/2,speed:0,steer:0,grounded:false,lap:0,checkpoint:0,time:0,best:0,reset:false,distance:0}).current;
  const cameraPosition=React.useRef(vec3(9,14,6));
  useProcess(camera, (node,dt)=>{if(demo.input.requests.has("reset"))state.reset=true;const p=cameraPosition.current,t=state.position,a=Math.min(1,dt*4);p.x+=(t.x+9-p.x)*a;p.y+=(t.y+13-p.y)*a;p.z+=(t.z+16-p.z)*a;(node.position = v3(p));});
  return <EngineNode ctor={G.Node3D} native={{name: "Racing"}}><EngineNode ctor={G.WorldEnvironment} native={{environment: sky}} /><EngineNode ctor={G.DirectionalLight3D} native={{rotation: vec3(-1,-.6,0), light_energy: 1.1, shadow_enabled: true}} />
    <EngineNode ctor={G.StaticBody3D} native={{position: vec3(0,-.25,0)}}><EngineNode ctor={G.CollisionShape3D} native={{shape: shape}} /><EngineNode ctor={G.MeshInstance3D} native={{mesh: floor, material_override: grass}} /></EngineNode>
    {[[-10,-10,0],[0,-10,0],[10,-10,1],[10,0,1],[10,10,2],[0,10,0],[-10,10,3],[-10,0,1]].map(([x,z,r],i)=><TrackTile key={i} x={x} z={z} corner={x!==0&&z!==0} rotation={r}/>)}
    <EngineNode ctor={G.MeshInstance3D} native={{mesh: forest}} />
    {[-1,1].flatMap(sign=>[<Barrier key={`outer-x${sign}`} position={vec3(sign*15,.6,0)} size={vec3(.4,1.2,30)}/>,<Barrier key={`outer-z${sign}`} position={vec3(0,.6,sign*15)} size={vec3(30,1.2,.4)}/>,<Barrier key={`inner-x${sign}`} position={vec3(sign*5,.6,0)} size={vec3(.4,1.2,10)}/>,<Barrier key={`inner-z${sign}`} position={vec3(0,.6,sign*5)} size={vec3(10,1.2,.4)}/>])}
    <GroundProbe state={state}/><Driver state={state}/><CarModel state={state}/>
    <Native ctor={G.Camera3D} ref={camera} initial={{position:vec3(9,14,6),rotation:vec3(-.616,.512,0)}} native={{current: true, fov: 55}} />
  </EngineNode>;
}
export default withDemo(Racing);
