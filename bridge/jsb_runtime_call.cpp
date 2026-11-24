#include "jsb_runtime_call.h"

#if !JSB_WITH_JAVASCRIPTCORE
#include "jsb_runtime_access_common.h"
#include "jsb_environment.h"
#include "../weaver/jsb_script_instance.h"
#include "core/os/os.h"
#include <string_view>

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
#include <emscripten/emscripten.h>
#endif

namespace jsb {
namespace {
using namespace runtime_access;

uint64_t ticks() { return OS::get_singleton()->get_ticks_usec(); }

Dictionary error(const char* code, const char* message) {
    Dictionary reply = error_reply(code, message), detail = reply["error"];
    detail["source"] = "native";
    return reply;
}

String return_name(Variant::Type type) { return type == Variant::NIL ? String("void") : wire_type(type); }

bool stamp_valid(const String& stamp) {
    if (stamp.length() != 64) return false;
    for (int index = 0; index < stamp.length(); ++index) {
        const char32_t ch = stamp[index];
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
    }
    return true;
}

String stamp(const RuntimeScriptSnapshot& binding, const String& run_scope, const String& path,
    const String& id, const String& name, uint64_t registration) {
    Array fields;
    fields.append(run_scope);
    fields.append(path);
    fields.append(id);
    fields.append(uitos(binding.instance_token));
    fields.append(uitos(binding.binding_generation));
    fields.append(uitos(registration));
    fields.append(name);
    return String::utf8(stringify(fields).get_data()).sha256_text();
}

Dictionary method_descriptor(const RuntimeScriptSnapshot& binding, const RuntimeMethodInfo& info,
    const String& run_scope, const String& path, const String& id, const String& name) {
    Dictionary output;
    Array parameters;
    for (const auto type : info.parameter_types) parameters.append(wire_type(type));
    output["method"] = name;
    output["parameterTypes"] = parameters;
    output["returnType"] = return_name(info.return_type);
    output["methodStamp"] = stamp(binding, run_scope, path, id, name, info.registration);
    return output;
}

Dictionary entered(const char* outcome, const Dictionary& entry_frame, const char* reason = nullptr) {
    Dictionary result;
    result["outcome"] = outcome;
    result["callEntered"] = true;
    result["entryFrame"] = entry_frame;
    if (reason) result["reason"] = reason;
    return success_reply(result);
}

struct Context {
    RuntimePropertyClock clock = ticks;
    uint64_t deadline = 0;
    int budget = 65536;
    String path, id, run_scope;
    Vector<String> components;
    std::shared_ptr<NativeWorld> world;
    const SceneTree* scene = nullptr;

