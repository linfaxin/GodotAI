import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';

// A scoped native bridge probe, not product/asset-loader or audio acceptance.
// Run explicitly against a newly built pthread template:
// GODOTJS_WEB_ENGINE_REPORT=/path/report.json pnpm --filter @godot-js/web-bridge test
test('real pthread native disposal publishes its epoch summary to the host',{
  skip:!process.env.GODOTJS_WEB_ENGINE_REPORT,timeout:180000,
},async t=>{
  const report=JSON.parse(await readFile(process.env.GODOTJS_WEB_ENGINE_REPORT,'utf8'));
  assert.equal(report.status,'built');assert.equal(report.execution?.executionModel,'proxy-pthread');
  const template=path.resolve(path.dirname(path.resolve(process.env.GODOTJS_WEB_ENGINE_REPORT)),report.template.path);
  const templateSha256=createHash('sha256').update(await readFile(template)).digest('hex');
  assert.equal(templateSha256,report.template.sha256,'probe template bytes must match the source-bound report');
  const directory=await mkdtemp(path.join(tmpdir(),'godotjs-native-epoch-'));
  let server,browser;
  t.after(async()=>{
    await browser?.close();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await rm(directory,{recursive:true,force:true});
  });
  execFileSync(process.env.PYTHON??'python3',['-m','zipfile','-e',template,directory]);
  const {createSourceSnapshot,createBuildPlan,packBuildPlan}=await import('../../../../packages/project-tools/dist/build-plan.js');
  const plan=await createBuildPlan(await createSourceSnapshot({
    '/project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.ts" id="1"]\n[node name="Probe" type="Node"]\nscript=ExtResource("1")\n',
    '/main.ts':`import {Node,print} from 'godot';export default class Probe extends Node {_ready(){print('NATIVE_EPOCH_READY');this.get_tree().quit();}}`,
  }),{kind:'scene',source:'project'});
  const artifact=await packBuildPlan(plan);await writeFile(path.join(directory,'probe.pck'),artifact.pack);
  const html=`<!doctype html><canvas id="canvas"></canvas><script>
  globalThis.probe={events:[],logs:[],done:false,error:null};
  const OriginalWorker=Worker,urls=[];
  function WrappedWorker(script,options){
    const target=new URL(String(script),location.href).href;
    const prefix='globalThis.__godotjsRuntimeHost={assignRole(role){globalThis.__epochRole=role;},markProgress(){},reportLog(){return true;},reportDiagnostic(){return true;},beginNativeEpoch(epoch){postMessage({__epochProbe:1,type:"begin",epoch,role:globalThis.__epochRole});},endNativeEpoch(epoch){postMessage({__epochProbe:1,type:"end",epoch,role:globalThis.__epochRole});}};';
    const url=URL.createObjectURL(new Blob([prefix+'importScripts('+JSON.stringify(target)+');'],{type:'text/javascript'}));urls.push(url);
    const worker=new OriginalWorker(url,options);
    worker.addEventListener('message',event=>{if(event.data?.__epochProbe!==1)return;event.stopImmediatePropagation();probe.events.push(event.data);},true);
    return worker;
  }
  WrappedWorker.prototype=OriginalWorker.prototype;Object.setPrototypeOf(WrappedWorker,OriginalWorker);globalThis.Worker=WrappedWorker;
  </script><script src="godot.js"></script><script>
  (async()=>{
    const engine=new Engine({canvas:document.getElementById('canvas'),executable:'godot',persistentPaths:[],serviceWorker:'',focusCanvas:false,
      onPrint:(...args)=>probe.logs.push(args.join(' ')),onPrintError:(...args)=>probe.logs.push(args.join(' ')),
      onExit:code=>{probe.events.push({type:'exit',code});setTimeout(()=>{probe.done=true;for(const url of urls)URL.revokeObjectURL(url);},100);}});
    await engine.preloadFile('probe.pck','/probe.pck');await engine.init('godot');
    await engine.start({args:['--main-pack','/probe.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});
  })().catch(error=>{probe.error=String(error);});
  </script>`;
  await writeFile(path.join(directory,'index.html'),html);
  server=createServer(async(request,response)=>{
    response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname),filename=path.resolve(directory,'.'+(pathname==='/'?'/index.html':pathname));
    if(!filename.startsWith(directory+path.sep)){response.writeHead(403);response.end();return;}
    try{const bytes=await readFile(filename);response.setHeader('Content-Type',filename.endsWith('.wasm')?'application/wasm':filename.endsWith('.js')?'text/javascript':filename.endsWith('.html')?'text/html':'application/octet-stream');response.end(bytes);}catch{response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {launchTestBrowser}=await import('../../../../apps/playground/scripts/browser-harness.mjs');
  browser=await launchTestBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage(),pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.goto('http://127.0.0.1:'+server.address().port);
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  await page.waitForFunction(()=>probe.done||probe.error,null,{timeout:150000});
  const observed=await page.evaluate(()=>probe);assert.equal(observed.error,null,JSON.stringify(observed));
  assert.deepEqual(pageErrors,[],JSON.stringify(observed));
  assert(observed.logs.some(line=>line.includes('NATIVE_EPOCH_READY')),JSON.stringify(observed));
  const start=observed.events.find(event=>event.type==='begin'&&event.role==='engine');
  assert(start,JSON.stringify(observed));
  assert(observed.events.some(event=>event.type==='end'&&event.epoch===start.epoch),JSON.stringify(observed));
  assert(observed.events.some(event=>event.type==='exit'&&event.code===0),JSON.stringify(observed));
  t.diagnostic(JSON.stringify({scope:'actual-pthread-native-epoch-observation',engineSha256:templateSha256,sourceCertified:report.sourceCertified===true,events:observed.events}));
});
