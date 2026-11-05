import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {createResolver} from '../dist/resolve.js';
import {createFixtureTransport, createJsDelivrTransport, npmFileUrl} from '../dist/transport.js';

const encode = value => new TextEncoder().encode(value);
const release = {id:'fixture-release-v1', specifiers:{react:'React','react/jsx-runtime':'jsxRuntime','react/jsx-dev-runtime':'jsxDevRuntime','@godot-js/react':'sdk','@godot-js/react/scheduler':'scheduler',scheduler:'scheduler'},react:{react:'19.3.1',reconciler:'0.34.0',scheduler:'0.28.0'}};
function project(source, dependencies={}, extra={}) {
  return {revision:'r1', sourceHash:'snapshot-hash',files:new Map([['/src/App.ts',encode(source)],...Object.entries(extra).map(([path,body])=>[path,encode(body)])]),config:{entry:'src/App.ts',dependencies,mode:'production'}};
}
function pkg(fixtures,name,version,metadata,files) {
  fixtures[`${name}@${version}/package.json`] = JSON.stringify({name,version,...metadata});
  for(const [path,body] of Object.entries(files)) fixtures[`${name}@${version}/${path}`]=body;
}
function setup(fixtures,extra={}) {
  const transport=createFixtureTransport(fixtures);
  return {...transport,resolver:createResolver({...transport,typescript:ts,...extra})};
}
function instance(result,name,version) { return Object.values(result.instances).find(item=>item.name===name&&item.version===version); }

test('separate runtime/type graphs honor conditional ESM/CJS exports and declaration dependencies',async()=>{
  const fixtures={};
  pkg(fixtures,'dual','1.0.0',{exports:{'.':{types:'./index.d.ts',import:'./import.js',require:'./require.cjs'},'./data':'./data.json'}},{
    'import.js':'export const value="import";','require.cjs':'exports.value="require";',
    'index.d.ts':'import type {Value} from "./types"; export declare const value:Value;',
    'types.d.ts':'export type Value=string;','data.json':'{"n":4}',
  });
  const {resolver}=setup(fixtures);
  const snapshot=project('import {value} from "dual"; declare const require:(s:string)=>unknown; export const c=require("dual"); import data from "dual/data"; export {value,data};',{dual:'1.0.0'});
  const result=await resolver.resolveProject(snapshot,release);
  const root=instance(result,'dual','1.0.0').root;
  assert(result.runtimeGraph.nodes[`${root}/import.js`]);
  assert(result.runtimeGraph.nodes[`${root}/require.cjs`]);
  assert(result.runtimeGraph.nodes[`${root}/data.json`]);
  assert(!result.runtimeGraph.nodes[`${root}/index.d.ts`]);
  assert(result.typeGraph.nodes[`${root}/index.d.ts`]);
  assert(result.typeGraph.nodes[`${root}/types.d.ts`]);
  assert.equal(result.typeGraph.unresolved.length,0);
  assert(result.typeGraph.edges.some(edge=>edge.importer==='/src/App.ts'&&edge.specifier==='dual'&&edge.resolved===`${root}/index.d.ts`&&edge.runtimeInstanceId===instance(result,'dual','1.0.0').id));
});

test('nested versions, relative extension/directory lookup, cycles and JSON are closed',async()=>{
  const fixtures={};
  for(const [name,range]of [['a','^1.0.0'],['b','^2.0.0']]) pkg(fixtures,name,'1.0.0',{main:'index.js',types:'index.d.ts',dependencies:{shared:range}},{'index.js':'module.exports=require("shared");','index.d.ts':'export {v} from "shared";'});
  for(const version of ['1.2.0','2.3.0']) pkg(fixtures,'shared',version,{main:'lib',types:'lib/index.d.ts'},{'lib/index.js':'const data=require("./data.json");require("./cycle");exports.v=data.v;','lib/data.json':`{"v":"${version}"}`,'lib/cycle.js':'require("./index.js");','lib/index.d.ts':'export declare const v:string;'});
  const {resolver,versionRequests}=setup(fixtures);
  const result=await resolver.resolveProject(project('import "a";import "b";',{a:'1.0.0',b:'1.0.0'}),release);
  assert(instance(result,'shared','1.2.0')); assert(instance(result,'shared','2.3.0'));
  assert.equal(Object.keys(result.instances).length,4);
  assert(versionRequests.includes('shared@^1.0.0')); assert(versionRequests.includes('shared@^2.0.0'));
  assert.equal(result.typeGraph.unresolved.length,0);
});

