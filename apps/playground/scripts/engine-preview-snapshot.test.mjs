import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {build} from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app=fileURLToPath(new URL('../',import.meta.url));
const output=await build({entryPoints:[path.join(app,'src/engine-preview.ts')],bundle:true,write:false,format:'iife',globalName:'PreviewModule',platform:'browser',target:'es2022',plugins:[{name:'snapshot-boundaries',setup(builder){
 builder.onResolve({filter:/^@godot-js\/react-browser\/(?:worker-)?runner$/},()=>({path:'runner',namespace:'snapshot'}));
 builder.onResolve({filter:/^\.\/engine-assets$/},()=>({path:'assets',namespace:'snapshot'}));
 builder.onLoad({filter:/.*/,namespace:'snapshot'},({path})=>({loader:'js',contents:path==='runner'?`class Runner {constructor(options){globalThis.__runnerOptions=options;}subscribe(){}run(artifact){globalThis.__artifact=artifact;return Promise.resolve(artifact);}stop(){}dispose(){}}class Legacy extends Runner {constructor(options){super(options);globalThis.__backend='legacy';}}class Worker extends Runner {constructor(options){super(options);globalThis.__backend='worker';}}export{Legacy as PreviewRunner,Worker as WorkerPreviewRunner};`:`export async function loadEngineRelease(){return globalThis.__manifest;}export async function loadReleaseContext(){return globalThis.__context;}export async function loadRuntimeCandidate(){return globalThis.__candidate;}`}));
}}]});

async function fixture(digest,query='',defaultBackend){
 const asset=name=>({path:name,sha256:'a'.repeat(64)});
 const context={engineProfile:'engine-2d-v1',engineReleaseId:'release',descriptorHash:'b'.repeat(64),candidateId:'c'.repeat(64),releaseRoot:'http://editor.test/'};
 const scope={URL,Uint8Array,structuredClone,TextEncoder,Object,DOMException,location:{href:'http://editor.test/'+query},
  ...(defaultBackend?{__PLAYGROUND_EXECUTION_BACKEND__:defaultBackend}:{}),
  __context:context,__manifest:{id:'release',runtimeProfile:'engine-2d-v1',runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1},engine:{javascript:asset('engine.js'),wasm:asset('engine.wasm'),worklets:[]}},
  __candidate:{executionBackend:'worker',presentationBackends:['direct','bitmap'],entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:{'runtime.worker.js':asset('runtime.worker.js'),'runtime.audio.worklet.js':asset('runtime.audio.worklet.js')}},
  fetch:async()=>({ok:true,json:async()=>({previewOrigin:'http://preview.test/'})}),
  crypto:{randomUUID:()=> 'generation',subtle:{digest}},
 };
 vm.runInNewContext(output.outputFiles[0].text,scope);
 const preview=await scope.PreviewModule.createEnginePreview({},()=>{});
 const compiled={engineProfile:'engine-2d-v1',engineReleaseId:'release',releaseContext:{...context},resources:{name:'original'}};
 return {preview,scope,context,compiled};
}

test('preview hashes and transfers the same private pack and compiler manifest across an asynchronous digest',async()=>{
 let releaseDigest,startedDigest;
 const started=new Promise(resolve=>{startedDigest=resolve;});
 const gate=new Promise(resolve=>{releaseDigest=resolve;});
 const {preview,scope,context,compiled}=await fixture(async(algorithm,input)=>{const bytes=new Uint8Array(input).slice();startedDigest();await gate;return webcrypto.subtle.digest(algorithm,bytes);});
 const pack=new Uint8Array([1,2,3]);
 const run=preview.run(pack,7,compiled);await started;
 pack.fill(9);compiled.resources.name='changed';compiled.releaseContext.candidateId='d'.repeat(64);context.engineReleaseId='later-release';releaseDigest();
 await run;
 assert.deepEqual(Array.from(scope.__artifact.pack),[1,2,3]);assert.equal(scope.__artifact.manifest.resources.name,'original');
 assert.equal(scope.__artifact.buildKey,createHash('sha256').update(scope.__artifact.pack).digest('hex'));
 assert.equal(scope.__artifact.manifest.releaseContext.candidateId,'c'.repeat(64));assert.equal(preview.context.engineReleaseId,'release');assert(Object.isFrozen(preview.context));
});

for(const action of ['stop','dispose'])test(`preview ${action} fences a pack digest that has not reached the runner`,async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const {preview,scope,compiled}=await fixture(async(algorithm,input)=>{await gate;return webcrypto.subtle.digest(algorithm,input);});
 const pending=preview.run(new Uint8Array([1]),1,compiled),rejected=assert.rejects(pending,{name:'AbortError'});
 await preview[action]();release();await rejected;assert.equal(scope.__artifact,undefined);
 if(action==='dispose')await assert.rejects(preview.run(new Uint8Array([2]),2,compiled),/E_RUNNER_DISPOSED/);
});

test('out-of-order pack digests keep only the latest requested project',async()=>{
 const gates=[];
 const {preview,scope,compiled}=await fixture(async(algorithm,input)=>{await new Promise(resolve=>gates.push(resolve));return webcrypto.subtle.digest(algorithm,input);});
 const stale=preview.run(new Uint8Array([1]),1,compiled),rejected=assert.rejects(stale,{name:'AbortError'});
 const latest=preview.run(new Uint8Array([2]),2,compiled);
 assert.equal(gates.length,2);gates[1]();await latest;gates[0]();await rejected;
 assert.equal(scope.__artifact.revision,2);assert.deepEqual(Array.from(scope.__artifact.pack),[2]);
});

test('ordinary preview is Worker-only with direct presentation and opt-in benchmark timings',async()=>{
 const hash=(algorithm,input)=>webcrypto.subtle.digest(algorithm,input);
 const normal=await fixture(hash);assert.equal(normal.scope.__backend,'worker');assert.equal(normal.scope.__runnerOptions.previewUrl,'http://preview.test/preview.html');assert.equal(normal.scope.__runnerOptions.configuration.presentationBackend,'direct');assert.equal(normal.scope.__runnerOptions.configuration.budgets,undefined);
 const bitmap=await fixture(hash,'?presentationBackend=bitmap');assert.equal(bitmap.scope.__runnerOptions.configuration.presentationBackend,'bitmap');
 const benchmark=await fixture(hash,'?benchmarkTimings=1');assert.equal(benchmark.scope.__runnerOptions.configuration.budgets.benchmarkTimingSamples,512);
 const compatible=await fixture(hash,'?executionBackend=worker');assert.equal(compatible.scope.__backend,'worker');
 for(const query of ['?executionBackend=legacy','?executionBackend=main-thread','?executionBackend='])await assert.rejects(fixture(hash,query),/E_EXECUTION_BACKEND_RETIRED/);
});
