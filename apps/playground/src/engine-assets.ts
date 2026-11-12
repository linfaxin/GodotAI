import {fetchVerifiedAsset} from '@godot-js/react-browser/verified-loader';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {assertReleaseContext,assertSameRelease,type ReleaseContext} from './release-context';
export type {ReleaseContext} from './release-context';
export interface ReleaseAsset {path:string;sha256:string;bytes:number;encoding?:'gzip';decodedSha256?:string;decodedBytes?:number;maxDecodedBytes?:number}
export interface EngineRelease {
 schemaVersion:2;runtimeProfile:string;id:string;candidateId?:string;
 engine:{javascript:ReleaseAsset;wasm:ReleaseAsset;worklets?:ReleaseAsset[]};
 api:{ir:ReleaseAsset;typeSnapshot:ReleaseAsset;declarations?:unknown;hash?:string;namingProfiles?:Partial<Record<'snake'|'camel',{typeSnapshot:ReleaseAsset}>>};
 sdk:{vendor:ReleaseAsset;vendors?:Partial<Record<'development'|'production',ReleaseAsset>>;runtimeModules:Record<string,ReleaseAsset>};
}
interface ReleaseState {manifest:EngineRelease;context:ReleaseContext;demo?:any}
let state:Promise<ReleaseState>|undefined;
const cache=new Map<string,Promise<Uint8Array>>();
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),n=>n.toString(16).padStart(2,'0')).join('');
async function descriptor(url:string){
 const response=await fetch(url,{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 if(!response.ok)throw Error('无法加载引擎发布清单，请先构建 Playground');
 const bytes=new Uint8Array(await response.arrayBuffer());
 return {value:JSON.parse(new TextDecoder().decode(bytes)),hash:await digest(bytes)};
}
async function readState(expected?:ReleaseContext):Promise<ReleaseState>{
 if(expected)assertReleaseContext(expected);
 const url=new URL('engine-release.json',expected?.releaseRoot??new URL('./',location.href));
 const {value:manifest,hash}=await descriptor(url.href);
 if(typeof manifest.runtimeProfile!=='string')throw Error('E_NATIVE_ENGINE_RELEASE');
 getEngineProfile(manifest.runtimeProfile);
 if(manifest.schemaVersion!==2||typeof manifest.id!=='string'||!manifest.id||!manifest.sdk?.runtimeModules||!manifest.sdk.vendor||!manifest.api?.typeSnapshot||!manifest.engine?.wasm)throw Error('E_NATIVE_ENGINE_RELEASE');
 const context:ReleaseContext={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,descriptorHash:hash,releaseRoot:new URL('./',url).href};
 const demoResponse=await fetch(new URL('demo-release.json',context.releaseRoot),{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 let demo:any;
 if(demoResponse.ok){const bytes=new Uint8Array(await demoResponse.arrayBuffer());const demoHash=await digest(bytes);demo={...JSON.parse(new TextDecoder().decode(bytes)),descriptorHash:demoHash};context.demoDescriptorHash=demoHash;}
 else if(demoResponse.status!==404)throw Error('E_DEMO_RELEASE_HTTP: '+demoResponse.status);
 const siteResponse=await fetch(new URL('manifest.json',context.releaseRoot),{cache:'no-cache',credentials:'same-origin',redirect:'error'});
 if(siteResponse.ok){
  const bytes=new Uint8Array(await siteResponse.arrayBuffer()),site=JSON.parse(new TextDecoder().decode(bytes));
  if(site.runtimeProfile!==context.engineProfile||site.engineReleaseId!==context.engineReleaseId)throw Error('E_SITE_RELEASE_MISMATCH');
  if(site.payloads?.['demo-release.json']&&site.payloads['demo-release.json'].sha256!==context.demoDescriptorHash)throw Error('E_SITE_DEMO_MISMATCH');
  context.candidateId=await digest(bytes);
  if(site.publicAssets===true)context.publicAssets=true;
 }else if(siteResponse.status!==404)throw Error('E_SITE_MANIFEST_HTTP: '+siteResponse.status);
 assertReleaseContext(context);
 if(expected)assertSameRelease(expected,context);
 return {manifest,context,demo};
}
/** Workers initialize from the editor's context, not their own latest pointer. */
export async function initializeReleaseContext(expected?:ReleaseContext):Promise<ReleaseContext>{
 state??=readState(expected);const loaded=await state;
 if(expected)assertSameRelease(expected,loaded.context);
 return {...loaded.context};
}
export async function loadReleaseContext():Promise<ReleaseContext>{return initializeReleaseContext();}
export async function loadEngineRelease():Promise<EngineRelease>{state??=readState();return (await state).manifest;}
export async function loadSiteConfiguration():Promise<{runtimeProfile:string;shellOnly:boolean}>{
 const response=await fetch('./shell-profile.json',{cache:'no-cache'});
 if(response.ok){const value=await response.json();if(value.schemaVersion!==2||typeof value.runtimeProfile!=='string')throw Error('E_SITE_PROFILE');getEngineProfile(value.runtimeProfile);return {runtimeProfile:value.runtimeProfile,shellOnly:value.shellOnly===true};}
 const manifest=await loadEngineRelease();return {runtimeProfile:manifest.runtimeProfile,shellOnly:false};
}
/** Public results are copies; compiler requests cannot mutate cached SDK bytes. */
export async function fetchReleaseAsset(asset:ReleaseAsset):Promise<Uint8Array> {
 if(!asset||!/^[-a-zA-Z0-9_./]+$/.test(asset.path)||asset.path.startsWith('/')||asset.path.split('/').includes('..')||!/^([a-f0-9]{64})$/i.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<0||asset.bytes>64*1024*1024)throw Error('E_SDK_ASSET_DESCRIPTOR');
 const context=await loadReleaseContext(),key=context.engineReleaseId+':'+context.descriptorHash+':'+asset.path+':'+asset.sha256+':'+(asset.decodedSha256??'');
 let pending=cache.get(key);
 if(!pending){pending=fetchVerifiedAsset({...asset,url:new URL(asset.path,context.releaseRoot).href},{maxBytes:64*1024*1024,maxDecodedBytes:64*1024*1024,cachePolicy:context.publicAssets?'public-immutable':'revalidate'}).then(bytes=>{if(!asset.encoding&&bytes.length!==asset.bytes)throw Error('运行模块长度不匹配：'+asset.path);return bytes;});cache.set(key,pending);pending.catch(()=>cache.delete(key));}
 return (await pending).slice();
}
export async function loadReactModules(mode:'development'|'production') {
 const manifest=await loadEngineRelease();
 const [vendor,rows]=await Promise.all([fetchReleaseAsset(manifest.sdk.vendors?.[mode]??manifest.sdk.vendor),Promise.all(Object.entries(manifest.sdk.runtimeModules).map(async([name,asset])=>[name,await fetchReleaseAsset(asset)] as const))]);
 return {vendor,runtimeModules:Object.fromEntries(rows),releaseId:manifest.id};
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
