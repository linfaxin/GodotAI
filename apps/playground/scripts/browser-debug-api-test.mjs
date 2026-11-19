import assert from 'node:assert/strict';
import path from 'node:path';
import {defaultTestDirectory,launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest,listenBrowserTestServer as listen,closeBrowserTestServer as close} from './browser-contract-report.mjs';

const scope='actual-product-debug-api';
await runReportedBrowserTest({scope,reportFile:process.env.PLAYGROUND_DEBUG_API_REPORT,run:async test=>{
 const directory=path.resolve(defaultTestDirectory());
 const {site,release,candidateId,descriptorHash}=await test.preflight(directory,{worker:true});
 const prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
 const options={urlPrefix:prefix,publicImmutable:site.publicAssets===true};
 const editor=createStaticServer(directory,options),preview=createStaticServer(directory,options);
 test.defer(()=>close(editor));test.defer(()=>close(preview));
 await Promise.all([listen(editor),listen(preview)]);
 const editorRoot=`http://127.0.0.1:${editor.address().port}${prefix}`;
 const previewRoot=`http://127.0.0.1:${preview.address().port}${prefix}`;
 const openPlayground=page=>page.goto(editorRoot+'?project=native&presentationBackend=direct&previewOrigin='+encodeURIComponent(previewRoot),{waitUntil:'domcontentloaded'});
 const timeout=Number(process.env.PLAYGROUND_DEBUG_API_TIMEOUT??120_000);
 assert(Number.isSafeInteger(timeout)&&timeout>0);
 const cases=[];
 const failures=[];
 let engineExecuted=false;

 function observeProduct(){
  if(location.pathname.endsWith('/preview.html'))return;
  const wire=globalThis.__debugApiWire={messages:[],builds:[],requests:[],rejectNext:false};
  const Channel=MessageChannel;
  globalThis.MessageChannel=new Proxy(Channel,{construct(target,args,newTarget){
   const channel=Reflect.construct(target,args,newTarget);
   for(const port of [channel.port1,channel.port2])port.addEventListener('message',({data})=>{
    if(data?.protocolVersion===2&&typeof data.runId==='string'&&['phase','log','exit-report'].includes(data.type)&&wire.messages.length<4096)wire.messages.push(data);
   });
   return channel;
  }});
  const NativeWorker=Worker;
  globalThis.Worker=class extends NativeWorker{
   constructor(...args){
    super(...args);
    this.isCompiler=new URL(String(args[0]),location.href).pathname.endsWith('/compiler.worker.js');
    if(!this.isCompiler)return;
    this.addEventListener('message',({data})=>{
     if(!data?.manifest||!['single-pack','pack-set'].includes(data.variant))return;
     const {engineId,artifactId,buildKey}=data.manifest;
     const rejected=wire.rejectNext;
     if(rejected){
      wire.rejectNext=false;
      data.manifest.engineId=engineId===('a'.repeat(64))?'b'.repeat(64):'a'.repeat(64);
     }
     if(wire.builds.length<64)wire.builds.push({variant:data.variant,engineId,artifactId,buildKey,rejected,sourceHash:data.sourceHash,
      compilerReleaseId:data.environmentFacts?.release?.releaseId,typescriptVersion:data.environmentFacts?.typescriptVersion});
    },true);
   }
   postMessage(data,...args){
    if(this.isCompiler&&wire.requests.length<256)wire.requests.push({kind:data.kind,revision:data.revision});
    return super.postMessage(data,...args);
   }
  };
  globalThis.__readDebugApi=(runId)=>{
   const api=globalThis.godotPlayground;
   if(!api)return;
   const context=api.get_project_context().result;
   const build=context.latestBuildAttemptId?api.get_build({attemptId:context.latestBuildAttemptId}).result:undefined;
   const id=runId??build?.preview?.runId??context.activeRunId??context.lastExitedRunId;
   const run=id?api.get_run({runId:id}).result:undefined;
   const events=id?api.read_run_events({runId:id,limit:100}).result?.items:undefined;
   return {context,build,run,events};
  };
 }

 const project=source=>({schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,
  launch:{kind:'script',module:'res://src/start.ts',export:'start'},
  files:{'/src/start.ts':source,'/project.godot':'config_version=5\n[application]\nconfig/name="Debug API acceptance"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'},
  editor:{selected:'/src/start.ts',mode:'production'}});
 const runProgram=marker=>`import {print} from 'godot';
export function start(){
 const realm=globalThis as any;
 if(typeof realm.WorkerGlobalScope!=='function'||!(realm instanceof realm.WorkerGlobalScope))throw Error('Expected a native engine Worker');
 print(${JSON.stringify(marker)});
 return ()=>print('DEBUG_API_CLEANUP');
}`;
 const failureProgram=`import {print} from 'godot';
export async function start(){
 print('DEBUG_API_START_FAILURE_LOG');
 await Promise.resolve();
 throw Error('DEBUG_API_START_FAILURE');
}`;
 const read=(page,runId)=>page.evaluate(id=>globalThis.__readDebugApi(id),runId);
 const readWire=page=>page.evaluate(()=>globalThis.__debugApiWire);
 async function importProject(page,source){
  const before=(await read(page)).context.latestBuildAttemptId;
  await page.locator('#import').setInputFiles({name:'debug-api.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project(source)))});
  await page.waitForFunction(previous=>{
   const {build}=globalThis.__readDebugApi();
   return build&&build.attemptId!==previous&&build.status!=='pending';
  },before,{timeout});
 }
 async function waitForRun(page,marker,previous){
  await page.waitForFunction(({marker,previous})=>{
   const {run,events}=globalThis.__readDebugApi();
   return run&&run.runId!==previous&&run.state==='running'&&events?.some(({event})=>event.type==='log'&&event.text?.includes(marker));
  },{marker,previous},{timeout});
  const {run,build,context}=await read(page);
  const wire=await readWire(page);
  const phase=wire.messages.find(packet=>packet.type==='phase'&&packet.phase==='running'&&packet.runId===run.runId);
  assert(phase,'The actual Worker sent a running phase');
  for(const field of ['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'])assert.equal(run[field],phase[field],field);
  assert(wire.messages.some(packet=>packet.type==='log'&&packet.runId===run.runId&&packet.text?.includes(marker)));
  assert.equal(run.attemptId,build.attemptId);
  assert.equal(build.preview.runId,run.runId);
  assert.equal(context.activeRunId,run.runId);
  assert.equal(context.release.value.releaseId,release.id);
  assert.equal(context.release.value.candidateId,candidateId);
  assert.equal(run.release.releaseId,release.id);
  assert.equal(run.release.descriptorSha256,descriptorHash);
  assert.deepEqual(run.configuration,{executionBackend:'worker',presentationBackend:'direct'});
  const workerBuild=wire.builds.at(-1);
  for(const field of ['variant','buildKey','artifactId'])assert.equal(build.artifact[field],workerBuild[field],field);
  assert.match(workerBuild.sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(build.sourceHash,workerBuild.sourceHash);
  assert.equal(build.environmentFacts.release.releaseId,workerBuild.compilerReleaseId);
  assert.equal(build.environmentFacts.typescriptVersion,workerBuild.typescriptVersion);
  assert.equal(build.compilerIdentity.target.engineReleaseId,release.id);
  engineExecuted=true;
  test.checkpoint({engineExecuted});
  return {run,build};
 }
 async function waitForExit(page,runId){
  await page.waitForFunction(id=>Boolean(globalThis.__readDebugApi(id)?.run?.exit),runId,{timeout});
  const snapshot=await read(page,runId);
  assert.equal(snapshot.run.state,'exited');
  assert.equal(snapshot.events.filter(({event})=>event.type==='exit').length,1);
  assert.deepEqual(snapshot.events.find(({event})=>event.type==='exit').event.exit,snapshot.run.exit);
  assert.equal(snapshot.context.lastExitedRunId,runId);
  return snapshot.run.exit;
 }
 const invoke=(page,tool,input)=>page.evaluate(({tool,input})=>window.godotPlayground[tool](input),{tool,input});
 function unwrap(response){
  assert.equal(response.ok,true,JSON.stringify(response));
  return response.result;
 }
 async function projectInput(page){
  const {projectId,editorRevision}=unwrap(await invoke(page,'get_project_context'));
  return {projectId,expectedEditorRevision:editorRevision};
 }
 async function editScript(page,text){
  const previous=(await projectInput(page)).expectedEditorRevision;
  await page.locator('#source .monaco-editor').click({position:{x:105,y:30}});
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  await page.waitForFunction(revision=>window.godotPlayground.get_project_context().result.editorRevision>revision,previous,{timeout});
  return projectInput(page);
 }

 test.stage='browser';
 const browser=await launchBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 test.defer(()=>browser.close());
 test.stage='run';
 async function browserCase(name,run,{waitForInitialRun=true}={}){
  await test.step(name,async()=>{
   const context=await browser.newContext({viewport:{width:1536,height:1000}});
   const errors=[];
   let page;
   try{
    await context.addInitScript(observeProduct);
    page=await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on('pageerror',error=>errors.push(String(error)));
    if(waitForInitialRun){
     await openPlayground(page);
     await page.waitForFunction(()=>{
      const {context,run}=globalThis.__readDebugApi?.()??{};
      return context?.preview.status==='available'&&run?.state==='running';
     },null,{timeout});
    }
    const result=await run(page);
    assert.deepEqual(errors,[]);
    cases.push({name,...result});
   }catch(error){
    const snapshot=page&&await read(page).catch(()=>undefined);
    failures.push({name,pageErrors:errors,context:snapshot?.context,build:snapshot?.build,run:snapshot?.run});
    test.checkpoint({failures});
    process.stderr.write(`[${scope}] ${name} failed: ${error.stack??error}\n`);
    throw error;
   }finally{await context.close();}
  });
 }

 await browserCase('native-run-logs-stop-and-restart',async page=>{
  const marker='DEBUG_API_NATIVE_PRINT';
  await importProject(page,runProgram(marker));
  const first=await waitForRun(page,marker);
  assert.equal(first.build.status,'succeeded');
  assert.equal(first.build.diagnostics.observed,true);
  assert.equal(first.build.diagnostics.counts.error,0);
  await page.locator('#debug-tab').click();
  await page.locator('#debug-panel').waitFor({state:'visible'});
  await page.locator('#debug-open-docs').click();
  assert(await page.locator('#debug-docs #agent-replay').isVisible());
  assert.deepEqual(await page.evaluate(()=>Object.getOwnPropertyNames(window).filter(key=>key.startsWith('godotPlayground'))),['godotPlayground']);
  assert.deepEqual((await page.evaluate(()=>Object.keys(window.godotPlayground))).sort(),[
   'check','get_build','get_diagnostics','get_project_context','get_run','play','read_run_events','schemaVersion','stop','wait_for_event',
  ]);
  const example=await page.locator('#debug-api-example').textContent();
  assert(example?.includes('window.godotPlayground'));
  const literal=JSON.parse(JSON.stringify(await page.evaluate(example)));
  assert.equal(literal.run.result.runId,first.run.runId);
  await page.locator('#debug-run-example').click();
  await page.waitForFunction(()=>Boolean(document.querySelector('#debug-example-result')?.textContent?.includes('"ok": true')),null,{timeout});
  const displayed=JSON.parse(await page.locator('#debug-example-result').textContent());
  assert.deepEqual(displayed.context,literal.context);
  assert.deepEqual(displayed.build,literal.build);
  assert.deepEqual(displayed.run,literal.run);
  const log=await invoke(page,'read_run_events',{runId:first.run.runId,kinds:['log'],levels:['log']});
  assert.equal(log.ok,true);
  assert(log.result.items.some(({event})=>event.text?.includes(marker)&&event.untrusted));
  assert(log.result.items.every(({event})=>event.type==='log'&&event.level==='log'));
  await page.locator('#stop').click();
  const exit=await waitForExit(page,first.run.runId);
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.reason,'clean-exit');
  assert.equal(exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(exit.report.sessionFacts.entryCleanup,'complete');
  assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
  const terminals=(await readWire(page)).messages.filter(packet=>packet.type==='exit-report'&&packet.runId===first.run.runId);
  assert.equal(terminals.length,1);
  assert.deepEqual(exit.report.sessionFacts,terminals[0].sessionFacts);
  await page.locator('#run').click();
  const second=await waitForRun(page,marker,first.run.runId);
  assert.notEqual(second.build.attemptId,first.build.attemptId);
  assert.notEqual(second.run.generation,first.run.generation);
  assert.equal(second.build.editorRevision,first.build.editorRevision);
  assert.equal(second.build.artifact.buildKey,first.build.artifact.buildKey);
  await page.locator('#stop').click();
  await waitForExit(page,second.run.runId);
  return {runIds:[first.run.runId,second.run.runId],attemptIds:[first.build.attemptId,second.build.attemptId],exit};
 });

 await browserCase('type-error',async page=>{
  await importProject(page,'export function start(){ const answer: number = "not a number"; return void answer; }');
  const {context,build}=await read(page);
  assert.equal(context.activeRunId,null);
  assert.equal(build.status,'failed');
  assert.equal(build.artifact,undefined);
  assert.equal(build.preview?.runId,undefined);
  assert(build.diagnostics.observed&&build.diagnostics.counts.error>0);
  assert(build.diagnostics.items.some(item=>item.code===2322&&item.location?.file==='/src/start.ts'&&item.location.line>0));
  return {attemptId:build.attemptId,diagnostics:build.diagnostics};
 });

 await browserCase('agent-check-play-and-targeted-stop',async page=>{
  const beforeMarker='AGENT_P0_ORIGINAL_RUN';
  await importProject(page,runProgram(beforeMarker));
  const first=await waitForRun(page,beforeMarker);
  const original=await projectInput(page);
  const invalid=await editScript(page,'export function start(){ const answer: number = "not a number"; return void answer; }');
  const bad=unwrap(await invoke(page,'check',invalid));
  assert.equal(bad.status,'completed');
  assert.equal(bad.scope,'typecheck');
  assert(bad.diagnostics.items.some(item=>item.code===2322&&item.location?.file==='/src/start.ts'&&item.location.line>0));
  assert.equal((await read(page)).context.latestBuildAttemptId,first.build.attemptId);
  assert.equal((await read(page)).context.activeRunId,first.run.runId);

  // Wait for the editor's debounced check before observing diagnostic reads.
  await page.waitForFunction(revision=>window.__debugApiWire.requests.filter(item=>item.kind==='check'&&item.revision===revision).length>=2,
   invalid.expectedEditorRevision,{timeout});
  const checkRequests=(await readWire(page)).requests.filter(item=>item.kind==='check').length;
  const diagnostic=unwrap(await invoke(page,'get_diagnostics',{projectId:invalid.projectId,editorRevision:invalid.expectedEditorRevision,
   checkId:bad.checkId,path:'res://src/start.ts'}));
  assert.deepEqual(diagnostic.check.diagnostics,bad.diagnostics);
  assert.equal((await readWire(page)).requests.filter(item=>item.kind==='check').length,checkRequests);
  assert.equal((await invoke(page,'play',original)).error.code,'revision_conflict');

  const rejected=unwrap(await invoke(page,'play',invalid));
  const failed=unwrap(await invoke(page,'wait_for_event',{...rejected,until:'running',timeoutMs:60_000}));
  assert.equal(failed.outcome,'no_session');assert.equal(failed.build.status,'failed');
  assert.equal(failed.build.artifact,undefined);assert.equal(failed.run,undefined);
  assert.equal(unwrap(await invoke(page,'get_run',{runId:first.run.runId})).state,'running');

  const marker='AGENT_P0_REPAIRED_RUN';
  const repaired=await editScript(page,runProgram(marker));
  const checked=unwrap(await invoke(page,'check',repaired));
  assert.equal(checked.status,'completed');assert.equal(checked.diagnostics.counts.error,0);
  assert.notEqual(checked.sourceHash,bad.sourceHash);

  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#debug-docs #agent-replay').click();
  await page.waitForFunction(()=>document.getElementById('agent-status').textContent==='预览已启动',null,{timeout});
  const trace=await page.locator('#agent-trace').textContent();
  const second=await waitForRun(page,marker,first.run.runId);
  assert.equal(second.build.sourceHash,checked.sourceHash);
  assert.deepEqual(second.build.compilerIdentity,checked.compilerIdentity);
  assert.notEqual(second.build.attemptId,rejected.attemptId);
  assert.match(trace,/"name": "play"/);
  assert(trace.includes(second.build.attemptId)&&trace.includes(second.run.runId));
  const old=unwrap(await invoke(page,'stop',{runId:first.run.runId}));
  assert.equal(old.status,'exited');
  assert.equal(unwrap(await invoke(page,'get_run',{runId:second.run.runId})).state,'running');

  await page.locator('#agent-stop').click();
  const finished=unwrap(await invoke(page,'wait_for_event',{runId:second.run.runId,until:'exited',timeoutMs:60_000}));
  assert.equal(finished.outcome,'reached');
  const {exit}=finished.run;
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(exit.report.sessionFacts.entryCleanup,'complete');
  assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
  const terminals=(await readWire(page)).messages.filter(packet=>packet.type==='exit-report'&&packet.runId===second.run.runId);
  assert.equal(terminals.length,1);
  assert.deepEqual(terminals[0].sessionFacts,exit.report.sessionFacts);
  return {attemptIds:[rejected.attemptId,second.build.attemptId],runIds:[first.run.runId,second.run.runId],exit};
 });

 await browserCase('stop-replacement-during-startup',async page=>{
  const {run:initial}=await read(page);
  await page.locator('#source .monaco-editor').click({position:{x:120,y:30}});
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n// Verify that a replacement session can be stopped.\n');
  await page.waitForFunction(revision=>globalThis.__readDebugApi().context.editorRevision>revision,initial.revision,{timeout});
  // Leave the replacement in handshaking so the Stop button is tested before running.
  const previewPage=new URL('preview.html',previewRoot);
  await page.route(url=>url.origin===previewPage.origin&&url.pathname===previewPage.pathname,route=>
   route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.locator('#run').click();
  await page.waitForFunction(previous=>{
   const {run}=globalThis.__readDebugApi();
   return run?.runId!==previous&&run?.state==='handshaking';
  },initial.runId,{timeout});
  const {context,run:replacement}=await read(page);
  assert.equal(context.lastExitedRunId,initial.runId);
  assert.notEqual(replacement.revision,initial.revision);
  const stop=page.locator('#stop');
  assert.equal(await stop.isEnabled(),true,'A replacement session can be stopped before it reaches running');
  await stop.click();
  const exit=await waitForExit(page,replacement.runId);
  assert.equal(exit.evidence,'editor-local');
  assert.equal(exit.report.reason,'forced-frame-disposal');
  assert.equal(await stop.isDisabled(),true);
  assert.equal((await read(page)).context.activeRunId,null);
  return {runIds:[initial.runId,replacement.runId],exit};
 });

 await browserCase('agent-targeted-stop-keeps-accepted-play',async page=>{
  const marker='AGENT_P0_SCOPED_STOP';
  await importProject(page,runProgram(marker));
  const first=await waitForRun(page,marker);
  const input=await projectInput(page);
  const runId=first.run.runId;
  const {play,stop}=await page.evaluate(({input,runId})=>{
   const api=window.godotPlayground;
   return {play:api.play(input),stop:api.stop({runId})};
  },{input,runId});
  const {attemptId}=unwrap(play);
  assert.equal(unwrap(stop).status,'stopping');
  const observed=unwrap(await invoke(page,'wait_for_event',{attemptId,until:'running',timeoutMs:60_000}));
  assert.equal(observed.outcome,'reached');
  const second=await waitForRun(page,marker,runId);
  assert.equal(second.run.runId,observed.run.runId);
  assert.equal(second.run.attemptId,attemptId);
  assert.equal(unwrap(await invoke(page,'get_run',{runId})).exit.evidence,'host-report');
  assert.equal(unwrap(await invoke(page,'stop',{runId})).status,'exited');
  assert.equal(unwrap(await invoke(page,'get_run',{runId:second.run.runId})).state,'running');
  await invoke(page,'stop',{runId:second.run.runId});
  const exit=await waitForExit(page,second.run.runId);
  return {attemptId,runIds:[runId,second.run.runId],exit};
 });

 await browserCase('catalog-failure-keeps-preview-unavailable',async page=>{
  await page.addInitScript(()=>localStorage.setItem('godotjs-workbench-v1',JSON.stringify({tab:'debug',collapsed:false})));
  await page.route(editorRoot+'catalog.json',route=>route.fulfill({status:503}));
  await openPlayground(page);
  await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('无法加载示例目录'),null,{timeout});
  const {context}=await read(page);
  assert.equal(context.release.status,'available');
  assert.equal(context.release.value.releaseId,release.id);
  assert.deepEqual(context.preview,{status:'unsupported',reason:'工作台加载失败，未启动预览'});
  assert.equal(context.projectId,null);
  assert.equal(context.latestBuildAttemptId,null);
  assert.equal(context.activeRunId,null);
  assert.deepEqual((await readWire(page)).messages,[]);
  assert.equal(await page.locator('#console-tab').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#console-panel').isVisible(),true);
  return {release:context.release,preview:context.preview};
 },{waitForInitialRun:false});

 await browserCase('prepare-rejection-keeps-active-run',async page=>{
  const marker='DEBUG_API_OLD_RUN_LOG';
  await importProject(page,runProgram(marker));
  const first=await waitForRun(page,marker);
  await page.locator('#debug-tab').click();
  const frame=await page.locator('#preview iframe').elementHandle();
  await page.evaluate(()=>{globalThis.__debugApiWire.rejectNext=true;});
  const attempt=unwrap(await invoke(page,'play',await projectInput(page)));
  const observed=unwrap(await invoke(page,'wait_for_event',{...attempt,until:'running',timeoutMs:60_000}));
  assert.equal(observed.outcome,'no_session');
  const {context,build}=await read(page);
  assert.equal(build.status,'succeeded');
  assert(build.artifact.artifactId);
  assert.equal(build.preview.error.diagnostic.code,'E_RUNTIME_TARGET_ENGINE');
  assert.match(build.preview.error.diagnostic.message,/E_RUNTIME_TARGET_ENGINE/);
  assert.equal(build.preview.runId,undefined);
  assert.notEqual(build.attemptId,first.build.attemptId);
  assert.equal(context.activeRunId,first.run.runId);
  const old=await read(page,first.run.runId);
  assert.equal(old.run.state,'running');
  assert.equal(old.run.exit,undefined);
  assert(old.events.some(({event})=>event.type==='log'&&event.text?.includes(marker)));
  assert(await frame.evaluate(original=>original===document.querySelector('#preview iframe')));
  assert((await readWire(page)).builds.at(-1).rejected);
  await page.locator('#debug-build[data-status="succeeded"][data-preview-status="rejected"]').waitFor();
  assert.equal(await page.locator('#debug-run').getAttribute('data-run-id'),first.run.runId);
  await page.locator(`#debug-linked-build[data-attempt-id="${first.build.attemptId}"]`).waitFor();
  await page.locator('#debug-linked-build-details summary').click();
  await page.waitForFunction(()=>Boolean(document.querySelector('#debug-linked-build-json')?.textContent),null,{timeout});
  assert.deepEqual(JSON.parse(await page.locator('#debug-linked-build-json').textContent()),JSON.parse(JSON.stringify(first.build)));
  assert.match(await page.locator('#debug-events').textContent(),new RegExp(marker));
  await page.locator('#stop').click();
  await waitForExit(page,first.run.runId);
  return {attemptId:build.attemptId,runId:first.run.runId,error:build.preview.error};
 });

 await browserCase('session-start-failure',async page=>{
  await importProject(page,failureProgram);
  await page.waitForFunction(()=>Boolean(globalThis.__readDebugApi().build?.preview?.runId),null,{timeout});
  const {build}=await read(page);
  const runId=build.preview.runId;
  const observed=unwrap(await invoke(page,'wait_for_event',{runId,until:'exited',timeoutMs:60_000}));
  assert.equal(observed.outcome,'reached');
  const exit=observed.run.exit;
  const snapshot=await read(page,runId);
  assert.equal(snapshot.run.attemptId,build.attemptId);
  assert(snapshot.events.some(({event})=>event.type==='log'&&event.text?.includes('DEBUG_API_START_FAILURE_LOG')));
  const terminal=(await readWire(page)).messages.find(packet=>packet.type==='exit-report'&&packet.runId===runId);
  assert(terminal,'The actual host settled the startup failure');
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.sessionFacts.failure.kind,'runtime');
  assert.match(exit.report.sessionFacts.failure.message,/DEBUG_API_START_FAILURE/);
  assert.deepEqual(exit.report.sessionFacts,terminal.sessionFacts);
  const diagnostic=unwrap(await invoke(page,'get_diagnostics',{projectId:build.projectId,editorRevision:build.editorRevision,runId}));
  assert.equal(diagnostic.run.evidence,'host-report');
  assert.match(diagnostic.run.diagnostic.message,/DEBUG_API_START_FAILURE/);
  return {attemptId:build.attemptId,runId,exit};
 });

 await browserCase('lost-preview-host',async page=>{
  const marker='DEBUG_API_HOST_LOSS_LOG';
  await importProject(page,runProgram(marker));
  const {run}=await waitForRun(page,marker);
  await page.bringToFront();
  assert.equal(await page.evaluate(()=>document.visibilityState),'visible');
  await page.locator('#preview iframe').evaluate(frame=>frame.remove());
  const observed=unwrap(await invoke(page,'wait_for_event',{runId:run.runId,until:'exited',timeoutMs:60_000}));
  assert.equal(observed.outcome,'reached');
  const exit=observed.run.exit;
  assert.equal(exit.evidence,'editor-local');
  assert.equal(exit.report.reason,'forced-frame-disposal');
  for(const field of ['engineOutcome','hostCleanup','sessionFacts','code'])assert.equal(exit.report[field],undefined,field);
  assert(!(await readWire(page)).messages.some(packet=>packet.type==='exit-report'&&packet.runId===run.runId));
  return {runId:run.runId,exit};
 });

 return withAcceptanceContext({status:'passed',scope,engineExecuted,cases,profile:release.runtimeProfile,releaseId:release.id,descriptorHash,candidateId},{directory,browser});
}});
