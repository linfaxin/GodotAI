#include "jsb_runtime_observation.h"
#include "jsb_runtime_game_probe.h"
#include "jsb_runtime_access_common.h"
#include "jsb_native_world.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/math/math_funcs.h"
#include "core/os/thread.h"
#include "core/os/os.h"
#include "main/main.h"
#include "scene/2d/node_2d.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include <cstring>
#include <limits>
#include <locale>
#include <sstream>
#include <string>
#include <vector>
#include <utility>

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
#include <emscripten/emscripten.h>
#endif

namespace jsb {
namespace {
using namespace runtime_access;

constexpr int MAX_PATH_BYTES = 2048;
constexpr int MAX_PATH_COMPONENTS = 128;
constexpr int MAX_CHILDREN_PER_PARENT = 512;
constexpr int MAX_CHILD_CACHE_WORK = 2048;
constexpr int RESULT_ENVELOPE_RESERVE = 128;





















Dictionary node_description(const Node* node, const String& path, const Variant& parent_path) {
    Dictionary description;
    description["path"] = path;
    description["parentPath"] = parent_path;
    description["name"] = String(node->get_name());
    description["type"] = node->get_class();
    description["instanceId"] = instance_id(node);
    return description;
}

Dictionary read_tree(const SceneTree* tree, Node* root, const String& root_path, int path_components, int depth, int limit, bool freeze_only = false) {
    struct Visit {
        Node* node;
        String path;
        Variant parent_path;
        int level;
    };
    std::vector<Visit> pending{{root, root_path, Variant(), 0}};
    Array nodes;
    int work_remaining = MAX_CHILD_CACHE_WORK;
    int bytes_remaining = RUNTIME_OBSERVATION_RESULT_BYTES - RESULT_ENVELOPE_RESERVE;
    const char* truncation_reason = nullptr;
    while (!pending.empty()) {
        if (nodes.size() == limit) {
            if (!truncation_reason) truncation_reason = "node_limit";
            break;
        }
        const Visit current = pending.back();
        pending.pop_back();

        const Dictionary description = node_description(current.node, current.path, current.parent_path);
        // In a render callback use a conservative JSON bound. Escape expansion is
        // at most six bytes per UTF-8 byte, and the scalar fields are bounded.
        const int bytes = freeze_only ? 320 + 6 * (current.path.utf8().length() +
            (current.parent_path.get_type() == Variant::STRING ? String(current.parent_path).utf8().length() : 0) + String(current.node->get_name()).utf8().length() +
            String(current.node->get_class()).utf8().length()) :
            JSON::stringify(description, "", false, true).utf8().length() + 1;
        if (bytes > bytes_remaining) {
            truncation_reason = "byte_budget";
            break;
        }
        bytes_remaining -= bytes;
        nodes.push_back(description);

        if (current.level >= depth) continue;
        const int total_children = current.node->get_child_count(true);
        if (total_children == 0) continue;
        // External child access can rebuild and sort a dirty cache including
        // internal children. Pay for that table before accessing it.
        if (total_children > MAX_CHILDREN_PER_PARENT || total_children > work_remaining) {
            if (!truncation_reason) truncation_reason = "work_budget";
            continue;
        }
        work_remaining -= total_children;
        for (int index = current.node->get_child_count(false) - 1; index >= 0; --index) {
            Node* child = current.node->get_child(index, false);
            if (!is_public_node(child, tree)) continue;
            const String child_name = child->get_name();
            if (path_components + current.level >= MAX_PATH_COMPONENTS || !valid_component(child_name)) {
                if (!truncation_reason) truncation_reason = "work_budget";
                continue;
            }
            const String child_path = current.path + "/" + child_name;
            if (child_path.utf8().length() > MAX_PATH_BYTES) {
                if (!truncation_reason) truncation_reason = "byte_budget";
                continue;
            }
            pending.push_back({child, child_path, current.path, current.level + 1});
        }
    }
    Dictionary result;
    result["nodes"] = nodes;
    result["truncated"] = truncation_reason != nullptr;
    if (truncation_reason) result["truncationReason"] = truncation_reason;
    return success_reply(result);
}

Dictionary read_node(Node* node, const String& path, bool is_root, const Array& properties) {
    const Node2D* node_2d = Object::cast_to<Node2D>(node);
    const CanvasItem* canvas_item = Object::cast_to<CanvasItem>(node);
    Array observations;
    for (int index = 0; index < properties.size(); ++index) {
        const String name = properties[index];
        Dictionary observation;
        observation["name"] = name;
        // Do not use Object::get: it may execute a user script or extension.
        if (name == "visible" && canvas_item) {
            observation["value"] = canvas_item->is_visible();
        } else if (name == "position" && node_2d) {
            const Vector2 position = node_2d->get_position();
            if (Math::is_finite(position.x) && Math::is_finite(position.y)) observation["value"] = coordinates(position);
            else observation["unavailable"] = "non_finite";
        } else if (name == "rotation" && node_2d) {
            const real_t rotation = node_2d->get_rotation();
            if (Math::is_finite(rotation)) observation["value"] = rotation;
            else observation["unavailable"] = "non_finite";
        } else {
            observation["unavailable"] = "unsupported_node_type";
        }
        observations.push_back(observation);
    }
    Dictionary result;
    result["node"] = node_description(node, path, is_root ? Variant() : Variant(path.substr(0, path.rfind_char('/'))));
    result["properties"] = observations;
    return success_reply(result);
}

Dictionary observe(const Dictionary& request) {
    const Variant raw_kind = request.get("kind", Variant());
    if (raw_kind.get_type() != Variant::STRING) return error_reply("invalid_input", "Observation kind is required");
    const String kind = raw_kind;
    if (kind != "tree" && kind != "node") return error_reply("invalid_input", "Unknown observation kind");

    String path;
    Vector<String> components;
    if ((kind == "node" || request.has("path")) && !read_path(request.get("path", Variant()), path, components)) {
        return error_reply("invalid_input", "Expected a bounded absolute runtime node path");
    }
    int depth = 0;
    int limit = 0;
    Array properties;
    if (kind == "tree") {
        if (!read_integer(request, "depth", 2, 0, 8, depth) || !read_integer(request, "limit", 200, 1, 500, limit)) {
            return error_reply("invalid_input", "Invalid runtime tree depth or node limit");
        }
    } else {
        const Variant raw = request.get("properties", Variant());
        if (raw.get_type() != Variant::ARRAY) return error_reply("invalid_input", "Runtime node properties are required");
        properties = raw;
        if (properties.is_empty() || properties.size() > 3) return error_reply("invalid_input", "Expected one to three runtime node properties");
        for (int index = 0; index < properties.size(); ++index) {
            const Variant property = properties[index];
            if (property.get_type() != Variant::STRING || (property != "visible" && property != "position" && property != "rotation") || properties.find(property) != index) {
                return error_reply("invalid_input", "Unknown or duplicate runtime node property");
            }
        }
    }

    std::shared_ptr<NativeWorld> world;
    const SceneTree* tree = nullptr;
    if (const char* error = active_scene_error(world, tree)) return error_reply(error, "The active native scene tree is unavailable");

    Node* node = find_node(tree, components);
    if (!node) return error_reply("node_not_found", "The node is absent from the active runtime tree");
    if (components.is_empty() && !read_path(String("/") + String(node->get_name()), path, components)) {
        return error_reply("observation_failed", "The runtime root path cannot be represented");
    }
    if (kind == "tree") return read_tree(tree, node, path, components.size(), depth, limit);
    return read_node(node, path, node == tree->get_root(), properties);
}



bool read_coordinate(const Variant& value, const std::vector<double>& numbers, real_t& coordinate) {
    if (value.get_type() != Variant::INT && value.get_type() != Variant::FLOAT) return false;
    const double index = value;
    if (index < 0 || index >= numbers.size()) return false;
    const double number = numbers[static_cast<size_t>(index)];
    constexpr double max = std::numeric_limits<real_t>::max();
    if (!Math::is_finite(number) || number < -max || number > max) return false;
    coordinate = static_cast<real_t>(number);
    return Math::is_finite(coordinate);
}

Dictionary write_unconfirmed(const char* reason) {
    Dictionary result;
    result["outcome"] = "unconfirmed";
    result["reason"] = reason;
    return success_reply(result);
}

Dictionary write_position(const Dictionary& request, const std::vector<double>& numbers) {
    String path, expected_id;
    Vector<String> components;
    const Variant raw_value = request.get("value", Variant());
    if (request.size() != 4 || request.get("property", Variant()) != "position" ||
        !read_path(request.get("path", Variant()), path, components) ||
        !read_instance_id(request.get("expectedInstanceId", Variant()), expected_id) ||
        raw_value.get_type() != Variant::DICTIONARY) {
        return error_reply("invalid_input", "Expected an absolute node path, instance ID and position");
    }
    const Dictionary value = raw_value;
    Vector2 requested;
    if (value.size() != 2 || !read_coordinate(value.get("x", Variant()), numbers, requested.x) ||
        !read_coordinate(value.get("y", Variant()), numbers, requested.y)) {
        return error_reply("invalid_input", "Expected two finite coordinates in the engine's real range");
    }

    std::shared_ptr<NativeWorld> world;
    const SceneTree* tree = nullptr;
    if (const char* error = active_scene_error(world, tree)) return error_reply(error, "The active native scene tree is unavailable");
    Node* node = find_node(tree, components);
    if (!node) return error_reply("node_not_found", "The node is absent from the active runtime tree");
    if (instance_id(node) != expected_id) return error_reply("node_changed", "The runtime node instance has changed");
    Node2D* node_2d = Object::cast_to<Node2D>(node);
    if (!node_2d) return error_reply("unsupported_node_type", "Position writes require a Node2D");

    {
        NativeInteropScope in_setter;
        node_2d->set_position(requested);
    }
    // A synchronous transform notification can remove or replace the node.
    std::shared_ptr<NativeWorld> current_world;
    const SceneTree* current_tree = nullptr;
    if (active_scene_error(current_world, current_tree) || current_world != world || current_tree != tree) {
        return write_unconfirmed("target_changed");
    }
    node = find_node(current_tree, components);
    if (!node || instance_id(node) != expected_id) return write_unconfirmed("target_changed");
    node_2d = Object::cast_to<Node2D>(node);
    if (!node_2d) return write_unconfirmed("target_changed");
    const Vector2 observed = node_2d->get_position();
    if (!Math::is_finite(observed.x) || !Math::is_finite(observed.y)) return write_unconfirmed("readback_failed");
    Dictionary result;
    result["outcome"] = observed == requested ? "applied" : "not_applied";
    result["observedValue"] = coordinates(observed);
    return success_reply(result);
}

// Godot's JSON decimal conversion can move a value across a rounding boundary.
// Parse number tokens separately and let Godot validate the JSON structure
// with exact, small integer indices substituted for those tokens.




} // namespace

CharString sample_runtime_observation(const char* request, uint32_t size) {
    Dictionary parsed;
    const Dictionary reply = parse_request(request, size, parsed) ? observe(parsed) :
        error_reply("invalid_input", "Expected a bounded UTF-8 JSON request");
    return JSON::stringify(reply, "", false, true).utf8();
}

CharString execute_runtime_write(const char* request, uint32_t size) {
    Dictionary parsed;
    std::vector<double> numbers;
    const Dictionary reply = parse_request(request, size, parsed, &numbers) ? write_position(parsed, numbers) :
        error_reply("invalid_input", "Expected a bounded UTF-8 JSON request");
    return JSON::stringify(reply, "", false, true).utf8();
}

} // namespace jsb


