import {PreviewRunner} from '@godot-js/engine/browser/runner';
import {WorkerPreviewRunner,supportsWorkerInteraction,type WorkerRunnerEvent} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {RunnerEvent} from '@godot-js/engine/browser/protocol';
import type {VerifiedRelease} from '@godot-js/engine/browser/verified-loader';
import {prepareWorkerRelease} from '@godot-js/engine/browser/release-adapter';
import type {ReleaseFacts} from '@godot-js/engine/release-assets';
import {prepareBrowserArtifact} from '@godot-js/project-tools/browser';
import {loadEngineRelease,loadReleaseContext,loadReleaseInputs,loadRuntimeCandidate,type ReleaseContext} from './engine-assets';
import {assertCompiledRelease,assertArtifactTarget} from './release-context';
import {assertArtifactReceipt} from '@godot-js/engine/identities';
import {assertArtifactSet,type ArtifactSet} from '@godot-js/engine/artifact-set';
import type {DebugPreviewConfiguration} from './debug-api';

/** A fresh cross-origin preview consumes the editor's pinned release tuple. */
export async function createEnginePreview(container:HTMLElement, listener:(event:RunnerEvent)=>void,options:{allowLegacyArtifacts?:boolean;onWorkerEvent?:(event:WorkerRunnerEvent)=>void}={}) {
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
 let release:VerifiedRelease&{releaseContext:ReleaseContext};
 const allowLegacyArtifacts=options.allowLegacyArtifacts===true&&manifest.artifactReceiptVersion!==2;
 const runtime=(manifest.execution??manifest.engine.execution)?.executionModel==='proxy-pthread'?undefined:await loadRuntimeCandidate();
 let target:ReleaseFacts|undefined;
 let configuration:DebugPreviewConfiguration|undefined;
 let runner:PreviewRunner|WorkerPreviewRunner;
 if(runtime?.executionBackend==='worker'){
  const inputs=await loadReleaseInputs();
  if(!inputs.siteManifestBytes)throw Error('E_WORKER_CANDIDATE_ABI');
  const prepared=await prepareWorkerRelease({...inputs,siteManifestBytes:inputs.siteManifestBytes,previewBaseUrl:previewRoot.href,
   presentationBackend:presentationBackend as 'direct'|'bitmap',allowedOrigins:[preview.origin],cachePolicy:context.publicAssets?'public-immutable':'revalidate'});
  if(prepared.facts.descriptorSha256!==context.descriptorHash||prepared.facts.candidateId!==context.candidateId)throw Error('E_PREVIEW_RELEASE_CONTEXT');
  target=prepared.facts;release={...prepared.release,releaseContext:context};
  const benchmark=requested.get('benchmarkTimings')==='1';
  configuration={executionBackend:'worker',presentationBackend:presentationBackend as 'direct'|'bitmap'};
  runner=new WorkerPreviewRunner({container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000},configuration:{presentationBackend:configuration.presentationBackend,...(benchmark?{budgets:{benchmarkTimingSamples:512}}:{})}});
  if(options.onWorkerEvent)runner.subscribe(options.onWorkerEvent);
 }else{
  if(manifest.runtimeAbi)throw Error('E_WORKER_CANDIDATE_ABI');
  const resolve=(asset:import('./engine-assets').ReleaseAsset)=>({...asset,url:new URL(asset.path,previewRoot).href});
  release={releaseId:manifest.id,profile:manifest.runtimeProfile,releaseContext:context,
   engineJs:resolve(manifest.engine.javascript),engineWasm:resolve(manifest.engine.wasm),
   worklets:(manifest.engine.worklets??[]).map(asset=>({...resolve(asset),name:asset.path.split('/').at(-1)!.replace(/\.gz$/,'')})),
   execution:manifest.execution??manifest.engine.execution,artifactReceiptVersion:manifest.artifactReceiptVersion,
   workerAssets:(manifest.engine.workerAssets??(manifest.execution??manifest.engine.execution)?.workerAssets??[]).map(asset=>({...resolve(asset),name:asset.path.split('/').at(-1)!.replace(/\.gz$/,''),role:asset.role})),
   allowedOrigins:[preview.origin],cachePolicy:context.publicAssets?'public-immutable':'revalidate'};
  runner=new PreviewRunner({container,previewUrl:preview.href,release,deadlines:{initializing:120_000,starting:60_000,downloading:120_000},allowLegacyArtifacts});
 }
 runner.subscribe(listener);
 let operationSequence=0,disposed=false;
 const supportsPlaytest=supportsWorkerInteraction(release,configuration?.presentationBackend,globalThis.navigator?.userAgent??'');
 return {manifest,context,runner,configuration,supportsPlaytest,async run(pack:Uint8Array|undefined,revision:number,details:unknown,artifactSet?:ArtifactSet,registerDebug?:(generation:string|number)=>()=>void,signal?:AbortSignal){
  if(disposed)throw Error('E_RUNNER_DISPOSED');
  if(signal?.aborted)throw new DOMException('Superseded','AbortError');
  const compiled=structuredClone(details) as {buildKey?:unknown;generation?:unknown;packSha256?:unknown;artifactId?:string;artifactReceipt?:{buildKey?:unknown;packSha256?:unknown}};
  assertCompiledRelease(context,compiled);assertArtifactTarget(manifest,compiled);
  const operation=++operationSequence;
  if(registerDebug&&compiled.generation!==undefined)throw Error('E_ARTIFACT_GENERATION');
  const generation=compiled.generation??crypto.randomUUID();
  if(!(typeof generation==='string'&&generation.length>0&&generation.length<=256)&&!(typeof generation==='number'&&Number.isSafeInteger(generation)&&generation>=0))throw Error('E_ARTIFACT_GENERATION');
  if(target){
   const releaseAssociation=registerDebug?.(generation);
   try{
    const output=artifactSet?{variant:'pack-set' as const,artifactSet,manifest:compiled}:{variant:'single-pack' as const,pack:pack!,manifest:compiled};
    const artifact=await prepareBrowserArtifact({output,target,revision,generation});
    if(signal?.aborted||disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
    // The runner validates asynchronously before creating its first session event.
    return await runner.run(artifact,{signal});
   }finally{releaseAssociation?.();}
  }
  if(artifactSet){
   const captured=await assertArtifactSet(artifactSet);
   if(release.execution?.artifactSetAbi!==1)throw Error('E_ARTIFACT_SET_ABI');
   if(captured.manifest.target.engineReleaseId!==release.releaseId||captured.manifest.target.engineProfile!==release.profile)throw Error('E_ARTIFACT_RELEASE_MISMATCH');
   assertArtifactTarget(manifest,captured.manifest.target);
   if(compiled.artifactId!==captured.manifest.artifactSetId)throw Error('E_ARTIFACT_IDENTITY');
   if(typeof compiled.buildKey!=='string'||!/^[a-f0-9]{64}$/i.test(compiled.buildKey))throw Error('E_ARTIFACT_BUILD_KEY');
   if(signal?.aborted||disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
   return runner.run({variant:'pack-set',revision,buildKey:compiled.buildKey,generation,artifactId:captured.manifest.artifactSetId,artifactSet:captured,manifest:{...compiled,generation}});
  }
  if(!(pack instanceof Uint8Array))throw Error('E_ARTIFACT_PACK');
  const snapshot=pack.slice();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',snapshot.buffer));
  if(signal?.aborted||disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
  const packSha256=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  if(compiled.packSha256!==undefined&&compiled.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
  if(compiled.artifactReceipt!==undefined){
   if(!compiled.artifactReceipt||compiled.artifactReceipt.packSha256!==packSha256)throw Error('E_ARTIFACT_PACK_HASH');
   if(compiled.artifactReceipt.buildKey!==compiled.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
  }
  const buildKey=typeof compiled.buildKey==='string'&&/^[a-f0-9]{64}$/i.test(compiled.buildKey)?compiled.buildKey:packSha256;
  const receipt=await assertArtifactReceipt(compiled.artifactReceipt,{pack:snapshot,buildKey,artifactId:compiled.artifactId,allowLegacy:allowLegacyArtifacts||(!manifest.artifactReceiptVersion&&!!runtime)});
  if(signal?.aborted||disposed||operation!==operationSequence)throw new DOMException('Superseded','AbortError');
  return runner.run({revision,buildKey,generation,packSha256,artifactId:receipt?.artifactId,pack:snapshot,manifest:{...compiled,generation}});
 },stopRun:(runId:string)=>runner instanceof WorkerPreviewRunner?runner.stopRun(runId):undefined,
 interaction:runner instanceof WorkerPreviewRunner ? runner : undefined,
 stop:()=>{++operationSequence;return runner.stop();},dispose:()=>{disposed=true;++operationSequence;return runner.dispose();}};
}
