// Bundled only against installed SDK tarballs. The matching preview page
// remains an unchanged, separately distributed asset.
import {prepareCompilerEnvironmentInput} from '@godot-js/project-tools/environment';
import {createCompilerEnvironment,compileProject,compileResultMetadata} from '@godot-js/project-tools/compiler';
import {createSourceSnapshot,createBuildPlan} from '@godot-js/project-tools/build-plan';
import {checkProjectTypes,snapshotTextFiles} from '@godot-js/project-tools/type-environment';
import {prepareBrowserArtifact} from '@godot-js/project-tools/browser';
import {prepareWorkerRelease} from '@godot-js/engine/browser/release-adapter';
import {WorkerPreviewRunner} from '@godot-js/engine/browser/dedicated/worker-runner';

async function readBytes(url,maxBytes,signal) {
  const response=await fetch(url,{signal,credentials:'same-origin',cache:'no-cache',redirect:'error'});
  if(!response.ok)throw Error('E_CONSUMER_HTTP: '+response.status+' '+new URL(url,location.href).pathname);
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw Error('E_CONSUMER_ASSET_SIZE');}
  if(!response.body)throw Error('E_CONSUMER_ASSET_BODY');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {
    for(;;){signal?.throwIfAborted();const part=await reader.read();signal?.throwIfAborted();if(part.done)break;
      length+=part.value.byteLength;if(length>maxBytes)throw Error('E_CONSUMER_ASSET_SIZE');chunks.push(part.value);}
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

let runner,lastArtifact,lastBuild;
const events=[];
async function dispose() {const previous=runner;runner=undefined;await previous?.dispose();}
async function prepare(options) {
  await dispose();
  const root=new URL(options.releaseRoot),preview=new URL(options.previewUrl);
  if(!root.pathname.endsWith('/')||root.search||root.hash)throw Error('E_CONSUMER_RELEASE_ROOT');
  const signal=options.signal;
  const [descriptorBytes,siteManifestBytes]=await Promise.all([
    readBytes(new URL('engine-release.json',root),16*1024*1024,signal),
    readBytes(new URL('manifest.json',root),16*1024*1024,signal),
  ]);
  const site=JSON.parse(new TextDecoder().decode(siteManifestBytes));
  const prepared=await prepareCompilerEnvironmentInput({descriptorBytes,naming:options.naming??'snake',
    selection:options.selection??{kind:'engine'},signal,
    readRawAsset:(asset,read)=>readBytes(new URL(asset.path,root),read.maxStoredBytes,read.signal)});
  const environment=await createCompilerEnvironment(prepared.input);
  const snapshot=await createSourceSnapshot(options.files);
  const plan=await createBuildPlan(snapshot,options.launch);
  const diagnostics=checkProjectTypes(environment.createTypeEnvironment(snapshotTextFiles(snapshot)));
  if(diagnostics.some(item=>item.category==='error'))throw Object.assign(Error('E_CONSUMER_TYPECHECK'),{diagnostics});
  const compiled=await compileProject({plan,environment,signal,artifactSet:options.artifactSet===true});
  const worker=await prepareWorkerRelease({descriptorBytes,siteManifestBytes,
    previewBaseUrl:new URL('./',preview).href,presentationBackend:options.presentationBackend??'direct',
    allowedOrigins:[preview.origin],cachePolicy:site.publicAssets===true?'public-immutable':'revalidate',signal});
  const context={engineProfile:worker.facts.engineProfile,engineReleaseId:worker.facts.releaseId,
    descriptorHash:worker.facts.descriptorSha256,candidateId:worker.facts.candidateId,releaseRoot:root.href,
    ...(site.payloads?.['demo-release.json']?{demoDescriptorHash:site.payloads['demo-release.json'].sha256}:{}),
    ...(site.publicAssets===true?{publicAssets:true}:{})};
  const manifest={...compileResultMetadata(compiled),releaseContext:context};
  const output=compiled.variant==='pack-set'?{variant:'pack-set',artifactSet:compiled.artifactSet,manifest}:
    {variant:'single-pack',pack:compiled.pack,manifest};
  lastArtifact=await prepareBrowserArtifact({output,target:worker.facts,revision:options.revision??1,generation:options.generation??1});
  lastBuild={buildKey:compiled.buildKey,sourceHash:compiled.sourceHash,artifactId:compiled.artifactId,
    variant:compiled.variant,diagnostics:compiled.diagnostics,environment:environment.identity,facts:prepared.facts};
  const container=options.container??document.body.appendChild(document.createElement('div'));
  runner=new WorkerPreviewRunner({container,previewUrl:preview.href,release:{...worker.release,releaseContext:context},
    configuration:{...options.configuration,presentationBackend:options.presentationBackend??'direct'},
    deadlines:{downloading:120000,initializing:120000,starting:60000,...options.deadlines}});
  runner.subscribe(event=>events.push(event));
  return lastArtifact;
}
globalThis.engineContractsConsumer={prepare,
  async run(options){const artifact=await prepare(options);const result=await runner.run(artifact);return {result,artifact};},
  stop:()=>runner?.stop(),dispose,
  get runner(){return runner;},get lastArtifact(){return lastArtifact;},get lastBuild(){return lastBuild;},
  get events(){return structuredClone(events);},
};
