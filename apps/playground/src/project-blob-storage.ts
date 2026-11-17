/** Versioned project storage internals. Source JSON cannot mint a stored blob reference. */
export const PROJECT_BLOB_LAYOUT=1 as const;
const RECORD='godotjs-owned-project-record';
const SNAPSHOT='godotjs-owned-project-snapshot';
const HASH=/^[a-f0-9]{64}$/;
type Encoding='utf8'|'utf16le'|'binary';
type Wire=null|boolean|number|string|{t:'array';items:Wire[]}|{t:'object';entries:[string,Wire][]}|{t:'opaque';value:unknown}|{t:'file';hash:string;bytes:number;encoding:Encoding};
export interface StoredProjectRecord {kind:typeof RECORD;layout:1;tree:Wire}
export interface BlobWriteBatch {readonly blobs:Map<string,Uint8Array>;encode(value:unknown):Promise<unknown>;put(tx:IDBTransaction):void}
export interface ProjectBlobPin {id:string;release():Promise<void>}
export interface MigrationResult {copied:number;conflicts:string[];sourceChanged:boolean}
const encoder=new TextEncoder();
export const projectBlobEnabled=(db:IDBDatabase|undefined):boolean=>!!db&&!!db.objectStoreNames?.contains('blobs');
const record=(value:unknown):value is StoredProjectRecord=>!!value&&typeof value==='object'&&(value as StoredProjectRecord).kind===RECORD&&(value as StoredProjectRecord).layout===1&&Object.hasOwn(value,'tree');
const hashBytes=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)),b=>b.toString(16).padStart(2,'0')).join('');
const fail=(message:string):never=>{throw Error('E_PROJECT_BLOB: '+message);};
const bytesForText=(text:string):{bytes:Uint8Array;encoding:Encoding}=>{
 let valid=true;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff)){valid=false;break;}}else if(c>=0xdc00&&c<=0xdfff){valid=false;break;}}
 if(valid)return {bytes:encoder.encode(text),encoding:'utf8'};
 // In-progress editor text can contain lone UTF-16 surrogates; preserve it exactly.
 const bytes=new Uint8Array(text.length*2),view=new DataView(bytes.buffer);
 for(let i=0;i<text.length;i++)view.setUint16(i*2,text.charCodeAt(i),true);
 return {bytes,encoding:'utf16le'};
};
const isFileMap=(value:unknown):value is Record<string,string|number[]|Uint8Array>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(item=>typeof item==='string'||item instanceof Uint8Array||Array.isArray(item)&&item.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255));

export function createBlobWriteBatch(db:IDBDatabase|undefined):BlobWriteBatch {
 const blobs=new Map<string,Uint8Array>();
 const encode=async(value:unknown):Promise<unknown>=>{
  const captured=structuredClone(value);
  if(!projectBlobEnabled(db))return captured;
  const ancestors=new Set<object>();
  const walk=async(item:unknown,file=false,depth=0):Promise<Wire>=>{
   if(file&&(typeof item==='string'||item instanceof Uint8Array||Array.isArray(item))){
    const captured=typeof item==='string'?bytesForText(item):{bytes:new Uint8Array(item as ArrayLike<number>),encoding:'binary' as const};
    const hash=await hashBytes(captured.bytes);if(!blobs.has(hash))blobs.set(hash,captured.bytes);
    return {t:'file',hash,bytes:captured.bytes.byteLength,encoding:captured.encoding};
   }
   if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number')return item;
   if(typeof item!=='object'||depth>256||ancestors.has(item)||(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null))return {t:'opaque',value:structuredClone(item)};
   ancestors.add(item);
   try{
    if(Array.isArray(item))return {t:'array',items:await Promise.all(item.map(value=>walk(value,false,depth+1)))};
    const entries:[string,Wire][]=[];
    for(const [key,value]of Object.entries(item)){
     if(key==='files'&&isFileMap(value)){
      const files:[string,Wire][]=[];for(const [path,contents]of Object.entries(value))files.push([path,await walk(contents,true,depth+1)]);
      entries.push([key,{t:'object',entries:files}]);
     }else entries.push([key,await walk(value,false,depth+1)]);
    }
    return {t:'object',entries};
   }finally{ancestors.delete(item);}
  };
  return {kind:RECORD,layout:PROJECT_BLOB_LAYOUT,tree:await walk(captured)} satisfies StoredProjectRecord;
 };
 return {blobs,encode,put(tx){if(projectBlobEnabled(db)){
  const store=tx.objectStore('blobs');
  for(const [hash,bytes]of blobs){const request=typeof store.getKey==='function'?store.getKey(hash):store.get(hash);request.onsuccess=()=>{if(request.result===undefined)store.put({layout:1,hash,bytes},hash);};}
 }}};
}

