import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {canonical,digest,sitePayloads} from './site-evidence.mjs';
import {WORKER_RUNTIME_ABI} from '../../../scripts/release/engine-profiles.mjs';
import {WORKER_CANDIDATE_ASSETS,WORKER_NATIVE_PATCH_FILES,assertWorkerBuildProof,describeWorkerCandidate,assertWorkerCandidate,runConfigurationHash,workerAcceptancePlan} from './worker-candidate.mjs';
import {assertWorkerSessionEvidence} from './runtime-evidence.mjs';

const configuration={executionBackend:'worker',presentationBackend:'direct',runtimeProtocolVersion:2,hostAbiVersion:1,audioAbiVersion:1,presentationAbiVersion:1,budgets:{maxInputEvents:1024,cleanupTimeoutMs:1000}};
function buildProof(){
 const implementation={path:'scripts/release/patch-web-worker-runtime.mjs',sha256:digest('patch')},patchId='godotjs-web-worker-runtime-v1';
 const files=Object.fromEntries(WORKER_NATIVE_PATCH_FILES.map(name=>[name,digest(name)]));
 const recipe={args:['platform=web','threads=no','dlink_enabled=no','use_quickjs_ng=no'],patches:Object.entries(files).map(([path,afterSha256])=>({patchId,path,afterSha256,beforeSha256:digest('before '+path),implementation}))};
 return {kind:'godot-js-browser-engine-build',status:'built',runtimeAbi:WORKER_RUNTIME_ABI,workerPatch:{patchId,version:1,implementation,files},recipe,recipeSha256:digest(canonical(recipe)),godotSource:{inputs:files,snapshotHash:digest(canonical(files))}};
}
test('native ABI cannot be attached to old, snapshotted or differently patched bytes',()=>{
 const proof=buildProof();assert.doesNotThrow(()=>assertWorkerBuildProof(proof));
 for(const change of [value=>{delete value.workerPatch;},value=>{value.status='snapshotted';},value=>{value.recipe.patches.pop();value.recipeSha256=digest(canonical(value.recipe));},value=>{value.godotSource.inputs['main/main.cpp']=digest('old');value.godotSource.snapshotHash=digest(canonical(value.godotSource.inputs));},value=>{value.workerPatch.implementation.sha256=digest('other');}]){
  const value=structuredClone(proof);change(value);assert.throws(()=>assertWorkerBuildProof(value),/E_WORKER_BUILD_PROOF/);
 }
});
test('candidate binds host, worker and audio bytes without a manifest hash cycle',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'worker-candidate-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of Object.values(WORKER_CANDIDATE_ASSETS))await writeFile(path.join(directory,name),name);
 const release={runtimeAbi:WORKER_RUNTIME_ABI},runtime=await describeWorkerCandidate(directory,release),payloads=await sitePayloads(directory),manifest={schemaVersion:3,runtime,payloads};
 assert.doesNotThrow(()=>assertWorkerCandidate(manifest,release,payloads));
 assert.deepEqual(runtime.presentationBackends,['direct','bitmap']);assert(!Object.hasOwn(runtime,'candidateId'));
 for(const name of Object.values(WORKER_CANDIDATE_ASSETS)){
  const changed=structuredClone(payloads);changed[name].sha256=digest('changed');assert.throws(()=>assertWorkerCandidate(manifest,release,changed),/E_WORKER_CANDIDATE_ASSET/);
 }
 assert.throws(()=>assertWorkerCandidate(manifest,{},payloads),/E_WORKER_RUNTIME_ABI/);
 for(const name of ['preview.legacy.html','preview.legacy.js','preview.legacy.js.map'])assert.throws(()=>assertWorkerCandidate(manifest,release,{...payloads,[name]:{sha256:digest('retired'),bytes:7}}),/E_WORKER_CANDIDATE_RETIRED_ENTRY/);
});
test('vNext sessions distinguish acceptance batches and reject reused workers, missing cleanup and mismatched configuration',()=>{
 const hash=runConfigurationHash(configuration),session={runId:'session-a',documentId:'document-a',workerId:'worker-a',runtime:'react',executionBackend:'worker',presentationBackend:'direct',runConfigurationHash:hash,workerState:'terminated',workerErrors:[],glErrors:[]};
 const report={schemaVersion:3,acceptanceBatchId:'batch-a',runConfiguration:configuration,runConfigurationHash:hash,sessions:[session]};
 assert.doesNotThrow(()=>assertWorkerSessionEvidence(report));
 assert.equal(runConfigurationHash({...configuration,budgets:{cleanupTimeoutMs:1000,maxInputEvents:1024}}),hash);
 for(const change of [value=>{value.schemaVersion=2;},value=>{value.runId=value.acceptanceBatchId;},value=>{value.sessions.push({...session});},value=>{value.sessions[0].workerState='unknown';},value=>{delete value.sessions[0].glErrors;},value=>{value.runConfiguration.budgets.cleanupTimeoutMs++;},value=>{value.sessions[0].workerId=value.acceptanceBatchId;}]){
  const value=structuredClone(report);change(value);assert.throws(()=>assertWorkerSessionEvidence(value),/E_SITE_WORKER_EVIDENCE/);
 }
});
test('Node evidence hashes exactly the shared Worker protocol configuration and rejects unknown fields',async()=>{
 const shared=await import('../../../scripts/jsb.react-browser/src/worker-protocol.ts');
 assert.equal(runConfigurationHash(configuration),await shared.hashWorkerRunConfiguration(configuration));
 assert.equal(runConfigurationHash(shared.DEFAULT_WORKER_RUN_CONFIGURATION),await shared.hashWorkerRunConfiguration(shared.DEFAULT_WORKER_RUN_CONFIGURATION));
 assert.throws(()=>runConfigurationHash({...configuration,ignored:'would change the requested contract'}),/E_WORKER_RUN_CONFIGURATION_FIELDS/);
});
test('expected React failures retain explicit source and outcome evidence without weakening normal runtime cleanup',()=>{
 const marker='BRIDGE_FAILURE_RENDER',hash=runConfigurationHash(configuration),session={runId:'failure-run',documentId:'failure-document',workerId:'failure-worker',runtime:'react',executionBackend:'worker',presentationBackend:'direct',runConfigurationHash:hash,workerState:'native-exited',workerErrors:[marker],glErrors:[],exit:{reason:'crashed',engineOutcome:{kind:'native-exit',code:0},hostCleanup:{status:'complete'}},expectedFailure:{kind:'render',marker,sourcePath:'res://src/App.tsx',logs:marker+'\n at res://src/App.tsx:1:1',authoredSource:true,iframeDisposed:true}};
 Object.assign(session,{revision:1,buildKey:'synthetic-build',generation:1});
 const originalSnapshot=structuredClone(session);delete originalSnapshot.expectedFailure;originalSnapshot.exit=null;
 const identity=Object.fromEntries(['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'].map(key=>[key,session[key]]));
 session.exit={...identity,protocolVersion:2,type:'exit-report',...session.exit,code:0};
 session.terminalObservation={schemaVersion:1,source:'parent-port',parentURL:'http://editor.test/',portId:'synthetic-port',connected:{...identity,protocolVersion:2,type:'connected'},connectedSequence:1,receiptSequence:2,connectedAtMs:1,receiptAtMs:2,snapshotReadAtMs:1,receiptReceivedAtMs:2,joinedAtMs:3,snapshot:originalSnapshot,receipt:session.exit};
 const report={schemaVersion:3,suite:'engine-bridge',acceptanceBatchId:'batch',runConfiguration:configuration,runConfigurationHash:hash,sessions:[session]};
 assert.doesNotThrow(()=>assertWorkerSessionEvidence(report));
 for(const change of [value=>{delete value.sessions[0].terminalObservation;},value=>{value.suite='workbench';},value=>{value.sessions[0].expectedFailure.iframeDisposed=false;},value=>{value.sessions[0].workerErrors.push('unrelated failure');},value=>{value.sessions[0].expectedFailure.logs=marker;},value=>{delete value.sessions[0].expectedFailure.sourcePath;},value=>{value.sessions[0].expectedFailure.sourcePath='res://src/Other.tsx';},value=>{value.sessions[0].expectedFailure.sourcePath='res://src/../App.tsx';},value=>{value.sessions[0].exit.hostCleanup.status='timed-out';}]){
  const value=structuredClone(report);change(value);assert.throws(()=>assertWorkerSessionEvidence(value),/E_SITE_WORKER_EVIDENCE/);
 }
 const renamed=structuredClone(report),failure=renamed.sessions[0].expectedFailure;
 renamed.suite='workbench';failure.marker='PLAYGROUND_EXPECTED_FAILURE';failure.sourcePath='res://src/LightRoom.tsx';failure.logs=failure.marker+'\n at '+failure.sourcePath+':1:40';renamed.sessions[0].workerErrors=[failure.marker];renamed.sessions[0].terminalObservation.snapshot.workerErrors=[failure.marker];
 assert.doesNotThrow(()=>assertWorkerSessionEvidence(renamed));
 assert.throws(()=>assertWorkerSessionEvidence(report,{runtime:true}),/E_SITE_WORKER_EVIDENCE/);
});
test('Worker acceptance plan distinguishes both presenters and browser suites for both engine profiles',()=>{
 for(const profile of ['full-engine-v1','engine-2d-v1']){
  const plan=workerAcceptancePlan(profile);assert.equal(new Set(plan.map(entry=>entry.name)).size,plan.length);
  for(const browser of ['chromium','firefox','webkit'])for(const presentationBackend of ['direct','bitmap'])assert(plan.some(entry=>entry.suite==='runtime'&&entry.browser===browser&&entry.presentationBackend===presentationBackend));
  assert.equal(plan.filter(entry=>entry.suite==='features').length,profile==='engine-2d-v1'?6:0);
 }
});
