import ts from "typescript";
import {DemoSourceComposer} from './demo-source-files';
import {CompilerSourceReceiver,type SourceSyncPatch} from './compiler-source-sync';
import {HISTORICAL_REACT_MODULE_ADAPTER} from '@godot-js/react-build/imports';
import {checkProjectTypes,snapshotTextFiles,ProjectLanguageService} from '@godot-js/project-tools/type-environment';
import {createCompilerEnvironment,compileResultMetadata,ProjectBuildCache,ProjectWorkspace,type CompilerEnvironment} from '@godot-js/project-tools/compiler';
import {prepareCompilerEnvironmentInput,type CompilerEnvironmentInputFacts,type RuntimeSelection} from '@godot-js/project-tools/environment';
import {decodeProjectText,readProjectBooleanSetting} from '@godot-js/project-tools/project-settings';
import {ProjectToolError} from '@godot-js/project-tools/errors';
import {prepareScriptRename} from '@godot-js/project-tools/script-renames';
import {compileEngineProject} from "./engine-project";
import {loadReleaseInputs,readReleaseRawAsset,loadDemoRuntime,loadDemoDeclarations,initializeReleaseContext,type ReleaseContext} from "./engine-assets";
import {DEMO_INPUT_SOURCE} from "./demo-input-source";
import type {TypeDiagnostic} from './compiler-types';
import {projectRuntimeDependencies} from './project-runtime-dependencies';
import {projectResourceConverters} from './project-resource-converters';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover'|'rename';source?:string;file?:string;files?:Record<string,string|number[]|Uint8Array>;sourceSync?:SourceSyncPatch;entry?:string;path?:string;newPath?:string;offset?:number;runtime?:'godot'|'react'|'engine';launch?:import('@godot-js/project-tools/build-plan').ProjectLaunch;importReceipts?:import('@godot-js/project-tools/import-receipts').ImportReceipt[];importCacheObservations?:readonly import('@godot-js/project-tools/import-receipts').LegacyImportObservation[];resourceImports?:import('@godot-js/project-tools/resource-converters').ResourceImportRequest[];mainScene?:string;controls?:Record<string,number>;mode?:'development'|'production';engineProfile?:string;demoApiVersion?:number;releaseContext?:ReleaseContext}
interface PreparedEnvironment {environment:CompilerEnvironment;facts:Readonly<CompilerEnvironmentInputFacts>}
const languageService=new ProjectLanguageService(),buildCache=new ProjectBuildCache(),workspace=new ProjectWorkspace();
// A pending environment belongs to its requesting operation and AbortSignal.
// Only completed environments can be reused by another request.
const compilerEnvironments=new Map<string,PreparedEnvironment>();
const demoSourceComposer=new DemoSourceComposer(),sourceReceiver=new CompilerSourceReceiver();
let capturedInputs:Readonly<Record<string,string|number[]|Uint8Array>>|undefined;
let buildSerial=0,activeBuild:AbortController|undefined,sourceRevision:unknown;
async function initialize(request:Request){
 if(!request.releaseContext)throw Error('E_RELEASE_CONTEXT_REQUIRED');
 const context=await initializeReleaseContext(request.releaseContext);
 if(request.engineProfile!==context.engineProfile)throw Error('E_PROJECT_ENGINE_PROFILE');
 return context;
}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request={...event.data},{id,kind='compile'}=request;
 const observed=(request as Request&{revision?:number;documentId?:string});
 const revision=observed.revision===undefined?undefined:JSON.stringify([observed.documentId,observed.revision]);
 let serial=0,aborter:AbortController|undefined;
 let association:Record<string,unknown>|undefined;
 const publish=(fields:Record<string,unknown>,transfer:Transferable[]=[])=>{
  if(aborter&&(aborter.signal.aborted||serial!==buildSerial)){self.postMessage({id,...association,code:'',diagnostics:[],error:'E_BUILD_SUPERSEDED',cancelled:true,revision:observed.revision});return;}
  self.postMessage({...association,...fields,revision:observed.revision},transfer);
 };
 try{
  // The source receiver owns these immutable revision maps before any await.
  if(request.sourceSync&&(request.sourceSync.documentId!==observed.documentId||request.sourceSync.revision!==observed.revision))throw Error('E_SOURCE_SYNC: Request and source revision differ');
  const synchronized=request.sourceSync?sourceReceiver.apply(request.sourceSync):undefined;
  const allFiles=synchronized??request.files??{['/src/'+request.file]:request.source??''};
  if(revision!==undefined&&revision!==sourceRevision){sourceRevision=revision;activeBuild?.abort(Error('E_BUILD_SUPERSEDED'));workspace.invalidate();}
  serial=kind==='compile'?++buildSerial:0;aborter=kind==='compile'?new AbortController():undefined;
  if(aborter){activeBuild?.abort(Error('E_BUILD_SUPERSEDED'));activeBuild=aborter;}
  const releaseContext=await initialize(request);aborter?.signal.throwIfAborted();
  const runtime=request.runtime??'react';
  if(runtime!=='godot'&&runtime!=='react'&&runtime!=='engine')throw Error('Unsupported engine launch');
  if(kind==='rename'){publish({id,renamePlan:prepareScriptRename(allFiles,request.path!,request.newPath!)});return;}
  const configuration=decodeProjectText(allFiles['/project.godot']);
  const naming=readProjectBooleanSetting(configuration??'','GodotJS','runtime/core/camel_case_bindings_enabled')?'camel':'snake';
  const user=Object.fromEntries(Object.entries(allFiles).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  const runtimeDependencies=projectRuntimeDependencies(user);
  const selection:RuntimeSelection=runtime==='react'||runtimeDependencies.react?{kind:'sdk',mode:request.mode??'production'}:{kind:'engine'};
  const historical=runtime==='react'&&request.launch===undefined?HISTORICAL_REACT_MODULE_ADAPTER:undefined;
  const demo=runtimeDependencies.demo?await loadDemoRuntime():undefined;
  aborter?.signal.throwIfAborted();
  if(demo&&request.demoApiVersion!==undefined&&request.demoApiVersion!==demo.demoApiVersion)throw Error('E_DEMO_API_VERSION');
  // Demo source is part of both the typecheck and the checked build snapshot.
  const files=demo?demoSourceComposer.compose(allFiles,demo,DEMO_INPUT_SOURCE):allFiles;
  const demoTypes=runtimeDependencies.demoTypes||runtimeDependencies.demo;
  const environmentKey=JSON.stringify([releaseContext.engineReleaseId,releaseContext.descriptorHash,naming,selection,
   demoTypes?releaseContext.demoDescriptorHash:null,historical?.id??null,[...runtimeDependencies.modules].sort()]);
  let prepared=compilerEnvironments.get(environmentKey);
  if(!prepared){
   const releaseInput=await loadReleaseInputs();aborter?.signal.throwIfAborted();
   const base=await prepareCompilerEnvironmentInput({descriptorBytes:releaseInput.descriptorBytes,naming,selection,readRawAsset:readReleaseRawAsset,signal:aborter?.signal});
   if(base.facts.release.releaseId!==releaseContext.engineReleaseId||base.facts.release.engineProfile!==releaseContext.engineProfile||base.facts.release.descriptorSha256!==releaseContext.descriptorHash)throw Error('E_RELEASE_CONTEXT_MISMATCH');
   const declarations=demoTypes?{...base.input.declarations,'/api.d.ts':await loadDemoDeclarations()}:base.input.declarations;
   let moduleDeclarations:Record<string,string>={...base.input.moduleDeclarations,...(demoTypes?{'@playground/api':'/api.d.ts'}:{})};
   let runtimeModules:Record<string,Uint8Array>={...base.input.runtimeModules,...(demo?{'@playground/api':demo.runtime}:{})};
   if(historical){const adapted=historical.apply({moduleDeclarations,runtimeModules,runtimeImports:runtimeDependencies.modules});moduleDeclarations=adapted.moduleDeclarations;runtimeModules=adapted.runtimeModules!;}
   const environment=await createCompilerEnvironment({...base.input,declarations,moduleDeclarations,runtimeModules,
    target:{...base.input.target,...(historical?{compatibilityAdapter:historical.id}:{})}});
   aborter?.signal.throwIfAborted();
   prepared={environment,facts:base.facts};
   compilerEnvironments.set(environmentKey,prepared);
   while(compilerEnvironments.size>8)compilerEnvironments.delete(compilerEnvironments.keys().next().value!);
  }
  aborter?.signal.throwIfAborted();
  const {environment:compilerEnvironment,facts}=prepared,previousInputs=capturedInputs,limits={maxBytes:256*1024*1024,maxFiles:10000};
  const captured=previousInputs?await workspace.captureChanges(Object.fromEntries(Object.entries(files).filter(([name,value])=>previousInputs[name]!==value)),Object.keys(previousInputs).filter(name=>!Object.hasOwn(files,name)),limits):await workspace.capture(files,limits);
  if(workspace.isCurrent(captured))capturedInputs=files;
  try{
   aborter?.signal.throwIfAborted();
   association={sourceHash:captured.source.sourceHash,environmentFacts:facts,compilerIdentity:compilerEnvironment.identity};
   if(kind!=='compile'){
    // Queries remain useful while an entry or scene is incomplete.
    const typeEnvironment=compilerEnvironment.createTypeEnvironment(snapshotTextFiles(captured.source));
    const service=languageService.use(typeEnvironment);
    if(kind==='completion'){
     const result=service.getCompletionsAtPosition(request.path!,request.offset!,{includeCompletionsForModuleExports:true,includeCompletionsWithInsertText:true});
     publish({id,...association,result:result?.entries.map(v=>({name:v.name,kind:v.kind,sortText:v.sortText,insertText:v.insertText}))??[]});return;
    }
    if(kind==='hover'){
     const v=service.getQuickInfoAtPosition(request.path!,request.offset!);publish({id,...association,result:v?{start:v.textSpan.start,length:v.textSpan.length,display:ts.displayPartsToString(v.displayParts),documentation:ts.displayPartsToString(v.documentation)}:null});return;
    }
    const diagnostics:TypeDiagnostic[]=checkProjectTypes(typeEnvironment,service);
    publish({id,code:'',...association,diagnostics});return;
   }
   if(request.resourceImports?.length&&facts.resources.status!=='available')throw new ProjectToolError('E_RESOURCE_CONVERTER_TARGET',facts.resources.reason);
   const result=await compileEngineProject({files,runtime,entry:request.entry??'/src/'+request.file,mainScene:request.mainScene,
    ...(request.launch!==undefined?{launch:request.launch}:{}),...(request.importReceipts?{importReceipts:request.importReceipts}:{}),...(request.importCacheObservations?{importCacheObservations:request.importCacheObservations}:{}),
    ...(request.resourceImports?.length&&facts.resources.status==='available'?{resourceImports:request.resourceImports,resourceConverters:projectResourceConverters(),resourceTarget:facts.resources.target}:{}),
    sourceSnapshot:captured.source,buildCache,languageService,signal:aborter?.signal,artifactSet:facts.release.artifactSetAbi===1,
    compilerEnvironment,...(demo?{props:{controls:request.controls??{}}}:{}),
   });
   const payload={id,...association,variant:result.variant,code:'',diagnostics:result.diagnostics.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file})),
    manifest:{...compileResultMetadata(result),...(facts.release.engineId?{engineId:facts.release.engineId}:{}),...(facts.requiredExtensionId?{extensionId:facts.requiredExtensionId}:{}),
     engineReleaseId:facts.release.releaseId,engineProfile:facts.release.engineProfile,releaseContext,...(demo?{demoApiVersion:demo.demoApiVersion,demoDescriptorHash:demo.demoDescriptorHash}:{})}};
   // Cross-worker transfer never detaches buffers retained by the build cache.
   if(result.variant==='pack-set'){
    const artifactSet={...result.artifactSet,packs:new Map([...result.artifactSet.packs].map(([name,bytes])=>[name,bytes.slice()]))};
    publish({...payload,artifactSet},[...artifactSet.packs.values()].map(bytes=>bytes.buffer as ArrayBuffer));
   }else{
    const pack=result.pack.slice();publish({...payload,pack},[pack.buffer]);
   }
  }finally{captured.release();}
 }catch(error){
  const details=(error as {diagnostics?:unknown})?.diagnostics;
  const message=String(error),errorCode=error instanceof ProjectToolError?error.code:undefined;
  const diagnostics=Array.isArray(details)
   ?details.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file}))
   :[{message,line:0,column:0,code:errorCode??0,category:'error'}];
  publish({id,code:'',diagnostics,error:message,...(errorCode?{errorCode}:{}),...(message.includes('E_SOURCE_SYNC')?{sourceSyncReset:true}:{})});
 }
 finally{if(aborter&&activeBuild===aborter)activeBuild=undefined;}
};
