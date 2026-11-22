#ifndef GODOTJS_TEST_RUNTIME_SCRIPT_PROPERTIES_H
#define GODOTJS_TEST_RUNTIME_SCRIPT_PROPERTIES_H

#include "jsb_test_helpers.h"
#include "../bridge/jsb_runtime_script_properties.h"
#include "../bridge/jsb_runtime_properties.h"
#include "../bridge/jsb_runtime_access_common.h"
#include "../bridge/jsb_native_world.h"
#include "core/io/json.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "../weaver/jsb_script_instance.h"
#include "scene/2d/node_2d.h"
#include "core/io/resource_loader.h"

namespace jsb::tests {
namespace {

class RuntimeScriptTestWorld {
    bool owns_ = !NativeWorld::current();
    std::shared_ptr<NativeWorld> world_ = NativeWorld::begin();
public:
    ~RuntimeScriptTestWorld() { if (owns_) NativeWorld::end(world_); }
};

bool runtime_metadata_eval(const std::shared_ptr<Environment>& env, const char* source) {
    impl::TryCatch caught(env->get_isolate());
    Error error = OK;
    env->eval_source(source, strlen(source), "runtime-script-properties-test.js", error);
    Utils::print_exception(caught);
    return error == OK && !caught.has_caught();
}

Object* runtime_metadata_fixture(const std::shared_ptr<Environment>& env, bool inherited = false, bool from_js = false) {
    if (from_js) {
        if (!runtime_metadata_eval(env, "globalThis.__runtimeMetadataFixture = new (require('res://.godot/GodotJS/tests/runtime/runtime-properties.js').default)(); __runtimeMetadataFixture.faults_enabled = true;")) return nullptr;
        v8::Local<v8::Value> value;
        if (!env->get_context()->Global()->Get(env->get_context(), impl::Helper::new_string(env->get_isolate(), "__runtimeMetadataFixture")).ToLocal(&value)
            || !value->IsObject()) return nullptr;
        return static_cast<Object*>(env->get_verified_object(value.As<v8::Object>(), NativeClassType::GodotObject));
    }
    const String path = inherited ? "res://tests/runtime/runtime-properties-inherited.ts" : "res://tests/runtime/runtime-properties.ts";
    const Ref<Resource> script = ResourceLoader::load(path);
    if (script.is_null()) return nullptr;
    Node2D* owner = memnew(Node2D);
    owner->set_script(script);
    v8::Local<v8::Object> wrapper;
    if (!owner->get_script_instance() || !env->try_get_object(owner, wrapper)) {
        memdelete(owner);
        return nullptr;
    }
    if (!env->get_context()->Global()->Set(env->get_context(), impl::Helper::new_string(env->get_isolate(), "__runtimeMetadataFixture"), wrapper).FromMaybe(false)) {
        memdelete(owner);
        return nullptr;
    }
    if (!wrapper->Set(env->get_context(), impl::Helper::new_string(env->get_isolate(), "faults_enabled"), v8::Boolean::New(env->get_isolate(), true)).FromMaybe(false)) {
        memdelete(owner);
        return nullptr;
    }
    return owner;
}

RuntimeExportInfo runtime_metadata_property(const RuntimeScriptMetadata& metadata, const StringName& name) {
    for (const RuntimeExportInfo& property : metadata.properties) if (property.name == name) return property;
    return {};
}

}

TEST_CASE("[jsb][SceneTree] runtime properties metadata is static and live reads bypass script cache") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env);
    REQUIRE(node);
    REQUIRE(runtime_metadata_eval(env, "globalThis.__runtimeMetadataCount = __runtimeMetadataFixture.getter_calls;"));
    RuntimeScriptSnapshot snapshot;
    RuntimeScriptMetadata metadata;
    CHECK(GodotJSScriptInstance::capture_runtime(node, snapshot, metadata) == nullptr);
    REQUIRE(bool(snapshot.environment));
    CHECK_FALSE(metadata.metadata_limited);
    CHECK_FALSE(metadata.inheritance_limited);
    CHECK(runtime_metadata_property(metadata, "health").type == Variant::INT);
    CHECK(runtime_metadata_property(metadata, "move_step").type == Variant::FLOAT);
    CHECK(runtime_metadata_property(metadata, "can_move").type == Variant::BOOL);
    CHECK(runtime_metadata_property(metadata, "display_name").type == Variant::STRING);
    CHECK(runtime_metadata_property(metadata, "unsupported_vector").type == Variant::VECTOR2);
    CHECK(runtime_metadata_property(metadata, "inherited_value").type == Variant::INT);
    CHECK(runtime_metadata_property(metadata, "override_value").type == Variant::FLOAT);
    CHECK(double(read_runtime_script_scalar(snapshot, runtime_metadata_property(metadata, "override_value")).value) == 17.25);
    CHECK(runtime_metadata_property(metadata, "internalCounter").name == StringName());
    CHECK(runtime_metadata_eval(env, "if (__runtimeMetadataFixture.getter_calls !== __runtimeMetadataCount) throw Error('metadata executed getter'); __runtimeMetadataFixture.cache_storage = 77;"));

    Variant cached;
    REQUIRE(node->get_script_instance()->get("cached_health", cached));
    CHECK(int64_t(cached) == 33);
    const RuntimeScriptAccess live = read_runtime_script_scalar(snapshot, runtime_metadata_property(metadata, "cached_health"));
    CHECK(live.entered);
    CHECK(live.reason == nullptr);
    CHECK(int64_t(live.value) == 77);
    CHECK(runtime_metadata_eval(env, "if (__runtimeMetadataFixture.getter_calls !== __runtimeMetadataCount + 1) throw Error('live read must execute getter once');"));
    CHECK(GodotJSScriptInstance::verify_runtime(node, snapshot));
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties strict scalars preserve values and report assignment rejection") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env);
    REQUIRE(node);
    RuntimeScriptSnapshot snapshot;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, snapshot, metadata) == nullptr);
    const auto health = runtime_metadata_property(metadata, "health");
    CHECK(write_runtime_script_scalar(snapshot, health, int64_t(40)).reason == nullptr);
    CHECK(int64_t(read_runtime_script_scalar(snapshot, health).value) == 40);
    CHECK(write_runtime_script_scalar(snapshot, health, int64_t(9007199254740991LL)).reason == nullptr);
    CHECK(int64_t(read_runtime_script_scalar(snapshot, health).value) == 9007199254740991LL);
    const auto step = runtime_metadata_property(metadata, "move_step");
    CHECK(write_runtime_script_scalar(snapshot, step, 0.12345678901234568).reason == nullptr);
    CHECK(double(read_runtime_script_scalar(snapshot, step).value) == 0.12345678901234568);
    const auto enabled = runtime_metadata_property(metadata, "can_move");
    CHECK(write_runtime_script_scalar(snapshot, enabled, false).reason == nullptr);
    CHECK_FALSE(bool(read_runtime_script_scalar(snapshot, enabled).value));
    const char32_t text[] = {U'a', 0, U'b', 0x4f60, 0x597d, 0x1f600};
    const String with_nul = String::utf32_unchecked(Span<char32_t>(text, 6));
    const auto name = runtime_metadata_property(metadata, "display_name");
    CHECK(write_runtime_script_scalar(snapshot, name, with_nul).reason == nullptr);
    const RuntimeScriptAccess string = read_runtime_script_scalar(snapshot, name);
    CHECK(string.reason == nullptr);
    CHECK(String(string.value) == with_nul);
    CHECK(String(string.value).length() == 6);
    const char32_t bom_codes[] = {0xfeff, U'a', 0, U'b', 1, 11};
    const String with_bom = String::utf32_unchecked(Span<char32_t>(bom_codes, 6));
    CHECK(write_runtime_script_scalar(snapshot, name, with_bom).reason == nullptr);
    const RuntimeScriptAccess bom_read = read_runtime_script_scalar(snapshot, name);
    CHECK(bom_read.reason == nullptr);
    CHECK(String(bom_read.value) == with_bom);
    const String vector_literal = "Vector2(1, 2)\n\t{ x: 1, y: 2 }";
    CHECK(write_runtime_script_scalar(snapshot, name, vector_literal).reason == nullptr);
    CHECK(String(read_runtime_script_scalar(snapshot, name).value) == vector_literal);
    REQUIRE(runtime_metadata_eval(env, "__runtimeMetadataFixture.display_name = '\\ud800';"));
    const RuntimeScriptAccess malformed = read_runtime_script_scalar(snapshot, name);
    REQUIRE(malformed.reason);
    CHECK(String(malformed.reason) == "encoding_failed");
    REQUIRE(runtime_metadata_eval(env, "__runtimeMetadataFixture.display_name = '\u4f60'.repeat(400);"));
    const RuntimeScriptAccess oversized = read_runtime_script_scalar(snapshot, name);
    REQUIRE(oversized.reason);
    CHECK(String(oversized.reason) == "value_too_large");
    REQUIRE(runtime_metadata_eval(env, "Object.defineProperty(__runtimeMetadataFixture, 'health', {configurable:true, get() { return new Number(8); }});"));
    const RuntimeScriptAccess boxed = read_runtime_script_scalar(snapshot, health);
    REQUIRE(boxed.reason);
    CHECK(String(boxed.reason) == "type_mismatch");
    REQUIRE(runtime_metadata_eval(env, "delete __runtimeMetadataFixture.health;"));
    const auto clamped = runtime_metadata_property(metadata, "clamped_health");
    CHECK(write_runtime_script_scalar(snapshot, clamped, int64_t(140)).reason == nullptr);
    CHECK(int64_t(read_runtime_script_scalar(snapshot, clamped).value) == 100);
    const RuntimeScriptAccess rejected = write_runtime_script_scalar(snapshot, runtime_metadata_property(metadata, "getter_only"), int64_t(8));
    CHECK(rejected.entered);
    REQUIRE(rejected.reason);
    CHECK(String(rejected.reason) == "setter_failed");
    const RuntimeScriptAccess fractional = read_runtime_script_scalar(snapshot, runtime_metadata_property(metadata, "fractional_int"));
    CHECK(fractional.entered);
    REQUIRE(fractional.reason);
    CHECK(String(fractional.reason) == "out_of_range");
    const RuntimeScriptAccess getter_failed = read_runtime_script_scalar(snapshot, runtime_metadata_property(metadata, "throwing_read"));
    CHECK(getter_failed.entered);
    REQUIRE(getter_failed.reason);
    CHECK(String(getter_failed.reason) == "getter_failed");
    CHECK(read_runtime_script_scalar(snapshot, health).reason == nullptr);
    const auto throwing = runtime_metadata_property(metadata, "throwing_write");
    const RuntimeScriptAccess setter_failed = write_runtime_script_scalar(snapshot, throwing, int64_t(77));
    CHECK(setter_failed.entered);
    REQUIRE(setter_failed.reason);
    CHECK(String(setter_failed.reason) == "setter_failed");
    const RuntimeScriptAccess after_throw = read_runtime_script_scalar(snapshot, throwing);
    CHECK(after_throw.reason == nullptr);
    CHECK(int64_t(after_throw.value) == 77);
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties native JSON executes against actual decorated script exports") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Node2D* target = Object::cast_to<Node2D>(runtime_metadata_fixture(env));
    REQUIRE(target);
    target->set_name("RuntimeScriptPropertyTarget");
    Node* root = SceneTree::get_singleton()->get_root();
    REQUIRE(root);
    root->add_child(target);
    const String path = String(target->get_path());
    const String instance = uitos(static_cast<uint64_t>(target->get_instance_id()));
    const auto invoke = [&](Dictionary request) -> Dictionary {
        request["path"] = path;
        request["expectedInstanceId"] = instance;
        request["outputBudgetBytes"] = 65536;
        const CharString bytes = JSON::stringify(request, "", false, true).utf8();
        const CharString reply = execute_runtime_properties(bytes.get_data(), bytes.length(), 5000000);
        REQUIRE(reply.length() > 0);
        JSON json;
        REQUIRE(json.parse(String::utf8(reply.get_data(), reply.length())) == OK);
        REQUIRE(json.get_data().get_type() == Variant::DICTIONARY);
        return json.get_data();
    };
    Dictionary describe;
    describe["kind"] = "describe";
    const Dictionary description = invoke(describe);
    CHECK(bool(description["ok"]));
    const Array descriptors = Dictionary(description["result"])["properties"];
    bool found_health = false;
    for (const Variant& value : descriptors) {
        const Dictionary descriptor = value;
        if (descriptor["name"] == "health") {
            found_health = true;
            CHECK(descriptor["origin"] == "godotjs_export");
            CHECK(descriptor["type"] == "int");
        }
    }
    CHECK(found_health);
    const auto write = [&](const char* property, int64_t value) -> Dictionary {
        Dictionary request, typed;
        request["kind"] = "write";
        request["property"] = property;
        typed["type"] = "int";
        typed["value"] = value;
        request["value"] = typed;
        const Dictionary reply = invoke(request);
        CHECK(bool(reply["ok"]));
        return reply["result"];
    };
    const Dictionary applied = write("health", 40);
    CHECK(applied["outcome"] == "applied");
    CHECK(int64_t(Dictionary(applied["beforeValue"])["value"]) == 100);
    CHECK(int64_t(Dictionary(applied["observedValue"])["value"]) == 40);
    CHECK(bool(applied["writeEntered"]));
    const Dictionary clamped = write("clamped_health", 140);
    CHECK(clamped["outcome"] == "not_applied");
    CHECK(int64_t(Dictionary(clamped["observedValue"])["value"]) == 100);
    Dictionary read, property;
    read["kind"] = "read";
    property["name"] = "fractional_int";
    property["expectedType"] = "int";
    Array properties;
    properties.push_back(property);
    read["properties"] = properties;
    const Dictionary sample = invoke(read);
    CHECK(bool(sample["ok"]));
    const Dictionary sampled = sample["result"];
    CHECK(sampled["outcome"] == "completed");
    const Array samples = sampled["properties"];
    REQUIRE(samples.size() == 1);
    CHECK(Dictionary(samples[0])["status"] == "unavailable");
    CHECK(Dictionary(samples[0])["reason"] == "out_of_range");
    const Dictionary before_failure = write("throwing_read", 1);
    CHECK(before_failure["outcome"] == "not_written");
    CHECK_FALSE(bool(before_failure["writeEntered"]));
    const Dictionary write_failure = write("throwing_write", 77);
    CHECK(write_failure["outcome"] == "unconfirmed");
    CHECK(write_failure["reason"] == "setter_failed");
    CHECK(bool(Dictionary(write_failure["evidence"])["writeEntered"]));
    CHECK(write("health", 41)["outcome"] == "applied");
    const String exact_string_command = vformat(R"({"kind":"write","path":"%s","expectedInstanceId":"%s","outputBudgetBytes":65536,"property":"display_name","value":{"type":"string","value":"\ufeffa\u0000b\u0001\u000b\ud83d\ude00"}})", path, instance);
    const CharString exact_bytes = exact_string_command.utf8();
    const CharString exact_reply = execute_runtime_properties(exact_bytes.get_data(), exact_bytes.length(), 5000000);
    REQUIRE(exact_reply.length() > 0);
    CHECK(std::strstr(exact_reply.get_data(), "\\u0000") != nullptr);
    CHECK(std::strstr(exact_reply.get_data(), "\\u0001") != nullptr);
    CHECK(std::strstr(exact_reply.get_data(), "\\u000b") != nullptr);
    CHECK(std::memchr(exact_reply.get_data(), 0, exact_reply.length()) == nullptr);
    CHECK(runtime_metadata_eval(env, "if (__runtimeMetadataFixture.display_name !== String.fromCharCode(0xfeff,97,0,98,1,11,0xd83d,0xde00)) throw Error('JSON string changed: ' + JSON.stringify(__runtimeMetadataFixture.display_name));"));
    REQUIRE(env->get_context()->Global()->Set(env->get_context(), impl::Helper::new_string(env->get_isolate(), "__runtimePropertiesWire"),
        impl::Helper::new_string(env->get_isolate(), String::utf8(exact_reply.get_data(), exact_reply.length()))).FromMaybe(false));
    CHECK(runtime_metadata_eval(env, "{ const reply = JSON.parse(__runtimePropertiesWire); if (!reply.ok || reply.result.outcome !== 'applied' || reply.result.requestedValue.value !== __runtimeMetadataFixture.display_name || reply.result.observedValue.value !== __runtimeMetadataFixture.display_name) throw Error('JSON wire changed exact string'); }"));
    memdelete(target);
}

