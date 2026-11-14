export interface VerifiedAsset {
  url: string;
  /** Digest of the exact bytes of the static file, before explicit decoding. */
  sha256: string;
  encoding?: 'gzip';
  decodedSha256?: string;
  decodedBytes?: number;
  maxDecodedBytes?: number;
}
export interface VerifiedRelease {
  releaseId: string;
  profile: string;
  engineJs: VerifiedAsset;
  engineWasm: VerifiedAsset;
  worklets?: Array<VerifiedAsset & { name?: string }>;
  releaseCertified?: boolean;
  allowedOrigins?: string[];
  maxAssetBytes?: number;
  /** Explicitly public versioned assets only; private assets keep revalidation. */
  cachePolicy?: 'revalidate' | 'public-immutable';
  /** Runtime transport contract, independently versioned from engine profiles. */
  runtimeAbi?: { protocolVersion: 2; host: 1; audio: 1; presentation: 1 };
  runtimeWorker?: VerifiedAsset;
  runtimeAudioWorklet?: VerifiedAsset;
}
export interface GodotInstance {
  preloadFile(bytes: Uint8Array, path: string): Promise<void>;
  init(basePath?: string): Promise<void>;
  start(config: Record<string, unknown>): Promise<void>;
  requestQuit(): void;
}
export interface GodotConstructor {
  new(config: Record<string, unknown>): GodotInstance;
  load(basePath: string, size?: number): Promise<unknown>;
}
export interface LoadedEngine {
  Engine: GodotConstructor;
  basePath: string;
  wasmSha256: string;
  /** Install on this instance before init(), using Godot 4.6.1's module-config hook. */
  installWorklets(instance: GodotInstance): void;
  dispose(): void;
}
export interface VerifiedWorkletBytes {
  name: string;
  /** Digest of these decoded bytes, ready for the receiving host to execute. */
  sha256: string;
  bytes: Uint8Array;
}
export interface LoadedWorkerEngine extends LoadedEngine {
  worklets: readonly VerifiedWorkletBytes[];
  runtimeAudioWorklet?: VerifiedWorkletBytes;
}
/** Narrow injection surface for worker hosts and loader contract tests. */
export interface VerifiedWorkerScope {
  fetch: typeof fetch;
  importScripts(...urls: string[]): void;
  location?: { href: string };
}
export interface VerifiedRuntimeWorker {
  worker: Worker;
  /** Original HTTP script URL, for an explicit logical base in Blob workers. */
  readonly scriptUrl: string;
  /** Terminates the worker and releases the exact verified script URL. */
  dispose(): void;
}
export interface RuntimeWorkerLoadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  cachePolicy?: 'revalidate' | 'public-immutable';
  allowedOrigins?: readonly string[];
  workerOptions?: WorkerOptions;
  Worker?: new (scriptURL: string | URL, options?: WorkerOptions) => Worker;
  fetch?: typeof fetch;
}

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError'); }
const DEFAULT_ASSET_LIMIT = 128 * 1024 * 1024;
const validDigest = (digest: unknown): digest is string => typeof digest === 'string' && /^[a-fA-F0-9]{64}$/.test(digest);
type WorkletKind = 'audio.worklet.js' | 'audio.position.worklet.js';
function workletKind(name: string): WorkletKind | undefined {
  for (const kind of ['audio.worklet.js', 'audio.position.worklet.js'] as const) {
    if (name === kind || name.endsWith(`.${kind}`)) return kind;
  }
}
function declaredWorkletKind(asset: VerifiedAsset & { name?: string }, base?: string): WorkletKind {
  const name = asset.name ?? new URL(asset.url, base).pathname.split('/').pop()!.replace(/\.gz$/, '');
  const kind = typeof name === 'string' ? workletKind(name) : undefined;
  if (!kind || name.includes('/') || name.includes('\\')) throw new Error('E_RELEASE_WORKLET_NAME');
  return kind;
}
function assetMetadata(asset: VerifiedAsset): void {
  if (!asset || !validDigest(asset.sha256)) throw new Error('E_RELEASE_DIGEST');
  if (asset.encoding !== undefined && asset.encoding !== 'gzip') throw new Error('E_RELEASE_ENCODING');
  if (asset.encoding === 'gzip') {
    if (!validDigest(asset.decodedSha256)) throw new Error('E_RELEASE_DECODED_DIGEST');
  } else if (asset.decodedSha256 !== undefined || asset.decodedBytes !== undefined) throw new Error('E_RELEASE_ENCODING');
  for (const size of [asset.decodedBytes, asset.maxDecodedBytes]) {
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) throw new Error('E_RELEASE_ASSET_SIZE');
  }
}
function byteLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ASSET_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('E_RELEASE_ASSET_SIZE');
  return value;
}
async function digestMatches(bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, n => n.toString(16).padStart(2, '0')).join('') === expected.toLowerCase();
}
async function readLimited(stream: ReadableStream<Uint8Array>, max: number, errorCode: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  const cancelled = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancelled, { once: true });
  try {
    for (;;) {
      abort(signal);
      const { done, value } = await reader.read();
      abort(signal);
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error(errorCode);
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', cancelled); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function validateRelease(release: VerifiedRelease, base = globalThis.location?.href): void {
  if (!release || typeof release.releaseId !== 'string' || !release.releaseId || typeof release.profile !== 'string' || !release.profile) throw new Error('E_RELEASE_DESCRIPTOR');
  if (release.cachePolicy !== undefined && !['revalidate', 'public-immutable'].includes(release.cachePolicy)) throw new Error('E_RELEASE_CACHE_POLICY');
  if (release.worklets !== undefined && !Array.isArray(release.worklets)) throw new Error('E_RELEASE_WORKLETS');
  const kinds = new Set<WorkletKind>();
  if (release.runtimeAbi !== undefined && (!release.runtimeAbi || release.runtimeAbi.protocolVersion !== 2 || release.runtimeAbi.host !== 1 || release.runtimeAbi.audio !== 1 || release.runtimeAbi.presentation !== 1)) throw new Error('E_RELEASE_RUNTIME_ABI');
  for (const asset of [release.engineJs, release.engineWasm, ...release.worklets ?? [], ...release.runtimeWorker ? [release.runtimeWorker] : [], ...release.runtimeAudioWorklet ? [release.runtimeAudioWorklet] : []]) {
    assetMetadata(asset);
    const url = new URL(asset.url, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('E_RELEASE_URL');
    if (release.allowedOrigins && !release.allowedOrigins.includes(url.origin)) throw new Error('E_RELEASE_ORIGIN');
  }
  for (const asset of release.worklets ?? []) {
    const kind = declaredWorkletKind(asset, base);
    if (kinds.has(kind)) throw new Error('E_RELEASE_WORKLET_DUPLICATE');
    kinds.add(kind);
  }
}

/** Resolve before crossing realms: a verified Blob has no HTTP relative base. */
export function resolveVerifiedRelease(release: VerifiedRelease, base = globalThis.location?.href): VerifiedRelease {
  validateRelease(release, base);
  const resolve = <T extends VerifiedAsset>(asset: T): T => ({ ...asset, url: new URL(asset.url, base).href });
  return { ...release, engineJs: resolve(release.engineJs), engineWasm: resolve(release.engineWasm),
    ...(release.worklets ? { worklets: release.worklets.map(resolve) } : {}),
    ...(release.runtimeWorker ? { runtimeWorker: resolve(release.runtimeWorker) } : {}),
    ...(release.runtimeAudioWorklet ? { runtimeAudioWorklet: resolve(release.runtimeAudioWorklet) } : {}) };
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason); };
    signal.addEventListener('abort', cancelled, { once: true });
    pending.then(value => { signal.removeEventListener('abort', cancelled); resolve(value); }, error => { signal.removeEventListener('abort', cancelled); reject(error); });
  });
}

