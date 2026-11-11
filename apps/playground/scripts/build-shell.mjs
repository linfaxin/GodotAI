import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {catalog} from '../src/catalog.ts';
import {buildFrontend} from './build-frontend.mjs';
import {buildDemoRuntime} from './build-demo-runtime.mjs';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** Engine/SDK types are release inputs; demo helper types have their own descriptor. */
export async function createTypeSnapshot({engineFiles}={}){
 const types={};
 async function collect(directory,prefix,filter){for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const p=path.join(directory,entry.name),key=`${prefix}/${entry.name}`;if(entry.isDirectory())await collect(p,key,filter);else if(filter(entry.name))types[key]=await fs.readFile(p,'utf8');}}
 await collect(path.resolve(app,'../../scripts/jsb.react/dist'),'/sdk',name=>name.endsWith('.d.ts'));
 if(engineFiles)await collect(path.resolve(app,'../../scripts/jsb.react/dist'),'/engine-sdk',name=>name.endsWith('.d.ts'));
 await collect(path.dirname(fileURLToPath(import.meta.resolve('@types/react/package.json'))),'/react',name=>name.endsWith('.d.ts'));
 await collect(path.dirname(fileURLToPath(import.meta.resolve('typescript/lib/typescript.js'))),'/lib',name=>/^lib\..*\.d\.ts$/.test(name));
 if(engineFiles){
  for(const [name,source]of Object.entries(engineFiles)){
   if(!name.startsWith('/')||name.includes('..')||typeof source!=='string')throw Error('Invalid generated engine declaration '+name);
   types[name]=source;
  }
  for(const name of ['/godot/index.d.ts','/godot-jsb/index.d.ts','/godot.annotations/index.d.ts','/engine-sdk/engine.d.ts'])if(!types[name])throw Error('Missing full engine declaration '+name);
 }
 return JSON.stringify(types);
}
export async function writeTypeSnapshot(dist,options){
 if(!options){
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(dist,'engine-release.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(manifest){
   if(manifest.schemaVersion!==2||manifest.runtimeProfile!=='full-engine-v1')throw Error('Unsupported full engine descriptor');
   const snapshots=[];
   for(const [naming,profile]of Object.entries(manifest.api.namingProfiles??{snake:manifest.api})){
    const engineFiles=JSON.parse(await fs.readFile(path.join(dist,profile.declarationsSnapshot.path),'utf8'));
    const snapshot=await createTypeSnapshot({engineFiles});
    if(createHash('sha256').update(snapshot).digest('hex')!==profile.typeSnapshotHash)throw Error('Full engine '+naming+' type inputs changed; rebuild the complete playground release');
    const filename=profile.typeSnapshot.path;
    if(!['types.json','types.camel.json'].includes(filename))throw Error('Unsupported type snapshot path '+filename);
    snapshots.push({filename,snapshot});
   }
   const snake=snapshots.find(item=>item.filename==='types.json');
   if(!snake)throw Error('Full engine descriptor is missing the snake type snapshot');
   for(const {filename,snapshot}of snapshots)await fs.writeFile(path.join(dist,filename),snapshot);
   return snake.snapshot;
  }
 }
 const snapshot=await createTypeSnapshot(options);
 await fs.writeFile(path.join(dist,'types.json'),snapshot);return snapshot;
}
async function refreshSiteManifests(dist){
 for(const name of ['manifest.json']){
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(dist,name),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!manifest.payloads)continue;
  for(const asset of Object.keys(manifest.payloads)){
   const bytes=await fs.readFile(path.join(dist,asset));
   manifest.payloads[asset]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
  }
  await fs.writeFile(path.join(dist,name),JSON.stringify(manifest,null,2));
 }
}
export async function buildShell(dist=path.join(app,'dist')){
 await fs.mkdir(dist,{recursive:true});await fs.cp(path.join(app,'web'),dist,{recursive:true});
 const demos=await Promise.all(catalog.map(async demo=>({...demo,source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
 await fs.writeFile(path.join(dist,'catalog.json'),JSON.stringify(demos));
 await writeTypeSnapshot(dist);await buildDemoRuntime(dist);await buildFrontend(dist);await refreshSiteManifests(dist);
 let profile='full-engine-v1';
 try{const manifest=JSON.parse(await fs.readFile(path.join(dist,'engine-release.json'),'utf8'));profile=manifest.runtimeProfile;}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.writeFile(path.join(dist,'shell-profile.json'),JSON.stringify({schemaVersion:2,runtimeProfile:profile}));
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildShell();
