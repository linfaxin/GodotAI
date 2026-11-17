import {assertReleaseContext,assertSameRelease,assertArtifactTarget,type ReleaseContext} from './release-context';
import {assertNativeReleaseIdentity,assertSiteDescriptorIdentity,assertArtifactReceipt} from '@godot-js/engine/identities';
import type {VerifiedRelease,VerifiedAsset} from '@godot-js/engine/browser/verified-loader';
import {assertArtifactSet,type ArtifactSet} from '@godot-js/engine/artifact-set';

const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),value=>value.toString(16).padStart(2,'0')).join('');
/** Verify the preview origin's own mirrored release, independently of the
 * objects supplied by its parent. Origins/paths may differ; content may not. */
export async function verifyPreviewReleaseContext(expected:ReleaseContext,options:{baseUrl?:string;fetch?:typeof fetch;signal?:AbortSignal;artifactManifest?:unknown;artifactPack?:Uint8Array;artifactSet?:ArtifactSet;artifactBuildKey?:string;artifactId?:string;allowLegacyArtifacts?:boolean;release?:VerifiedRelease}={}):Promise<void>{
 assertReleaseContext(expected);
 const root=new URL('./',options.baseUrl??location.href),request=options.fetch??globalThis.fetch;
 const read=async(name:string,optional=false)=>{
  const response=await request(new URL(name,root),{cache:'no-cache',credentials:'same-origin',redirect:'error',signal:options.signal});
  if(optional&&response.status===404)return undefined;
  if(!response.ok)throw Error('E_PREVIEW_RELEASE_HTTP: '+name+' '+response.status);
  const bytes=new Uint8Array(await response.arrayBuffer());
  return {value:JSON.parse(new TextDecoder().decode(bytes)),hash:await digest(bytes),bytes:bytes.length};
 };
 const descriptor=(await read('engine-release.json'))!;
 if(options.artifactManifest!==undefined)assertArtifactTarget(descriptor.value,options.artifactManifest);
 await assertNativeReleaseIdentity(descriptor.value);
 if(options.artifactManifest!==undefined){
  const artifact=options.artifactManifest as {artifactReceipt?:unknown;artifactId?:string;buildKey?:string};
  if(options.artifactId!==undefined&&artifact.artifactId!==undefined&&options.artifactId!==artifact.artifactId)throw Error('E_ARTIFACT_IDENTITY');
  if(options.artifactBuildKey!==undefined&&artifact.buildKey!==undefined&&options.artifactBuildKey!==artifact.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
  if(options.artifactSet){
   const set=await assertArtifactSet(options.artifactSet);
   if((descriptor.value.execution??descriptor.value.engine?.execution)?.artifactSetAbi!==1)throw Error('E_ARTIFACT_SET_ABI');
   if(set.manifest.target.engineReleaseId!==descriptor.value.id||set.manifest.target.engineProfile!==descriptor.value.runtimeProfile)throw Error('E_ARTIFACT_RELEASE_MISMATCH');
   assertArtifactTarget(descriptor.value,set.manifest.target);
   if((options.artifactId??artifact.artifactId)!==set.manifest.artifactSetId)throw Error('E_ARTIFACT_IDENTITY');
  }else await assertArtifactReceipt(artifact.artifactReceipt,{pack:options.artifactPack,buildKey:options.artifactBuildKey??artifact.buildKey,artifactId:options.artifactId??artifact.artifactId,allowLegacy:options.allowLegacyArtifacts===true&&descriptor.value.artifactReceiptVersion!==2});
 }
 const host=descriptor.value.engine?.host;
 if(host){
  const sealed=descriptor.value.payloads?.[host.path];
  if(host.path!=='preview.js'||typeof host.sha256!=='string'||!/^[a-f0-9]{64}$/.test(host.sha256)||!Number.isSafeInteger(host.bytes)||host.bytes<=0||!sealed||sealed.sha256!==host.sha256||sealed.bytes!==host.bytes)throw Error('E_PREVIEW_HOST_CLOSURE');
  const response=await request(new URL(host.path,root),{cache:'no-cache',credentials:'same-origin',redirect:'error',signal:options.signal});
  if(!response.ok)throw Error('E_PREVIEW_HOST_HTTP');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length!==host.bytes||await digest(bytes)!==host.sha256)throw Error('E_PREVIEW_HOST_HASH');
  if(typeof document!=='undefined'){
   const script=[...document.querySelectorAll<HTMLScriptElement>('script[src]')].find(item=>new URL(item.src,root).href===new URL(host.path,root).href);
   const integrity='sha256-'+btoa(String.fromCharCode(...Uint8Array.from((host.sha256 as string).match(/../g)!,value=>parseInt(value,16))));
   if(!script||script.integrity!==integrity)throw Error('E_PREVIEW_HOST_INTEGRITY');
  }
 }
 const actual:ReleaseContext={engineProfile:descriptor.value.runtimeProfile,engineReleaseId:descriptor.value.id,descriptorHash:descriptor.hash,releaseRoot:expected.releaseRoot};
 if(expected.demoDescriptorHash){
  const demo=(await read('demo-release.json'))!;
  actual.demoDescriptorHash=demo.hash;
  if(demo.value.runtimeProfile!==undefined&&demo.value.runtimeProfile!==actual.engineProfile)throw Error('E_PREVIEW_DEMO_PROFILE');
 }
 const site=await read('manifest.json',expected.candidateId===undefined);
 if(site){
  if(site.value.runtimeProfile!==actual.engineProfile||site.value.engineReleaseId!==actual.engineReleaseId)throw Error('E_PREVIEW_SITE_RELEASE');
  assertSiteDescriptorIdentity(site.value,{sha256:descriptor.hash,bytes:descriptor.bytes},{required:descriptor.value.engineId!==undefined});
  if(site.value.payloads?.['demo-release.json']&&site.value.payloads['demo-release.json'].sha256!==actual.demoDescriptorHash)throw Error('E_PREVIEW_SITE_DEMO');
  actual.candidateId=site.hash;
  if(site.value.publicAssets===true)actual.publicAssets=true;
 }
 if(descriptor.value.schemaVersion!==2)throw Error('E_PREVIEW_RELEASE_SCHEMA');
 assertSameRelease(expected,actual);
 if(options.release){
  const release=options.release;
  const sameAsset=(supplied:VerifiedAsset|undefined,declared:any,path?:string)=>{
   if(!supplied||!declared)throw Error('E_PREVIEW_RUNTIME_ASSET');
   const url=new URL(path??declared.path,root);
   if(new URL(supplied.url,root).href!==url.href||supplied.sha256!==declared.sha256||supplied.encoding!==declared.encoding||supplied.decodedSha256!==declared.decodedSha256||supplied.decodedBytes!==declared.decodedBytes)throw Error('E_PREVIEW_RUNTIME_ASSET');
  };
  if(JSON.stringify(release.runtimeAbi)!==JSON.stringify(descriptor.value.runtimeAbi)||JSON.stringify(release.runtimeAbi)!==JSON.stringify(site?.value.runtime?.abi))throw Error('E_PREVIEW_RUNTIME_ABI');
  if(site?.value.schemaVersion!==3||site.value.runtime?.executionBackend!=='worker')throw Error('E_PREVIEW_RUNTIME_CANDIDATE');
  sameAsset(release.engineJs,descriptor.value.engine.javascript);sameAsset(release.engineWasm,descriptor.value.engine.wasm);
  const runtime=site.value.runtime;
  sameAsset(release.runtimeWorker,runtime.assets?.[runtime.entry],runtime.entry);
  sameAsset(release.runtimeAudioWorklet,runtime.assets?.[runtime.audioWorklet],runtime.audioWorklet);
  if(release.worklets?.length!==(descriptor.value.engine.worklets??[]).length)throw Error('E_PREVIEW_RUNTIME_ASSET');
  for(let index=0;index<(release.worklets?.length??0);index++)sameAsset(release.worklets![index],descriptor.value.engine.worklets[index]);
 }
}
