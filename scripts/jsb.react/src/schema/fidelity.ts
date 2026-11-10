import type {HostSchema, PropertySchema, CommandSchema, SignalSchema} from './core';
import type {CodecName} from './codecs';

const p=(name:string,native:string,codec:CodecName,value:any,extra:Partial<PropertySchema>={}):PropertySchema=>({publicName:name,nativeName:native,accessName:native,codec,defaultValue:value,aliases:[name],...extra});
const n=(name:string,native:string,value:number,min:number,max:number)=>p(name,native,'number',value,{minimum:min,maximum:max});
const i=(name:string,native:string,value:number,min:number,max:number)=>p(name,native,'integer',value,{minimum:min,maximum:max});
const b=(name:string,native:string,value:boolean)=>p(name,native,'boolean',value);
const resource=(name:string,native:string,type:string)=>p(name,native,'assetRef',null,{resourceTypes:[type]});
const c=(name:string,native:string,args:CodecName[]=[],effects:string[]=[],result?:CodecName,phase:CommandSchema['phase']='process'):CommandSchema=>({publicName:name,nativeName:native,arguments:args,effects,phase,...(result?{result}:{})});
const signal=(name:string,native:string,parameters:CodecName[]=[],echo:SignalSchema['echo']='deliver'):SignalSchema=>({publicName:name,nativeName:native,parameters,echo});

export function extendFidelity(base:Readonly<Record<string,HostSchema>>):Readonly<Record<string,HostSchema>> {
 const out:Record<string,HostSchema>={...base};
 for(const [type,s] of Object.entries(out)) {
  // All public Control descendants share the same inheritance contract.
  if(s.properties.customMinimumSize)out[type]={...s,properties:{...s.properties,clipContents:b('clipContents','clip_contents',type==='ScrollContainer'),layoutDirection:i('layoutDirection','layout_direction',0,0,4),sizeFlagsStretchRatio:n('sizeFlagsStretchRatio','size_flags_stretch_ratio',1,.001,1024)},signals:{...s.signals,onResized:signal('onResized','resized',[],'suppress'),onMinimumSizeChanged:signal('onMinimumSizeChanged','minimum_size_changed',[],'suppress')}};
 }
 const animation=out.AnimationPlayer!;
 out.AnimationPlayer={...animation,commands:{...animation.commands,
  playSection:c('playSection','__react_fidelity_animation_section',['stringName','number','number','number','number','boolean'],['playback']),
  playSectionBackwards:c('playSectionBackwards','__react_fidelity_animation_backwards',['stringName','number','number','number'],['playback']),
  resetSection:c('resetSection','__react_fidelity_animation_reset',[],['playback']),
  hasSection:c('hasSection','has_section',[],[],'boolean'),getSectionStartTime:c('getSectionStartTime','get_section_start_time',[],[],'number'),getSectionEndTime:c('getSectionEndTime','get_section_end_time',[],[],'number'),getCurrentAnimationLength:c('getCurrentAnimationLength','get_current_animation_length',[],[],'number')
 },signals:{...animation.signals,onCurrentAnimationChanged:signal('onCurrentAnimationChanged','current_animation_changed',['stringName'])}};
 const camera=out.Camera2D!;
 out.Camera2D={...camera,properties:{...camera.properties,ignoreRotation:b('ignoreRotation','ignore_rotation',true),limitEnabled:b('limitEnabled','limit_enabled',true),limitSmoothed:b('limitSmoothed','limit_smoothed',false),anchorMode:i('anchorMode','anchor_mode',1,0,1)},commands:{...camera.commands,align:c('align','__react_fidelity_camera_align',[],['cameraSmoothing']),getScreenCenterPosition:c('getScreenCenterPosition','get_screen_center_position',[],[],'vector2'),getTargetPosition:c('getTargetPosition','get_target_position',[],[],'vector2'),isCurrent:c('isCurrent','is_current',[],[],'boolean')}};
 const camera3=out.Camera3D!;
 out.Camera3D={...camera3,commands:{...camera3.commands,projectPosition:c('projectPosition','__react_fidelity_camera_project',['vector2','number'],[],'vector3'),projectLocalRayNormal:c('projectLocalRayNormal','project_local_ray_normal',['vector2'],[],'vector3')}};
 const button=out.TextureButton!;
 out.TextureButton={...button,properties:{...button.properties,textureClickMask:resource('textureClickMask','texture_click_mask','BitMap')}};
 for(const d of [2,3]) {
  const type='CPUParticles'+d+'D',s=out[type]!,props:Record<string,PropertySchema>={colorInitialRamp:resource('colorInitialRamp','color_initial_ramp','Gradient')};
  for(const [publicName,native,min,max] of [['angle','angle',-3600,3600],['radialAccel','radial_accel',-10000,10000],['tangentialAccel','tangential_accel',-10000,10000],['orbitVelocity','orbit_velocity',-1000,1000],['hueVariation','hue_variation',-1,1]] as const) {
   props[publicName+'Min']=n(publicName+'Min',native+'_min',0,min,max);props[publicName+'Max']=n(publicName+'Max',native+'_max',0,min,max);props[publicName+'Curve']=resource(publicName+'Curve',native+'_curve','Curve');
  }
  out[type]={...s,properties:{...s.properties,...props}};
  const nav='NavigationAgent'+d+'D',agent=out[nav]!;
  out[nav]={...agent,properties:{...agent.properties,pathSearchMaxDistance:n('pathSearchMaxDistance','path_search_max_distance',0,0,1e6),pathSearchMaxPolygons:i('pathSearchMaxPolygons','path_search_max_polygons',4096,1,4096),pathReturnMaxRadius:n('pathReturnMaxRadius','path_return_max_radius',0,0,1e6)},commands:{...agent.commands,isTargetReached:c('isTargetReached','is_target_reached',[],[],'boolean','physics')}};
 }
 const polygon=out.Polygon2D!;
 out.Polygon2D={...polygon,properties:{...polygon.properties,vertexColors:p('vertexColors','vertex_colors','colorArray',[]),offset:p('offset','offset','vector2',{x:0,y:0}),textureOffset:p('textureOffset','texture_offset','vector2',{x:0,y:0}),textureRotation:n('textureRotation','texture_rotation',0,-10000,10000),textureScale:p('textureScale','texture_scale','vector2',{x:1,y:1}),invertEnabled:b('invertEnabled','invert_enabled',false),invertBorder:n('invertBorder','invert_border',100,0,10000)}};
 const line=out.Line2D!;
 out.Line2D={...line,properties:{...line.properties,sharpLimit:n('sharpLimit','sharp_limit',2,0,128),roundPrecision:i('roundPrecision','round_precision',8,1,64)}};
 // Every existing static texture consumer also accepts generated 2D gradients.
 for(const [type,s] of Object.entries(out)) {
  const properties={...s.properties};let changed=false;
  for(const [key,prop] of Object.entries(properties))if(prop.resourceTypes?.some(t=>t==='Texture2D'||t==='GradientTexture1D')){properties[key]={...prop,resourceTypes:[...new Set([...prop.resourceTypes,'GradientTexture2D'])]};changed=true;}
  if(changed)out[type]={...s,properties};
 }
 const freeze=(value:any):any=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};return freeze(out);
}
