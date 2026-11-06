import * as React from "react";
import { Node3D, MeshInstance3D, RigidBody3D, StaticBody3D, CollisionShape3D, RayCast3D, Camera3D, DirectionalLight3D, WorldEnvironment, useNodeRef, useProcess, usePhysicsProcess } from "@godot-js/react";
import { useDemo, useResource, useModelParts, vec3, type ModelPart } from "@playground/api";

type V3={x:number;y:number;z:number};
interface RaceState {position:V3;heading:number;speed:number;steer:number;grounded:boolean;lap:number;checkpoint:number;time:number;best:number;reset:boolean;distance:number}
// Kenney's MIT arcade controller uses a hidden physics sphere and a separate
// animated car model. Forces adapt that architecture to the current GodotPhysics build.
const checkpoints=[vec3(10,0,-10),vec3(10,0,10),vec3(-10,0,10),vec3(-10,0,-10)];
function CarPart({part,state}:{part:ModelPart;state:RaceState}){
  const mesh=useResource(part.id,"Mesh"),ref=useNodeRef<"Node3D">(),phase=React.useRef(0);
  useProcess(ref,{writes:["rotation"]},(commands,dt)=>{
    phase.current=(phase.current+state.speed*dt*2)%(Math.PI*2);
    const wheel=part.name.startsWith("wheel"),front=part.name.includes("front");
    commands.command("setRotation3D",vec3(part.rotation.x+(wheel?phase.current:0),part.rotation.y+(front?state.steer*.35:0),part.rotation.z+(part.name==="body"?-state.steer*Math.min(state.speed/30,.12):0)));
  });
  return <Node3D ref={ref} name={part.name.replace(/-/g,"_")} initial={{position:part.position,rotation:part.rotation}} engineOwned={["rotation"]}><MeshInstance3D mesh={mesh} scale={part.scale}/></Node3D>;
}
function CarModel({state}:{state:RaceState}){
  const parts=useModelParts("race-car"),ref=useNodeRef<"Node3D">();
  useProcess(ref,{writes:["position","rotation"]},commands=>{commands.command("setPosition3D",vec3(state.position.x,state.position.y-.65,state.position.z));commands.command("setRotation3D",vec3(0,state.heading,0));});
  return <Node3D ref={ref} name="CarModel" engineOwned={["position","rotation"]}>{parts.map(part=><CarPart key={part.id} part={part} state={state}/>)}</Node3D>;
}
function GroundProbe({state}:{state:RaceState}){
  const ref=useNodeRef<"RayCast3D">();
  usePhysicsProcess(ref,{writes:["position","rayQuery"],priority:-10},commands=>{commands.command("setPosition3D",state.position);commands.command("forceUpdate");state.grounded=commands.command<boolean>("isColliding");});
  return <RayCast3D ref={ref} name="GroundProbe" targetPosition={vec3(0,-1.1,0)} collisionMask={1} engineOwned={["position","rayQuery"]}/>;
}
function Driver({state}:{state:RaceState}){
  const demo=useDemo(),ref=useNodeRef<"RigidBody3D">(),sphere=useResource("sphere-shape","SphereShape3D");
  usePhysicsProcess(ref,{writes:["position","rotation","linearVelocity","angularVelocity","sleeping"]},(commands,dt)=>{
    const keys=demo.input.keys,throttle=Number(keys.has("KeyW")||keys.has("ArrowUp"))-Number(keys.has("KeyS")||keys.has("ArrowDown"));
    state.steer=Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft"));
    const p=commands.read<V3>("position"),v=commands.read<V3>("linearVelocity");state.speed=Math.hypot(v.x,v.z);
    const moving=Math.min(1,Math.max(.15,state.speed/4));state.heading=(state.heading+state.steer*demo.controls.steering*moving*dt*(throttle<0?-1:1))%(Math.PI*2);
    if(state.grounded&&throttle)commands.command("applyCentralForce",vec3(Math.sin(state.heading)*throttle*demo.controls.acceleration,0,Math.cos(state.heading)*throttle*demo.controls.acceleration));
    if(state.speed>demo.controls.speed)commands.command("setLinearVelocity",vec3(v.x/state.speed*demo.controls.speed,v.y,v.z/state.speed*demo.controls.speed));
    if(keys.has("Space"))commands.command("setLinearVelocity",vec3(v.x*.9,v.y,v.z*.9));
    if(state.reset||demo.input.pressed.has("KeyR")||p.y < -5){commands.command("setPosition3D",vec3(0,.9,-10));commands.command("setLinearVelocity",vec3());commands.command("setAngularVelocity",vec3());state.heading=Math.PI/2;state.reset=false;}
    state.distance+=Math.hypot(p.x-state.position.x,p.z-state.position.z);state.position={...p};state.time+=dt;
    const next=checkpoints[state.checkpoint];if(Math.hypot(p.x-next.x,p.z-next.z)<3){state.checkpoint=(state.checkpoint+1)%4;if(state.checkpoint===0){state.lap++;state.best=state.best?Math.min(state.best,state.time):state.time;state.time=0;demo.sound("coin");}}
    demo.stats({kind:"racing",speed:+(state.speed*3.6).toFixed(1),distance:+state.distance.toFixed(1),grounded:state.grounded,laps:state.lap,checkpoint:state.checkpoint,time:+state.time.toFixed(1),best:+state.best.toFixed(1)});
  });
  return <RigidBody3D ref={ref} name="VehicleSphere" collisionLayer={2} collisionMask={1} linearDamp={.3} angularDamp={1} initial={{position:vec3(0,.9,-10)}} engineOwned={["position","rotation","linearVelocity","angularVelocity","sleeping"]}><CollisionShape3D shape={sphere}/></RigidBody3D>;
}
function TrackTile({x,z,corner,rotation=0}:{x:number;z:number;corner:boolean;rotation?:number}){
  const mesh=useResource(corner?"race-track-corner":x===0&&z===-10?"race-track-finish":"race-track-straight","Mesh");
  return <MeshInstance3D mesh={mesh} position={vec3(x,0,z)} rotation={vec3(0,rotation*Math.PI/2,0)}/>;
}
function Barrier({position,size}:{position:V3;size:V3}){
  const box=useResource("box-mesh","Mesh"),shape=useResource("unit-shape","BoxShape3D"),material=useResource("material-violet","StandardMaterial3D");
  return <StaticBody3D position={position}><CollisionShape3D shape={shape} scale={size}/><MeshInstance3D mesh={box} materialOverride={material} scale={size}/></StaticBody3D>;
}
export default function Racing(){
  const demo=useDemo(),camera=useNodeRef<"Camera3D">(),sky=useResource("sky","Environment"),floor=useResource("floor-mesh","Mesh"),shape=useResource("floor-shape","BoxShape3D"),grass=useResource("material-mint","StandardMaterial3D"),forest=useResource("race-decoration-forest","Mesh");
  const state=React.useRef<RaceState>({position:vec3(0,.9,-10),heading:Math.PI/2,speed:0,steer:0,grounded:false,lap:0,checkpoint:0,time:0,best:0,reset:false,distance:0}).current;
  const cameraPosition=React.useRef(vec3(9,14,6));
  useProcess(camera,{writes:["position"]},(commands,dt)=>{if(demo.input.requests.has("reset"))state.reset=true;const p=cameraPosition.current,t=state.position,a=Math.min(1,dt*4);p.x+=(t.x+9-p.x)*a;p.y+=(t.y+13-p.y)*a;p.z+=(t.z+16-p.z)*a;commands.command("setPosition3D",p);});
  return <Node3D name="Racing"><WorldEnvironment environment={sky}/><DirectionalLight3D rotation={vec3(-1,-.6,0)} lightEnergy={1.1} shadowEnabled/>
    <StaticBody3D position={vec3(0,-.25,0)}><CollisionShape3D shape={shape}/><MeshInstance3D mesh={floor} materialOverride={grass}/></StaticBody3D>
    {[[-10,-10,0],[0,-10,0],[10,-10,1],[10,0,1],[10,10,2],[0,10,0],[-10,10,3],[-10,0,1]].map(([x,z,r],i)=><TrackTile key={i} x={x} z={z} corner={x!==0&&z!==0} rotation={r}/>)}
    <MeshInstance3D mesh={forest}/>
    {[-1,1].flatMap(sign=>[<Barrier key={`outer-x${sign}`} position={vec3(sign*15,.6,0)} size={vec3(.4,1.2,30)}/>,<Barrier key={`outer-z${sign}`} position={vec3(0,.6,sign*15)} size={vec3(30,1.2,.4)}/>,<Barrier key={`inner-x${sign}`} position={vec3(sign*5,.6,0)} size={vec3(.4,1.2,10)}/>,<Barrier key={`inner-z${sign}`} position={vec3(0,.6,sign*5)} size={vec3(10,1.2,.4)}/>])}
    <GroundProbe state={state}/><Driver state={state}/><CarModel state={state}/>
    <Camera3D ref={camera} current fov={55} initial={{position:vec3(9,14,6),rotation:vec3(-.616,.512,0)}} engineOwned={["position"]}/>
  </Node3D>;
}
