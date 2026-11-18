import ts from 'typescript';
import {verifyAndDecodeAsset, type AssetReadLimits, type ReleaseFacts, type ReleaseInput, type RawAssetReader, type StoredAsset} from '@godot-js/engine/release-assets';
import {assertNativeReleaseIdentity, assertNativeTypeSnapshot} from '@godot-js/engine/identities';
import {parseEngineApi, canonicalEngineApi, type EngineApiIR} from '@godot-js/engine/api';
import type {ImportTarget} from './import-receipts.js';
import type {CompilerEnvironmentInput} from './compiler.js';
import {DEFAULT_COMPILER_POLICY} from './compiler-policy.js';
import {resourceTargetForEngine} from './resource-formats.js';
import {hashBytes, canonicalJson} from './hash.js';
import {ProjectToolError} from './errors.js';

export type RuntimeSelection =
  | {kind: 'engine'}
  | {kind: 'sdk'; mode: 'development' | 'production'};

/** Facts about verified base inputs. Host overlays belong to the final
 * CompilerEnvironment identity, rather than these release facts. */
export interface CompilerEnvironmentInputFacts {
  readonly release: ReleaseFacts;
  readonly naming: 'snake' | 'camel';
  readonly selection: RuntimeSelection;
  readonly requiredExtensionId?: string;
  readonly bindingVersion?: string;
  readonly compilerPolicy: string;
  readonly typescriptVersion: string;
  readonly baseRuntimeModules: readonly string[];
  readonly assetReadLimits: AssetReadLimits;
  readonly api: Readonly<{status: 'available' | 'unknown'; reason?: string}>;
  readonly resources: Readonly<
    | {status: 'available'; target: ImportTarget}
    | {status: 'unknown'; reason: string}
  >;
}

export interface PrepareCompilerEnvironmentInput extends ReleaseInput {
  naming: 'snake' | 'camel';
  selection: RuntimeSelection;
  readRawAsset: RawAssetReader;
  signal?: AbortSignal;
  assetReadLimits?: Partial<AssetReadLimits>;
}

