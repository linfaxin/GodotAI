#ifndef GODOTJS_RUNTIME_SCRIPT_PROPERTIES_H
#define GODOTJS_RUNTIME_SCRIPT_PROPERTIES_H

#include "jsb_bridge_pch.h"
#include "jsb_object_handle.h"
#include <atomic>
#include <limits>

namespace jsb {
class Environment;

// Shared identity space never wraps or reuses an exhausted identity.
inline uint64_t next_runtime_script_identity() {
    static std::atomic<uint64_t> next{1};
    uint64_t value = next.load(std::memory_order_relaxed);
    while (value != std::numeric_limits<uint64_t>::max()) {
        if (next.compare_exchange_weak(value, value + 1, std::memory_order_relaxed)) return value;
    }
    return 0;
}

struct RuntimeExportInfo {
    StringName name;
    Variant::Type type = Variant::NIL;
    uint32_t usage = PROPERTY_USAGE_DEFAULT;
};
struct RuntimeClassRevision {
    ScriptClassID class_id;
    uint64_t revision = 0;
};
struct RuntimeScriptSnapshot {
    std::shared_ptr<Environment> environment;
    std::shared_ptr<ObjectBindingTicket> ticket;
    ObjectID owner_id;
    NativeObjectID object_id;
    uint64_t instance_token = 0;
    uint64_t binding_generation = 0;
    ScriptClassID class_id;
    Vector<RuntimeClassRevision> classes;
};
struct RuntimeScriptMetadata {
    Vector<RuntimeExportInfo> properties;
    int entries_visited = 0;
    int levels_visited = 0;
    bool metadata_limited = false;
    bool inheritance_limited = false;
};
struct RuntimeScriptAccess {
    bool entered = false;
    const char* reason = nullptr;
    Variant value;
};

// Implemented by the bounded runtime-property codec. No coercion or wrappers.
bool runtime_scalar_from_js(Environment* env, const v8::Local<v8::Value>& value,
    Variant::Type type, Variant& out, const char*& reason);
bool runtime_scalar_to_js(Environment* env, const Variant& value,
    v8::Local<v8::Value>& out, const char*& reason);

RuntimeScriptAccess read_runtime_script_scalar(const RuntimeScriptSnapshot& snapshot,
    const RuntimeExportInfo& property);
RuntimeScriptAccess write_runtime_script_scalar(const RuntimeScriptSnapshot& snapshot,
    const RuntimeExportInfo& property, const Variant& value);
}
#endif