#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
namespace jsb::game_probe {
namespace {
using namespace runtime_access;

struct ProbeProperty {
    String path;
    Vector<String> components;
    String name;
};

struct ProbeQuery {
    bool rendered = false;
    bool tree = false;
    String tree_path;
    Vector<String> tree_components;
    int depth = 2;
    int limit = 200;
    std::vector<ProbeProperty> properties;
};

struct PendingProbe {
    uint64_t deadline_us = 0;
    uint64_t world_id = 0;
    RID root;
    ProbeQuery query;
    Dictionary sample;
    bool finished = false;
    bool copied = false;
};

PendingProbe pending;
bool armed_draw = false;
bool normal_draw = false;
bool root_viewport = false;
bool root_blit = false;
unsigned commits = 0;

bool read_query(const Dictionary& input, ProbeQuery& query) {
    int max_dimension;
    if (!keys(input, {"screenshot", "props", "maxDimension"}, {"tree"}) ||
        input["screenshot"].get_type() != Variant::BOOL || input["props"].get_type() != Variant::ARRAY ||
        !read_integer(input, "maxDimension", 1024, 16, 1024, max_dimension))
        return false;
    query.rendered = input["screenshot"];
    const Array props = input["props"];
    if (props.size() > 16) return false;
    for (const Variant& item : props) {
        if (item.get_type() != Variant::DICTIONARY) return false;
        const Dictionary raw = item;
        ProbeProperty property;
        if (!keys(raw, {"path", "property"}) || !read_path(raw["path"], property.path, property.components) ||
            !valid_name(raw["property"], property.name) || property.name.contains(":"))
            return false;
        for (const ProbeProperty& previous : query.properties)
            if (previous.path == property.path && previous.name == property.name) return false;
        query.properties.push_back(std::move(property));
    }
    if (input.has("tree")) {
        if (input["tree"].get_type() != Variant::DICTIONARY) return false;
        const Dictionary tree = input["tree"];
        if (!keys(tree, {"depth", "limit"}, {"path"}) ||
            !read_integer(tree, "depth", 2, 1, 8, query.depth) ||
            !read_integer(tree, "limit", 200, 1, 500, query.limit) ||
            (tree.has("path") && !read_path(tree["path"], query.tree_path, query.tree_components)))
            return false;
        query.tree = true;
    }
    return true;
}

const char* probe_scene(const SceneTree*& tree) {
    const auto world = NativeWorld::current();
    const Engine* engine = Engine::get_singleton();
    tree = SceneTree::get_singleton();
    if (!world || world->id() != pending.world_id || world->is_closing() ||
        (tree && tree->godotjs_is_quit_requested())) return "run_ended";
    if (!Thread::is_main_thread() || NativeWorld::inside_interop() || !world->can_commit() ||
        !engine || engine->is_in_physics_frame() || !tree || !tree->get_root() ||
        tree->get_root()->get_viewport_rid() != pending.root) return "not_ready";
    if (OS::get_singleton()->get_ticks_usec() >= pending.deadline_us) return "timeout";
    return nullptr;
}

void fail_probe(const char* code, const char* reason) {
    pending.sample = error_reply(code, reason);
    pending.finished = true;
}

Dictionary snapshot(const SceneTree* tree, uint32_t iteration, uint32_t serial) {
    Array properties;
    for (const ProbeProperty& item : pending.query.properties) {
        Dictionary value;
        value["path"] = item.path;
        value["property"] = item.name;
        Node* node = find_node(tree, item.components);
        if (!node) value["reason"] = "node_not_found";
        else {
            value["instanceId"] = instance_id(node);
            if (item.name != "position" && item.name != "rotation" && item.name != "visible") {
                value["reason"] = "unsupported_property";
            } else {
                Array names;
                names.push_back(item.name);
                const Dictionary reply = read_node(node, item.path, node == tree->get_root(), names);
                const Dictionary result = reply["result"];
                const Array fields = result["properties"];
                const Dictionary field = fields[0];
                if (field.has("value")) value["value"] = field["value"];
                else value["reason"] = field["unavailable"];
            }
        }
        value["status"] = value.has("value") ? "value" : "unavailable";
        properties.push_back(value);
    }

    Dictionary sampled_tree;
    sampled_tree["status"] = "not_requested";
    if (pending.query.tree) {
        Node* root = find_node(tree, pending.query.tree_components);
        if (root) {
            const String path = pending.query.tree_path.is_empty() ? String("/") + String(root->get_name()) : pending.query.tree_path;
            const Dictionary reply = read_tree(tree, root, path, pending.query.tree_components.size(),
                pending.query.depth, pending.query.limit, true);
            sampled_tree = reply["result"];
            sampled_tree["status"] = "sampled";
        } else {
            sampled_tree["status"] = "root_missing";
            sampled_tree["path"] = pending.query.tree_path;
        }
    }
    Dictionary result;
    result["iteration"] = iteration;
    if (serial) result["renderSerial"] = serial;
    result["properties"] = properties;
    result["tree"] = sampled_tree;
    return success_reply(result);
}
} // namespace

void arm_draw() { armed_draw = pending.deadline_us && pending.query.rendered && !pending.finished; }
bool take_draw() { return std::exchange(armed_draw, false); }
DrawScope::DrawScope() : previous(std::exchange(normal_draw, false)) {}
DrawScope::~DrawScope() { normal_draw = previous; }
void DrawScope::enable(bool enabled) { normal_draw = enabled; }

ViewportScope::ViewportScope(RID viewport, bool main_window) :
    previous_root(std::exchange(root_viewport, normal_draw && main_window && viewport == pending.root)),
    previous_blit(std::exchange(root_blit, false)) {}
ViewportScope::~ViewportScope() {
    root_viewport = previous_root;
    root_blit = previous_blit;
}
void complete_blit() { root_blit = root_viewport; }
void reject_direct_to_screen(RID viewport) {
    if (normal_draw && pending.deadline_us && pending.query.rendered && !pending.finished && viewport == pending.root)
        fail_probe("unsupported", "direct_to_screen");
}
void clear() { pending = {}; }
void begin_iteration() { commits = 0; }

void commit(uint32_t iteration, uint32_t serial, bool own_context) {
    if (!own_context || !pending.deadline_us || pending.finished || !pending.query.rendered) return;
    ++commits;
    if (pending.copied || !normal_draw || !root_viewport || !root_blit) return;
    if (commits != 1) {
        fail_probe("probe_failed", "ambiguous_frame");
        return;
    }
    const SceneTree* tree = nullptr;
    if (const char* error = probe_scene(tree)) {
        fail_probe(error, error);
        return;
    }
    if (!EM_ASM_INT({ const fn = Module['godotGameProbeMayFreeze']; return fn && fn() ? 1 : 0; })) return;
    pending.sample = snapshot(tree, iteration, serial);
    pending.copied = EM_ASM_INT({
        const fn = Module['godotGameProbeFreeze'];
        return fn && fn($0 >>> 0, $1 >>> 0) ? 1 : 0;
    }, iteration, serial) != 0;
    if (!pending.copied) fail_probe("capture_failed", "capture_failed");
}

void end_iteration(uint32_t iteration, bool exiting) {
    if (!pending.deadline_us) return;
    const SceneTree* tree = nullptr;
    const char* error = probe_scene(tree);
    if (exiting || (error && std::strcmp(error, "run_ended") == 0)) {
        fail_probe("run_ended", "run_ended");
    } else if (pending.finished) {
        return;
    } else if (error) {
        fail_probe(error, error);
    } else if (!pending.query.rendered) {
        pending.sample = snapshot(tree, iteration, 0);
        pending.finished = true;
    } else if (pending.copied) {
        if (commits == 1) pending.finished = true;
        else fail_probe("probe_failed", "ambiguous_frame");
    }
}

uint32_t stage(uint32_t size, uint32_t remaining_us) {
    const SceneTree* tree;
    std::shared_ptr<NativeWorld> world;
    if (pending.deadline_us || !remaining_us || remaining_us > 30000000 ||
        active_scene_error(world, tree) || tree->godotjs_is_quit_requested()) return 0;
    Dictionary input;
    ProbeQuery query;
    if (!parse_request(buffer(), size, input) || !read_query(input, query)) return 0;
    pending.world_id = world->id();
    pending.root = tree->get_root()->get_viewport_rid();
    pending.deadline_us = OS::get_singleton()->get_ticks_usec() + remaining_us;
    pending.query = std::move(query);
    return 1;
}

uint32_t take() {
    char* destination = buffer();
    if (!pending.finished || !destination) return 0;
    CharString output = JSON::stringify(pending.sample, "", false, true).utf8();
    clear();
    if (output.length() > RUNTIME_OBSERVATION_RESULT_BYTES)
        output = JSON::stringify(error_reply("probe_failed", "result_budget")).utf8();
    std::memcpy(destination, output.get_data(), output.length());
    return output.length();
}
} // namespace jsb::game_probe
#endif

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_observation_abi() { return 1; }
extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t godotjs_runtime_observation_buffer() {
    return reinterpret_cast<uintptr_t>(jsb::runtime_access::buffer());
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_observation_sample(uint32_t input_size) {
    return jsb::runtime_access::execute_buffer(input_size, jsb::sample_runtime_observation);
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_write_abi() { return 1; }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_write_execute(uint32_t input_size) {
    return jsb::runtime_access::execute_buffer(input_size, jsb::execute_runtime_write);
}
#endif
