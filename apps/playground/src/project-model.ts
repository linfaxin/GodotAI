import {prepareResourceUidCache,resolveResourceUidFromCache} from '@godot-js/project-tools/resource-uids';
import {decodeProjectText,readProjectStringSetting} from '@godot-js/project-tools/project-settings';
import {renamedProjectFiles} from './project-rename.ts';
import type {ScriptRenamePlan} from '@godot-js/react-build/script-renames';
import {parseProjectLaunch} from '@godot-js/project-tools/launch';
import type {ProjectLaunch} from '@godot-js/project-tools/build-plan';
import {parseImportReceipt,createImportCacheObservations,parseImportCacheObservations,type LegacyImportObservation,type ImportReceipt} from '@godot-js/project-tools/import-receipts';
import {parseResourceImports,type ResourceImportRequest} from '@godot-js/project-tools/resource-converters';

export type ProjectRuntime='godot'|'react';
export const PROJECT_SCHEMA_VERSION=3;
export const DEFAULT_ENGINE_PROFILE='full-engine-v1';
export function validEngineProfile(value:unknown):value is string {return typeof value==='string'&&/^[a-z][a-z0-9._-]{0,127}$/.test(value);}
export function projectProfileMatches(project:Pick<EditorProject,'engineProfile'>,profile:string):boolean{return project.engineProfile===profile;}

