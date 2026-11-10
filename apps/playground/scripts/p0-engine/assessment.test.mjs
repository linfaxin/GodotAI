import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {assessEvidence,assessDirectory,REQUIRED_API_CHECKS,REQUIRED_TYPE_CHECKS,REQUIRED_REACT_CHECKS,REQUIRED_LIFECYCLE_CHECKS,RAPID_CHECK} from './assess.mjs';
import {REQUIRED_SOURCE_PATHS,sha256,createCandidateReceipt,createEvidenceReceipt} from './evidence-utils.mjs';

const booleans=names=>Object.fromEntries(names.map(name=>[name,true]));
function passingEvidence(){
 const sourceHashes=Object.fromEntries([...new Set(Object.values(REQUIRED_SOURCE_PATHS).flat())].map(name=>[name,sha256(name)]));
 sourceHashes['bridge/extra-engine-input.cpp']=sha256('engine input');
 const engine={jsSha256:sha256('engine JS'),wasmSha256:sha256('engine WASM')};
 const candidate={schemaVersion:2,candidateId:'candidate-A',validationRunId:'validation-A',createdAt:'2026-11-10T00:00:00.000Z',engine,sourceHashes};
 const receipt=role=>({schemaVersion:2,candidateId:candidate.candidateId,validationRunId:candidate.validationRunId,createdAt:'2026-11-10T00:01:00.000Z',engine:{...engine},sourceHashes:Object.fromEntries(REQUIRED_SOURCE_PATHS[role].map(name=>[name,sourceHashes[name]]))});
 const report=(role,fields)=>({evidenceReceipt:receipt(role),...fields});
 const reports={},artifacts={};
 for(const naming of ['snake','camel']){
  artifacts[`api-${naming}-api-ir.json`]=sha256('IR '+naming);
  reports[`api-${naming}-browser.json`]=report('api',{status:'passed',executionStatus:'completed',engine:{js:engine.jsSha256,wasm:engine.wasmSha256},report:{status:'passed',naming,checks:booleans(REQUIRED_API_CHECKS),observations:{classCount:902,bindableClasses:902}}});
  reports[`api-types-${naming}-report.json`]=report('types',{status:'passed',naming,checks:booleans(REQUIRED_TYPE_CHECKS),irSha256:artifacts[`api-${naming}-api-ir.json`]});
 }
 reports['api-naming-stability.json']=report('stability',{status:'passed',stableSnakeIR:true,rounds:[{mode:'snake',status:'passed',apiHash:artifacts['api-snake-api-ir.json']},{mode:'snake',status:'passed',apiHash:artifacts['api-snake-api-ir.json']},{mode:'camel',status:'passed',apiHash:artifacts['api-camel-api-ir.json']}]});
 for(const name of ['boot','boot-uid'])reports[name+'-browser.json']=report('boot',{status:'passed',executionStatus:'completed',report:{sceneLoads:2,entries:Object.fromEntries(['Node','Node2D','Control','scene'].map(kind=>[kind,{ready:true}]))}});
 reports['boot-fault-browser.json']=report('bootFault',{status:'passed',executionStatus:'completed',report:{processContinued:true},native:{events:['P0_EXPECTED_READY_FAILURE res://src/fault-entry.ts:4:1']},logs:[]});
 reports['react-browser.json']=report('react',{status:'passed',report:{status:'passed',checks:booleans(REQUIRED_REACT_CHECKS)}});
 reports['react-aba-browser.json']=report('aba',{status:'passed',report:{status:'passed',validAfterFree:false,reproduced:false,allocationAttempts:128}});
 reports['web-weak-callback-browser.json']=report('webWeak',{status:'passed',executionStatus:'completed',report:{status:'passed',simulatedDeaths:32,deliveredFinalizers:96,generationReplays:32},errors:[]});
 const cleanRun=i=>({runId:'run-'+i,exit:{runId:'run-'+i,reason:'clean-exit',code:0},native:{rayHit:true}});
 for(const [folder,playback]of [['lifecycle-default-full','default'],['lifecycle-stream-full','stream']])reports[folder+'/lifecycle-report.json']=report('lifecycle',{status:'passed',audioPlayback:playback,iterations:50,checks:REQUIRED_LIFECYCLE_CHECKS.map(name=>({name,status:'passed',evidence:name==='repeated-fresh-native-instances-clean-exit'?{uniqueRuns:50}:[]})),runs:Array.from({length:50},(_,i)=>cleanRun(i)),errors:[]});
 reports['lifecycle-rapid-full/lifecycle-report.json']=report('lifecycle',{status:'passed',audioPlayback:'stream',checks:[{name:RAPID_CHECK,status:'passed',evidence:Array.from({length:5},(_,i)=>({frames:1,superseded:{resolved:false},native:{rayHit:true},active:{runId:'rapid-'+i},exit:{runId:'rapid-'+i,reason:'clean-exit',code:0}}))}],errors:[]});
 return {candidate,reports,currentSources:{...sourceHashes},artifacts};
}
const gate=(input,id)=>assessEvidence(input).gates.find(item=>item.id===id);

