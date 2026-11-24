import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonical,digest,assertRuntimePropertiesBuildProof,
  RUNTIME_PROPERTIES_EXPORTS,RUNTIME_PROPERTIES_SOURCE_PATHS,
  assertRuntimeCallBuildProof,
  OBSERVATION_EXPORTS,OBSERVATION_SOURCE_PATHS} from '../web-release-utils.mjs';
import {workerBuildReportFixture} from '../../../apps/playground/scripts/fixtures/worker-build-report.mjs';
import {assertWorkerBuildProof} from '../../../apps/playground/scripts/worker-candidate.mjs';
import {executionFromReport} from '../execution-contract.mjs';
import {patchRuntimePropertiesQuitFile,unpatchRuntimePropertiesQuitFile,RUNTIME_PROPERTIES_QUIT_PATCH} from '../patch-runtime-properties-quit.mjs';
import {patchWebLifecycleFile} from '../patch-web-lifecycle.mjs';
import {patchNativeLifecycleFile} from '../patch-native-lifecycle.mjs';

import {propertiesProofFixture,runtimeCallProofFixture} from '../../../apps/playground/scripts/fixtures/runtime-properties-build-report.mjs';

test('properties proof binds its own compiled closure, quit patch and WASM without requiring write-1',()=>{
  const wasm=digest('actual wasm'),report=propertiesProofFixture(wasm);
  assert.equal(report.runtimeAbi.runtimeWrite,undefined);
  assert.doesNotThrow(()=>assertRuntimePropertiesBuildProof(report,wasm));
  assert.doesNotThrow(()=>assertWorkerBuildProof(report,{wasm:{sha256:wasm}}));
  assert.equal(executionFromReport(report).lifecycleAbi,1);
  assert.doesNotThrow(()=>assertRuntimePropertiesBuildProof(workerBuildReportFixture(),wasm));
});

test('properties proof rejects missing/changed declarations, closure, recipe, quit intent and binary',()=>{
  const wasm=digest('actual wasm');
  for(const change of [
    report=>delete report.runtimeProperties,
    report=>delete report.runtimeAbi.runtimeProperties,
    report=>report.runtimeAbi.runtimeProperties=2,
    report=>report.runtimeAbi.observation=undefined,
    report=>report.sourceCertified=false,
    report=>report.engineTarget='template_release',
    report=>report.runtimeProperties.wasmSha256=digest('other binary'),
    report=>report.runtimeProperties.exports.pop(),
    report=>delete report.runtimeProperties.sources['bridge/jsb_environment.cpp'],
    report=>report.runtimeProperties.sources['extra.cpp']=digest('not allowed'),
    report=>{report.source.inputs['bridge/jsb_environment.cpp']=digest('other helper');report.source.snapshotHash=digest(canonical(report.source.inputs));},
    report=>{report.recipe.patches.pop();report.recipeSha256=digest(canonical(report.recipe));},
    report=>report.recipe.patches.at(-1).implementation.sha256=digest('other patch'),
    report=>report.godotSource.inputs['scene/main/scene_tree.h']=digest('other header'),
  ]) {
    const report=propertiesProofFixture(wasm);change(report);
    assert.throws(()=>assertRuntimePropertiesBuildProof(report,wasm),/E_RUNTIME_PROPERTIES_BUILD_PROOF/);
  }
  assert.throws(()=>assertRuntimePropertiesBuildProof(propertiesProofFixture(wasm),digest('not the actual wasm')),/E_RUNTIME_PROPERTIES_BUILD_PROOF/);
});

test('runtime call proof is optional for older artifacts and binds its ABI, WASM and JavaScript',()=>{
  const assets={wasmSha256:digest('actual wasm'),javascriptSha256:digest('actual JavaScript')};
  const engine={wasm:{sha256:assets.wasmSha256},javascript:{sha256:assets.javascriptSha256}};
  assert.doesNotThrow(()=>assertRuntimeCallBuildProof(propertiesProofFixture(assets.wasmSha256),assets));
  const report=runtimeCallProofFixture(assets);
  report.template={assets:[{path:'godot.wasm',sha256:assets.wasmSha256},{path:'godot.js',sha256:assets.javascriptSha256}]};
  assert.doesNotThrow(()=>assertRuntimeCallBuildProof(report));
  assert.doesNotThrow(()=>assertRuntimeCallBuildProof(report,assets));
  assert.doesNotThrow(()=>assertWorkerBuildProof(report,engine));
  for(const javascript of [undefined,{sha256:digest('stale JavaScript')}]){
    assert.throws(()=>assertWorkerBuildProof(report,{...engine,javascript}),/E_RUNTIME_CALL_BUILD_PROOF/);
  }
  for(const change of [
    report=>delete report.runtimeCall,
    report=>delete report.runtimeAbi.runtimeCall,
    report=>report.runtimeAbi.runtimeCall=2,
    report=>report.runtimeCall.abi=2,
    report=>report.runtimeCall.wasmSha256=digest('unrelated binary'),
    report=>delete report.runtimeCall.javascriptSha256,
    report=>report.runtimeCall.javascriptSha256=digest('unrelated JavaScript'),
    report=>report.resolvedBuildOptions.dlink_enabled=true,
  ]) {
    const changed=structuredClone(report);change(changed);
    assert.throws(()=>assertRuntimeCallBuildProof(changed,assets),/E_RUNTIME_CALL_BUILD_PROOF/);
  }
});

test('the quit accessor is not script bound, composes with both lifecycle headers and is idempotent',async()=>{
  const path='scene/main/scene_tree.h';
  const source=await readFile(new URL('../../test/fixtures/godot-4.6.1-scene-tree.h',import.meta.url),'utf8');
  for(const lifecycle of [patchWebLifecycleFile,patchNativeLifecycleFile]) {
    const before=lifecycle(path,source).code;
    const patch=patchRuntimePropertiesQuitFile(path,before);
    assert.match(patch.code,/bool godotjs_is_quit_requested\(\) const \{ return _quit; \}/);
    assert.doesNotMatch(patch.code,/D_METHOD\("godotjs_is_quit_requested"/);
    assert.equal(patchRuntimePropertiesQuitFile(path,patch.code).code,patch.code);
    assert.equal(lifecycle(path,patch.code).code,patch.code);
    assert.equal(unpatchRuntimePropertiesQuitFile(path,patch.code),before);
    assert.throws(()=>patchRuntimePropertiesQuitFile(path,patch.code.replace('return _quit;','return false;')),/E_RUNTIME_PROPERTIES_QUIT_PATCH/);
  }
  assert.throws(()=>patchRuntimePropertiesQuitFile(path,source.replace('bool _quit = false;','bool _quit = true;')),/E_RUNTIME_PROPERTIES_QUIT_PATCH/);
});
