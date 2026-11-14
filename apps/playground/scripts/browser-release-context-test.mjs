import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {launchBrowser} from './browser-harness.mjs';
import {prepareWorkerRunConfiguration} from '../../../scripts/jsb.react-browser/dist/worker-protocol.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const bundle=await build({entryPoints:[new URL('../preview.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
const javascript=bundle.outputFiles[0].contents,abi={protocolVersion:2,host:1,audio:1,presentation:1};
const asset=(path,character)=>({path,sha256:character.repeat(64)});
const engineValue={schemaVersion:2,runtimeProfile:'engine-2d-v1',id:'engine-r1',runtimeAbi:abi,engine:{javascript:asset('engine/game.js','a'),wasm:asset('engine/game.wasm','b'),worklets:[]}};
const engine=JSON.stringify(engineValue),demo=JSON.stringify({schemaVersion:1,demoApiVersion:1,runtimeProfile:'engine-2d-v1'});
const runtime={executionBackend:'worker',abi,entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:{'runtime.worker.js':asset('runtime.worker.js','c'),'runtime.audio.worklet.js':asset('runtime.audio.worklet.js','d')}};
const site=JSON.stringify({schemaVersion:3,runtimeProfile:'engine-2d-v1',engineReleaseId:'engine-r1',runtime,payloads:{'demo-release.json':{sha256:hash(demo)}}});
let mode,requests=[];
const editor=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Release-context protocol V2 test</title>');});
const preview=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://fixture').pathname;
 if(pathname==='/preview.html'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="connection-status"></div><canvas id="canvas"></canvas><script src="preview.js"></script>');return;}
 if(pathname==='/preview.js'){res.setHeader('content-type','text/javascript');res.end(javascript);return;}
 requests.push(pathname);
 if(pathname.startsWith('/engine/')||pathname.startsWith('/runtime.')){res.setHeader('content-type','text/javascript');res.end('/* intentional asset hash mismatch; never executed */');return;}
 const bytes=pathname==='/engine-release.json'?(mode==='engine-id'?JSON.stringify({...engineValue,id:'engine-r2'}):mode==='descriptor'?engine+'\n':engine):pathname==='/demo-release.json'?(mode==='helper'?demo+'\n':demo):pathname==='/manifest.json'?(mode==='candidate'?site+'\n':site):undefined;
 if(bytes===undefined){res.writeHead(404).end();return;}res.setHeader('content-type','application/json');res.setHeader('cache-control','no-cache');res.end(bytes);
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
await listen(editor);await listen(preview);
const editorOrigin=`http://127.0.0.1:${editor.address().port}`,previewOrigin=`http://127.0.0.1:${preview.address().port}`;
const context={engineProfile:'engine-2d-v1',engineReleaseId:'engine-r1',descriptorHash:hash(engine),releaseRoot:editorOrigin+'/',demoDescriptorHash:hash(demo),candidateId:hash(site)};
const resolved=value=>({...value,url:previewOrigin+'/'+value.path});
const release={releaseId:'engine-r1',profile:'engine-2d-v1',runtimeAbi:abi,releaseContext:context,engineJs:resolved(engineValue.engine.javascript),engineWasm:resolved(engineValue.engine.wasm),worklets:[],runtimeWorker:resolved(runtime.assets[runtime.entry]),runtimeAudioWorklet:resolved(runtime.assets[runtime.audioWorklet]),allowedOrigins:[previewOrigin]};
const prepared=await prepareWorkerRunConfiguration();
let browser;const checks=[];
try{
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(mode of ['engine-id','descriptor','helper','candidate','matching-context']){
  requests=[];const page=await browser.newPage();await page.goto(editorOrigin);
  const result=await page.evaluate(async({previewOrigin,release,context,prepared})=>{
   const frame=document.createElement('iframe');frame.src=previewOrigin+'/preview.html?editorOrigin='+encodeURIComponent(location.origin);document.body.append(frame);
   await new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=reject;});
   return new Promise((resolve,reject)=>{
    const channel=new MessageChannel(),identity={runId:crypto.randomUUID(),revision:1,buildKey:'context-negative',generation:1,documentId:crypto.randomUUID(),workerId:crypto.randomUUID(),runConfigurationHash:prepared.hash},timer=setTimeout(()=>reject(Error('Preview context rejection timed out')),15000);
    channel.port1.onmessage=event=>{
     const message=event.data;
     if(message.type==='connected')channel.port1.postMessage({...identity,protocolVersion:2,type:'run',configuration:prepared.configuration,release,artifact:{pack:new Uint8Array([1]),manifest:{runtime:'godot',generation:identity.generation,engineProfile:context.engineProfile,engineReleaseId:context.engineReleaseId,releaseContext:context}}});
     if(message.type==='exit-report'){clearTimeout(timer);channel.port1.close();frame.remove();resolve(message);}
    };
    frame.contentWindow.postMessage({...identity,protocolVersion:2,type:'connect',editorOrigin:location.origin},previewOrigin,[channel.port2]);
   });
  },{previewOrigin,release,context,prepared});
  assert.equal(result.protocolVersion,2);assert.equal(result.engineOutcome.kind,'startup-failed');assert.equal(result.hostCleanup.status,'complete');assert.equal(result.code,undefined,'A startup rejection is not a Native exit');
  const executableRequests=requests.filter(name=>name.startsWith('/engine/')||name.startsWith('/runtime.'));
  assert.deepEqual(requests.filter(name=>name.endsWith('.json')),['/engine-release.json','/demo-release.json','/manifest.json']);
  if(mode==='matching-context'){assert.match(result.diagnostic.message,/E_ASSET_HASH/);assert.deepEqual(executableRequests,['/runtime.audio.worklet.js']);}
  else{assert.match(result.diagnostic.message,/E_PREVIEW_SITE_RELEASE|E_RELEASE_CONTEXT_MISMATCH|E_PREVIEW_SITE_DEMO/);assert.deepEqual(executableRequests,[],'Reject before downloading executable assets');}
  checks.push({case:mode,exitReport:result,requests:[...requests],nativeExecuted:false});await page.close();
 }
 console.log(JSON.stringify({status:'passed',testMode:'real-preview-protocol-v2',engineExecuted:false,previewBundleSha256:hash(javascript),browser:{name:browser.browserType().name(),version:browser.version()},checks},null,2));
}finally{await browser?.close();await close(editor);await close(preview);}
