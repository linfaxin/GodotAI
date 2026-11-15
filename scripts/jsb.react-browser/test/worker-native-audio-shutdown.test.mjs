import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {patchWorkerRuntimeFile,WORKER_RUNTIME_PATHS} from '../../release/patch-web-worker-runtime.mjs';

const nativePath='servers/audio/audio_server.cpp';
const original=await readFile(new URL('./fixtures/godot-4.6.1-audio-server.cpp',import.meta.url),'utf8');
const safeList=await readFile(new URL('./fixtures/godot-4.6.1-safe-list.h',import.meta.url),'utf8');
const sha=source=>createHash('sha256').update(source).digest('hex');
const method=source=>source.match(/void AudioServer::finish\(\) \{[\s\S]*?\n\}/)?.[0];
const patched=patchWorkerRuntimeFile(nativePath,original).code;
const deletion=original.match(/void AudioServer::_delete_stream_playback_list_node\([^]*?\n\}/)?.[0];
assert(method(original)&&method(patched)&&deletion);

test('shutdown patch pins upstream 4.6.1, composes once, and rejects changed or partial ownership cleanup',()=>{
 assert.equal(sha(original),'d1b2e1c2cc909035f836d7446b07190788e8f41e4a4d59218be50f9a4096fe22');
 assert.equal(sha(safeList),'b9cd8f7c2faf6bf906fbc7a09b84e7503792c34618405ce43159740986a98aff');
 assert(WORKER_RUNTIME_PATHS.includes(nativePath));assert.equal(WORKER_RUNTIME_PATHS.length,10);
 assert.equal(patchWorkerRuntimeFile(nativePath,original).changed,true);assert.equal(patchWorkerRuntimeFile(nativePath,patched).changed,false);
 for(const changed of [original+'\n// drift',patched.replace('sample_playback_list.clear();','sample_playback_list.clear(); // altered'),patched.replace('playback_list.maybe_cleanup();\n\t{','playback_list.maybe_cleanup();\n\t/* partial */ {')])assert.throws(()=>patchWorkerRuntimeFile(nativePath,changed),/E_WORKER_RUNTIME_PATCH_UNSUPPORTED/);
 const body=method(patched);assert(body.indexOf('->finish();')<body.indexOf('GODOTJS_THREADLESS_AUDIO_SHUTDOWN_V1'));assert(body.indexOf('GODOTJS_THREADLESS_AUDIO_SHUTDOWN_V1')<body.indexOf('memdelete(buses[i])'));
 assert(!body.includes('stream_playback->stop('),'ScriptServer has already shut down: do not reenter user playback virtuals');
});

