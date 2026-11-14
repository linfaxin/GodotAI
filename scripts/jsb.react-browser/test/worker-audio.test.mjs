import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as NodeWorker, MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { receiveMessageOnPort } from 'node:worker_threads';
import { WorkerAudioBridge } from '../dist/worker-audio.js';
import { WorkerAudioHost } from '../dist/worker-audio-host.js';
import { WorkerAudioRenderQueue, WorkerAudioCapturePool, WorkerAudioPositionCounter } from '../dist/worker-audio-worklet.js';
import { DEFAULT_AUDIO_LIMITS, estimateWorkerAudioPcm } from '../dist/worker-audio-protocol.js';
import {boundedWorkerCleanup} from '../dist/worker-session.js';

const identity = { runId: 'audio-run', audioEpoch: 7 };
const turn = () => new Promise(resolve => setImmediate(resolve));
function ports() {
  const pair = [{ onmessage: null, sent: [], closed: false }, { onmessage: null, sent: [], closed: false }];
  pair.forEach((port, index) => {
    port._mockport = true;
    port.start = () => {};
    port.close = () => { port.closed = true; };
    port.postMessage = (value, transfer = []) => {
      const attachment = value.port?._mockport ? value.port : undefined;
      const copy = structuredClone(attachment ? {...value,port:undefined} : value, { transfer: transfer.filter(item=>item!==attachment) });
      if (attachment) copy.port = attachment; port.sent.push(copy);
      queueMicrotask(() => { if (!pair[1-index].closed) pair[1-index].onmessage?.({ data: copy }); });
    };
  });
  return pair;
}
function preparedBridge(limits = {}) {
  const [host, worker] = ports(), [render, pcm] = ports();
  const bridge = new WorkerAudioBridge(worker, pcm, identity);
  host.onmessage = event => { if (event.data.type === 'prepare') host.postMessage({ ...identity, type: 'prepared', descriptor: { ...identity, kind: 'worklet', driver: 'AudioWorklet', sampleRate: 48000, channels: 2, inputChannels: 2, state: 'suspended', outputLatency: .02, limits: { ...DEFAULT_AUDIO_LIMITS, ...limits } } }); };
  return { bridge, host, worker, render, pcm };
}
async function ready(fixture) { await fixture.bridge.prepare({ mixRate: 48000, latencyMs: 50, driver: 'AudioWorklet' }); }

test('real pending registration buffers remain charged until their unregister ACK',async t=>{
 const control=new MessageChannel(),pcm=new MessageChannel();
 t.after(()=>{for(const port of [control.port1,control.port2,pcm.port1,pcm.port2])port.close();});
 const bridge=new WorkerAudioBridge(control.port1,pcm.port1,identity);
 const preparing=bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});
 const limits={...DEFAULT_AUDIO_LIMITS,sampleBytes:128};
 control.port2.postMessage({...identity,type:'prepared',descriptor:{...identity,kind:'worklet',driver:'AudioWorklet',sampleRate:48000,channels:2,inputChannels:2,state:'running',outputLatency:0,limits}});
 await preparing;
 const nativeData=new Float32Array(8);
 assert(bridge.samplePreflight(4,2));bridge.sampleRegister('s',nativeData,4,'disabled',0,0);bridge.sampleUnregister('s');
 assert.equal(bridge.sampleIsRegistered('s'),false,'Native read-your-writes remains immediate');
 assert.equal(bridge.snapshot().sampleBytes,0);assert.equal(bridge.snapshot().retainedSampleBytes,64);
 assert.equal(bridge.samplePreflight(4,2),false,'an unconsumed old registration still spends physical credit');
 assert.equal(nativeData.buffer.byteLength,32,'the Native input view is never transferred');
 const messages=[];for(let item;item=receiveMessageOnPort(control.port2);)messages.push(item.message);
 assert.equal(messages.filter(m=>m.operation==='register').reduce((sum,m)=>sum+m.buffer.byteLength,0),32);
 const registration=messages.find(m=>m.operation==='register'),retirement=messages.find(m=>m.operation==='unregister');
 const acknowledge=async seq=>{const received=once(control.port1,'message');control.port2.postMessage({...identity,type:'ack',seq});await received;};
 await acknowledge(registration.seq);assert.equal(bridge.snapshot().retainedSampleBytes,32);
 await acknowledge(retirement.seq);assert.equal(bridge.snapshot().retainedSampleBytes,0);assert(bridge.samplePreflight(4,2));
 bridge.sampleRegister('s',nativeData,4,'disabled',0,0);
 await acknowledge(retirement.seq);assert.equal(bridge.snapshot().retainedSampleBytes,64,'a duplicate old ACK cannot spend a new registration');
 bridge.revoke();assert.equal(bridge.samplePreflight(4,2),false);assert.equal(bridge.snapshot().retainedSampleBytes,64,'revocation does not invent a Host release');
 const stopped=once(control.port1,'message');control.port2.postMessage({...identity,type:'stopped'});await stopped;assert.equal(bridge.snapshot().retainedSampleBytes,0);
});

test('multiple retired registrations of the same id keep independent byte and count credits',async()=>{
 const f=preparedBridge({sampleBytes:256,sampleCount:2});await ready(f);
 for(let i=0;i<2;i++){assert(f.bridge.samplePreflight(4,2));f.bridge.sampleRegister('s',new Float32Array(8),4,'disabled',0,0);f.bridge.sampleUnregister('s');}
 assert.equal(f.bridge.snapshot().retainedSampleBytes,128);assert.equal(f.bridge.snapshot().retainedSampleCount,2);assert.equal(f.bridge.samplePreflight(4,2),false);
 const releases=f.worker.sent.filter(m=>m.operation==='unregister');
 f.host.postMessage({...identity,type:'ack',seq:releases[1].seq});await turn();assert.equal(f.bridge.snapshot().retainedSampleBytes,96);
 f.host.postMessage({...identity,type:'ack',seq:releases[1].seq});await turn();assert.equal(f.bridge.snapshot().retainedSampleBytes,96);
 f.host.postMessage({...identity,type:'ack',seq:releases[0].seq});await turn();assert.equal(f.bridge.snapshot().retainedSampleBytes,64);assert.equal(f.bridge.snapshot().retainedSampleCount,0);
 for(const registration of f.worker.sent.filter(m=>m.operation==='register'))f.host.postMessage({...identity,type:'ack',seq:registration.seq});await turn();assert.equal(f.bridge.snapshot().retainedSampleBytes,0);
});
function block(seq, values, extra = {}) { return { ...identity, type: 'block', blockId: seq, blockSeq: seq, frames: values.length/2, channels: 2, format: 'f32-interleaved', buffer: new Float32Array(values).buffer, ...extra }; }

