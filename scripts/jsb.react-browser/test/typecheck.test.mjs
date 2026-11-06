import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createTypeSession, checkProjectTypes, hydrateTypeInputs } from '../dist/typecheck.js';
import { createTypesWorkerHandler } from '../dist/types-worker.js';
import * as esbuild from 'esbuild';
import { createBrowserCompilerCore } from '../dist/compiler-core.js';
import { createBuiltInResolver } from '../dist/builtins.js';
import { createSnapshot, sha256, utf8 } from '../dist/snapshot.js';
import { profileReference } from '../../jsb.react/dist/schema/index.js';
import { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS } from '../../jsb.react/dist/contracts/index.js';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = path.join(repo, 'scripts/jsb.react');
const sdkRequire = createRequire(path.join(sdk, 'package.json'));
const files = {};
async function copyTree(real, virtual) {
  for (const entry of await readdir(real, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) await copyTree(path.join(real, entry.name), virtual + '/' + entry.name);
    else if (/\.(?:[cm]?ts|json)$/.test(entry.name)) files[virtual + '/' + entry.name] = new Uint8Array(await readFile(path.join(real, entry.name)));
  }
}
await copyTree(path.join(sdk, 'dist'), '/node_modules/@godot-js/react/dist');
files['/node_modules/@godot-js/react/package.json'] = await readFile(path.join(sdk, 'package.json'), 'utf8');
const reactTypesRoot = path.dirname(sdkRequire.resolve('@types/react/package.json'));
await copyTree(reactTypesRoot, '/node_modules/@types/react');
await copyTree(path.dirname(createRequire(path.join(reactTypesRoot, 'package.json')).resolve('csstype/package.json')), '/node_modules/csstype');
const lib = path.dirname(ts.getDefaultLibFilePath({}));
for (const name of await readdir(lib)) if (/^lib\..*\.d\.ts$/.test(name)) files['/typescript/lib/' + name] = await readFile(path.join(lib, name), 'utf8');

const valid = 'import {Label} from "@godot-js/react";\nexport default function App(props:{count:number}) {const message=String(props.count);return <Label text={message}/>;}';
function input(source = valid, extra = {}) {
  return { project: { hash: 'resolved-one', files: { ...files, '/src/App.tsx': source }, typeGraph: { edges: [] }, runtimeGraph: { entries: ['/src/App.tsx'] } }, entries: { app: { module: '/src/App.tsx', props: { count: 1 } } }, mode: 'production', profileId: 'core-ui-v1', projectKey: 'build-one', revision: 'rev-one', ...extra };
}
function checked(value) { const result = checkProjectTypes(ts, value); assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2)); return result; }

