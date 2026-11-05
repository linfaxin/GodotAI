import SparkMD5 from 'spark-md5';
import { BrowserBuildError } from './contracts.js';
import { canonicalPath } from './snapshot.js';

export interface PackOptions { formatVersion?: 3; engineVersion?: readonly [number, number, number]; maxBytes?: number; maxFiles?: number }
export interface PackResult { pack: Uint8Array; index: Readonly<Record<string, { offset: number; size: number }>> }
/** Godot PCK v3. Directory MD5 is a format requirement; artifact integrity uses SHA-256. */
export function packProject(input: ReadonlyMap<string, Uint8Array>, options: PackOptions = {}): PackResult {
  if (options.formatVersion !== undefined && options.formatVersion !== 3) throw new BrowserBuildError('E_PCK_VERSION', 'Only PCK v3 is implemented');
  if (input.size > (options.maxFiles ?? 10000)) throw new BrowserBuildError('E_PCK_BUDGET', 'PCK file count exceeds budget');
  const align = (n: number, to: number) => Math.ceil(n / to) * to;
  const encoder = new TextEncoder(), seen = new Set<string>();
  let cursor = 112;
  const entries = [...input].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([raw, bytes]) => {
    const name = canonicalPath(raw.startsWith('res://') ? raw.slice(6) : raw);
    if (seen.has(name.toLowerCase())) throw new BrowserBuildError('E_PCK_PATH', `Case-colliding PCK path ${name}`);
    seen.add(name.toLowerCase());
    if (!(bytes instanceof Uint8Array)) throw new BrowserBuildError('E_PCK_BYTES', `Expected binary bytes: ${name}`);
    const data = new Uint8Array(bytes), path = encoder.encode(name.slice(1)), offset = cursor;
    cursor = align(cursor + data.byteLength, 16);
    return { name, path, data, offset, md5: SparkMD5.ArrayBuffer.hash(data.buffer, true) };
  });
  const directoryOffset = cursor;
  const size = directoryOffset + 4 + entries.reduce((n, e) => n + 40 + align(e.path.byteLength, 4), 0);
  if (!Number.isSafeInteger(size) || size > (options.maxBytes ?? 64 * 1024 * 1024)) throw new BrowserBuildError('E_PCK_BUDGET', 'PCK byte size exceeds budget');
  const pack = new Uint8Array(size), view = new DataView(pack.buffer);
  const version = options.engineVersion ?? [4, 6, 1];
  if (version.length !== 3 || version.some(n => !Number.isSafeInteger(n) || n < 0)) throw new BrowserBuildError('E_PCK_VERSION', 'Invalid engine version');
  [0x43504447, 3, ...version, 2].forEach((n, i) => view.setUint32(i * 4, n, true));
  view.setBigUint64(24, 112n, true); view.setBigUint64(32, BigInt(directoryOffset), true);
  view.setUint32(cursor, entries.length, true); cursor += 4;
  const index: Record<string, { offset: number; size: number }> = Object.create(null);
  for (const entry of entries) {
    pack.set(entry.data, entry.offset);
    const length = align(entry.path.byteLength, 4);
    view.setUint32(cursor, length, true); cursor += 4;
    pack.set(entry.path, cursor); cursor += length;
    view.setBigUint64(cursor, BigInt(entry.offset - 112), true); cursor += 8;
    view.setBigUint64(cursor, BigInt(entry.data.byteLength), true); cursor += 8;
    for (let i = 0; i < 16; i++) pack[cursor++] = entry.md5.charCodeAt(i);
    view.setUint32(cursor, 0, true); cursor += 4;
    index['res://' + entry.name.slice(1)] = Object.freeze({ offset: entry.offset, size: entry.data.byteLength });
  }
  return { pack, index: Object.freeze(index) };
}
