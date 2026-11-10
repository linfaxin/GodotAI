const fail=(message:string):never=>{throw Error('E_INTERACTION_RESOURCE: '+message);};
const fields=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('Unexpected resource fields');};
const real=(v:any,min:number,max:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('Number out of range');return v as number;};
const integer=(v:any,min:number,max:number)=>{const n=real(v,min,max);if(!Number.isInteger(n))fail('Expected integer');return n;};
const bool=(v:any)=>{if(typeof v!=='boolean')fail('Expected boolean');return String(v);};
const vector=(v:any,nonnegative=false)=>{fields(v,['x','y','z']);return 'Vector3('+['x','y','z'].map(k=>real(v[k],nonnegative?0:-10000,10000)).join(',')+')';};
export const interactionResourceTypes=['CurveTexture','ParticleProcessMaterial','ButtonGroup','QuadMesh'];
export function serializeInteractionResource(def:any,reference:(id:any,types:string[])=>string):string[]{
 if(def.type==='CurveTexture'){fields(def,['type','curve','width']);return ['curve = '+reference(def.curve,['Curve']),'width = '+integer(def.width??256,2,4096)];}
 if(def.type==='ButtonGroup'){fields(def,['type','allowUnpress']);return ['allow_unpress = '+bool(def.allowUnpress??false)];}
 if(def.type==='QuadMesh'){fields(def,['type','size','material']);fields(def.size??{x:1,y:1},['x','y']);const size=def.size??{x:1,y:1};return ['size = Vector2('+real(size.x,.001,10000)+','+real(size.y,.001,10000)+')',...(def.material?['material = '+reference(def.material,['StandardMaterial3D','ShaderMaterial'])]:[])];}
 fields(def,['type','properties']);const props=def.properties??{};fields(props,['direction','gravity','spread','flatness','color','particle_flag_disable_z','emission_shape','emission_sphere_radius','emission_box_extents','emission_ring_axis','emission_ring_height','emission_ring_radius','emission_ring_inner_radius','initial_velocity_min','initial_velocity_max','scale_min','scale_max','angle_min','angle_max','angular_velocity_min','angular_velocity_max','linear_accel_min','linear_accel_max','damping_min','damping_max','scale_curve','angular_velocity_curve','linear_accel_curve','damping_curve','color_ramp','color_initial_ramp','angle_curve','radial_accel_min','radial_accel_max','radial_accel_curve','tangential_accel_min','tangential_accel_max','tangential_accel_curve','orbit_velocity_min','orbit_velocity_max','orbit_velocity_curve','hue_variation_min','hue_variation_max','hue_variation_curve','anim_speed_min','anim_speed_max','anim_speed_curve','anim_offset_min','anim_offset_max','anim_offset_curve']);
 const lines:string[]=['resource_local_to_scene = true'];for(const [key,value]of Object.entries(props)){
  if(['direction','gravity','emission_box_extents','emission_ring_axis'].includes(key)){if(['direction','emission_ring_axis'].includes(key)&&Math.hypot((value as any)?.x,(value as any)?.y,(value as any)?.z)<1e-8)fail('Zero direction');lines.push(key+' = '+vector(value,key==='emission_box_extents'));}
  else if(key==='color'){fields(value,['r','g','b','a']);lines.push(key+' = Color('+['r','g','b','a'].map(k=>real((value as any)[k],0,k==='a'?1:16)).join(',')+')');}
  else if(key==='particle_flag_disable_z')lines.push(key+' = '+bool(value));
  else if(key.endsWith('_curve'))lines.push(key+' = '+reference(value,['CurveTexture']));
  else if((key==='color_ramp'||key==='color_initial_ramp'))lines.push(key+' = '+reference(value,['GradientTexture1D']));
  else if(key==='emission_shape'){integer(value,0,6);if(![0,1,2,3,6].includes(value as number))fail('Point texture emission is outside this profile');lines.push(key+' = '+value);}
  else if(key.startsWith('anim_speed_'))lines.push(key+' = '+real(value,0,1000));
  else if(key.startsWith('anim_offset_'))lines.push(key+' = '+real(value,0,1));
  else if(key.startsWith('hue_variation_'))lines.push(key+' = '+real(value,-1,1));
  else if(key.startsWith('orbit_velocity_'))lines.push(key+' = '+real(value,-1000,1000));
  else lines.push(key+' = '+real(value,key==='spread'||key==='flatness'||key.startsWith('scale_')||key.startsWith('damping_')||key.startsWith('emission_')||key.startsWith('initial_velocity_')?0:-10000,key==='spread'?180:key==='flatness'?1:key.startsWith('scale_')?128:10000));
 }
 for(const key of ['initial_velocity','scale','angle','angular_velocity','linear_accel','damping','radial_accel','tangential_accel','orbit_velocity','hue_variation','anim_speed','anim_offset']){const defaults=key==='scale'?1:0;if(real(props[key+'_min']??defaults,-10000,10000)>real(props[key+'_max']??defaults,-10000,10000))fail('Particle minimum exceeds maximum');}
 if((props.emission_ring_inner_radius??0)>(props.emission_ring_radius??1))fail('Ring inner radius exceeds radius');return lines;
}
export function animationSettings(track:any,property?:string){
 const interpolation=integer(track.interpolation??(property==='visible'?0:1),0,property==='rotation'?4:2),updateMode=integer(track.updateMode??(property==='visible'?1:0),0,2);
 if(property==='visible'&&(interpolation!==0||updateMode!==1))fail('Visibility tracks require discrete nearest updates');return {interpolation,updateMode};
}
export const keyTransition=(value:any)=>real(value??1,-16,16);
export function animationLoopMode(animation:any):number{const mode=integer(animation.loopMode??(animation.loop?1:0),0,2);if(animation.loop!==undefined){bool(animation.loop);if(animation.loopMode!==undefined&&mode!==(animation.loop?1:0))fail('Conflicting loop and loopMode');}return mode;}