class FakeNode {
  constructor() { this.connections = []; this.gain = { value: 1, setValueAtTime: value => { this.gain.value = value; } }; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
}
class FakeContext {
  constructor(options = {}) { this.options = options; this.sampleRate = options.sampleRate || 44100; this.state = 'suspended'; this.currentTime = 0; this.baseLatency = .01; this.outputLatency = .02; this.destination = new FakeNode(); this.destination.channelCount = 2; this.audioWorklet = { addModule: async () => {} }; this.sources = []; }
  createGain() { return new FakeNode(); }
  createChannelSplitter() { return new FakeNode(); }
  createChannelMerger() { return new FakeNode(); }
  createMediaStreamSource() { return new FakeNode(); }
  createBuffer(channels, frames, sampleRate) { const data = Array.from({length: channels}, () => new Float32Array(frames)); return { length: frames, duration: frames/sampleRate, sampleRate, copyToChannel(input, channel) { data[channel].set(input); }, getChannelData: channel => data[channel] }; }
  createBufferSource() { const source = new FakeNode(); source.playbackRate = { value: 1 }; source.starts = []; source.start = (...args) => { source.starts.push(args); }; source.stop = () => source.onended?.(); this.sources.push(source); return source; }
  async resume() { this.state = 'running'; this.onstatechange?.(); }
  async close() { this.state = 'closed'; this.onstatechange?.(); }
}
function integration(options = {}, externalPorts) {
  const [hostPort, workerPort] = externalPorts?.control ?? ports(), [workletPort, pcmPort] = externalPorts?.pcm ?? ports();
  let context; const processors = []; let stream;
  const host = new WorkerAudioHost(hostPort, workletPort, { ...identity, workletUrl: 'blob:verified-worklet', timeoutMs: 100, ...options,
    createContext: preferences => { context = new FakeContext(preferences); context.destination.channelCount=options.outputChannels??2; return context; },
    createWorklet(_context, name, config) {
      const node = new FakeNode(), [main, processor] = ports(); node.port = main; node.name = name;
      const record = { node, processor }; processors.push(record);
      if (name === 'godot-worker-audio') {
        stream = record;
        processor.onmessage = ({data}) => {
          if (data.type === 'attach') {
            record.direct = data.port;
            record.queue = new WorkerAudioRenderQueue(identity, data.channels, data.maxFrames, data.maxBlocks, (message, transfer) => record.direct.postMessage(message, transfer));
            record.capture = new WorkerAudioCapturePool(identity, data.inputChannels, data.captureBlockFrames, data.maxBlocks, (message, transfer) => record.direct.postMessage(message, transfer));
            record.direct.onmessage = ({data}) => {
              if (data.type === 'stream') assert(record.queue.configureMaximumFrames(data.maxFrames));
              if (data.type === 'block') record.queue.accept(data);
              if (data.type === 'capture-return') record.capture.returned(data);
              if (data.type === 'producer-stopped') record.producerStopped = true;
              finish();
            };
            processor.postMessage({ ...identity, type: 'attached' });
          }
          if (data.type === 'capture-enable') record.capture.enable(data.enabled, data.inputEpoch);
          if (data.type === 'flush') { record.queue.flush(); record.capture.flush(); record.flushing = true; finish(); }
        };
        function finish() {
          if (!record.flushing || !record.producerStopped || record.capture.outstanding || record.done) return;
          record.done = true;
          processor.postMessage({ ...identity, type: 'metrics', outputPeak: 0, outputChecks: 0, transferredChunksOwned: record.queue.queuedBlocks + record.capture.outstanding });
          record.direct.postMessage({ ...identity, type: 'pcm-flushed' }); processor.postMessage({ ...identity, type: 'flushed' });
        }
      } else if (name === 'godot-worker-position') { record.counter=new WorkerAudioPositionCounter();processor.onmessage=({data})=>{const ack=record.counter.configure(data);if(ack){record.generation=ack;processor.postMessage(ack);}};
      } else if (name === 'godot-worker-meter') processor.onmessage = () => { processor.postMessage({ ...identity, type: 'output-metrics', outputPeak: .25, outputChecks: 10 }); processor.postMessage({ ...identity, type: 'meter-flushed' }); };
      return node;
    }
  });
  const bridge = externalPorts ? undefined : new WorkerAudioBridge(workerPort, pcmPort, identity);
  return { host, bridge, workerPort, pcmPort, processors, get context() { return context; }, get stream() { return stream; } };
}

test('native preparation negotiates the actual rate and suspended context, with no synchronous RPC', async () => {
  const f = integration(); assert.equal(f.bridge.available(), true); assert.equal(f.bridge.hasWorklet(), false);
  assert.throws(() => f.bridge.init(48000, 50, () => {}, () => {}), /prepared/);
  const descriptor = await f.bridge.prepare({ mixRate: 48000, latencyMs: 50, driver: 'AudioWorklet' });
  assert.equal(descriptor.sampleRate, 48000); assert.equal(descriptor.state, 'suspended'); assert.equal(f.context.options.latencyHint, undefined, 'Project ring latency must not become an AudioContext device hint');
  let state; assert.deepEqual(f.bridge.init(48000, 50, value => state = value, () => {}), {sampleRate:48000,channels:2}); assert.equal(state, 0);
  assert.throws(() => f.bridge.init(44100,50,()=>{},()=>{}), /differs/);
  await f.host.resumeFromGesture(); await turn(); assert.equal(state, 1);
  await f.host.close(); assert.equal(f.host.snapshot().contextsClosed, 1); assert.equal(f.host.snapshot().liveNodes, 0);
});

test('native ring PCM transfers standalone loans and rejects stale/duplicate tickets', async () => {
  const f = preparedBridge({streamBlocks:2,streamBlockFrames:2}); await ready(f);
  const heap = new Float32Array([1,2,3,4,5,6,7,8]); const calls=[];
  f.bridge.streamStart({outPtr:0,outSamples:8,inPtr:0,inSamples:8,heap:()=>heap,outCallback:(position,samples)=>{ calls.push([position,samples]); heap.fill(.5,position,position+samples); },inCallback:()=>{}});
  await turn(); assert.equal(heap.buffer.byteLength,32); assert.equal(f.pcm.sent.filter(data=>data.type==='block').length,2); assert.equal(f.bridge.snapshot().loans,2);
  const first = f.pcm.sent.find(data=>data.type==='block'); assert.deepEqual([...new Float32Array(first.buffer)], [1,2,3,4]);
  f.render.postMessage({...identity,type:'return',blockId:first.blockId,blockSeq:first.blockSeq+1,buffer:new ArrayBuffer(16)}); await turn(); assert.equal(calls.length,0);
  f.render.postMessage({...first,type:'return'},[first.buffer]); await turn(); assert.deepEqual(calls,[[0,4]]); assert.equal(f.bridge.snapshot().loans,2);
  f.render.postMessage({...identity,audioEpoch:6,type:'return',blockId:first.blockId,blockSeq:first.blockSeq,buffer:new ArrayBuffer(16)}); await turn(); assert.equal(calls.length,1);
});

test('bounded render queue deinterleaves variable render quanta, returns buffers and silences underruns', () => {
  const returned=[]; const queue = new WorkerAudioRenderQueue(identity,2,4,2,(message)=>returned.push(message));
  queue.accept(block(1,[1,2,3,4,5,6])); queue.accept(block(2,[7,8]));
  const left=new Float32Array(3),right=new Float32Array(3); queue.render([left,right]);
  assert.deepEqual([...left],[1,3,5]); assert.deepEqual([...right],[2,4,6]); assert.equal(returned.length,1);
  queue.render([left,right]); assert.deepEqual([...left],[7,0,0]); assert.equal(queue.underruns,1); assert.equal(queue.outputPeak,8);
  queue.flush(); queue.accept(block(3,[9,10])); queue.render([left,right]); assert.deepEqual([...left],[0,0,0]); assert.equal(queue.queuedBlocks,0); assert.equal(returned.length,3);
});

test('sample registry has read-your-writes activity and rejects stale voice epochs', async () => {
  const f=preparedBridge(); await ready(f); const finished=[]; f.bridge.setFinishedCallback(id=>finished.push(id));
  const planar=new Float32Array(16); f.bridge.sampleRegister('sample',planar,8,'disabled',0,0); assert.equal(planar.byteLength,64); assert.equal(f.bridge.sampleIsRegistered('sample'),true);
  f.bridge.sampleStart('voice','sample',0,1,1,new Float32Array(8)); assert.equal(f.bridge.sampleIsActive('voice'),true); assert.equal(f.bridge.samplePosition('voice'),1);
  await turn(); const start=f.worker.sent.find(data=>data.operation==='start');
  f.bridge.sampleStop('voice'); assert.equal(f.bridge.sampleIsActive('voice'),false); assert.deepEqual(finished,['voice']);
  f.bridge.sampleStart('voice','sample',0,2,1,new Float32Array(8));
  f.host.postMessage({...identity,type:'finished',id:'voice',voiceEpoch:start.voiceEpoch}); await turn(); assert.equal(f.bridge.sampleIsActive('voice'),true);
  f.host.postMessage({...identity,type:'position',id:'voice',voiceEpoch:start.voiceEpoch+1,commandSeq:f.worker.sent.filter(data=>data.operation==='start').at(-1).seq,position:2.5}); await turn(); assert.equal(f.bridge.samplePosition('voice'),2.5);
});

test('native decode preflight and per-voice copies have separate enforceable budgets',async()=>{
  const f=preparedBridge({sampleBytes:256,voiceBytes:64,voices:2});await ready(f);
  assert.equal(f.bridge.samplePreflight(8,2),true); assert.equal(f.bridge.samplePreflight(9,2),false);
  f.bridge.sampleRegister('s',new Float32Array(16),8,'disabled',0,0);
  assert.equal(f.bridge.samplePreflight(8,2),false);
  f.bridge.sampleStart('v','s',0,0,1,new Float32Array(8));
  assert.throws(()=>f.bridge.sampleStart('v2','s',0,0,1,new Float32Array(8)),/voice memory budget/);
  f.bridge.sampleStop('v');assert.equal(f.bridge.snapshot().voiceBytes,0);
  f.bridge.sampleUnregister('s');assert.equal(f.bridge.snapshot().sampleBytes,0);
});

test('stop fences both ports before acknowledging a fully returned epoch',async()=>{
  const f=integration({limits:{streamBlocks:2,streamBlockFrames:2}}); await f.bridge.prepare({mixRate:1000,latencyMs:4,driver:'AudioWorklet'});
  const heap=new Float32Array(8).fill(.25);let callbacks=0;
  f.bridge.streamStart({outPtr:0,outSamples:8,inPtr:0,inSamples:8,heap:()=>heap,outCallback:()=>callbacks++,inCallback:()=>{}});
  await turn(); f.stream.queue.render([new Float32Array(2),new Float32Array(2)]);
  // A return and its refill can race the independent main-thread stop command.
  await f.host.stop(); assert.equal(f.bridge.snapshot().loans,0); assert.equal(f.host.snapshot().transferredChunksOwned,0); assert.equal(f.context.state,'suspended');
  assert.equal(f.bridge.snapshot().stopped,true); const atStop=callbacks;await turn();assert.equal(callbacks,atStop);
  await f.host.close();assert.equal(f.host.snapshot().closed,true);assert.equal(f.host.snapshot().contextsCreated,1);assert.equal(f.host.snapshot().contextsClosed,1);
});

test('real asynchronous microphone admission routes pooled PCM into native input ring',async()=>{
  let stopped=0; const statuses=[];
  const f=integration({requestInput:async()=>({getTracks:()=>[{stop:()=>stopped++}]}),onInputStatus:state=>statuses.push(state)});
  await f.bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});const heap=new Float32Array(16384);const captures=[];
  f.bridge.streamStart({outPtr:0,outSamples:8192,inPtr:32768,inSamples:8192,heap:()=>heap,outCallback:()=>{},inCallback:(position,samples)=>captures.push([position,samples])});
  assert.equal(f.bridge.inputStart(),0);assert.equal(f.bridge.inputState,'pending');await turn();assert.equal(f.bridge.inputState,'active');
  const microphoneInput=new Float32Array(512);microphoneInput.set([.1,.2]);f.stream.capture.capture([microphoneInput]);await turn();assert.deepEqual(captures,[[0,1024]]);assert(Math.abs(heap[8192]-.1)<1e-6);assert.equal(f.stream.capture.outstanding,0);
  f.bridge.inputStop();await turn();assert.equal(f.bridge.inputState,'stopped');assert.equal(stopped,1);assert(statuses.includes('active'));
  await f.host.close();
});

