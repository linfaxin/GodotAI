import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sessionExitReason} from '@godot-js/engine/session-facts';
import {installPassiveRecorder,launchBrowser,withAcceptanceContext,observedWorkerSessions,observedWorkerOutcomes} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';
import {runReportedBrowserTest,browserTestFailureStatus,listenBrowserTestServer as listen,closeBrowserTestServer as close} from './browser-contract-report.mjs';

await runReportedBrowserTest({scope:'actual-product-runtime-host',reportFile:report=>process.env.PLAYGROUND_RUNTIME_HOST_REPORT??'/tmp/godotai-runtime-host-'+(report.backend??'preflight')+'.json',run:async test=>{

// Product acceptance: authored Schema 4 input, production compiler, actual
// verified native engine and original runner/ports. Observation never changes
// messages or handlers, and the command enters through the existing UI bridge.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const {site,release,candidateId}=await test.preflight(directory);
const execution=release.execution??release.engine?.execution;
const backend=execution?.executionModel==='proxy-pthread'?'proxy-pthread':'dedicated-worker';
assert(backend==='proxy-pthread'||site.runtime?.executionBackend==='worker','RuntimeHost acceptance requires a real Worker product');
const prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
const timeout=Number(process.env.PLAYGROUND_RUNTIME_HOST_TIMEOUT??180000);
const typedDemoGuard=process.env.PLAYGROUND_TYPED_DEMO_GUARD==='1';
const contractGroup=process.env.PLAYGROUND_CONTRACT_GROUP??'all';
if(!['all','lifecycle','failure-recovery','entry'].includes(contractGroup))throw Error('E_TEST_CONTRACT_GROUP: '+contractGroup);
const demoPackBytes=typedDemoGuard?(await fs.stat(path.join(directory,'demo-resources.pck'))).size:0;
assert(Number.isSafeInteger(timeout)&&timeout>0);
const useTls=execution?.requiresCrossOriginIsolation===true&&process.env.PLAYGROUND_TEST_TLS!=='0';
if(useTls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned local TLS acceptance currently requires Chromium');
const tls=useTls?await createLocalTestTls():undefined;
test.defer(()=>tls?.dispose());
const serverOptions={urlPrefix:prefix,publicImmutable:site.publicAssets===true,tls};
const editor=createStaticServer(directory,serverOptions),preview=createStaticServer(directory,serverOptions);
test.defer(()=>close(editor));test.defer(()=>close(preview));
let browser,context,page,deployment,commandRecorder;
test.defer(()=>browser?.close());test.defer(()=>context?.close());
const pageErrors=[],checks=[],cases=[];
const sourceObservations=[];
const commandTraffic=[],commandRoundtrips=[];
let sourceObservationOverflow=0,commandTrafficOverflow=0;
let report={status:'failed',scope:'actual-product-runtime-host',backend,checks,cases};
test.checkpoint(report);

// Optional allocation regression: the original compiler bundle is imported
// unchanged, but expanding its demo pack to a numeric array is made observable.
function guardDemoArrayExpansion({bytes}){
 if(location.pathname.endsWith('/preview.html'))return;
 const Original=Worker,guard=globalThis.__typedDemoGuard={workers:0,bytes};
 globalThis.Worker=new Proxy(Original,{construct(target,args,newTarget){
  const url=new URL(String(args[0]),location.href);
  if(!url.pathname.endsWith('/compiler.worker.js'))return Reflect.construct(target,args,newTarget);
  guard.workers++;
  const prefix=`const nativeArrayFrom=Array.from;Array.from=function(value,...rest){
   if(value instanceof Uint8Array&&value.byteLength===${bytes})throw Error('E_DEMO_NUMERIC_ARRAY_EXPANSION');
   return Reflect.apply(nativeArrayFrom,this,[value,...rest]);
  };importScripts(${JSON.stringify(url.href)});`;
  const bootstrap=URL.createObjectURL(new Blob([prefix],{type:'text/javascript'}));
  try{
   const worker=Reflect.construct(target,[bootstrap,...args.slice(1)],newTarget);
   const release=()=>URL.revokeObjectURL(bootstrap);
   worker.addEventListener('message',release,{once:true});worker.addEventListener('error',release,{once:true});
   return worker;
  }catch(error){URL.revokeObjectURL(bootstrap);throw error;}
 }});
}

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

function observeProjectCommandTraffic(){
 const scope=location.pathname.endsWith('/preview.html')?'preview-host':'editor';
 function observe(direction,packet){
  if(!packet||![1,2].includes(packet.protocolVersion)||typeof packet.runId!=='string'||
   !['project-command','project-command-receipt'].includes(packet.type))return;
  const {runId,revision,generation,commandSequence,type}=packet;
  void globalThis.__recordRuntimeHostCommand({scope,direction,runId,revision,generation,commandSequence,type,commandType:packet.data?.type});
 }
 const post=MessagePort.prototype.postMessage;
 MessagePort.prototype.postMessage=function(...args){
  const result=Reflect.apply(post,this,args);
  try{observe('sent',args[0]);}catch{/* Observation must not change the delivery result. */}
  return result;
 };
 const watch=port=>port.addEventListener('message',event=>observe('received',event.data));
 const Channel=MessageChannel;
 globalThis.MessageChannel=new Proxy(Channel,{construct(target,args,newTarget){
  const channel=Reflect.construct(target,args,newTarget);watch(channel.port1);watch(channel.port2);return channel;
 }});
 if(scope==='preview-host')addEventListener('message',event=>{for(const port of event.ports)watch(port);});
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
const pendingStartupProgram=`export async function start(ctx:any){
 const host=ctx.host,lifetime=ctx.lifetime;
 if(!host||!lifetime||typeof lifetime.onCancel!=="function")throw Error("RUNTIME_HOST_ENTRY_LIFETIME_MISSING");
 const cancelled=new Promise<void>(resolve=>lifetime.onCancel(()=>{console.log("RUNTIME_HOST_PENDING_CANCELLED");resolve();}));
 if(host.emitProjectEvent({type:"runtime-host-ready",marker:"RUNTIME_HOST_PENDING_STARTUP",sessionId:host.sessionId,role:host.role,apiVersion:host.apiVersion})!==true)throw Error("RUNTIME_HOST_PENDING_EVENT_REJECTED");
 await cancelled;
 if(!lifetime.cancelled)throw Error("RUNTIME_HOST_PENDING_LIFETIME_STILL_OPEN");
 return async()=>{
  console.log("RUNTIME_HOST_LATE_CLEANUP_BEGIN");
  await Promise.resolve().then(()=>Promise.resolve());
  // Entry cleanup must settle before the native mount and epoch are sealed.
  if(!ctx.godot.is_instance_valid(ctx.mount))throw Error("RUNTIME_HOST_LATE_CLEANUP_NATIVE_SEALED");
  if(host.emitProjectEvent({type:"runtime-host-after-close",marker:"RUNTIME_HOST_PENDING_STARTUP"})!==false)throw Error("RUNTIME_HOST_PENDING_CLOSED_ENTRY_ACTIVE");
  console.log("RUNTIME_HOST_LATE_CLEANUP_COMPLETE");
 };
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
async function newReactTemplate(){
 if(await page.locator('#preview iframe').count()){await page.locator('#stop').click();await stopped();}
 const before=await inspect(),messageStart=(await observation()).messages.length;
 if(!await page.locator('#new-react-project').isVisible())await page.locator('#project-menu summary').click();
 await page.locator('#new-react-project').click();
 const created=await until(async()=>{
  const state=await inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));
  return state?.projectId!==before.projectId&&state?.project?.engineDocument&&state.engine?.state==='running'&&
   await page.locator('#saved').textContent()==='已自动保存'?state:undefined;
 },'The new React project button did not create, save and run its actual Schema4 template');
 assert.equal(created.project.engineProfile,release.runtimeProfile);assert.equal(created.project.selected,'/src/App.tsx');
 assert.deepEqual(created.project.engineDocument.launch,{kind:'script',module:'res://src/start.ts',export:'start'});
 const authored=structuredClone(created.project.files),original=structuredClone(created.project.engineDocument.originalDocument);
 assert.equal(original.schemaVersion,4);assert.equal(original.runtime,'engine');
 const firstRun=await until(async()=>(await observation()).messages.slice(messageStart).find(packet=>packet.type==='phase'&&packet.phase==='running')?.runId,
  'The unchanged UI-created React template did not reach native running');
 cases.push({name:'new-react-project-ui-original',projectId:created.projectId,runId:firstRun,terminal:await stopClean(firstRun)});
 checks.push('The new React project button creates, saves, compiles and runs the unchanged Schema4 template; Stop confirms native exit 0, sealed complete entry/host cleanup and no force');

 // Retain the new template's start(ctx), root options, component and Label.
 // Import an authored observer through the real UI, then use the editor's Find
 // UI and per-key input for one short marker. Bulk insertText/paste/IME is not
 // part of this RuntimeHost acceptance. A ref observes the actual native node.
 const draftMarker='RUNTIME_HOST_REACT_SCHEMA4_DRAFT',marker='RUNTIME_HOST_REACT_SCHEMA4';
 const draftSource=authored['/src/App.tsx'].replace('import {EngineNode}', 'import {EngineNode,useRuntimeHost}')
  .replace('export default function App() {',`export default function App() {
  const marker = "RUNTIME_HOST_REACT_SCHEMA4_DRAFT";
  const host = useRuntimeHost();
  const label = React.useRef<Label | null>(null);
  React.useEffect(() => {
    if (!host || host.apiVersion !== 1 || host.role !== "engine") throw Error("RUNTIME_HOST_REACT_SCHEMA4_CONTEXT_MISSING");
    if (!label.current || label.current.text !== "Hello React + Godot") throw Error("RUNTIME_HOST_REACT_SCHEMA4_NATIVE_LABEL_MISSING");
    if (host.emitProjectEvent({type: "runtime-host-ready", marker, sessionId: host.sessionId, role: host.role, apiVersion: host.apiVersion, nativeText: label.current.text}) !== true) throw Error("RUNTIME_HOST_REACT_SCHEMA4_EVENT_REJECTED");
    return () => {
      if (host.emitProjectEvent({type: "runtime-host-after-close", marker}) !== false) throw Error("RUNTIME_HOST_REACT_SCHEMA4_CLOSED_ENTRY_ACTIVE");
      console.log("RUNTIME_HOST_REACT_SCHEMA4_CLEANUP_CLOSED");
    };
  }, [host]);`)
  .replace('<EngineNode ctor={Label}', '<EngineNode ctor={Label} ref={label}');
 assert.notEqual(draftSource,authored['/src/App.tsx']);assert.match(draftSource,/useRuntimeHost\(\)/);assert.match(draftSource,/ref=\{label\}/);
 assert.equal(draftSource.split(draftMarker).length,2,'Only one short marker needs editor input');
 const observerDocument={...structuredClone(original),files:{...authored,'/src/App.tsx':draftSource},editor:{...original.editor,selected:'/src/App.tsx'}};
 await importDocument(observerDocument,'/src/App.tsx',draftSource);
 const draftReady=await readyEvent(draftMarker),draftPacket=(await observation()).messages.find(item=>item.type==='project'&&item.data?.marker===draftMarker&&item.data?.sessionId===draftReady.sessionId);assert(draftPacket);
 const imported=await inspect();assert.notEqual(imported.projectId,created.projectId);assert.equal(imported.project.files['/src/start.ts'],authored['/src/start.ts']);
 cases.push({name:'new-react-template-imported-observer',derivedFromProjectId:created.projectId,projectId:imported.projectId,runId:draftPacket.runId,terminal:await stopClean(draftPacket.runId)});
 const source=draftSource.replace(draftMarker,marker),interactionTimeout=Math.min(timeout,30000);
 const codeInput=page.locator('#source textarea.inputarea').first();await codeInput.focus({timeout:interactionTimeout});
 await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.press('ControlOrMeta+f');
 const findInput=page.locator('.find-widget textarea:visible, .find-widget input:visible').first();
 await findInput.waitFor({state:'visible',timeout:interactionTimeout});await findInput.fill(draftMarker,{timeout:interactionTimeout});
 const editingTrace=await findInput.evaluate(el=>({tagName:el.tagName,ariaLabel:el.getAttribute('aria-label'),value:el.value,focused:document.activeElement===el}));
 await findInput.press('Escape');await codeInput.focus({timeout:interactionTimeout});await page.keyboard.type(marker,{delay:5});
 await until(async()=>{
  const state=await inspect();return state.projectId===imported.projectId&&state.project.files['/src/App.tsx']===source&&
   await page.locator('#saved').textContent()==='已自动保存';
 },'The real editor did not save the per-key RuntimeHost marker replacement');
 const edited=await inspect();assert.equal(edited.project.files['/src/start.ts'],authored['/src/start.ts']);
 assert.deepEqual(edited.project.engineDocument.originalDocument,observerDocument);
 await page.locator('#run').click();const ready=await readyEvent(marker);assert.equal(ready.nativeText,'Hello React + Godot');
 const packet=(await observation()).messages.find(item=>item.type==='project'&&item.data?.marker==='RUNTIME_HOST_REACT_SCHEMA4'&&item.data?.sessionId===ready.sessionId);assert(packet);
 assert.notEqual(packet.runId,firstRun);assert.notEqual(packet.runId,draftPacket.runId);const terminal=await stopClean(packet.runId);
 const cleanup=await until(async()=>{
  const messages=(await observation()).messages;return messages.find(item=>item.runId===packet.runId&&item.type==='log'&&item.text?.includes('RUNTIME_HOST_REACT_SCHEMA4_CLEANUP_CLOSED'));
 },'The actual React effect cleanup did not run after entry admission closed');
 assert.equal(sessionExitReason(terminal.sessionFacts),'clean-exit');
 cases.push({name:'new-react-template-import-marker-runtime-host',derivedFromProjectId:created.projectId,projectId:imported.projectId,sessionId:ready.sessionId,runId:packet.runId,
  nativeText:ready.nativeText,authoring:'actual-ui-import-and-editor-find-per-key-marker-exact-source-verified',editingTrace,startSourceUnchanged:true,cleanupObserved:cleanup.text,terminal});
 checks.push('An observer derived from the UI-created React template is imported through the real UI, then a short marker is edited with Find and per-key input; its unchanged start(ctx) renders a real native Label, exposes the public scoped RuntimeHost and runs effect cleanup after entry admission closes, with native exit 0 and complete cleanup');
}
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
 assert.equal(facts.entryCleanup,'complete','Managed native cleanup ticks must confirm every renderer release');
 assert.equal(facts.runtimeSummary,'sealed');assert.equal(sessionExitReason(facts),'clean-exit');
 await nativeSourceSeals(packet.runId);
 cases.push({name:'react-shader-demo-root-context',sessionId:ready.sessionId,runId:packet.runId,panels:stats.stats.panels,terminal});
 checks.push('The shipped React shader demo runs real native panels/resources, receives its scoped Root Context host and demo commands, and stops with sealed complete entry cleanup and native exit 0');
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
 const packets=(await observation()).messages.filter(packet=>packet.type==='project'&&packet.data?.type==='runtime-host-ready'&&packet.data.sessionId===ready.sessionId);
 assert.equal(packets.length,1);
 const {runId,revision,generation}=packets[0];
 const trace={runId,revision,generation,sessionId:ready.sessionId};commandRoundtrips.push(trace);
 function replies(events){
  return events.filter(event=>event?.sessionId===ready.sessionId&&event.marker===marker&&
   ['runtime-host-command','runtime-host-command-async'].includes(event.type));
 }
 try{
  trace.admission=await page.evaluate(()=>{
   const bridge=globalThis.__playgroundWorkbench,workbench=bridge.inspect();
   const context=globalThis.godotPlayground.get_project_context().result;
   const available=typeof bridge.enableNativeInputBenchmark==='function';
   return {available,admitted:available?bridge.enableNativeInputBenchmark():undefined,editorRevision:workbench.revision,
    activeRunId:context.activeRunId,phase:workbench.engine?.state};
  });
  assert.equal(trace.admission.available,true,'Use the actual workbench → runner.command path');
  assert.equal(trace.admission.admitted,true,'Verify the workbench command admission receipt');
  const result=await until(async()=>{
   const events=replies(await projectEvents()),sync=events.find(event=>event.type==='runtime-host-command'),async=events.find(event=>event.type==='runtime-host-command-async');
   return sync&&async?{sync,async}:undefined;
  },'Project command did not roundtrip through the real host');
  assert.equal(result.sync.commands,1);assert.equal(result.async.commands,1);assert.equal(result.sync.enabled,true);assert.equal(result.sync.nativeText,marker);
  return runId;
 }finally{
  trace.workbenchEvents=replies(await projectEvents().catch(()=>[]));
  const wire=await observation().catch(()=>undefined);
  trace.wireEvents=wire?.messages.filter(packet=>packet.runId===runId&&packet.type==='project'&&
   ['runtime-host-command','runtime-host-command-async'].includes(packet.data?.type))
   .map(packet=>({projectSequence:packet.projectSequence,data:packet.data,matches:replies([packet.data]).length===1}));
 }
}
async function stopClean(runId){
 await page.locator('#stop').click();await stopped();const terminal=await terminalFor(runId),facts=terminal.sessionFacts;
 const trace=commandRoundtrips.find(item=>item.runId===runId);
 if(trace)trace.terminal=terminal;
 assert(facts,'The terminal wire packet must carry SessionFacts');assert.equal(facts.schemaVersion,1);
 assert.equal(facts.nativeExit?.code,0);assert.equal(facts.failure,undefined);assert.equal(facts.forcedTerminationIssued,false);
 assert.equal(facts.runtimeSummary,'sealed');assert.equal(facts.entryCleanup,'complete');assert.equal(facts.hostCleanup,'complete');
 await nativeSourceSeals(runId);
 assert(!((await observation()).messages.some(packet=>packet.runId===runId&&packet.type==='project'&&packet.data?.type==='runtime-host-after-close')));
 return terminal;
}

async function stopPendingStartup(){
 await importProject(pendingStartupProgram);const ready=await readyEvent('RUNTIME_HOST_PENDING_STARTUP');
 const packet=(await observation()).messages.find(item=>item.type==='project'&&item.data?.marker==='RUNTIME_HOST_PENDING_STARTUP'&&item.data?.sessionId===ready.sessionId);
 assert(packet,'Pending startup must emit through the original project port before Stop');
 const terminal=await stopClean(packet.runId),messages=(await observation()).messages.filter(item=>item.runId===packet.runId);
 const index=marker=>messages.findIndex(item=>item.type==='log'&&item.text?.includes(marker));
 const cancelled=index('RUNTIME_HOST_PENDING_CANCELLED'),begin=index('RUNTIME_HOST_LATE_CLEANUP_BEGIN'),complete=index('RUNTIME_HOST_LATE_CLEANUP_COMPLETE');
 const ended=messages.findIndex(item=>['exit-report','fatal','exited','terminated'].includes(item.type));
 assert(cancelled>=0&&begin>cancelled&&complete>begin&&ended>complete,'Stop must cancel unresolved startup, await its late async cleanup, then emit the native terminal');
 cases.push({name:'pending-startup-late-async-cleanup',sessionId:ready.sessionId,runId:packet.runId,cleanupOrder:{cancelled,begin,complete,ended},terminal});
 checks.push('Stop cancels the public entry lifetime while start is unresolved, accepts its late async cleanup, retains the live native mount through the awaited cleanup, rejects closed-entry sends and reports complete cleanup without force');
}

try{
 await Promise.all([listen(editor),listen(preview)]);
 const scheme=tls?'https':'http',editorOrigin=`${scheme}://127.0.0.1:${editor.address().port}`,previewOrigin=`${scheme}://127.0.0.1:${preview.address().port}`;
 const delivery=await inspectTestSite(editorOrigin+prefix,tls);assert.equal(delivery.status,200);deployment=localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:delivery.headers});
 test.stage='browser';browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 test.stage='run';
 context=await browser.newContext({viewport:{width:1536,height:1000}});
 if(typedDemoGuard)await context.addInitScript(guardDemoArrayExpansion,{bytes:demoPackBytes});
 await context.exposeBinding('__recordRuntimeHostSource',(_source,observation)=>{if(sourceObservations.length<16384)sourceObservations.push(observation);else sourceObservationOverflow++;});
 commandRecorder=await installPassiveRecorder(context,'__recordRuntimeHostCommand',(_source,packet)=>{
  if(commandTraffic.length<2048)commandTraffic.push(packet);else commandTrafficOverflow++;
 });
 await context.addInitScript(observeRuntimeSources);await context.addInitScript(observeRuntimeHostMessages);
 await context.addInitScript(observeProjectCommandTraffic);
 page=await context.newPage();page.setDefaultTimeout(timeout);page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto(editorOrigin+prefix+'?project=native&benchmarkTimings=1&previewOrigin='+encodeURIComponent(previewOrigin+prefix),{waitUntil:'domcontentloaded'});
 await until(async()=>{const state=await inspect();return state?.ready&&state.engine?.state==='running';},'Initial native product did not start');
 if(execution?.requiresCrossOriginIsolation)assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 let first,restartedRun,failure;
 if(contractGroup==='all'||contractGroup==='lifecycle'){
  await test.step('normal-host-roundtrip',async()=>{
   await importProject(program('RUNTIME_HOST_FIRST'));
   first=await readyEvent('RUNTIME_HOST_FIRST');const firstRun=await roundtrip('RUNTIME_HOST_FIRST',first);
   cases.push({name:'normal-host-roundtrip',sessionId:first.sessionId,runId:firstRun,terminal:await stopClean(firstRun)});
   checks.push('Schema4 entry mutates/readbacks a native Label and delivers exact project/command roundtrips');
  });
  await test.step('stop-restart',async()=>{
   await page.locator('#run').click();const restarted=await readyEvent('RUNTIME_HOST_FIRST',first.sessionId);
   assert.notEqual(restarted.sessionId,first.sessionId);restartedRun=await roundtrip('RUNTIME_HOST_FIRST',restarted);
   cases.push({name:'stop-restart',sessionId:restarted.sessionId,runId:restartedRun,terminal:await stopClean(restartedRun)});
   checks.push('Stop retains native exit and sealed entry/host cleanup; restart uses a fresh identity');
  },{after:['normal-host-roundtrip']});
 }
 if(contractGroup==='all'||contractGroup==='failure-recovery'){
  await test.step('async-start-failure',async()=>{
   // In the independent short group the page's initial native project is
   // still active. Retire it before observing the failing project's terminal.
   if(await page.locator('#preview iframe').count()){await page.locator('#stop').click();await stopped();}
   const beforeFailure=(await observation()).terminals.length;await importProject(failureProgram);
   failure=await until(async()=>{const terminals=(await observation()).terminals.slice(beforeFailure);assert(terminals.length<=1,'Async startup failure must settle once');return terminals[0];},'Async startup rejection was not delivered as a terminal failure');
   await stopped();assert(failure.sessionFacts,'Async failure must retain terminal facts');assert.equal(failure.sessionFacts.failure?.kind,'runtime');assert.match(failure.sessionFacts.failure?.message??'',/RUNTIME_HOST_ASYNC_START_FAILURE/);
   assert.equal(failure.sessionFacts.hostCleanup,'complete');if(restartedRun)assert.notEqual(failure.runId,restartedRun);
   cases.push({name:'async-start-failure',runId:failure.runId,terminal:failure});
   checks.push('Async startup rejection retains its first fatal and confirmed host cleanup');
  });
  await test.step('recovery-after-failure',async()=>{
   await importProject(program('RUNTIME_HOST_RECOVERED'));const recovered=await readyEvent('RUNTIME_HOST_RECOVERED'),recoveredRun=await roundtrip('RUNTIME_HOST_RECOVERED',recovered);
   if(first)assert.notEqual(recovered.sessionId,first.sessionId);assert.notEqual(recoveredRun,failure.runId);
   cases.push({name:'recovery-after-failure',sessionId:recovered.sessionId,runId:recoveredRun,terminal:await stopClean(recoveredRun)});
   checks.push('A new project runs after failed startup without stale-session contamination');
  },{after:['async-start-failure']});
  await test.step('pending-startup-late-async-cleanup',stopPendingStartup,{after:['recovery-after-failure']});
 }
 if(contractGroup==='all'||contractGroup==='entry'){
  await test.step('new-react-template',newReactTemplate);
  if(contractGroup==='all')await test.step('react-shader-demo',runReactDemo,{after:['new-react-template']});
 }
 if(typedDemoGuard){
  const guard=await page.evaluate(()=>globalThis.__typedDemoGuard);assert(guard.workers>0);assert.equal(guard.bytes,demoPackBytes);
  checks.push('The shipped shader demo compiles and runs while a compiler Worker guard rejects Array.from on its '+demoPackBytes+'-byte typed demo resource pack');
 }
 assert.deepEqual(pageErrors,[]);
 assert.equal(sourceObservationOverflow,0,'Native source observation must remain complete');
 report={status:'passed',scope:'actual-product-runtime-host',engineExecuted:true,backend,checks,cases,pageErrors,deployment,execution,contractGroup,
  ...(typedDemoGuard?{compilerAllocationGuard:{method:'Worker bootstrap Array.from guard; original compiler bundle imported unchanged',demoPackBytes}}:{})};
 if(test.steps.every(step=>step.status==='passed'))report=await withAcceptanceContext(report,{directory,browser});
 else report={...report,sessions:observedWorkerSessions(browser),outcomes:observedWorkerOutcomes(browser)};
}catch(error){
 report={...report,status:browserTestFailureStatus(error,test.stage),error:String(error),stack:error?.stack,pageErrors,deployment,checks,cases,
  ...(page?{observed:await inspect().catch(()=>undefined),messages:await observation().catch(()=>undefined),logs:await page.locator('#logs').textContent().catch(()=>undefined)}:{})};
 process.exitCode=1;
}
report.runtimeSources=runtimeSourceEvidence();
await commandRecorder?.flush();
report.commandTrafficOverflow=commandTrafficOverflow;
report.commandRoundtrips=commandRoundtrips.map(trace=>({...trace,traffic:commandTraffic.filter(packet=>packet.runId===trace.runId)}));
return report;
}});
