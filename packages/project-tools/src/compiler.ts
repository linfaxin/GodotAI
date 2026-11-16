import ts from 'typescript';
import {createBuildPlan, prepareBuildPlan, packPreparedProject, type BuildPlan, type PlannedProject, type PrepareBuildPlanOptions, type SourceInput} from './build-plan.js';
import {EngineProjectBuildError} from './engine-project.js';
import type {PackOptions} from './pck.js';
import {hashBytes, hashJson, canonicalJson} from './hash.js';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
import {DEFAULT_COMPILER_POLICY, assertCompilerPolicy, type CompilerPolicy} from './compiler-policy.js';
import {createProjectTypeEnvironment, checkProjectTypes, snapshotTextFiles, type ProjectTypeEnvironment, type CompilerDiagnostic} from './type-environment.js';
import {ProjectToolError} from './errors.js';

export interface CompilerEnvironmentInput {
  /** The environment adapter validates a release/target descriptor. Actual
   * declaration and runtime bytes below additionally participate in identity. */
  target: Readonly<Record<string, unknown>>;
  declarations: Readonly<Record<string, string>>;
  moduleDeclarations?: Readonly<Record<string, string>>;
  runtimeModules?: Readonly<Record<string, Uint8Array>>;
  vendor?: Uint8Array;
  policy?: CompilerPolicy;
}
export interface CompilerEnvironment {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly policy: CompilerPolicy;
  readonly runtimeModules: Readonly<Record<string, Uint8Array>>;
  readonly vendor: Uint8Array | undefined;
  createTypeEnvironment(sources: SourceInput): ProjectTypeEnvironment;
}
const freezeJson = <T>(value: T): T => {
  const copy = JSON.parse(canonicalJson(value));
  const freeze = (item: any): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copy); return copy;
};

/** Own every input before hashing. Neither a declaration label nor a caller's
 * mutable SDK buffer can stand in for the bytes used by the compiler. */
export async function createCompilerEnvironment(input: CompilerEnvironmentInput): Promise<CompilerEnvironment> {
  if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target))
    throw new ProjectToolError('E_COMPILER_TARGET', 'Expected a target descriptor');
  const policy = Object.freeze({...input.policy ?? DEFAULT_COMPILER_POLICY}); assertCompilerPolicy(policy);
  const target = freezeJson(input.target), declarations = Object.freeze({...input.declarations});
  const moduleDeclarations = Object.freeze({...input.moduleDeclarations});
  const modules = Object.fromEntries(Object.entries(input.runtimeModules ?? {}).map(([name, bytes]) => {
    if (!(bytes instanceof Uint8Array)) throw new ProjectToolError('E_COMPILER_MODULE', `Expected runtime bytes for ${name}`);
    return [name, new Uint8Array(bytes)];
  }));
  if (input.vendor !== undefined && !(input.vendor instanceof Uint8Array)) throw new ProjectToolError('E_COMPILER_MODULE', 'Expected vendor bytes');
  const vendor = input.vendor ? new Uint8Array(input.vendor) : undefined;
  const identity = freezeJson({target, policy: policy.id, typescript: ts.version,
    declarations: await hashJson(declarations), moduleDeclarations: await hashJson(moduleDeclarations),
    runtimeModules: Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([name, bytes]) => [name, await hashBytes(bytes)]))),
    ...(vendor ? {vendor: await hashBytes(vendor)} : {})});
  return Object.freeze({identity, policy,
    get runtimeModules() { return Object.freeze(Object.fromEntries(Object.entries(modules).map(([name, bytes]) => [name, new Uint8Array(bytes)]))); },
    get vendor() { return vendor && new Uint8Array(vendor); },
    createTypeEnvironment(sources: SourceInput) { return createProjectTypeEnvironment({sources, declarations, moduleDeclarations, policy}); },
  });
}

export interface CompileBuildPlanOptions {
  environment?: CompilerEnvironment;
  preparation?: PrepareBuildPlanOptions;
  /** Existing framework adapters retain BuildPlan.compatibility. Core has no
   * React import and does not guess whether a script exports a class/component. */
  preparePlan?: (plan: BuildPlan, options: PrepareBuildPlanOptions) => Promise<PlannedProject>;
  pack?: PackOptions;
}

/** Shared product artifact path. Normalization preserves the supplied plan's
 * old entry semantics; all hosts use this same prepare/overlay/PCK sequence. */
