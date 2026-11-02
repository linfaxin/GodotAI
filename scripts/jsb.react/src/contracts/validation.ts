import { ContractError, ERROR_CODES, fail, invariant } from "./errors";
import {
  NATIVE_BRIDGE_ABI, REACT_VERSIONS, RUNTIME_ABI,
  type ActiveDescriptorV1, type BootVerificationReportV1, type CommitTicket,
  type NativeKey, type RuntimeManifestV1, type TemplatePlanV1, type TargetCertification,
} from "./types";

export function object(value: unknown, path = "$"): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), ERROR_CODES.INVALID_CONTRACT, "Expected object", path);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, ERROR_CODES.INVALID_CONTRACT, "Expected plain data object", path);
  for (const key of Reflect.ownKeys(value)) {
    invariant(typeof key === "string", ERROR_CODES.UNKNOWN_FIELD, "Symbol fields are not serializable", path);
    invariant(key !== "__proto__" && key !== "prototype" && key !== "constructor", ERROR_CODES.UNKNOWN_FIELD, `Forbidden field ${key}`, `${path}.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    invariant("value" in descriptor, ERROR_CODES.INVALID_CONTRACT, "Accessor fields are not allowed", `${path}.${key}`);
    invariant(descriptor.enumerable, ERROR_CODES.INVALID_CONTRACT, "Nonenumerable fields are not serializable", `${path}.${key}`);
  }
  return value as Record<string, unknown>;
}

export function exact(value: unknown, required: readonly string[], optional: readonly string[] = [], path = "$"): Record<string, unknown> {
  const result = object(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) invariant(allowed.has(key), ERROR_CODES.UNKNOWN_FIELD, `Unknown field ${key}`, `${path}.${key}`);
  for (const key of required) invariant(Object.hasOwn(result, key), ERROR_CODES.INVALID_CONTRACT, `Missing field ${key}`, `${path}.${key}`);
  return result;
}

export function string(value: unknown, path = "$"): string {
  invariant(typeof value === "string" && value.length > 0 && !value.includes("\0"), ERROR_CODES.INVALID_CONTRACT, "Expected nonempty string", path);
  return value;
}

export function integer(value: unknown, path = "$"): number {
  invariant(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, ERROR_CODES.INVALID_CONTRACT, "Expected nonnegative safe integer", path);
  return value;
}

export function strings(value: unknown, path = "$", unique = true): string[] {
  invariant(Array.isArray(value), ERROR_CODES.INVALID_CONTRACT, "Expected string array", path);
  const result = value.map((item, i) => string(item, `${path}[${i}]`));
  invariant(!unique || new Set(result).size === result.length, ERROR_CODES.INVALID_CONTRACT, "Duplicate array entry", path);
  return result;
}

function oneOf(value: unknown, values: readonly string[], path: string): string {
  invariant(typeof value === "string" && values.includes(value), ERROR_CODES.INVALID_CONTRACT, `Expected one of ${values.join(", ")}`, path);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  invariant(typeof value === "boolean", ERROR_CODES.INVALID_CONTRACT, "Expected boolean", path);
  return value;
}

export function assertSha256(value: unknown, path = "$"): asserts value is string {
  invariant(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), ERROR_CODES.INVALID_HASH, "Expected lowercase SHA-256", path);
}

export function assertCanonicalResPath(value: unknown, path = "$"): asserts value is string {
  invariant(typeof value === "string" && value.startsWith("res://"), ERROR_CODES.INVALID_PATH, "Expected canonical res:// URI", path);
  const relative = value.slice(6);
  invariant(relative.length > 0 && value.trim() === value && !/[\\\u0000-\u001f\u007f?#%:]/.test(relative), ERROR_CODES.INVALID_PATH, "Invalid URI characters", path);
  invariant(relative.split("/").every(part => part !== "" && part !== "." && part !== ".."), ERROR_CODES.INVALID_PATH, "Empty/traversing path segment", path);
}

export function validateNativeKey(value: unknown, path = "$"): NativeKey {
  const key = exact(value, ["slot", "revision"], [], path);
  integer(key.slot, `${path}.slot`); integer(key.revision, `${path}.revision`);
  invariant((key.slot as number) <= 0x7fffffff, ERROR_CODES.INVALID_CONTRACT, "Native slot exceeds current ObjectDB range", `${path}.slot`);
  invariant((key.revision as number) > 0 && (key.revision as number) <= 0xffffffff, ERROR_CODES.INVALID_CONTRACT, "Invalid uint32 revision", `${path}.revision`);
  return value as NativeKey;
}

export const nativeKeyEquals = (left: NativeKey, right: NativeKey): boolean => left.slot === right.slot && left.revision === right.revision;
export const nativeKeyString = (key: NativeKey): string => `${key.slot}:${key.revision}`;

export function validateCommitTicket(value: unknown, path = "$"): CommitTicket {
  const ticket = exact(value, ["rootId", "rootInstance", "commitId", "buildGeneration"], [], path);
  string(ticket.rootId, `${path}.rootId`); string(ticket.rootInstance, `${path}.rootInstance`);
  integer(ticket.commitId, `${path}.commitId`); string(ticket.buildGeneration, `${path}.buildGeneration`);
  return value as CommitTicket;
}

/** Canonical, deterministic JSON. Rejects non-data, sparse arrays and cycles. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, path: string, depth = 0): string {
    invariant(depth <= 128, ERROR_CODES.INVALID_CONTRACT, "Data nesting limit exceeded", path);
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      invariant(Number.isFinite(item), ERROR_CODES.INVALID_CONTRACT, "Nonfinite JSON number", path);
      return JSON.stringify(item);
    }
    invariant(typeof item === "object", ERROR_CODES.INVALID_CONTRACT, "Expected JSON data", path);
    invariant(!seen.has(item), ERROR_CODES.INVALID_CONTRACT, "Cyclic data", path);
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const parts: string[] = [];
      for (const key of Reflect.ownKeys(item)) {
        invariant(typeof key === "string" && (key === "length" || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length), ERROR_CODES.INVALID_CONTRACT, "Non-index array fields are not serializable", path);
      }
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        invariant(descriptor !== undefined && "value" in descriptor, ERROR_CODES.INVALID_CONTRACT, "Sparse/accessor array", `${path}[${i}]`);
        parts.push(visit(descriptor.value, `${path}[${i}]`, depth + 1));
      }
      result = `[${parts.join(",")}]`;
    } else {
      const record = object(item, path);
      result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${visit(record[key], `${path}.${key}`, depth + 1)}`).join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  return visit(value, "$");
}

