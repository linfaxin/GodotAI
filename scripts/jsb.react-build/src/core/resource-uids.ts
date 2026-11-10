import type {EngineProjectDiagnostic} from './engine-project.js';

export const RESOURCE_UID_CACHE='res://.godot/uid_cache.bin';
const maxId=0x7fffffffffffffffn,encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export interface ResourceUidCacheReadResult {entries:ReadonlyMap<bigint,string>;diagnostics:EngineProjectDiagnostic[]}

/** Godot 4.6.1 ResourceUID::text_to_id, including its historical z/9 behavior. */
export function resourceUidTextToId(text:string):bigint|undefined {
 if(!text.startsWith('uid://')||text==='uid://<invalid>')return undefined;
 let id=0n;
 for(let index=6;index<text.length;index++){
  const code=text.charCodeAt(index);
  const digit=code>=97&&code<=122?code-97:code>=48&&code<=57?code-48+25:undefined;
  if(digit===undefined)return undefined;
  id=BigInt.asUintN(64,id*34n+BigInt(digit));
 }
 return id&maxId;
}
function serialize(entries:ReadonlyMap<bigint,string>):Uint8Array {
 const values=[...entries].sort(([left],[right])=>left<right?-1:left>right?1:0).map(([id,path])=>({id,path:encoder.encode(path)}));
 const bytes=new Uint8Array(4+values.reduce((size,item)=>size+12+item.path.byteLength,0)),view=new DataView(bytes.buffer);
 view.setUint32(0,values.length,true);let offset=4;
 for(const item of values){view.setBigUint64(offset,item.id,true);view.setUint32(offset+8,item.path.byteLength,true);bytes.set(item.path,offset+12);offset+=12+item.path.byteLength;}
 return bytes;
}
/** Read the native binary format without importing a compiler or filesystem. */
export function readResourceUidCache(cached:Uint8Array):ResourceUidCacheReadResult {
 const entries=new Map<bigint,string>(),diagnostics:EngineProjectDiagnostic[]=[];
 const report=(category:'error'|'warning',code:string,message:string,file=RESOURCE_UID_CACHE)=>diagnostics.push({category,code,message,file,line:0,column:0});
  const view=new DataView(cached.buffer,cached.byteOffset,cached.byteLength);let offset=4;
  if(cached.byteLength<4)report('warning','W_ENGINE_UID_CACHE_INVALID','UID cache header is truncated; rebuilding from available source identities.');
  else {
   const count=view.getUint32(0,true);
   for(let index=0;index<count;index++){
    if(offset+12>cached.byteLength){report('warning','W_ENGINE_UID_CACHE_INVALID',`UID cache entry ${index} is truncated; preserving valid preceding entries.`);break;}
    const id=view.getBigUint64(offset,true),length=view.getUint32(offset+8,true);offset+=12;
    if(length>cached.byteLength-offset){report('warning','W_ENGINE_UID_CACHE_INVALID',`UID cache path ${index} is truncated; preserving valid preceding entries.`);break;}
    let path:string|undefined;
    try{path=decoder.decode(cached.subarray(offset,offset+length));}catch{report('warning','W_ENGINE_UID_CACHE_ENTRY',`UID cache entry ${index} contains invalid UTF-8; ignoring that entry.`);}
    offset+=length;
    if(id>maxId||path===undefined||!path||path.includes('\0')){
     if(path!==undefined)report('warning','W_ENGINE_UID_CACHE_ENTRY',`UID cache entry ${index} has an invalid identifier or path; ignoring that entry.`);
     continue;
    }
    // Native update_cache appends replacements; load_from_cache uses the last
    // occurrence of an ID, so duplicate cache records are not source conflicts.
    entries.set(id,path);
   }
   if(offset<cached.byteLength)report('warning','W_ENGINE_UID_CACHE_INVALID','UID cache contains trailing or unreadable data; preserving verified entries and rebuilding its binary index.');
  }
 return {entries,diagnostics};
}
/** Resolve a UID using only verified binary-cache records; invalid UIDs return undefined. */
export function resolveResourceUidFromCache(uid:string,cache:Uint8Array):string|undefined {
 const id=resourceUidTextToId(uid);return id===undefined?undefined:readResourceUidCache(cache).entries.get(id);
}
/** Preserve UID identities while moving their resource paths in an editor transaction. */
export function remapResourceUidCachePaths(cache:Uint8Array,paths:ReadonlyMap<string,string>):Uint8Array {
 const parsed=readResourceUidCache(cache);
 if(parsed.diagnostics.length)throw Error('UID cache is invalid; cannot safely rename resources.');
 let changed=false;
 const entries=new Map<bigint,string>();
 for(const [id,path]of parsed.entries){const next=paths.get(path)??path;entries.set(id,next);changed ||= next!==path;}
 return changed?serialize(entries):cache;
}
/** Merge source identities with the real native cache; never rewrite scene/config text. */
export function prepareResourceUidCache(files:ReadonlyMap<string,Uint8Array>,mainScene?:string):{cache?:Uint8Array;diagnostics:EngineProjectDiagnostic[]} {
 const cached=files.get(RESOURCE_UID_CACHE),parsed=cached?readResourceUidCache(cached):undefined;
 const entries=new Map(parsed?.entries),sources=new Map<bigint,{path:string;file:string}>(),pathIds=new Map<string,Set<bigint>>();
 const diagnostics:EngineProjectDiagnostic[]=[...(parsed?.diagnostics??[])];
 const report=(category:'error'|'warning',code:string,message:string,file=RESOURCE_UID_CACHE)=>diagnostics.push({category,code,message,file,line:0,column:0});
 const declare=(text:string,path:string,file:string)=>{
  const id=resourceUidTextToId(text);
  if(id===undefined){report('warning','W_ENGINE_UID_INVALID',`Invalid Godot UID ${JSON.stringify(text)}; its source file is preserved.`,file);return;}
  const previous=sources.get(id);
  if(previous&&previous.path!==path){report('error','E_ENGINE_UID_CONFLICT',`UID ${text} is declared by both ${previous.path} (${previous.file}) and ${path}.`,file);return;}
  sources.set(id,{path,file});
  const ids=pathIds.get(path)??new Set<bigint>();ids.add(id);pathIds.set(path,ids);
 };
 for(const [path,bytes] of files){
  if(!/\.(?:tscn|tres|uid|import)$/i.test(path))continue;
  let source:string;
  try{source=decoder.decode(bytes);}catch{report('warning','W_ENGINE_UID_METADATA_UTF8','Could not read UID metadata as UTF-8; the original resource is preserved.',path);continue;}
  if(path.endsWith('.uid'))declare(source.trim(),path.slice(0,-4),path);
  else if(path.endsWith('.import')){
   let section='';
   for(const line of source.split(/\r?\n/)){
    const header=/^\s*\[([^\]]+)\]/.exec(line);if(header){section=header[1];continue;}
    if(section==='remap'){const uid=/^\s*uid\s*=\s*"([^"\r\n]*)"/.exec(line);if(uid)declare(uid[1],path.slice(0,-7),path);}
   }
  }else {
   // Only the resource's own first header carries its identity. ext_resource
   // UID references must not claim the containing scene's path.
   const header=/^(?:\uFEFF)?(?:[ \t]*(?:[;#][^\n]*)?\r?\n)*[ \t]*\[(?:gd_scene|gd_resource)\b([^\]]*)\]/.exec(source);
   const uid=header&&/\buid\s*=\s*"([^"\r\n]*)"/.exec(header[1]);if(uid)declare(uid[1],path,path);
  }
 }
 for(const [id,source] of sources){
  const previous=entries.get(id);
  if(previous!==undefined&&previous!==source.path){
   const previousIsPresent=files.has(previous)||files.has(previous+'.import')||files.has(previous+'.remap')
    ||(previous.startsWith('res://')&&previous.endsWith('.ts')&&files.has('res://.godot/GodotJS/'+previous.slice(6,-3)+'.js'));
   const knownPreviousIds=pathIds.get(previous);
   if((previousIsPresent&&!knownPreviousIds)||!previous.startsWith('res://')){
    report('error','E_ENGINE_UID_CACHE_CONFLICT',`UID ${id} maps to ${previous} in the existing cache but is declared by ${source.path}; resolve the resource identity conflict.`,source.file);continue;
   }
   report('warning','W_ENGINE_UID_CACHE_UPDATED',`Updated stale UID ${id} cache path ${previous} to ${source.path}.`,source.file);
  }
  entries.set(id,source.path);
 }
 if(mainScene?.startsWith('uid://')){
  const id=resourceUidTextToId(mainScene);
  if(id===undefined)report('error','E_ENGINE_UID_INVALID',`Main scene has an invalid Godot UID: ${mainScene}`,'res://project.godot');
  else if(!entries.has(id))report('error','E_ENGINE_UID_UNRESOLVED',`Main scene ${mainScene} has no UID mapping. Include its .tscn/.tres header UID, .uid sidecar, .import metadata or valid UID cache.`,'res://project.godot');
 }
 return {cache:cached||entries.size?serialize(entries):undefined,diagnostics};
}
