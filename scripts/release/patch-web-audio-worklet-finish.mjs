/** All registered audio drivers are finished, including an unselected Worklet.
 * Only its threaded finish method is owned; other Web audio patches compose. */
import {createHash} from 'node:crypto';
export const AUDIO_WORKLET_FINISH_PATH='platform/web/audio_driver_web.cpp';
export const AUDIO_WORKLET_FINISH_PATCH='godotjs-audio-worklet-finish-v1';
const signature='void AudioDriverWorklet::finish_driver() {';
const original=`void AudioDriverWorklet::finish_driver() {
\tquit = true; // Ask thread to quit.
\tthread.wait_to_finish();
}`;
const patched=`void AudioDriverWorklet::finish_driver() {
\tquit = true; // Ask thread to quit.
\t// GODOTJS_AUDIO_WORKLET_FINISH_V1: Dummy selection never starts this driver.
\tif (thread.is_started()) {
\t\tthread.wait_to_finish();
\t}
}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
export const AUDIO_WORKLET_FINISH_SOURCE_SPAN_SHA256=sha(original);
export const AUDIO_WORKLET_FINISH_PATCHED_SPAN_SHA256=sha(patched);
const occurrences=(source,value)=>source.split(value).length-1;
const reject=()=>{throw Error('E_AUDIO_WORKLET_FINISH_PATCH_UNSUPPORTED: expected pinned Godot 4.6.1 threaded Worklet finish method');};
function state(source){
 if(typeof source!=='string'||occurrences(source,signature)!==1)reject();
 if(occurrences(source,patched)===1)return 'patched';
 if(source.includes('GODOTJS_AUDIO_WORKLET_FINISH_V1'))reject();
 if(occurrences(source,original)===1)return 'original';
 reject();
}
export function patchAudioWorkletFinish(source){
 const current=state(source);
 return {code:current==='patched'?source:source.replace(original,patched),changed:current!=='patched',patchId:AUDIO_WORKLET_FINISH_PATCH};
}
export function unpatchAudioWorkletFinish(source){
 return state(source)==='patched'?source.replace(patched,original):source;
}
