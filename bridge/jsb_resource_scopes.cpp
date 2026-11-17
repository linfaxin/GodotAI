#include "jsb_resource_scopes.h"
#include "jsb_environment.h"
#include "jsb_native_world.h"
#include "jsb_native_hooks.h"
#include "jsb_type_convert.h"
#include "core/config/engine.h"
#include "core/io/resource.h"
#include "core/templates/hash_set.h"
#include "scene/main/node.h"
#include <unordered_map>

namespace jsb {
namespace {
enum Op { OPEN, REMAP, FINISH, CLOSE };
void put(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& object, const char* name, const v8::Local<v8::Value>& value) {
    object->Set(context, impl::Helper::new_string_ascii(context->GetIsolate(), name), value).Check();
}
bool inspect(const Variant& value, HashSet<ObjectID>& seen, String& reason, int& budget, int depth) {
    if (depth > 64 || --budget < 0) { reason = "E_LOCAL_RESOURCE_GRAPH: resource graph exceeds the traversal budget"; return false; }
    if (value.get_type() == Variant::CALLABLE || value.get_type() == Variant::SIGNAL || value.get_type() == Variant::RID) {
        reason = "E_LOCAL_RESOURCE_GRAPH: callable, signal and server-handle references are unsupported"; return false;
    }
    if (value.get_type() == Variant::ARRAY) {
        const Array values = value;
        for (int i = 0; i < values.size(); ++i) if (!inspect(values[i], seen, reason, budget, depth + 1)) return false;
        return true;
    }
    if (value.get_type() == Variant::DICTIONARY) {
        const Dictionary values = value;
        for (const KeyValue<Variant,Variant>& pair : values)
            if (!inspect(pair.key, seen, reason, budget, depth + 1) || !inspect(pair.value, seen, reason, budget, depth + 1)) return false;
        return true;
    }
    if (value.get_type() != Variant::OBJECT) return true;
    Object* object = value.get_validated_object(); if (!object) return true;
    Resource* resource = Object::cast_to<Resource>(object);
    if (!resource) { reason = "E_LOCAL_RESOURCE_GRAPH: Node and arbitrary Object references are unsupported"; return false; }
    if (seen.has(resource->get_instance_id())) return true;
    seen.insert(resource->get_instance_id());
    if (resource->is_class("Script") || !resource->get_script().is_null()) { reason = "E_LOCAL_RESOURCE_SCRIPT: scripted resource graphs require a separate execution contract"; return false; }
    List<PropertyInfo> properties; resource->get_property_list(&properties);
    for (const PropertyInfo& property : properties)
        if ((property.usage & PROPERTY_USAGE_STORAGE) && property.name != StringName("script") && !inspect(resource->get(property.name), seen, reason, budget, depth + 1)) return false;
    return true;
}
}

struct ResourceScopes::Impl {
    struct Scope {
        ObjectID root;
        HashMap<Ref<Resource>,Ref<Resource>> remap;
        bool finished = false;
        bool finishing = false;
        bool closed = false;
        void clear() { remap.clear(); root = ObjectID(); finished = true; closed = true; }
    };
    Environment* environment;
    bool active = true;
    std::unordered_map<uintptr_t,std::shared_ptr<Scope>> scopes;
    explicit Impl(Environment* value) : environment(value) {}
};

ResourceScopes::ResourceScopes(Environment* environment) : impl_(std::make_unique<Impl>(environment)) {}
ResourceScopes::~ResourceScopes() { dispose(); }
void ResourceScopes::dispose() {
    if (!impl_->active) return; impl_->active = false;
    for (auto& pair : impl_->scopes) { pair.second->closed = true; if (!pair.second->finishing) pair.second->clear(); }
    impl_->scopes.clear();
}

void ResourceScopes::dispatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* isolate = info.GetIsolate(); const auto context = isolate->GetCurrentContext(); Environment* environment = Environment::wrap(isolate);
    auto fail = [&](const String& reason) { impl::Helper::throw_error(isolate, reason); };
    if (!environment || environment->is_disposing() || !environment->is_caller_thread() || !Thread::is_main_thread()) { fail("E_LOCAL_RESOURCE_THREAD: a live owner environment is required"); return; }
    auto& state = *environment->get_resource_scopes().impl_; const int op = info.Data().As<v8::Int32>()->Value();
    if (!state.active) { fail("E_LOCAL_RESOURCE_SCOPE: resource registry is closed"); return; }
    const auto world = environment->get_native_world();
    if (op != CLOSE && (!world || !world->can_commit() || Engine::get_singleton()->is_in_physics_frame())) { fail("E_LOCAL_RESOURCE_TIMING: a safe native commit stage is required"); return; }
    NativeInteropScope interop_scope;
    if (op == OPEN) {
        Object* object = nullptr;
        if (info.Length() != 1 || !TypeConvert::js_to_gd_obj(isolate, context, info[0], object)) { fail("E_LOCAL_RESOURCE_ROOT: a detached native root is required"); return; }
        Node* root = Object::cast_to<Node>(object);
        if (!root || root->get_parent() || root->is_inside_tree() || !world->permits_binding(root->get_instance_id(), environment->binding_epoch())) { fail("E_LOCAL_RESOURCE_ROOT: root must be detached and belong to this environment"); return; }
        if (state.scopes.size() >= 1024) { fail("E_LOCAL_RESOURCE_BUDGET: resource scope budget exceeded"); return; }
        const uintptr_t token = native_capability_token();
        if (!token) { fail("E_LOCAL_RESOURCE_BUDGET: native capability identities exhausted"); return; }
        auto scope = std::make_shared<Impl::Scope>(); scope->root = root->get_instance_id(); state.scopes.emplace(uintptr_t(token), scope);
        info.GetReturnValue().Set(v8::External::New(isolate, reinterpret_cast<void*>(uintptr_t(token)))); return;
    }
    uintptr_t token = 0;
    if (info.Length() && info[0]->IsExternal()) token = reinterpret_cast<uintptr_t>(info[0].As<v8::External>()->Value());
    const auto found = state.scopes.find(token);
    if (found == state.scopes.end()) { if (op == CLOSE) { info.GetReturnValue().Set(v8::Boolean::New(isolate, false)); return; } fail("E_LOCAL_RESOURCE_SCOPE: foreign or closed capability"); return; }
    const auto scope = found->second; // Retain across native setup callback reentry.
    if (op == CLOSE) { scope->closed = true; state.scopes.erase(found); if (!scope->finishing) scope->clear(); info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return; }
    Node* root = Object::cast_to<Node>(::ObjectDB::get_instance(scope->root));
    if (!root || scope->closed) { fail("E_LOCAL_RESOURCE_SCOPE: native scene root no longer exists"); return; }
    if (op == REMAP) {
        Object* object = nullptr;
        if (info.Length() != 2 || !TypeConvert::js_to_gd_obj(isolate, context, info[1], object)) { fail("E_LOCAL_RESOURCE_SOURCE: a native Resource is required"); return; }
        Ref<Resource> resource(Object::cast_to<Resource>(object));
        if (resource.is_null() || !resource->is_local_to_scene()) { fail("E_LOCAL_RESOURCE_POLICY: source must have resource_local_to_scene"); return; }
        Ref<Resource> result;
        if (const Ref<Resource>* existing = scope->remap.getptr(resource)) result = *existing;
        else {
            if (scope->finished || scope->finishing || root->get_parent() || root->is_inside_tree()) { fail("E_LOCAL_RESOURCE_SCOPE: new local resources require an unsealed detached root"); return; }
            HashSet<ObjectID> seen; String reason; int budget = 20000;
            if (!inspect(resource, seen, reason, budget, 0)) { fail(reason); return; }
            result = resource->duplicate_for_local_scene(root, scope->remap);
            if (result.is_null() || result == resource || result->get_local_scene() != root) { fail("E_LOCAL_RESOURCE_DUPLICATE: native local-scene duplication failed"); return; }
            scope->remap.insert(resource,result);
        }
        v8::Local<v8::Value> value;
        if (!TypeConvert::gd_var_to_js(isolate,context,Variant(result),value)) { fail("E_LOCAL_RESOURCE_CODEC: native Resource binding failed"); return; }
        info.GetReturnValue().Set(value); return;
    }
    if (op == FINISH) {
        if (scope->finished) { info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return; }
        if (root->get_parent() || root->is_inside_tree()) { fail("E_LOCAL_RESOURCE_TIMING: seal before attaching the template root"); return; }
        if (scope->finishing) { fail("E_LOCAL_RESOURCE_REENTRY: recursive scope setup is forbidden"); return; }
        scope->finishing = true; HashSet<ObjectID> configured;
        for (const auto& pair : scope->remap) {
            if (scope->closed) break;
            if (configured.has(pair.value->get_instance_id())) continue;
            configured.insert(pair.value->get_instance_id()); pair.value->setup_local_to_scene();
        }
        scope->finishing = false; scope->finished = true; if (scope->closed) scope->clear();
        info.GetReturnValue().Set(v8::Boolean::New(isolate, !scope->closed)); return;
    }
    fail("E_LOCAL_RESOURCE_OPERATION: unknown scope operation");
}

void ResourceScopes::install(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal) {
    auto* isolate = context->GetIsolate(); auto api = v8::Object::New(isolate); put(context,api,"abi",v8::Int32::New(isolate,1));
    for (const auto& method : {std::pair<const char*,int>{"open",OPEN},{"remap",REMAP},{"finish",FINISH},{"close",CLOSE}})
        put(context,api,method.first,JSB_NEW_FUNCTION(context,dispatch,v8::Int32::New(isolate,method.second)));
    put(context,internal,"resource_scopes",api);
}
}
