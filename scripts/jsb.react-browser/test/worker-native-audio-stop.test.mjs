import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {WorkerAudioBridge} from '../dist/worker-audio.js';
import {DEFAULT_AUDIO_LIMITS} from '../dist/worker-audio-protocol.js';
import {WorkerSessionLease} from '../dist/worker-session.js';
import {isWorkerEnvelope,sameWorkerRun} from '../dist/worker-protocol.js';
import {previewDiagnostic} from '../dist/protocol.js';
import {patchWorkerRuntimeFile,WORKER_RUNTIME_PATHS,WORKER_RUNTIME_ABI} from '../../release/patch-web-worker-runtime.mjs';

const original=await readFile(new URL('./fixtures/godot-4.6.1-audio-driver-web.cpp',import.meta.url),'utf8');
const native=patchWorkerRuntimeFile('platform/web/audio_driver_web.cpp',original).code;
const register=native.match(/void AudioDriverWeb::register_sample\([^]*?\n\}/)?.[0];
const admission=register?.match(/const bool sample_cancelled = EM_ASM_INT\(\{([^]*?)\}, frames_total\);/)?.[1];
assert(register&&admission,'Extract the actual checked native predecode admission, not a rewritten simulation');
const runtime=await readFile(new URL('../dist/worker-runtime.js',import.meta.url),'utf8');
const controlStart=runtime.indexOf('control.onmessage ='),controlEnd=runtime.indexOf('data.onmessage =',controlStart);
const actualControl=runtime.slice(controlStart,controlEnd);
const fatalStart=runtime.indexOf('const fatal ='),fatalEnd=runtime.indexOf('const onError =',fatalStart);
const actualFatal=runtime.slice(fatalStart,fatalEnd).replace('const fatal =','globalThis.actualFatal =');
assert(controlStart>=0&&controlEnd>controlStart&&fatalStart>=0&&fatalEnd>fatalStart);
const identity={runId:'audio-stop-run',revision:1,buildKey:'pack',generation:1,documentId:'document',workerId:'worker',runConfigurationHash:'a'.repeat(64)};
const audioIdentity={runId:identity.runId,audioEpoch:1};
class Port {onmessage=null;sent=[];start(){}close(){}postMessage(value,transfer=[]){this.sent.push({value,transfer});}}
function fixture(limits={}){
 const control=new Port(),pcm=new Port(),bridge=new WorkerAudioBridge(control,pcm,audioIdentity);
 return {control,pcm,bridge,async ready(){
  const preparing=bridge.prepare({mixRate:48000,latencyMs:75,driver:'AudioWorklet'});
  control.onmessage({data:{...audioIdentity,type:'prepared',descriptor:{...audioIdentity,kind:'worklet',driver:'AudioWorklet',sampleRate:48000,channels:2,inputChannels:2,state:'running',outputLatency:0,limits:{...DEFAULT_AUDIO_LIMITS,...limits}}}});
  await preparing;
 },stop(){control.onmessage({data:{...audioIdentity,type:'stop'}});}};
}
const nativeAdmission=(bridge,frames=10)=>runInNewContext('(function(){'+admission+'})()',{__godotWorkerAudio:bridge,$0:frames});
function runtimeStop(f){
 const control=new Port(),events=[],calls={quit:0,cancel:0},lease=new WorkerSessionLease();
 const scope={control,data:{},identity,isWorkerEnvelope,sameWorkerRun,lease,audio:f.bridge,DOMException,
  dom:{revokeInput(){}},aborter:new AbortController(),presentation:{dispose(){}},xr:{dispose(){}},
  cancelNativeStart(){calls.cancel++;},module:{},post:value=>events.push(value),text:values=>values.join(' '),
  closed:false,nativeExited:false,failed:false,previewDiagnostic,
  engine:{requestQuit(){calls.quit++;assert.equal(nativeAdmission(f.bridge),1,'Actual Native cancellation must precede any quit/cleanup callback');}},
 };
 runInNewContext(actualControl+'\n'+actualFatal,scope);
 return {control,scope,calls,events,lease,stop(){control.onmessage({data:{...identity,protocolVersion:2,type:'stop'}});}};
}

test('checked Native gate keeps the ten-file ABI and cannot decode after audio-port revocation',async()=>{
 assert.equal(WORKER_RUNTIME_PATHS.length,10);assert.deepEqual(WORKER_RUNTIME_ABI,{protocolVersion:2,host:1,audio:1,presentation:1});
 assert.equal(patchWorkerRuntimeFile('platform/web/audio_driver_web.cpp',native).changed,false);
 const f=fixture();await f.ready();assert.equal(nativeAdmission(f.bridge),0);assert.equal(f.bridge.samplePreflight(10,2),true);
 f.stop();assert.equal(f.bridge.available(),false);assert.equal(f.bridge.hasWorklet(),true,'The descriptor remains present; stop is a separate irreversible fence');
 assert.equal(nativeAdmission(f.bridge),1);assert.equal(f.bridge.samplePreflight(10,2),false);
 assert.equal(f.bridge.snapshot().stopped,true);
});

