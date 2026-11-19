import {assertNativeReleaseIdentity, assertSiteDescriptorIdentity, canonicalIdentityJson} from '../identities.js';
import {validateExecution} from '../execution.js';
import type {AssetIntegrity, ReleaseFacts, ReleaseInput} from '../release-assets.js';
import {validateRelease, type VerifiedAsset, type VerifiedRelease} from './verified-loader.js';
import {WORKER_PROTOCOL} from './dedicated/worker-protocol.js';

export interface PrepareWorkerReleaseOptions extends ReleaseInput {
  siteManifestBytes: Uint8Array;
  /** Root of the complete preview mirror, independently of the editor root. */
  previewBaseUrl: string;
  presentationBackend: 'direct' | 'bitmap';
  allowedOrigins: readonly string[];
  cachePolicy: 'revalidate' | 'public-immutable';
  signal?: AbortSignal;
}
export interface PreparedWorkerRelease {
  release: VerifiedRelease;
  facts: ReleaseFacts & Readonly<{candidateId: string}>;
}

type Data = Record<string, unknown>;
type RuntimeAbi = NonNullable<VerifiedRelease['runtimeAbi']>;
const digestPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: string, detail: string): never { throw Error(code + ': ' + detail); }
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
function captureBytes(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) return fail('E_WORKER_RELEASE_INPUT', field + ' must be Uint8Array');
  return new Uint8Array(value);
}
function parse(bytes: Uint8Array, field: string): Data {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (record(value)) return value;
  } catch (cause) { throw Error('E_WORKER_RELEASE_JSON: ' + field, {cause}); }
  return fail('E_WORKER_RELEASE_JSON', field + ' must be an object');
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
}
function path(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || /[:\\?#%\x00-\x20\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'))
    fail('E_WORKER_RELEASE_ASSET', 'Expected a relative static asset path');
}
function asset(value: unknown): asserts value is AssetIntegrity & {bytes: number} {
  if (!record(value) || typeof value.sha256 !== 'string' || !digestPattern.test(value.sha256) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0)
    fail('E_WORKER_RELEASE_ASSET', 'Missing stored asset hash or length');
}
function abi(value: unknown): asserts value is RuntimeAbi {
  if (!record(value) || value.protocolVersion !== WORKER_PROTOCOL || value.host !== 1 || value.audio !== 1 || value.presentation !== 1 ||
      value.lifecycle !== undefined && value.lifecycle !== 1 || Object.keys(value).some(key => !['protocolVersion', 'host', 'audio', 'presentation', 'lifecycle'].includes(key)))
    fail('E_WORKER_RELEASE_ABI', 'Unsupported Worker runtime ABI');
}
function root(value: string): URL {
  if (typeof value !== 'string') return fail('E_WORKER_RELEASE_URL', 'Expected preview root URL');
  let url: URL;
  try { url = new URL(value); }
  catch (cause) { throw Error('E_WORKER_RELEASE_URL: Invalid preview root URL', {cause}); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('E_WORKER_RELEASE_URL', 'Expected an HTTP preview root without credentials, query or fragment');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/** Prepare a captured release/site pair. Payload bytes are verified by the
 * existing loader when consumed; this helper never fetches executable assets. */
export async function prepareWorkerRelease(input: PrepareWorkerReleaseOptions): Promise<PreparedWorkerRelease> {
  // Capture every mutable input before the first digest/identity await.
  const descriptorBytes = captureBytes(input.descriptorBytes, 'descriptorBytes');
  const siteBytes = captureBytes(input.siteManifestBytes, 'siteManifestBytes');
  const previewRoot = root(input.previewBaseUrl);
  const presentation = input.presentationBackend, cachePolicy = input.cachePolicy, signal = input.signal;
  if (!Array.isArray(input.allowedOrigins)) fail('E_WORKER_RELEASE_ORIGIN', 'Expected allowedOrigins');
  const origins = [...new Set(input.allowedOrigins.map(value => root(value).origin))];
  if (!origins.includes(previewRoot.origin)) fail('E_WORKER_RELEASE_ORIGIN', 'Preview mirror origin is not allowed');
  active(signal);
  if (!['direct', 'bitmap'].includes(presentation)) fail('E_WORKER_RELEASE_PRESENTER', 'Unsupported presenter');
  if (!['revalidate', 'public-immutable'].includes(cachePolicy)) fail('E_WORKER_RELEASE_CACHE_POLICY', 'Unsupported cache policy');
  const descriptor = parse(descriptorBytes, 'descriptorBytes'), site = parse(siteBytes, 'siteManifestBytes');
  await assertNativeReleaseIdentity(descriptor);
  active(signal);
  const [descriptorSha256, candidateId] = await Promise.all([digest(descriptorBytes), digest(siteBytes)]);
  active(signal);
  if (site.schemaVersion !== 3 || typeof descriptor.runtimeProfile !== 'string' || !descriptor.runtimeProfile ||
      site.runtimeProfile !== descriptor.runtimeProfile || site.engineReleaseId !== descriptor.id ||
      site.engineRelease !== undefined && site.engineRelease !== 'engine-release.json' ||
      site.engineId !== undefined && site.engineId !== descriptor.engineId || site.extensionId !== undefined && site.extensionId !== descriptor.extensionId)
    fail('E_WORKER_RELEASE_SITE', 'Site does not describe this native release');
  assertSiteDescriptorIdentity(site, {sha256: descriptorSha256, bytes: descriptorBytes.byteLength}, {required: true});
  if (cachePolicy === 'public-immutable' && site.publicAssets !== true)
    fail('E_WORKER_RELEASE_CACHE_POLICY', 'Immutable caching requires explicitly public site assets');
  const engine = descriptor.engine;
  if (!record(engine)) fail('E_WORKER_RELEASE_SITE', 'Missing native engine');
  const execution = descriptor.execution ?? engine.execution;
  validateExecution(execution);
  if (execution.wasmThreads || execution.proxyToPthread || execution.executionModel === 'proxy-pthread')
    fail('E_WORKER_RELEASE_EXECUTION', 'Dedicated runtime requires a threadless native target');
  if (site.executionModel !== undefined && site.executionModel !== execution.executionModel)
    fail('E_WORKER_RELEASE_EXECUTION', 'Site execution declaration differs from native target');
  const runtime = site.runtime;
  if (!record(runtime) || runtime.executionBackend !== 'worker' || !record(runtime.assets) || !record(site.payloads))
    fail('E_WORKER_RELEASE_RUNTIME', 'Missing Worker runtime and payload closure');
  abi(descriptor.runtimeAbi); abi(runtime.abi);
  if (canonicalIdentityJson(descriptor.runtimeAbi) !== canonicalIdentityJson(runtime.abi) || descriptor.runtimeAbi.lifecycle !== execution.lifecycleAbi)
    fail('E_WORKER_RELEASE_ABI', 'Site/runtime/native ABI declarations differ');
  if (!Array.isArray(runtime.presentationBackends) || !runtime.presentationBackends.length ||
      runtime.presentationBackends.some(value => !['direct', 'bitmap'].includes(String(value))) ||
      new Set(runtime.presentationBackends).size !== runtime.presentationBackends.length || !runtime.presentationBackends.includes(presentation) ||
      !runtime.presentationBackends.includes(runtime.defaultPresentationBackend))
    fail('E_WORKER_RELEASE_PRESENTER', 'Requested presenter is not declared by this runtime');
  const payloads = site.payloads, runtimeAssets = runtime.assets;
  const pair = (name: string, reference: unknown): AssetIntegrity & {bytes: number} => {
    path(name); asset(reference);
    const sealed = payloads[name]; asset(sealed);
    if (reference.sha256 !== sealed.sha256 || reference.bytes !== sealed.bytes ||
        'path' in reference && reference.path !== name || 'path' in sealed && sealed.path !== name)
      fail('E_WORKER_RELEASE_ASSET', 'Asset differs from site payload: ' + name);
    return reference;
  };
  for (const [name, reference] of Object.entries(runtimeAssets)) pair(name, reference);
  const resolve = (name: string, reference: unknown): VerifiedAsset => {
    const integrity = pair(name, reference);
    return {...integrity, url: new URL(name, previewRoot).href};
  };
  const nativeAsset = (reference: unknown): VerifiedAsset => {
    if (!record(reference)) return fail('E_WORKER_RELEASE_ASSET', 'Missing native asset');
    path(reference.path);
    return resolve(reference.path, reference);
  };
  path(runtime.entry); path(runtime.audioWorklet);
  if (runtime.entry === runtime.audioWorklet) fail('E_WORKER_RELEASE_RUNTIME', 'Worker and audio worklet must be distinct');
  if (engine.host !== undefined) {
    if (!record(engine.host)) fail('E_WORKER_RELEASE_ASSET', 'Invalid native preview host');
    path(engine.host.path);
    const nativeHost = pair(engine.host.path, engine.host), runtimeHost = pair(engine.host.path, runtimeAssets[engine.host.path]);
    if (nativeHost.sha256 !== runtimeHost.sha256 || nativeHost.bytes !== runtimeHost.bytes)
      fail('E_WORKER_RELEASE_ASSET', 'Runtime preview host differs from native host');
  }
  const named = (reference: unknown): VerifiedAsset & {name: string} => {
    const resolved = nativeAsset(reference), name = new URL(resolved.url).pathname.split('/').at(-1)!.replace(/\.gz$/, '');
    return {...resolved, name};
  };
  const workers = engine.workerAssets ?? execution.workerAssets ?? [];
  if (!Array.isArray(workers)) fail('E_WORKER_RELEASE_ASSET', 'Invalid native worker assets');
  const worklets = engine.worklets ?? [];
  if (!Array.isArray(worklets)) fail('E_WORKER_RELEASE_ASSET', 'Invalid native worklets');
  const release: VerifiedRelease = {
    releaseId: descriptor.id as string, profile: descriptor.runtimeProfile,
    ...(site.engineTarget === 'template_debug' || site.engineTarget === 'template_release' ? {engineTarget: site.engineTarget} : {}),
    engineJs: nativeAsset(engine.javascript), engineWasm: nativeAsset(engine.wasm),
    worklets: worklets.map(named),
    workerAssets: workers.map(reference => ({...named(reference), ...(record(reference) && typeof reference.role === 'string' ? {role: reference.role} : {})})),
    execution, runtimeAbi: {...descriptor.runtimeAbi},
    runtimeWorker: resolve(runtime.entry, runtimeAssets[runtime.entry]), runtimeAudioWorklet: resolve(runtime.audioWorklet, runtimeAssets[runtime.audioWorklet]),
    ...(descriptor.artifactReceiptVersion === 2 ? {artifactReceiptVersion: 2} : {}), allowedOrigins: origins, cachePolicy,
  };
  validateRelease(release, previewRoot.href);
  if (cachePolicy === 'public-immutable' && [release.engineJs, release.engineWasm, ...release.worklets ?? [], ...release.workerAssets ?? [], release.runtimeWorker!, release.runtimeAudioWorklet!]
    .some(value => !/^\/releases\/[A-Za-z0-9_-]{8,}\//.test(new URL(value.url).pathname)))
    fail('E_WORKER_RELEASE_CACHE_POLICY', 'Immutable assets require versioned release URLs');
  active(signal);
  const facts = Object.freeze({releaseId: release.releaseId, descriptorSha256, engineProfile: release.profile, candidateId,
    ...(typeof descriptor.engineId === 'string' ? {engineId: descriptor.engineId} : {}),
    ...(typeof descriptor.extensionId === 'string' ? {extensionId: descriptor.extensionId} : {}),
    ...(release.artifactReceiptVersion === 2 ? {artifactReceiptVersion: 2 as const} : {}),
    ...(execution.artifactSetAbi === 1 ? {artifactSetAbi: 1 as const} : {}),
  });
  return {release, facts};
}
