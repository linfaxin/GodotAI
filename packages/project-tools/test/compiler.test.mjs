import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {build} from 'esbuild';
import {createCompilerEnvironment, compileBuildPlan, compileProject} from '../dist/compiler.js';
import {createProjectTypeEnvironment, checkProjectTypes} from '../dist/type-environment.js';
import {engineCheckOptions, engineEmitOptions} from '../dist/compiler-policy.js';
import {createSourceSnapshot, createBuildPlan, adaptLegacyLaunch} from '../dist/build-plan.js';
import {prepareNodeProject, checkNodeProject, compileNodeProject} from '../dist/node/compiler.js';
import {hashJson} from '../dist/hash.js';
import {createExtensionIdentity, nativeExtensionIdentityInputs} from '@godot-js/engine/identities';
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

async function localRelease(t) {
  const fixture = await nativeReleaseFixture();
  const types = {...fixture.types, ...await standardLibraries()};
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
  for (const [name, value] of Object.entries(files)) { const filename = path.join(project, name.slice(1)); await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, value); }
  const output = path.join(project, 'build', 'game.pck'), options = {project, release: fixture.release, output};
  const scene = await compileNodeProject(options);
  assert.equal(scene.manifest.mainScene, 'res://main.tscn'); assert(scene.index['res://asset.bin']); assert(scene.index['res://.godot/imported/keep.bin']);
  assert.equal(scene.index['res://.godot/editor/ignored.bin'], undefined);
  assert.equal((await compileNodeProject(options)).artifactId, scene.artifactId, 'own output is not read into the next snapshot');
  const script = await compileNodeProject({...options, launch: {kind: 'script', module: '/start.ts'}});
  assert.match(readPacked(script, 'res://.playground/engine-bootstrap.ts'), /Script entry must export a start function/);
  assert.notEqual(script.buildKey, scene.buildKey);
});

test('neutral compiler dependency graph has no application, React runtime, filesystem or browser host imports', async () => {
  const result = await build({entryPoints: [fileURLToPath(new URL('../dist/compiler.js', import.meta.url))], bundle: true, write: false, metafile: true, platform: 'neutral', format: 'esm', external: ['typescript', 'spark-md5']});
  assert(!Object.keys(result.metafile.inputs).some(name => /apps\/playground|scripts\/jsb\.react|verified-loader|runner|node:/.test(name)));
});
