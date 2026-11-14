#!/usr/bin/env node
// Experimental compatibility probe, not a shipping Worker backend.
// Build packages first (pnpm build). Extract a matching GodotJS threads=no Web
// template into WORKER_ENGINE_DIR. Results go to WORKER_REPORT_DIR (or work/).
// BROWSER=chromium,firefox,webkit selects targets. Firefox/WebKit require DISPLAY
// and software GL on Linux; WEBKIT_EXECUTABLE can supply a local launcher.
// PNG pixel assertions use Python/Pillow. Audio requires a working audio backend.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {makePack,makeNativePack} from './worker-runtime/fixtures.mjs';
const root=new URL('./worker-runtime/',import.meta.url),require=createRequire(new URL('../../apps/playground/package.json',import.meta.url)),drivers=require('playwright');
const output=resolve(process.env.WORKER_REPORT_DIR??new URL('../../work/worker-validation/results',import.meta.url).pathname);
await mkdir(output,{recursive:true});
const packBytes={production:await makePack('production'),development:await makePack('development'),native3d:makeNativePack()};
if(!process.env.WORKER_ENGINE_DIR)throw Error('Set WORKER_ENGINE_DIR to an extracted GodotJS single-thread Web template');
const engine=resolve(process.env.WORKER_ENGINE_DIR);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const engineBytes={};for(const name of ['godot.js','godot.wasm'])engineBytes[name]=await readFile(join(engine,name));
const report={kind:'godotjs-worker-runtime-experimental-probe',productionAcceptance:false,evidencePurpose:'Historical adapter prototype only; use the production Worker acceptance matrix for candidate/release evidence.',createdAt:new Date().toISOString(),scope:{runtime:'single-thread GodotJS, React production/development, dedicated Worker',sharedMemory:false,rendering:'real OffscreenCanvas/WebGL2; screenshot pixel assertions',audio:'separate PCM transport probe, not native Godot audio parity',browsers:'Linux; Firefox/WebKit headed with software GL'},packs:Object.fromEntries(Object.entries(packBytes).map(([mode,bytes])=>[mode,{sha256:hash(bytes),bytes:bytes.length}])),engine:Object.fromEntries(Object.entries(engineBytes).map(([name,bytes])=>[name,{sha256:hash(bytes),bytes:bytes.length}])),checks:[],browsers:[],limitations:['The adapter implements only the browser surfaces exercised by these probes. IME, clipboard, fullscreen, pointer lock, gamepad and native Godot WebAudio parity are not certified.','Linux Playwright WebKit does not establish macOS/iOS Safari compatibility.'],requests:[]};
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'),path=url.pathname;report.requests.push(path);let bytes,type='text/html';
 if(path==='/')bytes='<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' blob: \'unsafe-eval\' \'wasm-unsafe-eval\'; connect-src \'self\'; worker-src \'self\'; frame-src http://127.0.0.1:*; style-src \'unsafe-inline\'; img-src \'self\' data:; object-src \'none\'; base-uri \'none\'"><style>body{margin:0}button{position:absolute;top:250px}</style><script src="/page.js"></script>';
 else if(path==='/release.json'){const asset=name=>({url:`http://${req.headers.host}/engine/`+name,sha256:hash(engineBytes[name])});bytes=JSON.stringify({engineJs:asset('godot.js'),engineWasm:asset('godot.wasm')});type='application/json';}
 else if(path==='/verified-loader.js'){bytes=await readFile(new URL('../jsb.react-browser/dist/verified-loader.js',import.meta.url));type='text/javascript';}
 else if(path.endsWith('.pck')&&packBytes[path.slice(1,-4)]){bytes=packBytes[path.slice(1,-4)];type='application/octet-stream';}
 else if(path.startsWith('/engine/')){bytes=engineBytes[path.slice(8)]??await readFile(join(engine,path.slice(8)));type=path.endsWith('.wasm')?'application/wasm':'text/javascript';}
 else {bytes=await readFile(new URL('.'+path,root));type=path.endsWith('.js')?'text/javascript':'application/octet-stream';}
 res.writeHead(200,{'content-type':type,'cache-control':'no-store'}).end(bytes);
 }catch(error){res.writeHead(404).end(String(error));}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const previewServer=createServer((req,res)=>server.emit('request',req,res));