export interface EngineDocumentView {kind:'godotjs-schema4-view';launch:ProjectLaunch;baseDocument:Record<string,unknown>;originalDocument:unknown}
export interface EditorProject {schemaVersion:3;engineProfile:string;demoApiVersion?:number;runtime:ProjectRuntime;demoId:string;entry:string;mainScene?:string;mainSceneSource?:'project'|'explicit';selected:string;files:Record<string,string|number[]>;controls:Record<string,number>;mode:'production'|'development';engineDocument?:EngineDocumentView;importCacheObservations?:LegacyImportObservation[];migration?:{fromSchemaVersion:1|2|3;removedRenderer?:boolean;originalDocument:unknown}}
export function canRenameProjectFile(project:EditorProject,path:string):boolean {
 return (project.engineDocument?/\.(?:[cm]?[jt]s|tsx|jsx|tscn)$/i:/\.(?:[jt]sx?|tscn)$/i).test(path)&&!(/\.d\.[cm]?ts$/i.test(path));
}
// Legacy exports pretty-print byte arrays; their JSON can be much larger than decoded files.
export const MAX_PROJECT_DOCUMENT_BYTES=128*1024*1024;
export function filePath(value:string):string {
 const path='/'+value.replace(/^\/+/, '');
 if(path.length>180||path.split('/').slice(1).some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f\\]/.test(path))throw Error('请输入有效的项目文件路径');
 return path;
}
export function parseProject(value:unknown):EditorProject {
 const document=value as any;
 if(document?.schemaVersion!==undefined&&![1,2,3,4].includes(document.schemaVersion))throw Error('不支持的项目版本');
 const data=document?.project&&[1,2,3,4].includes(document.schemaVersion)?document.project:document;
 const version=document?.schemaVersion??data?.schemaVersion??1;
 if(version===4){
  if(data?.runtime!=='engine'||['entry','mainScene','mainSceneSource'].some(key=>Object.hasOwn(data,key)))throw Error('Schema 4 须使用 engine 和明确 launch');
  const launch=parseProjectLaunch(data.launch),editor=data.editor??{};
  if(!editor||typeof editor!=='object'||Array.isArray(editor))throw Error('无效的项目编辑器状态');
  if(data.importReceipts!==undefined){
   if(!Array.isArray(data.importReceipts))throw Error('无效的资源导入收据');
   const receipts=data.importReceipts.map(parseImportReceipt);
   if(new Set(receipts.map((item:ImportReceipt)=>item.resource)).size!==receipts.length)throw Error('重复的资源导入收据');
  }
  if(data.resourceImports!==undefined)parseResourceImports(data.resourceImports);
  const originalDocument=document.kind==='godotjs-editor-schema4'&&Object.hasOwn(document,'originalDocument')?document.originalDocument:value;
  return parseProject({schemaVersion:3,engineProfile:data.engineProfile,runtime:'godot',demoId:editor.demoId??'engine',selected:editor.selected,controls:editor.controls,mode:editor.mode,files:data.files,importCacheObservations:editor.importCacheObservations,
   engineDocument:{kind:'godotjs-schema4-view',launch,baseDocument:structuredClone(data),originalDocument:structuredClone(originalDocument)}});
 }
 const removedRuntime=version===1||(version<3&&data?.runtime==='legacy-react');
 const engineProfile=version===3?data?.engineProfile:DEFAULT_ENGINE_PROFILE;
 if(!validEngineProfile(engineProfile))throw Error('项目须指定有效的引擎配置 engineProfile');
 const demoApiVersion=data?.demoApiVersion;
 if(demoApiVersion!==undefined&&(!Number.isSafeInteger(demoApiVersion)||demoApiVersion<1))throw Error('无效的示例 API 版本');
 const runtime:ProjectRuntime=removedRuntime?'react':data?.runtime;
 if(!['godot','react'].includes(runtime))throw Error('项目须指定 godot 或 react 运行模式');
 let engineDocument:EngineDocumentView|undefined;
 if(data.engineDocument!==undefined){
  const view=data.engineDocument;
  if(runtime!=='godot'||view?.kind!=='godotjs-schema4-view'||view.baseDocument?.schemaVersion!==4||view.baseDocument?.runtime!=='engine'||!Object.hasOwn(view,'originalDocument'))throw Error('无效的 Schema 4 编辑视图');
  engineDocument={kind:'godotjs-schema4-view',launch:parseProjectLaunch(view.launch),baseDocument:structuredClone(view.baseDocument),originalDocument:structuredClone(view.originalDocument)};
 }
 if(!data||typeof data!=='object'||!data.files||typeof data.files!=='object'||Array.isArray(data.files))throw Error('项目缺少 files');
 const entries=Object.entries(data.files);if(!entries.length||entries.length>64)throw Error('项目须包含 1–64 个文件');
 let bytes=0;const files:EditorProject['files']={};
 for(const [name,contents] of entries){const path=filePath(name);if(Object.hasOwn(files,path))throw Error('文件路径重复');if(typeof contents==='string'){bytes+=new TextEncoder().encode(contents).length;files[path]=contents;}else if(Array.isArray(contents)&&contents.length<=1048576&&contents.every(n=>Number.isInteger(n)&&n>=0&&n<=255)){bytes+=contents.length;files[path]=contents.slice();}else throw Error('文件内容须为文本或字节数组');}
 if(bytes>8388608)throw Error('项目内容不能超过 8 MB');
 const importCacheObservations=data.importCacheObservations===undefined?createImportCacheObservations(files):parseImportCacheObservations(data.importCacheObservations);
 const launch=engineDocument?.launch;
 const rawEntry=launch?.kind==='script'?launch.module.startsWith('res://')?launch.module.slice(6):launch.module:launch?.kind==='scene'?'':data.entry??data.config?.entry??'';
 const entry=rawEntry?filePath(rawEntry):'';
 // Historical React exports can contain a project.godot aimed at an external
 // generated host. Keep that document verbatim without treating it as a launch request.
 if(data.mainSceneSource!==undefined&&!['project','explicit'].includes(data.mainSceneSource))throw Error('无效主场景来源');
 const explicitScene=launch?.kind==='scene'?launch.source==='override'?launch.path:undefined:data.mainSceneSource==='project'?undefined:data.mainScene??data.config?.mainScene;
 const mainScene=launch?.kind==='script'||runtime==='react'&&explicitScene===undefined?undefined:resolveProjectMainScene({files,mainScene:explicitScene});
 const mainSceneSource=explicitScene===undefined?'project' as const:'explicit' as const;
 if(entry&&(typeof files[entry]!=='string'||!(engineDocument?/\.(?:[cm]?[jt]s|tsx|jsx)$/i:/\.[jt]sx?$/).test(entry)))throw Error('项目入口须为已有的 TS、JS、TSX 或 JSX 文件');
 if(!entry&&!mainScene&&!(launch?.kind==='scene'&&launch.source==='project'&&Object.hasOwn(files,'/project.binary')))throw Error('项目须有脚本入口或原生主场景');
 if(mainScene&&!Object.hasOwn(files,filePath(mainScene.slice(6))))throw Error('主场景须为项目中已有的场景');
 const controls:Record<string,number>={};for(const [k,v] of Object.entries(data.controls??{})){if(typeof v!=='number'||!Number.isFinite(v))throw Error('无效场景参数');controls[k]=v;}
 const selection=typeof data.selected==='string'?filePath(data.selected):'';
 const selected=Object.hasOwn(files,selection)?selection:entry||(mainScene?filePath(mainScene.slice(6)):Object.keys(files)[0]);
 const migration=data.migration??(version<3?{fromSchemaVersion:version as 1|2,...(removedRuntime?{removedRenderer:true}:{}),originalDocument:structuredClone(value)}:undefined);
 if(migration&&(![1,2,3].includes(migration.fromSchemaVersion)||!Object.hasOwn(migration,'originalDocument')))throw Error('无效迁移备份');
 const demoId=String(data.demoId??(runtime==='godot'?'native':'react'));
 return {schemaVersion:3,engineProfile,...(demoApiVersion!==undefined?{demoApiVersion}:{}),runtime,demoId,entry,...(mainScene?{mainScene,mainSceneSource}:{}),selected,files,controls,mode:(data.mode??data.config?.mode)==='development'?'development':'production',...(importCacheObservations.length?{importCacheObservations}:{}),...(engineDocument?{engineDocument}:{}),...(migration?{migration:structuredClone(migration)}:{})};
}
/** Read project.godot without rewriting it or interpreting scene/resource schemas. */
export function resolveProjectMainScene(project:{files:Record<string,string|number[]>;mainScene?:string;mainSceneSource?:'project'|'explicit'}):string|undefined {
 let scene=project.mainSceneSource==='project'?undefined:project.mainScene;
 if(scene===undefined){
  const config=decodeProjectText(project.files['/project.godot']);
  if(config!==undefined)scene=readProjectStringSetting(config,'application','run/main_scene');
 }
 if(scene===undefined||scene==='')return undefined;
 if(typeof scene!=='string')throw Error('主场景路径无效');
 if(scene.startsWith('uid://')){
  const uid=scene;
  const files=new Map(Object.entries(project.files).map(([path,value])=>['res:/'+path,typeof value==='string'?new TextEncoder().encode(value):Uint8Array.from(value)]));
  const parsed=prepareResourceUidCache(files,uid),errors=parsed.diagnostics.filter(item=>item.category==='error');
  if(errors.length)throw Error(errors.map(item=>item.message).join('\n'));
  const cached=parsed.cache&&resolveResourceUidFromCache(uid,parsed.cache);
  if(!cached?.startsWith('res://'))throw Error('主场景 UID 无法在项目文件中解析，请提供 mainScene 的 res:// 路径');
  scene=cached;
 }
 const normalized=filePath(scene.startsWith('res://')?scene.slice(6):scene);
 if(!/\.(tscn|scn)$/.test(normalized))throw Error('主场景须为 tscn 或 scn 文件');
 return 'res:/'+normalized;
}
/** The original migration input is always available independently of later edits. */
export function exportProject(project:EditorProject,format:'original'|'migrated'='migrated'):unknown {
 if(project.engineDocument){
  if(format==='original')return structuredClone(project.engineDocument.originalDocument);
  const valid=parseProject(project),view=valid.engineDocument!,base=view.baseDocument,editor=base.editor&&typeof base.editor==='object'&&!Array.isArray(base.editor)?base.editor as Record<string,unknown>:{};
  return {...structuredClone(base),schemaVersion:4,runtime:'engine',engineProfile:valid.engineProfile,launch:structuredClone(view.launch),files:structuredClone(valid.files),editor:{...structuredClone(editor),selected:valid.selected,controls:valid.controls,mode:valid.mode,demoId:valid.demoId,...(valid.importCacheObservations?{importCacheObservations:structuredClone(valid.importCacheObservations)}:{})}};
 }
 return structuredClone(format==='original'&&project.migration?project.migration.originalDocument:parseProject(project));
}
/** Persist opted-in projects with a schema 4 envelope so old readers reject them
 * rather than silently dropping launch metadata. Legacy records are unchanged. */
