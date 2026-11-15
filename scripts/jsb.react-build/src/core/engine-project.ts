import {prepareEngineProject as prepareCore,EngineProjectBuildError,runtimeModulePath,type EngineProjectOptions as CoreOptions} from '@godot-js/project-tools/engine-project';
import {emittedModulePath} from '@godot-js/project-tools/project-modules';
import {resourcePath} from '@godot-js/project-tools/paths';
import {reactBootstrap} from './react-startup.js';
import {prepareBuildPlan,type BuildPlan} from '@godot-js/project-tools/build-plan';
import {parseProjectLaunch} from '@godot-js/project-tools/launch';
export {EngineProjectBuildError,runtimeModulePath};
export type {EngineProjectManifest,EngineProjectDiagnostic,PreparedEngineProject} from '@godot-js/project-tools/engine-project';
export interface EngineProjectOptions extends Omit<CoreOptions,'runtime'|'startup'> {runtime:'godot'|'react';props?:Record<string,unknown>}
/** Compatibility adapter. All project emission and native resource handling share one core. */
export function prepareEngineProject(options:EngineProjectOptions){
 if(options.launch!==undefined){try{parseProjectLaunch(options.launch);}catch(error){throw new EngineProjectBuildError([{code:'E_PROJECT_LAUNCH',message:String(error),line:0,column:0,category:'error'}]);}}
 if(options.runtime!=='godot'&&options.runtime!=='react')throw new EngineProjectBuildError([{code:'E_ENGINE_RUNTIME',message:'Expected runtime "godot" or "react"',line:0,column:0,category:'error'}]);
 if(options.runtime!=='react')return prepareCore(options);
 const entry=options.entry?resourcePath(options.entry):undefined;
 if(!entry)throw new EngineProjectBuildError([{code:'E_ENGINE_ENTRY',message:'React projects require an existing JavaScript or TypeScript entry',line:0,column:0,category:'error'}]);
 try{return prepareCore({...options,launch:undefined,startup:{source:reactBootstrap(emittedModulePath(entry),options.entryExport??'default',options.props??{}),requiredModules:['react','@godot-js/react/engine'],vendorExports:{'react':'React','react/jsx-runtime':'jsxRuntime','react/jsx-dev-runtime':'jsxDevRuntime','@godot-js/react':'engineReact','@godot-js/react/engine':'engineReact','scheduler':'scheduler'}}});}
 catch(error){if(error instanceof EngineProjectBuildError)for(const item of error.diagnostics)if(item.code==='E_ENGINE_STARTUP_RUNTIME')item.code='E_ENGINE_REACT_RUNTIME';throw error;}
}

/** Execute a read-only legacy launch plan without interpreting component exports
 * as native Node classes. Startup bytes participate in the effective build key. */
export function prepareLegacyBuildPlan(plan:BuildPlan,options:Omit<NonNullable<Parameters<typeof prepareBuildPlan>[1]>,'prepare'|'adapterIdentity'>&{props?:Record<string,unknown>}={}){
 if(!plan.compatibility)throw new EngineProjectBuildError([{code:'E_PROJECT_SCHEMA',message:'Expected an adapted legacy plan',line:0,column:0,category:'error'}]);
 const runtime=plan.compatibility.runtime;
 const startup=runtime==='react'&&plan.launch.kind==='script'?{source:reactBootstrap(emittedModulePath(plan.launch.module),plan.launch.export??'default',options.props??{})}:undefined;
 return prepareBuildPlan(plan,{...options,adapterIdentity:'@godot-js/react-build/legacy-startup-v1',compilerOptions:{...options.compilerOptions,...(startup?{startup}:{})},prepare:core=>prepareEngineProject({...core,runtime,...(options.props?{props:options.props}:{})})});
}
