import ts from "typescript";
import {engineModuleDeclaration} from '@godot-js/react/engine-modules';
import {decodeProjectText,readProjectBooleanSetting} from '@godot-js/react-build/project-settings';
import {prepareScriptRename} from '@godot-js/react-build/script-renames';
import {projectScript,projectModulePath} from '@godot-js/react-build/project-modules';
import {compileEngineProject} from "./engine-project";
import {loadReactModules,loadEngineRelease,fetchReleaseAsset} from "./engine-assets";
import {decodeBrowserImage} from "@godot-js/react-browser/assets";
import {prepareResourcePlan} from "./project-resources";
import {moduleCandidates} from "./module-resolution";
import type {TypeDiagnostic} from './compiler-types';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover'|'rename';source?:string;file?:string;files?:Record<string,string|number[]>;entry?:string;path?:string;newPath?:string;offset?:number;runtime?:'godot'|'react'|'legacy-react';mainScene?:string;mode?:'development'|'production'}
let declarations:Record<string,string>;
const ready=(async()=>{const response=await fetch('./engine-release.json');if(response.ok){const release=await loadEngineRelease();declarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(release.api.typeSnapshot)));}else{const types=await fetch('./types.json');if(!types.ok)throw Error('无法加载类型快照');declarations=await types.json();}})();
const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,jsx:ts.JsxEmit.React,strict:true,skipLibCheck:true,esModuleInterop:true,lib:['lib.es2022.d.ts'],ignoreDeprecations:'6.0',inlineSourceMap:true,inlineSources:true,resolveJsonModule:true,allowJs:true,rewriteRelativeImportExtensions:true,outDir:"/__emit"};
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data,{id,kind='compile'}=request;
 try{
  await ready;
  const runtime=request.runtime??'legacy-react';
  const allFiles=request.files??{['/src/'+request.file]:request.source??''};
  if(kind==='rename'){self.postMessage({id,renamePlan:prepareScriptRename(allFiles,request.path!,request.newPath!)});return;}
  let activeDeclarations=declarations;
  if(runtime!=='legacy-react'){
   const release=await loadEngineRelease(),configuration=decodeProjectText(allFiles['/project.godot']);
   const camel=readProjectBooleanSetting(configuration??'','GodotJS','runtime/core/camel_case_bindings_enabled')??false;
   const descriptor=release.api.namingProfiles?.[camel?'camel':'snake']?.typeSnapshot??(!camel?release.api.typeSnapshot:undefined);
   if(!descriptor)throw Error('当前引擎未提供 camel 命名类型快照');
   activeDeclarations=JSON.parse(new TextDecoder().decode(await fetchReleaseAsset(descriptor)));
  }
  const user=Object.fromEntries(Object.entries(allFiles).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),entry=request.entry??'/src/'+request.file;
  const snapshot={...activeDeclarations,...user},roots=Object.keys(user).filter(p=>projectScript.test(p));
  // The worker checks native projects; the shared core owns their sole emit
  // pass, including res:// and source-extension -> output-path rewriting.
  const compilerOptions=runtime==='legacy-react'?options:{...options,noEmit:true,allowImportingTsExtensions:true,rewriteRelativeImportExtensions:false};
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
   let code='',resources;
   if(kind==='compile'&&runtime==='legacy-react'&&!diagnostics.some(d=>d.category==='error'))resources=await prepareResourcePlan(allFiles,crypto.randomUUID(),(bytes,mime)=>decodeBrowserImage(bytes,mime,{}));
   if(kind==='compile'&&!diagnostics.some(d=>d.category==='error')){
    const modules:Record<string,string>={};
    program.emit(undefined,(_name,text,_bom,_err,sources)=>{if(sources?.length&&sources[0].fileName in user&&projectScript.test(sources[0].fileName))modules[sources[0].fileName]=text;});
    if(runtime!=='legacy-react'){
     const useReact=runtime==='react'||Object.values(user).some(text=>/[\"'](?:react|@godot-js\/react)(?:\/[^\"']*)?[\"']/.test(text));
     const release=await loadEngineRelease();
     const sdk=useReact?await loadReactModules(request.mode??'production'):{};
     const result=await compileEngineProject({files:allFiles,runtime,entry,mainScene:request.mainScene,generatedJs:modules,...sdk});
     self.postMessage({id,code:'',diagnostics:[...diagnostics,...result.diagnostics.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file}))],pack:result.pack,manifest:{...result.manifest,engineReleaseId:release.id}},[result.pack.buffer]);return;
    }
    code=`const __candidates=${moduleCandidates.toString()};const __external=require;const __modules={${Object.entries(modules).map(([p,c])=>JSON.stringify(p)+':function(require,module,exports){\n'+c+'\n}').join(',')}};const __json=${JSON.stringify(jsonFiles)};const __cache=Object.create(null);\n`+
     `function __load(name,from){if(['react','@godot-js/react','@playground/api'].includes(name))return __external(name);let path=name;if(name.startsWith('.')){let parts=from.split('/');parts.pop();for(const p of name.split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}path=parts.join('/');}const id=__candidates(path).find(p=>Object.hasOwn(__modules,p)||Object.hasOwn(__json,p));if(!id)throw Error('Unsupported module: '+name);if(Object.hasOwn(__json,id))return __json[id];if(__cache[id])return __cache[id].exports;const m={exports:{}};__cache[id]=m;__modules[id](n=>__load(n,id),m,m.exports);return m.exports;}module.exports=__load(${JSON.stringify(entry)},'/');`;
   }
   self.postMessage({id,code,diagnostics,resources});
  }finally{service.dispose();}
 }catch(error){const details=(error as any)?.diagnostics;self.postMessage({id,code:'',diagnostics:Array.isArray(details)?details.map(d=>({...d,file:d.file?.startsWith('res://')?'/'+d.file.slice(6):d.file})):[{message:String(error),line:0,column:0,code:0,category:'error'}],error:String(error)});}
};
