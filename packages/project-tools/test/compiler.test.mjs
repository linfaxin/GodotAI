import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {build} from 'esbuild';
import {createCompilerEnvironment, compileBuildPlan, compileProject,compileResultMetadata,ProjectBuildCache} from '../dist/compiler.js';
import {createProjectTypeEnvironment, checkProjectTypes} from '../dist/type-environment.js';
import {engineCheckOptions, engineEmitOptions} from '../dist/compiler-policy.js';
import {createSourceSnapshot, createBuildPlan, adaptLegacyLaunch, prepareBuildPlan} from '../dist/build-plan.js';
import {prepareNodeProject, checkNodeProject, compileNodeProject} from '../dist/node/compiler.js';
import {hashJson,hashBytes} from '../dist/hash.js';
import {createBrowserResourceConverters,createResourceExecutionCache,encodeRgbaPng,BINARY_RESOURCE_TARGET_ABI} from '../dist/resource-converters.js';
import {assessStoredImportReceipt} from '../dist/import-receipts.js';
import {readPckIndex} from '@godot-js/engine/pck-index';
import {createExtensionIdentity, nativeExtensionIdentityInputs,createEngineIdentity,nativeEngineIdentityInputs} from '@godot-js/engine/identities';
import {nativeReleaseFixture, sealRelease} from '../../engine/test/fixtures/native-release.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const libRoot = path.dirname(ts.getDefaultLibFilePath({target: ts.ScriptTarget.ES2022}));
let libraries;
async function standardLibraries() {
  if (libraries) return libraries;
  const files = {};
  const load = async name => {
    const filename = 'lib.' + name + '.d.ts', virtual = '/lib/' + filename;
    if (files[virtual]) return;
    const source = await readFile(path.join(libRoot, filename), 'utf8'); files[virtual] = source;
    await Promise.all([...source.matchAll(/<reference lib="([^"]+)"/g)].map(match => load(match[1])));
  };
  await load('es2022'); libraries = files; return files;
}
const source = () => ({'/start.ts': 'import {value} from "res://value.ts"; import config from "./config.json"; export function start(){ if(value!==config.value)throw Error("wrong") }', '/value.ts': 'export const value=42;', '/config.json': '{"value":42}'});
const planFor = async files => createBuildPlan(await createSourceSnapshot(files), {kind: 'script', module: '/start.ts'});
const readPacked = (artifact, name) => { const item = artifact.index[name]; assert(item, name); return decoder.decode(artifact.pack.subarray(item.offset, item.offset + item.size)); };
async function environment(overrides = {}) {
  return createCompilerEnvironment({target: {engineId: 'e'.repeat(64), naming: 'snake'}, declarations: await standardLibraries(), ...overrides});
}

test('versioned policy derives distinct checking/emitting settings and virtual checking cannot load Node ambient types', async () => {
  assert.equal(engineCheckOptions().noEmit, true); assert.equal(engineCheckOptions().rewriteRelativeImportExtensions, false);
  assert.equal(engineEmitOptions().module, ts.ModuleKind.CommonJS); assert.equal(engineEmitOptions().rewriteRelativeImportExtensions, true);
  assert.throws(() => engineCheckOptions({id: 'unknown'}), /E_COMPILER_POLICY/);
  const types = createProjectTypeEnvironment({sources: {...source(), '/unrelated.json': '{bad'}, declarations: await standardLibraries()});
  assert.deepEqual(checkProjectTypes(types), []);
  const service = types.createLanguageService();
  try { assert(service.getQuickInfoAtPosition('/value.ts', 'export const '.length + 1)); } finally { service.dispose(); }
  const invalid = createProjectTypeEnvironment({sources: {'/start.ts': 'export const value=process.version;'}, declarations: await standardLibraries()});
  assert(checkProjectTypes(invalid).some(item => item.category === 'error' && /process/.test(item.message)));
  const badJson = createProjectTypeEnvironment({sources: {...source(), '/config.json': '{bad'}, declarations: await standardLibraries()});
  assert(checkProjectTypes(badJson).some(item => item.file === '/config.json' && item.category === 'error'));
});

test('type view normalizes res paths, owns declarations and rejects shadowing of the target API', async () => {
  const declarations = {...await standardLibraries(), '/godot/index.d.ts': 'export class Node { readonly name: string }'};
  const types = createProjectTypeEnvironment({sources: {'res://start.ts': 'import {Node} from "godot"; export const node = new Node();'}, declarations, moduleDeclarations: {godot: '/godot/index.d.ts'}});
  declarations['/godot/index.d.ts'] = 'bad'; assert.deepEqual(checkProjectTypes(types), []);
  assert.throws(() => types.options.lib.push('lib.dom.d.ts'), TypeError);
  assert.throws(() => createProjectTypeEnvironment({sources: {'/godot/index.d.ts': 'forged'}, declarations}), /shadows/);
});

test('compiler environment captures actual bytes before hashing and full build checks the supplied plan snapshot', async () => {
  const module = encoder.encode('exports.value=42;'), original = module.slice();
  const declarations = await standardLibraries();
  const promise = createCompilerEnvironment({target: {engineId: 'e'.repeat(64), naming: 'snake'}, declarations, runtimeModules: {'@runtime/test': module}}); module.fill(0);
  const env = await promise;
  assert.deepEqual(env.runtimeModules['@runtime/test'], original);
  env.runtimeModules['@runtime/test'].fill(1); assert.deepEqual(env.runtimeModules['@runtime/test'], original);
  const changed = await environment({runtimeModules: {'@runtime/test': encoder.encode('exports.value=43;')}});
  assert.notDeepEqual(changed.identity, env.identity);
  const files = source(), plan = await planFor(files); files['/start.ts'] = 'this is invalid';
  const artifact = await compileProject({plan, environment: env});
  assert.match(readPacked(artifact, 'res://.godot/GodotJS/start.js'), /config/);
  assert.match(readPacked(artifact, 'res://.playground/engine-bootstrap.ts'), /Script entry must export a start function/);
  const wrong = await planFor({...source(), '/value.ts': 'export const value: number = "wrong";'});
  await assert.rejects(compileProject({plan: wrong, environment: env}), error => error.diagnostics?.some(item => item.file === '/value.ts'));
});

test('artifact facade preserves legacy class/component launch metadata for an injected current-renderer adapter', async () => {
  const classPlan = await adaptLegacyLaunch({schemaVersion: 3, runtime: 'godot', entry: '/Main.ts', files: {'/Main.ts': 'export default class Main {}'}});
  const native = await compileBuildPlan(classPlan);
  assert.match(readPacked(native, 'res://.playground/engine-bootstrap.ts'), /Native entry must export a Godot Node class/);
  const component = await adaptLegacyLaunch({schemaVersion: 3, runtime: 'react', entry: '/App.tsx', mainScene: '/main.tscn', files: {'/App.tsx': 'export default function App(){return null}', '/main.tscn': '[gd_scene format=3]\n[node name="Main" type="Node"]\n'}});
  const {prepareLegacyBuildPlan} = await import('../../../scripts/jsb.react-build/dist/core/engine-project.js');
  let called = false;
  const artifact = await compileBuildPlan(component, {preparation: {compilerOptions: {runtimeModules: {
    react: encoder.encode('exports.createElement=()=>null;'), '@godot-js/react/engine': encoder.encode('exports.createRoot=()=>({});'),
  }}}, preparePlan(plan, options) {
    called = true; assert.equal(plan.compatibility.runtime, 'react'); assert.equal(plan.launch.export, 'default');
    return prepareLegacyBuildPlan(plan, options);
  }});
  assert(called); assert.match(readPacked(artifact, 'res://.playground/engine-bootstrap.ts'), /EngineReact.createRoot/);
  // No adapter is inferred from a component-shaped default function.
  await assert.rejects(compileBuildPlan(component), /adapter/);
});

async function localRelease(t,{artifactSetAbi,historicalSdk}={}) {
  const fixture = await nativeReleaseFixture();
  if(artifactSetAbi){fixture.manifest.execution.artifactSetAbi=artifactSetAbi;fixture.manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(fixture.manifest));}
  let suppliedTypes=fixture.types;
  if(historicalSdk){
   const {createTypeSnapshot}=await import('../../../apps/playground/scripts/build-shell.mjs');
   const {buildEngineVendor,FULL_ENGINE_MODULE_CONTRACT,FULL_ENGINE_MODULE_EXPORTS,runtimeModuleSource}=await import('../../../apps/playground/scripts/full-engine-release.mjs');
   suppliedTypes=JSON.parse(await createTypeSnapshot({engineFiles:{...fixture.engineTypes,'/godot-jsb/index.d.ts':'export {};','/godot.annotations/index.d.ts':'export {};'}}));
   fixture.manifest.sdk.moduleContract=FULL_ENGINE_MODULE_CONTRACT;fixture.manifest.sdk.moduleExports=FULL_ENGINE_MODULE_EXPORTS;
   fixture.manifest.sdk.runtimeModules=Object.fromEntries(Object.entries(FULL_ENGINE_MODULE_EXPORTS).map(([name,member],index)=>[name,fixture.asset('runtime-'+index+'.js',runtimeModuleSource(member))]));
   const production=await buildEngineVendor({mode:'production'});fixture.manifest.sdk.vendor=fixture.asset('.playground/vendor.js',production);fixture.manifest.sdk.vendors={production:fixture.manifest.sdk.vendor,development:fixture.manifest.sdk.vendor};
  }
  const types = {...suppliedTypes, ...await standardLibraries()};
  fixture.manifest.api.typeSnapshot = fixture.asset('types.json', JSON.stringify(types));
  fixture.manifest.api.namingProfiles.snake.typeSnapshot = fixture.manifest.api.typeSnapshot;
  fixture.manifest.sdk.typesHash = await hashJson(Object.fromEntries(Object.entries(types).filter(([name]) => name !== '/godot/index.d.ts')));
  fixture.manifest.extensionId = await createExtensionIdentity(nativeExtensionIdentityInputs(fixture.manifest)); sealRelease(fixture.manifest);
  const directory = await mkdtemp(path.join(tmpdir(), 'godotjs-node-compiler-')); t.after(() => rm(directory, {recursive: true, force: true}));
  for (const [name, bytes] of fixture.files) { const filename = path.join(directory, name); await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, bytes); }
  const release = path.join(directory, 'engine-release.json'); await writeFile(release, JSON.stringify(fixture.manifest));
  const project = path.join(directory, 'project.json'); await writeFile(project, JSON.stringify({schemaVersion: 4, runtime: 'engine', engineProfile: 'engine-2d-v1', launch: {kind: 'script', module: '/start.ts'}, files: source()}));
  return {...fixture, directory, project, release};
}

