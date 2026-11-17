import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.resolve(process.env.PLAYGROUND_STORAGE_READ_REPORT_DIRECTORY??path.join(root,'work/storage-read-recovery'));await fs.mkdir(out,{recursive:true});
const require=createRequire(path.join(root,'apps/playground/package.json')),{build}=require('esbuild'),{chromium}=require('playwright');
const {createStaticServer}=await import(pathToFileURL(path.join(root,'apps/playground/scripts/serve.mjs')));
const site=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??path.join(root,'apps/playground/dist')),manifestBytes=await fs.readFile(path.join(site,'manifest.json')),manifest=JSON.parse(manifestBytes),release=JSON.parse(await fs.readFile(path.join(site,'engine-release.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex'),candidate=hash(manifestBytes),prefix=manifest.publicAssets?'/releases/'+candidate+'/':'/',options=manifest.publicAssets?{publicImmutable:true,urlPrefix:prefix}:{};
const editor=createStaticServer(site,options),preview=createStaticServer(site,options),listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await Promise.all([listen(editor),listen(preview)]);
const editorRoot=`http://127.0.0.1:${editor.address().port}${prefix}`,previewRoot=`http://127.0.0.1:${preview.address().port}${prefix}`;
const inputs=['project-storage','project-blob-storage','project-model'].map(n=>path.join(root,'apps/playground/src/'+n+'.ts'));
const bundle=(await build({stdin:{contents:inputs.map(n=>'export * from '+JSON.stringify(n)+';').join('\n'),resolveDir:root},bundle:true,write:false,format:'iife',globalName:'AuditStorageAPI',platform:'browser',target:'es2022'})).outputFiles[0].text;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext(),errors=[],report={schemaVersion:1,kind:'existing-project-read-and-recovery-under-pin-quota',status:'passed',releaseId:release.id,engineTemplateSha256:manifest.engineTemplateSha256,candidateId:candidate};
try{
 const seed=await context.newPage();await seed.route('**/main.js',r=>r.abort());await seed.goto(editorRoot);await seed.addScriptTag({content:bundle});
 report.before=await seed.evaluate(async profile=>{
  const A=AuditStorageAPI,db=await A.openProjectDatabase(profile),storage=A.createProjectStorage(Promise.resolve(db));
  const project=A.parseProject({schemaVersion:4,runtime:'engine',engineProfile:profile,launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{'/src/start.ts':"import {print} from 'godot';export function start(){print('SAVED_AUDIT_PROJECT');}",'/saved-data.bin':[8,7,6]},editor:{selected:'/src/start.ts',mode:'production'}});
  storage.stage('saved-audit',project);await storage.save('saved-audit');const loaded=await storage.load(),archive=await storage.exportRecovery();db.close();return {selected:loaded.snapshot.selected,source:loaded.snapshot.projects[0][1].files['/src/start.ts'],archiveKind:archive.kind};
 },release.runtimeProfile);assert.equal(report.before.selected,'saved-audit');await seed.close();
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(({profile})=>{const put=IDBObjectStore.prototype.put;globalThis.__pinQuota={calls:[],enabled:true};IDBObjectStore.prototype.put=function(...args){if(globalThis.__pinQuota.enabled&&this.name==='pins'&&this.transaction.db.name==='godotjs-playground-blob-v1:'+profile){__pinQuota.calls.push({store:this.name,key:args[1],job:args[0]?.job});throw new DOMException('Audit precise pin-only origin quota','QuotaExceededError');}return Reflect.apply(put,this,args);};},{profile:release.runtimeProfile});
 await page.goto(editorRoot+'?previewOrigin='+encodeURIComponent(previewRoot));await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&globalThis.__playgroundWorkbench.inspect().engine?.state==='running',null,{timeout:120000});await page.addScriptTag({content:bundle});
 report.product=await page.evaluate(()=>({state:__playgroundWorkbench.inspect(),saved:document.querySelector('#saved')?.textContent,logs:document.querySelector('#logs')?.textContent,pinFaults:__pinQuota.calls}));
 assert.equal(report.product.state.projectId,'saved-audit');assert(report.product.logs.includes('SAVED_AUDIT_PROJECT'));assert(!report.product.logs.includes('本地项目恢复失败'));
 report.after=await page.evaluate(async profile=>{
  const A=AuditStorageAPI,db=await A.openProjectDatabase(profile),storage=A.createProjectStorage(Promise.resolve(db)),error=e=>({name:e?.name,message:e?.message});
  const raw=await new Promise((resolve,reject)=>{const r=db.transaction('projects','readonly').objectStore('projects').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const direct=await A.decodeProjectRecord(db,raw);let loadError,exportError;
  let loaded,archive;try{loaded=await storage.load();}catch(e){loadError=error(e);}
  try{archive=await storage.exportRecovery();}catch(e){exportError=error(e);}
  db.close();return {directSelected:direct.selected,directSource:A.parseProject(direct.projects[0][1]).files['/src/start.ts'],loadError,exportError,loadedSelected:loaded?.snapshot?.selected,archiveKind:archive?.kind,faults:__pinQuota.calls};
 },release.runtimeProfile);
 assert.equal(report.after.directSelected,'saved-audit');assert.equal(report.after.directSource,report.before.source);assert.equal(report.after.loadError,undefined);assert.equal(report.after.exportError,undefined);assert.equal(report.after.loadedSelected,'saved-audit');assert.equal(report.after.archiveKind,'godotjs-project-storage-recovery');
 assert.deepEqual(errors,[]);report.pageErrors=errors;
 await page.locator('#stop').click();await page.waitForFunction(()=>__playgroundWorkbench.inspect().engine?.state==='exited',null,{timeout:30000});
}finally{await context.close();await browser.close();editor.closeAllConnections();preview.closeAllConnections();await Promise.all([new Promise(r=>editor.close(r)),new Promise(r=>preview.close(r))]);}
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