export function projectStorageDocument(project:EditorProject):unknown {
 return project.engineDocument?{kind:'godotjs-editor-schema4',schemaVersion:4,project:exportProject(project),originalDocument:structuredClone(project.engineDocument.originalDocument)}:project;
}
export function projectCompileRequest(project:EditorProject):{runtime:'godot'|'react'|'engine';launch?:ProjectLaunch;importReceipts?:ImportReceipt[];resourceImports?:ResourceImportRequest[];importCacheObservations?:LegacyImportObservation[]}{
 const observed=project.importCacheObservations?{importCacheObservations:parseImportCacheObservations(project.importCacheObservations)}:{};
 if(!project.engineDocument)return {runtime:project.runtime,...observed};
 const receipts=project.engineDocument.baseDocument.importReceipts,resourceImports=project.engineDocument.baseDocument.resourceImports;
 return {runtime:'engine',launch:structuredClone(project.engineDocument.launch),...observed,...(Array.isArray(receipts)?{importReceipts:receipts.map(parseImportReceipt)}:{}),...(resourceImports!==undefined?{resourceImports:parseResourceImports(resourceImports)}:{})};
}
/** Opt-in new project; established native/React templates remain unchanged. */
export function newEngineProject(engineProfile=DEFAULT_ENGINE_PROFILE):EditorProject {
 return parseProject({schemaVersion:4,runtime:'engine',engineProfile,launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{
  '/src/start.ts':'import {Node, Label, Vector2} from "godot";\n\nexport function start({mount}: {mount: Node}) {\n  const label = new Label();\n  label.text = "Hello Engine Worker";\n  label.position = new Vector2(32, 32);\n  mount.add_child(label);\n}\n',
  '/project.godot':'config_version=5\n\n[application]\nconfig/name="Engine project"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '/README.md':'Edit src/start.ts. The explicit script launch runs start(ctx) in the engine.\n',
 },editor:{selected:'/src/start.ts',mode:'production'}});
}
/** Validate a complete batch before committing any file to the live project. */
export function addProjectFiles(project:EditorProject,entries:[string,string|number[]][]):void {
 const files={...project.files};
 for(const [name,contents] of entries){const path=filePath(name);if(Object.hasOwn(files,path))throw Error('文件已存在：'+path);files[path]=contents;}
 project.files=parseProject({...project,files}).files;
}
export function renameProjectFile(project:EditorProject,old:string,name:string,scriptPlan?:ScriptRenamePlan):boolean {
 const path=filePath(name);
 if(!Object.hasOwn(project.files,old))throw Error('文件不存在');
 if(path===old)return false;
 if(Object.hasOwn(project.files,path))throw Error('文件已存在');
 if(!canRenameProjectFile(project,old)||!canRenameProjectFile(project,path))throw Error('框架阶段暂只支持普通脚本和文本场景改名，资源与声明文件改名尚未开放');
 const scripts=Object.fromEntries(Object.entries(project.files).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&/\.[cm]?[jt]sx?$/i.test(entry[0])));
 if(scriptPlan){
  if(scriptPlan.oldPath!==old||scriptPlan.newPath!==path||Object.keys(scripts).length!==Object.keys(scriptPlan.sources).length||Object.entries(scripts).some(([file,text])=>scriptPlan.sources[file]!==text))throw Error('项目已变化，请重新执行重命名');
 }else if(Object.values(scripts).some(text=>/['"`](?:\.{1,2}\/|\/|res:\/\/)/.test(text)))throw Error('脚本依赖需要编译器分析，请通过编辑器重命名');
 const prepared={...project.files};
 for(const [file,text]of Object.entries(scriptPlan?.changes??{})){
  if(!Object.hasOwn(scripts,file)||typeof text!=='string')throw Error('无效的脚本重命名分析结果');
  prepared[file]=text;
 }
 const files=renamedProjectFiles(prepared,old,path,true);
 const entry=project.entry===old?path:project.entry;
 const suffix=project.selected.slice(old.length);
 const selected=project.selected===old?path:true&&['.uid','.import','.remap'].includes(suffix)&&project.selected===old+suffix?path+suffix:project.selected;
 const mainScene=project.mainSceneSource!=='project'&&project.mainScene==='res:/'+old?'res:/'+path:project.mainScene;
 const engineDocument=project.engineDocument?structuredClone(project.engineDocument):undefined;
 if(engineDocument){const launch=engineDocument.launch;if(launch.kind==='script'&&filePath(launch.module.startsWith('res://')?launch.module.slice(6):launch.module)===old)launch.module='res:/'+path;
  else if(launch.kind==='scene'&&launch.source==='override'&&launch.path==='res:/'+old)launch.path='res:/'+path;}
 const valid=parseProject({...project,files,entry,selected,mainScene,...(engineDocument?{engineDocument}:{})});
 Object.assign(project,{files,entry,selected:valid.selected});
 if(valid.engineDocument)project.engineDocument=valid.engineDocument;
 if(valid.mainScene){project.mainScene=valid.mainScene;project.mainSceneSource=valid.mainSceneSource;}else{delete project.mainScene;delete project.mainSceneSource;}
 return true;
}
