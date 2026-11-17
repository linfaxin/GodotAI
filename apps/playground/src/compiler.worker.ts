import ts from "typescript";
import {DemoSourceComposer} from './demo-source-files';
import {CompilerSourceReceiver,type SourceSyncPatch} from './compiler-source-sync';
import {HISTORICAL_REACT_MODULE_ADAPTER} from '@godot-js/react-build/imports';
import {ENGINE_SDK_MODULES} from '@godot-js/react/engine-modules';
import {createProjectTypeEnvironment,checkProjectTypes,ProjectLanguageService} from '@godot-js/project-tools/type-environment';
import {createCompilerEnvironment,compileResultMetadata,ProjectBuildCache,ProjectWorkspace} from '@godot-js/project-tools/compiler';
import {decodeProjectText,readProjectBooleanSetting} from '@godot-js/project-tools/project-settings';
import {prepareScriptRename} from '@godot-js/project-tools/script-renames';
import {compileEngineProject} from "./engine-project";
import {loadReactModules,loadEngineRelease,fetchReleaseAsset,loadDemoRuntime,loadDemoDeclarations,initializeReleaseContext,type ReleaseContext} from "./engine-assets";
import {DEMO_INPUT_SOURCE} from "./demo-input-source";
import type {TypeDiagnostic} from './compiler-types';
import {projectRuntimeDependencies} from './project-runtime-dependencies';
import {projectResourceConverters} from './project-resource-converters';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover'|'rename';source?:string;file?:string;files?:Record<string,string|number[]|Uint8Array>;sourceSync?:SourceSyncPatch;entry?:string;path?:string;newPath?:string;offset?:number;runtime?:'godot'|'react'|'engine';launch?:import('@godot-js/project-tools/build-plan').ProjectLaunch;importReceipts?:import('@godot-js/project-tools/import-receipts').ImportReceipt[];importCacheObservations?:readonly import('@godot-js/project-tools/import-receipts').LegacyImportObservation[];resourceImports?:import('@godot-js/project-tools/resource-converters').ResourceImportRequest[];mainScene?:string;controls?:Record<string,number>;mode?:'development'|'production';engineProfile?:string;demoApiVersion?:number;releaseContext?:ReleaseContext}
let declarations:Record<string,string>|undefined;
const languageService=new ProjectLanguageService(),buildCache=new ProjectBuildCache(),workspace=new ProjectWorkspace();
const compilerEnvironments=new Map<string,Promise<Awaited<ReturnType<typeof createCompilerEnvironment>>>>();
const demoSourceComposer=new DemoSourceComposer(),sourceReceiver=new CompilerSourceReceiver();
let capturedInputs:Readonly<Record<string,string|number[]|Uint8Array>>|undefined;
let buildSerial=0,activeBuild:AbortController|undefined,sourceRevision:unknown;
async function initialize(request:Request){
 if(!request.releaseContext)throw Error('E_RELEASE_CONTEXT_REQUIRED');
 const context=await initializeReleaseContext(request.releaseContext);
 if(request.engineProfile!==context.engineProfile)throw Error('E_PROJECT_ENGINE_PROFILE');
 if(!declarations){const release=await loadEngineRelease();declarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(release.api.typeSnapshot)));}
 return context;
}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data,{id,kind='compile'}=request;
 const observed=(request as Request&{revision?:number;documentId?:string});
 const revision=observed.revision===undefined?undefined:JSON.stringify([observed.documentId,observed.revision]);
 let serial=0,aborter:AbortController|undefined;
 const publish=(fields:Record<string,unknown>,transfer:Transferable[]=[])=>{
  if(aborter&&(aborter.signal.aborted||serial!==buildSerial)){self.postMessage({id,code:'',diagnostics:[],error:'E_BUILD_SUPERSEDED',cancelled:true,revision:observed.revision});return;}
  self.postMessage({...fields,revision:observed.revision},transfer);
 };
 try{
  // Admission is synchronous: later messages cannot mutate this revision's map.
  if(request.sourceSync&&(request.sourceSync.documentId!==observed.documentId||request.sourceSync.revision!==observed.revision))throw Error('E_SOURCE_SYNC: Request and source revision differ');
  const synchronized=request.sourceSync?sourceReceiver.apply(request.sourceSync):undefined;
  if(revision!==undefined&&revision!==sourceRevision){sourceRevision=revision;activeBuild?.abort(Error('E_BUILD_SUPERSEDED'));workspace.invalidate();}
  serial=kind==='compile'?++buildSerial:0;aborter=kind==='compile'?new AbortController():undefined;
  if(aborter){activeBuild?.abort(Error('E_BUILD_SUPERSEDED'));activeBuild=aborter;}
  const releaseContext=await initialize(request);
  const runtime=request.runtime??'react';
  if(runtime!=='godot'&&runtime!=='react'&&runtime!=='engine')throw Error('Unsupported engine launch');
  const allFiles=synchronized??request.files??{['/src/'+request.file]:request.source??''};
  if(kind==='rename'){publish({id,renamePlan:prepareScriptRename(allFiles,request.path!,request.newPath!)});return;}
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
  let moduleDeclarations:Record<string,string>={'godot':'/godot/index.d.ts','godot-jsb':'/godot-jsb/index.d.ts','godot.annotations':'/godot.annotations/index.d.ts',
   ...Object.fromEntries(Object.entries(sdkContract).map(([name,value])=>[name,value.declaration])),
   ...(Object.hasOwn(activeDeclarations,'/api.d.ts')?{'@playground/api':'/api.d.ts'}:{})};
  const historical=runtime==='react'&&request.launch===undefined?HISTORICAL_REACT_MODULE_ADAPTER:undefined;
  if(historical)moduleDeclarations=historical.apply({moduleDeclarations,runtimeImports:runtimeDependencies.modules}).moduleDeclarations;
  const typeEnvironment=createProjectTypeEnvironment({sources:allFiles,declarations:activeDeclarations,moduleDeclarations});
  const service=languageService.use(typeEnvironment);
  try{
   if(kind==='completion'){
    const result=service.getCompletionsAtPosition(request.path!,request.offset!,{includeCompletionsForModuleExports:true,includeCompletionsWithInsertText:true});
    publish({id,result:result?.entries.map(v=>({name:v.name,kind:v.kind,sortText:v.sortText,insertText:v.insertText}))??[]});return;
   }
   if(kind==='hover'){
    const v=service.getQuickInfoAtPosition(request.path!,request.offset!);publish({id,result:v?{start:v.textSpan.start,length:v.textSpan.length,display:ts.displayPartsToString(v.displayParts),documentation:ts.displayPartsToString(v.documentation)}:null});return;
   }
   const diagnostics:TypeDiagnostic[]=checkProjectTypes(typeEnvironment,service);
   if(kind==='compile'&&!diagnostics.some(d=>d.category==='error')){
    const usesDemo=runtimeDependencies.demo;
    // Demo helpers import React and the engine renderer even from native scripts.
    const useReact=runtime==='react'||runtimeDependencies.react;
    const sdk:Partial<Awaited<ReturnType<typeof loadReactModules>>>=useReact?await loadReactModules(request.mode??'production'):{};
    const demo=usesDemo?await loadDemoRuntime():undefined;
    if(demo&&request.demoApiVersion!==undefined&&request.demoApiVersion!==demo.demoApiVersion)throw Error('E_DEMO_API_VERSION');
    const files=demo?demoSourceComposer.compose(allFiles,demo,DEMO_INPUT_SOURCE):allFiles;
    const baseModules={...sdk.runtimeModules,...(demo?{'@playground/api':demo.runtime}:{})};
    const runtimeModules=historical?historical.apply({moduleDeclarations,runtimeModules:baseModules,runtimeImports:runtimeDependencies.modules}).runtimeModules!:baseModules;
    const environmentKey=JSON.stringify([release.id,naming,useReact,request.mode??'production',runtimeDependencies.demoTypes||usesDemo,demo?.demoDescriptorHash,historical?.id??'raw-engine']);
    let environmentPending=compilerEnvironments.get(environmentKey);
    if(!environmentPending){environmentPending=createCompilerEnvironment({target:{engineId:release.engineId??release.id,engineReleaseId:release.id,engineProfile:release.runtimeProfile,naming,
     ...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),...(historical?{compatibilityAdapter:historical.id}:{}),bindingVersion:release.api.bindingVersion??'unknown',
     ...((release.execution??release.engine.execution)?.artifactSetAbi===1?{artifactSetAbi:1}:{})},
     declarations:activeDeclarations,moduleDeclarations,runtimeModules,vendor:sdk.vendor});
     compilerEnvironments.set(environmentKey,environmentPending);void environmentPending.catch(()=>compilerEnvironments.delete(environmentKey));
     while(compilerEnvironments.size>8)compilerEnvironments.delete(compilerEnvironments.keys().next().value!);
    }
    const compilerEnvironment=await environmentPending;aborter?.signal.throwIfAborted();
    const previousInputs=capturedInputs,limits={maxBytes:256*1024*1024,maxFiles:10000};
    const captured=previousInputs?await workspace.captureChanges(Object.fromEntries(Object.entries(files).filter(([name,value])=>previousInputs[name]!==value)),Object.keys(previousInputs).filter(name=>!Object.hasOwn(files,name)),limits):await workspace.capture(files,limits);
    if(workspace.isCurrent(captured))capturedInputs=files;
    try{
    const result=await compileEngineProject({files,runtime,entry,mainScene:request.mainScene,...(request.launch!==undefined?{launch:request.launch}:{}),...(request.importReceipts?{importReceipts:request.importReceipts}:{}),...(request.importCacheObservations?{importCacheObservations:request.importCacheObservations}:{}),...(request.resourceImports?{resourceImports:request.resourceImports,resourceConverters:projectResourceConverters(),resourceTarget:{resourceAbi:'godot-4.6.1-resources-v2',features:{engineId:release.engineId??release.id}}}:{}),identityInputs:{engineProfile:release.runtimeProfile,engineId:release.engineId??release.id,...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),bindingVersion:release.api.bindingVersion??'unknown',typescriptVersion:ts.version},...sdk,
     sourceSnapshot:captured.source,buildCache,signal:aborter?.signal,artifactSet:(release.execution??release.engine.execution)?.artifactSetAbi===1,
     compilerEnvironment,...(demo?{runtimeModules,props:{controls:request.controls??{}}}:{}),
    });
    const payload={id,variant:result.variant,code:'',diagnostics:[...diagnostics,...result.diagnostics.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file}))],manifest:{...compileResultMetadata(result),...(release.engineId?{engineId:release.engineId}:{}),...(useReact&&release.extensionId?{extensionId:release.extensionId}:{}),engineReleaseId:release.id,engineProfile:release.runtimeProfile,releaseContext,...(demo?{demoApiVersion:demo.demoApiVersion,demoDescriptorHash:demo.demoDescriptorHash}:{})}};
    if(result.variant==='pack-set')publish({...payload,artifactSet:result.artifactSet},[...result.artifactSet.packs.values()].map(bytes=>bytes.buffer as ArrayBuffer));
    else publish({...payload,pack:result.pack},[result.pack.buffer]);
    return;
    }finally{captured.release();}
   }
   publish({id,code:'',diagnostics});
  }finally{if(aborter&&activeBuild===aborter)activeBuild=undefined;}
 }catch(error){const details=(error as any)?.diagnostics;publish({id,code:'',diagnostics:Array.isArray(details)?details.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file})):[{message:String(error),line:0,column:0,code:0,category:'error'}],error:String(error),...(String(error).includes('E_SOURCE_SYNC')?{sourceSyncReset:true}:{})});}
};
