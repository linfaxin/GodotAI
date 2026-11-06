// Node orchestrates this development/CI check; decoding, resource compilation,
// PCK assembly and Godot resource loading all happen in the browser.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const args=process.argv.slice(2),arg=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const engineDir=arg('--engine-dir')??process.env.GODOT_WEB_ASSETS;
const playwright=process.env.PLAYWRIGHT_MODULE;
if(!engineDir||!playwright)throw Error('Usage: PLAYWRIGHT_MODULE=/path/playwright-core/index.mjs node test/assets.browser.mjs --engine-dir /path/to/godot-assets [--out report.json]');
const {chromium}=await import(pathToFileURL(resolve(playwright)).href);
const here=dirname(fileURLToPath(import.meta.url));
const bundle=await build({stdin:{contents:`export {compileAssets} from ${JSON.stringify(join(here,'../src/assets.ts'))};export {packProject} from ${JSON.stringify(join(here,'../src/pck.ts'))};`,resolveDir:join(here,'..')},bundle:true,write:false,format:'iife',globalName:'BrowserAssetProbe',platform:'browser'});
const server=createServer(async(request,response)=>{
  try{
    if(request.url==='/'){response.setHeader('content-type','text/html');response.end('<canvas id="canvas" width="80" height="80"></canvas><script src="/godot.js"></script><script src="/probe.js"></script>');return;}
    if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(request.url==='/probe.js'){response.setHeader('content-type','application/javascript');response.end(bundle.outputFiles[0].contents);return;}
    const file=request.url==='/godot.js'?'godot.js':request.url==='/godot.wasm'?'godot.wasm':undefined;
    if(!file){response.writeHead(404);response.end();return;}
    response.setHeader('content-type',file.endsWith('.wasm')?'application/wasm':'application/javascript');response.end(await readFile(join(engineDir,file)));
  }catch(error){response.writeHead(500);response.end(String(error));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK??='1';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage(),logs=[],errors=[];
  page.on('console',message=>logs.push({level:message.type(),text:message.text()}));
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const compilation=await page.evaluate(async()=>{
    const canvas=new OffscreenCanvas(2,1);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([255,0,0,255,0,128,255,64]),2,1),0,0);
    const png=new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
    const jpeg=new Uint8Array(await(await canvas.convertToBlob({type:'image/jpeg',quality:1})).arrayBuffer());
    const encode=value=>new TextEncoder().encode(value);
    const snapshot={revision:'native-assets',sourceHash:'probe',files:new Map([
      ['/assets/pixel.png',png],['/assets/pixel.jpg',jpeg],
      ['/assets/circle.tres',encode('[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = 7\n')],
    ]),config:{assets:{pixel:{source:'/assets/pixel.png',type:'Texture2D'},jpeg:{source:'/assets/pixel.jpg',type:'Texture2D'},circle:{source:'/assets/circle.tres',type:'CircleShape2D'}}}};
    const result=await BrowserAssetProbe.compileAssets(snapshot,{generation:'native-probe'});
    const js=`const G=require("godot");const call=(o,n,...a)=>{const c=n.replace(/_([a-z])/g,(_,x)=>x.toUpperCase());return(o[n]??o[c]).apply(o,a)};exports.default=class AssetProbe extends G.Node{_ready(){try{const texture=call(G.ResourceLoader,"load",${JSON.stringify(result.resources.pixel.uri)});const image=call(texture,"get_image");const pixel=call(image,"get_pixel",0,0);const jpg=call(G.ResourceLoader,"load",${JSON.stringify(result.resources.jpeg.uri)});const circle=call(G.ResourceLoader,"load",${JSON.stringify(result.resources.circle.uri)});console.log("NATIVE_ASSET_REPORT "+JSON.stringify({textureClass:call(texture,"get_class"),width:call(texture,"get_width"),height:call(texture,"get_height"),pixel:[pixel.r,pixel.g,pixel.b,pixel.a],jpegClass:call(jpg,"get_class"),jpegWidth:call(jpg,"get_width"),circleClass:call(circle,"get_class"),radius:circle.radius}));call(call(this,"get_tree"),"quit",0)}catch(e){console.error("NATIVE_ASSET_FAILED "+String(e)+" "+e.stack);call(call(this,"get_tree"),"quit",1)}}};`;
    result.files.set('res://src/AssetProbe.ts',encode('export default class AssetProbe {}'));
    result.files.set('res://.godot/GodotJS/src/AssetProbe.js',encode(js));
    result.files.set('res://AssetProbe.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/AssetProbe.ts" id="1"]\n[node name="AssetProbe" type="Node"]\nscript = ExtResource("1")\n'));
    result.files.set('res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n'));
    result.files.set('res://project.godot',encode('config_version=5\n[application]\nconfig/name="Assets native probe"\nrun/main_scene="res://AssetProbe.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[physics]\n2d/physics_engine="Dummy"\n3d/physics_engine="Dummy"\n[GodotJS]\nruntime/debugger/debugger_port=0\n'));
    const pack=BrowserAssetProbe.packProject(result.files).pack;
    window.nativeAssetProbe={events:[],exited:false};
    const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/godot',persistentPaths:[],onPrint:(...args)=>window.nativeAssetProbe.events.push(args.join(' ')),onPrintError:(...args)=>window.nativeAssetProbe.events.push('ERROR '+args.join(' ')),onExit:code=>{window.nativeAssetProbe.exitCode=code;window.nativeAssetProbe.exited=true;}});
    await engine.preloadFile(pack,'/application.pck');await engine.init('/godot');await engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});
    return{resources:result.resources,sourceHashes:result.sourceHashes,packBytes:pack.byteLength};
  });
  await page.waitForFunction(()=>window.nativeAssetProbe?.exited,{timeout:60000});
  const native=await page.evaluate(()=>window.nativeAssetProbe);
  const marker=logs.find(message=>message.text.startsWith('NATIVE_ASSET_REPORT '));
  const resourceReport=marker?JSON.parse(marker.text.slice('NATIVE_ASSET_REPORT '.length)):undefined;
  const report={compilation,native,resourceReport,logs,errors};
  if(arg('--out'))await writeFile(resolve(arg('--out')),JSON.stringify(report,null,2));
  assert.equal(native.exitCode,0);assert.deepEqual(errors,[]);assert(resourceReport,'Native resource report is required');
  assert.equal(resourceReport.textureClass,'ImageTexture');assert.equal(resourceReport.width,2);assert.equal(resourceReport.height,1);assert.deepEqual(resourceReport.pixel,[1,0,0,1]);
  assert.equal(resourceReport.jpegClass,'ImageTexture');assert.equal(resourceReport.jpegWidth,2);assert.equal(resourceReport.circleClass,'CircleShape2D');assert.equal(resourceReport.radius,7);
  assert(!native.events.some(event=>event.startsWith('ERROR ')),JSON.stringify(native.events));
  console.log(JSON.stringify({status:'passed',browser:browser.version(),resourceReport,packBytes:compilation.packBytes}));
}finally{await browser.close();await new Promise(done=>server.close(done));}
