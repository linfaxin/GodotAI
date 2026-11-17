import {packProject,type PackOptions} from './pck.js';
import {ARTIFACT_SET_INDEX,artifactBytesHash,bootstrapOnlyPath,createArtifactSetIdentity,type ArtifactSet,type ArtifactPack,type ArtifactUnionEntry,type ArtifactUnionIndex} from '@godot-js/engine/artifact-set';
import type {ProjectLaunch} from './build-plan.js';
import {resourcePath} from './paths.js';
import {canonicalJson,hashJson} from './hash.js';
import {byteMap,borrowByteMap,hashOwnedBytes,adoptBytes} from './owned-bytes.js';
import {cachedVerifiedPack,materializeVerifiedPack,type ProjectBuildCache} from './build-cache.js';
export type {ArtifactSet,ArtifactPack,ArtifactUnionIndex} from '@godot-js/engine/artifact-set';
export interface ArtifactSetOptions {target?:Readonly<Record<string,unknown>>;launch?:ProjectLaunch;pack?:PackOptions;groups?:Readonly<Record<string,readonly string[]>>;cache?:ProjectBuildCache}
export async function createArtifactSet(preparedFiles:ReadonlyMap<string,Uint8Array>,options:ArtifactSetOptions={}):Promise<ArtifactSet> {
 const files=new Map<string,Uint8Array>(),seen=new Set<string>();
 for(const [raw,bytes]of borrowByteMap(preparedFiles)){const path=resourcePath(raw),key=path.toLowerCase();if(seen.has(key)||key===ARTIFACT_SET_INDEX)throw Error('E_ARTIFACT_SET: Duplicate or reserved input');if(!(bytes instanceof Uint8Array))throw Error('E_ARTIFACT_SET: Expected owned binary files');seen.add(key);files.set(path,bytes);}
 if(files.size>10000)throw Error('E_ARTIFACT_SET: Union file budget exceeded');
 const packOptions=options.pack&&JSON.parse(canonicalJson(options.pack)),cache=options.cache;
 const packEntries=async(entries:ReadonlyMap<string,Uint8Array>)=>{
  const members=await Promise.all([...entries].sort(([a],[b])=>a<b?-1:a>b?1:0).map(async([path,bytes])=>({path,sha256:await hashOwnedBytes(bytes)})));
  const key=await hashJson({kind:'godotjs-artifact-resource-pack-v1',members,options:packOptions??{}});
  return cachedVerifiedPack(cache,key,()=>packProject(byteMap(entries),packOptions));
 };
 const target=JSON.parse(canonicalJson(options.target??{})),launch=options.launch&&JSON.parse(canonicalJson(options.launch));
 if(!target||typeof target!=='object'||Array.isArray(target))throw Error('E_ARTIFACT_SET: Invalid target');
 const bootstrap=new Map<string,Uint8Array>(),groups=new Map<string,Map<string,Uint8Array>>(),assigned=new Set<string>();
 const assign=(group:string,path:string)=>{const bytes=files.get(path);if(!bytes||assigned.has(path)||bootstrapOnlyPath(path))throw Error('E_ARTIFACT_SET: Invalid resource group assignment');assigned.add(path);let entries=groups.get(group);if(!entries){entries=new Map();groups.set(group,entries);}entries.set(path,bytes);};
 for(const [group,paths]of Object.entries(options.groups??{})){if(!group||!Array.isArray(paths))throw Error('E_ARTIFACT_SET: Invalid group');for(const path of paths)assign(group,resourcePath(path));}
 for(const [path,bytes]of files){if(assigned.has(path))continue;if(bootstrapOnlyPath(path)||/\.(?:[cm]?[jt]sx?|json|uid)$/i.test(path))bootstrap.set(path,bytes);else assign('resources',path);}
 if(groups.size>128)throw Error('E_ARTIFACT_SET: Resource package budget exceeded');
 const packs=new Map<string,Uint8Array>(),resources:ArtifactPack[]=[],unionEntries:ArtifactUnionEntry[]=[];let totalBytes=0;
 const addPack=(descriptor:Awaited<ReturnType<typeof packEntries>>)=>{
  if(descriptor.byteLength>256*1024*1024||(totalBytes+=descriptor.byteLength)>512*1024*1024||packs.has(descriptor.sha256))throw Error('E_ARTIFACT_SET: Package closure/size budget exceeded');
  packs.set(descriptor.sha256,materializeVerifiedPack(descriptor,cache));
 };
 for(const [,entries]of [...groups].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  if(!entries.size)continue;const descriptor=await packEntries(entries),sha256=descriptor.sha256;
  resources.push({path:`packs/${sha256}.pck`,sha256,bytes:descriptor.byteLength});addPack(descriptor);
  for(const entry of descriptor.entries)unionEntries.push({path:entry.path,source:sha256,bytes:entry.bytes,md5:entry.md5});
 }
 for(const entry of (await packEntries(bootstrap)).entries)unionEntries.push({path:entry.path,source:'bootstrap',bytes:entry.bytes,md5:entry.md5});
 unionEntries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const union:ArtifactUnionIndex={schemaVersion:1,resources,files:unionEntries,target,...(launch?{launch}:{})},indexBytes=adoptBytes(new TextEncoder().encode(canonicalJson(union)));
 if(indexBytes.length>8*1024*1024)throw Error('E_ARTIFACT_SET: Union index budget exceeded');bootstrap.set(ARTIFACT_SET_INDEX,indexBytes);
 const descriptor=await packEntries(bootstrap),sha256=descriptor.sha256;addPack(descriptor);
 const identity={schemaVersion:1 as const,bootstrap:{path:'application.pck',sha256,bytes:descriptor.byteLength},resources,unionIndexSha256:await artifactBytesHash(indexBytes),target,...(launch?{launch}:{})};
 // All members were captured before the first await; cached descriptors retain
 // private verified bytes. The global namespace was partitioned exactly once.
 // Only external runtime admission revalidates the complete untrusted closure.
 return {schemaVersion:1,manifest:{...identity,artifactSetId:await createArtifactSetIdentity(identity)},packs};
}
