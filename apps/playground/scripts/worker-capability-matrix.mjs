#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,siteIdentity} from './site-evidence.mjs';
import {WORKER_CAPABILITY_LEDGER,assertWorkerCapabilityProbeReport,assertOriginalPlatformProbeReport} from './worker-capability-ledger.mjs';
import {assertRuntimeEvidence} from './runtime-evidence.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const producerPath='apps/playground/scripts/browser-native-host-capabilities.mjs';
const collectorPath='apps/playground/scripts/worker-capability-matrix.mjs';
const json=async filename=>JSON.parse(await readFile(filename,'utf8'));
const identityFields=['profile','releaseId','descriptorHash','candidateId','siteHash','acceptanceBatchId'];
export function capabilityVariantPlan(){
 return ['chromium','firefox','webkit'].flatMap(browser=>['direct','bitmap'].flatMap(presentationBackend=>['production','development'].flatMap(sdkMode=>['snake','camel'].map(naming=>({browser,presentationBackend,sdkMode,naming,key:[browser,presentationBackend,sdkMode,naming].join('.')})))));
}
function safeEvidencePath(filename){if(typeof filename!=='string'||!filename||filename.includes('\\')||path.isAbsolute(filename)||filename.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('E_CAPABILITY_EVIDENCE_PATH');return filename;}
async function checkedBytes(directory,asset){const bytes=await readFile(path.join(directory,safeEvidencePath(asset?.path)));if(digest(bytes)!==asset.sha256||(asset.bytes!==undefined&&bytes.length!==asset.bytes))throw Error('E_CAPABILITY_EVIDENCE_HASH: '+asset.path);return bytes;}
const scopeKey=item=>[item.capability,item.browser.name,item.presentationBackend,item.sdkMode,item.naming].join(':');

/** Aggregate only dedicated, rehashed probe evidence. site-start is the original
 * identity/source snapshot, never a fabricated passing site receipt. Missing
 * producers and failed prerequisites remain explicit blocked cases. */
export async function collectWorkerCapabilities({reports,context,attempts}){
 if(context?.schemaVersion!==3||!['full-engine-v1','engine-2d-v1'].includes(context.profile)||typeof context.acceptanceBatchId!=='string')throw Error('E_CAPABILITY_BATCH');
 const capabilities=WORKER_CAPABILITY_LEDGER.filter(item=>item.profiles.includes(context.profile));
 const available=new Map(),issues=[];
 for(const attempt of attempts){
  if(!attempt.report)continue;
  const directory=path.join(reports,'worker-capabilities',attempt.key);
  try{
   if(attempt.report.path!=='worker-capabilities/'+attempt.key+'/report.json')throw Error('E_CAPABILITY_REPORT_PATH');
   const report=JSON.parse(await checkedBytes(reports,attempt.report));
   for(const field of identityFields)if(report[field]!==context[field])throw Error('E_CAPABILITY_REPORT_IDENTITY: '+field);
   if(report.browser?.name!==attempt.browser||report.presentationBackend!==attempt.presentationBackend||report.naming!==attempt.naming||report.sdkMode!==attempt.sdkMode)throw Error('E_CAPABILITY_REPORT_SCOPE');
   if(attempt.browserEvidence)for(const key of ['name','version','platform','settingsTier'])if(report.browser?.[key]!==attempt.browserEvidence[key])throw Error('E_CAPABILITY_BROWSER_DRIFT: '+key);
   for(const item of report.capabilityCases??[]){
    if(!capabilities.some(capability=>capability.id===item.capability)||item.browser?.name!==attempt.browser||item.presentationBackend!==attempt.presentationBackend||item.sdkMode!==attempt.sdkMode||item.naming!==attempt.naming)throw Error('E_CAPABILITY_CASE_SCOPE');
    const probe=JSON.parse(await checkedBytes(directory,item.probe));
    for(const asset of item.evidence??[])await checkedBytes(directory,asset);
    if(item.status==='passed'){
     assertWorkerCapabilityProbeReport(context,item,probe);
     if(item.classification==='original-platform-unsupported')assertOriginalPlatformProbeReport(context,item,JSON.parse(await checkedBytes(directory,item.baseline.probe)));
    }else if(item.status!=='blocked'&&item.status!=='failed')throw Error('E_CAPABILITY_CASE_STATUS');
    const prefix='worker-capabilities/'+attempt.key+'/',copy=structuredClone(item);
    copy.probe.path=prefix+safeEvidencePath(copy.probe.path);
    for(const asset of copy.evidence??[])asset.path=prefix+safeEvidencePath(asset.path);
    if(copy.baseline?.probe)copy.baseline.probe.path=prefix+safeEvidencePath(copy.baseline.probe.path);
    if(copy.change?.documentation)copy.change.documentation.path=prefix+safeEvidencePath(copy.change.documentation.path);
    if(copy.status!=='passed')copy.reason=report.cases.filter(value=>value.capability===copy.capability&&value.status!=='passed').map(value=>value.reason??value.errors?.join('; ')??value.status).join('; ')||'Dedicated probe did not pass';
    const key=scopeKey(copy);if(available.has(key))throw Error('E_CAPABILITY_DUPLICATE_CASE: '+key);available.set(key,copy);
   }
  }catch(error){issues.push({key:attempt.key,error:String(error.stack??error)});}
 }
 const cases=[];
 for(const variant of capabilityVariantPlan())for(const capability of capabilities){
  const attempt=attempts.find(value=>value.key===variant.key),key=[capability.id,variant.browser,variant.presentationBackend,variant.sdkMode,variant.naming].join(':');
  const observed=available.get(key);
  if(observed){cases.push(observed);continue;}
  cases.push({capability:capability.id,classification:'pending-bridge',status:'blocked',executionBackend:'worker',browser:attempt?.browserEvidence??{name:variant.browser,version:'unavailable',platform:process.platform,settingsTier:'unavailable'},presentationBackend:variant.presentationBackend,sdkMode:variant.sdkMode,naming:variant.naming,reason:attempt?.reason??'No dedicated capability producer supplied this scope',...(attempt?.dependency?{dependency:attempt.dependency}:{})});
 }
 const coverage={capabilities:capabilities.length,requiredVariants:24,requiredCases:capabilities.length*24,passingProbeCases:cases.filter(item=>item.status==='passed').length,blockedCases:cases.filter(item=>item.status==='blocked').length,failedCases:cases.filter(item=>item.status==='failed').length};
 const report={schemaVersion:3,kind:'worker-capability-matrix',...Object.fromEntries(identityFields.map(key=>[key,context[key]])),status:!issues.length&&cases.every(item=>item.status==='passed')?'passed':'blocked',collector:{path:collectorPath,sha256:digest(await readFile(path.join(root,collectorPath)))},coverage,attempts,issues,cases};
 await writeFile(path.join(reports,'worker-capabilities.json'),JSON.stringify(report,null,2)+'\n');return report;
}

async function executeVariant(args,env,log){
 const sink=createWriteStream(log);let pid,code,signal;
 try{await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});pid=child.pid;child.stdout.pipe(sink,{end:false});child.stderr.pipe(sink,{end:false});child.once('error',reject);child.once('close',(exitCode,exitSignal)=>{code=exitCode;signal=exitSignal;resolve();});});}
 finally{sink.end();await finished(sink);}
 return {pid,exitCode:code,signal};
}

