import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEngineProject,EngineProjectBuildError} from '../dist/core/index.js';
import {resourceUidTextToId,readResourceUidCache,resolveResourceUidFromCache} from '@godot-js/react-build/resource-uids';

const encode=value=>new TextEncoder().encode(value),cachePath='res://.godot/uid_cache.bin';
function cache(entries){const rows=entries.map(([id,path])=>[id,encode(path)]),out=new Uint8Array(4+rows.reduce((size,[,name])=>size+12+name.length,0)),view=new DataView(out.buffer);view.setUint32(0,rows.length,true);let offset=4;for(const [id,name]of rows){view.setBigUint64(offset,id,true);view.setUint32(offset+8,name.length,true);out.set(name,offset+12);offset+=12+name.length;}return [...out];}
function records(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result=new Map();let offset=4;for(let index=0;index<view.getUint32(0,true);index++){const id=view.getBigUint64(offset,true),length=view.getUint32(offset+8,true);result.set(id,new TextDecoder().decode(bytes.subarray(offset+12,offset+12+length)));offset+=12+length;}assert.equal(offset,bytes.length);return result;}
const project=files=>prepareEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':'[gd_scene format=3]\n[node name="Main" type="Node"]\n',...files}});

test('UID text decoding matches native base34, historical z/9 aliases and uint64 overflow',()=>{
 assert.equal(resourceUidTextToId('uid://d1t'),4371n);
 assert.equal(resourceUidTextToId('uid://ebd'),4661n);
 assert.equal(resourceUidTextToId('uid://d4n4ub6itg400'),0x7fffffffffffffffn);
 assert.equal(resourceUidTextToId('uid://a'),0n);assert.equal(resourceUidTextToId('uid://'),0n);
 assert.equal(resourceUidTextToId('uid://z'),resourceUidTextToId('uid://0'));
 assert.equal(resourceUidTextToId('uid://9'),resourceUidTextToId('uid://ba'));
 assert.equal(resourceUidTextToId('uid://'+'a'.repeat(32)+'d1t'),4371n);
 assert.equal(resourceUidTextToId('uid://b'+'a'.repeat(64)),(34n**64n)&0x7fffffffffffffffn);
 for(const value of ['UID://abc','uid://<invalid>','uid://bad_uid','uid://Abc','uid://é','not-a-uid'])assert.equal(resourceUidTextToId(value),undefined);
});

test('header, sidecar and import identities merge with valid native cache entries',()=>{
 const original={
  '/scene.tscn':'[gd_scene format=3 uid="uid://d1t"]\n[ext_resource type="Resource" uid="uid://b" path="res://external.tres" id="1"]\n',
  '/material.tres':'\n; source comment\n[gd_resource type="Resource" format=3 uid="uid://bc"]\n',
  '/src/main.ts':'export default class Main {}','/src/main.ts.uid':'uid://bd\n',
  '/image.png':[137,80,78,71],'/image.png.import':'[remap]\nuid="uid://be"\npath="res://.godot/imported/image.ctex"\n',
  '/.godot/imported/image.ctex':[1,2],'/already.res':[0,1], '/.godot/uid_cache.bin':cache([[999n,'res://already.res'],[1000n,'user://saved.tres']]),
 };
 const result=project(original),values=records(result.files.get(cachePath));
 assert.deepEqual([...values],[[36n,'res://material.tres'],[37n,'res://src/main.ts'],[38n,'res://image.png'],[999n,'res://already.res'],[1000n,'user://saved.tres'],[4371n,'res://scene.tscn']]);
 assert.equal(values.has(1n),false,'ext_resource references must not claim the containing scene');
 assert.deepEqual(result.diagnostics,[]);
 assert.equal(new TextDecoder().decode(result.files.get('res://scene.tscn')),original['/scene.tscn']);
});

test('native append-cache replacement semantics survive canonical merge and source rename updates',()=>{
 const result=project({'/.godot/uid_cache.bin':cache([[7n,'res://older.res'],[7n,'res://kept.res'],[4371n,'res://old-scene.tscn']]),'/new-scene.tscn':'[gd_scene format=3 uid="uid://d1t"]\n','/kept.res':[4]});
 const values=records(result.files.get(cachePath));assert.equal(values.get(7n),'res://kept.res');assert.equal(values.get(4371n),'res://new-scene.tscn');
 assert.deepEqual(result.diagnostics.map(item=>item.code),['W_ENGINE_UID_CACHE_UPDATED']);
});

