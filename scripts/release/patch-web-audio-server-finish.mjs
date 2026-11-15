/** Godot 4.6.1 can quit before the next audio mix retires stopped playbacks.
 * Drain server-owned payloads after all drivers stop, while buses still exist.
 * SafeList callbacks must run outside every range iterator's lifetime. */
import {createHash} from 'node:crypto';
export const AUDIO_SERVER_FINISH_PATCH='godotjs-audio-server-finish-v1';
export const AUDIO_SERVER_FINISH_SOURCE_SHA256='d1b2e1c2cc909035f836d7446b07190788e8f41e4a4d59218be50f9a4096fe22';
export const AUDIO_SERVER_FINISH_PATCHED_SHA256='e3366693165b2323edb716f98eaa85290e92a3cddd1627b56dbe18f3b835075a';
const hash=source=>createHash('sha256').update(source).digest('hex');
const before=`void AudioServer::finish() {
	for (int i = 0; i < AudioDriverManager::get_driver_count(); i++) {
		AudioDriverManager::get_driver(i)->finish();
	}

	for (int i = 0; i < buses.size(); i++) {
		memdelete(buses[i]);
	}

	buses.clear();
}`;
const after=`void AudioServer::finish() {
	for (int i = 0; i < AudioDriverManager::get_driver_count(); i++) {
		AudioDriverManager::get_driver(i)->finish();
	}

	// GODOTJS_AUDIO_SERVER_FINISH_V1
	// Drivers are stopped: no future mix can retire active or fading playbacks.
	// Break sample/playback Ref cycles without dispatching stop callbacks.
	LocalVector<Ref<AudioSamplePlayback>> sample_playbacks = std::move(sample_playback_list);
	for (const Ref<AudioSamplePlayback> &sample_playback : sample_playbacks) {
		sample_playback->stream_playback.unref();
	}
	sample_playbacks.clear();

	for (AudioStreamPlaybackListNode *playback : playback_list) {
		_delete_stream_playback_list_node(playback);
	}
	// The range iterators above must be gone before deletion callbacks run.
	playback_list.maybe_cleanup();

	for (AudioStreamPlaybackBusDetails *bus_details : bus_details_graveyard) {
		bus_details_graveyard.erase(bus_details, [](AudioStreamPlaybackBusDetails *d) { delete d; });
	}
	bus_details_graveyard.maybe_cleanup();
	for (AudioStreamPlaybackBusDetails *bus_details : bus_details_graveyard_frame_old) {
		bus_details_graveyard_frame_old.erase(bus_details, [](AudioStreamPlaybackBusDetails *d) { delete d; });
	}
	bus_details_graveyard_frame_old.maybe_cleanup();

	// Playback destructors may unregister callbacks, so drain these last.
	for (CallbackItem *ci : mix_callback_list) {
		mix_callback_list.erase(ci, [](CallbackItem *c) { delete c; });
	}
	mix_callback_list.maybe_cleanup();
	for (CallbackItem *ci : update_callback_list) {
		update_callback_list.erase(ci, [](CallbackItem *c) { delete c; });
	}
	update_callback_list.maybe_cleanup();
	for (CallbackItem *ci : listener_changed_callback_list) {
		listener_changed_callback_list.erase(ci, [](CallbackItem *c) { delete c; });
	}
	listener_changed_callback_list.maybe_cleanup();

	for (int i = 0; i < buses.size(); i++) {
		memdelete(buses[i]);
	}

	buses.clear();
}`;
export function patchAudioServerFinish(source){
 const digest=hash(source);
 if(digest===AUDIO_SERVER_FINISH_PATCHED_SHA256)return {code:source,patchId:AUDIO_SERVER_FINISH_PATCH};
 if(digest!==AUDIO_SERVER_FINISH_SOURCE_SHA256)throw Error('E_AUDIO_SERVER_FINISH_PATCH_UNSUPPORTED: expected pinned Godot AudioServer');
 const code=source.replace(before,after);
 if(hash(code)!==AUDIO_SERVER_FINISH_PATCHED_SHA256)throw Error('E_AUDIO_SERVER_FINISH_PATCH_UNSUPPORTED: unexpected patch result');
 return {code,patchId:AUDIO_SERVER_FINISH_PATCH};
}
