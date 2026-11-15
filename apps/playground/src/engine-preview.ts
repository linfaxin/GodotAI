import {PreviewRunner} from '@godot-js/engine/browser/runner';
import type {RunnerEvent} from '@godot-js/engine/browser/protocol';
import type {VerifiedRelease} from '@godot-js/engine/browser/verified-loader';
import {loadEngineRelease,loadReleaseContext,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease,assertArtifactTarget} from './release-context';
import {assertArtifactReceipt} from '@godot-js/engine/identities';

/** A fresh cross-origin preview consumes the editor's pinned release tuple. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void,options:{allowLegacyArtifacts?:boolean}={}) {
 const manifest=await loadEngineRelease(),context=await loadReleaseContext();
 let configured:string|undefined;
 const config=await fetch('./preview-config.json',{cache:'no-cache'});
 if(config.ok){const value=await config.json();configured=value.previewOrigin;}
 const override=new URL(location.href).searchParams.get('previewOrigin');
 if(override)configured=override;
 if(!configured&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
  const local=new URL(context.releaseRoot);local.hostname=location.hostname==='localhost'?'127.0.0.1':'localhost';configured=local.href;
 }
 if(!configured)throw Error('请在 preview-config.json 配置独立的预览站点 previewOrigin');
 const previewRoot=new URL(configured.replace(/\/$/,'')+'/');
 if(previewRoot.pathname==='/')previewRoot.pathname=new URL(context.releaseRoot).pathname;
 const preview=new URL('preview.html',previewRoot);
 if(preview.origin===location.origin)throw Error('预览站点须使用独立域名或端口');
 const resolve=(asset:any)=>({...asset,url:new URL(asset.url??asset.path,previewRoot).href,sha256:asset.sha256});
 const release:VerifiedRelease&{releaseContext:ReleaseContext}={
  releaseId:manifest.id,profile:manifest.runtimeProfile,releaseContext:context,
  engineJs:resolve(manifest.engine.javascript),engineWasm:resolve(manifest.engine.wasm),
  worklets:(manifest.engine.worklets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1).replace(/\.gz$/,'')})),
  execution:manifest.execution??manifest.engine.execution,
  artifactReceiptVersion:manifest.artifactReceiptVersion,
  workerAssets:(manifest.engine.workerAssets??(manifest.execution??manifest.engine.execution)?.workerAssets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1).replace(/\.gz$/,''),role:asset.role})),
  allowedOrigins:[preview.origin],
  cachePolicy:context.publicAssets?'public-immutable':'revalidate',
 };
 const allowLegacyArtifacts=options.allowLegacyArtifacts===true&&manifest.artifactReceiptVersion!==2;
 const runner=new PreviewRunner({container,previewUrl:preview.href,release,allowLegacyArtifacts,deadlines:{initializing:120_000,starting:60_000,downloading:120_000}});
 runner.subscribe(listener);
 return {manifest,context,runner,async run(pack:Uint8Array,revision:number,details:unknown){
  assertCompiledRelease(context,details);
  assertArtifactTarget(manifest,details);
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',pack.slice().buffer));
  const packSha256=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  const compiled=details as {buildKey?:unknown;generation?:unknown;packSha256?:unknown;artifactId?:string;artifactReceipt?:{buildKey?:unknown;packSha256?:unknown}};
  if(compiled.packSha256!==undefined&&compiled.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
  if(compiled.artifactReceipt!==undefined){
   if(!compiled.artifactReceipt||compiled.artifactReceipt.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
   if(compiled.artifactReceipt.buildKey!==compiled.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
  }
  const buildKey=typeof compiled.buildKey==='string'&&/^[a-f0-9]{64}$/i.test(compiled.buildKey)?compiled.buildKey:packSha256;
  const receipt=await assertArtifactReceipt(compiled.artifactReceipt,{pack,buildKey,artifactId:compiled.artifactId,allowLegacy:allowLegacyArtifacts});
  const generation=compiled.generation??crypto.randomUUID();
  if(!(typeof generation==='string'&&generation.length>0&&generation.length<=256)&&!(typeof generation==='number'&&Number.isSafeInteger(generation)&&generation>=0))throw Error('E_ARTIFACT_GENERATION');
  // Preserve the compiler's actual release identity; never replace it with the
  // preview's current release ID during rolling updates.
  return runner.run({revision,buildKey,generation,packSha256,artifactId:receipt?.artifactId,pack,manifest:{...(details as object),generation}});
 },stop:()=>runner.stop(),dispose:()=>runner.dispose()};
}
