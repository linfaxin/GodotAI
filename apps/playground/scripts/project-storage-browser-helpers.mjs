import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Browser contracts use the real storage codec. This helper is injected by tests
// only; the product does not expose a database mutation hook.
let bundle;
async function install(page){
 if(!bundle){
  const entry=fileURLToPath(new URL('../src/project-blob-storage.ts',import.meta.url));
  bundle=build({stdin:{contents:`export * from ${JSON.stringify(entry)};`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',globalName:'ProjectBlobTestCodec',platform:'browser',target:'es2022'}).then(result=>result.outputFiles[0].text+'\n;globalThis.__projectBlobTestCodec=ProjectBlobTestCodec;');
 }
 await page.evaluate(await bundle);
}

export async function readStorageSnapshot(page,name,key='current'){
 await install(page);
 return page.evaluate(async({name,key})=>{
  name??=globalThis.__playgroundWorkbench.inspect().storageDatabaseName;
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{return await globalThis.__projectBlobTestCodec.readProjectRecord(db,key);}finally{db.close();}
 },{name,key});
}

export async function writeStorageSnapshot(page,value,key='current',name){
 await install(page);
 await page.evaluate(async({name,key,value})=>{
  name??=globalThis.__playgroundWorkbench.inspect().storageDatabaseName;
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{
   const codec=globalThis.__projectBlobTestCodec,batch=codec.createBlobWriteBatch(db),stored=await codec.encodeProjectSnapshot(db,batch,value);
   await new Promise((resolve,reject)=>{const tx=codec.projectWriteTransaction(db);batch.put(tx);tx.objectStore('projects').put(stored,key);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
  }finally{db.close();}
 },{name,key,value});
}
