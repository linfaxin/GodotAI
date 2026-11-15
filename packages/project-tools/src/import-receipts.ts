import {hashBytes,hashJson,canonicalJson} from './hash.js';
import {resourcePath} from './paths.js';
import {ProjectToolError} from './errors.js';
import SparkMD5 from 'spark-md5';
import {readProjectStringSettings} from './project-settings.js';

export interface ImportTarget {resourceAbi:string;features:Readonly<Record<string,string|number|boolean>>}
export interface ImportConverter {id:string;version:string}
export interface ResourceHash {path:string;sha256:string}
export interface ImportReceipt {
 schemaVersion:1;kind:'godotjs-import-receipt';resource:string;uid?:string;
 converter:ImportConverter;target:ImportTarget;parameterHash:string;
 sources:readonly ResourceHash[];outputs:readonly ResourceHash[];
}
export interface ImportInspection {
 resource:string;uid?:string;files:ReadonlyMap<string,Uint8Array>;
 outputFiles?:ReadonlyMap<string,Uint8Array>;
 converter:ImportConverter;target:ImportTarget;parameters:unknown;
 /** Include the primary source and the entire declared dependency closure. */
 sourcePaths:readonly string[];
}
export interface ImportAssessment {resource:string;status:'fresh'|'stale'|'unverified';reasons:readonly string[]}
/** Untrusted edit detection only. MD5 observations never certify conversion or
 * freshness and are deliberately distinct from SHA256 converter receipts. */
