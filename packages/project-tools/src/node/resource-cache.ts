import {mkdir,readFile,writeFile,rename,unlink,readdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createResourceExecutionCache,type ResourceExecutionCacheOptions,type ResourceExecutionCache} from '../resource-execution-cache.js';

/** Dedicated host-owned cache directory, never an imported project document.
 * Atomic rename publishes completed records; budget eviction is reconstructible. */
export function createNodeResourceExecutionCache(directory:string,options:{maxBytes?:number;maxStorageBytes?:number}={}):ResourceExecutionCache {
 const root=resolve(directory),maxStorageBytes=options.maxStorageBytes??256*1024*1024;
 if(!Number.isSafeInteger(maxStorageBytes)||maxStorageBytes<1024)throw Error('E_RESOURCE_CACHE_BUDGET');
 const filename=(key:string)=>{if(!/^[a-f0-9]{64}$/.test(key))throw Error('E_RESOURCE_CACHE_KEY');return join(root,key+'.gjrc');};
 let queue=Promise.resolve();
 const storage:NonNullable<ResourceExecutionCacheOptions['storage']>={
  async read(key){try{const name=filename(key),info=await stat(name);if(!info.isFile()||info.size>(options.maxBytes??64*1024*1024))return undefined;return new Uint8Array(await readFile(name));}catch{return undefined;}},
  async write(key,bytes){
   const operation=queue.then(async()=>{
    await mkdir(root,{recursive:true,mode:0o700});const destination=filename(key),temporary=destination+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,destination);}finally{await unlink(temporary).catch(()=>{});}
    const entries=await Promise.all((await readdir(root)).filter(name=>/^[a-f0-9]{64}\.gjrc$/.test(name)).map(async name=>({name,info:await stat(join(root,name))})));
    let total=entries.reduce((sum,entry)=>sum+entry.info.size,0);
    for(const entry of entries.sort((a,b)=>a.info.mtimeMs-b.info.mtimeMs)){if(total<=maxStorageBytes)break;await unlink(join(root,entry.name)).catch(()=>{});total-=entry.info.size;}
   });queue=operation.catch(()=>{});return operation;
  },
  async remove(key){await unlink(filename(key)).catch(()=>{});},
 };
 return createResourceExecutionCache({storage,maxBytes:options.maxBytes});
}
