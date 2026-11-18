import assert from 'node:assert/strict';
import {defaultTestDirectory,launchBrowser,withAcceptanceContext,observedWorkerSessions,observedWorkerOutcomes} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls} from './browser-local-tls.mjs';
import {runReportedBrowserTest,listenBrowserTestServer as listen,closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {createPackedConsumer} from '../../../packages/project-tools/test/fixtures/packed-consumer.mjs';

const identityFields=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
function assertIdentity(value){for(const field of identityFields)assert(value[field]!==undefined,'Missing '+field);assert.match(value.runConfigurationHash,/^[a-f0-9]{64}$/);}
const configuration='config_version=5\n[application]\nconfig/name="Independent SDK contracts"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
const program=marker=>`import {Label} from 'godot';
export function start(ctx:any){
 const marker=${JSON.stringify(marker)},host=ctx.host,scope=globalThis as any;
 if(typeof scope.WorkerGlobalScope!=='function'||!(scope instanceof scope.WorkerGlobalScope)||host?.role!=='engine')throw Error('CONTRACT_WRONG_REALM');
 const label=new Label();label.text=marker;ctx.mount.add_child(label);
 const emit=()=>{if(label.text!==marker)throw Error('CONTRACT_NATIVE_READBACK');if(host.emitProjectEvent({type:'contract-native-readback',marker,nativeText:label.text,role:host.role,sessionId:host.sessionId})!==true)throw Error('CONTRACT_EVENT_REJECTED');};
 emit();const unbind=host.bindProjectCommand((command:any)=>{if(command.type==='probe')emit();});
 return ()=>{unbind();if(host.emitProjectEvent({type:'contract-after-close',marker})!==false)throw Error('CONTRACT_CLOSED_ENTRY');};
}`;

await runReportedBrowserTest({scope:'isolated-sdk-engine-contracts',reportFile:process.env.PLAYGROUND_CONSUMER_REPORT,run:async test=>{
 const directory=defaultTestDirectory(),{site,release,candidateId}=await test.preflight(directory,{worker:true}),execution=release.execution??release.engine?.execution;
 const cases=[],pageErrors=[],requests=[],consoleErrors=[],requestFailures=[];let browser,context,page,consumer,caller,engineExecuted=false;
 const tls=execution?.requiresCrossOriginIsolation?await createLocalTestTls():undefined;test.defer(()=>tls?.dispose());
 const prefix=site.publicAssets?'/releases/'+candidateId+'/':'/',options={urlPrefix:prefix,publicImmutable:site.publicAssets===true,tls};
 const editor=createStaticServer(directory,options),preview=createStaticServer(directory,options);
 test.defer(()=>close(editor));test.defer(()=>close(preview));test.defer(()=>close(caller));test.defer(()=>consumer?.dispose());test.defer(()=>browser?.close());test.defer(()=>context?.close());
 await Promise.all([listen(editor),listen(preview)]);
 const scheme=tls?'https':'http',editorRoot=`${scheme}://127.0.0.1:${editor.address().port}${prefix}`,previewRoot=`${scheme}://127.0.0.1:${preview.address().port}${prefix}`;
 test.checkpoint({cases,requestedTarget:{profile:'full-engine-v1',executionBackend:'worker',presentationBackend:'direct',browser:'chromium'}});
 test.stage='consumer-install';consumer=await createPackedConsumer({browser:true});
 // Serve the independent caller from a real local endpoint. Synthetic routed
 // documents have no matching IP address space and Chromium may reject their
 // local-network iframe navigation even when both intended URLs are loopback.
 caller=createStaticServer(consumer.directory,{isolation:execution?.requiresCrossOriginIsolation===true,tls});await listen(caller);
 test.stage='browser';browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(120000);
 page.on('pageerror',error=>pageErrors.push(String(error)));page.on('request',request=>requests.push(request.url()));
 page.on('console',message=>{if(message.type()==='error'&&consoleErrors.length<64)consoleErrors.push(message.text());});
 page.on('requestfailed',request=>{if(requestFailures.length<64)requestFailures.push({url:request.url(),error:request.failure()?.errorText});});
 await page.goto(`${scheme}://127.0.0.1:${caller.address().port}/consumer.html`);test.stage='run';
 const runOptions=marker=>({releaseRoot:editorRoot,previewUrl:previewRoot+'preview.html',files:{'/src/start.ts':program(marker),'/project.godot':configuration},launch:{kind:'script',module:'res://src/start.ts',export:'start'}});
 const native=async(runId,marker)=>{
  await page.waitForFunction(({runId,marker})=>globalThis.engineContractsConsumer.events.some(event=>event.type==='project'&&event.runId===runId&&event.data?.type==='contract-native-readback'&&event.data.marker===marker),{runId,marker});
  const event=await page.evaluate(({runId,marker})=>globalThis.engineContractsConsumer.events.find(event=>event.type==='project'&&event.runId===runId&&event.data?.marker===marker),{runId,marker});
  assertIdentity(event);assert.equal(event.data.nativeText,marker);assert.equal(event.data.role,'engine');engineExecuted=true;return event;
 };
 const stopClean=async()=>{
  const terminal=await page.evaluate(()=>globalThis.engineContractsConsumer.stop());assertIdentity(terminal);
  assert.equal(terminal.sessionFacts?.nativeExit?.code,0);assert.equal(terminal.sessionFacts.failure,undefined);assert.equal(terminal.sessionFacts.forcedTerminationIssued,false);assert.equal(terminal.sessionFacts.hostCleanup,'complete');
  const count=await page.evaluate(runId=>globalThis.engineContractsConsumer.events.filter(event=>event.type==='exit'&&event.report.runId===runId).length,terminal.runId);assert.equal(count,1);return terminal;
 };
 let firstBuild,secondBuild;
 await test.step('compiled-native-readback',async()=>{
  firstBuild=await page.evaluate(async options=>{const api=globalThis.engineContractsConsumer;globalThis.__contractArtifact1=await api.prepare(options);const result=await api.runner.run(globalThis.__contractArtifact1);return {result,build:api.lastBuild};},runOptions('CONTRACT_ONE'));
  assertIdentity(firstBuild.result);assert.equal(firstBuild.build.facts.selection.kind,'engine');assert.deepEqual(firstBuild.build.facts.baseRuntimeModules,[]);
  const readback=await native(firstBuild.result.runId,'CONTRACT_ONE');cases.push({name:'compiled-native-readback',build:firstBuild.build,readback,terminal:await stopClean()});
  const vendors=new Set(Object.values(release.sdk?.vendors??{}).map(asset=>new URL(asset.path,editorRoot).href));assert(!requests.some(url=>vendors.has(url)),'Engine-only source must not download SDK vendors');
 });
 await test.step('type-error-no-run',async()=>{
  const result=await page.evaluate(async options=>{const api=globalThis.engineContractsConsumer,before=api.events.length;try{await api.prepare({...options,files:{...options.files,'/src/start.ts':'const value: number="wrong"; export function start() {}'}});return {accepted:true};}catch(error){return {diagnostics:error.diagnostics,events:api.events.slice(before)};}},runOptions('CONTRACT_ONE'));
  assert(result.diagnostics?.some(item=>item.category==='error'&&item.file?.endsWith('start.ts')));assert(!result.events.some(event=>event.type==='state'&&event.state==='running'));cases.push({name:'type-error-no-run',diagnostics:result.diagnostics});
 },{after:['compiled-native-readback']});
 await test.step('captured-second-build',async()=>{
  secondBuild=await page.evaluate(async options=>{const api=globalThis.engineContractsConsumer;globalThis.__contractArtifact2=await api.prepare(options);return api.lastBuild;},{...runOptions('CONTRACT_TWO'),revision:2,generation:2,deadlines:{heartbeat:2000,stopping:3000}});
  assert.notEqual(secondBuild.sourceHash,firstBuild.build.sourceHash);assert.notEqual(secondBuild.buildKey,firstBuild.build.buildKey);cases.push({name:'captured-second-build',build:secondBuild});
 },{after:['type-error-no-run']});
 await test.step('cancel-before-session',async()=>{
  const result=await page.evaluate(async()=>{const api=globalThis.engineContractsConsumer,before=api.events.length;const pending=api.runner.run(globalThis.__contractArtifact1).then(()=>({accepted:true}),error=>({name:error.name,message:error.message}));const stopped=await api.stop();return {result:await pending,stopped,events:api.events.slice(before)};});
  assert.equal(result.result.name,'AbortError');assert.equal(result.stopped,undefined);assert.deepEqual(result.events,[]);cases.push({name:'cancel-before-session',result:result.result,sessionCreated:false});
 },{after:['captured-second-build']});
 await test.step('stop-before-ready',async()=>{
  let releaseRequest;const gate=new Promise(resolve=>releaseRequest=resolve),match=url=>url.origin===new URL(previewRoot).origin&&url.pathname.endsWith('/preview.html');
  const hold=async route=>{await gate;await route.continue().catch(()=>{});};await page.route(match,hold);
  try{
   const requested=page.waitForRequest(request=>match(new URL(request.url())));
   await page.evaluate(()=>{globalThis.__contractPending=globalThis.engineContractsConsumer.runner.run(globalThis.__contractArtifact1).then(value=>({value}),error=>({name:error.name,message:error.message}));});
   await requested;await page.waitForFunction(()=>globalThis.engineContractsConsumer.runner.state==='loading-frame');
   const terminal=await page.evaluate(()=>globalThis.engineContractsConsumer.stop());assertIdentity(terminal);assert.equal(terminal.reason,'forced-frame-disposal');assert(!Object.hasOwn(terminal,'code'));assert(!Object.hasOwn(terminal,'sessionFacts'));
   const result=await page.evaluate(()=>globalThis.__contractPending);assert.match(result.message,/E_RUN_ENDED/);
   const count=await page.evaluate(runId=>globalThis.engineContractsConsumer.events.filter(event=>event.type==='exit'&&event.report.runId===runId).length,terminal.runId);assert.equal(count,1);cases.push({name:'stop-before-ready',terminal,result});
  }finally{releaseRequest();await page.unroute(match,hold);}
 },{after:['cancel-before-session']});
 await test.step('wrong-target-and-hash-preserve-active-run',async()=>{
  const result=await page.evaluate(()=>globalThis.engineContractsConsumer.runner.run(globalThis.__contractArtifact1));await native(result.runId,'CONTRACT_ONE');
  const rejected=await page.evaluate(async()=>{const api=globalThis.engineContractsConsumer,errors=[];for(const kind of ['target','hash']){const invalid=structuredClone(globalThis.__contractArtifact2);if(kind==='target')invalid.manifest.engineReleaseId='0'.repeat(64);else invalid.pack[invalid.pack.length-1]^=1;try{await api.runner.run(invalid);errors.push({kind,accepted:true});}catch(error){errors.push({kind,message:error.message});}}return {errors,state:api.runner.state,exits:api.events.filter(event=>event.type==='exit').map(event=>event.report.runId),accepted:api.runner.command({type:'probe'})};});
  assert(rejected.errors.every(item=>!item.accepted));assert.match(rejected.errors[0].message,/E_ARTIFACT_ENGINE_RELEASE/);assert.match(rejected.errors[1].message,/HASH|IDENTITY/);assert.equal(rejected.state,'running');assert.equal(rejected.accepted,true);assert(!rejected.exits.includes(result.runId));cases.push({name:'wrong-target-and-hash-preserve-active-run',identity:result,rejected});
 },{after:['stop-before-ready']});
 await test.step('active-build-replacement',async()=>{
  const before=await page.evaluate(()=>globalThis.engineContractsConsumer.events.length);
  const result=await page.evaluate(()=>globalThis.engineContractsConsumer.runner.run(globalThis.__contractArtifact2));assertIdentity(result);const readback=await native(result.runId,'CONTRACT_TWO');
  const events=await page.evaluate(before=>globalThis.engineContractsConsumer.events.slice(before),before),terminal=events.find(event=>event.type==='exit')?.report;
  assertIdentity(terminal);assert.notEqual(terminal.runId,result.runId);assert.equal(terminal.sessionFacts.nativeExit?.code,0);
  const running=events.findIndex(event=>event.type==='state'&&event.state==='running'&&event.runId===result.runId);assert(running>=0);assert(!events.slice(running+1).some(event=>event.type==='project'&&event.runId===terminal.runId));cases.push({name:'active-build-replacement',readback,replaced:terminal,terminal:await stopClean()});
 },{after:['wrong-target-and-hash-preserve-active-run']});
 await test.step('newer-preparation-wins',async()=>{
  const result=await page.evaluate(async()=>{const api=globalThis.engineContractsConsumer;const older=api.runner.run(globalThis.__contractArtifact1).then(()=>({accepted:true}),error=>({name:error.name,message:error.message}));const latest=await api.runner.run(globalThis.__contractArtifact2);return {older:await older,latest};});
  assert.equal(result.older.name,'AbortError');await native(result.latest.runId,'CONTRACT_TWO');cases.push({name:'newer-preparation-wins',...result,terminal:await stopClean()});
 },{after:['active-build-replacement']});
 await test.step('lost-host-and-recovery',async()=>{
  const result=await page.evaluate(()=>globalThis.engineContractsConsumer.runner.run(globalThis.__contractArtifact1));await native(result.runId,'CONTRACT_ONE');await page.evaluate(()=>document.querySelector('iframe').remove());
  await page.waitForFunction(runId=>globalThis.engineContractsConsumer.events.some(event=>event.type==='exit'&&event.report.runId===runId),result.runId,{timeout:15000});
  const terminal=await page.evaluate(runId=>globalThis.engineContractsConsumer.events.find(event=>event.type==='exit'&&event.report.runId===runId).report,result.runId);assertIdentity(terminal);assert(!Object.hasOwn(terminal,'code'));assert(!Object.hasOwn(terminal,'engineOutcome'));assert(!Object.hasOwn(terminal,'sessionFacts'));
  const recovered=await page.evaluate(()=>globalThis.engineContractsConsumer.runner.run(globalThis.__contractArtifact2));await native(recovered.runId,'CONTRACT_TWO');assert.notEqual(recovered.runId,result.runId);cases.push({name:'lost-host-and-recovery',scope:'Actual preview frame loss; Worker/native cleanup remains unconfirmed',lost:terminal,recovered,terminal:await stopClean()});
 },{after:['newer-preparation-wins']});
 await test.step('ordinary-scene-entry',async()=>{
  const sceneFiles={'/project.godot':configuration,'/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Label"]\nscript = ExtResource("1")\ntext = "CONTRACT_SCENE"\n','/src/Main.ts':'import {Label,print} from "godot"; export default class Main extends Label { _ready(){if(this.text!=="CONTRACT_SCENE")throw Error("CONTRACT_SCENE_READBACK");print("CONTRACT_SCENE_NATIVE_READBACK "+this.text);} }'};
  const result=await page.evaluate(options=>globalThis.engineContractsConsumer.run(options),{...runOptions('CONTRACT_SCENE'),files:sceneFiles,launch:{kind:'scene',source:'override',path:'res://main.tscn'},revision:3,generation:3});
  await page.waitForFunction(runId=>globalThis.engineContractsConsumer.events.some(event=>event.type==='log'&&event.runId===runId&&event.text.includes('CONTRACT_SCENE_NATIVE_READBACK CONTRACT_SCENE')),result.result.runId);engineExecuted=true;cases.push({name:'ordinary-scene-entry',identity:result.result,terminal:await stopClean()});
 },{after:['lost-host-and-recovery']});
 if(execution?.artifactSetAbi===1)await test.step('artifact-set-early-mount',async()=>{
  const result=await page.evaluate(options=>globalThis.engineContractsConsumer.run(options),{...runOptions('CONTRACT_SET'),artifactSet:true,revision:4,generation:4});await native(result.result.runId,'CONTRACT_SET');
  const build=await page.evaluate(()=>globalThis.engineContractsConsumer.lastBuild);assert.equal(build.variant,'pack-set');cases.push({name:'artifact-set-early-mount',build,identity:result.result,terminal:await stopClean()});
 },{after:['ordinary-scene-entry']});
 assert.deepEqual(pageErrors,[]);
 let report={status:'passed',scope:'isolated-sdk-engine-contracts',engineExecuted,cases,pageErrors,consoleErrors,requestFailures,
  observed:await page.evaluate(()=>({state:globalThis.engineContractsConsumer.runner?.state,events:globalThis.engineContractsConsumer.events})),sdk:{packages:Object.keys(consumer.manifests),browserInputs:consumer.browserInputs},execution,
  deployment:{kind:'independent-local-static-consumer',callerOrigin:`${scheme}://127.0.0.1:${caller.address().port}`,releaseRoot:editorRoot,previewRoot,staticAssetsCors:'Access-Control-Allow-Origin: *; cross-origin fetch uses no credentials',requiresCrossOriginIsolation:execution?.requiresCrossOriginIsolation===true},
  limitations:['Independent packed SDK caller reuses the matching distributed preview host. Frame loss does not prove native termination.']};
 if(test.steps.every(step=>step.status==='passed'))report=await withAcceptanceContext(report,{directory,browser});
 else report={...report,sessions:observedWorkerSessions(browser),outcomes:observedWorkerOutcomes(browser)};
 return report;
}});
