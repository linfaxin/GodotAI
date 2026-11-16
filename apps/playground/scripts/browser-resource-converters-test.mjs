import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';

// Records actual production Worker messages; no compiler or runtime replacement.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const manifestBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(manifestBytes),release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const prefix=site.publicAssets?'/releases/'+createHash('sha256').update(manifestBytes).digest('hex')+'/':'/';
const options=site.publicAssets?{publicImmutable:true,urlPrefix:prefix}:{};
const editor=createStaticServer(directory,options),preview=createStaticServer(directory,options);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
await Promise.all([listen(editor),listen(preview)]);
const editorRoot=`http://127.0.0.1:${editor.address().port}${prefix}`,previewRoot=`http://127.0.0.1:${preview.address().port}${prefix}`;
const timeout=Number(process.env.PLAYGROUND_RESOURCE_TIMEOUT??180000),checks=[],errors=[],cases=[];
let browser,context,page,report={status:'failed',scope:'actual-product-resource-converters',checks};
function wav(samples){const bytes=Buffer.alloc(44+samples.length+(samples.length%2));bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(8000,28);bytes.writeUInt16LE(1,32);bytes.writeUInt16LE(8,34);bytes.write('data',36);bytes.writeUInt32LE(samples.length,40);bytes.set(samples,44);return bytes;}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function whitePng(dimension){
 const crc=data=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),result=Buffer.alloc(12+data.length);result.writeUInt32BE(data.length,0);type.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([type,data])),8+data.length);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(dimension,0);header.writeUInt32BE(dimension,4);header[8]=8;header[9]=6;
 const rows=Buffer.alloc((dimension*4+1)*dimension,255);for(let row=0;row<dimension;row++)rows[row*(dimension*4+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function ready(){await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout});}
