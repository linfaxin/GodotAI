import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {build} from 'esbuild';
import {createCompilerEnvironment} from '@godot-js/project-tools/compiler';
import {createSourceSnapshot} from '@godot-js/project-tools/build-plan';
import {packProject,readPckIndex} from '@godot-js/project-tools/pck';
import {compileEngineProject} from '../src/engine-project.ts';

const require=createRequire(import.meta.url),encode=value=>new TextEncoder().encode(value);
const externalModules=['typescript','@godot-js/react-build/imports','@godot-js/project-tools/type-environment','@godot-js/project-tools/compiler',
 '@godot-js/project-tools/project-settings','@godot-js/project-tools/errors','@godot-js/project-tools/script-renames','@godot-js/project-tools/resource-converters',
 '@godot-js/project-tools/engine-project','@godot-js/project-tools/build-plan','@godot-js/project-tools/artifact-set','@godot-js/project-tools/resource-uids',
 '@godot-js/project-tools/script-bindings','@godot-js/project-tools/project-modules','@godot-js/engine/pck-index','@godot-js/react-build/core'];
let libraries,bundle;
async function standardLibraries(){
 if(libraries)return libraries;
 const root=path.dirname(ts.getDefaultLibFilePath({target:ts.ScriptTarget.ES2022})),files={};
 const load=async name=>{
  const filename='lib.'+name+'.d.ts',virtual='/lib/'+filename;
  if(Object.hasOwn(files,virtual))return;
  const source=await readFile(path.join(root,filename),'utf8');files[virtual]=source;
  await Promise.all([...source.matchAll(/<reference lib="([^"]+)"/g)].map(match=>load(match[1])));
 };
 await load('es2022');libraries=files;return files;
}
function packedText(pack,name){
 const entry=readPckIndex(pack).entries.find(entry=>entry.path===name);assert(entry,name);
 return new TextDecoder().decode(pack.subarray(entry.offset,entry.offset+entry.bytes));
}

test('production project compilation checks the pinned source, while packing fixtures remain unchecked',async()=>{
 const environment=await createCompilerEnvironment({target:{naming:'snake'},declarations:await standardLibraries()});
 const files={'/start.ts':'export function start(){const value:number=42;return value}'};
 const sourceSnapshot=await createSourceSnapshot(files);
 files['/start.ts']='export function start(){const value:number="wrong";return value}';
 const request={runtime:'engine',launch:{kind:'script',module:'/start.ts'},files,compilerEnvironment:environment};
 const original=await compileEngineProject({...request,sourceSnapshot});
 assert.equal(original.sourceHash,sourceSnapshot.sourceHash);
 assert.match(packedText(original.pack,'res://start.ts'),/value:number=42/);
 await assert.rejects(compileEngineProject(request),error=>error.diagnostics?.some(item=>item.code===2322&&item.file==='/start.ts'));
 const {compilerEnvironment,...unchecked}=request;
 assert.equal((await compileEngineProject(unchecked)).variant,'single-pack');
});

test('checked legacy project compilation retains its startup adapter and props',async()=>{
 const environment=await createCompilerEnvironment({target:{naming:'snake'},declarations:await standardLibraries(),vendor:encode('exports.React={};exports.engineReact={};')});
 const result=await compileEngineProject({runtime:'react',entry:'/App.ts',files:{'/App.ts':'export default function App(){return null}'},
  compilerEnvironment:environment,props:{controls:{jump:7}}});
 assert.equal(result.plan.compatibility.runtime,'react');
 assert.match(packedText(result.pack,'res://.playground/engine-bootstrap.ts'),/"controls":\{"jump":7\}/);
 assert.deepEqual(result.diagnostics,[]);
});

async function workerBundle(){
 if(bundle)return bundle;
 // Stub release I/O and the already-tested release helper, keeping the real
 // Worker, final environment, source composer, checker and compiler pipeline.
 const result=await build({entryPoints:[fileURLToPath(new URL('../src/compiler.worker.ts',import.meta.url))],bundle:true,format:'cjs',platform:'node',write:false,
  external:externalModules,
  plugins:[{name:'release-fixture',setup(build){
   build.onResolve({filter:/^\.\/engine-assets$/},()=>({path:'assets',namespace:'fixture'}));
   build.onResolve({filter:/^@godot-js\/project-tools\/environment$/},()=>({path:'environment',namespace:'fixture'}));
   build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='assets'?`
export async function initializeReleaseContext(){return {...fixture.context}}
export async function loadReleaseInputs(){return {descriptorBytes:new Uint8Array([1,2,3])}}
export const readReleaseRawAsset=async()=>{throw Error('unexpected I/O')};
export async function loadDemoDeclarations(){return 'export function used():void;'}
export async function loadDemoRuntime(){return fixture.demo}
`:`
export async function prepareCompilerEnvironmentInput(options){
 const f=fixture;f.calls.push(options);await f.beforePrepare?.(options);options.signal?.throwIfAborted();
 const release={releaseId:f.context.engineReleaseId,descriptorSha256:f.context.descriptorHash,engineProfile:f.context.engineProfile};
 return {input:{target:{engineReleaseId:release.releaseId,engineProfile:release.engineProfile,naming:options.naming},declarations:f.declarations,
 moduleDeclarations:{godot:'/godot/index.d.ts'},runtimeModules:{},...(options.selection.kind==='sdk'?{vendor:new TextEncoder().encode('exports.React={};exports.engineReact={};')}:{})},
 facts:{release,naming:options.naming,selection:options.selection,baseRuntimeModules:[],api:{status:'unknown'},resources:{status:'unknown',reason:'fixture target'},
 compilerPolicy:'fixture',typescriptVersion:'fixture',assetReadLimits:{maxStoredBytes:67108864,maxDecodedBytes:67108864}}};
}
`}));
  }}]});
 bundle=result.outputFiles[0].text;return bundle;
}
async function workerFixture(){
 const fixture={context:{engineProfile:'full-engine-v1',engineReleaseId:'r'.repeat(64),descriptorHash:'d'.repeat(64),releaseRoot:'https://fixture.example/'},
  declarations:{...await standardLibraries(),'/godot/index.d.ts':'export class Node {}'},calls:[],
  demo:{runtime:encode('exports.used=()=>{};'),resources:packProject(new Map()).pack,demoDescriptorHash:'m'.repeat(64),demoApiVersion:1}};
 const messages=[],self={postMessage(value,transfer=[]){messages.push(structuredClone(value,{transfer}))}};
 // Public entries deliberately publish the import condition, not a require
 // condition. Resolve them through ESM before evaluating the isolated Worker.
 const imports=new Map(await Promise.all(externalModules.filter(name=>name!=='typescript').map(async name=>[name,await import(name)])));
 const fixtureRequire=name=>imports.has(name)?imports.get(name):require(name);
 // Keep the SDK's plain-object realm while giving each Worker its own module
 // closure and self. No globals or module caches are replaced by this fixture.
 new Function('require','self','fixture',await workerBundle())(fixtureRequire,self,fixture);
 const request=async fields=>{
  await self.onmessage({data:{id:1,runtime:'engine',engineProfile:'full-engine-v1',releaseContext:fixture.context,
   launch:{kind:'script',module:'/start.ts'},documentId:'document',revision:1,...fields}});
  return messages.findLast(message=>message.id===(fields.id??1));
 };
 return {fixture,messages,request};
}

