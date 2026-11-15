import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {siteIdentity} from './site-evidence.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function withSdkFixtureVersion(filename,version,operation){
 const original=await fs.readFile(filename),value=JSON.parse(original);value.version=version;
 const controller=new AbortController(),interrupt=()=>controller.abort(new Error('CI fixture build interrupted'));
 process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
 try{await fs.writeFile(filename,JSON.stringify(value,null,2)+'\n');return await operation(controller.signal);}
 finally{try{await fs.writeFile(filename,original);assert.deepEqual(await fs.readFile(filename),original,'SDK package bytes must be restored after the fixture build');}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}}
}
function run(args,{signal}={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:repository,env:process.env,stdio:'inherit',signal});child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(Error('Worker product build failed: '+(signal??code))));});}

/** Two fully built, sealed releases for a mechanical rollback fixture.
 * The previous prerelease SDK version is not a historical deployed release. */
export async function prepareWorkerProducts({engineReport,out,workDirectory,currentDirectory,previousDirectory,resourceProject}={}){
 assert(engineReport&&out&&workDirectory,'Pass engine-report, out and work-dir');
 engineReport=path.resolve(engineReport);out=path.resolve(out);workDirectory=path.resolve(workDirectory);
 const current=path.resolve(currentDirectory??path.join(out,'current')),previous=path.resolve(previousDirectory??path.join(out,'previous')),previousWork=path.join(workDirectory,'previous'),currentWork=path.join(workDirectory,'current');
 for(const directory of [current,previous]){try{await fs.access(path.join(directory,'engine-release.json'));throw Error('Refusing to overwrite a sealed CI candidate: '+directory);}catch(error){if(error.code!=='ENOENT')throw error;}}
 await fs.mkdir(out,{recursive:true});
 const sdkPackage=path.join(repository,'scripts/jsb.react/package.json'),original=await fs.readFile(sdkPackage),currentVersion=JSON.parse(original).version,previousVersion=currentVersion+'-worker-ci.previous';
 const args=(directory,workspace)=>['apps/playground/scripts/build.mjs','--execution-model','proxy-pthread','--engine-report',engineReport,'--out',directory,'--work-dir',workspace,'--public-assets'];
 const report={schemaVersion:1,kind:'godotjs-worker-ci-product-fixtures',status:'running',scope:'Two actual production builds with a previous SDK version fixture; not historical deployment evidence',engineReport,currentVersion,previousVersion,candidates:{previous,current}};
 try{
  await withSdkFixtureVersion(sdkPackage,previousVersion,signal=>run([...args(previous,previousWork),...(resourceProject?['--skip-assets','--resource-project',path.resolve(resourceProject)]:[])],{signal}));
  assert.deepEqual(await fs.readFile(sdkPackage),original,'The real current build starts only after the original SDK package bytes are restored');
  await run([...args(current,currentWork),'--skip-assets','--resource-project',path.join(previousWork,'export-project')]);
  assert.deepEqual(await fs.readFile(sdkPackage),original);
  const [oldRelease,newRelease]=await Promise.all([previous,current].map(async directory=>JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'))));
  assert.equal(oldRelease.sdk.version,previousVersion);assert.equal(newRelease.sdk.version,currentVersion);
  assert.notEqual(oldRelease.id,newRelease.id);assert.notEqual(oldRelease.extensionId,newRelease.extensionId);assert.equal(oldRelease.engineId,newRelease.engineId,'A fixture SDK version change must not alter the native engine or host identity');
  report.identities={previous:await siteIdentity(previous),current:await siteIdentity(current)};
  for(const identity of Object.values(report.identities))delete identity.payloads;
  await fs.writeFile(path.join(out,'current-context.json'),JSON.stringify({...report.identities.current,runId:randomUUID()},null,2)+'\n');
  report.sdkPackageRestoredSha256=hash(original);report.status='passed';
 }catch(error){report.status='failed';report.error=String(error);report.stack=error.stack;throw error;}
 finally{report.sdkPackageRestored=hash(await fs.readFile(sdkPackage))===hash(original);await fs.writeFile(path.join(out,'fixture-build.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
 const result=await prepareWorkerProducts({engineReport:option('--engine-report'),out:option('--out'),workDirectory:option('--work-dir'),currentDirectory:option('--current-out'),previousDirectory:option('--previous-out'),resourceProject:option('--resource-project')});console.log(JSON.stringify(result,null,2));
}
