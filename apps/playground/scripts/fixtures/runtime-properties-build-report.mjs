import {canonical,digest,RUNTIME_PROPERTIES_SOURCE_PATHS,OBSERVATION_SOURCE_PATHS,OBSERVATION_EXPORTS,RUNTIME_PROPERTIES_EXPORTS} from '../../../../scripts/release/web-release-utils.mjs';
import {RUNTIME_PROPERTIES_QUIT_PATCH} from '../../../../scripts/release/patch-runtime-properties-quit.mjs';
import {workerBuildReportFixture} from './worker-build-report.mjs';

/** Synthetic properties proof for contract tests; never a compiled engine. */
export function propertiesProofFixture(wasmSha256=digest('actual wasm')) {
  const report={...workerBuildReportFixture(),runtimeProfile:'full-engine-v1',engineTarget:'template_debug',sourceCertified:true};
  const sources=Object.fromEntries(RUNTIME_PROPERTIES_SOURCE_PATHS.map(path=>[path,digest('compiled '+path)]));
  Object.assign(report.source.inputs,sources);
  report.source.snapshotHash=digest(canonical(report.source.inputs));
  Object.assign(report.resolvedBuildOptions,{threads:false,dlink_enabled:false});
  report.runtimeAbi={...report.runtimeAbi,observation:1,runtimeProperties:1};
  report.runtimeObservation={abi:1,sources:Object.fromEntries(OBSERVATION_SOURCE_PATHS.map(path=>[path,report.source.inputs[path]])),exports:[...OBSERVATION_EXPORTS],wasmSha256};
  report.runtimeProperties={abi:1,sources,exports:[...RUNTIME_PROPERTIES_EXPORTS],wasmSha256};
  const path='scene/main/scene_tree.h',afterSha256=digest('compiled quit accessor');
  report.recipe.patches.push({path,patchId:RUNTIME_PROPERTIES_QUIT_PATCH,beforeSha256:report.godotSource.inputs[path],afterSha256,
    implementation:{path:'scripts/release/patch-runtime-properties-quit.mjs',sha256:sources['scripts/release/patch-runtime-properties-quit.mjs']}});
  report.godotSource.inputs[path]=afterSha256;
  report.godotSource.snapshotHash=digest(canonical(report.godotSource.inputs));
  report.lifecyclePatch.files[path].sha256=afterSha256;
  report.recipeSha256=digest(canonical(report.recipe));
  return report;
}

export function runtimeCallProofFixture({wasmSha256,javascriptSha256}) {
  const report=propertiesProofFixture(wasmSha256);
  report.runtimeAbi.runtimeCall=1;
  report.runtimeCall={abi:1,wasmSha256,javascriptSha256};
  return report;
}
