import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {assertReleaseContext,assertSameRelease,assertCompiledRelease,nativeAudioEnabled} from '../src/release-context.ts';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root='https://editor.test/releases/candidate-a/';
const context={engineProfile:'engine-2d-v1',engineReleaseId:'engine-r1',descriptorHash:'a'.repeat(64),releaseRoot:root,candidateId:'candidate-a',demoDescriptorHash:'d'.repeat(64)};
const asset={path:'engine/game.wasm',bytes:8,sha256:'b'.repeat(64)};
const release=(id='engine-r1')=>({schemaVersion:2,runtimeProfile:'engine-2d-v1',id,engine:{javascript:{...asset,path:'engine/game.js'},wasm:asset,worklets:[]},api:{typeSnapshot:{...asset,path:'types.json'}},sdk:{vendor:{...asset,path:'vendor.js'},runtimeModules:{}}});
async function moduleFor(t,entry){
 const directory=await mkdtemp(path.join(tmpdir(),'release-context-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const output=path.join(directory,'module.mjs');
 await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:output,target:'node24'});
 return import(pathToFileURL(output).href);
}
function mockFetch(t,files){
 t.mock.method(globalThis,'fetch',async input=>{
  const url=new URL(String(input),root),body=files.get(url.pathname);
  return body===undefined?new Response('missing',{status:404}):new Response(body,{status:200});
 });
 const previous=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{href:root+'index.html',hostname:'editor.test',origin:'https://editor.test'}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});
}

test('official native profiles retain real audio and context rejects unsupported or mixed releases',()=>{
 assert.equal(nativeAudioEnabled('full-engine-v1'),true);assert.equal(nativeAudioEnabled('engine-2d-v1'),true);assert.equal(nativeAudioEnabled('core-ui-v1'),false);
 assertReleaseContext(context);assertSameRelease(context,{...context});
 for(const [key,value]of Object.entries({engineProfile:'full-engine-v1',engineReleaseId:'engine-r2',descriptorHash:'c'.repeat(64),releaseRoot:'https://editor.test/releases/candidate-b/',candidateId:'candidate-b',demoDescriptorHash:'e'.repeat(64)}))assert.throws(()=>assertSameRelease(context,{...context,[key]:value}),/E_RELEASE_CONTEXT_MISMATCH/);
 assert.throws(()=>assertReleaseContext({...context,engineProfile:'unregistered'}),/E_RELEASE_CONTEXT/);
 assert.throws(()=>assertReleaseContext({...context,releaseRoot:'https://editor.test/releases/a/?latest=true'}),/E_RELEASE_CONTEXT_ROOT/);
 const manifest={engineProfile:context.engineProfile,engineReleaseId:context.engineReleaseId,releaseContext:context,keep:'compiler provenance'};
 assertCompiledRelease(context,manifest);assert.throws(()=>assertCompiledRelease(context,{...manifest,engineReleaseId:'engine-r2'}),/E_ARTIFACT_RELEASE_MISMATCH/);
});

test('editor pins descriptor, helper and candidate bytes; stale worker and rolling pointer mismatches fail',async t=>{
 const r1=JSON.stringify(release()),demo=JSON.stringify({schemaVersion:1,demoApiVersion:1,runtimeProfile:'engine-2d-v1'});
 const site=JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',payloads:{'demo-release.json':{sha256:hash(demo)}}});
 const files=new Map([['/releases/candidate-a/engine-release.json',r1],['/releases/candidate-a/demo-release.json',demo],['/releases/candidate-a/manifest.json',site]]);
 mockFetch(t,files);
 const editor=await moduleFor(t,'../src/engine-assets.ts'),expected=await editor.loadReleaseContext();
 assert.equal(expected.descriptorHash,hash(r1));assert.equal(expected.demoDescriptorHash,hash(demo));assert.equal(expected.candidateId,hash(site));
 const worker=await moduleFor(t,'../src/engine-assets.ts');assert.deepEqual(await worker.initializeReleaseContext(expected),expected);
 files.set('/releases/candidate-a/engine-release.json',JSON.stringify(release('engine-r2')));
 assert.deepEqual(await editor.loadReleaseContext(),expected,'existing sessions retain their original context');
 files.delete('/releases/candidate-a/manifest.json');
 const stale=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(stale.initializeReleaseContext(expected),/E_RELEASE_CONTEXT_MISMATCH/);
 files.set('/releases/candidate-a/engine-release.json',r1);
 files.set('/releases/candidate-a/demo-release.json',JSON.stringify({schemaVersion:1,demoApiVersion:2}));
 const changedHelper=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(changedHelper.initializeReleaseContext(expected),/E_RELEASE_CONTEXT_MISMATCH/);
});

