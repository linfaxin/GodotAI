import ts from "typescript";
import type {TypeDiagnostic} from './compiler-types';
interface Request {id:number;kind?:'compile'|'check'|'completion'|'hover';source?:string;file?:string;files?:Record<string,string>;entry?:string;path?:string;offset?:number}
let declarations:Record<string,string>;
const ready=fetch('./types.json').then(async r=>{if(!r.ok)throw Error('无法加载类型快照');declarations=await r.json();});
const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,jsx:ts.JsxEmit.React,strict:true,skipLibCheck:true,esModuleInterop:true,lib:['lib.es2022.d.ts'],ignoreDeprecations:'6.0',inlineSourceMap:true,inlineSources:true,resolveJsonModule:true,allowJs:true,outDir:"/__emit"};
function normalize(path:string){const parts:string[]=[];for(const p of path.split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}return '/'+parts.join('/');}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data,{id,kind='compile'}=request;
 try{
  await ready;
  const user=request.files??{['/src/'+request.file]:request.source??''},entry=request.entry??'/src/'+request.file;
  const snapshot={...declarations,...user},roots=Object.keys(user).filter(p=>/\.[jt]sx?$/.test(p));
  const resolve=(name:string,from:string):ts.ResolvedModule|undefined=>{
   const fixed:Record<string,string>={react:'/react/index.d.ts','@godot-js/react':'/sdk/index.d.ts','@playground/api':'/api.d.ts'};
   const base=name.startsWith('.')?normalize(from.slice(0,from.lastIndexOf('/')+1)+name):'';
   const clean=base.replace(/\.[jt]sx?$/,'');
   const file=fixed[name]??(base?[base,clean+'.ts',clean+'.tsx',clean+'.js',clean+'.jsx',clean+'.d.ts',base+'.d.ts',base+'/index.ts',base+'/index.tsx',base+'/index.d.ts',base+'.json'].find(p=>p in snapshot):undefined);
   return file&&file in snapshot?{resolvedFileName:file,isExternalLibraryImport:!(file in user)}:undefined;
  };
  const host:ts.LanguageServiceHost={getScriptFileNames:()=>roots,getScriptVersion:()=> '1',getScriptSnapshot:name=>name in snapshot?ts.ScriptSnapshot.fromString(snapshot[name]):undefined,getCompilationSettings:()=>options,getCurrentDirectory:()=> '/',getDefaultLibFileName:()=>'/lib/lib.es2022.d.ts',fileExists:name=>name in snapshot,readFile:name=>snapshot[name],readDirectory:()=>[],resolveModuleNames:(names,from)=>names.map(n=>resolve(n,from))};
  const service=ts.createLanguageService(host);
  try{
   if(kind==='completion'){
    const result=service.getCompletionsAtPosition(request.path!,request.offset!,{includeCompletionsForModuleExports:true,includeCompletionsWithInsertText:true});
    self.postMessage({id,result:result?.entries.slice(0,300).map(v=>({name:v.name,kind:v.kind,sortText:v.sortText,insertText:v.insertText}))??[]});return;
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
   let code='';
   if(kind==='compile'&&!diagnostics.some(d=>d.category==='error')){
    const modules:Record<string,string>={};
    program.emit(undefined,(_name,text,_bom,_err,sources)=>{if(sources?.length&&sources[0].fileName in user&&/\.[jt]sx?$/.test(sources[0].fileName))modules[sources[0].fileName]=text;});
    code=`const __external=require;const __modules={${Object.entries(modules).map(([p,c])=>JSON.stringify(p)+':function(require,module,exports){\n'+c+'\n}').join(',')}};const __json=${JSON.stringify(jsonFiles)};const __cache=Object.create(null);\n`+
     `function __load(name,from){if(['react','@godot-js/react','@playground/api'].includes(name))return __external(name);let path=name;if(name.startsWith('.')){let parts=from.split('/');parts.pop();for(const p of name.split('/')){if(p==='..')parts.pop();else if(p&&p!=='.')parts.push(p);}path=parts.join('/');}const clean=path.replace(/\\.[jt]sx?$/,'');const id=[path,clean+'.ts',clean+'.tsx',clean+'.js',clean+'.jsx',path+'/index.ts',path+'/index.tsx',path+'.json'].find(p=>Object.hasOwn(__modules,p)||Object.hasOwn(__json,p));if(!id)throw Error('Unsupported module: '+name);if(Object.hasOwn(__json,id))return __json[id];if(__cache[id])return __cache[id].exports;const m={exports:{}};__cache[id]=m;__modules[id](n=>__load(n,id),m,m.exports);return m.exports;}module.exports=__load(${JSON.stringify(entry)},'/');`;
   }
   self.postMessage({id,code,diagnostics});
  }finally{service.dispose();}
 }catch(error){self.postMessage({id,code:'',diagnostics:[{message:String(error),line:0,column:0,code:0,category:'error'}],error:String(error)});}
};
