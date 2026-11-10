import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {prepareEngineProject,EngineProjectBuildError} from '@godot-js/react-build/core';

const encode=value=>new TextEncoder().encode(value),absolute='res://.godot/GodotJS/node_modules/@runtime/aliased/index.js';
const scene='[gd_scene format=3]\n[node name="Main" type="Node"]\n';
const source=`import {value as imported} from '@runtime/aliased';
import {local} from './relative';
export {value as forwarded} from '@runtime/aliased';
export * from '@runtime/aliased';
export * as namespace from '@runtime/aliased';
export const sum=imported+local;
export function ownRequire(){const require=(name)=>'shadow:'+name;return require('@runtime/aliased');}
export const literal="from '@runtime/aliased'";
`;

test('provided and project modules use their canonical outputs while shadow require stays unchanged',()=>{
 for(const extension of ['ts','js']){
  const filename='/src/aliases.'+extension;
  const previous=ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,inlineSourceMap:true}}).outputText;
  const result=prepareEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,[filename]:source,'/src/relative.ts':'export const local=1;'},runtimeModules:{'@runtime/aliased':encode('exports.value=41;')},generatedJs:{[filename]:previous}});
  const code=new TextDecoder().decode(result.files.get('res://.godot/GodotJS/src/aliases.js'));
  const seen=[],module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>{seen.push(name);if(name===absolute)return {value:41};if(name==='res://.godot/GodotJS/src/relative.js')return {local:1};throw Error('Unexpected module '+name);}});
  assert.equal(module.exports.sum,42);assert.equal(module.exports.forwarded,41);assert.equal(module.exports.namespace.value,41);
  assert.equal(module.exports.ownRequire(),'shadow:@runtime/aliased');assert.equal(module.exports.literal,"from '@runtime/aliased'");
  assert.ok(seen.includes(absolute));assert.ok(seen.includes('res://.godot/GodotJS/src/relative.js'));assert.ok(!seen.includes('@runtime/aliased'));
  const map=JSON.parse(new TextDecoder().decode(result.files.get('res://.godot/GodotJS/src/aliases.js.map')));
  assert.deepEqual(map.sources,['res://'+filename.slice(1)]);assert.deepEqual(map.sourcesContent,[source]);
 }
});

test('explicit runtime module paths expose their canonical alias without admitting missing npm packages',()=>{
 const result=prepareEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,'/consumer.ts':"import mod = require('@runtime/aliased'); export const value=mod.value;"},runtimeModules:{[absolute]:encode('exports.value=41;')}});
 const code=new TextDecoder().decode(result.files.get('res://.godot/GodotJS/consumer.js'));
 assert.match(code,/require\("res:\/\/\.godot\/GodotJS\/node_modules\/@runtime\/aliased\/index.js"\)/);
 assert.equal(result.manifest.runtimeModules['@runtime/aliased'],absolute);
 assert.throws(()=>prepareEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,'/bad.ts':"import {value} from '@runtime/missing'; export {value};"},runtimeModules:{'@runtime/aliased':encode('')}}),error=>error instanceof EngineProjectBuildError&&error.diagnostics.some(item=>item.code==='E_ENGINE_MODULE_UNAVAILABLE'));
});
test('native module metadata adaptation preserves shadowed require bindings',()=>{
 const source=`export function local(){const require=name=>'local:'+name;return require('godot');}
export function parameter(require){return require('godot');}
export function hoisted(){if(true){var require=name=>'hoisted:'+name;}return require('godot');}
export function destructured({require}){return require('godot');}`;
 const result=prepareEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,'/shadow.ts':source}});
 assert.equal(result.manifest.runtimeModules.godot,undefined);
 const module={exports:{}};vm.runInNewContext(new TextDecoder().decode(result.files.get('res://.godot/GodotJS/shadow.js')),{module,exports:module.exports,require:()=>{throw Error('Unexpected module load');}});
 assert.equal(module.exports.local(),'local:godot');assert.equal(module.exports.parameter(name=>'param:'+name),'param:godot');assert.equal(module.exports.hoisted(),'hoisted:godot');assert.equal(module.exports.destructured({require:name=>'object:'+name}),'object:godot');
});
