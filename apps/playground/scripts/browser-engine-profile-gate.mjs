import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {packProject} from '@godot-js/react-browser/pck';
import {captureEngineApi} from './capture-engine-api.mjs';
import {launchTestBrowser} from './browser-harness.mjs';
import {getEngineProfile, validateEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {executionFromReport} from '../../../scripts/release/execution-contract.mjs';
import {isSourceCertified} from '../../../scripts/release/engine-build-proof.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=text=>new TextEncoder().encode(text);
const marker='GODOTJS_ENGINE_PROFILE_GATE';
const namingProfiles=['snake','camel'];
const workletSuffixes=['.audio.worklet.js','.audio.position.worklet.js'];
const engineTimeout=120_000;
const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const errorText=error=>String(error?.stack??error);

/** Production EngineRoot fixture. It deliberately has no demo/helper/site dependency. */
export async function createProfileGateFixture({runtime='godot',naming='snake'}={}){
 const common=`
const G=require('godot'),J=require('godot-jsb'),names=J.internal.names;
const type=name=>G[names.get_class(name)],member=name=>names.get_member(name);
const call=(object,name,...args)=>object[member(name)](...args);
const check=(value,message)=>{if(!value)throw Error(message);};
let hooks=0,signals=0,reference=null,button=null;
`;
 const nativeFixture=`
exports.default=class ProfileGate extends type('Node2D'){
 _ready(){
  this.frames=0;this.checks={};
  try{
   reference=new(type('Label'))();call(reference,'set','text','initial');call(this,'add_child',reference);
   button=new(type('Button'))();call(this,'add_child',button);
   this.slot=type('Callable').create(()=>signals++);call(button,'connect','pressed',this.slot);
   check(call(reference,'get','text')==='initial','initial render');this.checks.initial=true;
  }catch(error){this.finish(error);}
 }
 _process(){
  if(this.done)return;
  try{
   this.frames++;
   if(this.frames===2){
    call(button,'emit_signal','pressed');check(signals===1,'signal delivery');this.checks.signal=true;
    call(reference,'set','text','updated');
   }
   if(this.frames===4){check(call(reference,'get','text')==='updated','property update');this.checks.update=true;}
   if(this.frames===7){
    call(button,'disconnect','pressed',this.slot);call(reference,'free');call(button,'free');
    check(call(this,'get_child_count')===0,'native cleanup');this.checks.cleanup=true;this.finish();
   }
  }catch(error){this.finish(error);}
 }
`;
 const reactFixture=`
const React=require('react');
const {createRoot,EngineNode,useFrame}=require('@godot-js/react/engine');
function Content({text}){useFrame('process',()=>hooks++);return React.createElement(React.Fragment,null,
React.createElement(EngineNode,{ctor:type('Label'),native:{text,name:'GateLabel'},ref:node=>{reference=node;}}),
React.createElement(EngineNode,{ctor:type('Button'),native:{text:'signal',name:'GateButton'},on:{[member('pressed')]:()=>signals++},ref:node=>{button=node;}}));}
exports.default=class ProfileGate extends type('Node2D'){
 _ready(){
  this.frames=0;this.checks={};this.closeReceipts=[];this.phase='initial';
  try{this.startRoot('initial');}catch(error){this.finish(error);}
 }
 startRoot(text){
  this.root=createRoot(this,{godot:G,onError:error=>{this.failure??=error;}});
  this.root.render(React.createElement(Content,{text}));
 }
 shown(text){return reference&&button&&call(reference,'get','text')===text;}
 closeRoot(next){
  this.phase='closing';
  void this.root.close().then(receipt=>{
   const nativeChildren=call(this,'get_child_count');
   this.closeReceipts.push({...receipt,nativeChildren});
   check(receipt.status==='complete'&&receipt.pendingReleases===0,'root close receipt');
   check(nativeChildren===0,'native children still attached');
   this.phase=next;
  }).catch(error=>{this.failure??=error;});
 }
 _process(){
  if(this.done)return;
  try{
   if(this.failure)throw this.failure;
   // Observe retirement at subsequent frames before claiming the mount again.
   if(this.phase==='closing')this.closeProgress=this.root.getCloseProgress();
   check(++this.frames<=180,'checkpoint deadline at '+this.phase+' '+JSON.stringify(this.closeProgress??null));
   if(this.phase==='initial'&&this.shown('initial')){
    this.checks.initial=true;this.phase='signal';call(button,'emit_signal','pressed');
   }else if(this.phase==='signal'&&signals){
    check(signals===1,'signal delivery');this.checks.signal=true;
    this.phase='update';this.root.render(React.createElement(Content,{text:'updated'}));
   }else if(this.phase==='update'&&this.shown('updated')){
    this.checks.update=true;check(hooks>0,'production frame hook');this.checks.frameHook=true;
    this.closeRoot('closed-for-restart');
   }else if(this.phase==='closed-for-restart'){
    reference=null;button=null;this.closeProgress=undefined;
    this.phase='restart';this.startRoot('restarted');
   }else if(this.phase==='restart'&&this.shown('restarted')){
    this.checks.restart=true;this.closeRoot('closed-final');
   }else if(this.phase==='closed-final'){
    check(signals===1,'signal delivered more than once');this.checks.cleanup=true;this.finish();
   }
  }catch(error){this.finish(error);}
 }
`;
 const source=common+(runtime==='react'?reactFixture:nativeFixture)+`
 finish(error){
  if(this.done)return;
  this.done=true;
  console.log('${marker} '+JSON.stringify({
   status:error?'failed':'passed',runtime:'${runtime}',naming:'${naming}',checks:this.checks,
   frames:this.frames,hooks,signals,closeReceipts:this.closeReceipts,error:error?String(error.stack||error):undefined,
  }));
  call(call(this,'get_tree'),'quit',error?1:0);
  }
};`;
 const bundled=await build({stdin:{contents:source,loader:'js',resolveDir:path.join(repo,'apps/playground'),sourcefile:'profile-gate.js'},bundle:true,write:false,platform:'neutral',format:'cjs',target:'es2022',external:['godot','godot-jsb'],define:{'process.env.NODE_ENV':'"production"'},inject:[path.join(repo,'scripts/jsb.react/dist/internal/performance.mjs')],sourcemap:'inline'});
 const files=new Map([
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="Production engine profile gate"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled='+String(naming==='camel')+'\n')],
  ['res://main.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Main.ts" id="1"]\n[node name="Gate" type="Node2D"]\nscript = ExtResource("1")\n')],
  ['res://Main.ts',encode('export default class Main {}\n')],
  ['res://.godot/GodotJS/Main.js',bundled.outputFiles[0].contents],
  ['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
 ]);
 return {files,scriptSha256:hash(bundled.outputFiles[0].contents)};
}

async function verifyTemplateReport(filename,profile,assets){
 const reportBytes=await readFile(filename);
 const report=JSON.parse(reportBytes);
 if(report.runtimeProfile!==profile)throw Error('E_PROFILE_GATE_PROFILE: Engine report targets '+report.runtimeProfile+', requested '+profile);
 if(!report.sourceCertified||!isSourceCertified(report))throw Error('E_PROFILE_GATE_REPORT: Expected a source-certified template build report');
 const execution=executionFromReport(report);
 if(report.hostResourceAbi!==undefined&&execution.hostResourceAbi!==report.hostResourceAbi)
  throw Error('E_PROFILE_GATE_EXECUTION: Host resource ABI differs from the native build report');
 if(execution.executionModel!=='window'||execution.requiresCrossOriginIsolation)throw Error('E_PROFILE_GATE_EXECUTION: The independent gate requires a single-threaded Web template');
 for(const [name,actual] of Object.entries(assets)){
  const expected=report.template?.assets?.filter(asset=>asset.path===name)??[];
  if(expected.length!==1||expected[0].sha256!==actual.sha256||expected[0].bytes!==actual.bytes)
   throw Error('E_PROFILE_GATE_ASSET: Template asset differs from its report: '+name);
 }
 return {sha256:hash(reportBytes),recipeSha256:report.recipeSha256,execution};
}

async function runFixture(browser,server,routes,entry){
 let page;
 const logs=[],errors=[];
 try{
  const fixture=await createProfileGateFixture(entry);
  const pack=packProject(fixture.files).pack;
  entry.packSha256=hash(pack);
  entry.scriptSha256=fixture.scriptSha256;
  routes.set('/fixture.pck',{type:'application/octet-stream',bytes:pack});
  page=await browser.newPage();
  page.on('console',message=>logs.push(message.text()));
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.evaluate(async timeout=>{
   window.__gate={events:[],exitCode:null};
   let exited,timer;
   const exit=new Promise(resolve=>{exited=resolve;});
   const start=async()=>{
    const bytes=new Uint8Array(await(await fetch('/fixture.pck')).arrayBuffer());
    const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/godot',persistentPaths:[],persistentDrops:false,serviceWorker:'',
     onPrint:(...args)=>window.__gate.events.push(args.join(' ')),onPrintError:(...args)=>window.__gate.events.push('ERROR '+args.join(' ')),
     onExit:code=>{window.__gate.exitCode=code;exited();}});
    await engine.preloadFile(bytes,'/application.pck');await engine.init('/engine/godot');
    await Promise.race([engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility']}),exit]);
   };
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('E_PROFILE_GATE_START_TIMEOUT')),timeout);});
   try{await Promise.race([start(),deadline]);}finally{clearTimeout(timer);}
  },engineTimeout);
  await page.waitForFunction(()=>window.__gate.exitCode!==null,null,{timeout:engineTimeout});
  const observed=await page.evaluate(()=>({events:window.__gate.events,exitCode:window.__gate.exitCode}));
  entry.exitCode=observed.exitCode;
  entry.logs=observed.events;
  const prefix=marker+' ';
  const line=[...observed.events,...logs].find(text=>text.includes(prefix));
  if(line)entry.result=JSON.parse(line.slice(line.indexOf(prefix)+prefix.length));
  assert.equal(entry.exitCode,0,entry.result?.error??'Native fixture exit code');
  assert.equal(entry.result?.status,'passed','Native fixture result');
  assert.equal(entry.result.runtime,entry.runtime,'Native fixture runtime');
  assert.equal(entry.result.naming,entry.naming,'Native fixture naming');
  for(const name of ['initial','signal','update','cleanup'])assert.equal(entry.result.checks[name],true,'Native fixture check: '+name);
  if(entry.runtime==='react'){
   assert.equal(entry.result.checks.frameHook,true,'Production frame hook');
   assert.equal(entry.result.checks.restart,true,'React root restart');
   assert.deepEqual(entry.result.closeReceipts,Array.from({length:2},()=>({status:'complete',pendingReleases:0,nativeChildren:0})));
  }
  assert.deepEqual(errors,[]);
  entry.status='passed';
 }catch(error){entry.status='failed';entry.error=errorText(error);}
 finally{
  entry.errors=errors;
  if(entry.status==='failed')entry.console=logs;
  await page?.close().catch(error=>{entry.status='failed';entry.closeError=errorText(error);});
 }
}

