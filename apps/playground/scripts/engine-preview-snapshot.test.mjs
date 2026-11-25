import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {build} from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeReleaseFixture,sealRelease} from '../../../packages/engine/test/fixtures/native-release.mjs';
import {createCompilerEnvironment,compileBuildPlan,compileResultMetadata} from '@godot-js/project-tools/compiler';
import {createSourceSnapshot,createBuildPlan} from '@godot-js/project-tools/build-plan';

const hash=value=>createHash('sha256').update(value).digest('hex');

const app=fileURLToPath(new URL('../',import.meta.url));
const output=await build({entryPoints:[path.join(app,'src/engine-preview.ts')],bundle:true,write:false,format:'iife',globalName:'PreviewModule',platform:'browser',target:'es2022',plugins:[{name:'snapshot-boundaries',setup(builder){
 builder.onResolve({filter:/^@godot-js\/engine\/browser\/(?:dedicated\/worker-)?runner$/},()=>({path:'runner',namespace:'snapshot'}));
 builder.onResolve({filter:/^\.\/engine-assets$/},()=>({path:'assets',namespace:'snapshot'}));
 builder.onLoad({filter:/.*/,namespace:'snapshot'},({path})=>({loader:'js',resolveDir:app,contents:path==='runner'?`export{supportsWorkerInteraction}from '../../packages/engine/src/browser/dedicated/worker-interaction.ts';export{supportsInputScript}from '../../packages/engine/src/browser/dedicated/worker-input-script.ts';export{supportsWorkerObservation}from '../../packages/engine/src/browser/dedicated/worker-runtime-observation.ts';export{supportsWorkerRuntimeWrite}from '../../packages/engine/src/browser/dedicated/worker-runtime-write.ts';class Runner {constructor(options){globalThis.__runnerOptions=options;}subscribe(){}run(artifact){globalThis.__artifact=artifact;return Promise.resolve(artifact);}stop(){}dispose(){}}class Legacy extends Runner {constructor(options){super(options);globalThis.__backend='legacy';}}class Worker extends Runner {constructor(options){super(options);globalThis.__backend='worker';}}export{Legacy as PreviewRunner,Worker as WorkerPreviewRunner};`:`export async function loadEngineRelease(){return globalThis.__manifest;}export async function loadReleaseContext(){return globalThis.__context;}export async function loadRuntimeCandidate(){return globalThis.__candidate;}export async function loadReleaseInputs(){return {descriptorBytes:globalThis.__descriptorBytes.slice(),siteManifestBytes:globalThis.__siteBytes.slice()};}`}));
}}]});

async function fixture(digest,query='',defaultBackend){
 // The IO boundary is synthetic, while both public preparation adapters use
 // genuinely sealed descriptors and the compiler's actual artifact metadata.
 const native=await nativeReleaseFixture(),manifest=native.manifest;
 manifest.runtimeAbi={protocolVersion:2,host:1,audio:1,presentation:1};
 const assets={'runtime.worker.js':native.asset('runtime.worker.js','/* snapshot worker */'),
  'runtime.audio.worklet.js':native.asset('runtime.audio.worklet.js','/* snapshot audio worklet */')};
 sealRelease(manifest);
 const descriptorBytes=new TextEncoder().encode(JSON.stringify(manifest));
 const candidate={executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',abi:{...manifest.runtimeAbi},entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets};
 const site={schemaVersion:3,runtimeProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,runtime:candidate,
  payloads:{...manifest.payloads,'engine-release.json':{sha256:hash(descriptorBytes),bytes:descriptorBytes.length}}};
 const siteBytes=new TextEncoder().encode(JSON.stringify(site));
 const context={engineProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,descriptorHash:hash(descriptorBytes),candidateId:hash(siteBytes),releaseRoot:'http://editor.test/'};
 const scope={URL,Uint8Array,TextEncoder,TextDecoder,DOMException,AbortSignal,location:{href:'http://editor.test/'+query},
  ...(defaultBackend?{__PLAYGROUND_EXECUTION_BACKEND__:defaultBackend}:{}),
  __context:context,__manifest:manifest,__candidate:candidate,__descriptorBytes:descriptorBytes,__siteBytes:siteBytes,
  fetch:async()=>({ok:true,json:async()=>({previewOrigin:'http://preview.test/'})}),
  crypto:{randomUUID:()=> 'generation',subtle:{digest(algorithm,input){
   const bytes=ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):new Uint8Array(input);
   // Only gate a PCK digest. Release/receipt identities also use SHA-256 and
   // must remain live while constructing the preview and admitting metadata.
   return bytes[0]===0x47&&bytes[1]===0x44&&bytes[2]===0x50&&bytes[3]===0x43?digest(algorithm,input):webcrypto.subtle.digest(algorithm,input);
  }}},
 };
 // VM metadata must use the VM's plain-object prototype, just as browser
 // structured cloning produces objects in the receiving realm. These compile
 // manifests are finite JSON; pack bytes are captured by the real adapter.
 vm.runInNewContext('globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value));\n'+output.outputFiles[0].text,scope);
 const preview=await scope.PreviewModule.createEnginePreview({},()=>{});
 const environment=await createCompilerEnvironment({target:{engineReleaseId:manifest.id,engineProfile:manifest.runtimeProfile,engineId:manifest.engineId},declarations:{}});
 const project=async value=>{
  const plan=await createBuildPlan(await createSourceSnapshot({'/start.ts':`export function start(){return ${value};}`}),{kind:'script',module:'/start.ts'});
  const result=await compileBuildPlan(plan,{environment});
  return {pack:result.pack,compiled:{...compileResultMetadata(result),releaseContext:{...context},resources:{name:'original'}}};
 };
 return {preview,scope,context,project,...await project(1)};
}

