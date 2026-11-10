import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {auditEngineBinding} from './engine-api-binding-audit.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>new TextEncoder().encode(value);
// This project runs on the production template. No inspector module, editor
// metadata, native host or previously captured candidate supplies its API.
export function engineApiCaptureFiles(naming='snake'){
 if(!['snake','camel'].includes(naming))throw Error('E_ENGINE_API_NAMING: '+naming);
 const source=`const G=require('godot'),J=require('godot-jsb');
const names=J.internal.names;
const call=(object,name,...args)=>object[names.get_member(name)].apply(object,args);
exports.default=class EngineApiCapture extends G[names.get_class('Node')]{
 _ready(){this.frames=0;this.exitCode=1;try{
  if(typeof J.internal.get_engine_api!=='function')throw Error('Production engine API entry is unavailable');
  if(call(G[names.get_class('ClassDB')],'class_exists','P0EngineApiProbe'))throw Error('Inspector template cannot produce a production release');
  const ir=J.internal.get_engine_api();
  const bindingAudit=(${auditEngineBinding.toString()})(G,J);
  let bindable=0;const classFailures=[],nameMismatches=[];
  for(const cls of ir.classes){const original=cls.nativeName??cls.name,alias=names.get_class(original);try{if(!G[alias])throw Error('Unresolved class');bindable++;if(names.get_internal_mapping(alias)!==original)nameMismatches.push({original,alias});}catch(error){classFailures.push({original,alias,error:String(error)});}}
  const inventory={classes:ir.classes.length,bindable,classFailures,nameMismatches};
  if(bindingAudit.status!=='passed'||classFailures.length||nameMismatches.length)throw Error('Binding audit failed: '+JSON.stringify({bindingAudit,inventory}));
  const window=call(G[names.get_class('JavaScriptBridge')],'get_interface','window');
  call(window,'call','__captureEngineApi',JSON.stringify(ir),JSON.stringify({bindingAudit,inventory}));this.exitCode=0;
 }catch(error){console.error('ENGINE_API_CAPTURE_ERROR '+String(error));}}
 _process(){if(++this.frames===3)call(call(this,'get_tree'),'quit',this.exitCode);}
};`;
 return new Map([
  ['res://src/EngineApiCapture.ts',encode('export default class EngineApiCapture {}\n')],
  ['res://.godot/GodotJS/src/EngineApiCapture.js',encode(source)],
  ['res://EngineApiCapture.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/EngineApiCapture.ts" id="1"]\n[node name="EngineApiCapture" type="Node"]\nscript = ExtResource("1")\n')],
  ['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="Production engine API capture"\nrun/main_scene="res://EngineApiCapture.tscn"\n[display]\nwindow/size/viewport_width=64\nwindow/size/viewport_height=64\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled='+String(naming==='camel')+'\n')],
 ]);
}

export async function captureEngineApi({engineJs,engineWasm,output,reportPath=output+'.capture.json',naming='snake',timeout=120000,executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)}){
 const [{chromium},{packProject}]=await Promise.all([import('playwright'),import(path.join(repo,'scripts/jsb.react-browser/dist/pck.js'))]);
 const [javascript,wasm]=await Promise.all([readFile(engineJs),readFile(engineWasm)]);
 const {pack}=packProject(engineApiCaptureFiles(naming));
 const worklets={};
 for(const suffix of ['.audio.worklet.js','.audio.position.worklet.js'])worklets['/engine/godot'+suffix]=await readFile(engineJs.replace(/\.js$/,suffix));
 const routes=new Map([
  ['/',{type:'text/html',bytes:'<!doctype html><canvas id="canvas" width="64" height="64"></canvas><script src="/engine/godot.js"></script>'}],
  ['/engine/godot.js',{type:'application/javascript',bytes:javascript}],
  ['/engine/godot.wasm',{type:'application/wasm',bytes:wasm}],
  ['/capture.pck',{type:'application/octet-stream',bytes:pack}],
  ...Object.entries(worklets).map(([name,bytes])=>[name,{type:'application/javascript',bytes}]),
 ]);
 const server=createServer((request,response)=>{
  const route=routes.get(new URL(request.url,'http://localhost').pathname);
  if(!route){response.writeHead(404).end();return;}
  response.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);
 });
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 let browser;const errors=[];
 try{
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.text().includes('ENGINE_API_CAPTURE_ERROR'))errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async(timeout)=>{
   window.__engineApiCapture={ir:null,audit:null,exitCode:null};
   window.__captureEngineApi=(raw,audit)=>{window.__engineApiCapture.ir=JSON.parse(raw);window.__engineApiCapture.audit=JSON.parse(audit);};
   let exited,timer;const exit=new Promise(resolve=>{exited=resolve;});
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('E_ENGINE_API_CAPTURE_TIMEOUT')),timeout);});
   const initialize=async()=>{
    const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/godot',persistentPaths:[],persistentDrops:false,onExit:code=>{window.__engineApiCapture.exitCode=code;exited();}});
    const pack=new Uint8Array(await(await fetch('/capture.pck')).arrayBuffer());
    await engine.preloadFile(pack,'/capture.pck');await engine.init('/engine/godot');
    await Promise.race([engine.start({args:['--main-pack','/capture.pck','--rendering-method','gl_compatibility']}),exit]);
   };
   try{await Promise.race([initialize(),deadline]);}finally{clearTimeout(timer);}
  },timeout);
  await page.waitForFunction(()=>window.__engineApiCapture.exitCode!==null,null,{timeout});
  const result=await page.evaluate(()=>window.__engineApiCapture);
  if(result.exitCode!==0||!result.ir||!result.audit||errors.length)throw Error('E_ENGINE_API_CAPTURE: '+JSON.stringify({exitCode:result.exitCode,errors}));
  if(result.ir.bindingNaming!==naming)throw Error('E_ENGINE_API_NAMING: Native snapshot did not apply '+naming+' bindings');
  const report={schemaVersion:1,kind:'godotjs-production-engine-api-capture',status:'captured',naming,entry:'godot-jsb.internal.get_engine_api',engineJsSha256:hash(javascript),engineWasmSha256:hash(wasm),bindingAudit:result.audit.bindingAudit,classInventory:result.audit.inventory,capturePackSha256:hash(pack),browser:browser.version(),worklets:Object.fromEntries(Object.entries(worklets).map(([name,bytes])=>[path.basename(engineJs).replace(/\.js$/,name.slice('/engine/godot'.length)),hash(bytes)]))};
  const bytes=JSON.stringify(result.ir,null,2)+'\n';report.irSha256=hash(bytes);
  // Recheck disk identity after running the exact in-memory inputs.
  if(hash(await readFile(engineJs))!==report.engineJsSha256||hash(await readFile(engineWasm))!==report.engineWasmSha256)throw Error('E_ENGINE_API_CAPTURE: Engine changed during capture');
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');return {ir:result.ir,report};
 }finally{
  if(browser)await browser.close();
  await new Promise(done=>server.close(done));
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [engineJs,engineWasm,output,naming='snake']=process.argv.slice(2);
 if(!engineJs||!engineWasm||!output)throw Error('Usage: capture-engine-api.mjs <engine.js> <engine.wasm> <api-ir.json> [snake|camel]');
 console.log(JSON.stringify((await captureEngineApi({engineJs,engineWasm,output,naming})).report));
}
