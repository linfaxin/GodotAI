import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createStaticServer} from './serve.mjs';
import {launchBrowser,withAcceptanceContext,defaultTestDirectory} from './browser-harness.mjs';

// Editor/data contracts deliberately use shell mode; they are never engine-run evidence.
const directory=defaultTestDirectory();
const server=createStaticServer(directory);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await launchBrowser(),checks=[];
const inspect=page=>page.evaluate(()=>window.__playgroundWorkbench.inspect());
async function profilePage(context,profile){
 const page=await context.newPage();
 await page.route('**/shell-profile.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({schemaVersion:2,runtimeProfile:profile,shellOnly:true})}));
 await page.goto(origin+'/?project=shader');
 await page.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});
 await page.locator('#source .monaco-editor').waitFor();await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.delete('project');history.replaceState(null,'',url.pathname+url.search+url.hash);});return page;
}
async function mark(page,marker){
 await page.locator('#source .monaco-editor').click({position:{x:180,y:80}});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('\n// '+marker+'\n');
 await page.waitForFunction(marker=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes(marker)&&document.querySelector('#saved').textContent==='已自动保存';},marker);
}
async function readCurrent(page,name){return page.evaluate(name=>new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onsuccess=()=>{const db=request.result,read=db.transaction('projects').objectStore('projects').get('current');read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>reject(read.error);};request.onerror=()=>reject(request.error);}),name);}
async function importRaw(page,document){await page.locator('#import').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});}
async function exportedOriginal(page){const pending=page.waitForEvent('download');await page.locator('#unsupported-project button').filter({hasText:'导出原始项目'}).click();const result=await pending;return JSON.parse(await fs.readFile(await result.path(),'utf8'));}
try{
 {
  const context=await browser.newContext({viewport:{width:1440,height:900}}),full=await profilePage(context,'full-engine-v1'),two=await profilePage(context,'engine-2d-v1');
  await mark(full,'FULL_NAMESPACE');await mark(two,'TWO_D_NAMESPACE');
  const f=await inspect(full),t=await inspect(two);assert.notEqual(f.storageDatabaseName,t.storageDatabaseName);assert.equal(f.project.engineProfile,'full-engine-v1');assert.equal(t.project.engineProfile,'engine-2d-v1');
  const fullRows=new Map((await readCurrent(full,f.storageDatabaseName)).projects),twoRows=new Map((await readCurrent(two,t.storageDatabaseName)).projects);
  assert.match(fullRows.get('shader').files[fullRows.get('shader').entry],/FULL_NAMESPACE/);assert.doesNotMatch(fullRows.get('shader').files[fullRows.get('shader').entry],/TWO_D_NAMESPACE/);
  assert.match(twoRows.get('shader').files[twoRows.get('shader').entry],/TWO_D_NAMESPACE/);assert.doesNotMatch(twoRows.get('shader').files[twoRows.get('shader').entry],/FULL_NAMESPACE/);
  checks.push('same-origin full and 2d editors keep independent schema3 project namespaces');
  const before=await inspect(two),beforeSaved=await readCurrent(two,t.storageDatabaseName);
  for(const document of [{...f.project,files:{...f.project.files,'/full-only.txt':'FULL_DOCUMENT'}},{...t.project,engineProfile:'future-engine-v7',controls:{unrecognized:999}}]){
   await importRaw(two,document);await two.locator('#unsupported-project').waitFor({state:'visible'});assert.deepEqual((await inspect(two)).project,before.project);assert.deepEqual(await readCurrent(two,t.storageDatabaseName),beforeSaved);assert.deepEqual(await exportedOriginal(two),document);
   await two.locator('#unsupported-project button').filter({hasText:'关闭'}).click();
  }
  checks.push('mismatched and unknown imports preserve original JSON and never replace a 2d demo save');
  const imported={...t.project,demoId:'external-project-without-catalog-entry',controls:{custom:999},files:{...t.project.files,'/import.txt':'INDEPENDENT_IMPORT'}};
  await importRaw(two,imported);await two.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/import.txt']==='INDEPENDENT_IMPORT'&&document.querySelector('#saved').textContent==='已自动保存');
  const importedState=await inspect(two);assert.match(importedState.projectId,/^project-/);assert.equal(importedState.project.demoId,imported.demoId);assert.deepEqual(importedState.project.controls,imported.controls);
  await two.reload();await two.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project?.files['/import.txt']==='INDEPENDENT_IMPORT'&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});assert.deepEqual((await inspect(two)).project,importedState.project);
  const rows=new Map((await readCurrent(two,t.storageDatabaseName)).projects);assert.deepEqual(rows.get('shader'),twoRows.get('shader'));assert.deepEqual(rows.get(importedState.projectId),importedState.project);
  checks.push('custom imports use independent IDs, retain provenance and controls, and restore outside the built-in catalog');await context.close();
 }
 {
  const context=await browser.newContext({viewport:{width:1440,height:900}}),seed=await context.newPage();await seed.route('**/data-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Storage fixture</title>'}));await seed.goto(origin+'/data-fixture');
  const oldProject={schemaVersion:2,runtime:'react',demoId:'shader',entry:'/src/App.tsx',selected:'/src/App.tsx',files:{'/src/App.tsx':'export default function App(){return null;}','/legacy.txt':'KEEP_OLD_DATABASE'},controls:{speed:42},mode:'development'},snapshot={selected:'shader',projects:[['shader',oldProject]],versions:{shader:4}};
  await seed.evaluate(snapshot=>new Promise((resolve,reject)=>{const request=indexedDB.open('godotjs-showcase-workbench-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>{const db=request.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(snapshot,'current');tx.objectStore('projects').put(snapshot,'recovery');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}),snapshot);
  const two=await profilePage(context,'engine-2d-v1');assert.equal((await inspect(two)).project.files['/legacy.txt'],undefined);
  const full=await profilePage(context,'full-engine-v1');assert.equal((await inspect(full)).project.files['/legacy.txt'],'KEEP_OLD_DATABASE');assert.equal((await inspect(full)).project.schemaVersion,3);assert.equal((await inspect(full)).project.engineProfile,'full-engine-v1');assert.deepEqual(await readCurrent(seed,'godotjs-showcase-workbench-v1'),snapshot);
  await mark(full,'NEW_CLIENT_ONLY');assert.deepEqual(await readCurrent(seed,'godotjs-showcase-workbench-v1'),snapshot);
  checks.push('only full performs a copy migration; legacy schema2 data stays unchanged while the new client saves schema3');await context.close();
 }
 console.log(JSON.stringify(await withAcceptanceContext({status:'passed',checks},{directory,browser,testMode:'shell'}),null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
