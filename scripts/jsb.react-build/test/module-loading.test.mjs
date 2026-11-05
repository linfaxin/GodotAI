import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {bundleClosedModules} from '../dist/module-loading.js';
import {buildProject} from '../dist/index.js';
import {bundleClosedModulesWith} from '../dist/core/module-loading.js';
import * as esbuild from 'esbuild';

test('browser namespaces accept owned input aliases and validate the emitted external URI', async () => {
  const uri = 'res://generated/react/test/vendor/react.js';
  const options = rewritten => ({ entryPoints: ['entry'], bundle: true, write: false, format: 'cjs', platform: 'neutral', plugins: [{ name: 'browser-vfs', setup(build) {
    build.onResolve({ filter: /^entry$/ }, () => ({ path: '/src/App.tsx', namespace: 'project' }));
    build.onLoad({ filter: /.*/, namespace: 'project' }, () => ({ contents: 'import React from "react"; export default React;', loader: 'ts' }));
    build.onResolve({ filter: /^react$/ }, () => ({ path: rewritten, external: true }));
  } }] });
  const result = await bundleClosedModulesWith(esbuild, options(uri), [uri], { react: uri });
  assert(result.outputFiles[0].text.includes(uri));
  await assert.rejects(bundleClosedModulesWith(esbuild, options('unregistered-package'), [uri], { react: uri }), /E_DYNAMIC_MODULE/);
  await assert.rejects(bundleClosedModulesWith(esbuild, options(uri), []), /E_DYNAMIC_MODULE/);
});

test('unresolved loaders and escaped require in dependencies are rejected with source locations', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'react-module-loading-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'node_modules/dependency'),{recursive:true});
  await fs.writeFile(path.join(root,'entry.js'),'module.exports=require("dependency")');
  for(const source of ['exports.load=p=>require(p)','exports.load=p=>import(p)','const loader=require;exports.load=p=>loader(p)']){
    await fs.writeFile(path.join(root,'node_modules/dependency/index.js'),source);
    await assert.rejects(bundleClosedModules({entryPoints:[path.join(root,'entry.js')],bundle:true,write:false,format:'cjs',platform:'neutral'},[]),e=>e.code==='E_DYNAMIC_MODULE'&&/dependency.*index.js/.test(e.message));
  }
});

test('computed glob paths are refused; literal imports, literal requires and shadowed functions work',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'react-module-glob-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'models'));await fs.writeFile(path.join(root,'models/inventory.ts'),'export const value="INVENTORY_CONTENT";');
  const bundle=contents=>bundleClosedModules({stdin:{contents,resolveDir:root,sourcefile:'entry.ts',loader:'ts'},bundle:true,write:false,format:'cjs',platform:'neutral'},[]);
  for(const source of ['export const load=p=>require("./models/"+p)','export const load=p=>import(`./models/${p}`)'])await assert.rejects(bundle(source),e=>e.code==='E_DYNAMIC_MODULE');
  for(const source of ['export const load=()=>require("./models/inventory")','export const load=()=>import("./models/inventory")','import {value} from "./models/inventory";export {value}']){
    const result=await bundle(source);assert(result.outputFiles[0].text.includes('INVENTORY_CONTENT'));
  }
  await assert.doesNotReject(bundle('function require(value){return value};export const load=value=>require(value)'));
});

test('a late event loader fails publication and literal loading publishes the model',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'react-module-publication-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'src/models'),{recursive:true});
  await fs.writeFile(path.join(root,'project.godot'),'config_version=5\n[application]\nconfig/name="module-loading"\n');
  await fs.writeFile(path.join(root,'godot-react.config.mjs'),'export default {entries:{app:"src/App.tsx"}};');
  await fs.writeFile(path.join(root,'src/models/inventory.ts'),'export const inventory="INVENTORY_CONTENT";');
  const source=body=>`declare const require:(id:string)=>any;import {Button} from "@godot-js/react";${body}`;
  await fs.writeFile(path.join(root,'src/App.tsx'),source('function load(name:string){return require(name)}export default function App(){return <Button onPressed={()=>load("./models/inventory")}/>;}'));
  await assert.rejects(buildProject({projectRoot:root}),e=>e.code==='E_DYNAMIC_MODULE'&&/App.tsx/.test(e.message));
  await assert.rejects(fs.access(path.join(root,'generated/react/active.json')));
  await fs.writeFile(path.join(root,'src/App.tsx'),source('export default function App(){return <Button onPressed={()=>require("./models/inventory")}/>;}'));
  const valid=await buildProject({projectRoot:root});
  const output=await fs.readFile(path.join(root,valid.manifest.modules['entry-app'].uri.slice(6)),'utf8');assert(output.includes('INVENTORY_CONTENT'));
  const active=await fs.readFile(valid.activePath,'utf8');
  await fs.writeFile(path.join(root,'src/App.tsx'),source('export default function App(){return <Button onPressed={()=>import(String("./models/inventory"))}/>;}'));
  await assert.rejects(buildProject({projectRoot:root}),e=>e.code==='E_DYNAMIC_MODULE');
  assert.equal(await fs.readFile(valid.activePath,'utf8'),active);
});
