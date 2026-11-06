import { BrowserBuildError, type BrowserProjectConfig, type ProjectSnapshot } from './contracts.js';

export const utf8 = new TextEncoder();
export const text = new TextDecoder('utf-8', { fatal: true });
export const COMPILER_VERSION = 'godot-react-browser/0.1.0';
function freezeJson<T>(value: T, depth = 0): T {
  if (depth > 30) throw new BrowserBuildError('E_PROJECT_CONFIG', 'JSON configuration is nested too deeply');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new BrowserBuildError('E_PROJECT_CONFIG', 'Configuration must contain only finite JSON values');
  for (const child of Object.values(value)) freezeJson(child, depth + 1);
  return Object.freeze(value);
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8.encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function canonicalPath(path: string): string {
  if (typeof path !== 'string' || path.includes('\\') || /[\x00-\x1f\x7f?#:%]/.test(path)) throw new BrowserBuildError('E_PROJECT_PATH', `Invalid path ${JSON.stringify(path)}`);
  const normalized = '/' + path.replace(/^\/+/, '');
  if (normalized === '/' || normalized.split('/').slice(1).some(part => !part || part === '.' || part === '..') || path.trim() !== path) throw new BrowserBuildError('E_PROJECT_PATH', `Invalid path ${JSON.stringify(path)}`);
  return normalized;
}
export function isReservedPath(path: string): boolean {
  return /^\/(?:\.godot|node_modules|generated|typescript)(?:\/|$)/.test(path) || path === '/project.godot';
}
export function selectMainEntry(config: BrowserProjectConfig): string {
  if (!config.entries) return 'app';
  const candidates = Object.entries(config.entries).filter(([, entry]) => entry.module === config.entry);
  if (candidates.length !== 1) throw new BrowserBuildError('E_ENTRY', 'config.entry must identify exactly one configured entry module');
  return candidates[0][0];
}
export async function createSnapshot(input: {
  revision: string | number;
  files: ReadonlyMap<string, string | Uint8Array> | Record<string, string | Uint8Array>;
  config: BrowserProjectConfig;
  lock?: unknown;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<ProjectSnapshot> {
  const entries = typeof (input.files as ReadonlyMap<string, string | Uint8Array>)[Symbol.iterator] === 'function'
    ? [...input.files as ReadonlyMap<string, string | Uint8Array>]
    : Object.entries(input.files);
  if (!entries.length || entries.length > (input.maxFiles ?? 1000)) throw new BrowserBuildError('E_PROJECT_BUDGET', 'Project file count is outside the configured budget');
  const files = new Map<string, Uint8Array>(), folded = new Set<string>();
  let total = 0;
  for (const [name, contents] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const path = canonicalPath(name);
    if (isReservedPath(path) || files.has(path) || folded.has(path.toLowerCase())) throw new BrowserBuildError('E_PROJECT_PATH', `Reserved or colliding path ${path}`);
    if (typeof contents !== 'string' && !(contents instanceof Uint8Array)) throw new BrowserBuildError('E_PROJECT_FILE', `Expected text or Uint8Array at ${path}`);
    if ((typeof contents === 'string' ? contents.length : contents.byteLength) > (input.maxBytes ?? 16 * 1024 * 1024) - total) throw new BrowserBuildError('E_PROJECT_BUDGET', 'Project exceeds the configured byte budget');
    const bytes = typeof contents === 'string' ? utf8.encode(contents) : new Uint8Array(contents);
    total += bytes.byteLength;
    if (total > (input.maxBytes ?? 16 * 1024 * 1024)) throw new BrowserBuildError('E_PROJECT_BUDGET', 'Project exceeds the configured byte budget');
    files.set(path, bytes); folded.add(path.toLowerCase());
  }
  const config = structuredClone(input.config);
  if (config.schemaVersion !== 1 || !['development', 'production'].includes(config.mode) || typeof config.profileId !== 'string') throw new BrowserBuildError('E_PROJECT_CONFIG', 'Invalid browser project configuration');
  config.entry = canonicalPath(config.entry);
  if (config.entries) config.entries = Object.fromEntries(Object.entries(config.entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entry]) => [id, { ...entry, module: canonicalPath(entry.module) }]));
  if (!files.has(config.entry)) throw new BrowserBuildError('E_ENTRY', `Entry does not exist: ${config.entry}`);
  for (const [id, entry] of Object.entries(config.entries ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !files.has(entry.module)) throw new BrowserBuildError('E_ENTRY', `Invalid entry ${id}`);
  }
  selectMainEntry(config);
  for (const [name, version] of Object.entries(config.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new BrowserBuildError('E_DEPENDENCY_VERSION', `${name} requires an exact npm version`);
  }
  const hashes = Object.fromEntries(await Promise.all([...files].map(async ([name, bytes]) => [name, await sha256(bytes)])));
  freezeJson(config);
  const sourceHash = await sha256(canonicalJson({ config, files: hashes }));
  // Accessors return copies so ReadonlyMap does not accidentally expose mutable source bytes.
  const owned: ReadonlyMap<string, Uint8Array> = {
    get size() { return files.size; },
    has: name => files.has(name), get: name => { const bytes = files.get(name); return bytes && new Uint8Array(bytes); },
    *entries() { for (const [name, bytes] of files) yield [name, new Uint8Array(bytes)] as [string, Uint8Array]; return undefined; },
    *values() { for (const bytes of files.values()) yield new Uint8Array(bytes); return undefined; },
    keys: () => files.keys(),
    *[Symbol.iterator]() { for (const [name, bytes] of files) yield [name, new Uint8Array(bytes)] as [string, Uint8Array]; return undefined; },
    forEach(callback, thisArg) { for (const [name, bytes] of files) callback.call(thisArg, new Uint8Array(bytes), name, owned); },
  };
  return Object.freeze({ revision: String(input.revision), sourceHash, files: Object.freeze(owned), config: freezeJson(config), ...(input.lock === undefined ? {} : { lock: freezeJson(structuredClone(input.lock)) }) });
}
export async function buildKey(identity: import('./contracts.js').BuildIdentity): Promise<string> { return sha256(canonicalJson(identity)); }
