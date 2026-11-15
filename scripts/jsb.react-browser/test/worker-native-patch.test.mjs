import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {patchWorkerRuntimeFile,workerRuntimeBuildProof,WORKER_RUNTIME_PATHS} from '../../release/patch-web-worker-runtime.mjs';
import {patchAudioLifecycle} from '../../release/patch-web-audio-lifecycle.mjs';

const fixture=async name=>readFile(new URL(`./fixtures/godot-4.6.1-${name}`,import.meta.url),'utf8');
const enginePath='platform/web/js/engine/engine.js';
const engineSource=patchWorkerRuntimeFile(enginePath,await fixture('engine.js')).code;
const audioPath='platform/web/js/libs/library_godot_audio.js';
const audioSource=patchWorkerRuntimeFile(audioPath,patchAudioLifecycle(await fixture('audio.js')).code).code;
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

function engine(worker=true){
 const scope={Promise,DOMException,Features:{},Preloader:class{preloadedFiles=[];},InternalConfig:class{args=[];gdextensionLibs=[];update(){}getGodotConfig(){return{};}}};
 if(worker)scope.WorkerGlobalScope=class{static[Symbol.hasInstance](){return true;}};
 runInNewContext(`${engineSource}\nglobalThis.TestEngine=Engine;`,scope);
 const value=new scope.TestEngine();value.init=()=>Promise.resolve();
 const runtime={calls:0,cancellations:0,initConfig(){},callMain(){this.calls++;},_godot_web_worker_cancel_start(){this.cancellations++;}};
 value.rtenv=runtime;
 return {value,runtime};
}

test('native Worker startup waits for the two-phase continuation; legacy startup stays synchronous',async()=>{
 const {value,runtime}=engine();let settled=false;const starting=value.start().then(()=>{settled=true;});
 await tick();assert.equal(runtime.calls,1);assert.equal(settled,false);assert(runtime.godotWorkerStartPromise instanceof Promise);
 runtime.godotWorkerStartResolve();await starting;assert.equal(settled,true);
 const legacy=engine(false);await legacy.value.start();assert.equal(legacy.runtime.calls,1);assert.equal(legacy.runtime.godotWorkerStartPromise,undefined);
});

test('cancel rejects the pending start once and a late native resolve cannot revive it',async()=>{
 const {value,runtime}=engine();const starting=value.start();await tick();
 runtime.godotWorkerCancelStart();runtime.godotWorkerCancelStart();
 await assert.rejects(starting,{name:'AbortError'});assert.equal(runtime.cancellations,1);
 runtime.godotWorkerStartResolve();await assert.rejects(starting,{name:'AbortError'});
});

test('actual native setup failure is preserved by the public startup promise',async()=>{
 const {value,runtime}=engine();const starting=value.start();await tick();
 const error=new Error('host prepare failed');runtime.godotWorkerStartReject(error);
 await assert.rejects(starting,error);
});

