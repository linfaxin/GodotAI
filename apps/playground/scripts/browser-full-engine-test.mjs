import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {RUNTIME_LIFECYCLE_MINIMUM} from './runtime-evidence.mjs';

// Acceptance of the built production site: no runtime, compiler, or network mocks.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const productRelease=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const siteBytes=await fs.readFile(path.join(directory,'manifest.json'));
const publicAssets=JSON.parse(siteBytes).publicAssets===true;
const urlPrefix=publicAssets?`/releases/${createHash('sha256').update(siteBytes).digest('hex')}/`:'/';
const runtimeProfile=productRelease.runtimeProfile;
const isolated=(productRelease.execution??productRelease.engine?.execution)?.requiresCrossOriginIsolation===true;
const useTls=isolated&&process.env.PLAYGROUND_TEST_TLS!=='0';
if(useTls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned local TLS currently requires Chromium');
const tls=useTls?await createLocalTestTls():undefined;
const output=process.env.PLAYGROUND_FULL_ENGINE_REPORT;
const timeout=Number(process.env.PLAYGROUND_FULL_ENGINE_TIMEOUT??180000);
const lifecycleLoops=Number(process.env.PLAYGROUND_FULL_ENGINE_LOOPS??RUNTIME_LIFECYCLE_MINIMUM[process.env.BROWSER??'chromium']);
assert(Number.isInteger(lifecycleLoops)&&lifecycleLoops>=1&&lifecycleLoops<=100);
const checks=[],audio=[],errors=[],warnings=[],network=[],frames=[],sessionCleanup=[];
let browser,context,page,deployment,permissionPolicyObservation;
const editor=createStaticServer(directory,{publicImmutable:publicAssets,urlPrefix,tls}),preview=createStaticServer(directory,{publicImmutable:publicAssets,urlPrefix,tls});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(25);}throw Error(message);}
const inspect=async()=>page?await page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect()):undefined;
async function running(runtime){
 console.error(`[full-engine acceptance] waiting for ${runtime} run ${frames.length+1}`);
 await until(async()=>{
  if(errors.length)throw Error('Production page failed: '+JSON.stringify(errors));
  return page.evaluate(runtime=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.ready&&state.project.runtime===runtime){if(state.diagnostics?.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));if(['crashed','unresponsive'].includes(state.engine?.state))throw Error(JSON.stringify({engine:state.engine,logs:document.querySelector('#logs')?.textContent}));}return state?.ready&&state.project.runtime===runtime&&state.engine?.state==='running';},runtime);
 },`Production ${runtime} did not reach running`);
 const state=await inspect();assert.deepEqual(state.diagnostics.filter(d=>d.category==='error'),[]);
 assert.equal(await page.locator('#preview iframe').count(),1);
 const iframe=await page.locator('#preview iframe').elementHandle(),frame=await iframe.contentFrame();
 await iframe.dispose();
 assert(frame);assert.notEqual(new URL(frame.url()).origin,new URL(page.url()).origin);
 assert.equal(new URL(frame.url()).pathname,new URL('preview.html',state.releaseContext.releaseRoot).pathname);
 assert.equal(await frame.locator('canvas').count(),1);
 assert.match(await page.locator('#preview iframe').getAttribute('sandbox'),/allow-pointer-lock/);
 const permissions=await page.locator('#preview iframe').getAttribute('allow');
 if(isolated){
  assert.match(permissions,/autoplay/);assert.match(permissions,/cross-origin-isolated/);assert.match(permissions,/fullscreen/);assert.match(permissions,/xr-spatial-tracking/);assert.equal(await page.evaluate(()=>crossOriginIsolated),true);assert.equal(await frame.evaluate(()=>crossOriginIsolated),true);
  const observation=await frame.evaluate(()=>{const policy=document.featurePolicy;return {queryApi:typeof policy?.allowsFeature==='function',fullscreenEnabled:document.fullscreenEnabled,...(typeof policy?.allowsFeature==='function'?{fullscreen:policy.allowsFeature('fullscreen'),xrSpatialTracking:policy.allowsFeature('xr-spatial-tracking')}:{})};});
  if(observation.queryApi){assert.equal(observation.fullscreen,true);assert.equal(observation.xrSpatialTracking,true);}
  else assert.equal(observation.fullscreenEnabled,true,'A browser without the policy query API must still permit native fullscreen');
  permissionPolicyObservation??=observation;
 }
 else assert.equal(permissions,'autoplay');
 const observation=await frame.evaluate(()=>globalThis.__fullEngineObservation);
 assert(observation?.documentId,'A fresh real preview document must be instrumented');
 assert(!frames.some(previous=>previous.documentId===observation.documentId),'Every run creates a fresh iframe');
 frames.push({runtime,documentId:observation.documentId,url:frame.url()});
 await until(()=>audio.filter(e=>e.documentId===observation.documentId&&e.type==='worklet-loaded').length>=2,'Both real audio worklets must load');
 console.error(`[full-engine acceptance] running ${runtime} ${observation.documentId}`);
 return observation.documentId;
}
async function stop(documentId){
 await page.locator('#stop').click();
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited',null,{timeout});
 await page.waitForFunction(()=>!document.querySelector('#preview iframe'),null,{timeout});
 await until(()=>audio.some(e=>e.documentId===documentId&&e.type==='context-closed'&&e.state==='closed'),'Native engine shutdown must close its AudioContext');
 assert(!audio.some(e=>e.documentId===documentId&&e.type==='worklet-failed'));
 const terminal=await page.evaluate(()=>globalThis.__fullEngineTerminal);
 assert.equal(terminal.length,sessionCleanup.length+1,'Each stopped preview must deliver exactly one terminal receipt');
 const message=terminal.at(-1);assert.equal(message.type,'exited');assert.equal(message.code,0);
 const receipt=message.cleanup;assert(receipt);assert.equal(receipt.mode,'clean');assertCleanup(receipt);
 assert(!sessionCleanup.some(item=>item.runId===message.runId),'Terminal identities must belong to fresh sessions');
 sessionCleanup.push({documentId,runId:message.runId,cleanup:receipt});
 console.error(`[full-engine acceptance] stopped ${documentId}`);
}
function assertCleanup(receipt){
 assert.deepEqual(receipt.errors,[]);
 for(const [created,closed]of [['workers','terminatedWorkers'],['audioContexts','closedAudioContexts'],['messagePorts','closedMessagePorts'],['glContexts','lostGlContexts'],['mediaTracks','stoppedMediaTracks'],['networkResources','closedNetworkResources']])assert.equal(receipt[created]??0,receipt[closed]??0,`${created} must be fully released`);
 if(isolated){assert(receipt.workers>0);assert(receipt.messagePorts>0);assert(receipt.glContexts>0);}
}
async function choose(id){await page.locator('#project-switcher').click();await page.locator(`[data-demo="${id}"]`).click();}
function packedFiles(input){
 const bytes=Buffer.from(input),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 assert.equal(view.getUint32(0,true),0x43504447);assert.equal(view.getUint32(4,true),3);
 const base=Number(view.getBigUint64(24,true));let cursor=Number(view.getBigUint64(32,true));
 const count=view.getUint32(cursor,true);cursor+=4;const files={};
 for(let i=0;i<count;i++){
  const length=view.getUint32(cursor,true);cursor+=4;
  const name=bytes.subarray(cursor,cursor+length).toString('utf8').replace(/\0+$/,'');cursor+=length;
  const offset=base+Number(view.getBigUint64(cursor,true));cursor+=8;
  const size=Number(view.getBigUint64(cursor,true));cursor+=28;
  assert(offset+size<=bytes.length);files['res://'+name]=bytes.subarray(offset,offset+size);
 }
 return files;
}
const nativeProject={schemaVersion:3,engineProfile:runtimeProfile,runtime:'godot',demoId:'native',entry:'/src/Main.ts',selected:'/src/Main.ts',mode:'production',controls:{},files:{
 '/project.godot':'config_version=5\n[application]\nconfig/name="Full engine browser acceptance"\nrun/main_scene="uid://d1t"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
 '/main.tscn':'[gd_scene load_steps=2 format=3 uid="uid://d1t"]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n',
 '/main.tscn.uid':'uid://d1t',
 '/src/Main.ts':`import {Node2D,Label,Vector2,FastNoiseLite,print} from "godot";
import settings from "./settings.json";
import {extra} from "./nested/value";
export default class Main extends Node2D {
 _ready(){
  const answer=settings.base+extra;
  if(answer!==42)throw Error("Relative TS/JSON modules did not execute");
  const noise=new FastNoiseLite();
  const value=noise.get_noise_2d(1,2);
  if(!Number.isFinite(value))throw Error("Native noise module did not execute");
  const label=new Label();label.text="FULL_ENGINE_NATIVE_READY "+answer;label.position=new Vector2(32,32);this.add_child(label);
  print("FULL_ENGINE_NATIVE_READY "+JSON.stringify({answer,noise:value,children:this.get_child_count()}));
 }
}
`,
 '/src/nested/value.ts':'export const extra:number=2;',
 '/src/settings.json':'{"base":40}',
}};
function audioProject(playbackType){
 const project=structuredClone(nativeProject);
 project.files['/src/Main.ts']=`import {Node,AudioStreamPlayer,AudioStreamGenerator,AudioStreamGeneratorPlayback,Vector2,print} from "godot";
export default class Main extends Node {
 player!:AudioStreamPlayer;
 playback!:AudioStreamGeneratorPlayback;
 phase=0;
 _ready(){
  const generator=new AudioStreamGenerator();generator.mix_rate=8000;generator.buffer_length=0.1;
  this.player=new AudioStreamPlayer();this.player.stream=generator;this.player.playback_type=${playbackType};
  this.add_child(this.player);this.player.play();this.playback=this.player.get_stream_playback() as AudioStreamGeneratorPlayback;
  this.fill();print("FULL_ENGINE_AUDIO_READY ${playbackType}");
 }
 fill(){
  if(!this.playback)return;
  const frames=Math.min(Number(this.playback.get_frames_available()),1024);
  for(let i=0;i<frames;i++){const sample=Math.sin(this.phase)*0.2;this.phase+=2*Math.PI*220/8000;this.playback.push_frame(new Vector2(sample,sample));}
 }
 _process(_delta:number){this.fill();}
}
`;
 project.files['/main.tscn']=project.files['/main.tscn'].replace('type="Node2D"','type="Node"');
 return project;
}
try{
 const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
 getEngineProfile(release.runtimeProfile);assert.equal(release.engine.worklets.length,2);
 await Promise.all([listen(editor),listen(preview)]);
 const editorOrigin=`${tls?'https':'http'}://127.0.0.1:${editor.address().port}`,previewOrigin=`${tls?'https':'http'}://127.0.0.1:${preview.address().port}`;
 const delivery=await inspectTestSite(editorOrigin+urlPrefix,tls);assert.equal(delivery.status,200);
 deployment=localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers:delivery.headers});
 if(isolated){assert.equal(delivery.headers['cross-origin-opener-policy'],'same-origin');assert.equal(delivery.headers['cross-origin-embedder-policy'],'require-corp');assert.equal(delivery.headers['cross-origin-resource-policy'],'cross-origin');assert.match(delivery.headers['permissions-policy'],/cross-origin-isolated/);}
 browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 context=await browser.newContext({viewport:{width:1536,height:1000}});
 await context.exposeBinding('__fullAcceptanceRecord',(_source,event)=>{audio.push(event);});
 await context.addInitScript(()=>{
  globalThis.__fullEngineTerminal=[];
  globalThis.__fullEngineConnections=[];globalThis.__fullEngineHealth={};
  const Channel=MessageChannel;
  globalThis.MessageChannel=new Proxy(Channel,{construct(target,args,newTarget){const channel=Reflect.construct(target,args,newTarget);for(const port of [channel.port1,channel.port2])port.addEventListener('message',event=>{
   const message=event.data;if(message?.protocolVersion!==1||typeof message.runId!=='string')return;
   const health=globalThis.__fullEngineHealth[message.runId]??={host:0,engine:0};
   if(message.type==='heartbeat')health.host++;if(message.type==='engine-progress')health.engine++;
   if(message.type==='connected')globalThis.__fullEngineConnections.push({port,identity:message});
   if(['exited','terminated','fatal'].includes(message.type))globalThis.__fullEngineTerminal.push(message);
  });return channel;}});
  if(!location.pathname.endsWith('/preview.html'))return;
  const documentId=crypto.randomUUID(),contexts=[],meters=[],blobs=new Map();
  globalThis.__fullEngineObservation={documentId};
  const emit=event=>globalThis.__fullAcceptanceRecord({documentId,...event});
  // Observe the original Blob object; fetching blob: is intentionally forbidden
  // by the production connect-src CSP. Never alter the verified module bytes.
  const createObjectURL=URL.createObjectURL.bind(URL),revokeObjectURL=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=createObjectURL(blob);blobs.set(url,blob);return url;};
  URL.revokeObjectURL=url=>{blobs.delete(url);return revokeObjectURL(url);};
  const Native=globalThis.AudioContext??globalThis.webkitAudioContext;
  if(!Native)return;
  const NativeNode=globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode=new Proxy(NativeNode,{construct(target,args,newTarget){
   const node=Reflect.construct(target,args,newTarget),[ctx,name]=args;
   if(node.numberOfOutputs>0){
    const analyser=ctx.createAnalyser();analyser.fftSize=256;node.connect(analyser);
    const data=new Float32Array(analyser.fftSize),meter={ctx,name,peak:0,checks:0,reported:false};meters.push(meter);
    meter.timer=setInterval(()=>{
     analyser.getFloatTimeDomainData(data);meter.checks++;
     for(const sample of data)meter.peak=Math.max(meter.peak,Math.abs(sample));
     if(meter.peak>0.0001&&!meter.reported){meter.reported=true;void emit({type:'worklet-output',contextId:contexts.indexOf(ctx),name,peak:meter.peak,checks:meter.checks});}
    },25);
   }
   return node;
  }});
  globalThis.AudioContext=new Proxy(Native,{construct(target,args,newTarget){
   const ctx=Reflect.construct(target,args,newTarget),contextId=contexts.length;contexts.push(ctx);
   void emit({type:'context-created',contextId,state:ctx.state});
   const add=ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
   ctx.audioWorklet.addModule=async(url,options)=>{
    try{
     const [hash]=await Promise.all([(async()=>{
      const blob=blobs.get(String(url));if(!blob)throw Error('Worklet did not receive an observed verified Blob');
      const bytes=await blob.arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
     })(),add(url,options)]);
     await emit({type:'worklet-loaded',contextId,url:String(url),sha256:hash});
    }catch(error){await emit({type:'worklet-failed',contextId,url:String(url),error:String(error)});throw error;}
   };
   const close=ctx.close.bind(ctx);
   ctx.close=async(...args)=>{
    const output=meters.filter(meter=>meter.ctx===ctx).map(meter=>{clearInterval(meter.timer);return{name:meter.name,peak:meter.peak,checks:meter.checks};});
    const value=await close(...args);await emit({type:'context-closed',contextId,state:ctx.state,output});return value;
   };
   return ctx;
  }});
 });
 page=await context.newPage();page.setDefaultTimeout(timeout);
 page.on('pageerror',error=>errors.push({kind:'pageerror',message:String(error)}));
 page.on('console',message=>{if(message.type()==='error'){
  const text=message.text();
  // Godot reports normal module-resolution candidate misses through printErr.
  // The subsequent successful resolution is proved by the real React runs.
  const candidates=/^\[WARN\] \[jsb\]\[Warning\] failed to check out module \(absolute\) res:\/\/\.godot\/GodotJS\/(?:\.playground|src)\/node_modules\/(?:react|@godot-js\/react\/engine) \[at get_source_info /;
  (candidates.test(text)?warnings:errors).push({kind:'console',message:text});
 }});
 page.on('request',request=>{if(/\.audio\.(?:position\.)?worklet\.js(?:$|\?)/.test(request.url()))network.push(request.url());});
 await page.goto(`${editorOrigin}${urlPrefix}?previewOrigin=${encodeURIComponent(previewOrigin+urlPrefix)}`,{waitUntil:'domcontentloaded'});
 const initial=await running('godot');
 assert.equal((await inspect()).engine.releaseId,release.id);
 assert.equal((await inspect()).project.demoId,'native');
 assert.match((await inspect()).project.files['/src/Main.ts'],/from ["']godot["']/);
 checks.push('default native project automatically compiles and runs the full engine on a distinct preview origin');
 await stop(initial);
 await page.locator('#run').click();const rerun=await running('godot');await stop(rerun);
 checks.push('native stop and rerun create a fresh iframe and close real audio contexts');
 await page.locator('#files [data-path="/src/Main.ts"]').focus();await page.keyboard.press('F2');
 await page.locator('#filename').fill('src/Renamed.ts');await page.locator('#file-form').press('Enter');
 await page.locator('#file-form').waitFor({state:'hidden'});
 const renamed=await inspect();assert.equal(renamed.project.entry,'/src/Renamed.ts');
 assert.match(renamed.project.files['/main.tscn'],/path="res:\/\/src\/Renamed.ts"/);
 assert.equal(renamed.project.files['/src/Main.ts'],undefined);
 await page.locator('#run').click();const renamedScript=await running('godot');await stop(renamedScript);
 await page.locator('#files [data-path="/main.tscn"]').focus();await page.keyboard.press('F2');
 await page.locator('#filename').fill('world/Main.tscn');await page.locator('#file-form').press('Enter');
 await page.locator('#file-form').waitFor({state:'hidden'});
 const moved=await inspect();assert.equal(moved.project.mainScene,'res://world/Main.tscn');
 assert.match(moved.project.files['/project.godot'],/run\/main_scene="res:\/\/world\/Main.tscn"/);
 await page.locator('#run').click();const movedScene=await running('godot');await stop(movedScene);
 checks.push('real editor renames the attached native script and moves its main scene, preserving references and rerunning both projects');
 await choose('react');const react=await running('react');
 await stop(react);await page.locator('#run').click();const reactRerun=await running('react');await stop(reactRerun);
 checks.push('React uses the full native engine and supports fresh-iframe stop and rerun');

 const compiled=await page.evaluate(async files=>{
  const worker=new Worker('./compiler.worker.js');let serial=0;
  const request=(kind,files)=>new Promise((resolve,reject)=>{
   const id=++serial,timer=setTimeout(()=>reject(Error('Independent production compiler timed out')),120000);
   worker.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};
   worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message));};
   worker.postMessage({id,kind,runtime:'godot',revision:serial,entry:'/src/Main.ts',files,mode:'production',engineProfile:window.__playgroundWorkbench.inspect().engineProfile,releaseContext:window.__playgroundWorkbench.inspect().releaseContext});
  });
  try{
   const checked=await request('check',files),built=await request('compile',files);
   const camel={...files,'/project.godot':files['/project.godot']+'\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=true\n',
    '/src/Main.ts':'import {Node2D,Vector2} from "godot"; const node=new Node2D(); node.addChild(new Node2D()); node.position=new Vector2(1,2); export const children=node.getChildCount();'};
   const camelValid=await request('check',camel),camelCompiled=await request('compile',camel);
   const camelInvalid=await request('check',{...camel,'/src/Main.ts':camel['/src/Main.ts']+'\nnode.add_child(new Node2D());\nnode.position="wrong type";'});
   const snakeLast=await request('check',{...files,'/project.godot':files['/project.godot']+'\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=true\nruntime/core/camel_case_bindings_enabled=false\n'});
   return {checked,built:{...built,pack:built.pack?Array.from(built.pack):undefined},camelValid,camelCompiled:{...camelCompiled,packBytes:camelCompiled.pack?.byteLength,pack:undefined},camelInvalid,snakeLast};
  }finally{worker.terminate();}
 },nativeProject.files);
 for(const [name,result]of Object.entries(compiled))if(name!=='camelInvalid')assert.deepEqual(result.diagnostics?.filter(d=>d.category==='error'),[],`${name}: ${JSON.stringify(result)}`);
 assert(compiled.built.pack.length>112);assert.equal(compiled.built.code,'');
 assert.equal(compiled.built.manifest.runtime,'godot');assert.equal(compiled.built.manifest.engineReleaseId,release.id);
 assert.equal(compiled.built.manifest.mainScene,'uid://d1t');
 const packed=packedFiles(compiled.built.pack);
 assert.equal(packed['res://project.godot'].toString(),nativeProject.files['/project.godot']);
 assert.equal(packed['res://main.tscn.uid'].toString(),'uid://d1t');
 assert.match(packed['res://.godot/GodotJS/src/Main.js'].toString(),/require\("res:\/\/\.godot\/GodotJS\/src\/nested\/value.js"\)/);
 assert.equal(packed['res://.godot/GodotJS/src/settings.json'].toString(),'{"base":40}');
 assert(packed['res://.godot/uid_cache.bin']);
 assert(!Object.keys(packed).some(name=>name.includes('node_modules/react/')),'A native-only project must not silently pull React runtime');
 assert(compiled.camelCompiled.packBytes>112);
 const invalid=compiled.camelInvalid.diagnostics.filter(d=>d.category==='error');
 assert(invalid.some(d=>d.message.includes('add_child')),'Camel declarations must reject snake member calls');
 assert(invalid.some(d=>d.code===2322),'Camel declarations must retain property type checking');
 assert(invalid.every(d=>d.file==='/src/Main.ts'&&d.line>0&&d.column>0));
 checks.push('independent real worker compiles UID native scenes, native classes, relative TypeScript and JSON into a PCK');
 checks.push('camel declarations compile valid native APIs and produce navigable negative diagnostics');
 checks.push('the final project.godot camel setting wins when true is followed by false');

 await page.locator('#import').setInputFiles({name:'native-acceptance.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(nativeProject))});
 const imported=await running('godot');
 await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('FULL_ENGINE_NATIVE_READY {"answer":42'),null,{timeout});
 await stop(imported);
 checks.push('the production UI imports and executes the native UID/JSON/TypeScript project and a full-engine noise class');
 for(const [old,next]of [['/src/nested/value.ts','lib/value.ts'],['/src/Main.ts','world/Main.ts']]){
  await page.locator(`#files [data-path="${old}"]`).focus();await page.keyboard.press('F2');await page.locator('#filename').fill(next);await page.locator('#file-form').press('Enter');await page.locator('#file-form').waitFor({state:'hidden'});
  await page.locator('#run').click();const changed=await running('godot');await stop(changed);
 }
 const dependencyProject=(await inspect()).project;
 assert.match(dependencyProject.files['/world/Main.ts'],/from "\.\.\/lib\/value"/);
 assert.match(dependencyProject.files['/world/Main.ts'],/from "\.\.\/src\/settings.json"/);
 checks.push('worker-prepared renames update incoming TypeScript imports, moved-script imports, JSON dependencies and native scene references before running');
 const interop=structuredClone(nativeProject);
 interop.files['/src/barrel.ts']='export * as G from "godot";';interop.files['/src/star.ts']='export * from "godot";';
 interop.files['/src/Main.ts']=`import * as G from "godot";import {G as Again} from "./barrel";import {Node,Vector2,sin} from "./star";
export default class Main extends G.Node2D {_ready(){
 if(G!==Again||G.Node!==Node||G.Vector2!==Vector2||sin(0)!==0)throw Error('Native re-exports differ');
 import('godot').then(dynamic=>{if(dynamic!==G)throw Error('Native namespace identity differs');console.log('FULL_ENGINE_INTEROP_OK');});
}}`;
 await page.locator('#import').setInputFiles({name:'native-interop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(interop))});
 const nativeInterop=await running('godot');await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('FULL_ENGINE_INTEROP_OK'),null,{timeout});await stop(nativeInterop);
 checks.push('production worker and Web engine execute native namespace exports, star exports and dynamic imports with a shared namespace');
 const bytes=structuredClone(nativeProject);bytes.files['/project.godot']=Array.from(Buffer.from(bytes.files['/project.godot']+'\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=true\n'));
 bytes.files['/src/Main.ts']='import {Node2D,Label} from "godot";export default class Main extends Node2D {_ready(){this.addChild(new Label());console.log("FULL_ENGINE_BYTE_CAMEL_OK");}}';
 await page.locator('#import').setInputFiles({name:'byte-camel.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bytes))});
 const byteCamel=await running('godot');await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('FULL_ENGINE_BYTE_CAMEL_OK'),null,{timeout});await stop(byteCamel);
 checks.push('byte-encoded project.godot selects camel declarations and executes the same native camel bindings');
 for(const playbackType of [0,1]){
  await page.locator('#import').setInputFiles({name:`audio-${playbackType}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(audioProject(playbackType)))});
  const playing=await running('godot');
  await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
  await until(()=>audio.some(event=>event.documentId===playing&&event.type==='worklet-output'&&event.name==='godot-processor'&&event.peak>0.01),`AudioStreamGenerator playback type ${playbackType} must produce a nonzero real worklet output`);
  await stop(playing);
 }
 checks.push('native AudioStreamGenerator and AudioStreamPlayer produce measured worklet output under default and stream playback settings');
 for(let index=0;index<lifecycleLoops;index++){
  await page.locator('#run').click();const loop=await running('godot');
  await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
  await until(()=>audio.some(event=>event.documentId===loop&&event.type==='worklet-output'&&event.peak>0.01),'Repeated audio session must produce real output');
  await stop(loop);
 }
 checks.push(`${lifecycleLoops} additional fresh audio iframe lifecycles complete without stale worklet callbacks or context leaks`);
 if(isolated){
  const stalled=structuredClone(nativeProject);
  stalled.files['/src/Main.ts']=`import {Node2D,print} from "godot";export default class Main extends Node2D{_ready(){
   const host=(globalThis as any).__godotjsRuntimeHost;if(!host)throw Error('The real Worker RuntimeHost is missing');
   host.bindProjectCommand((raw:string)=>{if(JSON.parse(raw).type==='acceptance-hang'){print('FULL_ENGINE_HANG_ENTER');while(true){}}});
   print('FULL_ENGINE_HANG_READY');
  }}`;
  await page.locator('#import').setInputFiles({name:'forced-worker.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(stalled))});
  const stalledDocument=await running('godot');
  await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('FULL_ENGINE_HANG_READY'),null,{timeout});
  const before=await page.evaluate(()=>{const current=globalThis.__fullEngineConnections.at(-1),health={...globalThis.__fullEngineHealth[current.identity.runId]};current.port.postMessage({...current.identity,type:'project-command',data:{type:'acceptance-hang'}});return{runId:current.identity.runId,health};});
  await page.waitForFunction(()=>!document.querySelector('#preview iframe'),null,{timeout});
  const after=await page.evaluate(runId=>({health:globalThis.__fullEngineHealth[runId],terminal:globalThis.__fullEngineTerminal.at(-1),count:globalThis.__fullEngineTerminal.length}),before.runId);
  assert.equal(after.count,sessionCleanup.length+1);assert.equal(after.terminal.runId,before.runId);assert.equal(after.terminal.type,'terminated');assert.equal(after.terminal.cleanup.mode,'forced');assertCleanup(after.terminal.cleanup);
  assert(after.health.host>=before.health.host+5,'The preview host must stay responsive while the application Worker is stuck');
  assert(after.health.engine<=before.health.engine+1,'A stuck application Worker must stop reporting frame progress');
  sessionCleanup.push({documentId:stalledDocument,runId:before.runId,cleanup:after.terminal.cleanup,forced:true,health:{before:before.health,after:after.health}});
  await page.locator('#import').setInputFiles({name:'after-force.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(audioProject(1)))});
  const recovered=await running('godot');await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
  await until(()=>audio.some(event=>event.documentId===recovered&&event.type==='worklet-output'&&event.peak>0.01),'A fresh session after forced termination must restore real audio output');await stop(recovered);
  checks.push('A stalled application Worker leaves the host responsive, times out with complete forced cleanup, and a fresh Worker session restores real audio');
 }
 const hashes=new Set(release.engine.worklets.map(asset=>asset.decodedSha256??asset.sha256));
 for(const frame of frames){
  const loaded=audio.filter(event=>event.documentId===frame.documentId&&event.type==='worklet-loaded');
  assert.deepEqual(new Set(loaded.map(event=>event.sha256)),hashes);
  assert(loaded.every(event=>event.url.startsWith('blob:')),'AudioWorklet executes verified Blob URLs');
  const created=audio.filter(event=>event.documentId===frame.documentId&&event.type==='context-created');
  const closed=audio.filter(event=>event.documentId===frame.documentId&&event.type==='context-closed');
  assert(created.length>0);assert.equal(closed.length,created.length);
 }
 assert.equal(network.length,frames.length*release.engine.worklets.length,'Only the integrity loader downloads each worklet once per fresh iframe');
 assert.deepEqual(errors,[]);
 assert.deepEqual(warnings,[],'Production React imports must resolve without failed candidate paths');
 checks.push('both real audio worklets match release hashes, execute from verified Blob bytes, and every fresh session closes audio');
 const report=await withAcceptanceContext({status:'passed',releaseId:release.id,lifecycleLoops,deployment,checks,frames,audio,sessionCleanup,workletNetworkRequests:network.length,errors,warnings,permissionPolicyObservation,
  ...(permissionPolicyObservation?.queryApi===false?{limitations:['This browser has no Permissions Policy query API. Fullscreen and actual cross-origin isolation are verified; the XR allow token is present, but XR policy behavior is not attested by this test.']}:{}),
  ...(process.env.BROWSER==='firefox'&&process.env.LIBGL_ALWAYS_SOFTWARE==='1'?{testEnvironment:{headless:process.env.BROWSER_HEADLESS!=='0',softwareGL:true,firefoxUserPrefs:{'webgl.force-enabled':true,'webgl.disabled':false,'gfx.webrender.software':true}}}:{}),
 }, {directory,browser});
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}catch(error){
 const report={status:'failed',error:String(error),stack:error.stack,deployment,checks,frames,audio,sessionCleanup,network,errors,warnings,state:await inspect().catch(()=>undefined),logs:await page?.locator('#logs').textContent().catch(()=>undefined)};
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.error(JSON.stringify(report,null,2));throw error;
}finally{await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();}
