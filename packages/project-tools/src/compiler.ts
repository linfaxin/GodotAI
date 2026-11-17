import ts from 'typescript';
import {createBuildPlan, prepareBuildPlan, packPreparedProject,capturePrepareBuildPlanOptions, type BuildPlan, type PlannedProject, type PrepareBuildPlanOptions, type SourceInput} from './build-plan.js';
import {EngineProjectBuildError} from './engine-project.js';
import type {PackOptions} from './pck.js';
import {hashBytes, hashJson, canonicalJson} from './hash.js';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
import {DEFAULT_COMPILER_POLICY, assertCompilerPolicy, type CompilerPolicy} from './compiler-policy.js';
import {createProjectTypeEnvironment, checkProjectTypes, snapshotTextFiles, ProjectLanguageService,type ProjectTypeEnvironment, type CompilerDiagnostic} from './type-environment.js';
import {ProjectToolError} from './errors.js';
import {ProjectBuildCache} from './build-cache.js';
import {createArtifactSet,type ArtifactSetOptions} from './artifact-set.js';
import {captureBytes,hashOwnedBytes} from './owned-bytes.js';
export {ProjectBuildCache} from './build-cache.js';
export {ProjectWorkspace} from './workspace.js';
export {ProjectLanguageService} from './type-environment.js';

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
const environmentBytes=new WeakMap<CompilerEnvironment,{modules:Readonly<Record<string,Uint8Array>>;vendor?:Uint8Array}>();
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
    return [name,captureBytes(bytes)];
  }));
  if (input.vendor !== undefined && !(input.vendor instanceof Uint8Array)) throw new ProjectToolError('E_COMPILER_MODULE', 'Expected vendor bytes');
  const vendor = input.vendor ? captureBytes(input.vendor) : undefined;
  const identity = freezeJson({target, policy: policy.id, typescript: ts.version,
    declarations: await hashJson(declarations), moduleDeclarations: await hashJson(moduleDeclarations),
    runtimeModules: Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([name, bytes]) => [name, await hashOwnedBytes(bytes)]))),
    ...(vendor ? {vendor: await hashOwnedBytes(vendor)} : {})});
  const environment=Object.freeze({identity, policy,
    get runtimeModules() { return Object.freeze(Object.fromEntries(Object.entries(modules).map(([name, bytes]) => [name, new Uint8Array(bytes)]))); },
    get vendor() { return vendor && new Uint8Array(vendor); },
    createTypeEnvironment(sources: SourceInput) { return createProjectTypeEnvironment({sources, declarations, moduleDeclarations, policy}); },
  });
  environmentBytes.set(environment,{modules,vendor});return environment;
}

export interface CompileBuildPlanOptions {
  environment?: CompilerEnvironment;
  preparation?: PrepareBuildPlanOptions;
  /** Existing framework adapters retain BuildPlan.compatibility. Core has no
   * React import and does not guess whether a script exports a class/component. */
  preparePlan?: (plan: BuildPlan, options: PrepareBuildPlanOptions) => Promise<PlannedProject>;
  pack?: PackOptions;
  cache?:ProjectBuildCache;
  signal?:AbortSignal;
  languageService?:ProjectLanguageService;
  artifactSet?:boolean|Omit<ArtifactSetOptions,'target'|'launch'>;
}
function assertBuildActive(signal:AbortSignal|undefined):void{if(signal?.aborted)throw signal.reason??new ProjectToolError('E_BUILD_CANCELLED','Build cancelled');}

/** Shared product artifact path. Normalization preserves the supplied plan's
 * old entry semantics; all hosts use this same prepare/overlay/PCK sequence. */
async function compileBuildPlanInternal(plan: BuildPlan, options: CompileBuildPlanOptions = {}) {
  const setOptions=typeof options.artifactSet==='object'?options.artifactSet:undefined;
  // Nested package options and version tuples are semantic inputs too. Capture
  // them before preparation yields, with the top-level pack options taking
  // precedence over the optional ArtifactSet defaults.
  const pack=freezeJson({...setOptions?.pack,...options.pack});
  options={...options,cache:options.cache??setOptions?.cache,preparation:capturePrepareBuildPlanOptions(options.preparation??{}),pack,
    ...(setOptions?{artifactSet:{...setOptions,...(setOptions.groups?{groups:freezeJson(setOptions.groups)}:{}),pack}}:{})};
  assertBuildActive(options.signal);
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
  const preparation: PrepareBuildPlanOptions = {...options.preparation,...(options.cache?{cache:options.cache}:{})};
  const packBudget = options.pack?.maxBytes ?? 64 * 1024 * 1024;
  preparation.resourceLimits = {...preparation.resourceLimits,
    maxOutputBytes: Math.min(preparation.resourceLimits?.maxOutputBytes ?? packBudget, packBudget)};
  const ownedEnvironment=options.environment&&environmentBytes.get(options.environment);
  const runtimeModules=ownedEnvironment?.modules??options.environment?.runtimeModules;
  const vendor=ownedEnvironment?ownedEnvironment.vendor:options.environment?.vendor;
  if (options.environment) preparation.compilerOptions = {
    ...preparation.compilerOptions,
    runtimeModules: {...runtimeModules, ...preparation.compilerOptions?.runtimeModules},
    ...(vendor ? {vendor} : {}),
  };
  const prepared = await (options.preparePlan ?? prepareBuildPlan)(effective, preparation);
  assertBuildActive(options.signal);
  const target = options.environment?.identity.target as Record<string, unknown> | undefined;
  const targetFields = Object.fromEntries(['engineId', 'extensionId', 'engineReleaseId', 'engineProfile']
    .filter(name => typeof target?.[name] === 'string').map(name => [name, target![name] as string]));
  if(options.artifactSet){
    if(target?.artifactSetAbi!==1)throw new ProjectToolError('E_ARTIFACT_SET_TARGET','The matched native target does not provide artifactSetAbi 1');
    const configuration=typeof options.artifactSet==='object'?options.artifactSet:{};
    const setPlan=await createBuildPlan(prepared.plan.snapshot,prepared.plan.launch,{compatibility:prepared.plan.compatibility,
      inputs:{...prepared.plan.inputs,artifact:{kind:'pack-set',groups:configuration.groups??{},pack:options.pack??{}}}});
    const artifactSet=await createArtifactSet(prepared.prepared.files,{...configuration,target,launch:setPlan.launch,pack:options.pack,cache:options.cache});
    assertBuildActive(options.signal);
    return {variant:'pack-set' as const,artifactSet,manifest:{...prepared.prepared.manifest,...targetFields},diagnostics:prepared.prepared.diagnostics,
      buildKey:setPlan.buildKey,sourceHash:setPlan.snapshot.sourceHash,artifactId:artifactSet.manifest.artifactSetId,receipt:artifactSet.manifest,importReceipts:prepared.importReceipts,overlay:prepared.overlay.entries,plan:setPlan};
  }
  const artifact = await packPreparedProject(prepared, options.pack,options.cache);
  const receipt = await assertArtifactReceipt(artifact.receipt, {pack: artifact.pack, buildKey: artifact.plan.buildKey});
  if (!receipt?.artifactId) throw new Error('E_ARTIFACT_IDENTITY: Compiler must produce schema 2 receipts');
  assertBuildActive(options.signal);
  return {variant:'single-pack' as const,pack: artifact.pack, index: artifact.index, manifest: {...artifact.prepared.manifest, ...targetFields}, diagnostics: artifact.prepared.diagnostics,
    buildKey: artifact.plan.buildKey,sourceHash:artifact.plan.snapshot.sourceHash, artifactId: receipt.artifactId, receipt: artifact.receipt,importReceipts:artifact.importReceipts, overlay: artifact.overlay.entries, plan: artifact.plan};
}

