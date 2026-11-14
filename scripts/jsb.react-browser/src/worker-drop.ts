/** Structured-clone file payloads. No live FileSystemEntry crosses realms. */
export type DropEntry = {kind:'file';path:string;file:File}|{kind:'directory';path:string;children:DropEntry[]};
export interface DropPayload { dropId:number; entries:DropEntry[] }
export interface DropLimits { maxBytes:number;maxFiles:number;maxDepth:number;maxEntries:number;maxPathBytes:number;timeoutMs:number }
export const DEFAULT_DROP_LIMITS:Readonly<DropLimits>=Object.freeze({maxBytes:64*1024*1024,maxFiles:1024,maxDepth:16,maxEntries:2048,maxPathBytes:1024*1024,timeoutMs:15000});
interface EntryLike {name:string;isFile:boolean;isDirectory:boolean;file?(success:(file:File)=>void,error:(error:unknown)=>void):void;createReader?():{readEntries(success:(entries:EntryLike[])=>void,error:(error:unknown)=>void):void}}
interface TransferLike { items?:ArrayLike<{kind:string;getAsEntry?():EntryLike|null;webkitGetAsEntry?():EntryLike|null;getAsFile?():File|null}>;files?:ArrayLike<File> }
interface Budget {files:number;bytes:number;entries:number;paths:number;seen:Set<string>}
function enter(budget:Budget,path:string,depth:number,limits:DropLimits) {
  if(depth>limits.maxDepth||++budget.entries>limits.maxEntries)throw Error('E_WORKER_DROP_ENTRY_BUDGET');
  if(!path||path.length>4096||path.split('/').some(part=>!part||part==='.'||part==='..'||/[\u0000-\u001f\\]/.test(part)))throw Error('E_WORKER_DROP_PATH');
  if(budget.seen.has(path))throw Error('E_WORKER_DROP_DUPLICATE_PATH');budget.seen.add(path);
  budget.paths+=new TextEncoder().encode(path).byteLength;if(budget.paths>limits.maxPathBytes)throw Error('E_WORKER_DROP_PATH_BUDGET');
}
function fileBudget(budget:Budget,file:File,limits:DropLimits) {
  if(!(file instanceof Blob)||typeof file.name!=='string'||file.type.length>1024||!Number.isSafeInteger(file.size)||file.size<0||++budget.files>limits.maxFiles||(budget.bytes+=file.size)>limits.maxBytes)throw Error('E_WORKER_DROP_FILE_BUDGET');
}
function freshBudget():Budget{return {files:0,bytes:0,entries:0,paths:0,seen:new Set()};}
/** Drain every browser directory-reader batch. Every asynchronous boundary is
 * fenced by the owning run's AbortSignal, including late native callbacks. */
export async function collectDrop(transfer:TransferLike,signal:AbortSignal,provided:Partial<DropLimits>={}):Promise<DropEntry[]> {
  const limits={...DEFAULT_DROP_LIMITS,...provided},budget=freshBudget(),deadline=Date.now()+limits.timeoutMs;
  const active=()=>{if(signal.aborted)throw signal.reason??Error('E_WORKER_DROP_CLOSED');if(Date.now()>deadline)throw Error('E_WORKER_DROP_ENUMERATION_TIMEOUT');};
  function callback<T>(start:(resolve:(value:T)=>void,reject:(error:unknown)=>void)=>void):Promise<T>{
    active();return new Promise<T>((resolve,reject)=>{
      let settled=false;
      const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);if(error)reject(error);else resolve(value!);};
      const aborted=()=>finish(signal.reason??Error('E_WORKER_DROP_CLOSED'));
      const timer=setTimeout(()=>finish(Error('E_WORKER_DROP_ENUMERATION_TIMEOUT')),Math.max(1,deadline-Date.now()));signal.addEventListener('abort',aborted,{once:true});
      try{start(value=>finish(undefined,value),error=>finish(error??Error('E_WORKER_DROP_READ')));}catch(error){finish(error);}
    }).then(value=>{active();return value;});
  }
  async function visit(entry:EntryLike,parent:string,depth:number):Promise<DropEntry>{
    active();const path=parent?`${parent}/${entry.name}`:entry.name;enter(budget,path,depth,limits);
    if(entry.isFile&&entry.file){const file=await callback<File>((resolve,reject)=>entry.file!(resolve,reject));active();fileBudget(budget,file,limits);return {kind:'file',path,file};}
    if(entry.isDirectory&&entry.createReader){const reader=entry.createReader(),children:DropEntry[]=[];
      for(;;){const batch=await callback<EntryLike[]>((resolve,reject)=>reader.readEntries(resolve,reject));active();
        if(!Array.isArray(batch)||batch.length>limits.maxEntries)throw Error('E_WORKER_DROP_ENTRY_BUDGET');if(!batch.length)break;
        for(const child of batch){children.push(await visit(child,path,depth+1));active();}
      }return {kind:'directory',path,children};
    }throw Error('E_WORKER_DROP_ENTRY');
  }
  active();const entries:DropEntry[]=[];
  if(transfer.items&&transfer.items.length){
    if(transfer.items.length>limits.maxEntries)throw Error('E_WORKER_DROP_ENTRY_BUDGET');
    // The DataTransfer store becomes protected when the DOM event returns.
    // Snapshot every root entry/file before the first asynchronous file read.
    const roots=Array.from(transfer.items).filter(item=>item.kind==='file').map(item=>{const entry=item.getAsEntry?.()??item.webkitGetAsEntry?.();return {entry,file:entry?null:item.getAsFile?.()};});
    for(const root of roots){
      active();if(root.entry)entries.push(await visit(root.entry,'',1));
      else{const file=root.file;if(file){enter(budget,file.name,1,limits);fileBudget(budget,file,limits);entries.push({kind:'file',path:file.name,file});}}
    }
  }else if(transfer.files){if(transfer.files.length>limits.maxFiles)throw Error('E_WORKER_DROP_FILE_BUDGET');for(const file of Array.from(transfer.files)){
    active();const path=file.webkitRelativePath||file.name;enter(budget,path,path.split('/').length,limits);fileBudget(budget,file,limits);entries.push({kind:'file',path,file});
  }}
  active();return entries;
}

