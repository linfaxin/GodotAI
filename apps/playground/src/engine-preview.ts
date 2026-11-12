import {PreviewRunner} from '@godot-js/react-browser/runner';
import type {RunnerEvent} from '@godot-js/react-browser/protocol';
import type {VerifiedRelease} from '@godot-js/react-browser/verified-loader';
import {loadEngineRelease,loadReleaseContext,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease} from './release-context';

/** A fresh cross-origin preview consumes the editor's pinned release tuple. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void) {
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
  worklets:(manifest.engine.worklets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1)})),
  allowedOrigins:[preview.origin],
  cachePolicy:context.publicAssets?'public-immutable':'revalidate',
 };
 const runner=new PreviewRunner({container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000}});
 runner.subscribe(listener);
 return {manifest,context,runner,async run(pack:Uint8Array,revision:number,details:unknown){
  assertCompiledRelease(context,details);
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',pack.slice().buffer));
  const buildKey=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  const generation=crypto.randomUUID();
  // Preserve the compiler's actual release identity; never replace it with the
  // preview's current release ID during rolling updates.
  return runner.run({revision,buildKey,generation,pack,manifest:{...(details as object),generation}});
 },stop:()=>runner.stop(),dispose:()=>runner.dispose()};
}