export interface LegacyImportObservation {
 schemaVersion:1;kind:'godotjs-import-cache-observation';resource:string;
 files:readonly {path:string;md5:string|null;bytes:number|null}[];
}
export interface ImportCacheEntry {resource:string;metadata:string;outputs:readonly string[]}
export function inventoryImportCaches(files:ReadonlyMap<string,Uint8Array>):ImportCacheEntry[]{
 const entries:ImportCacheEntry[]=[];
 for(const [metadata,bytes]of files){
  if(!metadata.endsWith('.import'))continue;
  let strings:Readonly<Record<string,string>>={};try{strings=readProjectStringSettings(new TextDecoder('utf-8',{fatal:true}).decode(bytes),'remap');}catch{/* Preserve unreadable metadata, but never establish freshness. */}
  const outputs=Object.entries(strings).filter(([key,value])=>(key==='path'||key.startsWith('path.'))&&value.startsWith('res://')).flatMap(([,value])=>{try{return [resourcePath(value)];}catch{return [];}});
  entries.push({resource:resourcePath(metadata.slice(0,-7)),metadata:resourcePath(metadata),outputs:[...new Set(outputs)].sort()});
 }
 return entries.sort((a,b)=>a.resource<b.resource?-1:a.resource>b.resource?1:0);
}
const observationHash=(path:string,files:ReadonlyMap<string,Uint8Array>)=>{
 const bytes=files.get(path);return bytes?{path,md5:SparkMD5.ArrayBuffer.hash(new Uint8Array(bytes).buffer),bytes:bytes.byteLength}:{path,md5:null,bytes:null};
};
export function createImportCacheObservations(input:Readonly<Record<string,string|readonly number[]|Uint8Array>>|ReadonlyMap<string,Uint8Array>):LegacyImportObservation[]{
 const rows=typeof (input as ReadonlyMap<string,Uint8Array>)[Symbol.iterator]==='function'?[...(input as ReadonlyMap<string,Uint8Array>)]:Object.entries(input);
 const files=new Map(rows.map(([path,value])=>[resourcePath(path),typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value)]));
 return inventoryImportCaches(files).map(entry=>({schemaVersion:1,kind:'godotjs-import-cache-observation',resource:entry.resource,files:[...new Set([entry.resource,entry.metadata,...entry.outputs])].sort().map(path=>observationHash(path,files))}));
}
export function parseImportCacheObservations(value:unknown):LegacyImportObservation[]{
 if(!Array.isArray(value)||value.length>10000)throw new ProjectToolError('E_IMPORT_OBSERVATION','Invalid legacy cache observations');
 const parsed=value.map(raw=>{
  const item=JSON.parse(canonicalJson(raw)) as LegacyImportObservation;
  if(item.schemaVersion!==1||item.kind!=='godotjs-import-cache-observation'||typeof item.resource!=='string'||resourcePath(item.resource)!==item.resource||!Array.isArray(item.files)||item.files.length>10000)throw new ProjectToolError('E_IMPORT_OBSERVATION','Malformed legacy cache observation');
  const paths=new Set<string>();for(const file of item.files){
   if(!file||typeof file.path!=='string'||resourcePath(file.path)!==file.path||paths.has(file.path.toLowerCase())||!(file.md5===null&&file.bytes===null||typeof file.md5==='string'&&/^[a-f0-9]{32}$/.test(file.md5)&&typeof file.bytes==='number'&&Number.isSafeInteger(file.bytes)&&file.bytes>=0))throw new ProjectToolError('E_IMPORT_OBSERVATION','Invalid legacy observation fingerprint');
   paths.add(file.path.toLowerCase());
  }
  if(!paths.has(item.resource.toLowerCase())||!paths.has((item.resource+'.import').toLowerCase()))throw new ProjectToolError('E_IMPORT_OBSERVATION','Legacy observation needs its source and import metadata');
  return item;
 });
 if(new Set(parsed.map(item=>item.resource.toLowerCase())).size!==parsed.length)throw new ProjectToolError('E_IMPORT_OBSERVATION','Duplicate legacy observations');
 return parsed;
}
export function assessLegacyImportCaches(files:ReadonlyMap<string,Uint8Array>,observations:readonly LegacyImportObservation[]=[]):ImportAssessment[]{
 const baseline=parseImportCacheObservations(observations),inventory=inventoryImportCaches(files),byResource=new Map(inventory.map(entry=>[entry.resource,entry]));
 for(const item of baseline)if(!byResource.has(item.resource)&&item.files.some(file=>files.has(file.path)))byResource.set(item.resource,{resource:item.resource,metadata:item.resource+'.import',outputs:[]});
 return [...byResource.values()].map(entry=>{
  const old=baseline.find(item=>item.resource===entry.resource),reasons:string[]=[];
  if(old)for(const file of old.files){const current=observationHash(file.path,files);if(current.md5!==file.md5||current.bytes!==file.bytes)reasons.push(`Observed import input/cache changed: ${file.path}`);}
  return {resource:entry.resource,status:reasons.length?'stale':'unverified',reasons:reasons.length?reasons:['Legacy import cache has no verified producer receipt; observations detect edits only and never establish freshness']};
 });
}
const normalized=(paths:readonly string[])=>[...new Set(paths.map(resourcePath))].sort();
function validProducer(input:Pick<ImportInspection,'converter'|'target'>):void {
 if(typeof input.converter.id!=='string'||!input.converter.id||typeof input.converter.version!=='string'||!input.converter.version||typeof input.target.resourceAbi!=='string'||!input.target.resourceAbi||!input.target.features||Object.values(input.target.features).some(value=>!['string','number','boolean'].includes(typeof value)))throw new ProjectToolError('E_IMPORT_RECEIPT','Converter version, resource ABI and target features are required');
 canonicalJson(input.target);
}
export function parseImportReceipt(value:unknown):ImportReceipt {
 const receipt=JSON.parse(canonicalJson(value)) as ImportReceipt;
 if(receipt?.schemaVersion!==1||receipt.kind!=='godotjs-import-receipt'||typeof receipt.resource!=='string'||resourcePath(receipt.resource)!==receipt.resource||!receipt.converter||!receipt.target||!Array.isArray(receipt.sources)||!Array.isArray(receipt.outputs)||!receipt.outputs.length||!/^[a-f0-9]{64}$/.test(receipt.parameterHash))throw new ProjectToolError('E_IMPORT_RECEIPT','Invalid import receipt');
 validProducer(receipt);
 for(const list of [receipt.sources,receipt.outputs]){
  if(list.some(item=>!item||typeof item.path!=='string'||resourcePath(item.path)!==item.path||!/^[a-f0-9]{64}$/.test(item.sha256))||new Set(list.map(item=>item.path.toLowerCase())).size!==list.length)throw new ProjectToolError('E_IMPORT_RECEIPT','Invalid or colliding receipt file hashes');
 }
 if(!receipt.sources.some(item=>item.path===receipt.resource))throw new ProjectToolError('E_IMPORT_RECEIPT','Receipt primary source is missing');
 return receipt;
}
async function hashes(paths:readonly string[],files:ReadonlyMap<string,Uint8Array>):Promise<ResourceHash[]> {
 return Promise.all(normalized(paths).map(async path=>{
  const bytes=files.get(path);if(!bytes)throw new ProjectToolError('E_IMPORT_RECEIPT',`Missing conversion file ${path}`);
  return {path,sha256:await hashBytes(bytes)};
 }));
}
/** Invoke only after the named converter completed successfully. Existing legacy
 * bytes without a converter run must remain unverified, never blessed by a scan. */
