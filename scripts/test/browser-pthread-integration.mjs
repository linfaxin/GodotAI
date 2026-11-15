import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {serveIsolatedBrowserPair} from './browser-server.mjs';
import {buildEngineVendor} from '../../apps/playground/scripts/full-engine-release.mjs';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const request=createRequire(path.join(repository,'apps/playground/package.json'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const utf8=value=>new TextEncoder().encode(value);
const cleanupComplete=value=>value&&value.errors.length===0&&value.workers===value.terminatedWorkers&&value.audioContexts===value.closedAudioContexts&&(value.messagePorts??0)===(value.closedMessagePorts??0)&&(value.glContexts??0)===(value.lostGlContexts??0)&&(value.mediaTracks??0)===(value.stoppedMediaTracks??0)&&(value.networkResources??0)===(value.closedNetworkResources??0);
async function deadline(operation,label,ms=90000){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('E_WORKER_DEADLINE: '+label)),ms);})]);}finally{clearTimeout(timer);}}
const parse=values=>Object.fromEntries(values.reduce((rows,value,index)=>value.startsWith('--')?[...rows,[value.slice(2),values[index+1]?.startsWith('--')?true:values[index+1]??true]]:rows,[]));

export function workerProbeFiles(vendor,{hang=false,stopAudioBeforeQuit=false}={}) {
 const main=`const G=require('godot'),J=require('godot-jsb'),React=require('res://.playground/vendor.js').React,R=require('res://.playground/vendor.js').engineReact;
const host=globalThis.__godotjsRuntimeHost;
const assert=(value,message)=>{if(!value)throw Error('WORKER_PROBE '+message);};
exports.default=class WorkerProbe extends G.Node2D{
 _ready(){
  assert(typeof document==='undefined','business code must execute without DOM');assert(host&&host.role==='engine','explicit engine role');
  this.frames=0;this.physicsFrames=0;this.collided=false;this.echo=false;this.inputs=0;this.reactValue=0;
  this.lifecycle=require('res://worker-react-probe.js').run(G,R,React);
  const ir=J.internal.get_engine_api();assert(ir.modules.includes('GodotJS')&&ir.modules.includes('gltf')&&ir.modules.includes('godot_physics_3d'),'full module set');
  this.mount=new G.Node();this.add_child(this.mount);
  this.root=R.createRoot(this.mount,{autoProcess:false,onError:(error,info)=>host.reportDiagnostic({kind:info.kind,message:String(error),stack:info.stack})});
  const self=this;
  function App(){const [value,set]=React.useState(0);self.setReact=set;React.useLayoutEffect(()=>{self.reactValue=value;},[value]);return React.createElement(R.EngineNode,{ctor:G.Label,native:{text:'Worker '+value}});}
  this.root.render(React.createElement(App));this.root.flush();
  this.body=new G.CharacterBody2D();const hit=new G.CollisionShape2D();hit.shape=new G.RectangleShape2D();hit.shape.size=new G.Vector2(20,20);this.body.add_child(hit);this.body.position=new G.Vector2(100,30);this.add_child(this.body);
  const floor=new G.StaticBody2D(),shape=new G.CollisionShape2D();shape.shape=new G.RectangleShape2D();shape.shape.size=new G.Vector2(300,20);floor.add_child(shape);floor.position=new G.Vector2(100,120);this.add_child(floor);
  const player=new G.AudioStreamPlayer(),stream=new G.AudioStreamGenerator();stream.mix_rate=22050;stream.buffer_length=0.2;player.stream=stream;player.playback_type=G.AudioServer.PlaybackType.PLAYBACK_TYPE_STREAM;this.audioPlayer=player;this.add_child(player);player.play();this.playback=player.get_stream_playback();this.audioPhase=0;
  this.echoCount=0;this.workerRealms=[];this.spawnEchoWorker();
  host.bindProjectCommand(raw=>{const command=JSON.parse(raw);if(command.type==='hang'){host.emitProjectEvent({type:'hang-entered'});for(;;){}}else if(command.type==='stop'){this.cleanupProbe();this.stopAt=this.frames+6;}else if(command.type==='stale-packet'){postMessage({__godotjsRuntime:1,sessionId:command.oldSession,workerId:command.workerId,type:'project',role:'engine',data:{type:'stale-must-not-arrive'}});host.emitProjectEvent({type:'stale-probe-complete'});}});
  const screen=G.DisplayServer.screen_get_size();assert(screen.x>0&&screen.y>0,'synchronous host display query');
  host.emitProjectEvent({type:'probe-start',role:host.role,documentAbsent:typeof document==='undefined',workerIsolated:crossOriginIsolated,workerSecure:isSecureContext,sab:typeof SharedArrayBuffer==='function',syncHost:{display:G.DisplayServer.get_name(),screen:{x:screen.x,y:screen.y}},modules:ir.modules.length,has3D:!!G.Node3D,hasXR:!!G.WebXRInterface});
 }
 _input(event){if(event instanceof G.InputEventKey&&event.pressed)this.inputs++;}
 _physics_process(delta){this.physicsFrames++;this.body.velocity=new G.Vector2(0,220);this.body.move_and_slide();if(this.body.get_slide_collision_count()>0)this.collided=true;this.root.physics(delta);this.lifecycle.physics();}
 _process(delta){
  this.frames++;if(this.stopAt&&this.frames>=this.stopAt){this.get_tree().quit(0);return;}if(this.restartWorkerAt&&this.frames>=this.restartWorkerAt){this.restartWorkerAt=0;this.spawnEchoWorker();}this.root.process(delta);this.lifecycle.process();if(this.frames===4)this.setReact(7);
  if(this.echo&&!this.closeProbe)this.closeProbe=require('res://worker-close-probe.js').run(G);if(this.closeProbe)this.closeProbe.process();
  if(this.playback){const count=Math.min(this.playback.get_frames_available(),1024);for(let i=0;i<count;i++){const value=Math.sin(this.audioPhase++*Math.PI*2*440/22050)*0.2;this.playback.push_frame(new G.Vector2(value,value));}}
  if(this.closeProbe&&this.closeProbe.results().done&&!this.closeProbe.results().passed)throw Error(JSON.stringify(this.closeProbe.results()));
  if(this.frames>20&&this.collided&&this.echo&&this.closeProbe?.results().passed&&this.reactValue===7&&this.inputs>0&&!this.sent){assert(this.lifecycle.results().passed&&this.lifecycle.results().extendedPassed===true,JSON.stringify(this.lifecycle.results()));this.sent=true;host.emitProjectEvent({type:'probe-ready',frames:this.frames,physicsFrames:this.physicsFrames,collided:this.collided,echo:this.echo,workerReuse:{count:this.echoCount,realms:this.workerRealms},workerClose:this.closeProbe.results(),reactValue:this.reactValue,inputs:this.inputs,reactLifecycle:this.lifecycle.results()});${hang?'for(;;){}':''}}
 }
 spawnEchoWorker(){
  const {JSWorker}=require('godot.worker');this.worker=new JSWorker('src/echo.worker');
  this.worker.onready=()=>this.worker.postMessage({kind:'echo',vector:new G.Vector2(3,4)});
  this.worker.onmessage=data=>{
   assert(data.kind==='echo'&&data.vector instanceof G.Vector2&&data.vector.x===3&&data.vector.y===4,'Variant roundtrip');
   this.echoCount++;this.workerRealms.push({tag:data.realmTag,incarnation:data.incarnation});
   if(this.echoCount===1){this.worker.terminate();this.worker=null;this.restartWorkerAt=this.frames+4;}
   else{assert(this.workerRealms[0].tag===data.realmTag&&data.incarnation>this.workerRealms[0].incarnation,'pooled browser Worker reinitialized after native join');this.echo=true;}
  };
 }
 cleanupProbe(){if(this.cleaned)return;this.restartWorkerAt=0;this.cleaned=true;${stopAudioBeforeQuit?'if(this.audioPlayer){this.audioPlayer.stop();this.playback=null;}':''}if(this.worker){this.worker.terminate();this.worker=null;}if(this.closeProbe)this.closeProbe.dispose();if(this.root)this.root.shutdown();if(this.lifecycle)this.lifecycle.dispose();}
 _exit_tree(){this.cleanupProbe();}
};`;
 const echo=`const G=require('godot'),{JSWorkerParent}=require('godot.worker');if(!JSWorkerParent)throw Error('missing worker parent');globalThis.__workerProbeRealmTag??='realm-'+Math.random();globalThis.__workerProbeIncarnation=(globalThis.__workerProbeIncarnation??0)+1;JSWorkerParent.onmessage=data=>{if(!(data.vector instanceof G.Vector2))throw Error('worker Variant decode');JSWorkerParent.postMessage({kind:data.kind,vector:data.vector,realmTag:globalThis.__workerProbeRealmTag,incarnation:globalThis.__workerProbeIncarnation});JSWorkerParent.close();};`;
 const closeProbe=request(path.join(repository,'scripts/test/fixtures/worker-close-probe.cjs'));
 return new Map([
  ['res://project.godot',utf8('config_version=5\n[application]\nconfig/name="Full Worker integration"\nrun/main_scene="res://Main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
  ['res://Main.tscn',utf8('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n')],
  ['res://src/Main.ts',utf8('export default class WorkerProbe {}\n')],
  ['res://.godot/GodotJS/src/Main.js',utf8(main)],
  ['res://.godot/GodotJS/src/echo.worker.js',utf8(echo)],
  ['res://src/echo.worker.js',utf8(echo)],
  ['res://.playground/vendor.js',vendor],
  ['res://worker-react-probe.js',readFileSync(path.join(repository,'scripts/test/fixtures/worker-react-probe.cjs'))],
  ['res://worker-close-probe.js',readFileSync(path.join(repository,'scripts/test/fixtures/worker-close-probe.cjs'))],
  ['res://src/p1-close-startup.worker.js',utf8(closeProbe.startupSource)],
  ['res://.godot/GodotJS/src/p1-close-startup.worker.js',utf8(closeProbe.startupSource)],
  ['res://src/p1-close-message.worker.js',utf8(closeProbe.messageSource)],
  ['res://.godot/GodotJS/src/p1-close-message.worker.js',utf8(closeProbe.messageSource)],
  ['res://.godot/global_script_class_cache.cfg',utf8('list=Array[Dictionary]([])\n')],
 ]);
}

async function certificate(directory) {
 const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
 const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{encoding:'utf8'});
 if(generated.status!==0)throw Error('E_WORKER_TLS: '+generated.stderr);
 const publicKey=spawnSync('openssl',['x509','-in',cert,'-pubkey','-noout'],{encoding:'utf8'});
 const der=spawnSync('openssl',['pkey','-pubin','-outform','DER'],{input:publicKey.stdout});
 if(der.status!==0)throw Error('E_WORKER_TLS_SPKI');
 return {key:await readFile(key),cert:await readFile(cert),spki:createHash('sha256').update(der.stdout).digest('base64')};
}

export async function runWorkerIntegration({engineReport,out,loops=3,browserName='chromium',verbose=process.env.GODOTJS_WORKER_VERBOSE==='1',stopAudioBeforeQuit=process.env.GODOTJS_WORKER_PRESTOP_AUDIO==='1'}={}) {
 const harnessBytes=await readFile(fileURLToPath(import.meta.url));
 if(!['chromium','firefox','webkit'].includes(browserName))throw Error('E_WORKER_BROWSER: Expected chromium, firefox or webkit');
 if(!engineReport)throw Error('Pass --engine-report with an actual source-bound proxy-pthread build');
 const report=JSON.parse(await readFile(engineReport,'utf8'));
 if(report.status!=='built'||report.execution?.executionModel!=='proxy-pthread')throw Error('E_WORKER_ENGINE_REPORT');
 const directory=path.resolve(out??'/workspace/output/engine-worker-implementation/runtime');await mkdir(directory,{recursive:true});
 await mkdir(path.join(directory,'producer'),{recursive:true});await writeFile(path.join(directory,'producer/harness.mjs'),harnessBytes);
 const site=path.join(directory,'site');await mkdir(path.join(site,'engine'),{recursive:true});
 const archive=path.resolve(path.dirname(path.resolve(engineReport)),report.template.path);
 const archiveBytes=await readFile(archive);if(hash(archiveBytes)!==report.template.sha256)throw Error('E_WORKER_TEMPLATE_HASH');
 const extracted=spawnSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n z.extractall(sys.argv[2])',archive,path.join(site,'engine')],{encoding:'utf8'});
 if(extracted.status!==0)throw Error('E_WORKER_TEMPLATE: '+extracted.stderr);
 const {build}=request('esbuild'),playwright=request('playwright');
 await build({entryPoints:[path.join(repository,'packages/engine/src/browser/engine-session.ts')],bundle:true,format:'iife',globalName:'EngineHost',platform:'browser',target:'es2022',outfile:path.join(site,'session.js')});
 const {packProject}=await import('@godot-js/project-tools/pck');
 const vendor=await buildEngineVendor();
 const files=workerProbeFiles(vendor,{stopAudioBeforeQuit}),pack=packProject(files).pack;
 await writeFile(path.join(site,'project.pck'),pack);
 await writeFile(path.join(site,'preview.html'),`<!doctype html><link rel="icon" href="data:,"><button id="unlock" style="position:fixed;top:0;left:0;z-index:10000">Enable audio</button><canvas id="canvas" width="320" height="240" tabindex="0"></canvas><script src="session.js"></script><script src="engine/godot.js"></script><script>
 window.probe={documentId:crypto.randomUUID(),events:[],roles:[],progress:[],errors:[],exits:[],sessions:[],ready:false};
 // Preserve real native execution but hold final packets long enough for the
 // receiver to attempt reaping a completed sender before delivery.
 const postWorkerMessage=Worker.prototype.postMessage;
 Worker.prototype.postMessage=function(message,...args){
  if(message?.__jsbMessage===true&&message.route?.direction==='to-parent'&&message.data?.kind==='p1-close-final'){
   probe.delayedClosePackets=(probe.delayedClosePackets??0)+1;
   setTimeout(()=>postWorkerMessage.call(this,message,...args),300);return;
  }
  return postWorkerMessage.call(this,message,...args);
 };
 window.addEventListener('error',event=>probe.errors.push(String(event.message)));
 window.startProbe=async function(){
  if(probe.sessions.length||probe.session)throw Error('E_PROBE_ONE_SESSION_PER_DOCUMENT');
  const id=crypto.randomUUID(),identity={runId:id,revision:1,generation:id,buildKey:'probe'};
  probe.ready=false;probe.current=id;
  const session=new EngineHost.BrowserEngineSession({identity,executionModel:'proxy-pthread',requiresCrossOriginIsolation:true,onProject:data=>{probe.events.push({runId:id,...data});if(data.type==='probe-ready')probe.ready=true;},onWorkerRole:data=>probe.roles.push({runId:id,...data}),onProgress:data=>probe.progress.push({runId:id,...data}),onDiagnostic:data=>{probe.errors.push(JSON.stringify(data));console.error(JSON.stringify(data));},onLog:(level,text)=>{if(level==='error')probe.errors.push(text);}});
  probe.session=session;
  const previous=document.querySelector('canvas'),canvas=document.createElement('canvas');canvas.id='canvas';canvas.width=320;canvas.height=240;canvas.tabIndex=0;if(previous)previous.replaceWith(canvas);else document.body.append(canvas);
  const engine=new Engine({canvas,executable:'engine/godot',emscriptenPoolSize:3,persistentPaths:[],persistentDrops:false,focusCanvas:false,onPrintError:text=>probe.errors.push(String(text)),onExit:code=>{probe.exits.push({runId:id,code});}});probe.engine=engine;
  await engine.preloadFile(new Uint8Array(await(await fetch('project.pck')).arrayBuffer()),'/project.pck');await engine.init('engine/godot');session.attachEngine(engine);await engine.start({args:[${verbose?"'--verbose',":''}'--main-pack','/project.pck','--rendering-method','gl_compatibility']});
  probe.sessions.push(id);return id;
 };
 document.querySelector('#unlock').onclick=()=>{const runtime=probe.engine?.rtenv;if(runtime?.resumeAudio)runtime.resumeAudio();document.querySelector('canvas').focus();};
 window.stopProbe=async function(mode='clean'){if(mode==='clean'){probe.session.command({type:'stop'});for(let i=0;i<200&&!probe.exits.some(item=>item.runId===probe.current);i++)await new Promise(resolve=>setTimeout(resolve,20));if(!probe.exits.some(item=>item.runId===probe.current))throw Error('E_PROBE_COOPERATIVE_STOP_TIMEOUT');}const result=await probe.session.dispose(mode);probe.cleanup=result;return result;};
 </script>`);
 const tls=await certificate(directory),pair=await serveIsolatedBrowserPair({root:site,tls});
 await writeFile(path.join(site,'index.html'),`<!doctype html><link rel="icon" href="data:,"><title>Full Worker lifecycle integration</title><main id="sessions"></main>`);
 const launchArgs=['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--ignore-certificate-errors-spki-list='+tls.spki];
 const headless=process.env.BROWSER_HEADLESS!=='0';
 const firefoxUserPrefs={'webgl.force-enabled':true,'webgl.disabled':false,'gfx.webrender.software':true};
 const launchEnvironment={headless,display:process.env.DISPLAY??null,audioServer:process.env.PULSE_SERVER??null,...(browserName==='firefox'?{firefoxUserPrefs}:{})};
 let browser,selectedBrowser;
 try{selectedBrowser=resolveBrowserExecutable(playwright[browserName],browserName);browser=await playwright[browserName].launch({headless,executablePath:selectedBrowser.executablePath,...(browserName==='chromium'?{args:launchArgs}:{}),...(browserName==='firefox'?{firefoxUserPrefs}:{})});}
 catch(error){await writeFile(path.join(directory,'worker-integration.json'),JSON.stringify({schemaVersion:1,kind:'godotjs-worker-integration',status:'failed',phase:'browser-launch',browser:{name:browserName,playwrightVersion:request('playwright/package.json').version,...selectedBrowser},launchEnvironment,engineReport:path.resolve(engineReport),error:String(error?.stack??error)},null,2)+'\n');await pair.close();throw error;}
 const producerInputs={harness:hash(harnessBytes),host:hash(await readFile(path.join(site,'session.js'))),vendor:hash(vendor),pack:hash(pack),projectFiles:Object.fromEntries([...files].map(([name,bytes])=>[name,hash(bytes)])),editorHtml:hash(await readFile(path.join(site,'index.html'))),previewHtml:hash(await readFile(path.join(site,'preview.html')))};
 const result={schemaVersion:1,kind:'godotjs-worker-integration',status:'running',contextLifecycle:'fresh-document-per-session',verbose:!!verbose,stopAudioBeforeQuit:!!stopAudioBeforeQuit,validationBatchId:randomUUID(),sourceSnapshotHash:report.source.snapshotHash,producerHash:hash(JSON.stringify(producerInputs)),producerInputs,engineReport:path.resolve(engineReport),engineReportHash:hash(await readFile(engineReport)),templateSha256:report.template.sha256,os:process.platform,browser:{name:browserName,version:browser.version(),playwrightVersion:request('playwright/package.json').version,...selectedBrowser},launchEnvironment,origins:{editor:pair.editor.origin,preview:pair.preview.origin},cases:[],limitations:[],launchArgs:browserName==='chromium'?launchArgs:[],startedAt:new Date().toISOString()};
 try {
  const context=await browser.newContext(browserName==='chromium'?{}:{ignoreHTTPSErrors:true});
  await context.addInitScript(()=>{
   const gl=[];globalThis.__workerGLEvidence=gl;
   if(typeof HTMLCanvasElement!=='undefined'){
    const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){const value=getContext.call(this,type,...args);if(value&&['webgl','webgl2','experimental-webgl'].includes(type)&&!gl.some(item=>item.context===value))gl.push({context:value,type,owner:'host',offscreen:false});return value;};
   }
   const records=[];globalThis.__workerAudioEvidence=records;
   if(typeof AudioNode==='undefined')return;
   const connect=AudioNode.prototype.connect,observed=new WeakSet(),analysers=new WeakSet();
   AudioNode.prototype.connect=function(destination,...args){
    if(destination===this.context.destination&&!analysers.has(this)&&!observed.has(this)){
     observed.add(this);const analyser=this.context.createAnalyser();analysers.add(analyser);analyser.fftSize=256;
     const record={context:this.context,analyser,peak:0,checks:0};records.push(record);
     connect.call(this,analyser,...args);connect.call(analyser,destination);return destination;
    }
    return connect.call(this,destination,...args);
   };
   setInterval(()=>{for(const item of records){if(item.context.state!=='running')continue;const values=new Float32Array(item.analyser.fftSize);item.analyser.getFloatTimeDomainData(values);item.peak=Math.max(item.peak,...values.map(Math.abs));item.checks++;}},25);
  });
  const page=await context.newPage();const browserErrors=[];result.browserErrors=browserErrors;
  if(browserName==='firefox'&&!headless)await page.bringToFront();
  let rejectBrowser;const browserFailure=new Promise((_,reject)=>{rejectBrowser=reject;});void browserFailure.catch(()=>{});
  const step=(operation,label)=>deadline(Promise.race([operation,browserFailure]),label);
  page.on('pageerror',error=>{const detail=error.stack??String(error);browserErrors.push(detail);rejectBrowser(Error(detail));});
  page.on('console',message=>{process.stderr.write('[browser:'+message.type()+'] '+message.text()+'\n');if(message.type()==='error'){browserErrors.push(message.text());rejectBrowser(Error(message.text()));}});
  const browserWorkers={created:0,closed:0};
  page.on('worker',worker=>{browserWorkers.created++;worker.once('close',()=>browserWorkers.closed++);process.stderr.write('[worker] '+worker.url()+'\n');});
  const headers={};page.on('response',response=>{if([pair.editor.origin+'/index.html',pair.preview.origin+'/preview.html'].includes(response.url()))headers[response.url()]=response.headers();});
  await page.goto(pair.editor.origin+'/index.html');result.responseHeaders=headers;
  const documentIds=new Set(),allErrors=[];
  let previousSessionId;
  const openPreview=async label=>{
   if(page.workers().length||await page.locator('#preview').count())throw Error('E_WORKER_PREVIOUS_SCOPE_LIVE');
   await page.evaluate(src=>{const frame=document.createElement('iframe');frame.id='preview';frame.width='400';frame.height='320';frame.src=src;frame.allow='autoplay; cross-origin-isolated; xr-spatial-tracking; fullscreen';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-pointer-lock');document.querySelector('#sessions').append(frame);},pair.preview.origin+'/preview.html');
   const handle=await page.locator('#preview').elementHandle(),frame=await handle.contentFrame();await handle.dispose();if(!frame)throw Error('E_WORKER_FRAME');
   await step(frame.waitForFunction(()=>!!globalThis.probe?.documentId,null,{timeout:90000}),'preview document '+label);
   const isolation=await frame.evaluate(()=>({documentId:probe.documentId,isolated:crossOriginIsolated,secure:isSecureContext,sab:typeof SharedArrayBuffer==='function'}));
   if(!isolation.isolated||!isolation.secure||!isolation.sab||documentIds.has(isolation.documentId))throw Error('E_WORKER_ISOLATION_OR_DOCUMENT_REUSE '+JSON.stringify(isolation));documentIds.add(isolation.documentId);
   result.isolation??={top:await page.evaluate(()=>({isolated:crossOriginIsolated,secure:isSecureContext,sab:typeof SharedArrayBuffer==='function'})),preview:isolation};
   result.platformProbe??=await frame.evaluate(async()=>({ime:{compositionEvent:typeof CompositionEvent==='function',beforeInput:typeof InputEvent==='function',virtualKeyboard:!!navigator.virtualKeyboard},xr:{api:!!navigator.xr,immersiveVR:navigator.xr?await navigator.xr.isSessionSupported('immersive-vr').catch(()=>false):false}}));
   return {frame,documentId:isolation.documentId,workersAtStart:{...browserWorkers}};
  };
  const retirePreview=async opened=>{
   const {frame,workersAtStart}=opened;
   // Worker close is observed through Playwright before destroying the iframe;
   // removing the document must not conceal an incomplete session disposal.
   await deadline((async()=>{while(page.workers().length){await new Promise(resolve=>setTimeout(resolve,20));}})(),'browser Worker close before iframe disposal',10000);
   const workers={created:browserWorkers.created-workersAtStart.created,closed:browserWorkers.closed-workersAtStart.closed,remaining:page.workers().length};
   if(!workers.created||workers.created!==workers.closed||workers.remaining)throw Error('E_WORKER_BROWSER_LIFECYCLE '+JSON.stringify(workers));
   allErrors.push(...await frame.evaluate(()=>[...probe.errors]));
   await frame.evaluate(()=>{globalThis.__workerAudioEvidence.length=0;globalThis.__workerGLEvidence.length=0;probe.engine=undefined;probe.session=undefined;});
   await page.locator('#preview').evaluate(frame=>frame.remove());
   await deadline((async()=>{while(!frame.isDetached())await new Promise(resolve=>setTimeout(resolve,20));})(),'preview document removal',10000);
   return {...workers,closedBeforeFrameRemoval:true,documentDetached:frame.isDetached()};
  };
  for(let index=0;index<Number(loops);index++){
   const opened=await openPreview(index),{frame,documentId}=opened;
   const sessionStartedAt=Date.now();
   const audioStart=await frame.evaluate(()=>globalThis.__workerAudioEvidence.length);
   process.stderr.write('[probe] starting session '+index+'\n');
   await step(frame.evaluate(()=>startProbe()),'start session '+index);
   await step(frame.waitForFunction(()=>probe.events.some(item=>item.runId===probe.current&&item.type==='probe-start'),null,{timeout:90000}),'engine scene ready '+index);
   await frame.locator('#unlock').click();await frame.locator('canvas').click();await frame.locator('canvas').press('Space');
   await step(frame.waitForFunction(()=>probe.ready,null,{timeout:90000}),'systems ready '+index);
   await frame.waitForFunction(offset=>globalThis.__workerAudioEvidence?.slice(offset).some(item=>item.peak>0.01),audioStart,{timeout:10000});
   const state=await frame.evaluate(()=>({ready:probe.events.filter(item=>item.runId===probe.current&&item.type==='probe-ready').at(-1),delayedClosePackets:probe.delayedClosePackets??0,start:probe.events.filter(item=>item.runId===probe.current&&item.type==='probe-start').at(-1),roles:probe.roles.filter(item=>item.runId===probe.current),progress:probe.progress.filter(item=>item.runId===probe.current),gl:globalThis.__workerGLEvidence.map(item=>({type:item.type,owner:item.owner,offscreen:item.offscreen,vendor:item.context.getParameter(item.context.VENDOR),renderer:item.context.getParameter(item.context.RENDERER)})),errors:[...probe.errors]}));
   if(browserErrors.length||state.errors.length||!state.ready?.collided||!state.ready?.echo||state.ready.reactValue!==7||state.ready.inputs<1||!state.start?.documentAbsent||!state.roles.some(item=>item.role==='engine')||!state.roles.some(item=>item.role==='script-worker'))throw Error('E_WORKER_ASSERT '+JSON.stringify({...state,browserErrors}));
   if(!state.ready?.workerClose?.passed||state.delayedClosePackets!==6)throw Error('E_WORKER_CLOSE_ASSERT '+JSON.stringify(state));
   // Preserve completed P1 assertions if an unrelated shutdown step fails.
   result.activeCase={id:'session-'+index,...state};
   const staleSessionId=previousSessionId??'obsolete-session';
   const staleSessionRejected=await frame.evaluate(async oldSession=>{
    const role=probe.roles.find(item=>item.runId===probe.current&&item.role==='engine');
    probe.session.command({type:'stale-packet',oldSession,workerId:role.workerId});
    for(let i=0;i<200&&!probe.events.some(item=>item.runId===probe.current&&item.type==='stale-probe-complete');i++)await new Promise(resolve=>setTimeout(resolve,10));
    return probe.events.some(item=>item.runId===probe.current&&item.type==='stale-probe-complete')&&!probe.events.some(item=>item.type==='stale-must-not-arrive');
   },staleSessionId);
   if(!staleSessionRejected)throw Error('E_WORKER_STALE_MESSAGE');
   let cleanup,termination;
   if(index===Number(loops)-1){
    await frame.evaluate(()=>probe.session.command({type:'hang'}));
    await step(frame.waitForFunction(()=>probe.events.some(item=>item.runId===probe.current&&item.type==='hang-entered'),null,{timeout:10000}),'hang entered');
    const before=await frame.evaluate(()=>probe.progress.at(-1)?.sequence);await page.waitForTimeout(500);
    termination=await frame.evaluate(previous=>({engineHung:probe.events.some(item=>item.runId===probe.current&&item.type==='hang-entered')&&probe.progress.at(-1)?.sequence===previous,hostResponsive:true}),before);
    if(!termination.engineHung)throw Error('E_WORKER_HANG_PROBE');
    cleanup=await step(frame.evaluate(()=>stopProbe('forced')),'forced session cleanup');
   }
   else cleanup=await deadline(frame.evaluate(()=>stopProbe('clean')),'stop session '+index);
   if(!cleanupComplete(cleanup))throw Error('E_WORKER_CLEANUP '+JSON.stringify(cleanup));
   const audio=await frame.evaluate(()=>globalThis.__workerAudioEvidence.map(item=>({state:item.context.state,peak:item.peak,checks:item.checks})));
   if(audio.some(item=>item.state!=='closed'))throw Error('E_WORKER_AUDIO_CLEANUP '+JSON.stringify(audio));
   const memory=await frame.evaluate(()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:undefined);
   const independentWorkers=await retirePreview(opened);
   result.cases.push({id:'session-'+index,status:'passed',documentId,...state,staleSessionRejected,staleSessionId,staleSessionSource:previousSessionId?'retired-browser-session':'invalid-sentinel',...(termination?{termination}:{}),cleanup,audio,browserWorkers:independentWorkers,elapsedMs:Date.now()-sessionStartedAt,...(memory?{memory}:{})});
   delete result.activeCase;
   previousSessionId=state.start.runId;
   await writeFile(path.join(directory,'worker-integration.json'),JSON.stringify(result,null,2)+'\n');
  }
  // The hang case must be followed by a fresh successful session.
  const recovered=await openPreview('after-forced-restart'),{frame}=recovered;
  await step(frame.evaluate(()=>startProbe()),'restart after forced termination');await step(frame.waitForFunction(()=>probe.events.some(item=>item.runId===probe.current&&item.type==='probe-start'),null,{timeout:90000}),'restart scene ready');await frame.locator('#unlock').click();await frame.locator('canvas').click();await frame.locator('canvas').press('Space');await step(frame.waitForFunction(()=>probe.ready,null,{timeout:90000}),'restart systems ready');
  result.afterForcedRestartWorkerClose=await frame.evaluate(()=>({results:probe.events.filter(item=>item.runId===probe.current&&item.type==='probe-ready').at(-1)?.workerClose,delayedClosePackets:probe.delayedClosePackets??0}));
  if(!result.afterForcedRestartWorkerClose.results?.passed||result.afterForcedRestartWorkerClose.delayedClosePackets!==6)throw Error('E_WORKER_RESTART_CLOSE_ASSERT');
  const recoveredStaleRejected=await frame.evaluate(async oldSession=>{
   const role=probe.roles.find(item=>item.runId===probe.current&&item.role==='engine');
   probe.session.command({type:'stale-packet',oldSession,workerId:role.workerId});
   for(let i=0;i<200&&!probe.events.some(item=>item.runId===probe.current&&item.type==='stale-probe-complete');i++)await new Promise(resolve=>setTimeout(resolve,10));
   return probe.events.some(item=>item.runId===probe.current&&item.type==='stale-probe-complete')&&!probe.events.some(item=>item.type==='stale-must-not-arrive');
  },previousSessionId);
  if(!recoveredStaleRejected)throw Error('E_WORKER_RESTART_STALE_MESSAGE');
  result.afterForcedRestart=await step(frame.evaluate(()=>stopProbe('clean')),'restart cooperative cleanup');
  await page.waitForTimeout(200);
  const recoveryAudio=await frame.evaluate(()=>globalThis.__workerAudioEvidence.map(item=>({state:item.context.state,peak:item.peak,checks:item.checks})));
  if(recoveryAudio.some(item=>item.state!=='closed'))throw Error('E_WORKER_RESTART_AUDIO_CLEANUP');
  result.afterForcedRestartDocument={documentId:recovered.documentId,staleSessionRejected:recoveredStaleRejected,staleSessionId:previousSessionId,staleSessionSource:'forced-retired-browser-session',audio:recoveryAudio,browserWorkers:await retirePreview(recovered)};
  result.documentCount=documentIds.size;result.finalErrors=allErrors;
  if(result.documentCount!==Number(loops)+1)throw Error('E_WORKER_DOCUMENT_COUNT');
  if(!cleanupComplete(result.afterForcedRestart)||result.finalErrors.length)throw Error('E_WORKER_RESTART_CLEANUP '+JSON.stringify({cleanup:result.afterForcedRestart,errors:result.finalErrors}));
  result.status='passed';
  result.limitations.push('This fixture proves its stated systems; it does not certify all resource importers, IME composition, XR hardware, Safari, or GPU reclamation.');
 }catch(error){result.status='failed';result.error=String(error?.stack??error);throw error;}
 finally {result.finishedAt=new Date().toISOString();result.network={editor:pair.editor.requests,preview:pair.preview.requests};await writeFile(path.join(directory,'worker-integration.json'),JSON.stringify(result,null,2)+'\n');await browser.close();await pair.close();}
 return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const values=parse(process.argv.slice(2));
 runWorkerIntegration({engineReport:values['engine-report'],out:values.out,loops:values.loops??3,browserName:values.browser??'chromium',...(values.verbose?{verbose:true}:{}),...(values['active-audio-at-quit']?{stopAudioBeforeQuit:false}:{}),...(values['stop-audio-before-quit']?{stopAudioBeforeQuit:true}:{})}).then(result=>console.log(JSON.stringify({status:result.status,cases:result.cases.length}))).catch(error=>{console.error(error);process.exitCode=1;});
}
