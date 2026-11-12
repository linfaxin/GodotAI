import {createWorkbench} from './workbench/workbench';
import {createExplorer} from './workbench/explorer';
import {createCodeEditor} from './workbench/code-editor';
import {createFileMenu} from './workbench/file-menu';
import {filePath,parseProject,addProjectFiles,renameProjectFile,canRenameProjectFile,MAX_PROJECT_DOCUMENT_BYTES,exportProject,type EditorProject} from './project-model';
import {createProjectStorage,openProjectDatabase} from './project-storage';
import type {TypeDiagnostic} from './compiler-types';
import {defaultProject,demoProject,migrateDemoProject as migrateDemo} from './project-templates';
import {createEnginePreview} from './engine-preview';
import {loadReleaseContext,loadSiteConfiguration,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease} from './release-context';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import type {RunnerEvent} from '@godot-js/react-browser/protocol';
import {suppressBrowserSave} from './browser-shortcuts';
suppressBrowserSave(window);
interface Control {key:string;label:string;min:number;max:number;step:number;value:number}
interface Demo {id:string;name:string;subtitle:string;file:string;hint:string;source:string;controls:Control[];runtime?:'godot'|'react';actions?:{key:string;label:string}[]}
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const worker=new Worker('compiler.worker.js'),projects=new Map<string,EditorProject>();
let demos:Demo[]=[],selected:Demo,current:EditorProject,ready=false,serial=0,revision=0,runSerial=0,checking=0,logCount=0,lastCityNotice='';
let diagnostics:TypeDiagnostic[]=[],toastTimer:ReturnType<typeof setTimeout>,checkTimer:ReturnType<typeof setTimeout>,saveTimer:ReturnType<typeof setTimeout>;
const projectEvents:Record<string,unknown>[]=[];
const requests=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void}>();
let nativePreview:Awaited<ReturnType<typeof createEnginePreview>>|undefined,nativePreviewPending:Promise<Awaited<ReturnType<typeof createEnginePreview>>>|undefined;
let runtimeSerial=0,activeEngineRevision=-1;
let siteEngineProfile='full-engine-v1',shellOnly=false,sessionReleaseContext:ReleaseContext|undefined;
const editor=createCodeEditor({changed(path,value){if(!current)return;current.files[path]=value;changed();},position(line,column){$('position').textContent=`Ln ${line}, Col ${column}`;},query:languageQuery,run:()=>void compile(true),toggleFiles:()=>workbench.toggleFiles()});
const workbench=createWorkbench({selectFile,focusEditor:()=>editor.focus(),toast});
const fileMenu=createFileMenu({select:selectFile,rename:path=>fileForm(path),remove:deleteFile,canDelete:path=>path!==current?.entry,canRename:path=>canRenameProjectFile(current,path),toast});
const explorer=createExplorer(path=>{workbench.filePicked();selectFile(path);editor.focus();},(path,x,y)=>fileMenu.open(path,x,y));
function toast(message:string){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
function log(message:string,level='log'){
 if(!logCount)$('logs').replaceChildren();const line=document.createElement('div');line.className='log-line '+level;line.textContent=message.slice(0,4096);$('logs').append(line);
 if(++logCount>500){$('logs').firstElementChild?.remove();logCount=500;}$('log-count').textContent=String(logCount);workbench.logAdded(level);
}
function status(text:string,kind=''){$('status').textContent=text;$('run-dot').className=`status-dot ${kind}`;$('runtime-name').textContent=ready?(siteEngineProfile==='engine-2d-v1'?'Godot Web · 2D':'Godot Web · Full'):'加载运行环境';$('runtime-meta').textContent=selected?.name??'Godot WASM + React';document.querySelector('.runtime-card .status-dot')!.className=`status-dot ${kind}`;}
function send(data:Record<string,unknown>){nativePreview?.runner.command(data);}
function rpc(kind:string,extra:Record<string,unknown>={}):Promise<any>{
 if(current.engineProfile!==siteEngineProfile)return Promise.reject(Error('当前项目需要 '+current.engineProfile+'；原文已保留，请在匹配站点打开或另存兼容副本'));
 const id=++serial,files=current.files;
 return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});worker.postMessage({id,kind,files,entry:current.entry,runtime:current.runtime,mainScene:current.mainSceneSource==='project'?undefined:current.mainScene,mode:current.mode,controls:current.controls,engineProfile:current.engineProfile,demoApiVersion:current.demoApiVersion,releaseContext:sessionReleaseContext,...extra});});
}
worker.onmessage=({data})=>{const pending=requests.get(data.id);if(pending){requests.delete(data.id);pending.resolve(data);}};
worker.onerror=event=>{for(const request of requests.values())request.reject(Error(event.message));requests.clear();log(event.message,'error');status('编译器异常','error');$('run').removeAttribute('disabled');workbench.setReady();};
async function languageQuery(kind:'completion'|'hover',path:string,offset:number){const response=await rpc(kind,{path,offset});return response.result;}
let db:Promise<IDBDatabase|undefined>,storage:ReturnType<typeof createProjectStorage>;
async function initializeProjectStorage(profile:string){
 db=openProjectDatabase(profile);storage=createProjectStorage(db);await db;if(await storage.consumeLegacyMigrationNotice())toast('已复制旧版存档；旧页面后续修改请通过导出和导入迁移，不会自动同步');
}
let persistenceBlocked=false,recoverySnapshot:unknown,retainedImport:unknown;
const protectedProjectIds=new Set<string>();
async function save():Promise<boolean>{
 const savingSelected=selected.id;
 if(persistenceBlocked){$('saved').textContent='保存失败';return false;}
 $('saved').textContent='正在保存';
 try{
  const result=await storage.save(savingSelected);if(selected.id!==savingSelected)return false;
  if(result.conflicts.includes(selected.id)){$('saved').textContent='保存冲突';toast('另一个标签页已更新当前项目。本地修改尚未保存，请先导出本地修改，然后刷新页面。');return false;}
  if(result.invalid.has(selected.id)){$('saved').textContent='保存失败';toast('未保存当前修改：'+result.invalid.get(selected.id));return false;}
  if(storage.hasPending(selected.id)){$('saved').textContent='正在保存';return false;}
  $('saved').textContent='已自动保存';return true;
 }catch(error){$('saved').textContent='保存失败';toast('未保存当前修改：'+String(error));return false;}
}
function appendDemoButton(demo:Demo){
 if(document.querySelector('[data-demo="'+CSS.escape(demo.id)+'"]'))return;
 const button=document.createElement('button');button.className='demo-card';button.dataset.demo=demo.id;button.dataset.example=demo.id;button.setAttribute('role','menuitemradio');
 const art=document.createElement('div');art.className='demo-art '+demo.id;art.setAttribute('aria-hidden','true');
 const name=document.createElement('div');name.className='demo-name';name.textContent=demo.name;const check=document.createElement('span');check.className='demo-check';check.textContent='✓';name.append(check);
 const subtitle=document.createElement('div');subtitle.className='demo-subtitle';subtitle.textContent=demo.subtitle;
 const file=document.createElement('div');file.className='demo-file';file.textContent=demo.file;button.append(art,name,subtitle,file);
 button.onclick=()=>{select(demo);menu.open=false;$('project-switcher').focus();};$('demos').append(button);
}
function registerProjectDemo(id:string,project:EditorProject):Demo{
 const existing=demos.find(d=>d.id===id);if(existing)return existing;
 const source=demos.find(d=>d.id===project.demoId),file=(project.entry||project.selected).split('/').at(-1)!;
 const demo:Demo=source?{...source,id,name:source.name+' · 副本'}:{id,name:'导入项目 · '+file,subtitle:project.engineProfile,file,hint:project.engineProfile===siteEngineProfile?'独立项目，修改会单独保存。':'此项目需要 '+project.engineProfile+'；可查看与导出原文。',source:typeof project.files[project.entry]==='string'?project.files[project.entry] as string:'',runtime:project.runtime,controls:[]};
 demos.push(demo);appendDemoButton(demo);return demo;
}
async function restore(){
 const database=await db;if(!database)return;
 try{
  const loaded=await storage.load();recoverySnapshot=await storage.recovery();retainedImport=await storage.recovery('last-import');if(retainedImport!==undefined)registerRetainedImport();for(const id of loaded.invalid.keys())protectedProjectIds.add(id);
  if(recoverySnapshot!==undefined){$('export-recovery').hidden=false;$('restore-recovery').hidden=false;}
  if(!loaded.snapshot)return;
  for(const [id,value]of loaded.snapshot.projects){
   try{const parsed=parseProject(value),demo=demos.find(d=>d.id===id);
    const project=demo&&parsed.engineProfile===siteEngineProfile?migrateDemo(parsed,demo):parsed;
    projects.set(id,project);registerProjectDemo(id,project);if(loaded.migrated.includes(id)||project!==parsed)storage.stage(id,project);
   }catch{}
  }
  if(loaded.invalid.size){
   recoverySnapshot=await storage.preserveInvalidSnapshot(loaded.original,[...loaded.invalid.keys()]);$('export-recovery').hidden=false;$('restore-recovery').hidden=false;
   toast('部分项目无法解析，原始记录已保留，可导出恢复备份');
  }
  return projects.has(loaded.snapshot.selected??'')?loaded.snapshot.selected:undefined;
 }catch(error){
  persistenceBlocked=true;try{recoverySnapshot=await storage.recovery('current');$('export-recovery').hidden=false;}catch{}
  toast('本地项目恢复失败，已暂停自动保存');log(String(error),'error');
 }
}
function changed(){storage.stage(selected.id,current);revision++;$('saved').textContent='正在保存';clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(),250);clearTimeout(checkTimer);checkTimer=setTimeout(()=>void check(),1100);}
function initialProject(demo:Demo):EditorProject{return demo.id==='native'||demo.id==='react'?defaultProject(demo.runtime??'react',siteEngineProfile):demoProject(demo,siteEngineProfile);}