export async function createImportReceipt(input:ImportInspection&{outputFiles:ReadonlyMap<string,Uint8Array>;outputPaths:readonly string[]}):Promise<ImportReceipt>{
 validProducer(input);
 const resource=resourcePath(input.resource),sourcePaths=normalized(input.sourcePaths);
 if(!sourcePaths.includes(resource)||!input.outputPaths.length)throw new ProjectToolError('E_IMPORT_RECEIPT','A successful conversion needs its primary source and nonempty outputs');
 return {schemaVersion:1,kind:'godotjs-import-receipt',resource,...(input.uid?{uid:input.uid}:{}),
  converter:{...input.converter},target:JSON.parse(canonicalJson(input.target)),parameterHash:await hashJson(input.parameters),
  sources:await hashes(sourcePaths,input.files),outputs:await hashes(input.outputPaths,input.outputFiles)};
}
export async function assessImportReceipt(receipt:ImportReceipt|undefined,input:ImportInspection):Promise<ImportAssessment>{
 const resource=resourcePath(input.resource);
 if(!receipt)return {resource,status:'unverified',reasons:['No verified converter receipt is available']};
 try{receipt=parseImportReceipt(receipt);}catch{return {resource,status:'stale',reasons:['Malformed converter receipt']};}
 validProducer(input);
 const reasons:string[]=[];
 if(receipt.schemaVersion!==1||receipt.kind!=='godotjs-import-receipt'||receipt.resource!==resource)reasons.push('Receipt schema/resource differs');
 if(receipt.uid!==input.uid)reasons.push('Resource UID differs');
 if(canonicalJson(receipt.converter)!==canonicalJson(input.converter))reasons.push('Converter version differs');
 if(canonicalJson(receipt.target)!==canonicalJson(input.target))reasons.push('Target resource ABI/features differ');
 if(receipt.parameterHash!==await hashJson(input.parameters))reasons.push('Import parameters differ');
 if(canonicalJson(receipt.sources.map(value=>value.path))!==canonicalJson(normalized(input.sourcePaths)))reasons.push('Source dependency closure differs');
 if(!receipt.sources.some(value=>value.path===resource)||!receipt.outputs.length)reasons.push('Receipt has no primary source or outputs');
 if(new Set(receipt.sources.map(value=>value.path)).size!==receipt.sources.length||new Set(receipt.outputs.map(value=>value.path)).size!==receipt.outputs.length)reasons.push('Receipt contains duplicate records');
 for(const [item,files] of [...receipt.sources.map(item=>[item,input.files] as const),...receipt.outputs.map(item=>[item,input.outputFiles??input.files] as const)]){
  const bytes=files.get(item.path);
  if(!bytes)reasons.push(`Missing file ${item.path}`);
  else if(!/^[a-f0-9]{64}$/.test(item.sha256)||await hashBytes(bytes)!==item.sha256)reasons.push(`Content differs: ${item.path}`);
 }
 return {resource,status:reasons.length?'stale':'fresh',reasons};
}
/** A stored producer assertion is not a registered converter. Its file hashes
 * can disprove reuse, but matching bytes alone can never establish freshness. */
export async function assessStoredImportReceipt(value:unknown,files:ReadonlyMap<string,Uint8Array>,outputFiles:ReadonlyMap<string,Uint8Array>=files):Promise<ImportAssessment>{
 let receipt:ImportReceipt;
 try{receipt=parseImportReceipt(value);}catch{return {resource:'res://unknown-import',status:'stale',reasons:['Malformed stored import receipt']};}
 const reasons:string[]=[];
 for(const [item,current]of [...receipt.sources.map(item=>[item,files] as const),...receipt.outputs.map(item=>[item,outputFiles] as const)]){
  const bytes=current.get(item.path);
  if(!bytes)reasons.push(`Missing file ${item.path}`);
  else if(await hashBytes(bytes)!==item.sha256)reasons.push(`Content differs: ${item.path}`);
 }
 return {resource:receipt.resource,status:reasons.length?'stale':'unverified',reasons:reasons.length?reasons:['File hashes match, but the converter implementation/current recipe is not registered; conversion provenance remains unverified']};
}
export function requireFreshImports(values:readonly ImportAssessment[]):void {
 const stale=values.filter(value=>value.status==='stale');
 if(stale.length)throw new ProjectToolError('E_IMPORT_STALE',stale.map(value=>`${value.resource}: ${value.reasons.join('; ')}; rerun its converter or provide a reimported resource`).join('\n'));
}
