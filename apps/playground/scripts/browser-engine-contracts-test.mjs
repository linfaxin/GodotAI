import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultTestDirectory} from './browser-harness.mjs';
import {runReportedBrowserTest,readBrowserTestSite,browserTestError,browserTestFailureStatus} from './browser-contract-report.mjs';

const execute=promisify(execFile);
export const REQUIRED_CONTRACT_GROUPS=Object.freeze(['preflight','lifecycle','failure-recovery','replacement','entry-resources']);
const commands={
 lifecycle:[{name:'runtime-host',script:'browser-runtime-host-test.mjs',env:{PLAYGROUND_CONTRACT_GROUP:'lifecycle'},report:'PLAYGROUND_RUNTIME_HOST_REPORT'}],
 'failure-recovery':[{name:'runtime-host',script:'browser-runtime-host-test.mjs',env:{PLAYGROUND_CONTRACT_GROUP:'failure-recovery'},report:'PLAYGROUND_RUNTIME_HOST_REPORT'}],
 replacement:[{name:'isolated-consumer',script:'browser-engine-contracts-consumer-test.mjs',report:'PLAYGROUND_CONSUMER_REPORT'}],
 'entry-resources':[
  {name:'react-entry',script:'browser-runtime-host-test.mjs',env:{PLAYGROUND_CONTRACT_GROUP:'entry'},report:'PLAYGROUND_RUNTIME_HOST_REPORT'},
  {name:'schema4-entry',script:'browser-schema4-flow-test.mjs',report:'PLAYGROUND_SCHEMA4_REPORT'},
  {name:'native-resources',script:'browser-resource-converters-test.mjs',report:'PLAYGROUND_RESOURCE_REPORT'},
 ],
};

async function runContractProcess(command,{directory,reportFile}){
 const script=fileURLToPath(new URL(command.script,import.meta.url)),logFile=reportFile.replace(/\.json$/,'.log');
 await mkdir(path.dirname(reportFile),{recursive:true});
 await rm(reportFile,{force:true});
 let stdout='',stderr='',executionError;
 try{({stdout,stderr}=await execute(process.execPath,[script],{env:{...process.env,PLAYGROUND_TEST_DIRECTORY:directory,PLAYGROUND_ENGINE_CONTRACTS:'1',...command.env,[command.report]:reportFile},maxBuffer:32*1024*1024,timeout:20*60*1000}));}
 catch(error){executionError=error;stdout=error.stdout??'';stderr=error.stderr??'';}
 await writeFile(logFile,stdout+'\n'+stderr);
 let report;
 try{report=JSON.parse(await readFile(reportFile,'utf8'));}
 catch(error){return {name:command.name,status:'failed',error:browserTestError(executionError??error),reason:'Child did not produce a readable report',reportFile,logFile};}
 if(!['passed','failed','blocked'].includes(report.status))return {name:command.name,status:'failed',reason:'Invalid child report status',reportFile,logFile,report};
 const status=executionError&&report.status==='passed'?'failed':report.status;
 return {name:command.name,status,reportFile,logFile,report,...(executionError?{processError:browserTestError(executionError)}:{})};
}

function candidateIdentity(candidate){
 return {profile:candidate.release.runtimeProfile,releaseId:candidate.release.id,descriptorHash:candidate.descriptorHash,candidateId:candidate.candidateId};
}
function hasEngineExecution(report){
 return report?.engineExecuted===true&&Array.isArray(report.sessions)&&report.sessions.some(session=>
  session?.executionBackend==='worker'&&session.presentationBackend==='direct'&&
  ['runId','documentId','workerId','buildKey','runConfigurationHash'].every(key=>typeof session[key]==='string'&&session[key].length>0)&&
  session.revision!==undefined&&session.generation!==undefined);
}
function validateContractCase(result,candidate){
 if(result.status!=='passed')return result;
 const report=result.report,expected=candidateIdentity(candidate);
 const fail=(code,reason)=>({...result,status:'failed',reason,error:{code,message:code+': '+reason}});
 if(report?.status!=='passed')return fail('E_TEST_CONTRACT_REPORT','Passed case requires a passed child report');
 const mismatches=Object.keys(expected).filter(key=>report[key]!==expected[key]);
 if(mismatches.length)return {...fail('E_TEST_CONTRACT_IDENTITY','Child differs from preflight: '+mismatches.join(', ')),expectedIdentity:expected};
 // These process-level cases all require a real Worker run. Individual input
 // rejection/cancellation steps within them can legitimately have no session.
 if(!hasEngineExecution(report))return fail('E_TEST_CONTRACT_EXECUTION','Required case has no confirmed engine execution and Worker session');
 return result;
}

/** Run independent existing fixtures as separate processes. A failed group
 * cannot leave a page, storage database or script state in another group. */
export async function runEngineContractGroups({directory=defaultTestDirectory(),reportFile,runCommand=runContractProcess,preflight=readBrowserTestSite,print=true,setExitCode=true}={}){
 directory=path.resolve(directory);
 reportFile=path.resolve(reportFile??process.env.PLAYGROUND_ENGINE_CONTRACT_REPORT??'/tmp/godotai-engine-contracts-'+process.pid+'.json');
 return runReportedBrowserTest({scope:'engine-minimum-contracts',reportFile,print,setExitCode,run:async test=>{
  const groups=[],requestedTarget={profile:'full-engine-v1',executionBackend:'worker',presentationBackend:'direct',browser:'chromium'};
  let candidate;
  try{
   if(process.env.BROWSER&&process.env.BROWSER!=='chromium')throw Error('E_TEST_CONTRACT_BROWSER: Chromium required');
   if(process.env.PLAYGROUND_PRESENTATION_BACKEND&&process.env.PLAYGROUND_PRESENTATION_BACKEND!=='direct')throw Error('E_TEST_CONTRACT_PRESENTER: direct required');
   candidate=await preflight(directory,{worker:true});
   groups.push({name:'preflight',status:'passed'});
  }catch(error){groups.push({name:'preflight',status:browserTestFailureStatus(error,'preflight'),error:browserTestError(error)});}
  test.stage='run';
  for(const name of REQUIRED_CONTRACT_GROUPS.slice(1)){
   if(groups[0].status!=='passed'){groups.push({name,status:'blocked',blockedBy:'preflight',cases:[]});continue;}
   const cases=[];
   for(const command of commands[name]){
    try{cases.push(validateContractCase(await runCommand(command,{directory,reportFile:path.join(path.dirname(reportFile),path.basename(reportFile,'.json')+'.cases',name+'-'+command.name+'.json')}),candidate));}
    catch(error){cases.push({name:command.name,status:'failed',error:browserTestError(error)});}
   }
   const status=cases.some(item=>item.status==='failed')?'failed':cases.some(item=>item.status!=='passed')?'blocked':'passed';
   groups.push({name,status,cases});
  }
  const status=groups.some(group=>group.status==='failed')?'failed':groups.some(group=>group.status!=='passed')?'blocked':'passed';
  return {status,requestedTarget,directory,requiredGroups:[...REQUIRED_CONTRACT_GROUPS],groups,
   ...(candidate?{profile:candidate.release.runtimeProfile,releaseId:candidate.release.id,descriptorHash:candidate.descriptorHash,candidateId:candidate.candidateId}:{}),
   engineExecuted:!!candidate&&groups.some(group=>group.cases?.some(item=>hasEngineExecution(item.report)&&
    Object.entries(candidateIdentity(candidate)).every(([key,value])=>item.report[key]===value)))};
 }});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runEngineContractGroups();
