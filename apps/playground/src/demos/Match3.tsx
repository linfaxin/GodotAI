import * as React from "react";
import { Node2D, Sprite2D, ColorRect, useNodeRef, useProcess, vec2, color } from "@godot-js/react";
import { useDemo, useResource } from "@playground/api";

// Swap/match/collapse/refill state machine adapted from Kenney's MIT Match-3.
export function randomSource(seed:number){let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
export function findMatches(board:number[][]):number[]{
  const n=board.length,found=new Set<number>();
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const type=board[y][x];if(type<0)continue;
    if(x+2<n&&type===board[y][x+1]&&type===board[y][x+2]){let end=x;while(end<n&&board[y][end]===type)found.add(y*n+end++);}
    if(y+2<n&&type===board[y+1][x]&&type===board[y+2][x]){let end=y;while(end<n&&board[end][x]===type)found.add(end++*n+x);}
  }
  return [...found];
}
export function legalMove(board:number[][]):number[]|null{
  const n=board.length;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++)for(const [dx,dy] of [[1,0],[0,1]]){const xx=x+dx,yy=y+dy;if(xx>=n||yy>=n)continue;const copy=board.map(row=>row.slice());[copy[y][x],copy[yy][xx]]=[copy[yy][xx],copy[y][x]];if(findMatches(copy).length)return [x,y,xx,yy];}
  return null;
}
export function createBoard(n:number,types:number,seed:number):number[][]{
  if(!Number.isInteger(n)||n<3||n>12||!Number.isInteger(types)||types<3||types>5)throw Error("Invalid board dimensions");
  for(let attempt=0;attempt<50;attempt++){
    const random=randomSource(seed+attempt),board:number[][]=[];
    for(let y=0;y<n;y++){board.push([]);for(let x=0;x<n;x++){const allowed=Array.from({length:types},(_,i)=>i).filter(t=>!(x>1&&board[y][x-1]===t&&board[y][x-2]===t)&&!(y>1&&board[y-1][x]===t&&board[y-2][x]===t));board[y].push(allowed[Math.floor(random()*allowed.length)]);}}
    if(legalMove(board))return board;
  }
  throw Error("Unable to generate a playable board");
}
interface Tile {id:number;x:number;y:number;type:number;spawn?:number;clearing?:boolean}
interface BoardState {cells:Tile[];phase:string;timer:number;score:number;moves:number;combo:number;serial:number;seed:number;key:string;swap:number[]|null;start:{x:number;y:number}|null;hint:number[]|null}
const names=["gem","godot","grass","kenney","spikes"],step=62;
function TileView({tile,n,hint}:{tile:Tile;n:number;hint:boolean}){
  const texture=useResource(`tile-${names[tile.type]}`,"Texture2D"),ref=useNodeRef<"Sprite2D">(),origin=vec2((960-n*step)/2+step/2,(640-n*step)/2+step/2),scale=React.useRef(0);
  useProcess(ref,{writes:["position","scale"]},(commands,dt)=>{
    const target=vec2(origin.x+tile.x*step,origin.y+tile.y*step),p=commands.readPosition(),a=Math.min(1,dt*14);
    commands.setPosition(vec2(p.x+(target.x-p.x)*a,p.y+(target.y-p.y)*a));scale.current+=((tile.clearing?0:.42)-scale.current)*Math.min(1,dt*18);commands.command("setScale",vec2(scale.current,scale.current));
  });
  return <Sprite2D ref={ref} name={`Tile${tile.id}`} texture={texture} modulate={hint?color(1,.75,.4):color(1,1,1)} initial={{position:vec2(origin.x+tile.x*step,origin.y+(tile.spawn??tile.y)*step),scale:vec2(.01,.01)}} engineOwned={["position","scale"]}/>;
}
export default function Match3(){
  const demo=useDemo(),ref=useNodeRef<"Node2D">(),n=Math.round(demo.controls.size),types=Math.round(demo.controls.types);
  const [tiles,setTiles]=React.useState<Tile[]>([]),state=React.useRef<BoardState>({cells:[],phase:"idle",timer:0,score:0,moves:0,combo:1,serial:0,seed:1,key:"",swap:null,start:null,hint:null}).current;
  const publish=()=>setTiles(state.cells.slice());
  const board=()=>Array.from({length:n},(_,y)=>Array.from({length:n},(_,x)=>state.cells.find(c=>c.x===x&&c.y===y)?.type??-1));
  const reset=(seed:number)=>{state.seed=seed;const grid=createBoard(n,types,seed);state.cells=grid.flatMap((row,y)=>row.map((type,x)=>({id:++state.serial,x,y,type,spawn:y-n})));state.phase="idle";state.timer=0;state.score=0;state.moves=0;state.hint=null;state.start=null;publish();};
  const swap=(a:number[])=>{state.cells=state.cells.map(c=>c.x===a[0]&&c.y===a[1]?{...c,x:a[2],y:a[3]}:c.x===a[2]&&c.y===a[3]?{...c,x:a[0],y:a[1]}:c);publish();};
  const clearMatches=(matches:number[])=>{const ids=new Set(matches);state.combo++;state.score+=matches.length*state.combo*10;state.cells=state.cells.map(c=>({...c,clearing:ids.has(c.y*n+c.x)}));state.phase="clear";state.timer=0;demo.sound("coin");publish();};
  useProcess(ref,{},(_,dt)=>{
    const key=`${n}:${types}:${demo.controls.seed}`;if(state.key!==key){state.key=key;reset(Math.round(demo.controls.seed));}
    if(demo.input.requests.has("shuffle"))reset(state.seed+1);
    if(demo.input.requests.has("hint")){state.hint=legalMove(board());publish();}
    const at=(p:{x:number;y:number})=>({x:Math.floor((p.x-(960-n*step)/2)/step),y:Math.floor((p.y-(640-n*step)/2)/step)});
    if(state.phase==="idle"){
      for(const click of demo.input.clicks)if(click.button===1){const p=at(click);if(p.x>=0&&p.y>=0&&p.x<n&&p.y<n)state.start=p;}
      for(const release of demo.input.releases)if(release.button===1&&state.start){const a=state.start,b=at(release);state.start=null;if(b.x>=0&&b.y>=0&&b.x<n&&b.y<n&&Math.abs(a.x-b.x)+Math.abs(a.y-b.y)===1){state.swap=[a.x,a.y,b.x,b.y];state.combo=0;state.hint=null;swap(state.swap);state.phase="swap";state.timer=0;}}
    }
    state.timer+=dt*demo.controls.animation;
    if(state.phase==="swap"&&state.timer>.25){const matches=findMatches(board());if(matches.length){state.moves++;clearMatches(matches);}else{swap(state.swap!);state.phase="return";state.timer=0;}}
    else if(state.phase==="return"&&state.timer>.25)state.phase="idle";
    else if(state.phase==="clear"&&state.timer>.25){
      const random=randomSource(state.seed+state.serial),next:Tile[]=[];
      for(let x=0;x<n;x++){const remaining=state.cells.filter(c=>c.x===x&&!c.clearing).sort((a,b)=>b.y-a.y);remaining.forEach((c,i)=>next.push({...c,y:n-1-i,clearing:false}));for(let y=n-remaining.length-1;y>=0;y--)next.push({id:++state.serial,x,y,type:Math.floor(random()*types),spawn:y-n});}
      state.cells=next;state.phase="fall";state.timer=0;publish();
    }else if(state.phase==="fall"&&state.timer>.4){const matches=findMatches(board());if(matches.length)clearMatches(matches);else{state.phase="idle";if(!legalMove(board()))reset(state.seed+1);}}
    const hint=legalMove(board());demo.stats({kind:"match3",score:state.score,moves:state.moves,combo:state.combo,phase:state.phase,tiles:state.cells.length,seed:state.seed,hintX:hint?.[0]??-1,hintY:hint?.[1]??-1,hintToX:hint?.[2]??-1,hintToY:hint?.[3]??-1});
  });
  return <Node2D ref={ref} name="Match3"><ColorRect size={vec2(960,640)} color={color(.045,.06,.12)}/><ColorRect position={vec2((960-n*step)/2-14,(640-n*step)/2-14)} size={vec2(n*step+28,n*step+28)} color={color(.1,.13,.22)}/>
    {tiles.map(tile=><TileView key={tile.id} tile={tile} n={n} hint={!!state.hint&&((tile.x===state.hint[0]&&tile.y===state.hint[1])||(tile.x===state.hint[2]&&tile.y===state.hint[3]))}/>)}
  </Node2D>;
}
