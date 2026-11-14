/** Integration of an unchanged built production candidate, through its real UI.
 * No routes, module replacement, product capability probes or prototype assets.
 * Run once per PLAYGROUND_PRESENTATION_BACKEND=direct|bitmap and browser. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {launchBrowser,withAcceptanceContext,installPassiveRecorder} from '../../apps/playground/scripts/browser-harness.mjs';
import {createStaticServer} from '../../apps/playground/scripts/serve.mjs';
import {siteIdentity} from '../../apps/playground/scripts/site-evidence.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??path.join(repository,'apps/playground/dist'));
const presenter=process.env.PLAYGROUND_PRESENTATION_BACKEND??'direct';
assert(['direct','bitmap'].includes(presenter));
const timeout=Number(process.env.PLAYGROUND_WORKER_INTEGRATION_TIMEOUT??120000);
const imeCommitDelayMs=Number(process.env.PLAYGROUND_WORKER_IME_COMMIT_DELAY_MS??150);
assert(Number.isFinite(imeCommitDelayMs)&&imeCommitDelayMs>=0&&imeCommitDelayMs<=1000);
const imeIterations=Number(process.env.PLAYGROUND_WORKER_IME_ITERATIONS??3);assert(Number.isSafeInteger(imeIterations)&&imeIterations>=1&&imeIterations<=10);
const output=path.resolve(process.env.PLAYGROUND_WORKER_INTEGRATION_REPORT??path.join(repository,`work/worker-migration/integration-${process.env.BROWSER??'chromium'}-${presenter}.json`));
const screenshotDirectory=output.replace(/\.json$/,'')+'-screenshots';
const checks=[],screenshots=[],sessions=new Map(),sessionHistory=[],browserErrors=[],requests=[],contextLossOutcomes=[],imeTraces=[],projectTelemetry=[];
let browser,context,page,activeStage='startup';
const servers=[createStaticServer(directory),createStaticServer(directory)];
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const inspect=()=>page.evaluate(()=>globalThis.__playgroundWorkbench?.inspect());
const snapshot=()=>page.evaluate(()=>({state:globalThis.__playgroundWorkbench?.inspect(),status:document.querySelector('#status')?.textContent,logs:document.querySelector('#logs')?.textContent?.slice(-20000)}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function until(predicate,label,limit=timeout){const end=Date.now()+limit;while(Date.now()<end){const value=await predicate();if(value)return value;await sleep(25);}throw Error(label);}
async function check(name,callback){activeStage=name;console.error('[worker integration] '+name);const start=Date.now();await callback();checks.push({name,status:'passed',durationMs:Date.now()-start});}
async function event(type,predicate=()=>true){await page.waitForFunction(({type,source})=>{
 const state=globalThis.__playgroundWorkbench?.inspect();
 if(state?.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));
 if(state?.engine?.state==='exited'&&document.querySelector('#status')?.textContent==='运行错误')throw Error(document.querySelector('#logs')?.textContent);
 return state?.events.some(value=>value.type===type&&Function('value','return ('+source+')(value)')(value));
 },{type,source:String(predicate)},{timeout:Math.min(timeout,15000)});
 const observed=(await inspect()).events.filter(value=>value.type===type).findLast(predicate);projectTelemetry.push({stage:activeStage,event:observed});return observed;
}
async function frame(){const handle=await page.locator('#preview iframe').elementHandle();assert(handle);try{return await handle.contentFrame();}finally{await handle.dispose();}}
async function currentSession(){const preview=await frame();return preview.evaluate(()=>{const current=globalThis.__playgroundRuntimeSession;return typeof current==='function'?current():current;});}
async function running(){await page.waitForFunction(()=>{
 const state=globalThis.__playgroundWorkbench?.inspect();if(state?.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));
 if(state?.engine?.state==='exited'&&document.querySelector('#status')?.textContent==='运行错误')throw Error(document.querySelector('#logs')?.textContent);
 return state?.ready&&state.engine?.state==='running';
 },null,{timeout});const session=await currentSession();assert.equal(session.executionBackend,'worker');assert.equal(session.presentationBackend,presenter);return session;}
async function imported(project){await page.locator('#import').setInputFiles({name:'worker-integration.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await page.waitForFunction(source=>{const state=globalThis.__playgroundWorkbench?.inspect();return state?.project.files[state.project.entry]===source;},project.files[project.entry],{timeout});}
async function exited(workerId){await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout:20000});
 return until(()=>sessions.get(workerId)?.exit?.hostCleanup?sessions.get(workerId):false,'The real host must publish its cleanup receipt',5000);}
async function stop(workerId){await page.locator('#stop').click();const stopped=await exited(workerId);assert.equal(stopped.exit.hostCleanup.status,'complete');return stopped;}

// Decode externally captured Playwright PNGs, never read native GL pixels or
// alter product startup. Chromium/WebKit screenshots use RGB/RGBA 8-bit PNGs.
function pixels(png){
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let offset=8,width,height,channels;const compressed=[];
 while(offset<png.length){const length=png.readUInt32BE(offset),kind=png.toString('ascii',offset+4,offset+8),data=png.subarray(offset+8,offset+8+length);offset+=length+12;
  if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert([2,6].includes(data[9]));assert.equal(data[12],0);channels=data[9]===6?4:3;}if(kind==='IDAT')compressed.push(data);if(kind==='IEND')break;
 }
 assert(width&&height&&channels);const raw=inflateSync(Buffer.concat(compressed)),stride=width*channels,decoded=Buffer.alloc(stride*height);let cursor=0;
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<height;y++){const filter=raw[cursor++];assert(filter<=4);for(let x=0;x<stride;x++){
  const left=x>=channels?decoded[y*stride+x-channels]:0,up=y?decoded[(y-1)*stride+x]:0,upperLeft=y&&x>=channels?decoded[(y-1)*stride+x-channels]:0;
  decoded[y*stride+x]=(raw[cursor++]+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,upperLeft)))&255;
 }}return {width,height,channels,decoded};
}
async function screenshot(name,color){
 const preview=await frame(),canvas=preview.locator('canvas');let observation;
 await until(async()=>{const png=await canvas.screenshot({timeout:10000}),decoded=pixels(png);let red=0,green=0;
  for(let index=0;index<decoded.decoded.length;index+=decoded.channels){const r=decoded.decoded[index],g=decoded.decoded[index+1],b=decoded.decoded[index+2];if(r>180&&g<80&&b<80)red++;if(g>180&&r<80&&b<80)green++;}
  observation={name,width:decoded.width,height:decoded.height,red,green,sha256:sha(png),path:path.join(screenshotDirectory,name+'.png')};
  if((color==='red'?red:green)<3000)return false;await fs.writeFile(observation.path,png);return true;
 },`External ${presenter} compositor screenshot must contain the ${color} native rectangle`,10000);
 screenshots.push(observation);return observation;
}
const baseProject={schemaVersion:3,engineProfile:'full-engine-v1',runtime:'godot',demoId:'native',entry:'/src/Main.ts',selected:'/src/Main.ts',mode:'production',controls:{},files:{
 '/project.godot':'config_version=5\n[application]\nconfig/name="Official Worker integration"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.03,0.06,0.12,1)\n',
 '/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n',
 '/src/Main.ts':'',
}};
const nativeSource=marker=>`import {Node2D,ColorRect,Color,Vector2,LineEdit,JavaScriptBridge,Callable,FileAccess} from 'godot';
const host=()=>JavaScriptBridge.get_interface('window')!;
const send=(type:string,data:any={})=>host().call('__godotjsProjectEvent',JSON.stringify({type,fixture:${JSON.stringify(marker)},...data}));
export default class Main extends Node2D{
 rect!:ColorRect;edit!:LineEdit;frames=0;lastSize='';lastText='';realm:any;
 _ready(){
  this.rect=new ColorRect();this.rect.position=new Vector2(20,20);this.rect.size=new Vector2(130,100);this.rect.color=new Color(1,0,0,1);this.add_child(this.rect);
  this.edit=new LineEdit();this.edit.position=new Vector2(20,160);this.edit.size=new Vector2(260,40);this.add_child(this.edit);
  this.get_window()!.files_dropped.connect(Callable.create((files:any)=>{const count=typeof files.size==='function'?files.size():files.length,paths:string[]=[];
   for(let index=0;index<count;index++)paths.push(String(typeof files.get==='function'?files.get(index):files[index]));
   send('native-drop',{paths,contents:paths.map(path=>FileAccess.get_file_as_string(path))});
  }));
  this.realm=JSON.parse(String(JavaScriptBridge.eval('JSON.stringify({worker:typeof WorkerGlobalScope!=="undefined"&&globalThis instanceof WorkerGlobalScope,shared:typeof SharedArrayBuffer,crossOriginIsolated:globalThis.crossOriginIsolated,canvasType:document.getElementById("canvas").constructor.name})',true)));
  const interfaces:any={};for(const name of ['Array','JSON','Promise','WebSocket','RTCPeerConnection'])interfaces[name]=JavaScriptBridge.get_interface(name)!==null;
  send('native-ready',{realm:this.realm,interfaces});
 }
 _process(){
  const size=this.get_viewport()!.get_visible_rect().size,key=size.x+','+size.y;if(key!==this.lastSize){this.lastSize=key;send('native-size',{width:size.x,height:size.y});}
  if(this.edit.text!==this.lastText){this.lastText=this.edit.text;send('native-text',{text:this.lastText});}
  if(++this.frames===20)send('native-frames',{frames:this.frames});
 }
 _input(event:any){const kind=event.get_class();
  if(kind==='InputEventKey'){send('native-key',{pressed:event.pressed,key:event.keycode,unicode:event.unicode});
   if(event.pressed&&event.keycode===74)this.rect.color=new Color(0,1,0,1);
   if(event.pressed&&event.keycode===67){send('context-loss-requested');JavaScriptBridge.eval('(()=>{const gl=document.getElementById("canvas").getContext("webgl2");const loss=gl.getExtension("WEBGL_lose_context");if(!loss)throw Error("Missing WEBGL_lose_context test extension");loss.loseContext();})()',true);}
   if(event.pressed&&event.keycode===76){send('loop-entered');while(true){}}
  }else if(kind==='InputEventMouseButton')send('native-mouse',{pressed:event.pressed,button:event.button_index,x:event.position.x,y:event.position.y});
 }
}`;
function nativeProject(marker){const project=structuredClone(baseProject);project.files['/src/Main.ts']=nativeSource(marker);return project;}
function reactProject(){const project=structuredClone(baseProject);project.runtime='react';project.demoId='react';project.entry=project.selected='/src/App.tsx';delete project.files['/main.tscn'];delete project.files['/src/Main.ts'];project.files['/project.godot']=project.files['/project.godot'].replace('run/main_scene="res://main.tscn"\n','');
 project.files['/package.json']=JSON.stringify({private:true,dependencies:{react:'19.3.1','@godot-js/react':'0.1.0'}});
 project.files['/src/App.tsx']=`import * as React from 'react';import {EngineNode,useFrame} from '@godot-js/react/engine';import {Button,ColorRect,Color,Vector2,JavaScriptBridge} from 'godot';
const send=(type:string,data:any={})=>JavaScriptBridge.get_interface('window')!.call('__godotjsProjectEvent',JSON.stringify({type,...data}));
export default function App(){const [count,setCount]=React.useState(0);const frames=React.useRef(0);
 React.useLayoutEffect(()=>{const scope=globalThis as any;send('react-commit',{count,realm:{worker:typeof scope.WorkerGlobalScope!=='undefined'&&scope instanceof scope.WorkerGlobalScope,shared:typeof scope.SharedArrayBuffer},stack:new Error('React Worker callback').stack});},[count]);
 useFrame('process',()=>{if(++frames.current===20)send('react-frames',{frames:frames.current});});
 return <><EngineNode ctor={ColorRect} native={{position:new Vector2(20,20),size:new Vector2(130,100),color:count?new Color(0,1,0,1):new Color(1,0,0,1)}}/>
 <EngineNode ctor={Button} native={{position:new Vector2(20,140),size:new Vector2(150,40),text:'Increment '+count}} on={{pressed:()=>setCount(value=>value+1)}}/></>;
}`;return project;}

let initialIdentity;
try{
 await fs.mkdir(screenshotDirectory,{recursive:true});
 initialIdentity=await siteIdentity(directory);const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
 assert.equal(manifest.schemaVersion,3);assert.equal(manifest.runtime.executionBackend,'worker');assert(manifest.runtime.presentationBackends.includes(presenter));
 baseProject.engineProfile=initialIdentity.profile;
 await Promise.all(servers.map(listen));const [editorOrigin,previewOrigin]=servers.map(server=>'http://127.0.0.1:'+server.address().port);
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
 context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 await installPassiveRecorder(context,'__recordWorkerIntegrationSession',(_source,session)=>{if(session?.workerId){sessions.set(session.workerId,structuredClone(session));sessionHistory.push({at:Date.now(),workerId:session.workerId,state:session.workerState,closing:session.closing,exit:session.exit});}});
 await context.addInitScript(()=>{addEventListener('playground-runtime-session',event=>{void globalThis.__recordWorkerIntegrationSession(event.detail);});if(window===window.top){globalThis.__workerIntegrationTicks=0;setInterval(()=>globalThis.__workerIntegrationTicks++,20);}});
 page=await context.newPage();page.setDefaultTimeout(timeout);page.on('pageerror',error=>browserErrors.push(String(error)));page.on('request',request=>{if(request.resourceType()==='script'||/\.wasm(?:\.gz)?$/.test(request.url()))requests.push(request.url());});
 await page.goto(`${editorOrigin}/?project=native&executionBackend=worker&presentationBackend=${presenter}&previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready,null,{timeout});
 let nativeSession;
 await check('official UI compiles/imports native PCK and runs in a dedicated non-shared Worker',async()=>{
  await imported(nativeProject('native-main'));nativeSession=await running();const ready=await event('native-ready');assert.equal(ready.fixture,'native-main');assert.equal(ready.realm.worker,true);assert.equal(ready.realm.shared,'undefined');assert.equal(ready.realm.crossOriginIsolated,false);assert.equal(ready.realm.canvasType,'OffscreenCanvas');assert.deepEqual(ready.interfaces,{Array:true,JSON:true,Promise:true,WebSocket:true,RTCPeerConnection:true});await event('native-frames');
  const preview=await frame();assert.notEqual(new URL(preview.url()).origin,editorOrigin);const main=await preview.evaluate(()=>({jsbb:typeof globalThis._jsbb_,shared:typeof SharedArrayBuffer,canvas:document.querySelector('canvas').constructor.name}));assert.equal(main.jsbb,'undefined');assert.equal(main.canvas,'HTMLCanvasElement');
 });
 await check('external compositor screenshot proves native drawing and native mouse/key events change pixels',async()=>{
  await screenshot('native-initial','red');const preview=await frame();await preview.locator('canvas').click({position:{x:250,y:80}});await event('native-mouse',value=>value.pressed&&value.button===1);await page.keyboard.press('j');await event('native-key',value=>value.pressed&&value.key===74);await event('native-key',value=>!value.pressed&&value.key===74);await screenshot('native-key-changed','green');
 });
 await check('resize updates the native framebuffer and keeps presenting nonblank committed frames',async()=>{
  const size=await event('native-size'),before=await screenshot('native-before-resize','green');await page.setViewportSize({width:1200,height:850});
  await page.waitForFunction(({width,height})=>globalThis.__playgroundWorkbench.inspect().events.some(value=>value.type==='native-size'&&(value.width!==width||value.height!==height)),size,{timeout});
  const after=await screenshot('native-after-resize','green');assert(before.width!==after.width||before.height!==after.height);const current=await currentSession();assert.equal(current.workerId,nativeSession.workerId);
 });
 await check('browser DataTransfer File drop reaches native files_dropped and FileAccess reads its bytes',async()=>{
  const preview=await frame(),text='Official Worker drop 中文 bytes';
  const prevented=await preview.evaluate(text=>{const transfer=new DataTransfer();transfer.items.add(new File([text],'worker-drop.txt',{type:'text/plain'}));
   const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});document.querySelector('canvas').dispatchEvent(event);return event.defaultPrevented;
  },text);assert.equal(prevented,true);const dropped=await event('native-drop');assert.equal(dropped.paths.length,1);assert.match(dropped.paths[0],/\/worker-drop\.txt$/);assert.deepEqual(dropped.contents,[text]);
 });
 await check('real browser IME composition reaches the native LineEdit through the host editable node',async()=>{
  assert.equal(browser.browserType().name(),'chromium','This IME automation requires the Chromium DevTools input driver; run other browser IME acceptance manually.');
  const preview=await frame();await preview.locator('canvas').click({position:{x:80,y:180}});
  await preview.waitForFunction(()=>document.activeElement?.className==='ime',null,{timeout:10000});
  await preview.evaluate(()=>{const ime=document.querySelector('.ime'),events=[];globalThis.__workerIntegrationImeTrace=events;
   const record=(kind,event)=>{events.push({kind,time:performance.now(),data:event?.data??null,trusted:event?.isTrusted??null,inputType:event?.inputType??null,text:ime.textContent,active:document.activeElement?.className,hasFocus:document.hasFocus()});if(events.length>100)events.shift();};
   record('before-driver');for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','focus','blur'])ime.addEventListener(type,event=>record(type,event),true);
   new MutationObserver(()=>record('mutation')).observe(ime,{childList:true,subtree:true,characterData:true});
  });
  const cdp=await context.newCDPSession(page);try{for(let iteration=1;iteration<=imeIterations;iteration++){
   await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});if(imeCommitDelayMs)await sleep(imeCommitDelayMs);await cdp.send('Input.insertText',{text:'中文'});
   await event('native-text',new Function('value','return value.text === '+JSON.stringify('中文'.repeat(iteration))));
  }}finally{await cdp.detach();}
  imeTraces.push({imeCommitDelayMs,imeIterations,events:await preview.evaluate(()=>globalThis.__workerIntegrationImeTrace)});
 });
 await check('real WEBGL_lose_context event closes the run and a fresh Worker recovers',async()=>{
  const preview=await frame();await preview.locator('canvas').click({position:{x:250,y:80}});await page.keyboard.press('c');
  const lost=await exited(nativeSession.workerId);assert.equal(lost.exit.hostCleanup.status,'complete');assert.notEqual(lost.exit.reason,'clean-exit');
  const logs=await page.locator('#logs').textContent();
  assert.equal(lost.runId,nativeSession.runId);assert.equal(lost.documentId,nativeSession.documentId);
  // UI may omit a native Error stack. The same run's actual host observation
  // retains its Worker diagnostic; never borrow another session's errors.
  const lossDiagnostics=[logs,...(lost.workerErrors??[])].join('\n');
  // loseContext invalidates the backing context immediately; the native
  // webglcontextlost event is queued. A bitmap transfer can observe that real
  // invalidation first in the same committed iteration. Both failures must
  // clean up and recover; unrelated capture errors remain failures.
  assert.match(lossDiagnostics,/E_WORKER_WEBGL_CONTEXT_LOST|InvalidStateError:[\s\S]*transferToImageBitmap[\s\S]*WebGL context is lost/);
  assert((await inspect()).events.some(value=>value.type==='context-loss-requested'));
  contextLossOutcomes.push({workerId:nativeSession.workerId,detectedBy:/E_WORKER_WEBGL_CONTEXT_LOST/.test(lossDiagnostics)?'native-contextlost-event':'bitmap-transfer-observed-lost-context',workerErrors:lost.workerErrors??[],exit:lost.exit});
  await page.locator('#run').click();const recovered=await running();assert.notEqual(recovered.workerId,nativeSession.workerId);assert.notEqual(recovered.documentId,nativeSession.documentId);await event('native-ready');await screenshot('native-context-recovered','red');nativeSession=recovered;
 });
 await check('infinite native project loop leaves the main page responsive and forced termination never invents exit zero',async()=>{
  const preview=await frame();await preview.locator('canvas').click({position:{x:250,y:80}});await page.keyboard.press('l');
  await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().events.some(value=>value.type==='loop-entered'),null,{timeout:5000});
  const before=await page.evaluate(()=>globalThis.__workerIntegrationTicks);await page.waitForFunction(before=>globalThis.__workerIntegrationTicks>before+3,before,{timeout:2000});
  const stopped=await stop(nativeSession.workerId);assert.equal(stopped.exit.engineOutcome.kind,'terminate-issued');assert.equal(stopped.exit.reason,'forced-worker-termination');assert.equal(Object.hasOwn(stopped.exit,'code'),false);assert.equal(stopped.workerState,'terminated');
  await page.locator('#run').click();const restarted=await running();assert.notEqual(restarted.workerId,nativeSession.workerId);await event('native-ready');await screenshot('native-loop-recovered','red');await stop(restarted.workerId);
 });
 await check('real React useState/native signal commit execute in the Worker and update compositor pixels',async()=>{
  await imported(reactProject());const react=await running(),first=await event('react-commit',value=>value.count===0);assert.equal(first.realm.worker,true);assert.equal(first.realm.shared,'undefined');assert.match(first.stack,/React Worker callback/);await event('react-frames');await screenshot('react-initial','red');
  const preview=await frame();await preview.locator('canvas').click({position:{x:80,y:160}});const changed=await event('react-commit',value=>value.count===1);assert.equal(changed.realm.worker,true);await screenshot('react-state-changed','green');await stop(react.workerId);
 });
 await check('rapid project replacement cancels startup and only the new fresh session reaches the active UI',async()=>{
  await imported(nativeProject('cancel-first'));
  await page.waitForFunction(()=>{const state=globalThis.__playgroundWorkbench.inspect().engine?.state;return document.querySelector('#preview iframe')&&['loading-frame','handshaking','downloading','preloading','initializing','starting'].includes(state);},null,{timeout});
  const cancelled=await currentSession().catch(()=>undefined);await imported(nativeProject('cancel-final'));const replacement=await running();const ready=await event('native-ready',value=>value.fixture==='cancel-final');assert.equal(ready.fixture,'cancel-final');
  if(cancelled?.workerId)assert.notEqual(replacement.workerId,cancelled.workerId);assert.equal(await page.locator('#preview iframe').count(),1);await screenshot('native-cancel-recovered','red');await stop(replacement.workerId);
 });
 const identityAfter=await siteIdentity(directory);assert.equal(identityAfter.siteHash,initialIdentity.siteHash,'Candidate assets changed during integration');
 const report=await withAcceptanceContext({status:'passed',kind:'worker-integration',candidateId:initialIdentity.candidateId,siteHash:initialIdentity.siteHash,presentationBackend:presenter,checks,screenshots,sessions:[...sessions.values()],sessionHistory,browserErrors,requests,contextLossOutcomes,imeTraces,projectTelemetry}, {directory,browser});
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){const report={status:'failed',kind:'worker-integration',presentationBackend:presenter,activeStage,error:String(error),stack:error.stack,candidate:initialIdentity?{candidateId:initialIdentity.candidateId,siteHash:initialIdentity.siteHash,releaseId:initialIdentity.releaseId}:null,checks,screenshots,sessions:[...sessions.values()],sessionHistory,browserErrors,requests,imeTraces,imeCommitDelayMs,imeIterations,projectTelemetry,currentImeTrace:await(await frame().catch(()=>null))?.evaluate(()=>globalThis.__workerIntegrationImeTrace).catch(()=>null),last:await snapshot().catch(()=>null)};
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));process.exitCode=1;
}finally{await context?.close();await browser?.close();await Promise.all(servers.map(close));}
