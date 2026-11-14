import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// These tests execute the production host, lease, ledger, audio host and render
// queue. Browser I/O edges are doubles; no GPU or browser compatibility claim.
const directory=fileURLToPath(new URL('../',import.meta.url));
const replacements={
 'verified-loader.js':'export function fetchVerifiedAsset(...args){return globalThis.__fetchAsset(...args)};export function loadVerifiedRuntimeWorker(...args){return globalThis.__loadRuntime(...args)}',
 'worker-presentation.js':'export function createPresentationHost(...args){return globalThis.__presentation(...args)}',
 'worker-dom-host.js':'export function createInputHost(...args){return globalThis.__input(...args)}',
 'worker-browser.js':'export function createWorkerBrowserHost(...args){return globalThis.__browser(...args)}',
};
const code=(await build({stdin:{contents:'export {startWorkerPreviewHost} from "./src/worker-host.ts";export {prepareWorkerRunConfiguration} from "./src/worker-protocol.ts";export {WorkerAudioRenderQueue} from "./src/worker-audio-worklet.ts";',resolveDir:directory},
 bundle:true,write:false,format:'iife',globalName:'WorkerHostUnderTest',platform:'browser',target:'es2022',plugins:[{name:'host-io-edges',setup(builder){
 builder.onResolve({filter:/(verified-loader|worker-presentation|worker-dom-host|worker-browser)\.js$/},args=>({path:args.path.split('/').at(-1),namespace:'test-host'}));
 builder.onLoad({filter:/.*/,namespace:'test-host'},args=>({contents:replacements[args.path],loader:'js'}));
 }}]})).outputFiles[0].text;
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const flush=async()=>{for(let index=0;index<24;index++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<deadline,'host preparation did not settle');await flush();await new Promise(resolve=>setTimeout(resolve,1));}}

function ports(){
 const left={onmessage:null,sent:[],closed:false},right={onmessage:null,sent:[],closed:false};
 for(const [port,peer]of [[left,right],[right,left]])Object.assign(port,{peer,start(){},close(){this.closed=true;},postMessage(value){
  this.sent.push(value);queueMicrotask(()=>{if(!peer.closed)peer.onmessage?.({data:value});});
 }});
 return {port1:left,port2:right};
}
class FakeNode {
 constructor(){this.connections=[];this.gain={value:1,setValueAtTime:value=>{this.gain.value=value;}};}
 connect(node){this.connections.push(node);return node;}
 disconnect(){this.connections=[];}
}

