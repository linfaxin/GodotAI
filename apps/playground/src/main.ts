import {createWorkbench} from './workbench/workbench';
import {createExplorer} from './workbench/explorer';
import {createCodeEditor} from './workbench/code-editor';
import {createFileMenu} from './workbench/file-menu';
import {filePath,parseProject,addProjectFiles,renameProjectFile,canRenameProjectFile,MAX_PROJECT_DOCUMENT_BYTES,exportProject,type EditorProject} from './project-model';
import {createProjectStorage} from './project-storage';
import type {TypeDiagnostic} from './compiler-types';
import {defaultProject} from './project-templates';
import {createEnginePreview} from './engine-preview';
import type {RunnerEvent} from '@godot-js/react-browser/protocol';
import {suppressBrowserSave} from './browser-shortcuts';
suppressBrowserSave(window);
interface Control {key:string;label:string;min:number;max:number;step:number;value:number}
interface Demo {id:string;name:string;subtitle:string;file:string;hint:string;source:string;controls:Control[];runtime?:'godot'|'react'|'legacy-react';actions?:{key:string;label:string}[]}
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const token=crypto.randomUUID(),worker=new Worker('compiler.worker.js'),projects=new Map<string,EditorProject>();
let demos:Demo[]=[],selected:Demo,current:EditorProject,frame:HTMLIFrameElement|undefined,ready=false,serial=0,revision=0,runSerial=0,checking=0,logCount=0,lastCityNotice='';
let diagnostics:TypeDiagnostic[]=[],toastTimer:ReturnType<typeof setTimeout>,checkTimer:ReturnType<typeof setTimeout>,saveTimer:ReturnType<typeof setTimeout>;
const requests=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void}>();
let nativePreview:Awaited<ReturnType<typeof createEnginePreview>>|undefined,nativePreviewPending:Promise<Awaited<ReturnType<typeof createEnginePreview>>>|undefined;
let runtimeSerial=0,legacyReady=false,activeEngineRevision=-1;
const editor=createCodeEditor({changed(path,value){if(!current)return;current.files[path]=value;changed();},position(line,column){$('position').textContent=`Ln ${line}, Col ${column}`;},query:languageQuery,run:()=>void compile(true),toggleFiles:()=>workbench.toggleFiles()});
const workbench=createWorkbench({selectFile,focusEditor:()=>editor.focus(),toast});
const fileMenu=createFileMenu({select:selectFile,rename:path=>fileForm(path),remove:deleteFile,canDelete:path=>path!==current?.entry,canRename:path=>canRenameProjectFile(current,path),toast});
const explorer=createExplorer(path=>{workbench.filePicked();selectFile(path);editor.focus();},(path,x,y)=>fileMenu.open(path,x,y));
function toast(message:string){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
function log(message:string,level='log'){
 if(!logCount)$('logs').replaceChildren();const line=document.createElement('div');line.className='log-line '+level;line.textContent=message.slice(0,4096);$('logs').append(line);
 if(++logCount>500){$('logs').firstElementChild?.remove();logCount=500;}$('log-count').textContent=String(logCount);workbench.logAdded(level);
}
function status(text:string,kind=''){$('status').textContent=text;$('run-dot').className=`status-dot ${kind}`;$('runtime-name').textContent=ready?(current?.runtime==='legacy-react'?'Godot Web · 兼容':'Godot Web · Full'):'加载运行环境';$('runtime-meta').textContent=selected?.name??'Godot WASM + React';document.querySelector('.runtime-card .status-dot')!.className=`status-dot ${kind}`;}
function send(data:Record<string,unknown>){frame?.contentWindow?.postMessage({...data,token},'*');}
function rpc(kind:string,extra:Record<string,unknown>={}):Promise<any>{
 const id=++serial,files=current.files;
 return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});worker.postMessage({id,kind,files,entry:current.entry,runtime:current.runtime,mainScene:current.mainSceneSource==='project'?undefined:current.mainScene,mode:current.mode,...extra});});
}
worker.onmessage=({data})=>{const pending=requests.get(data.id);if(pending){requests.delete(data.id);pending.resolve(data);}};
worker.onerror=event=>{for(const request of requests.values())request.reject(Error(event.message));requests.clear();log(event.message,'error');status('编译器异常','error');$('run').removeAttribute('disabled');workbench.setReady();};
async function languageQuery(kind:'completion'|'hover',path:string,offset:number){const response=await rpc(kind,{path,offset});return response.result;}
const db=new Promise<IDBDatabase|undefined>(resolve=>{
 if(!globalThis.indexedDB){resolve(undefined);return;}
 const request=indexedDB.open('godotjs-showcase-workbench-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(undefined);
});
const storage=createProjectStorage(db);
let persistenceBlocked=false,recoverySnapshot:unknown;
async function save():Promise<boolean>{
 if(persistenceBlocked){$('saved').textContent='保存失败';return false;}
 try{
  const result=await storage.save(selected.id);
  if(result.conflicts.includes(selected.id)){$('saved').textContent='保存冲突';toast('另一个标签页已更新当前项目。本地修改尚未保存，请先导出本地修改，然后刷新页面。');return false;}
  if(result.invalid.has(selected.id)){$('saved').textContent='保存失败';toast('未保存当前修改：'+result.invalid.get(selected.id));return false;}
  if(storage.hasPending(selected.id)){$('saved').textContent='正在保存';return false;}
  $('saved').textContent='已自动保存';return true;
 }catch(error){$('saved').textContent='保存失败';toast('未保存当前修改：'+String(error));return false;}
}
async function restore(){
 const database=await db;if(!database)return;
 try{
  const loaded=await storage.load();recoverySnapshot=await storage.recovery();
  if(recoverySnapshot!==undefined){$('export-recovery').hidden=false;$('restore-recovery').hidden=false;}
  if(!loaded.snapshot)return;
  for(const [id,value] of loaded.snapshot.projects){
   const demo=demos.find(d=>d.id===id);if(!demo)continue;
   try{const project=parseProject(value);projects.set(id,project);if(loaded.migrated.includes(id))storage.stage(id,project);}
   catch{const replacement=initialProject(demo);projects.set(id,replacement);storage.stage(id,replacement);}
  }
  if(loaded.invalid.size){
   recoverySnapshot=loaded.original;$('export-recovery').hidden=false;$('restore-recovery').hidden=false;
   await new Promise<void>((resolve,reject)=>{const tx=database.transaction('projects','readwrite'),store=tx.objectStore('projects');store.put(loaded.original,'recovery:'+Date.now()+':'+crypto.randomUUID());store.put(loaded.original,'recovery');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
   toast('部分项目无法恢复，原始数据已备份，可导出恢复备份');
  }
  return loaded.snapshot.selected;
 }catch(error){
  persistenceBlocked=true;try{recoverySnapshot=await storage.recovery('current');$('export-recovery').hidden=false;}catch{}
  toast('本地项目恢复失败，已暂停自动保存');log(String(error),'error');
 }
}
function changed(){storage.stage(selected.id,current);revision++;$('saved').textContent='正在保存';clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(),250);clearTimeout(checkTimer);checkTimer=setTimeout(()=>void check(),1100);}
function initialProject(demo:Demo):EditorProject{if(demo.runtime==='godot'||demo.runtime==='react')return defaultProject(demo.runtime);return {schemaVersion:2,runtime:'legacy-react',demoId:demo.id,entry:'/src/'+demo.file,selected:'/src/'+demo.file,files:{['/src/'+demo.file]:demo.source,'/package.json':JSON.stringify({private:true,dependencies:{react:'19.3.1','@godot-js/react':'0.1.0'}},null,2),'/README.md':`# ${demo.name}\n\n${demo.hint}\n\n入口：src/${demo.file}\n\n内置资源由 playground 提供，见「开源鸣谢」。\n`},controls:Object.fromEntries(demo.controls.map(c=>[c.key,c.value])),mode:'production'};}
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
 if(!ready||!current)return;const focusOrigin=document.activeElement;clearTimeout(checkTimer);const key=++runSerial,rev=revision;checking++;$('run').setAttribute('disabled','');workbench.setBuilding();status('正在检查 TypeScript');
 try{const response=await rpc('compile');if(key!==runSerial||rev!==revision)return;setDiagnostics(response.diagnostics??[],true);
  if(diagnostics.some(d=>d.category==='error')){status('编译未通过','error');log(`TypeScript 检查未通过：${diagnostics.length} 个问题`,'warn');return;}
  log(`✓ ${selected.name} 编译通过，正在运行`);
  if(current.runtime==='legacy-react')send({type:'run',code:response.code,resources:response.resources,controls:current.controls,mode:current.mode,focusPreview:focusPreview&&(document.activeElement===focusOrigin||(focusOrigin===$('run')&&document.activeElement===document.body))});
  else {
   if(!(response.pack instanceof Uint8Array))throw Error('原生项目编译未产生 PCK');
   activeEngineRevision=rev;await nativePreview!.run(response.pack,rev,response.manifest);
   if(focusPreview&&key===runSerial)$('preview').querySelector('iframe')?.focus();
  }
  workbench.runStarted();
 }catch(error){if(key===runSerial){if(current.runtime!=='legacy-react'&&activeEngineRevision===rev&&nativePreview?.runner.state==='exited')return;log(String(error),'error');status('编译失败','error');}}
 finally{if(key===runSerial){$('run').removeAttribute('disabled');workbench.setReady();}}
}
function controls(){
 $('controls').replaceChildren();$('demo-actions').replaceChildren();$('hint').textContent=selected.hint;
 for(const c of selected.controls){const div=document.createElement('div');div.className='control';const label=document.createElement('label'),name=document.createElement('span'),output=document.createElement('output'),input=document.createElement('input');name.textContent=c.label;input.type='range';input.id=`control-${c.key}`;input.min=String(c.min);input.max=String(c.max);input.step=String(c.step);input.value=String(current.controls[c.key]??c.value);output.textContent=input.value;label.htmlFor=input.id;label.append(name,output);input.oninput=()=>{current.controls[c.key]=Number(input.value);output.textContent=input.value;send({type:'controls',controls:current.controls});storage.stage(selected.id,current);void save();};div.append(label,input);$('controls').append(div);}
 for(const action of selected.actions??[]){const button=document.createElement('button');button.dataset.action=action.key;button.textContent=action.label;button.onclick=()=>action.key==='load'?importCity():send({type:'action',action:action.key});$('demo-actions').append(button);}
}
function select(demo:Demo,run=true){
 clearTimeout(checkTimer);runSerial++;checking++;revision++;selected=demo;$('current-project-label').textContent=`(当前：${demo.name})`;$('project-switcher').title=`切换项目 (当前：${demo.name})`;$('project-switcher').setAttribute('aria-label',`切换项目 (当前：${demo.name})`);current=projects.get(demo.id)??initialProject(demo);if(!projects.has(demo.id))storage.stage(demo.id,current);projects.set(demo.id,current);workbench.resetTabs();editor.reset();explorer.reset();setDiagnostics([]);selectFile(current.selected);$('export-original').hidden=!current.migration;controls();$<HTMLSelectElement>('mode').value=current.mode;
 for(const tab of document.querySelectorAll<HTMLElement>('[data-demo]')){const active=tab.dataset.demo===demo.id;tab.classList.toggle('active',active);tab.setAttribute('aria-checked',String(active));}
 const legacy=current.runtime==='legacy-react';
 $<HTMLSelectElement>('profile').replaceChildren(new Option(legacy?'兼容项目':'完整 Godot Web 引擎',legacy?'showcase-v1':'full-engine-v1'));
 $('release-info').textContent=`Godot 4.6.1 · ${legacy?'兼容项目':'完整引擎'}`;
 $('runtime-meta').textContent=demo.name;document.title=`${demo.name} · GodotAI Playground`;void save();void prepareRuntime(run);
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
  if(current===target){renderFiles();changed();}else{storage.stage(target.demoId,target);void save();}
  toast('资源已添加，可在项目面板查看与导出');
 }catch(error){toast(String(error));}finally{input.value='';}
};
function download(name:string,value:unknown){let text=JSON.stringify(value);if(text.length<=16*1024*1024)text=JSON.stringify(value,null,2);const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export').onclick=()=>download('godot-playground-project.json',current);
$('export-original').onclick=()=>download('godot-playground-original.json',exportProject(current,'original'));
$('restore-recovery').onclick=async()=>{try{const recovery=await storage.recovery();if(!await save())throw Error('当前编辑尚未安全保存，请先导出修改');const result=await storage.restore(recovery as any);if(!result.snapshot)throw Error('本地项目存在保存冲突，未恢复任何内容');const snapshot=result.snapshot;persistenceBlocked=false;recoverySnapshot=await storage.recovery();projects.clear();for(const [id,document] of snapshot.projects){try{projects.set(id,parseProject(document));}catch{}}const demo=demos.find(d=>d.id===snapshot.selected)??demos[0];select(demo);toast('已从恢复备份还原项目');}catch(error){toast(String(error));}};
$('export-recovery').onclick=()=>download('godot-playground-recovery.json',recoverySnapshot);
$<HTMLInputElement>('import').onchange=async event=>{
 const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
 try{if(file.size>MAX_PROJECT_DOCUMENT_BYTES)throw Error('项目文件不能超过 128 MB');const project=parseProject(JSON.parse(await file.text()));const demo=demos.find(d=>d.id===project.demoId)??demos.find(d=>d.runtime===project.runtime)??demos[0];project.demoId=demo.id;for(const c of demo.controls)project.controls[c.key]=Math.max(c.min,Math.min(c.max,project.controls[c.key]??c.value));projects.set(demo.id,project);storage.stage(demo.id,project);select(demo);toast('项目已导入');}
 catch(error){toast(String(error));log(String(error),'error');}finally{input.value='';}
};
$('reset').onclick=()=>{projects.delete(selected.id);select(selected);toast('已恢复当前示例');};
$('share').onclick=async()=>{try{const json=new TextEncoder().encode(JSON.stringify(current));const compressed=new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());if(compressed.length>24576)throw Error('项目较大，请改用导出项目 JSON');let binary='';for(const n of compressed)binary+=String.fromCharCode(n);const url=new URL(location.href);url.hash='project='+btoa(binary);await navigator.clipboard.writeText(url.href);toast('项目分享链接已复制');}catch(error){toast(String(error));}};
async function importShared(){if(!location.hash.startsWith('#project='))return;try{const binary=atob(location.hash.slice(9).replace(/-/g,'+').replace(/_/g,'/'));if(binary.length>24576)throw Error('分享链接过大');const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(),chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_PROJECT_DOCUMENT_BYTES)throw Error('分享项目过大');chunks.push(value.slice());}}finally{await reader.cancel();}const text=await new Blob(chunks).text();const p=parseProject(JSON.parse(text));const demo=demos.find(d=>d.id===p.demoId)??demos.find(d=>d.runtime===p.runtime)??demos[0];p.demoId=demo.id;for(const c of demo.controls)p.controls[c.key]=Math.max(c.min,Math.min(c.max,p.controls[c.key]??c.value));projects.set(demo.id,p);storage.stage(demo.id,p);return demo.id;}catch(error){toast('无法读取分享项目：'+String(error));}}
function importCity(){const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{const file=input.files?.[0];if(!file)return;try{if(file.size>262144)throw Error('地图文件超过 256 KB');send({type:'import-data',data:JSON.parse(await file.text())});log(`✓ 已读取 ${file.name}`);}catch(error){log(String(error),'error');}};input.click();}
$('run').onclick=()=>void compile(true);$('check').onclick=()=>void check();$('stop').onclick=()=>{runSerial++;$('run').toggleAttribute('disabled',!ready);workbench.setReady();if(current.runtime==='legacy-react')send({type:'stop'});else void nativePreview?.stop();};
$<HTMLSelectElement>('mode').onchange=()=>{current.mode=$<HTMLSelectElement>('mode').value==='development'?'development':'production';changed();if(ready)void compile();};
$('clear-log').onclick=()=>{logCount=0;$('logs').replaceChildren();$('log-count').textContent='0';workbench.clearLogs();};
$('credits-open').onclick=()=>$<HTMLDialogElement>('credits').showModal();$('credits-close').onclick=()=>$<HTMLDialogElement>('credits').close();
const menu=$<HTMLDetailsElement>('examples-menu');
function positionProjects(){const popover=$('project-popover');popover.style.removeProperty('--menu-shift');const overflow=popover.getBoundingClientRect().right-innerWidth+8;if(overflow>0&&getComputedStyle(popover).position==='absolute')popover.style.setProperty('--menu-shift',`${-overflow}px`);}
menu.addEventListener('toggle',()=>{$('project-switcher').setAttribute('aria-expanded',String(menu.open));if(menu.open)positionProjects();});
$('project-close').onclick=()=>{menu.open=false;$('project-switcher').focus();};window.addEventListener('resize',()=>{if(menu.open)positionProjects();});
window.addEventListener('keydown',event=>{if(event.defaultPrevented)return;if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();void compile(true);}});
addEventListener('message',event=>{
 if(event.data?.type==='godotjs-preview-escape'&&nativePreview&&event.origin===nativePreview.runner.previewOrigin&&event.source===$('preview').querySelector('iframe')?.contentWindow){workbench.exitPreview();return;}
 if(event.source!==frame?.contentWindow||event.data?.token!==token)return;const data=event.data;
 if(data.type==='loading')$<HTMLProgressElement>('progress').value=data.total?data.current/data.total:0;
 if(data.type==='ready'){legacyReady=true;ready=true;$('run').removeAttribute('disabled');$('preview-placeholder').hidden=true;status('实时运行中','running');workbench.setReady();log('✓ Godot Web 引擎就绪 · 兼容项目');void compile();}
 if(data.type==='running'){$('stop').removeAttribute('disabled');status('实时运行中','running');}
 if(data.type==='stopped'){$('stop').setAttribute('disabled','');status(data.failed?'运行错误':'已停止',data.failed?'error':'');$('fps').textContent='— FPS';$('telemetry').textContent='场景已释放';}
 if(data.type==='runtime-error'){status('运行错误','error');log(data.message,'error');if(!ready){$('preview-placeholder').querySelector('h1')!.textContent='引擎启动失败';$('preview-placeholder').querySelector('p')!.textContent=data.message;}}
 if(data.type==='engine-log'&&/ERROR|Error|exception|failed/i.test(data.message))log(data.message,'error');
 if(data.type==='preview-escape')workbench.exitPreview();
 if(data.type==='export-data'){try{const json=JSON.stringify(data.data);if(json.length>262144||!/^[-a-z0-9_.]+$/i.test(data.name))throw Error('导出数据无效');download(data.name,data.data);log(`✓ 已导出 ${data.name}`);}catch(error){log(String(error),'error');}}
 if(data.type==='stats'){$('fps').textContent=`${data.fps} FPS`;const s=data.stats??{};if(s.kind==='city'&&s.notice!==lastCityNotice){lastCityNotice=s.notice;if(s.notice?.includes('导入')||s.notice?.startsWith('Error'))log(s.notice);}const text:Record<string,string>={city:`${s.buildings} BUILDINGS · UNDO ${s.undo}`,destruction:`${s.bodies} RIGID BODIES · ${s.spread} m`,racing:`${s.speed} km/h · LAP ${s.laps} · ${s.time} s`,match3:`SCORE ${s.score} · MOVES ${s.moves} · ${s.phase}`,dungeon:`SEED ${s.seed} · ROOMS ${s.revealed}/${s.rooms}`};$('telemetry').textContent=text[s.kind]??(selected.id==='islands'?`COINS ${s.coins??0}/${s.total??6} · JUMPS ${s.jumps??0}`:selected.id==='lights'?`3 LIGHTS · ${s.shadows?'SHADOWS ON':'SHADOWS OFF'}`:'3 LIVE MATERIALS · WEBGL 2');}
});
function onEngineEvent(event:RunnerEvent){
 if(current?.runtime==='legacy-react')return;
 const revision=event.type==='exit'?event.report.revision:event.revision;
 if(revision!==activeEngineRevision)return;
 if(event.type==='log'){log(event.text,event.level);return;}
 if(event.type==='exit'){
  $('stop').setAttribute('disabled','');$('fps').textContent='— FPS';
  if(event.report.diagnostic?.stack)log(event.report.diagnostic.stack,'error');
  if(event.report.reason==='clean-exit'||event.report.reason==='forced-frame-disposal'){status('已停止');$('telemetry').textContent='场景已释放';}
  else{status('运行错误','error');log(event.report.detail??event.report.reason,'error');}
  return;
 }
 if(event.state==='running'){$('preview-placeholder').hidden=true;$('stop').removeAttribute('disabled');status('实时运行中','running');$('telemetry').textContent='完整 Godot Web 引擎';}
 else if(event.state!=='exited')status(({downloading:'正在下载引擎',preloading:'正在装载项目',initializing:'正在初始化引擎',starting:'正在启动场景','waiting-ready':'等待场景就绪',stopping:'正在停止'} as Record<string,string>)[event.state]??'正在连接预览');
}
async function prepareRuntime(run:boolean){
 const sequence=++runtimeSerial;ready=false;$('run').setAttribute('disabled','');
 try{
  if(current.runtime==='legacy-react'){
   await nativePreview?.stop();if(sequence!==runtimeSerial)return;
   if(frame){ready=legacyReady;if(run&&ready)void compile();}
   else{legacyReady=false;frame=document.createElement('iframe');frame.title='Godot 兼容项目预览';frame.setAttribute('sandbox','allow-scripts allow-pointer-lock');frame.src=`runner.html#${token}`;$('preview').append(frame);}
  }else{
   frame?.remove();frame=undefined;legacyReady=false;
   nativePreviewPending??=createEnginePreview($('preview'),onEngineEvent).catch(error=>{nativePreviewPending=undefined;throw error;});
   nativePreview=await nativePreviewPending;if(sequence!==runtimeSerial)return;ready=true;
   $('runtime-name').textContent='Godot Web · Full';$('run').removeAttribute('disabled');workbench.setReady();
   if(run)void compile();
  }
  if(ready)$('run').removeAttribute('disabled');
 }catch(error){if(sequence===runtimeSerial){status('加载失败','error');log(String(error),'error');$('preview-placeholder').querySelector('p')!.textContent=String(error);}}
}
async function start(){
 const response=await fetch('catalog.json');if(!response.ok)throw Error('无法加载示例目录');demos=[...(['godot','react'] as const).map(runtime=>{const project=defaultProject(runtime);return {id:project.demoId,name:runtime==='godot'?'Godot 原生项目':'React + Godot',subtitle:runtime==='godot'?'NATIVE ENGINE / TYPESCRIPT':'NATIVE ENGINE / REACT',file:project.entry.split('/').at(-1)!,hint:runtime==='godot'?'直接编写 Godot 脚本、场景与资源，使用完整引擎 API。':'使用 React 声明场景树，节点、资源和方法来自完整 Godot 引擎。',source:project.files[project.entry] as string,runtime,controls:[]};}),...(await response.json()).map((demo:Demo)=>({...demo,runtime:'legacy-react' as const}))];$('project-count').textContent=`${demos.length} 个示例`;
 for(const demo of demos){const button=document.createElement('button');button.className='demo-card';button.dataset.demo=demo.id;button.dataset.example=demo.id;button.setAttribute('role','menuitemradio');const art=document.createElement('div');art.className='demo-art '+demo.id;art.setAttribute('aria-hidden','true');const name=document.createElement('div');name.className='demo-name';name.textContent=demo.name;const check=document.createElement('span');check.className='demo-check';check.textContent='✓';name.append(check);const subtitle=document.createElement('div');subtitle.className='demo-subtitle';subtitle.textContent=demo.subtitle;const file=document.createElement('div');file.className='demo-file';file.textContent=demo.file;button.append(art,name,subtitle,file);button.onclick=()=>{select(demo);menu.open=false;$('project-switcher').focus();};$('demos').append(button);}
 for(const [name,version] of Object.entries({godot:'4.6.1 · 全量 Web API',react:'19.3.1','@godot-js/react':'0.1.0','@playground/api':'内置'})){const item=document.createElement('div');item.className='dependency-item';const label=document.createElement('span');label.textContent=name;const code=document.createElement('code');code.textContent=version;item.append(label,code);$('dependencies').append(item);}
 const restored=await restore(),shared=await importShared();select(demos.find(d=>d.id===(shared??new URL(location.href).searchParams.get('project')??restored))??demos[0],false);
 if(shared&&await save()){const url=new URL(location.href);url.hash='';history.replaceState(history.state,'',url.href);}
 await prepareRuntime(true);
}
start().catch(error=>{status('加载失败','error');log(String(error),'error');});
// Read-only diagnostics for integration tests and local debugging.
(globalThis as any).__playgroundWorkbench={inspect:()=>({project:structuredClone(current),diagnostics:structuredClone(diagnostics),ready,revision,engine:nativePreview?{releaseId:nativePreview.manifest.id,state:nativePreview.runner.state}:undefined})};