const DEFAULT_COMPILER_ASSET_LIMIT = 64 * 1024 * 1024;
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
function fail(code: string, message: string): never { throw new ProjectToolError(code, message); }
function budget(value: number | undefined): number {
  const result = value ?? DEFAULT_COMPILER_ASSET_LIMIT;
  if (!Number.isSafeInteger(result) || result < 1) fail('E_COMPILER_ASSET_LIMIT', 'Expected a positive byte limit');
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function json(bytes: Uint8Array, code: string): any {
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { return fail(code, 'Expected valid UTF-8 JSON'); }
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Prepare verified base inputs. Host-specific declarations, module aliases and
 * demo modules are composed by the caller before createCompilerEnvironment(). */
export async function prepareCompilerEnvironmentInput(options: PrepareCompilerEnvironmentInput): Promise<{
  input: CompilerEnvironmentInput;
  facts: Readonly<CompilerEnvironmentInputFacts>;
  api?: EngineApiIR;
}> {
  const {naming, readRawAsset, signal} = options;
  const selection = {...options.selection} as RuntimeSelection;
  const limits = Object.freeze({maxStoredBytes: budget(options.assetReadLimits?.maxStoredBytes), maxDecodedBytes: budget(options.assetReadLimits?.maxDecodedBytes)});
  abort(signal);
  if (!['snake', 'camel'].includes(naming)) fail('E_COMPILER_NAMING', 'Expected snake or camel naming');
  if (!selection || !['engine', 'sdk'].includes(selection.kind)
    || (selection.kind === 'sdk' && !['development', 'production'].includes(selection.mode))
    || Object.keys(selection).some(key => !(selection.kind === 'sdk' ? ['kind', 'mode'] : ['kind']).includes(key)))
    fail('E_COMPILER_SELECTION', 'Choose the engine or one complete SDK mode');
  if (typeof readRawAsset !== 'function') fail('E_COMPILER_ASSET_READER', 'A raw asset reader is required');
  if (!(options.descriptorBytes instanceof Uint8Array)) fail('E_COMPILER_RELEASE', 'Expected release descriptor bytes');
  if (options.descriptorBytes.byteLength > limits.maxStoredBytes) fail('E_COMPILER_INPUT_BUDGET', 'Release descriptor exceeds the byte limit');
  const descriptorBytes = new Uint8Array(options.descriptorBytes);
  freeze(selection);
  const release = freeze(json(descriptorBytes, 'E_COMPILER_RELEASE'));
  await assertNativeReleaseIdentity(release);
  abort(signal);
  if (typeof release.runtimeProfile !== 'string' || !release.runtimeProfile) fail('E_PROJECT_ENGINE_PROFILE', 'Release is missing its engine profile');
  const descriptorSha256 = await hashBytes(descriptorBytes);
  abort(signal);

  const read = async (asset: StoredAsset): Promise<Uint8Array> => {
    if (!record(asset) || typeof asset.path !== 'string' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0)
      return fail('E_COMPILER_RELEASE_ASSET', 'Expected a complete stored asset descriptor');
    if (asset.bytes > limits.maxStoredBytes) return fail('E_ASSET_SIZE', 'Asset exceeds the stored byte limit');
    abort(signal);
    const raw = await readRawAsset(asset, {signal, maxStoredBytes: limits.maxStoredBytes});
    abort(signal);
    const bytes = await verifyAndDecodeAsset(raw, asset, {...limits, signal});
    abort(signal);
    return bytes;
  };
  const profile = release.api.namingProfiles?.[naming] ?? (naming === 'snake' ? release.api : undefined);
  if (!profile?.typeSnapshot) fail('E_COMPILER_NAMING', `Release has no ${naming} declaration snapshot`);
  const declarations = json(await read(profile.typeSnapshot), 'E_COMPILER_DECLARATIONS');
  await assertNativeTypeSnapshot(release, declarations, naming);
  abort(signal);

  let api: EngineApiIR | undefined;
  const ir = profile.ir ?? (naming === 'snake' ? release.api.ir : undefined);
  if (ir !== undefined) {
    api = parseEngineApi(json(await read(ir), 'E_COMPILER_API'));
    if (api.bindingNaming !== naming) fail('E_COMPILER_API_TARGET', 'API IR naming differs from the selected declaration profile');
    for (const [field, expected] of [
      ['engineVersion', release.engine.version],
      ['bindingVersion', profile.bindingVersion ?? release.api.bindingVersion],
      ['namingVersion', profile.namingVersion ?? release.api.namingVersion],
    ] as const) if (expected !== undefined && api[field] !== expected)
      fail('E_COMPILER_API_TARGET', `API IR ${field} differs from the release`);
    const modules = release.modules ?? release.engine.modules;
    if (modules !== undefined && canonicalJson([...api.modules].sort()) !== canonicalJson([...modules].sort()))
      fail('E_COMPILER_API_TARGET', 'API IR modules differ from the release');
    if (typeof profile.actualAPIHash === 'string' && await hashBytes(canonicalEngineApi(api)) !== profile.actualAPIHash)
      fail('E_COMPILER_API_TARGET', 'API IR content differs from its sealed API identity');
    abort(signal);
    freeze(api);
  }

  const moduleDeclarations: Record<string, string> = {godot: '/godot/index.d.ts', 'godot-jsb': '/godot-jsb/index.d.ts', 'godot.annotations': '/godot.annotations/index.d.ts'};
  for (const [name, contract] of Object.entries(release.sdk.moduleContract ?? {}) as [string, any][]) {
    if (!record(contract) || typeof contract.declaration !== 'string' || typeof declarations[contract.declaration] !== 'string')
      fail('E_COMPILER_SDK_CONTRACT', `Missing declaration route for ${name}`);
    moduleDeclarations[name] = contract.declaration;
  }
  const runtimeModules: Record<string, Uint8Array> = Object.create(null);
  let vendor: Uint8Array | undefined;
  if (selection.kind === 'sdk') {
    const sdk = release.sdk;
    if (!record(sdk.moduleContract) || !Object.keys(sdk.moduleContract).length || !record(sdk.runtimeModules) || !Object.keys(sdk.runtimeModules).length)
      fail('E_COMPILER_SDK_CONTRACT', 'The selected SDK needs its complete module contract and runtime modules');
    const asset = sdk.vendors?.[selection.mode];
    if (!asset) fail('E_COMPILER_SDK_MODE', `Release has no ${selection.mode} SDK vendor`);
    vendor = await read(asset);
    for (const [name, asset] of Object.entries(sdk.runtimeModules) as [string, StoredAsset][]) {
      if (!Object.hasOwn(sdk.moduleContract, name)) fail('E_COMPILER_SDK_CONTRACT', `Runtime module ${name} has no declaration contract`);
      runtimeModules[name] = await read(asset);
    }
    for (const name of Object.keys(sdk.moduleContract)) if (!Object.hasOwn(runtimeModules, name))
      fail('E_COMPILER_SDK_CONTRACT', `Missing runtime module ${name}`);
  }
  const execution = release.execution ?? release.engine.execution;
  const releaseFacts: ReleaseFacts = freeze({releaseId: release.id, descriptorSha256, engineProfile: release.runtimeProfile,
    ...(release.engineId !== undefined ? {engineId: release.engineId} : {}),
    ...(release.extensionId !== undefined ? {extensionId: release.extensionId} : {}),
    ...(release.artifactReceiptVersion === 2 ? {artifactReceiptVersion: 2 as const} : {}),
    ...(execution?.artifactSetAbi === 1 ? {artifactSetAbi: 1 as const} : {})});
  const requiredExtensionId = selection.kind === 'sdk' ? releaseFacts.extensionId : undefined;
  const target = freeze({...(releaseFacts.engineId !== undefined ? {engineId: releaseFacts.engineId} : {}),
    engineReleaseId: release.id, engineProfile: release.runtimeProfile, naming,
    ...(requiredExtensionId !== undefined ? {extensionId: requiredExtensionId} : {}), bindingVersion: release.api.bindingVersion ?? 'unknown',
    ...(execution?.artifactSetAbi === 1 ? {artifactSetAbi: 1} : {})});
  const facts: CompilerEnvironmentInputFacts = freeze({release: releaseFacts, naming, selection,
    ...(requiredExtensionId !== undefined ? {requiredExtensionId} : {}),
    ...(typeof release.api.bindingVersion === 'string' ? {bindingVersion: release.api.bindingVersion} : {}),
    compilerPolicy: DEFAULT_COMPILER_POLICY.id, typescriptVersion: ts.version,
    baseRuntimeModules: Object.keys(runtimeModules).sort(), assetReadLimits: limits,
    api: api ? {status: 'available'} : {status: 'unknown', reason: `Release has no ${naming} API IR`},
    resources: resourceTargetForEngine(release.engine.version ?? api?.engineVersion, releaseFacts.engineId)});
  abort(signal);
  return {input: Object.freeze({target, declarations: freeze(declarations), moduleDeclarations: freeze(moduleDeclarations),
    runtimeModules: Object.freeze(runtimeModules), ...(vendor ? {vendor} : {}), policy: DEFAULT_COMPILER_POLICY}), facts, ...(api ? {api} : {})};
}
