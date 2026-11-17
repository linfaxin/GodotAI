import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceSnapshot,createBuildPlan,packBuildPlan,prepareBuildPlan,snapshotFiles} from '../dist/build-plan.js';
import {ProjectWorkspace,ProjectBuildCache,compileBuildPlan,createCompilerEnvironment} from '../dist/compiler.js';
import {ProjectLanguageService,createProjectTypeEnvironment,checkProjectTypes} from '../dist/type-environment.js';
import {ResourceConverterRegistry} from '../dist/resource-converters.js';
import {ownedByteMetrics} from '../dist/owned-bytes.js';

const encoder=new TextEncoder(),launch={kind:'script',module:'/start.ts'};
const planFor=async files=>createBuildPlan(await createSourceSnapshot(files),launch);
const packedText=(result,path)=>{const item=result.index[path];return new TextDecoder().decode(result.pack.subarray(item.offset,item.offset+item.size));};

test('same immutable inputs retain build, PCK and artifact identity when only converter cache state changes',async()=>{
 const converter={id:'fixture/data',version:'1',extensions:['dat'],parameters:()=>({}),convert(context){
  return new Map([[context.destination,encoder.encode('[gd_resource type="Resource" format=3]\n[resource]\n')],[context.resource+'.import',encoder.encode('[remap]\npath='+JSON.stringify(context.destination)+'\n')]]);
 }};
 const source=new Map([['res://start.ts',encoder.encode('export function start(){}')],['res://asset.dat',Uint8Array.of(1,2,3)]]),requests=[{resource:'res://asset.dat',converter:converter.id}],target={resourceAbi:'fixture-resource-v1',features:{}};
 const seed=await new ResourceConverterRegistry().register(converter).run(requests,source,target);
 const all=new Map([...source,...seed.files]);all.set('res://start.ts','export function start(){}');
 const plan=await createBuildPlan(await createSourceSnapshot(all),launch),registry=new ResourceConverterRegistry().register(converter);
 const options={resourceImports:requests,resourceConverters:registry,resourceTarget:target,storedImportReceipts:seed.receipts};
 const cold=await packBuildPlan(plan,options),warm=await packBuildPlan(plan,options);
 assert.equal(cold.plan.snapshot.sourceHash,warm.plan.snapshot.sourceHash);assert.equal(cold.plan.buildKey,warm.plan.buildKey);
 assert.deepEqual(cold.pack,warm.pack);assert.deepEqual(cold.receipt,warm.receipt);assert.equal(cold.receipt.artifactId,warm.receipt.artifactId);
});

test('workspace snapshots own buffers, pin builds and reuse unchanged large blobs without rehashing them',async()=>{
 const workspace=new ProjectWorkspace(),image=new Uint8Array(256*1024).fill(37),files={'/start.ts':'export function start(){}','/asset.bin':image};
 const first=await workspace.capture(files),before=ownedByteMetrics();
 const second=await workspace.capture({...files,'/start.ts':'export function start(){return 1}'}),after=ownedByteMetrics();
 assert.equal(first.source.files.find(x=>x.path.endsWith('asset.bin')),second.source.files.find(x=>x.path.endsWith('asset.bin')));
 assert(after.bytesHashed-before.bytesHashed<1024,'unchanged binary blob must not be hashed again');
 image.fill(0);assert.equal(first.source.files.find(x=>x.path.endsWith('asset.bin')).bytes[0],37);
 assert.equal(workspace.pendingSnapshots,2);assert(!workspace.isCurrent(first));assert(workspace.isCurrent(second));
 first.release();first.release();assert.equal(workspace.pendingSnapshots,1);second.release();assert.equal(workspace.pendingSnapshots,0);
});

test('warm emit and PCK caching preserves bytes and does not expose cache buffers to callers',async()=>{
 const cache=new ProjectBuildCache(),plan=await planFor({'/start.ts':'import {value} from "./value"; export function start(){return value}','/value.ts':'export const value=1;'});
 const cold=await compileBuildPlan(plan,{cache}),expected=cold.pack.slice(),before=cache.metrics;
 cold.pack.fill(255);
 const warm=await compileBuildPlan(plan,{cache});
 assert.deepEqual(warm.pack,expected);assert.equal(warm.artifactId,cold.artifactId);assert(cache.metrics.emitHits>before.emitHits);assert.equal(cache.metrics.packHits,before.packHits+1);
 assert.equal(cache.metrics.packBytesWritten,before.packBytesWritten,'warm pack must reuse the assembled bytes');
});

