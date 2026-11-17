// Upstream Godot 4.6.1 platform/web/audio_driver_web.cpp, THREADS_ENABLED branch.
void AudioDriverWorklet::finish_driver() {
	quit = true; // Ask thread to quit.
	thread.wait_to_finish();
}
