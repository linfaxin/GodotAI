import * as React from "react";
import { Node3D, MeshInstance3D, CharacterBody3D, StaticBody3D, CollisionShape3D, Camera3D, DirectionalLight3D, WorldEnvironment, useNodeRef, useProcess, usePhysicsProcess } from "@godot-js/react";
import { useDemo, useResource, vec3 } from "@playground/api";

type V3={x:number;y:number;z:number};
interface World {player:V3;coins:Set<number>;jumps:number;respawns:number;finished:boolean}
// A compact course using Kenney's CC0 models. Controller and squash/stretch
// are ported to React frame hooks; no opaque PackedScene is instantiated.
const islands=[vec3(0,0,0),vec3(4,0,-3),vec3(8,.6,-5),vec3(11,1.2,-9),vec3(7,1.8,-13),vec3(2,2.4,-14),vec3(-2,3,-11)];
const coins=islands.slice(1).map(p=>vec3(p.x,p.y+1.25,p.z));
function Island({index,world}:{index:number;world:World}){
  const mesh=useResource(index===3||index===4?"platform-falling":"platform","Mesh"),shape=useResource("platform-shape","BoxShape3D"),ref=useNodeRef<"StaticBody3D">();
  const timer=React.useRef(-1),y=React.useRef(islands[index].y),demo=useDemo();
  usePhysicsProcess(ref,{writes:["position"]},(commands,dt)=>{
    const base=islands[index],under=Math.hypot(world.player.x-base.x,world.player.z-base.z)<1.5&&world.player.y>base.y&&world.player.y<base.y+2;
    if((index===3||index===4)&&under&&timer.current<0)timer.current=0;
    if(timer.current>=0){timer.current+=dt;if(timer.current>.6)y.current-=dt*5*demo.controls.collapse;
      if(timer.current>4){timer.current=-1;y.current=base.y;}}
    commands.command("setPosition3D",vec3(base.x,y.current,base.z));
  });
  return <StaticBody3D ref={ref} name={`Island${index}`} initial={{position:islands[index]}} engineOwned={["position"]}>
    <MeshInstance3D mesh={mesh} scale={vec3(1.5,1,1.5)}/><CollisionShape3D shape={shape} position={vec3(0,-.3,0)}/>
  </StaticBody3D>;
}
function Coin({index,world}:{index:number;world:World}){
  const mesh=useResource("coin","Mesh"),ref=useNodeRef<"Node3D">(),demo=useDemo(),t=React.useRef(index);
  const [collected,setCollected]=React.useState(false);
  useProcess(ref,{writes:["position","rotation","scale"]},(commands,dt)=>{
    t.current+=dt;const p=coins[index],hit=world.coins.has(index);
    if(hit!==collected)setCollected(hit);
    commands.command("setPosition3D",vec3(p.x,p.y+Math.sin(t.current*3)*.12,p.z));
    commands.command("setRotation3D",vec3(0,t.current*2,0));
    commands.command("setScale3D",vec3(.65,.65,.65));
    if(!hit&&Math.hypot(world.player.x-p.x,world.player.y-p.y,world.player.z-p.z)<1.1){world.coins.add(index);demo.sound("coin");}
  });
  return <Node3D ref={ref} name={`Coin${index}`} visible={!collected} engineOwned={["position","rotation","scale"]}><MeshInstance3D mesh={mesh}/></Node3D>;
}
function Player({world}:{world:World}){
  const shape=useResource("player-shape","CapsuleShape3D"),mesh=useResource("character","Mesh"),ref=useNodeRef<"CharacterBody3D">(),model=useNodeRef<"Node3D">(),demo=useDemo();
  const jumps=React.useRef(0),wasFloor=React.useRef(false),heading=React.useRef(0),squash=React.useRef(1);
  usePhysicsProcess(ref,{writes:["position","velocity"]},(commands,dt)=>{
    const floor=commands.command<boolean>("isOnFloor");if(floor)jumps.current=0;
    if(floor&&!wasFloor.current){squash.current=.7;demo.sound("land");}wasFloor.current=floor;
    const input=demo.input;let x=Number(input.keys.has("KeyD"))-Number(input.keys.has("KeyA")),z=Number(input.keys.has("KeyS"))-Number(input.keys.has("KeyW"));
    const len=Math.hypot(x,z);if(len>0){x/=len;z/=len;heading.current=Math.atan2(x,z);}
    const velocity=commands.read<V3>("velocity");let vy=floor?-.2:Math.max(-24,velocity.y-demo.controls.gravity*dt);
    if(input.pressed.has("Space")&&jumps.current<2){vy=demo.controls.jump;jumps.current++;world.jumps++;squash.current=1.35;demo.sound("jump");}
    commands.command("setVelocity3D",vec3(x*demo.controls.speed,vy,z*demo.controls.speed));commands.moveAndSlide();
    let p=commands.read<V3>("position");
    if(p.y < -8 || input.pressed.has("KeyR")){p=vec3(0,2,0);commands.command("setPosition3D",p);commands.command("setVelocity3D",vec3());world.respawns++;}
    world.player={...p};world.finished=world.coins.size===coins.length;
    demo.stats({coins:world.coins.size,total:coins.length,jumps:world.jumps,respawns:world.respawns,grounded:floor,finished:world.finished,x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)});
  });
  useProcess(model,{writes:["rotation","scale"]},(commands,dt)=>{
    squash.current+=(1-squash.current)*Math.min(1,dt*12);
    commands.command("setRotation3D",vec3(0,heading.current,0));
    commands.command("setScale3D",vec3(.9/Math.sqrt(squash.current),.9*squash.current,.9/Math.sqrt(squash.current)));
  });
  return <CharacterBody3D name="Player" ref={ref} initial={{position:vec3(0,2,0)}} engineOwned={["position","velocity"]}>
    <CollisionShape3D shape={shape} position={vec3(0,.55,0)}/>
    <Node3D name="Character" ref={model} engineOwned={["rotation","scale"]}><MeshInstance3D mesh={mesh}/></Node3D>
  </CharacterBody3D>;
}
function FollowCamera({world}:{world:World}){
  const ref=useNodeRef<"Camera3D">(),position=React.useRef(vec3(0,8,12));
  useProcess(ref,{writes:["position"]},(commands,dt)=>{
    const target=vec3(world.player.x,world.player.y+7,world.player.z+11),p=position.current,a=Math.min(1,dt*3);
    p.x+=(target.x-p.x)*a;p.y+=(target.y-p.y)*a;p.z+=(target.z-p.z)*a;commands.command("setPosition3D",p);
  });
  return <Camera3D ref={ref} name="Camera" current fov={55} initial={{position:vec3(0,8,12),rotation:vec3(-.52,0,0)}} engineOwned={["position"]}/>;
}
export default function SkyIslands(){
  const environment=useResource("sky","Environment"),cloud=useResource("cloud","Mesh"),flag=useResource("flag","Mesh");
  const world=React.useRef<World>({player:vec3(0,2,0),coins:new Set(),jumps:0,respawns:0,finished:false}).current;
  return <Node3D name="SkyIslands">
    <WorldEnvironment environment={environment}/><DirectionalLight3D rotation={vec3(-.9,-.6,0)} lightEnergy={1.5} shadowEnabled/>
    {islands.map((_,index)=><Island key={index} index={index} world={world}/>)}
    {coins.map((_,index)=><Coin key={index} index={index} world={world}/>)}
    <MeshInstance3D name="FinishFlag" mesh={flag} position={vec3(-2,3,-11)}/>
    {[-1,0,1].map(i=><MeshInstance3D key={i} mesh={cloud} position={vec3(i*15,-3,-12+i*8)} scale={vec3(3,2,3)}/>)}
    <Player world={world}/><FollowCamera world={world}/>
  </Node3D>;
}