test('adding a formerly missing module invalidates cached resolution without changing the importing source',async()=>{
 const cache=new ProjectBuildCache(),source='export function start(){return require("./late")}';
 const first=await compileBuildPlan(await planFor({'/start.ts':source}),{cache});
 assert.match(packedText(first,'res://.godot/GodotJS/start.js'),/require\("\.\/late"\)/);
 const files={'/start.ts':source,'/late.ts':'export const value=1;'};
 const warm=await compileBuildPlan(await planFor(files),{cache}),cold=await compileBuildPlan(await planFor(files));
 assert.deepEqual(warm.pack,cold.pack);assert.equal(warm.artifactId,cold.artifactId);
 assert.match(packedText(warm,'res://.godot/GodotJS/start.js'),/res:\/\/.godot\/GodotJS\/late.js/);
});

test('persistent language service updates missing modules, ambient declarations and SDK routes',()=>{
 const session=new ProjectLanguageService();
 const input={sources:{'/start.ts':'import {value} from "./late"; export const n:number=value;'},declarations:{}};
 let environment=createProjectTypeEnvironment(input),service=session.use(environment);
 assert(checkProjectTypes(environment,service).some(x=>x.code===2307));
 environment=createProjectTypeEnvironment({...input,sources:{...input.sources,'/late.ts':'export const value="wrong";'}});
 assert.equal(session.use(environment),service);assert(checkProjectTypes(environment,service).some(x=>x.code===2322));
 environment=createProjectTypeEnvironment({...input,sources:{...input.sources,'/late.ts':'export const value=1;'}});
 session.use(environment);assert(!checkProjectTypes(environment,service).some(x=>x.code===2307||x.code===2322));
 const routes={sources:{'/start.ts':'import {value} from "sdk"; export const n:number=value;'},declarations:{'/sdk-a.d.ts':'export const value:number;','/sdk-b.d.ts':'export const value:string;'}};
 environment=createProjectTypeEnvironment({...routes,moduleDeclarations:{sdk:'/sdk-a.d.ts'}});session.use(environment);assert(!checkProjectTypes(environment,service).some(x=>x.code===2322));
 environment=createProjectTypeEnvironment({...routes,moduleDeclarations:{sdk:'/sdk-b.d.ts'}});session.use(environment);assert(checkProjectTypes(environment,service).some(x=>x.code===2322));session.dispose();
});

test('cancellation after asynchronous preparation rejects publication while reusable deterministic work can finish',async()=>{
 const controller=new AbortController(),cache=new ProjectBuildCache(),plan=await planFor({'/start.ts':'export function start(){}'});
 let resume;const gate=new Promise(resolve=>{resume=resolve;});
 const build=compileBuildPlan(plan,{cache,signal:controller.signal,preparePlan:async(plan,options)=>{await gate;return prepareBuildPlan(plan,options);}});
 controller.abort(Error('superseded build'));resume();await assert.rejects(build,/superseded build/);
 const result=await compileBuildPlan(plan,{cache});assert(result.artifactId);assert(cache.metrics.emitHits>0);
});

test('ArtifactSet compilation is a distinct product and preserves resource pack identities across script edits',async()=>{
 const cache=new ProjectBuildCache(),environment=await createCompilerEnvironment({target:{artifactSetAbi:1,engineReleaseId:'e'.repeat(64)},declarations:{}});
 const files={'/start.ts':'export function start(){}','/asset.bin':new Uint8Array(128).fill(19)};
 const a=await compileBuildPlan(await planFor(files),{environment,cache,artifactSet:true});
 assert.equal(a.variant,'pack-set');assert(!Object.hasOwn(a,'pack'));assert(!Object.hasOwn(a,'index'));assert.equal(a.artifactId,a.artifactSet.manifest.artifactSetId);
 const b=await compileBuildPlan(await planFor({...files,'/start.ts':'export function start(){return 2}'}),{environment,cache,artifactSet:true});
 assert.deepEqual(a.artifactSet.manifest.resources,b.artifactSet.manifest.resources);
 assert.notEqual(a.artifactSet.manifest.bootstrap.sha256,b.artifactSet.manifest.bootstrap.sha256);
 assert(cache.metrics.packHits>0,'unchanged resource packs reuse their assembled bytes');
 await assert.rejects(compileBuildPlan(await planFor(files),{artifactSet:true}),/matched native target/);
});

