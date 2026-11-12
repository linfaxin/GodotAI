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