test('Node adapter and neutral compiler produce identical artifacts for the same sealed Web target; CLI writes PCK and receipt', async t => {
  const fixture = await localRelease(t), options = {project: fixture.project, release: fixture.release};
  const check = await checkNodeProject(options); assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
  const request = await prepareNodeProject(options), expected = await compileProject(request);
  const {compileEngineProject} = await import('../../../apps/playground/src/engine-project.ts');
  const browser = await compileEngineProject({runtime: 'engine', launch: {kind: 'script', module: '/start.ts'}, files: source(),
    compilerEnvironment: request.environment, identityInputs: {engineProfile: 'engine-2d-v1', engineId: fixture.manifest.engineId,
      bindingVersion: fixture.manifest.api.bindingVersion, typescriptVersion: ts.version}});
  assert.equal(browser.buildKey, expected.buildKey); assert.deepEqual(browser.pack, expected.pack);
  const output = path.join(fixture.directory, 'output', 'game.pck');
  const actual = await compileNodeProject({...options, output});
  assert.equal(actual.buildKey, expected.buildKey); assert.equal(actual.artifactId, expected.artifactId); assert.deepEqual(actual.pack, expected.pack);
  assert.deepEqual(new Uint8Array(await readFile(output)), expected.pack);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/node/cli.js', import.meta.url)), 'export-pck', '--project', fixture.project, '--release', fixture.release, '--output', output], {encoding: 'utf8', timeout: 20000});
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).artifactId, actual.artifactId);
  const receipt = JSON.parse(await readFile(output + '.receipt.json', 'utf8')); assert.equal(receipt.artifactId, actual.artifactId);
  const manifest = JSON.parse(await readFile(output + '.manifest.json', 'utf8'));
  assert.equal(manifest.engineId, fixture.manifest.engineId); assert.equal(manifest.engineReleaseId, fixture.manifest.id); assert.equal(manifest.artifactReceipt.artifactId, actual.artifactId);
  const adapter = path.join(fixture.directory, 'node_modules', '@test', 'components'); await mkdir(adapter, {recursive: true});
  await writeFile(path.join(adapter, 'package.json'), JSON.stringify({name: '@test/components', type: 'module', exports: {'./core': {import: './core.mjs'}}}));
  await writeFile(path.join(adapter, 'core.mjs'), 'export function prepareLegacyBuildPlan(){throw Error("check does not build")}');
  const component = path.join(fixture.directory, 'component.json');
  await writeFile(component, JSON.stringify({schemaVersion: 3, runtime: 'react', engineProfile: 'engine-2d-v1', entry: '/App.tsx', files: {'/App.tsx': 'export default function App(){return null}'}}));
  assert.equal((await checkNodeProject({project: component, release: fixture.release, startupAdapter: '@test/components/core'})).ok, true);
  const project = JSON.parse(await readFile(fixture.project, 'utf8'));
  await writeFile(fixture.project, JSON.stringify({...project, engineProfile: 'full-engine-v1'}));
  await assert.rejects(checkNodeProject(options), /profiles differ/);
  await writeFile(fixture.project, JSON.stringify({...project, files: {...project.files, '/image.png': [1]},
    resourceImports: [{resource: 'res://image.png', converter: 'godotjs/image-rgba'}]}));
  await assert.rejects(checkNodeProject(options), /no registered producer/);
  await writeFile(fixture.project, JSON.stringify(project));
  await writeFile(path.join(fixture.directory, 'types.json'), '{}');
  await assert.rejects(checkNodeProject(options), /Release bytes differ/);
});

