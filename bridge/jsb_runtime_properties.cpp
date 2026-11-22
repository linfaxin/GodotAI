#include "jsb_runtime_properties.h"
#include "jsb_runtime_access_common.h"
#include "jsb_runtime_script_properties.h"
#include "../weaver/jsb_script_instance.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/math/math_funcs.h"
#include "core/os/os.h"
#include "scene/2d/node_2d.h"
#include "scene/main/window.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
#include <emscripten/emscripten.h>
#endif

namespace jsb {
namespace {
using namespace runtime_access;
constexpr double MAX_SAFE_INTEGER = 9007199254740991.0;
uint64_t ticks() { return OS::get_singleton()->get_ticks_usec(); }
Dictionary error(const char* code, const char* message, const String& property = String(), int index = -1) {
    Dictionary reply = error_reply(code, message), detail = reply["error"];
    detail["source"] = "native";
    if (!property.is_empty()) detail["property"] = property;
    if (index >= 0) detail["index"] = index;
    return reply;
}
Dictionary frame() {
    Engine* engine = Engine::get_singleton();
    Dictionary result;
    result["process"] = uitos(engine ? engine->get_process_frames() : 0);
    result["physics"] = uitos(engine ? engine->get_physics_frames() : 0);
    result["drawn"] = uitos(engine ? engine->get_frames_drawn() : 0);
    return result;
}
Dictionary maximum_frame() {
    Dictionary result;
    result["process"] = "18446744073709551615";
    result["physics"] = "18446744073709551615";
    result["drawn"] = "18446744073709551615";
    return result;
}
bool append_json_string(std::string& output, const String& value) {
    static const char hex[] = "0123456789abcdef";
    output += '"';
    for (int index = 0; index < value.length(); ++index) {
        const uint32_t code = value[index];
        if (code < 0x20) {
            output += "\\u00"; output += hex[code >> 4]; output += hex[code & 15];
        } else if (code == '"' || code == '\\') {
            output += '\\'; output += static_cast<char>(code);
        } else if (code < 0x80) output += static_cast<char>(code);
        else if (code < 0x800) {
            output += static_cast<char>(0xc0 | (code >> 6));
            output += static_cast<char>(0x80 | (code & 63));
        } else if (code >= 0xd800 && code <= 0xdfff) return false;
        else if (code < 0x10000) {
            output += static_cast<char>(0xe0 | (code >> 12));
            output += static_cast<char>(0x80 | ((code >> 6) & 63));
            output += static_cast<char>(0x80 | (code & 63));
        } else if (code <= 0x10ffff) {
            output += static_cast<char>(0xf0 | (code >> 18));
            output += static_cast<char>(0x80 | ((code >> 12) & 63));
            output += static_cast<char>(0x80 | ((code >> 6) & 63));
            output += static_cast<char>(0x80 | (code & 63));
        } else return false;
    }
    output += '"';
    return true;
}
bool append_json(std::string& output, const Variant& value, int depth = 0) {
    if (depth > 64) return false;
    switch (value.get_type()) {
        case Variant::NIL: output += "null"; return true;
        case Variant::BOOL: output += bool(value) ? "true" : "false"; return true;
        case Variant::INT:
        case Variant::FLOAT: {
            const CharString number = JSON::stringify(value, "", false, true).utf8();
            output.append(number.get_data(), number.length()); return true;
        }
        case Variant::STRING: return append_json_string(output, value);
        case Variant::ARRAY: {
            output += '[';
            const Array items = value;
            for (int index = 0; index < items.size(); ++index) {
                if (index) output += ',';
                if (!append_json(output, items[index], depth + 1)) return false;
            }
            output += ']'; return true;
        }
        case Variant::DICTIONARY: {
            output += '{';
            const Dictionary object = value;
            const Array names = object.keys();
            for (int index = 0; index < names.size(); ++index) {
                if (index) output += ',';
                if (names[index].get_type() != Variant::STRING || !append_json_string(output, names[index])) return false;
                output += ':';
                if (!append_json(output, object[names[index]], depth + 1)) return false;
            }
            output += '}'; return true;
        }
        default: return false;
    }
}
CharString stringify(const Variant& value) {
    std::string output;
    if (!append_json(output, value)) return CharString();
    CharString result;
    result.resize_uninitialized(output.size() + 1);
    std::memcpy(result.ptrw(), output.data(), output.size());
    result.ptrw()[output.size()] = 0;
    return result;
}
int json_size(const Variant& value) {
    const CharString bytes = stringify(value);
    return bytes.length() ? bytes.length() : 1000000000;
}
bool scalar_type(Variant::Type type) { return type == Variant::BOOL || type == Variant::INT || type == Variant::FLOAT || type == Variant::STRING; }
String wire_type(Variant::Type type) {
    switch (type) {
        case Variant::BOOL: return "bool";
        case Variant::INT: return "int";
        case Variant::FLOAT: return "float";
        case Variant::STRING: return "string";
        case Variant::VECTOR2: return "vector2";
        default: return String();
    }
}
Variant::Type variant_type(const String& type) {
    if (type == "bool") return Variant::BOOL;
    if (type == "int") return Variant::INT;
    if (type == "float") return Variant::FLOAT;
    if (type == "string") return Variant::STRING;
    if (type == "vector2") return Variant::VECTOR2;
    return Variant::NIL;
}
bool keys(const Dictionary& object, std::initializer_list<const char*> required, std::initializer_list<const char*> optional = {}) {
    for (const char* key : required) if (!object.has(key)) return false;
    for (const Variant& raw : object.keys()) {
        if (raw.get_type() != Variant::STRING) return false;
        const String key = raw;
        bool found = false;
        for (const char* allowed : required) if (key == allowed) found = true;
        for (const char* allowed : optional) if (key == allowed) found = true;
        if (!found) return false;
    }
    return true;
}
bool valid_name(const Variant& raw, String& name) {
    if (raw.get_type() != Variant::STRING) return false;
    name = raw;
    if (name.is_empty() || name.utf8().length() > 256) return false;
    for (int i = 0; i < name.length(); ++i) if (name[i] == 0 || (name[i] >= 0xd800 && name[i] <= 0xdfff)) return false;
    return true;
}
// The structure parser replaces every numeric token with an exact small index.
bool number(const Variant& indexed, const std::vector<double>& numbers, double& result) {
    if (indexed.get_type() != Variant::INT && indexed.get_type() != Variant::FLOAT) return false;
    const double index = indexed;
    if (index < 0 || index >= numbers.size() || std::floor(index) != index) return false;
    result = numbers[static_cast<size_t>(index)];
    return Math::is_finite(result);
}
bool integer(const Variant& indexed, const std::vector<double>& numbers, int minimum, int maximum, int& result) {
    double value;
    if (!number(indexed, numbers, value) || std::floor(value) != value || value < minimum || value > maximum) return false;
    result = static_cast<int>(value); return true;
}
bool unicode_escapes_valid(const char* data, uint32_t size) {
    auto hex = [](char ch) -> int { if (ch >= '0' && ch <= '9') return ch - '0'; if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10; if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10; return -1; };
    bool quoted = false;
    for (uint32_t i = 0; i < size; ++i) {
        if (data[i] == '"') { quoted = !quoted; continue; }
        if (!quoted || data[i] != '\\') continue;
        if (++i >= size) return false;
        if (data[i] != 'u') continue;
        if (i + 4 >= size) return false;
        int code = 0;
        for (int n = 0; n < 4; ++n) { const int digit = hex(data[++i]); if (digit < 0) return false; code = code * 16 + digit; }
        if (code >= 0xdc00 && code <= 0xdfff) return false;
        if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 6 >= size || data[i + 1] != '\\' || data[i + 2] != 'u') return false;
            i += 2; int low = 0;
            for (int n = 0; n < 4; ++n) { const int digit = hex(data[++i]); if (digit < 0) return false; low = low * 16 + digit; }
            if (low < 0xdc00 || low > 0xdfff) return false;
        }
    }
    return true;
}
Dictionary typed(const Variant& value) {
    Dictionary result;
    result["type"] = wire_type(value.get_type());
    result["value"] = value.get_type() == Variant::VECTOR2 ? Variant(coordinates(value)) : value;
    return result;
}
const char* decode_value(const Variant& raw, const std::vector<double>& numbers, Variant& value) {
    if (raw.get_type() != Variant::DICTIONARY) return "invalid_input";
    const Dictionary object = raw;
    if (!keys(object, {"type", "value"}) || object["type"].get_type() != Variant::STRING) return "invalid_input";
    const Variant::Type type = variant_type(object["type"]);
    const Variant payload = object["value"];
    if (type == Variant::BOOL) {
        if (payload.get_type() != Variant::BOOL) return "type_mismatch";
        value = payload; return nullptr;
    }
    if (type == Variant::STRING) {
        if (payload.get_type() != Variant::STRING) return "type_mismatch";
        const String text = payload;
        if (text.utf8().length() > 1024) return "out_of_range";
        value = text; return nullptr;
    }
    if (type == Variant::INT || type == Variant::FLOAT) {
        double parsed;
        if (!number(payload, numbers, parsed)) return "type_mismatch";
        if (type == Variant::INT) {
            if (std::floor(parsed) != parsed || parsed < -MAX_SAFE_INTEGER || parsed > MAX_SAFE_INTEGER) return "out_of_range";
            value = static_cast<int64_t>(parsed);
        } else value = parsed;
        return nullptr;
    }
    if (type == Variant::VECTOR2) {
        if (payload.get_type() != Variant::DICTIONARY) return "type_mismatch";
        const Dictionary position = payload;
        double x, y;
        if (!keys(position, {"x", "y"}) || !number(position["x"], numbers, x) || !number(position["y"], numbers, y)) return "type_mismatch";
        const double maximum = std::numeric_limits<real_t>::max();
        if (std::abs(x) > maximum || std::abs(y) > maximum) return "out_of_range";
        value = Vector2(static_cast<real_t>(x), static_cast<real_t>(y));
        return nullptr;
    }
    return "unsupported";
}
struct Property {
    String name;
    Variant::Type type = Variant::NIL;
    bool native = false;
    bool writable = false;
    bool shadowed = false;
    RuntimeExportInfo exported;
};
struct Context {
    String path, id;
    Vector<String> components;
    std::shared_ptr<NativeWorld> world;
    const SceneTree* tree = nullptr;
    RuntimeScriptSnapshot script;
    RuntimeScriptMetadata metadata;
    bool script_present = false;
    RuntimePropertyClock clock = ticks;
    uint64_t deadline = 0;
    int budget = 65536;
    const char* scene(Node*& node, bool script_required = false) const {
        std::shared_ptr<NativeWorld> current;
        const SceneTree* current_tree = nullptr;
        if (const char* failure = active_scene_error(current, current_tree)) return failure;
        if (current != world || current_tree != tree) return "run_ended";
#ifdef GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI
        if (current_tree->godotjs_is_quit_requested()) return "run_ended";
#endif
        node = find_node(current_tree, components);
        if (!node || instance_id(node) != id) return "target_changed";
        if (script_required && !GodotJSScriptInstance::verify_runtime(node, script)) return "target_changed";
        return nullptr;
    }
    const char* admission(Node*& node, bool script_required = false) const {
        if (clock() >= deadline) return "timeout";
        return scene(node, script_required);
    }
};
Property native_property(Node* node, const String& name) {
    Property property; property.name = name;
    if (Object::cast_to<Node2D>(node) && (name == "position" || name == "rotation")) {
        property.native = true; property.type = name == "position" ? Variant::VECTOR2 : Variant::FLOAT;
        property.writable = name == "position";
    } else if (Object::cast_to<CanvasItem>(node) && name == "visible") {
        property.native = true; property.type = Variant::BOOL;
    }
    return property;
}
const RuntimeExportInfo* exported_property(const Context& context, const String& name) {
    for (const RuntimeExportInfo& property : context.metadata.properties) if (property.name == StringName(name)) return &property;
    return nullptr;
}
Property lookup(const Context& context, Node* node, const String& name) {
    Property property = native_property(node, name);
    const RuntimeExportInfo* exported = exported_property(context, name);
    if (property.native) { property.shadowed = exported != nullptr; return property; }
    if (exported) {
        property.exported = *exported; property.name = name; property.type = exported->type;
        property.writable = !(exported->usage & PROPERTY_USAGE_READ_ONLY);
    }
    return property;
}
Dictionary mode(const char* status, const char* reason = nullptr) {
    Dictionary value; value["status"] = status; if (reason) value["reason"] = reason; return value;
}
Dictionary descriptor(const Property& property) {
    Dictionary result, declared;
    result["name"] = property.name;
    declared["variantType"] = static_cast<int>(property.type);
    declared["name"] = Variant::get_type_name(property.type);
    result["declaredType"] = declared;
    const String type = wire_type(property.type);
    result["type"] = type.is_empty() ? Variant() : Variant(type);
    result["origin"] = property.native ? "native" : "godotjs_export";
    const bool supported = property.native || scalar_type(property.type);
    result["readAccess"] = supported ? mode(property.native ? "supported" : "candidate") : mode("unsupported", property.type == Variant::VECTOR2 ? "unsupported_export_type" : "unsupported_type");
    result["writeAccess"] = !supported ? mode("unsupported", property.type == Variant::VECTOR2 ? "unsupported_export_type" : "unsupported_type") :
        property.writable ? mode(property.native ? "supported" : "candidate") : mode("unsupported", property.native ? "no_native_setter" : "read_only");
    result["readMayExecuteScript"] = !property.native;
    result["writeMayExecuteScript"] = property.writable;
    result["shadowedExport"] = property.shadowed;
    return result;
}
const char* capture_script(Context& context, Node* node, const Vector<StringName>* names = nullptr, bool required = true) {
    const char* failure = GodotJSScriptInstance::capture_runtime(node, context.script, context.metadata, 512, 16, names);
    if (failure && std::strcmp(failure, "unsupported") == 0) {
        return required && node->get_script_instance() ? failure : nullptr;
    }
    if (failure) return failure;
    context.script_present = true;
    return nullptr;
}
RuntimeScriptAccess read(Context& context, const Property& property) {
    RuntimeScriptAccess result;
    Node* node = nullptr;
    if (const char* failure = context.admission(node, !property.native)) { result.reason = failure; return result; }
    if (property.native) {
        result.entered = true;
        if (property.name == "position") result.value = Object::cast_to<Node2D>(node)->get_position();
        else if (property.name == "rotation") result.value = static_cast<double>(Object::cast_to<Node2D>(node)->get_rotation());
        else result.value = Object::cast_to<CanvasItem>(node)->is_visible();
        if (property.type == Variant::VECTOR2) {
            const Vector2 value = result.value;
            if (!Math::is_finite(value.x) || !Math::is_finite(value.y)) result.reason = "out_of_range";
        } else if (property.type == Variant::FLOAT && !Math::is_finite(static_cast<double>(result.value))) result.reason = "out_of_range";
    } else {
        NativeInteropScope scope;
        result = read_runtime_script_scalar(context.script, property.exported);
    }
    if (const char* failure = context.admission(node, !property.native)) result.reason = std::strcmp(failure, "not_ready") == 0 ? "target_changed" : failure;
    return result;
}

