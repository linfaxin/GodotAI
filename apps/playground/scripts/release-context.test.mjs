import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {assertReleaseContext,assertSameRelease,assertCompiledRelease,nativeAudioEnabled} from '../src/release-context.ts';
import {canonicalIdentityJson,nativeReleaseIdentityInputs,createArtifactIdentity} from '@godot-js/engine/identities';
import {nativeReleaseFixture,sealRelease} from '../../../packages/engine/test/fixtures/native-release.mjs';
import {createCompilerEnvironment,compileBuildPlan,compileResultMetadata} from '@godot-js/project-tools/compiler';
import {createSourceSnapshot,createBuildPlan} from '@godot-js/project-tools/build-plan';
import {prepareCompilerEnvironmentInput} from '@godot-js/project-tools/environment';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root='https://editor.test/releases/candidate-a/';
const context={engineProfile:'engine-2d-v1',engineReleaseId:'engine-r1',descriptorHash:'a'.repeat(64),releaseRoot:root,candidateId:'candidate-a',demoDescriptorHash:'d'.repeat(64)};
const asset={path:'engine/game.wasm',bytes:8,sha256:'b'.repeat(64)};
function release(label='fixture-r1'){
 const value={schemaVersion:2,runtimeProfile:'engine-2d-v1',fixture:label,engine:{javascript:{...asset,path:'engine/game.js'},wasm:asset,worklets:[]},api:{typeSnapshot:{...asset,path:'types.json'}},sdk:{vendor:{...asset,path:'vendor.js'},runtimeModules:{}}};
 value.payloads=Object.fromEntries([value.engine.javascript,value.engine.wasm,value.api.typeSnapshot,value.sdk.vendor].map(value=>[value.path,value]));return sealRelease(value);
}
async function moduleFor(t,entry){const directory=await mkdtemp(path.join(tmpdir(),'release-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));const output=path.join(directory,'module.mjs');await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:output,target:'node24'});return import(pathToFileURL(output).href);}
function mockFetch(t,files){t.mock.method(globalThis,'fetch',async input=>{const body=files.get(new URL(String(input),root).pathname);return body===undefined?new Response('missing',{status:404}):new Response(body);});const previous=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{href:root+'index.html',hostname:'editor.test',origin:'https://editor.test'}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});}
function siteFor(manifest,engineBytes,extra={}){return JSON.stringify({schemaVersion:2,runtimeProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,payloads:{'engine-release.json':{sha256:hash(engineBytes),bytes:Buffer.byteLength(engineBytes)},...extra}});}
async function receipt(pack,buildKey=hash('build')){const body={schemaVersion:2,buildKey,sourceHash:hash('source'),packSha256:hash(pack),outputs:[{path:'res://main.js',disposition:'generated',reason:'compile',outputHash:hash('main')}]};return {...body,artifactId:await createArtifactIdentity(body)};}
async function sharedSdkEnvironment(reader){
 const {descriptorBytes}=await reader.loadReleaseInputs();
 return prepareCompilerEnvironmentInput({descriptorBytes,naming:'snake',selection:{kind:'sdk',mode:'production'},readRawAsset:reader.readReleaseRawAsset});
}

test('official native profiles retain real audio and context rejects unsupported or mixed releases',()=>{
 assert.equal(nativeAudioEnabled('full-engine-v1'),true);assert.equal(nativeAudioEnabled('engine-2d-v1'),true);assert.equal(nativeAudioEnabled('core-ui-v1'),false);assertReleaseContext(context);assertSameRelease(context,{...context});
 for(const [key,value]of Object.entries({engineProfile:'full-engine-v1',engineReleaseId:'engine-r2',descriptorHash:'c'.repeat(64),releaseRoot:'https://editor.test/releases/candidate-b/',candidateId:'candidate-b',demoDescriptorHash:'e'.repeat(64)}))assert.throws(()=>assertSameRelease(context,{...context,[key]:value}),/E_RELEASE_CONTEXT_MISMATCH/);
 assert.throws(()=>assertReleaseContext({...context,engineProfile:'unregistered'}),/E_RELEASE_CONTEXT/);assert.throws(()=>assertReleaseContext({...context,releaseRoot:root+'?latest=true'}),/E_RELEASE_CONTEXT_ROOT/);
 const manifest={engineProfile:context.engineProfile,engineReleaseId:context.engineReleaseId,releaseContext:context};assertCompiledRelease(context,manifest);assert.throws(()=>assertCompiledRelease(context,{...manifest,engineReleaseId:'other'}),/E_ARTIFACT_RELEASE_MISMATCH/);
});
test('editor pins the complete descriptor, helper and site seal across cached and fresh readers',async t=>{
 const manifest=release(),r1=JSON.stringify(manifest),demo=JSON.stringify({schemaVersion:1,demoApiVersion:1,runtimeProfile:manifest.runtimeProfile}),site=siteFor(manifest,r1,{'demo-release.json':{sha256:hash(demo)}});
 const files=new Map([['/releases/candidate-a/engine-release.json',r1],['/releases/candidate-a/demo-release.json',demo],['/releases/candidate-a/manifest.json',site]]);mockFetch(t,files);
 const editor=await moduleFor(t,'../src/engine-assets.ts'),expected=await editor.loadReleaseContext();assert.equal(expected.descriptorHash,hash(r1));assert.equal(expected.demoDescriptorHash,hash(demo));assert.equal(expected.candidateId,hash(site));
 const worker=await moduleFor(t,'../src/engine-assets.ts');assert.deepEqual(await worker.initializeReleaseContext(expected),expected);
 files.set('/releases/candidate-a/engine-release.json',JSON.stringify(release('other')));assert.deepEqual(await editor.loadReleaseContext(),expected);
 const stale=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(stale.initializeReleaseContext(expected),/E_SITE_RELEASE_MISMATCH|E_RELEASE_CONTEXT_MISMATCH/);
 files.set('/releases/candidate-a/engine-release.json',r1);files.set('/releases/candidate-a/manifest.json',site.replace(hash(r1),'f'.repeat(64)));const mixed=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(mixed.loadEngineRelease(),/E_SITE_DESCRIPTOR_HASH/);
 files.set('/releases/candidate-a/manifest.json',site);files.set('/releases/candidate-a/demo-release.json',demo+'\n');const helper=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(helper.initializeReleaseContext(expected),/E_SITE_DEMO_MISMATCH/);
});
test('preview adapter verifies target and schema2 receipt before a runner receives the pack',async t=>{
 const {manifest}=await nativeReleaseFixture(),r=JSON.stringify(manifest);mockFetch(t,new Map([['/releases/candidate-a/engine-release.json',r],['/releases/candidate-a/preview-config.json',JSON.stringify({previewOrigin:'https://preview.test'})]]));
 const module=await moduleFor(t,'../src/engine-preview.ts'),preview=await module.createEnginePreview({ownerDocument:{location:{origin:'https://editor.test'}}},()=>{});let artifact;preview.runner.run=async value=>{artifact=value;return {state:'running'};};
 const pack=new Uint8Array([1]),proof=await receipt(pack),provenance={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,releaseContext:preview.context,engineId:manifest.engineId,buildKey:proof.buildKey,artifactId:proof.artifactId,artifactReceipt:proof,sourceMarker:'unchanged'};
 await assert.rejects(preview.run(pack,1,{...provenance,engineReleaseId:'other'}),/E_ARTIFACT_RELEASE_MISMATCH/);
 await assert.rejects(preview.run(pack,1,{...provenance,engineId:'4'.repeat(64)}),/E_RUNTIME_TARGET_ENGINE/);
 await assert.rejects(preview.run(pack,1,{...provenance,extensionId:'4'.repeat(64)}),/E_RUNTIME_TARGET_EXTENSION/);
 await assert.rejects(preview.run(pack,1,{...provenance,artifactReceipt:undefined}),/E_ARTIFACT_RECEIPT/);
 await assert.rejects(preview.run(pack,1,{...provenance,artifactReceipt:{...proof,packSha256:'5'.repeat(64)}}),/E_ARTIFACT_PACK_HASH|E_ARTIFACT_IDENTITY/);
 await assert.rejects(preview.run(pack,1,{...provenance,artifactReceipt:{...proof,buildKey:'5'.repeat(64)}}),/E_ARTIFACT_BUILD_KEY/);
 await preview.run(pack,2,provenance);assert.equal(artifact.artifactId,proof.artifactId);assert.equal(artifact.manifest.sourceMarker,'unchanged');assert.equal(artifact.manifest.extensionId,undefined);
 await preview.run(pack,3,{...provenance,extensionId:manifest.extensionId});assert.equal(artifact.manifest.extensionId,manifest.extensionId);assert.throws(()=>{preview.manifest.extensionId='4'.repeat(64);},TypeError);

});

test('preview adapter preserves compiler manifest and refuses another release before creating an iframe',async t=>{
 const fixture=await nativeReleaseFixture(),manifest=fixture.manifest;
 manifest.runtimeAbi={protocolVersion:2,host:1,audio:1,presentation:1};
 const assets={'runtime.worker.js':fixture.asset('runtime.worker.js','/* release-context worker */'),
  'runtime.audio.worklet.js':fixture.asset('runtime.audio.worklet.js','/* release-context audio worklet */')};
 sealRelease(manifest);
 const descriptor=JSON.stringify(manifest),runtime={executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',abi:{...manifest.runtimeAbi},entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets};
 const site={schemaVersion:3,runtimeProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,runtime,
  payloads:{...manifest.payloads,'engine-release.json':{sha256:hash(descriptor),bytes:Buffer.byteLength(descriptor)}}};
 const files=new Map([['/releases/candidate-a/engine-release.json',descriptor],['/releases/candidate-a/manifest.json',JSON.stringify(site)],['/releases/candidate-a/preview-config.json',JSON.stringify({previewOrigin:'https://preview.test'})]]);
 // config fetch is relative to the document; the fetch fixture resolves it at root.
 mockFetch(t,files);
 location.href=root+'index.html';
 const module=await moduleFor(t,'../src/engine-preview.ts');
 const preview=await module.createEnginePreview({ownerDocument:{location:{origin:'https://editor.test'}}},()=>{});
 assert.equal(preview.context.releaseRoot,root);
 const environment=await createCompilerEnvironment({target:{engineReleaseId:manifest.id,engineProfile:manifest.runtimeProfile,engineId:manifest.engineId},declarations:{}});
 const plan=await createBuildPlan(await createSourceSnapshot({'/start.ts':'export function start() {}'}),{kind:'script',module:'/start.ts'});
 const result=await compileBuildPlan(plan,{environment}),provenance={...compileResultMetadata(result),releaseContext:preview.context,sourceMarker:'unchanged'};
 await assert.rejects(preview.run(result.pack,1,{...provenance,engineReleaseId:'engine-r2'}),/E_ARTIFACT_RELEASE_MISMATCH/);
 await assert.rejects(preview.run(result.pack,1,{...provenance,releaseContext:{...preview.context,candidateId:'0'.repeat(64)}}),/E_RELEASE_CONTEXT_MISMATCH/);
 let artifact;preview.runner.run=async value=>{artifact=value;return {state:'running'};};
 await preview.run(result.pack,2,provenance);
 assert.equal(artifact.manifest.sourceMarker,'unchanged');assert.equal(artifact.manifest.engineReleaseId,manifest.id);assert.deepEqual(artifact.manifest.releaseContext,preview.context);assert.equal(artifact.manifest.generation,artifact.generation);
 assert.equal(artifact.artifactId,result.artifactId);assert.equal(artifact.buildKey,result.buildKey);assert.deepEqual(artifact.pack,result.pack);
 assert.equal(preview.runner.options.previewUrl,'https://preview.test/releases/candidate-a/preview.html');
});
test('SDK replacement under old IDs and declaration identities is rejected before it reaches the compiler',async t=>{
 const fixture=await nativeReleaseFixture(),{manifest,files:assets}=fixture;
 // This suite checks SDK/type identity. An absent IR is a supported unknown
 // capability; do not let the generic fixture's '{}' IR mask those failures.
 delete manifest.api.ir;sealRelease(manifest);
 const files=new Map([...assets].map(([name,bytes])=>['/releases/candidate-a/'+name,bytes]));const original=JSON.stringify(manifest);files.set('/releases/candidate-a/engine-release.json',original);files.set('/releases/candidate-a/manifest.json',siteFor(manifest,original));mockFetch(t,files);
 const changed=structuredClone(manifest);changed.sdk.vendor={...changed.sdk.vendor,sha256:hash('replaced SDK'),bytes:12};changed.sdk.vendors.production=changed.sdk.vendor;files.set('/releases/candidate-a/engine-release.json',JSON.stringify(changed));const reader=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(sharedSdkEnvironment(reader),/E_IDENTITY_RELEASE/);
 const wrapper=structuredClone(manifest),specifier=Object.keys(wrapper.sdk.runtimeModules)[0];wrapper.sdk.runtimeModules[specifier]={...wrapper.sdk.runtimeModules[specifier],sha256:hash('changed runtime module')};sealRelease(wrapper);files.set('/releases/candidate-a/engine-release.json',JSON.stringify(wrapper));const changedModule=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(sharedSdkEnvironment(changedModule),/E_IDENTITY_EXTENSION/);
 files.set('/releases/candidate-a/engine-release.json',original);const valid=await moduleFor(t,'../src/engine-assets.ts');
 const prepared=await sharedSdkEnvironment(valid);assert.equal(prepared.facts.api.status,'unknown');assert.deepEqual(prepared.input.vendor,new Uint8Array(assets.get(manifest.sdk.vendor.path)));
 prepared.input.vendor[0]=0;assert.deepEqual((await sharedSdkEnvironment(valid)).input.vendor,new Uint8Array(assets.get(manifest.sdk.vendor.path)));
 const vendor=await valid.fetchReleaseAsset(manifest.sdk.vendor);vendor[0]=0;assert.deepEqual(await valid.fetchReleaseAsset(manifest.sdk.vendor),new Uint8Array(assets.get(manifest.sdk.vendor.path)));
 await assert.rejects(valid.fetchReleaseAsset({...manifest.sdk.vendor,path:'../vendor.js'}),/E_SDK_ASSET_DESCRIPTOR/);
 const badTypes={...fixture.types,'/engine-sdk/engine.d.ts':'changed SDK declarations'};const typeBytes=Buffer.from(JSON.stringify(badTypes));const typeAsset={...manifest.api.typeSnapshot,sha256:hash(typeBytes),bytes:typeBytes.length};files.set('/releases/candidate-a/'+typeAsset.path,typeBytes);await assert.rejects(valid.fetchReleaseAsset(typeAsset),/E_IDENTITY_TYPES/);
 const changedTypes=structuredClone(manifest);changedTypes.api.typeSnapshot=typeAsset;changedTypes.api.namingProfiles.snake.typeSnapshot=typeAsset;changedTypes.payloads[typeAsset.path]=typeAsset;sealRelease(changedTypes);const changedTypeDescriptor=JSON.stringify(changedTypes);files.set('/releases/candidate-a/engine-release.json',changedTypeDescriptor);files.set('/releases/candidate-a/manifest.json',siteFor(changedTypes,changedTypeDescriptor));const compiler=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(sharedSdkEnvironment(compiler),/E_IDENTITY_TYPES/);
});
test('preview verifies its own canonical descriptor and exact site seal on a mirrored origin',async t=>{
 const module=await moduleFor(t,'../src/preview-release-context.ts'),manifest=release(),engine=JSON.stringify(manifest),demo=JSON.stringify({schemaVersion:1,runtimeProfile:manifest.runtimeProfile,demoApiVersion:1}),site=siteFor(manifest,engine,{'demo-release.json':{sha256:hash(demo)}}),expected={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,descriptorHash:hash(engine),releaseRoot:root,demoDescriptorHash:hash(demo),candidateId:hash(site)};
 const files=new Map([['engine-release.json',engine],['demo-release.json',demo],['manifest.json',site]]),requests=[],mirror='https://preview.test/mirror/r1/';
 const fetch=async(input,options)=>{const url=new URL(String(input));requests.push({url,options});const body=files.get(url.pathname.split('/').at(-1));return body===undefined?new Response('missing',{status:404}):new Response(body);};
 await module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch});assert.equal(requests.length,3);assert(requests.every(({url,options})=>url.origin==='https://preview.test'&&options.credentials==='same-origin'));
 files.set('manifest.json',site.replace(hash(engine),'f'.repeat(64)));await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_SITE_DESCRIPTOR_HASH/);
 files.set('manifest.json',site);files.set('engine-release.json',JSON.stringify({...manifest,sdk:{...manifest.sdk,version:'changed'}}));await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_IDENTITY_RELEASE/);
});
test('preview checks the actual host response and the executing module script integrity',async t=>{
 const module=await moduleFor(t,'../src/preview-release-context.ts'),hostBytes='/* sealed actual host fixture */',manifest=release(),host={path:'preview.js',bytes:Buffer.byteLength(hostBytes),sha256:hash(hostBytes)};manifest.engine.host=host;manifest.payloads['preview.js']=host;sealRelease(manifest);
 const engine=JSON.stringify(manifest),expected={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,descriptorHash:hash(engine),releaseRoot:root},files=new Map([['engine-release.json',engine],['preview.js',hostBytes]]),fetch=async input=>{const body=files.get(new URL(String(input)).pathname.split('/').at(-1));return body===undefined?new Response('missing',{status:404}):new Response(body);};
 const script={src:new URL('preview.js',root).href,integrity:'sha256-'+Buffer.from(host.sha256,'hex').toString('base64')},previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:()=>[script]}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
 await module.verifyPreviewReleaseContext(expected,{baseUrl:root+'preview.html',fetch});files.set('preview.js','changed');await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:root+'preview.html',fetch}),/E_PREVIEW_HOST_HASH/);
 files.set('preview.js',hostBytes);script.integrity='sha256-wrong';await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:root+'preview.html',fetch}),/E_PREVIEW_HOST_INTEGRITY/);
});