TEST_CASE("[jsb][SceneTree] runtime properties JavaScript constructors publish non-reused script tokens") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* first = runtime_metadata_fixture(env, false, true);
    REQUIRE(first);
    RuntimeScriptSnapshot old;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(first, old, metadata) == nullptr);
    CHECK(int64_t(read_runtime_script_scalar(old, runtime_metadata_property(metadata, "health")).value) == 100);
    memdelete(first);
    Object* second = runtime_metadata_fixture(env, false, true);
    REQUIRE(second);
    RuntimeScriptSnapshot fresh;
    RuntimeScriptMetadata fresh_metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(second, fresh, fresh_metadata) == nullptr);
    CHECK(fresh.instance_token > old.instance_token);
    CHECK_FALSE(GodotJSScriptInstance::verify_runtime(second, old));
    memdelete(second);
}

TEST_CASE("[jsb][SceneTree] runtime properties getter self deletion is reported before any write") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* object = runtime_metadata_fixture(env);
    REQUIRE(object);
    Node2D* target = Object::cast_to<Node2D>(object);
    REQUIRE(target);
    target->set_name("RuntimeScriptDeleteTarget");
    SceneTree::get_singleton()->get_root()->add_child(target);
    const ObjectID id = target->get_instance_id();
    const String command = vformat(R"({"kind":"write","path":"/root/RuntimeScriptDeleteTarget","expectedInstanceId":"%s","outputBudgetBytes":65536,"property":"destroy_on_read","value":{"type":"int","value":2}})", uitos(static_cast<uint64_t>(id)));
    const CharString bytes = command.utf8();
    const CharString response = execute_runtime_properties(bytes.get_data(), bytes.length(), 5000000);
    JSON parser;
    REQUIRE(parser.parse(String::utf8(response.get_data(), response.length())) == OK);
    const Dictionary reply = parser.get_data();
    REQUIRE(bool(reply["ok"]));
    const Dictionary result = reply["result"];
    CHECK(result["outcome"] == "not_written");
    CHECK_FALSE(bool(result["writeEntered"]));
    CHECK(result["reason"] == "target_changed");
    CHECK(::ObjectDB::get_instance(id) == nullptr);
}