/** Downloads a bundled, self-contained classic worker and executes those exact
 * verified bytes. Creation does not imply application readiness; the caller's
 * protocol owns handshake and startup deadlines. Never imports an unverified URL. */
export async function loadVerifiedRuntimeWorker(asset: VerifiedAsset, options: RuntimeWorkerLoadOptions = {}): Promise<VerifiedRuntimeWorker> {
  abort(options.signal);
  assetMetadata(asset);
  const url = new URL(asset.url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('E_RELEASE_URL');
  if (options.allowedOrigins && !options.allowedOrigins.includes(url.origin)) throw new Error('E_RELEASE_ORIGIN');
  if (options.workerOptions?.type !== undefined && options.workerOptions.type !== 'classic') throw new Error('E_RUNTIME_WORKER_TYPE');
  const bytes = await fetchVerifiedAsset(asset, options);
  abort(options.signal);
  let blobUrl: string | undefined, worker: Worker | undefined, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    try { worker?.terminate(); }
    finally { if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined; } }
  };
  try {
    options.signal?.addEventListener('abort', dispose, { once: true });
    abort(options.signal);
    blobUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'text/javascript' }));
    const Constructor = options.Worker ?? globalThis.Worker;
    if (typeof Constructor !== 'function') throw new Error('E_RUNTIME_WORKER_UNAVAILABLE');
    worker = new Constructor(blobUrl, { ...options.workerOptions, type: 'classic' });
    // An injected constructor can synchronously cancel before returning.
    if (disposed) worker.terminate();
    abort(options.signal);
    return { worker, scriptUrl: url.href, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Worker equivalent of loadVerifiedEngine, without document or DOM execution.
 * importScripts remains synchronous; this adapter must run before project code.
 * Raw verified worklet bytes may be transferred to the iframe's audio host. */
export async function loadVerifiedWorkerEngine(release: VerifiedRelease, options: { signal?: AbortSignal; scope?: VerifiedWorkerScope; fetch?: typeof fetch; includeRuntimeAudioWorklet?: boolean; baseUrl?: string } = {}): Promise<LoadedWorkerEngine> {
  const scope = options.scope ?? globalThis as unknown as VerifiedWorkerScope;
  release = resolveVerifiedRelease(release, options.baseUrl ?? scope.location?.href);
  if (typeof scope.importScripts !== 'function') throw new Error('E_ENGINE_WORKER_IMPORT');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
  const urls: string[] = [];
  const installed = new Map<object, { config: Record<string, unknown>; wrapper: unknown; own?: PropertyDescriptor }>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', dispose);
    controller.abort(new DOMException('Engine disposed', 'AbortError'));
    for (const { config, wrapper, own } of installed.values()) if (config.getModuleConfig === wrapper) {
      if (own) Object.defineProperty(config, 'getModuleConfig', own);
      else delete config.getModuleConfig;
    }
    installed.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.length = 0;
  };
  const blob = (bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'text/javascript' }));
    urls.push(url); return url;
  };
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  controller.signal.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) forwardAbort();
  try {
    abort(controller.signal);
    const declared = release.worklets ?? [];
    const runtimeAudio = options.includeRuntimeAudioWorklet === true ? release.runtimeAudioWorklet : undefined;
    const assets = [release.engineJs, release.engineWasm, ...declared, ...runtimeAudio ? [runtimeAudio] : []];
    const bytes = await Promise.all(assets.map(asset => fetchVerifiedAsset(asset, { signal: controller.signal, maxBytes: release.maxAssetBytes, cachePolicy: release.cachePolicy, fetch: options.fetch ?? scope.fetch.bind(scope) })));
    abort(controller.signal);
    const worklets = declared.map((asset, index): VerifiedWorkletBytes => ({ name: declaredWorkletKind(asset, scope.location?.href), sha256: asset.decodedSha256 ?? asset.sha256, bytes: bytes[index + 2] }));
    const runtimeAudioWorklet = runtimeAudio ? { name: 'runtime.audio.worklet.js', sha256: runtimeAudio.decodedSha256 ?? runtimeAudio.sha256, bytes: bytes.at(-1)! } : undefined;
    const workletUrls = new Map(worklets.map(worklet => [worklet.name, blob(worklet.bytes)]));
    const captureKey = '__godotjsVerifiedEngine_' + crypto.randomUUID().replaceAll('-', '');
    const globals = scope as unknown as Record<string, unknown>;
    const capture = new TextEncoder().encode(`globalThis[${JSON.stringify(captureKey)}] = typeof Engine === 'function' ? Engine : undefined;`);
    let Engine: GodotConstructor;
    try {
      // The capture is a separate, fixed host script; engine bytes are unchanged.
      scope.importScripts(blob(bytes[0]), blob(capture));
      Engine = globals[captureKey] as GodotConstructor;
    } finally { delete globals[captureKey]; }
    abort(controller.signal);
    if (!Engine! || typeof Engine.load !== 'function') throw new Error('E_ENGINE_API');
    const basePath = await abortable(injectVerifiedWasm(Engine, release.engineWasm.url, bytes[1], scope), controller.signal);
    abort(controller.signal);
    const installWorklets = (instance: GodotInstance) => {
      if (disposed) throw new Error('E_ENGINE_DISPOSED');
      if (!workletUrls.size) return;
      const config = (instance as unknown as { config?: Record<string, unknown> }).config;
      if (!config || typeof config.getModuleConfig !== 'function') throw new Error('E_ENGINE_WORKLET_API');
      if (installed.has(config)) return;
      const original = config.getModuleConfig as (...args: unknown[]) => { locateFile?: (...args: unknown[]) => unknown };
      const wrapper = function(this: unknown, ...args: unknown[]) {
        if (disposed) throw new Error('E_ENGINE_DISPOSED');
        const module = original.apply(this, args), locateFile = module?.locateFile;
        if (typeof locateFile !== 'function') throw new Error('E_ENGINE_WORKLET_API');
        return { ...module, locateFile(path: string, ...rest: unknown[]) {
          if (disposed) throw new Error('E_ENGINE_DISPOSED');
          const kind = workletKind(path);
          if (kind) { const url = workletUrls.get(kind); if (!url) throw new Error('E_ENGINE_WORKLET_MISSING'); return url; }
          return locateFile.call(module, path, ...rest);
        } };
      };
      const own = Object.getOwnPropertyDescriptor(config, 'getModuleConfig');
      config.getModuleConfig = wrapper; installed.set(config, { config, wrapper, own });
    };
    return { Engine, basePath, wasmSha256: release.engineWasm.decodedSha256 ?? release.engineWasm.sha256, worklets, runtimeAudioWorklet, installWorklets, dispose };
  } catch (error) { dispose(); throw error; }
}
export async function fetchVerifiedAsset(asset: VerifiedAsset, options: { signal?: AbortSignal; maxBytes?: number; maxDecodedBytes?: number; fetch?: typeof fetch; cachePolicy?: 'revalidate' | 'public-immutable' } = {}): Promise<Uint8Array> {
  abort(options.signal);
  assetMetadata(asset);
  const max = byteLimit(options.maxBytes);
  const maxDecoded = Math.min(byteLimit(options.maxDecodedBytes), byteLimit(asset.maxDecodedBytes));
  if (asset.decodedBytes !== undefined && asset.decodedBytes > maxDecoded) throw new Error('E_ASSET_DECODED_SIZE');
  // Preserve the current host's login for private static assets. Fetch still
  // omits credentials for every other origin, including the public npm CDN.
  const immutable = options.cachePolicy === 'public-immutable';
  if (options.cachePolicy !== undefined && !['revalidate', 'public-immutable'].includes(options.cachePolicy)) throw new Error('E_RELEASE_CACHE_POLICY');
  if (immutable && !/^\/releases\/[A-Za-z0-9_-]{8,}\//.test(new URL(asset.url, globalThis.location?.href).pathname)) throw new Error('E_RELEASE_IMMUTABLE_URL');
  const response = await (options.fetch ?? globalThis.fetch)(asset.url, { signal: options.signal, credentials: immutable ? 'omit' : 'same-origin', redirect: 'error', cache: immutable ? 'force-cache' : 'no-cache' });
  if (!response.ok) throw new Error(`E_ASSET_HTTP: ${response.status} ${new URL(asset.url, globalThis.location?.href).pathname}`);
  if (Number(response.headers.get('content-length')) > max) { void response.body?.cancel().catch(() => {}); throw new Error('E_ASSET_SIZE'); }
  if (!response.body) throw new Error('E_ASSET_BODY');
  let bytes = await readLimited(response.body, max, 'E_ASSET_SIZE', options.signal);
  if (!await digestMatches(bytes, asset.sha256)) throw new Error('E_ASSET_HASH');
  abort(options.signal);
  if (asset.encoding === 'gzip') {
    if (typeof DecompressionStream === 'undefined') throw new Error('E_ASSET_DECOMPRESSION_UNAVAILABLE');
    try {
      const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = await readLimited(stream, Math.min(maxDecoded, asset.decodedBytes ?? maxDecoded), 'E_ASSET_DECODED_SIZE', options.signal);
    } catch (error) {
      abort(options.signal);
      if (error instanceof Error && error.message === 'E_ASSET_DECODED_SIZE') throw error;
      throw new Error('E_ASSET_DECOMPRESSION', { cause: error });
    }
    if (asset.decodedBytes !== undefined && bytes.byteLength !== asset.decodedBytes) throw new Error('E_ASSET_DECODED_LENGTH');
    if (!await digestMatches(bytes, asset.decodedSha256!)) throw new Error('E_ASSET_DECODED_HASH');
  }
  abort(options.signal);
  return bytes;
}

/** Godot 4.6.1's public Engine.load synchronously starts one fetch. This adapter
 * supplies the verified response at that exact point and fails closed otherwise.
 * It runs before any project code and restores fetch before returning. */
export async function injectVerifiedWasm(Engine: GodotConstructor, wasmUrl: string, bytes: Uint8Array, scope: Pick<typeof globalThis, 'fetch'> = globalThis): Promise<string> {
  const url = new URL(wasmUrl, globalThis.location?.href);
  // The .wasm URL is a private, in-memory loader key when the static download is
  // .wasm.gz. Engine.load never fetches this virtual URL from the network.
  if (url.pathname.endsWith('.wasm.gz')) url.pathname = url.pathname.slice(0, -3);
  if (!url.pathname.endsWith('.wasm')) throw new Error('E_ENGINE_WASM_URL');
  url.search = ''; url.hash = '';
  const basePath = url.href.slice(0, -5);
  const original = scope.fetch;
  let hits = 0;
  scope.fetch = ((input: RequestInfo | URL) => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, url.href).href;
    if (requested !== url.href || ++hits !== 1) return Promise.reject(new Error('E_ENGINE_LOADER_FETCH'));
    // This copy is the same verified bytes, never a second network request.
    return Promise.resolve(new Response(bytes.slice().buffer, { headers: { 'content-type': 'application/wasm' } }));
  }) as typeof fetch;
  let pending: Promise<unknown>;
  try { pending = Engine.load(basePath, bytes.byteLength); }
  finally { scope.fetch = original; }
  if (hits !== 1) { void pending!.catch(() => {}); throw new Error('E_ENGINE_LOADER_UNSUPPORTED'); }
  await pending!;
  return basePath;
}

