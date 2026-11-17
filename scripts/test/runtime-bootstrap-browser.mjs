import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeWorkerBootstrap} from '../../packages/engine/dist/browser/engine-session.js';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),request=createRequire(path.join(root,'apps/playground/package.json'));
const {chromium}=request('playwright'),args=process.argv.slice(2),outAt=args.indexOf('--out');
const directory=path.resolve(outAt<0?path.join(root,'work/runtime-bootstrap-browser'):args[outAt+1]);await mkdir(directory,{recursive:true});
const source=`const host=globalThis.__godotjsRuntimeHost;
if(!host||typeof globalThis.__godotjsInstallLifecycle!=='function')throw Error('Host must be installed before the original runtime');
const role=new URL(import.meta.url).searchParams.get('role');
host.assignRole(role);host.beginNativeEpoch('bootstrap-test');
let complete;const cleaned=new Promise(resolve=>{complete=resolve;}),entry=host.openEntry();
entry.lifetime.defer(async()=>{for(let i=0;i<64;i++)await Promise.resolve();complete();});entry.ready();
addEventListener('message',async event=>{if(event.data?.type==='probe-stop'){host.beginClose('probe-stop');await cleaned;const progress=await host.drainClose();if(progress.status!=='complete')throw Error('Entry cleanup was not confirmed');host.endNativeEpoch('bootstrap-test');postMessage({type:'probe-stopped',sealed:host.snapshotSummary().sealed,cleanup:host.snapshotSummary().entries[0].cleanup});}});
postMessage({type:'probe-ready',role,bootstrapConfigRemoved:globalThis.__godotjsRuntimeBootstrapConfig===undefined});`;
const server=createServer((req,res)=>{
 if(req.url.startsWith('/original')){res.writeHead(200,{'Content-Type':'text/javascript'});const module=req.url.includes('module');res.end(module?source:source.replace("new URL(import.meta.url)","new URL(globalThis.__originalScriptUrl)"));}
 else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Prebuilt runtime bootstrap</title>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const report={schemaVersion:1,kind:'godotjs-prebuilt-runtime-bootstrap-browser',status:'failed',cases:[]};let browser;
try{
 const selected=resolveBrowserExecutable(chromium,'chromium');report.browserSource=selected.source;
 browser=await chromium.launch({headless:true,executablePath:selected.executablePath});const page=await browser.newPage();await page.goto(base);
 for(const module of [false,true])for(const role of ['engine','script-worker']){
  const url=base+'/original-'+(module?'module':'classic')+'.js?role='+role;
  const bootstrap=runtimeWorkerBootstrap(url,'runtime-bootstrap-browser',1,module);
  assert(!bootstrap.includes('.toString()'));
  const result=await page.evaluate(async({source,module,url})=>{
   const code=module?source:'globalThis.__originalScriptUrl='+JSON.stringify(url)+';\n'+source;
   const blob=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(blob,{type:module?'module':'classic'}),packets=[];
   try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Bootstrap deadline')),5000);
    worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message));};
    worker.onmessage=event=>{packets.push(event.data);if(event.data.type==='probe-ready')worker.postMessage({type:'probe-stop'});if(event.data.type==='probe-stopped'){clearTimeout(timer);resolve({packets});}};
   });}finally{worker.terminate();URL.revokeObjectURL(blob);}
  },{source:bootstrap,module,url});
  assert(result.packets.some(packet=>packet.type==='role'&&packet.role===role));assert(result.packets.some(packet=>packet.type==='epoch'));
  assert(result.packets.some(packet=>packet.type==='probe-ready'&&packet.bootstrapConfigRemoved));assert(result.packets.some(packet=>packet.type==='summary'&&packet.data.sealed));
  assert(result.packets.some(packet=>packet.type==='probe-stopped'&&packet.sealed&&packet.cleanup==='complete'));
  report.cases.push({module,role,status:'passed',packets:result.packets.map(packet=>packet.type)});
 }
 report.status='passed';
}catch(error){report.error=String(error);process.exitCode=1;}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
