#!/usr/bin/env node
/** Observational performance measurements of an immutable real Playground site.
 * No mocks, acceptance thresholds, warm-up runs, or WASM precompilation precede startup samples. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {options,within} from '../../../scripts/release/web-release-utils.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {launchBrowser} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {siteIdentity} from './site-evidence.mjs';

const demos=Object.freeze(['shader','lights','match3','dungeon']);
const launchArgs=Object.freeze(['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const close=server=>new Promise(resolve=>server.close(resolve));
async function bounded(promise,timeout,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('E_PERFORMANCE_TIMEOUT: '+label)),timeout);})]);}finally{clearTimeout(timer);}}
const summarize=values=>{
 const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;
 if(!n)return{count:0,min:null,max:null,median:null,p95:null};
 return{count:n,min:sorted[0],max:sorted[n-1],median:n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2,p95:sorted[Math.ceil(.95*n)-1]};
};
function integer(value,fallback,name,min,max){const number=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw Error('E_PERFORMANCE_OPTION: '+name);return number;}
async function optionalText(filename){try{return(await readFile(filename,'utf8')).trim();}catch{return null;}}
/** Serialized into each real browser realm. Only WeakRef/WeakMap retain native
 * memories; the observer never changes bytes, imports, memory limits or grow(). */
export function installWasmMemoryObserver(){
 const key='__enginePerformanceWasmMemoryObserver';
 if(globalThis[key]?.version===1)return;
 const namespace=globalThis.WebAssembly,NativeMemory=namespace?.Memory,NativeInstance=namespace?.Instance,NativeWeakRef=globalThis.WeakRef,nativeThen=Promise.prototype.then;
 const now=()=>globalThis.performance?.now?.()??Date.now();
 const entries=[],byMemory=new WeakMap(),seenInstances=new WeakSet(),installed=[],errors=[],originals=[];
 let observedInstances=0,realmCapacityPeakBytes=null;
 const supported=typeof NativeMemory==='function'&&typeof NativeInstance==='function'&&typeof NativeWeakRef==='function';
 const realmId=globalThis.crypto?.randomUUID?.()??('realm-'+Date.now()+'-'+Math.random());
 const note=error=>{if(errors.length<32)errors.push(String(error));};
 function sample(){
  let current=0,live=0;
  const memories=entries.map(entry=>{
   const memory=entry.reference.deref();
   if(memory){
    try{entry.currentCapacityBytes=memory.buffer.byteLength;entry.capacityPeakBytes=Math.max(entry.capacityPeakBytes,entry.currentCapacityBytes);entry.lastObservedAtMs=now();current+=entry.currentCapacityBytes;live++;}
    catch(error){note(error);entry.currentCapacityBytes=null;}
   }else{entry.currentCapacityBytes=null;entry.collectedObservedAtMs??=now();}
   const {reference,...plain}=entry;return{...plain,exportNames:[...entry.exportNames]};
  });
  if(entries.length)realmCapacityPeakBytes=Math.max(realmCapacityPeakBytes??0,current);
  return{version:1,realmId,weakRefsSupported:supported,installedMethods:[...installed],observedInstances,observedMemories:entries.length,liveMemories:live,currentCapacityBytes:entries.length?current:null,wasmMemoryCapacityPeakBytes:realmCapacityPeakBytes,memories,errors:[...errors]};
 }
 function observe(value){
  try{
   const instance=value instanceof NativeInstance?value:value?.instance;
   if(!(instance instanceof NativeInstance)||seenInstances.has(instance))return;
   seenInstances.add(instance);observedInstances++;
   for(const name of Object.keys(instance.exports)){
    const memory=instance.exports[name];if(!(memory instanceof NativeMemory))continue;
    let entry=byMemory.get(memory);
    if(!entry){const capacity=memory.buffer.byteLength;entry={id:realmId+':memory-'+entries.length,reference:new NativeWeakRef(memory),exportNames:new Set(),initialCapacityBytes:capacity,currentCapacityBytes:capacity,capacityPeakBytes:capacity,discoveredAtMs:now(),lastObservedAtMs:now(),collectedObservedAtMs:null};entries.push(entry);byMemory.set(memory,entry);}
    entry.exportNames.add(name);
   }
   sample();
  }catch(error){note(error);}
 }
 if(supported)for(const name of ['instantiate','instantiateStreaming']){
  const descriptor=Object.getOwnPropertyDescriptor(namespace,name);if(typeof descriptor?.value!=='function')continue;
  const wrapper=new Proxy(descriptor.value,{apply(target,self,args){
   // Native errors thrown synchronously propagate unchanged. A fulfillment
   // observer returns the exact native value, and missing rejection handler
   // propagates the exact native rejection reason to the returned Promise.
   const pending=Reflect.apply(target,self,args);
   try{return Reflect.apply(nativeThen,pending,[value=>{observe(value);return value;}]);}
   catch(error){note(error);return pending;}
  }});
  try{Object.defineProperty(namespace,name,{...descriptor,value:wrapper});originals.push({name,descriptor,wrapper});installed.push(name);}catch(error){note(error);}
 }
 const observer={version:1,snapshot:sample,restore(){for(const entry of originals)if(namespace[entry.name]===entry.wrapper)Object.defineProperty(namespace,entry.name,entry.descriptor);}};
 Object.defineProperty(globalThis,key,{value:observer,configurable:true});
}
function startWasmMemorySampling(page,navigationStart){
 const samples=[],frames=new Map();let active=true;
 async function sample(){
  const previews=page.frames().filter(frame=>{try{return new URL(frame.url()).pathname.endsWith('/preview.html');}catch{return false;}}),observations=[];
  for(const frame of previews){
   try{
    const value=await frame.evaluate(()=>globalThis.__enginePerformanceWasmMemoryObserver?.snapshot()??null);
    observations.push({url:frame.url(),observer:value});
    if(value){const previous=frames.get(value.realmId);frames.set(value.realmId,{url:frame.url(),...value,wasmMemoryCapacityPeakBytes:value.observedMemories>0||previous?.observedMemories>0?Math.max(previous?.wasmMemoryCapacityPeakBytes??0,value.wasmMemoryCapacityPeakBytes??0):null});}
   }catch(error){observations.push({url:frame.url(),error:String(error)});}
  }
  samples.push({atMs:performance.now()-navigationStart,frames:observations});
 }
 const pending=(async()=>{while(active){await sample();if(active)await wait(250);}})();
 return{sample,async stop(){active=false;await pending;const recorded=[...frames.values()],observed=recorded.some(frame=>frame.observedMemories>0);return{method:'WeakRef observation of actual exports from native WebAssembly.instantiate/instantiateStreaming, sampled in real preview frames',samplingIntervalMs:250,unit:'bytes',scope:'Maximum observed per-preview-realm sum of live exported WebAssembly.Memory buffer capacities; per-memory peaks and raw frame samples are retained. The tested workbench has one active preview. Capacity includes unused space and is neither resident/physical memory nor renderer RSS. No memory parameters, grow calls, module bytes or imports are changed.',coverage:'Only exported Memory objects from observed asynchronous instantiations; synchronous new WebAssembly.Instance and non-exported/import-only memories are not covered.',wasmMemoryCapacityPeakBytes:observed?Math.max(...recorded.map(frame=>frame.wasmMemoryCapacityPeakBytes??0)):null,observedPreviewRealms:recorded,rawSamples:samples,availability:observed?'observed-exported-memory':'no-exported-memory-observed'};}};
}
export function editorObservation({demoId,settleMs}){
 if(window.top!==window)return;
 const result={demoId,startedAt:performance.now(),readyAt:null,runningAt:null,firstTelemetryAt:null,phases:[],telemetry:[],lastGeneration:null,shutdownRequested:false,error:null};
 globalThis.__enginePerformanceObservation=result;
 let lastState,lastFrames;
 setInterval(()=>{
  try{
   const state=globalThis.__playgroundWorkbench?.inspect();if(!state||state.project?.demoId!==demoId)return;
   const now=performance.now();
   if(state.ready&&result.readyAt===null)result.readyAt=now;
   const phase=state.engine?.state??null;
   if(phase!==lastState){result.phases.push({atMs:now,state:phase});lastState=phase;}
   if(state.diagnostics?.some(entry=>entry.category==='error'))result.error={kind:'diagnostics',diagnostics:state.diagnostics};
   if(phase==='running'&&result.runningAt===null)result.runningAt=now;
   if(phase==='exited'&&!result.shutdownRequested)result.error={kind:result.runningAt===null?'early-exit':'unexpected-exit',atMs:now};
   const event=state.events?.filter(entry=>entry.type==='stats').at(-1);
   if(!event)return;
   const key=String(event.generation)+':'+event.frames;
   if(key===lastFrames)return;lastFrames=key;
   if(result.firstTelemetryAt===null)result.firstTelemetryAt=now;
   result.lastGeneration=event.generation;
   result.telemetry.push({atMs:now,withinMeasurementWindow:result.runningAt!==null&&now>=result.runningAt+settleMs,generation:event.generation,frames:event.frames,fps:event.fps,stats:event.stats});
  }catch(error){result.error={kind:'observation',message:String(error)};}
 },20);
}
function startMemorySampling(context,page,navigationStart){
 const records=[],errors=[];let session,active=true;
 const pending=(async()=>{
  try{session=await context.newCDPSession(page);await session.send('Performance.enable');}
  catch(error){active=false;errors.push(String(error));return;}
  while(active){
   try{const {metrics}=await session.send('Performance.getMetrics');const values=Object.fromEntries(metrics.map(item=>[item.name,item.value]));records.push({atMs:performance.now()-navigationStart,jsHeapUsedBytes:values.JSHeapUsedSize??null,jsHeapTotalBytes:values.JSHeapTotalSize??null,documents:values.Documents??null,nodes:values.Nodes??null});}
   catch(error){errors.push(String(error));break;}
   if(active)await wait(250);
  }
 })();
 return async()=>{active=false;await pending;await session?.detach().catch(()=>{});const heap=records.map(value=>value.jsHeapUsedBytes).filter(Number.isFinite);return{method:'Chromium CDP page-target Performance.getMetrics',samplingIntervalMs:250,scope:'Sampled over navigation, the observation window and shutdown. Page-target JavaScript heap includes the editor and frames sharing that target. This is neither renderer RSS nor WASM linear-memory peak, and can omit separate iframe targets.',sampledPeakJSHeapUsedBytes:heap.length?Math.max(...heap):null,samples:records,errors};};
}
async function runScenario({site,identity,editorOrigin,previewOrigin,demoId,sample,browserName,timeout,settleMs,observeMs}){
 const wallStart=performance.now(),record={demoId,sample,status:'measuring',browser:null,errors:[],consoleErrors:[],consoleMessages:[],httpResponses:[]};
 let browser,context,page,stopMemory,wasmMemorySampler;
 const responses=[];
 try{
  const beforeLaunch=performance.now();browser=await launchBrowser({browser:browserName,headless:true,args:[...launchArgs]});record.browserLaunchMs=performance.now()-beforeLaunch;record.browser={name:browser.browserType().name(),version:browser.version()};
  context=await browser.newContext({viewport:{width:1536,height:1000},deviceScaleFactor:1});
  await context.addInitScript(installWasmMemoryObserver);
  await context.addInitScript(editorObservation,{demoId,settleMs});
  page=await context.newPage();page.setDefaultTimeout(timeout);
  page.on('pageerror',error=>record.errors.push(String(error)));
  page.on('console',message=>{const text=message.text().slice(0,4096);if(message.type()==='error')record.consoleErrors.push(text);record.consoleMessages.push({type:message.type(),text,location:message.location()});if(record.consoleMessages.length>200)record.consoleMessages.shift();});
  page.on('response',response=>{const pending=(async()=>{const request=response.request();if(!/^https?:/.test(request.url()))return;record.httpResponses.push({url:request.url(),status:response.status(),resourceType:request.resourceType(),contentEncoding:await response.headerValue('content-encoding'),contentLength:await response.headerValue('content-length'),timing:request.timing()});})();responses.push(pending);});
  const navigationStart=performance.now();
  if(browserName==='chromium')stopMemory=startMemorySampling(context,page,navigationStart);
  wasmMemorySampler=startWasmMemorySampling(page,navigationStart);
  await page.goto(editorOrigin+'/?project='+encodeURIComponent(demoId)+'&previewOrigin='+encodeURIComponent(previewOrigin),{waitUntil:'domcontentloaded'});
  await page.waitForFunction(({demoId,settleMs,observeMs})=>{
   const observed=globalThis.__enginePerformanceObservation,state=globalThis.__playgroundWorkbench?.inspect();
   if(observed?.error)throw Error(JSON.stringify(observed.error));
   if(!observed||state?.project?.demoId!==demoId||state.engine?.state!=='running'||observed.runningAt===null)return false;
   const events=observed.telemetry.filter(entry=>entry.withinMeasurementWindow);
   return performance.now()-observed.runningAt>=settleMs+observeMs&&events.length>=3&&events.at(-1).frames>20;
  },{demoId,settleMs,observeMs},{timeout});
  assert.equal(await page.locator('#preview iframe').count(),1,'Expected one real preview for memory capacity accounting');
  const state=await page.evaluate(()=>globalThis.__playgroundWorkbench.inspect());
  const observed=await page.evaluate(()=>globalThis.__enginePerformanceObservation);
  assert.equal(state.project.demoId,demoId);assert.equal(state.project.runtime,'react');assert.equal(state.engineProfile,identity.profile);assert.equal(state.engine.releaseId,identity.releaseId);assert.equal(state.releaseContext.engineReleaseId,identity.releaseId);assert.equal(state.releaseContext.descriptorHash,identity.descriptorHash);assert.equal(state.releaseContext.candidateId,identity.candidateId);assert.deepEqual(record.errors,[]);
  record.observation=observed;record.releaseContext=state.releaseContext;
  record.project={runtime:state.project.runtime,engineProfile:state.project.engineProfile,mode:state.project.mode,controls:state.project.controls,files:Object.fromEntries(Object.entries(state.project.files).map(([name,value])=>[name,sha(typeof value==='string'?value:Buffer.from(value))]))};
  record.navigationToReadyMs=observed.readyAt;record.navigationToRunningMs=observed.runningAt;record.navigationToFirstTelemetryMs=observed.firstTelemetryAt;
  record.fps=summarize(observed.telemetry.filter(entry=>entry.withinMeasurementWindow).map(entry=>entry.fps));assert(record.fps.count>=3,'Expected real finite telemetry FPS samples');
  record.navigation=await page.evaluate(()=>performance.getEntriesByType('navigation').map(entry=>entry.toJSON()));
  const iframe=page.frames().find(frame=>new URL(frame.url()||'about:blank').origin===previewOrigin);
  record.graphics=iframe?await iframe.evaluate(()=>{const canvas=document.querySelector('canvas');const gl=canvas?.getContext('webgl2');if(!gl)return null;const extension=gl.getExtension('WEBGL_debug_renderer_info');return{version:gl.getParameter(gl.VERSION),vendor:extension?gl.getParameter(extension.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};}).catch(error=>({error:String(error)})):null;
  await wasmMemorySampler.sample();
  // Shutdown is observed after the timed window, never used to warm another sample.
  const beforeStop=performance.now();await page.evaluate(()=>{globalThis.__enginePerformanceObservation.shutdownRequested=true;});await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});record.stopMs=performance.now()-beforeStop;assert.deepEqual(record.errors,[]);
  record.status='measured';
 }catch(error){
  record.status='failed';record.error=String(error.stack??error);
  record.frameUrls=page?.frames().map(frame=>frame.url())??[];
  try{
   const diagnostic=await bounded(page?.evaluate(()=>({state:globalThis.__playgroundWorkbench?.inspect()??null,observation:globalThis.__enginePerformanceObservation??null,status:document.querySelector('#status')?.textContent?.slice(0,4096)??null,logs:document.querySelector('#logs')?.textContent?.slice(-32768)??null,url:location.href})),3000,'failure diagnostic snapshot');
   record.finalState=diagnostic?.state??null;record.observation=diagnostic?.observation??null;record.failureDiagnostic=diagnostic??null;
  }catch(diagnosticError){record.diagnosticError=String(diagnosticError);}
  throw Object.assign(error,{performanceSample:record});
 }
 finally{
  if(wasmMemorySampler){record.wasmMemoryObservation=await wasmMemorySampler.stop();record.wasmMemoryCapacityPeakBytes=record.wasmMemoryObservation.wasmMemoryCapacityPeakBytes;}
  if(stopMemory)record.memory=await stopMemory();else record.memory={method:null,sampledPeakJSHeapUsedBytes:null,scope:'No supported Chromium CDP page-target memory metrics for this browser.'};
  await Promise.allSettled(responses);await context?.close();await browser?.close();record.wallClockMs=performance.now()-wallStart;
 }
 return record;
}
async function runCompileSample({editorOrigin,browserName,asset,wasmSha256,timeout,sample}){
 let browser,context;const record={sample,status:'measuring'};
 try{
  browser=await launchBrowser({browser:browserName,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(timeout);await page.goto(editorOrigin+'/__engine_performance_probe.html');
  Object.assign(record,await bounded(page.evaluate(async({asset,expected})=>{
   const start=performance.now(),response=await fetch('/'+asset.path,{cache:'no-cache',credentials:'same-origin'});if(!response.ok)throw Error('E_PERFORMANCE_FETCH '+response.status);let bytes=new Uint8Array(await response.arrayBuffer());const fetchedAt=performance.now();
   if(asset.encoding==='gzip')bytes=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');if(hash!==expected)throw Error('E_PERFORMANCE_WASM_HASH');
   const before=performance.now(),module=await WebAssembly.compile(bytes),after=performance.now();
   return{fetchAndHTTPDecodeMs:fetchedAt-start,decodeAndHashMs:before-fetchedAt,compileMs:after-before,wasmSha256:hash,wasmBytes:bytes.byteLength,imports:WebAssembly.Module.imports(module).length,exports:WebAssembly.Module.exports(module).length,httpContentEncoding:response.headers.get('content-encoding')};
  },{asset,expected:wasmSha256}),timeout,'isolated WebAssembly.compile'));record.browser={name:browser.browserType().name(),version:browser.version()};record.status='measured';
 }catch(error){record.status='failed';record.error=String(error.stack??error);throw Object.assign(error,{compileSample:record});}
 finally{await context?.close();await browser?.close();}
 return record;
}
export async function measureEnginePerformance(configuration){
 if(!configuration.site||!configuration.out)throw Error('E_PERFORMANCE_OPTION: --site and --out are required');
 const site=path.resolve(configuration.site),out=path.resolve(configuration.out);if(out===site||out.startsWith(site+path.sep))throw Error('E_PERFORMANCE_OUTPUT: Report must be outside the immutable site');
 const samples=integer(configuration.samples,3,'samples',1,100),settleMs=integer(configuration['settle-ms'],1000,'settle-ms',0,60000),observeMs=integer(configuration['observe-ms'],3000,'observe-ms',250,120000),timeout=integer(configuration['timeout-ms'],180000,'timeout-ms',1000,600000),browserName=configuration.browser??'chromium';
 if(!['chromium','firefox','webkit'].includes(browserName))throw Error('E_PERFORMANCE_BROWSER');
 const releaseBytes=await readFile(path.join(site,'engine-release.json')),release=JSON.parse(releaseBytes),siteManifest=JSON.parse(await readFile(path.join(site,'manifest.json'),'utf8'));assert.equal(typeof release.runtimeProfile,'string');getEngineProfile(release.runtimeProfile);
 const catalog=JSON.parse(await readFile(path.join(site,'catalog.json'),'utf8'));for(const id of demos)assert(catalog.some(demo=>demo.id===id),'Missing shared demo '+id);
 const completeIdentity=await siteIdentity(site),{payloads,...identity}=completeIdentity;
 const asset=release.engine.wasm,stored=await readFile(within(site,asset.path));assert.equal(sha(stored),asset.sha256);assert.equal(stored.length,asset.bytes);assert(stored.length<=128*1024*1024);assert(asset.encoding===undefined||asset.encoding==='gzip');const wasm=asset.encoding==='gzip'?gunzipSync(stored,{maxOutputLength:128*1024*1024}):stored,wasmSha256=sha(wasm);assert.equal(wasmSha256,asset.decodedSha256??asset.sha256);assert(WebAssembly.validate(wasm));
 const editorHandler=createStaticServer(site),editor=createServer((req,res)=>{if(new URL(req.url,'http://localhost').pathname==='/__engine_performance_probe.html'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end('<!doctype html><title>Isolated WebAssembly compile sample</title>');return;}editorHandler.emit('request',req,res);}),preview=createStaticServer(site);
 const report={schemaVersion:1,kind:'godotjs-browser-engine-performance',status:'measuring',startedAt:new Date().toISOString(),site,identity,engine:{profile:release.runtimeProfile,releaseId:release.id,descriptorHash:sha(releaseBytes),wasmSha256,wasmBytes:wasm.length,templateTarget:siteManifest.engineTarget??release.build?.engineTarget??release.build?.target??null,recipeSha256:release.build?.recipeSha256??null,reportedSourceCertified:release.build?.sourceCertified===true,buildReportSha256:release.build?.engineReportSha256??null,templateSha256:release.build?.engineTemplateSha256??null,source:release.build?.engineSource?{commit:release.build.engineSource.commit,snapshotHash:release.build.engineSource.snapshotHash}:null,godotSource:release.build?.godotSource?{commit:release.build.godotSource.commit,snapshotHash:release.build.godotSource.snapshotHash}:null,abi:{api:release.api?.version,binding:release.api?.bindingVersion,naming:release.api?.bindingNaming,sdk:release.sdk?.version,runtimeFamily:release.runtimeFamily}},parameters:{samplesPerDemo:samples,demos,settleMs,observeMs,timeoutMs:timeout,browser:browserName,headless:process.env.BROWSER_HEADLESS!=='0',viewport:{width:1536,height:1000},deviceScaleFactor:1,launchArgs:browserName==='chromium'?[...launchArgs]:[],browserCache:'A new browser process and empty context per demo/sample; no startup warm-up.',serverCache:'The same Node static servers remain running; file bodies are read through fs/OS, and OS filesystem caches are not flushed.',telemetry:'FPS is the actual application stats event value based on its process delta; raw events and timestamps are retained.',pollResolutionMs:20,percentile:'Nearest-rank p95; an even-count median is the average of the middle two values.',wasmMemoryObserver:'Proxy forwarding of native async instantiation; fulfillment values and rejection reasons preserved, WeakRef-only exported Memory observation in preview frames at 250 ms plus a final sample before stop. Logical capacity, not physical memory.',compileOrder:'Separate fresh browser processes after all UI startup samples; fetch/decode/hash excluded from WebAssembly.compile duration.',thresholds:'No acceptance thresholds or pass/fail performance budget evaluated.'},hardware:{platform:process.platform,arch:process.arch,node:process.version,kernel:os.release(),cpuModels:[...new Set(os.cpus().map(cpu=>cpu.model))],logicalCPUs:os.cpus().length,availableParallelism:os.availableParallelism(),totalMemoryBytes:os.totalmem(),cgroupCpuMax:await optionalText('/sys/fs/cgroup/cpu.max'),cgroupMemoryMax:await optionalText('/sys/fs/cgroup/memory.max'),loadAverageStart:os.loadavg()},scenarios:[],compileSamples:[]};
 try{
  await Promise.all([listen(editor),listen(preview)]);const editorOrigin='http://127.0.0.1:'+editor.address().port,previewOrigin='http://127.0.0.1:'+preview.address().port;report.origins={editor:editorOrigin,preview:previewOrigin};
  for(let sample=1;sample<=samples;sample++)for(let offset=0;offset<demos.length;offset++){
   const demoId=demos[(offset+sample-1)%demos.length];console.error(`[performance] ${release.runtimeProfile} ${demoId} cold sample ${sample}/${samples}`);
   try{report.scenarios.push(await runScenario({site,identity,editorOrigin,previewOrigin,demoId,sample,browserName,timeout,settleMs,observeMs}));}catch(error){if(error.performanceSample)report.scenarios.push(error.performanceSample);throw error;}
  }
  for(let sample=1;sample<=samples;sample++){console.error(`[performance] isolated WebAssembly.compile sample ${sample}/${samples}`);try{report.compileSamples.push(await runCompileSample({editorOrigin,browserName,asset,wasmSha256,timeout,sample}));}catch(error){if(error.compileSample)report.compileSamples.push(error.compileSample);throw error;}}
  const after=await siteIdentity(site);for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])assert.equal(after[key],identity[key],'Candidate changed during measurement: '+key);
  report.summary={demos:Object.fromEntries(demos.map(demoId=>{const entries=report.scenarios.filter(sample=>sample.demoId===demoId);return[demoId,{navigationToReadyMs:summarize(entries.map(sample=>sample.navigationToReadyMs)),navigationToRunningMs:summarize(entries.map(sample=>sample.navigationToRunningMs)),navigationToFirstTelemetryMs:summarize(entries.map(sample=>sample.navigationToFirstTelemetryMs)),perSampleMedianTelemetryFPS:summarize(entries.map(sample=>sample.fps.median)),sampledPageTargetJSHeapPeakBytes:summarize(entries.map(sample=>sample.memory?.sampledPeakJSHeapUsedBytes)),wasmMemoryCapacityPeakBytes:summarize(entries.map(sample=>sample.wasmMemoryCapacityPeakBytes)),stopMs:summarize(entries.map(sample=>sample.stopMs))}];})),isolatedWebAssemblyCompileMs:summarize(report.compileSamples.map(sample=>sample.compileMs))};
  report.status='completed';
 }catch(error){report.status='failed';report.error=String(error.stack??error);throw Object.assign(error,{performanceReport:report});}
 finally{report.finishedAt=new Date().toISOString();report.hardware.loadAverageEnd=os.loadavg();await Promise.all([close(editor),close(preview)]);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const configuration=options(process.argv.slice(2),['--help']);if(configuration.help){console.log('node apps/playground/scripts/browser-engine-performance.mjs --site DIR --out JSON [--samples 3] [--browser chromium] [--settle-ms 1000] [--observe-ms 3000] [--timeout-ms 180000]');}else{const report=await measureEnginePerformance(configuration);console.log(JSON.stringify({status:report.status,profile:report.engine.profile,scenarios:report.scenarios.length,compileSamples:report.compileSamples.length,out:path.resolve(configuration.out),summary:report.summary},null,2));}}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
