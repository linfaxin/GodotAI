import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {compileNodeProject,prepareNodeProject,checkNodeProject} from '../dist/node/compiler.js';
import {prepareBuildPlan} from '../dist/build-plan.js';
import {hashJson} from '../dist/hash.js';
import {createEngineIdentity,nativeEngineIdentityInputs,createExtensionIdentity,nativeExtensionIdentityInputs} from '@godot-js/engine/identities';
import {nativeReleaseFixture,sealRelease} from '../../engine/test/fixtures/native-release.mjs';

let libraries;
async function standardLibraries(){
 if(libraries)return libraries;
 const root=path.dirname(ts.getDefaultLibFilePath({target:ts.ScriptTarget.ES2022})),files={};
 const load=async name=>{const file='lib.'+name+'.d.ts',key='/lib/'+file;if(files[key])return;const text=await readFile(path.join(root,file),'utf8');files[key]=text;await Promise.all([...text.matchAll(/<reference lib="([^"]+)"/g)].map(match=>load(match[1])));};
 await load('es2022');return libraries=files;
}
const document=version=>({schemaVersion:4,runtime:'engine',engineProfile:'engine-2d-v1',launch:{kind:'script',module:'/start.ts'},files:{'/start.ts':`export const version=${version};export function start(){}`, '/asset.bin':[1,2,3]}});
async function fixture(t,{set=false}={}){
 const release=await nativeReleaseFixture(),types={...release.types,...await standardLibraries()};
 if(set){release.manifest.execution.artifactSetAbi=1;release.manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(release.manifest));}
 release.manifest.api.typeSnapshot=release.asset('types.json',JSON.stringify(types));
 release.manifest.api.namingProfiles.snake.typeSnapshot=release.manifest.api.typeSnapshot;
 release.manifest.sdk.typesHash=await hashJson(Object.fromEntries(Object.entries(types).filter(([name])=>name!=='/godot/index.d.ts')));
 release.manifest.extensionId=await createExtensionIdentity(nativeExtensionIdentityInputs(release.manifest));sealRelease(release.manifest);
 const directory=await mkdtemp(path.join(tmpdir(),'godotjs-output-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const [name,bytes]of release.files){const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
 const manifest=path.join(directory,'engine-release.json'),project=path.join(directory,'project.json');
 await writeFile(manifest,JSON.stringify(release.manifest));await writeFile(project,JSON.stringify(document(1)));
 return {directory,project,release:manifest};
}
function barrier(){
 let entered,release;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 return {started,release,async prepare(plan,options){entered();await blocked;return prepareBuildPlan(plan,options);}};
}
const absent=async file=>{try{await stat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}};

test('an older output keeps its captured destination when caller options change to a newer output',async t=>{
 const f=await fixture(t),a=path.join(f.directory,'a.pck'),b=path.join(f.directory,'b.pck'),pause=barrier();
 const options={project:f.project,release:f.release,output:a,preparePlan:pause.prepare};
 const slow=compileNodeProject(options);await pause.started;
 await writeFile(f.project,JSON.stringify(document(2)));
 const latest=await compileNodeProject({project:f.project,release:f.release,output:b});
 options.output=b;options.preparePlan=()=>{throw Error('late callback must not be read');};pause.release();
 const original=await slow;assert.notEqual(original.artifactId,latest.artifactId);
 assert.deepEqual(new Uint8Array(await readFile(a)),original.pack);
 assert.deepEqual(new Uint8Array(await readFile(b)),latest.pack);
 assert.equal(JSON.parse(await readFile(b+'.receipt.json','utf8')).artifactId,latest.artifactId);
});

test('a superseded output cannot escape its original ticket by changing to another destination',async t=>{
 const f=await fixture(t),a=path.join(f.directory,'same.pck'),b=path.join(f.directory,'escape.pck'),pause=barrier();
 const options={project:f.project,release:f.release,output:a,preparePlan:pause.prepare};
 const slow=compileNodeProject(options);await pause.started;
 await writeFile(f.project,JSON.stringify(document(2)));
 const latest=await compileNodeProject({project:f.project,release:f.release,output:a});
 options.output=b;pause.release();await assert.rejects(slow,error=>error.code==='E_BUILD_SUPERSEDED');
 assert.deepEqual(new Uint8Array(await readFile(a)),latest.pack);assert(await absent(b));
});

test('ArtifactSet publication retains the captured directory and variant after late option changes',async t=>{
 const f=await fixture(t,{set:true}),a=path.join(f.directory,'set-a'),b=path.join(f.directory,'set-b'),pause=barrier();
 const options={project:f.project,release:f.release,artifactSetDirectory:a,preparePlan:pause.prepare};
 const slow=compileNodeProject(options);await pause.started;
 await writeFile(f.project,JSON.stringify(document(2)));
 const latest=await compileNodeProject({project:f.project,release:f.release,artifactSetDirectory:b});
 options.artifactSetDirectory=b;options.output=path.join(f.directory,'late-single.pck');pause.release();
 const original=await slow;assert.notEqual(original.artifactId,latest.artifactId);
 assert.equal(JSON.parse(await readFile(path.join(a,'artifact-set.json'),'utf8')).artifactSetId,original.artifactId);
 assert.equal(JSON.parse(await readFile(path.join(b,'artifact-set.json'),'utf8')).artifactSetId,latest.artifactId);
 assert.deepEqual(new Uint8Array(await readFile(path.join(b,latest.artifactSet.manifest.bootstrap.path))),latest.artifactSet.packs.get(latest.artifactSet.manifest.bootstrap.sha256));
 assert(await absent(options.output));
});

test('the originally captured AbortSignal still cancels publication after the caller replaces it',async t=>{
 const f=await fixture(t),output=path.join(f.directory,'cancelled.pck'),pause=barrier(),original=new AbortController(),replacement=new AbortController();
 const options={project:f.project,release:f.release,output,preparePlan:pause.prepare,signal:original.signal};
 const slow=compileNodeProject(options);await pause.started;
 options.signal=replacement.signal;original.abort(Error('original cancellation wins'));pause.release();
 await assert.rejects(slow,/original cancellation wins/);assert(await absent(output));
});

test('replacing options with an aborted signal does not cancel the captured invocation',async t=>{
 const f=await fixture(t),output=path.join(f.directory,'original-signal.pck'),pause=barrier(),original=new AbortController(),replacement=new AbortController();
 const options={project:f.project,release:f.release,output,preparePlan:pause.prepare,signal:original.signal};
 const slow=compileNodeProject(options);await pause.started;
 options.signal=replacement.signal;replacement.abort(Error('replacement is unrelated'));pause.release();
 const result=await slow;assert.deepEqual(new Uint8Array(await readFile(output)),result.pack);
});

test('relative publication paths keep the invocation cwd even if it changes while compiling',async t=>{
 const f=await fixture(t),other=path.join(f.directory,'other'),pause=barrier(),previous=process.cwd();await mkdir(other);
 try{
  process.chdir(f.directory);
  const slow=compileNodeProject({project:'project.json',release:'engine-release.json',output:'out/game.pck',preparePlan:pause.prepare});
  await pause.started;process.chdir(other);pause.release();const result=await slow;
  assert.deepEqual(new Uint8Array(await readFile(path.join(f.directory,'out/game.pck'))),result.pack);
  assert(await absent(path.join(other,'out/game.pck')));
 }finally{pause.release();process.chdir(previous);}
});

test('prepare and check own their project and release options before initial I/O',async t=>{
 const f=await fixture(t);
 for(const run of [prepareNodeProject,checkNodeProject]){
  const options={project:f.project,release:f.release};const pending=run(options);
  options.project=path.join(f.directory,'missing-project');options.release=path.join(f.directory,'missing-release');
  const result=await pending;
  if(run===prepareNodeProject){assert(result.plan.snapshot.files.some(file=>file.path==='res://start.ts'));result.releaseSnapshot();}
  else assert.equal(result.ok,true);
 }
});

test('directory launch data is captured before asynchronous preparation',async t=>{
 const f=await fixture(t),source=path.join(f.directory,'directory');await mkdir(source);await writeFile(path.join(source,'start.ts'),'export function start(){}');
 const launch={kind:'script',module:'/start.ts'},options={project:source,release:f.release,launch};
 const pending=prepareNodeProject(options);launch.module='/missing.ts';launch.kind='scene';options.launch={kind:'scene',source:'project'};
 const request=await pending;try{assert.deepEqual(request.plan.launch,{kind:'script',module:'res://start.ts',export:'start'});}finally{request.releaseSnapshot();}
});

test('an invalid output request cannot supersede an admitted build ticket',async t=>{
 const f=await fixture(t),output=path.join(f.directory,'valid.pck'),pause=barrier();
 const slow=compileNodeProject({project:f.project,release:f.release,output,preparePlan:pause.prepare});await pause.started;
 await assert.rejects(compileNodeProject({project:f.project,release:f.release,output,artifactSetDirectory:path.join(f.directory,'invalid-set')}),error=>error.code==='E_COMPILER_OUTPUT');
 pause.release();const result=await slow;assert.deepEqual(new Uint8Array(await readFile(output)),result.pack);
});

for(const [olderSet,newerSet]of [[true,false],[false,true],[true,true]])test(`overlapping publication ranges supersede old builds (${olderSet?'set':'single'} -> ${newerSet?'set':'single'})`,async t=>{
 const f=await fixture(t,{set:true}),directory=path.join(f.directory,'shared'),pause=barrier();
 const oldDestination=olderSet?{artifactSetDirectory:directory}:{output:path.join(directory,'application.pck')};
 const newDirectory=olderSet&&newerSet?path.join(directory,'nested'):directory;
 const newDestination=newerSet?{artifactSetDirectory:newDirectory}:{output:path.join(directory,'application.pck')};
 const slow=compileNodeProject({project:f.project,release:f.release,...oldDestination,preparePlan:pause.prepare});await pause.started;
 await writeFile(f.project,JSON.stringify(document(2)));
 const latest=await compileNodeProject({project:f.project,release:f.release,...newDestination});
 const filename=newerSet?path.join(newDirectory,latest.artifactSet.manifest.bootstrap.path):newDestination.output;
 const bytes=await readFile(filename),manifest=await readFile(filename+'.manifest.json');
 pause.release();await assert.rejects(slow,error=>error.code==='E_BUILD_SUPERSEDED');
 assert.deepEqual(await readFile(filename),bytes);assert.deepEqual(await readFile(filename+'.manifest.json'),manifest);
});

test('single-PCK sidecars also participate in publication ownership',async t=>{
 const f=await fixture(t),output=path.join(f.directory,'game.pck'),pause=barrier();
 const slow=compileNodeProject({project:f.project,release:f.release,output,preparePlan:pause.prepare});await pause.started;
 const latest=await compileNodeProject({project:f.project,release:f.release,output:output+'.manifest.json'});
 pause.release();await assert.rejects(slow,error=>error.code==='E_BUILD_SUPERSEDED');
 assert.deepEqual(new Uint8Array(await readFile(output+'.manifest.json')),latest.pack);
});

test('sibling output directories with a common prefix can publish independently',async t=>{
 const f=await fixture(t,{set:true}),directory=path.join(f.directory,'set'),pause=barrier();
 const slow=compileNodeProject({project:f.project,release:f.release,artifactSetDirectory:directory,preparePlan:pause.prepare});await pause.started;
 await compileNodeProject({project:f.project,release:f.release,output:directory+'-other/application.pck'});
 pause.release();assert.equal((await slow).variant,'pack-set');
});


test('directory symlink aliases share publication ownership',async t=>{
 const f=await fixture(t,{set:true}),directory=path.join(f.directory,'real'),alias=path.join(f.directory,'alias'),pause=barrier();
 await mkdir(directory);await symlink(directory,alias,'dir');
 const slow=compileNodeProject({project:f.project,release:f.release,artifactSetDirectory:directory,preparePlan:pause.prepare});await pause.started;
 await writeFile(f.project,JSON.stringify(document(2)));
 const latest=await compileNodeProject({project:f.project,release:f.release,output:path.join(alias,'application.pck')});
 pause.release();await assert.rejects(slow,error=>error.code==='E_BUILD_SUPERSEDED');
 assert.deepEqual(new Uint8Array(await readFile(path.join(directory,'application.pck'))),latest.pack);
});
