import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {RESOURCE_FORMATS,resourceFormat,inspectResourceFormat} from '../dist/resource-formats.js';
import {ResourceConverterRegistry,createBrowserResourceConverters,pcmWavConverter,decodePcmWav,parseResourceImports} from '../dist/resource-converters.js';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../dist/build-plan.js';
import {assessStoredImportReceipt} from '../dist/import-receipts.js';

const encode=value=>new TextEncoder().encode(value),decode=value=>new TextDecoder().decode(value);
const target={resourceAbi:'godot-4-text-resource-v1',features:{engine:'fixture'}};
function wav(samples=[0,128,255]){
 const bytes=new Uint8Array(44+samples.length+(samples.length%2)),view=new DataView(bytes.buffer);
 bytes.set(encode('RIFF'),0);view.setUint32(4,bytes.length-8,true);bytes.set(encode('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);bytes.set(encode('data'),36);view.setUint32(40,samples.length,true);bytes.set(samples,44);return bytes;
}
const request={resource:'res://tone.wav',converter:'godotjs/wav-pcm'};
test('format directory distinguishes native API, ResourceLoader and executable browser producer routes',()=>{
 for(const extension of ['png','jpg','svg','tscn','tres','gltf','glb','ogg','wav','blend'])assert(resourceFormat('res://asset.'+extension),extension);
 assert.equal(resourceFormat('res://x.tscn').resourceLoader,'native');
 for(const format of ['svg','gltf','ogg','editor-source'])assert.deepEqual(RESOURCE_FORMATS.find(item=>item.id===format).browserConverters,[]);
 assert.deepEqual(inspectResourceFormat('x.png',{registeredConverters:createBrowserResourceConverters().ids}).converters,[]);
 assert.equal(inspectResourceFormat('x.ogg',{apiSymbols:new Set()}).directApi[0].present,false);
});
test('registered PCM conversion creates remap/receipt, preserves originals and UID, and reuses only verified current cache',async()=>{
 const original=wav(),files=new Map([['res://tone.wav',original],['res://tone.wav.import',encode('[remap]\nuid="uid://bb"\n')]]),registry=createBrowserResourceConverters();
 const first=await registry.run([request],files,target),receipt=first.receipts[0];
 assert.equal(receipt.uid,'uid://bb');assert.equal(first.assessments[0].status,'fresh');
 const output=receipt.outputs.find(item=>item.path.endsWith('.tres')).path;
 assert.match(decode(first.files.get(output)),/data=PackedByteArray\(128,0,127\)/);assert.doesNotMatch(decode(first.files.get(output)),/uid=/);assert.match(decode(first.files.get('res://tone.wav.import')),/uid="uid:\/\/bb"/);
 assert.match(decode(first.files.get('res://tone.wav.import')),/AudioStreamWAV/);assert.deepEqual(files.get('res://tone.wav'),original);assert.equal(files.size,2);
 const cached=new Map([...files,...first.files]);const reused=await registry.run([request],cached,target,[receipt]);assert.equal(reused.assessments[0].status,'fresh');assert.match(reused.reasons.get(output),/Verified cached/);
 const external=await createBrowserResourceConverters().run([request],cached,target,[receipt]);assert.match(external.reasons.get(output),/Converted/,'An imported self-declared producer receipt must execute again');
 assert.equal((await assessStoredImportReceipt(receipt,cached,cached)).status,'unverified');
 const broken=new Map(cached);broken.set(output,encode('corrupt'));const rebuilt=await registry.run([request],broken,target,[receipt]);assert.match(rebuilt.reasons.get(output),/Converted/);assert.deepEqual(rebuilt.files.get(output),first.files.get(output));
 const edited=new Map(cached);edited.set('res://tone.wav',wav([8,16]));const changed=await registry.run([request],edited,target,[receipt]);assert.notEqual(changed.receipts[0].outputs[0].sha256,receipt.outputs[0].sha256);
 const changedTarget=await registry.run([request],cached,{...target,features:{engine:'other'}},[receipt]);assert.notDeepEqual(changedTarget.receipts[0].outputs,receipt.outputs);
 const versioned=new ResourceConverterRegistry().register({...pcmWavConverter,version:'2.0.0'});assert.notDeepEqual((await versioned.run([request],cached,target,[receipt])).receipts[0].converter,receipt.converter);
 await assert.rejects(registry.run([{...request,uid:'uid://other'}],files,target),/UID conflicts/);
 await assert.rejects(registry.run([{...request,parameters:{resample:4000}}],files,target),/does not accept/);
 await assert.rejects(registry.run([{...request,dependencies:['res://missing.bin']}],files,target),/Missing conversion source/);
 await assert.rejects(registry.run([{...request,converter:'editor-importer'}],files,target),/not registered/);
});
test('PCM decoder rejects compressed, inconsistent, truncated and partial frames',()=>{
 assert.deepEqual([...decodePcmWav(wav()).data],[128,0,127]);
 for(const mutate of [bytes=>bytes.subarray(0,bytes.length-1),bytes=>{new DataView(bytes.buffer).setUint16(20,3,true);return bytes;},bytes=>{new DataView(bytes.buffer).setUint32(28,1,true);return bytes;},bytes=>{new DataView(bytes.buffer).setUint16(32,2,true);return bytes;}])assert.throws(()=>decodePcmWav(mutate(wav())),/WAV|PCM/);
 assert.throws(()=>parseResourceImports([request,request]),/Duplicate/);assert.throws(()=>parseResourceImports([{...request,unknown:true}]),/Unknown/);
});
test('real converters participate in source-plan-overlay-pack and native ResourceLoader loads PNG/JPEG/WAV remaps',{timeout:25000},async t=>{
 let decoded=0;
 const converters=createBrowserResourceConverters({id:'test-rgba',version:'1',async decode(bytes,mime){decoded++;assert(['image/png','image/jpeg'].includes(mime));bytes.fill(0);return {width:1,height:1,rgba:Uint8Array.of(255,0,0,255)};}});
 const sources={'/src/start.ts':`import {ResourceLoader,ImageTexture,AudioStreamWAV,print} from 'godot';
export function start(ctx:any){const png=ResourceLoader.load('res://pixel.png');const jpeg=ResourceLoader.load('res://pixel.jpg');const wav=ResourceLoader.load('res://tone.wav');if(ResourceLoader.load('uid://bb')!==png)throw Error('Source UID did not resolve to converted resource');if(!(png instanceof ImageTexture)||!(jpeg instanceof ImageTexture)||!(wav instanceof AudioStreamWAV)||png.get_width()!==1||wav.mix_rate!==8000)throw Error('ResourceLoader conversion failed');print('CONVERTER_RESOURCE_LOADER_OK');ctx.mount.get_tree().quit();}`,
  '/tone.wav':[...wav()],'/pixel.png.import':'[remap]\nuid="uid://bb"\n','/pixel.png':[1,2,3],'/pixel.jpg':[4,5,6]};
 const snapshot=await createSourceSnapshot(sources),plan=await createBuildPlan(snapshot,{kind:'script',module:'/src/start.ts'});
 const recipes=[request,{resource:'res://pixel.png',converter:'godotjs/image-rgba'},{resource:'res://pixel.jpg',converter:'godotjs/image-rgba'}];
 const packed=await packBuildPlan(plan,{resourceImports:recipes,resourceConverters:converters,resourceTarget:target});
 assert.equal(decoded,2);assert.equal(packed.receipt.imports.length,3);assert.equal(packed.plan.snapshot.sourceHash,snapshot.sourceHash);assert.deepEqual([...packed.prepared.files.get('res://pixel.png')],[1,2,3]);assert(packed.overlay.entries.some(item=>item.reason.includes('Converted by')));
 assert.notEqual(packed.plan.buildKey,(await packBuildPlan(plan,{resourceImports:[request],resourceConverters:converters,resourceTarget:target})).plan.buildKey);
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));try{await readFile(engine);}catch{t.skip('Native fixture unavailable; browser acceptance remains separate');return;}
 const directory=await mkdtemp(path.join(tmpdir(),'resource-converter-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'project.pck');await writeFile(filename,packed.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.match(output,/CONVERTER_RESOURCE_LOADER_OK/,output);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
});
