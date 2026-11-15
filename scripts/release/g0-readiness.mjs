import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateExecutionContract} from './execution-contract.mjs';
import {canonicalIdentityJson} from './release-identities.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw Error('E_G0_RECEIPT: '+message);};
export const G0_CASES=Object.freeze({
  'engine-execution':{blocker:'B1-EXEC',checks:['completeModuleBuild','sameEngineRealm','physicsObserved','glOwnershipRecorded']},
  'worker-routing':{blocker:'B2-ROUTING',checks:['explicitRoles','echoReturned','variantTransferred','workerExited']},
  'isolated-host':{blocker:'B3-HOST-DEPLOY',checks:['trustedHttps','separateOrigins','topIsolated','previewIsolated','workerIsolated','sabAvailable','inputObserved','audioObserved','syncHostProbed','imeXrProbed']},
  'session-termination':{blocker:'B4-SESSION',checks:['engineHung','hostResponsive','allOwnedThreadsStopped','hostAudioClosed','portsClosed','staleSessionRejected','nextSessionRunning']},
  'react-native':{blocker:'B5-REACT-INTEGRATION',checks:['crossRootPhaseGuard','cleanupBeforeFree','destroyedExactlyOnce','opaquePortalLifecycle']},
  'execution-identity':{blocker:'B6-IDENTITY',checks:['completeAssetClosure','wrongAssetRejected','wrongModelRejected','wrongProtocolRejected','wrongExtensionRejected']},
  'project-write':{blocker:'B7-PROJECT-WRITE',checks:['oldNewLaunchPreserved','sourcePreserved','uidMapsPreserved','staleCacheRejected','interruptionRecovered','conflictRecovered']},
});
const required={W1:[],W2:['B1-EXEC','B2-ROUTING'],W3:[],W4:['B1-EXEC','B5-REACT-INTEGRATION'],W5:[],W6:[],W7:['B1-EXEC','B2-ROUTING','B3-HOST-DEPLOY','B4-SESSION','B6-IDENTITY'],W8:['B1-EXEC','B2-ROUTING','B3-HOST-DEPLOY','B4-SESSION','B5-REACT-INTEGRATION','B6-IDENTITY'],W9:['B7-PROJECT-WRITE']};
export function calculateReadiness(clearedBlockers=[]) {
  const cleared=new Set(clearedBlockers);
  for(const value of cleared)if(!Object.values(G0_CASES).some(item=>item.blocker===value))fail('Unknown cleared blocker '+value);
  return Object.fromEntries(Object.entries(required).map(([id,dependencies])=>{
    const blockedBy=dependencies.filter(item=>!cleared.has(item));
    return [id,{developmentStart:'GO',integrationReady:blockedBy.length===0,blockedBy,defaultActivationReady:false,...(id==='W9'?{defaultActivationBlockedBy:['G1','G2',...blockedBy]}:{})}];
  }));
}
function inside(root,path){
  if(typeof path!=='string'||!path||isAbsolute(path))fail('Reports and assets require relative paths');
  const target=resolve(root,path),rel=relative(resolve(root),target);
  if(rel.startsWith('..')||isAbsolute(rel))fail('Evidence escapes receipt directory');
  return target;
}
/** Reports are frozen producer outputs, not status strings supplied by UI. A
 * passing case needs observed assertions and the exact producer/report bytes. */
