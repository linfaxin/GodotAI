import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createBrowserResourceConverters,createResourceExecutionCache,ResourceConverterRegistry,pngCtexConverter,jpegCtexConverter,pcmWavConverter,
 BINARY_RESOURCE_TARGET_ABI,encodeRgbaPng,encodeCompressedRgbaPng,inspectPng,validatePngData,inspectJpeg,deterministicJpegDecoder} from '../dist/resource-converters.js';
import jpeg from 'jpeg-js';
import {pngCrc} from '../dist/resource-binary.js';
import {createNodeResourceExecutionCache} from '../dist/node/resource-cache.js';
import {createSourceSnapshot,createBuildPlan} from '../dist/build-plan.js';
import {compileBuildPlan} from '../dist/compiler.js';

const target={resourceAbi:BINARY_RESOURCE_TARGET_ABI,features:{engine:'native-4.6.1-fixture'}};
const text=value=>new TextEncoder().encode(value),read=value=>new TextDecoder().decode(value);
const pixels=Uint8Array.of(255,0,0,255,0,255,0,128,0,0,255,255,64,128,192,255);
const png=()=>encodeRgbaPng({width:2,height:2,rgba:pixels});
const imageRequest={resource:'res://pixel.png',converter:'godotjs/png-ctex'};
const waveRequest={resource:'res://tone.wav',converter:'godotjs/wav-pcm'};
function wav({bits=8,stereo=false,data=Uint8Array.of(0,128,255)}={}){
 const bytes=new Uint8Array(44+data.length+(data.length&1)),view=new DataView(bytes.buffer),align=(bits/8)*(stereo?2:1);
 bytes.set(text('RIFF'));view.setUint32(4,bytes.length-8,true);bytes.set(text('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,stereo?2:1,true);
 view.setUint32(24,8000,true);view.setUint32(28,8000*align,true);view.setUint16(32,align,true);view.setUint16(34,bits,true);bytes.set(text('data'),36);view.setUint32(40,data.length,true);bytes.set(data,44);return bytes;
}
function jpegHeader(width=2,height=2){return Uint8Array.of(255,216,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,0x11,0,2,0x11,0,3,0x11,0);}
const output=(result,extension)=>result.receipts[0].outputs.find(item=>item.path.endsWith('.'+extension));

test('explicit binary format/ABI and source UID survive deterministic PNG CTEX production',async()=>{
 const original=png(),source=new Map([['res://pixel.png',original],['res://pixel.png.import',text('[remap]\nuid="uid://bb"\n')]]),registry=createBrowserResourceConverters();
 const first=await registry.run([imageRequest],source,target),record=output(first,'ctex'),bytes=first.files.get(record.path);
 assert.deepEqual(first.receipts[0].converter.output,{extension:'ctex',resourceType:'CompressedTexture2D',resourceAbi:'godot-4.6.1-ctex-v1'});
 assert.equal(read(bytes.subarray(0,4)),'GST2');assert.deepEqual(bytes.subarray(60),original);assert.match(read(first.files.get('res://pixel.png.import')),/CompressedTexture2D/);assert.match(read(first.files.get('res://pixel.png.import')),/uid="uid:\/\/bb"/);
 assert.deepEqual(source.get('res://pixel.png'),original);assert.equal(first.telemetry.executed,1);
 const cached=await registry.run([imageRequest],source,target);assert.deepEqual([...cached.files],[...first.files]);assert.deepEqual([...cached.reasons],[...first.reasons]);assert.deepEqual(cached.receipts,first.receipts);assert.equal(cached.telemetry.cacheHits,1);
 await assert.rejects(registry.run([imageRequest],source,{...target,resourceAbi:'godot-4-text-resource-v1'}),/E_RESOURCE_ABI/);
 await assert.rejects(registry.run([imageRequest],source,target,[],{maxDecodedPixels:3}),/IMAGE_BUDGET/);
 await assert.rejects(registry.run([imageRequest],source,target,[],{maxDecodedBytes:15}),/IMAGE_BUDGET/);
 await assert.rejects(registry.run([imageRequest],source,target,[],{maxOutputBytes:bytes.length-1}),/budget/);
 await assert.rejects(registry.run([{...imageRequest,parameters:{mipmaps:true}}],source,target),/mipmaps=false/);
 const sidecar=new Map([['res://pixel.png',original],['res://pixel.png.uid',text('uid://bc\n')]]),withUid=await registry.run([imageRequest],sidecar,target);assert.equal(withUid.receipts[0].uid,'uid://bc');assert.match(read(withUid.files.get('res://pixel.png.import')),/uid="uid:\/\/bc"/);assert.deepEqual(sidecar.get('res://pixel.png.uid'),text('uid://bc\n'));
 await assert.rejects(registry.run([imageRequest],new Map([...source,['res://pixel.png.uid',text('uid://bc')]]),target),/UID conflicts/);
});

test('PNG rejects bad CRC, unsupported modes and deflate bombs before an execution is cached',async()=>{
 const valid=png();await validatePngData(inspectPng(valid));
 const bad=valid.slice();bad[bad.length-1]^=1;assert.throws(()=>inspectPng(bad),/CRC/);
 const interlaced=valid.slice();interlaced[28]=1;new DataView(interlaced.buffer).setUint32(29,pngCrc(interlaced.subarray(12,29)));assert.throws(()=>inspectPng(interlaced),/noninterlaced/);
 const broken=valid.slice(),view=new DataView(broken.buffer),length=view.getUint32(33);broken[41]^=255;view.setUint32(41+length,pngCrc(broken.subarray(37,41+length)));
 await assert.rejects(createBrowserResourceConverters().run([imageRequest],new Map([['res://pixel.png',broken]]),target),/E_RESOURCE_FORMAT/);
 const huge=valid.slice(),hugeView=new DataView(huge.buffer);hugeView.setUint32(16,65535);hugeView.setUint32(29,pngCrc(huge.subarray(12,29)));assert.throws(()=>inspectPng(huge,4),/IMAGE_BUDGET/);
});

test('JPEG dimensions/output budget precede decoder allocation and PNG encoding is stable',async()=>{
 let calls=0;const decoder={id:'fixture-rgba',version:'1',deterministic:true,async decode(){calls++;return {width:2,height:2,rgba:pixels.slice()};}},registry=createBrowserResourceConverters(undefined,{jpegDecoder:decoder});
 const request={resource:'res://pixel.jpg',converter:'godotjs/jpeg-ctex'},source=new Map([['res://pixel.jpg',jpegHeader()]]);
 await assert.rejects(registry.run([request],source,target,[],{maxDecodedPixels:3}),/IMAGE_BUDGET/);
 await assert.rejects(registry.run([request],source,target,[],{maxOutputBytes:100}),/before decoding/);assert.equal(calls,0);
 const first=await registry.run([request],source,target),second=await registry.run([request],source,target);
 assert.equal(calls,1);assert.equal(second.telemetry.cacheHits,1);assert.deepEqual([...first.files],[...second.files]);assert.deepEqual(first.files.get(output(first,'ctex').path).subarray(60),encodeCompressedRgbaPng({width:2,height:2,rgba:pixels}));
 assert.match(first.receipts[0].converter.version,/2\.0\.0-png-fflate0\.8\.2-l6-m8/);
 const stored=await new ResourceConverterRegistry().register(jpegCtexConverter(decoder,{compression:'stored'})).run([request],source,target);assert.match(stored.receipts[0].converter.version,/^1\.0\.0-png-store/);assert.deepEqual(stored.files.get(output(stored,'ctex').path).subarray(60),png());
 const migrated=await registry.run([request],new Map([...source,...stored.files]),target,stored.receipts);assert(migrated.retainedOutputs.some(item=>item.path===output(stored,'ctex').path));assert.notEqual(output(migrated,'ctex').path,output(stored,'ctex').path);
 const other=createBrowserResourceConverters(undefined,{jpegDecoder:{...decoder,version:'2'}}),changed=await other.run([request],source,target);assert.notEqual(changed.receipts[0].outputs[0].path,first.receipts[0].outputs[0].path);
 assert.throws(()=>inspectJpeg(Uint8Array.of(255,216,255,218)),/frame/);
});

test('default JPEG producer uses the pinned software codec and compresses a 2K frame within a compact artifact budget',async()=>{
 const width=2048,height=2048,rgba=new Uint8Array(width*height*4).fill(255),input=new Uint8Array(jpeg.encode({width,height,data:rgba},85).data);
 const request={resource:'res://flat.jpg',converter:'godotjs/jpeg-ctex'},source=new Map([[request.resource,input]]),registry=createBrowserResourceConverters();
 assert(registry.ids.has(request.converter));
 const result=await registry.run([request],source,target,[],{maxOutputBytes:256*1024}),bytes=result.files.get(output(result,'ctex').path);
 assert(bytes.length<64*1024,'Flat 2K JPEG must not expand into a stored 16 MiB PNG');assert.match(result.receipts[0].converter.version,/jpeg-js-rgba\/0\.4\.4-strict-mp16-memory128-v1/);
 const inspected=inspectPng(bytes.subarray(60));assert.equal(inspected.width,width);await validatePngData(inspected);
 const decoded=await deterministicJpegDecoder.decode(input,'image/jpeg');assert.equal(decoded.rgba.length,width*height*4);
 await assert.rejects(deterministicJpegDecoder.decode(jpegHeader(65535,65535),'image/jpeg'),/IMAGE_BUDGET/);
});

test('binary PCM retains AudioStreamWAV metadata and cache hits still enforce decoded budgets',async()=>{
 const source=new Map([['res://tone.wav',wav()]]),registry=createBrowserResourceConverters(),result=await registry.run([waveRequest],source,target),bytes=result.files.get(output(result,'res').path);
 assert.equal(read(bytes.subarray(0,4)),'RSRC');assert.equal(read(bytes.subarray(-4)),'RSRC');assert.deepEqual(result.receipts[0].converter.output,{extension:'res',resourceType:'AudioStreamWAV',resourceAbi:'godot-4.6.1-rsrc-v6'});
 assert.match(result.receipts[0].converter.version,/rsrc6/);assert.deepEqual(source.get('res://tone.wav'),wav());
 await assert.rejects(registry.run([waveRequest],source,target,[],{maxDecodedBytes:2}),/decoded byte budget/);
});

test('only actual module-owned producers reuse execution cache; imported receipts cannot seed it',async()=>{
 const cache=createResourceExecutionCache();assert.equal('storeCompleted' in cache,false);
 const source=new Map([['res://pixel.png',png()]]),actual=await createBrowserResourceConverters(undefined,{cache}).run([imageRequest],source,target);
 let calls=0;const clone={...pngCtexConverter,async convert(context){calls++;return pngCtexConverter.convert(context);}},registry=new ResourceConverterRegistry({cache}).register(clone);
 await registry.run([imageRequest],source,target);await registry.run([imageRequest],source,target);assert.equal(calls,2,'Spreading a built-in object does not copy its execution authority');
 const forged=structuredClone(actual.receipts);forged[0].outputs.find(item=>item.path.endsWith('.ctex')).sha256='0'.repeat(64);
 const rebuilt=await createBrowserResourceConverters().run([imageRequest],new Map([...source,...actual.files]),target,forged);assert.equal(rebuilt.telemetry.executed,1);assert.deepEqual([...rebuilt.files],[...actual.files]);
});

test('Node cache survives a new registry/cache instance, rejects corrupt records and preserves artifact identity',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'resource-execution-cache-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sources={'/start.ts':'export function start(){}','/pixel.png':png()},plan=await createBuildPlan(await createSourceSnapshot(sources),{kind:'script',module:'/start.ts'});
 const options=cache=>({preparation:{resourceImports:[imageRequest],resourceConverters:createBrowserResourceConverters(undefined,{cache}),resourceTarget:target}});
 const first=await compileBuildPlan(plan,options(createNodeResourceExecutionCache(directory))),second=await compileBuildPlan(plan,options(createNodeResourceExecutionCache(directory)));
 assert.equal(first.buildKey,second.buildKey);assert.equal(first.artifactId,second.artifactId);assert.deepEqual(first.receipt,second.receipt);assert.deepEqual(first.pack,second.pack);
 const files=await readdir(directory);assert.equal(files.filter(name=>name.endsWith('.gjrc')).length,1);const cacheFile=path.join(directory,files.find(name=>name.endsWith('.gjrc')));await writeFile(cacheFile,Uint8Array.of(1,2,3));
 const registry=createBrowserResourceConverters(undefined,{cache:createNodeResourceExecutionCache(directory)}),recovered=await registry.run([imageRequest],new Map([['res://pixel.png',png()]]),target);assert.equal(recovered.telemetry.executed,1);assert.equal(read((await readFile(cacheFile)).subarray(0,4)),'GJRC');
});

test('actual native PCK loads binary PNG/JPEG/WAV at source paths and UID while source bytes remain intact',{timeout:35000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));try{await readFile(engine);}catch{t.skip('Native fixture unavailable');return;}
 const stereo=wav({bits:16,stereo:true,data:Uint8Array.of(0,128,255,127,0,0,255,255)});
 const sources={'/start.ts':`import {ResourceLoader,CompressedTexture2D,ImageTexture,AudioStreamWAV,FileAccess,print} from 'godot';export function start(ctx:any){
 const png=ResourceLoader.load('res://pixel.png'),jpeg=ResourceLoader.load('res://pixel.jpg'),wav=ResourceLoader.load('res://tone.wav'),stereo=ResourceLoader.load('res://stereo.wav');
 if(!(png instanceof CompressedTexture2D)||png instanceof ImageTexture||!(jpeg instanceof CompressedTexture2D)||png.get_width()!==2||jpeg.get_height()!==2||ResourceLoader.load('uid://bb')!==png||ResourceLoader.load('res://pixel.png')!==png)throw Error('Binary texture type/UID/cache mismatch');
 const color=png.get_image().get_pixel(1,0);if(color.g!==1||Math.abs(color.a-128/255)>.001)throw Error('Binary texture alpha mismatch');
 if(!(wav instanceof AudioStreamWAV)||wav.mix_rate!==8000||wav.data.size()!==3||wav.data.get_indexed(0)!==128||wav.data.get_indexed(2)!==127||ResourceLoader.load('uid://bc')!==wav)throw Error('Binary PCM8 or sidecar UID mismatch');
 if(!(stereo instanceof AudioStreamWAV)||!stereo.stereo||stereo.format!==1||stereo.data.size()!==8||stereo.data.get_indexed(1)!==128)throw Error('Binary PCM16 mismatch');
 if(FileAccess.get_file_as_bytes('res://pixel.png').size()===0||FileAccess.get_file_as_bytes('res://tone.wav').size()===0)throw Error('Original source bytes were stripped');print('BINARY_RESOURCES_NATIVE_OK');ctx.mount.get_tree().quit();}`,
 '/pixel.png':png(),'/pixel.jpg':jpegHeader(),'/pixel.png.import':'[remap]\nuid="uid://bb"\n','/tone.wav':wav(),'/tone.wav.uid':'uid://bc\n','/stereo.wav':stereo};
 const decoder={id:'native-fixture-rgba',version:'1',async decode(){return {width:2,height:2,rgba:pixels.slice()};}},plan=await createBuildPlan(await createSourceSnapshot(sources),{kind:'script',module:'/start.ts'});
 const result=await compileBuildPlan(plan,{preparation:{resourceImports:[imageRequest,{resource:'res://pixel.jpg',converter:'godotjs/jpeg-ctex'},waveRequest,{resource:'res://stereo.wav',converter:'godotjs/wav-pcm'}],resourceConverters:createBrowserResourceConverters(undefined,{jpegDecoder:decoder}),resourceTarget:target}});
 assert.deepEqual(result.plan.snapshot.files.find(file=>file.path==='res://pixel.png').bytes,png());assert(result.overlay.some(item=>item.path==='res://pixel.png'&&item.disposition==='unchanged'));
 const directory=await mkdtemp(path.join(tmpdir(),'binary-resource-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));const pack=path.join(directory,'project.pck');await writeFile(pack,result.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:25000,maxBuffer:1024*1024}),logs=(run.stdout??'')+(run.stderr??'');
 assert.equal(run.status,0,logs);assert.match(logs,/BINARY_RESOURCES_NATIVE_OK/,logs);assert.doesNotMatch(logs,/^(?:ERROR:|SCRIPT ERROR:)/m,logs);
});
