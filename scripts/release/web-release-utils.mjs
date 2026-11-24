import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertGame2dCertification } from './game-2d-evidence.mjs';
import {isEngineProfile,getEngineProfile,validateEngineProfile} from './engine-profiles.mjs';
import {executionFromReport,assertExecutionAssets,legacyExecution} from './execution-contract.mjs';
import {assertExecutionCertification} from './execution-evidence.mjs';
import {assertFullEngineIdentities} from './release-identities.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
export const OBSERVATION_READER_SOURCE = 'bridge/jsb_runtime_observation.cpp';
export const OBSERVATION_SOURCE_PATHS = [
  OBSERVATION_READER_SOURCE,
  'bridge/jsb_runtime_observation.h',
  'SCsub',
];
export const OBSERVATION_EXPORTS = [
  '_godotjs_runtime_observation_abi',
  '_godotjs_runtime_observation_buffer',
  '_godotjs_runtime_observation_sample',
];
export const RUNTIME_WRITE_EXPORTS = [
  '_godotjs_runtime_write_abi',
  '_godotjs_runtime_write_execute',
];


export const RUNTIME_PROPERTIES_EXPORTS = [
  '_godotjs_runtime_properties_abi',
  '_godotjs_runtime_properties_execute',
];
export const RUNTIME_PROPERTIES_SOURCE_PATHS = Object.freeze([
  'SCsub',
  'bridge/jsb_runtime_observation.cpp', 'bridge/jsb_runtime_observation.h',
  'bridge/jsb_runtime_access_common.cpp', 'bridge/jsb_runtime_access_common.h',
  'bridge/jsb_runtime_properties.cpp', 'bridge/jsb_runtime_properties.h',
  'bridge/jsb_runtime_scalar.cpp', 'bridge/jsb_runtime_script_properties.h',
  'bridge/jsb_environment.cpp', 'bridge/jsb_environment.h',
  'bridge/jsb_class_info.cpp', 'bridge/jsb_class_info.h',
  'bridge/jsb_object_handle.h',
  'bridge/jsb_native_world.cpp', 'bridge/jsb_native_world.h',
  'bridge/jsb_type_convert.cpp', 'bridge/jsb_type_convert.h',
  'bridge/jsb_bridge_module_loader.cpp', 'bridge/jsb_bridge_module_loader.h',
  'weaver/jsb_script.cpp', 'weaver/jsb_script.h',
  'weaver/jsb_script_instance.cpp', 'weaver/jsb_script_instance.h',
  'impl/web/jsb_web_interop.h', 'impl/web/js/library_godotjs_jsbi.js',
  'impl/web/bridge/src/monolith.ts', 'impl/web/js/jsbb.impl.js',
  'scripts/jsb.runtime/src/godot.annotations.ts',
  'scripts/out/jsb.runtime.bundle.js',
  'scripts/release/patch-runtime-properties-quit.mjs',
]);
export function assertRuntimePropertiesBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeProperties;
  if (report.runtimeAbi?.runtimeProperties === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  const quitPath = 'scene/main/scene_tree.h';
  const quit = report.recipe?.patches?.findLast(item => item.path === quitPath && item.patchId === 'godotjs-runtime-properties-quit-v1');
  const latest = report.recipe?.patches?.findLast(item => item.path === quitPath);
  if (report.runtimeAbi?.runtimeProperties !== 1 || report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      report.status !== 'built' || !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      report.resolvedBuildOptions?.threads !== false || report.resolvedBuildOptions?.dlink_enabled !== false ||
      digest(canonical(report.recipe)) !== report.recipeSha256 ||
      proof?.abi !== 1 || !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !Array.isArray(proof.exports) || canonical(proof.exports) !== canonical(RUNTIME_PROPERTIES_EXPORTS) ||
      !report.source?.inputs || digest(canonical(report.source.inputs)) !== report.source.snapshotHash ||
      Object.keys(proof.sources ?? {}).length !== RUNTIME_PROPERTIES_SOURCE_PATHS.length ||
      !RUNTIME_PROPERTIES_SOURCE_PATHS.every(path => hash.test(proof.sources[path]) && proof.sources[path] === report.source.inputs[path]) ||
      !quit || !latest || !hash.test(quit.afterSha256) ||
      quit.implementation?.path !== 'scripts/release/patch-runtime-properties-quit.mjs' ||
      quit.implementation?.sha256 !== report.source.inputs[quit.implementation.path] ||
      latest.afterSha256 !== report.godotSource?.inputs?.[quitPath] ||
      digest(canonical(report.godotSource?.inputs)) !== report.godotSource?.snapshotHash) {
    throw Error('E_RUNTIME_PROPERTIES_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, wasmSha256);
  assertSourcePatchChains(report);
}

export function assertRuntimeCallAssets(runtimeAbi, proof, {wasmSha256, javascriptSha256}) {
  if (runtimeAbi?.runtimeCall === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  if (runtimeAbi?.runtimeCall !== 1 || proof?.abi !== 1 ||
      !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !hash.test(proof.javascriptSha256) || proof.javascriptSha256 !== javascriptSha256) {
    throw Error('E_RUNTIME_CALL_BUILD_PROOF');
  }
}

export function assertRuntimeCallBuildProof(report, assets = {
  wasmSha256: report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256,
  javascriptSha256: report.template?.assets?.find(asset => asset.path === 'godot.js')?.sha256,
}) {
  assertRuntimeCallAssets(report.runtimeAbi, report.runtimeCall, assets);
  if (report.runtimeAbi?.runtimeCall === undefined) return;
  if (report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      report.status !== 'built' || !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      report.resolvedBuildOptions?.threads !== false || report.resolvedBuildOptions?.dlink_enabled !== false) {
    throw Error('E_RUNTIME_CALL_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, assets.wasmSha256);
}

export function assertRuntimeObservationBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeObservation;
  if (report.runtimeAbi?.observation === undefined && proof === undefined) return;
  if (report.runtimeAbi?.observation !== 1 || report.runtimeAbi?.lifecycle !== 1 ||
      !validRuntimeBridgeProof(report, proof, OBSERVATION_EXPORTS, wasmSha256)) {
    throw Error('E_RUNTIME_OBSERVATION_BUILD_PROOF');
  }
}

export function runtimeWriteBuildTarget(report) {
  const args = report.recipe?.args;
  const targets = Array.isArray(args) && args.filter(arg => typeof arg === 'string' && arg.startsWith('target='));
  return report.runtimeProfile === 'full-engine-v1' && report.engineTarget === 'template_debug' &&
    targets && targets.length === 1 && targets[0] === 'target=template_debug' &&
    report.resolvedBuildOptions?.target === 'template_debug' &&
    report.execution?.executionModel === 'window' && report.execution.wasmThreads === false;
}

export function assertRuntimeWriteBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeWrite;
  if (report.runtimeAbi?.runtimeWrite === undefined && proof === undefined) return;
  if (report.runtimeAbi?.runtimeWrite !== 1 || report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      !validRuntimeBridgeProof(report, proof, RUNTIME_WRITE_EXPORTS, wasmSha256)) {
    throw Error('E_RUNTIME_WRITE_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, wasmSha256);
}

function validRuntimeBridgeProof(report, proof, exports, wasmSha256) {
  const hash = /^[a-f0-9]{64}$/;
  return proof?.abi === 1 && hash.test(proof.wasmSha256) && proof.wasmSha256 === wasmSha256 &&
    Array.isArray(proof.exports) && canonical(proof.exports) === canonical(exports) &&
    report.source?.inputs && digest(canonical(report.source.inputs)) === report.source.snapshotHash &&
    Object.keys(proof.sources ?? {}).length === OBSERVATION_SOURCE_PATHS.length &&
    OBSERVATION_SOURCE_PATHS.every(path => hash.test(proof.sources[path]) && proof.sources[path] === report.source.inputs[path]);
}

/** Ordered checked patches may compose on one source file. Only the last
 * output is in the compiled snapshot; every intermediate edge must connect. */
export function assertSourcePatchChains(report) {
  const latest = new Map();
  for (const patch of report.recipe?.patches ?? []) {
    assertHash(patch.beforeSha256, 'source patch input'); assertHash(patch.afterSha256, 'source patch output');
    if (latest.has(patch.path) && latest.get(patch.path).afterSha256 !== patch.beforeSha256) fail('E_RELEASE_RECIPE', `Broken source patch chain: ${patch.path}`);
    latest.set(patch.path, patch);
  }
  for (const [path, patch] of latest) if (report.godotSource?.inputs?.[path] !== patch.afterSha256) fail('E_RELEASE_RECIPE', `Source patch is not in the attested snapshot: ${patch.patchId}`);
  return latest;
}
export function options(args, booleans = []) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name.startsWith('--')) fail('E_OPTION', `Unexpected argument ${name}`);
    if (booleans.includes(name)) { result[name.slice(2)] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('E_OPTION', `Missing value for ${name}`);
    if (result[name.slice(2)] !== undefined) fail('E_OPTION', `Duplicate ${name}`);
    result[name.slice(2)] = value;
  }
  return result;
}
export function required(value, name) { if (!value) fail('E_OPTION', `Missing ${name}`); return value; }
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(value)) fail('E_RELEASE_PATH', `Unsafe release path ${JSON.stringify(value)}`);
  return value;
}
export function within(root, path) {
  const result = resolve(root, safePath(path));
  if (!result.startsWith(`${resolve(root)}${sep}`)) fail('E_RELEASE_PATH', 'Path escaped release root');
  return result;
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
export async function filesIn(directory) {
  const result = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink()) fail('E_RELEASE_SYMLINK', `Release asset may not be a symlink: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  if (!(await lstat(directory)).isDirectory()) fail('E_RELEASE_DIRECTORY', `Expected directory ${directory}`);
  await walk(directory);
  return result;
}
export function relativePath(root, path) { return safePath(relative(root, path).split(sep).join('/')); }
export async function hashSiteRuntimeFiles(directory) {
  const hashes = {};
  for (const path of await filesIn(directory)) {
    const key = relativePath(directory, path);
    if (key.startsWith('release/') || ['app-config.json', 'release-assets.json'].includes(key)) continue;
    hashes[key] = digest(await readFile(path));
  }
  return hashes;
}
export function identity(descriptor) {
  // Certification can be attached after validating this exact candidate. It does
  // not change the identity of the bytes tested by a browser.
  const { id, runtimeRelease, certified, certification, ...content } = descriptor;
  return digest(canonical(content));
}
export function assertHash(value, label) { if (!/^(?!0{64}$)[a-f0-9]{64}$/.test(value ?? '')) fail('E_RELEASE_HASH', `Invalid ${label}`); }
export function assertCommit(value, label) { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '')) fail('E_RELEASE_SOURCE', `Invalid ${label}`); }

export async function verifyCDN({ baseUrl, descriptor, fetcher = fetch }) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const nonce = Date.now().toString(36);
  for (const file of [{ path: 'release.json' }, ...descriptor.files]) {
    const assetUrl = new URL(file.path.split('/').map(encodeURIComponent).join('/'), url);
    assetUrl.searchParams.set('godot_release_verify', nonce);
    const response = await fetcher(assetUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) fail('E_RELEASE_CDN', `CDN returned ${response.status} for ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (file.path === 'release.json') {
      if (canonical(JSON.parse(bytes.toString('utf8'))) !== canonical(descriptor)) fail('E_RELEASE_CDN', 'CDN release descriptor differs');
    } else if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes) fail('E_RELEASE_CDN', `CDN bytes differ: ${file.path}`);
  }
  return true;
}