async function fixture({fetchAsset,loadRuntime,moduleReady,closeReady,inputReady,ackAudio=true,verifyRelease,budgets={}}={}){
 let now=0,timerId=0,api,connect;const timers=new Map(),listeners=new Map(),channels=[],contexts=[],worklets=[],snapshots=[],createdUrls=[],revokedUrls=[];
 const counters={runtimeLoads:0,fetches:0,workerPosts:[],terminations:0,runtimeDisposals:0,presentationConsumes:0,presentationDisposals:0,presentationCheckpoints:[],inputCommands:0,inputDisposals:0,browserDisposals:0};
 const addTimer=(callback,delay,interval)=>{const id=++timerId;timers.set(id,{callback,due:now+Math.max(0,Number(delay)||0),interval});return id;};
 const editor={onmessage:null,sent:[],closed:false,start(){},close(){this.closed=true;},postMessage(message){this.sent.push(message);}};
 let inputOptions,presentationOptions;
 class Context {
  constructor(options){this.sampleRate=options.sampleRate||48000;this.state='suspended';this.currentTime=0;this.destination=new FakeNode();this.destination.channelCount=2;
   this.audioWorklet={addModule:()=>moduleReady??Promise.resolve()};this.closeCalls=0;contexts.push(this);}
  createGain(){return new FakeNode();}
  async resume(){this.state='running';this.onstatechange?.();}
  async close(){this.closeCalls++;if(closeReady)await closeReady;this.state='closed';this.onstatechange?.();}
 }
 class Worklet extends FakeNode {
  constructor(_context,name){super();this.name=name;const pair=ports();this.port=pair.port1;this.processor=pair.port2;worklets.push(this);
   this.processor.onmessage=({data})=>{
    if(data.type==='attach'){
     this.identity={runId:data.runId,audioEpoch:data.audioEpoch};this.direct=data.port;
     this.queue=new api.WorkerAudioRenderQueue(this.identity,data.channels,data.maxFrames,data.maxBlocks,(message)=>this.direct.postMessage(message));
     this.direct.onmessage=({data:message})=>{if(message.type==='block')this.queue.accept(message);if(message.type==='producer-stopped'){this.producerStopped=true;this.finish();}};
     this.processor.postMessage({...this.identity,type:'attached'});
    }else if(data.type==='flush'){
     if(name==='godot-worker-meter')this.processor.postMessage({...connect,type:'meter-flushed',audioEpoch:1});
     else{this.flushing=true;this.queue?.flush();this.finish();}
    }
   };
  }
  finish(){if(this.flushing&&this.producerStopped&&!this.flushed){this.flushed=true;this.direct.postMessage({...this.identity,type:'pcm-flushed'});this.processor.postMessage({...this.identity,type:'flushed'});}}
 }
 const runtime={worker:{terminate(){counters.terminations++;},postMessage(message){
  counters.workerPosts.push(message);connect=message;
  message.audioCommandPort.onmessage=({data})=>{if(data.type==='stop'&&ackAudio){message.audioCommandPort.postMessage({runId:message.runId,audioEpoch:1,type:'worker-stopped'});message.audioPcmPort.postMessage({runId:message.runId,audioEpoch:1,type:'producer-stopped'});}};
  message.audioPcmPort.onmessage=({data})=>{if(data.type==='pcm-flushed'&&ackAudio)message.audioCommandPort.postMessage({runId:message.runId,audioEpoch:1,type:'pcm-flushed',outstandingLoans:0});};
 }},dispose(){counters.runtimeDisposals++;this.worker.terminate();}};
 class TestURL extends URL {static createObjectURL(){const value=`blob:host-test-${createdUrls.length}`;createdUrls.push(value);return value;}static revokeObjectURL(value){revokedUrls.push(value);}}
 const sandbox={console,URL:TestURL,Blob,ArrayBuffer,Uint8Array,Float32Array,TextEncoder,crypto,AbortController,DOMException,queueMicrotask,AudioContext:Context,AudioWorkletNode:Worklet,
  performance:{now:()=>now},devicePixelRatio:1,location:{href:'https://preview.test/app/preview.html?run=1'},document:{hidden:false},navigator:{},
  MessageChannel:class{constructor(){const pair=ports();channels.push(pair);return pair;}},
  ResizeObserver:class{observe(){}disconnect(){}},
  setTimeout:(callback,delay)=>addTimer(callback,delay),clearTimeout:id=>timers.delete(id),
  setInterval:(callback,delay)=>addTimer(callback,delay,delay),clearInterval:id=>timers.delete(id),
  addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},removeEventListener(name,callback){listeners.get(name)?.delete(callback);},
  __fetchAsset(...args){counters.fetches++;return fetchAsset?fetchAsset(...args):Promise.resolve(new Uint8Array([1,2,3]));},
  __loadRuntime(...args){counters.runtimeLoads++;return loadRuntime?loadRuntime(runtime,...args):Promise.resolve(runtime);},
  __presentation(options){presentationOptions=options;return{offscreen:{},resize(){},observeWorkerCheckpoint(value,sequence){counters.presentationCheckpoints.push({value,sequence});},consume(){counters.presentationConsumes++;},dispose(){counters.presentationDisposals++;}};},
  __input(options){inputOptions=options;return{resize(){},command(){counters.inputCommands++;return true;},dispose(){counters.inputDisposals++;return inputReady;}};},
  __browser(){return{dispose(){counters.browserDisposals++;}};},
 };
 const context=vm.createContext(sandbox);vm.runInContext(code,context);api=context.WorkerHostUnderTest;
 const clone=value=>{context.__json=JSON.stringify(value);return vm.runInContext('JSON.parse(__json)',context);};
 const wrap=vm.runInContext('(identity,fields)=>({...identity,protocolVersion:2,...fields})',context);
 const prepared=await api.prepareWorkerRunConfiguration(clone({budgets:{hostSetupTimeoutMs:80,cleanupTimeoutMs:20,...budgets}}));
 const identity=clone({runId:'host-run',revision:1,generation:1,buildKey:'host-build',documentId:'host-document',workerId:'host-worker',runConfigurationHash:prepared.hash});
 const host=api.startWorkerPreviewHost(identity,editor,{canvas:{getBoundingClientRect:()=>({width:320,height:200,left:0,top:0})},verifyRelease,onSnapshot:snapshot=>snapshots.push(snapshot)});
 const envelope=fields=>wrap(identity,fields);
 const run=()=>editor.onmessage?.({data:envelope({type:'run',configuration:prepared.configuration,stopTimeoutMs:30,cleanupTimeoutMs:20,
  release:clone({runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1},runtimeWorker:{},runtimeAudioWorklet:{}}),artifact:{pack:new Uint8Array([1]),manifest:{generation:1}}})});
 async function advance(ms){const target=now+ms;await flush();for(;;){const next=[...timers].filter(([,timer])=>timer.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!next)break;
   const [id,timer]=next;now=timer.due;if(timer.interval)timer.due+=timer.interval;else timers.delete(id);timer.callback();await flush();}now=target;await flush();}
 return {host,editor,identity,counters,channels,contexts,worklets,snapshots,createdUrls,revokedUrls,timers,run,advance,flush,runtime,envelope,clone,makeError:message=>vm.runInContext('new Error('+JSON.stringify(message)+')',context),
  get connect(){return connect;},get inputOptions(){return inputOptions;},get presentationOptions(){return presentationOptions;},get receipt(){return editor.sent.find(message=>message.type==='exit-report');},
  sendControl(fields){connect.controlPort.postMessage(envelope(fields));},sendData(fields){connect.dataPort.postMessage(envelope(fields));},
  sendAudio(fields){connect.audioCommandPort.postMessage({runId:identity.runId,audioEpoch:1,...fields});},
  event(name){for(const callback of [...listeners.get(name)??[]])callback();},
  async ready(){run();await until(()=>connect||editor.sent.some(message=>message.type==='exit-report'));assert.ok(connect,'host should have connected a Worker');},
  async cleanup(){host.stop();await advance(200);for(const timer of timers.values())if(!timer.interval)timer.callback();timers.clear();await flush();},
 };
}

