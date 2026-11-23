import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultTestDirectory,launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest,listenBrowserTestServer as listen,closeBrowserTestServer as close} from './browser-contract-report.mjs';
import {createRuntimePropertiesDemo} from '../src/runtime-properties-demo.ts';
import {exportProject} from '../src/project-model.ts';

const selectedCase=process.env.PLAYGROUND_DEBUG_API_CASE;
const scope=selectedCase?'actual-product-debug-api-case':'actual-product-debug-api';
const observationCase='runtime-tree-node-and-png';
const writeCase='runtime-set-position';
const writeBoundariesCase='runtime-set-boundaries';
const readOnlyCase='runtime-set-unsupported';
const propertiesCase='runtime-script-properties';
const propertiesBoundariesCase='runtime-script-properties-boundaries';
const propertiesUnsupportedCase='runtime-script-properties-unsupported';
const publicMethods=['check','describe_runtime_properties','game_input','get_build','get_diagnostics','get_project_context','get_run','get_runtime_tree',
 'inspect_runtime_node','play','read_run_events','read_runtime_properties','runtime_set','schemaVersion','screenshot','stop','summer_call','wait_for_event','wait_for_input','write_runtime_property'];
await runReportedBrowserTest({scope,reportFile:process.env.PLAYGROUND_DEBUG_API_REPORT,run:async test=>{
 const directory=path.resolve(defaultTestDirectory());
 const {site,release,candidateId,descriptorHash}=await test.preflight(directory,{worker:true});
 const observationDeclared=release.runtimeAbi?.observation===1;
 const writeDeclared=release.runtimeAbi?.runtimeWrite===1;
 const propertiesDeclared=release.runtimeAbi?.runtimeProperties===1;
 if([propertiesCase,propertiesBoundariesCase].includes(selectedCase)&&(!propertiesDeclared||site.engineTarget!=='template_debug'))
  throw Error('E_TEST_RUNTIME_PROPERTIES_REQUIRED: Full Engine debug and runtime properties ABI 1 are required');
 if(selectedCase===propertiesUnsupportedCase&&(propertiesDeclared||!writeDeclared||site.engineTarget!=='template_debug'))
  throw Error('E_TEST_RUNTIME_PROPERTIES_LEGACY_REQUIRED: this case requires the old write-1 Full Engine debug template');
 if(selectedCase===observationCase&&!observationDeclared)throw Error('E_TEST_RUNTIME_OBSERVATION_REQUIRED: this case requires runtime observation ABI 1');
 if([writeCase,writeBoundariesCase].includes(selectedCase)&&(!writeDeclared||site.engineTarget!=='template_debug'))
  throw Error('E_TEST_RUNTIME_WRITE_REQUIRED: Full Engine debug and runtime write ABI 1 are required');
 if(selectedCase===readOnlyCase&&(writeDeclared||!observationDeclared||site.engineTarget!=='template_debug'))
  throw Error('E_TEST_RUNTIME_READ_ONLY_REQUIRED: Full Engine debug with observation ABI 1 and no write ABI is required');
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
    if(data?.protocolVersion===2&&typeof data.runId==='string'&&['phase','log','exit-report','runtime-write-result','runtime-property-result'].includes(data.type)&&wire.messages.length<4096)wire.messages.push(data);
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
 async function importPropertyFixture(page){
  const document=exportProject(createRuntimePropertiesDemo(release.runtimeProfile));
  document.files['/src/Player.ts']=`import {Node2D,Vector2,Variant,ResourceLoader,print} from 'godot';
import {createClassBinder} from 'godot.annotations';
const bind=createClassBinder();
@bind()
export default class PropertyBoundary extends Node2D {
 @bind.export(Variant.Type.TYPE_INT) accessor health:number=100;
 @bind.export(Variant.Type.TYPE_STRING) accessor mode:string='normal';
 @bind.export(Variant.Type.TYPE_STRING) accessor text:string='initial';
 @bind.export(Variant.Type.TYPE_INT) accessor reads:number=0;
 @bind.export(Variant.Type.TYPE_INT) accessor writes:number=0;
 private stored=100;
 @bind.export(Variant.Type.TYPE_INT)
 get probe():number {
  this.reads++;
  if(this.mode==='getter_throw')throw Error('EXPECTED_PROPERTY_GETTER');
  if(this.mode==='boxed')return new Number(7) as any;
  if(this.mode==='swap_script'){
   const value=this.stored;
   this.set_script(ResourceLoader.load('res://src/Replacement.ts'));
   return value;
  }
  if(this.mode==='quit')this.get_tree()!.quit();
  return this.stored;
 }
 set probe(value:number){
  this.writes++;
  this.stored=this.mode==='clamp'?Math.min(100,value):value;
  if(this.mode==='setter_throw')throw Error('EXPECTED_PROPERTY_SETTER');
 }
 @bind.export(Variant.Type.TYPE_VECTOR2)
 get exported_vector():Vector2 {this.reads++;return new Vector2(1,2);}
 _ready(){print('PROPERTY_BOUNDARIES_READY');}
}`;
  document.files['/src/Replacement.ts']=`import {Node2D,Vector2,Variant} from 'godot';
import {createClassBinder} from 'godot.annotations';
const bind=createClassBinder();
@bind()
export default class Replacement extends Node2D {
 // Existing set_script rebinding changes the prototype without constructing
 // new auto-accessor private slots. Native position is stable backing state.
 @bind.export(Variant.Type.TYPE_INT)
 get probe():number {return this.position.x+436;}
 set probe(value:number){this.position=new Vector2(value-436,this.position.y);}
}`;
  const before=(await read(page)).context.latestBuildAttemptId;
  await page.locator('#import').setInputFiles({name:'property-boundaries.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
  const ready=await waitForRun(page,'PROPERTY_BOUNDARIES_READY',await nextBuild(page,before));
  const sourceDocument=await exportSourceDocument(page);
  assert.deepEqual(sourceDocument.files,document.files,'Exported scene sources match the imported boundary fixture');
  return {...ready,sourceDocument};
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
 const assertPublicTools=async page=>assert.deepEqual((await page.evaluate(()=>Object.keys(window.godotPlayground))).sort(),publicMethods);
 async function exportSourceDocument(page){
  const downloaded=page.waitForEvent('download');
  await page.locator('#project-menu').evaluate(node=>node.open=true);
  await page.locator('#export').click();
  const document=JSON.parse(await readFile(await(await downloaded).path(),'utf8'));
  await page.locator('#project-menu').evaluate(node=>node.open=false);
  return document;
 }
 async function savePanelImages(page,stem){
  const frames=await page.locator('#agent-observations img').evaluateAll(async images=>Promise.all(images.map(async image=>{
   const png=await(await fetch(image.src)).blob();
   return {caption:image.alt,bytes:Array.from(new Uint8Array(await png.arrayBuffer()))};
  })));
  const images=[];
  for(const [index,frame]of frames.entries()){
   const bytes=Buffer.from(frame.bytes);
   assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   const metadata={caption:frame.caption,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
   if(process.env.PLAYGROUND_DEBUG_API_REPORT){
    const report=path.resolve(process.env.PLAYGROUND_DEBUG_API_REPORT),directory=path.dirname(report);
    metadata.png=path.basename(report,'.json')+'-'+stem+'-'+index+'.png';
    await mkdir(directory,{recursive:true});await writeFile(path.join(directory,metadata.png),bytes);
   }
   images.push(metadata);
  }
  return images;
 }
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
  if(selectedCase&&name!==selectedCase)return;
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
    const diagnostics=page&&await page.evaluate(()=>{
     const api=window.godotPlayground,context=api?.get_project_context().result;
     return context?.projectId&&context.editorRevision!==null?api.get_diagnostics({projectId:context.projectId,editorRevision:context.editorRevision}):undefined;
    }).catch(()=>undefined);
    const agent=page&&await page.evaluate(()=>({status:document.querySelector('#agent-status')?.textContent,
     trace:document.querySelector('#agent-trace')?.textContent,results:document.querySelector('#agent-write-results')?.textContent})).catch(()=>undefined);
    failures.push({name,pageErrors:errors,context:snapshot?.context,build:snapshot?.build,run:snapshot?.run,diagnostics,agent});
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
  assert(await page.locator('#agent-tools #agent-replay').isVisible());
  await page.locator('#debug-open-docs').click();
  assert.deepEqual(await page.evaluate(()=>Object.getOwnPropertyNames(window).filter(key=>key.startsWith('godotPlayground'))),['godotPlayground']);
  await assertPublicTools(page);
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
  await page.locator('#agent-tools #agent-replay').click();
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
  await page.locator('#debug-open-console').click();
  const capabilities=page.getByTestId('api-console-context');
  assert.match(await capabilities.innerText(),/截图与输入\s+不支持/);
  assert.match(await capabilities.innerText(),/公开属性访问\s+不支持/);
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

 if(!observationDeclared)await browserCase('legacy-observation-unsupported',async page=>{
  const {run}=await read(page);
  assert.deepEqual(run.observation,{supported:false,ready:false});
  assert.equal(run.interaction.ready,true);
  assert.equal((await invoke(page,'get_runtime_tree',{runId:run.runId})).error.code,'unsupported');
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'已验证画面变化并取得退出回执');
  assert.deepEqual(await page.locator('#agent-observations figcaption').allTextContents(),['输入前','输入后']);
  return {observation:run.observation,legacyPlaytest:true};
 });

 if(observationDeclared&&!writeDeclared&&site.engineTarget==='template_debug')await browserCase(readOnlyCase,async page=>{
  await assertPublicTools(page);
  const {run}=await read(page);
  const {runId}=run;
  assert.deepEqual(run.configuration,{executionBackend:'worker',presentationBackend:'direct'});
  assert.deepEqual(run.runtimeWrite,{supported:false,ready:false});
  assert.deepEqual(run.observation,{supported:true,ready:true,version:1});
  const tree=unwrap(await invoke(page,'get_runtime_tree',{runId,depth:3}));
  const node=tree.nodes.find(node=>node.type==='Node2D')??tree.nodes[0];
  assert(node);
  const write=await invoke(page,'runtime_set',{runId,path:node.path,expectedInstanceId:node.instanceId,
   property:'position',value:{x:192,y:256}});
  assert.equal(write.error.code,'unsupported');
  const sample=unwrap(await invoke(page,'inspect_runtime_node',{runId,path:node.path,properties:['position']}));
  assert.equal(sample.node.instanceId,node.instanceId);
  const screenshot=await page.evaluate(async runId=>{
   const result=await window.godotPlayground.screenshot({runId});
   if(!result.ok)return result;
   return {ok:true,mimeType:result.result.mimeType,png:Array.from(new Uint8Array(result.result.bytes,0,8))};
  },runId);
  assert.deepEqual(screenshot,{ok:true,mimeType:'image/png',png:[137,80,78,71,13,10,26,10]});
  const phase=(await readWire(page)).messages.find(message=>message.runId===runId&&message.type==='phase'&&message.phase==='running');
  assert.equal(phase?.observationVersion,1);
  assert.equal(phase.runtimeWriteVersion,undefined);
  unwrap(await invoke(page,'stop',{runId}));
  const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
  engineExecuted=true;
  return {runId,node,write,sample,screenshot,exit};
 });

 if(propertiesDeclared)await browserCase(propertiesCase,async page=>{
  await assertPublicTools(page);
  await page.locator('#debug-tab').click();await page.locator('#debug-open-docs').click();
  await page.locator('#agent-runtime-properties').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-runtime-properties')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'已验证公开属性、玩法变化、重启恢复和两次完整退出');
  const evidence=JSON.parse(await page.locator('#agent-properties-evidence').textContent());
  const sourceDocument=await exportSourceDocument(page);
  assert.deepEqual(sourceDocument.files,exportProject(createRuntimePropertiesDemo(release.runtimeProfile)).files,
   'The public replay leaves all project sources unchanged');
  assert.notEqual(evidence.first.run.runId,evidence.second.run.runId);
  assert.equal(evidence.first.sourceHash,evidence.second.sourceHash);
  assert.equal(evidence.frames.length,4);
  assert.deepEqual(evidence.frames.map(frame=>frame.caption),[
   '初始 · health=100 · move_step=64','写入后 · health=40','同次输入 · Player x=192','重启 · health=100 · Player x=64',
  ]);
  const identities=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
  const wire=await readWire(page);
  const propertyReplies=evidence.checks.flatMap(check=>check.kind==='summer-write'?[check.response.result.data.payload]:
   ['read','describe'].includes(check.kind)?[check.reply]:[]);
  const nativePropertyResults=propertyReplies.map(reply=>{
   const {receipt}=reply;
   const native=wire.messages.find(message=>message.type==='runtime-property-result'&&message.requestId===receipt.requestId);
   assert(native,'Every property observation was independently received from the actual Worker');
   for(const field of identities)assert.equal(native[field],receipt.run[field],field);
   assert.equal(native.accessSequence,receipt.accessSequence);
   assert.deepEqual(native.result,{ok:true,result:reply.result});
   return native;
  });
  assert.equal(new Set(propertyReplies.map(reply=>reply.receipt.requestId)).size,propertyReplies.length);
  for(const entry of [evidence.first,evidence.second]){
   const {runId}=entry.run;
   const phase=wire.messages.find(message=>message.type==='phase'&&message.phase==='running'&&message.runId===runId);
   assert.equal(phase?.runtimePropertiesVersion,1);
   const run=unwrap(await invoke(page,'get_run',{runId}));
   for(const field of identities)assert.equal(run[field],entry.run[field],field);
   assert.equal(run.release.releaseId,release.id);assert.equal(run.release.candidateId,candidateId);
   assert.equal(run.exit.evidence,'host-report');assert.equal(run.exit.report.reason,'clean-exit');
   assert.equal(run.exit.report.sessionFacts.nativeExit.code,0);assert.equal(run.exit.report.sessionFacts.hostCleanup,'complete');
   assert.equal(run.runtimeProperties.supported,true);assert.equal(run.runtimeProperties.ready,false);
  }
  const writes=evidence.checks.filter(check=>check.kind==='summer-write');
  assert.equal(writes.length,2);
  for(const [index,check]of writes.entries()){
   const data=check.response.result.data,receipt=data.payload.receipt,result=data.payload.result;
   assert.equal(data.route,'runtime_properties');
   assert.equal(result.property,index===0?'health':'move_step');
   assert.equal(result.outcome,'applied');assert.equal(result.writeEntered,true);assert.equal(result.phase,'readback');
   assert.deepEqual(result.beforeValue,{type:index===0?'int':'float',value:index===0?100:64});
   assert.deepEqual(result.observedValue,{type:index===0?'int':'float',value:index===0?40:128});
   const native=wire.messages.find(message=>message.type==='runtime-property-result'&&message.kind==='write'&&message.requestId===receipt.requestId);
   assert(native,'Actual Worker property write result was observed independently');
   for(const field of identities)assert.equal(native[field],receipt.run[field],field);
   assert.deepEqual(native.result.result,result);
  }
  const stale=evidence.checks.find(check=>check.kind==='stale-write');
  assert.equal(stale.reply.ok,false);assert.equal(stale.reply.error.code,'run_ended');
  assert.equal(evidence.checks.filter(check=>check.kind==='input').length,3);
  for(const input of evidence.checks.filter(check=>check.kind==='input')){
   assert.equal(input.receipt.operation.down,'dispatched');assert.equal(input.receipt.operation.up,'dispatched');
  }
  const images=await savePanelImages(page,'properties');assert.equal(images.length,4);
  engineExecuted=true;return {sourceDocument,evidence,nativePropertyResults,images};
 },{deviceScaleFactor:2});

 if(propertiesDeclared)await browserCase(propertiesBoundariesCase,async page=>{
  await assertPublicTools(page);
  const identityFields=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
  const fixtures=[];
  async function fixture(){
   const {run,build,sourceDocument}=await importPropertyFixture(page);
   const tree=unwrap(await invoke(page,'get_runtime_tree',{runId:run.runId,depth:3}));
   for(const field of identityFields)assert.equal(tree.run[field],run[field]);
   assert.equal(tree.releaseId,release.id);
   assert.equal(run.runtimeProperties.supported,true);assert.equal(run.runtimeProperties.ready,true);
   assert.equal(run.runtimeProperties.version,1);
   const nodes=tree.nodes.filter(node=>node.path==='/root/Main/Player'&&node.type==='Node2D');assert.equal(nodes.length,1);
   const target={runId:run.runId,path:nodes[0].path,expectedInstanceId:nodes[0].instanceId};
   const checks=[],sequences=new Set();
   test.checkpoint({propertyBoundaryFixtures:fixtures,propertyBoundaryCurrent:{run,build,sourceDocument,target,checks}});
   const matched=reply=>{
    if(reply.ok)assert(reply.receipt,'Every successful property result carries its captured receipt');
    if(reply.receipt){
     for(const field of identityFields)assert.equal(reply.receipt.run[field],run[field]);
     assert.equal(reply.receipt.releaseId,release.id);assert.equal(reply.receipt.expectedInstanceId,target.expectedInstanceId);
     assert.equal(reply.receipt.path,target.path);
     assert(Number.isSafeInteger(reply.receipt.accessSequence)&&reply.receipt.accessSequence>0);
     assert.equal(reply.receipt.requestId,run.runId+':'+reply.receipt.accessSequence);
     assert(!sequences.has(reply.receipt.accessSequence),'Property operations do not reuse access sequences');
     sequences.add(reply.receipt.accessSequence);
    }
    checks.push(reply);return reply;
   };
   const readProps=async properties=>matched(await invoke(page,'read_runtime_properties',{...target,properties}));
   const readInt=async name=>{
    const reply=await readProps([{name,expectedType:'int'}]);const result=unwrap(reply);
    assert.equal(result.outcome,'completed');assert.equal(result.properties[0].status,'value');return result.properties[0].value.value;
   };
   const write=async(property,type,value)=>matched(await invoke(page,'write_runtime_property',{...target,property,value:{type,value}}));
   const mode=async value=>assert.equal(unwrap(await write('mode','string',value)).outcome,'applied');
   const finish=async()=>{
    unwrap(await invoke(page,'stop',{runId:run.runId}));const exit=await waitForExit(page,run.runId);
    assert.equal(exit.evidence,'host-report');assert.equal(exit.report.reason,'clean-exit');
    assert.equal(exit.report.sessionFacts.nativeExit.code,0);assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
    const wire=await readWire(page);
    const nativePropertyResults=checks.filter(reply=>reply.receipt).map(reply=>{
     const native=wire.messages.find(message=>message.type==='runtime-property-result'&&message.requestId===reply.receipt.requestId);
     assert(native,'Boundary observations were independently received from the actual Worker');
     for(const field of identityFields)assert.equal(native[field],run[field]);
     assert.equal(native.accessSequence,reply.receipt.accessSequence);
     const {receipt,...payload}=reply;assert.deepEqual(native.result,payload);
     return native;
    });
    fixtures.push({run,build,sourceDocument,target,checks,nativePropertyResults,exit});return exit;
   };
   return {run,build,sourceDocument,target,readProps,readInt,write,mode,finish,checks,matched};
  }
  const first=await fixture();
  const copiedNames=await page.evaluate(async target=>{
   let getterCalls=0;
   class Names extends Array{
    get every(){getterCalls++;throw Error('input every was called');}
    get [Symbol.iterator](){getterCalls++;throw Error('input iterator was called');}
    get toJSON(){getterCalls++;throw Error('input toJSON was called');}
   }
   const reply=await window.godotPlayground.describe_runtime_properties({...target,names:new Names('health')});
   return {reply,getterCalls};
  },first.target);
  assert.equal(copiedNames.getterCalls,0);
  assert.equal(unwrap(first.matched(copiedNames.reply)).properties[0].status,'found');
  const vectorRequest={x:0.1,y:0.2},vectorComparison={x:Math.fround(0.1),y:Math.fround(0.2)};
  const nativePosition=unwrap(await first.write('position','vector2',vectorRequest));
  assert.equal(nativePosition.outcome,'applied');
  assert.deepEqual(nativePosition.requestedValue,{type:'vector2',value:vectorRequest});
  assert.deepEqual(nativePosition.comparisonValue,{type:'vector2',value:vectorComparison});
  assert.deepEqual(nativePosition.observedValue,nativePosition.comparisonValue);
  const positionRead=unwrap(await first.readProps([{name:'position',expectedType:'vector2'}]));
  assert.deepEqual(positionRead.properties[0].value,nativePosition.observedValue);
  assert.equal(unwrap(await first.write('position','vector2',{x:64,y:256})).outcome,'applied');
  await first.mode('getter_throw');
  const batch=unwrap(await first.readProps([{name:'health',expectedType:'int'},{name:'probe',expectedType:'int'},{name:'writes',expectedType:'int'}]));
  assert.equal(batch.outcome,'completed');
  assert.deepEqual(batch.properties.map(item=>item.status),['value','unavailable','not_attempted']);
  assert.equal(batch.properties[1].reason,'getter_failed');assert.equal(batch.properties[1].readEntered,true);assert.equal(batch.properties[2].readEntered,false);
  const beforeFailed=unwrap(await first.write('probe','int',7));
  assert.equal(beforeFailed.outcome,'not_written');assert.equal(beforeFailed.writeEntered,false);assert.equal(beforeFailed.phase,'before_read');assert.equal(beforeFailed.reason,'getter_failed');
  assert.equal(await first.readInt('writes'),0);
  await first.mode('setter_throw');const readsBefore=await first.readInt('reads');
  const thrown=unwrap(await first.write('probe','int',55));
  assert.equal(thrown.outcome,'unconfirmed');assert.equal(thrown.reason,'setter_failed');
  assert.equal(thrown.evidence.phase,'write');assert.equal(thrown.evidence.writeEntered,true);
  assert.equal(await first.readInt('writes'),1);assert.equal(await first.readInt('reads'),readsBefore+1,'No automatic readback/retry after a throwing setter');
  assert.equal(await first.readInt('probe'),55,'The throwing setter really changed state');
  await first.mode('clamp');
  const clamped=unwrap(await first.write('probe','int',140));
  assert.equal(clamped.outcome,'not_applied');assert.deepEqual(clamped.beforeValue,{type:'int',value:55});assert.deepEqual(clamped.observedValue,{type:'int',value:100});
  const text='\ufeffa'+Array.from({length:32},(_,code)=>String.fromCharCode(code)).join('')+'b 😀𐐷\n';
  const writtenText=unwrap(await first.write('text','string',text));assert.equal(writtenText.outcome,'applied');
  assert.deepEqual(writtenText.requestedValue,{type:'string',value:text});
  assert.deepEqual(writtenText.beforeValue,{type:'string',value:'initial'});
  assert.deepEqual(writtenText.comparisonValue,{type:'string',value:text});
  assert.deepEqual(writtenText.observedValue,{type:'string',value:text});
  const readText=unwrap(await first.readProps([{name:'text',expectedType:'string'}]));
  assert.equal(readText.outcome,'completed');assert.equal(readText.properties[0].status,'value');
  assert.deepEqual(readText.properties[0].value,{type:'string',value:text});
  const count=await first.readInt('reads');
  const description=unwrap(first.matched(await invoke(page,'describe_runtime_properties',{...first.target,names:['exported_vector']})));
  assert.equal(description.properties[0].status,'found');
  assert.deepEqual(description.properties[0].descriptor.readAccess,{status:'unsupported',reason:'unsupported_export_type'});
  const vectorRead=await first.readProps([{name:'exported_vector',expectedType:'vector2'}]);assert.equal(vectorRead.ok,false);assert.equal(vectorRead.error.code,'unsupported');
  const vectorWrite=await first.write('exported_vector','vector2',{x:3,y:4});assert.equal(vectorWrite.ok,false);assert.equal(vectorWrite.error.code,'unsupported');
  assert.equal(await first.readInt('reads'),count,'Unsupported script Vector2 did not execute its getter');
  const fractional=await first.write('health','int',1.5);assert.equal(fractional.ok,false);assert(['invalid_input','out_of_range'].includes(fractional.error.code));
  const mismatch=await first.write('health','string','40');assert.equal(mismatch.ok,false);assert.equal(mismatch.error.code,'type_mismatch');
  assert.equal(await first.readInt('health'),100);
  await first.mode('boxed');const boxed=unwrap(await first.readProps([{name:'probe',expectedType:'int'}]));
  assert.equal(boxed.properties[0].status,'unavailable');assert.equal(boxed.properties[0].reason,'type_mismatch');
  await first.finish();

  const swapped=await fixture();await swapped.mode('swap_script');
  const changed=unwrap(await swapped.write('probe','int',7));
  assert.equal(changed.outcome,'not_written');assert.equal(changed.writeEntered,false);assert.equal(changed.reason,'target_changed');
  const replacement=unwrap(await swapped.readProps([{name:'probe',expectedType:'int'},{name:'position',expectedType:'vector2'}]));
  assert.equal(replacement.outcome,'completed');
  assert.deepEqual(replacement.properties.map(item=>({status:item.status,value:item.value})),[
   {status:'value',value:{type:'int',value:500}},{status:'value',value:{type:'vector2',value:{x:64,y:256}}},
  ],'Old metadata did not write the replacement script or its native backing state');
  await swapped.finish();

  const quitting=await fixture();await quitting.mode('quit');
  const quitReply=await quitting.write('probe','int',7);
  if(quitReply.ok&&quitReply.result.outcome==='not_written')assert.equal(quitReply.result.writeEntered,false);
  else assert(quitReply.ok&&quitReply.result.outcome==='unconfirmed',JSON.stringify(quitReply));
  const quitExit=await waitForExit(page,quitting.run.runId);
  const quitWire=(await readWire(page)).messages.find(message=>message.type==='runtime-property-result'&&message.kind==='write'&&message.requestId===quitReply.receipt?.requestId);
  assert(quitWire?.result.ok,'The native quit-boundary result was independently observed');
  for(const field of identityFields)assert.equal(quitWire[field],quitting.run[field]);
  assert.equal(quitWire.accessSequence,quitReply.receipt.accessSequence);
  assert.equal(quitWire.result.result.outcome,'not_written');assert.equal(quitWire.result.result.writeEntered,false);
  assert.equal(quitExit.evidence,'host-report');assert.equal(quitExit.report.reason,'clean-exit');
  assert.equal(quitExit.report.sessionFacts.nativeExit.code,0);assert.equal(quitExit.report.sessionFacts.hostCleanup,'complete');
  fixtures.push({run:quitting.run,build:quitting.build,sourceDocument:quitting.sourceDocument,target:quitting.target,
   checks:quitting.checks,nativePropertyResults:[quitWire],exit:quitExit});
  test.checkpoint({propertyBoundaryFixtures:undefined,propertyBoundaryCurrent:undefined});
  engineExecuted=true;return {fixtures};
 });

 if(!propertiesDeclared&&writeDeclared)await browserCase(propertiesUnsupportedCase,async page=>{
  await assertPublicTools(page);
  const {run:{runId}}=await read(page);
  const run=unwrap(await invoke(page,'get_run',{runId}));
  assert.equal(run.runtimeProperties.supported,false);assert.equal(run.runtimeProperties.ready,false);
  const tree=unwrap(await invoke(page,'get_runtime_tree',{runId,depth:3}));
  const node=tree.nodes.find(item=>item.type==='Node2D');assert(node);
  const target={runId,path:node.path,expectedInstanceId:node.instanceId};
  const before=(await readWire(page)).messages.filter(message=>message.type==='runtime-property-result').length;
  const unsupported=[];
  for(const [name,input]of [
   ['describe_runtime_properties',target],
   ['read_runtime_properties',{...target,properties:[{name:'position',expectedType:'vector2'}]}],
   ['write_runtime_property',{...target,property:'position',value:{type:'vector2',value:{x:192,y:256}}}],
  ]){
   const result=await invoke(page,name,input);assert.equal(result.ok,false);assert.equal(result.error.code,'unsupported');unsupported.push({name,result});
  }
  assert.equal((await readWire(page)).messages.filter(message=>message.type==='runtime-property-result').length,before);
  const legacy=unwrap(await invoke(page,'summer_call',{op:'engine.runtime_set',input:{path:node.path,property:'position',value:'Vector2(192, 256)'}}));
  assert.equal(legacy.data.route,'legacy_write');
  assert.equal(legacy.data.payload.result.outcome,'applied');
  assert.equal(legacy.data.payload.result.beforeValue,undefined);assert.equal(legacy.data.payload.result.frame,undefined);
  const sample=unwrap(await invoke(page,'inspect_runtime_node',{runId,path:node.path,properties:['position']}));
  assert.deepEqual(sample.properties,[{name:'position',value:{x:192,y:256}}]);
  const png=await page.evaluate(async()=>{
   const result=await window.godotPlayground.summer_call({op:'engine.screenshot',input:{target:'game'}});
   if(!result.ok)return result;
   const frame=result.result.data;
   return {run:frame.run,releaseId:frame.releaseId,mimeType:frame.mimeType,signature:Array.from(new Uint8Array(frame.bytes,0,8))};
  });
  assert.equal(png.run.runId,runId);assert.equal(png.releaseId,release.id);assert.deepEqual(png.signature,[137,80,78,71,13,10,26,10]);
  unwrap(await invoke(page,'stop',{runId}));const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');assert.equal(exit.report.sessionFacts.nativeExit.code,0);assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
  engineExecuted=true;return {runId,node,unsupported,legacy,sample,png,exit};
 });

 if(writeDeclared)await browserCase(writeCase,async page=>{
  await assertPublicTools(page);
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  const initialRunId=(await read(page)).run.runId;
  await page.locator('#agent-runtime-write').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-runtime-write')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'已验证写入、画面变化和重启恢复，并取得两次退出回执');
  const media=page.locator('#agent-observations');
  const captions=await media.locator('figcaption').allTextContents();
  assert.match(captions[0],/^写入前 · Player x=64 · 状态 #\d+ · 画面 #\d+$/);
  assert.match(captions[1],/^写入后 · Player x=192 · 状态 #\d+ · 画面 #\d+$/);
  const trace=await page.locator('#agent-trace').textContent();
  assert.match(trace,/"code": "run_ended"/);
  const wire=await readWire(page);
  const phases=wire.messages.filter(message=>message.runId!==initialRunId&&message.type==='phase'&&message.phase==='running');
  assert.equal(phases.length,2);
  const identityFields=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
  const [first,restarted]=await Promise.all(phases.map(async phase=>{
   assert.equal(phase.runtimeWriteVersion,1);
   const run=unwrap(await invoke(page,'get_run',{runId:phase.runId}));
   for(const field of identityFields)assert.equal(run[field],phase[field],field);
   assert.deepEqual(run.runtimeWrite,{supported:true,ready:false,version:1});
   assert.deepEqual(run.configuration,{executionBackend:'worker',presentationBackend:'direct'});
   assert.equal(run.release.candidateId,candidateId);
   assert.equal(run.release.descriptorSha256,descriptorHash);
   assert.equal(run.exit.evidence,'host-report');
   assert.equal(run.exit.report.reason,'clean-exit');
   assert.equal(run.exit.report.sessionFacts.nativeExit.code,0);
   assert.equal(run.exit.report.sessionFacts.hostCleanup,'complete');
   const build=unwrap(await invoke(page,'get_build',{attemptId:run.attemptId}));
   assert.match(build.sourceHash,/^[a-f0-9]{64}$/);
   return {run,build};
  }));
  assert.notEqual(first.run.runId,restarted.run.runId);
  assert.equal(first.build.editorRevision,restarted.build.editorRevision);
  assert.equal(first.build.sourceHash,restarted.build.sourceHash);
  const replies=wire.messages.filter(message=>message.type==='runtime-write-result');
  assert.equal(replies.length,1);
  const receipt=replies[0];
  assert.equal(receipt.result.result.outcome,'applied');
  assert.deepEqual(receipt.result.result.observedValue,{x:192,y:256});
  for(const field of identityFields)assert.equal(receipt[field],first.run[field],field);
  assert.equal(receipt.requestId,first.run.runId+':1');
  const summaries=await page.locator('#agent-write-results li').allTextContents();
  assert(summaries.some(line=>line.includes(receipt.requestId)&&line.includes('applied')));
  assert(summaries.some(line=>line.includes(restarted.run.runId)&&line.includes('Player x=64')));
  const frames=await media.locator('img').evaluateAll(async images=>Promise.all(images.map(async image=>{
   const png=await (await fetch(image.src)).blob();
   const bitmap=await createImageBitmap(png);
   try {
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
    context.drawImage(bitmap,0,0);
    const marker=[64,192].map(x=>Array.from(context.getImageData(Math.floor(x*bitmap.width/960),
     Math.floor(256*bitmap.height/640),1,1).data));
    return {marker,bytes:Array.from(new Uint8Array(await png.arrayBuffer()))};
   }finally{bitmap.close();}
  })));
  assert.deepEqual(frames.map(frame=>frame.marker),[[[255,255,255,255],[255,0,0,255]],[[255,0,0,255],[255,255,255,255]]]);
  const images=[];
  for(const [index,frame] of frames.entries()){
   const png=Buffer.from(frame.bytes);
   assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   const metadata={sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length};
   if(process.env.PLAYGROUND_DEBUG_API_REPORT){
    const report=path.resolve(process.env.PLAYGROUND_DEBUG_API_REPORT),directory=path.dirname(report);
    metadata.png=path.basename(report,'.json')+(index===0?'-before.png':'-after.png');
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,metadata.png),png);
   }
   images.push(metadata);
  }
  engineExecuted=true;
  return {first,restarted,receipt,images,summaries,captions};
 },{deviceScaleFactor:2});

 if(writeDeclared)await browserCase(writeBoundariesCase,async page=>{
  const marker='DEBUG_API_WRITE_BOUNDARIES';
  const source=`import {Node,Node2D,print} from 'godot';
export function start({mount}: {mount: Node}){
 const target=new Node2D();
 target.set_name('WriteBoundaryTarget');
 mount.add_child(target);
 print('${marker}');
}`;
  const {run:{runId}}=await waitForRun(page,marker,await importProject(page,source));
  const {nodes}=unwrap(await invoke(page,'get_runtime_tree',{runId,depth:3}));
  const node=nodes.find(item=>item.name==='WriteBoundaryTarget');
  assert(node);
  const coordinates=[0.10000002011656761,0.10000007227063179,3.4028234663852886e38,3.402823466385289e38];
  const samples=await page.evaluate(async ({runId,path,expectedInstanceId,coordinates})=>{
   const api=window.godotPlayground,frame=document.createElement('iframe');
   document.body.append(frame);
   try{
    const results=[];
    for(const x of coordinates){
     const input=frame.contentWindow.JSON.parse(JSON.stringify({runId,path,expectedInstanceId,property:'position',value:{x,y:256}}));
     const controller=new frame.contentWindow.AbortController();
     const pending=api.runtime_set(input,controller.signal);
     controller.signal.dispatchEvent(new frame.contentWindow.Event('abort'));
     const write=await pending;
     const read=await api.inspect_runtime_node({runId,path,properties:['position']});
     results.push({write,read,aborted:controller.signal.aborted});
    }
    return results;
   }finally{frame.remove();}
  },{runId,path:node.path,expectedInstanceId:node.instanceId,coordinates});
  for(const [index,{write,read,aborted}]of samples.entries()){
   const x=Math.fround(coordinates[Math.min(index,2)]);
   assert.equal(aborted,false);
   if(index===3){
    assert.equal(write.ok,false);
    assert.equal(write.error.code,'invalid_input');
   }else{
    const receipt=unwrap(write);
    assert.equal(receipt.outcome,'applied');
    assert.deepEqual(receipt.observedValue,{x,y:256});
   }
   const observed=unwrap(read);
   assert.equal(observed.node.instanceId,node.instanceId);
   assert.deepEqual(observed.properties,[{name:'position',value:{x,y:256}}]);
  }
  unwrap(await invoke(page,'stop',{runId}));
  const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.sessionFacts.nativeExit.code,0);
  assert.equal(exit.report.sessionFacts.hostCleanup,'complete');
  return {runId,node,coordinates,samples,exit};
 });

 if(observationDeclared)await browserCase(observationCase, async page=>{
  await page.locator('#debug-tab').click();
  await page.locator('#debug-open-docs').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  assert.equal(await page.locator('#agent-status').textContent(),'已验证画面变化并取得退出回执');
  const captions=await page.locator('#agent-observations figcaption').allTextContents();
  assert.equal(captions.length,2);
  assert.match(captions[0],/Player x=64 · 状态 #\d+ · 画面 #\d+/);
  assert.match(captions[1],/Player x=128 · 状态 #\d+ · 画面 #\d+/);
  const trace=await page.locator('#agent-trace').textContent();
  assert.match(trace,/"name": "inspect_runtime_node"/);
  assert.match(trace,/"evidence": "host-report"/);

  const play=async()=>{
   const {attemptId}=unwrap(await invoke(page,'play',await projectInput(page)));
   return (await waitForRun(page,'试玩示例已就绪',attemptId)).run;
  };
  const run=await play();
  const {runId}=run;
  assert.deepEqual(run.observation,{supported:true,ready:true,version:1});
  assert.equal(run.release.candidateId,candidateId);
  assert.equal(run.interaction.ready,true);
  const identity=Object.fromEntries(['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'].map(field=>[field,run[field]]));
  const matched=sample=>{
   assert.deepEqual(sample.run,identity);
   assert.equal(sample.releaseId,release.id);
   assert.equal(typeof sample.requestId,'string');
   assert(sample.requestId.length>0);
   return sample;
  };
  const tree=matched(unwrap(await invoke(page,'get_runtime_tree',{runId,depth:3})));
  const player=tree.nodes.find(node=>node.name==='Player');
  assert(player);
  assert.equal(player.type,'Node2D');
  assert.match(player.path,/^\/root\/.+\/Player$/);
  assert(tree.nodes.some(node=>node.path===player.parentPath));
  assert.equal(tree.truncated,false);
  const query={runId,path:player.path,properties:['position','visible','rotation']};
  const inspect=async()=>matched(unwrap(await invoke(page,'inspect_runtime_node',query)));
  const position=sample=>sample.properties.find(property=>property.name==='position')?.value;
  const before=await inspect();
  assert.deepEqual(before.node,player);
  assert.deepEqual(position(before),{x:64,y:256});
  assert.equal(before.properties.find(property=>property.name==='visible')?.value,true);
  assert.equal(before.properties.find(property=>property.name==='rotation')?.value,0);
  assert(before.sampleSeq>tree.sampleSeq);

  const capture=async()=>{
   const frame=matched(unwrap(await page.evaluate(async runId=>{
    const captured=await window.godotPlayground.screenshot({runId});
    if(!captured.ok)return captured;
    const {bytes,...frame}=captured.result;
    const image=await createImageBitmap(new Blob([bytes],{type:frame.mimeType}));
    try{
     const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');
     ctx.drawImage(image,0,0);
     const sourceY=256*frame.sourceHeight/640;
     const samples=[64,128].map(x=>{
      const sourceX=x*frame.sourceWidth/960;
      const pixelX=Math.floor(sourceX*image.width/frame.sourceWidth);
      const pixelY=Math.floor(sourceY*image.height/frame.sourceHeight);
      return {sourceX,sourceY,pixelX,pixelY,rgba:Array.from(ctx.getImageData(pixelX,pixelY,1,1).data)};
     });
     return {ok:true,result:{...frame,decodedWidth:image.width,decodedHeight:image.height,samples,bytes:Array.from(new Uint8Array(bytes))}};
    }finally{image.close();}
   },runId)));
   const {bytes,...metadata}=frame;
   const png=Buffer.from(bytes);
   assert.equal(frame.mimeType,'image/png');
   assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   assert.equal(frame.decodedWidth,frame.width);
   assert.equal(frame.decodedHeight,frame.height);
   assert(frame.width<frame.sourceWidth||frame.height<frame.sourceHeight,'high-DPR capture exercised PNG downscaling');
   return {png,metadata:{...metadata,sha256:createHash('sha256').update(png).digest('hex'),byteLength:png.length}};
  };
  const red=[255,0,0,255],white=[255,255,255,255];
  const pixels=frame=>frame.metadata.samples.map(sample=>sample.rgba);
  const beforeFrame=await capture();
  assert.deepEqual(pixels(beforeFrame),[white,red]);
  const tap=async code=>{
   const {operationId}=unwrap(await invoke(page,'game_input',{runId,gesture:{kind:'key_tap',code}}));
   const receipt=unwrap(await invoke(page,'wait_for_input',{runId,operationId}));
   assert.equal(receipt.operation.status,'dispatched');
   assert.deepEqual(receipt.operation.run,identity);
   return receipt.operation;
  };
  const move=await tap('ArrowRight');
  await page.waitForFunction(async query=>{
   const sample=await window.godotPlayground.inspect_runtime_node(query);
   return sample.ok&&sample.result.properties.find(property=>property.name==='position')?.value?.x===128;
  },query,{timeout});
  const after=await inspect();
  assert.deepEqual(after.node,before.node);
  assert.deepEqual(position(after),{x:128,y:256});
  assert(after.sampleSeq>before.sampleSeq);
  assert.notEqual(before.requestId,after.requestId);
  const pixelDeadline=Date.now()+5000;
  let afterFrame;
  do { afterFrame=await capture(); }
  while(pixels(afterFrame)[1][1]!==255&&Date.now()<pixelDeadline);
  assert.deepEqual(pixels(afterFrame),[red,white]);
  assert(afterFrame.metadata.renderSerial>beforeFrame.metadata.renderSerial);

  const remove=await tap('ArrowLeft');
  await page.waitForFunction(async query=>{
   const sample=await window.godotPlayground.inspect_runtime_node(query);
   return !sample.ok&&sample.error.code==='node_not_found';
  },query,{timeout});
  const removed=await invoke(page,'inspect_runtime_node',query);
  assert.equal(removed.error.code,'node_not_found');
  const afterRemoval=matched(unwrap(await invoke(page,'get_runtime_tree',{runId,depth:3})));
  assert(!afterRemoval.nodes.some(node=>node.path===player.path));
  assert(afterRemoval.sampleSeq>after.sampleSeq);

  unwrap(await invoke(page,'stop',{runId}));
  const exit=await waitForExit(page,runId);
  assert.equal(exit.evidence,'host-report');
  assert.equal(exit.report.reason,'clean-exit');
  assert.equal(exit.report.sessionFacts.nativeExit.code,0);
  const restarted=await play();
  assert.notEqual(restarted.runId,runId);
  assert.equal((await invoke(page,'inspect_runtime_node',query)).error.code,'run_ended');
  const reset=unwrap(await invoke(page,'inspect_runtime_node',{...query,runId:restarted.runId}));
  assert.equal(reset.run.runId,restarted.runId);
  assert.deepEqual(position(reset),{x:64,y:256});
  unwrap(await invoke(page,'stop',{runId:restarted.runId}));
  const restartedExit=await waitForExit(page,restarted.runId);
  assert.equal(restartedExit.evidence,'host-report');

  for(const [label,frame] of [['before',beforeFrame],['after',afterFrame]]){
   if(process.env.PLAYGROUND_DEBUG_API_REPORT){
    const directory=path.dirname(path.resolve(process.env.PLAYGROUND_DEBUG_API_REPORT));
    const filename=path.basename(process.env.PLAYGROUND_DEBUG_API_REPORT,'.json')+'.runtime-observation-'+label+'.png';
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,filename),frame.png);
    frame.metadata.png=filename;
   }
  }
  return {candidateId,descriptorHash,releaseId:release.id,run:identity,observation:run.observation,tree:{requestId:tree.requestId,sampleSeq:tree.sampleSeq,player},
   before,after,beforeFrame:beforeFrame.metadata,afterFrame:afterFrame.metadata,move,remove,removed:removed.error,
   afterRemoval:{requestId:afterRemoval.requestId,sampleSeq:afterRemoval.sampleSeq},exit,reset,restartedExit};
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

 async function delayPlaytestCompile(page,accelerateTimeout=false){
  await page.evaluate(accelerateTimeout=>{
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
   if(accelerateTimeout){
    window.setTimeout=function(callback,ms,...args){
     const demoWaiting=document.querySelector('#agent-status')?.textContent==='正在启动试玩示例';
     return schedule.call(this,callback,ms===30000&&demoWaiting?20:ms,...args);
    };
   }
  },accelerateTimeout);
 }

 await browserCase('interaction-demo-cancels-delayed-start', async page=>{
  await delayPlaytestCompile(page,true);
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

 await browserCase('interaction-demo-confirms-explicit-cancellation', async page=>{
  await delayPlaytestCompile(page);
  await page.locator('#debug-tab').click();
  await page.locator('#agent-playtest').click();
  await page.waitForFunction(()=>window.__releaseDelayedCompile,null,{timeout});
  await page.locator('#agent-stop').click();
  await page.waitForFunction(()=>!document.querySelector('#agent-playtest')?.disabled,null,{timeout});
  const cancellation=await page.locator('#agent-status').textContent();
  assert.equal(cancellation,'已取消自动验证；退出状态见运行记录');
  assert.equal(await page.locator('#agent-stop').isDisabled(),true);
  const {build:{attemptId,status}}=await read(page);
  assert.equal(status,'pending');
  await page.evaluate(()=>window.__releaseDelayedCompile());
  const result=unwrap(await invoke(page,'wait_for_event',{attemptId,until:'running',timeoutMs:30000}));
  assert.equal(result.outcome,'no_session');
  assert.equal(result.build.status,'succeeded');
  assert.equal(result.build.preview.status,'skipped');
  return {attemptId,cancellation,preview:result.build.preview};
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
  const attemptId=await importProject(page,`import {Callable, Color, ColorRect, InputEvent, InputEventKey, JavaScriptBridge, Key, Node, Node2D, RenderingServer, Vector2, print} from 'godot';
export function start(ctx: {mount: Node}) {
  const root=ctx.mount.get_window()!;
  root.transparent_bg=true;
  const rect=new ColorRect(); rect.color=new Color(1,0,0,1); rect.size=new Vector2(4096,4096); ctx.mount.add_child(rect);
  const probe=new Node2D(); probe.set_name('StateProbe'); probe.position=new Vector2(12,34); ctx.mount.add_child(probe);
  const input=Callable.create((event: InputEvent)=>{
    if (!(event instanceof InputEventKey) || !event.pressed) return;
    if (event.physical_keycode===Key.KEY_SPACE) {rect.hide();print('INTERACTION_ALPHA_HIDDEN');}
    if (event.physical_keycode===Key.KEY_RIGHT) {
      RenderingServer.render_loop_enabled=false;
      probe.position=new Vector2(23,34);
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
  let probeQuery,beforePause,whilePaused;
  if(observationDeclared){
   const tree=unwrap(await invoke(page,'get_runtime_tree',{runId,depth:4}));
   const probe=tree.nodes.find(node=>node.name==='StateProbe');
   assert(probe);
   probeQuery={runId,path:probe.path,properties:['position']};
   beforePause=unwrap(await invoke(page,'inspect_runtime_node',probeQuery));
   assert.deepEqual(beforePause.properties,[{name:'position',value:{x:12,y:34}}]);
  }
  await tap('ArrowRight');
  await page.waitForFunction(id=>window.godotPlayground.read_run_events({runId:id,limit:100}).result.items.some(x=>x.event.text?.includes('INTERACTION_RENDER_PAUSED')),runId,{timeout});
  if(probeQuery){
   whilePaused=unwrap(await invoke(page,'inspect_runtime_node',probeQuery));
   assert.deepEqual(whilePaused.run,beforePause.run);
   assert.equal(whilePaused.node.instanceId,beforePause.node.instanceId);
   assert(whilePaused.sampleSeq>beforePause.sampleSeq);
   assert.deepEqual(whilePaused.properties,[{name:'position',value:{x:23,y:34}}]);
  }
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
  return {runId,beforePause,whilePaused,capture:duringLoss.capture.error.code,exit};
 });

 if(selectedCase&&!test.steps.some(step=>step.name===selectedCase))throw Error('Unknown Playground debug API case: '+selectedCase);
 return withAcceptanceContext({status:'passed',scope,engineExecuted,cases,failures,...(selectedCase?{selectedCase}:{}),profile:release.runtimeProfile,releaseId:release.id,descriptorHash,candidateId},{directory,browser});
}});