test('lock replay makes no version queries and verifies every fetched byte',async()=>{
  const fixtures={};
  pkg(fixtures,'a','1.0.0',{dependencies:{shared:'^1.0.0'},types:'index.d.ts'},{'index.js':'export {v} from "shared";','index.d.ts':'export {v} from "shared";'});
  pkg(fixtures,'shared','1.2.0',{types:'index.d.ts'},{'index.js':'export const v=42;','index.d.ts':'export declare const v:number;'});
  const snapshot=project('export {v} from "a";',{a:'1.0.0'}), first=setup(fixtures);
  const initial=await first.resolver.resolveProject(snapshot,release);
  const replay=setup(fixtures,{resolveVersion:()=>{throw Error('range resolution during replay');}});
  const result=await replay.resolver.resolveProject({...snapshot,lock:initial.lock},release);
  assert.equal(result.hash,initial.hash); assert.deepEqual(result.lock,initial.lock);
  const changed=setup({...fixtures,'shared@1.2.0/index.js':'export const v=43;'});
  await assert.rejects(changed.resolver.resolveProject({...snapshot,lock:initial.lock},release),error=>error.code==='E_LOCK_CONTENT');
  const stale=structuredClone(initial.lock); delete stale.files['https://cdn.jsdelivr.net/npm/shared@1.2.0/index.js'];
  await assert.rejects(first.resolver.resolveProject({...snapshot,lock:stale},release),error=>error.code==='E_LOCK_MISS');
});

test('malformed locks fail before fetching or silently selecting fresh dependency versions',async()=>{
  const fixtures={};pkg(fixtures,'a','1.0.0',{types:'index.d.ts'},{'index.js':'export const v=1;','index.d.ts':'export declare const v:number;'});
  const source=project('import "a";',{a:'1.0.0'}),initial=await setup(fixtures).resolver.resolveProject(source,release);
  const invalidDigest=structuredClone(initial.lock);Object.values(invalidDigest.files)[0].sha256='not-a-sha256';
  const invalidSize=structuredClone(initial.lock);Object.values(invalidSize.files)[0].size=-1;
  for(const lock of [null,0,{},invalidDigest,invalidSize]){
    const transport=setup(fixtures);
    await assert.rejects(transport.resolver.resolveProject({...source,lock},release),error=>error.code==='E_LOCK_FORMAT');
    assert.equal(transport.requests.length,0);assert.equal(transport.versionRequests.length,0);
  }
});

test('peer context creates separate instances and canonical React rejects incompatible peers',async()=>{
  const fixtures={};
  for(const [name,version]of [['one','1.0.0'],['two','2.0.0']]) pkg(fixtures,name,'1.0.0',{dependencies:{plugin:'1.0.0',host:version},types:'index.d.ts'},{'index.js':'export {v} from "plugin";','index.d.ts':'export {v} from "plugin";'});
  pkg(fixtures,'plugin','1.0.0',{peerDependencies:{host:'*'},types:'index.d.ts'},{'index.js':'export const v=1;','index.d.ts':'export declare const v:number;'});
  pkg(fixtures,'host','1.0.0',{},{});pkg(fixtures,'host','2.0.0',{},{});
  const {resolver}=setup(fixtures);
  const result=await resolver.resolveProject(project('import "one";import "two";',{one:'1.0.0',two:'1.0.0'}),release);
  const plugins=Object.values(result.instances).filter(item=>item.name==='plugin');
  assert.equal(plugins.length,2);assert.notEqual(plugins[0].id,plugins[1].id);
  assert.deepEqual(plugins.map(item=>item.peerBindings.host).sort(),['host@1.0.0','host@2.0.0']);
  pkg(fixtures,'bad-react','1.0.0',{peerDependencies:{react:'^18.0.0'}},{'index.js':'export const v=1;'});
  await assert.rejects(setup(fixtures).resolver.resolveProject(project('import "bad-react";',{'bad-react':'1.0.0'}),release),error=>error.code==='E_REACT_SINGLETON');
  await assert.rejects(resolver.resolveProject(project('import "react";',{react:'18.2.0'}),release),error=>error.code==='E_REACT_SINGLETON');
  pkg(fixtures,'bad-direct-react','1.0.0',{dependencies:{react:'^18.0.0'}},{'index.js':'import React from "react";export {React};'});
  await assert.rejects(setup(fixtures).resolver.resolveProject(project('import "bad-direct-react";',{'bad-direct-react':'1.0.0'}),release),error=>error.code==='E_REACT_SINGLETON');
});

