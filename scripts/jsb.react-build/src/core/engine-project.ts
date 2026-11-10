import ts from 'typescript';
import {prepareResourceUidCache,RESOURCE_UID_CACHE} from './resource-uids.js';
import {decodeProjectText,readProjectStringSetting as setting,writeProjectStringSetting as replaceSetting} from './project-settings.js';
import {nativeModuleSource} from './native-module-exports.js';
import {moduleRequireOffsets} from './script-bindings.js';
import {ENGINE_MODULE_ROOT,projectScript,projectDeclaration,moduleCandidates,projectModulePath,emittedModulePath} from './project-modules.js';

export interface EngineProjectDiagnostic {
 file?:string;line:number;column:number;message:string;code?:string|number;category:'error'|'warning';
}
export interface EngineProjectOptions {
 files:Readonly<Record<string,string|readonly number[]>>;
 runtime:'godot'|'react';entry?:string;entryExport?:string;mainScene?:string;props?:Record<string,unknown>;
 vendor?:Uint8Array;
 /** Canonical module specifier -> CommonJS bytes, or an explicit res:// module path. */
 runtimeModules?:Readonly<Record<string,Uint8Array>>;
 /** Optional emitted CommonJS by source path; native namespace imports are safely re-emitted. */
 generatedJs?:Readonly<Record<string,string>>;
 maxBytes?:number;maxFiles?:number;
}
export interface EngineProjectManifest {
 schemaVersion:1;runtime:'godot'|'react';entry?:string;mainScene?:string;
 projectSettings:'text'|'binary'|'generated';files:string[];generatedFiles:string[];
 modules:Record<string,string>;runtimeModules:Record<string,string>;
}
export interface PreparedEngineProject {
 files:ReadonlyMap<string,Uint8Array>;manifest:EngineProjectManifest;diagnostics:EngineProjectDiagnostic[];
}
export class EngineProjectBuildError extends Error {
 readonly diagnostics:EngineProjectDiagnostic[];
 constructor(diagnostics:EngineProjectDiagnostic[]){super(diagnostics.map(d=>d.message).join('\n'));this.name='EngineProjectBuildError';this.diagnostics=diagnostics;}
}
const encoder=new TextEncoder(),decoder=new TextDecoder();
const OUT=ENGINE_MODULE_ROOT,BOOT='res://.playground/engine-bootstrap.ts',SCENE='res://.playground/engine-bootstrap.tscn';
const nativeModules=new Set(['godot','godot-jsb','godot.annotations','godot.lib','godot.lib.api','godot.typeloader','jsb.core','jsb.inject','godot.worker']);
const importedSource=/\.(?:png|jpe?g|webp|svg|bmp|tga|hdr|exr|wav|ogg|mp3|flac|glb|gltf|fbx|blend|obj|dae|ttf|otf|woff2?|csv)$/i;
const emittedScript=projectScript,declaration=projectDeclaration;
function fail(code:string,message:string,file?:string):never {throw new EngineProjectBuildError([{code,message,file,line:0,column:0,category:'error'}]);}
function resourcePath(value:string):string {
 const path=value.startsWith('res://')?value.slice(6):value.replace(/^\//,'');
 if(!path||path.startsWith('/')||/[:\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))
  return fail('E_ENGINE_PATH',`Invalid project resource path: ${value}`,value);
 return 'res://'+path;
}
const outputPath=emittedModulePath;
function modulePath(specifier:string):string {
 if(specifier.startsWith('res://')||specifier.startsWith('/'))return resourcePath(specifier);
 if(!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(specifier)
  ||specifier.split('/').some(part=>part==='.'||part==='..'))return fail('E_ENGINE_MODULE_PATH',`Invalid runtime module specifier: ${specifier}`);
 return OUT+'node_modules/'+specifier+'/index.js';
}
function bytesEqual(left:Uint8Array,right:Uint8Array):boolean {return left.length===right.length&&left.every((value,index)=>value===right[index]);}
function sceneReference(value:string):string {
 if(value.startsWith('uid://')){if(!/^uid:\/\/[^\s"\\]+$/.test(value))fail('E_ENGINE_MAIN_SCENE',`Invalid scene UID: ${value}`);return value;}
 return resourcePath(value);
}
function defaults(mainScene:string):string {
 return 'config_version=5\n\n[application]\nconfig/name="GodotJS Playground"\nrun/main_scene='+JSON.stringify(mainScene)+'\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n\n[GodotJS]\nruntime/debugger/debugger_port=0\n';
}
function externalDiagnostics(path:string,javascript:string,files:ReadonlyMap<string,Uint8Array>,provided:Set<string>):EngineProjectDiagnostic[] {
 const ast=ts.createSourceFile(path,javascript,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS),diagnostics:EngineProjectDiagnostic[]=[];
 const requires=moduleRequireOffsets(ast);
 const seen=new Set<string>();
 const visit=(node:ts.Node)=>{
  if(ts.isCallExpression(node)&&requires.has(node.getStart(ast))&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])){
   const specifier=node.arguments[0].text;
   if(!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.startsWith('res://')&&!nativeModules.has(specifier)&&!provided.has(specifier)&&!seen.has(specifier)){
    const packageRoot=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
    const available=[...files.keys()].some(name=>name.startsWith('res://node_modules/'+packageRoot+'/')||name.startsWith(OUT+'node_modules/'+packageRoot+'/'));
    if(!available){seen.add(specifier);diagnostics.push({file:path,line:0,column:0,category:'error',code:'E_ENGINE_MODULE_UNAVAILABLE',message:`Module "${specifier}" is not included. Browser project compilation does not install npm packages; include its CommonJS runtimeModules or project node_modules files.`});}
   }
  }
  ts.forEachChild(node,visit);
 };visit(ast);return diagnostics;
}
function nativeImportTransformer(onRewrite:()=>void):ts.TransformerFactory<ts.SourceFile> {
 return context=>source=>{
  const factory=context.factory,statements:ts.Statement[]=[],defaults=new Set<string>();
  for(const node of source.statements){
   if(!ts.isImportDeclaration(node)||!ts.isStringLiteral(node.moduleSpecifier)||!nativeModules.has(node.moduleSpecifier.text)
    ||!node.importClause||node.importClause.isTypeOnly){statements.push(node);continue;}
   const clause=node.importClause,binding=clause.namedBindings,specifier=node.moduleSpecifier.text;
   if(!clause.name&&(!binding||!ts.isNamespaceImport(binding))){statements.push(node);continue;}
   onRewrite();
   // Native namespaces are lazy proxies. TypeScript's __importStar/default
   // probes __esModule, which is a class lookup there rather than metadata.
   const direct=(name:ts.Identifier)=>{
    const statement=factory.createVariableStatement(undefined,factory.createVariableDeclarationList([
     factory.createVariableDeclaration(name,undefined,undefined,factory.createCallExpression(factory.createIdentifier('require'),undefined,[factory.createStringLiteral(specifier)])),
    ],ts.NodeFlags.Const));
    ts.setOriginalNode(statement,node);ts.setTextRange(statement,node);statements.push(statement);
   };
   if(clause.name){defaults.add(clause.name.text);direct(clause.name);}
   if(binding&&ts.isNamespaceImport(binding))direct(binding.name);
   else if(binding)statements.push(factory.updateImportDeclaration(node,node.modifiers,factory.updateImportClause(clause,false,undefined,binding),node.moduleSpecifier,node.attributes));
  }
  const rewritten=factory.updateSourceFile(source,statements);
  // The module transformer still knows the original import symbol. Keep
  // default references bound to our direct local instead of foo_1.default.
  const directReference=(node:ts.Identifier)=>{
   const identifier=factory.createIdentifier(node.text);
   ts.setOriginalNode(identifier,node);ts.setTextRange(identifier,node);
   return ts.setEmitFlags(identifier,ts.EmitFlags.NoSubstitution);
  };
  const visit=(node:ts.Node):ts.VisitResult<ts.Node>=>{
   if(ts.isShorthandPropertyAssignment(node)&&defaults.has(node.name.text)&&!node.objectAssignmentInitializer){
    const property=factory.createPropertyAssignment(node.name.text,directReference(node.name));
    ts.setOriginalNode(property,node);ts.setTextRange(property,node);return property;
   }
   if(ts.isIdentifier(node)&&defaults.has(node.text))return directReference(node);
   return ts.visitEachChild(node,visit,context);
  };
  return defaults.size?ts.visitNode(rewritten,visit) as ts.SourceFile:rewritten;
 };
}
function runtimeImportTransformer(resolve:(specifier:string)=>string|undefined,onRewrite:(specifier:string)=>void):ts.TransformerFactory<ts.SourceFile> {
 return context=>source=>{
  const factory=context.factory,requires=moduleRequireOffsets(source);
  const mapped=(node:ts.Expression)=>{
   if(!ts.isStringLiteral(node))return node;
   const target=resolve(node.text);if(!target||target===node.text)return node;
   onRewrite(node.text);const literal=factory.createStringLiteral(target);
   ts.setOriginalNode(literal,node);ts.setTextRange(literal,node);return literal;
  };
  const rewritten=factory.updateSourceFile(source,source.statements.map(node=>{
   if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly)return factory.updateImportDeclaration(node,node.modifiers,node.importClause,mapped(node.moduleSpecifier),node.attributes);
   if(ts.isExportDeclaration(node)&&!node.isTypeOnly&&node.moduleSpecifier)return factory.updateExportDeclaration(node,node.modifiers,node.isTypeOnly,node.exportClause,mapped(node.moduleSpecifier),node.attributes);
   if(ts.isImportEqualsDeclaration(node)&&!node.isTypeOnly&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression){
    const reference=factory.updateExternalModuleReference(node.moduleReference,mapped(node.moduleReference.expression));
    return factory.updateImportEqualsDeclaration(node,node.modifiers,node.isTypeOnly,node.name,reference);
   }
   return node;
  }));
  const visit=(node:ts.Node):ts.VisitResult<ts.Node>=>{
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||requires.has(node.getStart(source)))&&node.arguments.length){
    const visited=ts.visitEachChild(node,visit,context);
    return factory.updateCallExpression(visited,visited.expression,visited.typeArguments,[mapped(visited.arguments[0]),...visited.arguments.slice(1)]);
   }
   return ts.visitEachChild(node,visit,context);
  };
  return ts.visitNode(rewritten,visit) as ts.SourceFile;
 };
}
function bootstrap(entry:string,exportName:string,props:Record<string,unknown>):string {
 return `const G = require('godot');
const React = require(${JSON.stringify(modulePath('react'))});
const EngineReact = require(${JSON.stringify(modulePath('@godot-js/react/engine'))});
const names = require('godot-jsb').internal.names;
const call = (object: any, name: string, ...args: any[]) => object[names.get_member(name)](...args);
export default class PlaygroundEngineBootstrap extends G.Node {
 private root: any;
 _ready() {
  try {
   const entry = require(${JSON.stringify(entry)});
   const Component = entry[${JSON.stringify(exportName)}] ?? (${JSON.stringify(exportName)} === 'default' && typeof entry === 'function' ? entry : undefined);
   if (Component === undefined) throw Error(${JSON.stringify(`React entry does not export "${exportName}"`)});
   this.root = EngineReact.createRoot(this, {autoProcess: false, onError: (error: any, info: any) => this.report(error, info)});
   this.root.render(React.isValidElement(Component) ? Component : React.createElement(Component, ${JSON.stringify(props)}));
  } catch (error) {
   try { this.close('startup-failure'); } catch (cleanup) { console.error('React bootstrap cleanup failed', cleanup); }
   throw error;
  }
 }
 _process(delta: number) { this.root?.process(delta); }
 _physics_process(delta: number) { this.root?.physics(delta); }
 _exit_tree() { this.close('bootstrap-exit'); }
 private report(error: any, info: any) {
  let message = 'React callback failed';try { message = String(error); } catch (_) {}
  const payload = {kind:info?.kind ?? 'runtime',message:message.slice(0,4096),stack:(info?.stack ?? '').slice(0,32768),componentStack:(info?.componentStack ?? '').slice(0,8192)};
  let handled = false;
  try {
   if (call(G[names.get_class('OS')], 'has_feature', 'web')) {
    const window = call(G[names.get_class('JavaScriptBridge')], 'get_interface', 'window');
    handled = call(window, 'call', '__godotjsReportReactError', JSON.stringify(payload)) === true;
   }
  } catch (_) { /* Native hosts and standalone previews use their own console. */ }
  if (!handled) (payload.kind === 'caught' || payload.kind === 'recoverable' ? console.warn : console.error)(payload.message + '\\n' + payload.stack);
  if (payload.kind === 'uncaught' || payload.kind === 'runtime') this.close('react-failure');
 }
 private close(reason: string) { const root = this.root; this.root = undefined; root?.shutdown(reason); }
}
`;
}
function nativeBootstrap(resource:string,module:string,exportName:string):string {
 return `const G = require('godot');
const names = require('godot-jsb').internal.names;
const call = (object: any, name: string, ...args: any[]) => object[names.get_member(name)](...args);
export default class PlaygroundEngineBootstrap extends G.Node {
 _ready() {
  if (!call(G[names.get_class('ResourceLoader')], 'load', ${JSON.stringify(resource)})) throw Error('Could not register the native entry script');
  const entry = require(${JSON.stringify(module)});
  const UserClass = entry[${JSON.stringify(exportName)}] ?? (${JSON.stringify(exportName)} === 'default' && typeof entry === 'function' ? entry : undefined);
  if (typeof UserClass !== 'function') throw Error('Native entry must export a Godot Node class');
  const node = new UserClass();
  if (!(node instanceof G.Node)) throw Error('Native entry must construct a Godot Node; use a native mainScene for other startup flows');
  call(this, 'add_child', node);
 }
}
`;
}

