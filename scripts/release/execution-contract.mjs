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
