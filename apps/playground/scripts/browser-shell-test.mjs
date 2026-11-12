import {launchBrowser} from './browser-harness.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createStaticServer} from './serve.mjs';
import fs from 'node:fs/promises';
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const site=JSON.parse(await fs.readFile(path.join(directory,'shell-profile.json'),'utf8')),shellOnly=site.shellOnly===true,profile=getEngineProfile(site.runtimeProfile);
if(process.env.PLAYGROUND_TEST_SHELL==='1'&&!shellOnly)throw Error('Shell contracts require an explicit shell-only fixture build');
const server=createStaticServer(directory);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1536,height:1000}}),errors=[],downloads=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('download',d=>downloads.push(d));
await page.addInitScript(()=>{window.__events=[];window.__saveKeys=[];addEventListener('message',e=>{if(e.data?.token)window.__events.push(e.data);});});
const project=()=>page.evaluate(()=>window.__playgroundWorkbench.inspect().project);
async function running(){
 await page.waitForFunction(()=>window.__playgroundWorkbench?.inspect().project&&document.querySelector('#saved').textContent==='已自动保存',null,{timeout:120000});
 await page.locator('#source .monaco-editor').waitFor();
 if(shellOnly){assert.equal(await page.locator('#run').isDisabled(),true);assert.equal(await page.locator('iframe').count(),0);}
 else await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().engine?.state==='running',null,{timeout:120000});
}
async function assertHidden(){const current=await project();assert.equal(current.schemaVersion,3);assert.equal(current.engineProfile,profile.id);assert.equal(await page.locator('#files [data-path$="/package.json"]').count(),0);assert.equal(await page.locator('#tabs').textContent().then(t=>t.includes('package.json')),false);assert.equal(await page.locator('#file-count').textContent(),String(Object.keys(current.files).filter(name=>name.split('/').at(-1)!=='package.json').length));assert.ok(current.files['/package.json']);}
try{
 if(shellOnly)await page.route('**/compiler.worker.js*',route=>route.fulfill({contentType:'text/javascript',body:`// Explicit editor contract fixture: no engine, compiler or runtime evidence.
self.onmessage=({data})=>self.postMessage({id:data.id,code:'',diagnostics:[],result:data.kind==='completion'?[]:null,testMode:'shell'});`}));
 await page.goto(`http://127.0.0.1:${port}/?project=react`,{waitUntil:'networkidle'});await running();await assertHidden();
 assert.equal(await page.locator('#profile').inputValue(),profile.id);assert.equal(await page.locator('#profile option').textContent(),profile.label);assert.match(await page.locator('#release-info').textContent(),new RegExp(profile.label));
 const demoIds=await page.locator('[data-demo]').evaluateAll(nodes=>nodes.map(node=>node.dataset.demo));assert.deepEqual(new Set(demoIds),new Set(['native','react',...profile.demoIds]));
 await page.locator('#file-search').fill('package.json');assert.equal(await page.locator('#files .file').count(),0);assert.equal(await page.locator('#no-files').isVisible(),true);await page.locator('#file-search').fill('');
 const original=(await project()).files;
 await page.evaluate(()=>{window.__saveKeys=[];window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyS')window.__saveKeys.push(e.defaultPrevented);},{capture:true});});
 for(const target of [shellOnly?'#project-menu summary':'#run','#source .monaco-editor']){if(target.includes('monaco'))await page.locator(target).click({position:{x:180,y:80}});else await page.locator(target).focus();for(const key of ['Control+s','Control+Shift+s','Meta+s','Meta+Shift+s'])await page.keyboard.press(key);}
 const parentKeys=await page.evaluate(()=>window.__saveKeys);assert.equal(parentKeys.length,8);assert.ok(parentKeys.every(Boolean));
 if(!shellOnly){const canvas=page.frameLocator('iframe').locator('canvas');await canvas.evaluate(()=>{window.__saveKeys=[];window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyS')window.__saveKeys.push(e.defaultPrevented);},{capture:true});});await canvas.click();for(const key of ['Control+s','Control+Shift+s','Meta+s','Meta+Shift+s'])await page.keyboard.press(key);const frameKeys=await canvas.evaluate(()=>window.__saveKeys);assert.equal(frameKeys.length,4);assert.ok(frameKeys.every(Boolean));}
 assert.equal(downloads.length,0);assert.deepEqual((await project()).files,original);
 // Existing IndexedDB selections of the hidden manifest migrate back to entry.
 await page.waitForFunction(()=>document.querySelector('#saved').textContent==='已自动保存');
 await page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open(window.__playgroundWorkbench.inspect().storageDatabaseName,1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),get=store.get('current');get.onsuccess=()=>{const saved=get.result;for(const [id,p] of saved.projects)if(id===saved.selected)p.selected='/package.json';store.put(saved,'current');};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}));
 await page.reload({waitUntil:'networkidle'});await running();await assertHidden();assert.equal((await project()).selected,(await project()).entry);
 // Filtering the tree does not remove metadata from exported projects.
 const download=page.waitForEvent('download');await page.locator('#project-menu summary').click();await page.locator('#export').click();assert.ok(JSON.parse(await fs.readFile(await (await download).path(),'utf8')).files['/package.json']);
 await page.locator('#source .monaco-editor').click({position:{x:180,y:80}});await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('\n// autosave remains active\n');await page.waitForFunction(()=>{const p=window.__playgroundWorkbench.inspect().project;return p.files[p.entry].includes('autosave remains active')&&document.querySelector('#saved').textContent==='已自动保存';});
 await page.reload({waitUntil:'networkidle'});await running();await assertHidden();assert.ok((await project()).files[(await project()).entry].includes('autosave remains active'));assert.deepEqual(errors,[]);
 const report={status:'passed',testMode:'shell',profile:profile.id,browser:{name:browser.browserType().name(),version:browser.version()},engineObserved:!shellOnly,checks:['schema3 and profile are retained','catalog matches the registered profile','manifest hidden from explorer, search, tabs and count','hidden-file selections restore to entry in the profile database','Ctrl/Cmd+S and Shift variants prevented in toolbar and Monaco',...(!shellOnly?['real preview iframe suppresses browser save']:[]),'no shortcut download or source mutation','project export retains metadata','autosave survives reload'],consoleErrors:errors};
 if(process.env.PLAYGROUND_SHELL_REPORT){const file=path.resolve(process.env.PLAYGROUND_SHELL_REPORT);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
