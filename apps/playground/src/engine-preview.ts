import {PreviewRunner} from '@godot-js/react-browser/runner';
import type {RunnerEvent} from '@godot-js/react-browser/protocol';
import type {VerifiedRelease} from '@godot-js/react-browser/verified-loader';

/** The preview document has its own origin and a new browsing context per run. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void) {
 const response=await fetch('./engine-release.json');
 if(!response.ok)throw Error('无法加载全量引擎发布清单，请先构建 Playground');
 const manifest=await response.json();
 if(manifest.schemaVersion!==2||manifest.runtimeProfile!=='full-engine-v1')throw Error('全量引擎清单版本不匹配');
 let configured:string|undefined;
 const config=await fetch('./preview-config.json');
 if(config.ok){const value=await config.json();configured=value.previewOrigin;}
 const override=new URL(location.href).searchParams.get('previewOrigin');
 if(override)configured=override;
 if(!configured&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
  const local=new URL(location.origin);local.hostname=location.hostname==='localhost'?'127.0.0.1':'localhost';configured=local.origin;
 }
 if(!configured)throw Error('请在 preview-config.json 配置独立的预览站点 previewOrigin');
 const preview=new URL('./preview.html',configured.replace(/\/$/,'')+'/');
 if(preview.origin===location.origin)throw Error('预览站点须使用独立域名或端口');
 const resolve=(asset:any)=>({...asset,url:new URL(asset.url??asset.path,preview).href,sha256:asset.sha256});
 const release:VerifiedRelease={
  releaseId:manifest.id??manifest.releaseId,profile:'full-engine-v1',
  engineJs:resolve(manifest.engine.javascript),engineWasm:resolve(manifest.engine.wasm),
  worklets:(manifest.engine.worklets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1)})),
  allowedOrigins:[preview.origin],
 };
 const runner=new PreviewRunner({container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000}});
 runner.subscribe(listener);
 return {manifest,runner,async run(pack:Uint8Array,revision:number,details:unknown){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',pack.slice().buffer));
  const buildKey=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  const generation=crypto.randomUUID();
  return runner.run({revision,buildKey,generation,pack,manifest:{generation,engineReleaseId:release.releaseId,project:details}});
 },stop:()=>runner.stop(),dispose:()=>runner.dispose()};
}