test('explicit @types supplementation preserves runtime/type package identity binding',async()=>{
  const fixtures={};
  pkg(fixtures,'untyped','1.0.0',{main:'index.js'},{'index.js':'exports.v=1;'});
  pkg(fixtures,'@types/untyped','1.1.0',{types:'index.d.ts',dependencies:{'@types/helper':'^2.0.0'}},{'index.d.ts':'import {V} from "@types/helper";export declare const v:V;'});
  pkg(fixtures,'@types/helper','2.0.1',{types:'index.d.ts'},{'index.d.ts':'export type V=number;'});
  const {resolver}=setup(fixtures);
  const result=await resolver.resolveProject(project('import {v} from "untyped";export {v};',{untyped:'1.0.0','@types/untyped':'1.1.0'}),release);
  const edge=result.typeGraph.edges.find(edge=>edge.importer==='/src/App.ts'&&edge.specifier==='untyped');
  assert.equal(edge.runtimeInstanceId,instance(result,'untyped','1.0.0').id);
  assert.equal(edge.typeInstanceId,instance(result,'@types/untyped','1.1.0').id);
  assert.equal(result.typeGraph.unresolved.length,0);
  const missing=await resolver.resolveProject(project('import "untyped";',{untyped:'1.0.0'}),release);
  assert.equal(missing.typeGraph.unresolved[0].code,'E_TYPES_NOT_FOUND');
});

test('certified SDK aliases are external and local SDK declaration closure needs no fetch',async()=>{
  const {resolver,requests}=setup({});
  const snapshot=project('import React from "react";import {x} from "@godot-js/react";import "@godot-js/react/scheduler";export {React,x};',{}, {
    '/node_modules/@types/react/index.d.ts':'import type {Properties} from "csstype";export type CSS=Properties;declare const React:unknown;export default React;',
    '/node_modules/csstype/index.d.ts':'export interface Properties {color?:string}',
    '/node_modules/@godot-js/react/dist/index.d.ts':'export declare const x:number;',
    '/node_modules/@godot-js/react/dist/scheduler.d.ts':'export declare function now():number;',
  });
  const result=await resolver.resolveProject(snapshot,release);
  assert.equal(requests.length,0);assert.equal(result.typeGraph.unresolved.length,0);
  assert(result.runtimeGraph.edges.every(edge=>edge.external));
  assert(result.typeGraph.nodes['/node_modules/csstype/index.d.ts']);
});

test('only static runtime imports enter runtime graph; type-only imports and shadowed require are handled',async()=>{
  const fixtures={};pkg(fixtures,'only-types','1.0.0',{types:'index.d.ts'},{'index.d.ts':'export type T=number;'});
  const {resolver}=setup(fixtures);
  const result=await resolver.resolveProject(project('import type {T} from "only-types";export {type T} from "only-types";function require(x:string){return x};export const v=require("not-a-package");export type Value=T;',{'only-types':'1.0.0'}),release);
  assert.equal(result.runtimeGraph.edges.length,0);assert.equal(result.typeGraph.unresolved.length,0);
  assert(instance(result,'only-types','1.0.0'));
});

test('exact exports remain usable beside unsupported wildcard exports and .js source paths resolve TS',async()=>{
  const fixtures={};
  pkg(fixtures,'explicit','1.0.0',{exports:{'.':{types:'./index.d.ts',default:'./index.js'},'./*':'./*.js'}},{'index.js':'export const x=1;','index.d.ts':'export declare const x:number;'});
  const result=await setup(fixtures).resolver.resolveProject(project('import {x} from "explicit";export {v} from "./relative.js";export {x};',{explicit:'1.0.0'},{'/src/relative.ts':'export const v=2;'}),release);
  assert(result.runtimeGraph.nodes['/src/relative.ts']);assert.equal(result.typeGraph.unresolved.length,0);
});

