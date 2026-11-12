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
 let activeRestore:{tx:IDBTransaction;changed:boolean;ids:Set<string>}|undefined;
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
   const projects:[string,unknown][]=[],seen=new Set<string>();
   for(const row of saved.projects){
    if(!isRow(row)){invalid.set(String(projects.length),'无效项目记录');continue;}
    const [id,value]=row;if(seen.has(id))invalid.set(id,'重复项目标识；完整原始快照已保留供恢复');seen.add(id);
    try{const project=parseProject(value);projects.push([id,project]);if((value as any)?.schemaVersion!==3||(value as any)?.runtime==='legacy-react')migrated.push(id);}
    catch(error){invalid.set(id,String(error));projects.push([id,value]);}
   }
   const snapshot={...saved,projects};versions.clear();for(const [id,version]of Object.entries(saved.versions??{}))versions.set(id,version);for(const [id]of projects)if(!versions.has(id))versions.set(id,0);
   return {snapshot,original,invalid,migrated};
  },
  recovery(key='recovery'){return read(key);},
  async consumeLegacyMigrationNotice(){const db=await database;if(!db)return false;return new Promise<boolean>((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),request=store.get('legacy-import-v1');let notice=false;request.onsuccess=()=>{const marker=request.result;if(marker?.copied&&!marker.notified){notice=true;store.put({...marker,notified:true},'legacy-import-v1');}};tx.oncomplete=()=>resolve(notice);tx.onabort=()=>reject(tx.error??Error('无法读取迁移状态'));});},
  async preserveInvalidSnapshot(document:unknown,invalidIds:string[]){
   const data=document as ProjectSnapshot,ids=new Set(invalidIds),invalid=Array.isArray(data?.projects)?data.projects.filter(row=>!isRow(row)||ids.has(row[0])):document;
   const bytes=new TextEncoder().encode(JSON.stringify(invalid)),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
   const key='invalid-recovery:'+Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
   const db=await database;if(!db)throw Error('无法备份原始项目');
   return new Promise<unknown>((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),request=store.get(key);let original:unknown;
    request.onsuccess=()=>{original=request.result;if(original===undefined){original=structuredClone(document);backup(store,original);store.put(original,key);}};
    tx.oncomplete=()=>resolve(original);tx.onabort=()=>reject(tx.error??Error('无法备份原始项目'));});
  },
  async retainImport(document:unknown){const db=await database;if(!db)throw Error('无法保留导入项目');const key='import:'+Date.now()+':'+crypto.randomUUID();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects');store.put(structuredClone(document),key);store.put(structuredClone(document),'last-import');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('无法保留导入项目'));});return key;},
  remember(snapshot:Snapshot|undefined){versions.clear();for(const [id,version]of Object.entries(snapshot?.versions??{}))versions.set(id,version);for(const [id] of snapshot?.projects??[])if(!versions.has(id))versions.set(id,0);},
  stage(id:string,project:EditorProject){pending.set(id,{project,revision:++revision});if(activeRestore){activeRestore.changed=true;activeRestore.ids.add(id);try{activeRestore.tx.abort();}catch{/* A commit already in progress is detected again by oncomplete. */}}},
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
      const malformed=saved&&(!Array.isArray(saved.projects)||rows.length!==saved.projects.length||new Set(rows.map(([id])=>id)).size!==rows.length);
      const projects=new Map(rows),nextVersions={...saved?.versions};
      let migrating=false;
      for(const [id,edit] of valid){
       const currentVersion=nextVersions[id]??0;
       if(currentVersion!==(versions.get(id)??0)){conflicts.push(id);continue;}
       const previous=projects.get(id) as any;if(previous&&(previous.schemaVersion!==3||previous.runtime==='legacy-react'))migrating=true;
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
    // A caller must save every pending project before replacing the snapshot.
    if(revision!==restoreRevision||pending.size)return {snapshot:undefined,conflicts:[...pending.keys()],interrupted:true};
    const conflicts:string[]=[],applied=new Map<string,number>();let restored:Snapshot|undefined,interrupted=false;
    await new Promise<void>((resolve,reject)=>{
     const tx=db.transaction('projects','readwrite'),attempt={tx,changed:false,ids:new Set<string>()};activeRestore=attempt;
     const store=tx.objectStore('projects'),current=store.get('current');
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
     tx.oncomplete=()=>{
      if(activeRestore===attempt)activeRestore=undefined;
      interrupted=attempt.changed||revision!==restoreRevision;
      if(restored){versions.clear();for(const [id,version]of applied)versions.set(id,version);if(!interrupted)for(const [id,edit]of pending)if(edit.revision<=restoreRevision)pending.delete(id);}
      if(interrupted){conflicts.push(...attempt.ids);restored=undefined;}
      resolve();
     };
     tx.onabort=()=>{
      if(activeRestore===attempt)activeRestore=undefined;
      if(attempt.changed){interrupted=true;restored=undefined;conflicts.push(...attempt.ids);resolve();}
      else reject(tx.error??Error('恢复事务失败，原始数据未改动'));
     };
    });
    return {snapshot:restored,conflicts,...(interrupted?{interrupted:true}:{})};
   });queue=operation.catch(()=>{});return operation;
  },
 };
}

