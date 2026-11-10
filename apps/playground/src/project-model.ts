import {resolveResourceUidFromCache} from '@godot-js/react-build/resource-uids';
import {decodeProjectText,readProjectStringSetting} from '@godot-js/react-build/project-settings';
import {renamedProjectFiles} from './project-rename.ts';
import type {ScriptRenamePlan} from '@godot-js/react-build/script-renames';

export type ProjectRuntime='godot'|'react'|'legacy-react';
export interface EditorProject {schemaVersion:2;runtime:ProjectRuntime;demoId:string;entry:string;mainScene?:string;mainSceneSource?:'project'|'explicit';selected:string;files:Record<string,string|number[]>;controls:Record<string,number>;mode:'production'|'development';migration?:{fromSchemaVersion:1;originalDocument:unknown}}
export function canRenameProjectFile(project:EditorProject,path:string):boolean {
 return project.runtime==='legacy-react'||/\.(?:[jt]sx?|tscn)$/i.test(path)&&!(/\.d\.[cm]?ts$/i.test(path));
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
 if(document?.schemaVersion!==undefined&&![1,2].includes(document.schemaVersion))throw Error('不支持的项目版本');
 const data=document?.project&&[1,2].includes(document.schemaVersion)?document.project:document;
 const version=document?.schemaVersion??data?.schemaVersion??1;
 const runtime:ProjectRuntime=version===1?'legacy-react':data?.runtime;
 if(!['godot','react','legacy-react'].includes(runtime))throw Error('项目须指定 godot、react 或 legacy-react 运行模式');
 if(!data||typeof data!=='object'||!data.files||typeof data.files!=='object'||Array.isArray(data.files))throw Error('项目缺少 files');
 const entries=Object.entries(data.files);if(!entries.length||entries.length>64)throw Error('项目须包含 1–64 个文件');
 let bytes=0;const files:EditorProject['files']={};
 for(const [name,contents] of entries){const path=filePath(name);if(Object.hasOwn(files,path))throw Error('文件路径重复');if(typeof contents==='string'){bytes+=new TextEncoder().encode(contents).length;files[path]=contents;}else if(Array.isArray(contents)&&contents.length<=1048576&&contents.every(n=>Number.isInteger(n)&&n>=0&&n<=255)){bytes+=contents.length;files[path]=contents.slice();}else throw Error('文件内容须为文本或字节数组');}
 if(bytes>8388608)throw Error('项目内容不能超过 8 MB');
 const rawEntry=data.entry??data.config?.entry??'';
 const entry=rawEntry?filePath(rawEntry):'';
 // Historical React exports can contain a project.godot aimed at an external
 // generated host. Keep that document verbatim without treating it as a launch request.
 if(data.mainSceneSource!==undefined&&!['project','explicit'].includes(data.mainSceneSource))throw Error('无效主场景来源');
 const explicitScene=data.mainSceneSource==='project'?undefined:data.mainScene??data.config?.mainScene;
 const mainScene=runtime==='legacy-react'&&explicitScene===undefined?undefined:resolveProjectMainScene({files,mainScene:explicitScene});
 const mainSceneSource=explicitScene===undefined?'project' as const:'explicit' as const;
 if(entry&&(typeof files[entry]!=='string'||!(runtime==='legacy-react'?/\.tsx$/:/\.[jt]sx?$/).test(entry)))throw Error(runtime==='legacy-react'?'旧项目入口须为已有的 TSX 文件':'项目入口须为已有的 TS、JS、TSX 或 JSX 文件');
 if(!entry&&(!mainScene||runtime==='legacy-react'))throw Error('项目须有脚本入口或原生主场景');
 if(mainScene&&!Object.hasOwn(files,filePath(mainScene.slice(6))))throw Error('主场景须为项目中已有的场景');
 const controls:Record<string,number>={};for(const [k,v] of Object.entries(data.controls??{})){if(typeof v!=='number'||!Number.isFinite(v))throw Error('无效场景参数');controls[k]=v;}
 const selection=typeof data.selected==='string'?filePath(data.selected):'';
 const selected=Object.hasOwn(files,selection)?selection:entry||(mainScene?filePath(mainScene.slice(6)):Object.keys(files)[0]);
 const migration=version===1?{fromSchemaVersion:1 as const,originalDocument:structuredClone(value)}:data.migration;
 if(migration&&(migration.fromSchemaVersion!==1||!Object.hasOwn(migration,'originalDocument')))throw Error('无效迁移备份');
 const demoId=String(data.demoId??(runtime==='godot'?'native':runtime==='react'?'react':'shader'));
 return {schemaVersion:2,runtime,demoId,entry,...(mainScene?{mainScene,mainSceneSource}:{}),selected,files,controls,mode:(data.mode??data.config?.mode)==='development'?'development':'production',...(migration?{migration:structuredClone(migration)}:{})};
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
  const found=Object.entries(project.files).find(([name,contents])=>typeof contents==='string'&&(
   (/\.tscn$/.test(name)&&contents.split(/\r?\n/,1)[0].includes('uid="'+uid+'"'))||
   (name.endsWith('.uid')&&contents.trim()===uid&&Object.hasOwn(project.files,name.slice(0,-4)))
  ));
  if(found)scene=found[0].endsWith('.uid')?found[0].slice(0,-4):found[0];
  else{
   const cache=project.files['/.godot/uid_cache.bin'];
   const cached=Array.isArray(cache)?resolveResourceUidFromCache(uid,Uint8Array.from(cache)):undefined;
   if(!cached?.startsWith('res://'))throw Error('主场景 UID 无法在项目文件中解析，请提供 mainScene 的 res:// 路径');
   scene=cached;
  }
 }
 const normalized=filePath(scene.startsWith('res://')?scene.slice(6):scene);
 if(!/\.(tscn|scn)$/.test(normalized))throw Error('主场景须为 tscn 或 scn 文件');
 return 'res:/'+normalized;
}
/** The original migration input is always available independently of later edits. */
export function exportProject(project:EditorProject,format:'original'|'migrated'='migrated'):unknown {
 return structuredClone(format==='original'&&project.migration?project.migration.originalDocument:parseProject(project));
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
 const files=renamedProjectFiles(prepared,old,path,project.runtime!=='legacy-react');
 const entry=project.entry===old?path:project.entry;
 const suffix=project.selected.slice(old.length);
 const selected=project.selected===old?path:project.runtime!=='legacy-react'&&['.uid','.import','.remap'].includes(suffix)&&project.selected===old+suffix?path+suffix:project.selected;
 const mainScene=project.mainSceneSource!=='project'&&project.mainScene==='res:/'+old?'res:/'+path:project.mainScene;
 const valid=parseProject({...project,files,entry,selected,mainScene});
 Object.assign(project,{files,entry,selected:valid.selected});
 if(valid.mainScene){project.mainScene=valid.mainScene;project.mainSceneSource=valid.mainSceneSource;}else{delete project.mainScene;delete project.mainSceneSource;}
 return true;
}