test('real SDK and React declarations check in production and development without Node ambient types', () => {
  for (const mode of ['production', 'development']) {
    const result = checked(input(valid, { mode }));
    assert.equal(result.projectKey, 'build-one'); assert.equal(result.revision, 'rev-one'); assert.equal(result.typescriptVersion, ts.version);
  }
  const result = checkProjectTypes(ts, input(valid + '\nprocess.cwd();'));
  assert(result.diagnostics.some(item => item.code === 2591 || item.code === 2580));
});
test('configured entry props and export are checked and report entry identity', () => {
  const value = input(); value.entries.app.props = { count: 'wrong' };
  const result = checkProjectTypes(ts, value);
  assert.equal(result.ok, false); assert(result.diagnostics.some(item => item.entryId === 'app' && item.file === '/src/App.tsx'));
  value.entries.app.export = 'missing';
  assert(checkProjectTypes(ts, value).diagnostics.some(item => item.code === 'E_ENTRY_EXPORT'));
});
test('profile checks follow SDK alias and namespace symbol identity', () => {
  for (const [imports, expression] of [['import {CharacterBody2D as Body} from "@godot-js/react";', '<Body/>'], ['import * as SDK from "@godot-js/react";', '<SDK.CharacterBody2D/>'], ['import {G} from "@godot-js/react";', '<G.CharacterBody2D/>']]) {
    const value = input(imports + 'export default function App(){return ' + expression + ';}', { entries: { app: { module: '/src/App.tsx' } } });
    assert(checkProjectTypes(ts, value).diagnostics.some(item => item.code === 'E_PROFILE_UNSUPPORTED'), imports);
    checked({ ...value, profileId: 'behavior-physics-v1' });
  }
  checked(input('function CharacterBody2D(){return null;} export default function App(){return <CharacterBody2D/>;}', { entries: { app: { module: '/src/App.tsx' } } }));
});
test('strict settings and declaration checking cannot be weakened by project options', () => {
  const value = input(valid + '\nfunction unsafe(value){return value;}');
  value.compilerOptions = { strict: false, skipLibCheck: true, noImplicitAny: false };
  // Individual strict flags are also fixed by the browser contract.
  const result = checkProjectTypes(ts, value);
  assert(result.diagnostics.some(item => item.code === 7006));
  const broken = input(); broken.project.files['/src/global.d.ts'] = 'declare const invalid: MissingType;';
  assert(checkProjectTypes(ts, broken).diagnostics.some(item => item.code === 2304));
});
test('virtual multi-file modules and frozen package type edges resolve without I/O', () => {
  const value = input('import {Label} from "@godot-js/react"; import {answer} from "./answer.js"; import {format} from "data-lib"; export default function App(){return <Label text={format(answer)}/>;}', { entries: { app: { module: '/src/App.tsx' } } });
  value.project.files['/src/answer.ts'] = 'export const answer=42;';
  value.project.files['/node_modules/.store/data-lib@1/node_modules/data-lib/index.d.ts'] = 'export declare function format(value:number):string;';
  value.project.typeGraph.edges.push({ importer: '/src/App.tsx', specifier: 'data-lib', mode: 'import', resolved: '/node_modules/.store/data-lib@1/node_modules/data-lib/index.d.ts' });
  checked(value);
  value.project.files['/src/answer.ts'] = 'export const answer="bad";';
  assert(checkProjectTypes(ts, value).diagnostics.some(item => item.code === 2345));
});
test('a session freezes file bytes, entry configuration and diagnostics DTOs', () => {
  const value = input(); value.project.files['/assets/test.png'] = new Uint8Array([255, 0, 1]);
  const session = createTypeSession(ts, value);
  value.project.files['/src/App.tsx'] = 'invalid source'; value.entries.app.export = 'missing'; value.revision = 'changed-revision';
  assert.equal(session.check().ok, true);
  assert.equal(session.check().revision, 'rev-one');
  assert.deepEqual(structuredClone(session.check()), session.check());
  session.dispose();
});
test('runtime and declaration package instances stay bound, including explicit @types fallback', () => {
  const value = input('import {value} from "data-lib"; export default function App(){return null;}', { entries: { app: { module: '/src/App.tsx' } } });
  const runtime = '/node_modules/.store/data-lib@1/node_modules/data-lib', declarations = '/node_modules/.store/@types+data-lib@1/node_modules/@types/data-lib';
  value.project.instances = { runtime: { id: 'runtime', name: 'data-lib', version: '1.0.0', root: runtime }, declarations: { id: 'declarations', name: '@types/data-lib', version: '1.0.0', root: declarations } };
  value.project.files[declarations + '/index.d.ts'] = 'export declare const value:number;';
  value.project.runtimeGraph.edges = [{ importer: '/src/App.tsx', specifier: 'data-lib', resolved: runtime + '/index.js', mode: 'import' }];
  value.project.typeGraph.edges = [{ importer: '/src/App.tsx', specifier: 'data-lib', resolved: declarations + '/index.d.ts', mode: 'import', runtimeInstanceId: 'runtime', typeInstanceId: 'declarations' }];
  checked(value);
  value.project.typeGraph.edges[0].runtimeInstanceId = 'wrong-runtime';
  assert(checkProjectTypes(ts, value).diagnostics.some(item => item.code === 'E_TYPES_PACKAGE_BINDING'));
});
test('completion and hover return structured-clone-safe DTOs', () => {
  const source = valid + '\nconst sample={count:1}; sample.count;';
  const session = createTypeSession(ts, input(source));
  const completions = session.complete('/src/App.tsx', source.lastIndexOf('sample.') + 'sample.'.length);
  assert(completions.some(item => item.name === 'count'));
  const hover = session.hover('/src/App.tsx', source.lastIndexOf('count') + 1);
  assert.match(hover.display, /count.*number/); assert.deepEqual(structuredClone(hover), hover);
  session.dispose();
});
test('incomplete declaration hydration never becomes a successful check', async () => {
  const value = input(); value.project.typeGraph.unresolved = ['missing-package'];
  assert.equal(checkProjectTypes(ts, value).ok, false);
  await assert.rejects(hydrateTypeInputs(value, async () => value.project), /E_TYPES_PENDING/);
  await assert.rejects(hydrateTypeInputs(input(), async () => { throw Error('network failed'); }), /network failed/);
});
test('release-supplied Godot globals are opt-in and media hosts follow the selected profile', () => {
  const value = input(valid + '\nconsole.log("ready");');
  value.project.files['/node_modules/@types/godot-runtime/index.d.ts'] = 'declare const console:{log(...args:unknown[]):void};';
  checked(value);
  const media = input('import {TextureRect,asset} from "@godot-js/react";export default function App(){return <TextureRect texture={asset("image","ImageTexture")}/>;}', {entries:{app:{module:'/src/App.tsx'}},profileId:'ui-media-v1'});
  checked(media);
  assert(checkProjectTypes(ts,{...media,profileId:'core-ui-v1'}).diagnostics.some(item=>item.code==='E_PROFILE_UNSUPPORTED'));
});
test('unified 2D profile accepts mixed hosts by SDK identity and preserves the old profile boundaries', () => {
  for (const [imports, expression] of [
    ['import {CharacterBody2D as Body,Sprite2D as Picture,CollisionShape2D,ProgressBar} from "@godot-js/react";', '<><Body><CollisionShape2D/><Picture/></Body><ProgressBar/></>'],
    ['import * as SDK from "@godot-js/react";', '<><SDK.CharacterBody2D><SDK.CollisionShape2D/><SDK.Sprite2D/></SDK.CharacterBody2D><SDK.ProgressBar/></>'],
    ['import {G} from "@godot-js/react";', '<><G.CharacterBody2D><G.CollisionShape2D/><G.Sprite2D/></G.CharacterBody2D><G.ProgressBar/></>'],
  ]) {
    const value = input(imports + 'export default function App(){return ' + expression + ';}', { entries: { app: { module: '/src/App.tsx' } }, profileId: 'game-2d-v1' });
    for (const mode of ['production', 'development']) checked({ ...value, mode });
    for (const profileId of ['core-ui-v1', 'ui-media-v1', 'behavior-physics-v1'])
      assert(checkProjectTypes(ts, { ...value, profileId }).diagnostics.some(item => item.code === 'E_PROFILE_UNSUPPORTED'), profileId + ': ' + imports);
  }
});
test('real combined WASM fixture type-checks against the release declarations in both modes', async () => {
  const source = await readFile(path.join(repo, 'scripts/test/fixtures/browser-game-2d.tsx'), 'utf8');
  const value = input(source, { entries: { app: { module: '/src/App.tsx' } }, profileId: 'game-2d-v1' });
  value.project.files['/node_modules/@types/godot-runtime/index.d.ts'] = 'declare const console:{log(...args:unknown[]):void};';
  for (const mode of ['production', 'development']) checked({ ...value, mode });
});

