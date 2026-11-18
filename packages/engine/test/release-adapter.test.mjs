import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWorkerRelease} from '../dist/browser/release-adapter.js';
import {createEngineIdentity,nativeEngineIdentityInputs} from '../dist/identities.js';
import {nativeReleaseFixture,digest,sealRelease} from './fixtures/native-release.mjs';

const encode=value=>new TextEncoder().encode(JSON.stringify(value,null,2)+'\n');
async function fixture({lifecycle=true,legacy=false}={}){
 const {manifest,files,asset}=await nativeReleaseFixture({legacy});
 manifest.engine.host=asset('preview.js','/* owned preview host */');
 manifest.runtimeAbi={protocolVersion:2,host:1,audio:1,presentation:1,...(lifecycle?{lifecycle:1}:{})};
 if(lifecycle)manifest.execution.lifecycleAbi=1;
 manifest.execution.artifactSetAbi=1;
 const runtimeAssets={};
 for(const name of ['preview.js','runtime.worker.js','runtime.audio.worklet.js']){
  const bytes=files.get(name)??new TextEncoder().encode('/* owned '+name+' */');files.set(name,bytes);
  runtimeAssets[name]={sha256:digest(bytes),bytes:bytes.byteLength};
 }
 const site={schemaVersion:3,runtimeProfile:manifest.runtimeProfile,engineReleaseId:'',engineRelease:'engine-release.json',
  runtime:{executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',abi:{...manifest.runtimeAbi},entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:runtimeAssets},payloads:{}};
 async function inputs(overrides={}){
  if(!legacy)manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(manifest));
  sealRelease(manifest);
  const descriptorBytes=encode(manifest);
  site.engineReleaseId=manifest.id;
  site.payloads={...Object.fromEntries([...files].map(([name,bytes])=>[name,{sha256:digest(bytes),bytes:bytes.byteLength}])),
   'engine-release.json':{sha256:digest(descriptorBytes),bytes:descriptorBytes.byteLength},...site.payloads};
  return {descriptorBytes,siteManifestBytes:encode(site),previewBaseUrl:'https://preview.example/mirror/game/',presentationBackend:'direct',allowedOrigins:['https://preview.example'],cachePolicy:'revalidate',...overrides};
 }
 return {manifest,site,inputs};
}

test('Worker release adapter pairs raw descriptors and prepares a different-origin complete mirror without fetching assets',async()=>{
 const f=await fixture(),input=await f.inputs(),before=structuredClone(input),original=globalThis.fetch;
 let requests=0;globalThis.fetch=()=>{requests++;assert.fail('metadata preparation must not fetch');};
 try{
  const {release,facts}=await prepareWorkerRelease(input);
  assert.equal(requests,0);assert.deepEqual(input,before);
  assert.equal(release.engineJs.url,'https://preview.example/mirror/game/engine/game.js');
  assert.equal(release.runtimeWorker.url,'https://preview.example/mirror/game/runtime.worker.js');
  assert.equal(release.runtimeAudioWorklet.url,'https://preview.example/mirror/game/runtime.audio.worklet.js');
  assert.equal(release.execution.executionModel,'window','historical native layout does not select page-thread execution');
  assert.equal(release.runtimeAbi.lifecycle,1);assert.equal(release.execution.artifactSetAbi,1);
  assert.equal(facts.releaseId,f.manifest.id);assert.equal(facts.engineId,f.manifest.engineId);assert.equal(facts.extensionId,f.manifest.extensionId);
  assert.equal(facts.descriptorSha256,digest(input.descriptorBytes));assert.equal(facts.candidateId,digest(input.siteManifestBytes));
  assert.notEqual(facts.descriptorSha256,digest(JSON.stringify(f.manifest)),'raw bytes are not reserialized for their digest');
  assert.equal(Object.hasOwn(release,'releaseContext'),false,'product context remains the caller adapter responsibility');
 }finally{globalThis.fetch=original;}
});

test('Worker release adapter captures exact views, options and original signal before its first await',async()=>{
 const f=await fixture(),input=await f.inputs(),expectedDescriptor=digest(input.descriptorBytes),expectedCandidate=digest(input.siteManifestBytes);
 const wrapped=new Uint8Array(input.descriptorBytes.length+8);wrapped.set(input.descriptorBytes,4);input.descriptorBytes=wrapped.subarray(4,-4);
 const pending=prepareWorkerRelease(input);
 input.descriptorBytes.fill(0);input.siteManifestBytes.fill(0);input.allowedOrigins[0]='https://changed.example';
 input.previewBaseUrl='https://changed.example/';input.presentationBackend='bitmap';input.cachePolicy='public-immutable';
 const {release,facts}=await pending;
 assert.equal(facts.descriptorSha256,expectedDescriptor);assert.equal(facts.candidateId,expectedCandidate);
 assert.equal(release.runtimeWorker.url,'https://preview.example/mirror/game/runtime.worker.js');assert.equal(release.cachePolicy,'revalidate');
 assert.deepEqual(release.allowedOrigins,['https://preview.example']);
 const next=await fixture(),aborter=new AbortController(),cancelled=await next.inputs({signal:aborter.signal});
 const reason=Error('cancel original preparation'),rejected=prepareWorkerRelease(cancelled);
 cancelled.signal=new AbortController().signal;aborter.abort(reason);
 await assert.rejects(rejected,error=>error===reason);
});

test('site descriptor seals, release headers and executable references cannot be omitted or changed',async t=>{
 for(const [name,change,pattern]of [
  ['missing descriptor seal',site=>{delete site.payloads['engine-release.json'];},/E_SITE_DESCRIPTOR_HASH/],
  ['wrong descriptor bytes',site=>{site.payloads['engine-release.json'].bytes++;},/E_SITE_DESCRIPTOR_HASH/],
  ['wrong profile',site=>{site.runtimeProfile='other-profile';},/E_WORKER_RELEASE_SITE/],
  ['wrong release',site=>{site.engineReleaseId=digest('other release');},/E_WORKER_RELEASE_SITE/],
  ['wrong native target',site=>{site.engineId=digest('other engine');},/E_WORKER_RELEASE_SITE/],
  ['wrong runtime hash',site=>{site.runtime.assets['runtime.worker.js'].sha256=digest('other worker');},/E_WORKER_RELEASE_ASSET/],
  ['missing native payload',site=>{delete site.payloads['engine/game.wasm'];},/E_WORKER_RELEASE_ASSET/],
  ['host different from native seal',site=>{site.runtime.assets['preview.js'].sha256=site.payloads['preview.js'].sha256=digest('other host');},/E_WORKER_RELEASE_ASSET/],
  ['unsafe runtime path',site=>{site.runtime.entry='../runtime.worker.js';},/E_WORKER_RELEASE_ASSET/],
 ])await t.test(name,async()=>{
  const f=await fixture(),input=await f.inputs();change(f.site);input.siteManifestBytes=encode(f.site);
  await assert.rejects(prepareWorkerRelease(input),pattern);
 });
});

test('Worker release adapter rejects incompatible runtime, ABI, presenter and native thread declarations',async t=>{
 for(const [name,change,pattern]of [
  ['site schema',site=>{site.schemaVersion=2;},/E_WORKER_RELEASE_SITE/],
  ['non-Worker backend',site=>{site.runtime.executionBackend='window';},/E_WORKER_RELEASE_RUNTIME/],
  ['ABI version',site=>{site.runtime.abi.audio=2;},/E_WORKER_RELEASE_ABI/],
  ['missing native lifecycle pairing',site=>{delete site.runtime.abi.lifecycle;},/E_WORKER_RELEASE_ABI/],
  ['undeclared presenter',site=>{site.runtime.presentationBackends=['bitmap'];site.runtime.defaultPresentationBackend='bitmap';},/E_WORKER_RELEASE_PRESENTER/],
 ])await t.test(name,async()=>{
  const f=await fixture(),input=await f.inputs();change(f.site);input.siteManifestBytes=encode(f.site);
  await assert.rejects(prepareWorkerRelease(input),pattern);
 });
 const f=await fixture();Object.assign(f.manifest.execution,{executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,workerBootstrap:'embedded'});
 await assert.rejects(prepareWorkerRelease(await f.inputs()),/E_WORKER_RELEASE_EXECUTION/);
});

test('historical native Worker ABI stays historical rather than acquiring an unbuilt lifecycle capability',async()=>{
 const f=await fixture({lifecycle:false,legacy:true}),{release,facts}=await prepareWorkerRelease(await f.inputs());
 assert.equal(release.runtimeAbi.lifecycle,undefined);assert.equal(release.execution.lifecycleAbi,undefined);
 assert.equal(facts.engineId,undefined);assert.equal(facts.extensionId,undefined);assert.equal(facts.artifactReceiptVersion,undefined);
});

test('immutable caching requires public site declaration and versioned mirror URLs',async()=>{
 const f=await fixture();
 await assert.rejects(prepareWorkerRelease(await f.inputs({cachePolicy:'public-immutable'})),/E_WORKER_RELEASE_CACHE_POLICY/);
 f.site.publicAssets=true;
 await assert.rejects(prepareWorkerRelease(await f.inputs({cachePolicy:'public-immutable'})),/E_WORKER_RELEASE_CACHE_POLICY/);
 const {release}=await prepareWorkerRelease(await f.inputs({cachePolicy:'public-immutable',previewBaseUrl:'https://preview.example/releases/reviewed-1234/'}));
 assert.equal(release.cachePolicy,'public-immutable');
 await assert.rejects(prepareWorkerRelease(await f.inputs({allowedOrigins:['https://other.example']})),/E_WORKER_RELEASE_ORIGIN/);
});

test('malformed raw JSON and a descriptor with unsealed changed content fail before becoming a prepared release',async()=>{
 const f=await fixture(),input=await f.inputs();
 await assert.rejects(prepareWorkerRelease({...input,siteManifestBytes:new Uint8Array([255])}),/E_WORKER_RELEASE_JSON/);
 const changed=structuredClone(f.manifest);changed.sdk.version='changed without new identity';
 await assert.rejects(prepareWorkerRelease({...input,descriptorBytes:encode(changed)}),/E_IDENTITY_RELEASE/);
});
