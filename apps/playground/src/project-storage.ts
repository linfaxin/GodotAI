import {parseProject,projectStorageDocument,type EditorProject} from './project-model.ts';
import {createBlobWriteBatch,decodeProjectRecord,projectWriteTransaction,storedSnapshotHeader,wrapProjectSnapshot,storedProjectSchema,projectBlobEnabled,readProjectRecord,migrateProjectBlobs,pinProjectSnapshot,collectProjectBlobs,exportProjectBlobRecovery,importProjectBlobRecovery} from './project-blob-storage.ts';

export interface ProjectSnapshot {selected?:string;projects:[string,unknown][];versions?:Record<string,number>}
type Snapshot=ProjectSnapshot;
interface Pending {project:EditorProject;revision:number}
const unavailableStorageErrors=new Set(['SecurityError','NotAllowedError','QuotaExceededError','InvalidStateError','UnknownError','VersionError','AbortError']);
/** Persistence can fail independently of the already owned project bytes.
 * Codec, validation and application errors must still fail their operation. */
export function isProjectPersistenceUnavailable(error:unknown):error is DOMException {
 return typeof DOMException==='function'&&error instanceof DOMException&&unavailableStorageErrors.has(error.name);
}
interface ProjectStorageOptions {onPersistenceUnavailable?:(error:DOMException)=>void}
const unavailableDatabase=(message='无法使用本地存储')=>new DOMException(message,'InvalidStateError');
const isRow=(row:unknown):row is [string,unknown]=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string';
function backup(store:IDBObjectStore,value:unknown){if(value===undefined)return;store.put(value,'recovery:'+Date.now()+':'+crypto.randomUUID());store.put(value,'recovery');}
/** Each write merges only this tab's edited projects inside one IndexedDB transaction. */
export function createProjectStorage(database:Promise<IDBDatabase|undefined>,options:ProjectStorageOptions={}){
 const versions=new Map<string,number>(),pending=new Map<string,Pending>(),owner=crypto.randomUUID();
 let revision=0,restoreSerial=0,queue:Promise<unknown>=Promise.resolve();
 let activeRestore:{tx:IDBTransaction;changed:boolean;ids:Set<string>}|undefined;
 // The storage instance owns failed cleanups after the RPC drops its handle.
 const pendingReleases=new Map<string,Awaited<ReturnType<typeof pinProjectSnapshot>>>();
 let retryTimer:ReturnType<typeof setTimeout>|undefined,retryDelay=250,retrying:Promise<void>|undefined;
 const scheduleReleaseRetry=()=>{
  if(retryTimer!==undefined||!pendingReleases.size)return;
  retryTimer=setTimeout(()=>{retryTimer=undefined;void retryPinReleases().catch(error=>console.error('Project pin cleanup failed',error));},retryDelay);
  (retryTimer as unknown as {unref?:()=>void}).unref?.();
 };
 const retryPinReleases=():Promise<void>=>{
  if(retrying)return retrying;
  retrying=(async()=>{
   for(const [id,pin]of pendingReleases){
    try{await pin.release();pendingReleases.delete(id);}
    catch(error){if(!isProjectPersistenceUnavailable(error))throw error;options.onPersistenceUnavailable?.(error);}
   }
  })().finally(()=>{
   retrying=undefined;
   if(!pendingReleases.size){if(retryTimer!==undefined)clearTimeout(retryTimer);retryTimer=undefined;retryDelay=250;}
   else{retryDelay=Math.min(30000,retryDelay*2);scheduleReleaseRetry();}
  });
  return retrying;
 };
 const read=async(key:string)=>{
  await retryPinReleases();
  const db=await database;if(!db)throw unavailableDatabase();
  return readProjectRecord(db,key);
 };
 return {
  /** Changes monotonically for staged edits, including changes already saved. */
  get editRevision(){return revision;},
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
    try{const project=parseProject(value);projects.push([id,project]);if(![3,4].includes((value as any)?.schemaVersion)||(value as any)?.runtime==='legacy-react')migrated.push(id);}
    catch(error){invalid.set(id,String(error));projects.push([id,value]);}
   }
   const snapshot={...saved,projects};versions.clear();for(const [id,version]of Object.entries(saved.versions??{}))versions.set(id,version);for(const [id]of projects)if(!versions.has(id))versions.set(id,0);
   return {snapshot,original,invalid,migrated};
  },
  recovery(key='recovery'){return read(key);},
  async pinSnapshot(value:unknown,job:string=crypto.randomUUID()){
   // Capture first; a DataCloneError is a bad snapshot, not denied storage.
   const captured=structuredClone(value),memoryPin={id:owner+':'+job,release:async()=>{}};
   let pin:Awaited<ReturnType<typeof pinProjectSnapshot>>;
   try{
    const db=await database;if(!db)return memoryPin;
    pin=await pinProjectSnapshot(db,owner,job,captured);
   }catch(error){
    if(!isProjectPersistenceUnavailable(error))throw error;
    options.onPersistenceUnavailable?.(error);return memoryPin;
   }
   return {id:pin.id,async release(){
    pendingReleases.set(pin.id,pin);
    await retryPinReleases();
   }};
  },
  async collectBlobs(){await retryPinReleases();const db=await database;if(!db)throw unavailableDatabase();return collectProjectBlobs(db);},
  async exportRecovery(){
   await retryPinReleases();const db=await database;if(!db)throw unavailableDatabase();
   try{await refreshProjectBlobSources(db);}catch(error){
    if(!isProjectPersistenceUnavailable(error))throw error;options.onPersistenceUnavailable?.(error);
    // Migration can need new space. Export each old namespace directly when
    // persistence is unavailable, so its latest branch is still in the file.
    return exportReadonlyProjectBlobSources(db);
   }
   return exportProjectBlobRecovery(db);
  },
  async importRecovery(archive:unknown){const db=await database;if(!db)throw unavailableDatabase();return importProjectBlobRecovery(db,archive);},
  async consumeLegacyMigrationNotice(){const db=await database;if(!db)return false;const key=projectBlobEnabled(db)?'blob-migration-notice':'legacy-import-v1';return new Promise<boolean>((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),request=store.get(key);let notice=false;request.onsuccess=()=>{const marker=request.result;if(marker?.copied&&!marker.notified){notice=true;store.put({...marker,notified:true},key);}};tx.oncomplete=()=>resolve(notice);tx.onabort=()=>reject(tx.error??Error('无法读取迁移状态'));});},
  async preserveInvalidSnapshot(document:unknown,invalidIds:string[]){
   const data=document as ProjectSnapshot,ids=new Set(invalidIds),invalid=Array.isArray(data?.projects)?data.projects.filter(row=>!isRow(row)||ids.has(row[0])):document;
   const bytes=new TextEncoder().encode(JSON.stringify(invalid)),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
   const key='invalid-recovery:'+Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
   const db=await database;if(!db)throw unavailableDatabase('无法备份原始项目');
   const batch=createBlobWriteBatch(db),encoded=await batch.encode(document);
   const saved=await new Promise<unknown>((resolve,reject)=>{const tx=projectWriteTransaction(db),store=tx.objectStore('projects'),request=store.get(key);batch.put(tx);let original:unknown;
    request.onsuccess=()=>{original=request.result;if(original===undefined){original=encoded;backup(store,original);store.put(original,key);}};
    tx.oncomplete=()=>resolve(original);tx.onabort=()=>reject(tx.error??Error('无法备份原始项目'));});
   return decodeProjectRecord(db,saved);
  },
  async retainImport(document:unknown){const db=await database;if(!db)throw unavailableDatabase('无法保留导入项目');const key='import:'+Date.now()+':'+crypto.randomUUID(),batch=createBlobWriteBatch(db),encoded=await batch.encode(document);await new Promise<void>((resolve,reject)=>{const tx=projectWriteTransaction(db),store=tx.objectStore('projects');batch.put(tx);store.put(encoded,key);store.put(encoded,'last-import');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('无法保留导入项目'));});return key;},
  remember(snapshot:Snapshot|undefined){versions.clear();for(const [id,version]of Object.entries(snapshot?.versions??{}))versions.set(id,version);for(const [id] of snapshot?.projects??[])if(!versions.has(id))versions.set(id,0);},
  stage(id:string,project:EditorProject){pending.set(id,{project,revision:++revision});if(activeRestore){activeRestore.changed=true;activeRestore.ids.add(id);try{activeRestore.tx.abort();}catch{/* A commit already in progress is detected again by oncomplete. */}}},
  hasPending(id:string){return pending.has(id);},
  save(selected:string){
   const operation=queue.then(async()=>{
    await retryPinReleases();
    const db=await database;if(!db)throw unavailableDatabase();
    const batch=createBlobWriteBatch(db),valid=new Map<string,{project:EditorProject;revision:number;encoded?:unknown}>(),invalid=new Map<string,string>(),conflicts:string[]=[];
    for(const [id,edit] of pending){try{valid.set(id,{project:parseProject(edit.project),revision:edit.revision});}catch(error){invalid.set(id,String(error));}}
    for(const edit of valid.values())edit.encoded=await batch.encode(projectStorageDocument(edit.project));
    await new Promise<void>((resolve,reject)=>{
     const tx=projectWriteTransaction(db),store=tx.objectStore('projects'),request=store.get('current');batch.put(tx);
     const applied=new Map<string,{version:number;revision:number}>();
     request.onsuccess=()=>{
      const persisted=request.result,saved=storedSnapshotHeader(persisted) as Snapshot|undefined;
      const rows=Array.isArray(saved?.projects)?saved.projects.filter(isRow):[];
      const malformed=saved&&(!Array.isArray(saved.projects)||rows.length!==saved.projects.length||new Set(rows.map(([id])=>id)).size!==rows.length);
      const projects=new Map(rows),nextVersions={...saved?.versions};
      let migrating=false;
      for(const [id,edit] of valid){
       const currentVersion=nextVersions[id]??0;
       if(currentVersion!==(versions.get(id)??0)){conflicts.push(id);continue;}
       const previous=projects.get(id) as any;if(previous&&(storedProjectSchema(previous)!==(edit.project.engineDocument?4:3)||previous.runtime==='legacy-react'))migrating=true;
       projects.set(id,edit.encoded);nextVersions[id]=currentVersion+1;applied.set(id,{version:currentVersion+1,revision:edit.revision});
      }
      if(malformed||migrating)backup(store,persisted);
      store.put(wrapProjectSnapshot(db,{selected,projects:[...projects],versions:nextVersions}),'current');
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
   const restoreRevision=revision,ticket=++restoreSerial;
   const isCurrent=()=>revision===restoreRevision&&ticket===restoreSerial&&!pending.size;
   const cancelled=()=>({snapshot:undefined,conflicts:[...pending.keys()],interrupted:true,canApply:()=>false});
   const operation=queue.then(async()=>{
    await retryPinReleases();
    const db=await database;if(!db)throw unavailableDatabase();
    if(!isCurrent())return cancelled();
    const recovery=typeof source==='string'?await read(source):structuredClone(source),raw=recovery as Snapshot;
    if(!raw||!Array.isArray(raw.projects)||!raw.projects.every(isRow)||new Set(raw.projects.map(([id])=>id)).size!==raw.projects.length)throw Error('恢复快照无效');
    // Keep the canonical documents owned by this request. Returning them never
    // needs blob reads after commit, when a different tab may replace and GC them.
    const documents:[string,unknown][]=raw.projects.map(([id,document])=>[id,projectStorageDocument(parseProject(document))]);
    const batch=createBlobWriteBatch(db),rows:[string,unknown][]=[];
    for(const [id,document]of documents)rows.push([id,await batch.encode(document)]);
    if(!isCurrent())return cancelled();
    const conflicts:string[]=[],applied=new Map<string,number>();let restored:Snapshot|undefined,interrupted=false;
    await new Promise<void>((resolve,reject)=>{
     const tx=projectWriteTransaction(db),attempt={tx,changed:false,ids:new Set<string>()};activeRestore=attempt;
     const store=tx.objectStore('projects'),current=store.get('current');batch.put(tx);
     current.onsuccess=()=>{
      const persisted=current.result,saved=storedSnapshotHeader(persisted) as Snapshot|undefined;
      const ids=new Set([...(saved?.projects??[]).filter(isRow).map(([id])=>id),...rows.map(([id])=>id)]);
      for(const id of ids)if((saved?.versions?.[id]??0)!==(versions.get(id)??0))conflicts.push(id);
      if(conflicts.length)return;
      const nextVersions={...saved?.versions};for(const id of ids){nextVersions[id]=(nextVersions[id]??0)+1;applied.set(id,nextVersions[id]);}
      restored={selected:raw.selected,projects:rows,versions:nextVersions};backup(store,persisted);store.put(wrapProjectSnapshot(db,restored),'current');
     };
     tx.oncomplete=()=>{
      if(activeRestore===attempt)activeRestore=undefined;
      interrupted=attempt.changed||!isCurrent();
      if(restored){versions.clear();for(const [id,version]of applied)versions.set(id,version);if(!interrupted)for(const [id,edit]of pending)if(edit.revision<=restoreRevision)pending.delete(id);}
      if(interrupted){conflicts.push(...attempt.ids);restored=undefined;}resolve();
     };
     tx.onabort=()=>{
      if(activeRestore===attempt)activeRestore=undefined;
      if(attempt.changed){interrupted=true;restored=undefined;conflicts.push(...attempt.ids);resolve();}
      else reject(tx.error??Error('恢复事务失败，原始数据未改动'));
     };
    });
    if(!isCurrent())return cancelled();
    const snapshot=restored?{...restored,projects:documents}:undefined;
    // Storage commit and permission to replace the visible editor are distinct.
    // Call immediately before publication, after any caller-owned awaits.
    return {snapshot,conflicts,...(interrupted?{interrupted:true}:{}),canApply:()=>!!snapshot&&isCurrent()};
   });queue=operation.catch(()=>{});return operation;
  },
 };
}

export const LEGACY_PROJECT_DATABASE='godotjs-showcase-workbench-v1';
export function projectDatabaseName(profile:string):string {
 if(!/^[a-z][a-z0-9._-]{0,127}$/.test(profile))throw Error('无效的引擎存储配置');
 return 'godotjs-playground-v3:'+profile;
}
export function projectBlobDatabaseName(profile:string):string {projectDatabaseName(profile);return 'godotjs-playground-blob-v1:'+profile;}
function openDatabase(factory:IDBFactory,name:string,create:boolean,blob=false):Promise<IDBDatabase|undefined>{
 return new Promise((resolve,reject)=>{
  const request=factory.open(name,1);let absent=false,blocked=false;
  request.onupgradeneeded=()=>{if(!create){absent=true;request.transaction?.abort();return;}if(!request.result.objectStoreNames.contains('projects'))request.result.createObjectStore('projects');if(blob)for(const name of ['blobs','pins','journal'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);};
  request.onsuccess=()=>{const db=request.result;if(blocked){db.close();return;}if(!db.objectStoreNames.contains('projects')){db.close();resolve(undefined);}else resolve(db);};
  request.onerror=event=>{if(absent){event.preventDefault();resolve(undefined);}else reject(request.error??Error('无法打开项目存储'));};
  request.onblocked=()=>{blocked=true;reject(new DOMException('项目存储被旧页面阻塞，请关闭旧页面后重试','InvalidStateError'));};
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
const sourceContexts=new WeakMap<IDBDatabase,{profile:string;factory:IDBFactory}>();
async function refreshProjectBlobSources(database:IDBDatabase):Promise<void>{
 const context=sourceContexts.get(database);if(!context)return;
 const {profile,factory}=context;
 // An older application can keep writing its separate namespace while this
 // tab stays open. Capture that branch again before a self-contained export.
 for(const sourceName of [projectDatabaseName(profile),...(profile==='full-engine-v1'?[LEGACY_PROJECT_DATABASE]:[])]){
  const source=await openDatabase(factory,sourceName,false);
  if(source)try{await migrateProjectBlobs(database,source,sourceName);}finally{source.close();}
 }
}
async function exportReadonlyProjectBlobSources(database:IDBDatabase):Promise<unknown>{
 const archive=await exportProjectBlobRecovery(database) as {records:[IDBValidKey,unknown][];[key:string]:unknown},context=sourceContexts.get(database);
 if(!context)return archive;
 const {profile,factory}=context;
 for(const sourceName of [projectDatabaseName(profile),...(profile==='full-engine-v1'?[LEGACY_PROJECT_DATABASE]:[])]){
  const source=await openDatabase(factory,sourceName,false);if(!source)continue;
  try{
   const captured=await exportProjectBlobRecovery(source) as {records:[IDBValidKey,unknown][]};
   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(captured.records))));
   const revision=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
   for(const [key,value]of captured.records)archive.records.push(['migration-source:'+sourceName+':readonly:'+revision+':'+String(key),value]);
  }finally{source.close();}
 }
 return archive;
}
export async function openProjectDatabase(profile:string,{factory=globalThis.indexedDB}:{factory?:IDBFactory}={}):Promise<IDBDatabase|undefined>{
 const name=projectBlobDatabaseName(profile);if(!factory)return undefined;
 const database=await openDatabase(factory,name,true,true);if(!database)return undefined;
 try{
  sourceContexts.set(database,{profile,factory});await refreshProjectBlobSources(database);
  return database;
 }catch(error){
  // A failed legacy migration must not hide an already committed destination.
  // An empty destination still rejects startup so autosave cannot replace the
  // legacy project before its migration has been preserved.
  if(isProjectPersistenceUnavailable(error))try{if(await readProjectRecord(database,'current')!==undefined)return database;}catch(readError){database.close();throw readError;}
  database.close();throw error;
 }
}