test('Node directory adapter retains source resources/import cache and supports explicit ordinary script startup', async t => {
  const fixture = await localRelease(t), project = path.join(fixture.directory, 'native-project');
  const files = {...source(), '/project.godot': '[application]\nrun/main_scene="res://main.tscn"\n',
    '/main.tscn': '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
    '/asset.bin': Uint8Array.of(0, 128, 255), '/.godot/imported/keep.bin': Uint8Array.of(4, 5), '/.godot/editor/ignored.bin': Uint8Array.of(8)};
  files['/start.ts']='\ufeff'+files['/start.ts'];
  for (const [name, value] of Object.entries(files)) { const filename = path.join(project, name.slice(1)); await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, value); }
  const output = path.join(project, 'build', 'game.pck'), options = {project, release: fixture.release, output};
  const scene = await compileNodeProject(options);
  assert.equal(scene.manifest.mainScene, 'res://main.tscn'); assert(scene.index['res://asset.bin']); assert(scene.index['res://.godot/imported/keep.bin']);
  assert.equal(scene.index['res://.godot/editor/ignored.bin'], undefined);
  const original=scene.index['res://start.ts'];assert.deepEqual(scene.pack.subarray(original.offset,original.offset+original.size),encoder.encode(files['/start.ts']),'directory source bytes, including a UTF-8 BOM, must be preserved');
  await writeFile(output+'.00000000-0000-4000-8000-000000000000.tmp',Uint8Array.of(9,8,7));
  assert.equal((await compileNodeProject(options)).artifactId, scene.artifactId, 'own output and interrupted output candidates are not read into the next snapshot');
  const script = await compileNodeProject({...options, launch: {kind: 'script', module: '/start.ts'}});
  assert.match(readPacked(script, 'res://.playground/engine-bootstrap.ts'), /Script entry must export a start function/);
  assert.notEqual(script.buildKey, scene.buildKey);
});

