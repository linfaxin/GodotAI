export function database(initial){
 const records=new Map(initial?[['current',structuredClone(initial)]]:[]);
 const db={records,abortNext:false,commits:[],transaction(_name,mode){
  const staged=new Map([...records].map(([k,v])=>[k,structuredClone(v)])),writes=[];
  let aborted=false,scheduled=false;
  const tx={error:null,objectStore(){return store;},abort(){aborted=true;setImmediate(()=>tx.onabort?.());}};
  const complete=()=>{if(scheduled)return;scheduled=true;setImmediate(()=>{
   if(aborted)return;
   if(mode==='readwrite'&&db.abortNext){db.abortNext=false;tx.error=Error('injected abort');tx.abort();return;}
   if(mode==='readwrite'){records.clear();for(const [k,v]of staged)records.set(k,v);db.commits.push(writes);}
   tx.oncomplete?.();
  });};
  const store={openCursor(){const request={},entries=[...staged];let index=0;const advance=()=>queueMicrotask(()=>{const entry=entries[index++];request.result=entry?{key:entry[0],value:structuredClone(entry[1]),continue:advance}:null;request.onsuccess?.();if(!entry)complete();});advance();return request;},get(key){const request={};queueMicrotask(()=>{request.result=structuredClone(staged.get(key));request.onsuccess?.();complete();});return request;},put(value,key){staged.set(key,structuredClone(value));writes.push(key);complete();}};
  return tx;
 }};
 return db;
}
