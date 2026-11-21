import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {canonical,digest,sitePayloads} from './site-evidence.mjs';
import {WORKER_RUNTIME_ABI,assertWorkerRuntimeAbi} from '../../../scripts/release/engine-profiles.mjs';
import {OBSERVATION_EXPORTS,OBSERVATION_SOURCE_PATHS,RUNTIME_WRITE_EXPORTS,assertRuntimeObservationBuildProof,assertRuntimeWriteBuildProof} from '../../../scripts/release/web-release-utils.mjs';
import {WORKER_CANDIDATE_ASSETS,WORKER_NATIVE_PATCH_FILES,assertWorkerBuildProof,describeWorkerCandidate,assertWorkerCandidate,runConfigurationHash,workerAcceptancePlan} from './worker-candidate.mjs';
import {assertWorkerSessionEvidence} from './runtime-evidence.mjs';
import {workerRuntimeBuildProof} from '../../../scripts/release/patch-web-worker-runtime.mjs';

const configuration={executionBackend:'worker',presentationBackend:'direct',runtimeProtocolVersion:2,hostAbiVersion:1,audioAbiVersion:1,presentationAbiVersion:1,budgets:{maxInputEvents:1024,cleanupTimeoutMs:1000}};
function buildProof(){
 const implementation={path:'scripts/release/patch-web-worker-runtime.mjs',sha256:digest('patch')},patchId='godotjs-web-worker-runtime-v1';
 const files=Object.fromEntries(WORKER_NATIVE_PATCH_FILES.map(name=>[name,digest(name)]));
 const recipe={args:['platform=web','threads=no','dlink_enabled=no','use_quickjs_ng=no'],patches:Object.entries(files).map(([path,afterSha256])=>({patchId,path,afterSha256,beforeSha256:digest('before '+path),implementation}))};
 return {kind:'godot-js-browser-engine-build',status:'built',runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1},workerPatch:{patchId,version:1,implementation,files},recipe,recipeSha256:digest(canonical(recipe)),godotSource:{inputs:files,snapshotHash:digest(canonical(files))}};
}
test('native ABI cannot be attached to old, snapshotted or differently patched bytes',()=>{
 const proof=buildProof();assert.doesNotThrow(()=>assertWorkerBuildProof(proof));
 for(const change of [value=>{delete value.workerPatch;},value=>{value.status='snapshotted';},value=>{value.recipe.patches.pop();value.recipeSha256=digest(canonical(value.recipe));},value=>{value.godotSource.inputs['main/main.cpp']=digest('old');value.godotSource.snapshotHash=digest(canonical(value.godotSource.inputs));},value=>{value.workerPatch.implementation.sha256=digest('other');}]){
  const value=structuredClone(proof);change(value);assert.throws(()=>assertWorkerBuildProof(value),/E_WORKER_BUILD_PROOF/);
 }
});
test('worker native proof retains its own implementation and seals all later source transformations',()=>{
 const proof=buildProof(),path='main/main.cpp',before=proof.workerPatch.files[path],after=digest('after early mount and shutdown patches');
 proof.recipe.patches.push({path,patchId:'another-source-owner',beforeSha256:before,afterSha256:after,implementation:{path:'scripts/release/another-owner.mjs',sha256:digest('another owner')}});
 proof.workerPatch=workerRuntimeBuildProof(proof.recipe.patches).workerPatch;proof.recipeSha256=digest(canonical(proof.recipe));proof.godotSource.inputs[path]=after;proof.godotSource.snapshotHash=digest(canonical(proof.godotSource.inputs));
 assert.equal(proof.workerPatch.files[path],after);assert.doesNotThrow(()=>assertWorkerBuildProof(proof));
 const broken=structuredClone(proof);broken.recipe.patches.at(-1).beforeSha256=digest('unrelated source');broken.recipeSha256=digest(canonical(broken.recipe));assert.throws(()=>assertWorkerBuildProof(broken),/broken source chain/);assert.throws(()=>workerRuntimeBuildProof(broken.recipe.patches),/broken source chain/);
 const stale=structuredClone(proof);stale.workerPatch.files[path]=before;assert.throws(()=>assertWorkerBuildProof(stale),/E_WORKER_BUILD_PROOF_FILE/);
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


test('candidate uses the actual historical ABI and refuses an unbuilt lifecycle upgrade',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'worker-candidate-abi-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of Object.values(WORKER_CANDIDATE_ASSETS))await writeFile(path.join(directory,name),'actual '+name);
 const release={runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}};
 const runtime=await describeWorkerCandidate(directory,release),payloads=await sitePayloads(directory);
 assert.equal(runtime.abi.lifecycle,undefined);
 const manifest={schemaVersion:3,runtime,payloads};assert.doesNotThrow(()=>assertWorkerCandidate(manifest,release,payloads));
 runtime.abi.lifecycle=1;assert.throws(()=>assertWorkerCandidate(manifest,release,payloads),/E_WORKER_CANDIDATE_ABI/);
});


