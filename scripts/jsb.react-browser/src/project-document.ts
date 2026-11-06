import { BrowserBuildError, type BrowserProjectConfig } from './contracts.js';
import { canonicalPath, createSnapshot } from './snapshot.js';

export interface EditorProject {
  config: BrowserProjectConfig;
  files: Record<string, string | number[]>;
  lock?: unknown;
  selected: string;
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function invalid(message: string): never { throw new BrowserBuildError('E_PROJECT_DOCUMENT', message); }
/** Validate serialized binary arrays before constructing any typed array. */
export async function parseEditorProject(value: unknown, options: { maxFiles?: number; maxBytes?: number } = {}): Promise<EditorProject> {
  if (!plain(value) || !plain(value.config) || !plain(value.files)) invalid('Expected project configuration and a file record');
  const entries = Object.entries(value.files), maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!entries.length || entries.length > (options.maxFiles ?? 1000)) invalid('Project file count exceeds the budget');
  let total = 0;
  const files: EditorProject['files'] = {}, sources = new Map<string, string | Uint8Array>();
  // This pass makes no allocation proportional to an unvalidated binary length.
  for (const [name, contents] of entries) {
    canonicalPath(name);
    if (typeof contents === 'string') {
      if (contents.length > maxBytes - total) invalid('Project exceeds the byte budget');
      // UTF-8 allocation is bounded by three times the checked string length.
      total += new TextEncoder().encode(contents).byteLength;
    } else {
      if (!Array.isArray(contents) || contents.length > maxBytes - total) invalid('Binary files must be bounded byte arrays');
      for (const byte of contents) if (!Number.isInteger(byte) || byte < 0 || byte > 255) invalid('Binary files must contain integer bytes');
      total += contents.length;
    }
    if (total > maxBytes) invalid('Project exceeds the byte budget');
  }
  for (const [name, contents] of entries) {
    const path = canonicalPath(name);
    if (Object.hasOwn(files, path)) invalid('File paths collide after normalization');
    files[path] = contents as string | number[];
    sources.set(path, typeof contents === 'string' ? contents : new Uint8Array(contents as number[]));
  }
  const snapshot = await createSnapshot({ revision: 'import', files: sources, config: value.config as unknown as BrowserProjectConfig, lock: value.lock, ...options });
  const selected = typeof value.selected === 'string' ? canonicalPath(value.selected) : snapshot.config.entry;
  return structuredClone({ config: snapshot.config, files, ...(value.lock === undefined ? {} : { lock: snapshot.lock }), selected: Object.hasOwn(files, selected) ? selected : snapshot.config.entry });
}
