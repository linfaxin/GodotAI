import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('../',import.meta.url));

// Explicit developer-provider test: real Worker, WebGL2, texture arrays, GPU
// blits, transferable ImageBitmap and compositor upload. No XR hardware claim.
test('real GPU stereo atlas reaches the Window XR layer with the correct eyes and vertical orientation',{skip:process.env.GODOT_XR_GPU_TEST!=='1'},async()=>{
 const identity={runId:'gpu-xr-run',documentId:'gpu-xr-document',workerId:'gpu-xr-worker',revision:1,generation:1,buildKey:'gpu-test',runConfigurationHash:'a'.repeat(64)};
 const workerSource=`import {createWorkerXRBridge} from './src/worker-xr.ts';
let bridge;onmessage=event=>{if(event.data.type==='stop'){bridge.dispose();postMessage({type:'retired',snapshot:bridge.snapshot()});return;}
const {port,identity}=event.data,canvas=new OffscreenCanvas(8,8),gl=canvas.getContext('webgl2',{antialias:false}),textures=new Map();let id=0,renders=0;
if(!gl)throw Error('Real Worker WebGL2 unavailable');
bridge=createWorkerXRBridge(port,{identity,canvas,onError:error=>postMessage({type:'error',message:String(error.stack||error)})});
const fbo=gl.createFramebuffer();
function draw(){renders++;const texture=textures.get(bridge.getColorTexture());gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
for(let layer=0;layer<2;layer++){gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,texture,0,layer);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Native array framebuffer incomplete');
gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,2,1);gl.clearColor(...(layer?[1,1,0,1]:[0,0,1,1]));gl.clear(gl.COLOR_BUFFER_BIT);gl.scissor(0,1,2,1);gl.clearColor(...(layer?[0,1,0,1]:[1,0,0,1]));gl.clear(gl.COLOR_BUFFER_BIT);}
const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('Worker GL error '+error);postMessage({type:'rendered',renders,views:bridge.getViewCount(),size:bridge.getRenderTargetSize(),snapshot:bridge.snapshot()});bridge.requestAnimationFrame(draw);}
bridge.initialize({mode:'inline',requiredFeatures:[],optionalFeatures:[],referenceSpaces:['local']},{started(){bridge.requestAnimationFrame(draw);},ended(){bridge.uninitialize();},failed(message){postMessage({type:'error',message});},input(){},simple(){},wakeMainLoop(){}},{gl,registerTexture(texture){textures.set(++id,texture);return id;},releaseTexture(key,texture){textures.delete(key);gl.deleteTexture(texture);}});};`;
 const hostSource=`import {createWorkerXRHost} from './src/worker-xr-host.ts';
const identity=${JSON.stringify(identity)},unit=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];let inFrame=false,layer,providerFrames=0;
const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,settings){const gl=getContext.call(this,type,settings);if(type==='webgl2'&&settings?.xrCompatible&&gl){gl.makeXRCompatible=async()=>{};const draw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{if(!inFrame)throw Error('XR draw escaped session frame');draw(...args);};}return gl;};
class VirtualSession extends EventTarget{constructor(){super();this.inputSources=[];this.visibilityState='visible';this.enabledFeatures=[];this.environmentBlendMode='opaque';this.frameRate=90;this.supportedFrameRates=[90];this.ended=false;}
async requestReferenceSpace(){const value=new EventTarget();value.boundsGeometry=[];return value;}updateRenderState(){}cancelAnimationFrame(id){cancelAnimationFrame(id);}async end(){this.ended=true;this.dispatchEvent(new Event('end'));}
requestAnimationFrame(callback){return requestAnimationFrame(time=>{if(this.ended)return;providerFrames++;inFrame=true;try{callback(time,{getViewerPose(){if(!inFrame)throw Error('Expired XR frame');return{transform:{matrix:unit},views:[0,1].map(index=>({index,transform:{matrix:unit},projectionMatrix:unit}))};},getPose(){return null;}});
if(layer){const {gl,fbo}=layer;gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);const pixels=new Uint8Array(128);gl.readPixels(0,0,8,4,gl.RGBA,gl.UNSIGNED_BYTE,pixels);globalThis.__pixels=Array.from(pixels);if(gl.getError()!==gl.NO_ERROR)throw Error('Window XR GL error');}}
finally{inFrame=false;}});}}
Object.defineProperty(navigator,'xr',{configurable:true,value:{isSessionSupported:async()=>true,requestSession:async()=>new VirtualSession()}});
globalThis.XRWebGLLayer=class{constructor(session,gl){this.gl=gl;this.framebufferWidth=8;this.framebufferHeight=4;const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,8,4);this.fbo=this.framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);layer=this;}getViewport(view){const size=providerFrames<5?2:4;return{x:view.index*size,y:0,width:size,height:size};}};
globalThis.__errors=[];const channel=new MessageChannel(),host=createWorkerXRHost(channel.port1,{identity,onError:error=>__errors.push(String(error.stack||error))}),worker=new Worker('/worker.js');globalThis.__host=host;globalThis.__worker=worker;
worker.onerror=event=>__errors.push(event.message);worker.onmessage=event=>{if(event.data.type==='error')__errors.push(event.data.message);else globalThis['__'+event.data.type]=event.data;};worker.postMessage({port:channel.port2,identity},[channel.port2]);`;
 const compile=async contents=>(await build({stdin:{contents,resolveDir:directory},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'})).outputFiles[0].contents;
 const [workerCode,hostCode]=await Promise.all([compile(workerSource),compile(hostSource)]);
 const server=createServer((request,response)=>{const route=request.url==='/worker.js'?workerCode:request.url==='/host.js'?hostCode:'<!doctype html><script src="/host.js"></script>';response.writeHead(200,{'content-type':request.url?.endsWith('.js')?'text/javascript':'text/html'}).end(route);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  const {launchTestBrowser}=await import('../../../apps/playground/scripts/browser-harness.mjs');browser=await launchTestBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',value=>errors.push(String(value)));await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>{if(__errors.length)throw Error(__errors.join('\n'));return __host.snapshot().presented>=8;},null,{timeout:15000});
  const result=await page.evaluate(()=>({pixels:__pixels,host:__host.snapshot(),worker:__rendered,errors:__errors}));
  assert.deepEqual(result.errors,[]);assert.deepEqual(errors,[]);assert.equal(result.worker.views,2);assert.deepEqual(result.worker.size,[2,2]);
  const pixel=(x,y)=>result.pixels.slice((y*8+x)*4,(y*8+x+1)*4);
  assert.deepEqual(pixel(0,0),[0,0,255,255],'left eye bottom');assert.deepEqual(pixel(0,3),[255,0,0,255],'left eye top');
  assert.deepEqual(pixel(4,0),[255,255,0,255],'right eye bottom');assert.deepEqual(pixel(4,3),[0,255,0,255],'right eye top');assert.deepEqual(pixel(3,0),[0,0,255,255],'upsampled left eye edge never samples right eye');assert.deepEqual(pixel(3,3),[255,0,0,255],'upsampled left top edge');assert.deepEqual(pixel(7,0),[255,255,0,255],'upsampled right edge');
  await page.evaluate(async()=>{await __host.dispose();__worker.postMessage({type:'stop'});});await page.waitForFunction(()=>globalThis.__retired);
  const retired=await page.evaluate(()=>({host:__host.snapshot(),worker:__retired.snapshot}));assert.equal(retired.host.sessionEnded,true);assert.equal(retired.worker.gpuBytes,0);assert.equal(retired.worker.outstandingFrames,0);
  console.log(JSON.stringify({kind:'xr-developer-provider-real-gpu',hardwareValidated:false,views:result.worker.views,pixels:result.pixels,retired}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
