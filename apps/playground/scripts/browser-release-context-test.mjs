import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {launchBrowser} from './browser-harness.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const bundle=await build({entryPoints:[new URL('../preview.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
const javascript=bundle.outputFiles[0].contents;
const engine=JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',id:'engine-r1'});
const demo=JSON.stringify({schemaVersion:1,demoApiVersion:1,runtimeProfile:'engine-2d-v1'});
const site=JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',payloads:{'demo-release.json':{sha256:hash(demo)}}});
let mode='engine-id',engineRequests=0;
const editor=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Release-context negative test</title>');});
const preview=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://fixture').pathname;
 if(pathname==='/preview.html'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="connection-status"></div><canvas id="canvas"></canvas><script src="preview.js"></script>');return;}
 if(pathname==='/preview.js'){res.setHeader('content-type','text/javascript');res.end(javascript);return;}
 if(pathname.startsWith('/engine/')){engineRequests++;res.writeHead(500).end('Engine must not be requested after a context mismatch');return;}
 let bytes=pathname==='/engine-release.json'?(mode==='engine-id'?JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',id:'engine-r2'}):mode==='descriptor'?engine+'\n':engine):pathname==='/demo-release.json'?(mode==='helper'?demo+'\n':demo):pathname==='/manifest.json'?(mode==='candidate'?site+'\n':site):undefined;
 if(bytes===undefined){res.writeHead(404).end();return;}res.setHeader('content-type','application/json');res.setHeader('cache-control','no-cache');res.end(bytes);
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
await listen(editor);await listen(preview);
const editorOrigin=`http://127.0.0.1:${editor.address().port}`,previewOrigin=`http://127.0.0.1:${preview.address().port}`;
const context={engineProfile:'engine-2d-v1',engineReleaseId:'engine-r1',descriptorHash:hash(engine),releaseRoot:editorOrigin+'/',demoDescriptorHash:hash(demo),candidateId:hash(site)};
const release={releaseId:'engine-r1',profile:'engine-2d-v1',releaseContext:context,engineJs:{url:previewOrigin+'/engine/game.js',sha256:'a'.repeat(64)},engineWasm:{url:previewOrigin+'/engine/game.wasm',sha256:'b'.repeat(64)},allowedOrigins:[previewOrigin]};
let browser;const checks=[];
try{
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(mode of ['engine-id','descriptor','helper','candidate']){
  const page=await browser.newPage();await page.goto(editorOrigin);
  const result=await page.evaluate(async({previewOrigin,release,context})=>{
   const frame=document.createElement('iframe');frame.src=previewOrigin+'/preview.html?editorOrigin='+encodeURIComponent(location.origin);document.body.append(frame);
   await new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=reject;});
   return new Promise((resolve,reject)=>{
    const channel=new MessageChannel(),identity={runId:crypto.randomUUID(),revision:1,buildKey:'context-negative',generation:'context-negative'},timer=setTimeout(()=>reject(Error('Preview context rejection timed out')),15000);
    channel.port1.onmessage=event=>{
     if(event.data.type==='connected')channel.port1.postMessage({...identity,protocolVersion:1,type:'run',release,artifact:{pack:new Uint8Array([1]),manifest:{generation:identity.generation,engineProfile:context.engineProfile,engineReleaseId:context.engineReleaseId,releaseContext:context}}});
     if(event.data.type==='fatal'){clearTimeout(timer);channel.port1.close();frame.remove();resolve(event.data.text);}
    };
    frame.contentWindow.postMessage({...identity,protocolVersion:1,type:'connect',editorOrigin:location.origin},previewOrigin,[channel.port2]);
   });
  },{previewOrigin,release,context});
  assert.match(result,/E_PREVIEW_SITE_RELEASE|E_RELEASE_CONTEXT_MISMATCH|E_PREVIEW_SITE_DEMO/);
  assert.equal(engineRequests,0,'The production preview must reject before engine downloads');
  checks.push({case:mode,rejected:true,error:result,engineRequests});await page.close();
 }
 console.log(JSON.stringify({status:'passed',testMode:'real-preview-negative',engineExecuted:false,previewBundleSha256:hash(javascript),browser:{name:browser.browserType().name(),version:browser.version()},checks},null,2));
}finally{await browser?.close();await close(editor);await close(preview);}
