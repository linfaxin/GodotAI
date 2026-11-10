import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REQUIRED_SOURCE_PATHS,EVIDENCE_SCHEMA_VERSION,canonicalJson,sha256,collectSourceHashes,repositoryRoot,evidenceRoot} from './evidence-utils.mjs';

const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const REQUIRED_API_CHECKS=Object.freeze(['classMetadata','nativeVector','nativeTransform','nativeColor','nodeIdentityAndNavigation','nativePropertyAccessors','nativeObjectLifetime','nativeObjectLifetimeAfterReallocation','sharedResourceIdentity','arrayDictionaryAndPackedArray','callableAndSignals','int64Positive','int64Negative','int64Boundaries','int64NativeReturn','int64InvalidInputs','resourceInstanceId','fullModuleNoise','genericBuiltinMetadata','genericUtilityMetadata']);
export const REQUIRED_TYPE_CHECKS=Object.freeze(['declarationSyntax','positive','wrongArgument','wrongInheritance','readonlyProperty','wrongSignal','wrongBuiltin']);
export const REQUIRED_REACT_CHECKS=Object.freeze(['commitOnly','abandonedRender','strictNoDuplicate','nativeRef','variantProps','removedPropertyRestore','resourceIdentity','resourceSharing','signalUpdate','signalCleanup','signalReentrantUnmount','externalFree','portalBorrowed','processHook','physicsHook','physicsQuery','unmount','allocationAccounting','noLegacyBridge']);
export const REQUIRED_LIFECYCLE_CHECKS=Object.freeze(['public-engine-memory-PCK-real-physics-audio-pointerlock','wrong-run-message-ignored-and-quit-refusal-forced-disposal','native-lifecycle-and-promise-errors-preserve-source','real-engine-cancellation-at-six-startup-phases','repeated-fresh-native-instances-clean-exit']);
export const RAPID_CHECK='rapid-run-replacement-keeps-one-active-instance-and-private-pack';
export const REQUIRED_REPORT_FILES=Object.freeze(['api-snake-browser.json','api-camel-browser.json','api-naming-stability.json','api-types-snake-report.json','api-types-camel-report.json','boot-browser.json','boot-uid-browser.json','boot-fault-browser.json','react-browser.json','react-aba-browser.json','web-weak-callback-browser.json','lifecycle-default-full/lifecycle-report.json','lifecycle-stream-full/lifecycle-report.json','lifecycle-rapid-full/lifecycle-report.json']);

