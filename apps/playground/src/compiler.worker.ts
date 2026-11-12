import ts from "typescript";
import {engineModuleDeclaration} from '@godot-js/react/engine-modules';
import {decodeProjectText,readProjectBooleanSetting} from '@godot-js/react-build/project-settings';
import {prepareScriptRename} from '@godot-js/react-build/script-renames';
import {projectScript,projectModulePath} from '@godot-js/react-build/project-modules';
import {compileEngineProject} from "./engine-project";
import {loadReactModules,loadEngineRelease,fetchReleaseAsset,loadDemoRuntime,loadDemoDeclarations,initializeReleaseContext,type ReleaseContext} from "./engine-assets";
import {DEMO_INPUT_SOURCE} from "./demo-input-source";
import {moduleCandidates} from "./module-resolution";
import type {TypeDiagnostic} from './compiler-types';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover'|'rename';source?:string;file?:string;files?:Record<string,string|number[]>;entry?:string;path?:string;newPath?:string;offset?:number;runtime?:'godot'|'react';mainScene?:string;controls?:Record<string,number>;mode?:'development'|'production';engineProfile?:string;demoApiVersion?:number;releaseContext?:ReleaseContext}
let declarations:Record<string,string>|undefined;
async function initialize(request:Request){
 if(!request.releaseContext)throw Error('E_RELEASE_CONTEXT_REQUIRED');
 const context=await initializeReleaseContext(request.releaseContext);
 if(request.engineProfile!==context.engineProfile)throw Error('E_PROJECT_ENGINE_PROFILE');
 if(!declarations){const release=await loadEngineRelease();declarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(release.api.typeSnapshot)));}
 return context;
}
const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,jsx:ts.JsxEmit.React,strict:true,skipLibCheck:true,esModuleInterop:true,lib:['lib.es2022.d.ts'],ignoreDeprecations:'6.0',inlineSourceMap:true,inlineSources:true,resolveJsonModule:true,allowJs:true,rewriteRelativeImportExtensions:true,outDir:"/__emit"};
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data,{id,kind='compile'}=request;
 try{
  const releaseContext=await initialize(request);
  const runtime=request.runtime??'react';
  if(runtime!=='godot'&&runtime!=='react')throw Error('项目运行模式仅支持 godot 和 react');
  const allFiles=request.files??{['/src/'+request.file]:request.source??''};
  if(kind==='rename'){self.postMessage({id,renamePlan:prepareScriptRename(allFiles,request.path!,request.newPath!)});return;}
  let activeDeclarations=declarations!;
  {
   const release=await loadEngineRelease(),configuration=decodeProjectText(allFiles['/project.godot']);
   const camel=readProjectBooleanSetting(configuration??'','GodotJS','runtime/core/camel_case_bindings_enabled')??false;
   const descriptor=release.api.namingProfiles?.[camel?'camel':'snake']?.typeSnapshot??(!camel?release.api.typeSnapshot:undefined);
   if(!descriptor)throw Error('当前引擎未提供 camel 命名类型快照');
   activeDeclarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(descriptor)));
  }
  const user=Object.fromEntries(Object.entries(allFiles).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),entry=request.entry??'/src/'+request.file;
  if(Object.values(user).some(text=>/["']@playground\/api["']/.test(text)))activeDeclarations={...activeDeclarations,'/api.d.ts':await loadDemoDeclarations()};
  const snapshot={...activeDeclarations,...user},roots=Object.keys(user).filter(p=>projectScript.test(p));
  // The worker checks native projects; the shared core owns their sole emit
  // pass, including res:// and source-extension -> output-path rewriting.
  const compilerOptions={...options,noEmit:true,allowImportingTsExtensions:true,rewriteRelativeImportExtensions:false};
  const resolve=(name:string,from:string):ts.ResolvedModule|undefined=>{
   const fixed:Record<string,string>={'@playground/api':'/api.d.ts','godot':'/godot/index.d.ts','godot-jsb':'/godot-jsb/index.d.ts','godot.annotations':'/godot.annotations/index.d.ts'};
   const base=projectModulePath(name,from);
   const file=fixed[name]??engineModuleDeclaration(name,runtime)??(base?moduleCandidates(base).find(p=>p in snapshot):undefined);
   return file&&file in snapshot?{resolvedFileName:file,isExternalLibraryImport:!(file in user)}:undefined;
  };
  const host:ts.LanguageServiceHost={getScriptFileNames:()=>[...roots,...Object.keys(activeDeclarations).filter(name=>name.startsWith('/godot/')||name.startsWith('/godot-jsb/')||name.startsWith('/godot.annotations/'))],getScriptVersion:()=> '1',getScriptSnapshot:name=>name in snapshot?ts.ScriptSnapshot.fromString(snapshot[name]):undefined,getCompilationSettings:()=>compilerOptions,getCurrentDirectory:()=> '/',getDefaultLibFileName:()=>'/lib/lib.es2022.d.ts',fileExists:name=>name in snapshot,readFile:name=>snapshot[name],readDirectory:()=>[],resolveModuleNames:(names,from)=>names.map(n=>resolve(n,from))};
  const service=ts.createLanguageService(host);
  try{
   if(kind==='completion'){
    const result=service.getCompletionsAtPosition(request.path!,request.offset!,{includeCompletionsForModuleExports:true,includeCompletionsWithInsertText:true});
    self.postMessage({id,result:result?.entries.map(v=>({name:v.name,kind:v.kind,sortText:v.sortText,insertText:v.insertText}))??[]});return;
   }
   if(kind==='hover'){
    const v=service.getQuickInfoAtPosition(request.path!,request.offset!);self.postMessage({id,result:v?{start:v.textSpan.start,length:v.textSpan.length,display:ts.displayPartsToString(v.displayParts),documentation:ts.displayPartsToString(v.documentation)}:null});return;
   }
   const program=service.getProgram()!;
   const diagnostics:TypeDiagnostic[]=ts.getPreEmitDiagnostics(program).filter(d=>!d.file||d.file.fileName in user).map(d=>{
    const p=d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start):undefined;
    return {file:d.file?.fileName,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),line:p?p.line+1:0,column:p?p.character+1:0,start:d.start,length:d.length,code:d.code,category:d.category===ts.DiagnosticCategory.Error?'error':d.category===ts.DiagnosticCategory.Warning?'warning':'info'};
   });
   // Match TypeScript's dependency graph: unrelated JSON is not executable input.
   // Parse reachable JSON for both checks and builds, with a navigable diagnostic.
   const jsonFiles:Record<string,unknown>={};
   for(const source of program.getSourceFiles().filter(s=>s.fileName in user&&s.fileName.endsWith('.json'))){
    try{jsonFiles[source.fileName]=JSON.parse(source.text);}
    catch(error){
     if(diagnostics.some(d=>d.file===source.fileName&&d.category==='error'))continue;
     const message=String(error),match=/position (\d+)/.exec(message),location=/line (\d+) column (\d+)/.exec(message);
     const start=match?Number(match[1]):location?source.getPositionOfLineAndCharacter(Number(location[1])-1,Number(location[2])-1):source.text.length;
     const point=source.getLineAndCharacterOfPosition(start);
     diagnostics.push({file:source.fileName,message,line:point.line+1,column:point.character+1,start,length:1,code:0,category:'error'});
    }
   }
   if(kind==='compile'&&!diagnostics.some(d=>d.category==='error')){
    const usesDemo=Object.values(user).some(text=>/["']@playground\/api["']/.test(text));
    // Demo helpers import React and the engine renderer even from native scripts.
    const useReact=usesDemo||runtime==='react'||Object.values(user).some(text=>/["'](?:react|@godot-js\/react)(?:\/[^"']*)?["']/.test(text));
    const release=await loadEngineRelease();
    const sdk:Partial<Awaited<ReturnType<typeof loadReactModules>>>=useReact?await loadReactModules(request.mode??'production'):{};
    const demo=usesDemo?await loadDemoRuntime():undefined;
    if(demo&&request.demoApiVersion!==undefined&&request.demoApiVersion!==demo.demoApiVersion)throw Error('E_DEMO_API_VERSION');
    const files=demo?{...allFiles,'/.playground/demo-input.ts':DEMO_INPUT_SOURCE,'/.playground/demo-resources.pck':Array.from(demo.resources)}:allFiles;
    const result=await compileEngineProject({files,runtime,entry,mainScene:request.mainScene,...sdk,
     ...(demo?{runtimeModules:{...sdk.runtimeModules,'@playground/api':demo.runtime},props:{controls:request.controls??{}}}:{}),
    });
    self.postMessage({id,code:'',diagnostics:[...diagnostics,...result.diagnostics.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file}))],pack:result.pack,manifest:{...result.manifest,engineReleaseId:release.id,engineProfile:release.runtimeProfile,releaseContext,...(demo?{demoApiVersion:demo.demoApiVersion,demoDescriptorHash:demo.demoDescriptorHash}:{})}},[result.pack.buffer]);return;
   }
   self.postMessage({id,code:'',diagnostics});
  }finally{service.dispose();}
 }catch(error){const details=(error as any)?.diagnostics;self.postMessage({id,code:'',diagnostics:Array.isArray(details)?details.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file})):[{message:String(error),line:0,column:0,code:0,category:'error'}],error:String(error)});}
};
