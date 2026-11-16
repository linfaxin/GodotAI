import ts from "typescript";
import {ENGINE_SDK_MODULES} from '@godot-js/react/engine-modules';
import {createProjectTypeEnvironment,checkProjectTypes} from '@godot-js/project-tools/type-environment';
import {createCompilerEnvironment} from '@godot-js/project-tools/compiler';
import {decodeProjectText,readProjectBooleanSetting} from '@godot-js/project-tools/project-settings';
import {prepareScriptRename} from '@godot-js/project-tools/script-renames';
import {compileEngineProject} from "./engine-project";
import {loadReactModules,loadEngineRelease,fetchReleaseAsset,loadDemoRuntime,loadDemoDeclarations,initializeReleaseContext,type ReleaseContext} from "./engine-assets";
import {DEMO_INPUT_SOURCE} from "./demo-input-source";
import type {TypeDiagnostic} from './compiler-types';
import {projectRuntimeDependencies} from './project-runtime-dependencies';
import {projectResourceConverters} from './project-resource-converters';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover'|'rename';source?:string;file?:string;files?:Record<string,string|number[]>;entry?:string;path?:string;newPath?:string;offset?:number;runtime?:'godot'|'react'|'engine';launch?:import('@godot-js/project-tools/build-plan').ProjectLaunch;importReceipts?:import('@godot-js/project-tools/import-receipts').ImportReceipt[];importCacheObservations?:readonly import('@godot-js/project-tools/import-receipts').LegacyImportObservation[];resourceImports?:import('@godot-js/project-tools/resource-converters').ResourceImportRequest[];mainScene?:string;controls?:Record<string,number>;mode?:'development'|'production';engineProfile?:string;demoApiVersion?:number;releaseContext?:ReleaseContext}
let declarations:Record<string,string>|undefined;
async function initialize(request:Request){
 if(!request.releaseContext)throw Error('E_RELEASE_CONTEXT_REQUIRED');
 const context=await initializeReleaseContext(request.releaseContext);
 if(request.engineProfile!==context.engineProfile)throw Error('E_PROJECT_ENGINE_PROFILE');
 if(!declarations){const release=await loadEngineRelease();declarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(release.api.typeSnapshot)));}
 return context;
}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data,{id,kind='compile'}=request;
 try{
  const releaseContext=await initialize(request);
  const runtime=request.runtime??'react';
  if(runtime!=='godot'&&runtime!=='react'&&runtime!=='engine')throw Error('Unsupported engine launch');
  const allFiles=request.files??{['/src/'+request.file]:request.source??''};
  if(kind==='rename'){self.postMessage({id,renamePlan:prepareScriptRename(allFiles,request.path!,request.newPath!)});return;}
  const release=await loadEngineRelease();
  let activeDeclarations=declarations!;
  let naming:'snake'|'camel'='snake';
  {
   const configuration=decodeProjectText(allFiles['/project.godot']);
   const camel=readProjectBooleanSetting(configuration??'','GodotJS','runtime/core/camel_case_bindings_enabled')??false;
   naming=camel?'camel':'snake';
   const descriptor=release.api.namingProfiles?.[camel?'camel':'snake']?.typeSnapshot??(!camel?release.api.typeSnapshot:undefined);
   if(!descriptor)throw Error('当前引擎未提供 camel 命名类型快照');
   activeDeclarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(descriptor)));
  }
  const user=Object.fromEntries(Object.entries(allFiles).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),entry=request.entry??'/src/'+request.file;
  const runtimeDependencies=projectRuntimeDependencies(user);
  if(runtimeDependencies.demoTypes||runtimeDependencies.demo)activeDeclarations={...activeDeclarations,'/api.d.ts':await loadDemoDeclarations()};
  const sdkContract=(release.sdk as typeof release.sdk&{moduleContract?:Record<string,{declaration:string}>}).moduleContract??ENGINE_SDK_MODULES;
  const moduleDeclarations={'godot':'/godot/index.d.ts','godot-jsb':'/godot-jsb/index.d.ts','godot.annotations':'/godot.annotations/index.d.ts',
   ...Object.fromEntries(Object.entries(sdkContract).map(([name,value])=>[name,value.declaration])),
   ...(Object.hasOwn(activeDeclarations,'/api.d.ts')?{'@playground/api':'/api.d.ts'}:{})};
  const typeEnvironment=createProjectTypeEnvironment({sources:allFiles,declarations:activeDeclarations,moduleDeclarations});
  const service=typeEnvironment.createLanguageService();
  try{
   if(kind==='completion'){
    const result=service.getCompletionsAtPosition(request.path!,request.offset!,{includeCompletionsForModuleExports:true,includeCompletionsWithInsertText:true});
    self.postMessage({id,result:result?.entries.map(v=>({name:v.name,kind:v.kind,sortText:v.sortText,insertText:v.insertText}))??[]});return;
   }
   if(kind==='hover'){
    const v=service.getQuickInfoAtPosition(request.path!,request.offset!);self.postMessage({id,result:v?{start:v.textSpan.start,length:v.textSpan.length,display:ts.displayPartsToString(v.displayParts),documentation:ts.displayPartsToString(v.documentation)}:null});return;
   }
   const diagnostics:TypeDiagnostic[]=checkProjectTypes(typeEnvironment,service);
   if(kind==='compile'&&!diagnostics.some(d=>d.category==='error')){
    const usesDemo=runtimeDependencies.demo;
    // Demo helpers import React and the engine renderer even from native scripts.
    const useReact=runtime==='react'||runtimeDependencies.react;
    const sdk:Partial<Awaited<ReturnType<typeof loadReactModules>>>=useReact?await loadReactModules(request.mode??'production'):{};
    const demo=usesDemo?await loadDemoRuntime():undefined;
    if(demo&&request.demoApiVersion!==undefined&&request.demoApiVersion!==demo.demoApiVersion)throw Error('E_DEMO_API_VERSION');
    const files=demo?{...allFiles,'/.playground/demo-input.ts':DEMO_INPUT_SOURCE,'/.playground/demo-resources.pck':demo.resources}:allFiles;
    const runtimeModules={...sdk.runtimeModules,...(demo?{'@playground/api':demo.runtime}:{})};
    const compilerEnvironment=await createCompilerEnvironment({target:{engineId:release.engineId??release.id,engineReleaseId:release.id,engineProfile:release.runtimeProfile,naming,
     ...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),bindingVersion:release.api.bindingVersion??'unknown'},
     declarations:activeDeclarations,moduleDeclarations,runtimeModules,vendor:sdk.vendor});
    const result=await compileEngineProject({files,runtime,entry,mainScene:request.mainScene,...(request.launch!==undefined?{launch:request.launch}:{}),...(request.importReceipts?{importReceipts:request.importReceipts}:{}),...(request.importCacheObservations?{importCacheObservations:request.importCacheObservations}:{}),...(request.resourceImports?{resourceImports:request.resourceImports,resourceConverters:projectResourceConverters(),resourceTarget:{resourceAbi:'godot-4-text-resource-v1',features:{engineId:release.engineId??release.id}}}:{}),identityInputs:{engineProfile:release.runtimeProfile,engineId:release.engineId??release.id,...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),bindingVersion:release.api.bindingVersion??'unknown',typescriptVersion:ts.version},...sdk,
     compilerEnvironment,...(demo?{runtimeModules,props:{controls:request.controls??{}}}:{}),
    });
    self.postMessage({id,code:'',diagnostics:[...diagnostics,...result.diagnostics.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file}))],pack:result.pack,manifest:{...result.manifest,buildKey:result.buildKey,artifactId:result.artifactId,artifactReceipt:result.receipt,outputOverlay:result.overlay,...(release.engineId?{engineId:release.engineId}:{}),...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),engineReleaseId:release.id,engineProfile:release.runtimeProfile,releaseContext,...(demo?{demoApiVersion:demo.demoApiVersion,demoDescriptorHash:demo.demoDescriptorHash}:{})}},[result.pack.buffer]);return;
   }
   self.postMessage({id,code:'',diagnostics});
  }finally{service.dispose();}
 }catch(error){const details=(error as any)?.diagnostics;self.postMessage({id,code:'',diagnostics:Array.isArray(details)?details.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file})):[{message:String(error),line:0,column:0,code:0,category:'error'}],error:String(error)});}
};
