import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {loadVerifiedRuntimeWorker,loadVerifiedWorkerEngine,validateRelease,resolveVerifiedRelease} from '../dist/verified-loader.js';

const raw=value=>new TextEncoder().encode(value);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function setup(t,{wasmGate,compressed=false,importFailure}={}){
 const assets=new Map(),blobs=new Map(),revoked=[],requests=[],imports=[];
 const asset=(name,content)=>{const url='https://preview.test/'+name;assets.set(url,content);return{url,sha256:sha(content)};};
 const worklet=(name,content)=>compressed?{...asset(name+'.gz',gzipSync(content)),encoding:'gzip',decodedSha256:sha(content),decodedBytes:content.length}:asset(name,content);
 const release={releaseId:'release',profile:'engine-2d-v1',engineJs:asset('godot.js',raw('/* exact verified engine */')),engineWasm:asset('godot.wasm',new Uint8Array([0,97,115,109])),
  worklets:[worklet('godot.audio.worklet.js',raw('audio bytes')),worklet('godot.audio.position.worklet.js',raw('position bytes'))],
  runtimeAudioWorklet:worklet('runtime.audio.worklet.js',raw('runtime audio bytes')),runtimeWorker:asset('runtime.worker.js',raw('runtime worker bytes')),
  runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1},allowedOrigins:['https://preview.test']};
 const network=async(input,options)=>{const url=String(input);requests.push({url,options});assert(assets.has(url));return new Response(assets.get(url));};
 class Engine{
  constructor(){this.config={getModuleConfig(base){return{preserved:true,locateFile(path){return base+'/'+path;}};}};}
  static async load(base){Engine.response=new Uint8Array(await(await scope.fetch(base+'.wasm')).arrayBuffer());if(wasmGate)await wasmGate.promise;}
 }
 const scope={fetch:network,location:{href:'https://preview.test/runtime.worker.js'},importScripts(...urls){imports.push(...urls);if(importFailure)throw importFailure;scope.__godotjsVerifiedEngine_fixedid=Engine;}};
 t.mock.method(crypto,'randomUUID',()=> 'fixed-id');
 t.mock.method(URL,'createObjectURL',blob=>{const url='blob:verified-'+blobs.size;blobs.set(url,blob);return url;});
 t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
 return{release,assets,blobs,revoked,requests,imports,scope,Engine,network};
}

test('Worker loader verifies exact engine/worklet bytes without a Document and intercepts the sole WASM request',async t=>{
 const f=setup(t,{compressed:true}),original=f.scope.fetch;
 const loaded=await loadVerifiedWorkerEngine(f.release,{scope:f.scope,includeRuntimeAudioWorklet:true});
 assert.equal(f.scope.fetch,original);assert.deepEqual(f.Engine.response,f.assets.get(f.release.engineWasm.url));
 assert.equal(loaded.Engine,f.Engine);assert.equal(loaded.basePath,'https://preview.test/godot');
 assert.equal(f.requests.length,5,'engine, WASM, two engine worklets and runtime worklet; runtime Worker is not redownloaded');
 assert.deepEqual(loaded.worklets.map(x=>x.name),['audio.worklet.js','audio.position.worklet.js']);
 assert.equal(new TextDecoder().decode(loaded.runtimeAudioWorklet.bytes),'runtime audio bytes');
 assert.equal(loaded.runtimeAudioWorklet.sha256,sha(raw('runtime audio bytes')));
 assert.equal(await f.blobs.get(f.imports[0]).text(),'/* exact verified engine */');
 assert.match(await f.blobs.get(f.imports[1]).text(),/typeof Engine === 'function'/);
 assert.equal(Object.hasOwn(f.scope,'__godotjsVerifiedEngine_fixedid'),false);
 const engine=new loaded.Engine(),untouched=new loaded.Engine(),originalConfig=engine.config.getModuleConfig;
 loaded.installWorklets(engine);loaded.installWorklets(engine);
 const module=engine.config.getModuleConfig('base');assert.equal(module.preserved,true);
 assert.equal(await f.blobs.get(module.locateFile('godot.audio.worklet.js')).text(),'audio bytes');
 assert.equal(module.locateFile('extension.wasm'),'base/extension.wasm');
 assert.equal(untouched.config.getModuleConfig('base').locateFile('godot.audio.worklet.js'),'base/godot.audio.worklet.js');
 loaded.dispose();loaded.dispose();assert.equal(engine.config.getModuleConfig,originalConfig);assert.equal(f.revoked.length,4);assert.equal(new Set(f.revoked).size,4);
 assert.throws(()=>loaded.installWorklets(engine),/E_ENGINE_DISPOSED/);
});

