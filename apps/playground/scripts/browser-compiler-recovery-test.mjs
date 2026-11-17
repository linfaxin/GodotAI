import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const manifestBytes=await fs.readFile(path.join(directory,'manifest.json')),manifest=JSON.parse(manifestBytes),candidateId=createHash('sha256').update(manifestBytes).digest('hex');
const prefix=manifest.publicAssets?'/releases/'+candidateId+'/':'/',options=manifest.publicAssets?{publicImmutable:true,urlPrefix:prefix}:{};
const editor=createStaticServer(directory,options),preview=createStaticServer(directory,options);
await Promise.all([editor,preview].map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
const url=server=>'http://127.0.0.1:'+server.address().port+prefix;
const browser=await launchBrowser({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const cases=[],pageErrors=[];
try{
 for(const permanent of [false,true]){
  const context=await browser.newContext(),page=await context.newPage();let attempts=0;
  page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.route(/\/compiler\.worker\.js(?:[?#]|$)/,async route=>{attempts++;if(permanent||attempts===1)await route.abort('failed');else await route.continue();});
  await page.goto(url(editor)+'?project=native&previewOrigin='+encodeURIComponent(url(preview)));
  await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&!document.querySelector('#run')?.hasAttribute('disabled')&&document.querySelector('#logs')?.textContent.includes('Worker'),null,{timeout:120000});
  const first=await page.evaluate(()=>({status:document.querySelector('#status').textContent,disabled:document.querySelector('#run').hasAttribute('disabled')}));
  await page.keyboard.press('Control+Enter');
  if(permanent)await page.waitForFunction(()=>!document.querySelector('#run')?.hasAttribute('disabled')&&document.querySelector('#status')?.textContent.includes('失败'),null,{timeout:30000});
  else await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().engine?.state==='running'&&!document.querySelector('#run')?.hasAttribute('disabled'),null,{timeout:120000});
  assert(attempts>=2,'retry creates a fresh compiler Worker');
  await page.waitForFunction(async()=>{
   const name=globalThis.__playgroundWorkbench.inspect().storageDatabaseName;
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   const count=await new Promise((resolve,reject)=>{const request=db.transaction('pins').objectStore('pins').count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return count===0;
  },null,{timeout:15000});
  const after=await page.evaluate(async()=>{
   const state=globalThis.__playgroundWorkbench.inspect();
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(state.storageDatabaseName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   const pins=await new Promise((resolve,reject)=>{const request=db.transaction('pins').objectStore('pins').count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();
   return {status:document.querySelector('#status').textContent,disabled:document.querySelector('#run').hasAttribute('disabled'),engine:state.engine?.state,pins};
  });
  assert.equal(after.disabled,false);assert.equal(after.pins,0);assert.equal(after.engine,permanent?'idle':'running');
  cases.push({mode:permanent?'persistent-load-failure':'transient-load-failure',status:'passed',attempts,first,after});await context.close();
 }
 assert.deepEqual(pageErrors,[]);
 let report={kind:'actual-product-compiler-worker-recovery',status:'passed',cases,pageErrors};
 report=await withAcceptanceContext(report,{directory,browser});
 if(process.env.PLAYGROUND_COMPILER_RECOVERY_REPORT)await fs.writeFile(process.env.PLAYGROUND_COMPILER_RECOVERY_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();for(const server of [editor,preview])server.closeAllConnections();await Promise.all([editor,preview].map(server=>new Promise(resolve=>server.close(resolve))));}
