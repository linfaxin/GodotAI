import { loadRuntimeRelease, fetchReleaseFiles } from '../../scripts/jsb.react-browser/src/release.js';
import { createSnapshot } from '../../scripts/jsb.react-browser/src/snapshot.js';
import { createBrowserCompilerCore } from '../../scripts/jsb.react-browser/src/compiler-core.js';
import { createBuiltInResolver } from '../../scripts/jsb.react-browser/src/builtins.js';
import { libraries } from 'playground:builtins';
import type { TypeScriptRuntime, TypecheckInput, TypecheckResult } from '../../scripts/jsb.react-browser/src/typecheck.js';
import type { RuntimeRelease } from '../../scripts/jsb.react-browser/src/contracts.js';

let compiler: ReturnType<typeof createBrowserCompilerCore> | undefined;
let aborter: AbortController | undefined;
let latest = 0;
let typesWorker: Worker | undefined;
let requestId = 0;
const typeRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
const send = (value: unknown) => postMessage(value);
function cancelTypes(reason: Error) {
  typesWorker?.terminate(); typesWorker = undefined;
  for (const query of typeRequests.values()) { clearTimeout(query.timer); query.reject(reason); }
  typeRequests.clear();
}
function ensureTypesWorker() {
  if (typesWorker) return;
  typesWorker = new Worker(new URL('./types-worker.js', self.location.href), { type: 'module' });
  typesWorker.onmessage = ({ data }) => {
    const query = typeRequests.get(data.id); if (!query) return;
    typeRequests.delete(data.id); clearTimeout(query.timer);
    data.ok ? query.resolve(data.result) : query.reject(Error(data.error?.message ?? 'E_TYPES_WORKER'));
  };
  typesWorker.onerror = event => cancelTypes(Error(event.message));
}
function typeQuery(message: object): Promise<unknown> {
  ensureTypesWorker();
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => cancelTypes(Error('E_TYPES_TIMEOUT: TypeScript exceeded its worker deadline')), 60000);
    typeRequests.set(id, { resolve, reject, timer }); typesWorker!.postMessage({ id, ...message });
  });
}
const objectUrls: string[] = [];
function moduleUrl(bytes: Uint8Array): string { const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'text/javascript' })); objectUrls.push(url); return url; }
async function initialize(releaseUrl: string, expectedId?: string, expectedDescriptorSha256?: string) {
  const { release, baseUrl } = await loadRuntimeRelease(releaseUrl, { expectedId, expectedDescriptorSha256 });
  if (release.sdkVersion !== libraries.versions['@godot-js/react']) throw Error('E_BUILTIN_RELEASE: SDK version differs from the built-in catalog');
  const files = await fetchReleaseFiles(release, baseUrl, { progress: (loaded, total) => send({ type: 'progress', stage: 'loading-runtime', loaded, total }) });
  const get = (kind: string) => {
    const file = release.files.find(file => file.kind === kind);
    if (!file || !files.has(file.path)) throw Error(`E_COMPILER_ASSET: ${kind}`);
    return files.get(file.path)!;
  };
  const tsUrl = moduleUrl(get('typescript-module'));
  const ts = (await import(tsUrl)).default as TypeScriptRuntime;
  const esbuildSource = get('compiler-js');
  const api = (await import(moduleUrl(new TextEncoder().encode(new TextDecoder().decode(esbuildSource) + '\nexport default esbuild;\n')))).default;
  await api.initialize({ wasmModule: await WebAssembly.compile(get('compiler-wasm').slice().buffer), worker: false });
  if (typeof caches !== 'undefined') await caches.delete('godot-react-npm-v1').catch(() => {});
  const resolver = createBuiltInResolver(libraries);
  compiler = createBrowserCompilerCore({ bundler: api, typescript: ts, release, releaseFiles: files, ...resolver,
    check: input => typeQuery({ kind: 'load', input, typescriptUrl: tsUrl }) as Promise<TypecheckResult>,
    progress: stage => send({ type: 'progress', stage }),
  });
  send({ type: 'initialized', release });
}
self.onmessage = async ({ data }) => {
  const id = data.id;
  try {
    if (data.kind === 'init') { await initialize(data.releaseUrl, data.expectedId, data.expectedDescriptorSha256); send({ id, ok: true }); return; }
    if (data.kind === 'cancel') { ++latest; aborter?.abort(); if (typeRequests.size) cancelTypes(Error('E_BUILD_CANCELLED')); return; }
    if (data.kind === 'completion' || data.kind === 'hover') { send({ id, ok: true, result: await typeQuery({ kind: data.kind, file: data.file, offset: data.offset }) }); return; }
    if (!compiler) throw Error('E_COMPILER_NOT_READY');
    const serial = ++latest; aborter?.abort(); if (typeRequests.size) cancelTypes(Error('E_BUILD_CANCELLED'));
    const controller = new AbortController(); aborter = controller;
    const snapshot = await createSnapshot({ revision: data.revision, files: new Map(data.files), config: { ...data.config, dependencies: { ...libraries.versions } } });
    if (serial !== latest) throw Error('E_BUILD_CANCELLED');
    const result = data.kind === 'check' ? await compiler.check(snapshot, { signal: controller.signal }) : await compiler.build(snapshot, { signal: controller.signal });
    if (serial !== latest) throw Error('E_BUILD_CANCELLED');
    send({ id, ok: true, result });
  } catch (error) { send({ id, ok: false, error: { message: String(error), code: (error as { code?: string }).code, diagnostics: (error as { details?: unknown }).details } }); }
};
