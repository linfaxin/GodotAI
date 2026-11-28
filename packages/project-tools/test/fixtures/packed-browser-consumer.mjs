// Bundled only against installed SDK tarballs. The matching preview page
// remains an unchanged, separately distributed asset.
import {prepareCompilerEnvironmentInput} from '@godot-js/project-tools/environment';
import {createCompilerEnvironment,compileProject,compileResultMetadata,ProjectWorkspace} from '@godot-js/project-tools/compiler';
import {applySourceSnapshotDelta,createSourceSnapshot,createBuildPlan,sourceFileText} from '@godot-js/project-tools/build-plan';
import {checkProjectTypes,snapshotTextFiles} from '@godot-js/project-tools/type-environment';
import {createEngineProjectDocument,readProjectDocument,writeProjectDocument} from '@godot-js/project-tools/project-document';
import {createBrowserResourceConverters,ResourceConverterRegistry} from '@godot-js/project-tools/resource-converters';
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
const workspace = new ProjectWorkspace();
async function dispose() {const previous=runner;runner=undefined;await previous?.dispose();}
async function prepareEnvironment(options) {
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
  const worker=await prepareWorkerRelease({descriptorBytes,siteManifestBytes,
    previewBaseUrl:new URL('./',preview).href,presentationBackend:options.presentationBackend??'direct',
    allowedOrigins:[preview.origin],cachePolicy:site.publicAssets===true?'public-immutable':'revalidate',signal});
  const context={engineProfile:worker.facts.engineProfile,engineReleaseId:worker.facts.releaseId,
    descriptorHash:worker.facts.descriptorSha256,candidateId:worker.facts.candidateId,releaseRoot:root.href,
    ...(site.payloads?.['demo-release.json']?{demoDescriptorHash:site.payloads['demo-release.json'].sha256}:{}),
    ...(site.publicAssets===true?{publicAssets:true}:{})};
  return {prepared,environment,worker,context,preview};
}
async function buildArtifact({environment,prepared,worker,context},plan,options) {
  const {signal,artifactSet,revision,generation,resourceImports,resourceConverters}=options;
  let preparation;
  if(resourceImports?.length){
    if(prepared.facts.resources.status!=='available')throw Error('E_CONSUMER_RESOURCE_TARGET: '+prepared.facts.resources.reason);
    preparation={resourceImports,resourceConverters,resourceTarget:prepared.facts.resources.target};
  }
  const compiled=await compileProject({plan,environment,signal,artifactSet:artifactSet===true,preparation});
  const manifest={...compileResultMetadata(compiled),releaseContext:context};
  const output=compiled.variant==='pack-set'?{variant:'pack-set',artifactSet:compiled.artifactSet,manifest}:
    {variant:'single-pack',pack:compiled.pack,manifest};
  const artifact=await prepareBrowserArtifact({output,target:worker.facts,revision,generation});
  const build={buildKey:compiled.buildKey,sourceHash:compiled.sourceHash,artifactId:compiled.artifactId,
    variant:compiled.variant,diagnostics:compiled.diagnostics,environment:environment.identity,facts:prepared.facts,
    importReceipts:compiled.importReceipts,outputOverlay:compiled.overlay,packSha256:manifest.packSha256};
  return {artifact,build};
}
function createRunner({worker,context,preview},options,subscribe){
  const container=options.container??document.body.appendChild(document.createElement('div'));
  const next=new WorkerPreviewRunner({container,previewUrl:preview.href,release:{...worker.release,releaseContext:context},
    configuration:{...options.configuration,presentationBackend:options.presentationBackend??'direct'},
    deadlines:{downloading:120000,initializing:120000,starting:60000,...options.deadlines}});
  next.subscribe(subscribe);
  return next;
}
async function prepare(options, captured) {
  await dispose();
  const setup=await prepareEnvironment(options);
  const snapshot=captured?.source??await createSourceSnapshot(options.files);
  const plan=await createBuildPlan(snapshot,options.launch);
  const diagnostics=checkProjectTypes(setup.environment.createTypeEnvironment(snapshotTextFiles(snapshot)));
  if(diagnostics.some(item=>item.category==='error'))throw Object.assign(Error('E_CONSUMER_TYPECHECK'),{diagnostics});
  const {artifact,build}=await buildArtifact(setup,plan,{...options,revision:captured?.revision??options.revision??1,generation:options.generation??1});
  lastArtifact=artifact;
  lastBuild=build;
  runner=createRunner(setup,options,event=>events.push(event));
  return lastArtifact;
}

