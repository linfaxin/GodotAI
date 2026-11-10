import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {createStaticServer} from './serve.mjs';
const server=createStaticServer(process.env.PLAYGROUND_TEST_DIRECTORY);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const legacyBase=base+'/?project=shader';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const checks=[],temp=await fs.mkdtemp(path.join(os.tmpdir(),'playground-projects-'));
async function newPage(context){const page=await context.newPage();if(process.env.PLAYGROUND_TEST_SHELL)await page.route('**/runner.html*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Compiler and persistence regression shell</title>'}));return page;}
const state=p=>p.evaluate(()=>window.__playgroundWorkbench.inspect().project);
async function loaded(p){await p.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});await p.locator('#source .monaco-editor').waitFor();assert.equal((await state(p)).runtime,'legacy-react','Persistence regressions must retain the compatibility runtime');
 // The query selects the initial compatibility project only. Subsequent reloads
 // must exercise the saved selection, including selections made by another tab.
 await p.evaluate(()=>{const url=new URL(location.href);if(url.searchParams.has('project')){url.searchParams.delete('project');history.replaceState(null,'',url.pathname+url.search+url.hash);}});
}
async function init(url=legacyBase){const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await newPage(context);await page.goto(url);await loaded(page);return {context,page};}
async function mark(p,name){await p.locator('#source .monaco-editor').click({position:{x:180,y:80}});await p.keyboard.press('ControlOrMeta+End');await p.keyboard.insertText('\n// '+name+'\n');await p.waitForFunction(name=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes(name)&&document.querySelector('#saved').textContent==='已自动保存';},name);}
async function importProject(page,project){await page.locator('#import').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});}
async function menuAction(page,id){if(!await page.locator('#project-menu').evaluate(node=>node.open))await page.locator('#project-menu summary').click();await page.locator('#'+id).click();}
async function snapshot(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('godotjs-showcase-workbench-v1',1);open.onsuccess=()=>{const db=open.result,r=db.transaction('projects').objectStore('projects').get('current');r.onsuccess=()=>{db.close();resolve(r.result);};r.onerror=()=>reject(r.error);};}));}
try{
 let original;
 {
  const {context,page}=await init();original=await state(page);await mark(page,'KEEP_UNCHANGED_RENAME');const before=await state(page);
  await page.locator(`#files [data-path="${before.entry}"]`).focus();await page.keyboard.press('F2');await page.locator('#file-form').press('Enter');assert.deepEqual(await state(page),before);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),before);checks.push('unchanged F2 rename retains source after reload');await context.close();
 }
 {
  // Legacy base64url links and the original export wrapper share the same reader.
  const wrapper={schemaVersion:1,project:{config:{entry:original.entry,mode:'development'},files:original.files,selected:original.entry}};
  const {context,page}=await init(base+'/#project='+gzipSync(JSON.stringify(wrapper)).toString('base64url'));
  assert.equal(new URL(page.url()).hash,'');assert.equal((await state(page)).mode,'development');await mark(page,'KEEP_SHARED_EDIT');const before=await state(page);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),before);checks.push('legacy shared URL is consumed and subsequent edits survive reload');await context.close();
 }
 {
  const {context,page}=await init();await mark(page,'KEEP_FAILED_IMPORT');const before=await state(page);
  const assets=Array.from({length:62},(_,i)=>({name:`asset-${i}.png`,mimeType:'image/png',buffer:Buffer.from([0,128,255])}));
  await page.locator('#asset-import').setInputFiles(assets);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('64'));assert.deepEqual(await state(page),before);
  // Retrying a smaller batch on the same input works after the rejection.
  await page.locator('#asset-import').setInputFiles(assets.slice(0,2));await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===5&&document.querySelector('#saved').textContent==='已自动保存');const added=await state(page);
  await page.reload();await loaded(page);assert.deepEqual(await state(page),added);checks.push('over-quota asset import is atomic and retry persists');
  const legacy={schemaVersion:1,runtimeRelease:'original',project:{config:{entry:original.entry,mode:'production',custom:{preserve:['attachment',17]}},files:{...original.files,'/legacy.txt':'original export','/assets/original.bin':[0,64,128,255]},selected:'/legacy.txt'}};
  await importProject(page,legacy);await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/legacy.txt']==='original export'&&document.querySelector('#saved').textContent==='已自动保存');await page.reload();await loaded(page);assert.equal((await state(page)).files['/legacy.txt'],'original export');checks.push('original exported JSON imports and persists');
  await page.locator(`#files [data-path="${original.entry}"]`).click();await mark(page,'EDIT_AFTER_MIGRATION');await page.reload();await loaded(page);
  const originalDownload=page.waitForEvent('download');await menuAction(page,'export-original');assert.deepEqual(JSON.parse(await fs.readFile(await (await originalDownload).path(),'utf8')),legacy);
  assert.ok((await state(page)).files[original.entry].includes('EDIT_AFTER_MIGRATION'));checks.push('migration-original export preserves the exact schema1 document, configuration and binary attachment after edits');await context.close();
 }
 {
  const {context,page}=await init();await mark(page,'KEEP_BEFORE_RECOVERY');
  const recovery={selected:'shader',projects:[['shader',{...original,files:{...original.files,'/restored.txt':'RECOVERED_VALID_BACKUP'}}]]};
  await page.evaluate(recovery=>new Promise((resolve,reject)=>{const open=indexedDB.open('godotjs-showcase-workbench-v1',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(recovery,'recovery');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}),recovery);
  await page.reload();await loaded(page);const beforeRecovery=await snapshot(page);assert.ok((await state(page)).files[original.entry].includes('KEEP_BEFORE_RECOVERY'));
  await menuAction(page,'restore-recovery');await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/restored.txt']==='RECOVERED_VALID_BACKUP'&&document.querySelector('#saved').textContent==='已自动保存'&&document.querySelector('#toast').textContent.includes('已从恢复备份还原项目'));
  const restored=await snapshot(page);assert.ok(restored.versions.shader>beforeRecovery.versions.shader,'Recovery must advance the conflict revision');assert.ok(!(await state(page)).files[original.entry].includes('KEEP_BEFORE_RECOVERY'));
  const recoveryDownload=page.waitForEvent('download');await menuAction(page,'export-recovery');assert.deepEqual(JSON.parse(await fs.readFile(await (await recoveryDownload).path(),'utf8')),beforeRecovery);
  await page.reload();await loaded(page);assert.equal((await state(page)).files['/restored.txt'],'RECOVERED_VALID_BACKUP');checks.push('restore-recovery applies a valid backup, preserves the replaced contents and persists a newer revision');await context.close();
 }
 {
  const {context,page}=await init();const valid={...original,demoId:'lights',files:{...original.files,'/kept.txt':'KEEP_VALID_AFTER_BAD'}};
  const bad={...original,files:{'/README.md':'KEEP_RECOVERY_BACKUP'}};
  const saved={selected:'lights',projects:[['shader',bad],['lights',valid]]};
  await page.evaluate(saved=>new Promise((resolve,reject)=>{const open=indexedDB.open('godotjs-showcase-workbench-v1',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(saved,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};}),saved);
  await page.reload();await loaded(page);assert.equal((await state(page)).files['/kept.txt'],'KEEP_VALID_AFTER_BAD');assert.ok((await snapshot(page)).projects.some(([id,p])=>id==='lights'&&p.files['/kept.txt']));
  await page.reload();await loaded(page);await page.locator('#project-menu summary').click();const download=page.waitForEvent('download');await page.locator('#export-recovery').click();assert.deepEqual(JSON.parse(await fs.readFile(await (await download).path(),'utf8')),saved);checks.push('bad stored record is backed up and later valid projects restore');await context.close();
 }
 {
  const {context,page}=await init();
  const nearLimit={...original,files:{[original.entry]:'export default function App(){return null;}', '/large.txt':''}};
  nearLimit.files['/large.txt']='x'.repeat(8388608-Buffer.byteLength(nearLimit.files[original.entry])-4);
  await importProject(page,nearLimit);await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/large.txt']?.length>8000000&&document.querySelector('#saved').textContent==='已自动保存');
  await page.locator('#source .monaco-editor').click({position:{x:180,y:80}});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('\n// beyond project limit\n');await page.waitForFunction(()=>document.querySelector('#saved').textContent==='保存失败');
  assert.ok((await state(page)).files[original.entry].includes('beyond project limit'));assert.equal((await snapshot(page)).projects.find(([id])=>id==='shader')[1].files[original.entry],nearLimit.files[original.entry]);
  await page.locator('#project-switcher').click();await page.locator('[data-demo="lights"]').click();await mark(page,'KEEP_HEALTHY_PROJECT');await page.reload();await loaded(page);const lights=await state(page);assert.ok(lights.files[lights.entry].includes('KEEP_HEALTHY_PROJECT'));await page.locator('#project-switcher').click();await page.locator('[data-demo="shader"]').click();assert.equal((await state(page)).files[original.entry],nearLimit.files[original.entry]);checks.push('oversized edits preserve the last autosave without blocking healthy projects');await context.close();
 }
 {
  const {context,page:a}=await init(),b=await newPage(context);await b.goto(legacyBase);await loaded(b);
  await mark(a,'KEEP_TAB_A');await b.locator('#project-switcher').click();await b.locator('[data-demo="lights"]').click();await mark(b,'KEEP_TAB_B');
  await a.reload();await loaded(a);let q=await state(a);assert.ok(q.files[q.entry].includes('KEEP_TAB_B'));await a.locator('#project-switcher').click();await a.locator('[data-demo="shader"]').click();q=await state(a);assert.ok(q.files[q.entry].includes('KEEP_TAB_A'));checks.push('different tabs preserve edits to different projects');
  await b.locator('#project-switcher').click();await b.locator('[data-demo="shader"]').click();await b.locator('#source .monaco-editor').click({position:{x:180,y:80}});await b.keyboard.press('ControlOrMeta+End');await b.keyboard.insertText('\n// local conflicting edit\n');await b.waitForFunction(()=>document.querySelector('#saved').textContent==='保存冲突');const conflict=await state(b);assert.ok(conflict.files[conflict.entry].includes('local conflicting edit'));assert.ok(!(await snapshot(b)).projects.find(([id])=>id==='shader')[1].files[q.entry].includes('local conflicting edit'));checks.push('same-project conflicts retain local changes and protect the stored version');await context.close();
 }
 {
  const {context,page}=await init();const files=[1,2].map(n=>({name:`binary-${n}.png`,mimeType:'image/png',buffer:Buffer.alloc(1048576,255)}));await page.locator('#asset-import').setInputFiles(files);await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===5&&document.querySelector('#saved').textContent==='已自动保存');
  await page.locator('#project-menu summary').click();const download=page.waitForEvent('download');await page.locator('#export').click();const file=path.join(temp,'project.json');await (await download).saveAs(file);assert.ok((await fs.stat(file)).size>12*1024*1024);
  await page.locator('#project-menu summary').click();await page.locator('#reset').click();await loaded(page);assert.equal(Object.keys((await state(page)).files).length,3);
  await page.locator('#import').setInputFiles(file);await page.waitForFunction(()=>Object.keys(window.__playgroundWorkbench.inspect().project.files).length===5&&document.querySelector('#saved').textContent==='已自动保存');let q=await state(page);assert.deepEqual(q.files['/assets/binary-1.png'],Array(1048576).fill(255));assert.deepEqual(q.files['/assets/binary-2.png'],Array(1048576).fill(255));checks.push('binary project exports larger than 12 MB import successfully');
  await mark(page,'AFTER_IMPORT');assert.equal(await page.locator('#import').inputValue(),'');await page.locator('#import').setInputFiles(file);await page.waitForFunction(()=>{const q=window.__playgroundWorkbench.inspect().project;return !q.files[q.entry].includes('AFTER_IMPORT')&&document.querySelector('#saved').textContent==='已自动保存';});assert.equal(await page.locator('#import').inputValue(),'');checks.push('the same JSON file can be imported repeatedly');
  const hash=gzipSync(JSON.stringify(await state(page))).toString('base64url'),shared=await newPage(context);await shared.goto(base+'/#project='+hash);await loaded(shared);await shared.waitForFunction(()=>!location.hash);q=await state(shared);assert.equal(q.files['/assets/binary-1.png'].length,1048576);assert.equal(q.files['/assets/binary-2.png'].length,1048576);checks.push('binary shared projects use decoded file limits after bounded decompression');await context.close();
 }
 {
  const {context,page}=await init();
  const results=await page.evaluate(async()=>{
   const w=new Worker('compiler.worker.js');let serial=0;const pending=new Map();w.onmessage=e=>pending.get(e.data.id)?.(e.data);
   const rpc=(kind,files)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);w.postMessage({id,kind,files,entry:'/src/App.tsx',runtime:'legacy-react'});});
   const cases={unused:{'/src/App.tsx':'export default function App(){return null;}','/unused.json':'{invalid'},invalid:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data;}','/data.json':'{"value": undefined}'},strict:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data;}','/data.json':'{"value":42,}'},directory:{'/src/App.tsx':'import {value} from "./main.js";export default function App(){return value;}','/src/main.js':'export {value} from "./lib";','/src/lib/index.js':'export const value=42;'},directoryJsx:{'/src/App.tsx':'import {value} from "./lib";export default function App(){return value;}','/src/lib/index.jsx':'export const value=42;'},valid:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data.value;}','/data.json':'{"value":42}'}};
   const results={};for(const [name,files] of Object.entries(cases)){const check=await rpc('check',files),compile=await rpc('compile',files);results[name]={check:check.diagnostics,compile:compile.diagnostics,code:compile.code};}w.terminate();return results;
  });
  assert.deepEqual(results.unused.check,[]);assert.deepEqual(results.unused.compile,[]);assert.ok(results.unused.code);
  for(const result of [results.invalid,results.strict]){assert.deepEqual(result.check,result.compile);assert.ok(result.check.some(d=>d.file==='/data.json'&&d.line>0&&d.column>0&&typeof d.start==='number'));assert.equal(result.code,'');}
  assert.deepEqual(results.valid.check,[]);assert.deepEqual(results.valid.compile,[]);const module={exports:{}};new Function('module','require',results.valid.code)(module,()=>{throw Error('unexpected external');});assert.equal(module.exports.default(),42);
  for(const result of [results.directory,results.directoryJsx]){assert.deepEqual(result.check,[]);assert.deepEqual(result.compile,[]);const module={exports:{}};new Function('module','require',result.code)(module,()=>{throw Error('unexpected external');});assert.equal(module.exports.default(),42);}checks.push('JavaScript and JSX directory modules check, compile and execute');
  checks.push('JSON checks and builds agree; valid imported JSON executes');await context.close();
 }
 {
  const {context,page}=await init();
  const result=await page.evaluate(async()=>{
   const worker=new Worker('./compiler.worker.js');let id=0;
   const request=(source,kind)=>new Promise((resolve,reject)=>{const requestId=++id;worker.onmessage=event=>{if(event.data.id===requestId){if(event.data.error)reject(Error(event.data.error));else resolve(event.data);}};worker.postMessage({id:requestId,kind,entry:'/App.tsx',files:{'/App.tsx':source},runtime:'legacy-react'});});
   const source=`import * as React from 'react';
import {Area2D,Area3D,RigidBody2D,RayCast2D,Camera2D,AudioStreamPlayer2D,AudioStreamPlayer3D,OmniLight3D,SpotLight3D,CPUParticles2D,CPUParticles3D,Timer,LineEdit,HSlider} from '@godot-js/react';
export default function App(){return <><Area2D onBodyEntered={body=>{void body;}}/><Area3D/><RigidBody2D angularVelocity={2}/><RayCast2D/><Camera2D zoom={{x:2,y:2}}/><AudioStreamPlayer2D pitchScale={1.2}/><AudioStreamPlayer3D/><OmniLight3D/><SpotLight3D/><CPUParticles2D amount={16}/><CPUParticles3D/><Timer waitTime={1} onTimeout={()=>{}}/><LineEdit onTextChanged={text=>{const checked:string=text;void checked;}}/><HSlider step={0} onValueChanged={value=>{const checked:number=value;void checked;}}/></>;}`;
   try{return {valid:await request(source,'check'),compiled:await request(source,'compile'),invalid:await request(source.replace('angularVelocity={2}','angularVelocity={{x:0,y:1}}'),'check')};}finally{worker.terminate();}
  });
  assert.deepEqual(result.valid.diagnostics,[]);assert.deepEqual(result.compiled.diagnostics,[]);assert.ok(result.compiled.code.includes('CPUParticles3D'));assert.ok(result.invalid.diagnostics.some(d=>d.category==='error'));
  checks.push('extended Godot hosts compile with local declarations and reject invalid typed props');await context.close();
 }
 {
  const {context,page}=await init();
  const project=JSON.parse(await fs.readFile(new URL('../examples/engine-features.project.json',import.meta.url),'utf8'));
  const result=await page.evaluate(async project=>{
   const worker=new Worker('./compiler.worker.js');let serial=0;
   const request=files=>new Promise(resolve=>{const id=++serial;worker.onmessage=event=>{if(event.data.id===id)resolve(event.data);};worker.postMessage({id,kind:'compile',entry:project.entry,files,runtime:'legacy-react'});});
   try{return {valid:await request(project.files),invalid:await request({...project.files,'/bad.resources.json':'{"version":1,"assets":{"evil":{"type":"Script"}}}'})};}finally{worker.terminate();}
  },project);
  assert.deepEqual(result.valid.diagnostics,[]);assert.ok(result.valid.code);assert.equal(result.valid.resources.images['/assets/strip.png'].width,2);assert.equal(result.valid.resources.definitions.motion.type,'AnimationLibrary');assert.equal(result.valid.resources.scenes['/assets/preview.tscn'].type,'Sprite2D');assert.ok(result.invalid.diagnostics.some(d=>d.category==='error'));assert.equal(result.invalid.code,'');
  checks.push('browser decodes project images, compiles animation/map/navigation resources and imports Godot text scenes');await context.close();
 }
 console.log(JSON.stringify({status:'passed',runtime:'legacy-react',checks},null,2));
}catch(error){for(const context of browser.contexts())for(const page of context.pages()){console.error(JSON.stringify(await page.evaluate(()=>({url:location.href,saved:document.querySelector('#saved')?.textContent,toast:document.querySelector('#toast')?.textContent,project:window.__playgroundWorkbench?.inspect().project?.demoId,source:window.__playgroundWorkbench?.inspect().project?.files[window.__playgroundWorkbench?.inspect().project?.entry]?.slice(-200)})).catch(()=>({url:page.url()})),null,2));}throw error;}finally{await browser.close();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});}
