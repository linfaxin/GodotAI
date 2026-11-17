/** Execution is independent of the compiled engine's functionality profile. */
const models = new Set(['window', 'proxy-pthread', 'dedicated-worker']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const reject = message => { throw Error('E_EXECUTION_CONTRACT: ' + message); };
const boolean = (value, label) => {
  if (value === true || value === 'yes' || value === 'true' || value === 1) return true;
  if (value === false || value === 'no' || value === 'false' || value === 0) return false;
  reject('Missing or invalid ' + label);
};
function flags(args = []) {
  const result = {};
  for (const argument of args) {
    const at = argument.indexOf('='); if (at < 1) continue;
    const key = argument.slice(0, at), value = argument.slice(at + 1);
    if (key in result && result[key] !== value) reject('Conflicting recipe switch ' + key);
    result[key] = value;
  }
  return result;
}
export function validateExecutionContract(value, { requireWorkerAssets = false } = {}) {
  if (!value || value.schemaVersion !== 1 || !models.has(value.executionModel)) reject('Unsupported schema or execution model');
  for (const key of ['wasmThreads', 'proxyToPthread', 'requiresCrossOriginIsolation']) if (typeof value[key] !== 'boolean') reject('Expected boolean ' + key);
  if (!Number.isSafeInteger(value.hostProtocolVersion) || value.hostProtocolVersion < 1) reject('Invalid host protocol');
  if (value.lifecycleAbi !== undefined && value.lifecycleAbi !== 1) reject('Unsupported lifecycle ABI');
  if (value.artifactSetAbi !== undefined && value.artifactSetAbi !== 1) reject('Unsupported ArtifactSet ABI');
  if (value.hostResourceAbi !== undefined && value.hostResourceAbi !== 1) reject('Unsupported host resource ABI');
  if (value.shutdownQueueAbi !== undefined && value.shutdownQueueAbi !== 1) reject('Unsupported shutdown queue ABI');
  if (value.routerProtocolVersion !== undefined && (!Number.isSafeInteger(value.routerProtocolVersion) || value.routerProtocolVersion < 1)) reject('Invalid router protocol');
  if (value.proxyToPthread !== (value.executionModel === 'proxy-pthread')) reject('Proxy/model mismatch');
  if (value.proxyToPthread && !value.wasmThreads) reject('Proxy execution requires WASM threads');
  if (value.wasmThreads && !value.requiresCrossOriginIsolation) reject('WASM threads require isolation');
  if (value.workerAssets !== undefined && !Array.isArray(value.workerAssets)) reject('Invalid worker asset closure');
  const seen = new Set();
  for (const asset of value.workerAssets ?? []) {
    if (!asset || typeof asset.path !== 'string' || asset.path.startsWith('/') || asset.path.includes('\\') || asset.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(asset.path)) reject('Invalid or duplicate worker path');
    if (!hash(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !['pthread-runtime', 'worker-bootstrap', 'host-glue', 'engine-main'].includes(asset.role)) reject('Invalid worker asset metadata');
    seen.add(asset.path);
  }
  // Emscripten may embed its worker bootstrap in the sealed main JS. Such a
  // release still explicitly declares how its complete worker code is sealed.
  if (value.workerBootstrap !== undefined && !['embedded', 'separate'].includes(value.workerBootstrap)) reject('Invalid worker bootstrap layout');
  if (requireWorkerAssets && value.executionModel !== 'window' && !(value.workerAssets?.length || value.workerBootstrap === 'embedded')) reject('Worker asset closure is missing');
  return value;
}
export const legacyExecution = () => ({ schemaVersion: 1, executionModel: 'window', wasmThreads: false, proxyToPthread: false, requiresCrossOriginIsolation: false, hostProtocolVersion: 1 });

const lifecyclePaths = ['platform/web/web_main.cpp', 'scene/main/scene_tree.h', 'scene/main/scene_tree.cpp'];
function assertLifecycleProof(report) {
  const proof = report.lifecyclePatch;
  if (proof?.abi !== 1 || proof.patchId !== 'godotjs-web-lifecycle-v1' || Object.keys(proof.files ?? {}).length !== lifecyclePaths.length) reject('Missing native lifecycle source proof');
  for (const path of lifecyclePaths) {
    const edges = (report.recipe?.patches ?? []).filter(patch => patch.path === path);
    const latest = edges.at(-1), file = proof.files[path];
    const allowed = path === 'platform/web/web_main.cpp' ? ['godotjs-web-lifecycle-v1', 'godotjs-web-worker-runtime-v1'] : ['godotjs-web-lifecycle-v1'];
    const applied=edges.findLast(edge=>allowed.includes(edge.patchId));
    if (!latest || !applied || (!allowed.includes(latest.patchId)&&!(path==='scene/main/scene_tree.cpp'&&latest.patchId==='godotjs-managed-shutdown-queue-v1')) || !hash(file?.sha256) || file.sha256 !== latest.afterSha256 || report.godotSource?.inputs?.[path] !== file.sha256) reject('Native lifecycle source differs: ' + path);
    const implementation = file.implementation;
    if (!implementation || !hash(implementation.sha256) || implementation.path !== applied.implementation?.path || implementation.sha256 !== applied.implementation?.sha256 || report.source?.inputs?.[implementation.path] !== implementation.sha256) reject('Native lifecycle implementation differs: ' + path);
    let previous;
    for (const edge of edges) {
      if (!hash(edge.beforeSha256) || !hash(edge.afterSha256) || (previous && previous !== edge.beforeSha256)) reject('Broken native lifecycle patch chain: ' + path);
      previous = edge.afterSha256;
    }
  }
}

/** Never certify threaded execution from requested arguments alone. Older
 * source-bound, single-thread reports retain their existing reader contract. */
export function executionFromReport(report, { requireWorkerAssets = false } = {}) {
  const requested = flags(report?.recipe?.args);
  if (requested.platform !== 'web' || requested.dlink_enabled !== 'no' || requested.use_quickjs_ng !== 'no') reject('Expected browser non-dlink recipe');
  const requestedThreads = boolean(requested.threads, 'recipe threads');
  const resolved = report.resolvedBuildOptions ?? report.resolvedOptions ?? {};
  const actualThreads = resolved.threads === undefined && !requestedThreads ? false : boolean(resolved.threads, 'resolved threads');
  const actualProxy = resolved.proxy_to_pthread === undefined && !actualThreads ? false : boolean(resolved.proxy_to_pthread, 'resolved proxy_to_pthread');
  if (actualThreads !== requestedThreads) reject('Resolved threads differ from recipe');
  if (requested.proxy_to_pthread !== undefined && actualProxy !== boolean(requested.proxy_to_pthread, 'recipe proxy')) reject('Resolved proxy differs from recipe');
  if (actualProxy && !actualThreads) reject('Upstream disabled proxy without threads');
  if (resolved.dlink_enabled !== undefined && boolean(resolved.dlink_enabled, 'resolved dlink')) reject('Dynamic linking is incompatible with this release');
  const supplied = report.execution;
  const value = supplied ? { schemaVersion: 1, ...supplied } : { ...legacyExecution(), executionModel: actualProxy ? 'proxy-pthread' : 'window', wasmThreads: actualThreads, proxyToPthread: actualProxy, requiresCrossOriginIsolation: actualThreads };
  validateExecutionContract(value, { requireWorkerAssets });
  if (value.lifecycleAbi === 1 || report.runtimeAbi?.lifecycle === 1) {
    if (value.lifecycleAbi !== 1 || (report.runtimeAbi && report.runtimeAbi.lifecycle !== 1)) reject('Native lifecycle ABI declarations differ');
    assertLifecycleProof(report);
  }
  if(value.artifactSetAbi===1){
    const proof=report.artifactSetPatch,edges=(report.recipe?.patches??[]).filter(edge=>edge.path==='main/main.cpp');
    const applied=edges.find(edge=>edge.patchId==='godotjs-artifact-set-early-mount-v1'),latest=edges.at(-1);
    if(proof?.abi!==1||proof.patchId!=='godotjs-artifact-set-early-mount-v1'||proof.path!=='main/main.cpp'||!applied||!latest||!hash(proof.sha256)||!hash(proof.implementation?.sha256)||proof.implementation?.path!=='scripts/release/patch-artifact-set-mount.mjs'||proof.sha256!==latest.afterSha256||report.godotSource?.inputs?.['main/main.cpp']!==proof.sha256||proof.implementation?.path!==applied.implementation?.path||proof.implementation?.sha256!==applied.implementation?.sha256||report.source?.inputs?.[proof.implementation?.path]!==proof.implementation?.sha256||!hash(report.source?.inputs?.['bridge/jsb_artifact_set.cpp'])||!hash(report.source?.inputs?.['bridge/jsb_artifact_set.h']))reject('ArtifactSet mount source proof differs');
    let previous;for(const edge of edges){if(!hash(edge.beforeSha256)||!hash(edge.afterSha256)||previous&&previous!==edge.beforeSha256)reject('Broken ArtifactSet source patch chain');previous=edge.afterSha256;}
  }
  if(value.shutdownQueueAbi===1){
    const proof=report.shutdownQueuePatch;
    if(proof?.abi!==1||proof.patchId!=='godotjs-managed-shutdown-queue-v1')reject('Missing shutdown queue source proof');
    for(const path of ['main/main.cpp','scene/main/scene_tree.cpp']){
      const edges=(report.recipe?.patches??[]).filter(edge=>edge.path===path),applied=edges.find(edge=>edge.patchId===proof.patchId),file=proof.files?.[path];
      if(!applied||!file||file.sha256!==edges.at(-1)?.afterSha256||report.godotSource?.inputs?.[path]!==file.sha256||file.implementation?.path!==applied.implementation?.path||file.implementation?.sha256!==applied.implementation?.sha256||report.source?.inputs?.[file.implementation?.path]!==file.implementation?.sha256)reject('Shutdown queue proof differs: '+path);
    }
  }
  if(value.hostResourceAbi===1){
    const proof=report.hostResourcePatch;
    const paths=['platform/web/js/libs/library_godot_os.js','platform/web/js/patches/patch_em_gl.js','platform/web/js/libs/library_godot_runtime.js','platform/web/js/libs/library_godot_audio.js','platform/web/js/libs/library_godot_display.js','modules/websocket/library_godot_websocket.js','modules/webrtc/library_godot_webrtc.js'];
    if(proof?.abi!==1||proof.patchId!=='godotjs-host-resource-owner-v1')reject('Missing host resource source proof');
    for(const path of paths){
      const edges=(report.recipe?.patches??[]).filter(edge=>edge.path===path),applied=edges.find(edge=>edge.patchId===proof.patchId),final=edges.at(-1),file=proof.files?.[path];
      if(!applied||!file||file.sha256!==final?.afterSha256||report.godotSource?.inputs?.[path]!==file.sha256||file.implementation?.path!==applied.implementation?.path||file.implementation?.sha256!==applied.implementation?.sha256||report.source?.inputs?.[file.implementation?.path]!==file.implementation?.sha256)reject('Host resource proof differs: '+path);
    }
  }
  if (value.wasmThreads !== actualThreads || value.proxyToPthread !== actualProxy) reject('Descriptor does not match resolved flags');
  return value;
}

export function assertExecutionAssets(execution, files) {
  validateExecutionContract(execution, { requireWorkerAssets: true });
  for (const worker of execution.workerAssets ?? []) {
    const asset = files.find(file => file.path === worker.path);
    if (!asset || asset.sha256 !== worker.sha256 || asset.bytes !== worker.bytes) reject('Unsealed worker asset ' + worker.path);
  }
}
