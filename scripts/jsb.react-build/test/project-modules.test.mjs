import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEngineProject} from '@godot-js/react-build/core';
import {moduleCandidates,projectModulePath} from '@godot-js/react-build/project-modules';

test('project module spellings resolve to the same emitted module',()=>{
 const source=`import {value} from './helper';export const direct=value;export {value as absolute} from 'res://src/helper.ts';export const common=require('./helper.js');export {value as named} from '/src/helper';`;
 const result=prepareEngineProject({runtime:'godot',entry:'/src/Main.ts',files:{'/src/Main.ts':source,'/src/helper.ts':'export const value=42;'}});
 const code=new TextDecoder().decode(result.files.get(result.manifest.modules['res://src/Main.ts']));
 assert.equal(code.match(/require\("res:\/\/\.godot\/GodotJS\/src\/helper.js"\)/g).length,4);
 assert.equal(projectModulePath('../helper','res://src/nested/Main.ts'),'/src/helper');
 assert(moduleCandidates('/src/foo.mjs').includes('/src/foo.mts'));
});
test('mjs/mts/cts imports point at the actual CommonJS output',()=>{
 for(const extension of ['mjs','mts','cts']){
  const result=prepareEngineProject({runtime:'godot',entry:'/src/Main.ts',files:{'/src/Main.ts':`export {value} from './helper.${extension}';`,['/src/helper.'+extension]:'export const value=42;'},...(extension==='cts'?{}:{generatedJs:{['/src/helper.'+extension]:'export const value=42;'}})});
  const target=result.manifest.modules['res://src/helper.'+extension];
  const code=new TextDecoder().decode(result.files.get(result.manifest.modules['res://src/Main.ts']));
  assert.equal(target,'res://.godot/GodotJS/src/helper.js');assert(code.includes(JSON.stringify(target)));
  assert.match(new TextDecoder().decode(result.files.get(target)),/exports.value/);
 }
});
