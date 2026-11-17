import {canonicalIdentityJson} from './identities.js';
import {readPckIndex,type PckIndexEntry} from './pck-index.js';

export const ARTIFACT_SET_INDEX='res://.godotjs/artifact-set-index.json';
export interface ArtifactPack {readonly path:string;readonly sha256:string;readonly bytes:number}
export interface ArtifactUnionEntry {readonly path:string;readonly source:'bootstrap'|string;readonly bytes:number;readonly md5:string}
export interface ArtifactUnionIndex {readonly schemaVersion:1;readonly resources:readonly ArtifactPack[];readonly files:readonly ArtifactUnionEntry[];readonly target:Readonly<Record<string,unknown>>;readonly launch?:unknown}
export interface ArtifactSetManifest {readonly schemaVersion:1;readonly bootstrap:ArtifactPack;readonly resources:readonly ArtifactPack[];readonly unionIndexSha256:string;readonly target:Readonly<Record<string,unknown>>;readonly launch?:unknown;readonly artifactSetId:string}
export interface ArtifactSet {readonly schemaVersion:1;readonly manifest:ArtifactSetManifest;readonly packs:ReadonlyMap<string,Uint8Array>}
const digest=/^[a-f0-9]{64}$/;
const reject=(text:string):never=>{throw Error('E_ARTIFACT_SET: '+text);};
export async function artifactBytesHash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),n=>n.toString(16).padStart(2,'0')).join('');}
export async function createArtifactSetIdentity(input:Omit<ArtifactSetManifest,'artifactSetId'>):Promise<string>{return artifactBytesHash(new TextEncoder().encode(canonicalIdentityJson({kind:'godotjs-artifact-set-v1',inputs:input})));}
/** Aggregate engine/import metadata is produced once by the bootstrap. Resource
 * packs cannot replace it, even when their advertised output list omits it. */
export function bootstrapOnlyPath(path:string):boolean {
 const name=path.toLowerCase();
 return ['res://project.godot','res://project.binary','res://override.cfg','res://.godot/uid_cache.bin','res://.godot/global_script_class_cache.cfg'].includes(name)
  ||name.startsWith('res://.godotjs/')||name.startsWith('res://.playground/')
  ||name.startsWith('res://.godot/')&&!name.startsWith('res://.godot/imported/')&&!name.startsWith('res://.godot/exported/')||name.endsWith('/global_script_class_cache.cfg');
}
function packDescriptor(value:unknown,bootstrap=false):asserts value is ArtifactPack {
 const v=value as ArtifactPack;if(!v||typeof v!=='object'||!digest.test(v.sha256)||!Number.isSafeInteger(v.bytes)||v.bytes<108||v.bytes>256*1024*1024
  ||v.path!==(bootstrap?'application.pck':`packs/${v.sha256}.pck`))reject('Invalid pack descriptor');
}
export function artifactSetTransfers(value:ArtifactSet):ArrayBuffer[]{return [...value.packs.values()].map(bytes=>bytes.buffer as ArrayBuffer);}
/** Copies before the first await. Public byte views never become trusted cache
 * storage or transfer ownership out of the caller's artifact. */
export async function assertArtifactSet(value:unknown):Promise<ArtifactSet> {
 const input=value as ArtifactSet;if(!input||input.schemaVersion!==1||!(input.packs instanceof Map))return reject('Invalid set envelope');
 let manifest:ArtifactSetManifest;try{manifest=JSON.parse(canonicalIdentityJson(input.manifest));}catch{return reject('Invalid manifest JSON');}
 if(manifest.schemaVersion!==1||!manifest.target||typeof manifest.target!=='object'||Array.isArray(manifest.target)||!Array.isArray(manifest.resources)||manifest.resources.length>128||!digest.test(manifest.unionIndexSha256)||!digest.test(manifest.artifactSetId))return reject('Invalid manifest');
 packDescriptor(manifest.bootstrap,true);for(const pack of manifest.resources)packDescriptor(pack);
 const descriptors=[manifest.bootstrap,...manifest.resources],packs=new Map<string,Uint8Array>();let total=0;
 if(new Set(descriptors.map(pack=>pack.sha256)).size!==descriptors.length||input.packs.size!==descriptors.length)return reject('Duplicate or missing packs');
 for(const descriptor of descriptors){const bytes=input.packs.get(descriptor.sha256);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==descriptor.bytes||(total+=bytes.length)>512*1024*1024)return reject('Pack closure/size differs');packs.set(descriptor.sha256,new Uint8Array(bytes));}
 const {artifactSetId,...identity}=manifest;if(await createArtifactSetIdentity(identity)!==artifactSetId)return reject('Set identity differs');
 const directories=new Map<string,readonly PckIndexEntry[]>();
 for(const pack of descriptors){const bytes=packs.get(pack.sha256)!;if(await artifactBytesHash(bytes)!==pack.sha256)return reject('Pack bytes differ');directories.set(pack.sha256,readPckIndex(bytes).entries);}
 const bootstrap=packs.get(manifest.bootstrap.sha256)!,bootstrapEntries=directories.get(manifest.bootstrap.sha256)!;
 const indexEntry=bootstrapEntries.find(entry=>entry.path===ARTIFACT_SET_INDEX);if(!indexEntry||indexEntry.bytes>8*1024*1024)return reject('Missing or oversized bootstrap union index');
 const indexBytes=bootstrap.subarray(indexEntry.offset,indexEntry.offset+indexEntry.bytes);if(await artifactBytesHash(indexBytes)!==manifest.unionIndexSha256)return reject('Union index identity differs');
 let union:ArtifactUnionIndex;try{union=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(indexBytes));}catch{return reject('Invalid union index JSON');}
 if(union.schemaVersion!==1||!Array.isArray(union.files)||union.files.length>10000||canonicalIdentityJson(union.resources)!==canonicalIdentityJson(manifest.resources)||canonicalIdentityJson(union.target)!==canonicalIdentityJson(manifest.target)||canonicalIdentityJson(union.launch??null)!==canonicalIdentityJson(manifest.launch??null))return reject('Union context differs');
 const actual=new Map<string,ArtifactUnionEntry>();
 for(const pack of descriptors)for(const entry of directories.get(pack.sha256)!){
  if(entry.path===ARTIFACT_SET_INDEX){if(pack!==manifest.bootstrap)return reject('Resource pack contains union index');continue;}
  if(pack!==manifest.bootstrap&&bootstrapOnlyPath(entry.path))return reject('Resource pack contains global metadata');
  const key=entry.path.toLowerCase();if(actual.has(key))return reject('Packs overlap or case-collide');
  actual.set(key,{path:entry.path,source:pack===manifest.bootstrap?'bootstrap':pack.sha256,bytes:entry.bytes,md5:entry.md5});
 }
 if(actual.size!==union.files.length)return reject('Union does not describe the actual directories');
 const seen=new Set<string>();for(const entry of union.files){if(!entry||typeof entry.path!=='string')return reject('Malformed union entry');const key=entry.path.toLowerCase();if(seen.has(key)||canonicalIdentityJson(actual.get(key)??null)!==canonicalIdentityJson(entry))return reject('Union entry differs from actual directory');seen.add(key);}
 // The returned value is a captured run input. Consumers transfer these owned
 // buffers exactly once; they never transfer compiler/cache-owned buffers.
 return {schemaVersion:1,manifest,packs};
}