function visibleFile(path:string){return path.split('/').at(-1)!=='package.json';}
function renderFiles(){fileMenu.close();const paths=Object.keys(current.files).filter(visibleFile);editor.reconcile(paths);explorer.render(paths,current.selected);workbench.syncFiles(paths,current.selected);}
function selectFile(path:string){if(!current||!Object.hasOwn(current.files,path))return;if(!visibleFile(path))path=current.entry||current.selected;current.selected=path;editor.show(path,current.files[path]);editor.diagnostics(diagnostics);renderFiles();}
function setDiagnostics(items:TypeDiagnostic[],reveal=false){
 diagnostics=items;editor.diagnostics(items);$('problem-count').textContent=String(items.length);$('type-status').textContent=items.length?`${items.length} 个问题`:'类型检查通过';$('diagnostics').replaceChildren();
 if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='没有发现问题';$('diagnostics').append(empty);}
 for(const item of items){const button=document.createElement('button');button.className='diagnostic-item';const code=document.createElement('code');code.textContent=`${item.file?.split('/').at(-1)??'项目'}:${item.line??0}:${item.column??0}`;const text=document.createElement('span');text.textContent=item.message;button.append(code,text);button.onclick=()=>{if(item.file&&Object.hasOwn(current.files,item.file)){selectFile(item.file);editor.reveal(item.start??0,item.length??1);}};$('diagnostics').append(button);}
 if(reveal&&items.length)workbench.showProblems();
}
async function check(){if(!current)return;const key=++checking,rev=revision;try{const response=await rpc('check');if(key===checking&&rev===revision)setDiagnostics(response.diagnostics??[]);}catch(error){log(String(error),'error');}}
async function compile(focusPreview=false){
 if(!ready||!current)return;if(current.engineProfile!==siteEngineProfile){toast('项目与当前引擎配置不匹配，原文已保留');return;}const focusOrigin=document.activeElement;clearTimeout(checkTimer);const key=++runSerial,rev=revision;checking++;$('run').setAttribute('disabled','');workbench.setBuilding();status('正在检查 TypeScript');
 try{const response=await rpc('compile');if(key!==runSerial||rev!==revision)return;setDiagnostics(response.diagnostics??[],true);
  if(diagnostics.some(d=>d.category==='error')){status('编译未通过','error');log(`TypeScript 检查未通过：${diagnostics.length} 个问题`,'warn');return;}
  log(`✓ ${selected.name} 编译通过，正在运行`);
  {
   if(!(response.pack instanceof Uint8Array))throw Error('原生项目编译未产生 PCK');
   if(!sessionReleaseContext)throw Error('E_RELEASE_CONTEXT_REQUIRED');
   assertCompiledRelease(sessionReleaseContext,response.manifest);
   activeEngineRevision=rev;await nativePreview!.run(response.pack,rev,response.manifest);
   if(focusPreview&&key===runSerial)$('preview').querySelector('iframe')?.focus();
  }
  workbench.runStarted();
 }catch(error){if(key===runSerial){if(activeEngineRevision===rev&&nativePreview?.runner.state==='exited')return;log(String(error),'error');status('编译失败','error');}}
 finally{if(key===runSerial){$('run').removeAttribute('disabled');workbench.setReady();}}
}
function controls(){
 $('controls').replaceChildren();$('demo-actions').replaceChildren();$('hint').textContent=selected.hint;
 for(const c of selected.controls){const div=document.createElement('div');div.className='control';const label=document.createElement('label'),name=document.createElement('span'),output=document.createElement('output'),input=document.createElement('input');name.textContent=c.label;input.type='range';input.id=`control-${c.key}`;input.min=String(c.min);input.max=String(c.max);input.step=String(c.step);input.value=String(current.controls[c.key]??c.value);output.textContent=input.value;label.htmlFor=input.id;label.append(name,output);input.oninput=()=>{current.controls[c.key]=Number(input.value);output.textContent=input.value;send({type:'controls',controls:current.controls});storage.stage(selected.id,current);void save();};div.append(label,input);$('controls').append(div);}
 for(const action of selected.actions??[]){const button=document.createElement('button');button.dataset.action=action.key;button.textContent=action.label;button.onclick=()=>action.key==='load'?importCity():send({type:'action',action:action.key});$('demo-actions').append(button);}
}
function select(demo:Demo,run=true){
 if(protectedProjectIds.has(demo.id)&&!projects.has(demo.id)){const id='project-'+crypto.randomUUID(),project=initialProject(demo);projects.set(id,project);storage.stage(id,project);select(registerProjectDemo(id,project),run);return;}
 projectEvents.length=0;activeEngineRevision=-1;
 clearTimeout(checkTimer);runSerial++;checking++;revision++;selected=demo;$('current-project-label').textContent=`(当前：${demo.name})`;$('project-switcher').title=`切换项目 (当前：${demo.name})`;$('project-switcher').setAttribute('aria-label',`切换项目 (当前：${demo.name})`);current=projects.get(demo.id)??initialProject(demo);if(!projects.has(demo.id))storage.stage(demo.id,current);projects.set(demo.id,current);workbench.resetTabs();editor.reset();explorer.reset();setDiagnostics([]);selectFile(current.selected);$('export-original').hidden=!current.migration;controls();$<HTMLSelectElement>('mode').value=current.mode;
 for(const tab of document.querySelectorAll<HTMLElement>('[data-demo]')){const active=tab.dataset.demo===demo.id;tab.classList.toggle('active',active);tab.setAttribute('aria-checked',String(active));}
 $<HTMLSelectElement>('profile').replaceChildren(new Option(getEngineProfile(siteEngineProfile).label,siteEngineProfile));
 $('release-info').textContent='Godot 4.6.1 · '+getEngineProfile(siteEngineProfile).label;
 $('runtime-meta').textContent=demo.name;document.title=`${demo.name} · GodotAI Playground`;void save();if(current.engineProfile!==siteEngineProfile){runtimeSerial++;ready=false;void nativePreview?.stop();$('run').setAttribute('disabled','');$('check').setAttribute('disabled','');status('项目需要 '+current.engineProfile,'error');toast('已保留此项目，请在匹配的引擎站点打开或导出原文');}else{$('check').removeAttribute('disabled');void prepareRuntime(run);}
}
function fileForm(old?:string){if(old&&!canRenameProjectFile(current,old)){toast('框架阶段暂只支持普通脚本和文本场景改名，资源与声明文件改名尚未开放');return;}const form=$<HTMLFormElement>('file-form'),input=$<HTMLInputElement>('filename');form.hidden=false;input.value=old?.slice(1)??'src/NewComponent.tsx';form.dataset.old=old??'';$('submit-file').textContent=old?'重命名':'创建';input.focus();input.select();}
$<HTMLFormElement>('file-form').onsubmit=async event=>{event.preventDefault();try{
 const form=$<HTMLFormElement>('file-form'),path=filePath($<HTMLInputElement>('filename').value.trim()),old=form.dataset.old;
 let modified=true;
 if(old){const target=current,started=revision,previous=current.files;
  const response=path===old?undefined:await rpc('rename',{path:old,newPath:path});
  if(current!==target||revision!==started)throw Error('项目已变化，请重新执行重命名');
  if(response?.error)throw Error(response.error);
  modified=renameProjectFile(current,old,path,response?.renamePlan);if(modified)for(const suffix of ['', '.uid', '.import', '.remap']){
  if(Object.hasOwn(previous,old+suffix)&&!Object.hasOwn(current.files,old+suffix)&&Object.hasOwn(current.files,path+suffix)){
   editor.rename(old+suffix,path+suffix);workbench.renameFile(old+suffix,path+suffix);
  }
 }}
 else addProjectFiles(current,[[path,path.endsWith('.json')?'{}\n':/\.[jt]sx?$/.test(path)?'export const value = 1;\n':'']]);
 form.hidden=true;selectFile(path);editor.focus();if(modified)changed();
}catch(error){toast(String(error));}};
function deleteFile(path:string){if(path===current.entry)return;delete current.files[path];selectFile(current.selected===path?current.entry:current.selected);changed();}
$('new-file').onclick=()=>fileForm();$('file-search').oninput=renderFiles;
$<HTMLInputElement>('asset-import').onchange=async event=>{
 const input=event.target as HTMLInputElement,target=current,files=Array.from(input.files??[]);if(!files.length)return;
 try{
  const additions:[string,string|number[]][]=[];
  for(const file of files){if(file.size>1048576)throw Error('单个资源不能超过 1 MB');const path=filePath('assets/'+file.name);additions.push([path,/\.(?:tres|tscn|godot|gd|gdshader|gdshaderinc|cfg|uid|import|gltf|svg|json)$/i.test(file.name)?await file.text():Array.from(new Uint8Array(await file.arrayBuffer()))]);}
  addProjectFiles(target,additions);
  if(current===target){renderFiles();changed();}else{const id=[...projects].find(([,project])=>project===target)?.[0];if(id)storage.stage(id,target);void save();}
  toast('资源已添加，可在项目面板查看与导出');
 }catch(error){toast(String(error));}finally{input.value='';}
};
function download(name:string,value:unknown){let text=JSON.stringify(value);if(text.length<=16*1024*1024)text=JSON.stringify(value,null,2);const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export').onclick=()=>download('godot-playground-project.json',current);
$('export-original').onclick=()=>download('godot-playground-original.json',exportProject(current,'original'));
$('restore-recovery').onclick=async()=>{try{const recovery=recoverySnapshot??await storage.recovery();if(!await save())throw Error('当前编辑尚未安全保存，请先导出修改');const result=await storage.restore(recovery as any);if(!result.snapshot)throw Error(result.interrupted?'恢复期间有新编辑或未保存项目，已取消切换；请先保存或导出修改':'本地项目存在保存冲突，未恢复任何内容');const snapshot=result.snapshot;persistenceBlocked=false;recoverySnapshot=await storage.recovery();projects.clear();for(const [id,document]of snapshot.projects){try{const parsed=parseProject(document),demo=demos.find(item=>item.id===id),project=demo&&parsed.engineProfile===siteEngineProfile?migrateDemo(parsed,demo):parsed;projects.set(id,project);registerProjectDemo(id,project);if(project!==parsed)storage.stage(id,project);}catch{}}const demo=demos.find(d=>d.id===snapshot.selected)??demos[0];select(demo);toast('已从恢复备份还原项目');}catch(error){toast(String(error));}};
$('export-recovery').onclick=()=>download('godot-playground-recovery.json',recoverySnapshot);
function registerRetainedImport(){
 let button=document.getElementById('retained-import');if(!button){button=document.createElement('button');button.id='retained-import';button.textContent='查看保留的导入项目';$('export-recovery').parentElement?.append(button);button.onclick=()=>showRetainedImport(retainedImport);}
}
function showRetainedImport(raw:unknown,project?:EditorProject){
 let dialog=document.querySelector<HTMLDialogElement>('#unsupported-project');if(!dialog){dialog=document.createElement('dialog');dialog.id='unsupported-project';document.body.append(dialog);}
 dialog.replaceChildren();const title=document.createElement('p');title.textContent=project?'项目需要 '+project.engineProfile+'，本站使用 '+siteEngineProfile+'。原文已保留，现有项目未被替换。':'已保留的原始导入文档。';
 const source=document.createElement('pre');source.textContent=JSON.stringify(raw,null,2).slice(0,32768);source.style.maxHeight='40vh';source.style.overflow='auto';
 const exportButton=document.createElement('button');exportButton.textContent='导出原始项目';exportButton.onclick=()=>download('godot-playground-original.json',raw);
 const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog!.close();dialog.append(title,source,exportButton,close);
 if(project&&['full-engine-v1','engine-2d-v1'].includes(project.engineProfile)){
  const copy=document.createElement('button');copy.textContent='创建当前引擎副本并检查';copy.onclick=()=>{dialog!.close();void importDocument(raw,{convert:true}).then(id=>{if(id){select(demos.find(d=>d.id===id)!,false);void check();}}).catch(error=>toast(String(error)));};dialog.append(copy);
 }
 dialog.showModal();
}
async function importDocument(document:unknown,{shared=false,convert=false}:{shared?:boolean;convert?:boolean}={}):Promise<string|undefined>{
 const project=parseProject(document);
 if(project.engineProfile!==siteEngineProfile&&!convert){
  await storage.retainImport(document);retainedImport=structuredClone(document);registerRetainedImport();showRetainedImport(document,project);toast('项目原文已保留，需要匹配的引擎配置');return;
 }
 const base=convert?parseProject({...project,engineProfile:siteEngineProfile,migration:project.migration??{fromSchemaVersion:3,originalDocument:structuredClone(document)}}):project;
 const sourceDemo=demos.find(demo=>demo.id===base.demoId),imported=sourceDemo?migrateDemo(base,sourceDemo):base;
 const id='project-'+crypto.randomUUID();projects.set(id,imported);const demo=registerProjectDemo(id,imported);storage.stage(id,imported);
 if(!shared){select(demo,!convert);toast(convert?'已创建独立副本，请检查 API 与资源兼容性':'项目已导入并独立保存');}
 return id;
}
$<HTMLInputElement>('import').onchange=async event=>{
 const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
 try{if(file.size>MAX_PROJECT_DOCUMENT_BYTES)throw Error('项目文件不能超过 128 MB');await importDocument(JSON.parse(await file.text()));}
 catch(error){toast(String(error));log(String(error),'error');}finally{input.value='';}
};
$('reset').onclick=()=>{if(selected.id.startsWith('project-')){const source=demos.find(d=>d.id===current.demoId);if(!source){toast('没有对应示例模板，请导入原始项目或新建项目');return;}const replacement=initialProject(source);projects.set(selected.id,replacement);storage.stage(selected.id,replacement);}else projects.delete(selected.id);select(selected);toast('已恢复当前示例');};
$('share').onclick=async()=>{try{const json=new TextEncoder().encode(JSON.stringify(exportProject(current)));const compressed=new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());if(compressed.length>24576)throw Error('项目较大，请改用导出项目 JSON');let binary='';for(const n of compressed)binary+=String.fromCharCode(n);const url=new URL(location.href);url.hash='project='+btoa(binary);await navigator.clipboard.writeText(url.href);toast('项目分享链接已复制');}catch(error){toast(String(error));}};
async function importShared(){if(!location.hash.startsWith('#project='))return;try{const binary=atob(location.hash.slice(9).replace(/-/g,'+').replace(/_/g,'/'));if(binary.length>24576)throw Error('分享链接过大');const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_PROJECT_DOCUMENT_BYTES)throw Error('分享项目过大');chunks.push(value.slice());}}finally{await reader.cancel();}const text=await new Blob(chunks).text();return await importDocument(JSON.parse(text),{shared:true});}catch(error){toast('无法读取分享项目：'+String(error));}}
function importCity(){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{const file=input.files?.[0];if(!file)return;try{if(file.size>262144)throw Error('地图文件超过 256 KB');send({type:'import-data',data:JSON.parse(await file.text())});log(`✓ 已读取 ${file.name}`);}catch(error){log(String(error),'error');}};input.click();}
$('run').onclick=()=>void compile(true);$('check').onclick=()=>void check();$('stop').onclick=()=>{runSerial++;$('run').toggleAttribute('disabled',!ready);workbench.setReady();void nativePreview?.stop();};
$<HTMLSelectElement>('mode').onchange=()=>{current.mode=$<HTMLSelectElement>('mode').value==='development'?'development':'production';changed();if(ready)void compile();};
$('clear-log').onclick=()=>{logCount=0;$('logs').replaceChildren();$('log-count').textContent='0';workbench.clearLogs();};
$('credits-open').onclick=()=>$<HTMLDialogElement>('credits').showModal();$('credits-close').onclick=()=>$<HTMLDialogElement>('credits').close();
const menu=$<HTMLDetailsElement>('examples-menu');
function positionProjects(){const popover=$('project-popover');popover.style.removeProperty('--menu-shift');const overflow=popover.getBoundingClientRect().right-innerWidth+8;if(overflow>0&&getComputedStyle(popover).position==='absolute')popover.style.setProperty('--menu-shift',`${-overflow}px`);}
menu.addEventListener('toggle',()=>{$('project-switcher').setAttribute('aria-expanded',String(menu.open));if(menu.open)positionProjects();});
$('project-close').onclick=()=>{menu.open=false;$('project-switcher').focus();};window.addEventListener('resize',()=>{if(menu.open)positionProjects();});
window.addEventListener('keydown',event=>{if(event.defaultPrevented)return;if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();void compile(true);}});
addEventListener('message',event=>{
 if(event.data?.type==='godotjs-preview-escape'&&nativePreview&&event.origin===nativePreview.runner.previewOrigin&&event.source===$('preview').querySelector('iframe')?.contentWindow)workbench.exitPreview();
});
function onProjectEvent(data:any){
 projectEvents.push(data);if(projectEvents.length>200)projectEvents.shift();
 if(data.type==='export-data'){try{const json=JSON.stringify(data.data);if(json.length>262144||!/^[-a-z0-9_.]+$/i.test(data.name))throw Error('导出数据无效');download(data.name,data.data);log(`✓ 已导出 ${data.name}`);}catch(error){log(String(error),'error');}}
 if(data.type==='stats'){$('fps').textContent=`${data.fps} FPS`;const s=data.stats??{};if(s.kind==='city'&&s.notice!==lastCityNotice){lastCityNotice=s.notice;if(s.notice?.includes('导入')||s.notice?.startsWith('Error'))log(s.notice);}const text:Record<string,string>={city:`${s.buildings} BUILDINGS · UNDO ${s.undo}`,destruction:`${s.bodies} RIGID BODIES · ${s.spread} m`,racing:`${s.speed} km/h · LAP ${s.laps} · ${s.time} s`,match3:`SCORE ${s.score} · MOVES ${s.moves} · ${s.phase}`,dungeon:`SEED ${s.seed} · ROOMS ${s.revealed}/${s.rooms}`};$('telemetry').textContent=text[s.kind]??(current.demoId==='islands'?`COINS ${s.coins??0}/${s.total??6} · JUMPS ${s.jumps??0}`:current.demoId==='lights'?`3 LIGHTS · ${s.shadows?'SHADOWS ON':'SHADOWS OFF'}`:'3 LIVE MATERIALS · WEBGL 2');}
}
function onEngineEvent(event:RunnerEvent){
 const revision=event.type==='exit'?event.report.revision:event.revision;
 if(revision!==activeEngineRevision)return;
 if(event.type==='project'){onProjectEvent({...event.data,generation:event.generation});return;}
 if(event.type==='log'){log(event.text,event.level);return;}
 if(event.type==='exit'){
  $('stop').setAttribute('disabled','');$('fps').textContent='— FPS';
  if(event.report.diagnostic?.stack)log(event.report.diagnostic.stack,'error');
  if(event.report.reason==='clean-exit'||event.report.reason==='forced-frame-disposal'){status('已停止');$('telemetry').textContent='场景已释放';}
  else{status('运行错误','error');log(event.report.detail??event.report.reason,'error');}
  return;
 }
 if(event.state==='running'){
  // Compilation snapshots controls before the new session can accept commands.
  // Replay the current values so edits made during startup reach this session.
  send({type:'controls',controls:current.controls});
  $('preview-placeholder').hidden=true;$('stop').removeAttribute('disabled');status('实时运行中','running');$('telemetry').textContent=getEngineProfile(siteEngineProfile).label;
 }
 else if(event.state!=='exited')status(({downloading:'正在下载引擎',preloading:'正在装载项目',initializing:'正在初始化引擎',starting:'正在启动场景','waiting-ready':'等待场景就绪',stopping:'正在停止'} as Record<string,string>)[event.state]??'正在连接预览');
}
async function prepareRuntime(run:boolean){
 const sequence=++runtimeSerial;ready=false;$('run').setAttribute('disabled','');
 if(shellOnly){ready=false;$('run').setAttribute('disabled','');status('仅编辑器测试模式');workbench.setReady();return;}
 if(current?.engineProfile!==siteEngineProfile){ready=false;status('项目需要其他引擎配置','error');return;}
 try{
  await nativePreview?.stop();if(sequence!==runtimeSerial)return;
  nativePreviewPending??=createEnginePreview($('preview'),onEngineEvent).catch(error=>{nativePreviewPending=undefined;throw error;});
  nativePreview=await nativePreviewPending;if(sequence!==runtimeSerial)return;ready=true;
  $('runtime-name').textContent=siteEngineProfile==='engine-2d-v1'?'Godot Web · 2D':'Godot Web · Full';$('run').removeAttribute('disabled');workbench.setReady();
  if(run)void compile();
  if(ready)$('run').removeAttribute('disabled');
 }catch(error){if(sequence===runtimeSerial){status('加载失败','error');log(String(error),'error');$('preview-placeholder').querySelector('p')!.textContent=String(error);}}
}
async function start(){
 const site=await loadSiteConfiguration();siteEngineProfile=site.runtimeProfile;shellOnly=site.shellOnly;
 if(!shellOnly){sessionReleaseContext=await loadReleaseContext();if(sessionReleaseContext.engineProfile!==siteEngineProfile)throw Error('E_SITE_ENGINE_PROFILE');}
 await initializeProjectStorage(siteEngineProfile);
 const response=await fetch('catalog.json');if(!response.ok)throw Error('无法加载示例目录');demos=[...(['godot','react'] as const).map(runtime=>{const project=defaultProject(runtime,siteEngineProfile);return {id:project.demoId,name:runtime==='godot'?'Godot 原生项目':'React + Godot',subtitle:runtime==='godot'?'NATIVE ENGINE / TYPESCRIPT':'NATIVE ENGINE / REACT',file:project.entry.split('/').at(-1)!,hint:runtime==='godot'?'直接编写 Godot 脚本、场景与资源，使用'+getEngineProfile(siteEngineProfile).label+' API。':'使用 React 声明场景树，节点、资源和方法来自'+getEngineProfile(siteEngineProfile).label+'。',source:project.files[project.entry] as string,runtime,controls:[]};}),...(await response.json()).map((demo:Demo)=>({...demo,runtime:'react' as const}))];$('project-count').textContent=`${demos.length} 个示例`;
 for(const demo of demos)appendDemoButton(demo);
 for(const [name,version] of Object.entries({godot:'4.6.1 · '+getEngineProfile(siteEngineProfile).label,react:'19.3.1','@godot-js/react':'0.1.0','@playground/api':'内置'})){const item=document.createElement('div');item.className='dependency-item';const label=document.createElement('span');label.textContent=name;const code=document.createElement('code');code.textContent=version;item.append(label,code);$('dependencies').append(item);}
 const restored=await restore(),shared=await importShared();select(demos.find(d=>d.id===(shared??new URL(location.href).searchParams.get('project')??restored))??demos[0],false);
 if(shared&&await save()){const url=new URL(location.href);url.hash='';history.replaceState(history.state,'',url.href);}
 await prepareRuntime(true);
}
start().catch(error=>{status('加载失败','error');log(String(error),'error');});
// Read-only diagnostics for integration tests and local debugging.
(globalThis as any).__playgroundWorkbench={inspect:()=>({project:structuredClone(current),projectId:selected?.id,engineProfile:siteEngineProfile,storageDatabaseName:'godotjs-playground-v3:'+siteEngineProfile,diagnostics:structuredClone(diagnostics),ready,revision,events:structuredClone(projectEvents),engine:nativePreview?{releaseId:nativePreview.manifest.id,profile:nativePreview.manifest.runtimeProfile,state:nativePreview.runner.state}:undefined,releaseContext:structuredClone(sessionReleaseContext)})};