export const LEGACY_PROJECT_DATABASE='godotjs-showcase-workbench-v1';
export function projectDatabaseName(profile:string):string {
 if(!/^[a-z][a-z0-9._-]{0,127}$/.test(profile))throw Error('无效的引擎存储配置');
 return 'godotjs-playground-v3:'+profile;
}
function openDatabase(factory:IDBFactory,name:string,create:boolean):Promise<IDBDatabase|undefined>{
 return new Promise((resolve,reject)=>{
  const request=factory.open(name,1);let absent=false;
  request.onupgradeneeded=()=>{if(!create){absent=true;request.transaction?.abort();return;}if(!request.result.objectStoreNames.contains('projects'))request.result.createObjectStore('projects');};
  request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('projects')){db.close();resolve(undefined);}else resolve(db);};
  request.onerror=event=>{if(absent){event.preventDefault();resolve(undefined);}else reject(request.error??Error('无法打开项目存储'));};
  request.onblocked=()=>reject(Error('项目存储被旧页面阻塞，请关闭旧页面后重试'));
 });
}
/** Copies one immutable snapshot into a new namespace. The legacy database is never written. */
export async function copyLegacyProjectStorage(destination:IDBDatabase,source:IDBDatabase):Promise<boolean>{
 const records=await new Promise<[IDBValidKey,unknown][]>((resolve,reject)=>{
  const tx=source.transaction('projects'),store=tx.objectStore('projects'),rows:[IDBValidKey,unknown][]=[];
  const cursor=store.openCursor();cursor.onsuccess=()=>{const row=cursor.result;if(row){rows.push([row.key,structuredClone(row.value)]);row.continue();}};
  tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error??Error('无法读取旧项目快照'));
 });
 return new Promise<boolean>((resolve,reject)=>{
  const tx=destination.transaction('projects','readwrite'),store=tx.objectStore('projects'),marker=store.get('legacy-import-v1'),current=store.get('current');
  let marked=false,loaded=false,markerValue:unknown,currentValue:unknown,copied=false;
  const apply=()=>{if(!marked||!loaded||markerValue!==undefined)return;if(currentValue===undefined){for(const [key,value]of records)store.put(value,key);copied=records.length>0;}store.put({source:LEGACY_PROJECT_DATABASE,copied,at:Date.now()},'legacy-import-v1');};
  marker.onsuccess=()=>{marked=true;markerValue=marker.result;apply();};current.onsuccess=()=>{loaded=true;currentValue=current.result;apply();};
  tx.oncomplete=()=>resolve(copied);tx.onabort=()=>reject(tx.error??Error('旧项目迁移失败，原始存档保持完整'));
 });
}
export async function openProjectDatabase(profile:string,{factory=globalThis.indexedDB}:{factory?:IDBFactory}={}):Promise<IDBDatabase|undefined>{
 const name=projectDatabaseName(profile);if(!factory)return undefined;
 const database=await openDatabase(factory,name,true);if(!database)return undefined;
 if(profile==='full-engine-v1'){
  const source=await openDatabase(factory,LEGACY_PROJECT_DATABASE,false);
  if(source)try{await copyLegacyProjectStorage(database,source);}finally{source.close();}
 }
 return database;
}
