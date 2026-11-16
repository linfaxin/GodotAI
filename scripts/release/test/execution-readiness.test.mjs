import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {executionFromReport,validateExecutionContract,assertExecutionAssets,legacyExecution} from '../execution-contract.mjs';
import {createEngineIdentity,createExtensionIdentity,createBuildKey,createArtifactIdentity,fullEngineIdentities,assertFullEngineIdentities} from '../release-identities.mjs';
import {calculateReadiness,validateG0Receipt,collectG0Receipt,G0_CASES} from '../g0-readiness.mjs';
import {executionContractHash,assertExecutionCertification,assertExecutionObservation} from '../execution-evidence.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const proxy=()=>({schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded',workerAssets:[{path:'godot.js',sha256:sha('main'),bytes:4,role:'engine-main'}]});
const report=()=>({recipe:{args:['platform=web','threads=yes','proxy_to_pthread=yes','dlink_enabled=no','use_quickjs_ng=no']},resolvedBuildOptions:{threads:true,proxy_to_pthread:true,dlink_enabled:false},execution:proxy()});
test('legacy execution reader stays strict while proxy certification requires real resolved switches',()=>{
  assert.deepEqual(executionFromReport({recipe:{args:['platform=web','threads=no','dlink_enabled=no','use_quickjs_ng=no']}}),legacyExecution());
  assert.equal(executionFromReport(report(),{requireWorkerAssets:true}).executionModel,'proxy-pthread');
  const missing=report();delete missing.resolvedBuildOptions;assert.throws(()=>executionFromReport(missing),/resolved threads/);
  const disabled=report();disabled.resolvedBuildOptions.proxy_to_pthread=false;assert.throws(()=>executionFromReport(disabled),/Resolved proxy/);
  const lie=report();lie.execution.wasmThreads=false;assert.throws(()=>executionFromReport(lie),/requires WASM threads/);
  const conflict=report();conflict.recipe.args.push('threads=no');assert.throws(()=>executionFromReport(conflict),/Conflicting recipe/);
});
test('worker code must belong to the exact sealed asset closure',()=>{
  const execution=proxy();assert.doesNotThrow(()=>assertExecutionAssets(execution,[{path:'godot.js',sha256:sha('main'),bytes:4}]));
  assert.throws(()=>assertExecutionAssets(execution,[{path:'godot.js',sha256:sha('tamper'),bytes:4}]),/Unsealed worker/);
  assert.throws(()=>validateExecutionContract({...execution,workerAssets:[],workerBootstrap:'separate'},{requireWorkerAssets:true}),/closure is missing/);
});
test('old main-thread reports cannot certify a new worker contract by changing a status label',()=>{
 const execution=proxy();
 assert.throws(()=>assertExecutionCertification(execution,{status:'passed'}),/E_EXECUTION_EVIDENCE/);
 const observation={contractHash:executionContractHash(execution),executionModel:'proxy-pthread',engineWorkerExecution:true,isolatedContexts:true,roleRouting:true,poolTermination:true};
 assert.doesNotThrow(()=>assertExecutionCertification(execution,{execution:observation}));
 assert.throws(()=>assertExecutionObservation(execution,{execution:{...observation,poolTermination:false}},'stress'),/whole session thread pool/);
 assert.throws(()=>assertExecutionCertification({...execution,hostProtocolVersion:2},{execution:observation}),/actual execution contract/);
 assert.doesNotThrow(()=>assertExecutionCertification(legacyExecution(),{status:'passed'}));
});
test('engine/extension/build/final artifact identities are deterministic and cannot include their own result',()=>{
  const engine={assets:[{path:'engine.wasm',sha256:sha('wasm')}],execution:proxy(),apiHash:sha('api')};
  assert.equal(createEngineIdentity(engine),createEngineIdentity({apiHash:engine.apiHash,execution:engine.execution,assets:engine.assets}));
  assert.notEqual(createEngineIdentity(engine),createEngineIdentity({...engine,apiHash:sha('new API')}));
  const engineId=createEngineIdentity(engine),extension={engineId,react:'19.3.1',adapterHash:sha('adapter')};
  assert.notEqual(createExtensionIdentity(extension),createExtensionIdentity({...extension,adapterHash:sha('new adapter')}));
  const buildKey=createBuildKey({sourceHash:sha('source'),engineId});
  assert.match(createArtifactIdentity({buildKey,packSha256:sha('final pack')}),/^[a-f0-9]{64}$/);
  assert.throws(()=>createBuildKey({sourceHash:sha('source'),packSha256:sha('self')}),/SELF_REFERENCE/);
  assert.throws(()=>createEngineIdentity({...engine,react:'19'}),/SELF_REFERENCE/);
  assert.throws(()=>createArtifactIdentity({buildKey,packSha256:sha('pack'),artifactId:'self'}),/SELF_REFERENCE/);
});
test('native engine identity excludes combined React type snapshots and extension identity is independently verified',()=>{
 const manifest={execution:proxy(),engine:{javascript:{path:'godot.js',sha256:sha('main'),bytes:4},wasm:{path:'godot.wasm',sha256:sha('wasm'),bytes:4},worklets:[]},modules:['GodotJS'],api:{bindingVersion:'1',namingVersion:'1',codegenVersion:'1',namingProfiles:{snake:{actualAPIHash:sha('api'),declarationsHash:sha('engine-only types')}},typeSnapshot:{path:'types.json',sha256:sha('merged types')}},sdk:{vendor:{sha256:sha('react')},vendors:{development:{sha256:sha('dev React')}},version:'1.0.0',moduleExports:{react:'React'}}};
 Object.assign(manifest,fullEngineIdentities(manifest));assert.doesNotThrow(()=>assertFullEngineIdentities(manifest));
 const previous=manifest.engineId;manifest.api.typeSnapshot.sha256=sha('different merged React declarations');assert.equal(fullEngineIdentities(manifest).engineId,previous);
 manifest.sdk.vendor.sha256=sha('different React');assert.equal(fullEngineIdentities(manifest).engineId,previous);assert.throws(()=>assertFullEngineIdentities(manifest),/Declared engine or extension/);
});
test('all development starts independently; only proven scoped blockers unlock integration',()=>{
  const before=calculateReadiness();assert(Object.values(before).every(item=>item.developmentStart==='GO'));
  assert.equal(before.W7.integrationReady,false);assert.equal(before.W9.defaultActivationReady,false);
  const after=calculateReadiness(['B1-EXEC','B2-ROUTING','B3-HOST-DEPLOY','B4-SESSION','B6-IDENTITY']);
  assert.equal(after.W7.integrationReady,true);assert.equal(after.W8.integrationReady,false);assert.equal(after.W9.defaultActivationReady,false);
  assert(after.W8.blockedBy.includes('B5-REACT-INTEGRATION'));
});
test('G0 refuses stale reports, empty passed assertions, altered assets and upgrades to default release',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'g0-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(resolve(root,'godot.js'),'main');
  const receipt={schemaVersion:1,kind:'worker-g0-receipt',validationBatchId:'batch-1',sourceSnapshotHash:sha('source'),producerHash:sha('producer'),execution:proxy(),artifacts:[{path:'godot.js',sha256:sha('main'),bytes:4}],cases:[]};
  const item={id:'engine-execution',status:'passed',reportPath:'case.json',limitations:[]};
  const evidence={status:'passed',evidenceKind:'browser-runtime',validationBatchId:receipt.validationBatchId,sourceSnapshotHash:receipt.sourceSnapshotHash,producerHash:receipt.producerHash,caseId:item.id,environment:{browser:'chromium',browserVersion:'actual-fixture-version',os:'linux'},observed:Object.fromEntries(G0_CASES[item.id].checks.map(key=>[key,true]))};
  const seal=async()=>{await writeFile(resolve(root,'case.json'),JSON.stringify(evidence));item.reportHash=sha(await readFile(resolve(root,'case.json')));receipt.cases=[item];};
  await seal();const result=await validateG0Receipt(receipt,{root});assert.deepEqual(result.clearedBlockers,['B1-EXEC']);assert.equal(result.defaultReleaseReady,false);
  evidence.status='failed';await seal();await assert.rejects(validateG0Receipt(receipt,{root}),/non-passing scoped report/);evidence.status='passed';
  evidence.evidenceKind='node-test';await seal();await assert.rejects(validateG0Receipt(receipt,{root}),/requires runtime evidence/);evidence.evidenceKind='browser-runtime';
  evidence.observed.physicsObserved=false;await seal();await assert.rejects(validateG0Receipt(receipt,{root}),/Missing observed assertion/);
  evidence.observed.physicsObserved=true;evidence.validationBatchId='old';await seal();await assert.rejects(validateG0Receipt(receipt,{root}),/Stale producer/);
  evidence.validationBatchId='batch-1';await seal();await writeFile(resolve(root,'godot.js'),'tampered');await assert.rejects(validateG0Receipt(receipt,{root}),/Artifact changed/);
});
test('a passed scoped runtime case can coexist with an honestly failed parent suite',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'g0-partial-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(resolve(root,'godot.js'),'main');
 const receipt={schemaVersion:1,kind:'worker-g0-receipt',validationBatchId:'partial',sourceSnapshotHash:sha('source'),producerHash:sha('producer'),execution:proxy(),artifacts:[{path:'godot.js',sha256:sha('main'),bytes:4}],cases:[]};
 const parent={status:'failed',cases:[{id:'session-0',status:'passed'},{id:'session-1',status:'failed'}]};await writeFile(resolve(root,'parent.json'),JSON.stringify(parent));
 const report={status:'passed',evidenceKind:'browser-runtime',validationBatchId:receipt.validationBatchId,sourceSnapshotHash:receipt.sourceSnapshotHash,producerHash:receipt.producerHash,caseId:'engine-execution',environment:{browser:'chromium',browserVersion:'fixture-version',os:'linux'},observed:Object.fromEntries(G0_CASES['engine-execution'].checks.map(key=>[key,true])),parentEvidence:{path:'parent.json',sha256:sha(JSON.stringify(parent)),caseId:'session-0'}};
 const seal=async()=>{await writeFile(resolve(root,'case.json'),JSON.stringify(report));receipt.cases=[{id:report.caseId,status:'passed',reportPath:'case.json',reportHash:sha(JSON.stringify(report)),limitations:['Only this passed scoped case is claimed.']}]};
 await seal();assert.deepEqual((await validateG0Receipt(receipt,{root})).clearedBlockers,['B1-EXEC']);
 report.parentEvidence.caseId='session-1';await seal();await assert.rejects(validateG0Receipt(receipt,{root}),/no passed scoped runtime case/);
});
test('receipt collector hashes real files and never invents passed cases for missing producers',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'g0-collect-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(resolve(root,'godot.js'),'main');
 const result=await collectG0Receipt({root,sourceSnapshotHash:sha('source'),producerHash:sha('producer'),validationBatchId:'new-batch',execution:proxy(),artifactPaths:['godot.js']});
 assert(result.receipt.cases.every(item=>item.status==='unverified'));
 assert.deepEqual(result.readiness.clearedBlockers,[]);assert.equal(result.readiness.defaultReleaseReady,false);
 assert(Object.values(result.readiness.workPackages).every(item=>item.developmentStart==='GO'));
});


