import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createSecureServer} from 'node:https';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStaticServer} from './serve.mjs';
import {launchBrowser} from './browser-harness.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';

// Both inputs are complete built sites. No engine, compiler, PCK, descriptor,
// integrity decision or progress signal is mocked by this deployment drill.
const previousDirectory=process.env.PLAYGROUND_ROLLBACK_PREVIOUS;
const candidateDirectory=process.env.PLAYGROUND_ROLLBACK_CANDIDATE;
if(!previousDirectory||!candidateDirectory)throw Error('Set PLAYGROUND_ROLLBACK_PREVIOUS and PLAYGROUND_ROLLBACK_CANDIDATE to two built product sites');
const output=process.env.PLAYGROUND_ROLLBACK_REPORT;
const timeout=Number(process.env.PLAYGROUND_ROLLBACK_TIMEOUT??120000);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'godotjs-real-rollback-'));
const checks=[],runs=[],requests=[],errors=[],stops=[];
const tls=process.env.PLAYGROUND_TEST_TLS==='0'?undefined:await createLocalTestTls();
if(tls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned local TLS currently requires Chromium');
let active,mixed=false,browser,context,editor,preview,deployment;
async function load(directory){
 directory=path.resolve(directory);
 const [siteBytes,releaseBytes,demoBytes]=await Promise.all(['manifest.json','engine-release.json','demo-release.json'].map(name=>fs.readFile(path.join(directory,name))));
 const site=JSON.parse(siteBytes),release=JSON.parse(releaseBytes);
 assert.equal(site.publicAssets,true,'Build rollback inputs with --public-assets to exercise immutable delivery');
 assert.equal((release.execution??release.engine.execution).executionModel,'proxy-pthread');
 assert.equal(site.engineReleaseId,release.id);
 const tuple={candidateId:sha(siteBytes),engineReleaseId:release.id,engineId:release.engineId,extensionId:release.extensionId,descriptorHash:sha(releaseBytes),demoDescriptorHash:sha(demoBytes),runtimeProfile:release.runtimeProfile};
 const target=path.join(temporary,'releases',tuple.candidateId);
 await fs.cp(directory,target,{recursive:true,mode:constants.COPYFILE_FICLONE});
 return {directory,releaseBytes,tuple};
}
const a=await load(previousDirectory),b=await load(candidateDirectory);
assert.notEqual(a.tuple.candidateId,b.tuple.candidateId,'The drill requires two distinct built candidates');
active=a;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>server?new Promise(resolve=>server.close(resolve)):Promise.resolve();
function siteServer(){
 const files=createStaticServer(temporary,{isolation:true,publicImmutable:true});
 const handler=(req,res)=>{
  const url=new URL(req.url,'http://deployment.test');
  if(url.pathname==='/'){
   res.writeHead(302,{'Location':`/releases/${active.tuple.candidateId}/index.html${url.search}`,'Cache-Control':'no-store'}).end();return;
  }
  if(mixed&&url.pathname===`/releases/${b.tuple.candidateId}/engine-release.json`){
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin'}).end(a.releaseBytes);return;
  }
  files.emit('request',req,res);
 };
 return tls?createSecureServer({key:tls.key,cert:tls.cert},handler):createServer(handler);
}
async function until(fn,message){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,50));}
 throw Error(message);
}
const state=page=>page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect());
async function ready(page,expected){
 await until(async()=>{
  if(errors.length)throw Error(JSON.stringify(errors));
  const value=await state(page);
  if(value?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(value.diagnostics));
  const logs=await page.locator('#logs').textContent();
  if(/\bE_[A-Z_]+\b|编译失败/.test(logs??''))throw Error(logs);
  return value?.ready&&value.engine?.state==='running';
 },'The complete product did not reach a real Worker frame');
 const value=await state(page);
 assert.equal(value.releaseContext.candidateId,expected.tuple.candidateId);
 assert.equal(value.releaseContext.engineReleaseId,expected.tuple.engineReleaseId);
 assert.equal(value.releaseContext.descriptorHash,expected.tuple.descriptorHash);
 assert.equal(value.releaseContext.demoDescriptorHash,expected.tuple.demoDescriptorHash);
 const expectedPath=`/releases/${expected.tuple.candidateId}/`;
 assert.equal(new URL(value.releaseContext.releaseRoot).pathname,expectedPath);
 const frame=page.frames().find(frame=>frame.url().includes('/preview.html'));
 assert(frame);assert.notEqual(new URL(frame.url()).origin,new URL(page.url()).origin);
 assert.equal(new URL(frame.url()).pathname,expectedPath+'preview.html');
 assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 assert.equal(await frame.evaluate(()=>crossOriginIsolated),true);
 assert.match(await page.locator('#logs').textContent(),/GODOTJS_WORKER_ROLE engine/);
 // running marks the native scene, while worklet initialization completes
 // asynchronously. Require the actual resource whose cleanup we assert.
 await until(()=>frame.evaluate(()=>globalThis.__rollbackResources?.audioWorkletNodes.length>=1),'The real audio worklet node was not constructed');
 return value;
}
async function stop(page){
 const before=await page.evaluate(()=>({engine:globalThis.__playgroundWorkbench?.inspect().engine,offset:globalThis.__rollbackTelemetry.length}));
 const frame=page.frames().find(frame=>frame.url().includes('/preview.html'));
 const resources=await frame?.evaluate(()=>globalThis.__rollbackResources);
 await page.locator('#stop').click();
 await until(async()=>await page.locator('#preview iframe').count()===0,'The retired preview frame remained mounted');
 const terminalEvents=await page.evaluate(offset=>globalThis.__rollbackTelemetry.slice(offset).filter(item=>['exited','terminated','fatal'].includes(item.type)),before.offset);
 const receipt=terminalEvents.at(-1);
 stops.push({page:page.url(),before,resources,terminalEvents,receipt});
 assert.equal(terminalEvents.length,1,'Each stop must deliver exactly one terminal receipt for its own run');
 assert(receipt,'A terminal cleanup receipt must cross the actual MessageChannel');
 assert.equal(receipt.type,'exited');assert.equal(receipt.code,0);
 assert(receipt.cleanup.workers>=1);assert(receipt.cleanup.audioContexts>=1);assert(receipt.cleanup.messagePorts>=1);assert(receipt.cleanup.glContexts>=1);
 assert.equal(receipt.cleanup.workers,receipt.cleanup.terminatedWorkers);
 assert.equal(receipt.cleanup.audioContexts,receipt.cleanup.closedAudioContexts);
 assert.equal(receipt.cleanup.messagePorts,receipt.cleanup.closedMessagePorts);
 assert.equal(receipt.cleanup.glContexts,receipt.cleanup.lostGlContexts);
 assert.deepEqual(receipt.cleanup.errors,[]);
 return receipt.cleanup;
}
function nativeProject(profile,label){return {schemaVersion:3,engineProfile:profile,runtime:'godot',demoId:'native',entry:'/src/Main.ts',selected:'/src/Main.ts',mode:'production',controls:{},files:{
 '/project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
 '/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n',
 '/src/Main.ts':`import {Node,print} from "godot";export default class Main extends Node{_ready(){print(${JSON.stringify('ROLLBACK_NATIVE_READY '+label)});}}`,
}};}
async function run(page,expected,label,{rerun=false}={}){
 const offset=requests.length;
 if(rerun)await page.locator('#run').click();
 else await page.locator('#import').setInputFiles({name:label+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(nativeProject(expected.tuple.runtimeProfile,label)))});
 await ready(page,expected);
 await until(async()=>await page.locator('#logs').textContent().then(text=>text.includes('ROLLBACK_NATIVE_READY '+label)),'The native project marker did not execute');
 const cleanup=await stop(page);
 const observed=requests.slice(offset).filter(item=>item.page===page.url());
 assert(observed.some(item=>/\/engine\/game\.(?:js|wasm)$/.test(new URL(item.url).pathname)),'The real verified engine assets must load');
 const prefix=`/releases/${expected.tuple.candidateId}/`;
 assert(observed.every(item=>!new URL(item.url).pathname.startsWith('/releases/')||new URL(item.url).pathname.startsWith(prefix)),'A page requested bytes from another release tuple');
 runs.push({label,tuple:expected.tuple,page:page.url(),engineExecuted:true,cleanup,requests:observed});
}
try{
 editor=siteServer();preview=siteServer();await Promise.all([listen(editor),listen(preview)]);
 const editorOrigin=`${tls?'https':'http'}://127.0.0.1:${editor.address().port}`,previewOrigin=`${tls?'https':'http'}://127.0.0.1:${preview.address().port}`;
 const immutable=await inspectTestSite(`${editorOrigin}/releases/${a.tuple.candidateId}/main.js`,tls);
 assert.equal(immutable.status,200);assert.match(immutable.headers['cache-control'],/immutable/);
 assert.equal(immutable.headers['cross-origin-embedder-policy'],'require-corp');
 assert.equal(immutable.headers['cross-origin-opener-policy'],'same-origin');
 assert.match(immutable.headers['permissions-policy'],/cross-origin-isolated/);
 deployment=localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:immutable.headers});
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 context=await browser.newContext();
 await context.addInitScript(()=>{
  globalThis.__rollbackTelemetry=[];
  if(location.pathname.endsWith('/preview.html')){
   const resources=globalThis.__rollbackResources={audioWorkletNodes:[]};
   const OriginalNode=globalThis.AudioWorkletNode;
   if(typeof OriginalNode==='function')globalThis.AudioWorkletNode=new Proxy(OriginalNode,{construct(target,args,newTarget){
    const node=Reflect.construct(target,args,newTarget);resources.audioWorkletNodes.push({name:String(args[1]),hasPort:typeof node.port?.close==='function'});return node;
   }});
  }
  const Original=MessageChannel;
  globalThis.MessageChannel=new Proxy(Original,{construct(target,args,newTarget){const channel=Reflect.construct(target,args,newTarget);for(const port of [channel.port1,channel.port2])port.addEventListener('message',event=>{if(event.data?.protocolVersion===1&&typeof event.data.runId==='string')globalThis.__rollbackTelemetry.push(event.data);});return channel;}});
 });
 const open=async expected=>{
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push({page:page.url(),message:String(error)}));
  page.on('request',request=>requests.push({page:page.url(),url:request.url()}));
  await page.goto(`${editorOrigin}/?previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});
  await ready(page,expected);await stop(page);return page;
 };
 const old=await open(a);await run(old,a,'previous-before-switch');
 active=b;
 const next=await open(b);await run(next,b,'candidate-after-switch');
 checks.push('The latest pointer switches the complete real product and its verified Worker assets to the new immutable tuple');
 await run(old,a,'previous-before-switch',{rerun:true});
 checks.push('An already open editor remains pinned to its original compiler, descriptors, helpers and Worker assets after the pointer advances');
 active=a;
 const restored=await open(a);await run(restored,a,'previous-after-rollback');
 checks.push('A whole-tuple pointer rollback starts the previous native project through the actual compiler, loader and PreviewRunner');
 const bad=await context.newPage(),badRequests=[];mixed=true;active=b;
 bad.on('request',request=>badRequests.push(request.url()));
 await bad.goto(`${editorOrigin}/?previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});
 await until(async()=>/E_SITE_RELEASE_MISMATCH|E_SITE_DEMO_MISMATCH|E_RELEASE_CONTEXT_MISMATCH/.test(await bad.locator('#logs').textContent()??''),'A mixed descriptor did not fail closed');
 assert.equal(badRequests.filter(url=>/\/engine\/game\.(?:js|wasm)$/.test(new URL(url).pathname)).length,0);
 checks.push('A deliberately mixed deployment is rejected before requesting or executing engine code');
 const report={schemaVersion:1,kind:'godotjs-real-product-rollback',status:'passed',testMode:'actual-product-double-origin',engineExecuted:true,deployment,browser:{name:browser.browserType().name(),version:browser.version()},previous:a.tuple,candidate:b.tuple,checks,runs,stops,mixedDeployment:{rejected:true,engineRequests:0},errors};
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}catch(error){
 const report={schemaVersion:1,kind:'godotjs-real-product-rollback',status:'failed',error:String(error),stack:error.stack,deployment,checks,runs,stops,requests,errors};
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.error(JSON.stringify(report,null,2));throw error;
}finally{await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();await fs.rm(temporary,{recursive:true,force:true});}
