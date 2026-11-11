import {parseProject,type EditorProject} from './project-model.ts';

export interface ProjectSnapshot {selected?:string;projects:[string,unknown][];versions?:Record<string,number>}
type Snapshot=ProjectSnapshot;
interface Pending {project:EditorProject;revision:number}
const isRow=(row:unknown):row is [string,unknown]=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string';
function backup(store:IDBObjectStore,value:unknown){if(value===undefined)return;store.put(value,'recovery:'+Date.now()+':'+crypto.randomUUID());store.put(value,'recovery');}
/** Each write merges only this tab's edited projects inside one IndexedDB transaction. */
export function createProjectStorage(database:Promise<IDBDatabase|undefined>){
 const versions=new Map<string,number>(),pending=new Map<string,Pending>();
 let revision=0,queue:Promise<unknown>=Promise.resolve();
 const read=async(key:string)=>{
  const db=await database;if(!db)throw Error('无法使用本地存储');
  return new Promise<unknown>((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 };
 return {
  /** Parsing is read-only; the stored v1 snapshot is backed up when a migration commits. */
  async load(){
   const original=await read('current'),invalid=new Map<string,string>(),migrated:string[]=[];
   if(original===undefined)return {snapshot:undefined,original,invalid,migrated};
   const saved=original as Snapshot;
   if(!saved||!Array.isArray(saved.projects))throw Error('本地项目快照无效；原始记录仍可通过 recovery/current 导出');
   const projects:[string,unknown][]=[];
   for(const row of saved.projects){
    if(!isRow(row)){invalid.set(String(projects.length),'无效项目记录');continue;}
    const [id,value]=row;
    try{const project=parseProject(value);projects.push([id,project]);if((value as any)?.schemaVersion!==2||(value as any)?.runtime==='legacy-react')migrated.push(id);}
    catch(error){invalid.set(id,String(error));projects.push([id,value]);}
   }
   const snapshot={...saved,projects};versions.clear();for(const [id,version]of Object.entries(saved.versions??{}))versions.set(id,version);for(const [id]of projects)if(!versions.has(id))versions.set(id,0);
   return {snapshot,original,invalid,migrated};
  },
  recovery(key='recovery'){return read(key);},
  remember(snapshot:Snapshot|undefined){versions.clear();for(const [id,version]of Object.entries(snapshot?.versions??{}))versions.set(id,version);for(const [id] of snapshot?.projects??[])if(!versions.has(id))versions.set(id,0);},
  stage(id:string,project:EditorProject){pending.set(id,{project,revision:++revision});},
  hasPending(id:string){return pending.has(id);},
  save(selected:string){
   const operation=queue.then(async()=>{
    const db=await database;if(!db)throw Error('无法使用本地存储');
    const valid=new Map<string,{project:EditorProject;revision:number}>(),invalid=new Map<string,string>(),conflicts:string[]=[];
    for(const [id,edit] of pending){try{valid.set(id,{project:parseProject(edit.project),revision:edit.revision});}catch(error){invalid.set(id,String(error));}}
    await new Promise<void>((resolve,reject)=>{
     const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),request=store.get('current');
     const applied=new Map<string,{version:number;revision:number}>();
     request.onsuccess=()=>{
      const saved=request.result as Snapshot|undefined;
      const rows=Array.isArray(saved?.projects)?saved.projects.filter(isRow):[];
      const malformed=saved&&(!Array.isArray(saved.projects)||rows.length!==saved.projects.length);
      const projects=new Map(rows),nextVersions={...saved?.versions};
      let migrating=false;
      for(const [id,edit] of valid){
       const currentVersion=nextVersions[id]??0;
       if(currentVersion!==(versions.get(id)??0)){conflicts.push(id);continue;}
       const previous=projects.get(id) as any;if(previous&&(previous.schemaVersion!==2||previous.runtime==='legacy-react'))migrating=true;
       projects.set(id,edit.project);nextVersions[id]=currentVersion+1;applied.set(id,{version:currentVersion+1,revision:edit.revision});
      }
      if(malformed||migrating)backup(store,saved);
      store.put({selected,projects:[...projects],versions:nextVersions},'current');
     };
     tx.oncomplete=()=>{for(const [id,edit] of applied){versions.set(id,edit.version);if(pending.get(id)?.revision===edit.revision)pending.delete(id);}resolve();};
     tx.onabort=()=>reject(tx.error??Error('本地存档发生变化，写入已取消'));
    });
    return {invalid,conflicts};
   });
   queue=operation.catch(()=>{});return operation;
  },
  /** Recovery is a new versioned write, never a rollback of conflict counters. */
  restore(source:Snapshot|string='recovery'){
   const restoreRevision=revision;
   const operation=queue.then(async()=>{
    const db=await database;if(!db)throw Error('无法使用本地存储');
    const conflicts:string[]=[],applied=new Map<string,number>();let restored:Snapshot|undefined;
    await new Promise<void>((resolve,reject)=>{
     const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),current=store.get('current');
     const sourceRequest=typeof source==='string'?store.get(source):undefined;let loaded=typeof source==='string'?false:true,recovery:unknown=typeof source==='string'?undefined:source,hasCurrent=false,saved:Snapshot|undefined;
     const apply=()=>{
      if(!loaded||!hasCurrent)return;
      try{
       const raw=recovery as Snapshot;if(!raw||!Array.isArray(raw.projects)||!raw.projects.every(isRow)||new Set(raw.projects.map(([id])=>id)).size!==raw.projects.length)throw Error('恢复快照无效');
       const rows=raw.projects.map(([id,p])=>[id,parseProject(p)] as [string,EditorProject]);
       const ids=new Set([...(saved?.projects??[]).filter(isRow).map(([id])=>id),...rows.map(([id])=>id)]);
       for(const id of ids)if((saved?.versions?.[id]??0)!==(versions.get(id)??0))conflicts.push(id);
       if(conflicts.length)return;
       const nextVersions={...saved?.versions};for(const id of ids){nextVersions[id]=(nextVersions[id]??0)+1;applied.set(id,nextVersions[id]);}
       restored={selected:raw.selected,projects:rows,versions:nextVersions};backup(store,saved);store.put(restored,'current');
      }catch(error){tx.abort();reject(error);}
     };
     current.onsuccess=()=>{saved=current.result;hasCurrent=true;apply();};
     if(sourceRequest)sourceRequest.onsuccess=()=>{recovery=sourceRequest.result;loaded=true;apply();};
     tx.oncomplete=()=>{if(restored){versions.clear();for(const [id,version]of applied)versions.set(id,version);for(const [id,edit]of pending)if(edit.revision<=restoreRevision)pending.delete(id);}resolve();};
     tx.onabort=()=>reject(tx.error??Error('恢复事务失败，原始数据未改动'));
    });
    return {snapshot:restored,conflicts};
   });queue=operation.catch(()=>{});return operation;
  },
 };
}
