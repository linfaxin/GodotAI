import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {patchAudioLifecycle,AUDIO_LIFECYCLE_PATCH,audioLifecycleFingerprints} from '../../release/patch-web-audio-lifecycle.mjs';

const fixture=await readFile(new URL('./fixtures/godot-4.6.1-audio.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function setup(){
 const stats={contexts:[],nodes:[],errors:[],nativeFinishes:0,stateCallbacks:0,intervalsCleared:0};
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
 class Node{
  constructor(){this.gain={value:1};this.playbackRate={value:1};this.listeners=new Map();this.stops=0;this.disconnects=0;this.starts=0;stats.nodes.push(this);}
  connect(){return this;}disconnect(){this.disconnects++;}start(){this.starts++;}stop(){this.stops++;}
  addEventListener(name,fn){this.listeners.set(name,fn);}removeEventListener(name){this.listeners.delete(name);}
 }
 class Context{
  constructor(){this.state='running';this.currentTime=2;this.destination={channelCount:2};this.closeCalls=0;this.requests=new Map();this.audioWorklet={addModule:path=>{const next=deferred();this.requests.set(path,next);return next.promise;}};stats.contexts.push(this);}
  createBufferSource(){return new Node();}createGain(){return new Node();}createChannelSplitter(){return new Node();}createChannelMerger(){return new Node();}
  close(){this.closeCalls++;this.state='closed';this.onstatechange?.();return Promise.resolve();}
 }
 class Worklet extends Node{
  constructor(ctx){super();assert.equal(ctx.state,'running');this.context=ctx;this.port={closeCalls:0,postMessage(){},close(){this.closeCalls++;}};this.parameters=new Map([['reset',{setValueAtTime(){}}]]);}
 }
 const library={},scope={console,Float32Array,Int32Array,Promise,Map,Set,Array,parseInt,window:{AudioContext:Context},AudioWorkletNode:Worklet,
  setInterval:()=>17,clearInterval:()=>stats.intervalsCleared++,navigator:{},
  LibraryManager:{library},autoAddDeps(){},mergeInto:(target,values)=>Object.assign(target,values),
  GodotConfig:{locate_file:path=>path},GodotOS:{atexit(){}},
  GodotRuntime:{error:(...values)=>stats.errors.push(values),allocString:value=>value,free(){},heapSlice:()=>new Float32Array(8),heapSub:()=>new Float32Array(8)},HEAPF32:new Float32Array(8)};
 // Emscripten emits the inner $ object under this global. Rename the source
 // library wrapper so its lexical binding does not shadow that runtime global.
 const patched=patchAudioLifecycle(fixture).code.replace('const GodotAudioWorklet =','const GodotAudioWorkletLibrary =').replace('autoAddDeps(GodotAudioWorklet,','autoAddDeps(GodotAudioWorkletLibrary,').replace('mergeInto(LibraryManager.library, GodotAudioWorklet);','mergeInto(LibraryManager.library, GodotAudioWorkletLibrary);');
 runInNewContext(patched,scope);
 scope.GodotAudio=library.$GodotAudio;scope.GodotAudioWorklet=library.$GodotAudioWorklet;
 const audio=scope.GodotAudio,driver=scope.GodotAudioWorklet;
 const init=()=>{audio.init(44100,16,()=>stats.stateCallbacks++,()=>{});return stats.contexts.at(-1);};
 const ctx=init();
 const sample=()=>{
  audio.samples.set('source',{loopMode:'disabled',sampleRate:44100,getAudioBuffer:()=>({})});audio.set_sample_bus_count(1);
  audio.sampleFinishedCallback=()=>stats.nativeFinishes++;
  return audio.SampleNode.create({id:'playback',streamObjectId:'source',busIndex:0},{start:true,offset:0,volume:new Float32Array(8)});
 };
 return{scope,audio,driver,stats,ctx,init,sample};
}
const close=audio=>new Promise((resolve,reject)=>audio.close_async(resolve,reject));

test('pending module loads do not block close and cannot construct or start after retirement',async()=>{
 const s=setup();s.driver.create(2);s.driver.start(new Float32Array(4),new Float32Array(4),new Int32Array(4));s.driver.start_no_threads(0,8,()=>assert.fail('retired native callback'),0,8,()=>assert.fail('retired native callback'));
 const sample=s.sample();
 await close(s.audio);
 assert.equal(s.ctx.closeCalls,1);assert.equal(s.audio.sampleNodes.size,0);assert.equal(s.driver.worklet,null);assert.equal(s.stats.nativeFinishes,0);
 for(const request of s.ctx.requests.values())request.resolve();await tick();
 assert.equal(s.stats.nodes.filter(node=>node.port).length,0);assert.equal(sample._source,null);assert.equal(s.stats.errors.length,0);
 await close(s.audio);assert.equal(s.ctx.closeCalls,1);
});

test('normal sample pause/resume and stream startup still work; shutdown retires all ports without native callbacks',async()=>{
 const s=setup();s.driver.create(2);s.driver.start(new Float32Array(4),new Float32Array(4),new Int32Array(4));const sample=s.sample();
 for(const request of s.ctx.requests.values())request.resolve();await tick();
 assert.equal(sample.isStarted,true);assert.equal(sample._source.starts,1);assert.ok(s.driver.get_node());
 s.audio.sample_set_pause('playback',true);assert.equal(sample.isPaused,true);
 s.audio.sample_set_pause('playback',false);assert.equal(sample.isPaused,false);assert.equal(sample._source.starts,1);
 const ended=sample._onended,position=sample._positionWorklet,positionMessage=position.port.onmessage,stream=s.driver.worklet,streamMessage=stream.port.onmessage;
 await close(s.audio);await close(s.audio);
 assert.equal(s.ctx.closeCalls,1);assert.equal(sample._source,null);assert.equal(s.audio.sampleNodes.size,0);assert.equal(s.audio.audioPositionWorkletNodes.length,0);
 assert.equal(position.port.closeCalls,1);assert.equal(stream.port.closeCalls,1);assert.equal(s.stats.nativeFinishes,0);assert.equal(s.stats.errors.length,0);
 assert.doesNotThrow(()=>{ended({});positionMessage({data:{type:'position',data:100}});streamMessage({data:'late'});s.audio.sample_set_pause('playback',true);s.audio.set_sample_bus_count(3);sample._pause();sample._restart();});
 assert.equal(s.audio.buses.length,0);assert.equal(s.stats.errors.length,0);
});

test('active sample completion keeps its callback and reusable position pool, then retirement closes the pool',async()=>{
 const s=setup(),sample=s.sample();s.ctx.requests.get('godot.audio.position.worklet.js').resolve();await tick();
 const worklet=sample._positionWorklet;sample.clear();sample.clear();
 assert.equal(s.stats.nativeFinishes,1);assert.equal(s.audio.audioPositionWorkletNodes.length,1);assert.equal(worklet.port.closeCalls,0);
 await close(s.audio);assert.equal(worklet.port.closeCalls,1);assert.equal(s.stats.nativeFinishes,1);
});

test('retired rejection is ignored, while active loading errors remain observable and close completes',async()=>{
 const retired=setup();retired.driver.create(2);const old=retired.driver.promise;await close(retired.audio);
 for(const request of retired.ctx.requests.values())request.reject(new Error('canceled download'));
 await old;await tick();assert.equal(retired.stats.errors.length,0);
 const active=setup();active.driver.create(2);active.driver.start();
 const failed=assert.rejects(active.driver.promise,/HTTP 404/),position=assert.rejects(active.audio.audioPositionWorkletPromise,/HTTP 404/);
 for(const request of active.ctx.requests.values())request.reject(new Error('HTTP 404'));
 await failed;await position;await tick();assert.equal(active.stats.errors.length,1);await close(active.audio);assert.equal(active.ctx.closeCalls,1);
});

test('an old initialization cannot install nodes into a new context',async()=>{
 const s=setup();s.driver.create(2);const oldPromise=s.driver.promise;await close(s.audio);
 const current=s.init();s.driver.create(2);const newPromise=s.driver.promise;
 for(const request of s.ctx.requests.values())request.resolve();await oldPromise;await tick();assert.equal(s.driver.worklet,null);
 for(const request of current.requests.values())request.resolve();await newPromise;
 assert.equal(s.driver.worklet.context,current);await close(s.audio);assert.equal(current.closeCalls,1);assert.equal(s.ctx.closeCalls,1);
});

test('new init before the close microtask is not retired by the old driver',async()=>{
 const s=setup();s.driver.create(2);const oldPromise=s.driver.promise;
 const pending=close(s.audio),current=s.init();s.driver.create(2);const newPromise=s.driver.promise;
 for(const request of current.requests.values())request.resolve();await newPromise;
 const node=s.driver.worklet;assert.equal(node.context,current);
 await pending;assert.equal(s.driver.worklet,node);assert.equal(current.closeCalls,0);
 for(const request of s.ctx.requests.values())request.resolve();await oldPromise;await tick();
 assert.equal(s.driver.worklet,node);await close(s.audio);assert.equal(current.closeCalls,1);
});

test('source patch is repeatable and validates the complete owned sections instead of trusting a marker',()=>{
 const patched=patchAudioLifecycle(fixture);assert(patched.changed);assert.equal(patchAudioLifecycle(patched.code).changed,false);
 assert.throws(()=>patchAudioLifecycle('/* '+AUDIO_LIFECYCLE_PATCH+' */'),/E_AUDIO_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchAudioLifecycle(fixture.replace('this.pauseTime = (GodotAudio.ctx.currentTime','this.pauseTime = (GodotAudio.ctx.changedTime')),/unknown sample\._pause/);
 assert.throws(()=>patchAudioLifecycle(patched.code.replace('session.retiring = true;','session.retiring = false;')),/modified audio.close_async/);
});

test('the known v1 source is upgraded and still validates as the complete v2 patch',async()=>{
 const legacy=JSON.parse(await readFile(new URL('./fixtures/audio-v1-edits.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(fixture).digest('hex'),legacy.sourceSha256);
 let input=fixture;for(const edit of [...legacy.edits].reverse())input=input.slice(0,edit.offset)+edit.insert+input.slice(edit.offset+edit.delete);
 assert.match(input,/godotjs-audio-lifecycle-v1/);
 const upgraded=patchAudioLifecycle(input);assert.equal(upgraded.patchId,AUDIO_LIFECYCLE_PATCH);assert.equal(upgraded.changed,true);assert.equal(patchAudioLifecycle(upgraded.code).changed,false);
 assert.deepEqual(audioLifecycleFingerprints(upgraded.code,true),audioLifecycleFingerprints(patchAudioLifecycle(fixture).code,true));
});
