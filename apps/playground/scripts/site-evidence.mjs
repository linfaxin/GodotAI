import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function sitePayloads(directory,prefix=''){
 const result={};
 for(const name of (await readdir(path.join(directory,prefix))).sort()){
  const relative=prefix+name,filename=path.join(directory,relative),info=await lstat(filename);
  if(info.isSymbolicLink())throw Error('E_SITE_SYMLINK: '+relative);
  if(info.isDirectory())Object.assign(result,await sitePayloads(directory,relative+'/'));
  else if(info.isFile()){const bytes=await readFile(filename);result[relative]={sha256:digest(bytes),bytes:bytes.length};}
 }
 return result;
}
export async function siteIdentity(directory){
 const releaseBytes=await readFile(path.join(directory,'engine-release.json')),release=JSON.parse(releaseBytes);
 const payloads=await sitePayloads(directory),siteHash=digest(canonical(payloads));
 const descriptorHash=digest(releaseBytes),candidateId=await siteCandidateId(directory,descriptorHash);
 return {profile:release.runtimeProfile,releaseId:release.id,descriptorHash,candidateId,siteHash,payloads};
}
export async function siteCandidateId(directory,fallback){
 try{return digest(await readFile(path.join(directory,'manifest.json')));}
 catch(error){if(error.code!=='ENOENT')throw error;return fallback;}
}

/** Compare executable workloads independently of build provenance. Commit,
 * report and candidate hashes remain in each report's unmodified identity. */
export async function performanceComparisonInputs(directory,{demos}={}){
 const fail=detail=>{throw Error('E_PERFORMANCE_MATERIAL: '+detail);};
 if(!Array.isArray(demos)||!demos.length||new Set(demos).size!==demos.length||demos.some(id=>typeof id!=='string'||!/^[-a-z0-9]+$/.test(id)))fail('demos');
 const read=async name=>{
  if(typeof name!=='string'||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('path');
  const filename=path.join(directory,name);if(!(await lstat(filename)).isFile())fail('file '+name);return readFile(filename);
 };
 const release=JSON.parse(await read('engine-release.json')),site=JSON.parse(await read('manifest.json')),demo=JSON.parse(await read('demo-release.json')),inputs={};
 const asset=async(key,descriptor)=>{
  if(!descriptor||!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||!/^([a-f0-9]{64})$/.test(descriptor.sha256))fail('descriptor '+key);
  const bytes=await read(descriptor.path);if(bytes.length!==descriptor.bytes||digest(bytes)!==descriptor.sha256)fail('bytes '+key);
  inputs[key]={sha256:descriptor.sha256,bytes:descriptor.bytes,...(descriptor.encoding?{encoding:descriptor.encoding,decodedSha256:descriptor.decodedSha256,decodedBytes:descriptor.decodedBytes}:{})};
 };
 if(release.schemaVersion!==2||site.runtimeProfile!==release.runtimeProfile||site.engineReleaseId!==release.id||demo.runtimeProfile!==release.runtimeProfile)fail('release');
 const target=site.engineTarget;if(!['template_debug','template_release'].includes(target))fail('native target');
 await asset('engine.javascript',release.engine?.javascript);await asset('engine.wasm',release.engine?.wasm);
 if(!Array.isArray(release.engine.worklets))fail('worklets');
 for(const [index,value]of release.engine.worklets.entries())await asset('engine.worklet.'+index,value);
 for(const mode of ['production','development'])await asset('sdk.vendor.'+mode,release.sdk?.vendors?.[mode]);
 if(!Object.keys(release.sdk?.runtimeModules??{}).length||!release.sdk.moduleExports||!release.sdk.moduleContract)fail('SDK runtime modules');
 for(const [specifier,value]of Object.entries(release.sdk.runtimeModules).sort(([a],[b])=>a.localeCompare(b)))await asset('sdk.module.'+specifier,value);
 const sdk=release.build?.sdkBuild;
 for(const [source,hash]of [['sourceInputs','sourceSnapshotHash'],['outputs','outputSnapshotHash']])if(!sdk?.[source]||!Object.keys(sdk[source]).length||!/^([a-f0-9]{64})$/.test(sdk[hash])||digest(canonical(sdk[source]))!==sdk[hash])fail('SDK proof '+hash);
 const api={};
 for(const naming of ['snake','camel']){
  const profile=release.api?.namingProfiles?.[naming];if(!profile?.actualAPIHash)fail('API '+naming);
  api[naming]={actualAPIHash:profile.actualAPIHash,bindingVersion:profile.bindingVersion,namingVersion:profile.namingVersion,codegenVersion:profile.codegenVersion};
  await asset('api.'+naming+'.declarations',profile.declarationsSnapshot);await asset('api.'+naming+'.types',profile.typeSnapshot);
 }
 const resourceBytes=await read('engine/game.pck');inputs['resources.enginePack']={sha256:digest(resourceBytes),bytes:resourceBytes.length};
 for(const name of ['runtime','resources','types'])await asset('demo.'+name,demo[name]);
 const catalog=JSON.parse(await read('catalog.json')),workloads={};
 for(const id of demos){
  const item=catalog.find(item=>item.id===id),project=JSON.parse(await read('examples/'+id+'.project.json'));
  if(typeof item?.source!=='string'||project.demoId!==id||project.engineProfile!==release.runtimeProfile||project.runtime!=='react'||!project.files?.[project.entry])fail('workload '+id);
  const {schemaVersion,engineProfile,demoApiVersion,runtime,demoId,entry,controls,mode}=project;
  // README is editor documentation and never compiled. Every executable or
  // configuration file, including project.godot/package.json, remains bound.
  const files=Object.fromEntries(Object.entries(project.files).filter(([name])=>name!=='/README.md'));
  workloads[id]=digest(canonical({catalogSource:item.source,schemaVersion,engineProfile,demoApiVersion,runtime,demoId,entry,controls,mode,files}));
 }
 const material={schemaVersion:1,kind:'godotjs-performance-material-v1',profile:release.runtimeProfile,target,engine:{version:release.engine.version,modules:release.engine.modules,runtimeFamily:release.runtimeFamily,runtimeAbi:release.runtimeAbi},sdk:{version:release.sdk.version,moduleExports:release.sdk.moduleExports,moduleContract:release.sdk.moduleContract,sourceSnapshotHash:sdk.sourceSnapshotHash,outputSnapshotHash:sdk.outputSnapshotHash},api,demo:{demoApiVersion:demo.demoApiVersion,assetIds:demo.assetIds},demos:[...demos],inputs,workloads};
 return {...material,sha256:digest(canonical(material))};
}
export function assertPerformanceComparable(baseline,current){
 for(const value of [baseline,current]){
  const {sha256,...material}=value??{};
  if(material.schemaVersion!==1||material.kind!=='godotjs-performance-material-v1'||!Object.keys(material.inputs??{}).length||!Object.keys(material.workloads??{}).length||digest(canonical(material))!==sha256)throw Error('E_PERFORMANCE_BASELINE_MATERIAL: missing or invalid material receipt');
 }
 if(canonical(baseline)!==canonical(current))throw Error('E_PERFORMANCE_BASELINE_MATERIAL: engine, SDK or executable workload differs');
}
