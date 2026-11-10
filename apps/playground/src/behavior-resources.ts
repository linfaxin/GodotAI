const fail=(message:string):never=>{throw Error('E_BEHAVIOR_RESOURCE: '+message);};
const fields=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected fields');};
const num=(v:any,min=-64,max=64)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number');return v as number;};
const integer=(v:any,min:number,max:number)=>{const n=num(v,min,max);if(!Number.isInteger(n))fail('Expected integer');return n;};
const list=(v:any,min=2,max=256):any[]=>{if(!Array.isArray(v)||v.length<min||v.length>max)fail('Invalid point count');return v;};
const real=(value:number)=>Number.isInteger(value)?String(value)+'.0':String(value);
export const behaviorResourceTypes=['Curve','Gradient','GradientTexture1D'];
export function serializeBehaviorResource(def:any,reference:(id:any,types:string[])=>string):string[]{
 if(def.type==='Curve'){
  fields(def,['type','points','bakeResolution','minValue','maxValue']);let previous=-1;const points=list(def.points).map(point=>{fields(point,['x','y','leftTangent','rightTangent','leftMode','rightMode']);const x=num(point.x,0,1),y=num(point.y);if(x-previous<1e-6)fail('Curve offsets must increase');previous=x;const mode=(side:string)=>integer(point[side+'Mode']??(point[side+'Tangent']===undefined?1:0),0,1);return {x,y,left:point.leftTangent===undefined?0:num(point.leftTangent,-4096,4096),right:point.rightTangent===undefined?0:num(point.rightTangent,-4096,4096),leftMode:mode('left'),rightMode:mode('right')};});
  const minimum=num(def.minValue??Math.min(0,...points.map(p=>p.y)),-4096,4096),maximum=num(def.maxValue??Math.max(1,...points.map(p=>p.y)),-4096,4096);if(minimum>=maximum)fail('Curve limits must increase');
  const data=points.flatMap((point,i)=>{const before=points[Math.max(0,i-1)]!,after=points[Math.min(points.length-1,i+1)]!,left=point.leftMode===0?point.left:i?(point.y-before.y)/(point.x-before.x):0,right=point.rightMode===0?point.right:i<points.length-1?(after.y-point.y)/(after.x-point.x):0;return [`Vector2(${point.x},${point.y})`,real(left),real(right),String(point.leftMode),String(point.rightMode)];});
  return ['_limits = ['+[minimum,maximum,0,1].map(real).join(',')+']','bake_resolution = '+integer(def.bakeResolution??256,2,1000),'_data = ['+data.join(',')+']'];
 }
 if(def.type==='Gradient'){
  fields(def,['type','points','interpolationMode','interpolationColorSpace']);let previous=-1;const points=list(def.points).map(point=>{fields(point,['offset','color']);const offset=num(point.offset,0,1);if(offset-previous<1e-6)fail('Gradient offsets must increase');previous=offset;fields(point.color,['r','g','b','a']);const color=['r','g','b','a'].map(k=>num(point.color[k],0,k==='a'?1:16));return {offset,color};});
  return ['interpolation_color_space = '+integer(def.interpolationColorSpace??0,0,2),'interpolation_mode = '+integer(def.interpolationMode??0,0,2),'offsets = PackedFloat32Array('+points.map(p=>p.offset).join(',')+')','colors = PackedColorArray('+points.flatMap(p=>p.color).join(',')+')'];
 }
 fields(def,['type','gradient','width','useHdr']);if(def.useHdr!==undefined&&typeof def.useHdr!=='boolean')fail('Expected useHdr boolean');return ['gradient = '+reference(def.gradient,['Gradient']),'width = '+integer(def.width??256,1,4096),'use_hdr = '+String(def.useHdr??false)];
}
