import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {patchAudioWorkletFinish,unpatchAudioWorkletFinish,AUDIO_WORKLET_FINISH_PATCH} from '../patch-web-audio-worklet-finish.mjs';
const upstream=await readFile(new URL('./fixtures/godot-4.6.1-audio-worklet-finish.cpp',import.meta.url),'utf8');
test('unselected threaded Worklet finishes without joining a thread it never started',()=>{
 const result=patchAudioWorkletFinish(upstream);
 assert.equal(result.patchId,AUDIO_WORKLET_FINISH_PATCH);assert.equal(result.changed,true);
 assert.match(result.code,/if \(thread\.is_started\(\)\) \{\n\t\tthread\.wait_to_finish\(\);/);
 assert.equal(unpatchAudioWorkletFinish(result.code),upstream);
 assert.deepEqual(patchAudioWorkletFinish(result.code),{code:result.code,changed:false,patchId:AUDIO_WORKLET_FINISH_PATCH});
});
test('Worklet guard composes without consuming other audio edits',()=>{
 const source='// unrelated start/audio-lifecycle patch\n'+upstream+'\n// unrelated driver implementation\n';
 const patched=patchAudioWorkletFinish(source).code;
 assert.equal(unpatchAudioWorkletFinish(patched),source);
 assert.equal(patchAudioWorkletFinish(unpatchAudioWorkletFinish(patched)).code,patched);
});
test('partial, modified and duplicated Worklet cleanup implementations are rejected',()=>{
 assert.throws(()=>patchAudioWorkletFinish(upstream.replace('quit = true','quit = false')),/E_AUDIO_WORKLET_FINISH_PATCH_UNSUPPORTED/);
 assert.throws(()=>unpatchAudioWorkletFinish(patchAudioWorkletFinish(upstream).code.replace('thread.is_started()','false')),/E_AUDIO_WORKLET_FINISH_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchAudioWorkletFinish(upstream+upstream),/E_AUDIO_WORKLET_FINISH_PATCH_UNSUPPORTED/);
});
