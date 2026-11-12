/** Official native Web build contracts. This module deliberately has no Node dependencies.
 * The public browser SDK still accepts consumer-defined profile strings. */
export const FULL_ENGINE_PROFILE='full-engine-v1';
export const ENGINE_2D_PROFILE='engine-2d-v1';
export const FULL_WEB_MODULE_BASELINE=Object.freeze([
  "GodotJS",
  "astcenc",
  "basis_universal",
  "bcdec",
  "bmp",
  "csg",
  "dds",
  "enet",
  "etcpak",
  "fbx",
  "freetype",
  "gdscript",
  "gltf",
  "godot_physics_2d",
  "godot_physics_3d",
  "gridmap",
  "hdr",
  "interactive_music",
  "jolt_physics",
  "jpg",
  "jsonrpc",
  "ktx",
  "mbedtls",
  "meshoptimizer",
  "mobile_vr",
  "mp3",
  "msdfgen",
  "multiplayer",
  "navigation_2d",
  "navigation_3d",
  "noise",
  "ogg",
  "regex",
  "svg",
  "text_server_adv",
  "text_server_fb",
  "tga",
  "theora",
  "tinyexr",
  "upnp",
  "vhacd",
  "vorbis",
  "webp",
  "webrtc",
  "websocket",
  "webxr",
  "zip"
]);

const threeModules=Object.freeze(['csg','fbx','gltf','godot_physics_3d','gridmap','jolt_physics','meshoptimizer','mobile_vr','navigation_3d','vhacd','webxr']);
export const ENGINE_2D_MODULE_BASELINE=Object.freeze(FULL_WEB_MODULE_BASELINE.filter(name=>!threeModules.includes(name)));
const profile=(id,label,modules,features,forbiddenModules=[],forbiddenClasses=[])=>Object.freeze({id,label,runtimeFamily:'native',audio:true,modules:Object.freeze(modules),requiredModules:Object.freeze(modules),allowedModules:Object.freeze([...modules,'objectdb_profiler']),forbiddenModules:Object.freeze(forbiddenModules),features:Object.freeze({disable_advanced_gui:false,disable_physics_2d:false,disable_navigation_2d:false,...features}),requiredClasses:Object.freeze(id===ENGINE_2D_PROFILE?['Node2D','Sprite2D','Control','Label','CharacterBody2D','NavigationAgent2D','TileMapLayer','AudioStreamPlayer']:[]),forbiddenClasses:Object.freeze(forbiddenClasses),demoIds:Object.freeze(id===ENGINE_2D_PROFILE?['shader','lights','match3','dungeon']:['shader','lights','islands','city','destruction','racing','match3','dungeon'])});
export const ENGINE_PROFILES=Object.freeze({
 [FULL_ENGINE_PROFILE]:profile(FULL_ENGINE_PROFILE,'完整 Godot Web 引擎',FULL_WEB_MODULE_BASELINE,{disable_3d:false,disable_physics_3d:false,disable_navigation_3d:false,disable_xr:false}),
 [ENGINE_2D_PROFILE]:profile(ENGINE_2D_PROFILE,'Godot 2D Web 引擎',ENGINE_2D_MODULE_BASELINE,{disable_3d:true,disable_physics_3d:true,disable_navigation_3d:true,disable_xr:true},threeModules,['Node3D','Camera3D','RigidBody3D','CharacterBody3D','NavigationAgent3D','GLTFDocument','GridMap']),
});
export function isEngineProfile(id){return typeof id==='string'&&Object.hasOwn(ENGINE_PROFILES,id);}
export function getEngineProfile(id=FULL_ENGINE_PROFILE){if(!isEngineProfile(id))throw Error('E_ENGINE_PROFILE: Unsupported official engine profile '+String(id));return ENGINE_PROFILES[id];}
export function engineBuildArgs({profile:profileId=FULL_ENGINE_PROFILE,target='template_debug',jobs=4,lto='none',moduleMode='baseline'}={}){
 const definition=getEngineProfile(profileId);
 if(!['template_debug','template_release'].includes(target))throw Error('E_BROWSER_TARGET: Only template_debug/template_release are supported');
 if(!['none','thin','full'].includes(lto))throw Error('E_BROWSER_LTO: Expected none, thin or full');
 if(!['baseline','explicit'].includes(moduleMode))throw Error('E_BROWSER_MODULE_MODE: Expected baseline or explicit');
 if(!Number.isSafeInteger(Number(jobs))||Number(jobs)<1||Number(jobs)>256)throw Error('E_BROWSER_JOBS: Invalid worker count');
 const args=['platform=web',`target=${target}`,'arch=wasm32','threads=no','dlink_enabled=no','use_quickjs_ng=no','skip_js_runtime=yes',`modules_enabled_by_default=${moduleMode==='explicit'?'no':'yes'}`,'module_GodotJS_enabled=yes','module_text_server_fb_enabled=yes','module_godotai_api_probe_enabled=no','opengl3=yes','vulkan=no','optimize=size','debug_symbols=no',`lto=${lto}`,'use_closure_compiler=no','tests=no'];
 if(lto==='thin')args.push(`linkflags=-Wl,--thinlto-jobs=${Number(jobs)}`);
 for(const [key,value]of Object.entries(definition.features))args.push(`${key}=${value?'yes':'no'}`);
 if(moduleMode==='explicit')for(const name of definition.modules)if(!['GodotJS','text_server_fb'].includes(name))args.push(`module_${name}_enabled=yes`);
 return [...args,`-j${Number(jobs)}`];
}
export function validateEngineProfile(profileId,{modules,features,classes}={}){
 const definition=getEngineProfile(profileId);
 if(!Array.isArray(modules)||!modules.length||new Set(modules).size!==modules.length)throw Error('E_ENGINE_MODULES: Missing or duplicate actual module list');
 const missing=definition.requiredModules.filter(name=>!modules.includes(name)),forbidden=modules.filter(name=>definition.forbiddenModules.includes(name)||!definition.allowedModules.includes(name));
 if(missing.length||forbidden.length)throw Error('E_ENGINE_MODULES: '+definition.id+' missing ['+missing.join(', ')+'] forbidden ['+forbidden.join(', ')+']');
 if(modules.some(name=>/godotai_api_probe|p0engineapiprobe/i.test(name)))throw Error('E_ENGINE_MODULES: Inspector cannot be released');
 if(features)for(const [name,expected]of Object.entries(definition.features))if(features[name]!==expected)throw Error('E_ENGINE_FEATURES: '+name+' does not match '+definition.id);
 if(classes){const names=new Set(classes.map(item=>typeof item==='string'?item:item.nativeName??item.name));const absent=definition.requiredClasses.filter(name=>!names.has(name)),present=definition.forbiddenClasses.filter(name=>names.has(name));if(absent.length||present.length)throw Error('E_ENGINE_CLASSES: missing ['+absent.join(', ')+'] forbidden ['+present.join(', ')+']');}
 return definition;
}
