import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '../../packages/project-tools/dist/pck.js';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'apps/playground/package.json'));
const {chromium}=require('playwright'),{build}=require('esbuild');
const args=process.argv.slice(2),at=args.indexOf('--report'),outAt=args.indexOf('--out');
const childBarrier=args.includes('--child-barrier'),jobsAt=args.indexOf('--cleanup-jobs'),cleanupJobs=jobsAt<0?1000000:Number(args[jobsAt+1]);
if(!Number.isSafeInteger(cleanupJobs)||cleanupJobs<1||cleanupJobs>20000000)throw Error('Invalid cleanup job budget');
if(at<0||!args[at+1])throw Error('Usage: native-web-checkpoint-probe.mjs --report <matching-web-build.json> [--out directory] [--child-barrier]');
const reportPath=path.resolve(args[at+1]),buildReport=JSON.parse(await readFile(reportPath,'utf8'));
assert.equal(buildReport.status,'built');
assert.equal(buildReport.execution?.shutdownQueueAbi,1,'actual managed queue source proof is required');
if(childBarrier)assert.equal(buildReport.execution?.executionModel,'proxy-pthread','the child lifetime probe needs a real pthread template');
const directory=path.resolve(outAt<0?path.join(root,'work/native-web-checkpoint'):args[outAt+1]);await mkdir(directory,{recursive:true});
const template=path.resolve(path.dirname(reportPath),buildReport.template.path),templateBytes=await readFile(template);
assert.equal(createHash('sha256').update(templateBytes).digest('hex'),buildReport.template.sha256);
const served=path.join(directory,'template');await mkdir(served,{recursive:true});execFileSync(process.env.PYTHON??'python3',['-m','zipfile','-e',template,served]);
let source=`const G=require('godot'),R=require('godot-jsb').internal.native_runtime;
const event=(type,data={})=>console.log('WEB_NATIVE_CHECKPOINT '+JSON.stringify({type,...data}));
const check=(condition,label)=>{if(!condition)throw Error('E_WEB_CHECKPOINT_PROBE: '+label);};
exports.default=class Probe extends G.Node {
 _ready(){try{
  check(R?.checkpointAbi===1&&typeof R.scheduleCheckpoint==='function','actual native checkpoint ABI');
  check(R.checkpoint().canDestroy===false,'ready is a native callback');event('native-callback',{canDestroy:false});
  const scope=R.openScope(),child=new G.Node();child.name='CheckpointChild';this.add_child(child);R.claim(scope,child);
  child.connect('tree_exiting',G.Callable.create(()=>event('unexpected-native-callable')));
  const entry=globalThis.__godotjsRuntimeHost.openEntry();let complete=false,finish,requested=false,cleanupSafe=0;
  entry.capability.attachCleanup({
   beginClose:()=>{event('cleanup-begin');this.call_deferred('unexpectedCleanupBusiness');this.get_node('/root/Aux').call('queue_business');},
   tick:()=>{
    if(complete||!R.checkpoint().canDestroy)return;
    cleanupSafe++;
    if(!requested){requested=true;R.requestRelease(scope,child);child.queue_free();event('cleanup-safe',{canDestroy:true});}
    if(R.status(scope).pending===0){complete=true;R.closeScope(scope);event('cleanup-complete',{cleanupSafe});finish?.();}
   },
   close:()=>complete?undefined:new Promise(resolve=>{finish=resolve;}),seal:()=>event('cleanup-seal')
  });entry.ready();
  R.scheduleCheckpoint(()=>{try{
   check(R.checkpoint().canDestroy===true,'owner microtask safe');event('owner-checkpoint',{canDestroy:true});
   child.connect('renamed',G.Callable.create(()=>{check(R.checkpoint().canDestroy===false,'native signal nested under owner ticket');event('nested-native-callback',{canDestroy:false});}));
   child.emit_signal('renamed');
   check(R.checkpoint().canDestroy===true,'owner restored after signal');
   Promise.resolve().then(()=>{try{
    check(R.checkpoint().canDestroy===false,'ticket ends before Promise continuation');event('after-await',{canDestroy:false});this.get_tree().quit(0);
   }catch(error){event('failure',{error:String(error)});this.get_tree().quit(1);}});
  }catch(error){event('failure',{error:String(error)});this.get_tree().quit(1);}});
 }catch(error){event('failure',{error:String(error)});this.get_tree().quit(1);}}
 unexpectedCleanupBusiness(){event('unexpected-business');}
};`;
const childSource=`const {JSWorkerParent}=require('godot.worker'),host=globalThis.__godotjsRuntimeHost;
const event=(type,data={})=>console.log('WEB_NATIVE_CHECKPOINT '+JSON.stringify({type,at:Date.now(),...data}));
if(!host||host.role!=='script-worker')throw Error('E_CHILD_LIFETIME_ROLE');
const entry=host.openEntry();
entry.lifetime.defer(async()=>{const began=Date.now();event('worker-cleanup-start');for(let i=0;i<${cleanupJobs};i++)await Promise.resolve();event('worker-cleanup-complete',{jobs:${cleanupJobs},durationMs:Date.now()-began});});
entry.ready();entry.onNativeSeal(()=>event('worker-seal',{summary:entry.summary()}));
JSWorkerParent.postMessage({kind:'barrier-ready',role:host.role,epoch:entry.capability.epoch,cleanup:entry.summary().cleanup});`;
if(childBarrier)source=`const G=require('godot'),{JSWorker}=require('godot.worker'),host=globalThis.__godotjsRuntimeHost;
const event=(type,data={})=>console.log('WEB_NATIVE_CHECKPOINT '+JSON.stringify({type,at:Date.now(),...data}));
exports.default=class Probe extends G.Node {
 _ready(){
  if(!host||host.role!=='engine')throw Error('E_ENGINE_LIFETIME_ROLE');
  const entry=host.openEntry();entry.lifetime.defer(()=>event('engine-local-cleanup-complete'));entry.ready();entry.onNativeSeal(()=>event('engine-seal',{summary:entry.summary()}));
  this.worker=new JSWorker('src/barrier.worker');
  this.worker.onmessage=data=>{if(data?.kind!=='barrier-ready')return;event('worker-ready',{role:data.role,epoch:data.epoch,cleanup:data.cleanup});
   Promise.resolve().then(()=>{event('engine-quit');this.get_tree().quit(0);});};
 }
};`;
const encode=value=>new TextEncoder().encode(value),files=new Map([
 ['res://project.godot',encode('config_version=5\n[application]\nrun/main_scene="res://Probe.tscn"\n[autoload]\nAux="*res://ProbeAux.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
 ['res://ProbeAux.gd',encode('extends Node\nfunc _ready():\n\tadd_to_group("web_cleanup_probe")\nfunc queue_business():\n\tcall_deferred("unexpected_deferred")\n\tget_tree().call_group_flags(SceneTree.GROUP_CALL_DEFERRED | SceneTree.GROUP_CALL_UNIQUE, "web_cleanup_probe", "unexpected_unique")\n\tprint(\'WEB_NATIVE_CHECKPOINT {"type":"gd-queued-business"}\')\nfunc unexpected_deferred():\n\tprint(\'WEB_NATIVE_CHECKPOINT {"type":"unexpected-gd-deferred"}\')\nfunc unexpected_unique():\n\tprint(\'WEB_NATIVE_CHECKPOINT {"type":"unexpected-gd-unique"}\')\n')],
 ['res://Probe.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Probe.ts" id="1"]\n[node name="CheckpointProbe" type="Node"]\nscript=ExtResource("1")\n')],
 ['res://src/Probe.ts',encode('export default class Probe {}\n')],
 ['res://.godot/GodotJS/src/Probe.js',encode(source)],
 ['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
]);
if(childBarrier){files.set('res://src/barrier.worker.js',encode(childSource));files.set('res://.godot/GodotJS/src/barrier.worker.js',encode(childSource));}
await writeFile(path.join(served,'probe.pck'),packProject(files).pack);
const sdk=(await build({stdin:{contents:'export {BrowserEngineSession} from "./packages/engine/src/browser/engine-session.ts";export {installNativeLifecycleGate} from "./packages/engine/src/browser/lifecycle-gate.ts";',resolveDir:root},bundle:true,format:'iife',globalName:'ProbeSDK',platform:'browser',target:'es2022',write:false})).outputFiles[0].contents;
await writeFile(path.join(served,'probe-sdk.js'),sdk);
const execution=buildReport.execution;
await writeFile(path.join(served,'index.html'),`<!doctype html><canvas id="canvas" width="64" height="64"></canvas><script src="probe-sdk.js"></script><script src="godot.js"></script><script>
globalThis.probe={events:[],logs:[],summaries:[],errors:[],done:false,exitCode:null,nativeExitAt:null};
const session=new ProbeSDK.BrowserEngineSession({identity:{runId:'native-web-checkpoint',revision:1,generation:'probe',buildKey:'probe'},executionModel:${JSON.stringify(execution.executionModel)},requiresCrossOriginIsolation:${!!execution.requiresCrossOriginIsolation},hostResourceAbi:${JSON.stringify(execution.hostResourceAbi)},onDiagnostic:item=>{probe.errors.push(item.message);probe.done=true;},onLog:(level,text)=>probe.logs.push(text),onSummary:summary=>probe.summaries.push({summary,at:Date.now()})});
(async()=>{
 const engine=new Engine({canvas:document.getElementById('canvas'),executable:'godot',emscriptenPoolSize:2,persistentPaths:[],serviceWorker:'',focusCanvas:false,onPrint:(...args)=>probe.logs.push(args.join(' ')),onPrintError:(...args)=>probe.logs.push(args.join(' ')),onExit:code=>{probe.exitCode=code;probe.nativeExitAt=Date.now();probe.done=true;}});
 session.installResourceOwner(engine);await engine.preloadFile('probe.pck','/probe.pck');await engine.init('godot');session.attachEngine(engine);
 await engine.start({args:['--main-pack','/probe.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});
})().catch(error=>{probe.errors.push(String(error));probe.done=true;});
globalThis.cleanupProbe=async()=>{await session.waitForRuntimeSummary(1500);const facts=session.sessionFacts({...(probe.exitCode!==null?{nativeExit:{code:probe.exitCode}}:{})}),stats=session.getStats(),cleanup=await session.dispose('clean');return {facts:{...facts,hostCleanup:cleanup.status},stats,cleanup};};
</script>`);
const server=createServer(async(req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname),file=path.resolve(served,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(served+path.sep)){res.writeHead(403).end();return;}
 try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end(bytes);}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;const consoleLogs=[],pageErrors=[];
const result={schemaVersion:1,kind:childBarrier?'godotjs-actual-pthread-child-lifetime':'godotjs-actual-web-native-checkpoint',status:'failed',execution,templateSha256:buildReport.template.sha256,sdkBundleSha256:createHash('sha256').update(sdk).digest('hex'),...(childBarrier?{cleanupJobs}:{})};
try{
 const selected=resolveBrowserExecutable(chromium,'chromium');result.browserSource=selected.source;
 browser=await chromium.launch({headless:true,executablePath:selected.executablePath,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage();
 page.on('console',message=>{const text=message.text();consoleLogs.push(text);if(text.startsWith('WEB_NATIVE_CHECKPOINT '))process.stdout.write(text+'\n');});page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>probe.done,null,{timeout:150000});
 const observed=await page.evaluate(async()=>{const final=await cleanupProbe();return {...probe,...final};});result.observed=observed;result.pageErrors=pageErrors;
 const events=[...observed.logs,...consoleLogs].filter(text=>text.startsWith('WEB_NATIVE_CHECKPOINT ')).map(text=>JSON.parse(text.slice('WEB_NATIVE_CHECKPOINT '.length)));
 result.events=events;assert.equal(observed.exitCode,0,JSON.stringify({observed,events}));assert.deepEqual(observed.errors,[]);assert.deepEqual(pageErrors,[]);
 assert.deepEqual(observed.logs.filter(text=>/^ERROR:/.test(text)),[],'successful cleanup cannot hide native teardown errors');
 if(childBarrier){
  for(const type of ['worker-ready','engine-quit','engine-local-cleanup-complete','worker-cleanup-start','worker-cleanup-complete','worker-seal','engine-seal'])assert(events.some(event=>event.type===type),type);
  assert.equal(events.find(event=>event.type==='worker-ready').cleanup,'pending');assert(events.find(event=>event.type==='engine-local-cleanup-complete').at<events.find(event=>event.type==='worker-cleanup-complete').at,'engine local completion must precede pending child cleanup');
  assert(observed.stats.engineWorkers>=1&&observed.stats.scriptWorkers>=1,'both actual realm owners announced');
  assert.equal(observed.facts.runtimeSummary,'sealed');assert.equal(observed.facts.entryCleanup,'complete');
  for(const type of ['worker-seal','engine-seal']){const seal=events.find(event=>event.type===type);assert.equal(seal.summary.cleanup,'complete');assert(seal.at<=observed.nativeExitAt,'all cleanup seals precede physical native exit');}
 }else for(const type of ['native-callback','owner-checkpoint','nested-native-callback','after-await','cleanup-begin','cleanup-safe','cleanup-complete','gd-queued-business'])assert(events.some(event=>event.type===type),type);
 assert(!events.some(event=>event.type==='failure'||event.type.startsWith('unexpected-')));assert.equal(observed.cleanup.status,'complete');result.status='passed';
}catch(error){result.error=String(error);result.consoleLogs=consoleLogs;result.pageErrors=pageErrors;try{if(!result.observed)result.observed=await page?.evaluate(()=>probe);}catch{}process.exitCode=1;}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
await writeFile(path.join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
