import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createTypeSession, checkProjectTypes, hydrateTypeInputs } from '../dist/typecheck.js';
import { createTypesWorkerHandler } from '../dist/types-worker.js';

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