function candidateIssues(candidate,currentSources){
 const errors=[];
 if(candidate?.schemaVersion!==EVIDENCE_SCHEMA_VERSION)errors.push('schema-2-candidate-required');
 if(typeof candidate?.candidateId!=='string'||!candidate.candidateId||typeof candidate?.validationRunId!=='string'||!candidate.validationRunId)errors.push('candidate-identity-required');
 if(!hex(candidate?.engine?.jsSha256)||!hex(candidate?.engine?.wasmSha256))errors.push('candidate-engine-hashes-required');
 if(!Number.isFinite(Date.parse(candidate?.createdAt)))errors.push('candidate-created-at-required');
 if(!candidate?.sourceHashes||!Object.keys(candidate.sourceHashes).length)errors.push('candidate-source-hashes-required');
 for(const [name,hash]of Object.entries(candidate?.sourceHashes??{}))if(!hex(hash)||currentSources?.[name]!==hash)errors.push('candidate-source-changed:'+name);
 return errors;
}
function receiptIssues(report,role,candidate){
 const issues=[],receipt=report?.evidenceReceipt;
 if(receipt?.schemaVersion!==EVIDENCE_SCHEMA_VERSION)return ['schema-2-evidence-required'];
 if(receipt.candidateId!==candidate?.candidateId||receipt.validationRunId!==candidate?.validationRunId)issues.push('stale-or-different-candidate');
 if(!Number.isFinite(Date.parse(receipt.createdAt))||Date.parse(receipt.createdAt)<Date.parse(candidate?.createdAt))issues.push('stale-evidence-time');
 if(receipt.engine?.jsSha256!==candidate?.engine?.jsSha256||receipt.engine?.wasmSha256!==candidate?.engine?.wasmSha256)issues.push('different-engine');
 for(const name of REQUIRED_SOURCE_PATHS[role])if(!hex(receipt.sourceHashes?.[name])||receipt.sourceHashes[name]!==candidate?.sourceHashes?.[name])issues.push('different-or-missing-source:'+name);
 for(const [name,hash]of Object.entries(receipt.sourceHashes??{}))if(!hex(hash)||candidate?.sourceHashes?.[name]!==hash)issues.push('different-source:'+name);
 const engine=report?.engine;
 if(engine){const js=engine.jsSha??engine.js,wasm=engine.wasmSha??engine.wasm;if(js!==candidate?.engine?.jsSha256||wasm!==candidate?.engine?.wasmSha256)issues.push('report-engine-differs-from-receipt');}
 return issues;
}
function checkBooleans(checks,required){
 const issues=[];
 if(!checks||typeof checks!=='object'||Array.isArray(checks)||!Object.keys(checks).length)return ['nonempty-check-set-required'];
 for(const name of required)if(checks[name]!==true)issues.push('required-check-not-passed:'+name);
 for(const [name,value]of Object.entries(checks))if(value!==true)issues.push('check-not-passed:'+name);
 return [...new Set(issues)];
}
function lifecycleIssues(report,playback,rapid=false){
 const issues=[];
 if(report?.status!=='passed')issues.push('report-not-passed');
 if(report?.audioPlayback!==playback)issues.push('wrong-audio-playback');
 const checks=Array.isArray(report?.checks)?report.checks:[];
 if(!checks.length)issues.push('nonempty-case-set-required');
 const names=new Set();for(const item of checks){if(names.has(item.name))issues.push('duplicate-case:'+item.name);names.add(item.name);if(item.status!=='passed')issues.push('case-not-passed:'+item.name);}
 for(const name of rapid?[RAPID_CHECK]:REQUIRED_LIFECYCLE_CHECKS)if(!checks.some(item=>item.name===name&&item.status==='passed'))issues.push('required-case-not-passed:'+name);
 if(rapid){
  const result=checks.find(item=>item.name===RAPID_CHECK)?.evidence;
  if(!Array.isArray(result)||result.length<5||!result.every(item=>item.frames===1&&item.superseded?.resolved===false&&item.native?.rayHit===true&&item.exit?.reason==='clean-exit'&&item.exit?.code===0&&item.exit?.runId===item.active?.runId))issues.push('five-rapid-replacements-required');
 }else{
  const repeated=checks.find(item=>item.name==='repeated-fresh-native-instances-clean-exit');
  const runs=Array.isArray(report?.runs)?report.runs:[],validRuns=runs.filter(item=>typeof item.runId==='string'&&item.exit?.runId===item.runId&&item.exit?.reason==='clean-exit'&&item.exit?.code===0&&item.native?.rayHit===true);
  if(!Number.isInteger(report?.iterations)||report.iterations<50||!(repeated?.evidence?.uniqueRuns>=50)||new Set(validRuns.map(item=>item.runId)).size<50)issues.push('fifty-real-runs-required');
 }
 if(!Array.isArray(report?.errors)||report.errors.length)issues.push('browser-errors-or-missing-error-observation');
 return issues;
}