const inspect=()=>page.evaluate(()=>{const value=globalThis.__playgroundWorkbench.inspect();return {...value,project:{runtime:value.project.runtime,entry:value.project.entry,launch:value.project.engineDocument?.launch,files:Object.fromEntries(Object.entries(value.project.files).map(([path,value])=>[path,Array.isArray(value)?{byteLength:value.length}:value]))}};});
async function imported(document){await page.locator('#import').setInputFiles({name:'resource-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});await ready();}
async function running(after=0,seconds=0.0005){await page.waitForFunction(({after,seconds})=>{const state=globalThis.__playgroundWorkbench.inspect();if(state.diagnostics.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state.engine?.state==='running'&&document.querySelector('#logs')?.textContent.includes('RESOURCE_FORMAT_NATIVE_OK '+seconds)&&globalThis.__resourceBuilds.length>after;},{after,seconds},{timeout});assert.deepEqual(errors,[]);return page.evaluate(()=>globalThis.__resourceBuilds.at(-1));}
async function download(id){const promise=page.waitForEvent('download');if(!await page.locator('#'+id).isVisible())await page.locator('#project-menu summary').click();await page.locator('#'+id).click();return JSON.parse(await fs.readFile(await(await promise).path(),'utf8'));}
const source=`import {ResourceLoader,Resource,ImageTexture,AudioStreamWAV,Image,FileAccess,AudioStreamOggVorbis,GLTFDocument,GLTFState,PackedScene,Node,print} from 'godot';
export function start({mount}:{mount:Node}){
 const realm=globalThis as any;if(typeof realm.WorkerGlobalScope!=='function'||!(realm instanceof realm.WorkerGlobalScope))throw Error('Project must execute in the native engine Worker');
 const png=ResourceLoader.load('res://assets/pixel.png');const jpeg=ResourceLoader.load('res://assets/pixel.jpg');const wav=ResourceLoader.load('res://assets/tone.wav');
 if(ResourceLoader.load('uid://bb')!==png)throw Error('Source image UID did not resolve');
 if(!(png instanceof ImageTexture)||!(jpeg instanceof ImageTexture)||!(wav instanceof AudioStreamWAV)||png.get_width()!==2||jpeg.get_height()!==2||wav.mix_rate!==8000)throw Error('Converted ResourceLoader route failed');
 const scene=ResourceLoader.load('res://native.tscn');const text=ResourceLoader.load('res://native.tres');if(!(scene instanceof PackedScene)||!(text instanceof Resource)||text.resource_name!=='Native text')throw Error('Native text resource failed');const node=scene.instantiate();if(!node)throw Error('Native text instantiation failed');mount.add_child(node);
 const svg=new Image();if(svg.load_svg_from_buffer(FileAccess.get_file_as_bytes('res://assets/pixel.svg'))!==0||svg.get_width()!==2)throw Error('Direct SVG failed');
 const ogg=AudioStreamOggVorbis.load_from_buffer(FileAccess.get_file_as_bytes('res://assets/tone.ogg'));if(!ogg||ogg.get_length()<=0)throw Error('Direct OGG failed');
 const gltf=new GLTFDocument(),state=new GLTFState();if(gltf.append_from_buffer(FileAccess.get_file_as_bytes('res://assets/rigged.glb'),'res://assets/',state)!==0)throw Error('Direct GLTF failed');const model=gltf.generate_scene(state);if(!model)throw Error('Direct GLTF scene failed');mount.add_child(model);
 print('RESOURCE_FORMAT_NATIVE_OK '+wav.get_length());
}`;
async function largeTextureCase(){
 const png=whitePng(2048),sourceSha256=hash(png);
 const largeSource=`import {ResourceLoader,ImageTexture,Image,Node,print} from 'godot';
export function start({mount,host}:{mount:Node;host?:any}){
 const realm=globalThis as any;if(typeof realm.WorkerGlobalScope!=='function'||!(realm instanceof realm.WorkerGlobalScope))throw Error('2K project must execute in the native engine Worker');
 const texture=ResourceLoader.load('res://assets/large.png');
 if(!(texture instanceof ImageTexture)||texture.get_width()!==2048||texture.get_height()!==2048)throw Error('2K ImageTexture dimensions/type mismatch');
 if(ResourceLoader.load('res://assets/large.png')!==texture||ResourceLoader.load('uid://bd')!==texture)throw Error('2K original path/UID cache mismatch');
 const image=texture.get_image();
 if(!(image instanceof Image)||image.get_width()!==2048||image.get_height()!==2048)throw Error('2K native texture image readback failed');
 const samples:{x:number;y:number;r:number;g:number;b:number;a:number}[]=[];
 for(const [x,y] of [[0,0],[2047,0],[1024,1024],[0,2047],[2047,2047]]){
  const pixel=image.get_pixel(x,y);
  if([pixel.r,pixel.g,pixel.b,pixel.a].some(value=>Math.abs(value-1)>1/255))throw Error('2K white RGBA pixel mismatch at '+x+','+y);
  samples.push({x,y,r:pixel.r,g:pixel.g,b:pixel.b,a:pixel.a});
 }
 if(!host||host.emitProjectEvent({type:'resource-2k-native-ok',resourceType:'ImageTexture',width:texture.get_width(),height:texture.get_height(),samples})!==true)throw Error('2K native evidence delivery failed');
 print('RESOURCE_FORMAT_NATIVE_2K_OK');
}`;
 const original={schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,launch:{kind:'script',module:'res://src/start.ts'},
  resourceImports:[{resource:'res://assets/large.png',converter:'godotjs/image-rgba',parameters:{mipmaps:false}}],files:{
   '/src/start.ts':largeSource,'/assets/large.png':[...png],'/assets/large.png.import':'[remap]\nuid="uid://bd"\n',
   '/project.godot':'config_version=5\n[application]\nconfig/name="2K resource acceptance"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  },editor:{selected:'/src/start.ts'}};
 const before=await page.evaluate(()=>globalThis.__resourceBuilds.length);await imported(original);
 await page.waitForFunction(source=>globalThis.__playgroundWorkbench.inspect().project.files['/src/start.ts']===source,largeSource,{timeout});
 await page.waitForFunction(before=>{
  const state=globalThis.__playgroundWorkbench.inspect();if(state.diagnostics.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));
  return globalThis.__resourceBuilds.length>before&&state.engine?.state==='running'&&state.events.some(event=>event.type==='resource-2k-native-ok')&&document.querySelector('#logs')?.textContent.includes('RESOURCE_FORMAT_NATIVE_2K_OK');
 },before,{timeout});
 assert.deepEqual(errors,[]);
 const {build,native}=await page.evaluate(()=>({build:globalThis.__resourceBuilds.at(-1),native:globalThis.__playgroundWorkbench.inspect().events.find(event=>event.type==='resource-2k-native-ok')}));
 assert(build.packBytes>22000000&&build.packBytes<64*1024*1024,'The actual transferred PCK must contain the 22 MB Base64 texture within the product budget');
 assert.equal(build.manifest.artifactReceipt.schemaVersion,2);assert.match(build.manifest.artifactReceipt.packSha256,/^[a-f0-9]{64}$/);
 assert.equal(build.manifest.artifactReceipt.imports.length,1);const receipt=build.manifest.artifactReceipt.imports[0];
 assert.equal(receipt.resource,'res://assets/large.png');assert.equal(receipt.uid,'uid://bd');assert.equal(receipt.converter.id,'godotjs/image-rgba');
 assert.match(receipt.converter.version,/base64\/browser-createImageBitmap-rgba\//);assert.equal(receipt.target.features.engineId,release.engineId);
 assert.equal(receipt.sources.find(item=>item.path===receipt.resource)?.sha256,sourceSha256);assert(receipt.outputs.some(item=>item.path.endsWith('.tres')));
 for(const output of receipt.outputs)assert.match(output.sha256,/^[a-f0-9]{64}$/);
 const sourceOverlay=build.manifest.outputOverlay.find(item=>item.path===receipt.resource);
 assert.equal(sourceOverlay.disposition,'unchanged');assert.equal(sourceOverlay.inputHash,sourceSha256);assert.equal(sourceOverlay.outputHash,sourceSha256);
 assert.equal(native.resourceType,'ImageTexture');assert.equal(native.width,2048);assert.equal(native.height,2048);assert.equal(native.samples.length,5);
 for(const sample of native.samples)for(const channel of ['r','g','b','a'])assert(Math.abs(sample[channel]-1)<=1/255);
 const exported=await download('export');assert.deepEqual(exported.files,original.files);assert.deepEqual(exported.resourceImports,original.resourceImports);assert.deepEqual(await download('export-original'),original);
 await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});
 cases.push({name:'2k-white-png-production-ui-compiler-native-resource-loader',sourceBytes:png.byteLength,sourceSha256,packBytes:build.packBytes,
  artifactId:build.manifest.artifactId,packSha256:build.manifest.artifactReceipt.packSha256,receipt,native,sourceExportPreserved:true,
  pixelReadback:{api:'ImageTexture.get_image() / Image.get_pixel()',scope:'Actual native texture image readback with the product Web renderer; no framebuffer drawing or screenshot proof'}});
 checks.push('An independent 2K PNG imports through the real UI and browser decoder/shared compiler into a 22 MB Base64 PCK; the actual native Worker loads ImageTexture by original path/UID, confirms 2048x2048 and five white RGBA pixel samples through get_image(), while source bytes, recipe, original export and converter receipt remain intact');
}
try{
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 context=await browser.newContext({viewport:{width:1536,height:1000},acceptDownloads:true});
 await context.addInitScript(()=>{const NativeWorker=globalThis.Worker;globalThis.__resourceBuilds=[];globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);if(String(args[0]).includes('compiler.worker'))this.addEventListener('message',({data})=>{if(data?.manifest?.artifactReceipt)globalThis.__resourceBuilds.push(structuredClone({manifest:data.manifest,packBytes:data.pack?.byteLength??0}));});}};});
 page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));page.setDefaultTimeout(timeout);await page.goto(editorRoot+'?project=native&previewOrigin='+encodeURIComponent(previewRoot));await ready();
 const images=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle='#ef2233';context.fillRect(0,0,2,2);return {png:[...Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],jpeg:[...Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]),c=>c.charCodeAt(0))]};});
 const firstWav=wav([0,128,255,128]),original={schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,launch:{kind:'script',module:'res://src/start.ts'},resourceImports:[
  {resource:'res://assets/pixel.png',converter:'godotjs/image-rgba',parameters:{mipmaps:false}},{resource:'res://assets/pixel.jpg',converter:'godotjs/image-rgba'},{resource:'res://assets/tone.wav',converter:'godotjs/wav-pcm'},
 ],files:{'/src/start.ts':source,'/assets/pixel.png':images.png,'/assets/pixel.jpg':images.jpeg,'/assets/tone.wav':[...firstWav],
  '/assets/pixel.png.import':'[remap]\nuid="uid://bb"\n','/assets/pixel.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
  '/assets/tone.ogg':[...await fs.readFile(new URL('../../../tests/react/showcase/fixtures/tone.ogg',import.meta.url))],'/assets/rigged.glb':[...await fs.readFile(new URL('../../../tests/react/showcase/fixtures/rigged.glb',import.meta.url))],
  '/native.tscn':'[gd_scene format=3 uid="uid://bc"]\n[node name="NativeText" type="Node"]\n','/native.tres':'[gd_resource type="Resource" format=3]\n[resource]\nresource_name="Native text"\n',
 },editor:{selected:'/src/start.ts'}};
 const before=await page.evaluate(()=>globalThis.__resourceBuilds.length);await imported(original);const first=await running(before),firstImports=first.manifest.artifactReceipt.imports;
 assert.equal(firstImports.length,3);for(const receipt of firstImports){assert.equal(receipt.target.features.engineId,release.engineId);assert(receipt.converter.id.startsWith('godotjs/'));assert(receipt.outputs.every(output=>/^[a-f0-9]{64}$/.test(output.sha256)));}
 assert.equal(firstImports.find(item=>item.resource.endsWith('pixel.png')).uid,'uid://bb');assert(first.manifest.outputOverlay.some(item=>item.reason.includes('Converted by')));
 assert.deepEqual((await download('export')).files,original.files);assert.deepEqual(await download('export-original'),original);checks.push('real UI recipes execute browser PNG/JPEG and PCM converters; ResourceLoader loads original paths with generated receipts and preserved UID/original bytes');
 checks.push('the actual Worker directly decodes SVG, GLB and OGG and loads native TSCN/TRES; no editor importer is required for these tested routes');
 const secondWav=wav([8,16,32,64,128,255,128,64]);const count=await page.evaluate(()=>globalThis.__resourceBuilds.length);
 await page.locator('.file[data-path="/assets/tone.wav"]').click({button:'right'});await page.locator('#delete-file').click();await page.locator('#asset-import').setInputFiles({name:'tone.wav',mimeType:'audio/wav',buffer:secondWav});
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().project.files['/assets/tone.wav']?.length===52&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout});await page.locator('#run').click();const second=await running(count,0.001),newReceipt=second.manifest.artifactReceipt.imports.find(item=>item.resource.endsWith('tone.wav')),oldReceipt=firstImports.find(item=>item.resource.endsWith('tone.wav'));
 assert.equal(newReceipt.sources[0].sha256,hash(secondWav));assert.notEqual(oldReceipt.sources[0].sha256,newReceipt.sources[0].sha256);assert.notDeepEqual(oldReceipt.outputs,newReceipt.outputs);assert.notEqual(first.manifest.buildKey,second.manifest.buildKey);
 assert.deepEqual((await download('export')).files['/assets/tone.wav'],[...secondWav]);assert.deepEqual((await download('export-original')).files['/assets/tone.wav'],[...firstWav]);checks.push('replacing WAV through the resource UI reexecutes conversion and changes source/output hashes and buildKey while original export stays intact');
 await imported({...original,resourceImports:[{resource:'res://assets/tone.wav',converter:'unavailable-editor-importer'}]});await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().diagnostics.some(item=>item.code==='E_RESOURCE_CONVERTER'&&item.message.includes('not registered')),null,{timeout});checks.push('unavailable converters fail explicitly instead of blessing an existing cache');
 await page.locator('#stop').click();
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});await largeTextureCase();
 report=await withAcceptanceContext({status:'passed',scope:'actual-product-resource-converters',checks,cases,pageErrors:errors,receiptExamples:firstImports.map(({resource,converter,target,uid,parameterHash})=>({resource,converter,target,...(uid?{uid}:{}),parameterHash}))},{directory,browser});
}catch(error){report={...report,error:String(error),stack:error?.stack,checks,cases,pageErrors:errors,...(page?{observed:await inspect().catch(()=>undefined),logs:await page.locator('#logs').textContent().catch(()=>undefined)}:{})};process.exitCode=1;}
finally{if(process.env.PLAYGROUND_RESOURCE_REPORT){const file=path.resolve(process.env.PLAYGROUND_RESOURCE_REPORT);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);}
