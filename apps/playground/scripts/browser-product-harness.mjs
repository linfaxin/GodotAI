import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';

// Observation only: production workers, compiler responses and protocol payloads
// retain their original bytes and handlers. No engine or compilation is mocked.
export function installProductObservation(){
 if(location.pathname.endsWith('/preview.html'))return;
 const observation=globalThis.__workerProductTest={telemetry:[],compilations:[]};
 const Channel=MessageChannel;
 globalThis.MessageChannel=new Proxy(Channel,{construct(target,args,newTarget){const channel=Reflect.construct(target,args,newTarget);for(const port of [channel.port1,channel.port2])port.addEventListener('message',event=>{if(event.data?.protocolVersion===1&&typeof event.data.runId==='string')observation.telemetry.push(event.data);});return channel;}});
 const WorkerClass=Worker;
 globalThis.Worker=new Proxy(WorkerClass,{construct(target,args,newTarget){const worker=Reflect.construct(target,args,newTarget);
  if(new URL(String(args[0]),location.href).pathname.endsWith('/compiler.worker.js'))worker.addEventListener('message',event=>{
   const packet=event.data;if(!(packet?.pack instanceof Uint8Array)||!packet.manifest)return;
   const {outputOverlay:ignoredOverlay,...manifest}=packet.manifest;
   const record={requestId:packet.id,manifest:structuredClone(manifest),artifactReceipt:structuredClone(packet.artifactReceipt??packet.receipt??packet.manifest.artifactReceipt),maps:[],sources:{},complete:false};observation.compilations.push(record);
   try{
    const bytes=packet.pack,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decode=new TextDecoder();
    if(view.getUint32(0,true)!==0x43504447||view.getUint32(4,true)!==3)throw Error('Unexpected production PCK format');
    const base=Number(view.getBigUint64(24,true));let cursor=Number(view.getBigUint64(32,true));const count=view.getUint32(cursor,true);cursor+=4;
    const pending=[];
    for(let index=0;index<count;index++){
     const length=view.getUint32(cursor,true);cursor+=4;const file='res://'+decode.decode(bytes.subarray(cursor,cursor+length)).replace(/\0+$/,'');cursor+=length;
     const offset=base+Number(view.getBigUint64(cursor,true));cursor+=8;const size=Number(view.getBigUint64(cursor,true));cursor+=28;
     if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>bytes.byteLength)throw Error('Invalid production PCK file range');
     if(file.endsWith('.map')&&file.includes('/src/')){const content=bytes.slice(offset,offset+size);record.maps.push({file,content:decode.decode(content)});}
     if(/^res:\/\/src\/.*\.(?:ts|tsx|js)$/.test(file))record.sources[file]=decode.decode(bytes.subarray(offset,offset+size));
    }
    for(const map of record.maps){const bytes=new TextEncoder().encode(map.content);pending.push(crypto.subtle.digest('SHA-256',bytes).then(hash=>{map.sha256=Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');}));}
    const packCopy=packet.pack.slice();pending.push(crypto.subtle.digest('SHA-256',packCopy).then(hash=>{record.packSha256=Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');}));
    void Promise.all(pending).then(()=>{record.complete=true;},error=>{record.error=String(error);record.complete=true;});
   }catch(error){record.error=String(error);record.complete=true;}
  });
  return worker;
 }});
}

export function assertProductCleanup(receipt,mode='clean'){
 assert(receipt);assert.equal(receipt.mode,mode);assert.deepEqual(receipt.errors,[]);
 for(const [created,closed]of [['workers','terminatedWorkers'],['audioContexts','closedAudioContexts'],['messagePorts','closedMessagePorts'],['glContexts','lostGlContexts'],['mediaTracks','stoppedMediaTracks'],['networkResources','closedNetworkResources']])assert.equal(receipt[created]??0,receipt[closed]??0,created+' must be fully released');
 assert(receipt.workers>0,'The real Worker execution scope must exist');
}

export async function openProductHarness({directory,timeout=180000}={}){
 directory=path.resolve(directory??process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
 const siteBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes),release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
 const candidateId=createHash('sha256').update(siteBytes).digest('hex'),prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
 assert.equal((release.execution??release.engine.execution)?.executionModel,'proxy-pthread','This acceptance requires the formal full-engine Worker candidate');
 const useTls=process.env.PLAYGROUND_TEST_TLS!=='0';if(useTls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned TLS acceptance currently requires Chromium; other browsers use explicit secure loopback');
 const tls=useTls?await createLocalTestTls():undefined,serverOptions={urlPrefix:prefix,publicImmutable:site.publicAssets===true,tls};
 const editor=createStaticServer(directory,serverOptions),preview=createStaticServer(directory,serverOptions),listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
 let browser,context,page;
 try{
  await Promise.all([listen(editor),listen(preview)]);
  const scheme=tls?'https':'http',editorOrigin=scheme+'://127.0.0.1:'+editor.address().port,previewOrigin=scheme+'://127.0.0.1:'+preview.address().port;
  const delivery=await inspectTestSite(editorOrigin+prefix,tls);assert.equal(delivery.status,200);
  const deployment=localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:delivery.headers});
  browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
  context=await browser.newContext({viewport:{width:1536,height:1000}});await context.addInitScript(installProductObservation);page=await context.newPage();page.setDefaultTimeout(timeout);
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
  const inspect=()=>page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect());
  const until=async(fn,label)=>{const end=Date.now()+timeout;while(Date.now()<end){if(pageErrors.length)throw Error(JSON.stringify(pageErrors));const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw Error(label);};
  const observation=()=>page.evaluate(()=>globalThis.__workerProductTest);
  const waitRunning=()=>until(async()=>{const current=await inspect();if(current?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(current.diagnostics));return current?.ready&&current.engine?.state==='running';},'Production Worker did not reach running');
  const stop=async()=>{
   if(!await page.locator('#preview iframe').count())return;
   await waitRunning();await page.locator('#stop').click();await until(async()=>await page.locator('#preview iframe').count()===0,'Preview iframe remained after stop');
   const terminal=(await observation()).telemetry.filter(item=>['fatal','terminated','exited'].includes(item.type)).at(-1);assert.equal(terminal?.type,'exited');assert.equal(terminal.code,0);assertProductCleanup(terminal.cleanup);return terminal;
  };
  await page.goto(editorOrigin+prefix+'?previewOrigin='+encodeURIComponent(previewOrigin+prefix),{waitUntil:'domcontentloaded'});await waitRunning();
  const initial=await inspect();assert.equal(initial.releaseContext.candidateId,candidateId);assert.equal(initial.engine.releaseId,release.id);assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  await stop();
  const importProject=async project=>{
   await stop();await page.locator('#clear-log').click();await page.evaluate(()=>{globalThis.__workerProductTest.telemetry.length=0;globalThis.__workerProductTest.compilations.length=0;});
   await page.locator('#import').setInputFiles({name:'worker-acceptance.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
   await until(async()=>{const current=await inspect();return current?.project?.files?.[project.entry]===project.files[project.entry];},'The authored project was not imported');
  };
  return {directory,site,release,candidateId,browser,context,page,pageErrors,deployment,inspect,until,observation,waitRunning,stop,importProject,report:report=>withAcceptanceContext({...report,deployment},{directory,browser}),close:async()=>{await context.close();await browser.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();}};
 }catch(error){await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();throw error;}
}
