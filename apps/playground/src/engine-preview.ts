import {WorkerPreviewRunner} from '@godot-js/react-browser/worker-runner';
import type {RunnerEvent} from '@godot-js/react-browser/protocol';
import type {VerifiedRelease} from '@godot-js/react-browser/verified-loader';
import {loadEngineRelease,loadReleaseContext,loadRuntimeCandidate,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease} from './release-context';

/** A fresh cross-origin preview consumes the editor's pinned release tuple. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void) {
 const manifest=await loadEngineRelease(),context=Object.freeze({...await loadReleaseContext()});
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
 const requested=new URL(location.href).searchParams;
 if(requested.has('executionBackend')&&requested.get('executionBackend')!=='worker')throw Error('E_EXECUTION_BACKEND_RETIRED: this playground runs in Worker only');
 const presentationBackend=requested.get('presentationBackend')??'direct';
 if(!['direct','bitmap'].includes(presentationBackend))throw Error('E_PRESENTATION_BACKEND');
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
 {
  const runtime=await loadRuntimeCandidate();
  if(!context.candidateId||!manifest.runtimeAbi||runtime?.executionBackend!=='worker'||!runtime.presentationBackends?.includes(presentationBackend))throw Error('E_WORKER_CANDIDATE_ABI');
  release.runtimeAbi=manifest.runtimeAbi;
  const asset=(name:string)=>{const value=runtime.assets?.[name];if(!value)throw Error('E_WORKER_CANDIDATE_ASSET: '+name);return resolve({...value,path:name});};
  release.runtimeWorker=asset(runtime.entry);release.runtimeAudioWorklet=asset(runtime.audioWorklet);
 }
 const options={container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000}};
 const benchmark=requested.get('benchmarkTimings')==='1';
 const runner=new WorkerPreviewRunner({...options,configuration:{presentationBackend:presentationBackend as 'direct'|'bitmap',...(benchmark?{budgets:{benchmarkTimingSamples:512}}:{})}});
 runner.subscribe(listener);
 let operationSequence=0,disposed=false;
 return {manifest,context,runner,async run(pack:Uint8Array,revision:number,details:unknown){
  if(disposed)throw Error('E_RUNNER_DISPOSED');
  // Pin both inputs before the asynchronous digest. The caller may compile or
  // edit another project while hashing; buildKey must describe these bytes.
  const snapshot=pack.slice(),compiled=structuredClone(details);
  assertCompiledRelease(context,compiled);
  const operation=++operationSequence;
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot.buffer));
  if(disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
  const buildKey=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  const generation=crypto.randomUUID();
  // Preserve the compiler's actual release identity; never replace it with the
  // preview's current release ID during rolling updates.
  return runner.run({revision,buildKey,generation,pack:snapshot,manifest:{...(compiled as object),generation}});
 },stop:()=>{++operationSequence;return runner.stop();},dispose:()=>{disposed=true;++operationSequence;return runner.dispose();}};
}