test('denied and late microphone permission cannot claim success or resurrect stopped capture',async()=>{
  const denied=integration({requestInput:async()=>{throw new Error('denied');}});await ready(denied);assert.equal(denied.bridge.inputStart(),0);await turn();assert.equal(denied.bridge.inputState,'denied');await denied.host.close();
  let resolveInput,stopped=0;
  const late=integration({requestInput:()=>new Promise(resolve=>{resolveInput=resolve;})});await ready(late);late.bridge.inputStart();await turn();late.bridge.inputStop();await turn();resolveInput({getTracks:()=>[{stop:()=>stopped++}]});await turn();assert.equal(stopped,1);assert.equal(late.bridge.inputState,'stopped');await late.host.close();
});

test('Native context-close ACK completes while full Host cleanup waits for microphone acquisition',async()=>{
 let grant,stopped=0;const permission=new Promise(resolve=>grant=resolve),f=integration({requestInput:()=>permission});await ready(f);f.bridge.inputStart();await turn();
 let finished=false;const closing=f.host.close().then(()=>{finished=true;});await turn();await f.bridge.close();
 assert.equal(f.context.state,'closed');assert.equal(finished,false);assert.equal(f.host.snapshot().closed,false);assert.equal(f.host.snapshot().pendingInputRequests,1);
 grant({getTracks:()=>[{stop(){stopped++;}}]});await closing;assert.equal(stopped,1);assert.equal(f.host.snapshot().closed,true);assert.equal(f.host.snapshot().pendingInputRequests,0);
});
test('one unresolved microphone permission keeps its credit across stop/restart and releases only on settlement',async()=>{
 const grants=[];let stops=0;const f=integration({limits:{pendingCommands:2},requestInput:()=>new Promise(resolve=>grants.push(resolve))});await ready(f);
 for(let i=0;i<16;i++){f.bridge.inputStart();await turn();f.bridge.inputStop();await turn();}
 assert.equal(grants.length,1);assert.equal(f.host.snapshot().pendingInputRequests,1);assert.equal(f.bridge.snapshot().pendingCommands,0);
 grants[0]({getTracks:()=>[{stop(){stops++;}}]});await turn();assert.equal(stops,1);assert.equal(f.host.snapshot().pendingInputRequests,0);
 f.bridge.inputStart();await turn();assert.equal(grants.length,2);const closing=f.host.close();grants[1]({getTracks:()=>[{stop(){stops++;}}]});await closing;assert.equal(stops,2);
});
test('unanswered microphone permission makes bounded cleanup time out and late denial does not reconnect input',async()=>{
 let deny;const permission=new Promise((_resolve,reject)=>deny=reject),f=integration({requestInput:()=>permission});await ready(f);f.bridge.inputStart();await turn();
 const closing=f.host.close();const outcome=await boundedWorkerCleanup(()=>closing,10);assert.equal(outcome.status,'timed-out');assert.equal(f.context.state,'closed');assert.equal(f.host.snapshot().closed,false);
 deny(new DOMException('permission denied','NotAllowedError'));await closing;assert.equal(f.host.snapshot().closed,true);assert.equal(outcome.status,'timed-out');
});
test('late microphone track cleanup failure rejects Host cleanup after the Native context-close ACK',async()=>{
 let grant;const permission=new Promise(resolve=>grant=resolve),f=integration({requestInput:()=>permission});await ready(f);f.bridge.inputStart();await turn();
 const closing=f.host.close(),failed=assert.rejects(closing,/track close failed/);await turn();await f.bridge.close();let secondStopped=0;
 grant({getTracks:()=>[{stop(){throw Error('track close failed');}},{stop(){secondStopped++;}}]});await failed;assert.equal(secondStopped,1);assert.equal(f.host.snapshot().closed,false);assert.equal(f.context.state,'closed');
});

