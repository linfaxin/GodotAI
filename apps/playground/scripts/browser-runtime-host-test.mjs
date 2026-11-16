import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {sessionExitReason} from '@godot-js/engine/session-facts';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';

// Product acceptance: authored Schema 4 input, production compiler, actual
// verified native engine and original runner/ports. Observation never changes
// messages or handlers, and the command enters through the existing UI bridge.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const siteBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes);
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const execution=release.execution??release.engine?.execution;
const backend=execution?.executionModel==='proxy-pthread'?'proxy-pthread':'dedicated-worker';
assert(backend==='proxy-pthread'||site.runtime?.executionBackend==='worker','RuntimeHost acceptance requires a real Worker product');
const candidateId=createHash('sha256').update(siteBytes).digest('hex');
const prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
const timeout=Number(process.env.PLAYGROUND_RUNTIME_HOST_TIMEOUT??180000);
assert(Number.isSafeInteger(timeout)&&timeout>0);
const useTls=execution?.requiresCrossOriginIsolation===true&&process.env.PLAYGROUND_TEST_TLS!=='0';
if(useTls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned local TLS acceptance currently requires Chromium');
const tls=useTls?await createLocalTestTls():undefined;
const serverOptions={urlPrefix:prefix,publicImmutable:site.publicAssets===true,tls};
const editor=createStaticServer(directory,serverOptions),preview=createStaticServer(directory,serverOptions);
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const close=server=>new Promise((resolve,reject)=>{if(!server.listening)return resolve();server.close(error=>error?reject(error):resolve());});
let browser,context,page,deployment;
const pageErrors=[],checks=[],cases=[];
const sourceObservations=[];
let sourceObservationOverflow=0;
let report={status:'failed',scope:'actual-product-runtime-host',backend,checks,cases};

function observeRuntimeHostMessages(){
 if(location.pathname.endsWith('/preview.html'))return;
 const observation=globalThis.__runtimeHostAcceptance={messages:[],terminals:[]};
 const Original=MessageChannel;
 globalThis.MessageChannel=new Proxy(Original,{construct(target,args,newTarget){
  const channel=Reflect.construct(target,args,newTarget);
  for(const port of [channel.port1,channel.port2])port.addEventListener('message',event=>{
   const packet=event.data;
   if(!packet||![1,2].includes(packet.protocolVersion)||typeof packet.runId!=='string')return;
   if(observation.messages.length<4096)observation.messages.push(packet);
   if(['exit-report','fatal','exited','terminated'].includes(packet.type))observation.terminals.push(packet);
  });
  return channel;
 }});
}

function observeRuntimeSources(){
 if(!location.pathname.endsWith('/preview.html')||typeof Worker!=='function')return;
 const Original=Worker,documentId=crypto.randomUUID();let workerSerial=0;
 globalThis.Worker=new Proxy(Original,{construct(target,args,newTarget){
  const worker=Reflect.construct(target,args,newTarget),observerWorkerId=++workerSerial;
  worker.addEventListener('message',event=>{
   const packet=event.data;
   if(packet?.__godotjsRuntime!==2||!['role','epoch','summary'].includes(packet.type))return;
   // The native session consumes these control packets with a capture listener.
   // Register first in the same phase, observe only, and preserve the packet.
   void globalThis.__recordRuntimeHostSource({documentId,observerWorkerId,previewUrl:location.href,packet}).catch(()=>{});
  },true);
  return worker;
 }});
}

function runtimeSourceEvidence(){
 const sources=new Map();
 for(const observation of sourceObservations){
  const {packet}=observation,key=observation.documentId+':'+observation.observerWorkerId+':'+packet.sessionId;
  let source=sources.get(key);
  if(!source){source={documentId:observation.documentId,observerWorkerId:observation.observerWorkerId,sessionId:packet.sessionId,workerId:packet.workerId,role:packet.role,epochs:new Map()};sources.set(key,source);}
  if(packet.type==='role')source.role=packet.role;
  const epoch=packet.data?.epoch;if(typeof epoch!=='string')continue;
  let record=source.epochs.get(epoch);if(!record){record={epoch,began:false,summaries:[]};source.epochs.set(epoch,record);}
  if(packet.type==='epoch')record.began=true;
  if(packet.type==='summary')record.summaries.push(packet.data);
 }
 return {scope:'passive-preview-worker-role-epoch-summary',overflow:sourceObservationOverflow,
  sources:[...sources.values()].map(source=>({...source,epochs:[...source.epochs.values()]})),observations:sourceObservations};
}

async function nativeSourceSeals(runId){
 if(backend!=='proxy-pthread')return;
 return until(()=>{
  const sources=runtimeSourceEvidence().sources.filter(source=>source.sessionId===runId&&['engine','script-worker'].includes(source.role));
  return sources.some(source=>source.role==='engine')&&sources.every(source=>source.epochs.length>0&&source.epochs.every(epoch=>
   epoch.began&&epoch.summaries.some(summary=>summary.sealed===true&&!summary.overflow)))?sources:undefined;
 },'The actual native sources did not seal their epochs for '+runId);
}

const program=marker=>`import {Node,Label,Vector2} from 'godot';
export function start(ctx:any){
 const host=ctx.host;
 if(!host||host.apiVersion!==1||host.role!=='engine'||typeof host.sessionId!=='string')throw Error('RUNTIME_HOST_CONTRACT_MISSING');
 const scope=globalThis as any;
 if(typeof scope.WorkerGlobalScope!=='function'||!(scope instanceof scope.WorkerGlobalScope))throw Error('RUNTIME_HOST_WRONG_REALM');
 const label=new Label();label.text=${JSON.stringify(marker)};label.position=new Vector2(8,12);ctx.mount.add_child(label);
 if(label.text!==${JSON.stringify(marker)}||label.position.x!==8)throw Error('RUNTIME_HOST_NATIVE_READBACK_FAILED');
 let commands=0;
 const obsolete=host.bindProjectCommand(()=>{throw Error('RUNTIME_HOST_OLD_BINDING_RAN');});
 const dispose=host.bindProjectCommand((command:any)=>{
  if(command.type!=='benchmark-input')return;
  commands++;
  if(host.emitProjectEvent({type:'runtime-host-command',marker:${JSON.stringify(marker)},sessionId:host.sessionId,commands,enabled:command.enabled,nativeText:label.text})!==true)throw Error('RUNTIME_HOST_COMMAND_EVENT_REJECTED');
  return Promise.resolve().then(()=>{if(host.emitProjectEvent({type:'runtime-host-command-async',marker:${JSON.stringify(marker)},sessionId:host.sessionId,commands})!==true)throw Error('RUNTIME_HOST_ASYNC_EVENT_REJECTED');});
 });
 obsolete();
 const values=Array.from({length:25000},(_,index)=>index%10);
 if(host.emitProjectEvent({type:'runtime-host-array',marker:${JSON.stringify(marker)},sessionId:host.sessionId,values})!==true)throw Error('RUNTIME_HOST_ARRAY_EVENT_REJECTED');
 if(host.emitProjectEvent({type:'runtime-host-ready',marker:${JSON.stringify(marker)},sessionId:host.sessionId,role:host.role,apiVersion:host.apiVersion,nativeText:label.text})!==true)throw Error('RUNTIME_HOST_START_EVENT_REJECTED');
 return ()=>{
  dispose();
  if(host.emitProjectEvent({type:'runtime-host-after-close',marker:${JSON.stringify(marker)}})!==false)throw Error('RUNTIME_HOST_CLOSED_ENTRY_STILL_ACTIVE');
 };
}
`;
const failureProgram=`export async function start(ctx:any){
 if(!ctx.host||ctx.host.apiVersion!==1)throw Error('RUNTIME_HOST_CONTRACT_MISSING');
 await Promise.resolve();
 throw Error('RUNTIME_HOST_ASYNC_START_FAILURE');
}
`;
function project(source){return {schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,
 launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{'/src/start.ts':source,
 '/project.godot':'config_version=5\n[application]\nconfig/name="RuntimeHost acceptance"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'},
 editor:{selected:'/src/start.ts',mode:'production'}};}
const inspect=()=>page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect());
const observation=()=>page.evaluate(()=>globalThis.__runtimeHostAcceptance);
// Verify the actual runner subscriber used by the workbench. Raw port packets
// remain independent identity/source evidence and cannot substitute for delivery.
const projectEvents=async()=>(await inspect()).events??[];
async function until(predicate,message){
 process.stderr.write('[RuntimeHost '+backend+'] Awaiting: '+message+'\n');
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(pageErrors.length)throw Error('Unexpected page error: '+JSON.stringify(pageErrors));const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}
 throw Error(message);
}
async function terminalFor(runId){return until(async()=>{
 const entries=(await observation()).terminals.filter(packet=>packet.runId===runId);
 assert(entries.length<=1,'A run must produce exactly one terminal report');return entries[0];
},'No terminal report for '+runId);}
async function stopped(){return until(async()=>{
 const state=await inspect();return state?.engine?.state==='exited'&&await page.locator('#preview iframe').count()===0;
},'The actual preview was not retired');}
async function importDocument(document,entry,source){
 if(await page.locator('#preview iframe').count()){await page.locator('#stop').click();await stopped();}
 await page.locator('#import').setInputFiles({name:'runtime-host.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
 await until(async()=>{const state=await inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.project?.files?.[entry]===source;},'The authored RuntimeHost project was not imported');
}
async function importProject(source){return importDocument(project(source),'/src/start.ts',source);}
async function runReactDemo(){
 const demo=JSON.parse(await fs.readFile(path.join(directory,'examples/shader.project.json'),'utf8')),entry=demo.entry;
 assert.equal(demo.runtime,'react');assert.equal(demo.demoId,'shader');
 const original=demo.files[entry];assert(original.includes('export default withDemo(ShaderLab);'));
 // Keep the shipped shader demo and its resource/input services. This authored
 // component only observes the public root context; it never replaces runtime
 // handlers or messages behind the product's back.
 const source=original.replace('import {EngineNode}', 'import {EngineNode,useRuntimeHost}').replace('export default withDemo(ShaderLab);',`function RuntimeHostObservedShaderLab(){
 const host=useRuntimeHost();
 React.useEffect(()=>{
  if(!host||host.apiVersion!==1||host.role!=='engine')throw Error('RUNTIME_HOST_REACT_CONTEXT_MISSING');
  if(host.emitProjectEvent({type:'runtime-host-ready',marker:'RUNTIME_HOST_REACT_SHADER',sessionId:host.sessionId,role:host.role,apiVersion:host.apiVersion})!==true)throw Error('RUNTIME_HOST_REACT_EVENT_REJECTED');
 },[host]);
 return <ShaderLab/>;
}
export default withDemo(RuntimeHostObservedShaderLab);`);
 demo.files[entry]=source;await importDocument(demo,entry,source);
 const ready=await readyEvent('RUNTIME_HOST_REACT_SHADER');
 const packet=(await observation()).messages.find(item=>item.type==='project'&&item.data?.marker==='RUNTIME_HOST_REACT_SHADER'&&item.data?.sessionId===ready.sessionId);assert(packet);
 const stats=await until(async()=>{const state=await inspect();return state.events.find(item=>item.type==='stats'&&item.state==='running'&&item.stats?.panels===3);},'The actual shader demo did not run native frame callbacks');
 assert.equal(stats.stats.panels,3);
 await page.evaluate(()=>globalThis.__playgroundWorkbench.enableNativeInputBenchmark());
 await until(async()=>{const state=await inspect();return state.events.find(item=>item.type==='benchmark-input-ready');},'The demo services did not receive the command through their scoped Root Context host');
 await page.locator('#stop').click();await stopped();const terminal=await terminalFor(packet.runId),facts=terminal.sessionFacts;
 assert(facts);assert.equal(facts.nativeExit?.code,0);assert.equal(facts.failure,undefined);assert.equal(facts.forcedTerminationIssued,false);assert.equal(facts.hostCleanup,'complete');
 assert(['complete','unconfirmed'].includes(facts.entryCleanup),'Private native release checkpoints must not be misreported as synchronous completion');
 assert.equal(facts.runtimeSummary,'sealed','Logical native disposal must seal the source even while asynchronous entry cleanup remains unconfirmed');
 assert.equal(sessionExitReason(facts),facts.entryCleanup==='complete'?'clean-exit':'cleanup-unconfirmed');
 await nativeSourceSeals(packet.runId);
 cases.push({name:'react-shader-demo-root-context',sessionId:ready.sessionId,runId:packet.runId,panels:stats.stats.panels,terminal});
 checks.push('The shipped React shader demo runs real native panels/resources, receives its scoped Root Context host and demo commands, and stops without a false fatal or fabricated cleanup confirmation');
}
async function readyEvent(marker,excludedSession){return until(async()=>{
 const state=await inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));
 if(state?.engine?.state!=='running')return;
 return (await projectEvents()).find(event=>event?.type==='runtime-host-ready'&&event.marker===marker&&event.sessionId!==excludedSession);
},'The real project did not emit its RuntimeHost ready event');}
async function roundtrip(marker,ready){
 assert.equal(ready.role,'engine');assert.equal(ready.apiVersion,1);assert.equal(ready.nativeText,marker);
 const array=await until(async()=>(await projectEvents()).find(event=>event?.type==='runtime-host-array'&&event.sessionId===ready.sessionId&&event.marker===marker),'The 25k integer array did not reach the actual workbench subscriber');
 assert.deepEqual(array.values,Array.from({length:25000},(_,index)=>index%10));
 const bytes=Buffer.byteLength(JSON.stringify(array),'utf8');assert(bytes>50000&&bytes<55000,'The ordinary integer array event should occupy about 50 KB of JSON');
 const called=await page.evaluate(()=>{const bridge=globalThis.__playgroundWorkbench;if(typeof bridge.enableNativeInputBenchmark!=='function')return false;bridge.enableNativeInputBenchmark();return true;});
 assert.equal(called,true,'Use the actual workbench → runner.command path');
 const result=await until(async()=>{const events=await projectEvents();const sync=events.find(event=>event?.type==='runtime-host-command'&&event.sessionId===ready.sessionId&&event.marker===marker),async=events.find(event=>event?.type==='runtime-host-command-async'&&event.sessionId===ready.sessionId&&event.marker===marker);return sync&&async?{sync,async}:undefined;},'Project command did not roundtrip through the real host');
 assert.equal(result.sync.commands,1);assert.equal(result.async.commands,1);assert.equal(result.sync.enabled,true);assert.equal(result.sync.nativeText,marker);
 const packets=(await observation()).messages.filter(packet=>packet.type==='project'&&packet.data?.type==='runtime-host-ready'&&packet.data.sessionId===ready.sessionId);
 assert.equal(packets.length,1);return packets[0].runId;
}
async function stopClean(runId){
 await page.locator('#stop').click();await stopped();const terminal=await terminalFor(runId),facts=terminal.sessionFacts;
 assert(facts,'The terminal wire packet must carry SessionFacts');assert.equal(facts.schemaVersion,1);
 assert.equal(facts.nativeExit?.code,0);assert.equal(facts.failure,undefined);assert.equal(facts.forcedTerminationIssued,false);
 assert.equal(facts.runtimeSummary,'sealed');assert.equal(facts.entryCleanup,'complete');assert.equal(facts.hostCleanup,'complete');
 await nativeSourceSeals(runId);
 assert(!((await observation()).messages.some(packet=>packet.runId===runId&&packet.type==='project'&&packet.data?.type==='runtime-host-after-close')));
 return terminal;
}