// Each independent page owns a workspace and one preview runner. An invalid
// build never reaches run(), and the current preview survives failed validation.
async function createRoundtrip(options) {
  const setup=await prepareEnvironment(options);
  const roundtripWorkspace=new ProjectWorkspace(),resourceConverters=createBrowserResourceConverters();
  const roundtripEvents=[];
  const container=document.body.appendChild(document.createElement('div'));
  container.style.cssText='width:960px;height:640px';
  const previewRunner=createRunner(setup,{...options,container},event=>roundtripEvents.push(event));
  let project,source,working=false;
  async function stage(run){
    if(working)throw Error('E_CONSUMER_BUSY: A project transaction is already pending');
    working=true;
    try{return await run();}finally{working=false;}
  }
  async function compileAndRun(snapshot,converters=resourceConverters) {
    const plan=await createBuildPlan(snapshot.source,project.launch,{inputs:{engineProfile:project.engineProfile}});
    const {artifact,build}=await buildArtifact(setup,plan,{revision:snapshot.revision,generation:snapshot.revision,
      resourceImports:project.resourceImports,resourceConverters:converters});
    const before=roundtripEvents.length;
    let run,rejection;
    try{run=await previewRunner.run(artifact);}
    catch(error){if(!/^E_RUN_ENDED:/.test(error.message))throw error;rejection=error.message;}
    return {revision:snapshot.revision,build,run,rejection,events:roundtripEvents.slice(before)};
  }
  async function publish(snapshot) {
    source=snapshot;
    try{return await compileAndRun(snapshot);}finally{snapshot.release();}
  }
  return {
    open:input=>stage(async()=>{
      if(source)throw Error('E_CONSUMER_WORKSPACE_NOT_EMPTY');
      const read=await readProjectDocument(input);
      if(read.schemaVersion!==4)throw Error('E_CONSUMER_SCHEMA');
      project=read.document;
      return publish(await roundtripWorkspace.capture(project.files));
    }),
    change:delta=>stage(async()=>publish(await roundtripWorkspace.captureChanges(delta.changed,delta.removed,{expectedBaseRevision:delta.baseRevision}))),
    rejectResource:({remove,withoutProducer})=>stage(async()=>{
      const start=roundtripEvents.length;
      const snapshot={...source,source:remove?await applySourceSnapshotDelta(source.source,{},[remove]):source.source};
      try{await compileAndRun(snapshot,withoutProducer?new ResourceConverterRegistry():resourceConverters);}
      catch(error){return {error:{code:error.code,message:error.message},revision:roundtripWorkspace.revision,events:roundtripEvents.slice(start)};}
      throw Error('E_CONSUMER_NEGATIVE_BUILD: Invalid resource compiled');
    }),
    export:()=>stage(async()=>{
      const files=Object.fromEntries(source.source.files.map(file=>[file.path,file.encoding==='utf8'?sourceFileText(file):file.bytes]));
      const current=await createEngineProjectDocument({files,launch:project.launch,engineProfile:project.engineProfile,resourceImports:project.resourceImports});
      return writeProjectDocument(current);
    }),
    runner:previewRunner,
    get events(){return structuredClone(roundtripEvents);},
  };
}
globalThis.engineContractsConsumer={prepare,
  async openRoundtrip(options){globalThis.engineContractsRoundtrip=await createRoundtrip(options);},
  async run(options){const artifact=await prepare(options);const result=await runner.run(artifact);return {result,artifact};},
  async runIteration(options) {
    const delta = options.delta;
    const captured = delta
      ? await workspace.captureChanges(delta.changed, delta.removed, {expectedBaseRevision: delta.baseRevision})
      : await workspace.capture(options.files);
    try {
      const artifact = await prepare(options, captured);
      const run = await runner.run(artifact);
      return {run, revision: captured.revision, build: lastBuild};
    } finally {
      captured.release();
    }
  },
  stop:()=>runner?.stop(),dispose,
  get runner(){return runner;},get lastArtifact(){return lastArtifact;},get lastBuild(){return lastBuild;},
  get events(){return structuredClone(events);},
};
