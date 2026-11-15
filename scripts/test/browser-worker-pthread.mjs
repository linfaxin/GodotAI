#!/usr/bin/env node
// Differential Emscripten smoke: this is not a threaded Godot compatibility test.
// Compile worker-runtime/pthread-probe.c with Emscripten 4.0.11:
// emcc INPUT -pthread -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=1
//   -sMODULARIZE=1 -sEXPORT_NAME=ThreadProbe -sENVIRONMENT=web,worker
//   -sEXIT_RUNTIME=1 -o PTHREAD_PROBE_DIR/pthread-probe.js
// Set PTHREAD_PROBE_DIR, DISPLAY, and optional WEBKIT_EXECUTABLE before running.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/playground/package.json',import.meta.url)),drivers=require('playwright');
if(!process.env.PTHREAD_PROBE_DIR)throw Error('Set PTHREAD_PROBE_DIR to the Emscripten pthread-probe.js/.wasm directory');
const directory=resolve(process.env.PTHREAD_PROBE_DIR),output=resolve(process.env.PTHREAD_REPORT_DIR??new URL('../../work/worker-validation/pthread-results',import.meta.url).pathname);
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){const headers={'content-type':'text/html'};if(url.searchParams.has('isolated'))Object.assign(headers,{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.writeHead(200,headers).end('<!doctype html><script src="/pthread-probe.js"></script><script>window.failure=null;ThreadProbe().catch(e=>window.failure=String(e));</script>');}else{const bytes=await readFile(join(directory,url.pathname.slice(1)));res.writeHead(200,{'content-type':url.pathname.endsWith('.wasm')?'application/wasm':'text/javascript','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'}).end(bytes);}}catch(e){res.writeHead(404).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{for(const name of ['chromium','firefox','webkit']){let browser;try{
 browser=await drivers[name].launch({headless:name==='chromium',...(name==='chromium'?{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}:name==='webkit'?{...(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{})}:{})});
 for(const isolated of [false,true]){const page=await browser.newPage(),logs=[],errors=[];page.on('console',message=>logs.push(message.text()));page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`http://127.0.0.1:${server.address().port}/`+(isolated?'?isolated=1':''));
 await page.waitForFunction(()=>window.failure!==null||document.readyState==='complete',null,{timeout:15000});
 for(let i=0;i<30&&!logs.some(x=>x.startsWith('PTHREAD_MEMORY'))&&!await page.evaluate(()=>window.failure);i++)await new Promise(done=>setTimeout(done,100));
 results.push({name,browser:browser.version(),isolated,...await page.evaluate(()=>({actualIsolation:crossOriginIsolated,sharedConstructor:typeof SharedArrayBuffer,failure:window.failure})),logs,errors});await page.close();}
 }catch(error){results.push({name,error:String(error)});}finally{await browser?.close();}}}finally{await new Promise(done=>server.close(done));}
await writeFile(join(output,'pthread-verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
for(const result of results){assert.equal(result.error,undefined);assert.equal(result.actualIsolation,result.isolated);if(result.isolated){assert(result.logs.includes('PTHREAD_BROWSER_MAIN 0'));assert(result.logs.some(line=>line.startsWith('PTHREAD_MEMORY ')&&JSON.parse(line.slice(15)).shared===true));}else{assert.equal(result.sharedConstructor,'undefined');assert(!result.logs.some(line=>line.startsWith('PTHREAD_MEMORY ')));}}
