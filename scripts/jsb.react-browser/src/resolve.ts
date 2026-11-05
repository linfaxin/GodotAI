import type * as TypeScript from "typescript";
import semver from "semver";
import { npmFileUrl, type FetchFile, type ResolveVersion } from "./transport.js";

export interface ResolverPolicy {
  id?: string;
  conditions?: readonly string[];
  mainFields?: readonly string[];
  cdnBase?: string;
}
export interface ResolverBudgets { maxFiles?: number; maxRequests?: number; maxBytes?: number; maxFileBytes?: number; maxPackages?: number }
export interface ResolverSnapshot {
  revision: string;
  files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;
  config: { entry: string; entries?: Readonly<Record<string, string | { module?: string; source?: string; path?: string; file?: string }>>; dependencies: Readonly<Record<string, string>>; mode?: string };
  sourceHash: string;
  lock?: unknown;
}
export interface ResolverRelease {
  id?: string;
  specifiers?: Readonly<Record<string, string>>;
  react?: Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  sdkPackageRoot?: string;
  typesRoot?: string;
  libRoot?: string;
}
export interface PackageMetadata {
  name?: string; version?: string; type?: string; main?: string; module?: string; types?: string; typings?: string;
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: unknown; imports?: unknown; typesVersions?: unknown; browser?: unknown;
}
export interface PackageInstance {
  id: string; name: string; version: string; root: string;
  peerBindings: Record<string, string>; dependencies: Record<string, string>; metadata: PackageMetadata;
}
export interface GraphNode { id: string; path: string; instanceId?: string; hash: string; format: "esm" | "cjs" | "json" | "declaration" }
export interface GraphEdge { importer: string; specifier: string; mode: "import" | "require"; resolved: string; external?: boolean; runtimeInstanceId?: string; typeInstanceId?: string }
export interface UnresolvedType { importer: string; specifier: string; code: string; message: string }
export interface ModuleGraph { entries: string[]; nodes: Record<string, GraphNode>; edges: GraphEdge[]; unresolved: UnresolvedType[] }
export interface DependencyLock {
  version: 1; policyId: string;
  requests: Record<string, string>;
  instances: Record<string, { name: string; version: string; peerBindings: Record<string, string>; dependencies: Record<string, string> }>;
  files: Record<string, { sha256: string; size: number }>;
  missing: string[];
}
export interface ResolvedProject {
  instances: Record<string, PackageInstance>; runtimeGraph: ModuleGraph; typeGraph: ModuleGraph;
  lock: DependencyLock; hash: string; files: Record<string, Uint8Array>;
}
export class ResolverError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "ResolverError"; }
}
const decoder = new TextDecoder();
const encoder = new TextEncoder();
// Prefix-only builtins such as node:test are caught by node: below; the bare
// npm package name "test" must remain available to ordinary package resolution.
const nodeBuiltins = new Set(("assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https inspector inspector/promises module net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises repl stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 vm wasi worker_threads zlib").split(" "));
const runtimeSingletons = new Set(["react", "scheduler", "react-reconciler", "@godot-js/react"]);
const declarationPattern = /\.d\.[cm]?ts$/;
function fail(code: string, message: string): never { throw new ResolverError(code, message); }
const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer))].map(value => value.toString(16).padStart(2, "0")).join("");
}
function cleanPath(value: string): string {
  if (/[\\\0?#]/.test(value)) fail("E_VFS_PATH", `Unsupported path ${JSON.stringify(value)}`);
  const parts: string[] = [];
  for (const part of value.replace(/^res:\/\//, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) fail("E_VFS_PATH", `Path escapes its root: ${value}`); parts.pop(); }
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
function projectPath(value: string): string {
  return cleanPath(value.startsWith("/") || value.startsWith("res://") || value.startsWith("src/") || value.startsWith("node_modules/") ? value : `/src/${value}`);
}
const dirname = (value: string): string => value.slice(0, value.lastIndexOf("/")) || "/";
function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name === "." || name === "..") fail("E_PACKAGE_SPECIFIER", `Unsupported npm specifier ${specifier}`);
  const rest = parts.slice(name.startsWith("@") ? 2 : 1);
  if (rest.some(part => !part || part === "." || part === ".." || /[\\%?#:]/.test(part))) fail("E_PACKAGE_SPECIFIER", `Invalid npm subpath ${specifier}`);
  return { name, subpath: rest.length ? `./${rest.join("/")}` : "." };
}
interface ImportReference { specifier: string; mode: "import" | "require"; runtime: boolean; type: boolean }
function scanImports(ts: typeof TypeScript, path: string, source: string): ImportReference[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const references: ImportReference[] = [];
  const add = (value: string, mode: "import" | "require", runtime: boolean, type = true) => references.push({ specifier: value, mode, runtime, type });
  const hasName = (name: TypeScript.BindingName | undefined): boolean => !!name && (ts.isIdentifier(name) ? name.text === "require" : name.elements.some(item => ts.isBindingElement(item) && hasName(item.name)));
  function shadowed(node: TypeScript.Node): boolean {
    for (let scope: TypeScript.Node | undefined = node.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => hasName(parameter.name))) return true;
      if (ts.isSourceFile(scope) || ts.isBlock(scope)) for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === "require" && !(ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Ambient)) return true;
        if (ts.isVariableStatement(statement) && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) && statement.declarationList.declarations.some(declaration => hasName(declaration.name))) return true;
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const clause = statement.importClause;
          if (clause.name?.text === "require") return true;
          if (clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text === "require" : clause.namedBindings.elements.some(element => element.name.text === "require"))) return true;
        }
      }
    }
    return false;
  }
  function visit(node: TypeScript.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const onlyTypes = clause?.isTypeOnly || !!(clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.length && clause.namedBindings.elements.every(element => element.isTypeOnly));
      add(node.moduleSpecifier.text, "import", !onlyTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes = node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(element => element.isTypeOnly));
      add(node.moduleSpecifier.text, "import", !onlyTypes);
    }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) add(node.moduleReference.expression.text, "require", !node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, "import", false);
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0].text, "import", true);
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && !shadowed(node)) add(node.arguments[0].text, "require", true);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  for (const reference of sourceFile.referencedFiles) add(reference.fileName.startsWith(".") ? reference.fileName : `./${reference.fileName}`, "import", false);
  for (const reference of sourceFile.typeReferenceDirectives) add(reference.fileName, "import", false);
  return references.filter((item, index) => references.findIndex(other => other.specifier === item.specifier && other.mode === item.mode && other.runtime === item.runtime) === index);
}