test('a worker patch alone cannot certify the new lifecycle capability',()=>{
 const report=buildProof();report.runtimeAbi.lifecycle=1;
 assert.throws(()=>assertWorkerBuildProof(report),/lifecycle/);
});

test('runtime observation is optional and bound to both the snapshotted reader and exact executable',()=>{
 const report=buildProof();
 assert.doesNotThrow(()=>assertRuntimeObservationBuildProof(report));
 assert.throws(()=>assertWorkerRuntimeAbi({...report.runtimeAbi,observation:1}),/E_WORKER_RUNTIME_ABI/);
 report.runtimeAbi={...WORKER_RUNTIME_ABI,observation:1};
 assert.doesNotThrow(()=>assertWorkerRuntimeAbi(report.runtimeAbi));
 assert.throws(()=>assertRuntimeObservationBuildProof(report),/E_RUNTIME_OBSERVATION_BUILD_PROOF/);
 const sources=Object.fromEntries(OBSERVATION_SOURCE_PATHS.map(path=>[path,digest(path)]));
 const inputs={...sources,'README.md':digest('other module input')};
 const wasmSha256=digest('matching wasm');
 report.source={inputs,snapshotHash:digest(canonical(inputs))};
 report.template={assets:[{path:'godot.wasm',sha256:wasmSha256}]};
 report.runtimeObservation={abi:1,sources,exports:[...OBSERVATION_EXPORTS],wasmSha256};
 assert.doesNotThrow(()=>assertRuntimeObservationBuildProof(report));
 assert.throws(()=>assertRuntimeObservationBuildProof(report,digest('other wasm')),/E_RUNTIME_OBSERVATION_BUILD_PROOF/);
 for(const mutate of [
  value=>delete value.runtimeAbi.observation,
  value=>value.runtimeObservation.exports.pop(),
  value=>value.runtimeObservation.sources[OBSERVATION_SOURCE_PATHS[0]]=digest('other reader'),
  value=>value.source.inputs.SCsub=digest('changed rules'),
 ]){
  const changed=structuredClone(report);mutate(changed);
  assert.throws(()=>assertRuntimeObservationBuildProof(changed),/E_RUNTIME_OBSERVATION_BUILD_PROOF/);
 }
});

test('runtime write proof requires the supported recipe, observations, source bytes and executable',()=>{
 const sources=Object.fromEntries(OBSERVATION_SOURCE_PATHS.map(path=>[path,digest(path)]));
 const wasmSha256=digest('matching wasm'),report={
  runtimeProfile:'full-engine-v1',engineTarget:'template_debug',sourceCertified:true,
  recipe:{args:['target=template_debug']},resolvedBuildOptions:{target:'template_debug'},
  execution:{executionModel:'window',wasmThreads:false},
  runtimeAbi:{...WORKER_RUNTIME_ABI,observation:1,runtimeWrite:1},
  source:{inputs:sources,snapshotHash:digest(canonical(sources))},
  template:{assets:[{path:'godot.wasm',sha256:wasmSha256}]},
  runtimeObservation:{abi:1,exports:OBSERVATION_EXPORTS,wasmSha256,sources},
  runtimeWrite:{abi:1,exports:RUNTIME_WRITE_EXPORTS,wasmSha256,sources},
 };
 assert.doesNotThrow(()=>assertWorkerRuntimeAbi(report.runtimeAbi));
 assert.throws(()=>assertWorkerRuntimeAbi({...report.runtimeAbi,observation:undefined}),/E_WORKER_RUNTIME_ABI/);
 assert.doesNotThrow(()=>assertRuntimeWriteBuildProof(report));
 assert.throws(()=>assertRuntimeWriteBuildProof(report,digest('other wasm')),/E_RUNTIME_WRITE_BUILD_PROOF/);
 for(const change of [
  value=>delete value.runtimeAbi.runtimeWrite, value=>delete value.runtimeWrite,
  value=>value.runtimeWrite.exports.pop(), value=>value.runtimeWrite.sources.SCsub=digest('other rules'),
  value=>value.runtimeAbi.lifecycle=undefined, value=>value.runtimeProfile='engine-2d-v1',
  value=>value.engineTarget='template_release', value=>value.execution.wasmThreads=true,
  value=>value.recipe.args=['target=template_release'],
  value=>value.recipe.args.push('target=template_release'),
  value=>delete value.resolvedBuildOptions,
  value=>value.resolvedBuildOptions.target='template_release',
  value=>value.sourceCertified=false,
 ]){
  const changed=structuredClone(report);change(changed);
  assert.throws(()=>assertRuntimeWriteBuildProof(changed),/E_RUNTIME_WRITE_BUILD_PROOF/);
 }
 const readOnly=structuredClone(report);delete readOnly.runtimeAbi.runtimeWrite;delete readOnly.runtimeWrite;
 assert.doesNotThrow(()=>assertRuntimeWriteBuildProof(readOnly));
});