// The SafeList implementation is the complete, byte-pinned Godot header, not a JS/list imitation.
// Only allocator macros and the surrounding AudioServer services are small native test doubles.
// Ref below uses real shared ownership/destructors to model the retained playback -> microphone
// and playback <-> sample chains; this is a lifecycle unit, not a full-engine acceptance claim.
const memoryHeader=String.raw`
#pragma once
#include <cstddef>
struct DefaultAllocator {};
extern int safe_nodes;
template<class T>T* tracked_new(){++safe_nodes;return new T;}
template<class T,class A>void memdelete_allocator(T* value){--safe_nodes;delete value;}
#define memnew_allocator(Type,Allocator) tracked_new<Type>()
`;
const typedefHeader=String.raw`
#pragma once
#define _FORCE_INLINE_ inline
extern int safe_errors;
#define ERR_PRINT(message) (++safe_errors)
`;
const harness=finish=>String.raw`
#include <cassert>
#include <memory>
#include <vector>
#include <functional>
#include <utility>
#include <iostream>
int safe_nodes=0,safe_errors=0;
#include "core/templates/safe_list.h"
#define memdelete(value) delete value
static bool drivers_finished=false,languages_closed=true,bus_freed_too_early=false;
static int driver_finishes=0,microphones=0,playbacks=0,samples=0,details=0,buses_live=0,virtual_stops=0,native_mic_stops=0,node_deletes=0,release_callbacks=0,sample_reentries=0;
template<class T>struct Ref {
 std::shared_ptr<T> value;
 Ref()=default;Ref(std::nullptr_t){};explicit Ref(std::shared_ptr<T> v):value(std::move(v)){}
 bool is_valid()const{return bool(value);}T*operator->()const{return value.get();}void unref(){value.reset();}
};
struct AudioSamplePlayback;struct AudioStreamPlayback;
struct Microphone {Microphone(){++microphones;}~Microphone(){assert(drivers_finished);--microphones;}};
struct AudioStreamPlayback {
 Ref<Microphone> microphone;Ref<AudioSamplePlayback> sample;bool scripted=false;std::function<void()> released;
 AudioStreamPlayback(){++playbacks;}
 virtual ~AudioStreamPlayback(){assert(drivers_finished);if(sample.is_valid())++sample_reentries;if(microphone.is_valid())++native_mic_stops;--playbacks;if(released)released();}
 virtual void stop(){++virtual_stops;assert(!languages_closed&&"shutdown must not reenter a closed script language");}
 void set_sample_playback(Ref<AudioSamplePlayback> value){sample=std::move(value);}
};
struct AudioSamplePlayback {Ref<AudioStreamPlayback> stream_playback;AudioSamplePlayback(){++samples;}~AudioSamplePlayback(){assert(drivers_finished);--samples;}};
struct AudioStreamPlaybackBusDetails {AudioStreamPlaybackBusDetails(){++details;}~AudioStreamPlaybackBusDetails(){assert(drivers_finished);--details;}};
struct Bus {Bus(){++buses_live;}~Bus(){if(playbacks||samples||details)bus_freed_too_early=true;--buses_live;}};
struct Driver {std::function<void()> finishing;void finish(){drivers_finished=true;++driver_finishes;if(finishing){auto fn=std::move(finishing);finishing={};fn();}}};
struct AudioDriverManager {static Driver driver;static int get_driver_count(){return 1;}static Driver*get_driver(int){return &driver;}};
Driver AudioDriverManager::driver;
class AudioServer {
public:
 struct AudioStreamPlaybackListNode {
  enum PlaybackState {PLAYING,FADE_OUT_TO_DELETION,AWAITING_DELETION};
  std::atomic<PlaybackState> state=PLAYING;Ref<AudioStreamPlayback> stream_playback;
  std::atomic<AudioStreamPlaybackBusDetails*>bus_details=nullptr;AudioStreamPlaybackBusDetails*prev_bus_details=nullptr;
 };
 SafeList<AudioStreamPlaybackListNode*>playback_list;
 SafeList<AudioStreamPlaybackBusDetails*>bus_details_graveyard,bus_details_graveyard_frame_old;
 std::vector<Ref<AudioSamplePlayback>>sample_playback_list;std::vector<Bus*>buses;
 void finish();void _delete_stream_playback_list_node(AudioStreamPlaybackListNode*);
 AudioStreamPlaybackListNode*add(std::shared_ptr<AudioStreamPlayback> playback,AudioStreamPlaybackListNode::PlaybackState state){auto*node=new AudioStreamPlaybackListNode;node->stream_playback=Ref<AudioStreamPlayback>(std::move(playback));node->state.store(state);node->bus_details.store(new AudioStreamPlaybackBusDetails);node->prev_bus_details=new AudioStreamPlaybackBusDetails;playback_list.insert(node);return node;}
};
${deletion.replace('delete p;', '++node_deletes; delete p;')}
${finish}
int main(){
 {
  AudioServer server;server.buses.push_back(new Bus);
  auto mic=std::make_shared<Microphone>();auto active=std::make_shared<AudioStreamPlayback>();active->microphone=Ref<Microphone>(mic);
  std::weak_ptr<Microphone>weak_mic=mic;std::weak_ptr<AudioStreamPlayback>weak_active=active;
  server.add(active,AudioServer::AudioStreamPlaybackListNode::PLAYING);mic.reset();active.reset();
  auto script=std::make_shared<AudioStreamPlayback>();script->scripted=true;
  script->released=[&]{++release_callbacks;assert(server.playback_list.maybe_cleanup()&&"deletion callback ran with an active SafeList iterator");};
  std::weak_ptr<AudioStreamPlayback>weak_script=script;server.add(script,AudioServer::AudioStreamPlaybackListNode::FADE_OUT_TO_DELETION);script.reset();
  // A previously queued deletion must execute exactly once alongside newly retired nodes.
  auto queued=std::make_shared<AudioStreamPlayback>();std::weak_ptr<AudioStreamPlayback>weak_queued=queued;auto*queued_node=server.add(queued,AudioServer::AudioStreamPlaybackListNode::AWAITING_DELETION);queued.reset();
  AudioDriverManager::driver.finishing=[&]{server._delete_stream_playback_list_node(queued_node);};
  // Cover a sample cycle both with and without an additional server playback-list reference.
  auto a=std::make_shared<AudioSamplePlayback>(),b=std::make_shared<AudioSamplePlayback>(),empty=std::make_shared<AudioSamplePlayback>();
  auto pa=std::make_shared<AudioStreamPlayback>(),pb=std::make_shared<AudioStreamPlayback>();
  a->stream_playback=Ref<AudioStreamPlayback>(pa);pa->sample=Ref<AudioSamplePlayback>(a);
  b->stream_playback=Ref<AudioStreamPlayback>(pb);pb->sample=Ref<AudioSamplePlayback>(b);
  server.add(pb,AudioServer::AudioStreamPlaybackListNode::PLAYING);
  server.sample_playback_list={Ref<AudioSamplePlayback>(a),Ref<AudioSamplePlayback>(b),Ref<AudioSamplePlayback>(empty),Ref<AudioSamplePlayback>()};
  std::weak_ptr<AudioSamplePlayback>weak_a=a,weak_b=b;std::weak_ptr<AudioStreamPlayback>weak_pa=pa,weak_pb=pb;
  a.reset();b.reset();empty.reset();pa.reset();pb.reset();
  // Both active graveyard heads and an already erased graveyard entry own native bus-detail data.
  server.bus_details_graveyard.insert(new AudioStreamPlaybackBusDetails);
  server.bus_details_graveyard_frame_old.insert(new AudioStreamPlaybackBusDetails);
  auto*old=new AudioStreamPlaybackBusDetails;server.bus_details_graveyard.insert(old);server.bus_details_graveyard.erase(old,[](auto*value){delete value;});
  server.finish();
#if defined(WEB_ENABLED) && !defined(THREADS_ENABLED) && defined(EXPECT_FIXED)
  assert(driver_finishes==1);assert(!bus_freed_too_early);assert(microphones==0&&playbacks==0&&samples==0&&details==0&&buses_live==0);
  assert(weak_mic.expired()&&weak_active.expired()&&weak_script.expired()&&weak_queued.expired());assert(weak_a.expired()&&weak_b.expired()&&weak_pa.expired()&&weak_pb.expired());
  assert(node_deletes==4&&release_callbacks==1&&native_mic_stops==1&&virtual_stops==0&&sample_reentries==0);assert(safe_nodes==0&&safe_errors==0);
  // Repeating shutdown retires no second node and runs no stale sample/deletion callback.
  server.finish();assert(driver_finishes==2);assert(node_deletes==4&&release_callbacks==1&&native_mic_stops==1&&safe_nodes==0&&safe_errors==0);
#else
  // Original threadless finish retains active refs; the patched non-Web/threaded branches must
  // remain byte/behavior compatible with that original method rather than applying a global fix.
  if(!weak_mic.expired()&&!weak_active.expired()&&!weak_a.expired()&&!weak_pa.expired()&&virtual_stops==0)return 17;
  return 18;
#endif
 }
 assert(safe_nodes==0&&safe_errors==0);std::cout<<"owned playback/sample/history references retired exactly once\n";return 0;
}
`;

