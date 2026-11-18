import {readStorageSnapshot,writeStorageSnapshot} from './project-storage-browser-helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runReportedBrowserTest,browserTestFailureStatus,listenBrowserTestServer as listen,closeBrowserTestServer as close} from './browser-contract-report.mjs';

await runReportedBrowserTest({scope:'actual-product-schema4-ui',reportFile:process.env.PLAYGROUND_SCHEMA4_REPORT,run:async test=>{

// Real product UI, production compiler and engine. No mocked workers or preview.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const {site,release,candidateId}=await test.preflight(directory);
const prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
const serverOptions=site.publicAssets?{publicImmutable:true,urlPrefix:prefix}:{};
const editor=createStaticServer(directory,serverOptions),preview=createStaticServer(directory,serverOptions);
test.defer(()=>close(editor));test.defer(()=>close(preview));
await Promise.all([listen(editor),listen(preview)]);
const editorRoot=`http://127.0.0.1:${editor.address().port}${prefix}`,previewRoot=`http://127.0.0.1:${preview.address().port}${prefix}`;
const timeout=Number(process.env.PLAYGROUND_SCHEMA4_TIMEOUT??180000),interactionTimeout=Math.min(timeout,30000),checks=[],pageErrors=[],editingTrace=[];
let browser,context,page;
test.defer(()=>browser?.close());test.defer(()=>context?.close());
const inspect=()=>page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect());
async function ready(){await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&document.querySelector('#saved')?.textContent==='已自动保存',null,{timeout});}
async function running(marker){
 await page.waitForFunction(marker=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.engine?.state==='running'&&document.querySelector('#logs')?.textContent.includes(marker);},marker,{timeout});
 assert.deepEqual(pageErrors,[]);assert.equal(await page.locator('#preview iframe').count(),1);
 test.checkpoint({engineExecuted:true});
}
async function menu(id){if(!await page.locator('#'+id).isVisible())await page.locator('#project-menu summary').click();await page.locator('#'+id).click();}
async function downloaded(id){const event=page.waitForEvent('download');await menu(id);const download=await event;return JSON.parse(await fs.readFile(await download.path(),'utf8'));}
const snapshot=()=>readStorageSnapshot(page);
async function importDocument(document){await page.locator('#import').setInputFiles({name:'schema4.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});}
const source=marker=>`import {Node,Label,Vector2,print} from 'godot';
import * as G from 'godot';
import DefaultG from 'godot';
export async function start({mount}:{mount:Node}){
 const realm=globalThis as any;if(typeof realm.WorkerGlobalScope!=='function'||!(realm instanceof realm.WorkerGlobalScope))throw Error('Project must execute in the native engine Worker');
 const dynamic:any=await import('godot');if(dynamic!==G||dynamic.default!==DefaultG||G.Node!==Node||dynamic.Node!==Node)throw Error('Native import namespace identity differs');
 if((dynamic as any).then!==undefined||(dynamic as any).__esModule!==true)throw Error('Native namespace metadata is unsafe');
 const label=new Label();label.text=${JSON.stringify(marker)};label.position=new Vector2(16,24);mount.add_child(label);
 print(${JSON.stringify(marker)});
 return ()=>print('SCHEMA4_CLEANUP');
}`;
let report={status:'failed',scope:'actual-product-schema4-ui',checks};
test.checkpoint(report);
try{
 test.stage='browser';browser=await launchBrowser({headless:process.env.BROWSER_HEADLESS!=='0',args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 test.stage='run';
 context=await browser.newContext({viewport:{width:1536,height:1000},acceptDownloads:true});page=await context.newPage();page.setDefaultTimeout(timeout);
 page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto(editorRoot+'?project=native&previewOrigin='+encodeURIComponent(previewRoot));await ready();
 if((release.execution??release.engine?.execution)?.requiresCrossOriginIsolation)assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 await menu('new-engine-project');await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().project.engineDocument&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout});
 let current=await inspect();assert.equal(current.project.engineDocument.launch.kind,'script');assert.equal((await downloaded('export')).runtime,'engine');checks.push('new engine project button creates an explicit schema4 script project');
 const original={schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{
  '/src/start.ts':source('SCHEMA4_WORKER_START_ONE'),'/project.godot':'config_version=5\n[application]\nrun/main_scene="res://unused-old.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '/asset.bin':[0,255,17],'/README.md':'schema4 original attachment',
 },editor:{selected:'/src/start.ts',mode:'production',custom:'retain'},customMetadata:{keep:true}};
 await importDocument(original);await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().project.files['/README.md']==='schema4 original attachment'&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout});
 await running('SCHEMA4_WORKER_START_ONE');
 const initial=await snapshot();current=await inspect();const projectId=current.projectId;
 assert.equal(new Map(initial.projects).get(projectId).schemaVersion,4);checks.push('imported start(ctx) compiles and executes in the real engine Worker; storage uses schema4');
 if(process.env.PLAYGROUND_ENGINE_CONTRACTS==='1'){
  await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});
  return await withAcceptanceContext({status:'passed',scope:'actual-product-schema4-core',engineExecuted:true,checks,pageErrors,execution:release.execution??release.engine?.execution},{directory,browser});
 }
 await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.delete('project');history.replaceState(null,'',url.pathname+url.search+url.hash);});
 // Use actual editor key events for a small, deterministic change. Bulk
 // insertText/paste has a separate browser/IME event path and is not certified
 // by this project persistence test.
 const codeInput=page.locator('#source textarea.inputarea').first();
 for(let remaining=1;remaining>=0;remaining--){
  await codeInput.focus({timeout:interactionTimeout});await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.press('ControlOrMeta+f');
  // Monaco's flexible-height Find input is a textarea; fixed overflow widgets
  // may also live outside #source. Target the actual visible UI control.
  const findInput=page.locator('.find-widget textarea:visible, .find-widget input:visible').first();
  await findInput.waitFor({state:'visible',timeout:interactionTimeout});await findInput.fill('SCHEMA4_WORKER_START_ONE',{timeout:interactionTimeout});
  editingTrace.push(await findInput.evaluate(el=>({tagName:el.tagName,ariaLabel:el.getAttribute('aria-label'),value:el.value,focused:document.activeElement===el})));
  await findInput.press('Escape');await codeInput.focus({timeout:interactionTimeout});await page.keyboard.type('SCHEMA4_WORKER_START_TWO',{delay:5});
  await page.waitForFunction(remaining=>(globalThis.__playgroundWorkbench.inspect().project.files['/src/start.ts'].match(/SCHEMA4_WORKER_START_ONE/g)??[]).length===remaining,remaining,{timeout:interactionTimeout});
 }
 await page.waitForFunction(expected=>globalThis.__playgroundWorkbench.inspect().project.files['/src/start.ts']===expected&&document.querySelector('#saved').textContent==='已自动保存',source('SCHEMA4_WORKER_START_TWO'),{timeout:interactionTimeout});
 await page.locator('#run').click();await running('SCHEMA4_WORKER_START_TWO');
 const exported=await downloaded('export');assert.equal(exported.schemaVersion,4);assert.equal(exported.runtime,'engine');assert.deepEqual(exported.launch,original.launch);assert.deepEqual(exported.files['/asset.bin'],original.files['/asset.bin']);assert.equal(exported.files['/project.godot'],original.files['/project.godot']);assert(exported.files['/src/start.ts'].includes('SCHEMA4_WORKER_START_TWO'));assert.deepEqual(await downloaded('export-original'),original);checks.push('Monaco edits compile through ordinary script startup; current export is schema4 and original export is exact');
 await page.reload();await ready();await running('SCHEMA4_WORKER_START_TWO');assert.equal((await inspect()).projectId,projectId);assert.deepEqual(await downloaded('export-original'),original);checks.push('reload restores edited source, explicit launch and first imported original');
 const beforeInvalid=await snapshot();await importDocument({...original,launch:{kind:'script',module:'res://missing.ts'}});await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('入口'),null,{timeout:10000});assert.deepEqual(await snapshot(),beforeInvalid);checks.push('invalid schema4 entry cannot replace stored or active project');
  await writeStorageSnapshot(page,initial,'recovery');
 await page.reload();await ready();await running('SCHEMA4_WORKER_START_TWO');const beforeRestore=await snapshot();await menu('restore-recovery');await running('SCHEMA4_WORKER_START_ONE');
 const restored=await snapshot();assert(restored.versions[projectId]>beforeRestore.versions[projectId]);assert.deepEqual(await downloaded('export-original'),original);assert.deepEqual(await downloaded('export-recovery'),beforeRestore);checks.push('versioned recovery restores schema4 startup and original while backing up the replaced snapshot');
 // Pause the recovery-backup read after the restore transaction has committed.
 // Typing during this final await must revoke publication of the older view.
 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put,digest=SubtleCrypto.prototype.digest;let committed=false,paused=false,release;
  const gate=new Promise(resolve=>release=resolve);
  IDBObjectStore.prototype.put=function(value,key,...rest){if(this.name==='projects'&&key==='recovery')this.transaction.addEventListener('complete',()=>{committed=true;});return Reflect.apply(put,this,[value,key,...rest]);};
  SubtleCrypto.prototype.digest=async function(...args){if(committed&&!paused){paused=true;globalThis.__restoreReadPaused=true;await gate;}return Reflect.apply(digest,this,args);};
  globalThis.__finishRestoreRead=()=>{IDBObjectStore.prototype.put=put;SubtleCrypto.prototype.digest=digest;release();};
 });
 await menu('restore-recovery');await page.waitForFunction(()=>globalThis.__restoreReadPaused,null,{timeout:interactionTimeout});
 await codeInput.focus({timeout:interactionTimeout});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type('\n// RECOVERY_RACE_EDIT\n',{delay:5});
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().project.files['/src/start.ts'].includes('RECOVERY_RACE_EDIT'),null,{timeout:interactionTimeout});
 await page.evaluate(()=>globalThis.__finishRestoreRead());
 await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已取消切换')&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:interactionTimeout});
 assert((await inspect()).project.files['/src/start.ts'].includes('RECOVERY_RACE_EDIT'));
 await codeInput.focus({timeout:interactionTimeout});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type('// AFTER_RECOVERY_CANCEL\n',{delay:5});
 await page.waitForFunction(()=>document.querySelector('#saved').textContent==='已自动保存'&&globalThis.__playgroundWorkbench.inspect().project.files['/src/start.ts'].includes('AFTER_RECOVERY_CANCEL'),null,{timeout:interactionTimeout});
 const afterRace=new Map((await snapshot()).projects).get(projectId),afterRaceFiles=afterRace.project?.files??afterRace.files;
 assert(afterRaceFiles['/src/start.ts'].includes('RECOVERY_RACE_EDIT'));assert(afterRaceFiles['/src/start.ts'].includes('AFTER_RECOVERY_CANCEL'));
 checks.push('edits during the post-commit recovery read stay visible and persist through subsequent typing');
 await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});
 report={status:'passed',scope:'actual-product-schema4-ui',engineExecuted:true,checks,pageErrors,editing:{method:'editor-find-and-per-key-marker-replacement',exactAuthoredSourceMatched:true,trace:editingTrace},limitations:['This flow verifies per-key editor input and project persistence. It does not certify bulk insertText, clipboard paste or IME input.'],execution:release.execution??release.engine?.execution,editorOrigin:new URL(editorRoot).origin,previewOrigin:new URL(previewRoot).origin};
 report=await withAcceptanceContext(report,{directory,browser});
}catch(error){report={...report,status:browserTestFailureStatus(error,test.stage),error:String(error),stack:error?.stack,pageErrors,checks,editingTrace,...(page?{observed:await inspect().catch(()=>undefined),logs:await page.locator('#logs').textContent().catch(()=>undefined),editorDom:await page.locator('#source').evaluate(el=>({activeElement:document.activeElement?.outerHTML,inputs:[...document.querySelectorAll('.find-widget textarea,.find-widget input')].map(input=>({html:input.outerHTML,visible:!!(input.offsetWidth||input.offsetHeight||input.getClientRects().length),value:input.value})),inputareas:[...el.querySelectorAll('textarea.inputarea')].map(input=>({value:input.value,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd}))})).catch(()=>undefined)}:{})};process.exitCode=1;}
return report;
}});