test('Host accepts presentation checkpoints only from matching outstanding geometry or bitmap receipts',async()=>{
 const f=await fixture();try{
  await f.ready();f.event('resize');await f.flush();const outgoing=f.connect.dataPort.peer.sent.find(m=>m.type==='geometry');assert(outgoing);
  const state={geometryEpoch:outgoing.geometry.epoch,outstanding:null},receipt={type:'data-receipt',dataSequence:outgoing.dataSequence,presentationCheckpoint:state};
  f.sendData({...receipt,dataSequence:99999});f.sendData({...receipt,runId:'old-run'});await f.flush();assert.equal(f.counters.presentationCheckpoints.length,0);
  f.sendData(receipt);await f.flush();assert.equal(f.counters.presentationCheckpoints.length,1);f.sendData(receipt);await f.flush();assert.equal(f.counters.presentationCheckpoints.length,1);
  f.inputOptions.sendState({visible:true});await f.flush();const ordinary=f.connect.dataPort.peer.sent.find(m=>m.type==='host-state');f.sendData({...receipt,dataSequence:ordinary.dataSequence});await f.flush();assert.equal(f.counters.presentationCheckpoints.length,1);
  f.presentationOptions.sendAck({type:'present-ack',runId:f.identity.runId,frameId:1,resizeEpoch:0});await f.flush();const ack=f.connect.dataPort.peer.sent.find(m=>m.type==='present-ack');f.sendData({...receipt,dataSequence:ack.dataSequence});await f.flush();assert.equal(f.counters.presentationCheckpoints.length,2);
 }finally{await f.cleanup();}
});

