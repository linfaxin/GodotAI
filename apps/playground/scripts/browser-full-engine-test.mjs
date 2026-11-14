import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkletResponseCollector} from './worklet-response-evidence.mjs';
import {launchBrowser,withAcceptanceContext,defaultTestDirectory,observedWorkerSessions,installPassiveRecorder,isBrowserConsoleWarning} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {RUNTIME_LIFECYCLE_MINIMUM} from './runtime-evidence.mjs';

// Acceptance of the built production site: no runtime, compiler, or network mocks.
const directory=defaultTestDirectory();
const runtimeProfile=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8')).runtimeProfile;
const siteManifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8')),workerRuntime=siteManifest.schemaVersion===3;
const output=process.env.PLAYGROUND_FULL_ENGINE_REPORT;
const timeout=Number(process.env.PLAYGROUND_FULL_ENGINE_TIMEOUT??180000);
const lifecycleLoops=Number(process.env.PLAYGROUND_FULL_ENGINE_LOOPS??RUNTIME_LIFECYCLE_MINIMUM[process.env.BROWSER??'chromium']);
assert(Number.isInteger(lifecycleLoops)&&lifecycleLoops>=1&&lifecycleLoops<=100);
const checks=[],audio=[],errors=[],warnings=[],network=[],frames=[],networkBodies=[],networkPending=[],runnerLogs=[],seenRunnerLogs=new Set();
const workletResponses=createWorkletResponseCollector();
let browser,context,page;
const editor=createStaticServer(directory),preview=createStaticServer(directory);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(25);}throw Error(message);}
const inspect=async()=>page?await page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect()):undefined;
async function captureRunnerLogs(documentId,phase){
 const lines=await page.locator('#logs .log-line').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,level:node.classList.contains('error')?'error':node.classList.contains('warn')?'warn':'log'})));
 runnerLogs.push({documentId,phase,lines});
 for(const line of lines){
  const key=line.level+':'+line.text;if(seenRunnerLogs.has(key))continue;seenRunnerLogs.add(key);
  if(line.level==='warn'||/(?:^|\n)\s*(?:WARNING:|\[WARN\])/.test(line.text))warnings.push({kind:'runner-log',documentId,...line});
  else if(line.level==='error'||/(?:^|\n)\s*(?:ERROR:|SCRIPT ERROR:)/.test(line.text))errors.push({kind:'runner-log',documentId,...line});
 }
}
async function running(runtime,{audioDriver='AudioWorklet'}={}){
 console.error(`[full-engine acceptance] waiting for ${runtime} run ${frames.length+1}`);
 await page.waitForFunction(runtime=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.ready&&state.project.runtime===runtime&&state.diagnostics?.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.ready&&state.project.runtime===runtime&&state.engine?.state==='running';},runtime,{timeout});
 const state=await inspect();assert.deepEqual(state.diagnostics.filter(d=>d.category==='error'),[]);
 assert.equal(await page.locator('#preview iframe').count(),1);
 const iframe=await page.locator('#preview iframe').elementHandle(),frame=await iframe.contentFrame();
 await iframe.dispose();
 assert(frame);assert.notEqual(new URL(frame.url()).origin,new URL(page.url()).origin);
 assert.equal(new URL(frame.url()).pathname,new URL('preview.html',state.releaseContext.releaseRoot).pathname);
 assert.equal(await frame.locator('canvas').count(),1);
 assert.match(await page.locator('#preview iframe').getAttribute('sandbox'),/allow-pointer-lock/);
 const permissions=await page.locator('#preview iframe').evaluate(element=>({
  delegated:(element.getAttribute('allow')??'').split(';').map(value=>value.trim()),
  recognized:element.featurePolicy?.features?.()??null,
 }));
 if(workerRuntime)for(const permission of ['fullscreen','microphone'])assert(permissions.delegated.includes(permission),'The Worker host must delegate '+permission);
 if(!workerRuntime||permissions.recognized?.includes('autoplay'))assert(permissions.delegated.includes('autoplay'),'Delegate autoplay when the browser recognizes it');
 const observation=await frame.evaluate(()=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;return session?.workerId?session:globalThis.__fullEngineObservation;});
 assert(observation?.documentId,'A fresh real preview document must be instrumented');
 assert(!frames.some(previous=>previous.documentId===observation.documentId),'Every run creates a fresh iframe');
 frames.push({runtime,documentId:observation.documentId,url:frame.url(),audioDriver,...(workerRuntime?{runId:observation.runId,workerId:observation.workerId,runConfigurationHash:observation.runConfigurationHash}:{})});
 await captureRunnerLogs(observation.documentId,'running');
 if(audioDriver==='Dummy')assert.equal(observation.audio?.driver,'Dummy','The prepared native driver must explicitly be Dummy');
 else await until(()=>audio.filter(e=>e.documentId===observation.documentId&&e.type==='worklet-loaded').length>=(workerRuntime?1:2),'The declared real audio worklets must load');
 console.error(`[full-engine acceptance] running ${runtime} ${observation.documentId}`);
 return observation.documentId;
}
async function stop(documentId,{dummy=false}={}){
 await page.locator('#stop').click();
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited',null,{timeout});
 await page.waitForFunction(()=>!document.querySelector('#preview iframe'),null,{timeout});
 if(dummy){
  await until(()=>observedWorkerSessions(browser).some(session=>session.documentId===documentId&&session.exit?.hostCleanup?.status==='complete'),'Dummy session must report actual host retirement');
  const retired=observedWorkerSessions(browser).find(session=>session.documentId===documentId);assert.equal(retired.audio.driver,'Dummy');assert.equal(retired.audio.contextsCreated,0);assert.equal(retired.audio.contextsClosed,0);
 }else await until(()=>audio.some(e=>e.documentId===documentId&&e.type==='context-closed'&&e.state==='closed'),'Native engine shutdown must close its AudioContext');
 assert(!audio.some(e=>e.documentId===documentId&&e.type==='worklet-failed'));
 await captureRunnerLogs(documentId,'stopped');
 console.error(`[full-engine acceptance] stopped ${documentId}`);
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
 project.files['/project.godot']+='\n[audio]\ngeneral/default_playback_type=0\ngeneral/default_playback_type.web=0\n';
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
function sampleAudioProject(){
 const project=structuredClone(nativeProject),pcm=Buffer.alloc(9600);
 for(let index=0;index<4800;index++)pcm.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*220/48000)*6500),index*2);
 project.files['/tone.tres']='[gd_resource type="AudioStreamWAV" format=3]\n[resource]\nformat=1\nmix_rate=48000\nstereo=false\nloop_mode=1\nloop_begin=0\nloop_end=4800\ndata=PackedByteArray('+Array.from(pcm).join(',')+')\n';
 project.files['/src/Main.ts']='import {Node,AudioStreamPlayer,ResourceLoader} from "godot";export default class Main extends Node {_ready(){const player=new AudioStreamPlayer();player.stream=ResourceLoader.load("res://tone.tres") as any;player.playback_type=2;this.add_child(player);player.play();console.log("FULL_ENGINE_WAV_SAMPLE_READY");}}';
 return project;
}
try{
 const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
 getEngineProfile(release.runtimeProfile);assert.equal(release.engine.worklets.length,2);
 await Promise.all([listen(editor),listen(preview)]);
 const editorOrigin=`http://127.0.0.1:${editor.address().port}`,previewOrigin=`http://127.0.0.1:${preview.address().port}`;
 browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 context=await browser.newContext({viewport:{width:1536,height:1000}});
 await installPassiveRecorder(context,'__fullAcceptanceRecord',(_source,event)=>{audio.push(event);});
 await context.addInitScript(()=>{
  if(!location.pathname.endsWith('/preview.html'))return;
  const documentId=crypto.randomUUID(),contexts=[],meters=[],blobs=new Map();
  globalThis.__fullEngineObservation={documentId};
  const emit=event=>{const current=globalThis.__playgroundRuntimeSession,session=typeof current==='function'?current():current;return globalThis.__fullAcceptanceRecord({documentId:session?.documentId??documentId,...event});};
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
 page.on('console',message=>{
  const text=message.text(),warning=isBrowserConsoleWarning(message.type(),text);
  if(message.type()==='error'||warning){
  // Godot reports normal module-resolution candidate misses through printErr.
  // The subsequent successful resolution is proved by the real React runs.
  const candidates=/^\[WARN\] \[jsb\]\[Warning\] failed to check out module \(absolute\) res:\/\/\.godot\/GodotJS\/(?:\.playground|src)\/node_modules\/(?:react|@godot-js\/react\/engine) \[at get_source_info /;
  (warning||candidates.test(text)?warnings:errors).push({kind:'console',message:text});
 }});
 page.on('request',request=>{if(/\.audio\.(?:position\.)?worklet\.js(?:$|\?)/.test(request.url()))network.push(request.url());});
 page.on('response',response=>{
  if(!/\.audio\.(?:position\.)?worklet\.js(?:$|\?)/.test(response.url()))return;
  networkPending.push(workletResponses.capture(response).then(evidence=>networkBodies.push(evidence)).catch(error=>errors.push({kind:'worklet-response',message:String(error)})));
 });
 await page.goto(`${editorOrigin}/?previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});
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
 if(workerRuntime){
  const dummy=structuredClone(nativeProject);dummy.files['/project.godot']+='\n[audio]\ndriver/driver="Dummy"\n';
  await page.locator('#import').setInputFiles({name:'explicit-dummy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(dummy))});
  const documentId=await running('godot',{audioDriver:'Dummy'});await stop(documentId,{dummy:true});
  assert.equal(audio.filter(event=>event.documentId===documentId).length,0,'Explicit Dummy must create no AudioContext or worklet');
  checks.push('explicit native Dummy driver runs without an AudioContext, worklet or failure fallback');
  await page.locator('#import').setInputFiles({name:'real-wav-sample.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sampleAudioProject()))});
  const sample=await running('godot');await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
  await until(()=>audio.some(event=>event.documentId===sample&&event.type==='worklet-output'&&event.name==='godot-worker-meter'&&event.peak>0.01),'A real AudioStreamWAV sample must produce measured master-graph output');
  await stop(sample);checks.push('a real looping AudioStreamWAV uses explicit sample playback and produces measured master output');
 }
 for(const playbackType of [0,1]){
  await page.locator('#import').setInputFiles({name:`audio-${playbackType}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(audioProject(playbackType)))});
  const playing=await running('godot');
  await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
  await until(()=>audio.some(event=>event.documentId===playing&&event.type==='worklet-output'&&event.name===(workerRuntime?'godot-worker-audio':'godot-processor')&&event.peak>0.01),`AudioStreamGenerator playback type ${playbackType} must produce a nonzero real worklet output`);
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
 const hashes=new Set(workerRuntime?[siteManifest.runtime.assets['runtime.audio.worklet.js'].sha256]:release.engine.worklets.map(asset=>asset.decodedSha256??asset.sha256));
 for(const frame of frames){
  const loaded=audio.filter(event=>event.documentId===frame.documentId&&event.type==='worklet-loaded');
  if(frame.audioDriver==='Dummy'){assert.equal(loaded.length,0);continue;}
  assert.deepEqual(new Set(loaded.map(event=>event.sha256)),hashes);
  assert(loaded.every(event=>event.url.startsWith('blob:')),'AudioWorklet executes verified Blob URLs');
  const created=audio.filter(event=>event.documentId===frame.documentId&&event.type==='context-created');
  const closed=audio.filter(event=>event.documentId===frame.documentId&&event.type==='context-closed');
  assert(created.length>0);assert.equal(closed.length,created.length);
 }
 const downloaded=[...release.engine.worklets.map(asset=>({path:asset.path,sha256:asset.sha256})),...(workerRuntime?[{path:siteManifest.runtime.audioWorklet,sha256:siteManifest.runtime.assets[siteManifest.runtime.audioWorklet].sha256}]:[])];
 await Promise.all(networkPending);
 assert.equal(network.length,frames.length*downloaded.length,'Each declared engine/runtime worklet is integrity-fetched once per fresh iframe');
 assert.equal(networkBodies.length,network.length,'Every worklet response must have captured bytes or linked cache revalidation evidence');
 for(const asset of downloaded){
  const url=new URL(asset.path,previewOrigin+'/').href,requests=network.filter(value=>value===url),responses=networkBodies.filter(value=>value.url===url);
  assert.equal(requests.length,frames.length,'Exactly one declared worklet request per fresh iframe: '+asset.path);
  assert.equal(responses.length,frames.length,'Exactly one evidenced worklet response per fresh iframe: '+asset.path);
  assert(responses.every(response=>response.sha256===asset.sha256),'Downloaded worklet bytes must match the declared hash: '+asset.path);
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(warnings,[],'Production React imports must resolve without failed candidate paths');
 checks.push('both real audio worklets match release hashes, execute from verified Blob bytes, and every fresh session closes audio');
 const report=await withAcceptanceContext({status:'passed',releaseId:release.id,lifecycleLoops,checks,frames,audio,runnerLogs,workletNetworkRequests:network.length,workletResponses:networkBodies,errors,warnings}, {directory,browser});
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}catch(error){
 await Promise.all(networkPending);
 const report={status:'failed',error:String(error),stack:error.stack,checks,frames,audio,network,workletResponses:networkBodies,errors,warnings,state:await inspect().catch(()=>undefined),logs:await page?.locator('#logs').textContent().catch(()=>undefined)};
 if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.error(JSON.stringify(report,null,2));throw error;
}finally{await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);}