export async function runWorkerCapabilityMatrix({site,reports,browsers=['chromium','firefox','webkit']}={}){
 site=path.resolve(site);reports=path.resolve(reports);
 const context=await json(path.join(reports,'site-start.json')),actual=await siteIdentity(site),release=await json(path.join(site,'engine-release.json')),manifest=await json(path.join(site,'manifest.json'));
 if(context.schemaVersion!==3||typeof context.acceptanceBatchId!=='string')throw Error('E_CAPABILITY_BATCH');
 for(const key of identityFields.filter(value=>value!=='acceptanceBatchId'))if(actual[key]!==context[key])throw Error('E_CAPABILITY_SITE_DRIFT: '+key);
 for(const name of [producerPath,collectorPath])if(context.testSources?.[name]!==digest(await readFile(path.join(root,name))))throw Error('E_CAPABILITY_PRODUCER_DRIFT: '+name);
 if(!Array.isArray(browsers)||!browsers.length||browsers.some(value=>!['chromium','firefox','webkit'].includes(value)))throw Error('E_CAPABILITY_BROWSERS');
 const attempts=[];
 for(const variant of capabilityVariantPlan()){
  const attempt={...variant,status:'blocked'};attempts.push(attempt);
  if(!browsers.includes(variant.browser)){attempt.reason='Browser not selected in this diagnostic invocation';continue;}
  const runtimeFile='runtime.worker.'+variant.presentationBackend+'.'+variant.browser+'.json';
  try{
   const raw=await readFile(path.join(reports,runtimeFile)),runtime=JSON.parse(raw);
   attempt.dependency={path:runtimeFile,sha256:digest(raw),bytes:raw.length};attempt.browserEvidence=runtime.browser;
   for(const key of identityFields)if(runtime[key]!==context[key])throw Error('Runtime prerequisite identity differs: '+key);
   if(runtime.status!=='passed')throw Error('Runtime prerequisite failed; no positive capability probe can certify this scope');
   assertRuntimeEvidence(runtime,release,manifest.runtime);
  }catch(error){attempt.reason=String(error.message??error);continue;}
  // This dedicated producer uses Chromium CDP for real activation. A passing
  // Firefox/WebKit runtime cannot be substituted with Chromium capability data.
  if(variant.browser!=='chromium'){attempt.reason='No dedicated Native host capability producer for this browser';continue;}
  const directory=path.join(reports,'worker-capabilities',variant.key);await mkdir(directory,{recursive:true});
  console.error('[worker capabilities] '+variant.key);
  try{
   const env={...process.env,BROWSER:variant.browser,BROWSER_HEADLESS:'1',PLAYGROUND_BROWSER_DEFAULT_SETTINGS:'1',PLAYGROUND_ACCEPTANCE_CONTEXT:path.join(reports,'site-start.json'),PLAYGROUND_TEST_DIRECTORY:site,PLAYGROUND_RUN_CONFIGURATION:path.join(reports,'configuration.'+variant.presentationBackend+'.json'),PLAYGROUND_PRESENTATION_BACKEND:variant.presentationBackend};
   const owner=await executeVariant([producerPath,'--site',site,'--out',directory,'--presentation',variant.presentationBackend,'--sdk-mode',variant.sdkMode,'--naming',variant.naming,'--timeout-ms','30000'],env,path.join(directory,'run.log'));
   Object.assign(attempt,owner);const bytes=await readFile(path.join(directory,'report.json'));attempt.report={path:'worker-capabilities/'+variant.key+'/report.json',sha256:digest(bytes),bytes:bytes.length};attempt.status=JSON.parse(bytes).status;
  }catch(error){attempt.reason=String(error.stack??error);}
 }
 return collectWorkerCapabilities({reports,context,attempts});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
 try{const report=await runWorkerCapabilityMatrix({site:argument('--site'),reports:argument('--reports'),...(argument('--browsers')?{browsers:argument('--browsers').split(',')}:{})});console.log(JSON.stringify({status:report.status,coverage:report.coverage}));if(report.status!=='passed')process.exitCode=1;}
 catch(error){console.error(error.stack??error);process.exitCode=1;}
}