export function projectWriteTransaction(db:IDBDatabase,extra:string[]=[]):IDBTransaction {
 return db.transaction(projectBlobEnabled(db)?['projects','blobs',...extra]:['projects',...extra],'readwrite');
}
/** Snapshot metadata remains synchronously mergeable inside the IDB write transaction. */
export function storedSnapshotHeader(value:unknown):any {
 return value&&typeof value==='object'&&(value as any).kind===SNAPSHOT&&(value as any).layout===1?(value as any).snapshot:value;
}
export function wrapProjectSnapshot(db:IDBDatabase,value:unknown):unknown {
 return projectBlobEnabled(db)?{kind:SNAPSHOT,layout:1,snapshot:value}:value;
}
export async function encodeProjectSnapshot(db:IDBDatabase,batch:BlobWriteBatch,value:unknown):Promise<unknown>{
 if(!projectBlobEnabled(db))return structuredClone(value);
 const snapshot=value as any;
 if(!snapshot||typeof snapshot!=='object'||!Array.isArray(snapshot.projects))return batch.encode(value);
 const projects:unknown[]=[];
 for(const row of snapshot.projects){
  if(Array.isArray(row)&&row.length===2&&typeof row[0]==='string')projects.push([row[0],await batch.encode(row[1])]);
  else projects.push(await batch.encode(row));
 }
 return wrapProjectSnapshot(db,{...structuredClone(snapshot),projects});
}
export function storedProjectSchema(value:unknown):number|undefined {
 if(record(value)&&value.tree&&typeof value.tree==='object'&&value.tree.t==='object'){
  const schema=value.tree.entries.find(([key])=>key==='schemaVersion')?.[1];return typeof schema==='number'?schema:undefined;
 }
 return value&&typeof value==='object'?(value as {schemaVersion?:number}).schemaVersion:undefined;
}
/** Copy metadata and every referenced byte in one readonly transaction. GC and
 * writers cannot interleave before the copies are owned; hashing may then yield. */
