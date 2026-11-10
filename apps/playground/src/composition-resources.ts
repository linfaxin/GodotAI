const fail=(message:string):never=>{throw Error('E_COMPOSITION_RESOURCE: '+message);};
const fields=(v:any,allowed:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('Unexpected fields');};
const number=(v:any,min:number,max:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Invalid number: out of range');return v as number;};
const integer=(v:any,min:number,max:number)=>{const n=number(v,min,max);if(!Number.isInteger(n))fail('Expected integer');return n;};
const color=(v:any,alphaMaximum=1)=>{fields(v,['r','g','b','a']);return 'Color('+['r','g','b','a'].map(k=>number(v[k],0,k==='a'?alphaMaximum:16)).join(',')+')';};
const bool=(v:any)=>typeof v==='boolean'?String(v):fail('Expected boolean');
const vector=(v:any)=>{fields(v,['x','y','z']);return 'Vector3('+['x','y','z'].map(k=>number(v[k],-10000,10000)).join(',')+')';};
const textures=['Texture2D','ImageTexture','CompressedTexture2D','AtlasTexture','GradientTexture1D','GradientTexture2D','CurveTexture'];
export const compositionResourceTypes=['Sky','ProceduralSkyMaterial','PanoramaSkyMaterial','Environment'];
export function serializeCompositionResource(def:any,reference:(id:any,types:string[])=>string):{body:string[];bytes:number} {
 fields(def,['type','properties']);const props=def.properties??{};let bytes=0;const body:string[]=[];
 if(def.type==='Sky'){
  fields(props,['sky_material','radiance_size','process_mode']);const size=integer(props.radiance_size??2,0,2);bytes=2*6*Math.pow(32*Math.pow(2,size),2)*8*4/3;
  body.push('radiance_size = '+size,'process_mode = '+integer(props.process_mode??0,0,3));if(props.sky_material!==undefined)body.push('sky_material = '+reference(props.sky_material,['ProceduralSkyMaterial','PanoramaSkyMaterial']));return {body,bytes};
 }
 let rules:Record<string,[string,number?,number?]>;
 if(def.type==='ProceduralSkyMaterial')rules={sky_top_color:['color'],sky_horizon_color:['color'],ground_bottom_color:['color'],ground_horizon_color:['color'],sky_curve:['number',0,1],ground_curve:['number',0,1],sky_energy_multiplier:['number',0,16],ground_energy_multiplier:['number',0,16],energy_multiplier:['number',0,16],sun_angle_max:['number',0,360],sun_curve:['number',0,1],sky_cover:['texture'],sky_cover_modulate:['color'],use_debanding:['bool']};
 else if(def.type==='PanoramaSkyMaterial')rules={panorama:['texture'],energy_multiplier:['number',0,16],filter:['bool']};
 else if(def.type==='Environment')rules={background_mode:['int',0,4],background_color:['color'],background_energy_multiplier:['number',0,16],ambient_light_source:['int',0,3],ambient_light_color:['color'],ambient_light_energy:['number',0,16],ambient_light_sky_contribution:['number',0,1],reflected_light_source:['int',0,2],tonemap_mode:['int',0,3],tonemap_exposure:['number',0,16],sky:['sky'],sky_rotation:['vector'],sky_custom_fov:['number',0,179],fog_enabled:['bool'],fog_light_color:['color'],fog_light_energy:['number',0,16],fog_density:['number',0,16],fog_mode:['int',0,1],fog_depth_begin:['number',0,1e6],fog_depth_end:['number',0,1e6],fog_depth_curve:['number',0,16],fog_height:['number',-1e5,1e5],fog_height_density:['number',-16,16],fog_aerial_perspective:['number',0,1],fog_sky_affect:['number',0,1],fog_sun_scatter:['number',0,1]};
 else return fail('Unsupported resource type');
 fields(props,Object.keys(rules));if(def.type==='Environment'&&props.fog_depth_end!==undefined&&props.fog_depth_end!==0&&props.fog_depth_end<(props.fog_depth_begin??0))fail('Fog end must be zero or >= begin');
 for(const [key,value]of Object.entries(props)){const [rule,min,max]=rules[key]!;let encoded:string;if(rule==='color')encoded=color(value,def.type==='Environment'?16:1);else if(rule==='bool')encoded=bool(value);else if(rule==='int')encoded=String(integer(value,min!,max!));else if(rule==='number')encoded=String(number(value,min!,max!));else if(rule==='vector')encoded=vector(value);else encoded=reference(value,rule==='sky'?['Sky']:textures);body.push(key+' = '+encoded);}
 return {body,bytes};
}
