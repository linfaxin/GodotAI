import * as React from "react";
import { Node2D, ColorRect, useNodeRef, useProcess, vec2, color } from "@godot-js/react";
import { useDemo } from "@playground/api";

// MIT BSP partition/room/orthogonal-corridor algorithm adapted from
// Vincenzopaolo's Godot demo. Rectangles replace TileMapLayer terrain painting.
interface Room {x:number;y:number;width:number;height:number;cx:number;cy:number}
interface Corridor {from:number;to:number;horizontalFirst:boolean}
export interface DungeonLayout {rooms:Room[];corridors:Corridor[];size:number}
export function generateDungeon(size:number,minRoom:number,seed:number):DungeonLayout{
  if(!Number.isInteger(size)||size<12||size>48||!Number.isInteger(minRoom)||minRoom<3||minRoom>size/2)throw Error("Invalid dungeon bounds");
  let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const rooms:Room[]=[],corridors:Corridor[]=[];
  const split=(x:number,y:number,width:number,height:number,depth:number):number=>{
    const vertical=width/height>1.3?true:height/width>1.3?false:random()>.5,span=vertical?width:height;
    if(span>=minRoom*2+2&&depth<6){const cut=minRoom+1+Math.floor(random()*(span-minRoom*2-1));const a=split(x,y,vertical?cut:width,vertical?height:cut,depth+1),b=split(vertical?x+cut:x,vertical?y:y+cut,vertical?width-cut:width,vertical?height:height-cut,depth+1);corridors.push({from:a,to:b,horizontalFirst:random()>.5});return a;}
    const room={x:x+1,y:y+1,width:width-2,height:height-2,cx:Math.floor(x+width/2),cy:Math.floor(y+height/2)};rooms.push(room);return rooms.length-1;
  };
  split(0,0,size,size,0);return {rooms,corridors,size};
}
function Passage({layout,corridor,scale,offset}:{layout:DungeonLayout;corridor:Corridor;scale:number;offset:{x:number;y:number}}){
  const a=layout.rooms[corridor.from],b=layout.rooms[corridor.to],bend=corridor.horizontalFirst?{cx:b.cx,cy:a.cy}:{cx:a.cx,cy:b.cy};
  return <Node2D>{[[a,bend],[bend,b]].map(([p,q],i)=><ColorRect key={i} position={vec2(offset.x+Math.min(p.cx,q.cx)*scale,offset.y+Math.min(p.cy,q.cy)*scale)} size={vec2((Math.abs(p.cx-q.cx)+1)*scale,(Math.abs(p.cy-q.cy)+1)*scale)} color={color(.2,.32,.43)}/>)}</Node2D>;
}
export default function Dungeon(){
  const demo=useDemo(),ref=useNodeRef<"Node2D">(),[extra,setExtra]=React.useState(0),[visible,setVisible]=React.useState(0),clock=React.useRef(0);
  const seed=Math.round(demo.controls.seed)+extra,size=Math.round(demo.controls.size),minimum=Math.round(demo.controls.room);
  const layout=React.useMemo(()=>generateDungeon(size,minimum,seed),[size,minimum,seed]),scale=520/size,offset=vec2((960-520)/2,60);
  React.useEffect(()=>{setVisible(0);clock.current=0;},[layout]);
  useProcess(ref,{},(_,dt)=>{if(demo.input.requests.has("generate")||demo.input.actions.has("Space"))setExtra(v=>v+1);clock.current+=dt*demo.controls.speed;const next=Math.min(layout.rooms.length,Math.floor(clock.current));if(next!==visible)setVisible(next);demo.stats({kind:"dungeon",seed,rooms:layout.rooms.length,revealed:visible,corridors:layout.corridors.length,complete:visible===layout.rooms.length});});
  return <Node2D ref={ref} name="Dungeon"><ColorRect size={vec2(960,640)} color={color(.035,.055,.095)}/><ColorRect position={vec2(offset.x-10,offset.y-10)} size={vec2(540,540)} color={color(.07,.1,.16)}/>
    {layout.corridors.filter(c=>c.from<visible&&c.to<visible).map((corridor,i)=><Passage key={i} layout={layout} corridor={corridor} scale={scale} offset={offset}/>)}
    {layout.rooms.slice(0,visible).map((room,i)=><Node2D key={i}><ColorRect position={vec2(offset.x+room.x*scale,offset.y+room.y*scale)} size={vec2(room.width*scale,room.height*scale)} color={color(.17,.42,.44)}/><ColorRect position={vec2(offset.x+room.x*scale+2,offset.y+room.y*scale+2)} size={vec2(room.width*scale-4,room.height*scale-4)} color={i===0?color(.35,.63,.55):i===layout.rooms.length-1?color(.55,.4,.65):color(.13,.25,.32)}/><ColorRect position={vec2(offset.x+room.cx*scale+scale*.35,offset.y+room.cy*scale+scale*.35)} size={vec2(scale*.3,scale*.3)} color={color(.65,.94,.83)}/></Node2D>)}
  </Node2D>;
}
