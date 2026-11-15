#!/usr/bin/env node
// Real browser/Worker execution contract using a minimal engine fixture.
// Verifies Blob/importScripts/lexical Engine capture and exact WASM bytes; this
// fixture is deliberately not reported as Godot engine/candidate acceptance.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const require=createRequire(new URL('../../apps/playground/package.json',import.meta.url)),{build}=require('esbuild'),{chromium}=require('playwright');
const source=new URL('../jsb.react-browser/src/verified-loader.ts',import.meta.url).pathname;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const common={bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'};
const host=(await build({...common,stdin:{contents:`import {loadVerifiedRuntimeWorker} from ${JSON.stringify(source)};globalThis.startVerifiedWorker=loadVerifiedRuntimeWorker;`,resolveDir:process.cwd(),sourcefile:'loader-host.ts'}})).outputFiles[0].text;
const worker=(await build({...common,stdin:{contents:`import {loadVerifiedWorkerEngine} from ${JSON.stringify(source)};onmessage=async({data:release})=>{let loaded;try{loaded=await loadVerifiedWorkerEngine(release);postMessage({type:'passed',worker:self instanceof WorkerGlobalScope,document:typeof document,shared:typeof SharedArrayBuffer,basePath:loaded.basePath,wasmSha256:loaded.wasmSha256});}catch(error){postMessage({type:'failed',error:String(error)});}finally{loaded?.dispose();}};`,resolveDir:process.cwd(),sourcefile:'loader-worker.ts'}})).outputFiles[0].text;
const engine=`const Engine=class {static async load(basePath,size){const response=await fetch(basePath+'.wasm');const bytes=await response.arrayBuffer();if(bytes.byteLength!==size)throw Error('size');await WebAssembly.compile(bytes);} };`;
const wasm=Buffer.from([0,97,115,109,1,0,0,0]);const assets=new Map([['/host.js',host],['/runtime.js',worker],['/engine.js',engine],['/engine.wasm',wasm]]),requests=[];
const server=createServer((request,response)=>{requests.push(request.url);if(assets.has(request.url))response.writeHead(200,{'content-type':request.url.endsWith('.wasm')?'application/wasm':'text/javascript'}).end(assets.get(request.url));else response.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><script src="/host.js"></script>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;
const output=resolve(process.env.WORKER_LOADER_REPORT_DIR??new URL('../../work/worker-validation/loader-results',import.meta.url).pathname);await mkdir(output,{recursive:true});
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage(),origin=`http://127.0.0.1:${server.address().port}`,errors=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto(origin);
 const release={releaseId:'fixture-only',profile:'fixture',engineJs:{url:origin+'/engine.js',sha256:sha(engine)},engineWasm:{url:origin+'/engine.wasm',sha256:sha(wasm)},allowedOrigins:[origin]};
 const result=await page.evaluate(async({asset,release})=>{const loaded=await globalThis.startVerifiedWorker(asset,{allowedOrigins:[location.origin]});try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('loader fixture deadline')),10000);loaded.worker.onerror=error=>{clearTimeout(timer);reject(Error(error.message));};loaded.worker.onmessage=({data})=>{clearTimeout(timer);resolve(data);};loaded.worker.postMessage(release);});}finally{loaded.dispose();}},{asset:{url:origin+'/runtime.js',sha256:sha(worker)},release});
 assert.deepEqual(errors,[]);assert.equal(result.type,'passed');assert.equal(result.worker,true);assert.equal(result.document,'undefined');assert.equal(result.shared,'undefined');assert.equal(result.wasmSha256,sha(wasm));for(const name of ['/runtime.js','/engine.js','/engine.wasm'])assert.equal(requests.filter(x=>x===name).length,1,name+' fetched exactly once');
 const report={kind:'real-browser-worker-loader-fixture',status:'passed',browser:browser.version(),sourceSha256:sha(await readFile(source)),runtimeWorkerSha256:sha(worker),result};await writeFile(join(output,'loader.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