test('neutral compiler dependency graph has no application, React runtime, filesystem or browser host imports', async () => {
  const result = await build({entryPoints: [fileURLToPath(new URL('../dist/compiler.js', import.meta.url))], bundle: true, write: false, metafile: true, platform: 'neutral', format: 'esm', external: ['typescript', 'spark-md5']});
  assert(!Object.keys(result.metafile.inputs).some(name => /apps\/playground|scripts\/jsb\.react|verified-loader|runner|node:/.test(name)));
});


test('Node output admission leaves the published root intact for cancelled and superseded builds',async t=>{
 const fixture=await localRelease(t),output=path.join(fixture.directory,'published.pck'),options={project:fixture.project,release:fixture.release,output};
 const original=await compileNodeProject(options);
 let entered,release;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 const slow=compileNodeProject({...options,preparePlan:async(plan,preparation)=>{entered();await blocked;return prepareBuildPlan(plan,preparation);}});
 await started;
 const latest=await compileNodeProject(options);release();
 await assert.rejects(slow,error=>error.code==='E_BUILD_SUPERSEDED');
 assert.deepEqual(new Uint8Array(await readFile(output)),latest.pack);
 const controller=new AbortController();
 await assert.rejects(compileNodeProject({...options,signal:controller.signal,preparePlan:async(plan,preparation)=>{const prepared=await prepareBuildPlan(plan,preparation);controller.abort(Error('cancelled before output'));return prepared;}}),/cancelled before output/);
 assert.deepEqual(new Uint8Array(await readFile(output)),original.pack);
});