Dictionary requested_wire(const Dictionary& object, const std::vector<double>& numbers, const Variant& converted) {
    Dictionary result = typed(converted);
    const String type = object["type"];
    if (type == "vector2") {
        const Dictionary indexed = object["value"];
        double x, y;
        number(indexed["x"], numbers, x); number(indexed["y"], numbers, y);
        Dictionary value; value["x"] = x; value["y"] = y;
        result["value"] = value;
    }
    return result;
}
Dictionary finish_write(const Property& property, const Dictionary& requested, const char* outcome,
    const char* reason = nullptr, const Variant* before = nullptr, const Variant* after = nullptr,
    const Variant* comparison = nullptr, const char* phase = "before_read") {
    Dictionary result;
    result["property"] = property.name;
    result["requestedValue"] = requested;
    result["outcome"] = outcome;
    const Dictionary now = frame();
    if (std::strcmp(outcome, "unconfirmed") == 0) {
        Dictionary evidence;
        evidence["phase"] = phase;
        evidence["writeEntered"] = std::strcmp(phase, "before_read") != 0;
        evidence["frame"] = now;
        if (before) evidence["beforeValue"] = typed(*before);
        result["reason"] = reason ? reason : "readback_failed";
        result["evidence"] = evidence;
    } else {
        result["phase"] = phase;
        result["writeEntered"] = std::strcmp(outcome, "not_written") != 0;
        result["frame"] = now;
        if (reason) result["reason"] = reason;
        if (before) result["beforeValue"] = typed(*before);
        if (after) result["observedValue"] = typed(*after);
        if (comparison) result["comparisonValue"] = typed(*comparison);
    }
    return success_reply(result);
}
Dictionary write(Context& context, const Property& property, const Variant& value, const Dictionary& requested) {
    const RuntimeScriptAccess before = read(context, property);
    if (before.reason) {
        if (!before.entered) return error(std::strcmp(before.reason, "target_changed") == 0 ? "node_changed" : before.reason,
            "The property access was not entered", property.name);
        return finish_write(property, requested, "not_written", before.reason);
    }
    // Reserve the full terminal and diagnostic shape before entering a setter.
    const Dictionary expected = finish_write(property, requested, "applied", nullptr, &before.value, &value, &value, "readback");
    if (json_size(expected) + 512 > context.budget) return finish_write(property, requested, "not_written", "output_budget");
    Node* node = nullptr;
    if (const char* failure = context.admission(node, !property.native)) return finish_write(property, requested, "not_written", std::strcmp(failure, "not_ready") == 0 ? "target_changed" : failure, &before.value);
    RuntimeScriptAccess mutation;
    if (property.native) {
        mutation.entered = true;
        NativeInteropScope scope;
        Object::cast_to<Node2D>(node)->set_position(value);
    } else {
        NativeInteropScope scope;
        mutation = write_runtime_script_scalar(context.script, property.exported, value);
    }
    if (!mutation.entered) return finish_write(property, requested, "not_written", mutation.reason ? mutation.reason : "target_changed", &before.value);
    if (mutation.reason) return finish_write(property, requested, "unconfirmed", "setter_failed", &before.value, nullptr, nullptr, "write");
    if (const char* failure = context.scene(node, !property.native)) return finish_write(property, requested, "unconfirmed", std::strcmp(failure, "not_ready") == 0 ? "target_changed" : failure, &before.value, nullptr, nullptr, "write");
    if (const char* failure = context.admission(node, !property.native)) return finish_write(property, requested, "unconfirmed", std::strcmp(failure, "not_ready") == 0 ? "target_changed" : failure, &before.value, nullptr, nullptr, "write");
    const RuntimeScriptAccess after = read(context, property);
    if (after.reason) return finish_write(property, requested, "unconfirmed", after.reason, &before.value, nullptr, nullptr, after.entered ? "readback" : "write");
    const Dictionary completed = finish_write(property, requested, after.value == value ? "applied" : "not_applied", nullptr,
        &before.value, &after.value, &value, "readback");
    if (json_size(completed) > context.budget) return finish_write(property, requested, "unconfirmed", "output_budget", &before.value, nullptr, nullptr, "readback");
    return completed;
}
Dictionary read_result(const Array& properties, const char* stop_reason = nullptr) {
    Dictionary result;
    result["outcome"] = "completed";
    result["frame"] = frame();
    result["properties"] = properties;
    if (stop_reason) result["stopReason"] = stop_reason;
    return success_reply(result);
}
Dictionary batch_read(Context& context, const Vector<Property>& requested, const Array& input) {
    // A small internal budget must still preserve every name and whether a Get
    // was entered. Reject before access if even the fallback cannot fit.
    Array minimum;
    for (int index = 0; index < requested.size(); ++index) {
        Dictionary item;
        item["name"] = requested[index].name;
        item["expectedType"] = Dictionary(input[index])["expectedType"];
        item["status"] = index == 0 ? "unavailable" : "not_attempted";
        item["readEntered"] = index == 0;
        if (index == 0) item["reason"] = "output_budget";
        minimum.push_back(item);
    }
    Dictionary minimum_result = read_result(minimum, "output_budget");
    Dictionary minimum_body = minimum_result["result"];
    minimum_body["frame"] = maximum_frame();
    if (json_size(minimum_result) + 128 > context.budget) return error("out_of_range", "The output budget cannot preserve the requested access evidence");
    Array observations;
    bool entered = false;
    const char* stop_reason = nullptr;
    for (int index = 0; index < requested.size(); ++index) {
        Dictionary item;
        item["name"] = requested[index].name;
        const Dictionary entry = input[index];
        item["expectedType"] = entry["expectedType"];
        if (stop_reason) {
            item["status"] = "not_attempted"; item["readEntered"] = false;
            observations.push_back(item); continue;
        }
        RuntimeScriptAccess accessed = read(context, requested[index]);
        if (accessed.reason && std::strcmp(accessed.reason, "not_ready") == 0) {
            if (!entered && !accessed.entered) return error("not_ready", "The runtime property context is unavailable");
            accessed.reason = "target_changed";
        }
        entered = entered || accessed.entered;
        if (accessed.reason && (std::strcmp(accessed.reason, "timeout") == 0 || std::strcmp(accessed.reason, "run_ended") == 0)) {
            if (!entered) return error(accessed.reason, "The property batch was not entered");
            item["status"] = accessed.entered ? "unavailable" : "not_attempted";
            item["readEntered"] = accessed.entered;
            if (accessed.entered) item["reason"] = accessed.reason;
            // Only this native reply can prove the remaining getters were not called.
            observations.push_back(item);
            for (int rest = index + 1; rest < requested.size(); ++rest) {
                Dictionary pending; pending["name"] = requested[rest].name;
                pending["expectedType"] = Dictionary(input[rest])["expectedType"];
                pending["status"] = "not_attempted"; pending["readEntered"] = false;
                observations.push_back(pending);
            }
            Dictionary evidence; evidence["phase"] = "read"; evidence["frame"] = frame(); evidence["properties"] = observations;
            Dictionary result; result["outcome"] = "unconfirmed"; result["reason"] = accessed.reason; result["evidence"] = evidence;
            return success_reply(result);
        }
        if (accessed.reason) {
            item["status"] = "unavailable"; item["readEntered"] = accessed.entered; item["reason"] = accessed.reason;
            stop_reason = accessed.reason;
        } else {
            item["status"] = "value"; item["readEntered"] = true; item["value"] = typed(accessed.value);
            Array prospective = observations.duplicate(); prospective.push_back(item);
            // Preserve room for all remaining names, stop facts and the frame.
            int reserved = 768;
            for (int rest = index + 1; rest < requested.size(); ++rest) reserved += requested[rest].name.utf8().length() * 6 + 160;
            if (json_size(read_result(prospective)) + reserved > context.budget) {
                item.erase("value"); item["status"] = "unavailable"; item["reason"] = "output_budget";
                stop_reason = "output_budget";
            }
        }
        observations.push_back(item);
    }
    return read_result(observations, stop_reason);
}
Dictionary describe(Context& context, Node* node, const Vector<StringName>* names, int limit) {
    Vector<String> all;
    if (names) {
        for (const StringName& name : *names) all.push_back(name);
    } else {
        if (Object::cast_to<Node2D>(node)) { all.push_back("position"); all.push_back("rotation"); }
        if (Object::cast_to<CanvasItem>(node)) all.push_back("visible");
        for (const RuntimeExportInfo& property : context.metadata.properties) {
            String representable;
            if (!valid_name(String(property.name), representable)) { context.metadata.metadata_limited = true; continue; }
            if (!all.has(representable)) all.push_back(representable);
        }
    }
    all.sort();
    if (names) {
        Array minimum;
        for (const String& name : all) {
            Dictionary item;
            item["name"] = name; item["status"] = "unresolved"; item["reason"] = "output_budget";
            minimum.push_back(item);
        }
        Dictionary scan;
        scan["metadataEntriesVisited"] = 512; scan["inheritanceLevelsVisited"] = 16;
        scan["truncated"] = true;
        Array reasons; reasons.push_back("metadata_limit"); reasons.push_back("inheritance_limit"); reasons.push_back("output_budget");
        scan["reasons"] = reasons;
        Dictionary body;
        body["frame"] = maximum_frame(); body["scan"] = scan; body["mode"] = "names"; body["properties"] = minimum;
        if (json_size(success_reply(body)) > context.budget) return error("out_of_range", "The output budget cannot preserve all requested names");
    }
    Array properties, reasons;
    if (context.metadata.metadata_limited) reasons.push_back("metadata_limit");
    if (context.metadata.inheritance_limited) reasons.push_back("inheritance_limit");
    for (int index = 0; index < all.size(); ++index) {
        const String& name = all[index];
        if (!names && properties.size() >= limit) { reasons.push_back("item_limit"); break; }
        const Property property = lookup(context, node, name);
        Dictionary item;
        if (names) {
            item["name"] = name;
            if (property.native || property.exported.name != StringName()) { item["status"] = "found"; item["descriptor"] = descriptor(property); }
            else if (context.metadata.metadata_limited || context.metadata.inheritance_limited) {
                item["status"] = "unresolved";
                item["reason"] = context.metadata.metadata_limited ? "metadata_limit" : "inheritance_limit";
            } else item["status"] = "absent";
        } else item = descriptor(property);
        // Reserve the scan/frame envelope and every remaining requested name.
        int reserved = 1024;
        if (names) for (int rest = index + 1; rest < all.size(); ++rest) {
            Dictionary pending;
            pending["name"] = all[rest]; pending["status"] = "unresolved"; pending["reason"] = "output_budget";
            reserved += json_size(pending) + 1;
        }
        if (json_size(properties) + json_size(item) + reserved > context.budget) {
            if (!reasons.has("output_budget")) reasons.push_back("output_budget");
            if (!names) break;
            item.clear(); item["name"] = name; item["status"] = "unresolved"; item["reason"] = "output_budget";
        }
        properties.push_back(item);
    }
    Dictionary scan;
    scan["metadataEntriesVisited"] = context.metadata.entries_visited;
    scan["inheritanceLevelsVisited"] = context.metadata.levels_visited;
    scan["truncated"] = !reasons.is_empty(); scan["reasons"] = reasons;
    Dictionary result; result["frame"] = frame(); result["scan"] = scan;
    result["mode"] = names ? "names" : "enumerate"; result["properties"] = properties;
    return success_reply(result);
}
Dictionary perform(const Dictionary& request, const std::vector<double>& numbers, Context& context) {
    if (!keys(request, {"kind", "path", "expectedInstanceId", "outputBudgetBytes"}, {"names", "limit", "properties", "property", "value"}) ||
        request["kind"].get_type() != Variant::STRING || !read_path(request["path"], context.path, context.components) ||
        !read_instance_id(request["expectedInstanceId"], context.id) || !integer(request["outputBudgetBytes"], numbers, 4096, 65536, context.budget)) {
        return error("invalid_input", "Expected a bounded typed runtime property command");
    }
    const String kind = request["kind"];
    Vector<StringName> names;
    Array inputs;
    Variant requested_value;
    int limit = 32;
    if (kind == "describe") {
        if (!keys(request, {"kind", "path", "expectedInstanceId", "outputBudgetBytes"}, {"names", "limit"}) || (request.has("names") && request.has("limit"))) return error("invalid_input", "Invalid description fields");
        if (request.has("limit") && !integer(request["limit"], numbers, 1, 64, limit)) return error("invalid_input", "Invalid descriptor limit");
        if (request.has("names")) {
            if (request["names"].get_type() != Variant::ARRAY) return error("invalid_input", "Expected property names");
            inputs = request["names"];
            if (inputs.is_empty() || inputs.size() > 16) return error("invalid_input", "Expected one to sixteen names");
            for (const Variant& value : inputs) { String name; if (!valid_name(value, name) || names.has(StringName(name))) return error("invalid_input", "Invalid or repeated property name"); names.push_back(name); }
        }
    } else if (kind == "read") {
        if (!keys(request, {"kind", "path", "expectedInstanceId", "outputBudgetBytes", "properties"}) || request["properties"].get_type() != Variant::ARRAY) return error("invalid_input", "Expected typed property batch");
        inputs = request["properties"];
        if (inputs.is_empty() || inputs.size() > 16) return error("invalid_input", "Expected one to sixteen properties");
        for (const Variant& value : inputs) {
            if (value.get_type() != Variant::DICTIONARY) return error("invalid_input", "Expected property descriptor");
            const Dictionary item = value; String name;
            if (!keys(item, {"name", "expectedType"}) || !valid_name(item["name"], name) || names.has(StringName(name)) || item["expectedType"].get_type() != Variant::STRING || variant_type(item["expectedType"]) == Variant::NIL) return error("invalid_input", "Invalid property descriptor");
            names.push_back(name);
        }
    } else if (kind == "write") {
        if (!keys(request, {"kind", "path", "expectedInstanceId", "outputBudgetBytes", "property", "value"})) return error("invalid_input", "Invalid write fields");
        String name;
        if (!valid_name(request["property"], name)) return error("invalid_input", "Expected property name");
        names.push_back(name);
        if (const char* failure = decode_value(request["value"], numbers, requested_value)) return error(failure, "Invalid typed property value", name);
    } else return error("invalid_input", "Unknown property command");

    Node* node = nullptr;
    if (const char* failure = active_scene_error(context.world, context.tree)) return error(failure, "The runtime is unavailable");
    node = find_node(context.tree, context.components);
    if (!node) return error("node_not_found", "The node is absent from the public runtime tree");
    if (instance_id(node) != context.id) return error("node_changed", "The node instance changed");
    if (const char* failure = context.admission(node)) return error(failure, "The runtime is not accepting property access");
    bool needs_script = kind == "describe";
    for (const StringName& name : names) if (!native_property(node, name).native) needs_script = true;
    if (const char* failure = capture_script(context, node, kind == "describe" && !request.has("names") ? nullptr : &names, needs_script && kind != "describe")) {
        if (needs_script) return error(failure, "The exported script metadata is not ready");
        context.script = {}; context.metadata = {};
    }
    if (kind == "describe") {
        const Dictionary result = describe(context, node, request.has("names") ? &names : nullptr, limit);
        if (const char* failure = context.admission(node)) return error(failure, "The runtime description exceeded its admission window");
        return result;
    }
    if (needs_script && (context.metadata.metadata_limited || context.metadata.inheritance_limited)) {
        return error("not_ready", "The complete script binding metadata exceeds this access budget");
    }
    Vector<Property> properties;
    for (int index = 0; index < names.size(); ++index) {
        const Property property = lookup(context, node, names[index]);
        if (!property.native && property.exported.name == StringName()) return error(context.metadata.metadata_limited || context.metadata.inheritance_limited ? "not_ready" : "property_not_found", "The property is not an available export", names[index], index);
        if (!property.native && !scalar_type(property.type)) return error("unsupported", "The script export type is not supported", names[index], index);
        const Variant::Type expected = kind == "read" ? variant_type(Dictionary(inputs[index])["expectedType"]) : requested_value.get_type();
        if (property.type != expected) return error("type_mismatch", "The property declaration changed or has another type", names[index], index);
        if (kind == "write" && !property.writable) return error(property.native ? "unsupported" : "property_read_only", "The property is not writable", names[index]);
        properties.push_back(property);
    }
    if (kind == "read") return batch_read(context, properties, inputs);
    const Dictionary requested = requested_wire(request["value"], numbers, requested_value);
    Dictionary minimum = finish_write(properties[0], requested, "not_written", "output_budget");
    Dictionary minimum_body = minimum["result"];
    minimum_body["frame"] = maximum_frame();
    if (json_size(minimum) > context.budget) return error("out_of_range", "The output budget cannot preserve the requested write evidence", properties[0].name);
    return write(context, properties[0], requested_value, requested);
}
} // namespace

CharString execute_runtime_properties(const char* request, uint32_t size, uint32_t budget_micros, RuntimePropertyClock clock) {
    Dictionary parsed;
    std::vector<double> numbers;
    Context context;
    context.clock = clock ? clock : ticks;
    context.deadline = context.clock() + budget_micros;
    Dictionary reply;
    if (budget_micros == 0 || budget_micros > 30000000 || !request || size == 0 || size > RUNTIME_OBSERVATION_REQUEST_BYTES || !unicode_escapes_valid(request, size) || !parse_properties_request(request, size, parsed, numbers)) {
        reply = error("invalid_input", "Expected bounded UTF-8 JSON and a positive native budget");
    } else reply = perform(parsed, numbers, context);
    CharString encoded = stringify(reply);
    // A malformed or oversized execution result cannot be recast as preaccess failure.
    if (encoded.length() > context.budget) return CharString();
    return encoded;
}
} // namespace jsb

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_properties_abi() {
#ifdef GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI
    return GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI;
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_properties_execute(uint32_t size, uint32_t budget_micros) {
    return jsb::runtime_access::execute_buffer(size, [budget_micros](const char* bytes, uint32_t count) {
        return jsb::execute_runtime_properties(bytes, count, budget_micros);
    });
}
#endif