TEST_CASE("[jsb][SceneTree] runtime properties inherited lookup and same-class rebind retain exact binding identity") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env, true);
    REQUIRE(node);
    const Vector<StringName> requested = {StringName("inherited_value"), StringName("override_value")};
    RuntimeScriptSnapshot original;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, original, metadata, 512, 16, &requested) == nullptr);
    CHECK(metadata.levels_visited == 2);
    CHECK(metadata.properties.size() == 2);
    CHECK(int64_t(read_runtime_script_scalar(original, runtime_metadata_property(metadata, "inherited_value")).value) == 11);
    CHECK(int64_t(read_runtime_script_scalar(original, runtime_metadata_property(metadata, "override_value")).value) == 5);
    {
        const ScriptClassInfoPtr own = env->find_script_class(original.class_id);
        REQUIRE(bool(own));
        CHECK(own->own_runtime_exports.is_empty());
    }
    StringName base_module_id;
    {
        const ScriptClassInfoPtr base = env->find_script_class(original.classes[1].class_id);
        REQUIRE(bool(base));
        base_module_id = base->module_id;
    }
    JavaScriptModule* base_module = env->get_module_cache().find(base_module_id);
    REQUIRE(base_module);
    REQUIRE(ScriptClassInfo::_parse_script_class(env->get_context(), *base_module));
    CHECK_FALSE(GodotJSScriptInstance::verify_runtime(node, original));
    RuntimeScriptSnapshot after_reload;
    RuntimeScriptMetadata reload_metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, after_reload, reload_metadata) == nullptr);
    CHECK(after_reload.classes[1].revision > original.classes[1].revision);
    env->rebind(node, after_reload.class_id);
    CHECK_FALSE(GodotJSScriptInstance::verify_runtime(node, after_reload));
    RuntimeScriptSnapshot fresh;
    RuntimeScriptMetadata fresh_metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, fresh, fresh_metadata) == nullptr);
    CHECK(fresh.binding_generation > original.binding_generation);
    CHECK(GodotJSScriptInstance::verify_runtime(node, fresh));
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties do not authorize an unregistered JavaScript base as a native endpoint") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env, true);
    REQUIRE(node);
    RuntimeScriptSnapshot original;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, original, metadata) == nullptr);
    REQUIRE(original.classes.size() == 2);
    const auto context = env->get_context();
    const auto key = impl::Helper::new_string(env->get_isolate(), "__runtimeMetadataTestClass");
    // The leaf intermediate inherits a loaded script module tag. The base
    // intermediate has no module tag and inherits directly from Node2D.
    for (const RuntimeClassRevision& revision : original.classes) {
        StringName module_id;
        v8::Local<v8::Object> class_obj;
        {
            const ScriptClassInfoPtr info = env->find_script_class(revision.class_id);
            REQUIRE(bool(info));
            module_id = info->module_id;
            class_obj = info->js_class.Get(env->get_isolate());
        }
        REQUIRE(context->Global()->Set(context, key, class_obj).FromMaybe(false));
        REQUIRE(runtime_metadata_eval(env, "globalThis.__runtimeMetadataOldParent = Object.getPrototypeOf(__runtimeMetadataTestClass.prototype); Object.setPrototypeOf(__runtimeMetadataTestClass.prototype, (class extends __runtimeMetadataOldParent.constructor {}).prototype);"));
        JavaScriptModule* module = env->get_module_cache().find(module_id);
        REQUIRE(module);
        REQUIRE(ScriptClassInfo::_parse_script_class(context, *module));
        RuntimeScriptSnapshot rejected;
        RuntimeScriptMetadata rejected_metadata;
        const char* reason = GodotJSScriptInstance::capture_runtime(node, rejected, rejected_metadata);
        REQUIRE(reason);
        CHECK(String(reason) == "not_ready");
        REQUIRE(runtime_metadata_eval(env, "Object.setPrototypeOf(__runtimeMetadataTestClass.prototype, __runtimeMetadataOldParent);"));
        REQUIRE(ScriptClassInfo::_parse_script_class(context, *module));
        RuntimeScriptSnapshot restored;
        RuntimeScriptMetadata restored_metadata;
        CHECK(GodotJSScriptInstance::capture_runtime(node, restored, restored_metadata) == nullptr);
    }
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties nested rebind cannot publish an outer binding as ready") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env);
    REQUIRE(node);
    RuntimeScriptSnapshot original;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, original, metadata) == nullptr);
    const auto context = env->get_context();
    v8::Local<v8::Object> original_class;
    {
        const ScriptClassInfoPtr info = env->find_script_class(original.class_id);
        REQUIRE(bool(info));
        original_class = info->js_class.Get(env->get_isolate());
    }
    REQUIRE(context->Global()->Set(context, impl::Helper::new_string(env->get_isolate(), "__runtimeRebindClass"), original_class).FromMaybe(false));
    const auto rebind_again = v8::Function::New(context, [](const v8::FunctionCallbackInfo<v8::Value>& info) {
        Environment* callback_env = Environment::wrap(info.GetIsolate());
        Object* owner = static_cast<Object*>(info.Data().As<v8::External>()->Value());
        const auto ticket = callback_env->get_binding_ticket(owner);
        if (ticket) callback_env->rebind(owner, ticket->runtime_bound_class_id);
    }, v8::External::New(env->get_isolate(), node)).ToLocalChecked();
    REQUIRE(context->Global()->Set(context, impl::Helper::new_string(env->get_isolate(), "__runtimeRebindAgain"), rebind_again).FromMaybe(false));
    REQUIRE(runtime_metadata_eval(env, "globalThis.__runtimeRebindOnce = true; globalThis.__runtimeRebindProxy = new Proxy(__runtimeRebindClass, {get(target, key, receiver) { if (key === 'prototype' && __runtimeRebindOnce) { __runtimeRebindOnce = false; __runtimeRebindAgain(); } return Reflect.get(target, key, receiver); }});"));
    v8::Local<v8::Value> proxy;
    REQUIRE(context->Global()->Get(context, impl::Helper::new_string(env->get_isolate(), "__runtimeRebindProxy")).ToLocal(&proxy));
    REQUIRE(proxy->IsObject());
    {
        const ScriptClassInfoPtr info = env->find_script_class(original.class_id);
        REQUIRE(bool(info));
        info->js_class.Reset(env->get_isolate(), proxy.As<v8::Object>());
    }
    env->rebind(node, original.class_id);
    CHECK_FALSE(GodotJSScriptInstance::verify_runtime(node, original));
    RuntimeScriptSnapshot rejected;
    RuntimeScriptMetadata rejected_metadata;
    const char* reason = GodotJSScriptInstance::capture_runtime(node, rejected, rejected_metadata);
    REQUIRE(reason);
    CHECK(String(reason) == "not_ready");
    {
        const ScriptClassInfoPtr info = env->find_script_class(original.class_id);
        REQUIRE(bool(info));
        info->js_class.Reset(env->get_isolate(), original_class);
    }
    env->rebind(node, original.class_id);
    RuntimeScriptSnapshot restored;
    RuntimeScriptMetadata restored_metadata;
    CHECK(GodotJSScriptInstance::capture_runtime(node, restored, restored_metadata) == nullptr);
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties malformed own exports remain unavailable after legacy parse") {
    RuntimeScriptTestWorld world;
    GodotJSScriptLanguageIniter initer;
    const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get());
    Object* node = runtime_metadata_fixture(env);
    REQUIRE(node);
    RuntimeScriptSnapshot original;
    RuntimeScriptMetadata metadata;
    REQUIRE(GodotJSScriptInstance::capture_runtime(node, original, metadata) == nullptr);
    const auto context = env->get_context();
    v8::Local<v8::Object> class_obj;
    StringName module_id;
    {
        const ScriptClassInfoPtr info = env->find_script_class(original.class_id);
        REQUIRE(bool(info));
        module_id = info->module_id;
        class_obj = info->js_class.Get(env->get_isolate());
    }
    v8::Local<v8::Value> prototype, original_exports;
    REQUIRE(class_obj->Get(context, impl::Helper::new_string(env->get_isolate(), "prototype")).ToLocal(&prototype));
    REQUIRE(prototype->IsObject());
    const auto symbol = env->get_symbol(Symbols::ClassProperties);
    REQUIRE(prototype.As<v8::Object>()->Get(context, symbol).ToLocal(&original_exports));
    REQUIRE(original_exports->IsArray());
    JavaScriptModule* module = env->get_module_cache().find(module_id);
    REQUIRE(module);
    for (int invalid_shape = 0; invalid_shape < 2; ++invalid_shape) {
        const auto invalid_array = v8::Array::New(env->get_isolate());
        REQUIRE(invalid_array->Set(context, uint32_t(0), v8::Null(env->get_isolate())).FromMaybe(false));
        const v8::Local<v8::Value> malformed = invalid_shape ? v8::Local<v8::Value>(invalid_array) : v8::Local<v8::Value>(v8::Null(env->get_isolate()));
        REQUIRE(prototype.As<v8::Object>()->Set(context, symbol, malformed).FromMaybe(false));
        REQUIRE(ScriptClassInfo::_parse_script_class(context, *module));
        RuntimeScriptSnapshot rejected;
        RuntimeScriptMetadata rejected_metadata;
        const char* reason = GodotJSScriptInstance::capture_runtime(node, rejected, rejected_metadata);
        REQUIRE(reason);
        CHECK(String(reason) == "not_ready");
    }
    // Keep runtime names exact even where the legacy string bridge strips BOM
    // or stops at NUL. Invalid names must not alias another exported field.
    const char32_t bom_name_codes[] = {0xfeff, U'h', U'e', U'a', U'l', U't', U'h'};
    const char32_t nul_name_codes[] = {U'h', U'e', U'a', U'l', U't', U'h', 0, U'x'};
    const String exact_names[] = {
        String::utf32_unchecked(Span<char32_t>(bom_name_codes, 7)),
        String::utf32_unchecked(Span<char32_t>(nul_name_codes, 8)),
        String("x").repeat(257),
    };
    for (int name_index = 0; name_index < 3; ++name_index) {
        const auto entry = v8::Object::New(env->get_isolate());
        v8::Local<v8::Value> name_value;
        const char* conversion_error = nullptr;
        REQUIRE(runtime_scalar_to_js(env.get(), exact_names[name_index], name_value, conversion_error));
        REQUIRE(entry->Set(context, impl::Helper::new_string(env->get_isolate(), "name"), name_value).FromMaybe(false));
        REQUIRE(entry->Set(context, impl::Helper::new_string(env->get_isolate(), "type"), v8::Int32::New(env->get_isolate(), Variant::INT)).FromMaybe(false));
        const auto exports = v8::Array::New(env->get_isolate());
        REQUIRE(exports->Set(context, uint32_t(0), entry).FromMaybe(false));
        REQUIRE(prototype.As<v8::Object>()->Set(context, symbol, exports).FromMaybe(false));
        REQUIRE(ScriptClassInfo::_parse_script_class(context, *module));
        RuntimeScriptSnapshot exact_snapshot;
        RuntimeScriptMetadata exact_metadata;
        const char* reason = GodotJSScriptInstance::capture_runtime(node, exact_snapshot, exact_metadata);
        if (name_index == 0) {
            REQUIRE(reason == nullptr);
            CHECK(runtime_metadata_property(exact_metadata, exact_names[0]).name == StringName(exact_names[0]));
            CHECK(runtime_metadata_property(exact_metadata, "health").name == StringName());
            REQUIRE(runtime_metadata_eval(env, "__runtimeMetadataFixture[String.fromCharCode(0xfeff) + 'health'] = 9;"));
            const RuntimeScriptAccess exact_read = read_runtime_script_scalar(exact_snapshot, runtime_metadata_property(exact_metadata, exact_names[0]));
            CHECK(exact_read.reason == nullptr);
            CHECK(int64_t(exact_read.value) == 9);
            CHECK(write_runtime_script_scalar(exact_snapshot, runtime_metadata_property(exact_metadata, exact_names[0]), int64_t(10)).reason == nullptr);
            CHECK(runtime_metadata_eval(env, "if (__runtimeMetadataFixture[String.fromCharCode(0xfeff) + 'health'] !== 10 || __runtimeMetadataFixture.health !== 100) throw Error('runtime name alias');"));
        } else {
            REQUIRE(reason);
            CHECK(String(reason) == "not_ready");
        }
    }
    REQUIRE(prototype.As<v8::Object>()->Set(context, symbol, original_exports).FromMaybe(false));
    REQUIRE(ScriptClassInfo::_parse_script_class(context, *module));
    RuntimeScriptSnapshot restored;
    RuntimeScriptMetadata restored_metadata;
    CHECK(GodotJSScriptInstance::capture_runtime(node, restored, restored_metadata) == nullptr);
    CHECK(runtime_metadata_property(restored_metadata, "health").type == Variant::INT);
    memdelete(node);
}