test('capture loan accounting ignores duplicate, wrong-epoch and wrong-size returns',()=>{
  const messages=[];const capture=new WorkerAudioCapturePool(identity,2,2,1,(message)=>messages.push(message));capture.enable(true,1);capture.capture([new Float32Array([1,2])]);const loan=messages[0];assert.equal(capture.outstanding,1);
  capture.returned({...loan,audioEpoch:6});assert.equal(capture.outstanding,1);
  capture.returned({...loan,buffer:new ArrayBuffer(4)});assert.equal(capture.outstanding,1);
  capture.returned(loan);assert.equal(capture.outstanding,0);capture.capture([new Float32Array([3,4])]);capture.returned(loan);assert.equal(capture.outstanding,1);capture.flush();capture.returned(messages[1]);assert.equal(capture.outstanding,0);
});

test('native samples retain planar data, actual host playback, pause/pitch and reported position semantics',async()=>{
  const f=integration();await ready(f);const planar=new Float32Array([.1,.2,.3,.4,.5,.6,.7,.8]);
  f.bridge.sampleRegister('s',planar,4,'forward',0,4);f.bridge.sampleBus('count',3);f.bridge.sampleStart('v','s',1,0,1,new Float32Array(8).fill(1));await turn();
  assert.equal(f.context.sources.length,1);const original=f.context.sources[0];assert.equal(original.loop,true);
  assert.notEqual(original.buffer.getChannelData(0).buffer,planar.buffer);assert(Math.abs(original.buffer.getChannelData(1)[0]-.5)<1e-6);
  f.bridge.samplePause('v',true);await turn();assert.equal(f.bridge.sampleIsActive('v'),true);
  f.bridge.samplePitch('v',2);f.bridge.samplePause('v',false);await turn();assert.equal(f.context.sources.length,2);assert.equal(f.context.sources[1].playbackRate.value,2);
  const position=f.processors.find(record=>record.node.name==='godot-worker-position');position.processor.postMessage({...position.generation,type:'position',frames:2400});await turn();assert.equal(f.bridge.samplePosition('v'),.05);
  f.bridge.sampleVolumes('v',[1,2],new Float32Array(16).fill(.5));f.bridge.sampleBus('volume',1,-6);f.bridge.sampleBus('send',2,1);f.bridge.sampleBus('solo',2,true);f.bridge.sampleBus('mute',1,true);f.bridge.sampleBus('move',2,1);f.bridge.sampleBus('add',3);f.bridge.sampleBus('remove',3);await turn();
  assert.equal(f.host.snapshot().voices,1);assert.equal(f.host.snapshot().voiceBytes,32);
  f.bridge.sampleStop('v');await turn();assert.equal(f.host.snapshot().voices,0);assert.equal(f.host.snapshot().voiceBytes,0);
  await f.host.close();assert.equal(f.host.snapshot().liveNodes,0);
});

test('a failed sample graph construction releases every admitted voice and rejects the run',async()=>{
  const errors=[];const f=integration({onError:error=>errors.push(error)});await ready(f);f.bridge.sampleRegister('s',new Float32Array(8),4,'disabled',0,0);f.bridge.sampleStart('v','s',99,0,1,new Float32Array(8));await turn();
  assert(errors.some(error=>/invalid bus/.test(error.message)));assert.equal(f.host.snapshot().voices,0);assert.equal(f.host.snapshot().voiceBytes,0);await f.host.close();assert.equal(f.host.snapshot().liveNodes,0);
});


