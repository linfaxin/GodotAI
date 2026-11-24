import {verifyAndDecodeAsset,type StoredAsset,type RawAssetReader} from '@godot-js/engine/release-assets';
import type {ExecutionContract, VerifiedRelease} from '@godot-js/engine/browser/verified-loader';
import {assertNativeReleaseIdentity,assertNativeTypeSnapshot,assertSiteDescriptorIdentity} from '@godot-js/engine/identities';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {assertReleaseContext,assertSameRelease,type ReleaseContext} from './release-context';
export type {ReleaseContext} from './release-context';
export interface ReleaseAsset {path:string;sha256:string;bytes:number;encoding?:'gzip';decodedSha256?:string;decodedBytes?:number;maxDecodedBytes?:number}
export interface EngineRelease {
 schemaVersion:2;runtimeAbi?:VerifiedRelease['runtimeAbi'];runtimeProfile:string;id:string;candidateId?:string;engineId?:string;extensionId?:string;artifactReceiptVersion?:2;
 engine:{javascript:ReleaseAsset;wasm:ReleaseAsset;host?:ReleaseAsset;worklets?:ReleaseAsset[];execution?:ExecutionContract;workerAssets?:Array<ReleaseAsset&{role?:string}>};
 execution?:ExecutionContract;
 api:{ir:ReleaseAsset;typeSnapshot:ReleaseAsset;authoring?:{version:1;runtimeMethod:boolean};declarations?:unknown;hash?:string;bindingVersion?:string;namingProfiles?:Partial<Record<'snake'|'camel',{typeSnapshot:ReleaseAsset}>>};
 sdk:{vendor:ReleaseAsset;vendors?:Partial<Record<'development'|'production',ReleaseAsset>>;runtimeModules:Record<string,ReleaseAsset>};
}
interface ReleaseState {manifest:EngineRelease;context:ReleaseContext;descriptorBytes:Uint8Array;siteBytes?:Uint8Array;demo?:any;site?:any}
let state:Promise<ReleaseState>|undefined;
const cache=new Map<string,Promise<Uint8Array>>();
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),n=>n.toString(16).padStart(2,'0')).join('');
async function descriptor(url:string){
 const response=await fetch(url,{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 if(!response.ok)throw Error('无法加载引擎发布清单，请先构建 Playground');
 const bytes=new Uint8Array(await response.arrayBuffer());
 return {value:JSON.parse(new TextDecoder().decode(bytes)),hash:await digest(bytes),bytes:bytes.length,raw:bytes};
}
async function readState(expected?:ReleaseContext):Promise<ReleaseState>{
 if(expected)assertReleaseContext(expected);
 const url=new URL('engine-release.json',expected?.releaseRoot??new URL('./',location.href));
 const {value:manifest,hash,bytes:descriptorLength,raw:descriptorBytes}=await descriptor(url.href);
 if(typeof manifest.runtimeProfile!=='string')throw Error('E_NATIVE_ENGINE_RELEASE');
 getEngineProfile(manifest.runtimeProfile);
 if(manifest.schemaVersion!==2||typeof manifest.id!=='string'||!manifest.id||!manifest.sdk?.runtimeModules||!manifest.sdk.vendor||!manifest.api?.typeSnapshot||!manifest.engine?.wasm)throw Error('E_NATIVE_ENGINE_RELEASE');
 await assertNativeReleaseIdentity(manifest);
 if(manifest.engine.host){const host=manifest.engine.host,sealed=manifest.payloads?.[host.path];if(!sealed||sealed.sha256!==host.sha256||sealed.bytes!==host.bytes)throw Error('E_NATIVE_HOST_CLOSURE');}
 const context:ReleaseContext={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,descriptorHash:hash,releaseRoot:new URL('./',url).href};
 const demoResponse=await fetch(new URL('demo-release.json',context.releaseRoot),{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 let demo:any;
 if(demoResponse.ok){const bytes=new Uint8Array(await demoResponse.arrayBuffer());const demoHash=await digest(bytes);demo={...JSON.parse(new TextDecoder().decode(bytes)),descriptorHash:demoHash};context.demoDescriptorHash=demoHash;}
 else if(demoResponse.status!==404)throw Error('E_DEMO_RELEASE_HTTP: '+demoResponse.status);
 let site:any,siteBytes:Uint8Array|undefined;
 const siteResponse=await fetch(new URL('manifest.json',context.releaseRoot),{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 if(siteResponse.ok){
  const bytes=new Uint8Array(await siteResponse.arrayBuffer());siteBytes=bytes;site=JSON.parse(new TextDecoder().decode(bytes));
  if(site.runtimeProfile!==context.engineProfile||site.engineReleaseId!==context.engineReleaseId)throw Error('E_SITE_RELEASE_MISMATCH');
  assertSiteDescriptorIdentity(site,{sha256:hash,bytes:descriptorLength},{required:manifest.engineId!==undefined});
  if(site.payloads?.['demo-release.json']&&site.payloads['demo-release.json'].sha256!==context.demoDescriptorHash)throw Error('E_SITE_DEMO_MISMATCH');
  context.candidateId=await digest(bytes);
  if(site.publicAssets===true)context.publicAssets=true;
 }else if(siteResponse.status!==404)throw Error('E_SITE_MANIFEST_HTTP: '+siteResponse.status);
 assertReleaseContext(context);
 if(expected)assertSameRelease(expected,context);
 return {manifest:deepFreeze(manifest),context,descriptorBytes,siteBytes,demo:demo&&deepFreeze(demo),site:site&&deepFreeze(site)};
}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
/** Workers initialize from the editor's context, not their own latest pointer. */
export async function initializeReleaseContext(expected?:ReleaseContext):Promise<ReleaseContext>{
 state??=readState(expected);const loaded=await state;
 if(expected)assertSameRelease(expected,loaded.context);
 return {...loaded.context};
}
export async function loadReleaseContext():Promise<ReleaseContext>{return initializeReleaseContext();}
export async function loadEngineRelease():Promise<EngineRelease>{state??=readState();return (await state).manifest;}
export async function loadRuntimeCandidate():Promise<any>{state??=readState();return (await state).site?.runtime;}
export async function loadReleaseInputs():Promise<{descriptorBytes:Uint8Array;siteManifestBytes?:Uint8Array}>{
 state??=readState();const loaded=await state;
 return {descriptorBytes:loaded.descriptorBytes.slice(),...(loaded.siteBytes?{siteManifestBytes:loaded.siteBytes.slice()}:{})};
}
export async function loadSiteConfiguration():Promise<{runtimeProfile:string;shellOnly:boolean}>{
 const response=await fetch('./shell-profile.json',{cache:'no-cache'});
 if(response.ok){const value=await response.json();if(value.schemaVersion!==2||typeof value.runtimeProfile!=='string')throw Error('E_SITE_PROFILE');getEngineProfile(value.runtimeProfile);return {runtimeProfile:value.runtimeProfile,shellOnly:value.shellOnly===true};}
 const manifest=await loadEngineRelease();return {runtimeProfile:manifest.runtimeProfile,shellOnly:false};
}
const ASSET_LIMIT=64*1024*1024;
function captureAsset(asset:StoredAsset):StoredAsset{
 if(!asset||!/^[-a-zA-Z0-9_./]+$/.test(asset.path)||asset.path.startsWith('/')||asset.path.split('/').includes('..')||!/^([a-f0-9]{64})$/i.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<0||asset.bytes>ASSET_LIMIT)throw Error('E_SDK_ASSET_DESCRIPTOR');
 return Object.freeze({...asset});
}
/** The shared environment adapter receives stored bytes, never decoded cache data. */
export const readReleaseRawAsset:RawAssetReader=async(input,options)=>{
 const asset=captureAsset(input),signal=options.signal,max=Math.min(options.maxStoredBytes,ASSET_LIMIT);
 if(!Number.isSafeInteger(max)||max<=0||asset.bytes>max)throw Error('E_ASSET_SIZE');
 signal?.throwIfAborted();
 const context=await loadReleaseContext();signal?.throwIfAborted();
 const immutable=context.publicAssets===true,url=new URL(asset.path,context.releaseRoot);
 if(immutable&&!/^\/releases\/[A-Za-z0-9_-]{8,}\//.test(url.pathname))throw Error('E_RELEASE_IMMUTABLE_URL');
 const response=await fetch(url,{signal,credentials:immutable?'omit':'same-origin',redirect:'error',cache:immutable?'force-cache':'no-cache'});
 if(!response.ok)throw Error('E_ASSET_HTTP: '+response.status+' '+url.pathname);
 if(Number(response.headers.get('content-length'))>max){void response.body?.cancel().catch(()=>{});throw Error('E_ASSET_SIZE');}
 if(!response.body)throw Error('E_ASSET_BODY');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 const cancel=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();signal?.throwIfAborted();if(done)break;length+=value.byteLength;if(length>max)throw Error('E_ASSET_SIZE');chunks.push(value);}}
 catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 signal?.throwIfAborted();return bytes;
};
/** Public results are copies; demo requests cannot mutate cached decoded bytes. */
export async function fetchReleaseAsset(input:ReleaseAsset):Promise<Uint8Array> {
 const asset=captureAsset(input),context=await loadReleaseContext(),key=context.engineReleaseId+':'+context.descriptorHash+':'+asset.path+':'+asset.sha256+':'+(asset.decodedSha256??'');
 let pending=cache.get(key);
 if(!pending){pending=readReleaseRawAsset(asset,{maxStoredBytes:ASSET_LIMIT}).then(bytes=>verifyAndDecodeAsset(bytes,asset,{maxStoredBytes:ASSET_LIMIT,maxDecodedBytes:ASSET_LIMIT})).then(async bytes=>{
  if(!asset.encoding&&bytes.length!==asset.bytes)throw Error('运行模块长度不匹配：'+asset.path);
  const manifest=await loadEngineRelease();
  const profiles=manifest.api.namingProfiles??{snake:manifest.api};
  for(const [naming,profile]of Object.entries(profiles))if(profile?.typeSnapshot?.path===asset.path)await assertNativeTypeSnapshot(manifest,JSON.parse(new TextDecoder().decode(bytes)),naming);
  return bytes;
 });cache.set(key,pending);pending.catch(()=>cache.delete(key));}
 return (await pending).slice();
}
let demoRelease:Promise<any>|undefined;
async function loadDemoRelease(){return demoRelease??=(async()=>{
 await loadReleaseContext();const loaded=await state!,value=loaded.demo;
 if(!value)throw Error('无法加载示例运行资源，请重新构建 Playground');
 if(value.schemaVersion!==1||(value.demoApiVersion??1)!==1)throw Error('E_DEMO_API_VERSION');
 if(value.runtimeProfile!==undefined&&value.runtimeProfile!==loaded.context.engineProfile)throw Error('E_DEMO_ENGINE_PROFILE');
 if(value.descriptorHash!==loaded.context.demoDescriptorHash)throw Error('E_DEMO_RELEASE_MISMATCH');
 return value;
})();}
export async function loadDemoDeclarations(){return new TextDecoder().decode(await fetchReleaseAsset((await loadDemoRelease()).types));}
export async function loadDemoRuntime(){
 const release=await loadDemoRelease();
 const [runtime,resources]=await Promise.all([fetchReleaseAsset(release.runtime),fetchReleaseAsset(release.resources)]);
 return {runtime,resources,demoApiVersion:release.demoApiVersion??1,demoDescriptorHash:release.descriptorHash};
}
