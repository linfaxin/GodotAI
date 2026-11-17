import {prepareEngineProject as prepareCore,EngineProjectBuildError,type EngineProjectOptions as CoreOptions} from '@godot-js/project-tools/engine-project';
import {createSourceSnapshot,createBuildPlan,adaptLegacyLaunch,packPreparedProject,type ProjectLaunch,type OutputEntry,type SourceSnapshot} from '@godot-js/project-tools/build-plan';
import {compileBuildPlan,type CompilerEnvironment,ProjectBuildCache,type CompileResult} from '@godot-js/project-tools/compiler';
import {prepareEngineProject as prepareReactProject,prepareLegacyBuildPlan,type EngineProjectOptions as LegacyOptions,type EngineProjectManifest,type EngineProjectDiagnostic} from '@godot-js/react-build/core';
import type {ImportReceipt,ImportInspection,LegacyImportObservation} from '@godot-js/project-tools/import-receipts';
import type {ImportTarget} from '@godot-js/project-tools/import-receipts';
import type {ResourceImportRequest,ResourceConverterRegistry} from '@godot-js/project-tools/resource-converters';
import {ProjectToolError} from '@godot-js/project-tools/errors';
import type {ArtifactSet,ArtifactSetOptions} from '@godot-js/project-tools/artifact-set';

export {EngineProjectBuildError};
export type {EngineProjectManifest,EngineProjectDiagnostic,PreparedEngineProject} from '@godot-js/react-build/core';
export interface EngineProjectOptions extends Omit<LegacyOptions,'runtime'> {
 runtime:'godot'|'react'|'engine';
 /** A supplied launch explicitly selects the new scene/script contract. */
 launch?:ProjectLaunch;
 identityInputs?:Readonly<Record<string,unknown>>;
 compilerEnvironment?:CompilerEnvironment;
 sourceSnapshot?:SourceSnapshot;
 buildCache?:ProjectBuildCache;
 signal?:AbortSignal;
 artifactSet?:boolean|Omit<ArtifactSetOptions,'target'|'launch'>;
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

export type EngineProjectResult=CompileResult;

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
 for(const [name,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1)throw new ProjectToolError('E_PROJECT_BUDGET','Invalid '+name);
 const packLimits={maxBytes:Math.min(limits.maxBytes,64*1024*1024),maxFiles:limits.maxFiles};
 let plan;
 if(options.launch!==undefined){
  plan=await createBuildPlan(options.sourceSnapshot??await createSourceSnapshot(options.files,limits),options.launch,{inputs:options.identityInputs});
 }else {
  if(options.runtime==='engine')throw new EngineProjectBuildError([{code:'E_PROJECT_LAUNCH',message:'Engine projects require an explicit scene or script launch',line:0,column:0,category:'error'}]);
  plan=await adaptLegacyLaunch({schemaVersion:3,runtime:options.runtime,files:options.files,
   ...(options.entry!==undefined?{entry:options.entry}:{}),...(options.entryExport!==undefined?{entryExport:options.entryExport}:{}),...(options.mainScene!==undefined?{mainScene:options.mainScene}:{})},
   {inputs:options.identityInputs,limits,snapshot:options.sourceSnapshot});
 }
 const compilerOptions:Omit<CoreOptions,'files'|'launch'|'entry'|'mainScene'>={
  ...(!options.compilerEnvironment&&options.vendor?{vendor:options.vendor}:{}),...(!options.compilerEnvironment&&options.runtimeModules?{runtimeModules:options.runtimeModules}:{}),
  ...(options.generatedJs?{generatedJs:options.generatedJs}:{}),...(!options.compilerEnvironment?{maxBytes:limits.maxBytes,maxFiles:limits.maxFiles}:{}),
 };
 const buildOptions={compilerOptions,...(options.importChecks?{importChecks:options.importChecks}:{}),...(options.importReceipts?{storedImportReceipts:options.importReceipts}:{}),...(options.importCacheObservations?{importCacheObservations:options.importCacheObservations}:{}),
  ...(options.resourceImports?{resourceImports:options.resourceImports,resourceConverters:options.resourceConverters,resourceTarget:options.resourceTarget}:{})};
 return compileBuildPlan(plan,{environment:options.compilerEnvironment,preparation:buildOptions,pack:packLimits,cache:options.buildCache,signal:options.signal,artifactSet:options.artifactSet,
  ...(plan.compatibility?{preparePlan:(input,preparation)=>prepareLegacyBuildPlan(input,{...preparation,...(options.props?{props:options.props}:{})})}:{})});
}