test('preview hashes and transfers the same private pack and compiler manifest across an asynchronous digest',async()=>{
 let releaseDigest,startedDigest;
 const started=new Promise(resolve=>{startedDigest=resolve;});
 const gate=new Promise(resolve=>{releaseDigest=resolve;});
 const {preview,scope,context,compiled,pack}=await fixture(async(algorithm,input)=>{const bytes=new Uint8Array(input).slice();startedDigest();await gate;return webcrypto.subtle.digest(algorithm,bytes);});
 const original=pack.slice(),originalRelease=context.engineReleaseId,originalCandidate=context.candidateId;
 const run=preview.run(pack,7,compiled);await started;
 pack.fill(9);compiled.resources.name='changed';compiled.releaseContext.candidateId='d'.repeat(64);context.engineReleaseId='later-release';releaseDigest();
 await run;
 assert.deepEqual(Array.from(scope.__artifact.pack),Array.from(original));assert.equal(scope.__artifact.manifest.resources.name,'original');
 assert.equal(scope.__artifact.buildKey,compiled.buildKey);assert.equal(scope.__artifact.packSha256,hash(original));
 assert.equal(scope.__artifact.manifest.releaseContext.candidateId,originalCandidate);assert.equal(preview.context.engineReleaseId,originalRelease);assert(Object.isFrozen(preview.context));
});

for(const action of ['stop','dispose'])test(`preview ${action} fences a pack digest that has not reached the runner`,async()=>{
 let release,started;const gate=new Promise(resolve=>{release=resolve;}),hashing=new Promise(resolve=>{started=resolve;});
 const {preview,scope,compiled,pack}=await fixture(async(algorithm,input)=>{started();await gate;return webcrypto.subtle.digest(algorithm,input);});
 const pending=preview.run(pack,1,compiled),rejected=assert.rejects(pending,{name:'AbortError'});await hashing;
 await preview[action]();release();await rejected;assert.equal(scope.__artifact,undefined);
 if(action==='dispose')await assert.rejects(preview.run(pack,2,compiled),/E_RUNNER_DISPOSED/);
});

test('out-of-order pack digests keep only the latest requested project',async()=>{
 const gates=[];let bothStarted;const hashing=new Promise(resolve=>{bothStarted=resolve;});
 const {preview,scope,compiled,pack,project}=await fixture(async(algorithm,input)=>{await new Promise(resolve=>{gates.push(resolve);if(gates.length===2)bothStarted();});return webcrypto.subtle.digest(algorithm,input);});
 const next=await project(2);
 const stale=preview.run(pack,1,compiled),rejected=assert.rejects(stale,{name:'AbortError'});
 const latest=preview.run(next.pack,2,next.compiled);
 await hashing;assert.equal(gates.length,2);gates[1]();await latest;gates[0]();await rejected;
 assert.equal(scope.__artifact.revision,2);assert.deepEqual(Array.from(scope.__artifact.pack),Array.from(next.pack));assert.equal(scope.__artifact.buildKey,next.compiled.buildKey);
});

test('ordinary preview is Worker-only with direct presentation and opt-in benchmark timings',async()=>{
 const hash=(algorithm,input)=>webcrypto.subtle.digest(algorithm,input);
 const normal=await fixture(hash);assert.equal(normal.scope.__backend,'worker');assert.equal(normal.scope.__runnerOptions.previewUrl,'http://preview.test/preview.html');assert.equal(normal.scope.__runnerOptions.configuration.presentationBackend,'direct');assert.equal(normal.scope.__runnerOptions.configuration.budgets,undefined);
 assert.equal(normal.preview.supportsObservation,false);
 const bitmap=await fixture(hash,'?presentationBackend=bitmap');assert.equal(bitmap.scope.__runnerOptions.configuration.presentationBackend,'bitmap');
 const benchmark=await fixture(hash,'?benchmarkTimings=1');assert.equal(benchmark.scope.__runnerOptions.configuration.budgets.benchmarkTimingSamples,512);
 const compatible=await fixture(hash,'?executionBackend=worker');assert.equal(compatible.scope.__backend,'worker');
 for(const query of ['?executionBackend=legacy','?executionBackend=main-thread','?executionBackend='])await assert.rejects(fixture(hash,query),/E_EXECUTION_BACKEND_RETIRED/);
});
