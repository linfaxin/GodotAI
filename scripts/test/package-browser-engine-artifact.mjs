#!/usr/bin/env node
import {readFile,writeFile,copyFile,mkdir,mkdtemp,rename,rm,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical,digest,options,required,safePath} from '../release/web-release-utils.mjs';
import {isSourceCertified} from '../release/engine-build-proof.mjs';
import {browserEnginePaths} from '../release/browser-engine-artifacts.mjs';

const json=async filename=>JSON.parse(await readFile(filename,'utf8'));
async function regular(filename){const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw Error('E_ENGINE_ARTIFACT_FILE: '+filename);return info;}
async function atomicCopy(source,destination){await mkdir(path.dirname(destination),{recursive:true});const temp=destination+'.'+randomUUID()+'.tmp';try{await copyFile(source,temp);await rename(temp,destination);}finally{await rm(temp,{force:true});}}
async function atomicJson(destination,value){await mkdir(path.dirname(destination),{recursive:true});const temp=destination+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,destination);}finally{await rm(temp,{force:true});}}

/** A published report references its immutable ZIP; the matching compiler log
 * can live there even after the original build machine has disappeared. */
async function readBuildLog(reportFile,template,expectedHash){
 if(!expectedHash)return undefined;
 const candidates=new Set([reportFile+'.log',path.join(path.dirname(reportFile),'build.log'),path.join(path.dirname(template),'build.log')]);
 for(const filename of candidates){
  try{await regular(filename);const bytes=await readFile(filename);if(digest(bytes)===expectedHash)return {filename,bytes};}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 throw Error('E_ENGINE_ARTIFACT_LOG');
}

// Resolve existing parent aliases without creating directories or following a
// destination write. This also catches an output reached through a symlinked
// parent that would otherwise replace an input under a different path string.
async function physicalPath(filename){
 let parent=path.resolve(filename);const missing=[];
 for(;;){
  try{return path.join(await realpath(parent),...missing);}
  catch(error){if(error.code!=='ENOENT')throw error;const next=path.dirname(parent);if(next===parent)throw error;missing.unshift(path.basename(parent));parent=next;}
 }
}
const overlaps=(left,right)=>left===right||left.startsWith(right+path.sep)||right.startsWith(left+path.sep);
async function assertPublicationPaths(inputs,outputs,artifact){
 const inputPaths=await Promise.all(inputs.map(physicalPath)),outputPaths=await Promise.all(outputs.map(physicalPath)),artifactPath=await physicalPath(artifact);
 if(overlaps(outputPaths[0],outputPaths[1])||outputPaths.some(output=>overlaps(output,artifactPath)||inputPaths.some(input=>overlaps(output,input))))throw Error('E_ENGINE_ARTIFACT_OUTPUT: publication overlaps an input or immutable artifact');
}

/** Preserve original report bytes. The portable view changes template.path
 * only; its mapping and both report hashes are independently checked. */
export async function inspectBrowserEngineArtifact(directory){
 directory=path.resolve(directory);const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('E_ENGINE_ARTIFACT_DIRECTORY');await regular(path.join(directory,'artifact.json'));
 const manifest=await json(path.join(directory,'artifact.json'));
 if(manifest.schemaVersion!==1||manifest.kind!=='godotjs-browser-engine-artifact')throw Error('E_ENGINE_ARTIFACT_MANIFEST');
 for(const name of ['engine-report.json','engine-report.original.json','engine-template.zip'])if(!manifest.files?.[name])throw Error('E_ENGINE_ARTIFACT_MANIFEST: '+name);
 for(const [name,expected]of Object.entries(manifest.files)){
  safePath(name);const filename=path.join(directory,name);await regular(filename);const bytes=await readFile(filename);
  if(digest(bytes)!==expected.sha256||bytes.length!==expected.bytes)throw Error('E_ENGINE_ARTIFACT_INTEGRITY: '+name);
 }
 const report=await json(path.join(directory,'engine-report.json')),original=await json(path.join(directory,'engine-report.original.json'));
 const normalized=structuredClone(original);normalized.template.path='engine-template.zip';
 if(canonical(normalized)!==canonical(report)||report.template.path!=='engine-template.zip'||report.template.sha256!==manifest.files['engine-template.zip'].sha256||manifest.sourceReportSha256!==manifest.files['engine-report.original.json'].sha256)throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
 if(manifest.files['engine-report.published.json']){
  const published=await json(path.join(directory,'engine-report.published.json'));
  if(typeof published.template?.path!=='string')throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
  published.template.path='engine-template.zip';
  if(canonical(published)!==canonical(report))throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
 }
 if(manifest.runtimeProfile!==report.runtimeProfile||manifest.target!==report.engineTarget||manifest.recipeSha256!==report.recipeSha256)throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
 if(!manifest.development&&(!report.sourceCertified||!isSourceCertified(report)))throw Error('E_ENGINE_ARTIFACT_SOURCE');
 if(report.logSha256&&manifest.files['build.log']?.sha256!==report.logSha256)throw Error('E_ENGINE_ARTIFACT_LOG');
 return {status:'verified',directory,manifest,report};
}

export async function packageBrowserEngineArtifact({report:reportFile,out,development=false,publishedReport}){
 reportFile=path.resolve(required(reportFile,'--report'));out=path.resolve(required(out,'--out'));
 await regular(reportFile);const originalBytes=await readFile(reportFile),original=JSON.parse(originalBytes);
 if(original.kind!=='godot-js-browser-engine-build'||!['built',...(development?['existing-development']:[])].includes(original.status))throw Error('E_ENGINE_ARTIFACT_REPORT');
 if(!development&&(!original.sourceCertified||!isSourceCertified(original)))throw Error('E_ENGINE_ARTIFACT_SOURCE');
 if(!original.template?.path)throw Error('E_ENGINE_ARTIFACT_REPORT: template missing');
 const template=path.resolve(path.dirname(reportFile),original.template.path);await regular(template);
 for(const input of [reportFile,template])if(input===out||input.startsWith(out+path.sep))throw Error('E_ENGINE_ARTIFACT_OUTPUT: output contains an input');
 const templateBytes=await readFile(template);
 if(digest(templateBytes)!==original.template.sha256||(original.template.bytes!==undefined&&original.template.bytes!==templateBytes.length))throw Error('E_ENGINE_ARTIFACT_TEMPLATE');
 const portable=structuredClone(original);portable.template.path='engine-template.zip';
 const entries={'engine-report.original.json':originalBytes,'engine-report.json':Buffer.from(JSON.stringify(portable,null,2)+'\n'),'engine-template.zip':templateBytes};
 if(publishedReport){
  const normalized=structuredClone(publishedReport);
  if(typeof normalized.template?.path!=='string')throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
  normalized.template.path='engine-template.zip';if(canonical(normalized)!==canonical(portable))throw Error('E_ENGINE_ARTIFACT_PROVENANCE');
  entries['engine-report.published.json']=Buffer.from(JSON.stringify(publishedReport,null,2)+'\n');
 }
 const log=await readBuildLog(reportFile,template,original.logSha256);
 if(log)entries['build.log']=log.bytes;
 const manifest={schemaVersion:1,kind:'godotjs-browser-engine-artifact',runtimeProfile:original.runtimeProfile,target:original.engineTarget,recipeSha256:original.recipeSha256,development:development===true,sourceReportSha256:digest(originalBytes),files:Object.fromEntries(Object.entries(entries).map(([name,bytes])=>[name,{sha256:digest(bytes),bytes:bytes.length}]))};
 try{await lstat(out);const existing=await inspectBrowserEngineArtifact(out);if(canonical(existing.manifest)!==canonical(manifest))throw Error('E_ENGINE_ARTIFACT_OUTPUT: existing artifact differs');return existing;}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(path.dirname(out),{recursive:true});const staging=await mkdtemp(path.join(path.dirname(out),'.engine-artifact-'));
 try{
  for(const [name,bytes]of Object.entries(entries))await writeFile(path.join(staging,name),bytes);
  await writeFile(path.join(staging,'artifact.json'),JSON.stringify(manifest,null,2)+'\n');
  await inspectBrowserEngineArtifact(staging);
  await rename(staging,out);
 }finally{await rm(staging,{recursive:true,force:true});}
 return inspectBrowserEngineArtifact(out);
}

/** Publish a small current pointer, keeping each complete build in an immutable
 * report-hash directory so later builds cannot overwrite previous evidence. */
export async function publishBrowserEngineArtifact({report,publish,templateOut,development=false}){
 report=path.resolve(required(report,'--report'));await regular(report);
 publish=path.resolve(required(publish,'--publish'));templateOut=path.resolve(required(templateOut,'--template-out'));
 const reportBytes=await readFile(report),out=path.join(path.dirname(publish),'releases',digest(reportBytes),'portable');
 const pointer=JSON.parse(reportBytes),template=path.join(out,'engine-template.zip');
 if(!pointer.template?.path)throw Error('E_ENGINE_ARTIFACT_REPORT: template missing');
 const sourceTemplate=path.resolve(path.dirname(report),pointer.template.path);await regular(sourceTemplate);
 const log=await readBuildLog(report,sourceTemplate,pointer.logSha256);
 await assertPublicationPaths([report,sourceTemplate,...(log?[log.filename]:[])],[publish,templateOut],out);
 pointer.template.path=path.relative(path.dirname(publish),template).split(path.sep).join('/');
 const artifact=await packageBrowserEngineArtifact({report,out,development,publishedReport:pointer});
 if(artifact.manifest.sourceReportSha256!==digest(reportBytes))throw Error('E_ENGINE_ARTIFACT_REPORT: report changed while packaging');
 await atomicCopy(template,templateOut);await atomicJson(publish,pointer);
 return {status:'published',report:publish,template:templateOut,artifact:out};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const config=options(process.argv.slice(2),['--paths','--development','--verify']);
  if(config.paths){
   const paths=browserEnginePaths({repository:required(config.repository,'--repository'),profile:config.profile,target:config.target,lto:config.lto,moduleMode:config['module-mode'],jobs:Number(config.jobs??4)});
   for(const filename of [process.env.GODOT_WEB_BUILD_DIR??paths.buildDirectory,paths.artifactDirectory,process.env.ENGINE_BUILD_REPORT??paths.reportPath,process.env.WEB_TEMPLATE_OUT??paths.templatePath]){if(/[\r\n]/.test(filename))throw Error('E_ENGINE_ARTIFACT_PATH');process.stdout.write(path.resolve(filename)+'\n');}
  }else if(config.verify){const result=await inspectBrowserEngineArtifact(required(config.out,'--out'));console.log(JSON.stringify({status:result.status,directory:result.directory,files:Object.keys(result.manifest.files).length}));}
  else if(config.publish)console.log(JSON.stringify(await publishBrowserEngineArtifact({report:config.report,publish:config.publish,templateOut:config['template-out'],development:config.development})));
  else{const result=await packageBrowserEngineArtifact(config);console.log(JSON.stringify({status:result.status,directory:result.directory,files:Object.keys(result.manifest.files).length}));}
 }catch(error){console.error(error.stack??error);process.exitCode=1;}
}
