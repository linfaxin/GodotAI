import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {engineApiFixture} from './fixtures/engine-api-fixture.mjs';

const exec=promisify(execFile),require=createRequire(import.meta.url);
const packageRoot=fileURLToPath(new URL('..',import.meta.url));
const run=async(cmd,args,cwd)=>exec(cmd,args,{cwd,env:{...process.env,NODE_PATH:''},maxBuffer:8*1024*1024,timeout:120_000});

test('packed engine SDK works in an isolated consumer without React, workspace aliases or Node ambient types',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'godotjs-engine-consumer-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifacts=path.join(root,'artifacts'),consumer=path.join(root,'consumer');
 await mkdir(artifacts);await mkdir(consumer);
 const packed=JSON.parse((await run('npm',['pack','--json','--ignore-scripts','--pack-destination',artifacts],packageRoot)).stdout)[0];
 assert.equal(packed.name,'@godot-js/engine');
 assert(packed.files.every(file=>!file.path.startsWith('src/')&&!file.path.includes('node_modules/')));
 await writeFile(path.join(consumer,'package.json'),JSON.stringify({name:'isolated-engine-consumer',private:true,type:'module'}));
 await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',path.join(artifacts,packed.filename)],consumer);
 const installed=path.join(consumer,'node_modules/@godot-js/engine');
 assert.equal((await lstat(installed)).isSymbolicLink(),false);
 const manifest=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));
 assert.deepEqual(manifest.dependencies??{},{});assert.deepEqual(manifest.peerDependencies??{},{});
 const entries=Object.keys(manifest.exports);
 for(const [name,entry]of Object.entries(manifest.exports)){
  assert(packed.files.some(file=>file.path===entry.import.slice(2)),name+' runtime is in tarball');
  assert(packed.files.some(file=>file.path===entry.types.slice(2)),name+' declarations are in tarball');
 }
 assert.deepEqual((await readdir(path.join(consumer,'node_modules'))).filter(name=>!name.startsWith('.')),['@godot-js']);
 assert.deepEqual(await readdir(path.join(consumer,'node_modules/@godot-js')),['engine']);
 const execute=async(source,name='consumer.mjs')=>{
  await writeFile(path.join(consumer,name),source);
  return run(process.execPath,[name],consumer);
 };
 const compile=async(name,options,files)=>{
  const config=path.join(consumer,name+'.json');
  await writeFile(config,JSON.stringify({compilerOptions:{strict:true,skipLibCheck:false,noEmit:true,types:[],target:'ES2022',...options},files}));
  return run(process.execPath,[require.resolve('typescript/bin/tsc'),'--project',config],consumer);
 };

 await t.test('all published subpaths load without a DOM, Godot, React or compiler runtime',async()=>{
  const result=await execute(`import assert from 'node:assert/strict';
const names=${JSON.stringify(entries.map(name=>'@godot-js/engine'+name.slice(1)))};
for(const name of names){const value=await import(name);assert(Object.keys(value).length>0,name);}
for(const name of ['react','react-reconciler','scheduler','typescript','@godot-js/react','godot'])assert.throws(()=>import.meta.resolve(name),{code:'ERR_MODULE_NOT_FOUND'});
const api=await import('@godot-js/engine/api');assert.equal(typeof api.generateEngineDeclarations,'function');
const browser=await import('@godot-js/engine/browser');for(const name of ['BrowserEngineSession','PreviewRunner','validateRelease','fetchVerifiedAsset','validateExecution'])assert.equal(typeof browser[name],'function',name);
assert.equal(globalThis.document,undefined);console.log('isolated-imports-passed');`);
  assert.match(result.stdout,/isolated-imports-passed/);
 });

 await t.test('browser entry declarations resolve using only standard browser libraries',async()=>{
  await writeFile(path.join(consumer,'browser-consumer.mts'),`import {BrowserEngineSession,PreviewRunner,validateExecution,legacyExecution,type BrowserEngineSessionOptions,type PreviewRunnerOptions,type VerifiedRelease,type BrowserArtifact} from '@godot-js/engine/browser';
import {createRuntimeBinding,installRuntimeHost,getRuntimeHost,type RuntimeHost} from '@godot-js/engine/runtime';
import {createEngineIdentity,assertRuntimeTargetIdentity} from '@godot-js/engine/identities';
import {parseEngineApi,type EngineApiIR} from '@godot-js/engine/api';
const identity={runId:'run',revision:1,buildKey:'build',generation:'generation'};
const session:BrowserEngineSessionOptions={identity,executionModel:'proxy-pthread',requiresCrossOriginIsolation:true,onProgress(p){p.sequence.toFixed();}};
declare const release:VerifiedRelease;
declare const container:HTMLElement;
const runner:PreviewRunnerOptions={container,previewUrl:'https://preview.example/preview.html',release};
const artifact:BrowserArtifact={revision:1,buildKey:'build',generation:'generation',pack:new Uint8Array([1]),manifest:{}};
const host:RuntimeHost=createRuntimeBinding({sessionId:'run',role:'engine',onDiagnostic(d){d.message.toUpperCase();return true;}});
const scope={};const uninstall=installRuntimeHost(host,scope);getRuntimeHost(scope);uninstall();
validateExecution(legacyExecution());void BrowserEngineSession;void PreviewRunner;void artifact;void runner;void session;
void createEngineIdentity({wasm:'hash'});assertRuntimeTargetIdentity({engineId:'a'.repeat(64)},{engineId:'a'.repeat(64)});
declare const api:EngineApiIR;parseEngineApi(api);
// @ts-expect-error Engine consumers do not acquire Node ambient types.
process.cwd();
// @ts-expect-error The engine package does not install React types.
import type {ReactNode} from 'react';
// @ts-expect-error Target execution variants are checked.
const invalid:BrowserEngineSessionOptions={identity,executionModel:'desktop'};
`);
  await compile('browser-types',{module:'NodeNext',moduleResolution:'NodeNext',lib:['ES2022','DOM','DOM.Iterable']},['browser-consumer.mts']);
 });

 await t.test('generated engine declarations compile in an engine-only environment and reject invalid native calls',async()=>{
  await writeFile(path.join(consumer,'api-fixture.json'),JSON.stringify(engineApiFixture()));
  const result=await execute(`import assert from 'node:assert/strict';import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {generateEngineDeclarations} from '@godot-js/engine/api';
const api=JSON.parse(await readFile('./api-fixture.json','utf8')),generated=generateEngineDeclarations(api);
assert.equal(generated.diagnostics.length,0);for(const [name,text]of Object.entries(generated.files)){
assert(!/from\\s+['\"](?:react|@godot-js\\/react|node:)/.test(text),name);const target='generated'+name;await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true});await writeFile(target,text);
}console.log(JSON.stringify(generated.coverage));`,'generate.mjs');
  assert(JSON.parse(result.stdout).classes>=4);
  await writeFile(path.join(consumer,'engine-consumer.cts'),`import * as G from 'godot';
import {createClassBinder} from 'godot.annotations';
import {internal} from 'godot-jsb';
const actor=new G.Node2D();actor.translate(new G.Vector2(1,2));actor.add_child(new G.Node());
const bind=createClassBinder();void bind;void internal.get_engine_api();
const position:G.Vector2=actor.position;void position;
// @ts-expect-error Native method arguments retain their generated types.
actor.translate('wrong');
// @ts-expect-error Native readonly properties stay readonly.
new G.Timer().time_left=3;
// @ts-expect-error Method-only properties do not become arbitrary expandos.
actor.name='wrong';
// @ts-expect-error DOM is not an engine program ambient dependency.
document.body;
// @ts-expect-error Node is not an engine program ambient dependency.
process.cwd();
// @ts-expect-error React is optional and absent from the engine package.
import type {ReactNode} from 'react';
`);
  await compile('engine-types',{module:'CommonJS',lib:['ES2022']},['engine-consumer.cts','generated/godot/index.d.ts','generated/godot-jsb/index.d.ts','generated/godot.annotations/index.d.ts']);
 });

 await t.test('runtime contract declarations require only ES2022, without browser or Node ambient types',async()=>{
  await writeFile(path.join(consumer,'pure-runtime.mts'),`import {createRuntimeBinding,type RuntimeHost,type ProjectData} from '@godot-js/engine/runtime';
import {createSessionFacts,sessionExitReason} from '@godot-js/engine/session-facts';
const host:RuntimeHost=createRuntimeBinding({sessionId:'pure',role:'engine'});const data:ProjectData={x:[1,'value']};host.emitProjectEvent(data);sessionExitReason(createSessionFacts());
// @ts-expect-error Runtime services do not install DOM ambient declarations.
document.body;
// @ts-expect-error Runtime services do not install Node ambient declarations.
process.cwd();
`);
  await compile('pure-runtime',{lib:['ES2022']},['pure-runtime.mts']);
 });

 await t.test('runtime hosts and execution/identity validation remain usable without React',async()=>{
  const result=await execute(`import assert from 'node:assert/strict';
import {createRuntimeBinding,installRuntimeHost,getRuntimeHost} from '@godot-js/engine/runtime';
import {validateExecution} from '@godot-js/engine/execution';
import {createEngineIdentity,createBuildKey,assertRuntimeTargetIdentity} from '@godot-js/engine/identities';
const scope={},received=[];const a=createRuntimeBinding({sessionId:'a',role:'engine',onDiagnostic(d){received.push(d.message);return true;}}),b=createRuntimeBinding({sessionId:'b',role:'engine'});
const dropA=installRuntimeHost(a,scope);assert.throws(()=>installRuntimeHost(b,scope),/E_RUNTIME_HOST_IN_USE/);assert.equal(getRuntimeHost(scope),a);assert(getRuntimeHost(scope).reportDiagnostic({kind:'runtime',message:'engine-only'}));dropA();const dropB=installRuntimeHost(b,scope);dropA();assert.equal(getRuntimeHost(scope),b);dropB();assert.throws(()=>getRuntimeHost(scope),/E_RUNTIME_HOST/);assert.deepEqual(received,['engine-only']);
const execution={schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded'};validateExecution(execution);assert.throws(()=>validateExecution({...execution,requiresCrossOriginIsolation:false}),/E_EXECUTION_CONTRACT/);
const first=await createEngineIdentity({wasm:'a',host:'b'}),second=await createEngineIdentity({host:'b',wasm:'a'});assert.equal(first,second);assert.match(first,/^[a-f0-9]{64}$/);assert.throws(()=>createEngineIdentity({react:'required'}),/E_IDENTITY_SELF_REFERENCE/);
assertRuntimeTargetIdentity({engineId:first},{engineId:first});assert.throws(()=>assertRuntimeTargetIdentity({engineId:first},{engineId:'c'.repeat(64)}),/E_RUNTIME_TARGET_ENGINE/);
assert.match(await createBuildKey({source:'project',engineId:first}),/^[a-f0-9]{64}$/);console.log('engine-runtime-passed');`,'runtime.mjs');
  assert.match(result.stdout,/engine-runtime-passed/);
 });
});