test('forceClose disposes the owned host context after a genuinely unresponsive Worker is terminated',async t=>{
  const control=new MessageChannel(),pcm=new MessageChannel();
  const f=integration({timeoutMs:15000},{control:[control.port1,control.port2],pcm:[pcm.port1,pcm.port2]});
  const worker=new NodeWorker(`const {parentPort}=require('node:worker_threads'); parentPort.once('message',async data=>{ const {WorkerAudioBridge}=await import(data.module); const bridge=new WorkerAudioBridge(data.control,data.pcm,data.identity); await bridge.prepare({mixRate:48000,latencyMs:50,driver:'AudioWorklet'}); const heap=new Float32Array(4096).fill(.25); bridge.streamStart({outPtr:0,outSamples:4096,inPtr:0,inSamples:4096,heap:()=>heap,outCallback:()=>{},inCallback:()=>{}}); parentPort.postMessage('blocked'); while(true){} });`,{eval:true});
  t.after(()=>worker.terminate());t.after(()=>control.port1.close());
  worker.postMessage({module:new URL('../dist/worker-audio.js',import.meta.url).href,identity,control:f.workerPort,pcm:f.pcmPort},[f.workerPort,f.pcmPort]);
  assert.deepEqual(await once(worker,'message'),['blocked']);await turn();
  assert(f.stream.queue.queuedBlocks>0);
  const normalClose=f.host.close();const normalFailure=assert.rejects(normalClose,/abandoned/);
  await worker.terminate();const started=performance.now();
  await f.host.forceClose();await normalFailure;
  assert(performance.now()-started<900,'hard cleanup must not wait the 15-second normal flush deadline');
  assert.equal(f.context.state,'closed');assert.equal(f.host.snapshot().contextsClosed,1);assert.equal(f.host.snapshot().liveNodes,0);assert.equal(f.host.snapshot().transferredChunksOwned,0);assert.equal(f.host.snapshot().abandonedEpoch,true);
  assert.equal(f.host.snapshot().abandonedChunks,'unknown','abandoned tickets must not be disguised as acknowledged returns');
  f.stream.direct.close();
});

test('PCM budget checks include both output and microphone pools before worklet allocation',async()=>{
  const f=integration({limits:{pcmBytes:1024}});
  await assert.rejects(f.bridge.prepare({mixRate:48000,latencyMs:50,driver:'AudioWorklet'}),/audioPcmBytes budget/);
  assert.equal(f.processors.length,0);assert.equal(f.context.state,'closed');await f.host.forceClose();assert.equal(f.host.snapshot().contextsClosed,1);
});


test('explicit Dummy remains a native project choice without AudioContext, Worklet or unreachable ACK waits',async()=>{
  const f=integration({timeoutMs:15000});
  const descriptor=await f.bridge.prepare({mixRate:0,latencyMs:50,driver:'Dummy'});
  assert.equal(descriptor.kind,'dummy');assert.equal(descriptor.driver,'Dummy');assert.equal(descriptor.sampleRate,44100);assert.equal(f.bridge.available(),true);assert.equal(f.bridge.hasWorklet(),false);
  assert.equal(f.context,undefined);assert.equal(f.processors.length,0);assert.equal(f.bridge.inputStart(),1);assert.equal(f.bridge.samplePreflight(10,2),false);
  // Simulate native Dummy exiting before the engine Worker can answer host audio cleanup.
  f.workerPort.close();const started=performance.now();await f.host.close();assert(performance.now()-started<900);
  assert.equal(f.host.snapshot().contextsCreated,0);assert.equal(f.host.snapshot().contextsClosed,0);assert.equal(f.host.snapshot().liveNodes,0);assert.equal(f.host.snapshot().closed,true);assert.equal(f.host.snapshot().abandonedEpoch,false);
});


test('native close uses an independently cached context-closed ACK across both stop/atExit races',async t=>{
  for(const order of ['stop-before-native-close','host-close-before-native-close']) {
    const control=new MessageChannel(),pcm=new MessageChannel();
    const f=integration({timeoutMs:1000},{control:[control.port1,control.port2],pcm:[pcm.port1,pcm.port2]});
    const worker=new NodeWorker(`const {parentPort}=require('node:worker_threads'); parentPort.once('message',async data=>{ const {WorkerAudioBridge}=await import(data.module); const bridge=new WorkerAudioBridge(data.control,data.pcm,data.identity); await bridge.prepare({mixRate:48000,latencyMs:50,driver:'AudioWorklet'}); const heap=new Float32Array(4096).fill(.25);bridge.streamStart({outPtr:0,outSamples:4096,inPtr:0,inSamples:4096,heap:()=>heap,outCallback:()=>{},inCallback:()=>{}}); parentPort.on('message',async command=>{if(command==='native-close'){await bridge.close();parentPort.postMessage('native-close-complete');}});parentPort.postMessage('ready'); });`,{eval:true});
    t.after(()=>worker.terminate());t.after(()=>control.port1.close());
    worker.postMessage({module:new URL('../dist/worker-audio.js',import.meta.url).href,identity,control:f.workerPort,pcm:f.pcmPort},[f.workerPort,f.pcmPort]);
    assert.deepEqual(await once(worker,'message'),['ready']);
    if(order==='stop-before-native-close') {await f.host.stop();assert.equal(f.context.state,'suspended');}
    else {await f.host.close();assert.equal(f.context.state,'closed');}
    await turn();
    const result=once(worker,'message');worker.postMessage('native-close');
    let timer;try {assert.deepEqual(await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`native-close hung: ${order}`)),900);})]),['native-close-complete']);}finally{clearTimeout(timer);}
    assert.equal(f.context.state,'closed');assert.equal(f.host.snapshot().contextsClosed,1);assert.equal(f.host.snapshot().closed,true);
    await f.host.close();await worker.terminate();f.stream.direct.close();
  }
});


test('capture fills existing loan capacity across render quanta without increasing allocated frames',()=>{
 const messages=[];const pool=new WorkerAudioCapturePool(identity,2,4,1,(message)=>messages.push(message));pool.enable(true,1);
 pool.capture([new Float32Array([1,2])]);assert.equal(messages.length,0);assert.equal(pool.outstanding,0);
 pool.capture([new Float32Array([3,4])]);assert.equal(messages.length,1);assert.equal(messages[0].frames,4);assert.deepEqual([...new Float32Array(messages[0].buffer)],[1,1,2,2,3,3,4,4]);assert.equal(pool.outstanding,1);
 pool.capture([new Float32Array([5,6])]);assert.equal(pool.droppedFrames,2);pool.returned(messages[0]);pool.capture([new Float32Array([7,8])]);pool.enable(false,1);pool.enable(true,2);pool.capture([new Float32Array([9,10,11,12])]);assert.equal(messages[1].inputEpoch,2);assert.deepEqual([...new Float32Array(messages[1].buffer)],[9,9,10,10,11,11,12,12]);
});


test('PCM loans cover the actual native ring without truncating a larger project buffer',async()=>{
 const f=preparedBridge({streamBlocks:8,streamBlockFrames:256});await ready(f);const heap=Float32Array.from({length:8192},(_,index)=>index);
 f.bridge.streamStart({outPtr:0,outSamples:8192,inPtr:0,inSamples:8192,heap:()=>heap,outCallback:()=>{},inCallback:()=>{}});await turn();
 const config=f.pcm.sent.find(message=>message.type==='stream'),blocks=f.pcm.sent.filter(message=>message.type==='block');assert.equal(config.outSamples,8192);assert.equal(config.maxFrames,512);assert.equal(blocks.length,8);assert.equal(blocks.reduce((sum,block)=>sum+block.frames,0),4096);assert.equal(new Float32Array(blocks.at(-1).buffer).at(-1),8191);
 const queue=new WorkerAudioRenderQueue(identity,2,256,8,()=>{});assert.equal(queue.configureMaximumFrames(512),true);queue.accept(blocks[0]);assert.equal(queue.queuedBlocks,1);assert.equal(queue.configureMaximumFrames(1024),false);
});

