import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {build,transform} from 'esbuild';
import {chromium} from 'playwright';
import {createEvidenceReceipt,REQUIRED_SOURCE_PATHS} from './evidence-utils.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const out=path.resolve(process.env.P0_LIFECYCLE_OUT??path.join(repo,'work/playground/p0/lifecycle'));
const engineJs=path.resolve(process.env.P0_ENGINE_JS??path.join(repo,'apps/playground/dist/engine/game.js'));
const engineWasm=path.resolve(process.env.P0_ENGINE_WASM??path.join(repo,'apps/playground/dist/engine/game.wasm'));
const count=Number(process.env.P0_LIFECYCLE_ITERATIONS??8);
const audioPlayback=process.env.P0_LIFECYCLE_AUDIO_PLAYBACK??'default';
assert(['default','stream'].includes(audioPlayback));
const selectedCases=process.env.P0_LIFECYCLE_CASES?.split(',');
assert(Number.isInteger(count)&&count>=1&&count<=100);
await mkdir(out,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytesJs=await readFile(engineJs),bytesWasm=await readFile(engineWasm);
const evidenceReceipt=process.env.P0_REQUIRE_EVIDENCE==='1'?await createEvidenceReceipt(REQUIRED_SOURCE_PATHS.lifecycle,{engineJs,engineWasm}):undefined;
const modes=['normal','reject-quit','ready-error','process-error','promise-error'];
const tools=await build({stdin:{contents:`export {packProject} from ${JSON.stringify(path.join(repo,'scripts/jsb.react-browser/src/pck.ts'))};`,resolveDir:repo},bundle:true,platform:'node',format:'cjs',write:false});
const toolPath=path.join(out,'lifecycle-pack.cjs');await writeFile(toolPath,tools.outputFiles[0].contents);
const {packProject}=createRequire(import.meta.url)(toolPath);
const source=await readFile(new URL('./lifecycle-probe.cjs',import.meta.url),'utf8');
const compiled=await transform(source,{loader:'js',format:'cjs',target:'es2022',sourcemap:'external',sourcefile:'res://src/LifecycleProbe.ts',sourcesContent:true});
const packs={};
for(const mode of modes){
 const enc=s=>new TextEncoder().encode(s),files=new Map([
  ['res://src/LifecycleProbe.ts',enc(source)],
  ['res://.godot/GodotJS/src/LifecycleProbe.js',enc(compiled.code+'\n//# sourceMappingURL=LifecycleProbe.js.map\n')],
  ['res://.godot/GodotJS/src/LifecycleProbe.js.map',enc(compiled.map)],
  ['res://lifecycle-config.js',enc('module.exports='+JSON.stringify({mode,audioPlayback})+';\n')],
  ['res://main.tscn',enc('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/LifecycleProbe.ts" id="1"]\n[node name="LifecycleProbe" type="Node2D"]\nscript = ExtResource("1")\n')],
  ['res://.godot/global_script_class_cache.cfg',enc('list=Array[Dictionary]([])\n')],
  ['res://project.godot',enc('config_version=5\n[application]\nconfig/name="P0 native lifecycle"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=96\nwindow/size/viewport_height=64\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[physics]\n2d/physics_engine="GodotPhysics2D"\n3d/physics_engine="GodotPhysics3D"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/logger/source_map_enabled=true\n')],
 ]);
 packs[mode]=packProject(files).pack;await writeFile(path.join(out,`lifecycle-${mode}.pck`),packs[mode]);
}

let previewSource=await readFile(path.join(repo,'apps/playground/preview.ts'),'utf8');
assert(previewSource.includes(", '--audio-driver', 'Dummy'"));
previewSource=previewSource.replace(", '--audio-driver', 'Dummy'",'');
const sessionAnchor='function startSession(identity: RunIdentity, port: MessagePort): void {';
assert.equal(previewSource.split(sessionAnchor).length,2,'One preview session entry is required for instrumentation');
previewSource=previewSource.replace(sessionAnchor,sessionAnchor+` (globalThis as any).__p0Identity=identity; (globalThis as any).__p0SendRaw=(value:any)=>port.postMessage(value);`);
previewSource=previewSource.replace('onExit: (code: number) => {',`onExit: (code: number) => { log('log',['P0_BROWSER_AUDIO_CLOSE '+JSON.stringify((globalThis as any).__p0AudioSnapshot?.())]);`);
previewSource=previewSource.replace("addEventListener('error', event => fatal(event.message));","addEventListener('error', event => fatal(new Error(event.message+'\\n'+(event.error?.stack??''))));");
const preview=await build({stdin:{contents:previewSource,loader:'ts',resolveDir:path.join(repo,'apps/playground')},bundle:true,platform:'browser',format:'iife',write:false,target:'es2022'});
let runnerSource=await readFile(path.join(repo,'scripts/jsb.react-browser/src/runner.ts'),'utf8');
assert(runnerSource.includes("'allow-scripts allow-same-origin'"));
runnerSource=runnerSource.replace("'allow-scripts allow-same-origin'","'allow-scripts allow-same-origin allow-pointer-lock'");
const runnerFile=path.join(out,'lifecycle-runner.ts');
// Imports remain in their original directory through esbuild's stdin resolveDir.
const runner=await build({stdin:{contents:runnerSource,loader:'ts',resolveDir:path.join(repo,'scripts/jsb.react-browser/src')},bundle:true,platform:'browser',format:'iife',globalName:'P0Runner',write:false,target:'es2022'});
const instrumentation=`(()=>{const Native=globalThis.AudioContext;const records=[];const connect=globalThis.AudioNode?.prototype.connect;
if(Native){globalThis.AudioContext=new Proxy(Native,{construct(T,args,N){const ctx=Reflect.construct(T,args,N);const record={ctx,analysers:[],closeCalls:0,closed:false,maxPeak:0};records.push(record);const close=ctx.close.bind(ctx);ctx.close=()=>{record.closeCalls++;return close().then(()=>{record.closed=true;});};return ctx;}});}
if(connect){AudioNode.prototype.connect=function(...args){const result=connect.apply(this,args);const record=records.find(r=>r.ctx===this.context);if(record&&args[0]===this.context.destination){const analyser=this.context.createAnalyser();analyser.fftSize=256;connect.call(this,analyser);record.analysers.push(analyser);}return result;};}
globalThis.__p0AudioSnapshot=()=>({contexts:records.length,records:records.map(r=>{const peak=Math.max(0,...r.analysers.map(a=>{const values=new Float32Array(a.fftSize);a.getFloatTimeDomainData(values);return Math.max(...values.map(Math.abs));}));r.maxPeak=Math.max(r.maxPeak,peak);return {state:r.ctx.state,closeCalls:r.closeCalls,closed:r.closed,peak,peakMax:r.maxPeak};})});})();`;
const client=`window.p0={events:[],runner:undefined,serial:0};window.setup=async previewUrl=>{const release=await(await fetch('/release.json')).json();p0.runner=new P0Runner.PreviewRunner({container:document.querySelector('#preview'),previewUrl,release,deadlines:{stopping:1200,heartbeat:12000,downloading:120000,initializing:120000,starting:120000}});p0.runner.subscribe(e=>{p0.events.push(e);if(e.type!=='log'||e.level==='error'||e.text.startsWith('P0_'))console.log('P0_EVENT '+JSON.stringify(e));});};window.run=async mode=>{const bytes=new Uint8Array(await(await fetch('/packs/'+mode+'.pck')).arrayBuffer());const revision=++p0.serial;return p0.runner.run({revision,buildKey:'p0-lifecycle-'+mode,generation:'p0-'+revision,manifest:{generation:'p0-'+revision},pack:bytes});};`;
let editorServer,previewServer,previewOrigin;
const requestLog=[];
const serve=()=>createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://local').pathname;requestLog.push({method:req.method,path:pathname});
 res.setHeader('Access-Control-Allow-Origin','*');
 try{
  if(pathname==='/'){res.setHeader('content-type','text/html');return res.end('<button id="gesture">Activate</button><div id="preview"></div><script src="/runner.js"></script><script src="/client.js"></script>');}
  if(pathname==='/preview.html'){res.setHeader('content-type','text/html');return res.end('<canvas id="canvas" width="96" height="64" tabindex="0"></canvas><div id="connection-status"></div><script>'+instrumentation+'</script><script src="/preview.js"></script>');}
  if(pathname==='/runner.js'){res.setHeader('content-type','text/javascript');return res.end(runner.outputFiles[0].contents);}
  if(pathname==='/preview.js'){res.setHeader('content-type','text/javascript');return res.end(preview.outputFiles[0].contents);}
  if(pathname==='/client.js'){res.setHeader('content-type','text/javascript');return res.end(client);}
  if(pathname==='/release.json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({releaseId:'p0-'+sha(bytesWasm).slice(0,16),profile:'native-full-runtime',engineJs:{url:previewOrigin+'/engine/game.js',sha256:sha(bytesJs)},engineWasm:{url:previewOrigin+'/engine/game.wasm',sha256:sha(bytesWasm)},allowedOrigins:[previewOrigin]}));}
  if(pathname.startsWith('/packs/')){const mode=pathname.slice(7,-4);if(packs[mode]){res.setHeader('content-type','application/octet-stream');return res.end(packs[mode]);}}
  if(pathname==='/engine/game.js'){res.setHeader('content-type','text/javascript');return res.end(bytesJs);}
  if(pathname==='/engine/game.wasm'){res.setHeader('content-type','application/wasm');return res.end(bytesWasm);}
  if(pathname.startsWith('/engine/game.audio.')){
   const suffix=pathname.slice('/engine/game'.length);const candidates=[path.join(path.dirname(engineJs),path.basename(engineJs,'.js')+suffix),path.join(path.dirname(engineJs),'godot'+suffix),path.join(repo,'apps/playground/dist/engine','game'+suffix)];
   for(const file of candidates)try{const bytes=await readFile(file);res.setHeader('content-type','text/javascript');return res.end(bytes);}catch{}
  }
  if(pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  res.writeHead(404);res.end();
 }catch(error){res.writeHead(500);res.end(String(error));}
});
editorServer=serve();previewServer=serve();await new Promise(r=>editorServer.listen(0,'127.0.0.1',r));await new Promise(r=>previewServer.listen(0,'127.0.0.1',r));
const editorOrigin='http://127.0.0.1:'+editorServer.address().port;previewOrigin='http://127.0.0.1:'+previewServer.address().port;
const report={status:'running',...(evidenceReceipt?{evidenceReceipt}:{}),engine:{js:engineJs,wasm:engineWasm,jsSha:sha(bytesJs),wasmSha:sha(bytesWasm),wasmBytes:bytesWasm.byteLength},fixture:{sourceSha:sha(source),compiledJsSha:sha(compiled.code),sourceMapSha:sha(compiled.map),packs:Object.fromEntries(Object.entries(packs).map(([mode,bytes])=>[mode,{sha256:sha(bytes),bytes:bytes.byteLength}]))},origins:{editorOrigin,previewOrigin},audioPlayback,iterations:count,checks:[],runs:[],exits:[],observations:{},errors:[],limitations:['Local separate-origin deployment only; no production host configured.','Iframe removal is not proof of process-level memory isolation or immediate native/GPU collection.','Browser AudioContext interception observes constructed/closed contexts and actual analyser samples; no physical speaker measurement.','Temporary fixture enables pointer lock and serves a permissive test policy; current product CSP and permissions are not modified.']};
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:800,height:600}});page.setDefaultTimeout(45000);const consoleErrors=[];
page.on('pageerror',error=>consoleErrors.push(String(error)));
page.on('console',event=>{if(event.text().startsWith('P0_EVENT '))console.log(event.text());});
const save=()=>writeFile(path.join(out,'lifecycle-report.json'),JSON.stringify(report,null,2));
const check=async(name,fn)=>{if(selectedCases&&!selectedCases.some(part=>name.includes(part)))return;try{const evidence=await fn();report.checks.push({name,status:'passed',evidence});}catch(error){report.checks.push({name,status:'failed',error:String(error),stack:error.stack});report.status='failed';await page.evaluate(async()=>{await p0.runner.stop();document.querySelectorAll('#preview iframe').forEach(f=>f.remove());}).catch(()=>{});}await save();console.log(JSON.stringify(report.checks.at(-1)));};
const start=async(mode='normal')=>{const at=Date.now();const run=await page.evaluate(mode=>window.run(mode),mode);await page.waitForFunction(id=>p0.events.some(e=>e.type==='log'&&e.runId===id&&e.text.startsWith('P0_LIFECYCLE_REPORT ')),run.runId);return {...run,startupMs:Date.now()-at};};
const stop=async(run,reason='clean-exit')=>{const exit=await page.evaluate(()=>p0.runner.stop());report.exits.push(exit);await save();assert.equal(exit.runId,run.runId);assert.equal(exit.reason,reason);assert.equal(await page.locator('iframe').count(),0);return exit;};
const nativeReport=run=>page.evaluate(id=>JSON.parse(p0.events.find(e=>e.type==='log'&&e.runId===id&&e.text.startsWith('P0_LIFECYCLE_REPORT ')).text.slice('P0_LIFECYCLE_REPORT '.length)),run.runId);
try{
 await page.goto(editorOrigin);await page.evaluate(url=>setup(url),previewOrigin+'/preview.html');
 await check('public-engine-memory-PCK-real-physics-audio-pointerlock',async()=>{
  const run=await start();const native=await nativeReport(run);assert(native.physicsTicks>5&&native.processTicks>12&&native.rayHit&&native.audioPlaying);
  const frame=page.frames().find(f=>f.url().startsWith(previewOrigin+'/preview.html'));assert(frame);
  const before=await frame.evaluate(()=>__p0AudioSnapshot());
  await frame.locator('canvas').click({position:{x:30,y:25}});
  await frame.waitForFunction(()=>__p0AudioSnapshot().records.some(r=>r.state==='running'&&r.peakMax>.001));
  const audio=await frame.evaluate(()=>__p0AudioSnapshot());
  await frame.waitForFunction(()=>document.pointerLockElement===document.querySelector('canvas'));
  const pointerLocked=await frame.evaluate(()=>document.pointerLockElement===document.querySelector('canvas'));await frame.evaluate(()=>document.exitPointerLock());
  report.observations.audioPhysicsPointer={native,beforeGesture:before,afterGesture:audio,pointerLocked};await save();
  const exit=await stop(run);const logs=await page.evaluate(id=>p0.events.filter(e=>e.type==='log'&&e.runId===id).map(e=>e.text),run.runId);
  const closed=logs.find(s=>s.startsWith('P0_BROWSER_AUDIO_CLOSE '));assert(closed,'Native onExit audio snapshot required');const closeState=JSON.parse(closed.slice('P0_BROWSER_AUDIO_CLOSE '.length));assert(closeState.records.every(r=>r.state==='closed'&&r.closeCalls===1));
  report.runs.push({...run,exit,native});return {native,beforeGesture:before,afterGesture:audio,pointerLocked,exit,audioOnExit:closeState};
 });
 await check('wrong-run-message-ignored-and-quit-refusal-forced-disposal',async()=>{
  const run=await start('reject-quit');const frame=page.frames().find(f=>f.url().startsWith(previewOrigin+'/preview.html'));
  await frame.evaluate(()=>__p0SendRaw({...__p0Identity,protocolVersion:1,runId:'stale-run',type:'log',level:'log',text:'P0_STALE_SHOULD_NOT_ARRIVE'}));await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>p0.events.some(e=>e.type==='log'&&e.text==='P0_STALE_SHOULD_NOT_ARRIVE')),false);
  const exit=await stop(run,'forced-frame-disposal');assert.equal(exit.code,undefined);return {exit};
 });
 await check('native-lifecycle-and-promise-errors-preserve-source',async()=>{
  const results=[];
  for(const [mode,marker]of [['ready-error','P0_READY_ERROR'],['process-error','P0_PROCESS_ERROR']]){
   const run=await start(mode);await page.waitForFunction(({id,marker})=>p0.events.some(e=>e.type==='log'&&e.runId===id&&e.text.includes(marker)),{id:run.runId,marker});
   const logs=await page.evaluate(id=>p0.events.filter(e=>e.type==='log'&&e.runId===id).map(e=>e.text),run.runId);const matching=logs.filter(s=>s.includes(marker)||s.includes('LifecycleProbe'));
   assert(matching.some(s=>/LifecycleProbe\.(?:ts|js)/.test(s)),'Error must retain native source location');
   report.observations.errors??=[];const observation={mode,matching,sourceMapMapped:matching.some(s=>s.includes('res://src/LifecycleProbe.ts'))};report.observations.errors.push(observation);await save();
   const exit=await stop(run);results.push({...observation,exit});
  }
  const promise=await page.evaluate(async()=>{const offset=p0.events.length;const result=await window.run('promise-error').then(value=>({resolved:true,value}),error=>({resolved:false,error:String(error)}));return {result,events:p0.events.slice(offset)};});
  const exit=promise.events.find(e=>e.type==='exit')?.report;assert(exit&&exit.reason==='crashed');assert.match(exit.detail,/P0_PROMISE_ERROR/);assert.equal(await page.locator('iframe').count(),0);
  const sourcePreserved=/LifecycleProbe\.(?:ts|js)/.test(exit.diagnostic?.stack??'')&&/P0_PROMISE_ERROR/.test(exit.diagnostic?.stack??'');
  report.observations.promise={...promise,sourcePreserved};await save();
  assert(sourcePreserved,'Promise fatal must retain original source stack, not only Error.message');results.push({mode:'promise-error',exit,sourcePreserved});
  return results;
 });
 await check('real-engine-cancellation-at-six-startup-phases',async()=>{
  const results=[];
  for(const phase of ['loading-frame','handshaking','downloading','preloading','initializing','starting']){
   const result=await page.evaluate(async target=>{
    const runner=p0.runner;let pendingStop;const unsubscribe=runner.subscribe(e=>{if(e.type==='state'&&e.state===target&&!pendingStop){pendingStop=runner.stop();}});
    let run;try{run=await window.run('normal').then(value=>({resolved:true,value}),error=>({resolved:false,error:String(error)}));if(!pendingStop)throw Error('Target phase was not observed: '+target);const exit=await pendingStop;return {phase:target,run,exit,frames:document.querySelectorAll('iframe').length};}finally{unsubscribe();}
   },phase);
   results.push(result);report.observations.cancellations=results;await save();
   await page.evaluate(()=>document.querySelectorAll('#preview iframe').forEach(f=>f.remove()));
  }
  for(const result of results){assert.equal(result.frames,0,'No frame may remain after '+result.phase+' cancellation');assert.equal(result.run.resolved,false);assert(['clean-exit','forced-frame-disposal','unresponsive'].includes(result.exit.reason));}
  return results;
 });
 await check('repeated-fresh-native-instances-clean-exit',async()=>{
  const seen=new Set(),samples=[];
  for(let i=0;i<count;++i){const run=await start();assert(!seen.has(run.runId));seen.add(run.runId);const native=await nativeReport(run);assert(native.rayHit);const exit=await stop(run);report.runs.push({...run,exit,native});
   const logs=await page.evaluate(id=>p0.events.filter(e=>e.type==='log'&&e.runId===id).map(e=>e.text),run.runId);const closed=logs.find(s=>s.startsWith('P0_BROWSER_AUDIO_CLOSE '));assert(closed);const state=JSON.parse(closed.slice('P0_BROWSER_AUDIO_CLOSE '.length));assert(state.records.every(r=>r.state==='closed'&&r.closeCalls===1));
   if((i+1)%10===0||i===count-1){samples.push({completed:i+1,frames:await page.locator('iframe').count(),audioOnExit:state});await save();console.log(JSON.stringify({completed:i+1,total:count}));}
  }
  return {uniqueRuns:seen.size,samples};
 });
 await check('rapid-run-replacement-keeps-one-active-instance-and-private-pack',async()=>{
  const results=[];
  for(let i=0;i<5;++i){
   const outcome=await page.evaluate(async()=>{
    const bytes=new Uint8Array(await(await fetch('/packs/normal.pck')).arrayBuffer()),firstRevision=++p0.serial,lastRevision=++p0.serial;
    const artifact=revision=>({revision,buildKey:'p0-rapid-'+revision,generation:'p0-rapid-'+revision,manifest:{generation:'p0-rapid-'+revision},pack:bytes});
    const first=p0.runner.run(artifact(firstRevision)).then(value=>({resolved:true,value}),error=>({resolved:false,error:String(error)}));
    const last=p0.runner.run(artifact(lastRevision));bytes.fill(0);
    return {superseded:await first,active:await last,frames:document.querySelectorAll('iframe').length};
   });
   assert.equal(outcome.superseded.resolved,false);assert.match(outcome.superseded.error,/Superseded|E_RUN_ENDED/);assert.equal(outcome.frames,1);
   await page.waitForFunction(id=>p0.events.some(e=>e.type==='log'&&e.runId===id&&e.text.startsWith('P0_LIFECYCLE_REPORT ')),outcome.active.runId);
   const native=await nativeReport(outcome.active);assert(native.rayHit);const exit=await stop(outcome.active);results.push({...outcome,native,exit});
  }
  return results;
 });
 await page.evaluate(()=>p0.runner.dispose());
 report.errors=consoleErrors;assert.deepEqual(consoleErrors,[]);assert.equal(await page.locator('iframe').count(),0);
 if(report.status!=='failed')report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);report.stack=error.stack;await page.screenshot({path:path.join(out,'lifecycle-failure.png')}).catch(()=>{});}
finally{report.requestCount=requestLog.length;report.requests=requestLog;await save();await browser.close();await Promise.all([new Promise(r=>editorServer.close(r)),new Promise(r=>previewServer.close(r))]);}
console.log(JSON.stringify({status:report.status,checks:report.checks.map(c=>({name:c.name,status:c.status})),report:path.join(out,'lifecycle-report.json')}));
if(report.status!=='passed')process.exitCode=1;