test('native lifecycle capability requires the complete compiled source proof',()=>{
 const paths=['platform/web/web_main.cpp','scene/main/scene_tree.h','scene/main/scene_tree.cpp'];
 const candidate=report();candidate.execution.lifecycleAbi=1;candidate.runtimeAbi={lifecycle:1};
 candidate.source={inputs:{}};candidate.godotSource={inputs:{}};candidate.recipe.patches=[];
 candidate.lifecyclePatch={abi:1,patchId:'godotjs-web-lifecycle-v1',files:{}};
 for(const path of paths){
  const implementation={path:'scripts/release/patch-web-lifecycle.mjs',sha256:sha('implementation')};
  const final=sha(path);candidate.source.inputs[implementation.path]=implementation.sha256;candidate.godotSource.inputs[path]=final;
  candidate.recipe.patches.push({path,patchId:'godotjs-web-lifecycle-v1',beforeSha256:sha('original '+path),afterSha256:final,implementation});
  candidate.lifecyclePatch.files[path]={sha256:final,implementation};
 }
 assert.equal(executionFromReport(candidate).lifecycleAbi,1);
 const mutate=fn=>{const copy=structuredClone(candidate);fn(copy);assert.throws(()=>executionFromReport(copy),/lifecycle/);};
 mutate(value=>delete value.lifecyclePatch);
 mutate(value=>delete value.lifecyclePatch.files[paths[1]]);
 mutate(value=>value.godotSource.inputs[paths[2]]=sha('unpatched source'));
 mutate(value=>value.source.inputs['scripts/release/patch-web-lifecycle.mjs']=sha('different implementation'));
 mutate(value=>value.recipe.patches[0].afterSha256=sha('different output'));
 mutate(value=>value.recipe.patches[0].patchId='unrelated-patch');
 mutate(value=>value.runtimeAbi.lifecycle=undefined);
 mutate(value=>value.execution.lifecycleAbi=undefined);
});
