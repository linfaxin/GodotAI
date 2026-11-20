#include "jsb_runtime_observation.h"
#include "jsb_native_world.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/math/math_funcs.h"
#include "core/os/thread.h"
#include "main/main.h"
#include "scene/2d/node_2d.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include <cstring>
#include <vector>

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
#include <emscripten/emscripten.h>
#endif

namespace jsb {
namespace {

constexpr int MAX_PATH_BYTES = 2048;
constexpr int MAX_PATH_COMPONENTS = 128;
constexpr int MAX_CHILDREN_PER_PARENT = 512;
constexpr int MAX_CHILD_CACHE_WORK = 2048;
constexpr int RESULT_ENVELOPE_RESERVE = 128;

Dictionary error_reply(const char* code, const char* message) {
    Dictionary error;
    error["code"] = code;
    error["message"] = message;
    Dictionary reply;
    reply["ok"] = false;
    reply["error"] = error;
    return reply;
}

Dictionary success_reply(const Dictionary& result) {
    Dictionary reply;
    reply["ok"] = true;
    reply["result"] = result;
    return reply;
}

bool valid_component(const String& name) {
    if (name.is_empty() || name[0] == '%' || name == "." || name == ".." || name.length() > MAX_PATH_BYTES) return false;
    for (int index = 0; index < name.length(); ++index) {
        const char32_t character = name[index];
        if (character < 0x20 || character == 0x7f || (character >= 0xd800 && character <= 0xdfff) ||
            character == ':' || character == '/') return false;
    }
    return true;
}

bool read_path(const Variant& raw, String& path, Vector<String>& components) {
    if (raw.get_type() != Variant::STRING) return false;
    path = raw;
    if (path.length() < 2 || path.length() > MAX_PATH_BYTES || path[0] != '/' || path.utf8().length() > MAX_PATH_BYTES) return false;
    components = path.substr(1).split("/");
    if (components.size() > MAX_PATH_COMPONENTS) return false;
    for (const String& name : components) if (!valid_component(name)) return false;
    return true;
}

bool read_integer(const Dictionary& request, const char* key, int fallback, int lower, int upper, int& value) {
    const Variant raw = request.get(key, fallback);
    if (raw.get_type() != Variant::INT && raw.get_type() != Variant::FLOAT) return false;
    const double number = raw;
    if (!Math::is_finite(number) || number < lower || number > upper || number != static_cast<int>(number)) return false;
    value = static_cast<int>(number);
    return true;
}

bool is_public_node(const Node* node, const SceneTree* tree) {
    return node && node->is_inside_tree() && node->get_tree() == tree &&
        !node->is_queued_for_deletion() && node->get_internal_mode() == Node::INTERNAL_MODE_DISABLED;
}

Node* find_node(const SceneTree* tree, const Vector<String>& components) {
    Node* node = tree->get_root();
    if (!is_public_node(node, tree)) return nullptr;
    if (components.is_empty()) return node;
    if (node->get_name() != StringName(components[0])) return nullptr;
    for (int index = 1; index < components.size(); ++index) {
        // Resolve a single canonical name. This does not populate the ordered
        // child cache, and checks every ancestor against the public tree scope.
        node = node->get_node_or_null(NodePath(components[index]));
        if (!is_public_node(node, tree)) return nullptr;
    }
    return node;
}

Dictionary node_description(const Node* node, const String& path, const Variant& parent_path) {
    Dictionary description;
    description["path"] = path;
    description["parentPath"] = parent_path;
    description["name"] = String(node->get_name());
    description["type"] = node->get_class();
    description["instanceId"] = uitos(static_cast<uint64_t>(node->get_instance_id()));
    return description;
}

Dictionary read_tree(const SceneTree* tree, Node* root, const String& root_path, int path_components, int depth, int limit) {
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
        const int bytes = JSON::stringify(description, "", false, true).utf8().length() + 1;
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
            if (Math::is_finite(position.x) && Math::is_finite(position.y)) {
                Dictionary coordinates;
                coordinates["x"] = position.x;
                coordinates["y"] = position.y;
                observation["value"] = coordinates;
            } else observation["unavailable"] = "non_finite";
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

    if (!Thread::is_main_thread() || Main::is_iterating() || NativeWorld::inside_interop()) {
        return error_reply("not_ready", "Runtime observation requires a completed owner iteration");
    }
    const auto world = NativeWorld::current();
    if (world && world->is_closing()) return error_reply("run_ended", "The native world is closing");
    const Engine* engine = Engine::get_singleton();
    const SceneTree* tree = SceneTree::get_singleton();
    if (!world || !engine || engine->is_in_physics_frame() || !tree || !tree->get_root() || !world->can_commit()) {
        return error_reply("not_ready", "The active native scene tree is unavailable");
    }

    Node* node = find_node(tree, components);
    if (!node) return error_reply("node_not_found", "The node is absent from the active runtime tree");
    if (components.is_empty() && !read_path(String("/") + String(node->get_name()), path, components)) {
        return error_reply("observation_failed", "The runtime root path cannot be represented");
    }
    if (kind == "tree") return read_tree(tree, node, path, components.size(), depth, limit);
    return read_node(node, path, node == tree->get_root(), properties);
}

} // namespace

CharString sample_runtime_observation(const char* request, uint32_t size) {
    String source;
    JSON parser;
    Dictionary reply;
    if (!request || size == 0 || size > RUNTIME_OBSERVATION_REQUEST_BYTES || std::memchr(request, 0, size) ||
        source.append_utf8(request, size) != OK || parser.parse(source) != OK || parser.get_data().get_type() != Variant::DICTIONARY) {
        reply = error_reply("invalid_input", "Expected a bounded UTF-8 JSON observation request");
    } else {
        reply = observe(parser.get_data());
    }
    return JSON::stringify(reply, "", false, true).utf8();
}

} // namespace jsb

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
namespace {
char observation_buffer[jsb::RUNTIME_OBSERVATION_RESULT_BYTES];
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_observation_abi() {
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t godotjs_runtime_observation_buffer() {
    return Thread::is_main_thread() ? reinterpret_cast<uintptr_t>(observation_buffer) : 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_observation_sample(uint32_t input_size) {
    if (!Thread::is_main_thread()) return 0;
    const CharString reply = jsb::sample_runtime_observation(observation_buffer, input_size);
    if (reply.length() <= 0 || static_cast<uint32_t>(reply.length()) > jsb::RUNTIME_OBSERVATION_RESULT_BYTES) return 0;
    // This borrowed area belongs to the runtime. The Worker copies the result
    // before calling back into WASM or submitting another request.
    std::memcpy(observation_buffer, reply.get_data(), reply.length());
    return reply.length();
}
#endif
