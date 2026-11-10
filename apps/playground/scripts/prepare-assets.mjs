import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const repo=path.resolve(app,"../.."),project=path.join(app,"project");
const run=(bin,args)=>{const r=spawnSync(bin,args,{encoding:"utf8",maxBuffer:16*1024*1024});const errors=(r.stderr??'').split('\n').filter(line=>/^(?:ERROR|SCRIPT ERROR):/.test(line)&&line!=='ERROR: Godot was compiled without fontconfig, system font support is disabled.');if(r.status!==0||errors.length)throw Error(`${bin} failed (${r.status})\n${r.stdout}\n${r.stderr}`);return r.stdout;};
export async function prepareAssets(){
  const sources=JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"));
  for(const source of sources){const data=await fs.readFile(path.join(app,source.local));if(createHash("sha256").update(data).digest("hex")!==source.sha256)throw Error(`Upstream asset checksum mismatch: ${source.local}`);}
  const temp=path.join(repo,"work/playground/asset-project"),derived=path.join(project,"assets/derived");
  await fs.mkdir(temp,{recursive:true});await fs.mkdir(derived,{recursive:true});
  await fs.writeFile(path.join(temp,"project.godot"),'config_version=5\n[application]\nconfig/name="Playground asset conversion"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await fs.cp(path.join(app,"third-party/kenney/models"),path.join(temp,"models"),{recursive:true});
  for(const name of ["city","racing"])await fs.cp(path.join(app,`third-party/${name}/models`),path.join(temp,name),{recursive:true});
  await fs.cp(path.join(app,"third-party/destruction/cube"),path.join(temp,"destruction"),{recursive:true});
  const models=[...["character","platform","platform-falling","coin","cloud","flag"].map(id=>({id,source:`models/${id}.glb`,offsetY:id==="platform"?-.55:id==="platform-falling"?-.5:0})),
    ...["building-small-a","building-small-b","building-small-c","building-garage","grass","grass-trees","road-straight","road-corner","road-intersection","pavement-fountain"].map(name=>({id:`city-${name}`,source:`city/${name}.glb`})),
    ...["track-straight","track-corner","track-finish","decoration-forest"].map(name=>({id:`race-${name}`,source:`racing/${name}.glb`})),
    {id:"race-car",source:"racing/vehicle-truck-red.glb",parts:true},
    {id:"shards",source:"destruction/cube_fragments.glb",parts:true,collision:true,strictTexture:false}];
  await fs.writeFile(path.join(temp,"models.json"),JSON.stringify(models));
  await fs.copyFile(path.join(app,"scripts/extract-assets.gd"),path.join(temp,"extract.gd"));
  // Reimport the full source graph, including newly added external GLB textures.
  await fs.rm(path.join(temp,".godot"),{recursive:true,force:true});
  const godot=process.env.GODOT_IMPORTER??"godot";
  run(godot,["--headless","--editor","--path",temp,"--import"]);
  console.log(run(godot,["--headless","--path",temp,"--script","res://extract.gd","--",derived]));
  const assets={};
  for(const {id,parts} of models)if(!parts)assets[id]={uri:`res://assets/derived/${id}.res`,type:"Mesh"};
  const parts=JSON.parse(await fs.readFile(path.join(derived,"models.json"),"utf8"));
  for(const group of Object.values(parts))for(const part of group){assets[part.id]={uri:`res://assets/derived/${part.id}.res`,type:"Mesh"};if(part.shapeId)assets[part.shapeId]={uri:`res://assets/derived/${part.shapeId}.res`,type:"ConvexPolygonShape3D"};}
  for(const name of ["gem","godot","grass","kenney","spikes"]){const id=`tile-${name}`;await fs.copyFile(path.join(app,`third-party/match3/sprites/tiles/${id}.png`),path.join(derived,`${id}.png`));assets[id]={uri:`res://assets/derived/${id}.png`,type:"Texture2D"};}
  for(const [id,file] of Object.entries({light:"2d/lights_and_shadows/light.png",floor:"2d/lights_and_shadows/background.png",godotea:"2d/sprite_shaders/godotea.png"})){
    await fs.copyFile(path.join(app,"third-party/godot",file),path.join(derived,`${id}.png`));assets[id]={uri:`res://assets/derived/${id}.png`,type:"Texture2D"};
  }
  for(const sound of ["jump","land","coin"]){await fs.copyFile(path.join(app,"third-party/kenney/sounds",`${sound}.ogg`),path.join(derived,`${sound}.ogg`));assets[`sound-${sound}`]={uri:`res://assets/derived/${sound}.ogg`,type:"AudioStream"};}
  const resources={
    "platform-shape":['BoxShape3D','size = Vector3(3, 0.6, 3)'],
    "player-shape":['CapsuleShape3D','radius = 0.25\nheight = 1.1'],
    "sphere-shape":['SphereShape3D','radius = 0.65'],
    "floor-shape":['BoxShape3D','size = Vector3(60, 0.5, 60)'],
    "floor-mesh":['BoxMesh','size = Vector3(60, 0.5, 60)'],
    "box-mesh":['BoxMesh','size = Vector3(1, 1, 1)'],
    "tile-shape":['BoxShape3D','size = Vector3(10, 0.4, 10)'],
    "unit-shape":['BoxShape3D','size = Vector3(1, 1, 1)'],
    occluder:['OccluderPolygon2D','polygon = PackedVector2Array(-30, -30, 30, -30, 30, 30, -30, 30)'],
    sky:['Environment','background_mode = 1\nbackground_color = Color(0.42, 0.72, 0.82, 1)\nambient_light_source = 3\nambient_light_color = Color(0.72, 0.84, 1, 1)\nambient_light_energy = 0.65\ntonemap_mode = 0'],
  };
  for(const [name,rgba] of Object.entries({mint:[.22,.65,.48,1],violet:[.52,.35,.85,1],gold:[1,.62,.16,1],dark:[.12,.16,.22,1],stone:[.35,.42,.5,1],ghost:[.4,1,.75,.45]}))resources[`material-${name}`]=['StandardMaterial3D',`albedo_color = Color(${rgba.join(', ')})\nroughness = 0.8\n${rgba[3]<1?'transparency = 1\n':''}`];
  for(const [id,[type,body]] of Object.entries(resources)){await fs.writeFile(path.join(derived,`${id}.tres`),`[gd_resource type="${type}" format=3]\n\n[resource]\n${body}\n`);assets[id]={uri:`res://assets/derived/${id}.tres`,type:type.endsWith("Mesh")?"Mesh":type};}
  for(const [index,name] of ["plasma","portal","hologram"].entries()){
    const image=index===2?'[ext_resource type="Texture2D" path="res://assets/derived/godotea.png" id="2"]\n':"";
    await fs.writeFile(path.join(derived,`shader-${index}.tres`),`[gd_resource type="ShaderMaterial" load_steps=${index===2?3:2} format=3]\n[ext_resource type="Shader" path="res://shaders/${name}.gdshader" id="1"]\n${image}\n[resource]\nshader = ExtResource("1")\n${index===2?'shader_parameter/image = ExtResource("2")\n':""}`);
    assets[`shader-${index}`]={uri:`res://assets/derived/shader-${index}.tres`,type:"ShaderMaterial"};
  }
  await fs.mkdir(path.join(project,"generated"),{recursive:true});
  await fs.writeFile(path.join(project,"generated/assets.js"),`exports.assets = ${JSON.stringify(assets)};\nexports.models = ${JSON.stringify(parts)};\n`);
  await fs.writeFile(path.join(project,"asset-hub.tres"),`[gd_resource type="Resource" load_steps=${Object.keys(assets).length+1} format=3]\n${Object.entries(assets).map(([id,a])=>`[ext_resource type="${a.type}" path="${a.uri}" id="${id}"]`).join("\n")}\n[resource]\nmetadata/assets = [${Object.keys(assets).map(id=>`ExtResource("${id}")`).join(", ")}]\n`);
  return assets;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await prepareAssets();