export async function compileBuildPlan(plan: BuildPlan, options: CompileBuildPlanOptions = {}) {
  const inputs = {...plan.inputs};
  if (options.environment) {
    const target = options.environment.identity.target as Record<string, unknown>;
    // Older adapters supplied these labels separately. The prepared environment
    // now binds their actual bytes once, with the same identity in both hosts.
    for (const name of ['engineId', 'extensionId', 'bindingVersion', 'typescriptVersion']) if (Object.hasOwn(inputs, name)) {
      const expected = name === 'typescriptVersion' ? ts.version : target[name];
      if (inputs[name] !== expected) throw new ProjectToolError('E_COMPILER_TARGET', `Plan ${name} differs from its prepared environment`);
      delete inputs[name];
    }
    if (target.engineProfile !== undefined) {
      if (inputs.engineProfile !== undefined && inputs.engineProfile !== target.engineProfile)
        throw new ProjectToolError('E_COMPILER_TARGET', 'Plan engine profile differs from its prepared environment');
      inputs.engineProfile = target.engineProfile;
    }
    if (inputs.importReceipts !== undefined && options.preparation?.storedImportReceipts !== undefined) {
      if (canonicalJson(inputs.importReceipts) !== canonicalJson(options.preparation.storedImportReceipts))
        throw new ProjectToolError('E_COMPILER_TARGET', 'Project import receipts differ from preparation');
      delete inputs.importReceipts; // Their actual inputs are included by prepareBuildPlan.
    }
  }
  const effective = await createBuildPlan(plan.snapshot, plan.launch, {compatibility: plan.compatibility,
    inputs: {...inputs, compiler: options.environment?.identity ?? {policy: DEFAULT_COMPILER_POLICY.id, typescript: ts.version}}});
  const preparation: PrepareBuildPlanOptions = {...options.preparation};
  const packBudget = options.pack?.maxBytes ?? 64 * 1024 * 1024;
  preparation.resourceLimits = {...preparation.resourceLimits,
    maxOutputBytes: Math.min(preparation.resourceLimits?.maxOutputBytes ?? packBudget, packBudget)};
  if (options.environment) preparation.compilerOptions = {
    ...preparation.compilerOptions,
    runtimeModules: {...options.environment.runtimeModules, ...preparation.compilerOptions?.runtimeModules},
    ...(options.environment.vendor ? {vendor: options.environment.vendor} : {}),
  };
  const prepared = await (options.preparePlan ?? prepareBuildPlan)(effective, preparation);
  const artifact = await packPreparedProject(prepared, options.pack);
  const receipt = await assertArtifactReceipt(artifact.receipt, {pack: artifact.pack, buildKey: artifact.plan.buildKey});
  if (!receipt?.artifactId) throw new Error('E_ARTIFACT_IDENTITY: Compiler must produce schema 2 receipts');
  const target = options.environment?.identity.target as Record<string, unknown> | undefined;
  const targetFields = Object.fromEntries(['engineId', 'extensionId', 'engineReleaseId', 'engineProfile']
    .filter(name => typeof target?.[name] === 'string').map(name => [name, target![name] as string]));
  return {pack: artifact.pack, index: artifact.index, manifest: {...artifact.prepared.manifest, ...targetFields}, diagnostics: artifact.prepared.diagnostics,
    buildKey: artifact.plan.buildKey, artifactId: receipt.artifactId, receipt: artifact.receipt, overlay: artifact.overlay.entries, plan: artifact.plan};
}

export interface CompileProjectRequest extends CompileBuildPlanOptions {
  plan: BuildPlan;
  environment: CompilerEnvironment;
}

/** Full checked build used by a CLI or any non-editor consumer. Editors can
 * reuse checkProjectTypes and compileBuildPlan while retaining their own LS. */
export async function compileProject(request: CompileProjectRequest) {
  const diagnostics = checkProjectTypes(request.environment.createTypeEnvironment(snapshotTextFiles(request.plan.snapshot)));
  if (diagnostics.some(item => item.category === 'error')) throw new EngineProjectBuildError(diagnostics.map(item => ({...item,
    category: item.category === 'error' ? 'error' : 'warning'})));
  const result = await compileBuildPlan(request.plan, request);
  return {...result, diagnostics: [...diagnostics, ...result.diagnostics] as CompilerDiagnostic[]};
}
