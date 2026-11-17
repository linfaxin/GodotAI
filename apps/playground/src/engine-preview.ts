import {PreviewRunner} from '@godot-js/engine/browser/runner';
import {WorkerPreviewRunner} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {RunnerEvent} from '@godot-js/engine/browser/protocol';
import type {VerifiedRelease} from '@godot-js/engine/browser/verified-loader';
import {loadEngineRelease,loadReleaseContext,loadRuntimeCandidate,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease,assertArtifactTarget} from './release-context';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
import {assertArtifactSet,type ArtifactSet} from '@godot-js/engine/artifact-set';

/** A fresh cross-origin preview consumes the editor's pinned release tuple. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void,options:{allowLegacyArtifacts?:boolean}={}) {
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
  worklets:(manifest.engine.worklets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1).replace(/\.gz$/,'')})),
  execution:manifest.execution??manifest.engine.execution,
  artifactReceiptVersion:manifest.artifactReceiptVersion,
  workerAssets:(manifest.engine.workerAssets??(manifest.execution??manifest.engine.execution)?.workerAssets??[]).map((asset:any)=>({...resolve(asset),name:asset.path.split('/').at(-1).replace(/\.gz$/,''),role:asset.role})),
  allowedOrigins:[preview.origin],cachePolicy:context.publicAssets?'public-immutable':'revalidate',
 };
 const allowLegacyArtifacts=options.allowLegacyArtifacts===true&&manifest.artifactReceiptVersion!==2;
 const runnerOptions={container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000}};
 const runtime=release.execution?.executionModel==='proxy-pthread'?undefined:await loadRuntimeCandidate();
 let runner:PreviewRunner|WorkerPreviewRunner;
 if(runtime?.executionBackend==='worker'){
  if(!context.candidateId||!manifest.runtimeAbi||!runtime.presentationBackends?.includes(presentationBackend))throw Error('E_WORKER_CANDIDATE_ABI');
  release.runtimeAbi=manifest.runtimeAbi;
  const asset=(name:string)=>{const value=runtime.assets?.[name];if(!value)throw Error('E_WORKER_CANDIDATE_ASSET: '+name);return resolve({...value,path:name});};
  release.runtimeWorker=asset(runtime.entry);release.runtimeAudioWorklet=asset(runtime.audioWorklet);
  const benchmark=requested.get('benchmarkTimings')==='1';
  runner=new WorkerPreviewRunner({...runnerOptions,configuration:{presentationBackend:presentationBackend as 'direct'|'bitmap',...(benchmark?{budgets:{benchmarkTimingSamples:512}}:{})}});
 }else{
  if(manifest.runtimeAbi)throw Error('E_WORKER_CANDIDATE_ABI');
  runner=new PreviewRunner({...runnerOptions,allowLegacyArtifacts});
 }
 runner.subscribe(listener);
 let operationSequence=0,disposed=false;
 return {manifest,context,runner,async run(pack:Uint8Array|undefined,revision:number,details:unknown,artifactSet?:ArtifactSet){
  if(disposed)throw Error('E_RUNNER_DISPOSED');
  const compiled=structuredClone(details) as {buildKey?:unknown;generation?:unknown;packSha256?:unknown;artifactId?:string;artifactReceipt?:{buildKey?:unknown;packSha256?:unknown}};
  assertCompiledRelease(context,compiled);assertArtifactTarget(manifest,compiled);
  const operation=++operationSequence;
  const generation=compiled.generation??crypto.randomUUID();
  if(!(typeof generation==='string'&&generation.length>0&&generation.length<=256)&&!(typeof generation==='number'&&Number.isSafeInteger(generation)&&generation>=0))throw Error('E_ARTIFACT_GENERATION');
  if(artifactSet){
   const captured=await assertArtifactSet(artifactSet);
   if(release.execution?.artifactSetAbi!==1)throw Error('E_ARTIFACT_SET_ABI');
   if(captured.manifest.target.engineReleaseId!==release.releaseId||captured.manifest.target.engineProfile!==release.profile)throw Error('E_ARTIFACT_RELEASE_MISMATCH');
   assertArtifactTarget(manifest,captured.manifest.target);
   if(compiled.artifactId!==captured.manifest.artifactSetId)throw Error('E_ARTIFACT_IDENTITY');
   if(typeof compiled.buildKey!=='string'||!/^[a-f0-9]{64}$/i.test(compiled.buildKey))throw Error('E_ARTIFACT_BUILD_KEY');
   if(disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
   return runner.run({variant:'pack-set',revision,buildKey:compiled.buildKey,generation,artifactId:captured.manifest.artifactSetId,artifactSet:captured,manifest:{...compiled,generation}});
  }
  if(!(pack instanceof Uint8Array))throw Error('E_ARTIFACT_PACK');
  const snapshot=pack.slice();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot.buffer));
  if(disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
  const packSha256=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  if(compiled.packSha256!==undefined&&compiled.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
  if(compiled.artifactReceipt!==undefined){
   if(!compiled.artifactReceipt||compiled.artifactReceipt.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
   if(compiled.artifactReceipt.buildKey!==compiled.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
  }
  const buildKey=typeof compiled.buildKey==='string'&&/^[a-f0-9]{64}$/i.test(compiled.buildKey)?compiled.buildKey:packSha256;
  const receipt=await assertArtifactReceipt(compiled.artifactReceipt,{pack:snapshot,buildKey,artifactId:compiled.artifactId,allowLegacy:allowLegacyArtifacts||(!manifest.artifactReceiptVersion&&!!runtime)});
  if(disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
  return runner.run({revision,buildKey,generation,packSha256,artifactId:receipt?.artifactId,pack:snapshot,manifest:{...compiled,generation}});
 },stop:()=>{++operationSequence;return runner.stop();},dispose:()=>{disposed=true;++operationSequence;return runner.dispose();}};
}
