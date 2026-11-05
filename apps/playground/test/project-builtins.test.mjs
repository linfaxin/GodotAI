import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../project-builtins.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
const {useBuiltInDependencies,assertEditableFile}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const project=()=>({config:{schemaVersion:1,entry:'/src/App.tsx',dependencies:{'left-pad':'1.3.0'},mode:'production',profileId:'core-ui-v1'},files:{'/src/App.tsx':'export default function App() {}','/package.json':'{unfinished old manifest','/pnpm-lock.yaml':'old'},selected:'/package.json',lock:{old:true}});
test('migration removes dependency manifests and obsolete locks while preserving source and selecting the entry',()=>{
 const value=useBuiltInDependencies(project());assert.deepEqual(Object.keys(value.files),['/src/App.tsx']);assert.equal(value.selected,'/src/App.tsx');assert.equal(value.lock,undefined);
 assert.deepEqual(value.config.dependencies,{react:'19.3.1','@godot-js/react':'0.1.0',scheduler:'0.28.0',clsx:'2.1.1'});
 assert.equal(value.files['/src/App.tsx'],'export default function App() {}');assert.deepEqual(useBuiltInDependencies(value),value);
});
test('file creation and rename cannot introduce editable dependency manifests',()=>{
 for(const path of ['/package.json','/nested/Package.JSON','/package-lock.json','/pnpm-lock.yaml','/yarn.lock'])assert.throws(()=>assertEditableFile(path),/E_READ_ONLY_DEPENDENCIES/);
 assert.doesNotThrow(()=>assertEditableFile('/src/package.ts'));
});
test('migration refuses a manifest used as a scene entry instead of discarding its contents',()=>{
 const value=project();value.config.entry='/package.json';assert.throws(()=>useBuiltInDependencies(value),/E_PROJECT_MANIFEST/);assert.equal(value.files['/package.json'],'{unfinished old manifest');
});
