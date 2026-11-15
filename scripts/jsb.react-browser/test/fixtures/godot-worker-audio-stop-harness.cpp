#include <cassert>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

// The production register_sample method is inserted below unchanged. Only
// surrounding native services and EM_ASM's return value are test doubles.
static int admission_result = 0, admission_calls = 0, native_errors = 0;
static int native_allocations = 0, instantiations = 0, starts = 0, mixes = 0, registrations = 0;
static std::vector<float> registered;
#define ERR_FAIL_COND_MSG(condition, message) do { if (condition) { ++native_errors; return; } } while (false)
#define EM_ASM_INT(...) (++admission_calls, admission_result)
struct Math { static bool is_finite(double value) { return std::isfinite(value); } };
struct CharString { std::string value; const char *get_data() const { return value.c_str(); } };
struct String {
 std::string value;
 String() = default;
 String(std::string p_value) : value(p_value) {}
 String &operator=(const char *p_value) { value = p_value; return *this; }
 CharString utf8() const { return { value }; }
};
static String itos(int64_t value) { return String(std::to_string(value)); }
template <class T> struct Ref {
 T *value = nullptr;
 Ref() = default;
 Ref(T *p_value) : value(p_value) {}
 bool is_null() const { return value == nullptr; }
 T *operator->() const { return value; }
};
struct AudioFrame { float left = 0, right = 0; };
template <class T> struct Vector {
 std::vector<T> values;
 void resize(int size) { ++native_allocations; values.resize(size); }
 T *ptrw() { return values.data(); }
 const T &operator[](int index) const { return values[index]; }
};
struct PackedFloat32Array {
 std::vector<float> values;
 void resize(int size) { ++native_allocations; values.resize(size); }
 float *ptrw() { return values.data(); }
};
struct AudioStreamPlayback {
 void start() { ++starts; }
 void mix(AudioFrame *frames, float, int count) {
  ++mixes;
  for (int i = 0; i < count; ++i) frames[i] = { 0.25f, 0.5f };
 }
};
struct AudioStream {
 AudioStreamPlayback playback;
 double get_length() const { return 0.25; }
 int64_t get_instance_id() const { return 17; }
 Ref<AudioStreamPlayback> instantiate_playback() { ++instantiations; return &playback; }
};
struct AudioSample {
 enum class LoopMode { LOOP_DISABLED, LOOP_FORWARD, LOOP_PINGPONG, LOOP_BACKWARD };
 LoopMode loop_mode = LoopMode::LOOP_FORWARD;
 Ref<AudioStream> stream;
 int loop_begin = 0, loop_end = 25;
};
class AudioDriverWeb {
 int mix_rate = 100;
public:
 void register_sample(const Ref<AudioSample> &sample);
};
static void godot_audio_sample_register_stream(const char *id, const float *data, int frames, const char *loop, int begin, int end) {
 ++registrations;
 assert(std::string(id) == "17" && std::string(loop) == "forward" && frames == 25 && begin == 0 && end == 25);
 registered.assign(data, data + frames * 2);
}

/* GODOTJS_INSERT_ACTUAL_REGISTER_SAMPLE */

int main() {
 AudioStream stream; AudioSample sample; sample.stream = &stream; AudioDriverWeb driver;
 admission_result = 1;
 driver.register_sample(&sample);
 assert(admission_calls == 1 && native_errors == 0);
 assert(native_allocations == 0 && instantiations == 0 && starts == 0 && mixes == 0 && registrations == 0);
 admission_result = 0;
 driver.register_sample(&sample);
 assert(admission_calls == 2 && native_errors == 0);
 assert(native_allocations == 2 && instantiations == 1 && starts == 1 && mixes == 1 && registrations == 1);
 assert(registered.size() == 50);
 for (int i = 0; i < 25; ++i) assert(registered[i] == 0.25f && registered[i + 25] == 0.5f);
 return 0;
}
