import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltInResolver } from '../dist/builtins.js';
import { createSnapshot } from '../dist/snapshot.js';
const libraries={versions:{clsx:'2.1.1'},modules:{clsx:'/node_modules/clsx/index.cjs'},files:{
  '/node_modules/clsx/index.cjs':'module.exports = value => value;',
  '/node_modules/clsx/index.d.ts':'export default function clsx(value:string):string;',
  '/node_modules/clsx/package.json':'{"name":"clsx","version":"2.1.1","main":"index.cjs","types":"index.d.ts"}',
}};
const resolver=createBuiltInResolver(libraries);
const snapshot=dependencies=>createSnapshot({revision:'r1',config:{schemaVersion:1,entry:'/src/App.ts',dependencies,mode:'production',profileId:'core-ui-v1'},files:{'/src/App.ts':'import clsx from "clsx";export default clsx("hello");','/src/util.ts':'export const value=1;','/src/modern.mts':'export const value=2;','/src/legacy.cts':'export const value=3;'}});

test('fixed bundles and declarations resolve without npm graphs or a dependency lock',async()=>{
  const project=await resolver.resolveProject(await snapshot({clsx:'2.1.1'}),{id:'release'});
  assert.equal(project.policyId,'builtin-v1');assert.equal(project.lock,undefined);assert.equal(project.typeGraph,undefined);
  assert.equal(resolver.resolveModule('clsx','/src/App.ts','import',project),'/node_modules/clsx/index.cjs');
  assert.equal(resolver.resolveModule('./util.js','/src/App.ts','import',project),'/src/util.ts');
  assert.equal(resolver.resolveModule('./modern.mjs','/src/App.ts','import',project),'/src/modern.mts');
  assert.equal(resolver.resolveModule('./legacy.cjs','/src/App.ts','import',project),'/src/legacy.cts');
  assert(project.files['/node_modules/clsx/index.d.ts']);
});

test('missing declarations and unavailable packages cannot fall back to network resolution',async()=>{
  const project=await resolver.resolveProject(await snapshot({}),{id:'release'});
  assert.equal(project.files['/node_modules/clsx/index.cjs'],undefined);
  assert.throws(()=>resolver.resolveModule('clsx','/src/App.ts','import',project),/E_BUILTIN_UNDECLARED/);
  for(const specifier of ['left-pad','node:fs','https://cdn.example/library.js'])assert.throws(()=>resolver.resolveModule(specifier,'/src/App.ts','import',project),/E_BUILTIN_MODULE/);
  await assert.rejects(resolver.resolveProject(await snapshot({clsx:'2.1.0'}),{id:'release'}),/E_BUILTIN_DEPENDENCY/);
});

test('declarations cannot execute and paths cannot escape the virtual project',async()=>{
  const project=await resolver.resolveProject(await snapshot({clsx:'2.1.1'}),{id:'release'});
  assert.throws(()=>resolver.resolveModule('/node_modules/clsx/index.d.ts','/src/App.ts','import',project),/E_MODULE_NOT_FOUND/);
  assert.throws(()=>resolver.resolveModule('../../escape','/src/App.ts','import',project),/E_PROJECT_PATH/);
});