test('Host forwards project commands only within its own credits and waits for Worker consumption',async()=>{
 const f=await fixture({budgets:{maxProjectEvents:2,maxProjectBytes:128}});
 try{
  await f.ready();f.sendControl({type:'phase',phase:'running'});await f.flush();const data=f.clone({type:'knob',value:'x'.repeat(32)});
  const send=seq=>f.editor.onmessage({data:f.envelope({type:'project-command',commandSequence:seq,data})});
  send(1);send(2);await f.flush();assert.deepEqual({...f.host.snapshot.projectCommands},{pending:2,bytes:116});
  assert.equal(f.editor.sent.some(m=>m.type==='project-command-receipt'),false,'mere forwarding is not consumption');
  f.sendControl({type:'project-command-receipt',commandSequence:2});await f.flush();assert.equal(f.host.snapshot.projectCommands?.pending??1,1);
  assert.equal(f.editor.sent.filter(m=>m.type==='project-command-receipt').length,1);
  f.sendControl({type:'project-command-receipt',commandSequence:2});await f.flush();assert.equal(f.editor.sent.filter(m=>m.type==='project-command-receipt').length,1);
  send(3);send(4);await f.flush();assert.equal(f.host.snapshot.closing,true,'direct port bypass cannot exceed Host queue budget');
 }finally{await f.cleanup();}
});

test('Native zero waits for DOM/device cleanup and bounds a stalled operation without fabricating success',async()=>{
 const closing=deferred(),f=await fixture({inputReady:closing.promise});
 try{
  await f.ready();f.sendControl({type:'native-exit',code:0});await f.flush();assert.equal(f.receipt,undefined);assert.equal(f.counters.inputDisposals,1);
  await f.advance(20);assert.equal(f.receipt.engineOutcome.kind,'native-exit');assert.equal(f.receipt.engineOutcome.code,0);assert.equal(f.receipt.hostCleanup.status,'timed-out');
  closing.resolve();await f.flush();assert.equal(f.editor.sent.filter(m=>m.type==='exit-report').length,1);assert.equal(f.counters.inputDisposals,1);
 }finally{closing.resolve();await f.cleanup();}
});
test('DOM/device cleanup rejection remains failed instead of complete after Native zero',async()=>{
 const closing=deferred(),f=await fixture({inputReady:closing.promise});
 try{
  await f.ready();f.sendControl({type:'native-exit',code:0});await f.flush();closing.reject(f.makeError('MIDI close failed'));await f.flush();
  assert.equal(f.receipt.engineOutcome.code,0);assert.equal(f.receipt.hostCleanup.status,'failed');assert.match(f.receipt.hostCleanup.detail,/MIDI close failed/);
 }finally{closing.resolve();await f.cleanup();}
});

test('cancelled worklet download cannot create a Blob URL or Worker after resolving late',async()=>{
 const pending=deferred(),f=await fixture({fetchAsset:()=>pending.promise});
 try{f.run();await until(()=>f.counters.fetches);assert.equal(f.counters.fetches,1);
  f.host.stop();await flush();pending.resolve(new Uint8Array([9]));await flush();
  assert.equal(f.counters.runtimeLoads,0);assert.equal(f.createdUrls.length,0);assert.equal(f.receipt.engineOutcome.kind,'startup-failed');
  assert.equal(Object.hasOwn(f.receipt,'code'),false);assert.equal(f.editor.sent.filter(message=>message.type==='exit-report').length,1);
 }finally{await f.cleanup();}
});

test('a Worker loader resolving after stop disposes its result and verified worklet URL once',async()=>{
 const pending=deferred(),f=await fixture({loadRuntime:()=>pending.promise});
 try{f.run();await until(()=>f.counters.runtimeLoads);assert.equal(f.createdUrls.length,1);
  f.host.stop();await flush();pending.resolve(f.runtime);await flush();
  assert.equal(f.counters.runtimeDisposals,1);assert.equal(f.counters.terminations,1);assert.equal(f.counters.workerPosts.length,0);
  assert.deepEqual(f.revokedUrls,f.createdUrls);assert.equal(f.receipt.engineOutcome.kind,'startup-failed');assert.equal(f.host.snapshot.closing,true);
 }finally{await f.cleanup();}
});

test('cancellation during release verification aborts it and fences every later acquisition',async()=>{
 const verified=deferred();let signal,entered=false;const f=await fixture({verifyRelease:(_release,_manifest,value)=>{signal=value;entered=true;return verified.promise;}});
 try{f.run();await until(()=>entered);assert.equal(entered,true);
  f.host.stop();assert.equal(signal.aborted,true);verified.resolve();await flush();
  assert.equal(f.counters.fetches,0);assert.equal(f.counters.runtimeLoads,0);assert.equal(f.createdUrls.length,0);
  assert.equal(f.receipt.engineOutcome.kind,'startup-failed');assert.equal(f.receipt.hostCleanup.status,'complete');
 }finally{verified.resolve();await f.cleanup();}
});