for(const name of ['engineJs','engineWasm','runtimeAudioWorklet'])test(`Worker loader rejects corrupt ${name} before importScripts`,async t=>{
 const f=setup(t);f.assets.set(f.release[name].url,raw('corrupt'));
 await assert.rejects(loadVerifiedWorkerEngine(f.release,{scope:f.scope,includeRuntimeAudioWorklet:true}),/E_ASSET_HASH/);
 assert.equal(f.imports.length,0);assert.equal(f.blobs.size,0);
});

test('Worker import failure releases all URLs and the temporary global capture',async t=>{
 const error=new Error('CSP refused import'),f=setup(t,{importFailure:error});
 await assert.rejects(loadVerifiedWorkerEngine(f.release,{scope:f.scope}),e=>e===error);
 assert.equal(f.revoked.length,4);assert.equal(Object.hasOwn(f.scope,'__godotjsVerifiedEngine_fixedid'),false);
});

test('Worker WASM load cancellation rejects immediately and releases URLs even when Engine.load never settles',async t=>{
 const gate=deferred(),f=setup(t,{wasmGate:gate}),controller=new AbortController();
 const pending=loadVerifiedWorkerEngine(f.release,{scope:f.scope,signal:controller.signal});
 while(!f.Engine.response)await flush();
 const error=new Error('cancel pending wasm');controller.abort(error);
 await assert.rejects(pending,e=>e===error);assert.equal(f.revoked.length,4);assert.equal(f.scope.fetch,f.network);
 gate.resolve();await flush();assert.equal(f.revoked.length,4);
});

test('Worker post-load cancellation restores only its own instance hook and releases worklets',async t=>{
 const f=setup(t),controller=new AbortController(),loaded=await loadVerifiedWorkerEngine(f.release,{scope:f.scope,signal:controller.signal});
 const engine=new loaded.Engine(),original=engine.config.getModuleConfig;loaded.installWorklets(engine);
 controller.abort();assert.equal(engine.config.getModuleConfig,original);assert.equal(f.revoked.length,4);
});

test('runtime ABI and optional executable assets use the same release origin and digest policy',async t=>{
 const f=setup(t);
 assert.throws(()=>validateRelease({...f.release,runtimeAbi:{protocolVersion:1,host:1,audio:1,presentation:1}}),/E_RELEASE_RUNTIME_ABI/);
 assert.throws(()=>validateRelease({...f.release,runtimeWorker:{...f.release.runtimeWorker,url:'https://other.test/worker.js'}}),/E_RELEASE_ORIGIN/);
 assert.throws(()=>validateRelease({...f.release,runtimeAudioWorklet:{...f.release.runtimeAudioWorklet,sha256:'wrong'}}),/E_RELEASE_DIGEST/);
});

test('runtime Worker starts only a verified Blob, retains it until disposal, and terminates once',async t=>{
 const f=setup(t),created=[];
 class FakeWorker{constructor(url,options){this.url=url;this.options=options;this.terminated=0;created.push(this);}terminate(){this.terminated++;}}
 const controller=new AbortController(),loaded=await loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker:FakeWorker,signal:controller.signal,allowedOrigins:f.release.allowedOrigins,workerOptions:{name:'run-worker'}});
 assert.equal(created.length,1);assert.equal(await f.blobs.get(loaded.worker.url).text(),'runtime worker bytes');assert.equal(loaded.worker.options.type,'classic');assert.equal(loaded.worker.options.name,'run-worker');assert.equal(f.revoked.length,0);
 controller.abort();loaded.dispose();assert.equal(created[0].terminated,1);assert.equal(f.revoked.length,1);
});