test('preview adapter preserves compiler manifest and refuses another release before creating an iframe',async t=>{
 const manifest={...release(),runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}};
 const runtime={executionBackend:'worker',presentationBackends:['direct','bitmap'],entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:{'runtime.worker.js':asset,'runtime.audio.worklet.js':asset}};
 const files=new Map([['/releases/candidate-a/engine-release.json',JSON.stringify(manifest)],['/releases/candidate-a/manifest.json',JSON.stringify({schemaVersion:3,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',runtime,payloads:{}})],['/releases/candidate-a/preview-config.json',JSON.stringify({previewOrigin:'https://preview.test'})]]);
 // config fetch is relative to the document; the fetch fixture resolves it at root.
 mockFetch(t,files);
 location.href=root+'index.html';
 const module=await moduleFor(t,'../src/engine-preview.ts');
 const preview=await module.createEnginePreview({ownerDocument:{location:{origin:'https://editor.test'}}},()=>{});
 assert.equal(preview.context.releaseRoot,root);
 const provenance={engineProfile:preview.context.engineProfile,engineReleaseId:preview.context.engineReleaseId,releaseContext:preview.context,sourceMarker:'unchanged'};
 await assert.rejects(preview.run(new Uint8Array([1]),1,{...provenance,engineReleaseId:'engine-r2'}),/E_ARTIFACT_RELEASE_MISMATCH/);
 let artifact;preview.runner.run=async value=>{artifact=value;return {state:'running'};};
 await preview.run(new Uint8Array([1]),2,provenance);
 assert.equal(artifact.manifest.sourceMarker,'unchanged');assert.equal(artifact.manifest.engineReleaseId,'engine-r1');assert.deepEqual(artifact.manifest.releaseContext,preview.context);assert.equal(artifact.manifest.generation,artifact.generation);
 assert.equal(preview.runner.options.previewUrl,'https://preview.test/releases/candidate-a/preview.html');
});

test('candidate manifests cannot substitute helper bytes and cached SDK payloads are copied',async t=>{
 const data=new TextEncoder().encode('sdk immutable bytes'),vendor={path:'vendor.js',bytes:data.length,sha256:hash(data)};
 const manifest=release();manifest.sdk.vendor=vendor;
 const demo=JSON.stringify({schemaVersion:1,demoApiVersion:1,runtimeProfile:'engine-2d-v1'});
 const files=new Map([['/releases/candidate-a/engine-release.json',JSON.stringify(manifest)],['/releases/candidate-a/demo-release.json',demo],['/releases/candidate-a/vendor.js',data]]);
 mockFetch(t,files);const module=await moduleFor(t,'../src/engine-assets.ts');
 const first=await module.fetchReleaseAsset(vendor);first[0]=0;
 assert.deepEqual(await module.fetchReleaseAsset(vendor),data,'caller mutation must not corrupt the next compiler request');
 await assert.rejects(module.fetchReleaseAsset({...vendor,path:'../vendor.js'}),/E_SDK_ASSET_DESCRIPTOR/);
 files.set('/releases/candidate-a/manifest.json',JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',payloads:{'demo-release.json':{sha256:'f'.repeat(64)}}}));
 const changed=await moduleFor(t,'../src/engine-assets.ts');await assert.rejects(changed.loadReleaseContext(),/E_SITE_DEMO_MISMATCH/);
});

test('preview verifies its own origin before loading an engine, allowing only byte-identical mirrors',async t=>{
 const module=await moduleFor(t,'../src/preview-release-context.ts');
 const engine=JSON.stringify(release()),demo=JSON.stringify({schemaVersion:1,runtimeProfile:'engine-2d-v1',demoApiVersion:1});
 const site=JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',payloads:{'demo-release.json':{sha256:hash(demo)}}});
 const expected={engineProfile:'engine-2d-v1',engineReleaseId:'engine-r1',descriptorHash:hash(engine),releaseRoot:root,demoDescriptorHash:hash(demo),candidateId:hash(site)};
 const files=new Map([['engine-release.json',engine],['demo-release.json',demo],['manifest.json',site]]),requests=[];
 const mirror='https://preview.test/mirror/r1/';
 const fetch=async(input,options)=>{const url=new URL(String(input));requests.push({url,options});const body=files.get(url.pathname.split('/').at(-1));return body===undefined?new Response('missing',{status:404}):new Response(body);};
 await module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html?editorOrigin=https%3A%2F%2Feditor.test',fetch});
 assert.equal(requests.length,3);assert(requests.every(({url,options})=>url.origin==='https://preview.test'&&url.pathname.startsWith('/mirror/r1/')&&options.cache==='no-cache'&&options.credentials==='same-origin'));
 files.set('engine-release.json',JSON.stringify(release('engine-r2')));
 await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_PREVIEW_SITE_RELEASE|E_RELEASE_CONTEXT_MISMATCH/);
 files.set('engine-release.json',engine);files.set('manifest.json',site+'\n');
 await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_RELEASE_CONTEXT_MISMATCH: candidateId/);
 files.set('manifest.json',site);files.set('demo-release.json',demo+'\n');
 await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_PREVIEW_SITE_DEMO|E_RELEASE_CONTEXT_MISMATCH/);
 files.delete('demo-release.json');
 await assert.rejects(module.verifyPreviewReleaseContext(expected,{baseUrl:mirror+'preview.html',fetch}),/E_PREVIEW_RELEASE_HTTP/);
});
