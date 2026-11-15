import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls} from './browser-local-tls.mjs';
import {resolveBrowserExecutable} from '../../../scripts/test/browser-launch.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url)),playwright=require('playwright');
const directory=path.resolve(process.env.PLAYGROUND_PREFLIGHT_DIRECTORY??'/workspace/output/engine-worker-implementation/shared-memory-startup-preflight');
await fs.mkdir(directory,{recursive:true});
const bundle=await build({stdin:{contents:'export {assertBrowserSharedMemoryGrowth} from "./shared-memory-growth.js";export {loadVerifiedEngine} from "./verified-loader.js";',resolveDir:path.join(repository,'packages/engine/src/browser'),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'Preflight',platform:'browser',target:'es2022'});
await fs.writeFile(path.join(directory,'preflight.js'),bundle.outputFiles[0].contents);
await fs.writeFile(path.join(directory,'index.html'),'<!doctype html><link rel="icon" href="data:,"><script src="preflight.js"></script><title>Real shared-memory startup capability</title>');
const tls=await createLocalTestTls(),http=createStaticServer(directory,{isolation:true}),https=createStaticServer(directory,{isolation:true,tls});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
await Promise.all([listen(http),listen(https)]);
const results={schemaVersion:1,kind:'godotjs-browser-shared-memory-startup-preflight',testMode:'fixed-wasm-real-browser-capability',engineExecuted:false,probeBundleSha256:createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex'),browsers:[]};
try{
 for(const name of ['chromium','firefox','webkit']){
  const localWrapper='/workspace/.godotai-tools/apt-browser-deps/run-webkit';
  const selected=name==='webkit'&&(process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE||existsSync(localWrapper))?{executablePath:process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE??localWrapper,source:'local-webkit-dependency-wrapper'}:resolveBrowserExecutable(playwright[name],name,{environment:{}});
  const browser=await playwright[name].launch({headless:true,executablePath:selected.executablePath,...(name==='chromium'?{args:['--no-sandbox','--disable-dev-shm-usage']}:{})});
  try{
   const certificateException=name==='webkit',context=await browser.newContext(certificateException?{ignoreHTTPSErrors:true}:{});
   await context.addInitScript(()=>{
    const evidence=globalThis.__preflightResources={createdWorkers:0,closedWorkers:0,createdUrls:0,revokedUrls:0};
    const Original=Worker,create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    globalThis.Worker=new Proxy(Original,{construct(target,args,newTarget){const worker=Reflect.construct(target,args,newTarget);evidence.createdWorkers++;const terminate=worker.terminate.bind(worker);let closed=false;worker.terminate=()=>{if(!closed){closed=true;evidence.closedWorkers++;}return terminate();};return worker;}});
    URL.createObjectURL=blob=>{evidence.createdUrls++;return create(blob);};URL.revokeObjectURL=url=>{evidence.revokedUrls++;return revoke(url);};
   });
   const page=await context.newPage(),engineRequests=[];
   page.on('request',request=>{if(/\/engine\/fixture\.(?:js|wasm)$/.test(new URL(request.url()).pathname))engineRequests.push(request.url());});
   const origin=`${certificateException?'https':'http'}://127.0.0.1:${(certificateException?https:http).address().port}`;
   await page.goto(origin+'/index.html');
   const observation=await page.evaluate(async()=>{
    let supported=true,error,loaderError;
    try{await Preflight.assertBrowserSharedMemoryGrowth();}catch(failure){supported=false;error=String(failure);}
    if(!supported){
     const release={releaseId:'browser-preflight-negative',profile:'full-engine-v1',engineJs:{url:location.origin+'/engine/fixture.js',sha256:'a'.repeat(64)},engineWasm:{url:location.origin+'/engine/fixture.wasm',sha256:'b'.repeat(64)},execution:{schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded'}};
     try{await Preflight.loadVerifiedEngine(release);}catch(failure){loaderError=String(failure);}
    }
    return {supported,error,loaderError,isolated:crossOriginIsolated,secure:isSecureContext,resources:globalThis.__preflightResources};
   });
   await page.waitForTimeout(100);
   assert.equal(observation.isolated,true);assert.equal(observation.secure,true);
   assert.equal(observation.resources.createdWorkers,observation.resources.closedWorkers);assert.equal(observation.resources.createdUrls,observation.resources.revokedUrls);assert.equal(page.workers().length,0);
   if(name==='webkit'){assert.equal(observation.supported,false);assert.match(observation.loaderError,/E_BROWSER_SHARED_MEMORY_GROWTH.*当前浏览器不支持/);assert.equal(engineRequests.length,0);}
   else assert.equal(observation.supported,true,observation.error);
   results.browsers.push({name,version:browser.version(),...selected,origin,securityContext:certificateException?'local-https-with-test-certificate-exception':'secure-http-loopback',...observation,engineRequests:engineRequests.length,remainingBrowserWorkers:page.workers().length,status:'passed'});
   await context.close();
  }finally{await browser.close();}
 }
 results.status='passed';
}catch(error){results.status='failed';results.error=String(error);results.stack=error.stack;throw error;}
finally{await fs.writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2)+'\n');await Promise.all([close(http),close(https)]);await tls.dispose();}
console.log(JSON.stringify(results,null,2));