/** Clone and freeze serializable contracts so consumers cannot mutate the verified snapshot. */
export function immutableData<T>(value: T): Readonly<T> {
  const copy = JSON.parse(canonicalJson(value)) as T;
  function freeze(item: unknown): void {
    if (item !== null && typeof item === "object") {
      for (const value of Object.values(item)) freeze(value);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}

function sourceLocation(value: unknown, path: string): void {
  const source = exact(value, ["source", "line", "column"], [], path);
  assertCanonicalResPath(source.source, `${path}.source`);
  integer(source.line, `${path}.line`); integer(source.column, `${path}.column`);
}

function dataMap(value: unknown, path: string): Record<string, unknown> {
  const map = object(value, path);
  for (const key of Object.keys(map)) string(key, `${path} key`);
  return map;
}

export interface ManifestValidationOptions {
  manifestUri?: string;
  expectedGeneration?: string;
  expectedRuntimeAbi?: string;
  expectedNativeBridgeAbi?: string;
  expectedProfileHash?: string;
}

export function validateManifest(value: unknown, options: ManifestValidationOptions = {}): RuntimeManifestV1 {
  const m = exact(value, ["schemaVersion", "generation", "sourceSnapshotHash", "compilerVersion", "runtimeAbi", "nativeBridgeAbi", "entryInterfaceHash", "mode", "target", "react", "profile", "entries", "modules", "resources", "nativeScripts", "artifacts", "sourceOrigins"], ["nativeScriptProfiles"]);
  invariant(m.schemaVersion === 1, ERROR_CODES.INVALID_CONTRACT, "Unsupported manifest schema version", "$.schemaVersion");
  for (const field of ["generation", "compilerVersion", "runtimeAbi", "nativeBridgeAbi"]) string(m[field], `$.${field}`);
  assertSha256(m.sourceSnapshotHash, "$.sourceSnapshotHash"); assertSha256(m.entryInterfaceHash, "$.entryInterfaceHash");
  oneOf(m.mode, ["development", "production"], "$.mode");
  const target = exact(m.target, ["sourceCommit", "sourceDiffHash", "godotVersion", "buildFlags", "platform", "arch", "engine", "godotSchemaHash"], [], "$.target");
  for (const field of ["sourceCommit", "godotVersion", "platform", "arch"]) string(target[field], `$.target.${field}`);
  assertSha256(target.sourceDiffHash, "$.target.sourceDiffHash"); assertSha256(target.godotSchemaHash, "$.target.godotSchemaHash");
  oneOf(target.engine, ["quickjs", "v8", "jsc", "web"], "$.target.engine");
  for (const [key, flag] of Object.entries(dataMap(target.buildFlags, "$.target.buildFlags")))
    invariant(typeof flag === "boolean" || typeof flag === "string" || (typeof flag === "number" && Number.isFinite(flag)), ERROR_CODES.INVALID_CONTRACT, "Invalid build flag", `$.target.buildFlags.${key}`);
  const react = exact(m.react, ["react", "reconciler", "scheduler"], [], "$.react");
  for (const field of Object.keys(REACT_VERSIONS)) string(react[field], `$.react.${field}`);
  const profile = exact(m.profile, ["id", "version", "hash"], [], "$.profile");
  string(profile.id, "$.profile.id"); invariant(profile.version === 1, ERROR_CODES.PROFILE, "Unsupported profile wire version", "$.profile.version"); assertSha256(profile.hash, "$.profile.hash");
  const entries = dataMap(m.entries, "$.entries"), modules = dataMap(m.modules, "$.modules"), resources = dataMap(m.resources, "$.resources"), scripts = dataMap(m.nativeScripts, "$.nativeScripts"), artifacts = dataMap(m.artifacts, "$.artifacts"), origins = dataMap(m.sourceOrigins, "$.sourceOrigins");
  invariant(Object.keys(entries).length > 0, ERROR_CODES.INVALID_CONTRACT, "At least one entry is required", "$.entries");
  const pathCases = new Map<string, string>();
  const uri = (value: unknown, path: string): string => {
    assertCanonicalResPath(value, path);
    const folded = value.toLowerCase(), previous = pathCases.get(folded);
    invariant(previous === undefined || previous === value, ERROR_CODES.INVALID_PATH, `Case-colliding URI ${value}`, path);
    pathCases.set(folded, value); return value;
  };
  for (const [id, raw] of Object.entries(modules)) {
    const p = `$.modules.${id}`, mod = exact(raw, ["uri", "sha256", "dependencies", "kind"], [], p);
    uri(mod.uri, `${p}.uri`); assertSha256(mod.sha256, `${p}.sha256`); strings(mod.dependencies, `${p}.dependencies`);
    oneOf(mod.kind, ["view", "vendor", "template", "model"], `${p}.kind`);
  }
  for (const [id, raw] of Object.entries(resources)) {
    const p = `$.resources.${id}`, resource = exact(raw, ["uri", "sha256", "type", "dependencies", "importedArtifacts"], [], p);
    uri(resource.uri, `${p}.uri`); assertSha256(resource.sha256, `${p}.sha256`); string(resource.type, `${p}.type`);
    strings(resource.dependencies, `${p}.dependencies`);
    for (const a of strings(resource.importedArtifacts, `${p}.importedArtifacts`)) uri(a, `${p}.importedArtifacts`);
  }
  for (const [id, raw] of Object.entries(scripts)) {
    const p = `$.nativeScripts.${id}`, script = exact(raw, ["source", "output", "sha256", "dependencies"], [], p);
    const source = uri(script.source, `${p}.source`), output = uri(script.output, `${p}.output`);
    invariant(source.endsWith(".ts") && !source.startsWith("res://node_modules/"), ERROR_CODES.INVALID_PATH, "NativeScript needs project-local .ts identity", `${p}.source`);
    invariant(output.endsWith(".js"), ERROR_CODES.INVALID_PATH, "NativeScript output must be .js", `${p}.output`);
    assertSha256(script.sha256, `${p}.sha256`); strings(script.dependencies, `${p}.dependencies`);
  }
  for (const [id, raw] of Object.entries(dataMap(m.nativeScriptProfiles ?? {}, "$.nativeScriptProfiles"))) {
    const p = `$.nativeScriptProfiles.${id}`, profile = exact(raw, ["type", "script", "schemaHash"], [], p);
    const type = string(profile.type, `${p}.type`);
    invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(type), ERROR_CODES.PROFILE, "Invalid NativeScript profile native type", `${p}.type`);
    const source = uri(profile.script, `${p}.script`); assertSha256(profile.schemaHash, `${p}.schemaHash`);
    invariant(Object.values(scripts).some(script => (script as { source: string }).source === source), ERROR_CODES.PROFILE, "NativeScript profile source is absent from NativeScript graph", `${p}.script`);
  }
  for (const [path, raw] of Object.entries(artifacts)) {
    uri(path, `$.artifacts.${path}`);
    invariant(path !== options.manifestUri && !/(?:^|\/)(?:active|journal)\.json$/.test(path), ERROR_CODES.INVALID_CONTRACT, "Manifest cannot own its activation/journal or itself", `$.artifacts.${path}`);
    const artifact = exact(raw, ["sha256", "owner", "kind"], [], `$.artifacts.${path}`);
    assertSha256(artifact.sha256, `$.artifacts.${path}.sha256`); oneOf(artifact.owner, ["compiler", "native-importer"], `$.artifacts.${path}.owner`); string(artifact.kind, `$.artifacts.${path}.kind`);
  }
  for (const [id, raw] of Object.entries(entries)) {
    const p = `$.entries.${id}`, entry = exact(raw, ["id", "module", "exportName", "script", "scene", "startupAssets"], ["resourceHub", "exportHub"], p);
    invariant(entry.id === id, ERROR_CODES.INVALID_CONTRACT, "Entry key/id mismatch", `${p}.id`);
    invariant(Object.hasOwn(modules, string(entry.module, `${p}.module`)), ERROR_CODES.INVALID_CONTRACT, "Unknown entry module", `${p}.module`);
    string(entry.exportName, `${p}.exportName`);
    for (const field of ["script", "scene", "resourceHub", "exportHub"]) if (entry[field] !== undefined) {
      const path = uri(entry[field], `${p}.${field}`);
      invariant(Object.hasOwn(artifacts, path), ERROR_CODES.INVALID_CONTRACT, `Entry ${field} missing from owned artifacts`, `${p}.${field}`);
    }
    invariant((entry.scene as string).endsWith(".tscn"), ERROR_CODES.INVALID_PATH, "Entry scene must be .tscn", `${p}.scene`);
    invariant(Object.values(scripts).some(raw => (raw as Record<string, unknown>).source === entry.script), ERROR_CODES.INVALID_CONTRACT, "Entry Script identity missing", `${p}.script`);
    for (const asset of strings(entry.startupAssets, `${p}.startupAssets`)) invariant(Object.hasOwn(resources, asset), ERROR_CODES.INVALID_CONTRACT, `Unknown startup asset ${asset}`, `${p}.startupAssets`);
  }
  for (const [path, raw] of Object.entries(origins)) { uri(path, `$.sourceOrigins.${path}`); sourceLocation(raw, `$.sourceOrigins.${path}`); uri((raw as { source: string }).source, `$.sourceOrigins.${path}.source`); }
  const checkEdges = (map: Record<string, unknown>, path: string) => {
    for (const [id, raw] of Object.entries(map)) for (const dep of (raw as { dependencies: string[] }).dependencies)
      invariant(Object.hasOwn(map, dep), ERROR_CODES.INVALID_CONTRACT, `Missing dependency ${dep}`, `${path}.${id}.dependencies`);
  };
  checkEdges(modules, "$.modules"); checkEdges(resources, "$.resources"); checkEdges(scripts, "$.nativeScripts");
  for (const [id, raw] of Object.entries(modules)) {
    const mod = raw as { uri: string; sha256: string };
    invariant(Object.hasOwn(artifacts, mod.uri), ERROR_CODES.INVALID_CONTRACT, "Module output missing from artifact graph", `$.modules.${id}.uri`);
    invariant((artifacts[mod.uri] as { sha256: string }).sha256 === mod.sha256, ERROR_CODES.INVALID_HASH, "Module/artifact hash mismatch", `$.modules.${id}.sha256`);
  }
  for (const [id, raw] of Object.entries(scripts)) {
    const script = raw as { source: string; output: string; sha256: string };
    invariant(Object.hasOwn(artifacts, script.source) && Object.hasOwn(artifacts, script.output), ERROR_CODES.INVALID_CONTRACT, "NativeScript source/output missing from artifact graph", `$.nativeScripts.${id}`);
    invariant((artifacts[script.output] as { sha256: string }).sha256 === script.sha256, ERROR_CODES.INVALID_HASH, "NativeScript output/artifact hash mismatch", `$.nativeScripts.${id}.sha256`);
  }
  for (const [id, raw] of Object.entries(resources)) for (const imported of (raw as { importedArtifacts: string[] }).importedArtifacts) invariant(Object.hasOwn(artifacts, imported), ERROR_CODES.INVALID_CONTRACT, "Imported resource output missing from artifact graph", `$.resources.${id}.importedArtifacts`);
  for (const [path, raw] of Object.entries(origins)) {
    invariant(Object.hasOwn(artifacts, path), ERROR_CODES.INVALID_CONTRACT, "Source origin has no owned artifact", `$.sourceOrigins.${path}`);
    invariant(!Object.hasOwn(artifacts, (raw as { source: string }).source), ERROR_CODES.INVALID_PATH, "Author source/output collision", `$.sourceOrigins.${path}.source`);
  }
  if (options.expectedGeneration !== undefined) invariant(m.generation === options.expectedGeneration, ERROR_CODES.GENERATION, "Generation mismatch");
  if (options.expectedRuntimeAbi !== undefined) invariant(m.runtimeAbi === options.expectedRuntimeAbi, ERROR_CODES.ABI, "Runtime ABI mismatch");
  if (options.expectedNativeBridgeAbi !== undefined) invariant(m.nativeBridgeAbi === options.expectedNativeBridgeAbi, ERROR_CODES.ABI, "Native bridge ABI mismatch");
  if (options.expectedProfileHash !== undefined) invariant(profile.hash === options.expectedProfileHash, ERROR_CODES.PROFILE, "Profile hash mismatch");
  return value as RuntimeManifestV1;
}

export const parseManifest = (text: string, options?: ManifestValidationOptions): RuntimeManifestV1 => validateManifest(parseJson(text), options);

export function assertCompatibility(manifest: RuntimeManifestV1, expected: { runtimeAbi?: string; nativeBridgeAbi?: string; profileHash?: string; generation?: string; react?: Readonly<Record<string, string>>; target?: Partial<TargetCertification>; profileId?: string; mode?: "development" | "production" } = {}): void {
  validateManifest(manifest, { expectedRuntimeAbi: expected.runtimeAbi ?? RUNTIME_ABI, expectedNativeBridgeAbi: expected.nativeBridgeAbi ?? NATIVE_BRIDGE_ABI, ...(expected.profileHash === undefined ? {} : { expectedProfileHash: expected.profileHash }), ...(expected.generation === undefined ? {} : { expectedGeneration: expected.generation }) });
  for (const [key, value] of Object.entries(expected.react ?? REACT_VERSIONS)) invariant((manifest.react as unknown as Record<string, string>)[key] === value, ERROR_CODES.ABI, `React tuple mismatch: ${key}`, `$.react.${key}`);
  if (expected.profileId !== undefined) invariant(manifest.profile.id === expected.profileId, ERROR_CODES.PROFILE, "Profile ID mismatch", "$.profile.id");
  if (expected.mode !== undefined) invariant(manifest.mode === expected.mode, ERROR_CODES.ABI, "Build mode mismatch", "$.mode");
  for (const [key, value] of Object.entries(expected.target ?? {})) invariant(canonicalJson((manifest.target as unknown as Record<string, unknown>)[key]) === canonicalJson(value), ERROR_CODES.ABI, `Native target mismatch: ${key}`, `$.target.${key}`);
}

export function validateActiveDescriptor(value: unknown): ActiveDescriptorV1 {
  const active = exact(value, ["schemaVersion", "generation", "manifestPath", "manifestSha256", "state"]);
  invariant(active.schemaVersion === 1 && active.state === "READY", ERROR_CODES.BUILD_NOT_READY, "Active descriptor is not READY");
  string(active.generation, "$.generation"); assertCanonicalResPath(active.manifestPath, "$.manifestPath"); assertSha256(active.manifestSha256, "$.manifestSha256");
  return value as ActiveDescriptorV1;
}

export function validateTemplatePlan(value: unknown): TemplatePlanV1 {
  const plan = exact(value, ["schemaVersion", "assetId", "source", "sourceHash", "snapshotHash", "profile", "rootId", "nodes", "resources"]);
  invariant(plan.schemaVersion === 1 && (plan.profile === "template-t0" || plan.profile === "template-local-v1" || plan.profile === "template-structural-v1"), ERROR_CODES.PROFILE, "Unsupported template schema/profile");
  string(plan.assetId, "$.assetId"); string(plan.rootId, "$.rootId"); assertCanonicalResPath(plan.source, "$.source"); assertSha256(plan.sourceHash, "$.sourceHash"); assertSha256(plan.snapshotHash, "$.snapshotHash");
  invariant(Array.isArray(plan.nodes) && plan.nodes.length > 0, ERROR_CODES.INVALID_CONTRACT, "Template has no nodes", "$.nodes");
  invariant(Array.isArray(plan.resources), ERROR_CODES.INVALID_CONTRACT, "Expected resources array", "$.resources");
  const nodes = new Map<string, Record<string, unknown>>(), orders = new Map<string | null, Set<number>>();
  for (const [i, raw] of plan.nodes.entries()) {
    const p = `$.nodes[${i}]`, node = exact(raw, ["nodeId", "nativeType", "parentId", "siblingOrder", "name", "initial", "ownerId", "source"], [], p);
    const id = string(node.nodeId, `${p}.nodeId`); invariant(!nodes.has(id), ERROR_CODES.INVALID_CONTRACT, "Duplicate template node", p);
    string(node.nativeType, `${p}.nativeType`); const name = string(node.name, `${p}.name`);
    invariant(!/[\/:@.\0]/.test(name), ERROR_CODES.NAME, "Invalid node name", `${p}.name`);
    integer(node.siblingOrder, `${p}.siblingOrder`); object(node.initial, `${p}.initial`); sourceLocation(node.source, `${p}.source`);
    invariant(node.parentId === null || typeof node.parentId === "string", ERROR_CODES.INVALID_CONTRACT, "Invalid parent", `${p}.parentId`);
    invariant(node.ownerId === null || typeof node.ownerId === "string", ERROR_CODES.INVALID_CONTRACT, "Invalid owner", `${p}.ownerId`);
    canonicalJson(node.initial); nodes.set(id, node);
    const parent = node.parentId as string | null, siblings = orders.get(parent) ?? new Set<number>();
    invariant(!siblings.has(node.siblingOrder as number), ERROR_CODES.INVALID_CONTRACT, "Duplicate sibling order", p); siblings.add(node.siblingOrder as number); orders.set(parent, siblings);
  }
  const root = nodes.get(plan.rootId as string); invariant(root !== undefined && root.parentId === null, ERROR_CODES.INVALID_CONTRACT, "Missing template root", "$.rootId");
  const names = new Set<string>();
  for (const [id, node] of nodes) {
    if (id !== plan.rootId) invariant(typeof node.parentId === "string" && nodes.has(node.parentId), ERROR_CODES.INVALID_CONTRACT, "Missing parent", `$.nodes.${id}`);
    const siblingName = JSON.stringify([node.parentId, node.name]); invariant(!names.has(siblingName), ERROR_CODES.NAME, "Duplicate sibling name", `$.nodes.${id}`); names.add(siblingName);
    const ancestors = new Set<string>(); let current: string | null = id;
    while (current !== null) { invariant(!ancestors.has(current), ERROR_CODES.INVALID_CONTRACT, "Cyclic template topology", `$.nodes.${id}`); const ancestor = nodes.get(current); invariant(ancestor !== undefined, ERROR_CODES.INVALID_CONTRACT, "Missing ancestor", `$.nodes.${id}`); ancestors.add(current); current = ancestor.parentId as string | null; }
    if (node.ownerId !== null) invariant(ancestors.has(node.ownerId as string) && node.ownerId !== id, ERROR_CODES.INVALID_CONTRACT, "Owner must be ancestor", `$.nodes.${id}.ownerId`);
  }
  for (const set of orders.values()) for (let i = 0; i < set.size; i++) invariant(set.has(i), ERROR_CODES.INVALID_CONTRACT, "Sibling order must be contiguous", "$.nodes");
  const resourceIds = new Set<string>();
  for (const [i, raw] of plan.resources.entries()) {
    const p = `$.resources[${i}]`, resource = exact(raw, ["resourceId", "type", "uri", "sha256", "dependencies", "sharingPolicy"], [], p);
    const id = string(resource.resourceId, `${p}.resourceId`); invariant(!resourceIds.has(id), ERROR_CODES.INVALID_CONTRACT, "Duplicate resource", p); resourceIds.add(id);
    string(resource.type, `${p}.type`); assertCanonicalResPath(resource.uri, `${p}.uri`); assertSha256(resource.sha256, `${p}.sha256`); strings(resource.dependencies, `${p}.dependencies`);
    invariant(resource.sharingPolicy === "shared" || (plan.profile === "template-local-v1" && resource.sharingPolicy === "instance"), ERROR_CODES.IMPORT_LOCAL_RESOURCE, "Resource sharing policy is not certified by the template profile", `${p}.sharingPolicy`);
  }
  for (const resource of plan.resources as { dependencies: string[] }[]) for (const dep of resource.dependencies) invariant(resourceIds.has(dep), ERROR_CODES.INVALID_CONTRACT, "Missing resource dependency", "$.resources");
  return value as TemplatePlanV1;
}

export function validateBootReport(value: unknown): BootVerificationReportV1 {
  const report = exact(value, ["schemaVersion", "kind", "scope", "entryId", "generation", "rootInstance", "runtimeAbi", "nativeBridgeAbi", "profile", "layoutPublished", "treeAudit", "startupAssets", "unexpectedErrors"]);
  invariant(report.schemaVersion === 1 && report.kind === "sdk-boot-verification-v1" && report.scope === "framework-boot-smoke", ERROR_CODES.INVALID_CONTRACT, "Unsupported boot report");
  for (const key of ["entryId", "generation", "rootInstance", "runtimeAbi", "nativeBridgeAbi", "profile"]) string(report[key], `$.${key}`);
  integer(report.layoutPublished, "$.layoutPublished");
  const audit = exact(report.treeAudit, ["matches", "businessNodes"], [], "$.treeAudit"); boolean(audit.matches, "$.treeAudit.matches"); integer(audit.businessNodes, "$.treeAudit.businessNodes");
  const assets = exact(report.startupAssets, ["requested", "ready", "failures"], [], "$.startupAssets");
  const requested = strings(assets.requested, "$.startupAssets.requested"), ready = strings(assets.ready, "$.startupAssets.ready"); strings(assets.failures, "$.startupAssets.failures", false);
  for (const id of ready) invariant(requested.includes(id), ERROR_CODES.INVALID_CONTRACT, "Ready asset was not requested", "$.startupAssets.ready");
  strings(report.unexpectedErrors, "$.unexpectedErrors", false); return value as BootVerificationReportV1;
}

export function assertBootSucceeded(value: unknown): BootVerificationReportV1 {
  const report = validateBootReport(value);
  invariant(report.layoutPublished > 0 && report.treeAudit.matches && report.unexpectedErrors.length === 0 && report.startupAssets.failures.length === 0 && report.startupAssets.ready.length === report.startupAssets.requested.length, ERROR_CODES.BUILD_NOT_READY, "SDK boot verification failed");
  return report;
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) { if (error instanceof ContractError) throw error; return fail(ERROR_CODES.INVALID_CONTRACT, "Invalid JSON"); }
}

export const validateRuntimeManifest = validateManifest;
export const parseRuntimeManifest = parseManifest;
export function assertRuntimeManifest(value: unknown, options?: ManifestValidationOptions): asserts value is RuntimeManifestV1 { validateManifest(value, options); }
