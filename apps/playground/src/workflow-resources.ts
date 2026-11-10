const fail=(m:string):never=>{throw Error('E_WORKFLOW_RESOURCE: '+m);};
const fields=(v:any,names:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Object.keys(v).some(k=>!names.includes(k)))fail('Unexpected fields');};
const num=(v:any,min:number,max:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number');return v as number;};
const color=(v:any)=>{fields(v,['r','g','b','a']);return 'Color('+['r','g','b','a'].map(k=>num(v[k],0,k==='a'?1:16)).join(',')+')';};
const bool=(v:any)=>typeof v==='boolean'?String(v):fail('Expected boolean');
const quote=JSON.stringify;
export const workflowResourceTypes=['StyleBoxTexture','StyleBoxEmpty','CodeHighlighter'];
export function serializeWorkflowResource(def:any,reference:(id:any,types:string[])=>string):string[]{
 fields(def,['type','properties']);const p=def.properties??{};const body:string[]=[];
 if(def.type==='CodeHighlighter'){
  const colors=['number_color','symbol_color','function_color','member_variable_color'];fields(p,[...colors,'keyword_colors','member_keyword_colors','color_regions']);
  for(const [key,value]of Object.entries(p)){if(colors.includes(key)){body.push(key+' = '+color(value));continue;}if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>(key==='color_regions'?32:256))fail('Highlighter map exceeds budget');const entries=Object.entries(value as Record<string,unknown>).map(([word,c])=>{if(key==='color_regions'){if(word.length>65||!/^\S{1,32}(?: \S{1,32})?$/.test(word)||/[\w\x00-\x1f]/.test(word))fail('Invalid region delimiters');}else if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(word))fail('Invalid keyword');return quote(word)+':'+color(c);});body.push(key+' = {'+entries.join(',')+'}');}return body;
 }
 const margins=['content_margin_left','content_margin_right','content_margin_top','content_margin_bottom'];const texture=['texture','region_rect','texture_margin_left','texture_margin_right','texture_margin_top','texture_margin_bottom','expand_margin_left','expand_margin_right','expand_margin_top','expand_margin_bottom','axis_stretch_horizontal','axis_stretch_vertical','draw_center','modulate_color'];fields(p,def.type==='StyleBoxEmpty'?margins:[...margins,...texture]);
 for(const [key,value]of Object.entries(p)){let v:string;if(key==='texture')v=reference(value,['Texture2D','ImageTexture','CompressedTexture2D','AtlasTexture','GradientTexture1D','GradientTexture2D','CurveTexture']);else if(key==='modulate_color')v=color(value);else if(key==='draw_center')v=bool(value);else if(key==='region_rect'){const r=value as any;fields(r,['position','size']);fields(r.position,['x','y']);fields(r.size,['x','y']);v='Rect2('+[r.position.x,r.position.y,r.size.x,r.size.y].map(n=>num(n,0,4096)).join(',')+')';}else if(key.startsWith('axis_stretch_')){const n=num(value,0,2);if(!Number.isInteger(n))fail('Expected enum');v=String(n);}else v=String(num(value,margins.includes(key)?-1:0,4096));body.push(key+' = '+v);}return body;
}
