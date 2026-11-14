import {assertReleaseContext,assertSameRelease,type ReleaseContext} from './release-context';
import type {VerifiedRelease,VerifiedAsset} from '../../../scripts/jsb.react-browser/src/verified-loader.js';

const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),value=>value.toString(16).padStart(2,'0')).join('');
/** Verify the preview origin's own mirrored release, independently of the
 * objects supplied by its parent. Origins/paths may differ; content may not. */
export async function verifyPreviewReleaseContext(expected:ReleaseContext,options:{baseUrl?:string;fetch?:typeof fetch;signal?:AbortSignal;release?:VerifiedRelease}={}):Promise<void>{
 assertReleaseContext(expected);
 const root=new URL('./',options.baseUrl??location.href),request=options.fetch??globalThis.fetch;
 const read=async(name:string,optional=false)=>{
  const response=await request(new URL(name,root),{cache:'no-cache',credentials:'same-origin',redirect:'error',signal:options.signal});
  if(optional&&response.status===404)return undefined;
  if(!response.ok)throw Error('E_PREVIEW_RELEASE_HTTP: '+name+' '+response.status);
  const bytes=new Uint8Array(await response.arrayBuffer());
  return {value:JSON.parse(new TextDecoder().decode(bytes)),hash:await digest(bytes)};
 };
 const descriptor=(await read('engine-release.json'))!;
 const actual:ReleaseContext={engineProfile:descriptor.value.runtimeProfile,engineReleaseId:descriptor.value.id,descriptorHash:descriptor.hash,releaseRoot:expected.releaseRoot};
 if(expected.demoDescriptorHash){
  const demo=(await read('demo-release.json'))!;
  actual.demoDescriptorHash=demo.hash;
  if(demo.value.runtimeProfile!==undefined&&demo.value.runtimeProfile!==actual.engineProfile)throw Error('E_PREVIEW_DEMO_PROFILE');
 }
 const site=await read('manifest.json',expected.candidateId===undefined);
 if(site){
  if(site.value.runtimeProfile!==actual.engineProfile||site.value.engineReleaseId!==actual.engineReleaseId)throw Error('E_PREVIEW_SITE_RELEASE');
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
