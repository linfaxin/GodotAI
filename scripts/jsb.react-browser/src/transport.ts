import semver from "semver";

export interface FetchOptions { signal?: AbortSignal }
export type FetchFile = (url: string, options?: FetchOptions) => Promise<Uint8Array>;
export type ResolveVersion = (name: string, range: string, options?: FetchOptions) => Promise<string>;

export class TransportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(`${code}: ${message}`); this.name = "TransportError";
  }
}

export function npmFileUrl(name: string, version: string, path: string, base = "https://cdn.jsdelivr.net/npm/"): string {
  return `${base.replace(/\/?$/, "/")}${name}@${version}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Raw npm files only: the resolver never consumes a CDN's rewritten +esm output. */
export function createJsDelivrTransport(options: {
  fetch?: typeof globalThis.fetch;
  metadataBase?: string;
  maxFileBytes?: number;
} = {}): { fetchFile: FetchFile; resolveVersion: ResolveVersion } {
  const request = options.fetch ?? globalThis.fetch;
  if (!request) throw new TransportError("E_FETCH_UNAVAILABLE", "A Fetch implementation is required");
  const fetchFile: FetchFile = async (url, init = {}) => {
    const response = await request(url, { signal: init.signal, redirect: "error" });
    if (!response.ok) throw new TransportError(response.status === 404 ? "E_FILE_NOT_FOUND" : "E_FETCH", `${url}: HTTP ${response.status}`, response.status);
    const limit = options.maxFileBytes ?? 16 * 1024 * 1024;
    const announced = Number(response.headers.get("content-length"));
    if (announced > limit) throw new TransportError("E_FILE_BUDGET", `${url} exceeds ${limit} bytes`);
    // Stream limits prevent a missing/untrusted Content-Length from bypassing the budget.
    if (response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new TransportError("E_FILE_BUDGET", `${url} exceeds ${limit} bytes`); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new TransportError("E_FILE_BUDGET", `${url} exceeds ${limit} bytes`);
    return bytes;
  };
  const resolveVersion: ResolveVersion = async (name, range, init) => {
    const base = options.metadataBase ?? "https://data.jsdelivr.com/v1/package/resolve/npm/";
    const bytes = await fetchFile(`${base}${name}@${encodeURIComponent(range)}`, init);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TransportError("E_VERSION_METADATA", `Invalid version metadata for ${name}@${range}`); }
    const version = (value as { version?: unknown })?.version;
    if (typeof version !== "string" || !semver.valid(version) || !semver.satisfies(version, range))
      throw new TransportError("E_VERSION_NOT_FOUND", `No version satisfies ${name}@${range}`);
    return version;
  };
  return { fetchFile, resolveVersion };
}

/** Deterministic, network-free transport. Keys may be full URLs or name@version/path. */
export function createFixtureTransport(
  fixtures: Readonly<Record<string, string | Uint8Array>>,
  versions: Readonly<Record<string, readonly string[] | string>> = {},
): { fetchFile: FetchFile; resolveVersion: ResolveVersion; requests: string[]; versionRequests: string[] } {
  const requests: string[] = [], versionRequests: string[] = [];
  const fetchFile: FetchFile = async (url, options) => {
    options?.signal?.throwIfAborted(); requests.push(url);
    const key = decodeURIComponent(url.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, ""));
    const value = fixtures[url] ?? fixtures[key];
    if (value === undefined) throw new TransportError("E_FILE_NOT_FOUND", `Fixture not found: ${key}`, 404);
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  };
  const resolveVersion: ResolveVersion = async (name, range, options) => {
    options?.signal?.throwIfAborted(); versionRequests.push(`${name}@${range}`);
    const declared = versions[name];
    const available = declared === undefined
      ? Object.keys(fixtures).flatMap(key => {
          const prefix = `${name}@`; if (!key.startsWith(prefix)) return [];
          const version = key.slice(prefix.length).split("/")[0]; return semver.valid(version) ? [version] : [];
        })
      : typeof declared === "string" ? [declared] : [...declared];
    const version = semver.maxSatisfying(available, range);
    if (!version) throw new TransportError("E_VERSION_NOT_FOUND", `No fixture version satisfies ${name}@${range}`);
    return version;
  };
  return { fetchFile, resolveVersion, requests, versionRequests };
}
