#!/usr/bin/env node
/** Observational performance measurements of an immutable real Playground site.
 * No mocks, acceptance thresholds, warm-up runs, or WASM precompilation precede startup samples. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {options,within} from '../../../scripts/release/web-release-utils.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {launchBrowser,browserLaunchEvidence} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {siteIdentity,canonical,performanceComparisonInputs,assertPerformanceComparable} from './site-evidence.mjs';
import {assessPerformanceBudget,createWorkerRegressionBudget} from './performance-acceptance.mjs';

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
/** Pure observation of the candidate's existing monotonic counters. Sampling
 * cannot recover per-frame capture duration, ACK RTT or on-screen FPS. */
export function summarizeBitmapPresentation(samples,{session,windowStartMs,windowEndMs}={}){
 const result={schemaVersion:1,availability:'unavailable',method:'Differences of actual identity-bound Worker presentation counters sampled through the unchanged Host snapshot',unit:'events/second',window:{startMs:windowStartMs??null,endMs:windowEndMs??null,clock:'Node navigation-relative sampling timestamps; browser telemetry window, approximate alignment at 250ms sampling resolution'},commitHz:null,captureHz:null,ackHz:null,skippedHz:null,captureDurationMs:null,ackRoundTripMs:null,provesOnscreenFPS:false,counterDeltas:{},latencyAvailability:'The runtime exposes cumulative counts only; no capture duration or ACK RTT is inferred.',publicationCadenceCaveat:'Heartbeat publication can repeat counter snapshots between samples. Interval distributions include this quantization and are not per-frame timing distributions.',rawSamples:[],intervalRates:[]};
 if(session?.executionBackend!=='worker'||session?.presentationBackend!=='bitmap'){result.availability='not-applicable';return result;}
 const keys=['runId','documentId','workerId','runConfigurationHash'];
 if(keys.some(key=>typeof session[key]!=='string'||!session[key])||!Number.isFinite(windowStartMs)||!Number.isFinite(windowEndMs)||windowEndMs<=windowStartMs)return result;
 result.identity=Object.fromEntries(keys.map(key=>[key,session[key]]));
 for(const sample of samples??[]){
  if(!Number.isFinite(sample.atMs)||sample.atMs<windowStartMs||sample.atMs>windowEndMs)continue;
  const actual=sample.frames?.map(frame=>frame.worker).find(value=>value?.executionBackend==='worker'&&value.presentationBackend==='bitmap'&&keys.every(key=>value[key]===session[key]));
  const memory=actual?.memory,worker=memory?.presentation;
  if(memory?.schemaVersion!==1||memory.workerId!==session.workerId||memory.realmId!==session.workerId||memory.executionBackend!=='worker'||!worker)continue;
  result.rawSamples.push({atMs:sample.atMs,worker,host:actual.presentationHost??null});
 }
 result.rawSamples.sort((a,b)=>a.atMs-b.atMs);
 const counters={committed:'commitHz',captured:'captureHz',acknowledged:'ackHz',skipped:'skippedHz'};
 for(const [counter,metric]of Object.entries(counters)){
  const values=result.rawSamples.filter(sample=>Number.isSafeInteger(sample.worker[counter])&&sample.worker[counter]>=0);
  if(values.length<2)continue;
  if(values.some((value,index)=>index&&value.worker[counter]<values[index-1].worker[counter])){result.availability='inconsistent-counter';result.reason='A monotonic counter decreased: '+counter;for(const name of Object.values(counters))result[name]=null;return result;}
  const first=values[0],last=values.at(-1),elapsed=last.atMs-first.atMs;
  if(elapsed<=0)continue;
  const countDelta=last.worker[counter]-first.worker[counter];
  result.counterDeltas[counter]={startValue:first.worker[counter],endValue:last.worker[counter],startObservedAtMs:first.atMs,endObservedAtMs:last.atMs,elapsedMs:elapsed,countDelta};
  result[metric]=countDelta*1000/elapsed;
 }
 for(let index=1;index<result.rawSamples.length;index++){
  const before=result.rawSamples[index-1],after=result.rawSamples[index],elapsed=after.atMs-before.atMs;if(elapsed<=0)continue;
  const interval={startMs:before.atMs,endMs:after.atMs};
  for(const [counter,metric]of Object.entries(counters))interval[metric]=[before.worker[counter],after.worker[counter]].every(value=>Number.isSafeInteger(value)&&value>=0)?(after.worker[counter]-before.worker[counter])*1000/elapsed:null;
  result.intervalRates.push(interval);
 }
 result.intervalRateDistributions=Object.fromEntries(Object.values(counters).map(metric=>[metric,summarize(result.intervalRates.map(value=>value[metric]))]));
 result.availability=Number.isFinite(result.captureHz)&&Number.isFinite(result.ackHz)?'observed':'insufficient-counter-samples';
 return result;
}
/** Bounded opt-in timestamps, separate from counter-rate estimates. */
export function summarizeWorkerTimings(session,{windowStartEpochMs,windowEndEpochMs}={}){
 const result={schemaVersion:1,availability:'not-applicable',identity:null,clock:null,scope:'Capture/ACK/Host consumption during the FPS observation window; trusted KeyJ input probe afterward. Native consumption is a real fixture _input callback. No physical input/display claim.',captureDurationMs:null,ackRoundTripMs:null,hostConsumptionLatencyMs:null,hostConsumptionDurationMs:null,inputHostToWorkerMs:null,inputHostToNativeMs:null,inputWorkerDispatchMs:null,inputNativeQueueMs:null,rawFrames:[],rawInputs:[],provesOnscreenPresentation:false};
 if(session?.executionBackend!=='worker')return result;
 result.availability='unavailable';const data=session.memory?.benchmark;
 if(!data||data.schemaVersion!==1||data.mode!=='benchmark')return result;
 const keys=['runId','documentId','workerId','runConfigurationHash'];
 if(keys.some(key=>typeof session[key]!=='string'||!session[key])||!Number.isSafeInteger(data.sampleLimitPerKind)||data.sampleLimitPerKind<1||data.sampleLimitPerKind>4096||!Array.isArray(data.frames)||!Array.isArray(data.inputs)||data.frames.length>data.sampleLimitPerKind||data.inputs.length>data.sampleLimitPerKind)throw Error('E_PERFORMANCE_BENCHMARK_EVIDENCE');
 result.identity=Object.fromEntries(keys.map(key=>[key,session[key]]));result.clock=data.clock;
 const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
 const inputSequences=new Set(),frameIds=new Set();
 for(const row of data.inputs){
  if(!Number.isSafeInteger(row.sequence)||inputSequences.has(row.sequence)||![row.capturedAtMs,row.forwardedAtMs,row.workerReceivedAtMs].every(finite)||row.capturedAtMs>row.forwardedAtMs||row.workerDispatchedAtMs!==null&&(!finite(row.workerDispatchedAtMs)||row.workerDispatchedAtMs<row.workerReceivedAtMs)||row.nativeConsumedAtMs!==null&&(!finite(row.nativeConsumedAtMs)||row.nativeConsumedAtMs<row.workerReceivedAtMs))throw Error('E_PERFORMANCE_INPUT_TIMING');
  inputSequences.add(row.sequence);if(row.trusted===true&&row.code==='KeyJ'&&['keydown','keyup'].includes(row.event))result.rawInputs.push({...row});
 }
 for(const row of data.frames){
  if(!Number.isSafeInteger(row.frameId)||frameIds.has(row.frameId)||![row.captureStartedAtMs,row.captureEndedAtMs].every(finite)||row.captureEndedAtMs<row.captureStartedAtMs||row.ackReceivedAtMs!==null&&(!finite(row.ackReceivedAtMs)||row.ackReceivedAtMs<row.captureEndedAtMs))throw Error('E_PERFORMANCE_FRAME_TIMING');
  frameIds.add(row.frameId);
  if(row.hostConsumedAtMs!==null&&(!finite(row.hostReceivedAtMs)||!finite(row.hostConsumedAtMs)||row.hostConsumedAtMs<row.hostReceivedAtMs||!finite(row.ackReceivedAtMs)||!['consumed','released'].includes(row.hostDisposition)))throw Error('E_PERFORMANCE_HOST_CONSUMPTION_TIMING');
  if(finite(windowStartEpochMs)&&finite(windowEndEpochMs)&&row.captureStartedAtMs>=windowStartEpochMs&&row.captureEndedAtMs<=windowEndEpochMs)result.rawFrames.push({...row});
 }
 const inputs=result.rawInputs,frames=result.rawFrames,consumed=frames.filter(row=>row.hostDisposition==='consumed');
 result.captureDurationMs=summarize(frames.map(row=>row.captureEndedAtMs-row.captureStartedAtMs));
 result.ackRoundTripMs=summarize(frames.filter(row=>row.ackReceivedAtMs!==null).map(row=>row.ackReceivedAtMs-row.captureEndedAtMs));
 // Only same-realm ordering is validated above. Adjacent cross-realm readings
 // can reverse under browser precision reduction; omit those intervals without
 // discarding Native consumption or inventing zero latency.
 const crossRealmConsumed=consumed.filter(row=>row.hostReceivedAtMs>=row.captureEndedAtMs&&row.hostConsumedAtMs<=row.ackReceivedAtMs);
 result.hostConsumptionLatencyMs=summarize(crossRealmConsumed.map(row=>row.hostConsumedAtMs-row.captureEndedAtMs));
 result.hostConsumptionDurationMs=summarize(consumed.map(row=>row.hostConsumedAtMs-row.hostReceivedAtMs));
 result.inputHostToWorkerMs=summarize(inputs.filter(row=>row.workerReceivedAtMs>=row.forwardedAtMs).map(row=>row.workerReceivedAtMs-row.capturedAtMs));
 result.inputWorkerDispatchMs=summarize(inputs.filter(row=>row.workerDispatchedAtMs!==null).map(row=>row.workerDispatchedAtMs-row.workerReceivedAtMs));
 result.inputHostToNativeMs=summarize(inputs.filter(row=>row.nativeConsumedAtMs!==null&&row.nativeConsumedAtMs>=row.forwardedAtMs).map(row=>row.nativeConsumedAtMs-row.capturedAtMs));
 result.inputNativeQueueMs=summarize(inputs.filter(row=>row.nativeConsumedAtMs!==null).map(row=>row.nativeConsumedAtMs-row.workerReceivedAtMs));
 result.availability=result.inputHostToNativeMs.count>=2&&(session.presentationBackend!=='bitmap'||result.ackRoundTripMs.count>0&&result.hostConsumptionLatencyMs.count>0)?'observed':'insufficient-samples';
 result.unavailableCrossRealmIntervals={inputHostToWorker:inputs.length-result.inputHostToWorkerMs.count,inputHostToNative:inputs.filter(row=>row.nativeConsumedAtMs!==null).length-result.inputHostToNativeMs.count,hostConsumptionLatency:consumed.length-crossRealmConsumed.length};
 result.rejectedSamples=data.rejectedSamples;return result;
}
function integer(value,fallback,name,min,max){const number=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw Error('E_PERFORMANCE_OPTION: '+name);return number;}
async function optionalText(filename){try{return(await readFile(filename,'utf8')).trim();}catch{return null;}}
async function performanceHardware(){
 return {platform:process.platform,arch:process.arch,node:process.version,kernel:os.release(),cpuModels:[...new Set(os.cpus().map(cpu=>cpu.model))],logicalCPUs:os.cpus().length,availableParallelism:os.availableParallelism(),totalMemoryBytes:os.totalmem(),cgroupCpuMax:await optionalText('/sys/fs/cgroup/cpu.max'),cgroupMemoryMax:await optionalText('/sys/fs/cgroup/memory.max'),loadAverageStart:os.loadavg()};
}
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
 const samples=[],frames=new Map(),workers=new Map();let active=true;
 async function sample(){
  const previews=page.frames().filter(frame=>{try{return /\/preview(?:\.legacy)?\.html$/.test(new URL(frame.url()).pathname);}catch{return false;}}),observations=[];
  for(const frame of previews){
   try{
    const observation=await frame.evaluate(()=>{const current=globalThis.__playgroundRuntimeSession;return{legacy:globalThis.__enginePerformanceWasmMemoryObserver?.snapshot()??null,session:typeof current==='function'?current():current??null};});
    const value=observation.legacy,session=observation.session,memory=session?.memory;
    observations.push({url:frame.url(),observer:value,worker:session});
    if(value){const previous=frames.get(value.realmId);frames.set(value.realmId,{url:frame.url(),...value,wasmMemoryCapacityPeakBytes:value.observedMemories>0||previous?.observedMemories>0?Math.max(previous?.wasmMemoryCapacityPeakBytes??0,value.wasmMemoryCapacityPeakBytes??0):null});}
    if(memory?.schemaVersion===1&&memory.workerId===session.workerId&&memory.realmId===session.workerId&&memory.executionBackend==='worker'){
     const previous=workers.get(memory.workerId),capacity=memory.wasmMemoryCapacityPeakBytes,heap=memory.jsHeapUsedPeakBytes;
     workers.set(memory.workerId,{url:frame.url(),runId:session.runId,documentId:session.documentId,runConfigurationHash:session.runConfigurationHash,runConfiguration:session.runConfiguration,presentationBackend:session.presentationBackend,...memory,wasmMemoryCapacityPeakBytes:Number.isFinite(capacity)?Math.max(previous?.wasmMemoryCapacityPeakBytes??0,capacity):previous?.wasmMemoryCapacityPeakBytes??null,jsHeapUsedPeakBytes:Number.isFinite(heap)?Math.max(previous?.jsHeapUsedPeakBytes??0,heap):previous?.jsHeapUsedPeakBytes??null});
    }
   }catch(error){observations.push({url:frame.url(),error:String(error)});}
  }
  samples.push({atMs:performance.now()-navigationStart,frames:observations});
 }
 const pending=(async()=>{while(active){await sample();if(active)await wait(250);}})();
 return{sample,async stop(){active=false;await pending;const recorded=[...frames.values()],workerRealms=[...workers.values()],capacities=[...recorded.filter(frame=>frame.observedMemories>0).map(frame=>frame.wasmMemoryCapacityPeakBytes),...workerRealms.map(worker=>worker.wasmMemoryCapacityPeakBytes)].filter(Number.isFinite),heaps=workerRealms.map(worker=>worker.jsHeapUsedPeakBytes).filter(Number.isFinite);return{method:'Legacy async-instantiation WeakRef observation plus actual Worker HEAPU8 buffer capacity reported by the exact candidate runtime',samplingIntervalMs:250,unit:'bytes',scope:'Maximum observed per-realm WASM linear-memory capacity. Worker measurements are collected inside the Worker and bound to its run/document/worker/config identity. Page-target CDP heap remains separate. Capacity is neither resident memory nor renderer RSS.',coverage:'Worker capacity covers the active native HEAPU8/_jsbb_ buffer. Worker JS heap is available only when that realm exposes performance.memory; unavailable values remain null. Legacy observation covers exported asynchronous instantiations only.',wasmMemoryCapacityPeakBytes:capacities.length?Math.max(...capacities):null,workerJSHeapUsedPeakBytes:heaps.length?Math.max(...heaps):null,observedWorkerRealms:workerRealms,observedPreviewRealms:recorded,rawSamples:samples,availability:capacities.length?'observed-native-memory':'no-native-memory-observed'};}};
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
async function runScenario({site,identity,editorOrigin,previewOrigin,demoId,sample,browserName,timeout,settleMs,observeMs,presentationBackend,executionBackend}){
 const wallStart=performance.now(),record={demoId,sample,status:'measuring',browser:null,errors:[],consoleErrors:[],consoleMessages:[],httpResponses:[]};
 let browser,context,page,stopMemory,wasmMemorySampler;
 const responses=[];
 try{
  const beforeLaunch=performance.now();browser=await launchBrowser({browser:browserName,headless:true,args:[...launchArgs]});record.browserLaunchMs=performance.now()-beforeLaunch;record.browser={name:browser.browserType().name(),version:browser.version(),...browserLaunchEvidence(browser)};
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
  await page.goto(editorOrigin+'/?project='+encodeURIComponent(demoId)+'&previewOrigin='+encodeURIComponent(previewOrigin)+'&presentationBackend='+encodeURIComponent(presentationBackend)+'&executionBackend='+encodeURIComponent(executionBackend)+(executionBackend==='worker'?'&benchmarkTimings=1':''),{waitUntil:'domcontentloaded'});
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
  record.runtimeSession=iframe?await iframe.evaluate(()=>{const current=globalThis.__playgroundRuntimeSession;return typeof current==='function'?current():current??null;}):null;
  if(executionBackend==='worker'){assert.equal(record.runtimeSession?.executionBackend,'worker','Measured execution backend must be the actual Worker');assert.equal(record.runtimeSession?.presentationBackend,presentationBackend);}
  else assert.equal(record.runtimeSession,null,'Legacy baseline must execute the explicit legacy preview');
  record.graphics=iframe?await iframe.evaluate(()=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;if(session?.executionBackend==='worker')return session.graphics??null;const canvas=document.querySelector('canvas');const gl=canvas?.getContext('webgl2');if(!gl)return null;const extension=gl.getExtension('WEBGL_debug_renderer_info');return{version:gl.getParameter(gl.VERSION),vendor:extension?gl.getParameter(extension.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};}).catch(error=>({error:String(error)})):null;
  if(executionBackend==='worker'){
   // No warmup: actual input is measured after the fixed FPS window ends.
   await page.evaluate(()=>{const enable=globalThis.__playgroundWorkbench?.enableNativeInputBenchmark;if(typeof enable!=='function')throw Error('E_PERFORMANCE_BENCHMARK_UNSUPPORTED');enable();});
   await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().events.some(event=>event.type==='benchmark-input-ready'),null,{timeout});
   await iframe.locator('canvas').focus();await page.keyboard.press('j');
   await iframe.waitForFunction(()=>{const value=globalThis.__playgroundRuntimeSession,session=typeof value==='function'?value():value;return session?.memory?.benchmark?.inputs.filter(row=>row.trusted&&row.code==='KeyJ'&&row.nativeConsumedAtMs!==null).length>=2;},null,{timeout});
   record.runtimeSession=await iframe.evaluate(()=>{const value=globalThis.__playgroundRuntimeSession;return typeof value==='function'?value():value;});
   const origin=await page.evaluate(()=>performance.timeOrigin),windowEnd=observed.telemetry.filter(row=>row.withinMeasurementWindow).at(-1).atMs;
   record.workerTimings=summarizeWorkerTimings(record.runtimeSession,{windowStartEpochMs:origin+observed.runningAt+settleMs,windowEndEpochMs:origin+windowEnd});
   assert.equal(record.workerTimings.availability,'observed','Timing requires actual Native input and presentation receipts');
  }else{await iframe.locator('canvas').focus();await page.keyboard.press('j');}
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
  if(wasmMemorySampler){
   record.wasmMemoryObservation=await wasmMemorySampler.stop();record.wasmMemoryCapacityPeakBytes=record.wasmMemoryObservation.wasmMemoryCapacityPeakBytes;record.workerJSHeapUsedPeakBytes=record.wasmMemoryObservation.workerJSHeapUsedPeakBytes;
   const telemetry=record.observation?.telemetry?.filter(value=>value.withinMeasurementWindow)??[];
   record.bitmapPresentation=summarizeBitmapPresentation(record.wasmMemoryObservation.rawSamples,{session:record.runtimeSession,windowStartMs:Number.isFinite(record.observation?.runningAt)?record.observation.runningAt+settleMs:null,windowEndMs:telemetry.at(-1)?.atMs});
  }
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
 const presentationBackend=configuration['presentation-backend']??'direct';if(!['direct','bitmap'].includes(presentationBackend))throw Error('E_PERFORMANCE_PRESENTATION');
 let budget=configuration.budget?JSON.parse(await readFile(path.resolve(configuration.budget),'utf8')):undefined;
 const executionBackend=configuration.execution??'worker';if(!['legacy','worker'].includes(executionBackend))throw Error('E_PERFORMANCE_EXECUTION');
 const releaseBytes=await readFile(path.join(site,'engine-release.json')),release=JSON.parse(releaseBytes),siteManifest=JSON.parse(await readFile(path.join(site,'manifest.json'),'utf8'));assert.equal(typeof release.runtimeProfile,'string');getEngineProfile(release.runtimeProfile);
 if(executionBackend==='legacy'){
  let html;try{html=await readFile(path.join(site,'preview.legacy.html'),'utf8');}catch{throw Error('E_PERFORMANCE_LEGACY_SITE: supply a frozen external legacy baseline site; the product no longer ships a legacy entry');}
  if(!html.includes('./preview.legacy.js'))throw Error('E_PERFORMANCE_LEGACY_SITE');
 }
 const catalog=JSON.parse(await readFile(path.join(site,'catalog.json'),'utf8'));for(const id of demos)assert(catalog.some(demo=>demo.id===id),'Missing shared demo '+id);
 const completeIdentity=await siteIdentity(site),{payloads,...identity}=completeIdentity;
 const producer={schemaVersion:1,kind:'worker-performance-tool',sources:{}};
 for(const name of ['browser-engine-performance.mjs','performance-acceptance.mjs','browser-harness.mjs','site-evidence.mjs'])producer.sources['apps/playground/scripts/'+name]=sha(await readFile(new URL('./'+name,import.meta.url)));
 const hardware=await performanceHardware(),comparisonInputs=await performanceComparisonInputs(site,{demos});
 if(configuration.baseline){
  if(executionBackend!=='worker'||configuration.budget||!configuration['write-budget'])throw Error('E_PERFORMANCE_BASELINE: use --execution worker --baseline JSON --write-budget JSON before measuring');
  const bytes=await readFile(path.resolve(configuration.baseline)),baseline=JSON.parse(bytes);
  // The retired entry lives in an independently frozen site. Engine bytes and
  // SDK release must still match; keep each site's actual candidate identity.
  if(baseline.identity?.profile!==identity.profile)throw Error('E_PERFORMANCE_BASELINE_IDENTITY: profile');
  assertPerformanceComparable(baseline.comparisonInputs,comparisonInputs);
  if(baseline.engine?.templateTarget!==siteManifest.engineTarget)throw Error('E_PERFORMANCE_BASELINE_IDENTITY: native target');
  if(canonical(baseline.producer)!==canonical(producer))throw Error('E_PERFORMANCE_BASELINE_PRODUCER: baseline and Worker measurements must use the same frozen tool sources');
  for(const key of ['platform','arch','node','kernel','cpuModels','logicalCPUs','availableParallelism','totalMemoryBytes','cgroupCpuMax','cgroupMemoryMax'])if(canonical(baseline.hardware?.[key])!==canonical(hardware[key]))throw Error('E_PERFORMANCE_BASELINE_HARDWARE: '+key);
  for(const [key,value]of Object.entries({samplesPerDemo:samples,settleMs,observeMs,timeoutMs:timeout,browser:browserName}))if(baseline.parameters?.[key]!==value)throw Error('E_PERFORMANCE_BASELINE_PARAMETERS: '+key);
  if(JSON.stringify(baseline.parameters?.demos)!==JSON.stringify(demos))throw Error('E_PERFORMANCE_BASELINE_PARAMETERS: demos');
  budget=createWorkerRegressionBudget(baseline,{baselineSha256:sha(bytes),presentationBackend});
  const budgetFile=path.resolve(configuration['write-budget']);if(budgetFile===site||budgetFile.startsWith(site+path.sep))throw Error('E_PERFORMANCE_BUDGET_OUTPUT');
  const budgetBytes=JSON.stringify(budget,null,2)+'\n';await mkdir(path.dirname(budgetFile),{recursive:true});
  try{await writeFile(budgetFile,budgetBytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||await readFile(budgetFile,'utf8')!==budgetBytes)throw error;}
 }else if(configuration['write-budget'])throw Error('E_PERFORMANCE_BASELINE: --write-budget requires --baseline');
 const asset=release.engine.wasm,stored=await readFile(within(site,asset.path));assert.equal(sha(stored),asset.sha256);assert.equal(stored.length,asset.bytes);assert(stored.length<=128*1024*1024);assert(asset.encoding===undefined||asset.encoding==='gzip');const wasm=asset.encoding==='gzip'?gunzipSync(stored,{maxOutputLength:128*1024*1024}):stored,wasmSha256=sha(wasm);assert.equal(wasmSha256,asset.decodedSha256??asset.sha256);assert(WebAssembly.validate(wasm));
 const editorHandler=createStaticServer(site),editor=createServer((req,res)=>{if(new URL(req.url,'http://localhost').pathname==='/__engine_performance_probe.html'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end('<!doctype html><title>Isolated WebAssembly compile sample</title>');return;}editorHandler.emit('request',req,res);}),preview=createStaticServer(site);
 const report={schemaVersion:2,measurementBatchId:randomUUID(),kind:'godotjs-browser-engine-performance',status:'measuring',startedAt:new Date().toISOString(),site,identity,engine:{profile:release.runtimeProfile,releaseId:release.id,descriptorHash:sha(releaseBytes),wasmSha256,wasmBytes:wasm.length,templateTarget:siteManifest.engineTarget??release.build?.engineTarget??release.build?.target??null,recipeSha256:release.build?.recipeSha256??null,reportedSourceCertified:release.build?.sourceCertified===true,buildReportSha256:release.build?.engineReportSha256??null,templateSha256:release.build?.engineTemplateSha256??null,source:release.build?.engineSource?{commit:release.build.engineSource.commit,snapshotHash:release.build.engineSource.snapshotHash}:null,godotSource:release.build?.godotSource?{commit:release.build.godotSource.commit,snapshotHash:release.build.godotSource.snapshotHash}:null,abi:{api:release.api?.version,binding:release.api?.bindingVersion,naming:release.api?.bindingNaming,sdk:release.sdk?.version,runtimeFamily:release.runtimeFamily}},parameters:{samplesPerDemo:samples,demos,settleMs,observeMs,timeoutMs:timeout,browser:browserName,headless:process.env.BROWSER_HEADLESS!=='0',viewport:{width:1536,height:1000},deviceScaleFactor:1,launchArgs:browserName==='chromium'?[...launchArgs]:[],browserCache:'A new browser process and empty context per demo/sample; no startup warm-up.',serverCache:'The same Node static servers remain running; file bodies are read through fs/OS, and OS filesystem caches are not flushed.',telemetry:'FPS is the actual application stats event value based on its process delta; raw events and timestamps are retained.',benchmarkTiming:'Bounded opt-in Worker timing. Both backends focus the canvas and press KeyJ after the fixed observation window; actual Native _input timing is collected only in Worker mode.',pollResolutionMs:20,percentile:'Nearest-rank p95; an even-count median is the average of the middle two values.',wasmMemoryObserver:'Actual Worker memory snapshots identified by run/document/worker/config plus legacy WeakRef observation. Logical capacity, not physical memory; page-target heap is separate.',compileOrder:'Separate fresh browser processes after all UI startup samples; fetch/decode/hash excluded from WebAssembly.compile duration.',thresholds:budget?{budgetId:budget.id}: 'No versioned performance budget supplied; acceptance remains not-evaluated.'},hardware,scenarios:[],compileSamples:[]};
 report.comparisonInputs=comparisonInputs;report.producer=producer;report.measurementStatus='measuring';report.performanceAcceptance={status:'not-evaluated',reason:'Measurement is not performance acceptance.'};
 report.measurementScope={profile:release.runtimeProfile,executionBackend,presentationBackend:executionBackend==='worker'?presentationBackend:'legacy',browser:browserName,settingsTier:browserName==='chromium'?'environment-override':'default'};
 try{
  await Promise.all([listen(editor),listen(preview)]);const editorOrigin='http://127.0.0.1:'+editor.address().port,previewOrigin='http://127.0.0.1:'+preview.address().port;report.origins={editor:editorOrigin,preview:previewOrigin};
  for(let sample=1;sample<=samples;sample++)for(let offset=0;offset<demos.length;offset++){
   const demoId=demos[(offset+sample-1)%demos.length];console.error(`[performance] ${release.runtimeProfile} ${demoId} cold sample ${sample}/${samples}`);
   try{report.scenarios.push(await runScenario({site,identity,editorOrigin,previewOrigin,demoId,sample,browserName,timeout,settleMs,observeMs,presentationBackend,executionBackend}));}catch(error){if(error.performanceSample)report.scenarios.push(error.performanceSample);throw error;}
  }
  for(let sample=1;sample<=samples;sample++){console.error(`[performance] isolated WebAssembly.compile sample ${sample}/${samples}`);try{report.compileSamples.push(await runCompileSample({editorOrigin,browserName,asset,wasmSha256,timeout,sample}));}catch(error){if(error.compileSample)report.compileSamples.push(error.compileSample);throw error;}}
  const after=await siteIdentity(site);for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])assert.equal(after[key],identity[key],'Candidate changed during measurement: '+key);
  report.summary={demos:Object.fromEntries(demos.map(demoId=>{const entries=report.scenarios.filter(sample=>sample.demoId===demoId);return[demoId,{navigationToReadyMs:summarize(entries.map(sample=>sample.navigationToReadyMs)),navigationToRunningMs:summarize(entries.map(sample=>sample.navigationToRunningMs)),navigationToFirstTelemetryMs:summarize(entries.map(sample=>sample.navigationToFirstTelemetryMs)),perSampleMedianTelemetryFPS:summarize(entries.map(sample=>sample.fps.median)),perSampleBitmapCaptureHz:summarize(entries.map(sample=>sample.bitmapPresentation?.captureHz)),perSampleBitmapAckHz:summarize(entries.map(sample=>sample.bitmapPresentation?.ackHz)),perSampleBitmapCommitHz:summarize(entries.map(sample=>sample.bitmapPresentation?.commitHz)),perSampleCaptureDurationP95Ms:summarize(entries.map(sample=>sample.workerTimings?.captureDurationMs?.p95)),perSampleAckRoundTripP95Ms:summarize(entries.map(sample=>sample.workerTimings?.ackRoundTripMs?.p95)),perSampleHostConsumptionP95Ms:summarize(entries.map(sample=>sample.workerTimings?.hostConsumptionLatencyMs?.p95)),perSampleInputToWorkerP95Ms:summarize(entries.map(sample=>sample.workerTimings?.inputHostToWorkerMs?.p95)),perSampleInputToNativeP95Ms:summarize(entries.map(sample=>sample.workerTimings?.inputHostToNativeMs?.p95)),sampledPageTargetJSHeapPeakBytes:summarize(entries.map(sample=>sample.memory?.sampledPeakJSHeapUsedBytes)),wasmMemoryCapacityPeakBytes:summarize(entries.map(sample=>sample.wasmMemoryCapacityPeakBytes)),workerJSHeapUsedPeakBytes:summarize(entries.map(sample=>sample.workerJSHeapUsedPeakBytes)),stopMs:summarize(entries.map(sample=>sample.stopMs))}];})),isolatedWebAssemblyCompileMs:summarize(report.compileSamples.map(sample=>sample.compileMs))};
  report.measurementScope.settingsTier=report.scenarios[0]?.browser.settingsTier??report.measurementScope.settingsTier;
  report.parameters.actualLaunchArgs=report.scenarios[0]?.browser.launchArgs??[];
  report.measurementStatus='completed';report.performanceAcceptance=assessPerformanceBudget(report,budget);report.status=report.performanceAcceptance.status==='failed'?'failed':'completed';
 }catch(error){report.status='failed';report.measurementStatus='failed';report.error=String(error.stack??error);throw Object.assign(error,{performanceReport:report});}
 finally{report.finishedAt=new Date().toISOString();report.hardware.loadAverageEnd=os.loadavg();await Promise.all([close(editor),close(preview)]);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const configuration=options(process.argv.slice(2),['--help']);if(configuration.help){console.log('node apps/playground/scripts/browser-engine-performance.mjs --site DIR --out JSON [--samples 3] [--browser chromium] [--settle-ms 1000] [--observe-ms 3000] [--timeout-ms 180000] [--presentation-backend direct|bitmap] [--execution legacy|worker] [--budget JSON | --baseline JSON --write-budget JSON]');}else{const report=await measureEnginePerformance(configuration);if(report.status==='failed')process.exitCode=1;console.log(JSON.stringify({status:report.status,measurementStatus:report.measurementStatus,performanceAcceptance:report.performanceAcceptance,profile:report.engine.profile,scenarios:report.scenarios.length,compileSamples:report.compileSamples.length,out:path.resolve(configuration.out),summary:report.summary},null,2));}}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
