#!/usr/bin/env node
/** Resource probes for legacy Base64, the bounded CTEX format and explicit
 * production binary producers. Godot Web/GPU acceptance remains separate. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {options} from '../release/web-release-utils.mjs';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const request=createRequire(new URL('../../apps/playground/package.json',import.meta.url));
const dimension=2048,encode=value=>new TextEncoder().encode(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function whitePng(){
 const crc=data=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),result=Buffer.alloc(12+data.length);result.writeUInt32BE(data.length,0);type.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([type,data])),8+data.length);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(dimension,0);header.writeUInt32BE(dimension,4);header[8]=8;header[9]=6;
 const rows=Buffer.alloc((dimension*4+1)*dimension,255);for(let row=0;row<dimension;row++)rows[row*(dimension*4+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

// Serialized into an ordinary browser Worker, alongside the real Playground
// converter bundle. No injected RGBA decoder supplies the expected white data.
async function browserWorker(event){
 try{
  const {dimension}=event.data,started=performance.now();
  const response=await fetch('/white-2048.png');if(!response.ok)throw Error('PNG fixture fetch failed');
  const source=new Uint8Array(await response.arrayBuffer());
  const result=await AssetConverters.projectResourceConverters().run(
   [{resource:'res://large.png',converter:'godotjs/image-rgba'}],new Map([['res://large.png',source]]),
   {resourceAbi:'godot-4-text-resource-v1',features:{engine:'manual-resource-format-probe'}},undefined,
   {maxOutputBytes:64*1024*1024,maxDecodedPixels:16*1024*1024});
  const receipt=result.receipts[0],outputRecord=receipt.outputs.find(file=>file.path.endsWith('.tres'));
  const output=result.files.get(outputRecord?.path);if(!output)throw Error('No converted texture');
  const prefix=new TextDecoder().decode(output.subarray(0,512)),marker='PackedByteArray("';
  const markerAt=prefix.indexOf(marker),start=markerAt+marker.length,pixels=dimension*dimension,rgbaBytes=pixels*4;
  if(!prefix.startsWith('[gd_resource type="ImageTexture"')||!prefix.includes('"width":'+dimension)||!prefix.includes('"height":'+dimension)||markerAt<0)throw Error('ImageTexture envelope mismatch');
  // Check all encoded RGBA bytes without making a second 22 MiB text or atob
  // string. Every white RGBA byte is 255: full groups encode as ////.
  const payloadBytes=4*Math.ceil(rgbaBytes/3),tail=rgbaBytes%3===1?'/w==':rgbaBytes%3===2?'//8=':'';
  for(let i=0;i<payloadBytes-tail.length;i++)if(output[start+i]!==47)throw Error('Decoded white RGBA data mismatch at '+i);
  for(let i=0;i<tail.length;i++)if(output[start+payloadBytes-tail.length+i]!==tail.charCodeAt(i))throw Error('RGBA Base64 padding mismatch');
  if(!new TextDecoder().decode(output.subarray(start+payloadBytes)).startsWith('")}\n\n[resource]\nimage=SubResource("image")'))throw Error('ImageTexture suffix mismatch');
  self.postMessage({status:'passed',sourceBytes:source.byteLength,outputBytes:output.byteLength,pixelsChecked:pixels,rgbaBytesChecked:rgbaBytes,
   converter:receipt.converter,sourceSha256:receipt.sources[0].sha256,outputSha256:outputRecord.sha256,elapsedMs:Math.round(performance.now()-started)});
 }catch(error){self.postMessage({status:'failed',error:String(error?.stack??error)});}
}

async function browserDecoderProbe(png,executable){
 const {build}=request('esbuild'),{chromium}=request('playwright');
 const bundle=await build({entryPoints:[path.join(repository,'apps/playground/src/project-resource-converters.ts')],bundle:true,write:false,format:'iife',globalName:'AssetConverters',platform:'browser',target:'es2022'});
 const worker=bundle.outputFiles[0].text+'\nself.onmessage='+browserWorker.toString()+';\n';
 const server=createServer((req,res)=>{
  if(req.url==='/white-2048.png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);}
  else if(req.url==='/worker.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(worker);}
  else {res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><link rel="icon" href="data:,"><title>Manual resource decoder probe</title>');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let browser;
 try{
  const selection=resolveBrowserExecutable(chromium,'chromium',{environment:{...process.env,...(executable?{BROWSER_EXECUTABLE:executable}:{})}});
  browser=await chromium.launch({executablePath:selection.executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  const result=await page.evaluate(dimension=>{
   const worker=new Worker('/worker.js');
   return new Promise((resolve,reject)=>{
    const finish=(callback,value)=>{clearTimeout(timer);worker.terminate();callback(value);};
    const timer=setTimeout(()=>finish(reject,Error('Browser decoder exceeded 30 seconds')),30000);
    worker.onmessage=event=>finish(resolve,event.data);worker.onerror=event=>finish(reject,Error(event.message));worker.postMessage({dimension});
   });
  },dimension);
  return {...result,browser:await browser.version(),executableSource:selection.source,
   scope:'Actual createImageBitmap/OffscreenCanvas decoder and production Base64 converter in an ordinary Chromium Worker; no Godot Web/GPU rendering'};
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}

function pngCtex(png){
 // Bounded Godot 4.6.1 CTEX v1, PNG-only, RGBA8, no mipmaps. The inner image
 // payload includes Image's native four-byte "PNG " prefix before PNG bytes.
 const ctex=new Uint8Array(60+png.byteLength),view=new DataView(ctex.buffer);ctex.set(encode('GST2'));
 for(const [offset,value]of [[4,1],[8,dimension],[12,dimension],[16,0],[20,0],[24,0],[28,0],[32,0],[36,1],[44,0],[48,5],[52,png.byteLength+4]])view.setUint32(offset,value,true);
 view.setUint16(40,dimension,true);view.setUint16(42,dimension,true);ctex.set(encode('PNG '),56);ctex.set(png,60);return ctex;
}

async function nativeCtexProbe(png,engine,directory){
 const version=spawnSync(engine,['--version'],{encoding:'utf8',timeout:10000});
 if(version.error)throw Error('Cannot run GodotJS host '+engine+': '+version.error.message);
 const engineVersion=version.stdout.trim();assert.equal(version.status,0,version.stderr);assert.match(engineVersion,/^4\.6\.1\./,'The bounded CTEX prototype targets Godot 4.6.1');
 const engineHash=createHash('sha256');for await(const bytes of createReadStream(engine))engineHash.update(bytes);
 const {createSourceSnapshot,createBuildPlan,packBuildPlan}=await import('@godot-js/project-tools/build-plan');
 const ctex=pngCtex(png),files={
  '/start.ts':`import {ResourceLoader,CompressedTexture2D,ImageTexture,print} from 'godot';
export function start(ctx:any){
 const value=ResourceLoader.load('res://large.png');
 if(!(value instanceof CompressedTexture2D)||value instanceof ImageTexture||value.get_width()!==2048||value.get_height()!==2048||ResourceLoader.load('res://large.png')!==value)throw Error('CTEX prototype type/dimensions/cache mismatch');
 print('CTEX_SELF_CONTAINED_OK');ctx.mount.get_tree().quit();
}`,
  '/large.png.import':'[remap]\nimporter="texture"\ntype="CompressedTexture2D"\npath="res://.godot/imported/prototype.ctex"\n',
  '/.godot/imported/prototype.ctex':ctex,
 };
 const artifact=await packBuildPlan(await createBuildPlan(await createSourceSnapshot(files),{kind:'script',module:'/start.ts'}));
 assert.equal(artifact.index['res://large.png'],undefined,'This experimental fixture must load without a source PNG in its PCK');
 const pack=path.join(directory,'ctex-probe.pck');await writeFile(pack,artifact.pack);await writeFile(path.join(directory,'prototype.ctex'),ctex);
 const result=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
 const logs=(result.stdout??'')+(result.stderr??'');await writeFile(path.join(directory,'ctex-probe.log'),logs);
 return {status:!result.error&&result.status===0&&logs.includes('CTEX_SELF_CONTAINED_OK')&&!/^(?:ERROR:|SCRIPT ERROR:)/m.test(logs)?'passed':'failed',
  ...(result.error?{error:String(result.error)}:{}),engineVersion,engineSha256:engineHash.digest('hex'),exitCode:result.status,
  pngBytes:png.byteLength,ctexBytes:ctex.byteLength,packBytes:artifact.pack.byteLength,ctexSha256:hash(ctex),packSha256:hash(artifact.pack),
  sourcePngInPack:false,observableType:'CompressedTexture2D',imageTextureEquivalent:false,
  scope:'GodotJS 4.6.1 native headless ResourceLoader original-path remap/type/dimensions/cache; no production converter, editor reimport/export or Web/GPU rendering'};
}

export async function runResourceFormatProbe({mode='all',out,godot,chromium}={}){
 if(!['all','browser','ctex','binary'].includes(mode))throw Error('Expected --mode all, browser, ctex or binary');
 const directory=path.resolve(out??path.join(repository,'work/resource-format-probe'));await mkdir(directory,{recursive:true});
 const png=whitePng();await writeFile(path.join(directory,'white-2048.png'),png);
 if(mode==='binary'){const {runBinaryResourceProbe}=await import('./binary-resource-probe.mjs');return runBinaryResourceProbe({out:directory,godot,chromium,png});}
 const report={schemaVersion:1,kind:'godotjs-manual-resource-format-probe',status:'failed',mode,dimension,
  source:{bytes:png.byteLength,sha256:hash(png)},productionConverterChanged:false,checks:{},
  limitations:['One opaque-white 2048x2048 RGBA PNG; no JPEG, transparency, color-profile, mipmap or malformed CTEX matrix.',
   'Browser decoding and native CTEX loading are separate checks; this script does not load CTEX in Godot Web or draw it on a GPU.',
   'CTEX returns CompressedTexture2D; adopting it needs an explicit compatibility decision and remains outside production conversion.']};
 try{
  if(mode!=='ctex'){
   report.checks.browser=await browserDecoderProbe(png,chromium);
   assert.equal(report.checks.browser.status,'passed',JSON.stringify(report.checks.browser));
   assert.equal(report.checks.browser.sourceSha256,report.source.sha256);
  }
  if(mode!=='browser'){
   const executable=godot??process.env.GODOT??path.join(repository,'tests/bin/godot-host-qjs');
   // Resolve explicit relative paths before changing the child process cwd.
   report.checks.ctex=await nativeCtexProbe(png,path.resolve(executable),directory);
   assert.equal(report.checks.ctex.status,'passed','CTEX prototype failed; inspect '+path.join(directory,'ctex-probe.log'));
  }
  report.status='passed';return report;
 }catch(error){report.error=String(error?.stack??error);throw error;}
 finally{await writeFile(path.join(directory,'resource-format-report.json'),JSON.stringify(report,null,2)+'\n');}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=options(process.argv.slice(2),['--help']);
  for(const key of Object.keys(args))if(!['mode','out','godot','chromium','help'].includes(key))throw Error('Unknown option --'+key);
  if(args.help)console.log('node scripts/test/resource-format-probe.mjs [--mode all|browser|ctex|binary] [--out work/resource-format-probe] [--godot /path/to/godotjs-4.6.1] [--chromium /path/to/chromium]\nRequires built project-tools and installed Playground esbuild/Playwright dependencies. Binary mode checks production producers and reopened persistent cache; real Web/GPU rendering is a separate product test.');
  else console.log(JSON.stringify(await runResourceFormatProbe(args),null,2));
 }catch(error){console.error(error?.stack??error);process.exitCode=1;}
}