test('host hard termination deadline operates while Worker control and audio ports are silent',async()=>{
 const closing=deferred(),f=await fixture({ackAudio:false,closeReady:closing.promise});
 try{await f.ready();f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});await flush();assert.equal(f.contexts.length,1);
  f.host.stop();assert.equal(f.counters.terminations,0);await f.advance(29);assert.equal(f.counters.terminations,0);
  await f.advance(1);assert.ok(f.counters.terminations>=1);assert.equal(f.receipt,undefined,'cleanup still owns its independent deadline');
  await f.advance(20);assert.equal(f.receipt.engineOutcome.kind,'terminate-issued');assert.equal(f.receipt.hostCleanup.status,'timed-out');
  assert.equal(f.receipt.reason,'forced-worker-termination');assert.equal(Object.hasOwn(f.receipt,'code'),false);assert.deepEqual(f.revokedUrls,f.createdUrls);
 }finally{closing.resolve();await f.cleanup();}
});

test('native zero keeps its outcome while stalled AudioContext close produces a bounded cleanup receipt',async()=>{
 const closing=deferred(),f=await fixture({closeReady:closing.promise});
 try{await f.ready();f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});await flush();assert.equal(f.contexts.length,1);
  f.sendControl({type:'native-exit',code:0});await flush();assert.equal(f.receipt,undefined);await f.advance(20);
  assert.equal(f.receipt.engineOutcome.kind,'native-exit');assert.equal(f.receipt.engineOutcome.code,0);assert.equal(f.receipt.hostCleanup.status,'timed-out');
  assert.notEqual(f.receipt.reason,'clean-exit');assert.equal(f.channels.every(channel=>channel.port1.closed),true);assert.deepEqual(f.revokedUrls,f.createdUrls);
  closing.resolve();await flush();assert.equal(f.editor.sent.filter(message=>message.type==='exit-report').length,1);assert.equal(f.contexts[0].state,'closed');
 }finally{closing.resolve();await f.cleanup();}
});

test('genuine native zero plus complete cleanup emits one clean receipt and releases host resources',async()=>{
 const f=await fixture();
 try{await f.ready();f.sendControl({type:'native-exit',code:0});f.sendControl({type:'native-exit',code:9});await flush();
  assert.equal(f.receipt.reason,'clean-exit');assert.equal(f.receipt.code,0);assert.equal(f.receipt.engineOutcome.kind,'native-exit');assert.equal(f.receipt.hostCleanup.status,'complete');
  assert.equal(f.counters.runtimeDisposals,1);assert.equal(f.editor.sent.filter(message=>message.type==='exit-report').length,1);
  assert.equal(f.channels.every(channel=>channel.port1.closed),true);assert.deepEqual(f.revokedUrls,f.createdUrls);assert.equal(f.timers.size,0);
 }finally{await f.cleanup();}
});

for(const kind of ['error','messageerror'])test(`Worker ${kind} during shutdown cannot be reported as clean native zero`,async()=>{
 const f=await fixture();
 try{
  await f.ready();f.host.stop();
  if(kind==='error')f.runtime.worker.onerror({preventDefault(){},message:'Worker shutdown exploded'});
  else f.runtime.worker.onmessageerror();
  f.sendControl({type:'native-exit',code:0});await flush();
  assert.equal(f.receipt.reason,'crashed');assert.equal(f.receipt.code,0);
  assert.equal(f.receipt.hostCleanup.status,'complete');assert.ok(f.receipt.diagnostic);
  assert.equal(f.host.snapshot.workerErrors.length,1);
 }finally{await f.cleanup();}
});