/** Pure project preparation: no filesystem, network, package installer or editor importer. */
export function prepareEngineProject(options:EngineProjectOptions):PreparedEngineProject {
 if(options.runtime!=='godot'&&options.runtime!=='react')fail('E_ENGINE_RUNTIME','Expected runtime "godot" or "react"');
 const files=new Map<string,Uint8Array>(),textFiles=new Map<string,string>(),casePaths=new Map<string,string>();
 const generated=new Set<string>(),modules:Record<string,string>=Object.create(null),runtimePaths:Record<string,string>=Object.create(null);
 const diagnostics:EngineProjectDiagnostic[]=[];
 for(const [input,value] of Object.entries(options.files)){
  const path=resourcePath(input),collision=casePaths.get(path.toLowerCase());
  if(collision)fail('E_ENGINE_PATH_COLLISION',`Project paths collide: ${collision} and ${input}`,input);
  casePaths.set(path.toLowerCase(),path);
  if(typeof value==='string'){textFiles.set(path,value);files.set(path,encoder.encode(value));}
  else if(Array.isArray(value)&&value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)){
   const bytes=Uint8Array.from(value);files.set(path,bytes);
   if(path==='res://project.godot'){
    try{textFiles.set(path,decodeProjectText(bytes)!);}
    catch{fail('E_ENGINE_PROJECT_TEXT','project.godot must contain valid UTF-8 text',path);}
   }
  }
  else fail('E_ENGINE_BYTES',`Expected text or byte values 0–255: ${input}`,input);
 }
 const put=(path:string,value:string|Uint8Array,replace=false)=>{
  const bytes=typeof value==='string'?encoder.encode(value):new Uint8Array(value);
  const collision=casePaths.get(path.toLowerCase());
  if(collision&&collision!==path)fail('E_ENGINE_PATH_COLLISION',`Generated path collides with ${collision}: ${path}`,path);
  const existing=files.get(path);
  if(existing&&!replace&&!bytesEqual(existing,bytes))fail('E_ENGINE_GENERATED_COLLISION',`Generated runtime file conflicts with a project file: ${path}`,path);
  files.set(path,bytes);casePaths.set(path.toLowerCase(),path);generated.add(path);
 };
 // Exported projects expect this editor cache even when no global scripts are
 // registered. Preserve a supplied cache; a fresh project has an empty list.
 if(!files.has('res://.godot/global_script_class_cache.cfg'))put('res://.godot/global_script_class_cache.cfg','list=Array[Dictionary]([])\n');
 const textProject=textFiles.get('res://project.godot');
 if(files.has('res://project.godot')&&textProject===undefined)fail('E_ENGINE_PROJECT_TEXT','project.godot must be UTF-8 text supplied as a string','res://project.godot');
 let project=textProject,mainScene=options.mainScene?sceneReference(options.mainScene):project===undefined?undefined:setting(project,'application','run/main_scene');
 let projectSettings:EngineProjectManifest['projectSettings']=project===undefined?'generated':'text';
 let nativeEntryAlias:string|undefined;
 const entry=options.entry?resourcePath(options.entry):undefined;
 if(entry&&!files.has(entry))fail('E_ENGINE_ENTRY',`Entry is missing from the project: ${entry}`,entry);
 if(options.runtime==='react'){
  if(!entry||!emittedScript.test(entry)||declaration.test(entry))fail('E_ENGINE_ENTRY','React projects require an existing JavaScript or TypeScript entry',entry);
  if(project===undefined&&files.has('res://project.binary'))fail('E_ENGINE_PROJECT_BINARY','React startup requires project.godot text so native project settings can be preserved','res://project.binary');
  mainScene=SCENE;
  const script=bootstrap(outputPath(entry),options.entryExport??'default',options.props??{});
  put(BOOT,script);textFiles.set(BOOT,script);
  put(SCENE,'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="'+BOOT+'" id="1"]\n[node name="PlaygroundEngineBootstrap" type="Node"]\nscript = ExtResource("1")\n');
  project=project===undefined?defaults(mainScene):replaceSetting(project,'application','run/main_scene',mainScene);
 }else if(project===undefined&&!mainScene&&files.has('res://project.binary'))projectSettings='binary';
 else {
  if(!mainScene&&entry){
   if(!emittedScript.test(entry)||declaration.test(entry))fail('E_ENGINE_ENTRY','Native entries must be JavaScript or TypeScript scripts',entry);
   const resource=entry.endsWith('.ts')?entry:entry.replace(/\.[^.\/]+$/,'.ts');
   if(resource!==entry)put(resource,'// GodotJS script resource for '+entry+'\n');
   nativeEntryAlias=outputPath(resource);
   const script=nativeBootstrap(resource,nativeEntryAlias,options.entryExport??'default');
   put(BOOT,script);textFiles.set(BOOT,script);
   put(SCENE,'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="'+BOOT+'" id="1"]\n[node name="PlaygroundEngineBootstrap" type="Node"]\nscript = ExtResource("1")\n');
   mainScene=SCENE;
  }
  if(!mainScene)fail('E_ENGINE_MAIN_SCENE','Godot projects require application/run/main_scene in project.godot or an explicit mainScene option','res://project.godot');
  mainScene=sceneReference(mainScene);
  project=project===undefined?defaults(mainScene):options.mainScene||nativeEntryAlias?replaceSetting(project,'application','run/main_scene',mainScene):project;
 }
 if(project!==undefined){
  put('res://project.godot',project,true);
  if(files.delete('res://project.binary'))diagnostics.push({file:'res://project.binary',line:0,column:0,category:'warning',code:'W_ENGINE_STALE_PROJECT_BINARY',message:'Ignored project.binary because project.godot text is authoritative.'});
 }
 if(options.vendor)put('res://.playground/vendor.js',options.vendor);
 const provided=new Set<string>();
 for(const [specifier,bytes] of Object.entries(options.runtimeModules??{})){
  if(nativeModules.has(specifier))fail('E_ENGINE_NATIVE_MODULE',`Native module must be provided by GodotJS: ${specifier}`);
  if(!(bytes instanceof Uint8Array))fail('E_ENGINE_MODULE_BYTES',`Expected CommonJS bytes for runtime module ${specifier}`);
  const path=modulePath(specifier);
  const canonical=/^res:\/\/\.godot\/GodotJS\/node_modules\/(.+)\/index\.js$/.exec(path)?.[1];
  if(canonical&&nativeModules.has(canonical))fail('E_ENGINE_NATIVE_MODULE',`Native module must be provided by GodotJS: ${canonical}`);
  put(path,bytes);runtimePaths[specifier]=path;if(canonical){provided.add(canonical);runtimePaths[canonical]=path;}
 }
 if(options.runtime==='react'&&options.vendor){
  const exports:Record<string,string>={'react':'React','react/jsx-runtime':'jsxRuntime','react/jsx-dev-runtime':'jsxDevRuntime','@godot-js/react':'engineReact','@godot-js/react/engine':'engineReact','scheduler':'scheduler'};
  for(const [specifier,key] of Object.entries(exports)){
   if(provided.has(specifier))continue;
   const path=modulePath(specifier);put(path,`module.exports = require('res://.playground/vendor.js')[${JSON.stringify(key)}];\n`);provided.add(specifier);runtimePaths[specifier]=path;
  }
 }
 if(options.runtime==='react'&&(!provided.has('react')||!provided.has('@godot-js/react/engine')))
  fail('E_ENGINE_REACT_RUNTIME','React projects require the engine React vendor or runtimeModules for react and @godot-js/react/engine');
 // A shared JS namespace supplies module metadata without probing ClassDB.
 // Statically resolved native imports share this cached namespace.
 const nativeNamespace=OUT+'.playground/native-modules/godot.js';
 const supplied=new Map(Object.entries(options.generatedJs??{}).map(([path,code])=>[resourcePath(path),code]));
 const moduleOutputs=new Map<string,string>();
 for(const path of textFiles.keys()){
  if(declaration.test(path))continue;
  if(emittedScript.test(path))moduleOutputs.set('/'+path.slice(6),path.startsWith(OUT)?path:outputPath(path));
  else if(path.endsWith('.json'))moduleOutputs.set('/'+path.slice(6),path.startsWith(OUT)?path:OUT+path.slice(6));
 }
 const outputOwners=new Map<string,string>();
 for(const [path,source] of textFiles){
  if(path.startsWith(OUT)||declaration.test(path))continue;
  if(emittedScript.test(path)){
   const output=outputPath(path);
   if(outputOwners.has(output))fail('E_ENGINE_EMIT_COLLISION',`Scripts produce the same JavaScript module: ${outputOwners.get(output)} and ${path}`,path);
   outputOwners.set(output,path);
   // .mts/.mjs force ESM in TypeScript even with module:CommonJS. The native
   // loader expects CommonJS; keep the real source URI in the rewritten map.
   const transpileName=path.replace(/\.mts$/i,'.ts').replace(/\.mjs$/i,'.js');
   let rewriteImports=false;
   const rewritten=()=>{rewriteImports=true;};
   const referencesNative=()=>{put(nativeNamespace,nativeModuleSource());runtimePaths.godot=nativeNamespace;rewritten();};
   const resolveImport=(specifier:string)=>{
    if(specifier==='godot')return nativeNamespace;
    if(runtimePaths[specifier])return runtimePaths[specifier];
    const base=projectModulePath(specifier,path);if(!base)return undefined;
    const resolved=moduleCandidates(base).find(candidate=>moduleOutputs.has(candidate));
    return resolved?moduleOutputs.get(resolved):undefined;
   };
   const result=ts.transpileModule(source,{fileName:transpileName,reportDiagnostics:true,transformers:{before:[runtimeImportTransformer(resolveImport,(specifier)=>{if(specifier==='godot')referencesNative();else rewritten();}),nativeImportTransformer(rewritten)]},compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true,sourceMap:true,inlineSources:true,rewriteRelativeImportExtensions:true}});
   for(const item of result.diagnostics??[]){
    const point=item.file&&item.start!==undefined?item.file.getLineAndCharacterOfPosition(item.start):undefined;
    diagnostics.push({file:path,line:point?point.line+1:0,column:point?point.character+1:0,code:item.code,category:item.category===ts.DiagnosticCategory.Error?'error':'warning',message:ts.flattenDiagnosticMessageText(item.messageText,'\n')});
   }
   const useSupplied=supplied.has(path)&&!rewriteImports&&!/\.(?:mts|mjs)$/i.test(path);
   let javascript=useSupplied?supplied.get(path)!:result.outputText;
   // Externally supplied JavaScript can carry an inline map. Preserve that
   // original map instead of pairing different emitted code with our map.
   let mapText=result.sourceMapText;
   if(useSupplied){
    const inline=/\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,\s]+)?;base64,([^\s]+)/.exec(javascript);
    if(inline){try{mapText=new TextDecoder().decode(Uint8Array.from(atob(inline[1]),c=>c.charCodeAt(0)));}catch{mapText=undefined;}}
    else mapText=supplied.get(path+'.map');
    if(!mapText)diagnostics.push({file:path,line:0,column:0,category:'warning',code:'W_ENGINE_SOURCE_MAP',message:'Precompiled JavaScript has no readable source map. Original source is preserved; mapped runtime locations require its emitted source map.'});
   }
   if(mapText){
    try{
     const map=JSON.parse(mapText);map.file=output.slice(output.lastIndexOf('/')+1);map.sourceRoot='';map.sources=[path];map.sourcesContent=[source];
     put(output+'.map',JSON.stringify(map),true);
     javascript=javascript.replace(/^\s*\/\/# sourceMappingURL=.*$/gm,'')+'\n//# sourceMappingURL='+output.slice(output.lastIndexOf('/')+1)+'.map\n';
    }catch{diagnostics.push({file:path,line:0,column:0,category:'warning',code:'W_ENGINE_SOURCE_MAP',message:'Supplied source map is invalid; generated JavaScript is preserved.'});}
   }
   put(output,javascript,true);modules[path]=output;
   diagnostics.push(...externalDiagnostics(path,javascript,files,provided));
  }else if(path.endsWith('.json')){
   // Relative native require() runs next to the generated CommonJS modules.
   put(OUT+path.slice(6),source,true);
  }
 }
 if(nativeEntryAlias&&entry&&nativeEntryAlias!==outputPath(entry)){
  put(nativeEntryAlias,files.get(outputPath(entry))!,true);
  const sourceMap=files.get(outputPath(entry)+'.map');if(sourceMap)put(nativeEntryAlias+'.map',sourceMap,true);
 }
 for(const [path,bytes] of files){
  if(path.startsWith('res://.godot/')||!importedSource.test(path))continue;
  const imported=files.get(path+'.import');
  if(imported){
   const targets=[...decoder.decode(imported).matchAll(/^\s*path(?:\.[^=\s]+)?\s*=\s*"(res:\/\/[^"\r\n]+)"/gm)].map(match=>match[1]);
   const missing=targets.filter(target=>!files.has(target));
   if(targets.length&&!missing.length)continue;
   diagnostics.push({file:path,line:0,column:0,category:'warning',code:'W_ENGINE_IMPORT_CACHE_MISSING',message:`Editor import metadata has no available imported resource${missing.length?': '+missing.join(', '):'.'} Include its .godot/imported cache; the browser does not run Godot editor importers.`});
  }else diagnostics.push({file:path,line:0,column:0,category:'warning',code:'W_ENGINE_IMPORT_REQUIRED',message:`${path} is an editor-imported resource format. Its original ${bytes.byteLength} bytes are preserved, but ResourceLoader may need an editor-generated .import file and .godot/imported cache. Direct native file/image/audio APIs can still consume supported original formats.`});
 }
 const uidCache=prepareResourceUidCache(files,mainScene);
 diagnostics.push(...uidCache.diagnostics);
 if(uidCache.cache)put(RESOURCE_UID_CACHE,uidCache.cache,true);
 const errors=diagnostics.filter(item=>item.category==='error');if(errors.length)throw new EngineProjectBuildError(diagnostics);
 return {files,diagnostics,manifest:{schemaVersion:1,runtime:options.runtime,entry,mainScene,projectSettings,
  files:[...files.keys()].sort(),generatedFiles:[...generated].sort(),modules,runtimeModules:runtimePaths}};
}