const compiler=process.env.CXX??'c++';
const compilerAvailable=spawnSync(compiler,['--version'],{stdio:'ignore'}).status===0;
test('actual pinned SafeList and production finish/delete code retire native ownership after driver shutdown', {skip:!compilerAvailable,timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'worker-native-audio-shutdown-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(join(directory,'core/os'),{recursive:true});await mkdir(join(directory,'core/templates'),{recursive:true});
 await writeFile(join(directory,'core/templates/safe_list.h'),safeList);await writeFile(join(directory,'core/os/memory.h'),memoryHeader);await writeFile(join(directory,'core/typedefs.h'),typedefHeader);
 for(const [name,finish,defines,expected]of [
  ['upstream-threadless-web',method(original),['WEB_ENABLED'],17],
  ['fixed-threadless-web',method(patched),['WEB_ENABLED','EXPECT_FIXED'],0],
  ['unchanged-threaded-web',method(patched),['WEB_ENABLED','THREADS_ENABLED'],17],
  ['unchanged-native-threadless',method(patched),[],17],
 ]){
  const file=join(directory,name+'.cpp'),binary=join(directory,name);await writeFile(file,harness(finish));
  const build=spawnSync(compiler,['-std=c++17','-O1','-DDEBUG_ENABLED',...defines.map(value=>'-D'+value),'-I',directory,file,'-o',binary],{encoding:'utf8',timeout:30000});
  assert.equal(build.status,0,name+': '+build.stderr);const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,expected,name+': '+run.stderr+' '+run.stdout);
 }
});
