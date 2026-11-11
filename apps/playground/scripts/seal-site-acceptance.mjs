import {readFile,writeFile,readdir,lstat,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical} from './full-engine-release.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function files(directory,prefix=''){
 const result={};
 for(const name of (await readdir(path.join(directory,prefix))).sort()){
  const relative=prefix+name,filename=path.join(directory,relative),info=await lstat(filename);
  if(info.isSymbolicLink())throw Error('E_SITE_SYMLINK: '+relative);
  if(info.isDirectory())Object.assign(result,await files(directory,relative+'/'));
  else if(info.isFile()){const bytes=await readFile(filename);result[relative]={sha256:digest(bytes),bytes:bytes.length};}
 }
 return result;
}
export async function sealSiteAcceptance(directory,reports,{verify=false,begin=false}={}){
 directory=path.resolve(directory);reports=path.resolve(reports);
 const release=await json(path.join(directory,'engine-release.json'));
 if(release.schemaVersion!==2||release.runtimeProfile!=='full-engine-v1')throw Error('E_SITE_PROFILE');
 const identity=structuredClone(release);delete identity.id;delete identity.verifiedRelease.releaseId;
 if(digest(canonical(identity))!==release.id)throw Error('E_SITE_RELEASE_ID');
 const sources={};
 for(const [mapName,entry]of [['main.js.map','apps/playground/src/main.ts'],['compiler.worker.js.map','apps/playground/src/compiler.worker.ts'],['preview.js.map','apps/playground/preview.ts']]){
  const map=await json(path.join(directory,mapName)),expected=await readFile(path.join(repo,entry),'utf8');
  const suffix=entry.includes('/src/')?'src/'+path.basename(entry):path.basename(entry);
  // Embedded source identity remains valid when the immutable site is moved
  // from a CI staging directory into an artifact or another serving directory.
  const index=map.sources.findIndex((source,index)=>source.replaceAll('\\','/').endsWith('/'+suffix)&&map.sourcesContent?.[index]===expected);
  if(index<0)throw Error('E_SITE_ENTRY: '+entry);
  sources[entry]=digest(map.sourcesContent[index]);
 }
 const payloads=await files(directory);
 for(const [name,asset]of Object.entries(release.payloads))if(payloads[name]?.sha256!==asset.sha256||payloads[name]?.bytes!==asset.bytes)throw Error('E_SITE_PAYLOAD: '+name);
 const candidate={schemaVersion:1,application:'default-playground',releaseId:release.id,sources,siteHash:digest(canonical(payloads)),payloads};
 const start=path.join(reports,'site-start.json');
 if(begin){await mkdir(reports,{recursive:true});await writeFile(start,JSON.stringify(candidate,null,2)+'\n');return {status:'prepared',releaseId:release.id,siteHash:candidate.siteHash,files:Object.keys(payloads).length};}
 if(canonical(await json(start))!==canonical(candidate))throw Error('E_SITE_TEST_INPUT_DRIFT');
 const started=(await stat(start)).mtimeMs;
 const evidence={};
 for(const name of ['runtime','editor','bridge','projects','react-demos','workbench']){
  if((await stat(path.join(reports,name+'.json'))).mtimeMs<started)throw Error('E_SITE_STALE_EVIDENCE: '+name);
  const bytes=await readFile(path.join(reports,name+'.json')),result=JSON.parse(bytes);
  if(result.status!=='passed'||(['runtime','editor','bridge'].includes(name)&&result.releaseId!==release.id))throw Error('E_SITE_ACCEPTANCE: '+name);
  evidence[name]={sha256:digest(bytes),bytes:bytes.length};
 }
 const receipt={...candidate,status:'passed',evidence};
 const filename=path.join(reports,'site-acceptance.json');
 if(verify){if(canonical(await json(filename))!==canonical(receipt))throw Error('E_SITE_ACCEPTANCE_DRIFT');}
 else{await mkdir(reports,{recursive:true});await writeFile(filename,JSON.stringify(receipt,null,2)+'\n');}
 return {status:'passed',releaseId:release.id,siteHash:receipt.siteHash,files:Object.keys(payloads).length,receipt:filename};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [directory,reports,...flags]=process.argv.slice(2);
 if(!directory||!reports)throw Error('Usage: seal-site-acceptance.mjs <site> <reports> [--begin|--verify]');
 console.log(JSON.stringify(await sealSiteAcceptance(directory,reports,{verify:flags.includes('--verify'),begin:flags.includes('--begin')}),null,2));
}
