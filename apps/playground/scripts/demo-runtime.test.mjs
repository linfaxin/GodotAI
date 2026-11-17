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

test('demo sources enter the build before startup with one aggregated UID cache',async()=>{
 const {DemoSourceComposer}=await import('../src/demo-source-files.ts');
 const {readResourceUidCache}=await import('@godot-js/project-tools/resource-uids');
 const cache=(id,path)=>{const text=bytes(path),result=new Uint8Array(16+text.length),view=new DataView(result.buffer);view.setUint32(0,1,true);view.setBigUint64(4,BigInt(id),true);view.setUint32(12,text.length,true);result.set(text,16);return result;};
 const demo={demoDescriptorHash:'verified-demo',resources:packProject(new Map([
  ['res://assets/demo.res',Uint8Array.of(7,8,9)],['res://.playground/demo-manifest.json',bytes('{"assets":{},"models":{}}')],
  ['res://.godot/uid_cache.bin',cache(20,'res://assets/demo.res')],
 ])).pack};
 const composer=new DemoSourceComposer(),result=composer.compose({'/start.ts':'export function start(){}','/.godot/uid_cache.bin':Array.from(cache(10,'res://own.tres'))},demo,'export default class Input {}');
 assert.deepEqual(result['/assets/demo.res'],Uint8Array.of(7,8,9));assert.equal(result['/.playground/demo-resources.pck'],undefined);
 assert.equal(result['/.playground/demo-input.ts'],'export default class Input {}');
 const parsed=readResourceUidCache(result['/.godot/uid_cache.bin']);assert.deepEqual(parsed.diagnostics,[]);assert.equal(parsed.entries.get(10n),'res://own.tres');assert.equal(parsed.entries.get(20n),'res://assets/demo.res');
 assert.throws(()=>composer.compose({'/.godot/uid_cache.bin':Array.from(cache(20,'res://different.res'))},demo,''),/E_ENGINE_UID_CACHE_CONFLICT/);
 assert.throws(()=>composer.compose({'/assets/demo.res':[7,8,9]},demo,''),/E_DEMO_RESOURCE_COLLISION/);
 const codePack={demoDescriptorHash:'wrong',resources:packProject(new Map([['res://project.godot',bytes('injected')]])).pack};
 assert.throws(()=>composer.compose({},codePack,''),/E_DEMO_RESOURCE_PATH/);
 const corrupted=demo.resources.slice();corrupted[112]^=1;
 assert.throws(()=>new DemoSourceComposer().compose({},{...demo,resources:corrupted},''),/E_PCK_INDEX/);
});