export async function runEngineProfileGate({engineJs,engineWasm,engineReport,profile='engine-2d-v1',out,browser:browserName='chromium',capture=true}){
 out=path.resolve(out);await mkdir(out,{recursive:true});
 const api=Object.fromEntries(namingProfiles.map(naming=>[naming,capture?{status:'blocked',blockedBy:'preflight'}:{status:'skipped'}]));
 const cases=['godot','react'].flatMap(runtime=>namingProfiles.map(naming=>({runtime,naming,status:'blocked',blockedBy:'preflight'})));
 const report={schemaVersion:1,profile,testMode:'real-engine',preflight:{status:'pending'},api,cases,status:'running'};
 const reportPath=path.join(out,'gate.json');
 let browser,server,failure;
 try{
  getEngineProfile(profile);
  const [javascript,wasm,sdk,...workletBytes]=await Promise.all([
   readFile(engineJs),readFile(engineWasm),readFile(path.join(repo,'scripts/jsb.react/dist/engine.js')),
   ...workletSuffixes.map(suffix=>readFile(engineJs.replace(/\.js$/,suffix))),
  ]);
  const worklets=workletSuffixes.map((suffix,index)=>['godot'+suffix,workletBytes[index]]);
  const assets=Object.fromEntries([['godot.js',javascript],['godot.wasm',wasm],...worklets]
   .map(([name,bytes])=>[name,{sha256:hash(bytes),bytes:bytes.length}]));
  if(engineReport)report.engineReport=await verifyTemplateReport(engineReport,profile,assets);
  assert.equal(WebAssembly.validate(wasm),true,'WASM validation');
  report.engine={javascript:assets['godot.js'].sha256,wasm:assets['godot.wasm'].sha256,wasmBytes:wasm.length,
   worklets:Object.fromEntries(worklets.map(([name])=>['/engine/'+name,assets[name].sha256]))};
  report.sdk={engine:hash(sdk)};
  report.preflight.status='passed';

  if(capture)for(const naming of namingProfiles){
   const output=path.join(out,'api-'+naming+'.json');
   try{
    const {ir,report:captured}=await captureEngineApi({engineJs,engineWasm,output,naming,execution:report.engineReport?.execution});
    assert.equal(captured.engineJsSha256,report.engine.javascript,'Captured JS differs from preflight');
    assert.equal(captured.engineWasmSha256,report.engine.wasm,'Captured WASM differs from preflight');
    for(const [name] of worklets){
     const capturedName=path.basename(engineJs).replace(/\.js$/,name.slice('godot'.length));
     assert.equal(captured.worklets[capturedName],assets[name].sha256,'Captured worklet differs from preflight: '+name);
    }
    validateEngineProfile(profile,{modules:ir.modules,classes:ir.classes});
    api[naming]={status:'passed',irSha256:captured.irSha256,bindingAudit:captured.bindingAudit.status,classes:captured.classInventory.classes,modules:ir.modules};
   }catch(error){api[naming]={status:'failed',error:errorText(error)};}
  }
  const runnable=cases.filter(entry=>{
   const available=['passed','skipped'].includes(api[entry.naming].status);
   entry.blockedBy=available?'browser-startup':'api-'+entry.naming;
   return available;
  });
  if(runnable.length){
   const routes=new Map([
    ['/',{type:'text/html',bytes:'<!doctype html><canvas id="canvas" width="320" height="240"></canvas><script src="/engine/godot.js"></script>'}],
    ['/engine/godot.js',{type:'application/javascript',bytes:javascript}],
    ['/engine/godot.wasm',{type:'application/wasm',bytes:wasm}],
    ...worklets.map(([name,bytes])=>['/engine/'+name,{type:'application/javascript',bytes}]),
   ]);
   server=createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname,route=routes.get(name);
    if(!route){res.writeHead(name==='/favicon.ico'?204:404).end();return;}
    res.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);
   });
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   browser=await launchTestBrowser({browser:browserName,headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
   report.browser={name:browser.browserType().name(),version:browser.version()};
   for(const entry of runnable){delete entry.blockedBy;await runFixture(browser,server,routes,entry);}
  }
  const failures=[...namingProfiles.filter(naming=>api[naming].status==='failed').map(naming=>'api-'+naming),
   ...cases.filter(entry=>entry.status!=='passed').map(entry=>entry.runtime+'-'+entry.naming+' ('+entry.status+')')];
  if(failures.length)throw Error('E_PROFILE_GATE_FAILED: '+failures.join(', ')+'; see '+reportPath);
  report.status='passed';
 }catch(error){
  failure=error;
  if(report.preflight.status==='pending')report.preflight={status:'failed',error:errorText(error)};
 }finally{
  try{await browser?.close();}catch(error){failure??=error;}
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  if(failure){report.status='failed';report.error=errorText(failure);}
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 }
 if(failure)throw failure;
 return report;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const engineJs=argument('--engine-js'),engineWasm=argument('--engine-wasm');
  if(!engineJs||!engineWasm)throw Error('Expected --engine-js and --engine-wasm');
  const engineReport=argument('--engine-report');
  if(process.argv.includes('--engine-report')&&(!engineReport||engineReport.startsWith('--')))throw Error('Expected a path after --engine-report');
  const report=await runEngineProfileGate({engineJs:path.resolve(engineJs),engineWasm:path.resolve(engineWasm),engineReport,
   profile:argument('--profile')??'engine-2d-v1',out:argument('--out')??'work/2d-engine/gate',browser:argument('--browser')??process.env.BROWSER??'chromium',
   capture:!process.argv.includes('--skip-api')&&!process.argv.includes('--skip-capture')});
  console.log(JSON.stringify({status:report.status,profile:report.profile,browser:report.browser,cases:report.cases.length,wasmBytes:report.engine.wasmBytes}));
 }catch(error){console.error(error.stack??error);process.exitCode=1;}
}