/** Rebuild only the asynchronous Entry subset used by Godot's native drop
 * helper. All children are returned in one batch after host pagination. */
export function createDropTransfer(entries:DropEntry[],isActive:()=>boolean,provided:Partial<DropLimits>={}) {
  const limits={...DEFAULT_DROP_LIMITS,...provided},budget=freshBudget(),files:File[]=[];
  function build(entry:DropEntry,parent:string,depth:number):any {
    if(!entry||typeof entry!=='object'||typeof entry.path!=='string')throw Error('E_WORKER_DROP_ENTRY');
    enter(budget,entry.path,depth,limits);
    if(parent&&entry.path.slice(0,entry.path.lastIndexOf('/'))!==parent)throw Error('E_WORKER_DROP_PATH');
    const name=entry.path.slice(entry.path.lastIndexOf('/')+1),base={name,fullPath:'/'+entry.path};
    if(entry.kind==='file'){
      fileBudget(budget,entry.file,limits);if(name!==entry.file.name)throw Error('E_WORKER_DROP_PATH');
      const file=new File([entry.file],name,{type:entry.file.type,lastModified:entry.file.lastModified});Object.defineProperty(file,'relativePath',{configurable:true,value:entry.path});files.push(file);
      return {...base,isFile:true,isDirectory:false,file(success:(file:File)=>void,error?:(error:unknown)=>void){queueMicrotask(()=>{if(isActive())success(file);else error?.(new DOMException('E_WORKER_DROP_CLOSED','AbortError'));});}};
    }
    if(entry.kind!=='directory'||!Array.isArray(entry.children)||entry.children.length>limits.maxEntries)throw Error('E_WORKER_DROP_ENTRY');
    const children=entry.children.map(child=>build(child,entry.path,depth+1));
    return {...base,isFile:false,isDirectory:true,createReader(){let read=false;return {readEntries(success:(children:unknown[])=>void,error?:(error:unknown)=>void){queueMicrotask(()=>{if(!isActive()){error?.(new DOMException('E_WORKER_DROP_CLOSED','AbortError'));return;}const result=read?[]:children;read=true;success(result);});}};}};
  }
  if(!Array.isArray(entries)||entries.length>limits.maxEntries)throw Error('E_WORKER_DROP_ENTRY_BUDGET');
  const roots=entries.map(entry=>build(entry,'',Math.max(1,entry.path.split('/').length)));
  const items=roots.map(entry=>({kind:'file',type:entry.isFile?files.find(file=>(file as any).relativePath===entry.fullPath.slice(1))?.type??'':'',getAsEntry:()=>entry,webkitGetAsEntry:()=>entry,getAsFile:()=>entry.isFile?files.find(file=>(file as any).relativePath===entry.fullPath.slice(1))??null:null}));
  return {items:Object.assign(items,{item:(index:number)=>items[index]??null}),files:Object.assign(files,{item:(index:number)=>files[index]??null}),types:['Files'],dropEffect:'copy',effectAllowed:'all',getData:()=>''};
}
