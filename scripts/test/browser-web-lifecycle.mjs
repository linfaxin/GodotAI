#!/usr/bin/env node
/** Real Godot Web exit-gate probe. It runs the same native template in its
 * declared owner realm; the ordinary Dedicated product is tested separately. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveBrowserSite} from './browser-server.mjs';
import {options} from '../release/web-release-utils.mjs';
import {webLifecycleBuildProof} from '../release/patch-web-lifecycle.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const request=createRequire(path.join(repository,'apps/playground/package.json'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>new TextEncoder().encode(value);
async function until(check,label,timeout=120000){
 const deadline=Date.now()+timeout;
 while(!check()){
  if(Date.now()>=deadline)throw Error('E_LIFECYCLE_PROBE_TIMEOUT: '+label);
  await new Promise(resolve=>setTimeout(resolve,20));
 }
}

export function nativeLifecycleProject(mode){
 const source=`const G=require('godot');
const mode=${JSON.stringify(mode)};
const emit=value=>console.log('GODOTJS_LIFECYCLE_PROBE '+JSON.stringify({mode,...value}));
exports.default=class NativeLifecycleProbe extends G.Node {
 _ready(){
  const binding=globalThis.__godotjsRuntimeHost;
  if(!binding||typeof binding.beginClose!=='function')throw Error('Missing managed lifecycle binding');
  this.entry=binding.openEntry();this.frames=0;
  const audioServer=G.AudioServer,staleNative=audioServer.get_bus_index;
  this.callStaleNative=()=>staleNative.call(audioServer,'Master');
  // A pthread can close before queued microtasks run. Observe the real logical
  // seal synchronously, while its physical Isolate and native handles remain.
  const bridge=globalThis._jsbb_,seal=bridge.SealNativeEpoch;let observedSeal=false;
  bridge.SealNativeEpoch=function(...args){
   const result=seal.apply(this,args);
   if(!observedSeal&&this.engine){
    observedSeal=true;
    const interop=this.interop,original=interop.call_function;let nativeCalls=0,threw=false;
    interop.call_function=function(...values){nativeCalls++;return original.apply(this,values);};
    try{staleNative.call(audioServer,'Master');}catch(_){threw=true;}finally{interop.call_function=original;}
    emit({phase:'late-native',nativeCalls,threw,physicalBridgeRetained:!!this.engine});
   }
   return result;
  };
  this.attached=new G.Node();this.add_child(this.attached);this.detached=new G.Node();
  this.entry.lifetime.onCancel(()=>emit({phase:'cancel',frames:this.frames}));
  this.entry.lifetime.defer(async()=>{
   const frames=this.frames;
   emit({phase:'cleanup-start',frames,worker:typeof WorkerGlobalScope!=='undefined'});
   if(mode==='hang-cleanup')await new Promise(()=>{});
   await new Promise(resolve=>setTimeout(resolve,25));
   if(this.frames!==frames)throw Error('Business frames continued during native cleanup gate');
   if(G.AudioServer.get_bus_index('Master')<0)throw Error('Audio service closed before cleanup');
   if(mode==='failing-cleanup')throw Error('EXPECTED_LIFECYCLE_CLEANUP_FAILURE');
   this.attached.queue_free();this.detached.queue_free();
   for(let i=0;i<200&&(G.is_instance_valid(this.attached)||G.is_instance_valid(this.detached));i++)await new Promise(resolve=>setTimeout(resolve,5));
   if(G.is_instance_valid(this.attached)||G.is_instance_valid(this.detached))throw Error('Native delete queue did not run during cleanup');
   emit({phase:'cleanup-complete',frames:this.frames,destroyed:true});
  });
  if(mode!=='pending-startup')this.entry.finishStartup();
  this.entry.host.bindProjectCommand(data=>{if(data.type==='quit')this.get_tree().quit(0);});
  emit({phase:'ready',worker:typeof WorkerGlobalScope!=='undefined',role:binding.role});
 }
 _process(){this.frames++;if(this.frames===5&&mode!=='command-quit')this.get_tree().quit(0);}
 _exit_tree(){
  emit({phase:'exit-tree',frames:this.frames});
 }
};`;
 return new Map([
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="Native lifecycle probe"\nrun/main_scene="res://Main.tscn"\n[display]\nwindow/size/viewport_width=96\nwindow/size/viewport_height=64\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
  ['res://Main.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n')],
  ['res://src/Main.ts',encode('export default class NativeLifecycleProbe {}\n')],
  ['res://.godot/GodotJS/src/Main.js',encode(source)],
  ['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
 ]);
}

async function localCertificate(directory){
 const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
 const created=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{encoding:'utf8'});
 if(created.status!==0)throw Error('E_LIFECYCLE_TLS: '+created.stderr);
 const pub=spawnSync('openssl',['x509','-in',cert,'-pubkey','-noout'],{encoding:'utf8'});
 const der=spawnSync('openssl',['pkey','-pubin','-outform','DER'],{input:pub.stdout});
 if(der.status!==0)throw Error('E_LIFECYCLE_TLS_SPKI');
 return {key:await readFile(key),cert:await readFile(cert),spki:createHash('sha256').update(der.stdout).digest('base64')};
}

export async function runWebLifecycleProbe({engineReport,out,timeout=10000}={}){
 if(!engineReport)throw Error('Pass --engine-report from a real matching Web build');
 const reportBytes=await readFile(engineReport),report=JSON.parse(reportBytes);
 if(report.status!=='built'||report.execution?.lifecycleAbi!==1)throw Error('E_LIFECYCLE_BUILD');
 const proof=webLifecycleBuildProof(report.recipe?.patches??[]);
 assert.deepEqual(proof.lifecyclePatch,report.lifecyclePatch);
 for(const [name,record]of Object.entries(proof.lifecyclePatch.files))assert.equal(report.godotSource.inputs[name],record.sha256);
 const directory=path.resolve(out??path.join(repository,'work/web-execution/native-lifecycle'));
 const site=path.join(directory,'site');await mkdir(path.join(site,'engine'),{recursive:true});
 const archive=path.resolve(path.dirname(path.resolve(engineReport)),report.template.path);
 assert.equal(hash(await readFile(archive)),report.template.sha256,'Matching template bytes');
 const extraction=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:z.extractall(sys.argv[2])',archive,path.join(site,'engine')],{encoding:'utf8'});
 if(extraction.status!==0)throw Error('E_LIFECYCLE_TEMPLATE: '+extraction.stderr);
 const {build}=request('esbuild'),{chromium}=request('playwright');
 await build({stdin:{contents:`export {BrowserEngineSession} from ${JSON.stringify(path.join(repository,'packages/engine/src/browser/engine-session.ts'))};export {installNativeLifecycleGate} from ${JSON.stringify(path.join(repository,'packages/engine/src/browser/lifecycle-gate.ts'))};`,resolveDir:repository},bundle:true,format:'iife',globalName:'EngineHost',platform:'browser',target:'es2022',outfile:path.join(site,'session.js')});
 const {packProject}=await import('@godot-js/project-tools/pck');
 const packs={};
 for(const mode of ['self-quit','command-quit','failing-cleanup','hang-cleanup','pending-startup']){
  const pack=packProject(nativeLifecycleProject(mode)).pack;packs[mode]=hash(pack);await writeFile(path.join(site,mode+'.pck'),pack);
 }
 await writeFile(path.join(site,'index.html'),'<!doctype html><link rel="icon" href="data:,"><canvas id="canvas" width="96" height="64"></canvas><script src="session.js"></script><script src="engine/godot.js"></script>');
 const tls=await localCertificate(directory);
 const server=await serveBrowserSite({root:site,tls,isolation:report.execution.requiresCrossOriginIsolation?'require-corp':false});
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--ignore-certificate-errors-spki-list='+tls.spki]});
 const result={schemaVersion:1,kind:'godotjs-real-web-lifecycle',status:'running',engineReport:path.resolve(engineReport),engineReportSha256:hash(reportBytes),templateSha256:report.template.sha256,execution:report.execution,browser:browser.version(),packs,cases:[]};
 try{
  for(const mode of Object.keys(packs)){
   const page=await browser.newPage(),events=[],errors=[],logs=[],failedRequests=[];
   const current={name:mode,status:'running',events,errors,logs,failedRequests};result.cases.push(current);
   page.on('console',message=>{const text=message.text(),marker='GODOTJS_LIFECYCLE_PROBE ';if(logs.length<100)logs.push(text);if(process.env.GODOTJS_LIFECYCLE_VERBOSE==='1')console.log(mode,message.type(),text);const at=text.indexOf(marker);if(at>=0)try{events.push(JSON.parse(text.slice(at+marker.length)));}catch{} });
   page.on('pageerror',error=>errors.push(String(error)));
   page.on('requestfailed',request=>failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
   await page.goto(server.url);
   await page.evaluate(async({mode,execution})=>{
    const probe=window.__lifecycleProbe={exitCode:null,diagnostics:[],errors:[],forced:false,module:null};
    const session=probe.session=new EngineHost.BrowserEngineSession({identity:{runId:crypto.randomUUID(),revision:1,generation:'lifecycle',buildKey:'lifecycle'},executionModel:execution.executionModel,requiresCrossOriginIsolation:execution.requiresCrossOriginIsolation,onDiagnostic:item=>probe.diagnostics.push(item)});
    // Window execution is a native gate probe only. Dedicated product coverage
    // uses the actual Worker host; pthread installs this in its own bootstrap.
    if(execution.executionModel==='window')globalThis.__godotjsInstallLifecycle=module=>{
     probe.module=module;
     EngineHost.installNativeLifecycleGate(module,globalThis.__godotjsRuntimeHost,{onError:error=>probe.errors.push(String(error))});
    };
    const engine=probe.engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/godot',emscriptenPoolSize:2,persistentPaths:[],persistentDrops:false,onExit:code=>{probe.exitCode=code;}});
    const pack=new Uint8Array(await(await fetch('/'+mode+'.pck')).arrayBuffer());
    await engine.preloadFile(pack,'/application.pck');await engine.init('/engine/godot');session.attachEngine(engine);
    let deadline;
    try{await Promise.race([engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility']}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('E_LIFECYCLE_NATIVE_START_TIMEOUT')),120000);})]);}
    finally{clearTimeout(deadline);}
   },{mode,execution:report.execution});
   await until(()=>events.some(event=>event.phase==='ready'),'actual project ready');
   if(mode==='command-quit'){
    assert.equal(await page.evaluate(()=>window.__lifecycleProbe.session.command({type:'quit'})),true);
   }
   if(mode==='hang-cleanup'||mode==='pending-startup'){
    await until(()=>events.some(event=>event.phase==='cleanup-start'),'actual native cleanup gate');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>window.__lifecycleProbe.exitCode),null,'Pending cleanup cannot permit native exit');
    await page.evaluate(async()=>{window.__lifecycleProbe.forced=true;window.__lifecycleProbe.cleanup=await window.__lifecycleProbe.session.dispose('forced');});
   }else await page.waitForFunction(()=>window.__lifecycleProbe.exitCode!==null,null,{timeout});
   const observed=await page.evaluate(async()=>{
    const p=window.__lifecycleProbe;
    if(p.exitCode!==null)await p.session.waitForRuntimeSummary();
    const facts=p.session.sessionFacts({...(p.exitCode!==null?{nativeExit:{code:p.exitCode}}:{}),forcedTerminationIssued:p.forced});
    const native=p.module?{version:p.module.godotjsLifecycleVersion,ticks:p.module.godotjsNativeCleanupTicks,phase:p.module.godotjsNativeExitPhase}:null;
    const cleanup=p.cleanup??await p.session.dispose(p.forced?'forced':'clean');
    return {exitCode:p.exitCode,diagnostics:p.diagnostics,errors:p.errors,forced:p.forced,facts,native,cleanup};
   });
   assert.deepEqual(errors,[]);assert.deepEqual(observed.errors,[]);
   if(mode==='failing-cleanup')assert(observed.diagnostics.some(item=>item.message==='EXPECTED_LIFECYCLE_CLEANUP_FAILURE'));
   else assert.deepEqual(observed.diagnostics,[]);
   const first=phase=>events.findIndex(event=>event.phase===phase);
   assert(first('cleanup-start')>=0,'Actual cleanup starts');
   assert(events.some(event=>event.phase==='ready'&&event.role==='engine'));
   assert(events.some(event=>event.phase==='ready'&&event.worker===(report.execution.executionModel==='proxy-pthread')),'Project runs in its declared native owner realm');
   if(!['hang-cleanup','pending-startup'].includes(mode)){
    assert.equal(observed.exitCode,0);
    if(mode==='failing-cleanup'){
     assert(first('exit-tree')>first('cleanup-start'));
     assert.equal(observed.facts.entryCleanup,'failed');
     assert.equal(observed.facts.failure.message,'EXPECTED_LIFECYCLE_CLEANUP_FAILURE');
    }else{
     assert(first('cleanup-complete')>first('cleanup-start'));
     assert(first('exit-tree')>first('cleanup-complete'),'Native tree finalization occurs after awaited cleanup');
     assert.equal(observed.facts.entryCleanup,'complete');
    }
    assert.equal(observed.facts.runtimeSummary,'sealed');
    const late=events.find(event=>event.phase==='late-native');
    assert(late,'Late native-wrapper probe ran after tree exit');assert.equal(late.nativeCalls,0,'Sealed native wrappers cannot re-enter WASM');
    assert.equal(late.threw,true);assert.equal(late.physicalBridgeRetained,true,'Logical guard precedes physical Isolate release');
    if(observed.native){assert(observed.native.ticks>0);assert.equal(observed.native.phase,'native-cleanup');}
   }else{assert.equal(observed.forced,true);assert.notEqual(observed.facts.entryCleanup,'complete');}
   Object.assign(current,{status:'passed',...observed});
   await page.close();
  }
  result.status='passed';return result;
 }catch(error){result.status='failed';result.error=String(error?.stack??error);throw error;}
 finally{await writeFile(path.join(directory,'lifecycle-report.json'),JSON.stringify(result,null,2)+'\n');await browser.close();await server.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=options(process.argv.slice(2));
 try{const result=await runWebLifecycleProbe({engineReport:args['engine-report'],out:args.out,timeout:args.timeout?Number(args.timeout):undefined});console.log(JSON.stringify({status:result.status,execution:result.execution,cases:result.cases.map(item=>({name:item.name,status:item.status}))}));}
 catch(error){console.error(error?.stack??error);process.exitCode=1;}
}