test('device latency settling updates the native mirror using actual AudioContext values',async()=>{
 const f=integration();await ready(f);const updates=[];f.bridge.init(48000,50,()=>{},value=>updates.push(value));f.context.outputLatency=.05;
 await new Promise(resolve=>setTimeout(resolve,1050));await turn();assert(Math.abs(updates.at(-1)-.06)<1e-9);const descriptor=await f.bridge.prepare({mixRate:48000,latencyMs:50,driver:'AudioWorklet'});assert(Math.abs(descriptor.outputLatency-.06)<1e-9);await f.host.close();
});


test('phase-one PCM admission exactly matches native rounding and counts native input history',()=>{
 const layout=estimateWorkerAudioPcm(75,48000,2,DEFAULT_AUDIO_LIMITS);assert.equal(layout.nativeRingFrames,4096);assert.equal(layout.nativeRingSamples,8192);assert.equal(layout.nativeOutputBytes,32768);assert.equal(layout.nativeInputBytes,32768);assert.equal(layout.nativeCaptureHistoryBytes,131072);assert.equal(layout.transportOutputBytes,32768);assert.equal(layout.captureBlockFrames,512);assert.equal(layout.capturePoolFrames,4096);assert.equal(layout.capturePoolBytes,32768);assert.equal(layout.totalBytes,262144);
 assert.equal(estimateWorkerAudioPcm(32,48000,2,DEFAULT_AUDIO_LIMITS).nativeRingFrames,2048,'exact linear-distance tie rounds up');assert.equal(estimateWorkerAudioPcm(31,48000,2,DEFAULT_AUDIO_LIMITS).nativeRingFrames,1024);
 assert.throws(()=>estimateWorkerAudioPcm(50000,48000,2,DEFAULT_AUDIO_LIMITS),/overflow int32/);assert.throws(()=>estimateWorkerAudioPcm(40000,48000,2,DEFAULT_AUDIO_LIMITS),/audioPcmBytes budget/);
 assert.throws(()=>estimateWorkerAudioPcm(75,48000,2,{...DEFAULT_AUDIO_LIMITS,pcmBytes:layout.totalBytes-1}),/audioPcmBytes/);assert.equal(estimateWorkerAudioPcm(75,48000,2,{...DEFAULT_AUDIO_LIMITS,pcmBytes:layout.totalBytes}).totalBytes,layout.totalBytes);
});

test('huge project latency fails before worklet allocation and native setup2 admission, closing its context',async()=>{
 for(const latencyMs of [40000,50000,Number.MAX_SAFE_INTEGER]){
  const f=integration();await assert.rejects(f.bridge.prepare({mixRate:48000,latencyMs,driver:'AudioWorklet'}),/audioPcmBytes|overflow int32/);assert.equal(f.processors.length,0);assert.equal(f.context.state,'closed');assert.equal(f.host.snapshot().contextsClosed,1);assert.equal(f.bridge.hasWorklet(),false);await f.host.forceClose();
 }
});


test('late sample positions after pause/pitch cannot cross either port or superseded generation ACKs',async()=>{
 const f=integration();await ready(f);f.bridge.sampleRegister('s',new Float32Array(9600),4800,'forward',0,4800);f.bridge.sampleStart('v','s',0,0,1,new Float32Array(8).fill(1));await turn();
 const position=f.processors.find(record=>record.node.name==='godot-worker-position'),old=position.generation;
 position.processor.postMessage(position.counter.processFrames(2400));await turn();assert.equal(f.bridge.samplePosition('v'),.05);
 f.bridge.samplePause('v',true);
 position.processor.postMessage({...old,type:'position',frames:48000});await turn();assert.equal(f.bridge.samplePosition('v'),.05,'pre-pause report must not move the paused native position');
 assert.equal(position.counter.processFrames(2400),undefined,'the actual render counter freezes on a pause barrier');const pausedGeneration=position.generation;
 f.bridge.samplePitch('v',2);position.processor.postMessage({...pausedGeneration,type:'position',frames:96000});await turn();assert.equal(f.bridge.samplePosition('v'),.05,'pre-pitch report must not pass the new command generation');
 // Even an ACK already emitted on the node port cannot reopen a superseded generation.
 position.processor.postMessage({...old,type:'position-generation-ack',frames:192000});await turn();assert.equal(f.bridge.samplePosition('v'),.05);
 // Public position keeps upstream output-frame timing even at pitch 2; it is not source playhead time.
 f.bridge.samplePause('v',false);await turn();assert.equal(f.context.sources.at(-1).playbackRate.value,2);position.processor.postMessage(position.counter.processFrames(2400));await turn();assert.equal(f.bridge.samplePosition('v'),.1,'resumed position uses actual newly rendered frames, not a synthetic clock');await f.host.close();
});

test('Worker locally fences a queued position even before its pause/pitch command reaches the host',async()=>{
 const f=preparedBridge();await ready(f);f.bridge.sampleRegister('s',new Float32Array(16),8,'forward',0,8);f.bridge.sampleStart('v','s',0,1,1,new Float32Array(8));await turn();const start=f.worker.sent.find(message=>message.operation==='start');
 f.host.postMessage({...identity,type:'position',id:'v',voiceEpoch:start.voiceEpoch,commandSeq:start.seq,position:99});f.bridge.samplePause('v',true);await turn();assert.equal(f.bridge.samplePosition('v'),1);
 const pause=f.worker.sent.find(message=>message.operation==='pause');f.host.postMessage({...identity,type:'position',id:'v',voiceEpoch:start.voiceEpoch,commandSeq:pause.seq,position:100});f.bridge.samplePitch('v',2);await turn();assert.equal(f.bridge.samplePosition('v'),1);
});


