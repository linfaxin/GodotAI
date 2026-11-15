// Runs the real pinned AudioServer finish/deletion functions with Godot's real
// SafeList. Only unrelated drivers, buses and refcounted payloads are reduced.
#include <cassert>
#include <cstdlib>
#include <functional>
#include <memory>
#include <vector>
#include "safe_list.h"

static int drivers_finished = 0;
static int buses_live = 0;
static int playbacks_live = 0;
static int samples_live = 0;
static int details_live = 0;
static int callbacks_live = 0;
static int callbacks_invoked = 0;
static bool patched = false;

template <typename T> class Ref {
	std::shared_ptr<T> value;
public:
	Ref() = default;
	explicit Ref(T *p_value) : value(p_value) {}
	T *operator->() const { return value.get(); }
	void unref() { value.reset(); }
};
template <typename T> using LocalVector = std::vector<T>;
struct AudioSamplePlayback;
struct AudioStreamPlayback {
	Ref<AudioSamplePlayback> sample;
	std::function<void()> on_destroy;
	AudioStreamPlayback() { ++playbacks_live; }
	~AudioStreamPlayback() {
		assert(drivers_finished == 2 && buses_live == 2);
		--playbacks_live;
		if (on_destroy) on_destroy();
	}
};
struct AudioSamplePlayback {
	Ref<AudioStreamPlayback> stream_playback;
	AudioSamplePlayback() { ++samples_live; }
	~AudioSamplePlayback() {
		assert(drivers_finished == 2 && buses_live == 2);
		--samples_live;
	}
};
struct Driver {
	void finish() {
		assert(buses_live == 2 && playbacks_live == 6 && details_live == 12);
		++drivers_finished;
	}
};
struct AudioDriverManager {
	static int get_driver_count() { return 2; }
	static Driver *get_driver(int) { static Driver driver; return &driver; }
};
struct Bus {
	Bus() { ++buses_live; }
	~Bus() {
		if (patched) {
			assert(playbacks_live == 0 && samples_live == 0 && details_live == 0);
			assert(callbacks_live == 0 && callbacks_invoked == 0 && safe_list_nodes == 0);
		}
		--buses_live;
	}
};
#define memdelete(p) delete p
class AudioServer {
public:
	struct AudioStreamPlaybackBusDetails {
		AudioStreamPlaybackBusDetails() { ++details_live; }
		~AudioStreamPlaybackBusDetails() {
			assert(drivers_finished == 2 && buses_live == 2);
			--details_live;
		}
	};
	struct AudioStreamPlaybackListNode {
		Ref<AudioStreamPlayback> stream_playback;
		AudioStreamPlaybackBusDetails *prev_bus_details = new AudioStreamPlaybackBusDetails;
		std::atomic<AudioStreamPlaybackBusDetails *> bus_details{new AudioStreamPlaybackBusDetails};
	};
	struct CallbackItem {
		CallbackItem() { ++callbacks_live; }
		~CallbackItem() {
			assert(drivers_finished == 2 && buses_live == 2);
			--callbacks_live;
		}
		void callback() { ++callbacks_invoked; }
	};
	SafeList<AudioStreamPlaybackListNode *> playback_list;
	SafeList<AudioStreamPlaybackBusDetails *> bus_details_graveyard;
	SafeList<AudioStreamPlaybackBusDetails *> bus_details_graveyard_frame_old;
	SafeList<CallbackItem *> mix_callback_list;
	SafeList<CallbackItem *> update_callback_list;
	SafeList<CallbackItem *> listener_changed_callback_list;
	LocalVector<Ref<AudioSamplePlayback>> sample_playback_list;
	LocalVector<Bus *> buses;
	void _delete_stream_playback_list_node(AudioStreamPlaybackListNode *p_playback_node);
	void finish();
};
#include "audio-functions-under-test.inc"

int main() {
	patched = EXPECT_PATCHED;
	AudioServer server;
	server.buses.push_back(new Bus);
	server.buses.push_back(new Bus);
	AudioServer::CallbackItem *retired_during_playback_destruction = nullptr;
	for (int i = 0; i < 2; ++i) {
		server.mix_callback_list.insert(new AudioServer::CallbackItem);
		auto *callback = new AudioServer::CallbackItem;
		server.update_callback_list.insert(callback);
		retired_during_playback_destruction = callback;
		server.listener_changed_callback_list.insert(new AudioServer::CallbackItem);
	}
	for (int i = 0; i < 4; ++i) {
		auto *node = new AudioServer::AudioStreamPlaybackListNode;
		node->stream_playback = Ref<AudioStreamPlayback>(new AudioStreamPlayback);
		if (i == 0) {
			node->stream_playback->on_destroy = [&server, retired_during_playback_destruction]() {
				server.update_callback_list.erase(retired_during_playback_destruction,
						[](AudioServer::CallbackItem *c) { delete c; });
			};
		}
		server.playback_list.insert(node);
		if (i == 3) server._delete_stream_playback_list_node(node); // Existing graveyard payload.
	}
	for (int i = 0; i < 2; ++i) {
		Ref<AudioSamplePlayback> sample(new AudioSamplePlayback);
		sample->stream_playback = Ref<AudioStreamPlayback>(new AudioStreamPlayback);
		sample->stream_playback->sample = sample; // Real sample/playback Ref cycle.
		sample->stream_playback->on_destroy = [&server]() {
			// A destructor must see the original sample list already detached.
			assert(server.sample_playback_list.empty());
		};
		server.sample_playback_list.push_back(sample);
		server.bus_details_graveyard.insert(new AudioServer::AudioStreamPlaybackBusDetails);
		server.bus_details_graveyard_frame_old.insert(new AudioServer::AudioStreamPlaybackBusDetails);
	}
	server.finish();
	if (!patched) std::_Exit(playbacks_live > 0 ? 23 : 24); // Reproduce the pinned shutdown leak.
	assert(drivers_finished == 2 && buses_live == 0);
	assert(playbacks_live == 0 && samples_live == 0 && details_live == 0);
	assert(callbacks_live == 0 && callbacks_invoked == 0 && safe_list_nodes == 0);
	assert(server.playback_list.begin() == server.playback_list.end());
	return 0;
}
