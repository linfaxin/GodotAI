export interface EditorProject {schemaVersion:1;demoId:string;entry:string;selected:string;files:Record<string,string|number[]>;controls:Record<string,number>;mode:'production'|'development'}
// Legacy exports pretty-print byte arrays; their JSON can be much larger than decoded files.
export const MAX_PROJECT_DOCUMENT_BYTES=128*1024*1024;
export function filePath(value:string):string {
 const path='/'+value.replace(/^\/+/, '');
 if(path.length>180||path.split('/').slice(1).some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f\\]/.test(path))throw Error('请输入有效的项目文件路径');
 return path;
}
export function parseProject(value:unknown):EditorProject {
 const document=value as any;
 const data=document?.schemaVersion===1&&document.project?document.project:document;
 if(!data||typeof data!=='object'||!data.files||typeof data.files!=='object'||Array.isArray(data.files))throw Error('项目缺少 files');
 const entries=Object.entries(data.files);if(!entries.length||entries.length>64)throw Error('项目须包含 1–64 个文件');
 let bytes=0;const files:EditorProject['files']={};
 for(const [name,contents] of entries){const path=filePath(name);if(Object.hasOwn(files,path))throw Error('文件路径重复');if(typeof contents==='string'){bytes+=new TextEncoder().encode(contents).length;files[path]=contents;}else if(Array.isArray(contents)&&contents.length<=1048576&&contents.every(n=>Number.isInteger(n)&&n>=0&&n<=255)){bytes+=contents.length;files[path]=contents.slice();}else throw Error('文件内容须为文本或字节数组');}
 if(bytes>8388608)throw Error('项目内容不能超过 8 MB');
 const entry=filePath(data.entry??data.config?.entry??'');if(typeof files[entry]!=='string'||!entry.endsWith('.tsx'))throw Error('项目入口须为已有的 TSX 文件');
 const controls:Record<string,number>={};for(const [k,v] of Object.entries(data.controls??{})){if(typeof v!=='number'||!Number.isFinite(v))throw Error('无效场景参数');controls[k]=v;}
 const selected=typeof data.selected==='string'&&Object.hasOwn(files,data.selected)?data.selected:entry;
 return {schemaVersion:1,demoId:String(data.demoId??'shader'),entry,selected,files,controls,mode:(data.mode??data.config?.mode)==='development'?'development':'production'};
}
/** Validate a complete batch before committing any file to the live project. */
export function addProjectFiles(project:EditorProject,entries:[string,string|number[]][]):void {
 const files={...project.files};
 for(const [name,contents] of entries){const path=filePath(name);if(Object.hasOwn(files,path))throw Error('文件已存在：'+path);files[path]=contents;}
 project.files=parseProject({...project,files}).files;
}
export function renameProjectFile(project:EditorProject,old:string,name:string):boolean {
 const path=filePath(name);
 if(!Object.hasOwn(project.files,old))throw Error('文件不存在');
 if(path===old)return false;
 if(Object.hasOwn(project.files,path))throw Error('文件已存在');
 const files={...project.files,[path]:project.files[old]};delete files[old];
 const entry=project.entry===old?path:project.entry,selected=project.selected===old?path:project.selected;
 parseProject({...project,files,entry,selected});
 Object.assign(project,{files,entry,selected});return true;
}
