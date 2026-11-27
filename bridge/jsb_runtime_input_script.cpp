#include "jsb_runtime_input_script.h"

#ifdef GODOTJS_INPUT_SCRIPT_ABI
#include "jsb_runtime_access_common.h"
#include "core/config/engine.h"
#include "core/input/input.h"
#include "core/input/input_map.h"
#include "main/main.h"
#include <cmath>
#include <cstring>
#include <emscripten.h>

namespace jsb::input_script {
namespace {
using namespace runtime_access;

constexpr uint32_t buffer_size = 4096;
char exchange_buffer[buffer_size];

struct Edge {
    uint64_t physics = 0;
    uint32_t iteration = 0;
    Dictionary receipt() const {
        Dictionary result;
        result["physics"] = uitos(physics);
        result["iteration"] = iteration;
        return result;
    }
};

struct Script {
    uint32_t sequence = 0;
    double deadline_ms = 0;
    uint64_t base = 0;
    int press_offset = 0;
    int release_offset = 0;
    int action_id = 0;
    int keycode = 0;
    bool physical = false;
    bool key_held = false;
    int button = 0;
    int x = 0;
    int y = 0;
    int geometry_epoch = 0;
    ObjectID tree;
    ObjectID scene;
    StringName action;
    Edge down;
    Edge up;
    bool release_step_completed = false;
    CharString terminal;
};

Script script;
Ref<InputEventKey> deferred_key_release;
ObjectID deferred_key_scene;
uint32_t iteration = 0;
bool in_iteration = false;
bool closing = false;

bool active() { return script.sequence != 0 && script.terminal.length() == 0; }

// Same monotonic epoch and units as the Worker control channel's deadline.
double now_ms() { return EM_ASM_DOUBLE({ return performance.timeOrigin + performance.now(); }); }

Ref<InputEventKey> send_key(bool down, bool dispatch = true) {
    Ref<InputEventKey> event;
    event.instantiate();
    if (script.physical) event->set_physical_keycode(static_cast<Key>(script.keycode));
    else event->set_keycode(static_cast<Key>(script.keycode));
    event->set_pressed(down);
    script.key_held = down;
    Input::get_singleton()->godotjs_script_event(event, dispatch);
    return event;
}

void defer_key_release() {
    // Retire the native key now. Deliver the callback when its scene can process input.
    deferred_key_scene = script.scene;
    deferred_key_release = send_key(false, false);
}

MouseButtonMask mouse_mask() {
    return static_cast<MouseButtonMask>(1 << (script.button - 1));
}

void send_button(bool down, bool dispatch = true) {
    Input *input = Input::get_singleton();
    Ref<InputEventMouseButton> event;
    event.instantiate();
    const Point2 position(script.x, script.y);
    event->set_position(position);
    event->set_global_position(position);
    event->set_button_index(static_cast<MouseButton>(script.button));
    event->set_pressed(down);
    BitField<MouseButtonMask> mask = input->get_mouse_button_mask();
    if (down) mask.set_flag(mouse_mask());
    else mask.clear_flag(mouse_mask());
    event->set_button_mask(mask);
    input->godotjs_script_event(event, dispatch);
}

void finish(const char *reason) {
    if (!active()) return;
    Dictionary result;
    result["source"] = "native";
    if (reason) result["reason"] = reason;
    if (!script.down.physics) {
        result["kind"] = "not_executed";
    } else {
        result["kind"] = reason ? "interrupted" : "completed";
        result["base"] = uitos(script.base);
        result["down"] = script.down.receipt();
        if (script.up.physics) {
            result["up"] = script.up.receipt();
            result["releaseStepCompleted"] = script.release_step_completed;
        }
        if (reason) result["owner"] = script.up.physics ? "released" : "cleared";
        else result["finishedIteration"] = script.up.iteration;
    }
    script.terminal = stringify(result);
}

const char *unavailable() {
    if (closing) return "run_ended";
    const SceneTree *tree = SceneTree::get_singleton();
    if (!tree || tree->godotjs_is_quit_requested()) return "run_ended";
    if (tree->get_instance_id() != script.tree || !tree->get_current_scene() ||
        tree->get_current_scene()->get_instance_id() != script.scene) return "scene_changed";
    if (tree->is_paused() || tree->is_suspended()) return "paused";
    if (Input::get_singleton()->is_input_disabled()) return "input_disabled";
    if (script.action_id) {
        const auto *action = InputMap::get_singleton()->get_action_map().getptr(script.action);
        if (!action || action->id != script.action_id) return "action_changed";
    }
    if (now_ms() >= script.deadline_ms) return "timeout";
    return nullptr;
}

bool outside_callbacks() {
    return Thread::is_main_thread() && !in_iteration && !Main::is_iterating() && !NativeWorld::inside_interop();
}

bool read_command(const Dictionary &command, String &name) {
    if (!read_integer(command, "pressOffset", -1, 0, 119, script.press_offset)) return false;
    if (command.has("button")) {
        return keys(command, {"button", "x", "y", "geometryEpoch", "pressOffset", "releaseOffset", "deadline"}) &&
            read_integer(command, "releaseOffset", -1, script.press_offset, script.press_offset, script.release_offset) &&
            read_integer(command, "button", -1, 1, 3, script.button) &&
            read_integer(command, "x", -1, 0, 65535, script.x) &&
            read_integer(command, "y", -1, 0, 65535, script.y) &&
            read_integer(command, "geometryEpoch", -1, 1, 0x7fffffff, script.geometry_epoch);
    }
    if (!read_integer(command, "releaseOffset", -1, script.press_offset + 1, 120, script.release_offset)) return false;
    if (command.has("keycode")) {
        if (!keys(command, {"keycode", "physical", "pressOffset", "releaseOffset", "deadline"}) ||
            !read_integer(command, "keycode", -1, 1, 0x7fffff, script.keycode) ||
            command["physical"].get_type() != Variant::BOOL) return false;
        script.physical = command["physical"];
        return true;
    }
    return keys(command, {"actionName", "pressOffset", "releaseOffset", "deadline"}) &&
        valid_name(command["actionName"], name) && name.utf8().length() <= 128;
}
} // namespace

char *buffer() { return exchange_buffer; }

uint32_t stage(uint32_t sequence, uint32_t size, uint32_t remaining_us) {
    if (!sequence || script.sequence || !outside_callbacks()) return 0;
    const double entered_ms = now_ms();
    script.sequence = sequence;
    std::shared_ptr<NativeWorld> world;
    const SceneTree *tree = nullptr;
    const char *failure = closing ? "run_ended" : active_scene_error(world, tree);
    if (!failure && (!tree->get_current_scene() || tree->godotjs_is_quit_requested())) failure = "not_ready";
    if (!failure && !remaining_us) failure = "timeout";
    Dictionary command;
    String name;
    if (!failure && (remaining_us > 30000000 || size > buffer_size ||
        !unicode_escapes_valid(exchange_buffer, size) || !parse_request(exchange_buffer, size, command) ||
        !read_command(command, name))) {
        failure = "invalid_input";
    }
    if (!failure) {
        const Variant deadline = command["deadline"];
        if (deadline.get_type() != Variant::FLOAT && deadline.get_type() != Variant::INT) failure = "invalid_input";
        else {
            script.deadline_ms = static_cast<double>(deadline);
            if (!std::isfinite(script.deadline_ms) || script.deadline_ms <= 0 || script.deadline_ms > entered_ms + 30000)
                failure = "invalid_input";
            else if (now_ms() >= script.deadline_ms) failure = "timeout";
        }
    }
    if (!failure && !name.is_empty()) {
        script.action = StringName(name);
        const auto *action = InputMap::get_singleton()->get_action_map().getptr(script.action);
        if (!action) failure = "unknown_action";
        else script.action_id = action->id;
    }
    if (!failure) {
        script.tree = tree->get_instance_id();
        script.scene = tree->get_current_scene()->get_instance_id();
        failure = unavailable();
    }
    if (failure) finish(failure);
    return 1;
}

void cancel(uint32_t sequence, uint32_t reason) {
    if (sequence != script.sequence || !outside_callbacks()) return;
    finish(reason == 1 ? "timeout" : reason == 2 ? "run_ended" : reason == 3 ? "hidden" : "cancelled");
    if (script.key_held) {
        if (reason == 2) send_key(false, false);
        else defer_key_release();
    }
}

uint32_t take(uint32_t sequence) {
    if (sequence != script.sequence || !outside_callbacks() || !script.terminal.length() || script.key_held) return 0;
    const uint32_t size = script.terminal.length();
    if (size > buffer_size) return 0;
    std::memcpy(exchange_buffer, script.terminal.get_data(), size);
    script = {};
    return size;
}

void begin_iteration(uint32_t serial) {
    iteration = serial;
    in_iteration = true;
    const SceneTree *tree = SceneTree::get_singleton();
    if (tree && (tree->is_paused() || tree->is_suspended())) {
        if (script.key_held && !active()) defer_key_release();
        return;
    }
    if (deferred_key_release.is_valid()) {
        Ref<InputEventKey> event = deferred_key_release;
        deferred_key_release.unref();
        if (tree && tree->get_current_scene() && tree->get_current_scene()->get_instance_id() == deferred_key_scene)
            Input::get_singleton()->godotjs_script_event(event, true);
    }
    if (script.key_held && !active()) send_key(false);
}

void before_physics() {
    if (!in_iteration || !active() || script.up.physics) return;
    if (const char *failure = unavailable()) { finish(failure); return; }
    const uint64_t frame = Engine::get_singleton()->get_physics_frames() + 1;
    if (!script.base) script.base = frame;
    Input *input = Input::get_singleton();
    if (frame == script.base + script.press_offset) {
        if (script.button) {
            const bool fits = EM_ASM_INT({
                return Module['godotInputScriptClickFits'] && Module['godotInputScriptClickFits']($0, $1, $2);
            }, script.geometry_epoch, script.x, script.y);
            if (!fits) { finish("geometry_conflict"); return; }
            if (input->get_mouse_button_mask().has_flag(mouse_mask())) { finish("busy"); return; }
        }
        if (script.keycode) {
            const Key key = static_cast<Key>(script.keycode);
            if (script.physical ? input->is_physical_key_pressed(key) : input->is_key_pressed(key)) {
                finish("busy");
                return;
            }
        }
        script.down = {frame, iteration};
        if (script.keycode) send_key(true);
        if (script.button) {
            send_button(true);
            if (active()) script.up = {frame, iteration};
            send_button(false, active());
            return;
        }
    }
    if (active() && frame == script.base + script.release_offset) {
        script.up = {frame, iteration};
        if (script.key_held) send_key(false);
    }
}

void after_physics() {
    if (!in_iteration || !active()) return;
    if (script.up.physics == Engine::get_singleton()->get_physics_frames() && script.up.physics)
        script.release_step_completed = true;
    if (const char *failure = unavailable()) finish(failure);
}

void end_iteration(bool exiting) {
    closing = closing || exiting;
    in_iteration = false;
    if (active()) {
        if (const char *failure = unavailable()) finish(failure);
        else if (script.release_step_completed) finish(nullptr);
    }
    if (exiting && script.key_held) send_key(false, false);
    if (exiting) deferred_key_release.unref();
}

bool pressed(const StringName &action) {
    if (!active() || !in_iteration || !script.down.physics || script.up.physics || action != script.action ||
        !Engine::get_singleton()->is_in_physics_frame()) return false;
    if (const char *failure = unavailable()) { finish(failure); return false; }
    return true;
}

void pause() { finish("paused"); }
void scene_will_change(const Node *current, const Node *next) {
    if (current != next) {
        deferred_key_release.unref();
        finish("scene_changed");
    }
}
void reset() { finish("input_reset"); }
void release(const StringName &action) {
    if (script.action == action) finish("action_released");
}
} // namespace jsb::input_script
#endif
