import test from 'node:test';
import assert from 'node:assert/strict';
import {packProject} from '@godot-js/react-browser/pck';
import {unpackResources} from './build-demo-runtime.mjs';
const bytes=value=>new TextEncoder().encode(value);
test('demo resource extraction preserves exported dependencies and drops the removed runner',()=>{
 const files=new Map([
  ['res://assets/derived/image.png.import',bytes('[remap]')],
  ['res://assets/derived/shader.tres.remap',bytes('[remap]')],
  ['res://.godot/imported/image.ctex',new Uint8Array([1,2,255])],
  ['res://.godot/exported/1/shader.res',new Uint8Array([7,8,0])],
  ['res://.godot/uid_cache.bin',new Uint8Array([0,0,0,0])],
  ['res://shaders/plasma.gdshader',bytes('shader_type canvas_item;')],
  ['res://host.ts',bytes('removed host')],['res://.godot/GodotJS/host.js',bytes('removed host')],
  ['res://generated/vendor.js',bytes('removed renderer')],['res://project.godot',bytes('removed startup')],
 ]);
 const extracted=unpackResources(packProject(files).pack);
 assert.equal(extracted.size,6);
 for(const [name,value]of extracted)assert.deepEqual(value,files.get(name));
 assert(!extracted.has('res://host.ts'));assert(!extracted.has('res://generated/vendor.js'));assert(!extracted.has('res://project.godot'));
 assert.throws(()=>unpackResources(new Uint8Array(112)),/PCK/);
});