// Read the actual binary directory and payloads instead of trusting artifact.files.
function unpackPck(pack) {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  assert.equal(view.getUint32(0, true), 0x43504447);
  assert.equal(view.getUint32(4, true), 3);
  const base = Number(view.getBigUint64(24, true));
  let cursor = Number(view.getBigUint64(32, true));
  const count = view.getUint32(cursor, true), entries = new Map(); cursor += 4;
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(cursor, true); cursor += 4;
    const name = new TextDecoder().decode(pack.slice(cursor, cursor + length)).replace(/\0+$/, ''); cursor += length;
    const offset = Number(view.getBigUint64(cursor, true)) + base; cursor += 8;
    const size = Number(view.getBigUint64(cursor, true)); cursor += 8 + 16 + 4;
    assert(offset >= base && offset + size <= pack.length, name);
    entries.set('res://' + name, pack.slice(offset, offset + size));
  }
  return entries;
}
async function compilerFixture() {
  const releaseFiles = new Map(), releaseEntries = [];
  for (const [virtualPath, source] of Object.entries(files)) {
    const bytes = typeof source === 'string' ? utf8.encode(source) : source;
    const path = 'types' + virtualPath;
    releaseFiles.set(path, bytes);
    releaseEntries.push({ path, virtualPath, sha256: await sha256(bytes), kind: 'types' });
  }
  // Vendor execution is exercised by the real WASM suite. This unit fixture
  // supplies fixed vendor bytes while running the real TS, bundler and PCK code.
  for (const sdkMode of ['production', 'development']) {
    const path = 'sdk-' + sdkMode + '.js', bytes = utf8.encode('module.exports={};');
    releaseFiles.set(path, bytes); releaseEntries.push({ path, sha256: await sha256(bytes), kind: 'sdk', sdkMode });
  }
  const release = { schemaVersion: 1, id: 'a'.repeat(64), version: 'test', certified: false,
    engine: { godotVersion: '4.6.1', engine: 'web', engineTarget: 'template_debug', threads: false },
    runtimeAbi: RUNTIME_ABI, nativeBridgeAbi: NATIVE_BRIDGE_ABI, react: REACT_VERSIONS,
    profiles: Object.fromEntries(['core-ui-v1', 'ui-media-v1', 'behavior-physics-v1', 'game-2d-v1'].map(id => [id, profileReference(id)])),
    files: releaseEntries, specifiers: {}, dependencies: {}, sdkPackageRoot: '/node_modules/@godot-js/react', typesRoot: '/node_modules/@types', libRoot: '/typescript/lib' };
  const resolver = createBuiltInResolver({ versions: {}, modules: {}, files: {} });
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
  const compiler = createBrowserCompilerCore({ bundler: esbuild, typescript: ts, release, releaseFiles, ...resolver,
    decodeImage: async bytes => { assert.deepEqual(bytes, png); return { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) }; } });
  return { compiler, release, png };
}
test('real browser compiler packs textures and collision shapes together and selects physics by capability', async () => {
  const { compiler, png } = await compilerFixture();
  const source = 'import {Node,CharacterBody2D,CollisionShape2D,Sprite2D,ProgressBar,asset} from "@godot-js/react"; export default function App(){return <Node><CharacterBody2D engineOwned={["position","velocity"]}><CollisionShape2D shape={asset("shape","CircleShape2D")}/><Sprite2D texture={asset("image","Texture2D")}/></CharacterBody2D><ProgressBar value={42}/></Node>;}';
  const config = { schemaVersion: 1, entry: '/src/App.tsx', dependencies: {}, profileId: 'game-2d-v1', mode: 'production', assets: {
    image: { source: '/assets/image.png', type: 'Texture2D' }, shape: { source: '/assets/shape.tres', type: 'CircleShape2D' } } };
  const project = { '/src/App.tsx': source, '/assets/image.png': png, '/assets/shape.tres': '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius=12.0\n' };
  const keys = [];
  for (const mode of ['production', 'development']) {
    const artifact = await compiler.build(await createSnapshot({ revision: mode, config: { ...config, mode }, files: project }));
    const packed = unpackPck(artifact.pack), decode = uri => new TextDecoder().decode(packed.get(uri));
    assert.deepEqual(artifact.manifest.profile, profileReference('game-2d-v1'));
    assert.match(decode('res://project.godot'), /2d\/physics_engine="GodotPhysics2D"/);
    assert.match(decode('res://project.godot'), /3d\/physics_engine="Dummy"/);
    assert.match(decode(artifact.manifest.resources.image.uri), /type="ImageTexture"/);
    assert.match(decode(artifact.manifest.resources.shape.uri), /type="CircleShape2D"/);
    for (const resource of Object.values(artifact.manifest.resources)) assert.equal(await sha256(packed.get(resource.uri)), resource.sha256);
    keys.push(artifact.buildKey);
  }
  assert.notEqual(keys[0], keys[1]);
  for (const profileId of ['core-ui-v1', 'ui-media-v1', 'behavior-physics-v1']) {
    const artifact = await compiler.build(await createSnapshot({ revision: profileId, config: { ...config, profileId, assets: {} }, files: { '/src/App.tsx': 'import {Label} from "@godot-js/react";export default function App(){return <Label text="old profile"/>;}' } }));
    assert.match(new TextDecoder().decode(unpackPck(artifact.pack).get('res://project.godot')), new RegExp('2d/physics_engine="' + (profileId === 'behavior-physics-v1' ? 'GodotPhysics2D' : 'Dummy') + '"'));
  }
});
test('mixed build refuses missing release profiles, changed hashes and old-profile resource widening', async () => {
  const { compiler, release, png } = await compilerFixture();
  const config = { schemaVersion: 1, entry: '/src/App.tsx', dependencies: {}, profileId: 'game-2d-v1', mode: 'production' };
  const snapshot = await createSnapshot({ revision: 'negative', config, files: { '/src/App.tsx': 'export default function App(){return null;}' } });
  const reference = release.profiles['game-2d-v1'];
  delete release.profiles['game-2d-v1'];
  await assert.rejects(compiler.build(snapshot), /E_PROFILE_UNSUPPORTED/);
  release.profiles['game-2d-v1'] = { ...reference, hash: 'f'.repeat(64) };
  await assert.rejects(compiler.build(snapshot), /E_PROFILE_UNSUPPORTED/);
  release.profiles['game-2d-v1'] = reference;
  for (const [profileId, assets, extra] of [
    ['ui-media-v1', { shape: { source: '/shape.tres', type: 'CircleShape2D' } }, { '/shape.tres': '[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius=12.0\n' }],
    ['behavior-physics-v1', { image: { source: '/image.png', type: 'Texture2D' } }, { '/image.png': png }],
  ]) await assert.rejects(compiler.build(await createSnapshot({ revision: profileId, config: { ...config, profileId, assets }, files: { '/src/App.tsx': 'export default function App(){return null;}', ...extra } })), /E_PROFILE_RESOURCE/);
});
test('worker serializes load/check/query/dispose and contains no runtime Node imports', async () => {
  const handle = createTypesWorkerHandler(ts);
  assert.equal((await handle({ id: 0, kind: 'check' })).ok, false);
  const results = await Promise.all([handle({ id: 1, kind: 'load', input: input() }), handle({ id: 2, kind: 'check' })]);
  assert(results.every(item => item.ok && item.result.ok));
  assert.equal((await handle({ id: 3, kind: 'dispose' })).ok, true);
  assert.equal((await handle({ id: 4, kind: 'check' })).ok, false);
  const source = await readFile(new URL('../dist/types-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:node:|typescript['"])/);
});