test('Node ArtifactSet output is a real alternative and its output directory is excluded from source revisions',async t=>{
 const fixture=await localRelease(t,{artifactSetAbi:1}),project=path.join(fixture.directory,'source-directory');await mkdir(project);
 await writeFile(path.join(project,'start.ts'),'export function start(){}');await writeFile(path.join(project,'resource.bin'),Uint8Array.of(3,2,1));
 const artifactSetDirectory=path.join(project,'artifacts'),options={project,release:fixture.release,launch:{kind:'script',module:'/start.ts'},artifactSetDirectory};
 const first=await compileNodeProject(options);assert.equal(first.variant,'pack-set');assert.equal(first.pack,undefined);
 const manifest=JSON.parse(await readFile(path.join(artifactSetDirectory,'artifact-set.json'),'utf8'));assert.equal(manifest.artifactSetId,first.artifactId);
 for(const descriptor of [manifest.bootstrap,...manifest.resources])assert.deepEqual(new Uint8Array(await readFile(path.join(artifactSetDirectory,descriptor.path))),first.artifactSet.packs.get(descriptor.sha256));
 const warm=await compileNodeProject(options);assert.equal(warm.artifactId,first.artifactId,'exported artifact directory must never become project input');
 await writeFile(path.join(project,'start.ts'),'export function start(){return 1}');
 const edited=await compileNodeProject(options);assert.notEqual(edited.artifactId,first.artifactId);assert.deepEqual(edited.artifactSet.manifest.resources,first.artifactSet.manifest.resources);
});