test('unsupported npm features, blocked exports and Node builtins have stable errors',async()=>{
  const fixtures={};
  pkg(fixtures,'blocked','1.0.0',{exports:{'.':'./index.js','./private':null}},{'index.js':'export {};'});
  pkg(fixtures,'wild','1.0.0',{exports:{'./*':'./*.js'}},{});
  pkg(fixtures,'indirect','1.0.0',{}, {'index.js':'import "node:fs";'});
  for(const [source,deps,code]of [
    ['import "blocked/private";',{blocked:'1.0.0'},'E_PACKAGE_EXPORT'],
    ['import "blocked/nope";',{blocked:'1.0.0'},'E_PACKAGE_EXPORT'],
    ['import "wild/x";',{wild:'1.0.0'},'E_EXPORTS_UNSUPPORTED'],
    ['import "#private";',{},'E_PACKAGE_IMPORTS_UNSUPPORTED'],
    ['import "indirect";',{indirect:'1.0.0'},'E_NODE_BUILTIN'],
    ['import "fs/promises";',{},'E_NODE_BUILTIN'],
    ['import "node:crypto";',{},'E_NODE_BUILTIN'],
    ['import "node:test";',{},'E_NODE_BUILTIN'],
    ['import "dep";',{dep:'^1.0.0'},'E_DIRECT_VERSION'],
    ['import "undeclared";',{},'E_UNDECLARED_DEPENDENCY'],
  ]) await assert.rejects(setup(fixtures).resolver.resolveProject(project(source,deps),release),error=>error.code===code,`${source} -> ${code}`);
});

test('raw TSCN is never classified as an executable or prevalidated template module',async()=>{
  const snapshot=project('import scene from "./scene.tscn";export {scene};',{}, {'/src/scene.tscn':'[gd_scene format=3]\n[node name="Root" type="Node"]\n'});
  await assert.rejects(setup({}).resolver.resolveProject(snapshot,release),error=>error.code==='E_MODULE_FORMAT'&&error.message.includes('scene.tscn'));
});

test('abort, budgets, iterable owned VFS and mutation isolation',async()=>{
  const fixtures={};pkg(fixtures,'big','1.0.0',{}, {'index.js':'export const text="abcdefghijklmnopqrstuvwxyz";'});
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(setup(fixtures).resolver.resolveProject(project('import "big";',{big:'1.0.0'}),release,{signal:cancelled.signal}),{name:'AbortError'});
  await assert.rejects(setup(fixtures,{budgets:{maxFileBytes:10}}).resolver.resolveProject(project('import "big";',{big:'1.0.0'}),release),error=>error.code==='E_FILE_BUDGET');
  const snapshot=project('export const x=1;');const original=snapshot.files.get('/src/App.ts');
  const owned={entries:()=>snapshot.files.entries(),[Symbol.iterator]:()=>snapshot.files[Symbol.iterator]()};
  const result=await setup({}).resolver.resolveProject({...snapshot,files:owned},release);
  original.fill(0);assert.match(new TextDecoder().decode(result.files['/src/App.ts']),/export const x=1/);
});

test('raw jsDelivr transport validates status, response limits and semver metadata',async()=>{
  const observed=[];
  const transport=createJsDelivrTransport({maxFileBytes:100,fetch:async(url,init)=>{
    observed.push([String(url),init]);
    return String(url).includes('/resolve/')?new Response('{"version":"1.2.3"}'):new Response('export const x=1;');
  }});
  const url=npmFileUrl('@scope/pkg','1.0.0','dist/my file.js');
  assert.equal(url,'https://cdn.jsdelivr.net/npm/@scope/pkg@1.0.0/dist/my%20file.js');
  assert.equal(new TextDecoder().decode(await transport.fetchFile(url)),'export const x=1;');
  assert.equal(await transport.resolveVersion('a','^1.0.0'),'1.2.3');
  assert(observed.every(([,init])=>init.redirect==='error'));
  await assert.rejects(createJsDelivrTransport({fetch:async()=>new Response('missing',{status:404})}).fetchFile(url),error=>error.code==='E_FILE_NOT_FOUND');
  await assert.rejects(createJsDelivrTransport({maxFileBytes:3,fetch:async()=>new Response('1234')}).fetchFile(url),error=>error.code==='E_FILE_BUDGET');
});
