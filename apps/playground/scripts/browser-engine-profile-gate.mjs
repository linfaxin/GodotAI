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

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=text=>new TextEncoder().encode(text);
const marker='GODOTJS_ENGINE_PROFILE_GATE';
const argument=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};

/** Production EngineRoot fixture. It deliberately has no demo/helper/site dependency. */
export async function createProfileGateFixture({runtime='godot',naming='snake'}={}){
 const react=runtime==='react';
 const source=`${react?`const React=require('react');const {createRoot,EngineNode,useFrame}=require('@godot-js/react/engine');`:''}
const G=require('godot'),J=require('godot-jsb'),names=J.internal.names;
const type=name=>G[names.get_class(name)],member=name=>names.get_member(name);
const call=(object,name,...args)=>object[member(name)](...args);
const check=(value,message)=>{if(!value)throw Error(message);};
let hooks=0,signals=0,reference=null,button=null;
${react?`function Content({text}){useFrame('process',()=>hooks++);return React.createElement(React.Fragment,null,
React.createElement(EngineNode,{ctor:type('Label'),native:{text,name:'GateLabel'},ref:node=>{reference=node;}}),
React.createElement(EngineNode,{ctor:type('Button'),native:{text:'signal',name:'GateButton'},on:{[member('pressed')]:()=>signals++},ref:node=>{button=node;}}));}`:''}
exports.default=class ProfileGate extends type('Node2D'){
 _ready(){this.frames=0;this.done=false;this.checks={};try{
  ${react?`this.root=createRoot(this,{godot:G,onError:error=>{throw error;}});this.root.render(React.createElement(Content,{text:'initial'}));`:`reference=new(type('Label'))();call(reference,'set','text','initial');call(this,'add_child',reference);button=new(type('Button'))();call(this,'add_child',button);this.slot=type('Callable').create(()=>signals++);call(button,'connect','pressed',this.slot);`}
  check(reference&&call(reference,'get','text')==='initial','initial render');this.checks.initial=true;
 }catch(error){this.finish(error);}}
 _process(){if(this.done)return;try{this.frames++;
  if(this.frames===2){call(button,'emit_signal','pressed');check(signals===1,'signal delivery');this.checks.signal=true;
   ${react?`this.root.render(React.createElement(Content,{text:'updated'}));`:`call(reference,'set','text','updated');`}
  }
  if(this.frames===4){check(reference&&call(reference,'get','text')==='updated','property update');this.checks.update=true;
   ${react?`check(hooks>0,'production frame hook');this.checks.frameHook=true;this.root.shutdown();check(call(this,'get_child_count')===0,'root shutdown children');this.root=createRoot(this,{godot:G,onError:error=>{throw error;}});this.root.render(React.createElement(Content,{text:'restarted'}));check(reference&&call(reference,'get','text')==='restarted','root restart');this.checks.restart=true;`:''}
  }
  if(this.frames===7){${react?`this.root.shutdown();check(call(this,'get_child_count')===0,'final root shutdown');`:`call(button,'disconnect','pressed',this.slot);call(reference,'free');call(button,'free');check(call(this,'get_child_count')===0,'native cleanup');`}
   this.checks.cleanup=true;this.finish();}
 }catch(error){this.finish(error);}}
 finish(error){if(this.done)return;this.done=true;console.log('${marker} '+JSON.stringify({status:error?'failed':'passed',runtime:'${runtime}',naming:'${naming}',checks:this.checks,frames:this.frames,hooks,signals,error:error?String(error.stack||error):undefined}));call(call(this,'get_tree'),'quit',error?1:0);}
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

export async function runEngineProfileGate({engineJs,engineWasm,profile='engine-2d-v1',out,browser:browserName='chromium',capture=true}){
 const definition=getEngineProfile(profile);
 out=path.resolve(out);await mkdir(out,{recursive:true});
 const [javascript,wasm,sdk]=await Promise.all([readFile(engineJs),readFile(engineWasm),readFile(path.join(repo,'scripts/jsb.react/dist/engine.js'))]);
 assert.equal(WebAssembly.validate(wasm),true,'WASM validation');
 const worklets=new Map();
 for(const suffix of ['.audio.worklet.js','.audio.position.worklet.js'])worklets.set('/engine/godot'+suffix,await readFile(engineJs.replace(/\.js$/,suffix)));
 const api={};
 if(capture)for(const naming of ['snake','camel']){
  const output=path.join(out,'api-'+naming+'.json');
  const result=await captureEngineApi({engineJs,engineWasm,output,naming});
  validateEngineProfile(profile,{modules:result.ir.modules,classes:result.ir.classes});
  api[naming]={irSha256:result.report.irSha256,bindingAudit:result.report.bindingAudit.status,classes:result.report.classInventory.classes,modules:result.ir.modules};
 }
 let activePack;
 const server=createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  const route=name==='/'?{type:'text/html',bytes:'<!doctype html><canvas id="canvas" width="320" height="240"></canvas><script src="/engine/godot.js"></script>'}:name==='/engine/godot.js'?{type:'application/javascript',bytes:javascript}:name==='/engine/godot.wasm'?{type:'application/wasm',bytes:wasm}:name==='/fixture.pck'?{type:'application/octet-stream',bytes:activePack}:worklets.has(name)?{type:'application/javascript',bytes:worklets.get(name)}:undefined;
  if(!route){res.writeHead(name==='/favicon.ico'?204:404).end();return;}
  res.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let browser;const cases=[];
 const report={schemaVersion:1,profile:definition.id,testMode:'real-engine',engine:{javascript:hash(javascript),wasm:hash(wasm),wasmBytes:wasm.length,worklets:Object.fromEntries([...worklets].map(([name,bytes])=>[name,hash(bytes)]))},sdk:{engine:hash(sdk)},api,cases,status:'running'};
 try{
  browser=await launchTestBrowser({browser:browserName,headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  report.browser={name:browser.browserType().name(),version:browser.version()};
  for(const runtime of ['godot','react'])for(const naming of ['snake','camel']){
   const fixture=await createProfileGateFixture({runtime,naming});activePack=packProject(fixture.files).pack;
   const page=await browser.newPage(),logs=[],errors=[];
   page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>errors.push(String(error)));
   try{
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.evaluate(async()=>{
     window.__gate={events:[],exitCode:null};
     const bytes=new Uint8Array(await(await fetch('/fixture.pck')).arrayBuffer());
     let exited;const exit=new Promise(resolve=>exited=resolve);
     const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/godot',persistentPaths:[],persistentDrops:false,serviceWorker:'',onPrint:(...args)=>window.__gate.events.push(args.join(' ')),onPrintError:(...args)=>window.__gate.events.push('ERROR '+args.join(' ')),onExit:code=>{window.__gate.exitCode=code;exited();}});
     window.__gate.engine=engine;
     await engine.preloadFile(bytes,'/application.pck');await engine.init('/engine/godot');
     await Promise.race([engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility']}),exit]);
    });
    await page.waitForFunction(()=>window.__gate.exitCode!==null,null,{timeout:120000});
    const observed=await page.evaluate(()=>({events:window.__gate.events,exitCode:window.__gate.exitCode}));
    const line=[...observed.events,...logs].find(text=>text.includes(marker+' '));
    const result=line?JSON.parse(line.slice(line.indexOf(marker+' ')+marker.length+1)):undefined;
    const entry={runtime,naming,packSha256:hash(activePack),scriptSha256:fixture.scriptSha256,exitCode:observed.exitCode,result,errors,logs:observed.events};cases.push(entry);
    assert.equal(observed.exitCode,0,JSON.stringify(entry));assert.equal(result?.status,'passed',JSON.stringify(entry));assert.deepEqual(errors,[]);
   }finally{await page.close();}
  }
  report.status='passed';
 }catch(error){report.status='failed';report.error=String(error.stack??error);throw error;}
 finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(out,'gate.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const engineJs=argument('--engine-js'),engineWasm=argument('--engine-wasm');
  if(!engineJs||!engineWasm)throw Error('Expected --engine-js and --engine-wasm');
  const report=await runEngineProfileGate({engineJs:path.resolve(engineJs),engineWasm:path.resolve(engineWasm),profile:argument('--profile')??'engine-2d-v1',out:argument('--out')??'work/2d-engine/gate',browser:argument('--browser')??process.env.BROWSER??'chromium',capture:!process.argv.includes('--skip-api')});
  console.log(JSON.stringify({status:report.status,profile:report.profile,browser:report.browser,cases:report.cases.length,wasmBytes:report.engine.wasmBytes}));
 }catch(error){console.error(error.stack??error);process.exitCode=1;}
}
