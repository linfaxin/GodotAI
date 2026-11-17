import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {siteIdentity} from './site-evidence.mjs';

// The actual editor, compiler Worker and native preview remain unchanged.
// Only IndexedDB failures are injected; compiler traffic is observed passively.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const siteBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes);
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const candidateId=createHash('sha256').update(siteBytes).digest('hex'),prefix=site.publicAssets?'/releases/'+candidateId+'/':'/';
const options=site.publicAssets?{publicImmutable:true,urlPrefix:prefix}:{};
const editor=createStaticServer(directory,options),preview=createStaticServer(directory,options);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await Promise.all([listen(editor),listen(preview)]);
const editorRoot=`http://127.0.0.1:${editor.address().port}${prefix}`,previewRoot=`http://127.0.0.1:${preview.address().port}${prefix}`;
const timeout=Number(process.env.PLAYGROUND_STORAGE_DEGRADATION_TIMEOUT??180000),cases=[],pageErrors=[];
let browser,context,page;
const source=marker=>`import {Node,Label,print} from 'godot';export function start({mount}:{mount:Node}){const label=new Label();label.text=${JSON.stringify(marker)};mount.add_child(label);print(${JSON.stringify(marker)});return()=>print('STORAGE_DEGRADATION_CLEANUP');}`;
const project=marker=>({schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{'/src/start.ts':source(marker),'/README.md':'owned in-memory project'},editor:{selected:'/src/start.ts',mode:'production'}});
function injectStorageFaults({profile,initial}){
 if(window!==window.top)return;
 const state=globalThis.__storageDegradationProbe={mode:initial,faults:[],sent:{},received:{}};
 const blob='godotjs-playground-blob-v1:'+profile;
 const open=IDBFactory.prototype.open;
 IDBFactory.prototype.open=function(...args){if(state.mode==='deny'&&String(args[0]).startsWith('godotjs-')){state.faults.push('open-denied');throw new DOMException('Injected denied local persistence','SecurityError');}return Reflect.apply(open,this,args);};
 const transaction=IDBDatabase.prototype.transaction;
 IDBDatabase.prototype.transaction=function(stores,mode,...rest){
  const names=typeof stores==='string'?[stores]:Array.from(stores);
  if(this.name===blob&&mode==='readwrite'&&(state.mode==='quota'||state.mode==='migration-quota'&&names.includes('journal'))){state.faults.push(names.includes('pins')?'pin-quota':'project-quota');throw new DOMException('Injected origin quota exhaustion','QuotaExceededError');}
  return Reflect.apply(transaction,this,[stores,mode,...rest]);
 };
 const postMessage=Worker.prototype.postMessage,observed=new WeakSet(),requests=new Map();
 Worker.prototype.postMessage=function(...args){
  const message=args[0];
  if(message&&['compile','check','hover','completion','rename'].includes(message.kind)){
   requests.set(message.id,message.kind);state.sent[message.kind]=(state.sent[message.kind]??0)+1;
   if(!observed.has(this)){observed.add(this);this.addEventListener('message',event=>{const kind=requests.get(event.data?.id);if(kind){requests.delete(event.data.id);state.received[kind]=(state.received[kind]??0)+1;}});}
  }
  return Reflect.apply(postMessage,this,args);
 };
}
async function ready(){await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&globalThis.__playgroundWorkbench.inspect().engine?.state==='running',null,{timeout});}
async function running(marker){await page.waitForFunction(marker=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.engine?.state==='running'&&document.querySelector('#logs')?.textContent.includes(marker);},marker,{timeout});}
async function menu(id){if(!await page.locator('#'+id).isVisible())await page.locator('#project-menu summary').click();await page.locator('#'+id).click();}
async function exported(){const pending=page.waitForEvent('download');await menu('export');const file=await pending;return JSON.parse(await fs.readFile(await file.path(),'utf8'));}
async function inspect(){return page.evaluate(()=>({workbench:globalThis.__playgroundWorkbench.inspect(),probe:globalThis.__storageDegradationProbe,saved:document.querySelector('#saved')?.textContent,logs:document.querySelector('#logs')?.textContent}));}
const {payloads,...siteBefore}=await siteIdentity(directory);
let report={...siteBefore,status:'failed',scope:'actual-product-storage-degradation',cases};
try{
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 for(const id of ['open-denied','late-quota','migration-quota']){
  context=await browser.newContext({acceptDownloads:true});page=await context.newPage();page.setDefaultTimeout(timeout);page.on('pageerror',error=>pageErrors.push(String(error)));
  let legacy;
  if(id==='migration-quota'){
   // Seed an old namespace before product startup; it must survive a failed
   // new-namespace migration byte-for-byte.
   await page.goto(editorRoot+'storage-fault-seed');legacy={selected:'retained',projects:[['retained',project('OLD_STORAGE_MUST_SURVIVE')]],versions:{retained:3}};
   await page.evaluate(async({profile,snapshot})=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('godotjs-playground-v3:'+profile,1);r.onupgradeneeded=()=>r.result.createObjectStore('projects');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(snapshot,'current');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();},{profile:release.runtimeProfile,snapshot:legacy});
  }
  await page.addInitScript(injectStorageFaults,{profile:release.runtimeProfile,initial:id==='open-denied'?'deny':id==='migration-quota'?'migration-quota':'none'});
  await page.goto(editorRoot+'?project=native&previewOrigin='+encodeURIComponent(previewRoot));await ready();
  if(id==='late-quota'){
   await page.waitForFunction(()=>document.querySelector('#saved')?.textContent==='已自动保存',null,{timeout});
   await page.evaluate(()=>{globalThis.__storageDegradationProbe.mode='quota';});
  }
  const marker='STORAGE_DEGRADATION_'+id.replaceAll('-','_').toUpperCase(),document=project(marker);
  await page.locator('#import').setInputFiles({name:'memory-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});await running(marker);
  await page.waitForFunction(()=>document.querySelector('#saved')?.textContent==='保存失败',null,{timeout});
  const before=await page.evaluate(()=>globalThis.__storageDegradationProbe.received.check??0);await page.locator('#check').click();
  await page.waitForFunction(before=>(globalThis.__storageDegradationProbe.received.check??0)>before,before,{timeout});
  const state=await inspect();assert.equal(state.saved,'保存失败');assert(state.probe.received.compile>=2);assert(state.probe.received.check>before);assert(!state.workbench.diagnostics.some(item=>item.category==='error'));
  const output=await exported();assert.equal(output.files['/src/start.ts'],document.files['/src/start.ts']);assert.equal(output.files['/README.md'],document.files['/README.md']);
  if(id==='late-quota')assert(state.probe.faults.includes('pin-quota')&&state.probe.faults.includes('project-quota'));
  if(id==='open-denied')assert(state.probe.faults.includes('open-denied'));
  if(id==='migration-quota'){
   assert(state.probe.faults.includes('project-quota'));
   const retained=await page.evaluate(async profile=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('godotjs-playground-v3:'+profile,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const r=db.transaction('projects').objectStore('projects').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}},release.runtimeProfile);
   assert.deepEqual(retained,legacy);
  }
  await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});
  cases.push({id,status:'passed',compilerRequests:state.probe.sent,compilerResponses:state.probe.received,faults:state.probe.faults,saved:state.saved,marker,exportMatches:true,legacyPreserved:id==='migration-quota'?true:undefined});
  await context.close();context=undefined;page=undefined;
 }
 assert.deepEqual(pageErrors,[]);report.status='passed';
}catch(error){report={...report,error:String(error),stack:error?.stack,pageErrors,...(page?{observed:await inspect().catch(()=>undefined)}:{})};process.exitCode=1;}
finally{
 await context?.close();if(browser)report=await withAcceptanceContext(report,{directory,browser});await browser?.close();
 editor.closeAllConnections();preview.closeAllConnections();await Promise.all([new Promise(resolve=>editor.close(resolve)),new Promise(resolve=>preview.close(resolve))]);
 if(process.env.PLAYGROUND_STORAGE_DEGRADATION_REPORT){const output=path.resolve(process.env.PLAYGROUND_STORAGE_DEGRADATION_REPORT);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}
