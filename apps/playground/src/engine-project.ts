import {prepareEngineProject as prepareCore,EngineProjectBuildError,type EngineProjectOptions as CoreOptions} from '@godot-js/project-tools/engine-project';
import {createSourceSnapshot,createBuildPlan,adaptLegacyLaunch,prepareBuildPlan,packPreparedProject,type ProjectLaunch,type OutputEntry} from '@godot-js/project-tools/build-plan';
import {prepareEngineProject as prepareReactProject,prepareLegacyBuildPlan,type EngineProjectOptions as LegacyOptions,type EngineProjectManifest,type EngineProjectDiagnostic} from '@godot-js/react-build/core';
import type {ImportReceipt,ImportInspection,LegacyImportObservation} from '@godot-js/project-tools/import-receipts';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
import type {ImportTarget} from '@godot-js/project-tools/import-receipts';
import type {ResourceImportRequest,ResourceConverterRegistry} from '@godot-js/project-tools/resource-converters';
import {ProjectToolError} from '@godot-js/project-tools/errors';

export {EngineProjectBuildError};
export type {EngineProjectManifest,EngineProjectDiagnostic,PreparedEngineProject} from '@godot-js/react-build/core';
export interface EngineProjectOptions extends Omit<LegacyOptions,'runtime'> {
 runtime:'godot'|'react'|'engine';
 /** A supplied launch explicitly selects the new scene/script contract. */
 launch?:ProjectLaunch;
 identityInputs?:Readonly<Record<string,unknown>>;
 importReceipts?:readonly ImportReceipt[];
 importCacheObservations?:readonly LegacyImportObservation[];
 importChecks?:readonly {receipt?:ImportReceipt;inspection:Omit<ImportInspection,'files'|'outputFiles'>}[];
 resourceImports?:readonly ResourceImportRequest[];
 resourceConverters?:ResourceConverterRegistry;
 resourceTarget?:ImportTarget;
}

// Retained synchronous compatibility API. Actual browser compilation uses the
// immutable snapshot/plan/overlay pipeline below, with one shared emitter.
export function prepareEngineProject(options:EngineProjectOptions) {
 return options.runtime==='react'&&options.launch===undefined?prepareReactProject({...options,runtime:'react'}):prepareCore(options);
}

export interface EngineProjectResult {
 pack:Uint8Array;manifest:EngineProjectManifest;diagnostics:EngineProjectDiagnostic[];
 index:Readonly<Record<string,{offset:number;size:number}>>;
 buildKey:string;
 artifactId:string;
 receipt:Awaited<ReturnType<typeof packPreparedProject>>['receipt'];
 overlay:readonly OutputEntry[];
}

/** Product path: read-only source -> explicit plan -> audited overlay -> PCK.
 * Existing runtime labels preserve their exact old launch semantics. New engine
 * projects require an explicit scene or ordinary script launch. */
export async function compileEngineProject(options:EngineProjectOptions):Promise<EngineProjectResult> {
 try{return await compileSnapshot(options);}catch(error){
  if(error instanceof ProjectToolError){
   const aliases:Record<string,string>={E_PROJECT_PATH:'E_ENGINE_PATH',E_PROJECT_PATH_COLLISION:'E_ENGINE_PATH_COLLISION',E_PROJECT_BYTES:'E_ENGINE_BYTES'};
   throw new EngineProjectBuildError([{code:aliases[error.code]??error.code,message:error.message,line:0,column:0,category:'error'}]);
  }
  throw error;
 }
}
async function compileSnapshot(options:EngineProjectOptions):Promise<EngineProjectResult>{
 const limits={maxBytes:options.maxBytes??256*1024*1024,maxFiles:options.maxFiles??10000};
 let plan;
 if(options.launch!==undefined){
  plan=await createBuildPlan(await createSourceSnapshot(options.files,limits),options.launch,{inputs:options.identityInputs});
 }else {
  if(options.runtime==='engine')throw new EngineProjectBuildError([{code:'E_PROJECT_LAUNCH',message:'Engine projects require an explicit scene or script launch',line:0,column:0,category:'error'}]);
  plan=await adaptLegacyLaunch({schemaVersion:3,runtime:options.runtime,files:options.files,
   ...(options.entry!==undefined?{entry:options.entry}:{}),...(options.entryExport!==undefined?{entryExport:options.entryExport}:{}),...(options.mainScene!==undefined?{mainScene:options.mainScene}:{})},
   {inputs:options.identityInputs,limits});
 }
 const compilerOptions:Omit<CoreOptions,'files'|'launch'|'entry'|'mainScene'>={
  ...(options.vendor?{vendor:options.vendor}:{}),...(options.runtimeModules?{runtimeModules:options.runtimeModules}:{}),
  ...(options.generatedJs?{generatedJs:options.generatedJs}:{}),maxBytes:limits.maxBytes,maxFiles:limits.maxFiles,
 };
 const buildOptions={compilerOptions,...(options.importChecks?{importChecks:options.importChecks}:{}),...(options.importReceipts?{storedImportReceipts:options.importReceipts}:{}),...(options.importCacheObservations?{importCacheObservations:options.importCacheObservations}:{}),
  ...(options.resourceImports?{resourceImports:options.resourceImports,resourceConverters:options.resourceConverters,resourceTarget:options.resourceTarget}:{})};
 const prepared=plan.compatibility?await prepareLegacyBuildPlan(plan,{...buildOptions,...(options.props?{props:options.props}:{})}):await prepareBuildPlan(plan,buildOptions);
 const artifact=await packPreparedProject(prepared,limits);
 const receipt=await assertArtifactReceipt(artifact.receipt,{pack:artifact.pack,buildKey:artifact.plan.buildKey});
 if(!receipt?.artifactId)throw Error('E_ARTIFACT_IDENTITY: Compiler must produce schema 2 receipts');
 return {pack:artifact.pack,index:artifact.index,manifest:artifact.prepared.manifest,diagnostics:artifact.prepared.diagnostics,
  buildKey:artifact.plan.buildKey,artifactId:receipt.artifactId,receipt:artifact.receipt,overlay:artifact.overlay.entries};
}