test('fresh complete evidence clears prerequisites without certifying default release',()=>{
 const result=assessEvidence(passingEvidence());assert.equal(result.status,'blockers-cleared');assert.equal(result.engineeringStart.status,'go');assert.equal(result.defaultReleaseReady,false);assert(result.gates.every(item=>item.status==='passed'));
});
test('missing, empty and additional failed cases cannot pass',()=>{
 for(const mutate of [input=>delete input.reports['boot-browser.json'],input=>delete input.reports['web-weak-callback-browser.json'],input=>input.reports['react-browser.json'].report.checks={},input=>delete input.reports['api-camel-browser.json'].report.checks.nativeVector,input=>input.reports['react-browser.json'].report.checks.futureRegression=false]){
  const input=passingEvidence();mutate(input);assert.equal(assessEvidence(input).status,'blocked');
 }
});
test('IR stability and type failures block G1 even if API checks all pass',()=>{
 for(const mutate of [input=>input.reports['api-naming-stability.json'].stableSnakeIR=false,input=>input.reports['api-types-snake-report.json'].status='failed',input=>input.reports['api-types-camel-report.json'].checks.wrongSignal=false,input=>input.reports['api-types-camel-report.json'].irSha256=sha256('different IR'),input=>input.reports['api-naming-stability.json'].rounds=[]]){
  const input=passingEvidence();mutate(input);assert.equal(gate(input,'G1').status,'blocked');
 }
});
test('same engine with different runner or fixture source is rejected',()=>{
 for(const [file,source]of [['lifecycle-stream-full/lifecycle-report.json','scripts/jsb.react-browser/src/runner.ts'],['react-browser.json','apps/playground/scripts/p0-engine/react-probe.ts']]){
  const input=passingEvidence();input.reports[file].evidenceReceipt.sourceHashes[source]=sha256('other source');assert.equal(assessEvidence(input).status,'blocked');
 }
});
test('all frozen candidate sources including engine-only inputs must remain unchanged',()=>{
 const input=passingEvidence();input.currentSources['bridge/extra-engine-input.cpp']=sha256('changed after build');const result=assessEvidence(input);assert.equal(result.status,'blocked');assert(result.gates.every(item=>item.issues.some(issue=>issue.startsWith('candidate-source-changed:'))));
});
test('old schema, previous validation run and old timestamps are not reusable',()=>{
 for(const mutate of [input=>delete input.reports['react-browser.json'].evidenceReceipt,input=>input.reports['api-snake-browser.json'].evidenceReceipt.schemaVersion=1,input=>input.reports['boot-browser.json'].evidenceReceipt.validationRunId='previous-run',input=>input.reports['boot-browser.json'].evidenceReceipt.createdAt='2026-11-09T00:00:00.000Z']){
  const input=passingEvidence();mutate(input);assert.equal(assessEvidence(input).status,'blocked');
 }
});
test('empty static blocker summaries cannot override failed or absent actual lifecycle cases',()=>{
 const input=passingEvidence();input.reports['lifecycle-findings.json']={status:'passed',blockers:[]};input.reports['lifecycle-default-full/lifecycle-report.json'].checks[0].status='failed';assert.equal(gate(input,'G4').status,'blocked');
 input.reports['lifecycle-default-full/lifecycle-report.json'].checks=[];assert.equal(gate(input,'G4').status,'blocked');
});
test('stream success cannot substitute for default sample, fifty runs or five rapid replacements',()=>{
 for(const mutate of [input=>input.reports['lifecycle-default-full/lifecycle-report.json'].audioPlayback='stream',input=>input.reports['lifecycle-stream-full/lifecycle-report.json'].runs=[],input=>input.reports['lifecycle-default-full/lifecycle-report.json'].runs.forEach(item=>item.runId='duplicate'),input=>input.reports['lifecycle-rapid-full/lifecycle-report.json'].checks[0].evidence.pop()]){
  const input=passingEvidence();mutate(input);assert.equal(gate(input,'G4').status,'blocked');
 }
});
test('ABA, React lifecycle and late Web weak callbacks remain hard blockers',()=>{
 const input=passingEvidence();input.reports['react-aba-browser.json'].report.reproduced=true;assert.equal(gate(input,'G3').status,'blocked');
 input.reports['react-aba-browser.json'].report.reproduced=false;input.reports['react-browser.json'].report.checks.unmount=false;assert.equal(gate(input,'G3').status,'blocked');
 for(const mutate of [value=>value.report.simulatedDeaths=31,value=>value.report.deliveredFinalizers=95,value=>value.report.generationReplays=31,value=>value.executionStatus='failed',value=>value.report.status='failed',value=>value.errors.push('late finalizer error'),value=>delete value.errors]){
  const evidence=passingEvidence();mutate(evidence.reports['web-weak-callback-browser.json']);assert.equal(gate(evidence,'G3').status,'blocked');
 }
});
test('receipt producers bind actual bytes and reject source changes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'p0-receipt-'));
 try{
  const js=path.join(root,'engine.js'),wasm=path.join(root,'engine.wasm'),directory=path.join(root,'evidence');await writeFile(js,'engine');await writeFile(wasm,'wasm');await writeFile(path.join(root,'fixture.js'),'original');
  const candidate=await createCandidateReceipt({engineJs:js,engineWasm:wasm,sourcePaths:['fixture.js'],directory,repoRoot:root});
  const receipt=await createEvidenceReceipt(['fixture.js'],{engineJs:js,engineWasm:wasm,directory,repoRoot:root});assert.equal(receipt.candidateId,candidate.candidateId);assert.equal(receipt.validationRunId,candidate.validationRunId);
  await writeFile(path.join(root,'fixture.js'),'changed');await assert.rejects(()=>createEvidenceReceipt(['fixture.js'],{engineJs:js,engineWasm:wasm,directory,repoRoot:root}),/source differs/);
  await writeFile(path.join(root,'fixture.js'),'original');await writeFile(wasm,'other wasm');await assert.rejects(()=>createEvidenceReceipt(['fixture.js'],{engineJs:js,engineWasm:wasm,directory,repoRoot:root}),/engine differs/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('directory evaluation uses explicit roots and writes blocked assessment for old evidence',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'p0-assess-'));
 try{
  await mkdir(path.join(directory,'repo'));await writeFile(path.join(directory,'api-snake-browser.json'),JSON.stringify({status:'passed',report:{checks:{}}}));
  const result=await assessDirectory({directory,repoRoot:path.join(directory,'repo')});assert.equal(result.status,'blocked');assert.equal(result.schemaVersion,2);assert.equal(JSON.parse(await readFile(path.join(directory,'assessment.json'),'utf8')).defaultReleaseReady,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