    const char* check(Node*& node) const {
        if (clock() >= deadline) return "timeout";
        std::shared_ptr<NativeWorld> active_world;
        const SceneTree* active = nullptr;
        if (const char* failure = active_scene_error(active_world, active)) return failure;
        if (active != scene || active_world != world) return "run_ended";
#ifdef GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI
        if (active->godotjs_is_quit_requested()) return "run_ended";
#endif
        node = find_node(active, components);
        if (!node) return "node_not_found";
        if (instance_id(node) != id) return "node_changed";
        return nullptr;
    }
};

Dictionary describe(const Context& context, const RuntimeScriptSnapshot& binding, const ScriptClassInfo& info,
    const String& requested, int limit) {
    Array methods;
    Vector<String> names;
    if (!requested.is_empty()) {
        if (info.own_runtime_methods.find(StringName(requested)) == info.own_runtime_methods.end())
            return error("method_not_found", "The script does not expose this method");
        names.push_back(requested);
    } else {
        for (const auto& pair : info.own_runtime_methods) names.push_back(String(pair.first));
        names.sort();
    }
    Dictionary result;
    result["truncated"] = false;
    result["methods"] = methods;
    const Dictionary reply = success_reply(result);
    for (int index = 0; index < names.size(); ++index) {
        if (index >= limit) {
            result["truncated"] = true;
            break;
        }
        const String& name = names[index];
        const auto& method = info.own_runtime_methods.find(StringName(name))->second;
        methods.append(method_descriptor(binding, method, context.run_scope, context.path, context.id, name));
        if (json_size(reply) > context.budget) {
            if (!requested.is_empty()) return error("output_budget", "Method descriptor exceeds the output budget");
            methods.pop_back();
            result["truncated"] = true;
            break;
        }
    }
    return reply;
}

Dictionary invoke(const Context& context, const RuntimeScriptSnapshot& binding, const String& name,
    const String& expected_stamp, const String& expected_return, const Vector<Variant>& args) {
    Environment* env = binding.environment.get();
    v8::Isolate* isolate = env->get_isolate();
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handles(isolate);
    const auto realm = env->get_context();
    v8::Context::Scope realm_scope(realm);
    v8::Local<v8::Function> fn;
    Variant::Type return_type;
    {
        const auto info = env->find_script_class(binding.class_id);
        if (!info || !info->runtime_methods_ready) return error("binding_changed", "Method registration changed");
        const auto method = info->own_runtime_methods.find(StringName(name));
        if (method == info->own_runtime_methods.end() ||
            expected_stamp != stamp(binding, context.run_scope, context.path, context.id, name, method->second.registration) ||
            expected_return != return_name(method->second.return_type)) {
            return error("binding_changed", "The method token no longer matches this script binding");
        }
        if (args.size() != method->second.parameter_types.size()) return error("bad_args", "Wrong number of arguments");
        for (int index = 0; index < args.size(); ++index) {
            if (args[index].get_type() != method->second.parameter_types[index]) return error("bad_args", "Wrong argument type");
        }
        return_type = method->second.return_type;
        fn = method->second.function.Get(isolate);
    }
    v8::Local<v8::Value> values[8];
    for (int index = 0; index < args.size(); ++index) {
        const char* reason = nullptr;
        if (!runtime_scalar_to_js(env, args[index], values[index], reason)) return error("bad_args", "Could not encode argument");
    }
    v8::Local<v8::Object> receiver;
    if (!env->try_get_object(binding.object_id, receiver)) return error("binding_changed", "The script binding is unavailable");
    if (json_size(entered("result_unavailable", maximum_frame(), "encoding_failed")) > context.budget) {
        return error("output_budget", "The minimum call receipt would exceed the budget");
    }
    {
        Node* checked = nullptr;
        if (const char* failure = context.check(checked)) return error(failure, "The node is no longer available");
        if (!GodotJSScriptInstance::verify_runtime(checked, binding)) return error("binding_changed", "The script binding changed");
    }

    // No node, class-table lock or script-instance pointer survives the call.
    const Dictionary entry_frame = frame();
    v8::Local<v8::Value> result;
    bool threw = false;
#if JSB_WITH_WEB
    const bool returned = fn->CallRuntime(receiver, args.size(), values, threw).ToLocal(&result);
#elif JSB_WITH_QUICKJS
    const bool returned = fn->Call(realm, receiver, args.size(), values).ToLocal(&result);
    if (!returned) {
        const JSValue exception = JS_GetException(isolate->ctx());
        JS_FreeValue(isolate->ctx(), exception);
        isolate->set_stack_copy(impl::StackPos::Exception, impl::StackPos::Null);
        threw = true;
    }
#else
    const impl::TryCatch caught(isolate);
    const bool returned = fn->Call(realm, receiver, args.size(), values).ToLocal(&result);
    threw = caught.has_caught();
#endif
    if (threw) return entered("threw", entry_frame);
    // A broken bridge provides no reliable terminal execution evidence.
    if (!returned) return {};
    Dictionary value;
    if (return_type == Variant::NIL) {
        if (!result->IsUndefined()) return entered("result_unavailable", entry_frame, "type_mismatch");
        value["type"] = "void";
    } else {
        Variant scalar;
        const char* reason = nullptr;
        if (!runtime_scalar_from_js(env, result, return_type, scalar, reason)) {
            const std::string_view failure = reason ? reason : "";
            return entered("result_unavailable", entry_frame,
                failure == "value_too_large" || failure == "encoding_failed" ? reason : "type_mismatch");
        }
        value = typed(scalar);
    }
    Dictionary reply = entered("returned", entry_frame), body = reply["result"];
    body["value"] = value;
    if (json_size(reply) > context.budget) return entered("result_unavailable", entry_frame, "output_budget");
    return reply;
}

Dictionary perform(const Dictionary& request, const std::vector<double>& numbers, Context& context) {
    const auto kind = request.get("kind", Variant());
    if (kind.get_type() != Variant::STRING ||
        !read_path(request.get("path", Variant()), context.path, context.components) ||
        !read_instance_id(request.get("expectedInstanceId", Variant()), context.id) ||
        !integer(request.get("outputBudgetBytes", Variant()), numbers, 1, 65536, context.budget) ||
        !valid_name(request.get("runScope", Variant()), context.run_scope)) {
        return error("invalid_input", "Invalid runtime method command");
    }
    String method, method_stamp, expected_return;
    int limit = 32;
    Vector<Variant> args;
    const bool is_describe = kind == "describe";
    if (is_describe) {
        if (!keys(request, {"kind", "path", "expectedInstanceId", "runScope", "outputBudgetBytes"}, {"method", "limit"}) ||
            (request.has("method") && request.has("limit")) ||
            (request.has("method") && !valid_name(request["method"], method)) ||
            (request.has("limit") && !integer(request["limit"], numbers, 1, 64, limit))) {
            return error("invalid_input", "Invalid runtime method discovery");
        }
    } else {
        if (kind != "invoke" || !keys(request, {"kind", "path", "expectedInstanceId", "runScope", "outputBudgetBytes",
                "method", "methodStamp", "expectedReturnType", "args"}) ||
            !valid_name(request["method"], method) ||
            !valid_name(request["methodStamp"], method_stamp) || !stamp_valid(method_stamp) ||
            !valid_name(request["expectedReturnType"], expected_return) ||
            (expected_return != "void" && !scalar_type(variant_type(expected_return))) ||
            request["args"].get_type() != Variant::ARRAY) return error("invalid_input", "Invalid runtime method invocation");
        const Array supplied = request["args"];
        if (supplied.size() > 8) return error("bad_args", "At most eight arguments are supported");
        for (const Variant& item : supplied) {
            Variant value;
            if (decode_value(item, numbers, value) || !scalar_type(value.get_type()))
                return error("bad_args", "Expected a bounded, typed scalar argument");
            args.push_back(value);
        }
    }

    if (const char* failure = active_scene_error(context.world, context.scene)) return error(failure, "Runtime scene is unavailable");
    Node* node = nullptr;
    if (const char* failure = context.check(node)) return error(failure, "The runtime node is unavailable");
    RuntimeScriptSnapshot binding;
    if (const char* failure = GodotJSScriptInstance::capture_runtime_binding(node, binding))
        return error(failure, "The node has no available GodotJS binding");
    {
        const auto info = binding.environment->find_script_class(binding.class_id);
        if (!info || !info->runtime_methods_ready) return error("not_ready", "Method metadata is unavailable");
        const auto* module = binding.environment->get_module_cache().find(info->module_id);
        if (!module || module->is_reloading() || module->script_class_id != binding.class_id)
            return error("not_ready", "Method metadata is being replaced");
        if (is_describe) return describe(context, binding, *info, method, limit);
    }
    return invoke(context, binding, method, method_stamp, expected_return, args);
}
}

CharString execute_runtime_call(const char* request, uint32_t size, uint32_t remaining_budget_micros, RuntimePropertyClock clock) {
    Context context;
    context.clock = clock ? clock : ticks;
    context.deadline = context.clock() + remaining_budget_micros;
    Dictionary parsed;
    std::vector<double> numbers;
    if (!request || size == 0 || size > RUNTIME_OBSERVATION_REQUEST_BYTES || remaining_budget_micros == 0 ||
        remaining_budget_micros > 30000000 || !unicode_escapes_valid(request, size) ||
        !parse_properties_request(request, size, parsed, numbers)) {
        return stringify(error("invalid_input", "Expected a bounded method request with a positive deadline"));
    }
    const Dictionary reply = perform(parsed, numbers, context);
    if (reply.is_empty()) return {};
    const CharString encoded = stringify(reply);
    return encoded.length() <= context.budget ? encoded : CharString();
}
}

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_call_abi() {
#ifdef GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI
    return 1;
#else
    return 0;
#endif
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_runtime_call_execute(uint32_t size, uint32_t budget_micros) {
    return jsb::runtime_access::execute_buffer(size, [budget_micros](const char* bytes, uint32_t count) {
        return jsb::execute_runtime_call(bytes, count, budget_micros);
    });
}
#endif
#endif // !JSB_WITH_JAVASCRIPTCORE