export function createResolver(options: {
  fetchFile: FetchFile; resolveVersion?: ResolveVersion;
  typescript?: typeof TypeScript; policy?: ResolverPolicy; budgets?: ResolverBudgets;
}) {
  const ts = options.typescript ?? (globalThis as typeof globalThis & { ts?: typeof TypeScript }).ts;
  const policy = { conditions: [] as readonly string[], mainFields: ["main", "module"] as readonly string[], cdnBase: "https://cdn.jsdelivr.net/npm/", ...options.policy };
  const limits = { maxFiles: 2000, maxRequests: 8000, maxBytes: 32 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxPackages: 200, ...options.budgets };

  return { async resolveProject(snapshot: ResolverSnapshot, release: ResolverRelease, init: { signal?: AbortSignal } = {}): Promise<ResolvedProject> {
    if (!ts) fail("E_TYPESCRIPT_REQUIRED", "Pass createResolver({typescript}) or load the browser TypeScript API first");
    const signal = init.signal;
    const abort = () => signal?.throwIfAborted();
    const policyId = policy.id ?? `godot-neutral-v1:${await sha256(encoder.encode(canonical({ conditions: policy.conditions, mainFields: policy.mainFields, cdnBase: policy.cdnBase })))}`;
    const replay = snapshot.lock as DependencyLock | undefined;
    if (snapshot.lock !== undefined) {
      const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
      if (!record(replay) || !record(replay.requests) || !record(replay.instances) || !record(replay.files) || !Array.isArray(replay.missing)) fail("E_LOCK_FORMAT", "Dependency lock must contain request, instance, file and missing-file records");
      if (Object.keys(replay.files).length > limits.maxFiles || Object.keys(replay.instances).length > limits.maxPackages || Object.keys(replay.requests).length > limits.maxRequests || replay.missing.length > limits.maxRequests) fail("E_LOCK_BUDGET", "Dependency lock exceeds resolver budgets");
      for (const version of Object.values(replay.requests)) if (typeof version !== "string" || !semver.valid(version) || version !== semver.valid(version)) fail("E_LOCK_FORMAT", "Locked requests must contain normalized exact versions");
      for (const file of Object.values(replay.files)) if (!record(file) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > limits.maxFileBytes) fail("E_LOCK_FORMAT", "Locked files require a SHA-256 digest and bounded integer byte size");
      for (const instance of Object.values(replay.instances)) {
        if (!record(instance) || typeof instance.name !== "string" || typeof instance.version !== "string" || !semver.valid(instance.version) || !record(instance.peerBindings) || !record(instance.dependencies)) fail("E_LOCK_FORMAT", "Malformed package instance in dependency lock");
        if (Object.values(instance.peerBindings).some(value => typeof value !== "string") || Object.values(instance.dependencies).some(value => typeof value !== "string")) fail("E_LOCK_FORMAT", "Instance and peer bindings must be strings");
      }
      if (replay.missing.some(url => typeof url !== "string") || new Set(replay.missing).size !== replay.missing.length || replay.missing.some(url => Object.hasOwn(replay.files, url))) fail("E_LOCK_FORMAT", "Missing-file records must be unique and disjoint from locked files");
    }
    if (replay && (replay.version !== 1 || replay.policyId !== policyId)) fail("E_LOCK_POLICY", "Lock version or resolver policy does not match");
    const lock: DependencyLock = { version: 1, policyId, requests: {}, instances: {}, files: {}, missing: [] };
    const missing = new Set<string>();
    const files: Record<string, Uint8Array> = {}, fetched = new Map<string, Promise<Uint8Array | undefined>>();
    const sourceEntries = typeof (snapshot.files as ReadonlyMap<string, Uint8Array>)[Symbol.iterator] === "function" ? (snapshot.files as ReadonlyMap<string, Uint8Array>).entries() : Object.entries(snapshot.files);
    const folded = new Map<string, string>();
    for (const [name, bytes] of sourceEntries) {
      const path = projectPath(name), prior = folded.get(path.toLowerCase());
      if (prior && prior !== path) fail("E_CASE_COLLISION", `${prior} and ${path}`);
      if (files[path]) fail("E_VFS_PATH", `Multiple snapshot inputs resolve to ${path}`);
      folded.set(path.toLowerCase(), path); files[path] = bytes.slice();
    }
    const instances: Record<string, PackageInstance> = {}, instancePromises = new Map<string, Promise<PackageInstance>>();
    const metadataCache = new Map<string, Promise<PackageMetadata>>();
    const runtimeGraph: ModuleGraph = { entries: [], nodes: {}, edges: [], unresolved: [] };
    const typeGraph: ModuleGraph = { entries: [], nodes: {}, edges: [], unresolved: [] };
    const visited = new Set<string>(); let requestCount = 0, fetchedCount = 0, byteCount = 0;
    const roots = { ...snapshot.config.dependencies };
    const certified: Record<string, string> = { ...release.dependencies, ...release.react };
    if (release.react?.reconciler) certified["react-reconciler"] = release.react.reconciler;
    for (const [name, range] of Object.entries(roots)) {
      if (!semver.valid(range) || range !== semver.valid(range)) fail("E_DIRECT_VERSION", `Direct dependency ${name} requires an exact normalized npm version, received ${range}`);
      if (runtimeSingletons.has(name) && certified[name] && range !== certified[name]) fail("E_REACT_SINGLETON", `${name}@${range} conflicts with certified ${certified[name]}`);
    }
    async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
      abort();
      let pending = fetched.get(url);
      if (!pending) {
        pending = (async () => {
          if (++requestCount > limits.maxRequests) fail("E_REQUEST_BUDGET", `More than ${limits.maxRequests} npm requests`);
          if (replay?.missing?.includes(url)) { missing.add(url); return undefined; }
          const expected = replay?.files[url];
          if (replay && !expected) fail("E_LOCK_MISS", `File is not recorded in the lock: ${url}`);
          let bytes: Uint8Array;
          try { bytes = (await options.fetchFile(url, { signal })).slice(); }
          catch (error) {
            const failure = error as { code?: string; status?: number };
            if (failure.code === "E_FILE_NOT_FOUND" || failure.status === 404) {
              if (expected) fail("E_LOCK_CONTENT", `Locked file is missing: ${url}`);
              missing.add(url); return undefined;
            }
            throw error;
          }
          abort();
          if (bytes.byteLength > limits.maxFileBytes) fail("E_FILE_BUDGET", `${url} exceeds ${limits.maxFileBytes} bytes`);
          byteCount += bytes.byteLength;
          if (++fetchedCount > limits.maxFiles || byteCount > limits.maxBytes) fail("E_FETCH_BUDGET", "Resolved dependency graph exceeds the configured byte/file budget");
          const digest = await sha256(bytes);
          if (expected && (expected.sha256 !== digest || expected.size !== bytes.byteLength)) fail("E_LOCK_CONTENT", `SHA-256/size mismatch for ${url}`);
          lock.files[url] = { sha256: digest, size: bytes.byteLength };
          return bytes;
        })();
        fetched.set(url, pending);
      }
      return pending;
    }
    async function readMetadata(name: string, version: string): Promise<PackageMetadata> {
      const key = `${name}@${version}`;
      let pending = metadataCache.get(key);
      if (!pending) {
        pending = (async () => {
          const bytes = await fetchBytes(npmFileUrl(name, version, "package.json", policy.cdnBase));
          if (!bytes) fail("E_PACKAGE_METADATA", `Missing package.json for ${key}`);
          let value: PackageMetadata;
          try { value = JSON.parse(decoder.decode(bytes)); } catch { return fail("E_PACKAGE_METADATA", `Invalid package.json for ${key}`); }
          if (!value || typeof value !== "object" || (value.name && value.name !== name) || (value.version && value.version !== version)) fail("E_PACKAGE_METADATA", `Package identity mismatch for ${key}`);
          return value;
        })();
        metadataCache.set(key, pending);
      }
      return pending;
    }
    async function chooseVersion(name: string, range: string, requester: string): Promise<string> {
      const key = `${requester}|${name}|${range}`;
      const locked = replay?.requests[key];
      if (replay && !locked) fail("E_LOCK_MISS", `Unrecorded dependency request ${key}`);
      let version: string;
      if (locked) version = locked;
      else if (semver.valid(range)) version = range;
      else {
        if (!semver.validRange(range)) fail("E_DEPENDENCY_RANGE", `Unsupported dependency source ${name}@${range}`);
        if (!options.resolveVersion) fail("E_VERSION_RESOLVER", `A version resolver is required for ${name}@${range}`);
        abort(); version = await options.resolveVersion(name, range, { signal }); abort();
      }
      if (!semver.valid(version) || !semver.satisfies(version, range)) fail("E_LOCK_VERSION", `${version} does not satisfy ${name}@${range}`);
      lock.requests[key] = version; return version;
    }
    async function packageInstance(name: string, range: string, parent?: PackageInstance): Promise<PackageInstance> {
      const requester = parent?.id ?? "$project";
      const version = await chooseVersion(name, range, requester);
      const metadata = await readMetadata(name, version);
      const peers: Record<string, string> = {};
      for (const [peer, requirement] of Object.entries(metadata.peerDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        let boundVersion: string | undefined;
        if (runtimeSingletons.has(peer) && certified[peer]) boundVersion = certified[peer];
        else {
          const parentRange = parent?.metadata.dependencies?.[peer] ?? parent?.metadata.optionalDependencies?.[peer] ?? roots[peer];
          const inherited = parent?.peerBindings[peer];
          if (parentRange) boundVersion = await chooseVersion(peer, parentRange, requester);
          else if (inherited) boundVersion = inherited.slice(inherited.lastIndexOf("@") + 1);
        }
        if (!boundVersion) {
          if (metadata.peerDependenciesMeta?.[peer]?.optional) continue;
          fail("E_PEER_MISSING", `${name}@${version} requires peer ${peer}@${requirement}; importer ${requester} has no binding`);
        }
        if (!semver.validRange(requirement) || !semver.satisfies(boundVersion, requirement)) fail(runtimeSingletons.has(peer) ? "E_REACT_SINGLETON" : "E_PEER_CONFLICT", `${name}@${version} requires ${peer}@${requirement}, found ${boundVersion} at ${requester}`);
        peers[peer] = `${peer}@${boundVersion}`;
      }
      const peerKey = Object.keys(peers).length ? `_${(await sha256(encoder.encode(canonical(peers)))).slice(0, 16)}` : "";
      const id = `${name.replace(/\//g, "+")}@${version}${peerKey}`;
      let pending = instancePromises.get(id);
      if (!pending) {
        pending = (async () => {
          if (Object.keys(instances).length >= limits.maxPackages) fail("E_PACKAGE_BUDGET", `More than ${limits.maxPackages} package instances`);
          const instance: PackageInstance = { id, name, version, root: `/node_modules/.store/${id}/node_modules/${name}`, peerBindings: peers, dependencies: {}, metadata };
          instances[id] = instance;
          const recorded = replay?.instances[id];
          if (replay && (!recorded || recorded.name !== name || recorded.version !== version || canonical(recorded.peerBindings) !== canonical(peers))) fail("E_LOCK_INSTANCE", `Package binding changed for ${id}`);
          lock.instances[id] = { name, version, peerBindings: { ...peers }, dependencies: instance.dependencies };
          const bytes = await fetchBytes(npmFileUrl(name, version, "package.json", policy.cdnBase));
          if (bytes) files[`${instance.root}/package.json`] = bytes.slice();
          return instance;
        })();
        instancePromises.set(id, pending);
      }
      const instance = await pending;
      if (parent) parent.dependencies[name] = instance.id;
      return instance;
    }
    async function read(path: string, instance?: PackageInstance): Promise<Uint8Array | undefined> {
      abort(); if (files[path]) return files[path];
      if (!instance || !path.startsWith(`${instance.root}/`)) return undefined;
      const relative = path.slice(instance.root.length + 1);
      const bytes = await fetchBytes(npmFileUrl(instance.name, instance.version, relative, policy.cdnBase));
      if (bytes) files[path] = bytes.slice();
      return bytes;
    }
    function boundPath(base: string, relative: string, instance?: PackageInstance): string {
      const path = cleanPath(`${base}/${relative}`);
      if (instance && path !== instance.root && !path.startsWith(`${instance.root}/`)) fail("E_PACKAGE_PATH", `Path escapes ${instance.name}: ${relative}`);
      return path;
    }
    function exportTarget(value: unknown, purpose: "runtime" | "type", mode: "import" | "require"): string | null | undefined {
      if (value === null || typeof value === "string") return value;
      if (Array.isArray(value)) fail("E_EXPORTS_UNSUPPORTED", "Package exports arrays are not supported by this resolver policy");
      if (!value || typeof value !== "object") fail("E_EXPORTS_TARGET", "Invalid package exports target");
      const conditions = new Set([...policy.conditions, mode, "default", ...(purpose === "type" ? ["types"] : [])]);
      for (const [condition, target] of Object.entries(value)) {
        if (condition.includes("*") || condition.startsWith(".")) fail("E_EXPORTS_UNSUPPORTED", `Unsupported condition ${condition}`);
        if (conditions.has(condition)) { const selected = exportTarget(target, purpose, mode); if (selected !== undefined) return selected; }
      }
      return undefined;
    }
    function selectExport(metadata: PackageMetadata, subpath: string, purpose: "runtime" | "type", mode: "import" | "require"): string | null | undefined {
      const exports = metadata.exports;
      if (exports === undefined) return undefined;
      if (exports && typeof exports === "object" && !Array.isArray(exports)) {
        const keys = Object.keys(exports);
        const subpaths = keys.filter(key => key.startsWith("."));
        if (subpaths.length && subpaths.length !== keys.length) fail("E_EXPORTS_TARGET", "Package exports cannot mix conditions and subpaths");
        if (subpaths.length) {
          if (!Object.hasOwn(exports, subpath)) {
            if (keys.some(key => key.includes("*"))) fail("E_EXPORTS_UNSUPPORTED", `Resolving ${subpath} would require unsupported exports wildcard matching`);
            fail("E_PACKAGE_EXPORT", `Package does not export ${subpath}`);
          }
          return exportTarget((exports as Record<string, unknown>)[subpath], purpose, mode);
        }
      }
      if (subpath !== ".") fail("E_PACKAGE_EXPORT", `Package does not export ${subpath}`);
      return exportTarget(exports, purpose, mode);
    }
    async function candidate(path: string, purpose: "runtime" | "type", instance?: PackageInstance, seen = new Set<string>(), directories = true): Promise<string | undefined> {
      if (seen.has(path)) return undefined; seen.add(path);
      const substitutions = purpose === "type" && !declarationPattern.test(path)
        ? path.endsWith(".mjs") ? [path.slice(0, -4) + ".d.mts", path.slice(0, -4) + ".mts"]
          : path.endsWith(".cjs") ? [path.slice(0, -4) + ".d.cts", path.slice(0, -4) + ".cts"]
          : path.endsWith(".js") || path.endsWith(".jsx") ? [path.replace(/\.jsx?$/, ".d.ts"), path.replace(/\.jsx?$/, ".ts"), path.replace(/\.jsx?$/, ".tsx")] : []
        : [];
      const extension = /\.[^/]+$/.test(path);
      const runtimeSubstitutions = purpose === "runtime" ? path.endsWith(".js") || path.endsWith(".jsx") ? [path.replace(/\.jsx?$/, ".ts"), path.replace(/\.jsx?$/, ".tsx")] : path.endsWith(".mjs") ? [path.slice(0, -4) + ".mts"] : path.endsWith(".cjs") ? [path.slice(0, -4) + ".cts"] : [] : [];
      const candidates = [...substitutions, ...(purpose === "runtime" || declarationPattern.test(path) || /\.[cm]?tsx?$/.test(path) || path.endsWith(".json") ? [path] : []), ...runtimeSubstitutions, ...(!extension ? (purpose === "type" ? [".d.ts", ".ts", ".tsx", ".d.mts", ".d.cts"] : [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]).map(suffix => path + suffix) : [])];
      for (const item of candidates) if (await read(item, instance)) return item;
      if (extension || !directories) return undefined;
      const packageBytes = await read(`${path}/package.json`, instance);
      if (packageBytes) {
        let metadata: PackageMetadata;
        try { metadata = JSON.parse(decoder.decode(packageBytes)); } catch { return fail("E_PACKAGE_METADATA", `Invalid package.json at ${path}`); }
        const fields = purpose === "type" ? ["types", "typings", ...policy.mainFields] : policy.mainFields;
        for (const field of fields) {
          const target = (metadata as Record<string, unknown>)[field];
          if (typeof target === "string") { const result = await candidate(boundPath(path, target, instance), purpose, instance, seen); if (result) return result; }
        }
      }
      return candidate(`${path}/index`, purpose, instance, seen, false);
    }
    async function packageEntry(instance: PackageInstance, subpath: string, purpose: "runtime" | "type", mode: "import" | "require"): Promise<string | undefined> {
      const metadata = instance.metadata;
      if (purpose === "type" && metadata.typesVersions !== undefined) fail("E_TYPES_VERSIONS_UNSUPPORTED", `${instance.name} uses unsupported typesVersions`);
      const target = selectExport(metadata, subpath, purpose, mode);
      if (target === null) fail("E_PACKAGE_EXPORT", `${instance.name} explicitly blocks ${subpath}`);
      if (target !== undefined) {
        if (!target.startsWith("./") || target.split("/").some(part => part === ".." || part === "node_modules") || /[\\%?#]/.test(target)) fail("E_EXPORTS_TARGET", `Invalid exports target ${target} in ${instance.name}`);
        const result = await candidate(boundPath(instance.root, target, instance), purpose, instance);
        if (result) return result;
        // A sibling .d.ts may not exist. Legacy types may still describe the root runtime export.
        if (purpose === "runtime") fail("E_MODULE_NOT_FOUND", `Export ${subpath} points to missing ${target} in ${instance.name}`);
      } else if (metadata.exports !== undefined && purpose === "runtime") fail("E_PACKAGE_EXPORT", `No matching export condition for ${instance.name}/${subpath}`);
      if (subpath !== ".") return candidate(boundPath(instance.root, subpath, instance), purpose, instance);
      if (purpose === "type") for (const target of [metadata.types, metadata.typings]) if (target) {
        const result = await candidate(boundPath(instance.root, target, instance), purpose, instance); if (result) return result;
      }
      for (const field of policy.mainFields) {
        const main = (metadata as Record<string, unknown>)[field];
        if (typeof main === "string") { const result = await candidate(boundPath(instance.root, main, instance), purpose, instance); if (result) return result; }
      }
      return candidate(`${instance.root}/index`, purpose, instance);
    }
    const sdkRoot = cleanPath(release.sdkPackageRoot ?? "/node_modules/@godot-js/react");
    const declaredTypesRoot = cleanPath(release.typesRoot ?? "/node_modules/@types");
    const reactTypesRoot = declaredTypesRoot.endsWith("/react") ? declaredTypesRoot : `${declaredTypesRoot}/react`;
    async function sdkType(specifier: string): Promise<string | undefined> {
      if (specifier === "react" || specifier.startsWith("react/")) return candidate(specifier === "react" ? `${reactTypesRoot}/index.d.ts` : `${reactTypesRoot}/${specifier.slice(6)}`, "type");
      if (specifier === "@godot-js/react" || specifier.startsWith("@godot-js/react/")) {
        const subpath = specifier === "@godot-js/react" ? "." : `./${specifier.slice("@godot-js/react/".length)}`;
        const packageBytes = files[`${sdkRoot}/package.json`];
        if (packageBytes) {
          let metadata: PackageMetadata;
          try { metadata = JSON.parse(decoder.decode(packageBytes)); } catch { return fail("E_PACKAGE_METADATA", "Invalid SDK package.json"); }
          const target = selectExport(metadata, subpath, "type", "import");
          if (typeof target === "string") { const result = await candidate(boundPath(sdkRoot, target), "type"); if (result) return result; }
          if (subpath === ".") for (const target of [metadata.types, metadata.typings]) if (target) { const result = await candidate(boundPath(sdkRoot, target), "type"); if (result) return result; }
        }
        const stem = subpath === "." ? "index" : subpath.slice(2);
        for (const target of [`${sdkRoot}/dist/${stem}`, `${sdkRoot}/${stem}`]) { const result = await candidate(target, "type"); if (result) return result; }
      }
      return undefined;
    }
    function instanceFor(path: string): PackageInstance | undefined { return Object.values(instances).find(instance => path.startsWith(`${instance.root}/`)); }
    async function resolveReference(importer: string, reference: ImportReference, purpose: "runtime" | "type"): Promise<{ path: string; instance?: PackageInstance; external?: boolean; runtimeInstanceId?: string; typeInstanceId?: string } | undefined> {
      const specifier = reference.specifier;
      const parent = instanceFor(importer);
      if (specifier.startsWith("node:") || nodeBuiltins.has(specifier)) fail("E_NODE_BUILTIN", `Node builtin ${specifier} is unavailable in the Godot browser runtime (imported by ${importer})`);
      if (specifier.startsWith("#")) fail("E_PACKAGE_IMPORTS_UNSUPPORTED", `Package imports mappings are not supported: ${specifier} in ${importer}`);
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const path = specifier.startsWith("/") ? cleanPath(specifier) : boundPath(dirname(importer), specifier, parent);
        const result = await candidate(path, purpose, parent);
        if (!result) { if (purpose === "type") return undefined; fail("E_MODULE_NOT_FOUND", `${specifier} imported by ${importer}`); }
        return { path: result, instance: parent };
      }
      if (/^[a-z]+:/i.test(specifier)) fail("E_PACKAGE_SPECIFIER", `URL imports are not supported: ${specifier}`);
      if (Object.hasOwn(release.specifiers ?? {}, specifier)) {
        const canonicalName = splitSpecifier(specifier).name;
        const requirement = parent?.metadata.dependencies?.[canonicalName] ?? parent?.metadata.peerDependencies?.[canonicalName] ?? parent?.metadata.optionalDependencies?.[canonicalName];
        if (requirement && certified[canonicalName] && (!semver.validRange(requirement) || !semver.satisfies(certified[canonicalName], requirement)))
          fail("E_REACT_SINGLETON", `${parent!.id} requires ${canonicalName}@${requirement}, release provides ${certified[canonicalName]}`);
        if (purpose === "runtime") return { path: release.specifiers![specifier], external: true };
        const path = await sdkType(specifier); return path ? { path } : undefined;
      }
      const { name, subpath } = splitSpecifier(specifier);
      if (runtimeSingletons.has(name)) fail(name === "react-reconciler" ? "E_RENDERER_IMPORT" : "E_SDK_SUBPATH", `Use an explicitly certified SDK/runtime import: ${specifier}`);
      if (name === "react-dom" || name === "react-native") fail("E_RENDERER_IMPORT", `${name} cannot render the Godot host`);
      if (purpose === "type") {
        const localRoot = `/node_modules/${name}`;
        const localMetadata = files[`${localRoot}/package.json`];
        if (localMetadata || Object.keys(files).some(path => path.startsWith(`${localRoot}/`))) {
          const metadata = localMetadata ? JSON.parse(decoder.decode(localMetadata)) as PackageMetadata : {};
          const target = selectExport(metadata, subpath, "type", reference.mode);
          if (target === null) fail("E_PACKAGE_EXPORT", `${name} explicitly blocks ${subpath}`);
          const candidates = typeof target === "string" ? [boundPath(localRoot, target)] : subpath !== "." ? [boundPath(localRoot, subpath)] : [metadata.types, metadata.typings, "index.d.ts"].filter((item): item is string => !!item).map(item => boundPath(localRoot, item));
          for (const path of candidates) { const result = await candidate(path, "type"); if (result) return { path: result }; }
        }
      }
      let range = parent?.metadata.dependencies?.[name] ?? parent?.metadata.optionalDependencies?.[name];
      if (!range && parent?.metadata.peerDependencies?.[name]) {
        const binding = parent.peerBindings[name]; if (binding) range = binding.slice(binding.lastIndexOf("@") + 1);
      }
      range ??= roots[name];
      if (!range) {
        // SDK and declaration packages can declare @types dependencies in their local package metadata.
        let directory = dirname(importer);
        while (directory !== "/") {
          const bytes = files[`${directory}/package.json`];
          if (bytes) {
            const metadata = JSON.parse(decoder.decode(bytes)) as PackageMetadata;
            range = metadata.dependencies?.[name] ?? metadata.peerDependencies?.[name]; if (range) break;
          }
          directory = dirname(directory);
        }
      }
      if (!range) {
        if (purpose === "type") return undefined;
        fail("E_UNDECLARED_DEPENDENCY", `${specifier} imported by ${importer} is not declared in its package`);
      }
      const instance = await packageInstance(name, range, parent);
      const path = await packageEntry(instance, subpath, purpose, reference.mode);
      if (path) return { path, instance, runtimeInstanceId: instance.id, ...(purpose === "type" ? { typeInstanceId: instance.id } : {}) };
      if (purpose === "type" && !name.startsWith("@types/")) {
        const typeName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
        const typeRange = roots[typeName] ?? instance.metadata.dependencies?.[typeName];
        if (typeRange) {
          const typesInstance = await packageInstance(typeName, typeRange, parent);
          const declaration = await packageEntry(typesInstance, subpath, "type", reference.mode);
          if (declaration) return { path: declaration, instance: typesInstance, runtimeInstanceId: instance.id, typeInstanceId: typesInstance.id };
        }
      }
      if (purpose === "runtime") fail("E_MODULE_NOT_FOUND", `No runtime entry for ${specifier} in ${instance.id}`);
      return undefined;
    }
    async function visit(path: string, purpose: "runtime" | "type", instance?: PackageInstance): Promise<void> {
      abort(); const key = `${purpose}:${path}`; if (visited.has(key)) return; visited.add(key);
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(path)) fail("E_MODULE_FORMAT", `Only JavaScript, TypeScript and JSON modules are supported: ${path}`);
      if (purpose === "runtime" && declarationPattern.test(path)) fail("E_MODULE_FORMAT", `A declaration file cannot execute as a runtime module: ${path}`);
      const bytes = await read(path, instance); if (!bytes) fail("E_MODULE_NOT_FOUND", `Missing graph node ${path}`);
      const graph = purpose === "runtime" ? runtimeGraph : typeGraph;
      graph.nodes[path] = { id: path, path, ...(instance ? { instanceId: instance.id } : {}), hash: await sha256(bytes), format: declarationPattern.test(path) ? "declaration" : path.endsWith(".json") ? "json" : path.endsWith(".cjs") || instance?.metadata.type === "commonjs" ? "cjs" : "esm" };
      if (path.endsWith(".json")) return;
      for (const reference of scanImports(ts!, path, decoder.decode(bytes))) {
        if (purpose === "runtime" && !reference.runtime) continue;
        let resolution: Awaited<ReturnType<typeof resolveReference>>;
        try { resolution = await resolveReference(path, reference, purpose); }
        catch (error) {
          // Missing declarations block semantic checking, but do not disguise a valid runtime graph as a build failure.
          if (purpose === "type" && error instanceof ResolverError && ["E_MODULE_NOT_FOUND", "E_UNDECLARED_DEPENDENCY", "E_TYPES_VERSIONS_UNSUPPORTED"].includes(error.code)) {
            typeGraph.unresolved.push({ importer: path, specifier: reference.specifier, code: error.code, message: error.message }); continue;
          }
          throw error;
        }
        if (!resolution) {
          graph.unresolved.push({ importer: path, specifier: reference.specifier, code: "E_TYPES_NOT_FOUND", message: `No locked declaration for ${reference.specifier} imported by ${path}; declare a matching @types dependency if needed` }); continue;
        }
        graph.edges.push({ importer: path, specifier: reference.specifier, mode: reference.mode, resolved: resolution.path, ...(resolution.external ? { external: true } : {}), ...(resolution.runtimeInstanceId ? { runtimeInstanceId: resolution.runtimeInstanceId } : {}), ...(resolution.typeInstanceId ? { typeInstanceId: resolution.typeInstanceId } : {}) });
        if (!resolution.external) await visit(resolution.path, purpose, resolution.instance);
      }
    }
    const configured = snapshot.config.entries ? Object.values(snapshot.config.entries).map(entry => typeof entry === "string" ? entry : entry.module ?? entry.source ?? entry.path ?? entry.file ?? "") : [snapshot.config.entry];
    for (const entry of configured) {
      if (!entry) fail("E_ENTRY", "An entry path is required");
      const path = await candidate(projectPath(entry), "runtime"); if (!path) fail("E_ENTRY", `Entry not found: ${entry}`);
      runtimeGraph.entries.push(path); typeGraph.entries.push(path);
      await visit(path, "runtime"); await visit(path, "type");
    }
    // JSX's implicit module is absent from the source AST, but must be locked for the TS host.
    for (const path of Object.keys(typeGraph.nodes).filter(path => /\.tsx$/.test(path))) {
      const specifier = snapshot.config.mode === "development" ? "react/jsx-dev-runtime" : "react/jsx-runtime";
      const declaration = await sdkType(specifier);
      if (declaration) { typeGraph.edges.push({ importer: path, specifier, mode: "import", resolved: declaration }); await visit(declaration, "type"); }
    }
    if (replay) for (const [id, instance] of Object.entries(lock.instances)) if (canonical(instance.dependencies) !== canonical(replay.instances[id]?.dependencies ?? {})) fail("E_LOCK_INSTANCE", `Dependency bindings changed for ${id}`);
    lock.requests = sorted(lock.requests); lock.instances = sorted(lock.instances); lock.files = sorted(lock.files); lock.missing = [...missing].sort();
    for (const graph of [runtimeGraph, typeGraph]) { graph.entries.sort(); graph.nodes = sorted(graph.nodes); graph.edges.sort((a, b) => canonical(a).localeCompare(canonical(b))); }
    return { instances: sorted(instances), runtimeGraph, typeGraph, lock, files: sorted(files), hash: await sha256(encoder.encode(canonical({ sourceHash: snapshot.sourceHash, release: release.id, policyId, lock, runtimeGraph, typeGraph }))) };
  } };
}