test('single and set builds preserve independent source/import evidence across Node, browser, cache and editor persistence',async t=>{
 const fixture=await localRelease(t,{artifactSetAbi:1}),cache=new ProjectBuildCache(),resourceCache=createResourceExecutionCache();
 const png=encodeRgbaPng({width:1,height:1,rgba:Uint8Array.of(255,0,0,255)}),document={schemaVersion:4,runtime:'engine',engineProfile:fixture.manifest.runtimeProfile,launch:{kind:'script',module:'/start.ts'},files:{'/start.ts':'\ufeffexport function start(){}','/pixel.png':[...png]},resourceImports:[{resource:'res://pixel.png',converter:'godotjs/png-ctex'}]};
 await writeFile(fixture.project,JSON.stringify(document));
 const artifactSetDirectory=path.join(fixture.directory,'evidence-set'),options={project:fixture.project,release:fixture.release,artifactSetDirectory,cache,resourceCache};
 const cold=await compileNodeProject(options),before=cache.metrics,warm=await compileNodeProject(options);
 assert.equal(cold.variant,'pack-set');assert.equal(cold.sourceHash,cold.plan.snapshot.sourceHash);assert.equal(cold.importReceipts.length,1);
 assert.equal(cold.importReceipts[0].converter.output.extension,'ctex');assert.deepEqual(cold.importReceipts,warm.importReceipts);assert.equal(cold.buildKey,warm.buildKey);assert.equal(cold.artifactId,warm.artifactId);assert.equal(cache.metrics.packBytesWritten,before.packBytesWritten);
 const metadata=compileResultMetadata(cold);assert.deepEqual(metadata,compileResultMetadata(warm));assert.equal(metadata.sourceHash,cold.sourceHash);assert(!Object.hasOwn(metadata,'packSha256'));assert(!Object.hasOwn(metadata,'artifactReceipt'));
 assert.deepEqual(compileResultMetadata({...cold,manifest:{...cold.manifest,artifactReceipt:{imports:[]},packSha256:'stale-single',artifactSetId:'stale-set'}}),metadata);
 const sidecar=JSON.parse(await readFile(path.join(artifactSetDirectory,'application.pck.manifest.json'),'utf8'));
 for(const key of ['sourceHash','buildKey','artifactId','artifactSetId','importReceipts','outputOverlay'])assert.deepEqual(sidecar[key],metadata[key]);
 assert(!Object.hasOwn(sidecar,'packSha256'));assert(!Object.hasOwn(sidecar,'artifactReceipt'));
 const request=await prepareNodeProject(options),{compileEngineProject}=await import('../../../apps/playground/src/engine-project.ts');
 let browser;
 try{browser=await compileEngineProject({runtime:'engine',launch:document.launch,files:document.files,resourceImports:document.resourceImports,resourceConverters:createBrowserResourceConverters(undefined,{cache:resourceCache}),resourceTarget:{resourceAbi:BINARY_RESOURCE_TARGET_ABI,features:{engineId:fixture.manifest.engineId}},compilerEnvironment:request.environment,artifactSet:true,buildCache:cache,identityInputs:{engineProfile:fixture.manifest.runtimeProfile,engineId:fixture.manifest.engineId,bindingVersion:fixture.manifest.api.bindingVersion,typescriptVersion:ts.version}});}finally{request.releaseSnapshot();}
 assert.deepEqual(compileResultMetadata(browser),metadata);assert.deepEqual(browser.artifactSet.manifest,cold.artifactSet.manifest);
 const actual=new Map();for(const bytes of browser.artifactSet.packs.values())for(const entry of readPckIndex(bytes).entries)actual.set(entry.path,bytes.slice(entry.offset,entry.offset+entry.bytes));
 assert.deepEqual(actual.get('res://start.ts'),encoder.encode(document.files['/start.ts']));
 for(const output of metadata.outputOverlay)if(output.outputHash)assert.equal(await hashBytes(actual.get(output.path)),output.outputHash,output.path);
 for(const receipt of metadata.importReceipts){assert.equal((await assessStoredImportReceipt(receipt,actual)).status,'unverified','hash matches do not invent trusted producer attestation');for(const item of [...receipt.sources,...receipt.outputs])assert.equal(await hashBytes(actual.get(item.path)),item.sha256,item.path);}
 const broken=new Map(actual),output=cold.importReceipts[0].outputs[0].path;broken.set(output,Uint8Array.of(0));assert.equal((await assessStoredImportReceipt(cold.importReceipts[0],actual,broken)).status,'stale');
 const single=await compileNodeProject({...options,artifactSetDirectory:undefined,output:path.join(fixture.directory,'evidence-single.pck')});assert.deepEqual(single.importReceipts,cold.importReceipts);assert.equal(single.sourceHash,cold.sourceHash);assert.deepEqual(single.receipt.imports,single.importReceipts);
 assert(!Object.hasOwn(compileResultMetadata({...single,manifest:{...single.manifest,artifactSetId:'stale-set'}}),'artifactSetId'));
 const {parseProject,exportProject,projectCompileRequest}=await import('../../../apps/playground/src/project-model.ts'),{applyCompiledImportReceipts}=await import('../../../apps/playground/src/compiled-project-metadata.ts');
 const editor=parseProject(document),original=exportProject(editor,'original'),sources=structuredClone(editor.files);
 assert(applyCompiledImportReceipts(editor,metadata));assert.deepEqual(projectCompileRequest(editor).importReceipts,cold.importReceipts);assert.deepEqual(exportProject(editor).importReceipts,cold.importReceipts);assert.deepEqual(editor.files,sources);assert.deepEqual(exportProject(editor,'original'),original);assert(!applyCompiledImportReceipts(editor,metadata));
 const persisted=exportProject(editor);assert.throws(()=>applyCompiledImportReceipts(editor,{importReceipts:[...cold.importReceipts,...cold.importReceipts]}),/Duplicate/);assert.throws(()=>applyCompiledImportReceipts(editor,{importReceipts:[{...cold.importReceipts[0],schemaVersion:9}]}),/receipt/i);assert.deepEqual(exportProject(editor),persisted);
 const compatibility=parseProject(document);assert(applyCompiledImportReceipts(compatibility,{artifactReceipt:single.receipt}));assert.deepEqual(projectCompileRequest(compatibility).importReceipts,cold.importReceipts);
 const precedence=parseProject(document);assert(!applyCompiledImportReceipts(precedence,{importReceipts:[],artifactReceipt:single.receipt}));assert.equal(projectCompileRequest(precedence).importReceipts,undefined);
});