test('surround output never changes the native stereo microphone callback format or PCM budget',async()=>{
 for(const outputChannels of [6,8])for(const sourceChannels of [1,2]){
  const f=integration({outputChannels,requestInput:async()=>({getTracks:()=>[{stop(){}}]})});const descriptor=await f.bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});assert.equal(descriptor.channels,outputChannels);assert.equal(descriptor.inputChannels,2);assert.equal(descriptor.pcm.capturePoolBytes,8*512*2*4,'capture budget must use native stereo, independent of surround output');
  const outSamples=outputChannels*4096,heap=new Float32Array(outSamples*2),calls=[];
  f.bridge.streamStart({outPtr:0,outSamples,inPtr:outSamples*4,inSamples:outSamples,heap:()=>heap,outCallback:()=>{},inCallback:(position,samples)=>calls.push({position,samples,values:[...heap.subarray(outSamples+position,outSamples+position+samples)]})});assert.equal(f.bridge.inputStart(),0);await turn();
  const left=new Float32Array(512);left.set([.125,.25]);const input=[left];if(sourceChannels===2){const right=new Float32Array(512);right.set([.5,.75]);input.push(right);}
  f.stream.capture.capture(input);await turn();assert.equal(calls[0].samples,1024,'512 captured frames must be 1024 native float samples independent of surround output');assert.equal(calls[0].position,0);assert.deepEqual(calls[0].values.slice(0,4),sourceChannels===1?[.125,.125,.25,.25]:[.125,.5,.25,.75]);assert(heap.subarray(outSamples+1024).every(value=>value===0),'unused native input_rb capacity must remain untouched');
  f.stream.capture.capture(input);await turn();assert.equal(calls[1].position,1024);assert.equal(calls[1].samples,1024);assert.equal(f.stream.capture.outstanding,0);await f.host.close();
 }
 const stereo=estimateWorkerAudioPcm(75,48000,2,DEFAULT_AUDIO_LIMITS),surround=estimateWorkerAudioPcm(75,48000,8,DEFAULT_AUDIO_LIMITS);assert.equal(surround.capturePoolBytes,stereo.capturePoolBytes);assert.equal(surround.nativeCaptureHistoryBytes,stereo.nativeCaptureHistoryBytes);assert.equal(surround.nativeInputBytes,stereo.nativeInputBytes*4,'native input_rb allocation remains output-channel sized');assert.equal(surround.nativeOutputBytes,stereo.nativeOutputBytes*4);
});


test('looped sample pause/resume and pitch changes preserve offset-to-duration cursor across multiple wraps',async()=>{
 const f=integration();await ready(f);f.bridge.sampleRegister('loop',new Float32Array(960000),480000,'forward',123,456);f.bridge.sampleStart('v','loop',0,5,1,new Float32Array(8));await turn();
 const started=()=>f.context.sources.at(-1).starts.at(-1)[1];assert.equal(started(),5);assert.equal(f.context.sources[0].loopStart,5);assert.equal(f.context.sources[0].loopEnd,10,'explicit end preserves upstream restart region instead of WebAudio whole-buffer fallback');
 f.context.currentTime=7.5;f.bridge.samplePause('v',true);await turn();f.context.currentTime=100;f.bridge.samplePause('v',false);await turn();assert.equal(started(),7.5,'7.5s rendered from offset 5 must resume at 7.5, not 2.5');
 f.context.currentTime=112.5;f.bridge.samplePitch('v',2);await turn();f.context.currentTime=116.25;f.bridge.samplePause('v',true);await turn();f.context.currentTime=200;f.bridge.samplePause('v',false);await turn();assert.equal(started(),7.5);assert.equal(f.context.sources.at(-1).playbackRate.value,2);
 f.context.currentTime=201;f.bridge.samplePitch('v',.5);await turn();f.context.currentTime=222;f.bridge.samplePause('v',true);await turn();f.context.currentTime=300;f.bridge.samplePause('v',false);await turn();assert.equal(started(),5);assert.equal(f.context.sources.at(-1).playbackRate.value,.5);
 for(const source of f.context.sources)for(const [,offset]of source.starts)assert(Number.isFinite(offset)&&offset>=5&&offset<10);await f.host.close();
});

test('loop offset at or beyond duration uses a valid WebAudio whole-buffer interval without zero/negative modulo',async()=>{
 for(const offset of [10,12]){
  const f=integration();await ready(f);f.bridge.sampleRegister('loop',new Float32Array(960000),480000,'backward',100,200);f.bridge.sampleStart('v','loop',0,offset,1,new Float32Array(8));await turn();const first=f.context.sources[0];assert.equal(first.loopStart,0);assert.equal(first.loopEnd,10);assert.equal(first.starts[0][1],0,'out-of-range initial offset clamps to loop end then wraps to effective loop start');
  f.context.currentTime=1.25;f.bridge.samplePitch('v',2);await turn();f.context.currentTime=4.5;f.bridge.samplePause('v',true);await turn();f.context.currentTime=100;f.bridge.samplePause('v',false);await turn();const resumed=f.context.sources.at(-1).starts[0][1];assert.equal(resumed,7.75);assert(Number.isFinite(resumed)&&resumed>=0&&resumed<10);await f.host.close();
 }
});

// Execute the registered production processor, not the integration fixture's simulated process().
let processorModuleSequence=0;
async function productionProcessor() {
 const classes=new Map(),[main,processor]=ports();
 const oldProcessor=globalThis.AudioWorkletProcessor,oldRegister=globalThis.registerProcessor;
 try {
  globalThis.AudioWorkletProcessor=class { constructor(){this.port=processor;} };
  globalThis.registerProcessor=(name,klass)=>classes.set(name,klass);
  await import(`../dist/worker-audio-worklet.js?capture-regression=${++processorModuleSequence}`);
  return {instance:new (classes.get('godot-worker-audio'))(),main};
 } finally {
  if(oldProcessor===undefined)delete globalThis.AudioWorkletProcessor;else globalThis.AudioWorkletProcessor=oldProcessor;
  if(oldRegister===undefined)delete globalThis.registerProcessor;else globalThis.registerProcessor=oldRegister;
 }
}

test('capture admission covers one native driver period at every rate without multiplying surround duration',()=>{
 assert.equal(estimateWorkerAudioPcm(3,8000,2,{...DEFAULT_AUDIO_LIMITS,streamBlockFrames:300}).captureBlockFrames,384,'custom minimum blocks are quantum aligned too');
 for(const rate of [8000,11025,16000,22050,32000,44100,48000,96000,192000])for(const latency of [3,25,75]){
  const stereo=estimateWorkerAudioPcm(latency,rate,2,DEFAULT_AUDIO_LIMITS);
  assert(stereo.capturePoolFrames>=stereo.nativeRingFrames);
  assert(stereo.captureBlockFrames>=DEFAULT_AUDIO_LIMITS.streamBlockFrames);
  assert.equal(stereo.captureBlockFrames%128,0);
  assert.equal(stereo.capturePoolFrames,8*stereo.captureBlockFrames);
  for(const channels of [1,4,6,8]){
   const layout=estimateWorkerAudioPcm(latency,rate,channels,DEFAULT_AUDIO_LIMITS);
   assert.equal(layout.nativeRingFrames,stereo.nativeRingFrames);
   assert.equal(layout.capturePoolBytes,stereo.capturePoolBytes);
   assert.equal(layout.capturePoolBytes,layout.capturePoolFrames*2*4);
   assert.equal(layout.nativeInputBytes,layout.nativeRingFrames*channels*4);
  }
 }
});

