import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertGame2dCertification } from './game-2d-evidence.mjs';
import {isEngineProfile,getEngineProfile,validateEngineProfile} from './engine-profiles.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
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
  for (const patch of attestation.recipe?.patches ?? []) if (attestation.godotSource?.inputs?.[patch.path] !== patch.afterSha256) fail('E_RELEASE_RECIPE', `Source patch is not in the attested snapshot: ${patch.patchId}`);
  if (descriptor.sourceCertified) {
    if (attestation.status !== 'built') fail('E_RELEASE_SOURCE', 'Source certification requires an actual successful build');
    assertCommit(attestation.source?.commit, 'GodotJS commit'); assertHash(attestation.source?.snapshotHash, 'GodotJS snapshot');
    assertCommit(attestation.godotSource?.commit, 'Godot commit'); assertHash(attestation.godotSource?.snapshotHash, 'Godot snapshot');
    for (const source of [attestation.source, attestation.godotSource]) if (digest(canonical(source.inputs)) !== source.snapshotHash) fail('E_RELEASE_SOURCE', 'Source snapshot map does not match its hash');
    if (descriptor.target?.sourceCommit !== attestation.source.commit || descriptor.target?.sourceDiffHash !== attestation.source.snapshotHash || descriptor.target?.buildFlags?.godot_build_recipe_sha256 !== attestation.recipeSha256) fail('E_RELEASE_SOURCE', 'Runtime target does not match the actual engine source tuple');
    if (!attestation.recipe?.args?.includes('threads=no') || !attestation.recipe.args.includes('dlink_enabled=no') || !attestation.recipe.args.includes('platform=web')) fail('E_RELEASE_RECIPE', 'Recipe must explicitly build single-thread non-dlink Web');
  }
  if(descriptor.runtimeProfile!==undefined&&descriptor.runtimeProfile!=='legacy-profiles-v1')getEngineProfile(descriptor.runtimeProfile);
  if(isEngineProfile(descriptor.runtimeProfile)){
    if(descriptor.legacy!==false||!descriptor.engineRelease)fail('E_RELEASE_PROFILE','Native release cannot enter the legacy path');
    const native=await json(within(root,descriptor.engineRelease));
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