test('semantic preparation inputs are captured before asynchronous build work starts',async()=>{
 const vendor=encoder.encode('module.exports={value:1};'),options={compilerOptions:{vendor},resourceLimits:{maxOutputBytes:4096}},engineVersion=[4,6,1];
 let resume;const gate=new Promise(resolve=>{resume=resolve;});
 const result=compileBuildPlan(await planFor({'/start.ts':'export function start(){}'}),{preparation:options,pack:{engineVersion},preparePlan:async(plan,preparation)=>{await gate;return prepareBuildPlan(plan,preparation);}});
 vendor.fill(0);options.resourceLimits.maxOutputBytes=1;engineVersion[2]=99;resume();
 const artifact=await result;assert.match(packedText(artifact,'res://.playground/vendor.js'),/value:1/);assert.equal(new DataView(artifact.pack.buffer).getUint32(16,true),1);
});

test('ArtifactSet package defaults are applied and captured before asynchronous preparation',async()=>{
 const environment=await createCompilerEnvironment({target:{artifactSetAbi:1},declarations:{}}),engineVersion=[4,6,2],cache=new ProjectBuildCache();
 let resume;const gate=new Promise(resolve=>{resume=resolve;});
 const pending=compileBuildPlan(await planFor({'/start.ts':'export function start(){}'}),{environment,artifactSet:{pack:{engineVersion},cache},preparePlan:async(plan,preparation)=>{await gate;return prepareBuildPlan(plan,preparation);}});
 engineVersion[2]=99;resume();const result=await pending;
 for(const bytes of result.artifactSet.packs.values())assert.equal(new DataView(bytes.buffer).getUint32(16,true),2);
 assert(cache.metrics.packBytesWritten>0);
});

test('explicit workspace deltas reuse untouched binary payloads without copying or hashing them',async()=>{
 const workspace=new ProjectWorkspace(),binary=new Uint8Array(4*1024*1024).fill(63);
 const initial=await workspace.capture({'/start.ts':'export function start(){}','/large.bin':binary}),before=ownedByteMetrics();binary.fill(0);
 const next=await workspace.captureChanges({'/start.ts':'export function start(){return 1}'}),after=ownedByteMetrics();
 assert.equal(initial.source.files.find(file=>file.path.endsWith('large.bin')),next.source.files.find(file=>file.path.endsWith('large.bin')));
 assert(after.bytesCopied-before.bytesCopied<1024);assert(after.bytesHashed-before.bytesHashed<1024);
 assert.equal(next.source.files.find(file=>file.path.endsWith('large.bin')).bytes[0],63);
 const deleted=await workspace.captureChanges({},['/large.bin']);assert(!deleted.source.files.some(file=>file.path.endsWith('large.bin')));
 initial.release();next.release();deleted.release();assert.equal(workspace.pendingSnapshots,0);
});


test('build snapshots reject non-roundtrippable source text without rewriting its original value',async()=>{
 const files={'/start.ts':'export const text="\ud800";'};
 await assert.rejects(createSourceSnapshot(files),error=>error.code==='E_PROJECT_TEXT');
 assert.equal(files['/start.ts'].charCodeAt('export const text="'.length),0xd800);
 const valid=await createSourceSnapshot({'/start.ts':'\ufeffexport const text="\ufffd";'});assert.equal(valid.files.length,1);
 assert.equal(snapshotFiles(valid)['res://start.ts'],'\ufeffexport const text="\ufffd";');
 await assert.rejects(createSourceSnapshot({'/start.ts':'😀😀a'},{maxBytes:8}),error=>error.code==='E_PROJECT_BUDGET');
});
