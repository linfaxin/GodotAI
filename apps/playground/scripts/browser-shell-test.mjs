import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createStaticServer} from './serve.mjs';
import fs from 'node:fs/promises';
const server=createStaticServer(process.env.PLAYGROUND_TEST_DIRECTORY);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1536,height:1000}}),errors=[],downloads=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('download',d=>downloads.push(d));
await page.addInitScript(()=>{window.__events=[];window.__saveKeys=[];addEventListener('message',e=>{if(e.data?.token)window.__events.push(e.data);});});
const project=()=>page.evaluate(()=>window.__playgroundWorkbench.inspect().project);
async function running(){await page.waitForFunction(()=>window.__events.some(e=>e.type==='stats'&&e.state==='running'&&e.frames>35),null,{timeout:120000});}
async function assertHidden(){assert.equal(await page.locator('#files [data-path$="/package.json"]').count(),0);assert.equal(await page.locator('#tabs').textContent().then(t=>t.includes('package.json')),false);assert.equal(await page.locator('#file-count').textContent(),'2');assert.ok((await project()).files['/package.json']);}
try{
 await page.goto(`http://127.0.0.1:${port}`,{waitUntil:'networkidle'});await running();await assertHidden();
 await page.locator('#file-search').fill('package.json');assert.equal(await page.locator('#files .file').count(),0);assert.equal(await page.locator('#no-files').isVisible(),true);await page.locator('#file-search').fill('');
 const original=(await project()).files;
 await page.evaluate(()=>{window.__saveKeys=[];window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyS')window.__saveKeys.push(e.defaultPrevented);},{capture:true});});
 for(const target of ['#run','#source .monaco-editor']){if(target.includes('monaco'))await page.locator(target).click({position:{x:180,y:80}});else await page.locator(target).focus();for(const key of ['Control+s','Control+Shift+s','Meta+s','Meta+Shift+s'])await page.keyboard.press(key);}
 const parentKeys=await page.evaluate(()=>window.__saveKeys);assert.equal(parentKeys.length,8);assert.ok(parentKeys.every(Boolean));
 const canvas=page.frameLocator('iframe').locator('canvas');await canvas.evaluate(()=>{window.__saveKeys=[];window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyS')window.__saveKeys.push(e.defaultPrevented);},{capture:true});});await canvas.click();for(const key of ['Control+s','Control+Shift+s','Meta+s','Meta+Shift+s'])await page.keyboard.press(key);
 const frameKeys=await canvas.evaluate(()=>window.__saveKeys);assert.equal(frameKeys.length,4);assert.ok(frameKeys.every(Boolean));assert.equal(downloads.length,0);assert.deepEqual((await project()).files,original);
 // Existing IndexedDB selections of the hidden manifest migrate back to entry.
 await page.waitForFunction(()=>document.querySelector('#saved').textContent==='已自动保存');
 await page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('godotjs-showcase-workbench-v1',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),get=store.get('current');get.onsuccess=()=>{const saved=get.result;for(const [id,p] of saved.projects)if(id===saved.selected)p.selected='/package.json';store.put(saved,'current');};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}));
 await page.reload({waitUntil:'networkidle'});await running();await assertHidden();assert.equal((await project()).selected,(await project()).entry);
 // Filtering the tree does not remove metadata from exported projects.
 const download=page.waitForEvent('download');await page.locator('#project-menu summary').click();await page.locator('#export').click();assert.ok(JSON.parse(await fs.readFile(await (await download).path(),'utf8')).files['/package.json']);
 await page.locator('#source .monaco-editor').click({position:{x:180,y:80}});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('\n// autosave remains active\n');await page.waitForFunction(()=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes('autosave remains active')&&document.querySelector('#saved').textContent==='已自动保存';});
 await page.reload({waitUntil:'networkidle'});await running();await assertHidden();assert.ok((await project()).files[(await project()).entry].includes('autosave remains active'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',checks:['manifest hidden from explorer, search, tabs and count','existing hidden-file selections restore to entry','Ctrl/Cmd+S and Shift variants prevented in toolbar, Monaco and iframe','no shortcut download or source mutation','project export retains metadata','autosave survives reload'],consoleErrors:errors},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
