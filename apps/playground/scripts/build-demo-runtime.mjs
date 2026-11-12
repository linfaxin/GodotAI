import {readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {packProject} from '@godot-js/react-browser/pck';
import {DEMO_API_VERSION,assertResourceManifest} from './profile-resources.mjs';
const app=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function unpackResources(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.getUint32(0,true)!==0x43504447||view.getUint32(4,true)!==3)throw Error('Expected Godot PCK v3');
 const base=Number(view.getBigUint64(24,true));let cursor=Number(view.getBigUint64(32,true)),count=view.getUint32(cursor,true);cursor+=4;
 const files=new Map();
 for(let index=0;index<count;index++){
  const length=view.getUint32(cursor,true);cursor+=4;
  const name=new TextDecoder().decode(bytes.subarray(cursor,cursor+length)).replace(/\0.*$/s,'');cursor+=length;
  const offset=base+Number(view.getBigUint64(cursor,true)),size=Number(view.getBigUint64(cursor+8,true));cursor+=36;
  if(offset<0||size<0||offset+size>bytes.length)throw Error('Invalid PCK entry');
  if(/^(?:assets\/|shaders\/|\.godot\/(?:imported|exported)\/)/.test(name)||name==='.godot/uid_cache.bin')files.set('res://'+name,bytes.slice(offset,offset+size));
 }
 return files;
}
export function verifyResourcePack(resources,{assets}){
 for(const [id,asset]of Object.entries(assets))if(![asset.uri,asset.uri+'.import',asset.uri+'.remap'].some(uri=>resources.has(uri)))throw Error('E_DEMO_RESOURCE_MISSING: '+id+' '+asset.uri);
 for(const [uri,bytes]of resources){
  if(!/\.(?:import|remap)$/.test(uri))continue;
  const source=new TextDecoder().decode(bytes);
  for(const match of source.matchAll(/(?:^|\n)path(?:\.[\w]+)?\s*=\s*"(res:\/\/[^"\n]+)"/g))if(!resources.has(match[1]))throw Error('E_DEMO_DEPENDENCY_MISSING: '+uri+' -> '+match[1]);
 }
}
export async function buildDemoRuntime(dist=path.join(app,'dist'),options={}){
 const runtimeProfile=options.runtimeProfile??'full-engine-v1',project=options.project??path.join(app,'project');
 const packFile=path.join(dist,'engine/game.pck'),resources=unpackResources(new Uint8Array(await readFile(packFile)));
 if(!resources.size)throw Error('The exported demo resource pack is empty');
 const generated=await readFile(path.join(project,'generated/assets.js'),'utf8');
 const assets=JSON.parse(/exports\.assets = (.*);/.exec(generated)[1]),models=JSON.parse(/exports\.models = (.*);/.exec(generated)[1]);
 assertResourceManifest({assets,models},runtimeProfile);verifyResourcePack(resources,{assets});
 resources.set('res://.playground/demo-manifest.json',new TextEncoder().encode(JSON.stringify({demoApiVersion:DEMO_API_VERSION,runtimeProfile,assets,models})));
 const pack=packProject(resources).pack;
 const result=await build({entryPoints:[path.join(app,'src/api.tsx')],bundle:true,write:false,platform:'neutral',format:'cjs',target:'es2022',external:['react','@godot-js/react/engine','godot','res://*'],define:{'process.env.NODE_ENV':'"production"'}});
 const runtime=new TextEncoder().encode(new TextDecoder().decode(result.outputFiles[0].contents)
  .replaceAll('require("react")','require("res://.godot/GodotJS/node_modules/react/index.js")')
  .replaceAll('require("@godot-js/react/engine")','require("res://.godot/GodotJS/node_modules/@godot-js/react/engine/index.js")'));
 const types=await readFile(path.join(app,'src/editor-api.d.ts'));
 const descriptor=(name,bytes)=>({path:name,bytes:bytes.length,sha256:sha(bytes)});
 const manifest={schemaVersion:1,demoApiVersion:DEMO_API_VERSION,runtimeProfile,assetIds:Object.keys(assets).sort(),runtime:descriptor('demo-runtime.js',runtime),resources:descriptor('demo-resources.pck',pack),types:descriptor('demo-api.d.ts',types)};
 await writeFile(path.join(dist,'demo-runtime.js'),runtime);await writeFile(path.join(dist,'demo-resources.pck'),pack);
 await writeFile(path.join(dist,'demo-api.d.ts'),types);
 await writeFile(path.join(dist,'demo-release.json'),JSON.stringify(manifest,null,2)+'\n');
 for(const name of ['runner.html','runner.js','runner.js.map','legacy-manifest.json','engine.json'])await rm(path.join(dist,name),{force:true});
 return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(await buildDemoRuntime());
