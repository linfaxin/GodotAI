import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {capabilityVariantPlan,collectWorkerCapabilities} from './worker-capability-matrix.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';
import {digest} from './site-evidence.mjs';

async function fixture(t,profile='full-engine-v1'){
 const reports=await mkdtemp(path.join(tmpdir(),'worker-capability-aggregate-'));t.after(()=>rm(reports,{recursive:true,force:true}));
 const variant=capabilityVariantPlan()[0],prefix='worker-capabilities/'+variant.key,directory=path.join(reports,prefix);await mkdir(directory,{recursive:true});
 const browser={name:variant.browser,version:'unit-only-synthetic',platform:'linux',settingsTier:'default'},producer={path:'apps/playground/scripts/browser-native-host-capabilities.mjs',sha256:'a'.repeat(64)};
 const context={schemaVersion:3,profile,releaseId:'release',descriptorHash:'b'.repeat(64),candidateId:'c'.repeat(64),siteHash:'d'.repeat(64),acceptanceBatchId:'batch',testSources:{[producer.path]:producer.sha256}};
 const configuration={executionBackend:'worker',presentationBackend:variant.presentationBackend,runtimeProtocolVersion:2,hostAbiVersion:1,audioAbiVersion:1,presentationAbiVersion:1,budgets:{cleanupTimeoutMs:1000}},configurationHash=runConfigurationHash(configuration),sessions=[{runId:'unit-run',documentId:'unit-doc',workerId:'unit-worker',runConfigurationHash:configurationHash}];
 const probe={...context,schemaVersion:3,kind:'worker-capability-probe',testMode:'real-engine',capability:'fullscreen',classification:'bridged',status:'passed',executionBackend:'worker',presentationBackend:variant.presentationBackend,naming:variant.naming,sdkMode:variant.sdkMode,browser,producer,runConfiguration:configuration,runConfigurationHash:configurationHash,sessions,observations:{supported:true,unitOnly:true},checks:{syntheticUnitFixture:true}};
 const save=async(filename,value)=>{const bytes=Buffer.from(JSON.stringify(value));await writeFile(path.join(directory,filename),bytes);return{path:filename,sha256:digest(bytes),bytes:bytes.length};};
 const probeRef=await save('fullscreen.probe.json',probe),evidence=await save('fullscreen.raw.json',{unitOnly:true});
 const item={capability:'fullscreen',classification:'bridged',status:'passed',executionBackend:'worker',presentationBackend:variant.presentationBackend,naming:variant.naming,sdkMode:variant.sdkMode,browser,sessions,probe:probeRef,evidence:[evidence]};
 const report={...context,browser,presentationBackend:variant.presentationBackend,naming:variant.naming,sdkMode:variant.sdkMode,capabilityCases:[item],cases:[]};
 const reportRef=await save('report.json',report),attempt={...variant,browserEvidence:browser,report:{...reportRef,path:prefix+'/report.json'}};
 return{reports,context,variant,directory,probe,report,item,attempt,save};
}

test('capability matrix lists all 24 scopes and emits a complete blocked aggregate without fake probes',async t=>{
 assert.equal(capabilityVariantPlan().length,24);assert.equal(new Set(capabilityVariantPlan().map(row=>row.key)).size,24);
 for(const profile of ['full-engine-v1','engine-2d-v1']){
  const f=await fixture(t,profile),report=await collectWorkerCapabilities({reports:f.reports,context:f.context,attempts:[]});
  assert.equal(report.status,'blocked');assert.equal(report.coverage.requiredCases,(profile==='full-engine-v1'?32:30)*24);assert.equal(report.cases.length,report.coverage.requiredCases);assert.equal(report.coverage.passingProbeCases,0);assert(report.cases.every(row=>row.status==='blocked'&&!row.probe));
  assert.equal(JSON.parse(await readFile(path.join(f.reports,'worker-capabilities.json'))).acceptanceBatchId,f.context.acceptanceBatchId);
 }
});

test('dedicated same-batch probe bytes survive aggregation with correct relative paths and scope',async t=>{
 const f=await fixture(t),report=await collectWorkerCapabilities({reports:f.reports,context:f.context,attempts:[f.attempt]});
 assert.equal(report.coverage.passingProbeCases,1);assert.equal(report.status,'blocked');assert.equal(report.issues.length,0);
 const observed=report.cases.find(row=>row.status==='passed');assert.equal(observed.probe.path,'worker-capabilities/'+f.variant.key+'/fullscreen.probe.json');assert(observed.evidence.every(row=>row.path.startsWith('worker-capabilities/')));
});

for(const corruption of ['probe-bytes','batch','scope','browser','duplicate','report-bytes'])test('aggregate rejects '+corruption+' instead of promoting it to passing evidence',async t=>{
 const f=await fixture(t);
 if(corruption==='probe-bytes')await writeFile(path.join(f.directory,'fullscreen.probe.json'),'tampered');
 else if(corruption==='report-bytes')await writeFile(path.join(f.directory,'report.json'),'tampered');
 else{
  if(corruption==='batch')f.report.acceptanceBatchId='other-batch';
  if(corruption==='scope')f.report.naming='camel';
  if(corruption==='browser')f.report.browser={...f.report.browser,version:'different-build'};
  if(corruption==='duplicate')f.report.capabilityCases.push(f.item);
  const ref=await f.save('report.json',f.report);f.attempt.report={...ref,path:'worker-capabilities/'+f.variant.key+'/report.json'};
 }
 const report=await collectWorkerCapabilities({reports:f.reports,context:f.context,attempts:[f.attempt]});assert.equal(report.status,'blocked');assert.equal(report.issues.length,1);if(corruption!=='duplicate')assert.equal(report.coverage.passingProbeCases,0);
});
