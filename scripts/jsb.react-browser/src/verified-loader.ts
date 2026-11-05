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
  releaseCertified?: boolean;
  allowedOrigins?: string[];
  maxAssetBytes?: number;
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
export interface LoadedEngine { Engine: GodotConstructor; basePath: string; wasmSha256: string; dispose(): void }

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError'); }
const DEFAULT_ASSET_LIMIT = 128 * 1024 * 1024;
const validDigest = (digest: unknown): digest is string => typeof digest === 'string' && /^[a-fA-F0-9]{64}$/.test(digest);
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
  for (const asset of [release.engineJs, release.engineWasm]) {
    assetMetadata(asset);
    const url = new URL(asset.url, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('E_RELEASE_URL');
    if (release.allowedOrigins && !release.allowedOrigins.includes(url.origin)) throw new Error('E_RELEASE_ORIGIN');
  }
}
export async function fetchVerifiedAsset(asset: VerifiedAsset, options: { signal?: AbortSignal; maxBytes?: number; maxDecodedBytes?: number; fetch?: typeof fetch } = {}): Promise<Uint8Array> {
  abort(options.signal);
  assetMetadata(asset);
  const max = byteLimit(options.maxBytes);
  const maxDecoded = Math.min(byteLimit(options.maxDecodedBytes), byteLimit(asset.maxDecodedBytes));
  if (asset.decodedBytes !== undefined && asset.decodedBytes > maxDecoded) throw new Error('E_ASSET_DECODED_SIZE');
  // Preserve the current host's login for private static assets. Fetch still
  // omits credentials for every other origin, including the public npm CDN.
  const response = await (options.fetch ?? globalThis.fetch)(asset.url, { signal: options.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-cache' });
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
  const [js, wasm] = await Promise.all([
    fetchVerifiedAsset(release.engineJs, { signal: options.signal, maxBytes: release.maxAssetBytes }),
    fetchVerifiedAsset(release.engineWasm, { signal: options.signal, maxBytes: release.maxAssetBytes }),
  ]);
  abort(options.signal);
  const doc = options.document ?? document;
  const script = doc.createElement('script');
  const blobUrl = URL.createObjectURL(new Blob([js.slice().buffer], { type: 'text/javascript' }));
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      script.onload = () => { options.signal?.removeEventListener('abort', cancelled); resolve(); };
      script.onerror = () => { options.signal?.removeEventListener('abort', cancelled); reject(new Error('E_ENGINE_SCRIPT')); };
      options.signal?.addEventListener('abort', cancelled, { once: true });
      script.src = blobUrl;
      doc.head.append(script);
    });
    abort(options.signal);
    const Engine = (doc.defaultView as unknown as { Engine?: GodotConstructor })?.Engine;
    if (!Engine || typeof Engine.load !== 'function') throw new Error('E_ENGINE_API');
    const basePath = await injectVerifiedWasm(Engine, release.engineWasm.url, wasm);
    abort(options.signal);
    return { Engine, basePath, wasmSha256: release.engineWasm.decodedSha256 ?? release.engineWasm.sha256, dispose: () => script.remove() };
  } catch (error) { script.remove(); throw error; }
  finally { URL.revokeObjectURL(blobUrl); }
}
