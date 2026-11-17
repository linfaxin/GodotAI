import type {EngineProjectDiagnostic} from './engine-project.js';
import type {PackResult} from './pck.js';
import {adoptBytes,captureBytes,hashOwnedBytes} from './owned-bytes.js';
import {readPckIndex,type PckIndexEntry} from '@godot-js/engine/pck-index';

export interface CachedEmit {outputText:string;sourceMapText?:string;diagnostics:readonly EngineProjectDiagnostic[];rewritten:boolean;nativeReferenced:boolean}
export interface BuildCacheMetrics {emitHits:number;emitMisses:number;packHits:number;packMisses:number;packBytesWritten:number;textBytesEncoded:number;packBytesVerified:number;packBytesCopied:number}
type Entry={value:unknown;bytes:number};
type State={entries:Map<string,Entry>;bytes:number;epoch:number;maxBytes:number;maxEntries:number;metrics:BuildCacheMetrics};
const states=new WeakMap<ProjectBuildCache,State>();
/** Cache state is execution metadata. It never participates in build identity. */
export class ProjectBuildCache {
 constructor(options:{maxBytes?:number;maxEntries?:number}={}){
  const maxBytes=options.maxBytes??64*1024*1024,maxEntries=options.maxEntries??512;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw Error('E_BUILD_CACHE_BUDGET');
  states.set(this,{entries:new Map(),bytes:0,epoch:0,maxBytes,maxEntries,metrics:{emitHits:0,emitMisses:0,packHits:0,packMisses:0,packBytesWritten:0,textBytesEncoded:0,packBytesVerified:0,packBytesCopied:0}});
 }
 get metrics():Readonly<BuildCacheMetrics>{return {...states.get(this)!.metrics};}
 clear():void {const state=states.get(this)!;state.entries.clear();state.bytes=0;state.epoch++;pendingPacks.get(this)?.clear();}
}
function get<T>(cache:ProjectBuildCache,key:string):T|undefined{const state=states.get(cache)!;const entry=state.entries.get(key);if(!entry)return;state.entries.delete(key);state.entries.set(key,entry);return entry.value as T;}
function put(cache:ProjectBuildCache,key:string,value:unknown,bytes:number):void{
 const state=states.get(cache)!;if(bytes>state.maxBytes)return;
 const previous=state.entries.get(key);if(previous){state.bytes-=previous.bytes;state.entries.delete(key);}
 state.entries.set(key,{value,bytes});state.bytes+=bytes;
 while(state.bytes>state.maxBytes||state.entries.size>state.maxEntries){const first=state.entries.keys().next().value!;state.bytes-=state.entries.get(first)!.bytes;state.entries.delete(first);}
}
/** Internal helpers never expose cached buffers through the public cache API. */
export function cachedTextBytes(cache:ProjectBuildCache|undefined,text:string):Uint8Array{
 if(!cache)return adoptBytes(new TextEncoder().encode(text));
 const key='text:'+text;let bytes=get<Uint8Array>(cache,key);if(bytes)return bytes;
 bytes=adoptBytes(new TextEncoder().encode(text));states.get(cache)!.metrics.textBytesEncoded+=bytes.length;put(cache,key,bytes,bytes.length+text.length*2);return bytes;
}
export function getCachedEmit(cache:ProjectBuildCache|undefined,key:string):CachedEmit|undefined{
 if(!cache)return;const result=get<CachedEmit>(cache,'emit:'+key);states.get(cache)!.metrics[result?'emitHits':'emitMisses']++;return result;
}
export function putCachedEmit(cache:ProjectBuildCache|undefined,key:string,value:CachedEmit):void{
 if(!cache)return;const copy={...value,diagnostics:value.diagnostics.map(item=>Object.freeze({...item}))};
 put(cache,'emit:'+key,Object.freeze(copy),(key.length+value.outputText.length+(value.sourceMapText?.length??0))*2+JSON.stringify(value.diagnostics).length*2);
}
export function getCachedPack(cache:ProjectBuildCache|undefined,key:string):PackResult|undefined{
 if(!cache)return;const result=get<PackResult>(cache,'pack:'+key);states.get(cache)!.metrics[result?'packHits':'packMisses']++;
 return result&&{pack:new Uint8Array(result.pack),index:result.index};
}
export function putCachedPack(cache:ProjectBuildCache|undefined,key:string,value:PackResult):void{
 if(!cache)return;states.get(cache)!.metrics.packBytesWritten+=value.pack.length;
 put(cache,'pack:'+key,{pack:new Uint8Array(value.pack),index:value.index},value.pack.length+key.length*2);
}

/** Internal opaque package cache record. Its byte storage never crosses this module. */
export interface VerifiedPackDescriptor {readonly sha256:string;readonly byteLength:number;readonly entries:readonly PckIndexEntry[]}
const verifiedPacks=new WeakMap<VerifiedPackDescriptor,Uint8Array>();
const pendingPacks=new WeakMap<ProjectBuildCache,Map<string,Promise<VerifiedPackDescriptor>>>();
export async function cachedVerifiedPack(cache:ProjectBuildCache|undefined,key:string,produce:()=>PackResult):Promise<VerifiedPackDescriptor>{
 const cacheKey='verified-pack:'+key,epoch=cache?states.get(cache)!.epoch:0;
 const found=cache&&get<VerifiedPackDescriptor>(cache,cacheKey);
 if(found){states.get(cache!)!.metrics.packHits++;return found;}
 let pending=cache&&pendingPacks.get(cache)?.get(key);
 if(pending){states.get(cache!)!.metrics.packHits++;return pending;}
 if(cache)states.get(cache)!.metrics.packMisses++;
 pending=(async()=>{
  const result=produce(),bytes=captureBytes(result.pack),index=readPckIndex(bytes);
  const descriptor:VerifiedPackDescriptor=Object.freeze({sha256:await hashOwnedBytes(bytes),byteLength:bytes.length,entries:index.entries});
  verifiedPacks.set(descriptor,bytes);
  if(cache){const state=states.get(cache)!;state.metrics.packBytesWritten+=bytes.length;state.metrics.packBytesVerified+=bytes.length;
   if(state.epoch===epoch)put(cache,cacheKey,descriptor,bytes.length+cacheKey.length*2+index.entries.reduce((n,entry)=>n+entry.path.length*2+128,0));
  }
  return descriptor;
 })();
 if(cache){let jobs=pendingPacks.get(cache);if(!jobs){jobs=new Map();pendingPacks.set(cache,jobs);}if(jobs.size<states.get(cache)!.maxEntries){jobs.set(key,pending);void pending.finally(()=>{if(jobs!.get(key)===pending)jobs!.delete(key);}).catch(()=>{});}}
 return pending;
}
/** The one output copy can be transferred or mutated without changing cache identity. */
export function materializeVerifiedPack(descriptor:VerifiedPackDescriptor,cache?:ProjectBuildCache):Uint8Array {
 const bytes=verifiedPacks.get(descriptor);if(!bytes)throw Error('E_BUILD_CACHE_PACK: Unknown verified pack');
 if(cache)states.get(cache)!.metrics.packBytesCopied+=bytes.length;
 return new Uint8Array(bytes);
}
