#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sealSiteAcceptance} from './seal-site-acceptance.mjs';
import {workerAcceptancePlan,assertWorkerCandidate,runConfigurationHash} from './worker-candidate.mjs';
import {assertRuntimeEvidence,assertWorkerSessionEvidence} from './runtime-evidence.mjs';
import {sitePayloads} from './site-evidence.mjs';
import {runWorkerCapabilityMatrix} from './worker-capability-matrix.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const commands={runtime:['browser-full-engine-test.mjs','PLAYGROUND_FULL_ENGINE_REPORT'],editor:['browser-engine-editor-test.mjs','PLAYGROUND_EDITOR_REPORT'],bridge:['browser-engine-bridge-test.mjs','PLAYGROUND_BRIDGE_REPORT'],projects:['browser-project-test.mjs'], 'demo-regressions':['browser-demo-regressions-test.mjs','PLAYGROUND_DEMO_REGRESSIONS_REPORT'],'react-demos':['browser-react-demos-test.mjs','PLAYGROUND_REACT_DEMOS_REPORT'],workbench:['browser-test.mjs'],delivery:['browser-http-delivery-test.mjs','PLAYGROUND_DELIVERY_REPORT'],features:['browser-2d-features-test.mjs','PLAYGROUND_2D_FEATURES_REPORT']};
async function execute(args,env){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>64*1024*1024)child.kill();});child.stderr.on('data',bytes=>{stderr+=bytes;process.stderr.write(bytes);});child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
 });
}
/** One immutable site, two explicit presenters, no SDK rebuilds or candidate
 * mutations during the batch. Browser/profile jobs can run independently. */
export async function runWorkerAcceptanceMatrix({site,out,planOnly=false}={}){
 if(!site||!out)throw Error('E_WORKER_MATRIX_OPTIONS: --site and --out required');
 site=path.resolve(site);out=path.resolve(out);if(out===site||out.startsWith(site+path.sep))throw Error('E_WORKER_MATRIX_OUTPUT');
 const release=JSON.parse(await readFile(path.join(site,'engine-release.json'),'utf8')),manifest=JSON.parse(await readFile(path.join(site,'manifest.json'),'utf8'));
 assertWorkerCandidate(manifest,release,await sitePayloads(site));
 const plan=workerAcceptancePlan(release.runtimeProfile);if(planOnly)return {status:'planned',profile:release.runtimeProfile,plan};
 await mkdir(out,{recursive:true});const prepared=await sealSiteAcceptance(site,out,{begin:true}),results=[];
 const {DEFAULT_WORKER_RUN_CONFIGURATION}=await import(pathToFileURL(path.join(root,'scripts/jsb.react-browser/dist/worker-protocol.js')).href);
 for(const presentationBackend of ['direct','bitmap'])await writeFile(path.join(out,'configuration.'+presentationBackend+'.json'),JSON.stringify({...DEFAULT_WORKER_RUN_CONFIGURATION,presentationBackend},null,2)+'\n');
 for(const item of plan){
  try{
  const [script,reportVariable]=commands[item.suite],reportFile=path.join(out,item.name+'.json'),configurationFile=path.join(out,'configuration.'+item.presentationBackend+'.json');
  const env={...process.env,BROWSER:item.browser,PLAYGROUND_BROWSER_DEFAULT_SETTINGS:process.env.PLAYGROUND_BROWSER_DEFAULT_SETTINGS??'1',PLAYGROUND_TEST_DIRECTORY:site,PLAYGROUND_ACCEPTANCE_CONTEXT:prepared.context,PLAYGROUND_PRESENTATION_BACKEND:item.presentationBackend,PLAYGROUND_FULL_ENGINE_LOOPS:item.browser==='chromium'?'50':'2',PLAYGROUND_SCREENSHOTS:path.join(out,item.name+'.screenshots')};
  if(reportVariable)env[reportVariable]=reportFile;
  env.PLAYGROUND_RUN_CONFIGURATION=configurationFile;
  const args=['apps/playground/scripts/'+script,...(item.suite==='features'?['--site',site,'--out',path.join(out,item.name+'.artifacts'),'--report',reportFile,'--sessions',item.browser==='chromium'?'2':'1','--require-cjk']:[])];
  console.error('[worker matrix] '+item.name);
  const result=await execute(args,env);await writeFile(path.join(out,item.name+'.stderr.log'),result.stderr);
  if(result.code!==0){await writeFile(path.join(out,item.name+'.stdout.log'),result.stdout);throw Error('E_WORKER_MATRIX_SUITE: '+item.name+' exit '+result.code);}
  if(!reportVariable)await writeFile(reportFile,result.stdout);
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  if(report.status!=='passed')throw Error('E_WORKER_MATRIX_REPORT: '+item.name+' status '+report.status);
  // A producer's passed string cannot stand in for its actual exit and
  // cleanup evidence, even when another browser prevents whole-site sealing.
  if(item.suite==='runtime')assertRuntimeEvidence(report,release,manifest.runtime);
  else if(!['editor','delivery'].includes(item.suite))assertWorkerSessionEvidence(report);
  else if(report.schemaVersion!==3||Object.hasOwn(report,'runId')||report.runConfigurationHash!==runConfigurationHash(report.runConfiguration)||report.executionScope!==(item.suite==='editor'?'compiler-worker':'http-delivery'))throw Error('E_WORKER_MATRIX_REPORT_SCOPE: '+item.name);
  if(item.suite==='runtime')await writeFile(configurationFile,JSON.stringify(report.runConfiguration,null,2)+'\n');
  results.push({...item,status:'passed'});
  }catch(error){results.push({...item,status:'failed',error:String(error.stack??error)});console.error('[worker matrix] failed '+item.name+': '+String(error.message??error));}
 }
 // Capability evidence is collected even when a browser failed. Unusable
 // runtime scopes become explicit blocked dependencies, never passing probes.
 const capabilities=await runWorkerCapabilityMatrix({site,reports:out});
 const summary={schemaVersion:3,acceptanceBatchId:prepared.acceptanceBatchId,candidateId:prepared.candidateId,status:results.every(item=>item.status==='passed')?'executed':'failed',capabilities:{path:'worker-capabilities.json',status:capabilities.status,coverage:capabilities.coverage},results};
 await writeFile(path.join(out,'matrix-results.json'),JSON.stringify(summary,null,2)+'\n');
 if(summary.status==='failed')throw Error('E_WORKER_MATRIX_FAILED: '+results.filter(item=>item.status==='failed').map(item=>item.name).join(', '));
 try{
  const receipt=await sealSiteAcceptance(site,out);await sealSiteAcceptance(site,out,{verify:true});summary.status='passed';summary.receipt=receipt.receipt;await writeFile(path.join(out,'matrix-results.json'),JSON.stringify(summary,null,2)+'\n');return receipt;
 }catch(error){summary.status='failed';summary.sealingError=String(error.stack??error);await writeFile(path.join(out,'matrix-results.json'),JSON.stringify(summary,null,2)+'\n');throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
 try{console.log(JSON.stringify(await runWorkerAcceptanceMatrix({site:option('--site'),out:option('--out'),planOnly:args.includes('--plan')}),null,2));}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