test('unprepared active and active-budget failures remain errors while the legacy Window path is unchanged',async()=>{
 const fresh=fixture();assert.equal(fresh.bridge.available(),true);assert.throws(()=>nativeAdmission(fresh.bridge),/AudioHost must be prepared/);
 const limited=fixture({sampleBytes:256});await limited.ready();assert.equal(nativeAdmission(limited.bridge,8),0);assert.throws(()=>nativeAdmission(limited.bridge,9),/E_WORKER_SAMPLE_BUDGET/);
 assert.equal(runInNewContext('(function(){'+admission+'})()',{$0:1000000}),0,'No Worker audio bridge retains the existing Window behavior');
});

test('revoked Native sample APIs neither inspect or copy caller data nor post or allocate resources',async()=>{
 const f=fixture();await f.ready();f.bridge.sampleRegister('sample',new Float32Array(20),10,'disabled',0,0);f.bridge.sampleStart('voice','sample',0,0,1,[1,1]);
 f.stop();const commands=f.control.sent.length,pcm=f.pcm.sent.length;let reads=0;
 const unreadable=new Proxy({}, {get(){reads++;throw Error('revoked caller data was read');}});
 assert.doesNotThrow(()=>{
  f.bridge.sampleRegister('late',unreadable,10,'disabled',0,0);
  f.bridge.sampleStart('late-voice','late',0,0,1,unreadable);
  f.bridge.sampleVolumes('voice',[0],unreadable);
  f.bridge.sampleBus('count',2);f.bridge.sampleUnregister('sample');f.bridge.sampleStop('voice');
  f.bridge.samplePause('voice',true);f.bridge.samplePitch('voice',2);
 });
 assert.equal(reads,0);assert.equal(f.control.sent.length,commands);assert.equal(f.pcm.sent.length,pcm);
 assert.deepEqual(f.bridge.snapshot(),{sampleBytes:0,retainedSampleBytes:160,retainedSampleCount:1,retiringSamples:0,voiceBytes:0,loans:0,pendingCommands:0,stopped:true});
});

test('local revocation does not suppress the actual Native close/Host closed handshake',async()=>{
 const f=fixture();await f.ready();f.bridge.revoke();
 const closed=f.bridge.close();assert.equal(f.control.sent.at(-1).value.type,'close');
 f.control.onmessage({data:{...audioIdentity,type:'closed'}});await closed;
 assert.equal(f.bridge.available(),false);assert.equal(f.bridge.snapshot().stopped,true);
});

for(const order of ['audio-first','runtime-first'])test('actual runtime and audio-port handlers both fence Native quit callbacks: '+order,async()=>{
 const f=fixture();await f.ready();const r=runtimeStop(f);
 if(order==='audio-first'){f.stop();assert.equal(nativeAdmission(f.bridge),1);r.stop();}
 else {r.stop();assert.equal(nativeAdmission(f.bridge),1);f.stop();}
 r.stop();assert.equal(r.calls.quit,1);assert.equal(r.calls.cancel,1);assert.equal(r.lease.active,false);
 assert.equal(f.bridge.available(),false);assert(f.control.sent.some(entry=>entry.value.type==='worker-stopped'),'Audio ACK remains owned by the actual audio-port stop handler');
 assert.equal(r.scope.aborter.signal.aborted,true);
});

test('actual runtime fatal path revokes audio before Native quit and preserves its first diagnostic',async()=>{
 const f=fixture();await f.ready();const r=runtimeStop(f);
 r.scope.actualFatal(new Error('original-runtime-failure'));r.scope.actualFatal(new Error('late-secondary'));
 assert.equal(r.calls.quit,1);assert.equal(r.calls.cancel,1);assert.equal(f.bridge.available(),false);
 const fatal=r.events.filter(event=>event.type==='worker-fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.message,'original-runtime-failure');
});

test('actual patched native register_sample returns before playback creation and buffer allocations on cancellation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'godot-worker-audio-stop-'));
 try{
  const template=await readFile(new URL('./fixtures/godot-worker-audio-stop-harness.cpp',import.meta.url),'utf8');
  const source=join(directory,'stop.cpp'),binary=join(directory,'stop');
  await writeFile(source,template.replace('/* GODOTJS_INSERT_ACTUAL_REGISTER_SAMPLE */',register));
  const compiled=spawnSync(process.env.CXX||'c++',['-std=c++17','-O0',source,'-o',binary],{encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{await rm(directory,{recursive:true,force:true});}
});