export async function validateG0Receipt(receipt,{root='.',expectedSourceHash,expectedExecution}={}) {
  if(receipt?.schemaVersion!==1||receipt.kind!=='worker-g0-receipt'||typeof receipt.validationBatchId!=='string'||!receipt.validationBatchId)fail('Unsupported receipt');
  for(const key of ['sourceSnapshotHash','producerHash'])if(!hash(receipt[key]))fail('Missing '+key);
  if(expectedSourceHash&&receipt.sourceSnapshotHash!==expectedSourceHash)fail('Source snapshot differs');
  validateExecutionContract(receipt.execution,{requireWorkerAssets:true});
  if(expectedExecution&&canonicalIdentityJson(receipt.execution)!==canonicalIdentityJson(expectedExecution))fail('Execution contract differs');
  if(!Array.isArray(receipt.artifacts)||!receipt.artifacts.length||!Array.isArray(receipt.cases))fail('Missing actual artifacts or cases');
  const paths=new Set();
  for(const asset of receipt.artifacts){
    if(paths.has(asset.path)||!hash(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0)fail('Invalid/duplicate artifact');paths.add(asset.path);
    inside(root,asset.path);
    const bytes=await readFile(inside(root,asset.sourcePath??asset.path));if(bytes.length!==asset.bytes||sha(bytes)!==asset.sha256)fail('Artifact changed: '+asset.path);
  }
  for(const asset of receipt.execution.workerAssets??[]){const sealed=receipt.artifacts.find(item=>item.path===asset.path);if(!sealed||sealed.sha256!==asset.sha256||sealed.bytes!==asset.bytes)fail('Worker is outside receipt asset closure');}
  const seen=new Set(),cleared=[];
  for(const item of receipt.cases){
    const spec=G0_CASES[item.id];if(!spec||seen.has(item.id)||!['passed','failed','unsupported','unverified'].includes(item.status))fail('Invalid/duplicate case');seen.add(item.id);
    if(!Array.isArray(item.limitations))fail('Every case records limitations');
    if(item.status!=='passed')continue;
    if(!hash(item.reportHash))fail('Passing case has no report identity');
    if(item.producerHash!==undefined&&!hash(item.producerHash))fail('Passing case has no producer identity');
    const bytes=await readFile(inside(root,item.reportPath));if(sha(bytes)!==item.reportHash)fail('Report changed: '+item.id);
    const report=JSON.parse(bytes);
    if(report.status!=='passed')fail('Passing receipt case points to a non-passing scoped report: '+item.id);
    if(report.validationBatchId!==receipt.validationBatchId||report.sourceSnapshotHash!==receipt.sourceSnapshotHash||report.producerHash!==(item.producerHash??receipt.producerHash))fail('Stale producer/source/batch: '+item.id);
    if(report.caseId!==item.id||spec.checks.some(check=>report.observed?.[check]!==true))fail('Missing observed assertion: '+item.id);
    if(item.id!=='execution-identity'&&item.id!=='project-write'){
      if(report.evidenceKind!=='browser-runtime')fail('Browser case requires runtime evidence, not a build or mock: '+item.id);
      const env=report.environment;
      if(!env||!['chromium','firefox','webkit','safari'].includes(env.browser)||!env.browserVersion||!env.os)fail('Passing browser case lacks actual environment');
      if(item.id==='isolated-host'){
        const top=new URL(env.topOrigin),preview=new URL(env.previewOrigin);
        if(top.protocol!=='https:'||preview.protocol!=='https:'||top.origin===preview.origin||!env.responseHeaders)fail('Missing actual HTTPS deployment');
      }
    }
    if(report.parentEvidence){
      const parent=report.parentEvidence;
      if(!hash(parent.sha256)||typeof parent.caseId!=='string')fail('Invalid parent runtime evidence');
      const bytes=await readFile(inside(root,parent.path));
      if(sha(bytes)!==parent.sha256)fail('Parent runtime evidence changed');
      const raw=JSON.parse(bytes),scoped=raw.cases?.find(candidate=>candidate.id===parent.caseId);
      if(parent.testSuite){
        if(!['execution-identity','project-write'].includes(item.id)||raw.status!=='passed'||raw.tests?.failed!==0||!(raw.tests?.passed>0))fail('Invalid nonbrowser parent test suite');
        const logPath=raw.log?.path??raw.tests?.report,logHash=raw.log?.sha256??raw.tests?.reportSha256;
        if(logPath!==undefined||logHash!==undefined){
          if(!hash(logHash))fail('Parent unit log has no identity');
          const log=await readFile(inside(root,relative(resolve(root),resolve(dirname(inside(root,parent.path)),logPath))));
          if(sha(log)!==logHash)fail('Parent unit log changed');
        }
      }else if(scoped?.status!=='passed')fail('Parent report has no passed scoped runtime case');
    }
    cleared.push(spec.blocker);
  }
  return {status:'validated',validationBatchId:receipt.validationBatchId,clearedBlockers:cleared,workPackages:calculateReadiness(cleared),defaultReleaseReady:false};
}
/** Collect real immutable files; omitted/unfinished cases are explicitly
 * unverified rather than silently converted into successful readiness. */
export async function collectG0Receipt({root='.',sourceSnapshotHash,producerHash,validationBatchId,execution,artifactPaths,caseReports={}}){
  const artifacts=[];
  for(const entry of artifactPaths??[]){
    const item=typeof entry==='string'?{path:entry}:entry;
    inside(root,item.path);
    const bytes=await readFile(inside(root,item.sourcePath??item.path));artifacts.push({...item,sha256:sha(bytes),bytes:bytes.length});
  }
  const cases=[];
  for(const id of Object.keys(G0_CASES)){
    const path=caseReports[id];
    if(!path){cases.push({id,status:'unverified',limitations:['No producer report was supplied.']});continue;}
    const bytes=await readFile(inside(root,path)),report=JSON.parse(bytes);
    cases.push({id,status:report.status??'unverified',reportPath:path,reportHash:sha(bytes),producerHash:report.producerHash,limitations:report.limitations??[]});
  }
  const receipt={schemaVersion:1,kind:'worker-g0-receipt',validationBatchId,sourceSnapshotHash,producerHash,execution,artifacts,cases};
  const readiness=await validateG0Receipt(receipt,{root});
  return {receipt,readiness};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const filename=resolve(process.argv[2]??'g0-receipt.json');const receipt=JSON.parse(await readFile(filename,'utf8'));console.log(JSON.stringify(await validateG0Receipt(receipt,{root:resolve(filename,'..')}),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