export async function loadVerifiedEngine(release: VerifiedRelease, options: { signal?: AbortSignal; document?: Document } = {}): Promise<LoadedEngine> {
  validateRelease(release);
  const [js, wasm, ...worklets] = await Promise.all([
    fetchVerifiedAsset(release.engineJs, { signal: options.signal, maxBytes: release.maxAssetBytes, cachePolicy: release.cachePolicy }),
    fetchVerifiedAsset(release.engineWasm, { signal: options.signal, maxBytes: release.maxAssetBytes, cachePolicy: release.cachePolicy }),
    ...(release.worklets ?? []).map(asset => fetchVerifiedAsset(asset, { signal: options.signal, maxBytes: release.maxAssetBytes, cachePolicy: release.cachePolicy })),
  ]);
  abort(options.signal);
  const doc = options.document ?? document;
  const script = doc.createElement('script');
  const urls: string[] = [];
  const verifiedWorklets = new Map<WorkletKind, string>();
  type ModuleConfig = { locateFile?: (path: string, ...args: unknown[]) => string };
  type Config = { getModuleConfig: (...args: unknown[]) => ModuleConfig };
  const installed = new Map<Config, { wrapper: Config['getModuleConfig']; own?: PropertyDescriptor }>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    script.onload = null; script.onerror = null;
    script.remove();
    for (const [config, hook] of installed) {
      if (config.getModuleConfig !== hook.wrapper) continue;
      if (hook.own) Object.defineProperty(config, 'getModuleConfig', hook.own);
      else delete (config as Partial<Config>).getModuleConfig;
    }
    installed.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.length = 0;
  };
  const blob = (bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'text/javascript' }));
    urls.push(url);
    return url;
  };
  const installWorklets = (instance: GodotInstance) => {
    if (disposed) throw new Error('E_ENGINE_DISPOSED');
    if (verifiedWorklets.size === 0) return;
    // This is the instance config used by the unmodified Godot 4.6.1 Engine.init.
    // Patching its factory leaves the SDK and other engine instances untouched.
    const config = (instance as unknown as { config?: Config }).config;
    if (!config || typeof config.getModuleConfig !== 'function') throw new Error('E_ENGINE_WORKLET_API');
    if (installed.has(config)) return;
    const original = config.getModuleConfig;
    const wrapper: Config['getModuleConfig'] = function (this: Config, ...args) {
      if (disposed) throw new Error('E_ENGINE_DISPOSED');
      const module = original.apply(this, args);
      const locateFile = module?.locateFile;
      if (typeof locateFile !== 'function') throw new Error('E_ENGINE_WORKLET_API');
      return { ...module, locateFile(path: string, ...rest: unknown[]) {
        if (disposed) throw new Error('E_ENGINE_DISPOSED');
        const kind = workletKind(path);
        if (kind) {
          const url = verifiedWorklets.get(kind);
          if (!url) throw new Error('E_ENGINE_WORKLET_MISSING');
          return url;
        }
        return locateFile.call(module, path, ...rest);
      } };
    };
    const own = Object.getOwnPropertyDescriptor(config, 'getModuleConfig');
    config.getModuleConfig = wrapper;
    installed.set(config, { wrapper, own });
  };
  try {
    options.signal?.addEventListener('abort', dispose, { once: true });
    abort(options.signal);
    for (let index = 0; index < worklets.length; index++) {
      verifiedWorklets.set(declaredWorkletKind(release.worklets![index], globalThis.location?.href), blob(worklets[index]));
    }
    const blobUrl = blob(js);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener('abort', cancelled);
        script.onload = null; script.onerror = null;
      };
      const cancelled = () => { cleanup(); reject(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
      script.onload = () => { cleanup(); resolve(); };
      script.onerror = () => { cleanup(); reject(new Error('E_ENGINE_SCRIPT')); };
      options.signal?.addEventListener('abort', cancelled, { once: true });
      script.src = blobUrl;
      try { doc.head.append(script); }
      catch (error) { cleanup(); reject(error); }
    });
    abort(options.signal);
    const Engine = (doc.defaultView as unknown as { Engine?: GodotConstructor })?.Engine;
    if (!Engine || typeof Engine.load !== 'function') throw new Error('E_ENGINE_API');
    const basePath = await injectVerifiedWasm(Engine, release.engineWasm.url, wasm);
    abort(options.signal);
    return { Engine, basePath, wasmSha256: release.engineWasm.decodedSha256 ?? release.engineWasm.sha256, installWorklets, dispose };
  } catch (error) { dispose(); throw error; }
}
