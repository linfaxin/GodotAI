import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';

const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??'/workspace/output/engine-worker-implementation/product-candidate-v8-final');
const output=process.env.PLAYGROUND_UNSUPPORTED_REPORT;
const site=await fs.readFile(path.join(directory,'manifest.json'));
const candidateId=createHash('sha256').update(site).digest('hex'),urlPrefix='/releases/'+candidateId+'/';
const tls=await createLocalTestTls(),editor=createStaticServer(directory,{urlPrefix,publicImmutable:true,tls}),preview=createStaticServer(directory,{urlPrefix,publicImmutable:true,tls});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
const playwright=createRequire(new URL('../package.json',import.meta.url))('playwright');
let browser,context,page,deployment;
const engineRequests=[],pageErrors=[];
try{
 await Promise.all([listen(editor),listen(preview)]);
 const editorOrigin='https://127.0.0.1:'+editor.address().port,previewOrigin='https://127.0.0.1:'+preview.address().port;
 const delivery=await inspectTestSite(editorOrigin+urlPrefix,tls);
 deployment={...localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:delivery.headers}),kind:'local-https-negative-compatibility-fixture',tls:{validation:'playwright-local-test-certificate-exception',certificateSha256:tls.certificateSha256}};
 const localWrapper='/workspace/.godotai-tools/apt-browser-deps/run-webkit';
 const executablePath=process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE??(existsSync(localWrapper)?localWrapper:playwright.webkit.executablePath());
 browser=await playwright.webkit.launch({headless:true,executablePath});
 context=await browser.newContext({ignoreHTTPSErrors:true});
 await context.addInitScript(()=>{
  globalThis.__unsupportedTerminal=[];
  const Original=MessageChannel;
  globalThis.MessageChannel=new Proxy(Original,{construct(target,args,newTarget){const channel=Reflect.construct(target,args,newTarget);for(const port of [channel.port1,channel.port2])port.addEventListener('message',event=>{if(event.data?.protocolVersion===1&&['fatal','terminated','exited'].includes(event.data.type))globalThis.__unsupportedTerminal.push(event.data);});return channel;}});
 });
 page=await context.newPage();page.on('pageerror',error=>pageErrors.push(String(error)));
 page.on('request',request=>{if(/\/engine\/game\.(?:js|wasm)(?:\.gz)?$/.test(new URL(request.url()).pathname))engineRequests.push(request.url());});
 await page.goto(editorOrigin+urlPrefix+'?previewOrigin='+encodeURIComponent(previewOrigin+urlPrefix));
 await page.waitForFunction(()=>document.querySelector('#logs')?.textContent.includes('E_BROWSER_SHARED_MEMORY_GROWTH'),null,{timeout:120000});
 await page.waitForFunction(()=>!document.querySelector('#preview iframe'),null,{timeout:10000});
 const observation=await page.evaluate(()=>({logs:document.querySelector('#logs').textContent,state:globalThis.__playgroundWorkbench.inspect(),terminal:globalThis.__unsupportedTerminal,isolated:crossOriginIsolated,secure:isSecureContext}));
 assert.equal(observation.state.releaseContext.candidateId,candidateId);assert.equal(observation.state.engine.state,'exited');assert.equal(observation.isolated,true);assert.equal(observation.secure,true);
 assert.match(observation.logs,/当前浏览器不支持此 Worker 引擎模式/);assert.equal(engineRequests.length,0);assert.deepEqual(pageErrors,[]);
 assert.equal(observation.terminal.length,1);const terminal=observation.terminal[0];assert.equal(terminal.type,'fatal');assert.match(terminal.text,/E_BROWSER_SHARED_MEMORY_GROWTH/);assert.equal(terminal.cleanup.workers,1);assert.equal(terminal.cleanup.terminatedWorkers,1);assert.deepEqual(terminal.cleanup.errors,[]);
 await page.waitForTimeout(100);const remainingPreviewWorkers=page.workers().filter(worker=>worker.url().startsWith('blob:'+previewOrigin)).length;assert.equal(remainingPreviewWorkers,0);
 const report={schemaVersion:1,kind:'godotjs-unsupported-worker-product-guard',status:'passed',workerExecutionSupported:false,engineExecuted:false,candidateId,releaseId:observation.state.engine.releaseId,browser:{name:'webkit',version:browser.version()},deployment,engineRequests:0,remainingPreviewWorkers,pageErrors,observation};
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}catch(error){const report={status:'failed',error:String(error),stack:error.stack,candidateId,deployment,engineRequests,pageErrors,logs:await page?.locator('#logs').textContent().catch(()=>undefined)};if(output)await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));throw error;}
finally{await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls.dispose();}