test('runtime Worker refuses changed bytes, disallowed origins and module entries before creating a worker',async t=>{
 const f=setup(t);let created=0;class FakeWorker{constructor(){created++;}}
 await assert.rejects(loadVerifiedRuntimeWorker({...f.release.runtimeWorker,sha256:'0'.repeat(64)},{fetch:f.network,Worker:FakeWorker}),/E_ASSET_HASH/);
 await assert.rejects(loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker:FakeWorker,allowedOrigins:['https://other.test']}),/E_RELEASE_ORIGIN/);
 await assert.rejects(loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker:FakeWorker,workerOptions:{type:'module'}}),/E_RUNTIME_WORKER_TYPE/);
 assert.equal(created,0);assert.equal(f.blobs.size,0);
});

test('runtime Worker construction failure revokes its URL and a synchronous cancellation terminates the late instance',async t=>{
 const f=setup(t);class BrokenWorker{constructor(){throw Error('constructor failed');}}
 await assert.rejects(loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker:BrokenWorker}),/constructor failed/);assert.equal(f.revoked.length,1);
 const controller=new AbortController();let terminated=0;class LateWorker{constructor(){controller.abort(new Error('cancel constructor'));}terminate(){terminated++;}}
 await assert.rejects(loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker:LateWorker,signal:controller.signal}),/cancel constructor/);
 assert.equal(terminated,1);assert.equal(f.revoked.length,2);
});

test('runtime Worker download cancellation never constructs an executable Blob',async t=>{
 const f=setup(t),controller=new AbortController();let requested;const started=new Promise(done=>requested=done);
 const fetch=async()=>new Response(new ReadableStream({start(){requested();}}));
 const pending=loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch,signal:controller.signal});await started;
 controller.abort(new Error('cancel download'));await assert.rejects(pending,/cancel download/);assert.equal(f.blobs.size,0);
});

test('release normalization resolves every executable asset without mutating metadata or caller URLs',t=>{
 const f=setup(t),relative=structuredClone(f.release);for(const asset of [relative.engineJs,relative.engineWasm,...relative.worklets,relative.runtimeWorker,relative.runtimeAudioWorklet])asset.url='./'+new URL(asset.url).pathname.slice(1);
 const before=structuredClone(relative),resolved=resolveVerifiedRelease(relative,'https://preview.test/preview.html');assert.deepEqual(relative,before);assert.deepEqual(resolved,f.release);
 assert.throws(()=>resolveVerifiedRelease(relative,'https://other.test/preview.html'),/E_RELEASE_ORIGIN/);
 for(const url of ['javascript:evil','https://user:pass@preview.test/godot.js'])assert.throws(()=>resolveVerifiedRelease({...relative,engineJs:{...relative.engineJs,url}},'https://preview.test/preview.html'),/E_RELEASE_URL/);
});

test('Blob Worker loads relative engine, WASM and worklets using an explicit verified HTTP base',async t=>{
 const f=setup(t),relative=structuredClone(f.release);for(const asset of [relative.engineJs,relative.engineWasm,...relative.worklets,relative.runtimeWorker,relative.runtimeAudioWorklet])asset.url=new URL(asset.url).pathname.slice(1);
 f.scope.location.href='blob:https://preview.test/verified-id';
 const loaded=await loadVerifiedWorkerEngine(relative,{scope:f.scope,baseUrl:'https://preview.test/preview.html',includeRuntimeAudioWorklet:true});
 assert.equal(loaded.basePath,'https://preview.test/godot');assert.equal(f.requests.length,5);assert(f.requests.every(r=>r.url.startsWith('https://preview.test/')));assert.equal(await f.blobs.get(f.imports[0]).text(),'/* exact verified engine */');loaded.dispose();
});

test('runtime loader exposes original HTTP script URL without changing its verified Blob bytes',async t=>{
 const f=setup(t);class Worker{terminate(){}}const loaded=await loadVerifiedRuntimeWorker(f.release.runtimeWorker,{fetch:f.network,Worker});assert.equal(loaded.scriptUrl,f.release.runtimeWorker.url);loaded.dispose();
});
