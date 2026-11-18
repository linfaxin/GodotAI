/** Integrity describes stored file bytes, before descriptor-level decoding.
 * Transport locations and authentication remain the host's responsibility. */
export type AssetIntegrity = Readonly<{
  sha256: string;
  bytes?: number;
  encoding?: 'gzip';
  decodedSha256?: string;
  decodedBytes?: number;
  maxDecodedBytes?: number;
}>;
export type StoredAsset = AssetIntegrity & Readonly<{path: string; bytes: number}>;
export type ReleaseInput = Readonly<{descriptorBytes: Uint8Array}>;
export type AssetReadLimits = Readonly<{maxStoredBytes: number; maxDecodedBytes: number}>;
export type RawAssetReader = (
  asset: StoredAsset,
  options: {signal?: AbortSignal; maxStoredBytes: number},
) => Promise<Uint8Array>;
export type ReleaseFacts = Readonly<{
  releaseId: string;
  descriptorSha256: string;
  engineProfile: string;
  engineId?: string;
  extensionId?: string;
  artifactReceiptVersion?: 2;
  artifactSetAbi?: 1;
}>;

const DEFAULT_ASSET_LIMIT = 128 * 1024 * 1024;
const digestPattern = /^[a-fA-F0-9]{64}$/;
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('E_RELEASE_ASSET_SIZE');
  return value;
}
function metadata(asset: AssetIntegrity): void {
  if (!asset || typeof asset.sha256 !== 'string' || !digestPattern.test(asset.sha256)) throw new Error('E_RELEASE_DIGEST');
  if (asset.bytes !== undefined && (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0)) throw new Error('E_RELEASE_ASSET_SIZE');
  if (asset.encoding !== undefined && asset.encoding !== 'gzip') throw new Error('E_RELEASE_ENCODING');
  if (asset.encoding === 'gzip') {
    if (typeof asset.decodedSha256 !== 'string' || !digestPattern.test(asset.decodedSha256)) throw new Error('E_RELEASE_DECODED_DIGEST');
  } else if (asset.decodedSha256 !== undefined || asset.decodedBytes !== undefined) throw new Error('E_RELEASE_ENCODING');
  for (const size of [asset.decodedBytes, asset.maxDecodedBytes]) {
    if (size !== undefined) limit(size);
  }
}
async function matches(bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') === expected.toLowerCase();
}
async function decodedBytes(stream: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    for (;;) {
      abort(signal);
      const next = await reader.read();
      abort(signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new Error('E_ASSET_DECODED_SIZE');
      chunks.push(new Uint8Array(next.value));
    }
  } catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Capture exact stored bytes before hashing. This has no path or IO policy:
 * callers may use bounded file, HTTP or cache readers in either host. */
export async function verifyAndDecodeAsset(
  input: Uint8Array,
  integrity: AssetIntegrity,
  options: AssetReadLimits & {signal?: AbortSignal},
): Promise<Uint8Array> {
  const {signal, maxStoredBytes, maxDecodedBytes} = options;
  const asset = {...integrity};
  abort(signal); metadata(asset);
  const max = limit(maxStoredBytes), decodedMax = Math.min(limit(maxDecodedBytes), limit(asset.maxDecodedBytes ?? DEFAULT_ASSET_LIMIT));
  if (!(input instanceof Uint8Array)) throw new Error('E_ASSET_BYTES');
  if (input.byteLength > max) throw new Error('E_ASSET_SIZE');
  if (asset.bytes !== undefined && input.byteLength !== asset.bytes) throw new Error('E_ASSET_LENGTH');
  if (asset.decodedBytes !== undefined && asset.decodedBytes > decodedMax) throw new Error('E_ASSET_DECODED_SIZE');
  let bytes = new Uint8Array(input);
  if (!await matches(bytes, asset.sha256)) throw new Error('E_ASSET_HASH');
  abort(signal);
  if (asset.encoding === 'gzip') {
    if (typeof DecompressionStream === 'undefined') throw new Error('E_ASSET_DECOMPRESSION_UNAVAILABLE');
    try {
      const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = await decodedBytes(stream, Math.min(decodedMax, asset.decodedBytes ?? decodedMax), signal);
    } catch (error) {
      abort(signal);
      if (error instanceof Error && error.message === 'E_ASSET_DECODED_SIZE') throw error;
      throw new Error('E_ASSET_DECOMPRESSION', {cause: error});
    }
    if (asset.decodedBytes !== undefined && bytes.byteLength !== asset.decodedBytes) throw new Error('E_ASSET_DECODED_LENGTH');
    if (!await matches(bytes, asset.decodedSha256!)) throw new Error('E_ASSET_DECODED_HASH');
  }
  abort(signal);
  return bytes;
}
