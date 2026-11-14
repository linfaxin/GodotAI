#!/usr/bin/env node
/** Full native Godot Worker microphone path through the frozen production workbench. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { launchBrowser, withAcceptanceContext, observedWorkerSessions, browserLaunchEvidence, installPassiveRecorder } from '../../apps/playground/scripts/browser-harness.mjs';
import { createStaticServer } from '../../apps/playground/scripts/serve.mjs';

const directory = resolve(process.env.WORKER_MICROPHONE_SITE ?? fileURLToPath(new URL('../../work/worker-migration/site-full-debug/', import.meta.url)));
const output = resolve(process.env.WORKER_MICROPHONE_REPORT_DIR ?? fileURLToPath(new URL('../../work/worker-validation/microphone/', import.meta.url)));
const timeout = Number(process.env.WORKER_MICROPHONE_TIMEOUT ?? 120000);
const deniedMode = process.env.WORKER_MICROPHONE_CASE === 'denied';
const defaultBrowserSettings = process.env.PLAYGROUND_BROWSER_DEFAULT_SETTINGS === '1';
const requestedMixRate=process.env.WORKER_MICROPHONE_MIX_RATE?Number(process.env.WORKER_MICROPHONE_MIX_RATE):undefined,requestedLatencyMs=process.env.WORKER_MICROPHONE_LATENCY_MS?Number(process.env.WORKER_MICROPHONE_LATENCY_MS):undefined;
for(const value of [requestedMixRate,requestedLatencyMs])if(value!==undefined)assert(Number.isSafeInteger(value)&&value>0);
const explicitAudioSettings=(requestedMixRate===undefined?'':`driver/mix_rate=${requestedMixRate}\ndriver/mix_rate.web=${requestedMixRate}\n`)+(requestedLatencyMs===undefined?'':`driver/output_latency=${requestedLatencyMs}\ndriver/output_latency.web=${requestedLatencyMs}\n`);
const steadyWindow = process.env.WORKER_MICROPHONE_SOAK !== '0';
async function cpuEvidence(){const paths=['/proc/stat','/proc/loadavg','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/cpu.stat','/sys/fs/cgroup/cpu.pressure','/sys/fs/cgroup/memory.current'];const files=Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(path,'utf8').catch(error=>String(error))])));return{timestamp:new Date().toISOString(),availableParallelism:availableParallelism(),logicalCpus:cpus().length,loadAverage:loadavg(),files};}
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.runtime.executionBackend, 'worker');
const project = { schemaVersion: 3, engineProfile: manifest.runtimeProfile, runtime: 'godot', demoId: 'native', entry: '/src/Main.ts', selected: '/src/Main.ts', mode: 'production', controls: {}, files: {
 '/project.godot': 'config_version=5\n[application]\nconfig/name="Native Worker microphone acceptance"\nrun/main_scene="res://main.tscn"\n[audio]\ndriver/enable_input=true\ngeneral/default_playback_type=0\ngeneral/default_playback_type.web=0\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'.replace('driver/enable_input=true\n','driver/enable_input=true\n'+explicitAudioSettings),
 '/main.tscn': '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n',
 '/src/Main.ts': `import {Node,AudioStreamMicrophone,AudioStreamPlayer,print} from "godot";
export default class Main extends Node {
 player!:AudioStreamPlayer;
 _ready(){
  this.player=new AudioStreamPlayer();this.player.stream=new AudioStreamMicrophone();this.player.playback_type=1;
  this.add_child(this.player);this.player.play();
  const playback=this.player.get_stream_playback();if(!playback)throw Error("Microphone has no native playback");
  print("FULL_ENGINE_MICROPHONE_NATIVE_READY "+playback.get_class());
 }
}
`
}};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const events = [], errors = [], warnings = [], logs = [];
let browser, context, page;
const editor = createStaticServer(directory), preview = createStaticServer(directory);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) { const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await pause(50);}throw Error(message); }
const report = { kind: 'full-native-godot-worker-microphone', case: deniedMode ? 'permission-denied' : 'virtual-device-playback', status: 'failed', scope: 'Frozen Schema 3 full-engine site; production workbench imports a native AudioStreamMicrophone -> AudioStreamPlayer stream project; Chromium virtual media device only.', createdAt: new Date().toISOString(), directory, projectSha256: sha(JSON.stringify(project)), project, environment: { mediaSource: 'Chromium virtual fake media device; no real user microphone is requested', settingsTier: 'environment-override', flags: ['--use-fake-device-for-media-stream', deniedMode ? '--use-fake-ui-for-media-stream=deny' : '--use-fake-ui-for-media-stream', ...(defaultBrowserSettings ? [] : ['--autoplay-policy=no-user-gesture-required'])] }, checks: [], events, errors, warnings, logs };
async function captureLogs(phase) {
 const lines = await page.locator('#logs .log-line').evaluateAll(nodes => nodes.map(node => ({ level: node.classList.contains('error') ? 'error' : node.classList.contains('warn') ? 'warn' : 'log', text: node.textContent })));
 logs.push({phase,lines});
 for(const line of lines)if(line.level==='error'||/(?:^|\n)\s*(?:ERROR:|SCRIPT ERROR:)/.test(line.text))errors.push({kind:'native-runner',phase,...line});
 return lines;
}
async function nativeAudioEvidence() {
 for(const worker of page.workers()){
  try{const native=await worker.evaluate(()=>{const audio=globalThis.__godotWorkerAudio;if(!audio?.stream)return null;const loans=Array.from(audio.loans.values()).map(loan=>({bytes:loan.bytes,samples:loan.samples,ringPosition:loan.ringPosition}));return{inputState:audio.inputState,outSamples:audio.stream.outSamples,inSamples:audio.stream.inSamples,outFrames:audio.stream.outSamples/audio.descriptor.channels,inFrames:audio.stream.inSamples/audio.descriptor.channels,outputLoanFrames:loans.reduce((sum,loan)=>sum+loan.samples,0)/audio.descriptor.channels,loans,descriptor:audio.descriptor};});if(native)return native;}catch{}
 }
 return null;
}
async function running(marker) {
 await page.waitForFunction(marker=>{const state=window.__playgroundWorkbench?.inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.ready&&state.engine?.state==='running'&&(!marker||document.querySelector('#logs').textContent.includes(marker));},marker,{timeout});
 const iframe=await page.locator('#preview iframe').elementHandle(),frame=await iframe.contentFrame();await iframe.dispose();assert(frame);
 const session=await frame.evaluate(()=>{const value=window.__playgroundRuntimeSession;return typeof value==='function'?value():value;});
 assert.equal(session.runtime,'godot');assert(session.workerId);return {session,frame};
}
async function stop(session) {
 await page.locator('#stop').click();
 await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().engine?.state==='exited',null,{timeout});
 await page.locator('#preview iframe').waitFor({state:'detached',timeout});
 const retired=await until(()=>observedWorkerSessions(browser).find(item=>item.documentId===session.documentId&&item.exit),'Native microphone session must publish its real exit and host cleanup');
 assert.equal(retired.exit.engineOutcome.kind,'native-exit');assert.equal(retired.exit.engineOutcome.code,0);assert.equal(retired.exit.hostCleanup.status,'complete');
 return retired;
}
try {
 await mkdir(output,{recursive:true});await Promise.all([listen(editor),listen(preview)]);
 const editorOrigin=`http://127.0.0.1:${editor.address().port}`,previewOrigin=`http://127.0.0.1:${preview.address().port}`;
 report.origins={editor:editorOrigin,preview:previewOrigin};
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',...report.environment.flags]});
 report.browser={name:'chromium',version:browser.version(),...browserLaunchEvidence(browser)};
 context=await browser.newContext({viewport:{width:1280,height:900}});
 await installPassiveRecorder(context,'__recordNativeMicrophone',(_source,event)=>events.push(event));
 await context.addInitScript(()=>{
  if(!location.pathname.endsWith('/preview.html'))return;
  const fallback=crypto.randomUUID(),tracks=[],contexts=[];
  const emit=event=>{const source=window.__playgroundRuntimeSession,session=typeof source==='function'?source():source;void window.__recordNativeMicrophone({documentId:session?.documentId??fallback,time:performance.now(),...event}).catch(()=>{});};
  const nativePost=MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage=function(...args){const value=Reflect.apply(nativePost,this,args);const data=args[0];if(data?.type==='input-status')emit({type:'input-status',state:data.state,inputEpoch:data.inputEpoch,message:data.message??null});return value;};
  const media=navigator.mediaDevices;
  if(media){const get=media.getUserMedia.bind(media);media.getUserMedia=async constraints=>{
   emit({type:'get-user-media-requested',constraints});
   try{const stream=await get(constraints);for(const track of stream.getTracks()){
    tracks.push(track);emit({type:'track-live',id:track.id,kind:track.kind,label:track.label,readyState:track.readyState,settings:track.getSettings()});
    const stop=track.stop.bind(track);track.stop=(...args)=>{const result=stop(...args);emit({type:'track-stopped',id:track.id,readyState:track.readyState});return result;};
   }return stream;}catch(error){emit({type:'get-user-media-rejected',name:error.name,message:error.message});throw error;}
  };}
  window.__nativeMicrophoneTracks=()=>tracks.map(track=>({id:track.id,readyState:track.readyState,kind:track.kind}));
  addEventListener('pointerdown',event=>{if(event.target instanceof HTMLCanvasElement)emit({type:'canvas-unlock-gesture',trusted:event.isTrusted,isActive:navigator.userActivation?.isActive??null,hasBeenActive:navigator.userActivation?.hasBeenActive??null,contextStates:contexts.map(ctx=>ctx.state)});},{capture:true});
  window.__nativeMicrophoneContexts=()=>contexts.map(ctx=>({sampleRate:ctx.sampleRate,state:ctx.state,baseLatency:ctx.baseLatency,outputLatency:ctx.outputLatency}));
  const Native=window.AudioContext;
  window.AudioContext=new Proxy(Native,{construct(target,args,newTarget){const ctx=Reflect.construct(target,args,newTarget);contexts.push(ctx);emit({type:'context-created',sampleRate:ctx.sampleRate,state:ctx.state});const close=ctx.close.bind(ctx);ctx.close=async(...parameters)=>{const result=await close(...parameters);emit({type:'context-closed',state:ctx.state});return result;};return ctx;}});
 });
 page=await context.newPage();page.on('pageerror',error=>errors.push({kind:'pageerror',message:error.message}));page.on('console',message=>{if(message.type()==='error')errors.push({kind:'console',message:message.text()});else if(message.type()==='warning')warnings.push({kind:'console',message:message.text()});});
 await page.goto(`${editorOrigin}/?previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});
 const initial=await running();await stop(initial.session);await captureLogs('default-project-stopped');
 await page.locator('#import').setInputFiles({name:'native-microphone.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 const active=await running('FULL_ENGINE_MICROPHONE_NATIVE_READY');report.activeSession=active.session;
 // A real trusted preview gesture is the product's audio unlock path; observer calls are not evidence.
 await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:8,y:8}});
 report.unlockGesture=await until(()=>events.find(event=>event.documentId===active.session.documentId&&event.type==='canvas-unlock-gesture'&&event.trusted===true&&event.isActive===true),'The microphone run must receive a real trusted canvas gesture');
 const allow=await page.locator('#preview iframe').getAttribute('allow');assert(allow.split(';').map(item=>item.trim()).includes('microphone'));report.iframeAllow=allow;
 if(deniedMode) {
  await until(()=>events.some(event=>event.documentId===active.session.documentId&&event.type==='input-status'&&event.state==='denied'),'A real browser permission rejection must reach AudioHost input-status');
  await until(async()=>{const snapshot=await active.frame.evaluate(()=>{const value=window.__playgroundRuntimeSession;return typeof value==='function'?value():value;});return snapshot.audio.outputChecks>0;},'The rejected microphone project must remain alive and render its silent output');
  report.microphoneEvents=events.filter(event=>event.documentId===active.session.documentId);
  assert(report.microphoneEvents.some(event=>event.type==='get-user-media-rejected'&&event.name==='NotAllowedError'));
  assert(!report.microphoneEvents.some(event=>event.type==='track-live'));
  assert(!report.microphoneEvents.some(event=>event.type==='input-status'&&event.state==='active'));
  report.retiredSession=await stop(active.session);await captureLogs('microphone-permission-denied-stopped');
  assert.equal(report.retiredSession.audio.outputPeak,0);assert.equal(report.retiredSession.audio.contextsCreated,1);assert.equal(report.retiredSession.audio.contextsClosed,1);assert.equal(report.retiredSession.audio.liveNodes,0);assert.equal(report.retiredSession.audio.transferredChunksOwned,0);
  assert.deepEqual(errors,[]);
  report.checks.push('The real browser denies virtual-device permission with NotAllowedError; AudioHost reports denied and never claims active capture.');
  report.checks.push('The complete native microphone project remains alive with silent output and exits zero with complete AudioContext cleanup.');
 } else {
 await until(()=>events.some(event=>event.documentId===active.session.documentId&&event.type==='input-status'&&event.state==='active'),'The actual AudioHost must acknowledge active microphone capture');
 const playing=await until(async()=>{const session=await active.frame.evaluate(()=>{const value=window.__playgroundRuntimeSession;return typeof value==='function'?value():value;});return session?.audio?.outputPeak>.001&&session.audio.outputChecks>0?session:undefined;},'Native microphone playback must produce measured master output');
 report.playingSession=playing;
 report.audioContexts=await active.frame.evaluate(()=>window.__nativeMicrophoneContexts());
 report.nativeAudio=await nativeAudioEvidence();
 assert(report.nativeAudio?.outSamples>0,'The report must observe the actual native ABI ring, not infer its size');
 assert.equal(report.nativeAudio.outputLoanFrames,report.nativeAudio.outFrames,'Transport must cover the complete actual native ring');
 if(requestedMixRate!==undefined)assert.equal(report.nativeAudio.descriptor.sampleRate,requestedMixRate);

 if(steadyWindow){
  const warmupMs=2000,requestedWindowMs=5000;
  await pause(warmupMs);
  const sample=()=>active.frame.evaluate(()=>{const value=window.__playgroundRuntimeSession;return typeof value==='function'?value():value;});
  let trace;if(process.env.WORKER_MICROPHONE_TRACE==='1'){trace=await context.newCDPSession(page);await trace.send('Tracing.start',{categories:'toplevel,devtools.timeline,v8',transferMode:'ReturnAsStream'});}
  const cpuBefore=await cpuEvidence(),before=await sample(),nativeBefore=await nativeAudioEvidence(),contextsBefore=await active.frame.evaluate(()=>window.__nativeMicrophoneContexts()),started=performance.now();
  await pause(requestedWindowMs);
  const after=await sample(),elapsedMs=performance.now()-started,cpuAfter=await cpuEvidence(),nativeAfter=await nativeAudioEvidence(),contextsAfter=await active.frame.evaluate(()=>window.__nativeMicrophoneContexts());
  if(trace){const completed=new Promise(resolve=>trace.once('Tracing.tracingComplete',resolve));await trace.send('Tracing.end');const end=await completed;let content='',eof=false;while(!eof){const part=await trace.send('IO.read',{handle:end.stream});content+=part.base64Encoded?Buffer.from(part.data,'base64').toString('utf8'):part.data;eof=part.eof;}await trace.send('IO.close',{handle:end.stream});await writeFile(join(output,'steady-trace.json'),content);report.steadyTrace='steady-trace.json';}
  report.stabilityWindow={scope:'Real native Godot microphone playback, virtual device; no physical sound-quality claim.',warmupMs,requestedWindowMs,elapsedMs,before:before.audio,after:after.audio,nativeBefore,nativeAfter,contextsBefore,contextsAfter,delta:{outputUnderruns:after.audio.outputUnderruns-before.audio.outputUnderruns,inputDroppedFrames:after.audio.inputDroppedFrames-before.audio.inputDroppedFrames,outputChecks:after.audio.outputChecks-before.audio.outputChecks},cpuBefore,cpuAfter};
  assert(report.stabilityWindow.delta.outputChecks>0,'The stable window must include actual master-render quanta');
 }

 report.liveTracks=await active.frame.evaluate(()=>window.__nativeMicrophoneTracks());assert(report.liveTracks.some(track=>track.kind==='audio'&&track.readyState==='live'));
 const ready=await captureLogs('microphone-playing');assert(ready.some(line=>line.text.includes('FULL_ENGINE_MICROPHONE_NATIVE_READY AudioStreamPlaybackMicrophone')));
 report.checks.push('Production compiler and real Worker engine execute native AudioStreamMicrophone with explicit stream playback.');
 report.checks.push('Real getUserMedia resolves a Chromium virtual audio track and AudioHost input-status becomes active.');
 report.checks.push('Native microphone capture returns through the Godot audio mixer to measured master AudioWorklet output.');
 report.retiredSession=await stop(active.session);await captureLogs('microphone-stopped');
 const ownEvents=events.filter(event=>event.documentId===active.session.documentId);report.microphoneEvents=ownEvents;
 assert(ownEvents.some(event=>event.type==='track-stopped'&&event.readyState==='ended'));assert(ownEvents.some(event=>event.type==='input-status'&&event.state==='stopped'));assert(ownEvents.some(event=>event.type==='context-closed'&&event.state==='closed'));
 for(const track of report.liveTracks)assert(ownEvents.some(event=>event.type==='track-stopped'&&event.id===track.id&&event.readyState==='ended'));
 assert.equal(report.retiredSession.audio.contextsCreated,1);assert.equal(report.retiredSession.audio.contextsClosed,1);assert.equal(report.retiredSession.audio.liveNodes,0);assert.equal(report.retiredSession.audio.transferredChunksOwned,0);
 assert.deepEqual(errors,[]);report.checks.push('Native exit is zero, host cleanup completes, every microphone track ends and the AudioContext closes.');
 }
 report.status='passed';
 const accepted=await withAcceptanceContext(report,{directory,browser});Object.assign(report,accepted);
 if(!deniedMode && process.env.WORKER_MICROPHONE_SKIP_DENIAL !== '1') {
  // fake-ui=deny is a separate real-browser policy: the accepting flag overrides CDP permission denial.
  await context.close();await browser.close();context=undefined;browser=undefined;
  const deniedOutput=join(output,'permission-denied');
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,WORKER_MICROPHONE_CASE:'denied',WORKER_MICROPHONE_REPORT_DIR:deniedOutput},stdio:'inherit'});child.once('error',reject);child.once('exit',resolve);});
  report.permissionDenial=JSON.parse(await readFile(join(deniedOutput,'microphone.json'),'utf8'));
  assert.equal(code,0);assert.equal(report.permissionDenial.status,'passed');
  report.checks.push('A second browser with fake-ui=deny independently verifies native permission rejection and zero-exit cleanup.');
 }

} catch(error) {report.error=error.stack??String(error);if(page){try{report.state=await page.evaluate(()=>window.__playgroundWorkbench?.inspect());await captureLogs('failure');}catch{}}process.exitCode=1;}
finally{await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);report.finishedAt=new Date().toISOString();await mkdir(output,{recursive:true});await writeFile(join(output,'microphone.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,case:report.case,checks:report.checks,outputPeak:report.playingSession?.audio?.outputPeak,steadyWindow:report.stabilityWindow?.delta,report:join(output,'microphone.json'),error:report.error},null,2));
