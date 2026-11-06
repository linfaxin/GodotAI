import type { CapabilityProfileV1 } from "../contracts";
import { HOST_SCHEMA, CORE_PROFILE, type PropertySchema, type HostSchema, type CommandSchema } from "./core";
import { CODEC_DEFINITIONS, type CodecName, type CodecValue } from "./codecs";

const v2=(x=0,y=0)=>Object.freeze({x,y});
const v3=(x=0,y=0,z=0)=>Object.freeze({x,y,z});
const white=Object.freeze({r:1,g:1,b:1,a:1});
const p=(publicName:string,nativeName:string,codec:CodecName,defaultValue:CodecValue,extra:Partial<PropertySchema>={}):PropertySchema=>Object.freeze({publicName,nativeName,accessName:nativeName,codec,defaultValue,aliases:Object.freeze([publicName]),...extra});
const resource=(name:string,native:string,types:string[])=>p(name,native,"assetRef",null,{resourceTypes:Object.freeze(types)});
const cmd=(publicName:string,nativeName:string,args:CodecName[],effects:string[],phase:CommandSchema["phase"]="process",result?:CodecName):CommandSchema=>Object.freeze({publicName,nativeName,arguments:Object.freeze(args),effects:Object.freeze(effects),phase,...(result?{result}:{})});
const host=(type:string,properties:Record<string,PropertySchema>,commands:Record<string,CommandSchema>={},visual=true):HostSchema=>Object.freeze({type,nativeType:type,properties:Object.freeze(properties),commands:Object.freeze(commands),signals:Object.freeze({}),intrinsicEngineOwned:Object.freeze([]),visual});
const name=HOST_SCHEMA.Node.properties.name;
const transform3d={
  name,position:p("position","position","vector3",v3(),{aliases:Object.freeze(["transform3d"])}),
  rotation:p("rotation","rotation","vector3",v3(),{aliases:Object.freeze(["transform3d"])}),
  scale:p("scale","scale","vector3",v3(1,1,1),{aliases:Object.freeze(["transform3d"])}),
  visible:p("visible","visible","boolean",true,{aliases:Object.freeze(["visibility"])}),
};
const transformCommands={
  setPosition3D:cmd("setPosition3D","set_position",["vector3"],["transform3d"]),
  setRotation3D:cmd("setRotation3D","set_rotation",["vector3"],["transform3d"]),
  setScale3D:cmd("setScale3D","set_scale",["vector3"],["transform3d"]),
};
const canvasMaterial=resource("material","material",["CanvasItemMaterial","ShaderMaterial"]);
export const SHOWCASE_HOST_SCHEMA:Readonly<Record<string,HostSchema>>=Object.freeze({
  ...HOST_SCHEMA,
  ColorRect:host("ColorRect",{...HOST_SCHEMA.Control.properties,material:canvasMaterial,
    position:p("position","position","vector2",v2()),size:p("size","size","vector2",v2()),color:p("color","color","color",white)},
    {setShaderFloat:cmd("setShaderFloat","set_instance_shader_parameter",["stringName","number"],["shaderParameters"])}),
  Sprite2D:host("Sprite2D",{...HOST_SCHEMA.Node2D.properties,material:canvasMaterial,texture:resource("texture","texture",["Texture2D"]),centered:p("centered","centered","boolean",true)}, {...HOST_SCHEMA.Node2D.commands}),
  CanvasModulate:host("CanvasModulate",{...HOST_SCHEMA.Node2D.properties,color:p("color","color","color",white)}),
  PointLight2D:host("PointLight2D",{...HOST_SCHEMA.Node2D.properties,texture:resource("texture","texture",["Texture2D"]),color:p("color","color","color",white),energy:p("energy","energy","number",1,{minimum:0,maximum:16}),textureScale:p("textureScale","texture_scale","number",1,{minimum:0.01,maximum:100}),shadowEnabled:p("shadowEnabled","shadow_enabled","boolean",false)}, {...HOST_SCHEMA.Node2D.commands}),
  LightOccluder2D:host("LightOccluder2D",{...HOST_SCHEMA.Node2D.properties,occluder:resource("occluder","occluder",["OccluderPolygon2D"])}),
  Node3D:host("Node3D",{...transform3d},{...transformCommands}),
  MeshInstance3D:host("MeshInstance3D",{...transform3d,mesh:resource("mesh","mesh",["Mesh"]),materialOverride:resource("materialOverride","material_override",["StandardMaterial3D"])},{...transformCommands}),
  Camera3D:host("Camera3D",{...transform3d,current:p("current","current","boolean",false),fov:p("fov","fov","number",75,{minimum:1,maximum:179}),projection:p("projection","projection","integer",0,{minimum:0,maximum:2}),size:p("size","size","number",1,{minimum:.01,maximum:1000})},{...transformCommands,
    projectRayOrigin:cmd("projectRayOrigin","project_ray_origin",["vector2"],[],"process","vector3"),projectRayNormal:cmd("projectRayNormal","project_ray_normal",["vector2"],[],"process","vector3")}),
  DirectionalLight3D:host("DirectionalLight3D",{...transform3d,lightColor:p("lightColor","light_color","color",white),lightEnergy:p("lightEnergy","light_energy","number",1,{minimum:0,maximum:16}),shadowEnabled:p("shadowEnabled","shadow_enabled","boolean",false)}),
  WorldEnvironment:host("WorldEnvironment",{name,environment:resource("environment","environment",["Environment"])},{},false),
  StaticBody3D:host("StaticBody3D",{...transform3d},{setPosition3D:cmd("setPosition3D","set_position",["vector3"],["transform3d"],"physics")}),
  CollisionShape3D:host("CollisionShape3D",{...transform3d,shape:resource("shape","shape",["BoxShape3D","CapsuleShape3D","SphereShape3D","ConvexPolygonShape3D"]),disabled:p("disabled","disabled","boolean",false)}),
  RigidBody3D:host("RigidBody3D",{...transform3d,
    mass:p("mass","mass","number",1,{minimum:.001,maximum:10000}),linearVelocity:p("linearVelocity","linear_velocity","vector3",v3()),angularVelocity:p("angularVelocity","angular_velocity","vector3",v3()),gravityScale:p("gravityScale","gravity_scale","number",1,{minimum:0,maximum:10}),linearDamp:p("linearDamp","linear_damp","number",0,{minimum:0,maximum:100}),angularDamp:p("angularDamp","angular_damp","number",0,{minimum:0,maximum:100}),freeze:p("freeze","freeze","boolean",false),sleeping:p("sleeping","sleeping","boolean",false),collisionLayer:p("collisionLayer","collision_layer","integer",1,{minimum:0,maximum:0xffffffff}),collisionMask:p("collisionMask","collision_mask","integer",1,{minimum:0,maximum:0xffffffff})},
    {setPosition3D:cmd("setPosition3D","set_position",["vector3"],["transform3d"],"physics"),setLinearVelocity:cmd("setLinearVelocity","set_linear_velocity",["vector3"],["linearVelocity"],"physics"),setAngularVelocity:cmd("setAngularVelocity","set_angular_velocity",["vector3"],["angularVelocity"],"physics"),applyCentralImpulse:cmd("applyCentralImpulse","apply_central_impulse",["vector3"],["linearVelocity","sleeping"],"physics"),applyCentralForce:cmd("applyCentralForce","apply_central_force",["vector3"],["linearVelocity","sleeping"],"physics")}),
  RayCast3D:host("RayCast3D",{...transform3d,enabled:p("enabled","enabled","boolean",true),targetPosition:p("targetPosition","target_position","vector3",v3(0,-1,0)),excludeParent:p("excludeParent","exclude_parent","boolean",true),collisionMask:p("collisionMask","collision_mask","integer",1,{minimum:0,maximum:0xffffffff})},
    {setPosition3D:cmd("setPosition3D","set_position",["vector3"],["transform3d"],"physics"),forceUpdate:cmd("forceUpdate","force_raycast_update",[],["rayQuery"],"physics"),isColliding:cmd("isColliding","is_colliding",[],[],"physics","boolean"),getCollisionNormal:cmd("getCollisionNormal","get_collision_normal",[],[],"physics","vector3")}),
  CharacterBody3D:host("CharacterBody3D",{...transform3d,velocity:p("velocity","velocity","vector3",v3())},{
    setPosition3D:cmd("setPosition3D","set_position",["vector3"],["transform3d"],"physics"),
    setVelocity3D:cmd("setVelocity3D","set_velocity",["vector3"],["velocity"],"physics"),
    moveAndSlide:cmd("moveAndSlide","move_and_slide",[],["transform3d","velocity"],"physics","boolean"),
    isOnFloor:cmd("isOnFloor","is_on_floor",[],[],"physics","boolean"),
  }),
  AudioStreamPlayer:host("AudioStreamPlayer",{name,stream:resource("stream","stream",["AudioStream"]),volumeDb:p("volumeDb","volume_db","number",0,{minimum:-80,maximum:6})},{play:cmd("play","play",["number"],["playback"])},false),
});
export const SHOWCASE_PROFILE:CapabilityProfileV1=Object.freeze({...CORE_PROFILE,id:"showcase-v1",hosts:Object.freeze(Object.keys(SHOWCASE_HOST_SCHEMA)),codecs:Object.freeze([...CORE_PROFILE.codecs,"vector3"]),resources:Object.freeze([...CORE_PROFILE.resources,"Texture2D","ShaderMaterial","Mesh","StandardMaterial3D","Environment","OccluderPolygon2D","BoxShape3D","CapsuleShape3D","SphereShape3D","ConvexPolygonShape3D","AudioStream"]),features:Object.freeze({...CORE_PROFILE.features,physics:true})});
export const SHOWCASE_SCHEMA_DESCRIPTOR=Object.freeze({profile:SHOWCASE_PROFILE,hosts:SHOWCASE_HOST_SCHEMA,codecs:Object.freeze({...CODEC_DEFINITIONS,vector3:Object.freeze({fields:Object.freeze(["x","y","z"]),component:"number"})})});
/** SHA-256 of canonicalJson(SHOWCASE_SCHEMA_DESCRIPTOR), checked by the profile tests. */
export const SHOWCASE_PROFILE_HASH="b9a864961509bb1cdcdeaf331e026d3dccf61ca705bd451dc38fe07e2463929e";
