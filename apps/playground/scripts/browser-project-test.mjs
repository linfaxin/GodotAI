import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createStaticServer} from './serve.mjs';
const server=createStaticServer(process.env.PLAYGROUND_TEST_DIRECTORY);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const checks=[];
const state=p=>p.evaluate(()=>window.__playgroundWorkbench.inspect().project);
async function loaded(p){await p.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});await p.locator('#source .monaco-editor').waitFor();}
async function init(url=base){const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await context.newPage();await page.goto(url);await loaded(page);return {context,page};}
async function mark(p,name){await p.locator('#source .monaco-editor').click({position:{x:180,y:80}});await p.keyboard.press('ControlOrMeta+End');await p.keyboard.insertText('\n// '+name+'\n');await p.waitForFunction(name=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes(name)&&document.querySelector('#saved').textContent==='已自动保存';},name);}
async function importProject(page,project){await page.locator('#import').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});}
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
  const legacy={schemaVersion:1,runtimeRelease:'original',project:{config:{entry:original.entry,mode:'production'},files:{...original.files,'/legacy.txt':'original export'},selected:'/legacy.txt'}};
  await importProject(page,legacy);await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().project.files['/legacy.txt']==='original export'&&document.querySelector('#saved').textContent==='已自动保存');await page.reload();await loaded(page);assert.equal((await state(page)).files['/legacy.txt'],'original export');checks.push('original exported JSON imports and persists');await context.close();
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
  await page.reload();await loaded(page);assert.equal((await state(page)).files[original.entry],nearLimit.files[original.entry]);checks.push('oversized edits keep the last valid autosave');await context.close();
 }
 {
  const {context,page}=await init();
  const results=await page.evaluate(async()=>{
   const w=new Worker('compiler.worker.js');let serial=0;const pending=new Map();w.onmessage=e=>pending.get(e.data.id)?.(e.data);
   const rpc=(kind,files)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);w.postMessage({id,kind,files,entry:'/src/App.tsx'});});
   const cases={unused:{'/src/App.tsx':'export default function App(){return null;}','/unused.json':'{invalid'},invalid:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data;}','/data.json':'{"value": undefined}'},strict:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data;}','/data.json':'{"value":42,}'},valid:{'/src/App.tsx':'import data from "../data.json"; export default function App(){return data.value;}','/data.json':'{"value":42}'}};
   const results={};for(const [name,files] of Object.entries(cases)){const check=await rpc('check',files),compile=await rpc('compile',files);results[name]={check:check.diagnostics,compile:compile.diagnostics,code:compile.code};}w.terminate();return results;
  });
  assert.deepEqual(results.unused.check,[]);assert.deepEqual(results.unused.compile,[]);assert.ok(results.unused.code);
  for(const result of [results.invalid,results.strict]){assert.deepEqual(result.check,result.compile);assert.ok(result.check.some(d=>d.file==='/data.json'&&d.line>0&&d.column>0&&typeof d.start==='number'));assert.equal(result.code,'');}
  assert.deepEqual(results.valid.check,[]);assert.deepEqual(results.valid.compile,[]);const module={exports:{}};new Function('module','require',results.valid.code)(module,()=>{throw Error('unexpected external');});assert.equal(module.exports.default(),42);
  checks.push('JSON checks and builds agree; valid imported JSON executes');await context.close();
 }
 console.log(JSON.stringify({status:'passed',checks},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