test('malformed caches retain verified entries and invalid metadata produces honest diagnostics',()=>{
 const prefix=cache([[41n,'res://kept.res']]);prefix[0]=2;
 const result=project({'/.godot/uid_cache.bin':prefix,'/kept.res':[4],'/bad.gdshader.uid':'uid://bad_value','/bad.gdshader':'shader_type canvas_item;'});
 assert.equal(records(result.files.get(cachePath)).get(41n),'res://kept.res');
 assert.ok(result.diagnostics.some(item=>item.code==='W_ENGINE_UID_CACHE_INVALID'));
 assert.ok(result.diagnostics.some(item=>item.code==='W_ENGINE_UID_INVALID'));
 const invalid=project({'/.godot/uid_cache.bin':[0,0,0,0,255]});assert.equal(records(invalid.files.get(cachePath)).size,0);
 assert.ok(invalid.diagnostics.some(item=>item.code==='W_ENGINE_UID_CACHE_INVALID'));
});

test('UID collisions and unresolved UID main scenes fail rather than choosing another resource',()=>{
 assert.throws(()=>project({'/one.tscn':'[gd_scene format=3 uid="uid://d1t"]','/two.tres':'[gd_resource type="Resource" uid="uid://d1t"]'}),error=>error instanceof EngineProjectBuildError&&error.diagnostics.some(item=>item.code==='E_ENGINE_UID_CONFLICT'));
 assert.throws(()=>project({'/.godot/uid_cache.bin':cache([[4371n,'res://kept.res']]),'/kept.res':[4],'/other.tscn':'[gd_scene format=3 uid="uid://d1t"]'}),error=>error.diagnostics.some(item=>item.code==='E_ENGINE_UID_CACHE_CONFLICT'));
 assert.throws(()=>project({'/.godot/uid_cache.bin':cache([[4371n,'res://Virtual.ts']]),'/.godot/GodotJS/Virtual.js':'module.exports={};','/other.tscn':'[gd_scene format=3 uid="uid://d1t"]'}),error=>error.diagnostics.some(item=>item.code==='E_ENGINE_UID_CACHE_CONFLICT'));
 assert.throws(()=>prepareEngineProject({runtime:'godot',files:{'/project.godot':'config_version=5\n[application]\nrun/main_scene="uid://d1t"\n'}}),error=>error.diagnostics.some(item=>item.code==='E_ENGINE_UID_UNRESOLVED'));
});

test('the thin public UID helper resolves binary native scenes from existing cache alone',()=>{
 const bytes=Uint8Array.from(cache([[4371n,'res://native/主场景.scn'],[4661n,'res://materials/native.res']]));
 assert.equal(resolveResourceUidFromCache('uid://d1t',bytes),'res://native/主场景.scn');
 assert.equal(resolveResourceUidFromCache('uid://ebd',bytes),'res://materials/native.res');
 assert.equal(resolveResourceUidFromCache('uid://ba',bytes),undefined);
 assert.equal(resolveResourceUidFromCache('uid://invalid_uid',bytes),undefined);
 assert.equal(readResourceUidCache(bytes).diagnostics.length,0);
 const result=prepareEngineProject({runtime:'godot',files:{'/project.godot':'config_version=5\n[application]\nrun/main_scene="uid://d1t"\n','/native/主场景.scn':[1,2,3],'/.godot/uid_cache.bin':[...bytes]}});
 assert.equal(resolveResourceUidFromCache('uid://d1t',result.files.get(cachePath)),'res://native/主场景.scn');
});

test('the public UID-only package subpath stays browser-safe without bundling TypeScript',async()=>{
 const {build}=await import('esbuild');
 const result=await build({stdin:{contents:"import {resolveResourceUidFromCache} from '@godot-js/react-build/resource-uids'; export {resolveResourceUidFromCache};",resolveDir:process.cwd()},platform:'browser',format:'esm',bundle:true,write:false,metafile:true});
 assert.ok(!Object.keys(result.metafile.inputs).some(name=>/typescript|react-browser|apps\//.test(name)));
 assert.ok(result.outputFiles[0].contents.length<16000);
});