test('production Worklet preserves exact stereo ramps through 50ms delayed native consumption, then drops only beyond the bounded ring',async()=>{
 for(const channels of [1,2,4,6,8]) {
 const pcm=estimateWorkerAudioPcm(75,48000,channels,DEFAULT_AUDIO_LIMITS),limits={...DEFAULT_AUDIO_LIMITS};
 const descriptor={...identity,kind:'worklet',driver:'AudioWorklet',sampleRate:48000,channels,inputChannels:2,state:'running',outputLatency:.02,limits,pcm};
 const [controlHost,controlWorker]=ports(),[directWorklet,directWorker]=ports();
 const bridge=new WorkerAudioBridge(controlWorker,directWorker,identity);
 controlHost.onmessage=({data})=>{if(data.type==='prepare')controlHost.postMessage({...identity,type:'prepared',descriptor});};
 await bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});
 const {instance,main}=await productionProcessor();
 main.postMessage({...identity,type:'attach',port:directWorklet,channels,inputChannels:2,maxFrames:256,captureBlockFrames:pcm.captureBlockFrames,maxBlocks:8,pcmBytes:pcm.transportBudgetBytes});await turn();
 const outSamples=4096*channels,heap=new Float32Array(outSamples*2),received=[];
 bridge.streamStart({outPtr:0,outSamples,inPtr:outSamples*4,inSamples:outSamples,heap:()=>heap,outCallback:()=>{},inCallback:(position,samples)=>received.push(...heap.subarray(outSamples+position,outSamples+position+samples))});
 bridge.inputStart();main.postMessage({...identity,type:'capture-enable',inputEpoch:1,enabled:true});await turn();
 const render=(start,count)=>{for(let frame=start;frame<start+count;frame+=128){const l=Float32Array.from({length:128},(_,i)=>frame+i),r=Float32Array.from({length:128},(_,i)=>-(frame+i));assert.equal(instance.process([[l,r]],[Array.from({length:channels},()=>new Float32Array(128))]),true);}};
 // No task turn / no capture returns for 53.33ms of actual processor input.
 render(0,2560);
 assert.equal(instance.capturePool.droppedFrames,0);assert.equal(instance.capturePool.outstanding,5);assert.equal(received.length,0);
 // The former 8 x 256 pool loses 512 frames under the identical delayed-return burst.
 const old=new WorkerAudioCapturePool(identity,2,256,8,()=>{});old.enable(true,1);
 for(let frame=0;frame<2560;frame+=128)old.capture([new Float32Array(128)]);
 assert.equal(old.droppedFrames,512);
 // Fill exactly the admitted 4096-frame period, then another 256 frames: no growth or allocation.
 render(2560,1792);
 assert.equal(instance.capturePool.outstanding,8);assert.equal(instance.capturePool.droppedFrames,256);
 assert.equal(directWorklet.sent.filter(m=>m.type==='capture').length,8);
 await turn();assert.equal(instance.capturePool.outstanding,0);assert.equal(received.length,4096*2);
 for(let f=0;f<4096;f++){assert.equal(received[f*2],f);assert.equal(received[f*2+1],-f);}
 const loan=directWorklet.sent.find(m=>m.type==='capture');
 // A new input epoch cannot be credited by old or forged return tickets.
 bridge.inputStop();bridge.inputStart();main.postMessage({...identity,type:'capture-enable',inputEpoch:2,enabled:true});await turn();
 render(4352,512);assert.equal(instance.capturePool.outstanding,1);
 instance.capturePool.returned({...loan,buffer:new ArrayBuffer(pcm.captureBlockFrames*2*4)});assert.equal(instance.capturePool.outstanding,1);
 const currentLoan=directWorklet.sent.filter(m=>m.type==='capture').at(-1);
 instance.capturePool.returned({...currentLoan,inputEpoch:1,buffer:new ArrayBuffer(pcm.captureBlockFrames*2*4)});assert.equal(instance.capturePool.outstanding,1,'correct sequence with a stale input epoch cannot credit the current loan');
 // Stop before the queued native callback: the buffer must still return without further native writes.
 const consumed=received.length;
 main.postMessage({...identity,type:'flush'});controlHost.postMessage({...identity,type:'stop'});
 await turn();assert.equal(instance.capturePool.outstanding,0);assert.equal(bridge.snapshot().loans,0);
 assert.equal(instance.capturePool.droppedFrames,256);
 assert(received.length===consumed||received.length===consumed+512*2,'the already queued block may precede stop, but must never be consumed twice');
 assert(main.sent.some(m=>m.type==='flush'));assert(instance.flushReported);
 const atStop=received.length;render(4864,512);await turn();assert.equal(received.length,atStop);assert.equal(instance.capturePool.outstanding,0);
 }
});

test('new capture-period reservation rejects insufficient PCM before native setup2 and worklet creation',async()=>{
 // This budget admitted the old 8 x 256 pool but cannot hold the actual 4096-frame capture period.
 const f=integration({limits:{pcmBytes:245760}});let nativeSetup2=false;
 await assert.rejects(f.bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'}).then(()=>{nativeSetup2=true;}),/audioPcmBytes budget/);
 assert.equal(nativeSetup2,false);assert.equal(f.processors.length,0);assert.equal(f.context.state,'closed');assert.equal(f.host.snapshot().contextsClosed,1);
 await f.host.forceClose();
});

test('native input ring must match the phase-one period even when a smaller allocation would fit',async()=>{
 const f=integration();await f.bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});
 const heap=new Float32Array(16384);
 assert.throws(()=>f.bridge.streamStart({outPtr:0,outSamples:8192,inPtr:32768,inSamples:4096,heap:()=>heap,outCallback:()=>{},inCallback:()=>{}}),/differ from phase-one/);
 assert.equal(f.bridge.snapshot().loans,0);await f.host.close();
});

test('very small mono native staging rings wrap capture packets safely without claiming native-history losslessness',async()=>{
 const f=integration({outputChannels:1,requestInput:async()=>({getTracks:()=>[{stop(){}}]})});
 const d=await f.bridge.prepare({mixRate:8000,latencyMs:3,driver:'AudioWorklet'});
 assert.equal(d.pcm.nativeRingFrames,32);assert.equal(d.pcm.captureBlockFrames,256);
 assert(d.pcm.captureBlockFrames>d.pcm.nativeRingFrames*4,'this existing extreme setting exceeds native history duration and is not certified lossless');
 const heap=new Float32Array(80).fill(-999),received=[],calls=[];
 f.bridge.streamStart({outPtr:0,outSamples:32,inPtr:128,inSamples:32,heap:()=>heap,outCallback:()=>{},inCallback:(position,samples)=>{calls.push([position,samples]);received.push(...heap.subarray(32+position,32+position+samples));}});
 f.bridge.inputStart();await turn();
 f.stream.capture.capture([Float32Array.from({length:256},(_,i)=>i)]);await turn();
 assert.equal(calls.length,16);assert(calls.every(([position,samples])=>position===0&&samples===32));
 for(let frame=0;frame<256;frame++)assert.deepEqual(received.slice(frame*2,frame*2+2),[frame,frame]);
 assert(heap.subarray(0,32).every(v=>v===-999));assert(heap.subarray(64).every(v=>v===-999));
 assert.equal(f.stream.capture.outstanding,0);await f.host.close();
});