export async function inspectRelease(directory, { requireCertified = false } = {}) {
  const root = resolve(directory), descriptor = await json(resolve(root, 'release.json'));
  if (descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.files)) fail('E_RELEASE_SCHEMA', 'Expected release schemaVersion 1 and files array');
  if (descriptor.id !== identity(descriptor) || descriptor.runtimeRelease !== descriptor.id) fail('E_RELEASE_IDENTITY', 'runtimeRelease does not match immutable descriptor content');
  if (requireCertified && descriptor.certified !== true) fail('E_RELEASE_UNCERTIFIED', 'Official publication requires source and browser validation certification');
  const paths = new Set();
  for (const file of descriptor.files) {
    safePath(file.path);
    if (paths.has(file.path)) fail('E_RELEASE_DUPLICATE', `Duplicate ${file.path}`);
    paths.add(file.path); assertHash(file.sha256, file.path);
    const bytes = await readFile(within(root, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('E_RELEASE_INTEGRITY', `Bytes changed: ${file.path}`);
    if (file.kind === 'engine-wasm') {
      let decoded = bytes;
      if (file.encoding) {
        if (file.encoding !== 'gzip' || !Number.isSafeInteger(file.decodedBytes) || file.decodedBytes < 8 || file.decodedBytes > 128 * 1024 * 1024) fail('E_RELEASE_ENCODING', 'Unsupported or oversized encoded engine');
        assertHash(file.decodedSha256, 'decoded WASM');
        try { decoded = gunzipSync(bytes, { maxOutputLength: file.decodedBytes }); }
        catch { fail('E_RELEASE_ENCODING', 'Engine gzip is invalid or exceeds its decoded size'); }
        if (decoded.length !== file.decodedBytes || digest(decoded) !== file.decodedSha256) fail('E_RELEASE_INTEGRITY', 'Decoded WASM bytes differ');
      }
      if (!decoded.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('E_RELEASE_ENGINE', 'Invalid decoded WebAssembly module');
    }
  }
  for (const path of await filesIn(root)) {
    const key = relativePath(root, path);
    if (key !== 'release.json' && !paths.has(key)) fail('E_RELEASE_UNSEALED', `Unsealed file ${key}`);
  }
  const attestation = await json(within(root, descriptor.attestation));
  if(attestation.runtimeProfile!==undefined&&attestation.runtimeProfile!==descriptor.runtimeProfile)fail('E_RELEASE_PROFILE','Attestation profile differs from release');
  if (attestation.schemaVersion !== 1 || attestation.kind !== 'godot-js-web-release-attestation') fail('E_RELEASE_ATTESTATION', 'Unsupported release attestation');
  if (digest(canonical(attestation.recipe)) !== attestation.recipeSha256) fail('E_RELEASE_RECIPE', 'Attestation recipe was changed');
  assertSourcePatchChains(attestation);
  const wasm = descriptor.files.find(file => file.kind === 'engine-wasm');
  const wasmSha256 = wasm?.decodedSha256 ?? wasm?.sha256;
  assertRuntimeObservationBuildProof(attestation, wasmSha256);
  assertRuntimeWriteBuildProof(attestation, wasmSha256);
  assertRuntimePropertiesBuildProof(attestation, wasmSha256);
  assertRuntimeCallBuildProof(attestation, {
    wasmSha256,
    javascriptSha256: descriptor.files.find(file => file.kind === 'engine-js')?.sha256,
  });
  if (descriptor.sourceCertified) {
    if (attestation.status !== 'built') fail('E_RELEASE_SOURCE', 'Source certification requires an actual successful build');
    assertCommit(attestation.source?.commit, 'GodotJS commit'); assertHash(attestation.source?.snapshotHash, 'GodotJS snapshot');
    assertCommit(attestation.godotSource?.commit, 'Godot commit'); assertHash(attestation.godotSource?.snapshotHash, 'Godot snapshot');
    for (const source of [attestation.source, attestation.godotSource]) if (digest(canonical(source.inputs)) !== source.snapshotHash) fail('E_RELEASE_SOURCE', 'Source snapshot map does not match its hash');
    if (descriptor.target?.sourceCommit !== attestation.source.commit || descriptor.target?.sourceDiffHash !== attestation.source.snapshotHash || descriptor.target?.buildFlags?.godot_build_recipe_sha256 !== attestation.recipeSha256) fail('E_RELEASE_SOURCE', 'Runtime target does not match the actual engine source tuple');
    const actualExecution=executionFromReport(attestation);
    const declaredExecution=descriptor.execution??legacyExecution();
    for(const key of ['executionModel','wasmThreads','proxyToPthread','requiresCrossOriginIsolation','hostProtocolVersion','lifecycleAbi','artifactSetAbi','hostResourceAbi','shutdownQueueAbi'])if(actualExecution[key]!==declaredExecution[key])fail('E_RELEASE_EXECUTION','Execution differs from the source-bound recipe: '+key);
  }
  const releaseExecution=descriptor.execution??legacyExecution();
  assertExecutionAssets(releaseExecution,descriptor.files);
  if(descriptor.engine?.host){const host=descriptor.engine.host,file=descriptor.files.find(item=>item.path===host.path);if(!file||file.sha256!==host.sha256||file.bytes!==host.bytes||!Number.isSafeInteger(host.bytes)||host.bytes<=0)fail('E_RELEASE_HOST','Browser host is outside the sealed release');}
  if(descriptor.engine?.threads!==releaseExecution.wasmThreads)fail('E_RELEASE_EXECUTION','Engine thread metadata differs from execution contract');
  if(descriptor.runtimeProfile!==undefined&&descriptor.runtimeProfile!=='legacy-profiles-v1')getEngineProfile(descriptor.runtimeProfile);
  if(isEngineProfile(descriptor.runtimeProfile)){
    if(descriptor.legacy!==false||!descriptor.engineRelease)fail('E_RELEASE_PROFILE','Native release cannot enter the legacy path');
    const native=await json(within(root,descriptor.engineRelease));
    if(releaseExecution.executionModel!=='window'&&!native.engine?.host)fail('E_RELEASE_HOST','Worker native descriptor has no bound host bundle');
    if(native.engine?.host){
      const host=native.engine.host,file=descriptor.files.find(item=>item.path===host.path),sealed=native.payloads?.[host.path];
      if(!file||!sealed||file.sha256!==host.sha256||file.bytes!==host.bytes||sealed.sha256!==host.sha256||sealed.bytes!==host.bytes)fail('E_RELEASE_HOST','Browser host is outside the exact release closure');
    }
    if(native.engineId!==undefined||native.extensionId!==undefined){
      const target=assertFullEngineIdentities(native);
      if((descriptor.engineId!==undefined&&descriptor.engineId!==target.engineId)||(descriptor.extensionId!==undefined&&descriptor.extensionId!==target.extensionId))fail('E_RELEASE_IDENTITY','Native engine/extension identities differ from release');
    }
    if(native.sdk?.typesHash){
      const types=await json(within(root,native.api.typeSnapshot.path));
      for(const name of Object.keys(native.api.declarations))delete types[name];
      if(digest(canonical(types))!==native.sdk.typesHash)fail('E_RELEASE_IDENTITY','Extension declarations differ from their sealed type identity');
    }
    const nativeIdentity=structuredClone(native);delete nativeIdentity.id;delete nativeIdentity.verifiedRelease?.releaseId;
    if(native.schemaVersion!==2||native.runtimeProfile!==descriptor.runtimeProfile||native.profile!==descriptor.runtimeProfile||native.verifiedRelease?.profile!==descriptor.runtimeProfile||native.id!==digest(canonical(nativeIdentity))||native.id!==descriptor.engineReleaseId||native.verifiedRelease?.releaseId!==native.id)fail('E_RELEASE_PROFILE','Native descriptor identity/profile mismatch');
    const ir=await json(within(root,native.api.ir.path));
    if(attestation.modules&&canonical([...attestation.modules].sort())!==canonical([...ir.modules].sort()))fail('E_RELEASE_MODULES','Attested modules differ from native API');
    try{validateEngineProfile(descriptor.runtimeProfile,{modules:ir.modules,classes:ir.classes,features:attestation.resolvedFeatures||attestation.resolvedBuildOptions?{...attestation.resolvedBuildOptions,...attestation.resolvedFeatures}:undefined});}catch(error){fail('E_RELEASE_PROFILE',error.message);}
    if(canonical([...ir.modules].sort())!==canonical([...(native.modules??[])].sort())||canonical([...ir.modules].sort())!==canonical([...(descriptor.engine.modules??[])].sort()))fail('E_RELEASE_MODULES','Native module evidence does not match the actual API');
    if(descriptor.runtimeProfile==='engine-2d-v1'&&!attestation.resolvedFeatures&&!attestation.resolvedBuildOptions&&descriptor.sourceCertified)fail('E_RELEASE_PROFILE','Certified 2D requires resolved feature evidence');
  }
  if (descriptor.certified) {
    if (!descriptor.sourceCertified || descriptor.certification?.status !== 'passed' || descriptor.certification.runtimeRelease !== descriptor.id) fail('E_RELEASE_CERTIFICATION', 'Missing source or exact-release browser certification');
    const evidence = descriptor.certification;
    assertExecutionCertification(releaseExecution,evidence);
    assertGame2dCertification(descriptor, evidence);
    const requiredKinds = ['engine-js', 'engine-wasm', 'contracts', 'bootstrap', 'compiler-js', 'compiler-wasm', 'typescript', 'typescript-module', 'type'];
    for (const kind of requiredKinds) if (!descriptor.files.some(file => file.kind === kind)) fail('E_RELEASE_CERTIFICATION', `Missing certified ${kind} asset`);
    for (const mode of ['development', 'production']) if (!descriptor.files.some(file => file.kind === 'sdk' && file.sdkMode === mode)) fail('E_RELEASE_CERTIFICATION', `Missing certified ${mode} SDK`);
    if (!Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.some(check => check.status !== 'passed')) fail('E_RELEASE_CERTIFICATION', 'Every recorded browser check must pass');
    for (const file of descriptor.files.filter(file => file.kind !== 'attestation')) {
      if (evidence.artifactHashes?.[file.path] !== file.sha256) fail('E_RELEASE_CERTIFICATION', `Browser evidence does not bind ${file.path}`);
    }
  }
  return descriptor;
}
