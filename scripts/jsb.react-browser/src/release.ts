import { BrowserBuildError, type RuntimeRelease } from './contracts.js';
import { fetchVerifiedAsset } from './verified-loader.js';
import { sha256, canonicalJson } from './snapshot.js';

export async function loadRuntimeRelease(url: string, options: { expectedId?: string; expectedDescriptorSha256?: string; signal?: AbortSignal } = {}): Promise<{ release: RuntimeRelease; baseUrl: string }> {
  const response = await fetch(url, { signal: options.signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new BrowserBuildError('E_RELEASE_HTTP', `Cannot load runtime release (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (options.expectedDescriptorSha256 && await sha256(bytes) !== options.expectedDescriptorSha256) throw new BrowserBuildError('E_RELEASE_DESCRIPTOR_HASH', 'Runtime descriptor differs from the application-pinned bytes');
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.files) || !/^[a-f0-9]{64}$/.test(raw.id)) throw new BrowserBuildError('E_RELEASE_DESCRIPTOR', 'Malformed runtime release');
  if (options.expectedId && options.expectedId !== raw.id) throw new BrowserBuildError('E_RELEASE_ID', 'Runtime descriptor differs from the application-pinned release');
  // The publisher excludes these identity/evidence fields when computing the content ID.
  const identity = { ...raw }; delete identity.id; delete identity.runtimeRelease; delete identity.certified; delete identity.certification;
  const actual = await sha256(canonicalJson(identity));
  if (actual !== raw.id) throw new BrowserBuildError('E_RELEASE_ID', 'Runtime descriptor content identity is invalid');
  const seen = new Set<string>();
  for (const file of raw.files) {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some((part: string) => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw new BrowserBuildError('E_RELEASE_FILE', 'Invalid runtime asset');
    seen.add(file.path);
  }
  const profiles = Array.isArray(raw.profiles) ? Object.fromEntries(raw.profiles.map((profile: { id: string }) => [profile.id, profile])) : raw.profiles;
  return { baseUrl: response.url, release: { ...raw, profiles, engine: { ...raw.engine, engine: 'web', engineTarget: raw.engine.target ?? raw.engine.engineTarget } } };
}
export async function fetchReleaseFiles(release: RuntimeRelease, baseUrl: string, options: { signal?: AbortSignal; includeEngine?: boolean; progress?: (loaded: number, total: number) => void } = {}): Promise<Map<string, Uint8Array>> {
  const files = release.files.filter(file => options.includeEngine || !file.kind.startsWith('engine-'));
  const output = new Map<string, Uint8Array>();
  let next = 0, loaded = 0;
  const cache = typeof caches !== 'undefined' ? await caches.open('godot-react-release-v1').catch(() => undefined) : undefined;
  const load = async () => {
    while (next < files.length) {
      const file = files[next++]; options.signal?.throwIfAborted();
      const url = new URL(file.url ?? file.path, baseUrl).href;
      const key = new URL('./__cache__/' + file.sha256, baseUrl).href;
      const cached = await cache?.match(key);
      let bytes: Uint8Array | undefined = cached ? new Uint8Array(await cached.arrayBuffer()) : undefined;
      if (bytes && await sha256(bytes) !== file.sha256) { await cache?.delete(key); bytes = undefined; }
      if (!bytes) {
        bytes = await fetchVerifiedAsset({ url, sha256: file.sha256 }, { signal: options.signal, maxBytes: 64 * 1024 * 1024 });
        await cache?.put(key, new Response(new Uint8Array(bytes).buffer)).catch(() => {});
      }
      output.set(file.path, bytes); options.progress?.(++loaded, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, load));
  return output;
}