test('historical component sources keep their intent through current engine facade routes without changing Schema 4 semantics',async t=>{
 const fixture=await localRelease(t,{historicalSdk:true}),startupAdapter=fileURLToPath(new URL('../../../scripts/jsb.react-build/dist/core/index.js',import.meta.url)),options={project:fixture.project,release:fixture.release,startupAdapter};
 const original='import * as React from "react";import {Label} from "@godot-js/react";export default function App(){return <Label text="historical"/>}';
 const document={schemaVersion:3,runtime:'react',engineProfile:fixture.manifest.runtimeProfile,entry:'/App.tsx',files:{'/App.tsx':original}};await writeFile(fixture.project,JSON.stringify(document));
 const request=await prepareNodeProject(options);assert.equal(request.environment.identity.target.compatibilityAdapter,'godotjs-historical-react-modules/1');
 const node=await compileProject(request);assert.match(readPacked(node,'res://.godot/GodotJS/node_modules/@godot-js/react/index.js'),/engineComponents/);assert.match(readPacked(node,'res://.godot/GodotJS/node_modules/@godot-js/react/engine/index.js'),/engineReact/);assert.equal(readPacked(node,'res://App.tsx'),original);
 const {compileEngineProject}=await import('../../../apps/playground/src/engine-project.ts');
 const browser=await compileEngineProject({runtime:'react',entry:'/App.tsx',files:document.files,compilerEnvironment:request.environment,identityInputs:{engineProfile:fixture.manifest.runtimeProfile,engineId:fixture.manifest.engineId,extensionId:fixture.manifest.extensionId,bindingVersion:fixture.manifest.api.bindingVersion,typescriptVersion:ts.version}});
 assert.equal(browser.buildKey,node.buildKey);assert.equal(browser.artifactId,node.artifactId);assert.deepEqual(browser.pack,node.pack);
 await writeFile(fixture.project,JSON.stringify({schemaVersion:4,runtime:'engine',engineProfile:fixture.manifest.runtimeProfile,launch:{kind:'script',module:'/App.tsx',export:'default'},files:document.files}));
 const modern=await checkNodeProject(options);assert.equal(modern.ok,false);assert(modern.diagnostics.some(item=>item.code===2305&&/Label/.test(item.message)));
 await writeFile(fixture.project,JSON.stringify(document));assert.equal((await compileNodeProject(options)).artifactId,node.artifactId,'switching checking modes cannot poison the shared language service/module cache');
 const denied={...document,files:{'/App.tsx':original.replace('@godot-js/react','@godot-js/react/legacy')}};await writeFile(fixture.project,JSON.stringify(denied));
 await assert.rejects(checkNodeProject(options),error=>error.code==='E_HISTORICAL_REACT_IMPORT');
 assert.deepEqual(JSON.parse(await readFile(fixture.project,'utf8')),denied,'the adapter never rewrites historical source documents');
});
