import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import {launchBrowser} from './browser-harness.mjs';
import {fileURLToPath} from 'node:url';

const entry=fileURLToPath(new URL('../src/project-storage.ts',import.meta.url));
const built=await build({stdin:{contents:`export * from ${JSON.stringify(entry)};export * from ${JSON.stringify(fileURLToPath(new URL('../src/project-blob-storage.ts',import.meta.url)))};`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',globalName:'StorageAPI',platform:'browser',target:'es2022'});
const server=createServer((request,response)=>{response.setHeader('Cache-Control','no-store');if(request.url==='/storage.js'){response.setHeader('Content-Type','text/javascript');response.end(built.outputFiles[0].contents);}else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><script src="/storage.js"></script>');}});
server.listen(0,'127.0.0.1');await once(server,'listening');
let browser;
try{
 browser=await launchBrowser({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();page.on('pageerror',error=>console.error(error.stack));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const report=await page.evaluate(async()=>{
  const A=globalThis.StorageAPI,profile='full-engine-v1';
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const read=(db,store,key)=>new Promise((resolve,reject)=>{const request=db.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const entries=(db,store)=>new Promise((resolve,reject)=>{const tx=db.transaction(store),items=[];const request=tx.objectStore(store).openCursor();request.onsuccess=()=>{const item=request.result;if(item){items.push([item.key,item.value]);item.continue();}};tx.oncomplete=()=>resolve(items);tx.onabort=()=>reject(tx.error);});
  const write=(db,store,key,value)=>new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const open=(name)=>new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const source=await open(A.projectDatabaseName(profile));
  const project={schemaVersion:3,engineProfile:profile,runtime:'react',demoId:'react',entry:'/src/App.tsx',selected:'/src/App.tsx',files:{'/src/App.tsx':'export default function App(){return null}', '/asset.bin':[0,255,31]},controls:{},mode:'production'};
  const original={selected:'a',projects:[['a',project]],versions:{a:4}};
  await write(source,'projects','current',original);await write(source,'projects','recovery',original);
  const db=await A.openProjectDatabase(profile),storage=A.createProjectStorage(Promise.resolve(db));
  check(db.name===A.projectBlobDatabaseName(profile),'new namespace');
  check(equal(await read(source,'projects','current'),original),'source database unchanged');
  const loaded=await storage.load();check(equal(loaded.snapshot.projects[0][1].files,project.files),'migration rehydrates exact files');
  check((await entries(db,'blobs')).length===2,'source and recovery deduplicate file bytes');
  check(await storage.consumeLegacyMigrationNotice(),'one migration notice');check(!await storage.consumeLegacyMigrationNotice(),'notice consumed');
  const other=A.createProjectStorage(Promise.resolve(db));other.remember(loaded.snapshot);
  const edited=structuredClone(project);edited.files['/note.txt']='new tab';storage.stage('a',edited);await storage.save('a');
  other.stage('a',project);check((await other.save('a')).conflicts.includes('a'),'stale tab rejected');
  const aborted=A.createProjectStorage(Promise.resolve(new Proxy(db,{get(target,key){if(key==='transaction')return(...args)=>{const tx=target.transaction(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}})));
  aborted.remember((await storage.load()).snapshot);const notCommitted=structuredClone(edited);notCommitted.files['/failed.txt']='must not commit';aborted.stage('a',notCommitted);
  let failed=false;try{await aborted.save('a');}catch{failed=true;}check(failed&&aborted.hasPending('a'),'aborted write retains pending edits');check(!(await storage.load()).snapshot.projects[0][1].files['/failed.txt'],'aborted write not visible');
  const mutable={files:{'/one.txt':'first','/two.txt':'second'},metadata:{revision:1}},ownedBatch=A.createBlobWriteBatch(db),encoding=ownedBatch.encode(mutable);mutable.files['/two.txt']='changed during digest';mutable.metadata.revision=2;
  const encoded=await encoding;await new Promise((resolve,reject)=>{const tx=A.projectWriteTransaction(db);ownedBatch.put(tx);tx.objectStore('projects').put(encoded,'owned-snapshot');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const owned=await A.readProjectRecord(db,'owned-snapshot');check(owned.files['/two.txt']==='second'&&owned.metadata.revision===1,'record encoding owns all source data before asynchronous hashes');
  const temporary={files:{'/temp.bin':[9,8,7,6]}};
  const pin1=await storage.pinSnapshot(temporary,'job1'),pin2=await other.pinSnapshot(temporary,'job2');
  const before=(await entries(db,'blobs')).length;await pin1.release();await storage.collectBlobs();check((await entries(db,'blobs')).length===before,'second tab pin survives first release');
  await pin2.release();check((await storage.collectBlobs()).removed===1,'unreferenced temporary blob collected');
  const archived=await storage.exportRecovery();check(archived.kind==='godotjs-project-storage-recovery'&&Array.isArray(archived.records),'self-contained recovery archive');
  check(archived.records.find(([key])=>key==='current')[1].projects[0][1].files['/note.txt']==='new tab','archive contains editor data');
  const unicode=structuredClone(edited);unicode.files['/surrogate.txt']='a\ud800b';storage.stage('a',unicode);await storage.save('a');check((await storage.load()).snapshot.projects[0][1].files['/surrogate.txt']==='a\ud800b','lone surrogate preserved');
  const restored=await storage.restore('recovery');check(restored.snapshot&&equal(restored.snapshot.projects[0][1].files,project.files),'restore decodes blob references');
  const imported=await storage.importRecovery(archived);check(imported.currentKey&&!(await storage.load()).snapshot.projects[0][1].files['/note.txt'],'archive import does not activate or overwrite current');
  const activated=await storage.restore(imported.currentKey);check(activated.snapshot.projects[0][1].files['/note.txt']==='new tab','imported archive restores independently');
  const changed=structuredClone(original);changed.versions.a=5;changed.projects[0][1].files['/old-page.txt']='late source edit';await write(source,'projects','current',changed);
  const liveArchive=await storage.exportRecovery();check(liveArchive.records.some(([key,value])=>String(key).startsWith('migration-source:')&&value?.projects?.[0]?.[1]?.files?.['/old-page.txt']==='late source edit'),'export captures the old writer branch without reopening the new page');
  db.close();const reopened=await A.openProjectDatabase(profile),reader=A.createProjectStorage(Promise.resolve(reopened));
  check(!(await reader.load()).snapshot.projects[0][1].files['/old-page.txt'],'late old writer cannot overwrite new branch');
  const recovery=await reader.exportRecovery();check(recovery.records.some(([key,value])=>String(key).startsWith('migration-source:')&&value?.projects?.[0]?.[1]?.files?.['/old-page.txt']==='late source edit'),'late source branch preserved');
  const failures=[];
  const unavailable=A.createProjectStorage(Promise.reject(new DOMException('Denied local persistence','SecurityError')),{onPersistenceUnavailable:error=>failures.push(error.name)});
  const memoryPin=await unavailable.pinSnapshot(temporary,'denied');await memoryPin.release();
  let saveDenied=false;try{await unavailable.save('a');}catch(error){saveDenied=error.name==='SecurityError';}check(saveDenied&&failures.includes('SecurityError'),'denied persistence permits memory pin but never reports saved');
  let pinFault=false;
  const quotaDb=new Proxy(reopened,{get(target,key){if(key==='transaction')return(stores,mode,...rest)=>{if(pinFault&&mode==='readwrite'&&Array.from(typeof stores==='string'?[stores]:stores).includes('pins'))throw new DOMException('Pin store unavailable','QuotaExceededError');return target.transaction(stores,mode,...rest);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const resilient=A.createProjectStorage(Promise.resolve(quotaDb),{onPersistenceUnavailable:error=>failures.push(error.name)});
  pinFault=true;const quotaPin=await resilient.pinSnapshot(temporary,'quota');await quotaPin.release();check(failures.at(-1)==='QuotaExceededError','pin quota failure falls back to owned memory bytes');
  pinFault=false;const durable=await resilient.pinSnapshot(temporary,'release-retry');check((await entries(reopened,'pins')).some(([key])=>key===durable.id),'durable compile pin exists');
  pinFault=true;await durable.release();check((await entries(reopened,'pins')).some(([key])=>key===durable.id),'failed pin delete remains conservative');
  pinFault=false;await resilient.collectBlobs();check(!(await entries(reopened,'pins')).some(([key])=>key===durable.id),'normal GC retries the durable pin deletion after the RPC drops its wrapper');
  const beforeFailures=failures.length;let badSnapshot=false;try{await resilient.pinSnapshot({files:{'/bad':()=>{}}},'bad-codec');}catch(error){badSnapshot=error.name==='DataCloneError';}check(badSnapshot&&failures.length===beforeFailures,'snapshot encoding error is not storage degradation');
  const repeated=await resilient.pinSnapshot(temporary,'repeated');let duplicate=false;try{await resilient.pinSnapshot(temporary,'repeated');}catch(error){duplicate=String(error).includes('Repeated job pin');}await repeated.release();check(duplicate,'duplicate job pin remains an application error');
  // Pin-only quota cannot block readonly project recovery or archive export.
  const put=IDBObjectStore.prototype.put;let pinWrites=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='pins'){pinWrites++;throw new DOMException('No room for a read pin','QuotaExceededError');}return Reflect.apply(put,this,args);};
  try{
   check((await reader.load()).snapshot.selected==='a','existing project restores under pin-write quota');
   check((await reader.exportRecovery()).records.some(([key])=>key==='current'),'existing recovery exports under pin-write quota');
   check(pinWrites===0,'read/export do not attempt persistent pin writes');
  }finally{IDBObjectStore.prototype.put=put;}
  // Legacy migration write failures must not hide a populated destination.
  const transaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(stores,...args){const names=typeof stores==='string'?[stores]:Array.from(stores);if(this.name===reopened.name&&names.includes('journal'))throw new DOMException('Legacy migration quota','QuotaExceededError');return Reflect.apply(transaction,this,[stores,...args]);};
  try{
   const readable=await A.openProjectDatabase(profile),notices=[],existing=A.createProjectStorage(Promise.resolve(readable),{onPersistenceUnavailable:error=>notices.push(error.name)});
   check((await existing.load()).snapshot.selected==='a','migration failure preserves access to committed destination');
   const readonlyArchive=await existing.exportRecovery();
   check(readonlyArchive.records.some(([key])=>key==='current'),'archive still exports committed data if legacy refresh is unavailable');
   check(readonlyArchive.records.some(([key,value])=>String(key).startsWith('migration-source:')&&value?.projects?.[0]?.[1]?.files?.['/old-page.txt']==='late source edit'),'readonly export also preserves the late legacy writer branch');
   check(notices.includes('QuotaExceededError'),'unavailable legacy refresh remains visible');readable.close();
  }finally{IDBDatabase.prototype.transaction=transaction;}
  // The storage owner retries cleanup even if no more RPC/storage calls occur.
  let idlePin=await resilient.pinSnapshot({files:{'/idle.txt':'owned only by ended job'}},'idle-release');
  const idleId=idlePin.id;pinFault=true;await idlePin.release();idlePin=undefined;pinFault=false;
  const until=Date.now()+4000;
  while((await entries(reopened,'pins')).some(([key])=>key===idleId)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  check(!(await entries(reopened,'pins')).some(([key])=>key===idleId),'background retry owns discarded RPC release');
  await resilient.collectBlobs();
  // A GC after transaction completion and before asynchronous validation must
  // not invalidate the owned byte copies, including files decoded later.
  const raceDb=await A.openProjectDatabase('engine-2d-v1'),batch=A.createBlobWriteBatch(raceDb);
  const raceValue={files:{'/first.txt':'first captured bytes','/later.txt':'later captured bytes'}},raceRecord=await batch.encode(raceValue);
  await new Promise((resolve,reject)=>{const tx=A.projectWriteTransaction(raceDb);batch.put(tx);tx.objectStore('projects').put(raceRecord,'race');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const digest=SubtleCrypto.prototype.digest;let entered,continueHash;
  const hashing=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>continueHash=resolve);
  SubtleCrypto.prototype.digest=async function(...args){entered();await gate;return Reflect.apply(digest,this,args);};
  const reading=A.readProjectRecord(raceDb,'race');await hashing;SubtleCrypto.prototype.digest=digest;
  await new Promise((resolve,reject)=>{const tx=raceDb.transaction('projects','readwrite');tx.objectStore('projects').delete('race');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  check((await A.collectProjectBlobs(raceDb)).removed===2,'GC can remove persistent bytes after consistent readonly capture');
  continueHash();check(equal(await reading,raceValue),'captured later files decode after concurrent GC');
  check((await entries(raceDb,'pins')).length===0,'consistent reads need no durable pin');raceDb.close();
  // Restore owns its returned documents before commit. Force a concurrent
  // writer/GC at the old decoder's first post-commit hash, when one exists.
  const restoreDb=await A.openProjectDatabase('review-restore'),restoreStore=A.createProjectStorage(Promise.resolve(restoreDb));
  restoreStore.stage('a',project);await restoreStore.save('a');
  const replacement=structuredClone(project);replacement.files['/src/App.tsx']+=' // recovered';replacement.files['/later.txt']='recovered-only file';
  const recoveryBatch=A.createBlobWriteBatch(restoreDb),recoveryRecord=await A.encodeProjectSnapshot(restoreDb,recoveryBatch,{selected:'a',projects:[['a',replacement]]});
  await new Promise((resolve,reject)=>{const tx=A.projectWriteTransaction(restoreDb);recoveryBatch.put(tx);tx.objectStore('projects').put(recoveryRecord,'recovery');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const recoveryInput=await restoreStore.recovery();let committed=false,pauseDecode,releaseDecode;
  const decodePaused=new Promise(resolve=>pauseDecode=resolve),decodeGate=new Promise(resolve=>releaseDecode=resolve);
  IDBDatabase.prototype.transaction=function(stores,mode,...rest){const tx=Reflect.apply(transaction,this,[stores,mode,...rest]),names=typeof stores==='string'?[stores]:Array.from(stores);if(this===restoreDb&&mode==='readwrite'&&names.includes('projects'))tx.addEventListener('complete',()=>{committed=true;});return tx;};
  SubtleCrypto.prototype.digest=async function(...args){if(committed){SubtleCrypto.prototype.digest=digest;pauseDecode();await decodeGate;}return Reflect.apply(digest,this,args);};
  let restoreResult;
  try{
   const restoring=restoreStore.restore(recoveryInput);
   await Promise.race([restoring,decodePaused]);SubtleCrypto.prototype.digest=digest;
   const concurrent=A.createProjectStorage(Promise.resolve(restoreDb));await concurrent.load();concurrent.stage('a',project);await concurrent.save('a');
   check((await concurrent.collectBlobs()).removed===2,'GC removes both restored-only files after a later tab save');
   releaseDecode();restoreResult=await restoring;
   check(equal(restoreResult.snapshot.projects[0][1].files,replacement.files),'owned restore result survives concurrent save and blob GC');
   check((await restoreStore.load()).snapshot.projects[0][1].files['/later.txt']===undefined,'later tab save remains durable');
  }finally{releaseDecode();SubtleCrypto.prototype.digest=digest;IDBDatabase.prototype.transaction=transaction;}
  // Stage an edit after the completion handler has returned, before the caller
  // receives its result. The committed versions must still permit saving it.
  let intercept=true;const postCommitEdit=structuredClone(project);postCommitEdit.files['/later.txt']='typed after completion';
  const guardedDb=new Proxy(restoreDb,{get(target,key){if(key==='transaction')return(stores,mode,...rest)=>{
   const tx=target.transaction(stores,mode,...rest),names=typeof stores==='string'?[stores]:Array.from(stores);
   if(intercept&&mode==='readwrite'&&names.includes('projects'))Object.defineProperty(tx,'oncomplete',{set(callback){tx.addEventListener('complete',event=>{intercept=false;callback.call(tx,event);guarded.stage('a',postCommitEdit);});}});
   return tx;
  };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const guarded=A.createProjectStorage(Promise.resolve(guardedDb));await guarded.load();
  const cancelled=await guarded.restore(recoveryInput);
  check(cancelled.interrupted&&cancelled.snapshot===undefined&&!cancelled.canApply(),'post-completion edit revokes the returned restore view');
  check(guarded.hasPending('a'),'post-completion edit stays pending');
  check(!(await guarded.save('a')).conflicts.length,'post-completion edit keeps the committed conflict version');
  check((await guarded.load()).snapshot.projects[0][1].files['/later.txt']==='typed after completion','post-completion edit persists without being replaced');
  const applicable=await guarded.restore(recoveryInput);check(applicable.canApply(),'unchanged restore view can be published');
  guarded.stage('a',postCommitEdit);await guarded.save('a');check(!applicable.canApply(),'saving a new edit cannot revive an old publication ticket');
  restoreDb.close();reopened.close();source.close();return {status:'passed',checks:46,scope:'real-chromium-indexeddb',browser:navigator.userAgent};
 });
 assert.equal(report.status,'passed');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();server.close();await once(server,'close');}
