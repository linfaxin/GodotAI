import {canonical,digest} from '../../../../scripts/release/web-release-utils.mjs';
import {legacyExecution} from '../../../../scripts/release/execution-contract.mjs';
import {WORKER_RUNTIME_PATHS,WORKER_RUNTIME_PATCH,workerRuntimeBuildProof} from '../../../../scripts/release/patch-web-worker-runtime.mjs';
import {WEB_LIFECYCLE_PATHS,WEB_LIFECYCLE_PATCH,webLifecycleBuildProof} from '../../../../scripts/release/patch-web-lifecycle.mjs';
import {ARTIFACT_SET_MOUNT_PATCH,artifactSetMountBuildProof} from '../../../../scripts/release/patch-artifact-set-mount.mjs';
import {HOST_RESOURCE_PATHS,HOST_RESOURCE_PATCH,hostResourceBuildProof} from '../../../../scripts/release/patch-web-resource-owner.mjs';
import {NATIVE_OBSERVER_PATHS,NATIVE_OBSERVER_PATCH,nativeObserverBuildProof} from '../../../../scripts/release/patch-native-observer.mjs';
import {MANAGED_SHUTDOWN_PATHS,MANAGED_SHUTDOWN_PATCH,managedShutdownBuildProof} from '../../../../scripts/release/patch-managed-shutdown-queue.mjs';

/** Synthetic composed receipts for release/sealer tests, not a native build. */
export function workerBuildReportFixture(){
 const patches=[],inputs={},moduleInputs={
  'bridge/jsb_artifact_set.cpp':digest('synthetic artifact-set source'),
  'bridge/jsb_artifact_set.h':digest('synthetic artifact-set header'),
 };
 const add=(paths,patchId,implementationPath)=>{
  const implementation={path:implementationPath,sha256:digest('synthetic '+implementationPath)};
  moduleInputs[implementationPath]=implementation.sha256;
  for(const path of paths){
   const beforeSha256=inputs[path]??digest('synthetic original '+path),afterSha256=digest('synthetic '+patchId+' '+path);
   patches.push({path,patchId,beforeSha256,afterSha256,implementation});inputs[path]=afterSha256;
  }
 };
 add(WORKER_RUNTIME_PATHS,WORKER_RUNTIME_PATCH,'scripts/release/patch-web-worker-runtime.mjs');
 add(WEB_LIFECYCLE_PATHS.filter(path=>path!=='platform/web/web_main.cpp'),WEB_LIFECYCLE_PATCH,'scripts/release/patch-web-lifecycle.mjs');
 add(['main/main.cpp'],ARTIFACT_SET_MOUNT_PATCH,'scripts/release/patch-artifact-set-mount.mjs');
 add(HOST_RESOURCE_PATHS,HOST_RESOURCE_PATCH,'scripts/release/patch-web-resource-owner.mjs');
 add(NATIVE_OBSERVER_PATHS,NATIVE_OBSERVER_PATCH,'scripts/release/patch-native-observer.mjs');
 add(MANAGED_SHUTDOWN_PATHS,MANAGED_SHUTDOWN_PATCH,'scripts/release/patch-managed-shutdown-queue.mjs');
 const recipe={args:['platform=web','threads=no','dlink_enabled=no','use_quickjs_ng=no'],patches};
 return {kind:'godot-js-browser-engine-build',status:'built',
  source:{commit:'a'.repeat(40),inputs:moduleInputs,snapshotHash:digest(canonical(moduleInputs))},
  godotSource:{commit:'b'.repeat(40),inputs,snapshotHash:digest(canonical(inputs))},
  recipe,recipeSha256:digest(canonical(recipe)),
  ...workerRuntimeBuildProof(patches),...webLifecycleBuildProof(patches),...artifactSetMountBuildProof(patches),
  ...hostResourceBuildProof(patches),...nativeObserverBuildProof(patches),...managedShutdownBuildProof(patches),
  execution:{...legacyExecution(),lifecycleAbi:1,artifactSetAbi:1,hostResourceAbi:1,shutdownQueueAbi:1},
 };
}
