import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {createStaticServer} from './serve.mjs';
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const server=createStaticServer(directory);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const legacyBase=base+'/?project=shader';
const browser=await launchBrowser({args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const shellOnly=process.env.PLAYGROUND_TEST_SHELL==='1';
const siteProfile=(await(await fetch(base+'/shell-profile.json')).json()).runtimeProfile??'full-engine-v1';
const checks=[];const record=message=>{checks.push(message);process.stderr.write('[project-contract] '+message+'\n');};
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'playground-projects-'));
async function newPage(context){context.setDefaultTimeout(45000);const page=await context.newPage();if(shellOnly)await page.route('**/preview.html*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Compiler and persistence regression shell</title>'}));return page;}
const state=p=>p.evaluate(()=>window.__playgroundWorkbench.inspect().project);
const projectId=p=>p.evaluate(()=>window.__playgroundWorkbench.inspect().projectId);
async function loaded(p){await p.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});await p.locator('#source .monaco-editor').waitFor();assert.equal((await state(p)).runtime,'react','Persistence regressions use the native React runtime');
 if(!shellOnly)await p.waitForFunction(()=>window.__playgroundWorkbench?.inspect().engine?.state==='running',null,{timeout:120000});
 // The query selects the initial compatibility project only. Subsequent reloads
 // must exercise the saved selection, including selections made by another tab.
 await p.evaluate(()=>{const url=new URL(location.href);if(url.searchParams.has('project')){url.searchParams.delete('project');history.replaceState(null,'',url.pathname+url.search+url.hash);}});
}
async function init(url=legacyBase){const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await newPage(context);await page.goto(url);await loaded(page);return {context,page};}
async function mark(p,name){await p.locator('#source .monaco-editor').click({position:{x:180,y:80}});await p.keyboard.press('ControlOrMeta+End');await p.keyboard.insertText('\n// '+name+'\n');await p.waitForFunction(name=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes(name)&&document.querySelector('#saved').textContent==='已自动保存';},name);}
async function importProject(page,project){await page.locator('#import').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});}
async function menuAction(page,id){if(!await page.locator('#project-menu').evaluate(node=>node.open))await page.locator('#project-menu summary').click();await page.locator('#'+id).click();}
async function snapshot(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(window.__playgroundWorkbench.inspect().storageDatabaseName,1);open.onsuccess=()=>{const db=open.result,r=db.transaction('projects').objectStore('projects').get('current');r.onsuccess=()=>{db.close();resolve(r.result);};r.onerror=()=>reject(r.error);};}));}
try{
 let original;
 {
  const {context,page}=await init();original=await state(page);await mark(page,'KEEP_UNCHANGED_RENAME');const before=await state(page);
  await page.locator(`#files [data-path="${before.entry}"]`).focus();await page.keyboard.press('F2');await page.locator('#file-form').press('Enter');assert.deepEqual(await state(page),before);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),before);record('unchanged F2 rename retains source after reload');await context.close();
 }
 {
  // Legacy base64url links and the original export wrapper share the same reader.
  const wrapper={schemaVersion:1,project:{config:{entry:original.entry,mode:'development'},files:original.files,selected:original.entry}};
  const document=siteProfile==='full-engine-v1'?wrapper:{...original,mode:'development'};
  const {context,page}=await init(base+'/#project='+gzipSync(JSON.stringify(document)).toString('base64url'));
  assert.equal(new URL(page.url()).hash,'');assert.equal((await state(page)).mode,'development');await mark(page,'KEEP_SHARED_EDIT');const before=await state(page);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),before);record((siteProfile==='full-engine-v1'?'legacy':'schema3')+' shared URL is consumed and subsequent edits survive reload');await context.close();
 }
 {
  const {context,page}=await init();await mark(page,'KEEP_FAILED_IMPORT');const before=await state(page);
  const assets=Array.from({length:62},(_,i)=>({name:`asset-${i}.png`,mimeType:'image/png',buffer:Buffer.from([0,128,255])}));
  await page.locator('#asset-import').setInputFiles(assets);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('64'));assert.deepEqual(await state(page),before);
  // Retrying a smaller batch on the same input works after the rejection.
  await page.locator('#asset-import').setInputFiles(assets.slice(0,2));await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===6&&document.querySelector('#saved').textContent==='已自动保存');const added=await state(page);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),added);record('over-quota asset import is atomic and retry persists');
  const legacy={schemaVersion:1,runtimeRelease:'original',project:{config:{entry:original.entry,mode:'production',custom:{preserve:['attachment',17]}},files:{...original.files,'/legacy.txt':'original export','/assets/original.bin':[0,64,128,255]},selected:'/legacy.txt'}};
  if(siteProfile==='full-engine-v1'){await importProject(page,legacy);await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/legacy.txt']==='original export'&&document.querySelector('#saved').textContent==='已自动保存');await page.reload();await loaded(page);assert.equal((await state(page)).files['/legacy.txt'],'original export');record('original exported JSON imports and persists');
  await page.locator(`#files [data-path="${original.entry}"]`).click();await mark(page,'EDIT_AFTER_MIGRATION');await page.reload();await loaded(page);
  const originalDownload=page.waitForEvent('download');await menuAction(page,'export-original');assert.deepEqual(JSON.parse(await fs.readFile(await (await originalDownload).path(),'utf8')),legacy);
  assert.ok((await state(page)).files[original.entry].includes('EDIT_AFTER_MIGRATION'));record('migration-original export preserves the exact schema1 document, configuration and binary attachment after edits');}await context.close();
 }
 {
  const {context,page}=await init();await mark(page,'KEEP_BEFORE_RECOVERY');
  const recovery={selected:'shader',projects:[['shader',{...original,files:{...original.files,'/restored.txt':'RECOVERED_VALID_BACKUP'}}]]};
  await page.evaluate(recovery=>new Promise((resolve,reject)=>{const open=indexedDB.open(window.__playgroundWorkbench.inspect().storageDatabaseName,1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(recovery,'recovery');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}),recovery);
  await page.reload();await loaded(page);const beforeRecovery=await snapshot(page);assert.ok((await state(page)).files[original.entry].includes('KEEP_BEFORE_RECOVERY'));
  await menuAction(page,'restore-recovery');await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/restored.txt']==='RECOVERED_VALID_BACKUP'&&document.querySelector('#saved').textContent==='已自动保存'&&document.querySelector('#toast').textContent.includes('已从恢复备份还原项目'));
  const restored=await snapshot(page);assert.ok(restored.versions.shader>beforeRecovery.versions.shader,'Recovery must advance the conflict revision');assert.ok(!(await state(page)).files[original.entry].includes('KEEP_BEFORE_RECOVERY'));
  const recoveryDownload=page.waitForEvent('download');await menuAction(page,'export-recovery');assert.deepEqual(JSON.parse(await fs.readFile(await (await recoveryDownload).path(),'utf8')),beforeRecovery);
  await page.reload();await loaded(page);assert.equal((await state(page)).files['/restored.txt'],'RECOVERED_VALID_BACKUP');record('restore-recovery applies a valid backup, preserves the replaced contents and persists a newer revision');await context.close();
 }
 {
  const {context,page}=await init();const valid={...original,demoId:'lights',files:{...original.files,'/kept.txt':'KEEP_VALID_AFTER_BAD'}};
  const bad={...original,files:{'/README.md':'KEEP_RECOVERY_BACKUP'}};
  const saved={selected:'lights',projects:[['shader',bad],['lights',valid]]};
  await page.evaluate(saved=>new Promise((resolve,reject)=>{const open=indexedDB.open(window.__playgroundWorkbench.inspect().storageDatabaseName,1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(saved,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}),saved);
  await page.reload();await loaded(page);assert.equal((await state(page)).files['/kept.txt'],'KEEP_VALID_AFTER_BAD');assert.ok((await snapshot(page)).projects.some(([id,p])=>id==='lights'&&p.files['/kept.txt']));
  await page.reload();await loaded(page);await page.locator('#project-menu summary').click();const download=page.waitForEvent('download');await page.locator('#export-recovery').click();assert.deepEqual(JSON.parse(await fs.readFile(await (await download).path(),'utf8')),saved);record('bad stored record is backed up and later valid projects restore');await context.close();
 }
 {
  const {context,page}=await init();
  const nearLimit={...original,files:{[original.entry]:'export default function App(){return null;}', '/large.txt':''}};
  nearLimit.files['/large.txt']='x'.repeat(8388608-Buffer.byteLength(nearLimit.files[original.entry])-4);
  await importProject(page,nearLimit);await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/large.txt']?.length>8000000&&document.querySelector('#saved').textContent==='已自动保存');
  const nearLimitId=await projectId(page);
  await page.locator('#source .monaco-editor').click({position:{x:180,y:80}});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('\n// beyond project limit\n');await page.waitForFunction(()=>document.querySelector('#saved').textContent==='保存失败');
  assert.ok((await state(page)).files[original.entry].includes('beyond project limit'));assert.equal((await snapshot(page)).projects.find(([id])=>id===nearLimitId)[1].files[original.entry],nearLimit.files[original.entry]);
  await page.locator('#project-switcher').click();await page.locator('[data-demo="lights"]').click();await mark(page,'KEEP_HEALTHY_PROJECT');await page.reload();await loaded(page);const lights=await state(page);assert.ok(lights.files[lights.entry].includes('KEEP_HEALTHY_PROJECT'));await page.locator('#project-switcher').click();await page.locator(`[data-demo="${nearLimitId}"]`).click();assert.equal((await state(page)).files[original.entry],nearLimit.files[original.entry]);record('oversized edits preserve the last autosave without blocking healthy projects');await context.close();
 }
 {
  const {context,page:a}=await init(),b=await newPage(context);await b.goto(legacyBase);await loaded(b);
  await mark(a,'KEEP_TAB_A');await b.locator('#project-switcher').click();await b.locator('[data-demo="lights"]').click();await mark(b,'KEEP_TAB_B');
  await a.reload();await loaded(a);let q=await state(a);assert.ok(q.files[q.entry].includes('KEEP_TAB_B'));await a.locator('#project-switcher').click();await a.locator('[data-demo="shader"]').click();q=await state(a);assert.ok(q.files[q.entry].includes('KEEP_TAB_A'));record('different tabs preserve edits to different projects');
  await b.locator('#project-switcher').click();await b.locator('[data-demo="shader"]').click();await b.locator('#source .monaco-editor').click({position:{x:180,y:80}});await b.keyboard.press('ControlOrMeta+End');await b.keyboard.insertText('\n// local conflicting edit\n');await b.waitForFunction(()=>document.querySelector('#saved').textContent==='保存冲突');const conflict=await state(b);assert.ok(conflict.files[conflict.entry].includes('local conflicting edit'));assert.ok(!(await snapshot(b)).projects.find(([id])=>id==='shader')[1].files[q.entry].includes('local conflicting edit'));record('same-project conflicts retain local changes and protect the stored version');await context.close();
 }
 {
  const {context,page}=await init();const files=[1,2].map(n=>({name:`binary-${n}.png`,mimeType:'image/png',buffer:Buffer.alloc(1048576,255)}));await page.locator('#asset-import').setInputFiles(files);await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===6&&document.querySelector('#saved').textContent==='已自动保存');
  await page.locator('#project-menu summary').click();const download=page.waitForEvent('download');await page.locator('#export').click();const file=path.join(temp,'project.json');await (await download).saveAs(file);assert.ok((await fs.stat(file)).size>12*1024*1024);
  await page.locator('#project-menu summary').click();await page.locator('#reset').click();await loaded(page);assert.equal(Object.keys((await state(page)).files).length,4);
  await page.locator('#import').setInputFiles(file);await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===6&&document.querySelector('#saved').textContent==='已自动保存');let q=await state(page);assert.deepEqual(q.files['/assets/binary-1.png'],Array(1048576).fill(255));assert.deepEqual(q.files['/assets/binary-2.png'],Array(1048576).fill(255));record('binary project exports larger than 12 MB import successfully');
  await mark(page,'AFTER_IMPORT');assert.equal(await page.locator('#import').inputValue(),'');await page.locator('#import').setInputFiles(file);await page.waitForFunction(()=>{const q=window.__playgroundWorkbench.inspect().project;return !q.files[q.entry].includes('AFTER_IMPORT')&&document.querySelector('#saved').textContent==='已自动保存';});assert.equal(await page.locator('#import').inputValue(),'');record('the same JSON file can be imported repeatedly');
  const hash=gzipSync(JSON.stringify(await state(page))).toString('base64url'),shared=await newPage(context);await shared.goto(base+'/#project='+hash);await loaded(shared);await shared.waitForFunction(()=>!location.hash);q=await state(shared);assert.equal(q.files['/assets/binary-1.png'].length,1048576);assert.equal(q.files['/assets/binary-2.png'].length,1048576);record('binary shared projects use decoded file limits after bounded decompression');await context.close();
 }
 if(!shellOnly){
  const {context,page}=await init();
  const result=await page.evaluate(async()=>{
   const worker=new Worker('compiler.worker.js');let serial=0;
   const request=(kind,files)=>new Promise(resolve=>{worker.onmessage=e=>resolve(e.data);worker.postMessage({id:++serial,kind,runtime:'react',entry:'/src/App.tsx',files,demoApiVersion:window.__playgroundWorkbench.inspect().project.demoApiVersion,engineProfile:window.__playgroundWorkbench.inspect().engineProfile,releaseContext:window.__playgroundWorkbench.inspect().releaseContext});});
   const source='import React from "react";import {EngineNode} from "@godot-js/react";import {Label} from "godot";import {answer} from "res://src/value.ts";export default function App(){return <EngineNode ctor={Label} native={{text:String(answer)}}/>;}';
   try{return {valid:await request('compile',{'/src/App.tsx':source,'/src/value.ts':'export const answer=42;'}),invalid:await request('check',{'/src/App.tsx':source,'/src/value.ts':'export const answer:number="wrong";'})};}finally{worker.terminate();}
  });
  assert.deepEqual(result.valid.diagnostics,[]);assert(result.valid.pack.byteLength>0);assert(result.invalid.diagnostics.some(d=>d.category==='error'&&d.file==='/src/value.ts'));
  record('native React imports compile into a PCK and retain navigable diagnostics');await context.close();
 }
 console.log(JSON.stringify(await withAcceptanceContext({status:'passed',runtime:'react',checks},{directory,browser,testMode:shellOnly?'shell':'real-engine'}),null,2));
}catch(error){for(const context of browser.contexts())for(const page of context.pages()){console.error(JSON.stringify(await page.evaluate(()=>({url:location.href,saved:document.querySelector('#saved')?.textContent,toast:document.querySelector('#toast')?.textContent,project:window.__playgroundWorkbench?.inspect().project?.demoId})).catch(()=>({url:page.url()})),null,2));}throw error;}finally{await browser.close();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});}