await new Promise(done=>previewServer.listen(0,'127.0.0.1',done));
const previewOrigin=`http://127.0.0.1:${previewServer.address().port}`;
const origin=`http://127.0.0.1:${server.address().port}`;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function observe(page,type){
 await page.waitForFunction(type=>window.observations.some(x=>x.type===type||['fatal','worker-error','react-error','exited'].includes(x.type)),type,{timeout:60000});
 const events=await page.evaluate(()=>window.observations),event=events.find(x=>x.type===type);
 if(!event)throw Error(JSON.stringify(events.slice(-12)));return event;
}
async function pixel(page,label){
 const screenshot=await page.screenshot({path:join(output,label+'.png')});
 const result=spawnSync('python3',['-c','import sys,io,json;from PIL import Image;im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB");print(json.dumps({"sample":im.getpixel((30,30)),"center":im.getpixel((160,120)),"size":im.size}))'],{input:screenshot,encoding:null});
 if(result.status!==0)throw Error(result.stderr.toString());return JSON.parse(result.stdout.toString());
}
let browser,page;
process.once('SIGTERM',()=>process.exit(143));
process.once('SIGINT',()=>process.exit(130));
async function check(browserName,name,run){if(process.env.CHECK&&name!==process.env.CHECK)return true;const begin=Date.now();console.log('RUN',browserName,name);try{const evidence=await run();report.checks.push({browser:browserName,name,status:'passed',ms:Date.now()-begin,evidence});console.log('PASS',browserName,name);return true;}catch(error){report.checks.push({browser:browserName,name,status:'failed',ms:Date.now()-begin,error:String(error),events:await page?.evaluate(()=>window.observations.slice(-12)).catch(()=>[])});console.error('FAIL',browserName,name,String(error));return false;}finally{await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2));}}
async function boot(mode='production',audio=false,raw=false,corrupt){return page.evaluate(args=>window.start(...args),[mode,audio,raw,corrupt]);}
try{for(const name of (process.env.BROWSER?process.env.BROWSER.split(','):['chromium','firefox','webkit'])){
 try{
 browser=await drivers[name].launch({headless:name==='chromium',...(name==='chromium'?{executablePath:process.env.CHROMIUM_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox','--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']}:name==='webkit'?{...(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{})}:{firefoxUserPrefs:{'webgl.force-enabled':true,'gfx.webrender.software':true}})});
 report.browsers.push({name,version:browser.version()});page=await browser.newPage({viewport:{width:800,height:600}});
 page.on('pageerror',error=>console.error('PAGE',name,String(error)));
 await page.goto(origin);
 await check(name,'main-thread-engine-reference',async()=>{await page.evaluate(()=>window.startMain());const frames=await observe(page,'frames'),commit=await observe(page,'react-commit');assert.equal(commit.worker,false);assert.equal(frames.nativeClass,'ColorRect');return {frames,commit,image:await pixel(page,name+'-main-reference')};});
 await page.goto(origin);
 await check(name,'unmodified-runtime-in-worker-requires-adapter',async()=>{await boot('production',false,true);const fatal=await observe(page,'fatal');assert.match(fatal.message,/HTMLCanvasElement|document|window/);return fatal;});
 const startup=await check(name,'react-godot-wasm-worker-arraybuffer-production',async()=>{
  const transfer=await boot();assert.equal(transfer.detached,true);assert.equal(transfer.shared,'undefined');assert.equal(transfer.crossOriginIsolated,false);
  const commit=await observe(page,'react-commit'),started=await observe(page,'started'),frames=await observe(page,'frames');
  assert.equal(commit.worker,true);assert.equal(commit.count,0);assert.equal(started.memoryArrayBuffer,true);assert.equal(started.realm.document,'undefined');assert.equal(started.realm.shared,'undefined');assert.equal(frames.nativeClass,'ColorRect');
  const image=await pixel(page,name+'-production');assert(image.sample[0]>200&&image.sample[1]<40);return {transfer,commit,started,frames,image};
 });
 if(!startup){const last=report.checks.at(-1);if(name==='webkit'&&last.events?.some(x=>x.type==='browser-alert'&&/WebGL 2/.test(x.text))){last.status='unsupported';last.reason='This WebKit build executes the project but cannot render WebGL2 on OffscreenCanvas; main-thread reference passed.';}report.checks.push({browser:name,name:'dependent-runtime-probes',status:'blocked',reason:'Real engine rendering did not pass'});continue;}
 await check(name,'native-physics-in-worker',async()=>{const physics=await observe(page,'physics');assert(physics.y>20);return physics;});
 await check(name,'react-state-update-changes-real-pixels',async()=>{
  await page.evaluate(()=>window.command({type:'increment'}));await page.waitForFunction(()=>window.observations.some(x=>x.type==='react-commit'&&x.count===1),null,{timeout:10000});
  await wait(150);const image=await pixel(page,name+'-updated');assert(image.sample[1]>200&&image.sample[0]<40);return image;
 });
 await check(name,'real-keyboard-and-pointer-reach-godot',async()=>{
  await page.locator('canvas').click({position:{x:30,y:30}});await page.keyboard.press('a');
  await page.waitForFunction(()=>window.observations.some(x=>x.type==='native-input'&&x.kind==='InputEventKey'&&x.pressed===true&&x.key===65)&&window.observations.some(x=>x.type==='native-input'&&x.kind==='InputEventMouseButton'&&x.pressed===true&&x.button===1),null,{timeout:10000});
  return page.evaluate(()=>window.observations.filter(x=>x.type==='native-input'));
 });
 await check(name,'javascriptbridge-project-channel',async()=>{
  await page.evaluate(()=>window.worker.postMessage({type:'project-command',data:{type:'probe-command',value:42}}));
  const received=await observe(page,'project-command-received');assert.deepEqual(JSON.parse(received.raw),{type:'probe-command',value:42});const sent=await observe(page,'project-event');assert.equal(sent.data.type,'probe-ready');return {sent,received};
 });
 await check(name,'offscreen-resize',async()=>{await page.evaluate(()=>window.resize(480,300));const resized=await observe(page,'resized');assert.equal(resized.width,480);assert.equal(resized.height,300);await wait(150);return {resized,image:await pixel(page,name+'-resized')};});
 await check(name,'cooperative-exit-runs-react-cleanup',async()=>{await page.evaluate(()=>window.stop());const exit=await observe(page,'exited'),cleanup=await observe(page,'effect-cleanup');assert.equal(exit.code,0);return {exit,cleanup};});
 await check(name,'development-sdk-in-worker',async()=>{await boot('development');const event=await observe(page,'frames');const commit=await observe(page,'react-commit');assert.equal(commit.worker,true);return {event,commit};});
 await check(name,'react-errors-cross-worker-boundary',async()=>{await page.evaluate(()=>window.command({type:'react-fail'}));const event=await observe(page,'react-error');assert.match(event.data.message,/WORKER_REACT_FAILURE/);return event;});
 await check(name,'worker-project-errors-cross-boundary',async()=>{await boot();await observe(page,'frames');await page.evaluate(()=>window.command({type:'throw'}));const event=await observe(page,'fatal');assert.match(event.message,/WORKER_PROJECT_FAILURE/);return event;});
 await check(name,'synchronous-infinite-loop-host-survives-and-terminates',async()=>{
  await boot();await observe(page,'frames');const before=await page.evaluate(()=>window.ticks);await page.evaluate(()=>window.command({type:'loop'}));await observe(page,'loop-entered');await wait(500);
  const after=await page.evaluate(()=>window.ticks);assert(after>before+5);await page.evaluate(()=>window.kill());const count=await page.evaluate(()=>window.observations.length);await wait(200);assert.equal(await page.evaluate(()=>window.observations.length),count);await boot();await observe(page,'frames');return {before,after,restarted:true};
 });
 await check(name,'early-startup-hard-cancel-and-restart',async()=>{await boot();await page.evaluate(()=>window.kill());await boot();return observe(page,'frames');});
 await check(name,'five-fresh-run-stop-cycles',async()=>{const exits=[];for(let i=0;i<5;i++){await boot();await observe(page,'frames');await page.evaluate(()=>window.stop());const exit=await observe(page,'exited');assert.equal(exit.code,0);exits.push(exit.code);}return {exits};});
 await check(name,'native-3d-rendering-and-png-decode-in-worker',async()=>{await boot('native3d');const frames=await observe(page,'native3d-frames'),image=await pixel(page,name+'-native3d'),asset=await observe(page,'asset-decoded');assert.equal(frames.worker,true);assert(image.center[2]>200&&image.center[0]<40);assert.equal(asset.width,2);assert.equal(asset.height,2);assert(asset.r>0.99&&asset.b>0.99);return {frames,image,asset};});
 for(const asset of ['js','wasm'])await check(name,asset+'-hash-rejected-before-execution',async()=>{await boot('production',false,false,asset);const event=await observe(page,'fatal');assert.match(event.message,/E_ASSET_HASH/);assert.equal(await page.evaluate(()=>window.observations.some(x=>x.type==='started')),false);return event;});
 await check(name,'cross-origin-sandboxed-preview-worker-loop-recovery',async()=>{
  await page.evaluate(url=>{window.kill();const frame=document.createElement('iframe');frame.id='isolated-preview';frame.sandbox='allow-scripts allow-same-origin allow-pointer-lock';frame.src=url;document.body.append(frame);},previewOrigin);
  const handle=await page.locator('#isolated-preview').elementHandle(),frame=await handle.contentFrame();await frame.waitForFunction(()=>typeof window.start==='function');
  const transfer=await frame.evaluate(()=>window.start());assert.equal(transfer.crossOriginIsolated,false);await observe(frame,'frames');const before=await page.evaluate(()=>window.ticks);
  await frame.evaluate(()=>window.command({type:'loop'}));await observe(frame,'loop-entered');await wait(400);const after=await page.evaluate(()=>window.ticks);assert(after>before+5);
  await frame.evaluate(()=>window.kill());await frame.evaluate(()=>window.start());await observe(frame,'frames');await frame.evaluate(()=>window.kill());await page.locator('#isolated-preview').evaluate(el=>el.remove());await handle.dispose();return {editorOrigin:origin,previewOrigin,before,after,restarted:true};
 });
 await check(name,'native-godot-audio-blocked-without-host-adapter',async()=>{await boot('production',true);const exit=await observe(page,'exited'),started=await observe(page,'started'),logs=await page.evaluate(()=>window.observations.filter(x=>x.type==='log'));assert.equal(started.audioContext,'undefined');assert(logs.some(x=>x.text.includes("Unknown audio driver 'AudioWorklet'")));return {exit,logs,scope:'Known functionality gap: native AudioWorklet driver is not registered when Worker has no AudioContext; this is not audio playback success'};});
 await page.evaluate(()=>window.kill());
 await check(name,'pcm-arraybuffer-worker-to-audioworklet',async()=>{
  await page.evaluate(()=>{window.observations=[];window.prepareAudio();});await page.locator('#audio-start').click();
  await page.waitForFunction(()=>window.observations.some(x=>x.type==='audio-rendered'||x.type==='audio-failed'),null,{timeout:15000});
  const produced=await observe(page,'audio-produced'),rendered=await observe(page,'audio-rendered');assert.equal(produced.worker,true);assert.equal(produced.shared,'undefined');assert.equal(produced.detached,32);assert(rendered.energy>1);await page.evaluate(()=>window.closeAudio());const closed=await observe(page,'audio-closed');assert.equal(closed.state,'closed');return {produced,rendered,closed,scope:'Actual PCM transport and worklet processing; not integrated Godot WebAudio certification'};
 });
 }catch(error){report.checks.push({browser:name,name:'browser-session',status:'failed',error:String(error)});console.error(name,error);}finally{await browser?.close();browser=undefined;}
 }}finally{await Promise.all([new Promise(done=>server.close(done)),new Promise(done=>previewServer.close(done))]);report.finishedAt=new Date().toISOString();await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report.checks.map(({browser,name,status,error})=>({browser,name,status,error})),null,2));
if(report.checks.some(x=>x.status==='failed'))process.exitCode=1;
