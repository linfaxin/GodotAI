const fail=(message:string):never=>{throw Error('E_FIDELITY_RESOURCE: '+message);};
const fields=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected resource fields');};
const number=(v:any,min:number,max:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Number out of range');return v as number;};
const integer=(v:any,min:number,max:number)=>{const n=number(v,min,max);if(!Number.isInteger(n))fail('Expected integer');return n;};
export const fidelityResourceTypes=['GradientTexture2D','BitMap'];
export function serializeFidelityResource(def:any,reference:(id:any,types:string[])=>string,images:Record<string,any>):{body:string[];bytes:number} {
 if(def.type==='GradientTexture2D') {
  fields(def,['type','gradient','width','height','fill','fillFrom','fillTo','repeat','useHdr']);
  const width=integer(def.width??64,1,1024),height=integer(def.height??64,1,1024);
  const point=(v:any)=>{fields(v,['x','y']);return 'Vector2('+number(v.x,-16,16)+','+number(v.y,-16,16)+')';};
  if(def.useHdr!==undefined&&typeof def.useHdr!=='boolean')fail('Expected useHdr boolean');
  return {bytes:width*height*(def.useHdr?16:4),body:['gradient = '+reference(def.gradient,['Gradient']),'width = '+width,'height = '+height,'fill = '+integer(def.fill??0,0,2),'fill_from = '+point(def.fillFrom??{x:0,y:0}),'fill_to = '+point(def.fillTo??{x:1,y:0}),'repeat = '+integer(def.repeat??0,0,2),'use_hdr = '+String(def.useHdr??false)]};
 }
 fields(def,['type','width','height','data','image','alphaThreshold']);
 let width:number,height:number,data:number[];
 if(def.image!==undefined) {
  if(def.width!==undefined||def.height!==undefined||def.data!==undefined)fail('Choose image alpha or packed mask data');
  const image=images[def.image];if(typeof def.image!=='string'||!image)fail('Mask image must be a decoded project image');
  width=integer(image.width,1,1024);height=integer(image.height,1,1024);const threshold=Math.fround(number(def.alphaThreshold??.1,0,1));
  if(!Array.isArray(image.rgba)||image.rgba.length!==width*height*4)fail('Invalid decoded mask image');
  data=Array(Math.ceil(width*height/8)).fill(0);for(let index=0;index<width*height;index++)if(integer(image.rgba[index*4+3],0,255)/255>threshold)data[index>>3]!|=1<<(index&7);
 } else {
  if(def.alphaThreshold!==undefined)fail('Alpha threshold requires an image');width=integer(def.width,1,1024);height=integer(def.height,1,1024);
  if(!Array.isArray(def.data)||def.data.length!==Math.ceil(width*height/8))fail('Mask byte count must match dimensions');
  data=def.data.map((v:any)=>integer(v,0,255));const used=width*height%8;if(used&&((data.at(-1)??0)>>used))fail('Nonzero mask padding');
 }
 return {bytes:data.length,body:['data = {"size":Vector2i('+width+','+height+'),"data":PackedByteArray('+data.join(',')+')}']};
}