test('the native phase-1 JS continuation waits for prepare and never resumes after cancellation',async()=>{
 const source=patchWorkerRuntimeFile('platform/web/web_main.cpp',await fixture('web-main.cpp')).code;
 const script=source.match(/EM_ASM\(\{(\s*const epoch = Module\['godotWorkerBootEpoch'\][\s\S]*?)\}, godot_web_worker_audio_mix_rate\(\)/)?.[1];
 assert(script);
 let prepareResolve,preferences,resumes=0,cancels=0,error;
 const module={_godot_web_worker_resume(){resumes++;},_godot_web_worker_cancel_start(){cancels++;module.godotWorkerBootCancelled=true;module.godotWorkerBootEpoch++;},godotWorkerStartReject:value=>{error=value;}};
 const scope={Promise,Module:module,$0:0,$1:75,$2:17,UTF8ToString:p=>{assert.equal(p,17);return'AudioWorklet';},__godotWorkerAudio:{prepare:value=>{preferences=value;return new Promise(resolve=>{prepareResolve=resolve;});}}};
 runInNewContext(script,scope);await tick();assert.deepEqual({...preferences},{mixRate:0,latencyMs:75,driver:'AudioWorklet'});assert.equal(resumes,0);
 module._godot_web_worker_cancel_start();prepareResolve();await tick();assert.equal(resumes,0);assert.equal(cancels,1);assert.equal(error,undefined);
 // A fresh Worker resumes exactly once only after host preparation succeeds.
 module.godotWorkerBootCancelled=false;
 runInNewContext(`(function(){${script}})()`,scope);await tick();prepareResolve();await tick();assert.equal(resumes,1);
});

function audio(){
 const library={},calls=[],heap=new Float32Array(64),integers=new Int32Array(heap.buffer),retire=[];
 const bridge=new Proxy({available:()=>true,hasWorklet:()=>true,init:(rate,latency,state,update)=>{calls.push(['init',rate,latency]);state(1);update(.05);return{sampleRate:48000,channels:2};},close:()=>Promise.resolve(),samplePosition:()=>1.25},{get:(target,key)=>target[key]??((...args)=>calls.push([key,...args]))});
 let finished,freed=0;
 bridge.setFinishedCallback=fn=>{finished=fn;};
 const scope={console,Promise,Map,Set,Float32Array,Int32Array,Array,HEAPF32:heap,HEAP32:integers,__godotWorkerAudio:bridge,LibraryManager:{library},autoAddDeps(){},mergeInto:Object.assign,GodotOS:{atexit:fn=>retire.push(fn)},GodotRuntime:{parseString:p=>`id-${p}`,allocString:s=>s,free(){freed++;},getHeapValue:p=>integers[p>>2],setHeapValue:(p,v)=>{integers[p>>2]=v;},get_func:fn=>fn}};
 runInNewContext(audioSource,scope);
 return {library,calls,heap,integers,retire,finished:()=>finished,freed:()=>freed};
}

test('native audio imports use prepared host rate and preserve heap ownership and callbacks',async()=>{
 const s=audio();s.integers[0]=44100;let state,latency;
 assert.equal(s.library.godot_audio_is_available(),1);
 assert.equal(s.library.godot_audio_init(0,50,v=>{state=v;},v=>{latency=v;}),2);
 assert.equal(s.integers[0],48000);assert.equal(state,1);assert.equal(latency,.05);
 s.heap.set([1,2,3,4],8);
 s.library.godot_audio_sample_register_stream(3,32,2,4,0,2);
 const sample=s.calls.find(call=>call[0]==='sampleRegister');assert.equal(sample[1],'id-3');assert.deepEqual(Array.from(sample[2]),[1,2,3,4]);assert.equal(s.heap.buffer.byteLength,256);
 s.library.godot_audio_worklet_start_no_threads(0,16,()=>{},64,16,()=>{});
 const stream=s.calls.find(call=>call[0]==='streamStart')[1];assert.equal(stream.heap(),s.heap);assert.equal(stream.outSamples,16);
 assert.equal(s.library.godot_audio_get_sample_playback_position(5),1.25);
 let ended;s.library.godot_audio_sample_set_finished_callback(id=>{ended=id;});s.finished()('sample');assert.equal(ended,'sample');assert.equal(s.freed(),1);
 assert.throws(()=>s.library.godot_audio_script_create(1024,2),/E_WORKER_AUDIO_SCRIPT_PROCESSOR_UNSUPPORTED/);
 await new Promise((resolve,reject)=>s.retire[0](resolve,reject));
});

test('checked native patches reject partial/unknown source and incomplete native ABI receipts',async()=>{
 for(const [path,name]of [[enginePath,'engine.js'],['main/main.cpp','main.cpp'],['platform/web/web_main.cpp','web-main.cpp'],['platform/web/audio_driver_web.cpp','audio-driver-web.cpp'],['servers/audio/audio_server.cpp','audio-server.cpp'],['platform/web/display_server_web.cpp','display-server-web.cpp'],['platform/web/js/libs/library_godot_input.js','input.js'],['modules/webxr/native/library_godot_webxr.js','webxr.js'],['modules/webrtc/library_godot_webrtc.js','webrtc.js']]){
  const source=await fixture(name);const applied=patchWorkerRuntimeFile(path,source);
  assert.equal(patchWorkerRuntimeFile(path,applied.code).changed,false);
  assert.throws(()=>patchWorkerRuntimeFile(path,`${applied.code}\n// drift`),/E_WORKER_(?:RUNTIME|XR)_PATCH_UNSUPPORTED/);
 }
 assert.throws(()=>workerRuntimeBuildProof([]),/E_WORKER_RUNTIME_PROOF/);assert.equal(WORKER_RUNTIME_PATHS.length,10);
});

test('the actual native continuation configures explicit Dummy and rejects accidental fallback',async t=>{
 const compiler=process.env.CXX??'c++';
 if(spawnSync(compiler,['--version']).status!==0){t.skip('Native C++ compiler unavailable');return;}
 const source=patchWorkerRuntimeFile('platform/web/web_main.cpp',await fixture('web-main.cpp')).code;
 const continuation=source.match(/extern "C" EMSCRIPTEN_KEEPALIVE int godot_web_worker_resume\(\) \{[\s\S]*?\n\}\n(?=\n\/\/\/ When)/)?.[0];assert(continuation);
 const root=await mkdtemp(join(tmpdir(),'worker-native-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // Compile the production C++ continuation with deterministic native service
 // doubles. EM_ASM is separately exercised above; this checks the native order.
 const fixtureSource=`
#include <cassert>
#include <cstdlib>
#include <string>
#define EMSCRIPTEN_KEEPALIVE
#define EM_ASM(...) ((void)0)
using String=std::string;using Error=int;constexpr int OK=0;
static int worker_boot_phase=1,requested_rate=0,setups=0,starts=0,releases=0;
static const char *selected="Dummy",*actual="Dummy";
struct AudioDriverDummy { bool threads=true;int rate=-1;static AudioDriverDummy*get_dummy_singleton(){static AudioDriverDummy value;return &value;}void set_use_threads(bool value){threads=value;}void set_mix_rate(int value){rate=value;} };
struct AudioDriverManager {static constexpr int DEFAULT_MIX_RATE=44100;};
struct AudioDriver {static AudioDriver*get_singleton(){static AudioDriver value;return &value;}const char*get_name(){return actual;}};
const char*godot_web_worker_audio_driver(){return selected;}int godot_web_worker_audio_mix_rate(){return requested_rate;}
struct Main {static Error setup2(){setups++;if(String(selected)=="Dummy"){assert(!AudioDriverDummy::get_dummy_singleton()->threads);assert(AudioDriverDummy::get_dummy_singleton()->rate>0);}return OK;}};
static int start_web_runtime(){starts++;return EXIT_SUCCESS;}static void worker_release_boot_keepalive(){releases++;}
${continuation}
void reset(const char*choice,const char*driver,int rate){selected=choice;actual=driver;requested_rate=rate;worker_boot_phase=1;setups=starts=releases=0;*AudioDriverDummy::get_dummy_singleton()=AudioDriverDummy();}
int main(){
 reset("Dummy","Dummy",0);assert(godot_web_worker_resume()==EXIT_SUCCESS);assert(worker_boot_phase==3);assert(AudioDriverDummy::get_dummy_singleton()->rate==44100);assert(setups==1&&starts==1&&releases==1);
 reset("Dummy","Dummy",48000);assert(godot_web_worker_resume()==EXIT_SUCCESS);assert(AudioDriverDummy::get_dummy_singleton()->rate==48000);
 reset("AudioWorklet","AudioWorklet",0);assert(godot_web_worker_resume()==EXIT_SUCCESS);assert(AudioDriverDummy::get_dummy_singleton()->threads);assert(AudioDriverDummy::get_dummy_singleton()->rate==-1);
 reset("AudioWorklet","Dummy",0);assert(godot_web_worker_resume()==EXIT_FAILURE);assert(starts==0&&releases==1&&worker_boot_phase==-1);
 reset("Dummy","Dummy",0);worker_boot_phase=-1;assert(godot_web_worker_resume()==EXIT_FAILURE);assert(setups==0&&releases==0);
}`;
 const input=join(root,'resume.cpp'),binary=join(root,'resume');await writeFile(input,fixtureSource);
 const built=spawnSync(compiler,['-std=c++17',input,'-o',binary],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
 const result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('the main native patch receipt pins the complete independent XR helper implementation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'worker-native-xr-pin-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const main=await readFile(new URL('../../release/patch-web-worker-runtime.mjs',import.meta.url),'utf8');
 const helper=await readFile(new URL('../../release/patch-web-worker-xr.mjs',import.meta.url),'utf8');
 await writeFile(join(root,'patch-web-worker-runtime.mjs'),main);await writeFile(join(root,'patch-web-worker-xr.mjs'),helper+'\n// unbound helper modification\n');
 const isolated=await import(pathToFileURL(join(root,'patch-web-worker-runtime.mjs')).href);
 assert.throws(()=>isolated.patchWorkerRuntimeFile('modules/webxr/native/library_godot_webxr.js','unused'),/E_WORKER_XR_IMPLEMENTATION_DRIFT/);
});
