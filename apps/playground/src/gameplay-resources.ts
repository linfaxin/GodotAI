import {validateSimplePolygon} from '@godot-js/react/schema';
const fail=(message:string):never=>{throw Error('E_GAMEPLAY_RESOURCE: '+message);};
const fields=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected fields');};
const num=(v:any,min=-1e6,max=1e6)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number');return v as number;};
const list=(v:any,min=0,max=4096):any[]=>{if(!Array.isArray(v)||v.length<min||v.length>max)fail('Invalid array length');return v;};
const vec=(v:any,d:2|3)=>{const names=d===2?['x','y']:['x','y','z'];fields(v,names);return Object.fromEntries(names.map(k=>[k,num(v[k])])) as any;};
export const gameplayResourceTypes=['OccluderPolygon2D','AtlasTexture','ConvexPolygonShape2D','ConcavePolygonShape2D','SeparationRayShape2D','WorldBoundaryShape2D','ConvexPolygonShape3D','ConcavePolygonShape3D','SeparationRayShape3D','WorldBoundaryShape3D'];
export function serializeGameplayResource(def:any,reference:(id:any,types:string[])=>string):string[]{
 if(def.type==='AtlasTexture'){
  fields(def,['type','atlas','region','margin','filterClip']);const rect=(v:any)=>{const values=list(v,4,4).map((n,i)=>num(n,0,i<2?4096:8192));return 'Rect2('+values.join(',')+')';};
  if(def.filterClip!==undefined&&typeof def.filterClip!=='boolean')fail('Expected filterClip boolean');
  return ['atlas = '+reference(def.atlas,['Texture2D','AtlasTexture','GradientTexture2D']),'region = '+rect(def.region),...(def.margin?['margin = '+rect(def.margin)]:[]),'filter_clip = '+String(def.filterClip??false)];
 }
 if(def.type==='OccluderPolygon2D'){fields(def,['type','points','closed','cullMode']);const closed=def.closed??true;if(typeof closed!=='boolean')fail('Expected closed boolean');const points=list(def.points,closed?3:2,256).map(v=>vec(v,2));if(closed)validateSimplePolygon(points,false);const cull=def.cullMode??0;if(!Number.isInteger(cull)||cull<0||cull>2)fail('Invalid occluder cull mode');return ['polygon = PackedVector2Array('+points.flatMap(p=>[p.x,p.y]).join(',')+')','closed = '+closed,'cull_mode = '+cull];}
 const d=def.type.endsWith('2D')?2:3;
 if(def.type.startsWith('SeparationRayShape')){fields(def,['type','length','slideOnSlope']);if(def.slideOnSlope!==undefined&&typeof def.slideOnSlope!=='boolean')fail('Expected slope boolean');return ['length = '+num(def.length,.0001,10000),'slide_on_slope = '+String(def.slideOnSlope??false)];}
 if(def.type.startsWith('WorldBoundaryShape')){fields(def,['type','normal','distance']);const normal=vec(def.normal,d),length=Math.hypot(...Object.values(normal) as number[]);if(length<1e-10)fail('Zero boundary normal');const parts=(d===2?['x','y']:['x','y','z']).map(k=>normal[k]/length);return d===2?['normal = Vector2('+parts.join(',')+')','distance = '+num(def.distance??0)]:['plane = Plane('+[...parts,num(def.distance??0)].join(',')+')'];}
 const concave=def.type.startsWith('Concave'),key=concave?(d===2?'segments':'faces'):'points';fields(def,['type',key]);const points=list(def[key],concave?(d===2?2:3):d+1,concave?4096:256).map(p=>vec(p,d));
 if(concave&&points.length%(d===2?2:3)!==0)fail('Incomplete segment/triangle');
 if(!concave&&d===2){validateSimplePolygon(points,false);let direction=0;for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!,c=points[(i+2)%points.length]!,cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);if(Math.abs(cross)<1e-9)continue;if(direction&&direction*cross<0)fail('Convex shape must be convex');direction=Math.sign(cross);}}
 if(!concave&&d===3){const a=points[0]!,b=points.find(p=>Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)>1e-9);if(!b)fail('Degenerate convex hull');const u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};let normal:any;for(const c of points){const v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z},cross={x:u.y*v.z-u.z*v.y,y:u.z*v.x-u.x*v.z,z:u.x*v.y-u.y*v.x};if(Math.hypot(cross.x,cross.y,cross.z)>1e-9){normal=cross;break;}}if(!normal||!points.some(p=>Math.abs(normal.x*(p.x-a.x)+normal.y*(p.y-a.y)+normal.z*(p.z-a.z))>1e-9))fail('Convex hull must enclose volume');}

 if(concave){for(let i=0;i<points.length;i+=d===2?2:3){const a=points[i]!,b=points[i+1]!;if(d===2&&a.x===b.x&&a.y===b.y)fail('Degenerate segment');if(d===3){const c=points[i+2]!,u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};if(Math.hypot(u.y*v.z-u.z*v.y,u.z*v.x-u.x*v.z,u.x*v.y-u.y*v.x)<1e-10)fail('Degenerate triangle');}}}
 return [(concave&&d===3?'data':key)+' = PackedVector'+d+'Array('+points.flatMap(p=>d===2?[p.x,p.y]:[p.x,p.y,p.z]).join(',')+')'];
}
export interface MeshSurface {vertices:{x:number;y:number;z:number}[];normals?:{x:number;y:number;z:number}[];uvs?:{x:number;y:number}[];indices?:number[];material?:string}
export interface ArrayMeshDefinition {type:'ArrayMesh';surfaces:MeshSurface[]}
export function validateArrayMesh(def:any,reference:(id:any,types:string[])=>string):ArrayMeshDefinition{
 fields(def,['type','surfaces']);let total=0;const surfaces=list(def.surfaces,1,64).map(raw=>{fields(raw,['vertices','normals','uvs','indices','material']);const vertices=list(raw.vertices,3,65536).map(v=>vec(v,3));total+=vertices.length;if(total>65536)fail('Mesh exceeds 65536 vertices');const out:MeshSurface={vertices};
  if(raw.normals){out.normals=list(raw.normals,vertices.length,vertices.length).map(v=>{const n=vec(v,3),length=Math.hypot(n.x,n.y,n.z);if(length<1e-10)fail('Zero normal');return {x:n.x/length,y:n.y/length,z:n.z/length};});}
  if(raw.uvs)out.uvs=list(raw.uvs,vertices.length,vertices.length).map(v=>vec(v,2));
  if(raw.indices){out.indices=list(raw.indices,3,196608).map(v=>{num(v,0,vertices.length-1);if(!Number.isInteger(v))fail('Invalid index');return v;});if(out.indices.length%3)fail('Incomplete indexed triangle');}else if(vertices.length%3)fail('Incomplete triangle');
  if(raw.material!==undefined){reference(raw.material,['StandardMaterial3D','ShaderMaterial']);out.material=raw.material;}
  return out;
 });return {type:'ArrayMesh',surfaces};
}
