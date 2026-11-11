import {EngineNode} from "@godot-js/react/engine";
import * as G from "godot";
import {Native, withDemo, v2, useNodeRef, useProcess, useDemo, useResource, vec3} from "@playground/api";
import * as React from "react";

// Grid placement, rotation and map serialization adapted from Kenney's MIT
// City Builder. GridMap/PackedScene creation becomes ordinary keyed TSX.
export interface CityCell {x:number;z:number;type:number;rotation:number}
const models=["building-small-a","building-small-b","building-small-c","building-garage","grass-trees","road-straight"];
const prices=[120,180,240,90,30,10];
export function validateCityMap(data:unknown):CityCell[]{
  const map=data as {version?:unknown;cells?:unknown};
  if(!map||map.version!==1||!Array.isArray(map.cells)||map.cells.length>324)throw Error("地图须为 version:1，最多 324 个建筑");
  const used=new Set<string>();
  return map.cells.map(value=>{const c=value as CityCell;if(!c||![c.x,c.z,c.type,c.rotation].every(Number.isInteger)||Math.abs(c.x)>9||Math.abs(c.z)>9||c.type<0||c.type>=models.length||c.rotation<0||c.rotation>3)throw Error("地图包含无效网格或建筑类型");const key=`${c.x},${c.z}`;if(used.has(key))throw Error("地图存在重复网格");used.add(key);return {x:c.x,z:c.z,type:c.type,rotation:c.rotation};});
}
function Building({cell,ghost=false}:{cell:CityCell;ghost?:boolean}){
  const mesh=useResource(`city-${models[cell.type]}`,"Mesh"),preview=useResource("material-ghost","StandardMaterial3D");
  return <EngineNode ctor={G.MeshInstance3D} native={{mesh: mesh, material_override: ghost?preview:null, position: vec3(cell.x,.06,cell.z), rotation: vec3(0,cell.rotation*Math.PI/2,0)}} />;
}
function initialMap():CityCell[]{return [...Array.from({length:9},(_,i)=>({x:i-4,z:0,type:5,rotation:1})),{x:-2,z:-2,type:0,rotation:0},{x:0,z:-2,type:1,rotation:0},{x:2,z:-2,type:2,rotation:0},{x:2,z:2,type:4,rotation:0}];}
function CityBuilder(){
  const demo=useDemo(),camera=useNodeRef<"Camera3D">(),grass=useResource("city-grass","Mesh"),sky=useResource("sky","Environment");
  const [cells,setCells]=React.useState<CityCell[]>(initialMap),[hover,setHover]=React.useState({x:0,z:1}),[rotation,setRotation]=React.useState(0);
  const current=React.useRef(cells),history=React.useRef<CityCell[][]>([]),future=React.useRef<CityCell[][]>([]),pan=React.useRef(vec3()),notice=React.useRef("左键建造 · R 旋转 · Delete 拆除");
  const commit=(next:CityCell[])=>{history.current.push(current.current);if(history.current.length>50)history.current.shift();future.current=[];current.current=next;setCells(next);demo.sound("land");};
  useProcess(camera, (node,dt)=>{
    const input=demo.input,a=demo.controls.angle,radius=18,limit=Math.floor(demo.controls.grid/2);
    pan.current.x+=((input.keys.has("KeyD")?1:0)-(input.keys.has("KeyA")?1:0))*dt*5;
    pan.current.z+=((input.keys.has("KeyS")?1:0)-(input.keys.has("KeyW")?1:0))*dt*5;
    pan.current.x=Math.max(-8,Math.min(8,pan.current.x));pan.current.z=Math.max(-8,Math.min(8,pan.current.z));
    (node.position = vec3(Math.sin(a)*radius+pan.current.x,16,Math.cos(a)*radius+pan.current.z));
    (node.rotation = vec3(-Math.atan2(16,radius),a,0));
    const origin=node.project_ray_origin(v2(input.pointer)),direction=node.project_ray_normal(v2(input.pointer));
    let hit=hover;if(Math.abs(direction.y)>.001){const t=-origin.y/direction.y;hit={x:Math.round(origin.x+direction.x*t),z:Math.round(origin.z+direction.z*t)};if(hit.x!==hover.x||hit.z!==hover.z)setHover(hit);}
    let turn=rotation;if(input.actions.has("KeyR")||input.clicks.some(c=>c.button===2)){turn=(turn+1)%4;setRotation(turn);}
    const selected=Math.round(demo.controls.building),inside=Math.abs(hit.x)<limit&&Math.abs(hit.z)<limit;
    if(inside&&input.clicks.some(c=>c.button===1)){const old=current.current.filter(c=>c.x!==hit.x||c.z!==hit.z);commit([...old,{...hit,type:selected,rotation:turn}]);}
    if(input.actions.has("Delete")||input.requests.has("demolish"))commit(current.current.filter(c=>c.x!==hit.x||c.z!==hit.z));
    if(input.actions.has("KeyZ")||input.requests.has("undo")){const last=history.current.pop();if(last){future.current.push(current.current);current.current=last;setCells(last);}}
    if(input.actions.has("KeyY")||input.requests.has("redo")){const next=future.current.pop();if(next){history.current.push(current.current);current.current=next;setCells(next);}}
    if(input.requests.has("save"))demo.exportJSON("godot-city.json",{version:1,cells:current.current});
    if(input.imported!==undefined){try{commit(validateCityMap(input.imported));notice.current="地图导入成功";}catch(error){notice.current=String(error);}delete input.imported;}
    demo.stats({kind:"city",buildings:current.current.length,cost:current.current.reduce((sum,c)=>sum+prices[c.type],0),undo:history.current.length,hoverX:hit.x,hoverZ:hit.z,notice:notice.current});
  });
  return <EngineNode ctor={G.Node3D} native={{name: "CityBuilder"}}><EngineNode ctor={G.WorldEnvironment} native={{environment: sky}} /><EngineNode ctor={G.DirectionalLight3D} native={{rotation: vec3(-.9,-.5,0), light_energy: 1.2, shadow_enabled: true}} />
    <EngineNode ctor={G.MeshInstance3D} native={{mesh: grass, scale: vec3(demo.controls.grid,1,demo.controls.grid)}} />
    {cells.map(cell=><Building key={`${cell.x},${cell.z}`} cell={cell}/>)}
    {Math.abs(hover.x)<demo.controls.grid/2&&Math.abs(hover.z)<demo.controls.grid/2&&<Building key={`ghost-${demo.controls.building}`} ghost cell={{...hover,type:Math.round(demo.controls.building),rotation}}/>}
    <Native ctor={G.Camera3D} ref={camera} initial={{position:vec3(12,16,14),rotation:vec3(-.7,.7,0)}} native={{current: true, projection: 1, size: demo.controls.zoom}} />
  </EngineNode>;
}
export default withDemo(CityBuilder);