/** Pure assessment. Inputs are explicit so missing and stale evidence can be tested. */
export function assessEvidence({candidate,reports,currentSources,artifacts={}}){
 const candidateErrors=candidateIssues(candidate,currentSources),gates=[];
 const inspect=(file,role)=>{const report=reports[file],issues=report?receiptIssues(report,role,candidate):['missing-report'];return {report,issues:issues.map(issue=>file+':'+issue)};};
 const gate=(id,evidence,issues)=>gates.push({id,status:issues.length||candidateErrors.length?'blocked':'passed',issues:[...candidateErrors,...issues],evidence});
 let issues=[];
 for(const naming of ['snake','camel']){
  const file=`api-${naming}-browser.json`,item=inspect(file,'api');issues.push(...item.issues);
  if(item.report?.status!=='passed'||item.report?.executionStatus!=='completed'||item.report?.report?.status!=='passed')issues.push(file+':report-not-passed');
  if(item.report?.report?.naming!==naming)issues.push(file+':wrong-naming');
  issues.push(...checkBooleans(item.report?.report?.checks,REQUIRED_API_CHECKS).map(issue=>file+':'+issue));
  if(!(item.report?.report?.observations?.classCount>0)||item.report?.report?.observations?.bindableClasses!==item.report?.report?.observations?.classCount)issues.push(file+':class-binding-inventory-not-complete');
  const typesFile=`api-types-${naming}-report.json`,types=inspect(typesFile,'types');issues.push(...types.issues);
  if(types.report?.status!=='passed'||types.report?.naming!==naming)issues.push(typesFile+':report-not-passed-or-wrong-naming');
  issues.push(...checkBooleans(types.report?.checks,REQUIRED_TYPE_CHECKS).map(issue=>typesFile+':'+issue));
  const expected=artifacts[`api-${naming}-api-ir.json`];if(!hex(expected)||types.report?.irSha256!==expected)issues.push(typesFile+':different-or-missing-input-ir');
 }
 const stable=inspect('api-naming-stability.json','stability');issues.push(...stable.issues);
 if(stable.report?.status!=='passed'||stable.report?.stableSnakeIR!==true)issues.push('api-naming-stability.json:stability-not-passed');
 const rounds=stable.report?.rounds??[];
 if(!Array.isArray(rounds)||rounds.filter(item=>item.mode==='snake').length<2||!rounds.some(item=>item.mode==='camel'))issues.push('api-naming-stability.json:required-rounds-missing');
 else{
  const snake=rounds.filter(item=>item.mode==='snake');
  if(!snake.every(item=>hex(item.apiHash)&&item.apiHash===snake[0].apiHash)||snake[0].apiHash!==artifacts['api-snake-api-ir.json'])issues.push('api-naming-stability.json:snake-ir-hash-mismatch');
  if(!rounds.filter(item=>item.mode==='camel').every(item=>item.apiHash===artifacts['api-camel-api-ir.json']))issues.push('api-naming-stability.json:camel-ir-hash-mismatch');
  if(!rounds.every(item=>item.status==='passed'))issues.push('api-naming-stability.json:round-not-passed');
 }
 gate('G1',['api-snake-browser.json','api-camel-browser.json','api-naming-stability.json','api-types-snake-report.json','api-types-camel-report.json'],issues);
 issues=[];
 for(const name of ['boot','boot-uid','boot-fault']){
  const file=name+'-browser.json',item=inspect(file,name==='boot-fault'?'bootFault':'boot');issues.push(...item.issues);
  if(item.report?.status!=='passed'||item.report?.executionStatus!=='completed')issues.push(file+':report-not-passed');
  if(name==='boot-fault'){
   if(item.report?.report?.processContinued!==true)issues.push(file+':process-recovery-not-observed');
   const log=[...(item.report?.native?.events??[]),...(item.report?.logs??[]).map(line=>line.text)].join('\n');
   if(!log.includes('P0_EXPECTED_READY_FAILURE')||!log.includes('src/fault-entry.ts:4'))issues.push(file+':source-map-error-not-observed');
  }else{
   for(const kind of ['Node','Node2D','Control','scene'])if(item.report?.report?.entries?.[kind]?.ready!==true)issues.push(file+':missing-entry-lifecycle:'+kind);
   if(item.report?.report?.sceneLoads!==2)issues.push(file+':scene-reload-not-observed');
  }
 }
 gate('G2',['boot-browser.json','boot-uid-browser.json','boot-fault-browser.json'],issues);
 issues=[];const react=inspect('react-browser.json','react'),aba=inspect('react-aba-browser.json','aba');issues.push(...react.issues,...aba.issues);
 if(react.report?.status!=='passed'||react.report?.report?.status!=='passed')issues.push('react-browser.json:report-not-passed');
 issues.push(...checkBooleans(react.report?.report?.checks,REQUIRED_REACT_CHECKS).map(issue=>'react-browser.json:'+issue));
 if(aba.report?.status!=='passed'||aba.report?.report?.status!=='passed'||aba.report?.report?.validAfterFree!==false||aba.report?.report?.reproduced!==false||!(aba.report?.report?.allocationAttempts>0))issues.push('react-aba-browser.json:stale-reference-regression-not-passed');
 const weak=inspect('web-weak-callback-browser.json','webWeak');issues.push(...weak.issues);
 if(weak.report?.status!=='passed'||weak.report?.executionStatus!=='completed'||weak.report?.report?.status!=='passed')issues.push('web-weak-callback-browser.json:report-not-passed');
 for(const [name,minimum]of [['simulatedDeaths',32],['deliveredFinalizers',96],['generationReplays',32]])if(!Number.isInteger(weak.report?.report?.[name])||weak.report.report[name]<minimum)issues.push('web-weak-callback-browser.json:insufficient-'+name);
 if(!Array.isArray(weak.report?.errors)||weak.report.errors.length)issues.push('web-weak-callback-browser.json:browser-errors-or-missing-error-observation');
 gate('G3',['react-browser.json','react-aba-browser.json','web-weak-callback-browser.json'],issues);
 issues=[];const lifecycleFiles=[];
 for(const [folder,playback,rapid]of [['lifecycle-default-full','default',false],['lifecycle-stream-full','stream',false],['lifecycle-rapid-full','stream',true]]){
  const file=folder+'/lifecycle-report.json',item=inspect(file,'lifecycle');lifecycleFiles.push(file);issues.push(...item.issues,...lifecycleIssues(item.report,playback,rapid).map(issue=>file+':'+issue));
 }
 gate('G4',lifecycleFiles,issues);
 const passed=gates.every(item=>item.status==='passed');
 return {schemaVersion:EVIDENCE_SCHEMA_VERSION,status:passed?'blockers-cleared':'blocked',candidateId:candidate?.candidateId??null,validationRunId:candidate?.validationRunId??null,
  engineeringStart:{status:passed?'go':'conditional-go',meaning:passed?'Prerequisite blocker regressions passed; proceed with dependent implementation.':'Independent engineering and blocker repairs can proceed; dependent lifecycle integration remains gated.'},
  defaultReleaseReady:false,defaultReleaseLimitations:['P0 type-consumer checks do not certify all production declarations.','Production preview deployment and migration/recovery acceptance remain separate release gates.'],gates,
  blockers:gates.filter(item=>item.status!=='passed').map(item=>({gate:item.id,issues:item.issues})),evidenceSchema:2};
}

