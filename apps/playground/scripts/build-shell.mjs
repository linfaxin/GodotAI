import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {catalog} from '../src/catalog.ts';
import {buildFrontend} from './build-frontend.mjs';
import {buildDemoRuntime} from './build-demo-runtime.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {profileCatalog,collectManifestPayloads} from './profile-resources.mjs';
import {invalidateSiteDelivery} from './site-delivery-state.mjs';
import {describeWorkerCandidate} from './worker-candidate.mjs';
import {assertWorkerRuntimeAbi} from '../../../scripts/release/engine-profiles.mjs';
import {assertWorkerSdkBuildFrozen} from './worker-sdk-proof.mjs';
import {assertGameProbeAssets,assertRuntimeCallAssets,digest,within} from '../../../scripts/release/web-release-utils.mjs';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repository=path.resolve(app,'../..');
/** Engine/SDK types are release inputs; demo helper types have their own descriptor. */
export async function createTypeSnapshot({engineFiles}={}){
 const types={};
 async function collect(directory,prefix,filter){for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const p=path.join(directory,entry.name),key=`${prefix}/${entry.name}`;if(entry.isDirectory())await collect(p,key,filter);else if(filter(entry.name))types[key]=await fs.readFile(p,'utf8');}}
 // Public routes advertise only modules produced by this engine vendor. Keep
 // their relative declaration dependencies without exposing legacy entrypoints.
 const sdkRoot=path.resolve(app,'../../scripts/jsb.react/dist'),available={};
 async function sdkDeclarations(directory,prefix){for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(directory,entry.name),relative=prefix+entry.name;if(entry.isDirectory())await sdkDeclarations(filename,relative+'/');else if(entry.name.endsWith('.d.ts'))available[relative]=await fs.readFile(filename,'utf8');}}
 await sdkDeclarations(sdkRoot,'');
 const {ENGINE_SDK_MODULES}=createRequire(path.join(sdkRoot,'../package.json'))('@godot-js/react/engine-modules');
 const visit=(virtualPath)=>{
  if(Object.hasOwn(types,virtualPath))return;
  const match=/^\/(sdk|engine-sdk)\/(.*)$/.exec(virtualPath);if(!match||typeof available[match[2]]!=='string')throw Error('Missing SDK declaration '+virtualPath);
  const source=available[match[2]];types[virtualPath]=source;
  const parsed=ts.preProcessFile(source,true,true);
  for(const dependency of [...parsed.importedFiles,...parsed.referencedFiles]){
   if(!dependency.fileName.startsWith('.'))continue;
   const base=path.posix.normalize(path.posix.join(path.posix.dirname(virtualPath),dependency.fileName)).replace(/\.(?:mjs|cjs|js)$/i,'');
   const candidate=[base,base+'.d.ts',base+'/index.d.ts'].find(name=>{const key=/^\/(?:sdk|engine-sdk)\/(.*)$/.exec(name)?.[1];return key&&Object.hasOwn(available,key);});
   if(!candidate)throw Error('Missing SDK declaration dependency '+dependency.fileName+' from '+virtualPath);visit(candidate);
  }
 };
 for(const entry of Object.values(ENGINE_SDK_MODULES))if(entry.scope==='engine'||entry.scope==='shared'){
  if(entry.declaration.startsWith('/sdk/')||entry.declaration.startsWith('/engine-sdk/'))visit(entry.declaration);
 }
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
   if(manifest.schemaVersion!==2)throw Error('Unsupported native engine descriptor');
   getEngineProfile(manifest.runtimeProfile);
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
  if(manifest.schemaVersion===3)manifest.runtime=await describeWorkerCandidate(dist,JSON.parse(await fs.readFile(path.join(dist,'engine-release.json'),'utf8')));
  manifest.payloads=await collectManifestPayloads(dist);
  await fs.writeFile(path.join(dist,name),JSON.stringify(manifest,null,2));
 }
}
export async function buildShell(dist,options={}){
 const shellOnly=options.shellOnly??process.env.PLAYGROUND_TEST_SHELL==='1';
 dist=dist??path.join(app,shellOnly?'dist-shell':options.runtimeProfile==='engine-2d-v1'?'dist-2d-debug':'dist');
 let existing;
 try{existing=JSON.parse(await fs.readFile(path.join(dist,'engine-release.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const runtimeProfile=options.runtimeProfile??existing?.runtimeProfile??'full-engine-v1';getEngineProfile(runtimeProfile);
 if(existing&&existing.runtimeProfile!==runtimeProfile)throw Error('Shell profile must match its exact engine release');
 if(shellOnly&&existing)throw Error('A shell-only fixture must use an output directory without an engine release');
 if(!shellOnly&&!existing)throw Error('A frontend refresh requires an existing engine release; use --shell-only for contract fixtures');
 if(!shellOnly){
  if((existing.execution??existing.engine?.execution)?.executionModel!=='proxy-pthread'){
   try{assertWorkerRuntimeAbi(existing.runtimeAbi);}catch{throw Error('E_EXECUTION_BACKEND_RETIRED: rebuild the complete playground as a Worker release before refreshing');}
  }
  if(existing.runtimeAbi?.runtimeCall!==undefined||existing.build?.runtimeCall!==undefined||existing.runtimeAbi?.gameProbe!==undefined||existing.build?.gameProbe!==undefined){
   const {javascript,wasm}=existing.engine;
   const [javascriptSha256,wasmSha256]=await Promise.all([javascript,wasm].map(async asset=>digest(await fs.readFile(within(dist,asset.path)))));
   assertRuntimeCallAssets(existing.runtimeAbi,existing.build?.runtimeCall,{javascriptSha256,wasmSha256});
   assertGameProbeAssets(existing.runtimeAbi,existing.build?.gameProbe,{javascriptSha256,wasmSha256});
  }
  await assertWorkerSdkBuildFrozen(repository,existing.build?.sdkBuild);
  const resourceBuild=JSON.parse(await fs.readFile(path.join(dist,'resource-build.json'),'utf8'));
  if(resourceBuild.runtimeProfile!==runtimeProfile||resourceBuild.engineReleaseId!==existing.id)throw Error('Resource build does not belong to this engine release');
  for(const [asset,expected]of [['engine/game.pck',resourceBuild.output?.sha256],['resource-inputs/generated/assets.js',resourceBuild.generatedManifest?.sha256]])if(createHash('sha256').update(await fs.readFile(path.join(dist,asset))).digest('hex')!==expected)throw Error('Resource refresh input changed: '+asset);
 }
 await fs.mkdir(dist,{recursive:true});await invalidateSiteDelivery(dist);await fs.cp(path.join(app,'web'),dist,{recursive:true});
 const demos=await Promise.all(profileCatalog(catalog,runtimeProfile).map(async demo=>({...demo,source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
 await fs.writeFile(path.join(dist,'catalog.json'),JSON.stringify(demos));
 await writeTypeSnapshot(dist);
 if(!shellOnly){
  // The retained exported PCK and generated resource map are immutable refresh
  // inputs. Copy the small manifest into the output instead of relying on a
  // mutable build-workspace directory surviving deployment.
  await buildDemoRuntime(dist,{project:path.join(dist,'resource-inputs'),runtimeProfile});
 }
 await buildFrontend(dist,undefined,{runtimeProfile,executionModel:(existing?.execution??existing?.engine?.execution)?.executionModel,...(existing?.engine?.host?{previewHost:existing.engine.host}:{})});
 await fs.writeFile(path.join(dist,'shell-profile.json'),JSON.stringify({schemaVersion:2,runtimeProfile,shellOnly}));
 if(!shellOnly)await assertWorkerSdkBuildFrozen(repository,existing.build.sdkBuild);
 await refreshSiteManifests(dist);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
 await buildShell(option('--out'),{runtimeProfile:option('--profile'),shellOnly:process.argv.includes('--shell-only')||process.env.PLAYGROUND_TEST_SHELL==='1'});
}
