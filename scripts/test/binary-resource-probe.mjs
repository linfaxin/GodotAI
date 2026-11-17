/** Real browser Worker producers plus native PCK loading. Web/GPU rendering is
 * deliberately a separate product acceptance test using matching engine assets. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url)),request=createRequire(new URL('../../apps/playground/package.json',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function workerMain(){self.onmessage=async event=>{try{
 const small=BinaryAssets.encodeRgbaPng({width:2,height:2,rgba:Uint8Array.of(255,0,0,255,0,255,0,128,0,0,255,255,64,128,192,255)});
 const png=event.data.png?Uint8Array.from(event.data.png):small;
 let jpeg;if(event.data.jpeg)jpeg=Uint8Array.from(event.data.jpeg);else{
  const image=await createImageBitmap(new Blob([small],{type:'image/png'})),canvas=new OffscreenCanvas(2,2),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();jpeg=new Uint8Array(await(await canvas.convertToBlob({type:'image/jpeg',quality:1})).arrayBuffer());
 }
 const samples=Uint8Array.of(0,128,255),wav=new Uint8Array(48),view=new DataView(wav.buffer),encode=value=>new TextEncoder().encode(value);
 wav.set(encode('RIFF'));view.setUint32(4,40,true);wav.set(encode('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);wav.set(encode('data'),36);view.setUint32(40,3,true);wav.set(samples,44);
 const sources=new Map([['res://pixel.png',png],['res://pixel.png.import',encode('[remap]\nuid="uid://bb"\n')],['res://pixel.jpg',jpeg],['res://tone.wav',wav]]);
 const result=await BinaryAssets.projectResourceConverters().run([{resource:'res://pixel.png',converter:'godotjs/png-ctex'},{resource:'res://pixel.jpg',converter:'godotjs/jpeg-ctex'},{resource:'res://tone.wav',converter:'godotjs/wav-pcm'}],sources,{resourceAbi:'godot-4.6.1-resources-v2',features:{engine:'binary-resource-probe'}});
 const decoded=await BinaryAssets.deterministicJpegDecoder.decode(jpeg,'image/jpeg');
 self.postMessage({status:'passed',jpeg:[...jpeg],jpegPixels:[...decoded.rgba],png:[...png],wav:[...wav],telemetry:result.telemetry,receipts:result.receipts,outputs:[...result.files].map(([name,bytes])=>[name,[...bytes]])});
 }catch(error){self.postMessage({status:'failed',error:String(error.stack||error)});}};}

export async function runBinaryResourceProbe({out,godot,chromium:executable,png}={}){
 const directory=path.resolve(out??path.join(repository,'work/binary-resource-probe'));await mkdir(directory,{recursive:true});
 const {build}=request('esbuild'),{chromium}=request('playwright');
 const bundle=await build({stdin:{contents:"export {projectResourceConverters} from './apps/playground/src/project-resource-converters';export {deterministicJpegDecoder} from './packages/project-tools/src/resource-converters';export {encodeRgbaPng} from './packages/project-tools/src/resource-binary';",resolveDir:repository,loader:'ts'},bundle:true,write:false,format:'iife',globalName:'BinaryAssets',platform:'browser',target:'es2022'});
 const worker=bundle.outputFiles[0].text+'\n('+workerMain.toString()+')();';
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url.startsWith('/worker.js')?'text/javascript':'text/html');res.end(req.url.startsWith('/worker.js')?worker:'<!doctype html><title>Binary resource producer probe</title>');});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let browser;const report={schemaVersion:1,kind:'godotjs-binary-resource-probe',status:'failed',scope:'Real Chromium Worker PNG/JPEG/PCM production, persistent cache across Workers and native headless PCK ResourceLoader; no Godot Web/GPU or editor reimport claim'};
 try{
  const selection=resolveBrowserExecutable(chromium,'chromium',{environment:{...process.env,...(executable?{BROWSER_EXECUTABLE:executable}:{})}});
  browser=await chromium.launch({executablePath:selection.executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  const run=data=>page.evaluate(data=>new Promise((resolve,reject)=>{const worker=new Worker('/worker.js'),timer=setTimeout(()=>{worker.terminate();reject(Error('Resource producer probe deadline'));},30000);worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message));};worker.postMessage(data);}),data);
  const first=await run(png?{png:[...png]}:{});assert.equal(first.status,'passed',first.error);
  const reopened=await run({png:first.png,jpeg:first.jpeg});assert.equal(reopened.status,'passed',reopened.error);assert.deepEqual(reopened.outputs,first.outputs);assert.deepEqual(reopened.receipts,first.receipts);assert.deepEqual(reopened.telemetry,{executed:0,cacheHits:3});
  const node=await import('../../packages/project-tools/dist/resource-converters.js'),encode=value=>new TextEncoder().encode(value),sources=new Map([['res://pixel.png',Uint8Array.from(first.png)],['res://pixel.png.import',encode('[remap]\nuid="uid://bb"\n')],['res://pixel.jpg',Uint8Array.from(first.jpeg)],['res://tone.wav',Uint8Array.from(first.wav)]]);
  const nativeProducer=await node.createBrowserResourceConverters().run([{resource:'res://pixel.png',converter:'godotjs/png-ctex'},{resource:'res://pixel.jpg',converter:'godotjs/jpeg-ctex'},{resource:'res://tone.wav',converter:'godotjs/wav-pcm'}],sources,{resourceAbi:'godot-4.6.1-resources-v2',features:{engine:'binary-resource-probe'}});
  assert.deepEqual([...nativeProducer.files].map(([name,bytes])=>[name,[...bytes]]),first.outputs);assert.deepEqual(nativeProducer.receipts,first.receipts);
  const nodeJpeg=await node.deterministicJpegDecoder.decode(Uint8Array.from(first.jpeg),'image/jpeg');assert.deepEqual([...nodeJpeg.rgba],first.jpegPixels);
  report.nodeBrowserParity={status:'passed',producer:first.receipts.find(item=>item.resource==='res://pixel.jpg').converter,rgbaSha256:hash(nodeJpeg.rgba),outputBytes:[...nativeProducer.files.values()].reduce((total,bytes)=>total+bytes.length,0)};
  const {createSourceSnapshot,createBuildPlan,packBuildPlan}=await import('@godot-js/project-tools/build-plan');
  const files=Object.fromEntries(first.outputs.map(([name,bytes])=>[name,Uint8Array.from(bytes)]));Object.assign(files,{'/pixel.png':Uint8Array.from(first.png),'/pixel.jpg':Uint8Array.from(first.jpeg),'/tone.wav':Uint8Array.from(first.wav)});
  files['/start.ts']=`import {ResourceLoader,CompressedTexture2D,ImageTexture,AudioStreamWAV,FileAccess,print} from 'godot';export function start(ctx:any){
   const png=ResourceLoader.load('res://pixel.png'),jpeg=ResourceLoader.load('res://pixel.jpg'),wav=ResourceLoader.load('res://tone.wav');
   if(!(png instanceof CompressedTexture2D)||png instanceof ImageTexture||!(jpeg instanceof CompressedTexture2D)||jpeg.get_width()!==2||jpeg.get_height()!==2||ResourceLoader.load('uid://bb')!==png)throw Error('Binary texture type/UID/cache mismatch');
   const image=png.get_image();if(!image||image.get_width()!==png.get_width()||image.get_pixel(0,0).a!==1)throw Error('PNG native image readback failed');
   if(!(wav instanceof AudioStreamWAV)||wav.mix_rate!==8000||wav.data.size()!==3||wav.data.get_indexed(0)!==128||wav.data.get_indexed(2)!==127)throw Error('Binary PCM data mismatch');
   if(FileAccess.get_file_as_bytes('res://pixel.png').size()!==${first.png.length}||FileAccess.get_file_as_bytes('res://tone.wav').size()!==${first.wav.length})throw Error('Original source bytes are missing');
   print('BINARY_RESOURCE_PROBE_NATIVE_OK '+png.get_width()+'x'+png.get_height());ctx.mount.get_tree().quit();}`;
  const prepared=await packBuildPlan(await createBuildPlan(await createSourceSnapshot(files),{kind:'script',module:'/start.ts'})),pack=path.join(directory,'binary-resources.pck');await writeFile(pack,prepared.pack);
  const engine=path.resolve(godot??process.env.GODOT??path.join(repository,'tests/bin/godot-host-qjs')),binarySha256=hash(await readFile(engine)),version=spawnSync(engine,['--version'],{encoding:'utf8',timeout:10000});assert.equal(version.status,0,version.stderr);assert.match(version.stdout,/^4\.6\.1\./);
  const native=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024}),logs=(native.stdout??'')+(native.stderr??'');await writeFile(path.join(directory,'native.log'),logs);assert.equal(native.status,0,logs);assert.match(logs,/BINARY_RESOURCE_PROBE_NATIVE_OK/,logs);assert.doesNotMatch(logs,/^(?:ERROR:|SCRIPT ERROR:)/m,logs);
  Object.assign(report,{status:'passed',browser:await browser.version(),executableSource:selection.source,first:first.telemetry,reopened:reopened.telemetry,receipts:first.receipts,
   outputs:first.outputs.map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:hash(Uint8Array.from(bytes))})),native:{binary:engine,binarySha256,engineVersion:version.stdout.trim(),exitCode:native.status,packBytes:prepared.pack.length,packSha256:hash(prepared.pack),sourceBytesPreserved:true}});
  assert.equal(hash(await readFile(engine)),binarySha256,'Native binary changed during the resource probe');
  return report;
 }catch(error){report.status='failed';report.error=String(error.stack??error);throw error;}
 finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(directory,'binary-resource-report.json'),JSON.stringify(report,null,2)+'\n');}
}