test('Worker check and build share final demo environment and composed source identity',async()=>{
 const {fixture,request}=await workerFixture();
 const files={'/start.ts':'import {used} from "@playground/api";export function start(){used()}'};
 const checked=await request({kind:'check',files});assert.deepEqual(checked.diagnostics,[]);assert.equal(checked.error,undefined);
 const built=await request({id:2,kind:'compile',files});assert.equal(built.error,undefined);assert.deepEqual(built.diagnostics,[]);
 assert.equal(checked.sourceHash,built.manifest.sourceHash);assert.equal(checked.sourceHash,built.sourceHash);
 assert.deepEqual(checked.compilerIdentity,built.compilerIdentity);assert.deepEqual(checked.environmentFacts.baseRuntimeModules,[]);
 assert.equal(typeof checked.compilerIdentity.runtimeModules['@playground/api'],'string');
 assert.match(packedText(built.pack,'res://.playground/demo-input.ts'),/class PlaygroundInput/);
 assert.equal(fixture.calls.length,1,'a completed final environment is reused');
 assert.deepEqual(fixture.calls[0].selection,{kind:'sdk',mode:'production'});
});

test('Worker type errors retain source and final environment association without duplicate diagnostics',async()=>{
 const {request}=await workerFixture(),files={'/start.ts':'export function start(){const value:number="wrong";return value}'};
 const checked=await request({kind:'check',files}),built=await request({id:2,kind:'compile',files});
 assert.equal(checked.diagnostics.filter(item=>item.code===2322).length,1);
 assert.equal(built.diagnostics.filter(item=>item.code===2322).length,1);assert.equal(built.pack,undefined);
 assert.equal(built.sourceHash,checked.sourceHash);assert.deepEqual(built.compilerIdentity,checked.compilerIdentity);
 // Type queries do not acquire a launch/scene prerequisite.
 const query=await request({id:3,kind:'hover',launch:undefined,path:'/start.ts',offset:16,files});
 assert.equal(query.error,undefined);assert(query.result);
});

test('Worker replies retain the structured code when the resource target cannot compile',async()=>{
 const {request}=await workerFixture();
 const result=await request({kind:'compile',files:{'/start.ts':'export function start(){}'},
  resourceImports:[{resource:'res://asset.png',converter:'fixture'}]});
 assert.equal(result.errorCode,'E_RESOURCE_CONVERTER_TARGET');
 assert.equal(result.diagnostics[0].code,result.errorCode);
 assert.equal(result.pack,undefined);
});

test('a superseded pending Worker environment cannot cancel or poison a newer request',async()=>{
 const {fixture,request}=await workerFixture(),files={'/start.ts':'export function start(){}'};
 let entered,resume;
 const started=new Promise(resolve=>entered=resolve),paused=new Promise(resolve=>resume=resolve);
 fixture.beforePrepare=async()=>{if(fixture.calls.length===1){entered();await paused}};
 const first=request({id:1,kind:'compile',files});await started;
 const second=await request({id:2,kind:'compile',revision:2,files});assert.equal(second.error,undefined);assert(second.pack);
 resume();const old=await first;assert.equal(old.cancelled,true);assert.equal(old.error,'E_BUILD_SUPERSEDED');assert.equal(old.pack,undefined);
 assert.equal(fixture.calls.length,2);assert.equal(fixture.calls[0].signal.aborted,true);assert.equal(fixture.calls[1].signal.aborted,false);
 const checked=await request({id:3,kind:'check',revision:2,files});assert.deepEqual(checked.diagnostics,[]);
 assert.equal(fixture.calls.length,2,'only the completed environment is reused');
});