export async function assessDirectory({directory=evidenceRoot(),repoRoot=repositoryRoot()}={}){
 const reports={},artifacts={};let candidate;
 try{candidate=JSON.parse(await readFile(path.join(directory,'candidate-receipt.json'),'utf8'));}catch{}
 for(const file of REQUIRED_REPORT_FILES)try{reports[file]=JSON.parse(await readFile(path.join(directory,file),'utf8'));}catch{}
 for(const name of ['api-snake-api-ir.json','api-camel-api-ir.json'])try{artifacts[name]=sha256(canonicalJson(JSON.parse(await readFile(path.join(directory,name),'utf8'))));}catch{}
 let currentSources={};for(const name of Object.keys(candidate?.sourceHashes??{}))try{Object.assign(currentSources,await collectSourceHashes([name],{repoRoot}));}catch{}
 const assessment=assessEvidence({candidate,reports,currentSources,artifacts});await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'assessment.json'),JSON.stringify(assessment,null,2));return assessment;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const assessment=await assessDirectory();console.log(JSON.stringify({status:assessment.status,engineeringStart:assessment.engineeringStart,defaultReleaseReady:assessment.defaultReleaseReady,gates:assessment.gates.map(({id,status,issues})=>({id,status,issues})),evidence:path.join(evidenceRoot(),'assessment.json')},null,2));if(assessment.status!=='blockers-cleared')process.exitCode=2;
}