export type CompileResult=Awaited<ReturnType<typeof compileBuildPlanInternal>>;
/** Independent build evidence. Set identity remains a hash of its package
 * closure; converter provenance is never passed off as a single-PCK receipt. */
export function compileResultMetadata(result:Omit<SinglePackCompileResult,'diagnostics'>|Omit<PackSetCompileResult,'diagnostics'>){
 const manifest:Record<string,unknown>=Object.fromEntries(Object.entries(result.manifest).filter(([,value])=>value!==undefined));
 for(const key of ['artifactReceipt','packSha256','artifactSetId'])delete manifest[key];
 return freezeJson({...manifest,variant:result.variant,buildKey:result.buildKey,sourceHash:result.sourceHash,artifactId:result.artifactId,
  importReceipts:result.importReceipts,outputOverlay:result.overlay,
  ...(result.variant==='pack-set'?{artifactSetId:result.artifactSet.manifest.artifactSetId}:{packSha256:result.receipt.packSha256,artifactReceipt:result.receipt})});
}
export type SinglePackCompileResult=Extract<CompileResult,{variant:'single-pack'}>;
export type PackSetCompileResult=Extract<CompileResult,{variant:'pack-set'}>;
export function compileBuildPlan(plan:BuildPlan,options?:CompileBuildPlanOptions&{artifactSet?:false|undefined}):Promise<SinglePackCompileResult>;
export function compileBuildPlan(plan:BuildPlan,options:CompileBuildPlanOptions&{artifactSet:true|Omit<ArtifactSetOptions,'target'|'launch'>}):Promise<PackSetCompileResult>;
export function compileBuildPlan(plan:BuildPlan,options:CompileBuildPlanOptions):Promise<CompileResult>;
export function compileBuildPlan(plan:BuildPlan,options:CompileBuildPlanOptions={}):Promise<CompileResult>{return compileBuildPlanInternal(plan,options);}

export interface CompileProjectRequest extends CompileBuildPlanOptions {
  plan: BuildPlan;
  environment: CompilerEnvironment;
  releaseSnapshot?:()=>void;
}

/** Full checked build used by a CLI or any non-editor consumer. Editors can
 * reuse checkProjectTypes and compileBuildPlan while retaining their own LS. */
export type CheckedCompileResult<T extends CompileResult=CompileResult>=T extends CompileResult?Omit<T,'diagnostics'>&{diagnostics:CompilerDiagnostic[]}:never;
export function compileProject(request:CompileProjectRequest&{artifactSet?:false|undefined}):Promise<CheckedCompileResult<SinglePackCompileResult>>;
export function compileProject(request:CompileProjectRequest&{artifactSet:true|Omit<ArtifactSetOptions,'target'|'launch'>}):Promise<CheckedCompileResult<PackSetCompileResult>>;
export function compileProject(request:CompileProjectRequest):Promise<CheckedCompileResult>;
export async function compileProject(request: CompileProjectRequest) {
 try{
  assertBuildActive(request.signal);
  const typeEnvironment=request.environment.createTypeEnvironment(snapshotTextFiles(request.plan.snapshot));
  const diagnostics = checkProjectTypes(typeEnvironment,request.languageService?.use(typeEnvironment));
  if (diagnostics.some(item => item.category === 'error')) throw new EngineProjectBuildError(diagnostics.map(item => ({...item,
    category: item.category === 'error' ? 'error' : 'warning'})));
  const result = await compileBuildPlan(request.plan, request);
  return {...result, diagnostics: [...diagnostics, ...result.diagnostics] as CompilerDiagnostic[]};
 }finally{request.releaseSnapshot?.();}
}