TEST_CASE("[jsb][SceneTree] runtime properties wire strings retain NUL BOM Unicode and strict JSON escapes") {
    const char utf8[] = {'a', 0, 'b', char(0xef), char(0xbb), char(0xbf), char(0xe4), char(0xbd), char(0xa0), char(0xe5), char(0xa5), char(0xbd), char(0xf0), char(0x9f), char(0x98), char(0x80)};
    const char32_t expected_text[] = {U'a', 0, U'b', 0xfeff, 0x4f60, 0x597d, 0x1f600};
    const String expected = String::utf32_unchecked(Span<char32_t>(expected_text, 7));
    String decoded;
    REQUIRE(runtime_access::decode_utf8_exact(utf8, sizeof(utf8), decoded));
    CHECK(decoded == expected);
    CHECK(decoded.length() == 7);
    CHECK(decoded[1] == 0);
    const char invalid[][4] = {{char(0xc0), char(0x80), 0, 0}, {char(0xed), char(0xa0), char(0x80), 0}, {char(0xf0), char(0x9f), 0, 0}};
    CHECK_FALSE(runtime_access::decode_utf8_exact(invalid[0], 2, decoded));
    CHECK_FALSE(runtime_access::decode_utf8_exact(invalid[1], 3, decoded));
    CHECK_FALSE(runtime_access::decode_utf8_exact(invalid[2], 2, decoded));
    const char* request = R"({"value":"a\u0000b\ufeff\u4f60\u597d\ud83d\ude00","controls":"\u0001\u000b","array":["a\"b",3.14],"budget":65536})";
    Dictionary parsed;
    std::vector<double> numbers;
    REQUIRE(runtime_access::parse_properties_request(request, strlen(request), parsed, numbers));
    CHECK(String(parsed["value"]) == expected);
    CHECK(String(parsed["value"])[1] == 0);
    CHECK(String(parsed["controls"]).length() == 2);
    CHECK(String(parsed["controls"])[0] == 1);
    CHECK(String(parsed["controls"])[1] == 11);
    CHECK(String(Array(parsed["array"])[0]) == "a\"b");
    REQUIRE(numbers.size() == 2);
    CHECK(numbers[0] == 3.14);
    CHECK(numbers[1] == 65536);
    CHECK(int64_t(parsed["budget"]) == 1);
    const char* duplicate = R"({"a":1,"\u0061":2})";
    CHECK_FALSE(runtime_access::parse_properties_request(duplicate, strlen(duplicate), parsed, numbers));
    const char* lone_surrogate = R"({"value":"\ud800"})";
    CHECK_FALSE(runtime_access::parse_properties_request(lone_surrogate, strlen(lone_surrogate), parsed, numbers));
    const char* escaped_literal = R"({"value":"\\u0000"})";
    REQUIRE(runtime_access::parse_properties_request(escaped_literal, strlen(escaped_literal), parsed, numbers));
    CHECK(String(parsed["value"]) == "\\u0000");
}
}
#endif
