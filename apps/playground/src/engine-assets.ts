import {fetchVerifiedAsset} from '@godot-js/react-browser/verified-loader';
export interface ReleaseAsset {path:string;sha256:string;bytes:number;encoding?:'gzip';decodedSha256?:string;decodedBytes?:number;maxDecodedBytes?:number}
export interface EngineRelease {
 schemaVersion:2;runtimeProfile:'full-engine-v1';id:string;
 engine:{javascript:ReleaseAsset;wasm:ReleaseAsset;worklets?:ReleaseAsset[]};
 api:{ir:ReleaseAsset;typeSnapshot:ReleaseAsset;declarations?:unknown;hash?:string;namingProfiles?:Partial<Record<'snake'|'camel',{typeSnapshot:ReleaseAsset}>>};
 sdk:{vendor:ReleaseAsset;vendors?:Partial<Record<'development'|'production',ReleaseAsset>>;runtimeModules:Record<string,ReleaseAsset>};
}
const cache=new Map<string,Promise<Uint8Array>>();
/** Copy every public result; a compiler request cannot mutate a cached SDK. */
export async function fetchReleaseAsset(asset:ReleaseAsset):Promise<Uint8Array> {
 if(!asset||!/^[-a-zA-Z0-9_./]+$/.test(asset.path)||asset.path.startsWith('/')||asset.path.split('/').includes('..')||!/^([a-f0-9]{64})$/i.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<0||asset.bytes>64*1024*1024)throw Error('E_SDK_ASSET_DESCRIPTOR');
 const key=asset.path+':'+asset.sha256+':'+(asset.decodedSha256??'');
 let pending=cache.get(key);
 if(!pending){pending=fetchVerifiedAsset({...asset,url:new URL(asset.path,location.href).href},{maxBytes:64*1024*1024,maxDecodedBytes:64*1024*1024}).then(bytes=>{if(!asset.encoding&&bytes.length!==asset.bytes)throw Error('运行模块长度不匹配：'+asset.path);return bytes;});cache.set(key,pending);pending.catch(()=>cache.delete(key));}
 return (await pending).slice();
}
let release:Promise<EngineRelease>|undefined;
export function loadEngineRelease():Promise<EngineRelease> {
 return release??=(async()=>{const response=await fetch('./engine-release.json');if(!response.ok)throw Error('无法加载全量引擎 SDK，请重新构建 Playground');const value=await response.json();if(value.schemaVersion!==2||value.runtimeProfile!=='full-engine-v1'||!value.sdk?.runtimeModules||!value.sdk.vendor)throw Error('E_FULL_ENGINE_RELEASE');return value;})();
}
export async function loadReactModules(mode:'development'|'production') {
 const manifest=await loadEngineRelease();
 const [vendor,rows]=await Promise.all([fetchReleaseAsset(manifest.sdk.vendors?.[mode]??manifest.sdk.vendor),Promise.all(Object.entries(manifest.sdk.runtimeModules).map(async([name,asset])=>[name,await fetchReleaseAsset(asset)] as const))]);
 return {vendor,runtimeModules:Object.fromEntries(rows),releaseId:manifest.id};
}
let demoRelease:Promise<any>|undefined;
async function loadDemoRelease(){return demoRelease??=(async()=>{
 const response=await fetch('./demo-release.json');if(!response.ok)throw Error('无法加载示例运行资源，请重新构建 Playground');
 const release=await response.json();if(release.schemaVersion!==1)throw Error('示例运行资源版本无效');
 return release;
})();}
export async function loadDemoDeclarations(){return new TextDecoder().decode(await fetchReleaseAsset((await loadDemoRelease()).types));}
export async function loadDemoRuntime(){
 const release=await loadDemoRelease();
 const [runtime,resources]=await Promise.all([fetchReleaseAsset(release.runtime),fetchReleaseAsset(release.resources)]);
 return {runtime,resources};
}
