import {canonicalJson,hashBytes} from './hash.js';
import {parseImportReceipt,type ImportReceipt} from './import-receipts.js';
import {byteMap,captureBytes} from './owned-bytes.js';

/** Executable, trusted cache I/O supplied by a host adapter. Project documents
 * and imported receipt JSON never supply this adapter or call storeCompleted. */
export interface ResourceExecutionCacheStorage {
 read(key:string):Promise<Uint8Array|undefined>;
 write(key:string,bytes:Uint8Array):Promise<void>;
 remove?(key:string):Promise<void>;
}
export interface ResourceExecutionCacheOptions {storage?:ResourceExecutionCacheStorage;maxBytes?:number}
export interface ResourceExecutionCacheEntry {receipt:ImportReceipt;outputs:ReadonlyMap<string,Uint8Array>}
const cacheBrand:unique symbol=Symbol('resource-execution-cache');
/** Opaque host-owned cache handle. It has no public API accepting a receipt or
 * output bytes as an assertion that a producer has executed. */
export interface ResourceExecutionCache {readonly [cacheBrand]:true}
const caches=new WeakMap<ResourceExecutionCache,ResourceExecutionCacheImpl>();
const magic=Uint8Array.of(71,74,82,67,1);
const validKey=(key:string)=>/^[a-f0-9]{64}$/.test(key);
/** Only the registry's module-branded deterministic producers may populate or
 * consume these execution records. The public JSON receipt remains untrusted. */
class ResourceExecutionCacheImpl {
 private readonly entries=new Map<string,{bytes:Uint8Array;size:number}>();
 private readonly storage:ResourceExecutionCacheStorage|undefined;
 private readonly maxBytes:number;
 private size=0;
 constructor(options:ResourceExecutionCacheOptions={}) {
  this.maxBytes=options.maxBytes??64*1024*1024;
  if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024)throw Error('E_RESOURCE_CACHE_BUDGET');
  this.storage=options.storage;
 }
 private retain(key:string,bytes:Uint8Array):void {
  const old=this.entries.get(key);if(old){this.size-=old.size;this.entries.delete(key);}
  if(bytes.length>this.maxBytes)return;
  while(this.size+bytes.length>this.maxBytes){const first=this.entries.keys().next().value;if(first===undefined)break;this.size-=this.entries.get(first)!.size;this.entries.delete(first);}
  this.entries.set(key,{bytes,size:bytes.length});this.size+=bytes.length;
 }
 async get(key:string):Promise<ResourceExecutionCacheEntry|undefined> {
  if(!validKey(key))throw Error('E_RESOURCE_CACHE_KEY');
  let record=this.entries.get(key)?.bytes;
  if(record){this.entries.delete(key);this.entries.set(key,{bytes:record,size:record.length});}
  else try{const bytes=await this.storage?.read(key);if(bytes&&bytes.length<=this.maxBytes)record=captureBytes(bytes);}catch{return undefined;}
  if(!record)return undefined;
  try{
   if(record.length<9||!magic.every((byte,index)=>record![index]===byte))throw Error('E_RESOURCE_CACHE_FORMAT');
   const length=new DataView(record.buffer,record.byteOffset,record.byteLength).getUint32(5,true);
   if(length>1024*1024||length>record.length-9)throw Error('E_RESOURCE_CACHE_FORMAT');
   const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.subarray(9,9+length)));
   if(header.key!==key||!Array.isArray(header.outputs)||header.outputs.length>1024)throw Error('E_RESOURCE_CACHE_FORMAT');
   const receipt=parseImportReceipt(header.receipt),outputs=new Map<string,Uint8Array>();let cursor=9+length;
   if(header.outputs.length!==receipt.outputs.length)throw Error('E_RESOURCE_CACHE_FORMAT');
   for(const item of header.outputs){
    if(!item||typeof item.path!=='string'||!Number.isSafeInteger(item.bytes)||item.bytes<1||cursor+item.bytes>record.length||outputs.has(item.path))throw Error('E_RESOURCE_CACHE_FORMAT');
    const expected=receipt.outputs.find(output=>output.path===item.path),bytes=record.subarray(cursor,cursor+item.bytes);
    if(!expected||await hashBytes(bytes)!==expected.sha256)throw Error('E_RESOURCE_CACHE_HASH');
    outputs.set(item.path,captureBytes(bytes));cursor+=item.bytes;
   }
   if(cursor!==record.length)throw Error('E_RESOURCE_CACHE_FORMAT');
   this.retain(key,record);return {receipt,outputs:byteMap(outputs)};
  }catch{
   const old=this.entries.get(key);if(old){this.size-=old.size;this.entries.delete(key);}
   try{await this.storage?.remove?.(key);}catch{}return undefined;
  }
 }
 /** Host adapter records are committed only after an actual successful producer
  * execution and receipt/output verification by ResourceConverterRegistry. */
 async storeCompleted(key:string,receipt:ImportReceipt,outputs:ReadonlyMap<string,Uint8Array>):Promise<void> {
  if(!validKey(key))throw Error('E_RESOURCE_CACHE_KEY');
  const owned=byteMap(outputs),rows=[...owned].sort(([a],[b])=>a<b?-1:a>b?1:0);
  const meta=new TextEncoder().encode(canonicalJson({key,receipt,outputs:rows.map(([path,bytes])=>({path,bytes:bytes.length}))}));
  const size=9+meta.length+rows.reduce((sum,[,bytes])=>sum+bytes.length,0);if(size>this.maxBytes||meta.length>1024*1024)return;
  const record=new Uint8Array(size);record.set(magic);new DataView(record.buffer).setUint32(5,meta.length,true);record.set(meta,9);let offset=9+meta.length;
  for(const [,bytes]of rows){record.set(bytes,offset);offset+=bytes.length;}
  // Cache I/O is optional: a quota or persistence failure cannot invalidate
  // the completed build, and cannot create a partial in-memory record.
  try{await this.storage?.write(key,new Uint8Array(record));}catch{}
  this.retain(key,record);
 }
}
export function createResourceExecutionCache(options:ResourceExecutionCacheOptions={}):ResourceExecutionCache {
 const cache=Object.freeze({[cacheBrand]:true as const});caches.set(cache,new ResourceExecutionCacheImpl(options));return cache;
}
// Package-internal execution access. These functions are not exported by any
// package entry; arbitrary project JSON cannot obtain an execution writer.
export function cachedResourceExecution(cache:ResourceExecutionCache,key:string):Promise<ResourceExecutionCacheEntry|undefined>{const owned=caches.get(cache);if(!owned)throw Error('E_RESOURCE_CACHE_OWNER');return owned.get(key);}
export function storeResourceExecution(cache:ResourceExecutionCache,key:string,receipt:ImportReceipt,outputs:ReadonlyMap<string,Uint8Array>):Promise<void>{const owned=caches.get(cache);if(!owned)throw Error('E_RESOURCE_CACHE_OWNER');return owned.storeCompleted(key,receipt,outputs);}
