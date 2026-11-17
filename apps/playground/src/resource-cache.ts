import {createResourceExecutionCache,type ResourceExecutionCacheStorage} from '@godot-js/project-tools/resource-converters';

/** Separate, reconstructible producer cache. It never reads project imports,
 * recovery snapshots or user-provided receipt JSON as execution records. */
export function createBrowserResourceExecutionCache(factory:IDBFactory|undefined=globalThis.indexedDB){
 const maxStorageBytes=128*1024*1024;
 const database=new Promise<IDBDatabase|undefined>(resolve=>{
  if(!factory){resolve(undefined);return;}
  try{const request=factory.open('godotjs-resource-executions-v1',1);
   request.onupgradeneeded=()=>{request.result.createObjectStore('records');request.result.createObjectStore('metadata');};
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(undefined);request.onblocked=()=>resolve(undefined);
  }catch{resolve(undefined);}
 });
 const storage:ResourceExecutionCacheStorage={
  async read(key){const db=await database;if(!db)return undefined;
   return new Promise<Uint8Array|undefined>((resolve,reject)=>{
    const tx=db.transaction(['records','metadata'],'readwrite'),request=tx.objectStore('records').get(key);let bytes:Uint8Array|undefined;
    request.onsuccess=()=>{if(request.result instanceof Uint8Array){bytes=request.result;tx.objectStore('metadata').put({key,bytes:bytes.length,used:Date.now()},key);}};
    tx.oncomplete=()=>resolve(bytes);tx.onabort=()=>reject(tx.error??Error('Resource cache read failed'));
   });
  },
  async write(key,bytes){const db=await database;if(!db||bytes.length>maxStorageBytes)return;
   await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['records','metadata'],'readwrite'),records=tx.objectStore('records'),metadata=tx.objectStore('metadata');
    records.put(bytes,key);metadata.put({key,bytes:bytes.length,used:Date.now()},key);
    const request=metadata.getAll();request.onsuccess=()=>{
     const rows=(request.result as Array<{key:string;bytes:number;used:number}>).sort((a,b)=>a.used-b.used);let total=rows.reduce((sum,row)=>sum+row.bytes,0);
     for(const row of rows){if(total<=maxStorageBytes)break;if(row.key===key)continue;records.delete(row.key);metadata.delete(row.key);total-=row.bytes;}
    };
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Resource cache write failed'));
   });
  },
  async remove(key){const db=await database;if(!db)return;await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['records','metadata'],'readwrite');tx.objectStore('records').delete(key);tx.objectStore('metadata').delete(key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Resource cache remove failed'));});},
 };
 return createResourceExecutionCache({storage,maxBytes:64*1024*1024});
}
