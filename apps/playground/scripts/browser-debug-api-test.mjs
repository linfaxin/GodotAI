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
 const openPlayground=(page,presentationBackend='direct')=>page.goto(editorRoot+'?project=native&presentationBackend='+presentationBackend+'&previewOrigin='+encodeURIComponent(previewRoot),{waitUntil:'domcontentloaded'});
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

 const project=(source,settings='')=>({schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,
  launch:{kind:'script',module:'res://src/start.ts',export:'start'},
  files:{'/src/start.ts':source,'/project.godot':'config_version=5\n[application]\nconfig/name="Debug API acceptance"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'+settings},
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
 async function nextBuild(page,previous){
  const result=await page.waitForFunction(previous=>{
   const {build}=globalThis.__readDebugApi();
   return build&&build.attemptId!==previous&&build.status!=='pending'&&build.attemptId;
  },previous,{timeout});
  return result.jsonValue();
 }
 async function importProject(page,source,settings){
  const before=(await read(page)).context.latestBuildAttemptId;
  await page.locator('#import').setInputFiles({name:'debug-api.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project(source,settings)))});
  return nextBuild(page,before);
 }
 async function waitForRun(page,marker,attemptId){
  const result=await page.waitForFunction(({marker,attemptId})=>{
   const result=window.godotPlayground.get_build({attemptId});
   if (!result.ok) throw Error(JSON.stringify(result.error));
   const build=result.result;
   if (build.status==='failed'||build.status==='cancelled'||['skipped','rejected'].includes(build.preview?.status)) throw Error(JSON.stringify(build));
   if (build.preview?.status!=='session-created') return false;
   const {run,events}=globalThis.__readDebugApi(build.preview.runId);
   if (run?.exit) throw Error(JSON.stringify(run.exit));
   return run?.state==='running'&&events?.some(({event})=>event.type==='log'&&event.text?.includes(marker))&&run.runId;
  },{marker,attemptId},{timeout});
  const {run,context}=await read(page,await result.jsonValue());
  const build=unwrap(await invoke(page,'get_build',{attemptId}));
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
 async function browserCase(name,run,{waitForInitialRun=true,deviceScaleFactor=1,presentationBackend='direct'}={}){
  await test.step(name,async()=>{
   const context=await browser.newContext({viewport:{width:1536,height:1000},deviceScaleFactor});
   const errors=[];
   let page;
   try{
    await context.addInitScript(observeProduct);
    page=await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on('pageerror',error=>errors.push(String(error)));
    if(waitForInitialRun){
     await openPlayground(page,presentationBackend);
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
  const first=await waitForRun(page,marker,await importProject(page,runProgram(marker)));
  assert.equal(first.build.status,'succeeded');
  assert.equal(first.build.diagnostics.observed,true);
  assert.equal(first.build.diagnostics.counts.error,0);
  await page.locator('#debug-tab').click();
  await page.locator('#debug-panel').waitFor({state:'visible'});
  await page.locator('#debug-open-docs').click();
  assert(await page.locator('#debug-docs #agent-replay').isVisible());
  assert.deepEqual(await page.evaluate(()=>Object.getOwnPropertyNames(window).filter(key=>key.startsWith('godotPlayground'))),['godotPlayground']);
  assert.deepEqual((await page.evaluate(()=>Object.keys(window.godotPlayground))).sort(),[
   'check','game_input','get_build','get_diagnostics','get_project_context','get_run','play','read_run_events','schemaVersion',
   'screenshot','stop','wait_for_event','wait_for_input',
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
  const second=await waitForRun(page,marker,await nextBuild(page,first.build.attemptId));
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
  const first=await waitForRun(page,beforeMarker,await importProject(page,runProgram(beforeMarker)));
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
  const second=await waitForRun(page,marker,await nextBuild(page,rejected.attemptId));
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
  const first=await waitForRun(page,marker,await importProject(page,runProgram(marker)));
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
  const second=await waitForRun(page,marker,attemptId);
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
  const first=await waitForRun(page,marker,await importProject(page,runProgram(marker)));
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
  const {run}=await waitForRun(page,marker,await importProject(page,runProgram(marker)));
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

 await browserCase('unsupported-playtest-keeps-current-preview',async page=>{
  const projects=await page.locator('#demos [data-demo]').count();
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-replay').click();
  await page.waitForFunction(()=>document.querySelector('#agent-status')?.textContent==='预览已启动',null,{timeout});
  const before=await read(page);
  assert.equal(before.run.configuration.presentationBackend,'bitmap');
  assert.equal(before.run.interaction.supported,false);
  assert.equal(await page.locator('#agent-stop').isEnabled(),true);
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.match(await page.locator('#agent-status').textContent(),/Worker Direct/);
  const after=await read(page);
  assert.equal(after.context.projectId,before.context.projectId);
  assert.equal(after.context.latestBuildAttemptId,before.context.latestBuildAttemptId);
  assert.equal(after.context.activeRunId,before.run.runId);
  assert.equal(after.run.state,'running');
  assert.equal(await page.locator('#demos [data-demo]').count(),projects);
  assert.equal(await page.locator('#agent-stop').isEnabled(),true);
  return {runId:after.run.runId,projectId:after.context.projectId};
 },{presentationBackend:'bitmap'});

 await browserCase('interaction-demo-reuses-unedited-sample',async page=>{
  const openDocs=async()=>{
   const docsButton=page.locator('#debug-open-docs');
   if(!await docsButton.isVisible())await page.locator('#debug-tab').click();
   if(!await page.locator('#debug-docs').isVisible())await docsButton.click();
  };
  const playtest=async()=>{
   await page.locator('#agent-playtest').click();
   await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
   assert.equal(await page.locator('#agent-status').textContent(),'已验证画面变化并取得退出回执');
   return (await read(page)).context.projectId;
  };
  const count=()=>page.locator('#demos [data-demo]').count();
  const baseline=await count();
  await openDocs();
  const sample=await playtest();
  assert.equal(await playtest(),sample);
  assert.equal(await count(),baseline+1);
  await page.waitForFunction(()=>document.querySelector('#saved')?.textContent==='已自动保存',null,{timeout});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(id=>{
   const {context,run}=globalThis.__readDebugApi?.()??{};
   return context?.preview.status==='available'&&run?.state==='running'&&document.querySelector(`[data-demo="${id}"]`);
  },sample,{timeout});
  await openDocs();
  assert.equal(await playtest(),sample);
  assert.equal(await count(),baseline+1);
  const code='export default class Main {} // retained playtest edit';
  await editScript(page,code);
  await page.waitForFunction(()=>document.querySelector('#saved')?.textContent==='已自动保存',null,{timeout});
  const replacement=await playtest();
  assert.notEqual(replacement,sample);
  assert.equal(await playtest(),replacement);
  assert.equal(await count(),baseline+2);
  await page.locator('#project-switcher').click();
  await page.locator(`[data-demo="${sample}"]`).click();
  const edited=await page.evaluate(()=>globalThis.__playgroundWorkbench.inspect().project);
  assert.equal(edited.files[edited.entry],code);
  return {sample,replacement};
 });

 await browserCase('direct-screenshot-and-programmatic-input', async page=>{
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'已验证画面变化并取得退出回执');
  assert.equal(await page.locator('#agent-observations img').count(),2);
  assert.match(await page.locator('#agent-trace').textContent(),/"byteLength"/);
  assert.doesNotMatch(await page.locator('#agent-trace').textContent(),/"bytes":/);

  const capture=runId=>page.evaluate(async id=>{
   const result=await window.godotPlayground.screenshot({runId:id});
   if(!result.ok)return result;
   const {bytes,...frame}=result.result;
   const image=await createImageBitmap(new Blob([bytes],{type:frame.mimeType}));
   try {
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {ok:true,result:{...frame,center:Array.from(ctx.getImageData(image.width>>1,image.height>>1,1,1).data),
     target:Array.from(ctx.getImageData(Math.floor(image.width*.09),Math.floor(image.height*.12),1,1).data)}};
   }finally{image.close();}
  },runId);
  const action=async (runId,gesture)=>{
   const {operationId}=unwrap(await invoke(page,'game_input',{runId,gesture}));
   return unwrap(await invoke(page,'wait_for_input',{runId,operationId,timeoutMs:7000})).operation;
  };
  const play=async ()=>{
   const {attemptId}=unwrap(await invoke(page,'play',await projectInput(page)));
   return unwrap(await invoke(page,'wait_for_event',{attemptId,until:'running',timeoutMs:60000})).run.runId;
  };
  const runId=await play();
  let before=unwrap(await capture(runId));
  const initialSerial=before.renderSerial;
  assert.equal(before.run.runId,runId);
  assert.deepEqual(before.center,[255,0,0,255]);assert.deepEqual(before.target,[0,0,255,255]);
  const pressed=await action(runId,{kind:'key_tap',code:'Space'});
  assert.equal(pressed.status,'dispatched');
  assert.deepEqual([pressed.down,pressed.up],['dispatched','dispatched']);
  assert.equal(pressed.nativeConsumption,'unconfirmed');
  await page.waitForFunction(id=>window.godotPlayground.read_run_events({runId:id,limit:100}).result.items.some(x=>x.event.text?.includes('试玩释放 Space')),runId,{timeout});
  const after=unwrap(await capture(runId));
  assert(after.renderSerial>before.renderSerial);
  assert.deepEqual(after.center,[0,255,0,255]);
  const canvas=page.frameLocator('#preview iframe').locator('canvas');
  const compositor=await canvas.screenshot();
  const external=await page.evaluate(async bytes=>{
   const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));
   const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();
   return Array.from(ctx.getImageData(canvas.width>>1,canvas.height>>1,1,1).data);
  },Array.from(compositor));
  assert.deepEqual(external,after.center);
  assert.equal(after.geometry.dpr,2);
  await canvas.focus();
  await page.keyboard.down('ArrowRight');
  try {
   const conflict=await action(runId,{kind:'key_tap',code:'ArrowRight'});
   assert.equal(conflict.status,'not_dispatched');assert.equal(conflict.reason,'input_conflict');
  } finally {await page.keyboard.up('ArrowRight');}
  await page.setViewportSize({width:1100,height:740});
  const resizeDeadline=Date.now()+5000;
  do { before=unwrap(await capture(runId)); }
  while(before.geometry.epoch<=after.geometry.epoch&&Date.now()<resizeDeadline);
  assert(before.geometry.epoch>after.geometry.epoch);assert.deepEqual(before.target,[0,0,255,255]);
  const stale=await action(runId,{kind:'primary_click',x:.09,y:.12,geometryEpoch:after.geometry.epoch});
  assert.equal(stale.status,'not_dispatched');assert.equal(stale.reason,'geometry_conflict');
  before=unwrap(await capture(runId));
  assert.deepEqual(before.target,[0,0,255,255]);
  const click=await action(runId,{kind:'primary_click',x:.09,y:.12,geometryEpoch:before.geometry.epoch});
  assert.equal(click.status,'dispatched');
  assert.deepEqual(unwrap(await capture(runId)).target,[255,255,0,255]);
  const race=await page.evaluate(async id=>{
   const api=window.godotPlayground,controller=new AbortController();
   const first=api.screenshot({runId:id},controller.signal);
   controller.abort();
   return [(await first).error.code,(await api.screenshot({runId:id})).error.code];
  },runId);
  assert.deepEqual(race,['cancelled','busy']);
  unwrap(await invoke(page,'stop',{runId}));
  const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');
  const newRunId=await play();
  assert.notEqual(newRunId,runId);
  assert.deepEqual(unwrap(await capture(newRunId)).center,[255,0,0,255]);
  assert.deepEqual(unwrap(await invoke(page,'wait_for_input',{runId,operationId:pressed.operationId,timeoutMs:0})).operation,pressed);
  assert.equal((await invoke(page,'game_input',{runId,gesture:{kind:'key_tap',code:'Space'}})).error.code,'run_ended');
  assert.equal((await invoke(page,'screenshot',{runId})).error.code,'run_ended');
  unwrap(await invoke(page,'stop',{runId:newRunId}));
  await waitForExit(page,newRunId);
  return {runId,newRunId,input:pressed,click,renderSerials:[initialSerial,after.renderSerial,before.renderSerial],exit};
 },{deviceScaleFactor:2});

 await browserCase('interaction-quit-and-fatal-during-dispatch', async page=>{
  const results=[];
  for(const fatal of [false,true]){
   const marker=fatal?'INTERACTION_FATAL_ON_DOWN':'INTERACTION_QUIT_ON_DOWN', ready=marker+'_READY';
   const attemptId=await importProject(page,`import {Callable, Color, ColorRect, InputEvent, InputEventMouseButton, Node, Vector2, print} from 'godot';
import type {EngineRuntimeHost} from '@godot-js/react/engine';
export function start(ctx: {mount: Node; host: EngineRuntimeHost}) {
  const rect=new ColorRect(); rect.size=new Vector2(4096,4096); rect.color=new Color(1,0,0,1); ctx.mount.add_child(rect);
  const root=ctx.mount.get_window()!;
  const onInput=Callable.create((event: InputEvent)=>{
    if (!(event instanceof InputEventMouseButton) || event.button_index!==1 || !event.pressed) return;
    print('${marker}');
    ${fatal?"ctx.host.reportDiagnostic({kind:'runtime',message:'"+marker+"'});":"ctx.mount.get_tree()!.quit(0);"}
  });
  root.window_input.connect(onInput);
  print('${ready}');
  return ()=>root.window_input.disconnect(onInput);
}`);
   const {run:{runId}}=await waitForRun(page,ready,attemptId);
   const epoch=await page.evaluate(async runId=>{
    const shot=await window.godotPlayground.screenshot({runId});
    if(!shot.ok)throw Error(shot.error.code);
    return shot.result.geometry.epoch;
   },runId);
   const gesture={kind:'primary_click',x:.5,y:.5,geometryEpoch:epoch};
   const {operationId}=unwrap(await invoke(page,'game_input',{runId,gesture}));
   const {operation}=unwrap(await invoke(page,'wait_for_input',{runId,operationId}));
   assert.equal(operation.down,'dispatched');
   assert.equal(operation.up,fatal?'not_dispatched':'dispatched');
   assert.equal(operation.status,fatal?'partial':'dispatched');
   const exit=await waitForExit(page,runId);
   assert.equal(exit.evidence,'host-report');
   assert.equal(exit.report.reason,fatal?'crashed':'clean-exit');
   if(fatal)assert.match(exit.report.sessionFacts.failure.message,new RegExp(marker));
   else assert.equal(exit.report.sessionFacts.nativeExit.code,0);
   assert.deepEqual(unwrap(await invoke(page,'wait_for_input',{runId,operationId,timeoutMs:0})).operation,operation);
   results.push({operation,exit});
  }
  return {results};
 });

 await browserCase('interaction-demo-reports-forced-disposal', async page=>{
  await page.evaluate(()=>{
   const send=MessagePort.prototype.postMessage;
   MessagePort.prototype.postMessage=function(packet,...args){
    if(packet?.type==='stop'&&packet.protocolVersion===2&&document.querySelector('#agent-observations')?.hidden===false){
     document.querySelector('#preview iframe')?.remove();
     return;
    }
    return send.call(this,packet,...args);
   };
  });
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-observations img').count(),2);
  assert.equal(await page.locator('#agent-status').textContent(),'已验证画面变化，编辑器已关闭预览，未收到退出回执');
  const {run}=await read(page);
  assert.equal(run.exit.evidence,'editor-local');
  assert.equal(run.exit.report.reason,'forced-frame-disposal');
  return {runId:run.runId,exit:run.exit};
 });

 await browserCase('interaction-demo-cancels-delayed-start', async page=>{
  await page.evaluate(()=>{
   const send=Worker.prototype.postMessage,schedule=window.setTimeout;
   Worker.prototype.postMessage=function(packet,...args){
    if(this.isCompiler&&packet?.kind==='compile'&&!window.__releaseDelayedCompile){
     window.__releaseDelayedCompile=()=>{
      Worker.prototype.postMessage=send;
      window.setTimeout=schedule;
      send.call(this,packet,...args);
     };
     return;
    }
    return send.call(this,packet,...args);
   };
   window.setTimeout=function(callback,ms,...args){
    const demoWaiting=document.querySelector('#agent-status')?.textContent==='正在启动试玩示例';
    return schedule.call(this,callback,ms===30000&&demoWaiting?20:ms,...args);
   };
  });
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>window.__releaseDelayedCompile&&!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'试玩示例未进入运行状态');
  const {build:{attemptId,status}}=await read(page);
  assert.equal(status,'pending');
  await page.evaluate(()=>window.__releaseDelayedCompile());
  const result=unwrap(await invoke(page,'wait_for_event',{attemptId,until:'running',timeoutMs:30000}));
  assert.equal(result.outcome,'no_session');
  assert.equal(result.build.status,'succeeded');
  assert.equal(result.build.preview.status,'skipped');
  return {attemptId,preview:result.build.preview};
 });

 await browserCase('interaction-frame-alpha-and-context-loss', async page=>{
  // Keep preparation observable after the previous run exits.
  await page.evaluate(()=>{
   const digest=SubtleCrypto.prototype.digest;
   SubtleCrypto.prototype.digest=async function(...args){
    const result=await digest.apply(this,args);
    await new Promise(resolve=>setTimeout(resolve,200));
    return result;
   };
  });
  const attemptId=await importProject(page,`import {Callable, Color, ColorRect, InputEvent, InputEventKey, JavaScriptBridge, Key, Node, RenderingServer, Vector2, print} from 'godot';
export function start(ctx: {mount: Node}) {
  const root=ctx.mount.get_window()!;
  root.transparent_bg=true;
  const rect=new ColorRect(); rect.color=new Color(1,0,0,1); rect.size=new Vector2(4096,4096); ctx.mount.add_child(rect);
  const input=Callable.create((event: InputEvent)=>{
    if (!(event instanceof InputEventKey) || !event.pressed) return;
    if (event.physical_keycode===Key.KEY_SPACE) {rect.hide();print('INTERACTION_ALPHA_HIDDEN');}
    if (event.physical_keycode===Key.KEY_RIGHT) {
      RenderingServer.render_loop_enabled=false;
      print('INTERACTION_RENDER_PAUSED');
    }
    if (event.physical_keycode===Key.KEY_LEFT) {
      RenderingServer.frame_post_draw.connect(Callable.create(()=>{
        JavaScriptBridge.eval("document.getElementById('canvas').GLctxObject.GLctx.getExtension('WEBGL_lose_context').loseContext()",true);
      }),4);
      RenderingServer.render_loop_enabled=true;
    }
  });
  root.window_input.connect(input);
  print('INTERACTION_ALPHA_READY');
  return ()=>root.window_input.disconnect(input);
}`,'\n[display]\nwindow/per_pixel_transparency/allowed=true\n');
  const {run:{runId}}=await waitForRun(page,'INTERACTION_ALPHA_READY',attemptId);
  const rgba=()=>page.evaluate(async id=>{
   const frame=await window.godotPlayground.screenshot({runId:id});
   if(!frame.ok)return frame;
   const bitmap=await createImageBitmap(new Blob([frame.result.bytes],{type:frame.result.mimeType}));
   const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
   try{ctx.drawImage(bitmap,0,0);return Array.from(ctx.getImageData(canvas.width>>1,canvas.height>>1,1,1).data);}
   finally{bitmap.close();}
  },runId);
  assert.deepEqual(await rgba(),[255,0,0,255]);
  const tap=async code=>{
   const {operationId}=unwrap(await invoke(page,'game_input',{runId,gesture:{kind:'key_tap',code}}));
   const receipt=unwrap(await invoke(page,'wait_for_input',{runId,operationId}));
   assert.equal(receipt.operation.status,'dispatched');
  };
  await tap('Space');
  await page.waitForFunction(id=>window.godotPlayground.read_run_events({runId:id,limit:100}).result.items.some(x=>x.event.text?.includes('INTERACTION_ALPHA_HIDDEN')),runId,{timeout});
  assert.deepEqual(await rgba(),[0,0,0,0]);
  await tap('ArrowRight');
  await page.waitForFunction(id=>window.godotPlayground.read_run_events({runId:id,limit:100}).result.items.some(x=>x.event.text?.includes('INTERACTION_RENDER_PAUSED')),runId,{timeout});
  const duringLoss=await page.evaluate(async runId=>{
   const api=window.godotPlayground;
   const capture=api.screenshot({runId,timeoutMs:7000});
   const input=api.game_input({runId,gesture:{kind:'key_tap',code:'ArrowLeft'}});
   return {input,capture:await capture};
  },runId);
  unwrap(duringLoss.input);
  assert.equal(duringLoss.capture.ok,false);
  assert(['capture_failed','run_ended'].includes(duringLoss.capture.error.code),JSON.stringify(duringLoss.capture));
  const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');
  assert.match(exit.report.diagnostic?.message??'',/E_WORKER_WEBGL_CONTEXT_LOST/);
  return {runId,capture:duringLoss.capture.error.code,exit};
 });

 return withAcceptanceContext({status:'passed',scope,engineExecuted,cases,failures,profile:release.runtimeProfile,releaseId:release.id,descriptorHash,candidateId},{directory,browser});
}});
