import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { buildBuiltInLibraries, builtInLibrariesPlugin } from '../build-builtins.mjs';

test('the built-in artifact supplies fixed clsx code and declarations with SDK scheduler types',async()=>{
  const libraries=await buildBuiltInLibraries();
  assert.equal(libraries.versions.clsx,'2.1.1');assert.equal(libraries.modules.clsx,'/node_modules/clsx/index.cjs');
  assert.match(libraries.files['/node_modules/clsx/index.cjs'],/MIT License/);
  assert.match(libraries.files['/node_modules/clsx/index.d.ts'],/clsx/);
  assert.match(libraries.files['/node_modules/scheduler/index.d.ts'],/@godot-js\/react\/scheduler/);
});

test('the Playground compiler bundle excludes the npm resolver, transport and semver',async()=>{
  const result=await build({entryPoints:[fileURLToPath(new URL('../compiler-worker.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',metafile:true,plugins:[builtInLibrariesPlugin()]});
  for(const input of Object.keys(result.metafile.inputs))assert(!/(?:jsb\.react-browser\/src\/(?:resolve|transport)\.ts|node_modules\/.*semver)/.test(input),input);
});
