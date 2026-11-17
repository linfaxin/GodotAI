/** Private build-local byte ownership. Public reads never expose stored buffers. */
const owned = new WeakSet<Uint8Array>();
const maps = new WeakMap<object, ReadonlyMap<string, Uint8Array>>();
const digests = new WeakMap<Uint8Array, Promise<string>>();
const metrics = {bytesCopied: 0, bytesHashed: 0};
export function ownedByteMetrics(): Readonly<typeof metrics> { return {...metrics}; }

/** Internal fast path: no public aliases can change bytes during this await. */
export async function hashOwnedBytes(bytes: Uint8Array): Promise<string> {
  const previous=owned.has(bytes)&&digests.get(bytes);if(previous)return previous;
  metrics.bytesHashed+=bytes.byteLength;
  const pending=globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>).then(value=>Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''));
  if(owned.has(bytes))digests.set(bytes,pending);
  return pending;
}

export function captureBytes(value: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(value);
  metrics.bytesCopied+=bytes.byteLength;
  owned.add(bytes);
  return bytes;
}

/** Only callers inside this package can retain a known-owned buffer. */
export function retainBytes(value: Uint8Array): Uint8Array {
  return owned.has(value) ? value : captureBytes(value);
}

export function adoptBytes(value: Uint8Array): Uint8Array {
  owned.add(value);
  return value;
}

/** Adopt package-owned values; capture any values coming from public callers. */
export function byteMap(input: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  const existing = maps.get(input);
  if (existing) return input;
  const values = new Map([...input].map(([path, bytes]) => [path, retainBytes(bytes)]));
  const view: ReadonlyMap<string, Uint8Array> = Object.freeze({
    get size() { return values.size; },
    has: (path: string) => values.has(path),
    get: (path: string) => { const bytes = values.get(path); return bytes && new Uint8Array(bytes); },
    keys: () => values.keys(),
    *values(): Generator<Uint8Array, undefined, unknown> { for (const bytes of values.values()) yield new Uint8Array(bytes); return undefined; },
    *entries(): Generator<[string, Uint8Array], undefined, unknown> { for (const [path, bytes] of values) yield [path, new Uint8Array(bytes)] as [string, Uint8Array]; return undefined; },
    *[Symbol.iterator](): Generator<[string, Uint8Array], undefined, unknown> { for (const [path, bytes] of values) yield [path, new Uint8Array(bytes)] as [string, Uint8Array]; return undefined; },
    forEach(callback: (value: Uint8Array, key: string, map: ReadonlyMap<string, Uint8Array>) => void, thisArg?: unknown) {
      for (const [path, bytes] of values) callback.call(thisArg, new Uint8Array(bytes), path, view);
    },
  });
  maps.set(view, values);
  return view;
}

/** Trusted package code only. Unrecognized public maps are captured first. */
export function borrowByteMap(input: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  const known = maps.get(input);
  if (known) return known;
  const captured = byteMap(input);
  return maps.get(captured)!;
}

/** Inspect metadata without first copying an oversized untrusted input. */
export function knownByteMap(input: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> | undefined {
  return maps.get(input);
}