test('secondary shutdown errors retain the first Worker fault and its stack',async()=>{
 const f=await fixture();
 try{
  await f.ready();f.sendControl({type:'worker-fatal',diagnostic:{source:'browser',message:'E_WORKER_WEBGL_CONTEXT_LOST',stack:'Error: E_WORKER_WEBGL_CONTEXT_LOST\n    at actualCanvasEvent'},detail:'E_WORKER_WEBGL_CONTEXT_LOST'});await flush();
  f.runtime.worker.onerror({preventDefault(){},message:'Secondary native shutdown alert'});
  f.sendControl({type:'native-exit',code:0});await flush();
  assert.equal(f.receipt.reason,'crashed');assert.equal(f.receipt.code,0);
  assert.equal(f.receipt.diagnostic.message,'E_WORKER_WEBGL_CONTEXT_LOST');
  assert.match(f.receipt.diagnostic.stack,/actualCanvasEvent/);
  assert.equal(f.host.snapshot.workerErrors.length,2);
 }finally{await f.cleanup();}
});

test('closing fences queued presentation, input callbacks, host commands and project data',async()=>{
 const f=await fixture();let bitmapClosed=0;
 try{await f.ready();const queued=f.connect.dataPort.peer.onmessage;
  f.sendControl({type:'phase',phase:'running'});await flush();f.host.stop();
  queued({data:f.envelope({type:'present-frame',bitmap:{close(){bitmapClosed++;}}})});
  f.sendData({type:'host-command',command:{type:'dom-command',kind:'focus'}});
  f.inputOptions.sendInput({type:'pointer'});f.inputOptions.sendState({visible:true});f.presentationOptions.sendAck({type:'frame-ack'});
  f.sendControl({type:'project',data:{type:'stats',frames:99}});f.sendControl({type:'phase',phase:'running'});await flush();
  assert.equal(bitmapClosed,1);assert.equal(f.counters.presentationConsumes,0);assert.equal(f.counters.inputCommands,0);
  assert.equal(f.connect.dataPort.peer.sent.filter(message=>['input','host-state','frame-ack'].includes(message.type)).length,1,'only initial host-state precedes cancellation');
  assert.equal(f.editor.sent.filter(message=>message.type==='project').length,0);assert.equal(f.host.snapshot.closing,true);
  await f.advance(50);assert.equal(f.editor.sent.filter(message=>message.type==='exit-report').length,1);
 }finally{await f.cleanup();}
});

test('late worklet module completion and audio prepare cannot construct a second context after stop',async()=>{
 const loading=deferred(),f=await fixture({moduleReady:loading.promise});
 try{await f.ready();f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});await flush();assert.equal(f.contexts.length,1);
  f.host.stop();f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});loading.resolve();await flush();
  assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].state,'closed');assert.equal(f.worklets.length,0);
  await f.advance(50);assert.equal(f.editor.sent.filter(message=>message.type==='exit-report').length,1);
 }finally{loading.resolve();await f.cleanup();}
});

test('independent late PCM cannot refill a flushed renderer or reopen stopped audio',async()=>{
 const f=await fixture();
 try{await f.ready();f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});await flush();
  const stream=f.worklets.find(node=>node.name==='godot-worker-audio');assert.ok(stream);
  f.host.stop();await flush();assert.equal(stream.flushed,true);
  f.connect.audioPcmPort.postMessage({runId:f.identity.runId,audioEpoch:1,type:'block',blockId:1,blockSeq:1,frames:2,channels:2,format:'f32-interleaved',buffer:new Float32Array([1,1,1,1]).buffer});
  f.sendAudio({type:'command',seq:1,operation:'resume'});f.sendAudio({type:'prepare',preferences:{mixRate:48000,latencyMs:50,driver:'AudioWorklet'}});await flush();
  const output=[new Float32Array(2).fill(9),new Float32Array(2).fill(9)];stream.queue.render(output);
  assert.deepEqual([...output[0]],[0,0]);assert.equal(stream.queue.queuedBlocks,0);assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].state,'suspended');
  await f.advance(50);assert.equal(f.receipt.engineOutcome.kind,'terminate-issued');assert.equal(f.contexts[0].state,'closed');
 }finally{await f.cleanup();}
});

test('Host forwards its actual HTTP document URL into the verified Blob Worker boot',async()=>{
 const f=await fixture();try{f.run();await until(()=>f.connect);assert.equal(f.connect.documentUrl,'https://preview.test/app/preview.html?run=1');}finally{await f.cleanup();}
});
