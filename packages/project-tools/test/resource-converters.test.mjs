import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {RESOURCE_FORMATS,resourceFormat,inspectResourceFormat} from '../dist/resource-formats.js';
import {ResourceConverterRegistry,createBrowserResourceConverters,pcmWavConverter,decodePcmWav,parseResourceImports} from '../dist/resource-converters.js';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../dist/build-plan.js';
import {assessStoredImportReceipt} from '../dist/import-receipts.js';
import {base64Resource} from '../dist/base64-resource.js';
import {compileBuildPlan} from '../dist/compiler.js';

const encode=value=>new TextEncoder().encode(value),decode=value=>new TextDecoder().decode(value);
const target={resourceAbi:'godot-4-text-resource-v1',features:{engine:'fixture'}};

test('registered image decoder identity and method stay captured through complete artifact builds',async()=>{
 let originalCalls=0,replacementCalls=0;
 const decoder={id:'owned-decoder',version:'1',async decode(){
  assert.equal(this,decoder,'Stateful decoders keep their original receiver');originalCalls++;
  return {width:1,height:1,rgba:Uint8Array.of(255,255,255,255)};
 }};
 const registry=createBrowserResourceConverters(decoder);
 const plan=await createBuildPlan(await createSourceSnapshot({'/start.ts':'export function start(){}','/image.png':whitePng(1,1)}),{kind:'script',module:'/start.ts'});
 const options={preparation:{resourceImports:[{resource:'res://image.png',converter:'godotjs/image-rgba'}],resourceConverters:registry,resourceTarget:target}};
 const first=await compileBuildPlan(plan,options);
 decoder.id='replacement';decoder.version='2';decoder.decode=async()=>{replacementCalls++;return {width:1,height:1,rgba:Uint8Array.of(0,0,0,255)};};
 const second=await compileBuildPlan(plan,options);
 assert.equal(originalCalls,2);assert.equal(replacementCalls,0);
 assert.equal(first.buildKey,second.buildKey);assert.equal(first.artifactId,second.artifactId);assert.deepEqual(first.pack,second.pack);
 assert.equal(second.receipt.imports[0].converter.version,'1.1.0-base64/owned-decoder/1');
 const changed=await compileBuildPlan(plan,{preparation:{...options.preparation,resourceConverters:createBrowserResourceConverters(decoder)}});
 assert.equal(replacementCalls,1);assert.notEqual(changed.buildKey,first.buildKey);assert.notEqual(changed.artifactId,first.artifactId);
});
function whitePng(width,height){
 const crc=data=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),result=Buffer.alloc(12+data.length);result.writeUInt32BE(data.length,0);type.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([type,data])),8+data.length);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const rows=Buffer.alloc((width*4+1)*height,255);for(let row=0;row<height;row++)rows[row*(width*4+1)]=0;
 return Uint8Array.from(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
}
function wav(samples=[0,128,255]){
 const bytes=new Uint8Array(44+samples.length+(samples.length%2)),view=new DataView(bytes.buffer);
 bytes.set(encode('RIFF'),0);view.setUint32(4,bytes.length-8,true);bytes.set(encode('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);bytes.set(encode('data'),36);view.setUint32(40,samples.length,true);bytes.set(samples,44);return bytes;
}
const request={resource:'res://tone.wav',converter:'godotjs/wav-pcm'};
test('format directory distinguishes native API, ResourceLoader and executable browser producer routes',()=>{
 for(const extension of ['png','jpg','svg','tscn','tres','gltf','glb','ogg','wav','blend'])assert(resourceFormat('res://asset.'+extension),extension);
 assert.equal(resourceFormat('res://x.tscn').resourceLoader,'native');
 for(const format of ['svg','gltf','ogg','editor-source'])assert.deepEqual(RESOURCE_FORMATS.find(item=>item.id===format).browserConverters,[]);
 assert.deepEqual(inspectResourceFormat('x.png',{registeredConverters:createBrowserResourceConverters().ids}).converters,['godotjs/png-ctex']);
 assert.equal(inspectResourceFormat('x.ogg',{apiSymbols:new Set()}).directApi[0].present,false);
});
test('registered PCM conversion creates remap/receipt, preserves originals and UID, and reuses only verified current cache',async()=>{
 const original=wav(),files=new Map([['res://tone.wav',original],['res://tone.wav.import',encode('[remap]\nuid="uid://bb"\n')]]),registry=createBrowserResourceConverters();
 const first=await registry.run([request],files,target),receipt=first.receipts[0];
 assert.equal(receipt.uid,'uid://bb');assert.equal(first.assessments[0].status,'fresh');
 const output=receipt.outputs.find(item=>item.path.endsWith('.tres')).path;
 assert.match(decode(first.files.get(output)),/data=PackedByteArray\("gAB\/"\)/);assert.doesNotMatch(decode(first.files.get(output)),/uid=/);assert.match(decode(first.files.get('res://tone.wav.import')),/uid="uid:\/\/bb"/);
 assert.match(decode(first.files.get('res://tone.wav.import')),/AudioStreamWAV/);assert.deepEqual(files.get('res://tone.wav'),original);assert.equal(files.size,2);
 const cached=new Map([...files,...first.files]);const reused=await registry.run([request],cached,target,[receipt]);assert.equal(reused.assessments[0].status,'fresh');assert.equal(reused.reasons.get(output),first.reasons.get(output));assert.equal(reused.telemetry.cacheHits,1);
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
test('converter outputs own returned bytes and version upgrades preserve prior and unknown source caches',async()=>{
 let returned;
 const isolated=new ResourceConverterRegistry().register({id:'test/owned',version:'1',extensions:['bin'],parameters:()=>({}),convert(context){
  returned=encode('[gd_resource type="Resource" format=3]\n');
  return new Map([[context.destination,returned],[context.resource+'.import',encode('[remap]\npath='+JSON.stringify(context.destination)+'\n')]]);
 }});
 const converted=await isolated.run([{resource:'res://source.bin',converter:'test/owned'}],new Map([['res://source.bin',Uint8Array.of(1)]]),target);
 const output=converted.receipts[0].outputs.find(item=>item.path.endsWith('.tres')).path,stable=converted.files.get(output);
 returned.fill(0);converted.files.get(output).fill(1);assert.deepEqual(converted.files.get(output),stable);
 const legacy=new ResourceConverterRegistry().register({...pcmWavConverter,version:'1.0.1',convert(context){
  const files=pcmWavConverter.convert(context);files.set(context.destination,encode(decode(files.get(context.destination)).replace('PackedByteArray("gAB/")','PackedByteArray(128,0,127)')));return files;
 }});
 const original=new Map([['res://tone.wav',wav()],['res://tone.wav.import',encode('[remap]\nuid="uid://bb"\n')]]),old=await legacy.run([request],original,target);
 const oldOutput=old.receipts[0].outputs.find(item=>item.path.endsWith('.tres')).path;
 const sources=Object.fromEntries([...original,...old.files,['res://.godot/imported/opaque.res',Uint8Array.of(3,4)]]);
 sources['res://start.ts']='export function start(){}';
 const plan=await createBuildPlan(await createSourceSnapshot(sources),{kind:'script',module:'/start.ts'});
 const result=await packBuildPlan(plan,{resourceImports:[request],resourceConverters:createBrowserResourceConverters(),resourceTarget:target,storedImportReceipts:old.receipts});
 assert.match(result.importReceipts[0].converter.version,/base64/);assert.notEqual(result.importReceipts[0].outputs.find(item=>item.path.endsWith('.tres')).path,oldOutput);
 assert.deepEqual(result.prepared.files.get(oldOutput),old.files.get(oldOutput));assert.deepEqual(result.prepared.files.get('res://.godot/imported/opaque.res'),Uint8Array.of(3,4));
 assert(result.prepared.diagnostics.some(item=>item.code==='W_RESOURCE_PREVIOUS_OUTPUT_RETAINED'&&item.file===oldOutput));
 assert.deepEqual(plan.snapshot.files.find(item=>item.path==='res://tone.wav.import').bytes,old.files.get('res://tone.wav.import'));
});

test('Base64 budgets reject oversized encoded output before packing',async()=>{
 const registry=createBrowserResourceConverters({id:'budget',version:'1',decode:async()=>({width:16,height:16,rgba:new Uint8Array(16*16*4)})});
 await assert.rejects(registry.run([{resource:'res://pixel.png',converter:'godotjs/image-rgba'}],new Map([['res://pixel.png',Uint8Array.of(1)]]),target,[],{maxOutputBytes:1024}),/E_RESOURCE_BUDGET/);
 await assert.rejects(registry.run([{resource:'res://pixel.png',converter:'godotjs/image-rgba'}],new Map([['res://pixel.png',Uint8Array.of(1)]]),target,[],{maxDecodedPixels:255}),/Invalid|invalid/);
 const data=new Uint8Array(4096*4096*4);
 assert.throws(()=>base64Resource('',data,''),/E_RESOURCE_BUDGET/);
});

test('registered producer identity and callable do not change during an async conversion',async()=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;});
 const producer={...pcmWavConverter,version:'fixed-version',async convert(context){await barrier;return pcmWavConverter.convert(context);}};
 const registry=new ResourceConverterRegistry().register(producer),source=new Map([['res://tone.wav',wav()]]);
 const pending=registry.run([request],source,target);producer.version='changed-version';producer.convert=()=>{throw Error('replacement must not execute');};source.get('res://tone.wav').fill(0);release();
 const result=await pending;assert.equal(result.receipts[0].converter.version,'fixed-version');
 const resource=result.receipts[0].outputs.find(item=>item.path.endsWith('.tres'));assert.match(decode(result.files.get(resource.path)),/PackedByteArray\("gAB\/"\)/);
});

test('2K converted texture and PCM Base64 resources load from the actual PCK with their original remap and UID',{timeout:45000},async t=>{
 const dimension=2048,png=whitePng(dimension,dimension),converters=createBrowserResourceConverters({id:'2k-rgba',version:'1',async decode(bytes){assert.deepEqual(bytes,png);return {width:dimension,height:dimension,rgba:new Uint8Array(dimension*dimension*4).fill(255)};}});
 const rgba=base64Resource('[gd_resource type="Image" format=3]\n[resource]\ndata={"width":1,"height":1,"format":"RGBA8","mipmaps":false,"data":PackedByteArray("',Uint8Array.of(0,128,255,64),'" )}\n');
 const stereo=wav([0,128,255,127,0,0,255,255]),stereoView=new DataView(stereo.buffer);
 stereoView.setUint16(22,2,true);stereoView.setUint16(32,4,true);stereoView.setUint16(34,16,true);stereoView.setUint32(28,32000,true);
 const sources={'/src/start.ts':`import {ResourceLoader,ImageTexture,AudioStreamWAV,Image,print} from 'godot';
export function start(ctx:any){const texture=ResourceLoader.load('res://large.png');const tone=ResourceLoader.load('res://tone.wav');const stereo=ResourceLoader.load('res://stereo.wav');const image=ResourceLoader.load('res://pixel-data.tres');if(!(texture instanceof ImageTexture)||texture.get_width()!==2048||texture.get_height()!==2048||ResourceLoader.load('uid://bb')!==texture||ResourceLoader.load('res://large.png')!==texture)throw Error('2K texture/UID/cache mismatch');if(!(tone instanceof AudioStreamWAV)||tone.mix_rate!==8000||tone.data.size()!==3||tone.data.get_indexed(0)!==128||tone.data.get_indexed(2)!==127)throw Error('PCM8 Base64 mismatch');if(!(stereo instanceof AudioStreamWAV)||!stereo.stereo||stereo.format!==1||stereo.data.size()!==8||stereo.data.get_indexed(1)!==128)throw Error('Stereo PCM16 Base64 mismatch');if(!(image instanceof Image))throw Error('Image type mismatch');const pixel=image.get_pixel(0,0);if(pixel.r!==0||Math.abs(pixel.g-128/255)>.001||pixel.b!==1||Math.abs(pixel.a-64/255)>.001)throw Error('RGBA Base64 mismatch');print('BASE64_2K_RESOURCE_LOADER_OK');ctx.mount.get_tree().quit();}`,
 '/large.png':png,'/large.png.import':'[remap]\nuid="uid://bb"\n','/tone.wav':wav(),'/stereo.wav':stereo,'/pixel-data.tres':rgba};
 const snapshot=await createSourceSnapshot(sources),plan=await createBuildPlan(snapshot,{kind:'script',module:'/src/start.ts'});
 const packed=await packBuildPlan(plan,{resourceImports:[{resource:'res://large.png',converter:'godotjs/image-rgba'},request,{resource:'res://stereo.wav',converter:'godotjs/wav-pcm'}],resourceConverters:converters,resourceTarget:target});
 assert(packed.pack.byteLength<64*1024*1024);assert(packed.pack.byteLength>21*1024*1024);assert.equal(packed.receipt.imports.length,3);
 assert.deepEqual(packed.prepared.files.get('res://large.png'),png);
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));try{await readFile(engine);}catch{t.skip('Native fixture unavailable; real browser rendering remains separate');return;}
 const directory=await mkdtemp(path.join(tmpdir(),'resource-base64-2k-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'project.pck');await writeFile(filename,packed.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.match(output,/BASE64_2K_RESOURCE_LOADER_OK/,output);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
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

test('native ResourceLoader refuses malformed or truncated Base64 resources instead of caching success',{timeout:20000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));try{await readFile(engine);}catch{t.skip('Native fixture unavailable');return;}
 const files={'/start.ts':`import {ResourceLoader,print} from 'godot';export function start(ctx:any){for(const path of ['res://bad.tres','res://truncated.tres'])for(let i=0;i<2;i++)if(ResourceLoader.load(path)!==null)throw Error('Malformed Base64 loaded or cached');print('MALFORMED_BASE64_REJECTED');ctx.mount.get_tree().quit();}`,
 '/bad.tres':'[gd_resource type="AudioStreamWAV" format=3]\n[resource]\ndata=PackedByteArray("!!!")\n',
 '/truncated.tres':'[gd_resource type="AudioStreamWAV" format=3]\n[resource]\ndata=PackedByteArray("gAB/\n'};
 const plan=await createBuildPlan(await createSourceSnapshot(files),{kind:'script',module:'/start.ts'}),artifact=await packBuildPlan(plan);
 const directory=await mkdtemp(path.join(tmpdir(),'resource-bad-base64-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'project.pck');await writeFile(filename,artifact.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});const output=(run.stdout??'')+(run.stderr??'');
 assert.equal(run.status,0,output);assert.match(output,/MALFORMED_BASE64_REJECTED/,output);assert.match(output,/Invalid base64-encoded string/,output);assert.match(output,/truncated\.tres/,output);
});
