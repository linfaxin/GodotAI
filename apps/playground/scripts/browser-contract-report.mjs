import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const browserTestError=error=>({message:String(error?.message??error),...(error?.code?{code:error.code}:{}),...(error?.stack?{stack:error.stack}:{})});
export function browserTestFailureStatus(error,stage){
 return stage!=='run'&&(error?.code==='ENOENT'||/Executable doesn't exist|browser executable.*(?:missing|not found)|E_BROWSER_UNAVAILABLE/i.test(String(error?.message??error)))?'blocked':'failed';
}

/** Read and verify the candidate before launching anything. Missing input is a
 * prerequisite failure; supplied corrupt bytes are a failed contract. */
export async function readBrowserTestSite(directory,{worker=false}={}){
 const siteBytes=await readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes);
 const descriptorBytes=await readFile(path.join(directory,'engine-release.json')),release=JSON.parse(descriptorBytes);
 if(site.runtimeProfile!==release.runtimeProfile||site.engineReleaseId!==release.id)throw Error('E_TEST_SITE_RELEASE');
 if(worker&&(release.runtimeProfile!=='full-engine-v1'||site.schemaVersion!==3||site.runtime?.executionBackend!=='worker'))throw Error('E_TEST_CONTRACT_TARGET: full-engine-v1 Dedicated Worker required');
 const {assertNativeReleaseIdentity,assertSiteDescriptorIdentity}=await import('@godot-js/engine/identities');
 await assertNativeReleaseIdentity(release);
 assertSiteDescriptorIdentity(site,{sha256:hash(descriptorBytes),bytes:descriptorBytes.length},{required:release.engineId!==undefined});
 for(const [name,asset]of Object.entries(site.payloads??{})){
  if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('E_TEST_SITE_PATH');
  const bytes=await readFile(path.join(directory,name));
  if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)throw Error('E_TEST_SITE_PAYLOAD: '+name);
 }
 return {site,siteBytes,release,descriptorBytes,candidateId:hash(siteBytes),descriptorHash:hash(descriptorBytes)};
}

export const listenBrowserTestServer=server=>new Promise((resolve,reject)=>{
 const failed=error=>reject(error);server.once('error',failed);
 server.listen(0,'127.0.0.1',()=>{server.off('error',failed);resolve();});
});
export const closeBrowserTestServer=server=>new Promise((resolve,reject)=>{
 if(!server?.listening)return resolve();server.close(error=>error?reject(error):resolve());
});

/** Small lifecycle wrapper shared by the three existing real-browser scripts.
 * It also covers initialization, and every cleanup runs even if reporting fails. */
export async function runReportedBrowserTest({scope,reportFile,run,print=true,setExitCode=true}){
 const cleanups=[],steps=[];
 let report={status:'failed',scope,stage:'preflight',steps};
 const test={
  stage:'preflight',
  get steps(){return steps;},
  defer(cleanup){cleanups.push(cleanup);},
  checkpoint(value){report={...report,...value,steps};},
  async preflight(directory,options){
   const value=await readBrowserTestSite(directory,options);
   Object.assign(report,{profile:value.release.runtimeProfile,releaseId:value.release.id,descriptorHash:value.descriptorHash,candidateId:value.candidateId});
   return value;
  },
  async step(name,body,{after=[]}={}){
   const dependency=after.find(id=>steps.find(step=>step.name===id)?.status!=='passed');
   if(dependency){steps.push({name,status:'blocked',blockedBy:dependency});return;}
   process.stderr.write('['+scope+'] '+name+'\n');
   try{const value=await body();steps.push({name,status:'passed'});return value;}
   catch(error){steps.push({name,status:'failed',error:browserTestError(error)});return;}
  },
 };
 try{report={...report,...await run(test),steps,stage:test.stage};}
 catch(error){report={...report,status:browserTestFailureStatus(error,test.stage),stage:test.stage,error:browserTestError(error)};}
 finally{
  for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){(report.cleanupErrors??=[]).push(browserTestError(error));}
 }
 const unsuccessful=steps.find(step=>step.status==='failed')??steps.find(step=>step.status==='blocked');
 if(unsuccessful){report.status=unsuccessful.status==='failed'?'failed':'blocked';report.error??=unsuccessful.error;}
 if(report.cleanupErrors?.length&&report.status==='passed')report.status='failed';
 const output=typeof reportFile==='function'?reportFile(report):reportFile;
 if(output){
  try{const file=path.resolve(output);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(report,null,2)+'\n');}
  catch(error){report.reportError=browserTestError(error);if(report.status==='passed')report.status='failed';process.stderr.write('E_TEST_REPORT_WRITE: '+String(error?.message??error)+'\n');}
 }
 if(print)console.log(JSON.stringify(report,null,2));
 if(setExitCode&&report.status!=='passed')process.exitCode=1;
 return report;
}