async function captureProjectRecords(db:IDBDatabase,key?:IDBValidKey){
 const records:[IDBValidKey,unknown][]=[],blobs=new Map<string,unknown>(),enabled=projectBlobEnabled(db);
 await new Promise<void>((resolve,reject)=>{
  const tx=db.transaction(enabled?['projects','blobs']:['projects'],'readonly');
  const capture=(key:IDBValidKey,value:unknown)=>{
   records.push([key,value]);
   if(enabled)for(const hash of storedBlobHashes(value))if(!blobs.has(hash)){
    blobs.set(hash,undefined);
    const request=tx.objectStore('blobs').get(hash);request.onsuccess=()=>blobs.set(hash,request.result);
   }
  };
  const store=tx.objectStore('projects');
  if(key!==undefined){const request=store.get(key);request.onsuccess=()=>{try{capture(key,request.result);}catch(error){reject(error);tx.abort();}};}
  else{const request=store.openCursor();request.onsuccess=()=>{try{const cursor=request.result;if(cursor){capture(cursor.key,cursor.value);cursor.continue();}}catch(error){reject(error);tx.abort();}};}
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new DOMException('Project snapshot read aborted','AbortError'));
 });
 return {records,blobs};
}
export async function readProjectRecord(db:IDBDatabase,key:IDBValidKey):Promise<unknown>{
 const {records,blobs}=await captureProjectRecords(db,key);
 return decodeProjectRecord(db,records[0]?.[1],blobs);
}
export async function decodeProjectRecord(db:IDBDatabase,value:unknown,blobs?:ReadonlyMap<string,unknown>):Promise<unknown>{
 if(value&&typeof value==='object'&&(value as any).kind===SNAPSHOT&&(value as any).layout===1)return decodeProjectRecord(db,(value as any).snapshot,blobs);
 if(!record(value)){
  if(Array.isArray(value))return Promise.all(value.map(item=>decodeProjectRecord(db,item,blobs)));
  if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){
   const result:Record<string,unknown>={};for(const [key,item]of Object.entries(value))Object.defineProperty(result,key,{value:await decodeProjectRecord(db,item,blobs),enumerable:true,writable:true,configurable:true});return result;
  }
  return structuredClone(value);
 }
 const cache=new Map<string,Promise<Uint8Array>>();
 const bytes=(ref:{hash:string;bytes:number})=>{
  if(!HASH.test(ref.hash)||!Number.isSafeInteger(ref.bytes)||ref.bytes<0)fail('Malformed file reference');
  let pending=cache.get(ref.hash);
  if(!pending){pending=(blobs?Promise.resolve(blobs.get(ref.hash)):new Promise<unknown>((resolve,reject)=>{
   const request=db.transaction('blobs').objectStore('blobs').get(ref.hash);
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  })).then(async(row:any)=>{
   if(!row||row.layout!==1||row.hash!==ref.hash||!(row.bytes instanceof Uint8Array))fail('Missing file '+ref.hash);
   const bytes=new Uint8Array(row.bytes);if(await hashBytes(bytes)!==ref.hash)fail('File hash mismatch');return bytes;
  });cache.set(ref.hash,pending);}
  return pending.then(bytes=>{if(bytes.length!==ref.bytes)fail('File byte length mismatch');return bytes;});
 };
 const walk=async(item:Wire,depth=0):Promise<any>=>{
  if(item===null||typeof item!=='object')return item;
  if(depth>512)fail('Record nesting budget exceeded');
  if(item.t==='opaque')return structuredClone(item.value);
  if(item.t==='array')return Promise.all(item.items.map(value=>walk(value,depth+1)));
  if(item.t==='object'){
   const result:Record<string,unknown>={};for(const [key,value]of item.entries)Object.defineProperty(result,key,{value:await walk(value,depth+1),enumerable:true,writable:true,configurable:true});return result;
  }
  if(item.t!=='file')return fail('Unknown storage record');
  const contents=await bytes(item);
  if(item.encoding==='binary')return Array.from(contents);
  if(item.encoding==='utf8')return new TextDecoder('utf-8',{fatal:true}).decode(contents);
  if(item.encoding==='utf16le'){
   if(contents.length%2)fail('Malformed UTF-16 file');const view=new DataView(contents.buffer,contents.byteOffset,contents.byteLength),parts:string[]=[];
   for(let i=0;i<contents.length;i+=16384){const codes:number[]=[];for(let j=i;j<Math.min(i+16384,contents.length);j+=2)codes.push(view.getUint16(j,true));parts.push(String.fromCharCode(...codes));}return parts.join('');
  }
  return fail('Unknown file encoding');
 };
 return walk(value.tree);
}
export function storedBlobHashes(value:unknown,result=new Set<string>()):Set<string>{
 if(!record(value)){
  if(Array.isArray(value))value.forEach(item=>storedBlobHashes(item,result));
  else if(value&&typeof value==='object')Object.values(value).forEach(item=>storedBlobHashes(item,result));
  return result;
 }
 const walk=(item:Wire)=>{if(!item||typeof item!=='object')return;if(item.t==='file'){if(HASH.test(item.hash))result.add(item.hash);}else if(item.t==='array')item.items.forEach(walk);else if(item.t==='object')item.entries.forEach(([,value])=>walk(value));};walk(value.tree);return result;
}
const rows=(db:IDBDatabase,store='projects')=>new Promise<[IDBValidKey,unknown][]>((resolve,reject)=>{
 const tx=db.transaction(store),result:[IDBValidKey,unknown][]=[];const request=tx.objectStore(store).openCursor();request.onsuccess=()=>{const cursor=request.result;if(cursor){result.push([cursor.key,structuredClone(cursor.value)]);cursor.continue();}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error);
});
const fingerprint=async(value:unknown):Promise<string>=>{
 try{return await hashBytes(encoder.encode(JSON.stringify(value)));}catch{return 'opaque';}
};
/** Immutable source copy; checkpoints and conflicts survive interruption/retry. */
export async function migrateProjectBlobs(destination:IDBDatabase,source:IDBDatabase,sourceName:string):Promise<MigrationResult>{
 const sourceRows=await rows(source),sourceCurrent=sourceRows.find(([key])=>key==='current')?.[1],sourceHash=await fingerprint(sourceRows),currentHash=await fingerprint(sourceCurrent);
 const id='migration:'+sourceName+':'+sourceHash,batch=createBlobWriteBatch(destination);
 const existing=await new Promise<any>((resolve,reject)=>{const request=destination.transaction('journal').objectStore('journal').get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 if(existing?.status==='complete')return {copied:0,conflicts:existing.conflicts??[],sourceChanged:false};
 const prepared=await Promise.all(sourceRows.map(async([key,value])=>[key,await encodeProjectSnapshot(destination,batch,value)] as [IDBValidKey,unknown]));
 const result:MigrationResult={copied:0,conflicts:[],sourceChanged:false};
 await new Promise<void>((resolve,reject)=>{
  const tx=projectWriteTransaction(destination,['journal']),store=tx.objectStore('projects'),journal=tx.objectStore('journal');let pending=prepared.length;
  const finish=()=>{if(pending)return;journal.put({layout:1,source:sourceName,sourceHash,status:'complete',copied:result.copied,conflicts:result.conflicts},id);};
  batch.put(tx);
  if(!pending){finish();}
  for(const [key,value]of prepared){
   const request=store.get(key);request.onsuccess=()=>{
    if(request.result===undefined){store.put(value,key);result.copied++;}
    else{
     const conflict='migration-source:'+sourceName+':'+sourceHash+':'+String(key);
     const saved=store.get(conflict);saved.onsuccess=()=>{if(saved.result===undefined)store.put(value,conflict);};
     // This raw source revision remains recoverable even if the destination was edited.
     if(key==='current')result.conflicts.push(sourceName);
    }
    journal.put({layout:1,source:sourceName,sourceHash,status:'copied',key:String(key)},id+':'+String(key));pending--;finish();
   };
  }
  store.put({source:sourceName,copied:sourceRows.length>0,sourceHash,notified:false},'blob-migration-notice');
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('E_PROJECT_BLOB: Migration aborted'));
 });
 // A source page can write after the consistent snapshot was read. Preserve the
 // fork rather than pretending the two databases have a shared transaction.
 const latest=await new Promise<unknown>((resolve,reject)=>{const request=source.transaction('projects').objectStore('projects').get('current');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 result.sourceChanged=await fingerprint(latest)!==currentHash;
 return result;
}
export async function pinProjectSnapshot(db:IDBDatabase,owner:string,job:string,value:unknown):Promise<ProjectBlobPin>{
 if(!projectBlobEnabled(db))return {id:owner+':'+job,release:async()=>{}};
 if(!owner||!job||owner.length>256||job.length>256)fail('Invalid pin owner/job');
 const batch=createBlobWriteBatch(db),encoded=await batch.encode(value),hashes=[...storedBlobHashes(encoded)].sort(),id=JSON.stringify([owner,job]);
 await new Promise<void>((resolve,reject)=>{
  const tx=db.transaction(['blobs','pins'],'readwrite'),pins=tx.objectStore('pins'),request=pins.get(id);let repeated=false,failure:unknown;
  request.onsuccess=()=>{try{if(request.result!==undefined){repeated=true;tx.abort();return;}batch.put(tx);pins.put({layout:1,owner,job,hashes},id);}catch(error){failure=error;tx.abort();}};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??(repeated?Error('E_PROJECT_BLOB: Repeated job pin'):tx.error));
 });
 let released=false;
 return {id,async release(){if(released)return;await releasePin(db,id);released=true;}};
}
async function releasePin(db:IDBDatabase,id:string):Promise<void>{
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('pins','readwrite');tx.objectStore('pins').delete(id);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
}
/** One transaction serializes mark/delete with writers and cross-tab pins. */
export async function collectProjectBlobs(db:IDBDatabase):Promise<{removed:number;retained:number;blocked:boolean}>{
 if(!projectBlobEnabled(db))return {removed:0,retained:0,blocked:false};
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(['projects','blobs','pins'],'readwrite'),live=new Set<string>();let pending=2,blocked=false,removed=0,retained=0;
  const collect=()=>{if(--pending)return;const store=tx.objectStore('blobs'),request=typeof store.openKeyCursor==='function'?store.openKeyCursor():store.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(blocked||live.has(String(cursor.key)))retained++;else{store.delete(cursor.primaryKey);removed++;}cursor.continue();};};
  const projects=tx.objectStore('projects').openCursor();projects.onsuccess=()=>{const cursor=projects.result;if(cursor){storedBlobHashes(cursor.value,live);cursor.continue();}else collect();};
  const pins=tx.objectStore('pins').openCursor();pins.onsuccess=()=>{const cursor=pins.result;if(cursor){const pin=cursor.value;if(pin?.layout!==1||!Array.isArray(pin.hashes)||pin.hashes.some((hash:unknown)=>typeof hash!=='string'||!HASH.test(hash)))blocked=true;else pin.hashes.forEach((hash:string)=>live.add(hash));cursor.continue();}else collect();};
  tx.oncomplete=()=>resolve({removed,retained,blocked});tx.onabort=()=>reject(tx.error);
 });
}
/** Self-contained recovery archive; no dependency on the currently deployed UI. */
export async function exportProjectBlobRecovery(db:IDBDatabase):Promise<unknown>{
 const {records,blobs}=await captureProjectRecords(db);
 const decoded:[IDBValidKey,unknown][]=[];for(const [key,value]of records)decoded.push([key,await decodeProjectRecord(db,value,blobs)]);
 return {kind:'godotjs-project-storage-recovery',storageLayout:projectBlobEnabled(db)?PROJECT_BLOB_LAYOUT:0,databaseName:db.name,records:decoded};
}
/** Import into recovery keys only. Activating a snapshot remains a versioned restore. */
export async function importProjectBlobRecovery(db:IDBDatabase,archive:unknown):Promise<{id:string;currentKey?:string;records:number}>{
 const value=archive as any;
 if(!value||value.kind!=='godotjs-project-storage-recovery'||![0,1].includes(value.storageLayout)||!Array.isArray(value.records)||value.records.length>10000)fail('Invalid recovery archive');
 if(value.databaseName&&typeof value.databaseName!=='string')fail('Invalid recovery database');
 const id='recovery-import:'+crypto.randomUUID(),seen=new Set<string>(),batch=createBlobWriteBatch(db),prepared:[string,unknown][]=[];let currentKey:string|undefined;
 for(const row of value.records){
  if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||seen.has(row[0]))fail('Invalid or repeated recovery record');
  seen.add(row[0]);const key=id+':'+row[0];if(row[0]==='current')currentKey=key;
  prepared.push([key,await encodeProjectSnapshot(db,batch,row[1])]);
 }
 await new Promise<void>((resolve,reject)=>{
  const tx=projectWriteTransaction(db),store=tx.objectStore('projects');batch.put(tx);
  for(const [key,value]of prepared)store.put(value,key);
  store.put({layout:1,kind:'recovery-import',sourceDatabase:value.databaseName??null,records:prepared.length,currentKey:currentKey??null},id);
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
 });
 return {id,currentKey,records:prepared.length};
}