try{
 await Promise.all([listen(editor),listen(preview)]);
 const scheme=tls?'https':'http',editorOrigin=`${scheme}://127.0.0.1:${editor.address().port}`,previewOrigin=`${scheme}://127.0.0.1:${preview.address().port}`;
 const delivery=await inspectTestSite(editorOrigin+prefix,tls);assert.equal(delivery.status,200);deployment=localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:delivery.headers});
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 context=await browser.newContext({viewport:{width:1536,height:1000}});
 await context.exposeBinding('__recordRuntimeHostSource',(_source,observation)=>{if(sourceObservations.length<16384)sourceObservations.push(observation);else sourceObservationOverflow++;});
 await context.addInitScript(observeRuntimeSources);await context.addInitScript(observeRuntimeHostMessages);
 page=await context.newPage();page.setDefaultTimeout(timeout);page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto(editorOrigin+prefix+'?project=native&benchmarkTimings=1&previewOrigin='+encodeURIComponent(previewOrigin+prefix),{waitUntil:'domcontentloaded'});
 await until(async()=>{const state=await inspect();return state?.ready&&state.engine?.state==='running';},'Initial native product did not start');
 if(execution?.requiresCrossOriginIsolation)assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 await importProject(program('RUNTIME_HOST_FIRST'));
 const first=await readyEvent('RUNTIME_HOST_FIRST'),firstRun=await roundtrip('RUNTIME_HOST_FIRST',first);
 cases.push({name:'normal-host-roundtrip',sessionId:first.sessionId,runId:firstRun,terminal:await stopClean(firstRun)});
 checks.push('Schema4 entry receives a scoped engine host before execution, mutates/readbacks a native Label, delivers an exact 25k integer array of about 50 KB through the actual workbench subscriber, then completes small-event and command roundtrips');
 await page.locator('#run').click();const restarted=await readyEvent('RUNTIME_HOST_FIRST',first.sessionId);
 assert.notEqual(restarted.sessionId,first.sessionId);const restartedRun=await roundtrip('RUNTIME_HOST_FIRST',restarted);
 cases.push({name:'stop-restart',sessionId:restarted.sessionId,runId:restartedRun,terminal:await stopClean(restartedRun)});
 checks.push('Stop reports sealed entry/host cleanup, rejects closed-entry sends and restarts into a fresh session with a fresh command handler');
 const beforeFailure=(await observation()).terminals.length;await importProject(failureProgram);
 const failure=await until(async()=>{const terminals=(await observation()).terminals.slice(beforeFailure);assert(terminals.length<=1,'Async startup failure must settle once');return terminals[0];},'Async startup rejection was not delivered as a terminal failure');
 await stopped();assert(failure.sessionFacts,'Async failure must retain terminal facts');assert.equal(failure.sessionFacts.failure?.kind,'runtime');assert.match(failure.sessionFacts.failure?.message??'',/RUNTIME_HOST_ASYNC_START_FAILURE/);
 assert.equal(failure.sessionFacts.hostCleanup,'complete');assert.notEqual(failure.runId,restartedRun);
 cases.push({name:'async-start-failure',runId:failure.runId,terminal:failure});
 checks.push('Async start rejection reaches the original session as one structured fatal with confirmed host cleanup');
 await importProject(program('RUNTIME_HOST_RECOVERED'));const recovered=await readyEvent('RUNTIME_HOST_RECOVERED'),recoveredRun=await roundtrip('RUNTIME_HOST_RECOVERED',recovered);
 assert(![first.sessionId,restarted.sessionId].includes(recovered.sessionId));assert.notEqual(recoveredRun,failure.runId);
 cases.push({name:'recovery-after-failure',sessionId:recovered.sessionId,runId:recoveredRun,terminal:await stopClean(recoveredRun)});
 checks.push('A new project runs and communicates after failed startup without stale-session contamination');
 await runReactDemo();
 assert.deepEqual(pageErrors,[]);
 assert.equal(sourceObservationOverflow,0,'Native source observation must remain complete');
 report=await withAcceptanceContext({status:'passed',scope:'actual-product-runtime-host',engineExecuted:true,backend,checks,cases,pageErrors,deployment,execution},{directory,browser});
}catch(error){
 report={...report,status:'failed',error:String(error),stack:error?.stack,pageErrors,deployment,checks,cases,
  ...(page?{observed:await inspect().catch(()=>undefined),messages:await observation().catch(()=>undefined),logs:await page.locator('#logs').textContent().catch(()=>undefined)}:{})};
 process.exitCode=1;
}finally{
 report.runtimeSources=runtimeSourceEvidence();
 const output=path.resolve(process.env.PLAYGROUND_RUNTIME_HOST_REPORT??'/tmp/godotai-runtime-host-'+backend+'.json');
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,reportFile:output},null,2));
 await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();
}
