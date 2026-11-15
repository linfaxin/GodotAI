import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {patchAudioServerFinish} from '../../../scripts/release/patch-web-audio-server-finish.mjs';
import {digest} from '../../../scripts/release/web-release-utils.mjs';

const fixture=name=>new URL('./fixtures/'+name,import.meta.url);
test('audio shutdown source is pinned, idempotent and rejects both source and patched drift',async()=>{
 const original=await readFile(fixture('godot-4.6.1-audio-server.cpp'),'utf8');
 const patched=patchAudioServerFinish(original);
 assert.deepEqual(patchAudioServerFinish(patched.code),patched);
 assert.throws(()=>patchAudioServerFinish(original+'\n'),/E_AUDIO_SERVER_FINISH_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchAudioServerFinish(patched.code.replace('playback_list.maybe_cleanup();','playback_list.clear();')),/E_AUDIO_SERVER_FINISH_PATCH_UNSUPPORTED/);
 assert.match(patched.code,/GODOTJS_AUDIO_SERVER_FINISH_V1/);
});

test('actual AudioServer finish drains real SafeList payloads after iterators and before buses',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'audio-server-finish-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=await readFile(fixture('godot-4.6.1-audio-server.cpp'),'utf8');
 const safeList=await readFile(fixture('godot-4.6.1-safe-list.h'));
 assert.equal(digest(safeList),'b9cd8f7c2faf6bf906fbc7a09b84e7503792c34618405ce43159740986a98aff');
 await mkdir(join(root,'core/os'),{recursive:true});await mkdir(join(root,'core'),{recursive:true});
 await writeFile(join(root,'safe_list.h'),safeList);
 // Preserve the exact upstream SafeList algorithm; adapt only its allocator
 // and two engine-wide macros to the standalone native regression executable.
 await writeFile(join(root,'core/os/memory.h'),'#pragma once\nstruct DefaultAllocator {};\ninline int safe_list_nodes = 0;\ntemplate<typename T> T *tracked_new() { ++safe_list_nodes; return new T; }\ntemplate<typename T, typename A> void memdelete_allocator(T *p) { --safe_list_nodes; delete p; }\n#define memnew_allocator(T,A) tracked_new<T>()\n');
 await writeFile(join(root,'core/typedefs.h'),'#pragma once\n#include <cassert>\n#define _FORCE_INLINE_ inline\n#define ERR_PRINT(message) assert(false && message)\n');
 await copyFile(fixture('audio-server-finish-harness.cpp'),join(root,'harness.cpp'));
 const deletion=source.slice(source.indexOf('void AudioServer::_delete_stream_playback_list_node('),source.indexOf('\nbool AudioServer::thread_has_channel_mix_buffer('));
 for(const [name,code,expected]of [['original',source,23],['patched',patchAudioServerFinish(source).code,0]]){
  const finish=code.slice(code.indexOf('void AudioServer::finish() {'),code.indexOf('\n/* MISC config */'));
  assert.equal(/->stop\(|->stop_playback\(|->set_sample_playback\(/.test(finish),false,'shutdown cannot dispatch playback callbacks after scripting shutdown');
  await writeFile(join(root,'audio-functions-under-test.inc'),deletion+'\n'+finish);
  const executable=join(root,name);
  const compiled=spawnSync(process.env.CXX??'c++',['-std=c++17','-DDEBUG_ENABLED','-DEXPECT_PATCHED='+(name==='patched'?1:0),'-I',root,join(root,'harness.cpp'),'-o',executable],{encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.error?.message??compiled.stderr);
  const result=spawnSync(executable,[],{encoding:'utf8'});
  assert.equal(result.status,expected,result.stderr||String(result.signal));
 }
});
