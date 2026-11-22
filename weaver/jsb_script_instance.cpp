#include "jsb_script_instance.h"
#include "jsb_script_language.h"

GodotJSScriptInstance::GodotJSScriptInstance()
    : runtime_instance_token_(jsb::next_runtime_script_identity()) {
}

void GodotJSScriptInstance::publish_runtime_binding() {
    if (!env_ || !owner_ || !object_id_) return;
    const std::shared_ptr<jsb::ObjectBindingTicket> ticket = env_->get_binding_ticket(owner_);
    if (!ticket || !env_->verify_binding(ticket)) return;
    ticket->runtime_script_ready = false;
    ticket->runtime_instance_token = runtime_instance_token_;
    ticket->runtime_script_generation = jsb::next_runtime_script_identity();
    ticket->runtime_bound_class_id = class_id_;
    ticket->runtime_script_ready = runtime_instance_token_ != 0 && ticket->runtime_script_generation != 0;
}

const char* GodotJSScriptInstance::capture_runtime(Object* owner, jsb::RuntimeScriptSnapshot& snapshot,
    jsb::RuntimeScriptMetadata& metadata, int max_entries, int max_levels, const Vector<StringName>* requested_names) {
    snapshot = {};
    metadata = {};
    if (!owner) return "node_not_found";
    ScriptInstance* raw = owner->get_script_instance();
    if (!raw || raw->is_placeholder() || raw->get_language() != GodotJSScriptLanguage::get_singleton()) return "unsupported";
    GodotJSScriptInstanceBase* base = static_cast<GodotJSScriptInstanceBase*>(raw);
    if (base->is_shadow()) return "not_ready";
    GodotJSScriptInstance* instance = static_cast<GodotJSScriptInstance*>(base);
    const std::shared_ptr<jsb::Environment> env = instance->env_;
    if (!env || env->get_thread_id() != Thread::get_caller_id() || env->native_cleanup_phase() != 0) return "not_ready";
    const std::shared_ptr<jsb::ObjectBindingTicket> ticket = env->get_binding_ticket(owner);
    if (!ticket || !env->verify_binding(ticket) || !ticket->runtime_script_ready
        || ticket->runtime_instance_token != instance->runtime_instance_token_) return "not_ready";
    snapshot.environment = env;
    snapshot.ticket = ticket;
    snapshot.owner_id = owner->get_instance_id();
    snapshot.object_id = instance->object_id_;
    snapshot.instance_token = instance->runtime_instance_token_;
    snapshot.binding_generation = ticket->runtime_script_generation;
    snapshot.class_id = ticket->runtime_bound_class_id;

    jsb::ScriptClassID current = snapshot.class_id;
    HashSet<StringName> names;
    HashSet<StringName> modules;
    for (;;) {
        if (metadata.levels_visited >= max_levels) {
            metadata.inheritance_limited = true;
            break;
        }
        StringName parent_module;
        {
            const jsb::ScriptClassInfoPtr info = env->find_script_class(current);
            if (!info || !info->runtime_metadata_ready || info->runtime_metadata_revision == 0) return "not_ready";
            if (modules.has(info->module_id)) return "not_ready";
            modules.insert(info->module_id);
            const jsb::JavaScriptModule* module = env->get_module_cache().find(info->module_id);
            if (!module || module->is_reloading() || module->script_class_id != current) return "not_ready";
            snapshot.classes.push_back({current, info->runtime_metadata_revision});
            ++metadata.levels_visited;
            parent_module = info->runtime_base_script_module_id;
            if (requested_names) {
                // Direct map lookup remains useful when an export table is
                // larger than the bounded enumeration window.
                for (const StringName& requested_name : *requested_names) {
                    if (names.has(requested_name)) continue;
                    if (metadata.entries_visited >= max_entries) {
                        metadata.metadata_limited = true;
                        break;
                    }
                    ++metadata.entries_visited;
                    if (const jsb::RuntimeExportInfo* entry = info->own_runtime_exports.getptr(requested_name)) {
                        names.insert(requested_name);
                        metadata.properties.push_back(*entry);
                    }
                }
            } else {
                for (const KeyValue<StringName, jsb::RuntimeExportInfo>& entry : info->own_runtime_exports) {
                    if (metadata.entries_visited >= max_entries) {
                        metadata.metadata_limited = true;
                        break;
                    }
                    ++metadata.entries_visited;
                    if (names.has(entry.key)) continue;
                    names.insert(entry.key);
                    metadata.properties.push_back(entry.value);
                }
            }
        }
        if (parent_module == StringName()) break;
        const jsb::JavaScriptModule* parent = env->get_module_cache().find(parent_module);
        if (!parent || parent->is_reloading() || !parent->script_class_id) return "not_ready";
        current = parent->script_class_id;
    }
    return nullptr;
}

bool GodotJSScriptInstance::verify_runtime(Object* owner, const jsb::RuntimeScriptSnapshot& snapshot) {
    if (!owner || owner->get_instance_id() != snapshot.owner_id || !snapshot.environment || !snapshot.ticket) return false;
    ScriptInstance* raw = owner->get_script_instance();
    if (!raw || raw->is_placeholder() || raw->get_language() != GodotJSScriptLanguage::get_singleton()) return false;
    GodotJSScriptInstanceBase* base = static_cast<GodotJSScriptInstanceBase*>(raw);
    if (base->is_shadow()) return false;
    GodotJSScriptInstance* instance = static_cast<GodotJSScriptInstance*>(base);
    const std::shared_ptr<jsb::Environment>& env = snapshot.environment;
    if (instance->env_ != env || instance->runtime_instance_token_ != snapshot.instance_token
        || instance->object_id_ != snapshot.object_id || env->get_thread_id() != Thread::get_caller_id()
        || env->native_cleanup_phase() != 0 || !env->verify_binding(snapshot.ticket)) return false;
    const std::shared_ptr<jsb::ObjectBindingTicket> ticket = env->get_binding_ticket(owner);
    if (ticket != snapshot.ticket || !ticket->runtime_script_ready
        || ticket->runtime_instance_token != snapshot.instance_token
        || ticket->runtime_script_generation != snapshot.binding_generation
        || ticket->runtime_bound_class_id != snapshot.class_id) return false;
    for (const jsb::RuntimeClassRevision& revision : snapshot.classes) {
        const jsb::ScriptClassInfoPtr info = env->find_script_class(revision.class_id);
        if (!info || !info->runtime_metadata_ready || info->runtime_metadata_revision != revision.revision) return false;
        const jsb::JavaScriptModule* module = env->get_module_cache().find(info->module_id);
        if (!module || module->is_reloading() || module->script_class_id != revision.class_id) return false;
    }
    return true;
}

namespace jsb {
namespace {
void clear_runtime_access_exception(v8::Isolate* isolate) {
    // Return a structured access failure without evaluating arbitrary thrown
    // objects' message/stack getters, or leaving the VM error slot dirty.
#if JSB_WITH_WEB
    jsbi_StackSet(isolate->rt(), impl::StackBase::Error, impl::StackBase::Undefined);
#elif JSB_WITH_QUICKJS
    const JSValue error = JS_GetException(isolate->ctx());
    JS_FreeValue(isolate->ctx(), error);
    isolate->set_stack_copy(impl::StackPos::Exception, impl::StackPos::Null);
#else
    // V8's scoped TryCatch consumes its exception on destruction.
    (void) isolate;
#endif
}
}
RuntimeScriptAccess read_runtime_script_scalar(const RuntimeScriptSnapshot& snapshot,
    const RuntimeExportInfo& property) {
    RuntimeScriptAccess result;
    Object* owner = ::ObjectDB::get_instance(snapshot.owner_id);
    if (!GodotJSScriptInstance::verify_runtime(owner, snapshot)) { result.reason = "target_changed"; return result; }
    Environment* env = snapshot.environment.get();
    v8::Isolate* isolate = env->get_isolate();
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handles(isolate);
    const v8::Local<v8::Context> context = env->get_context();
    v8::Context::Scope context_scope(context);
    v8::Local<v8::Object> self;
    if (!env->try_get_object(snapshot.object_id, self)) { result.reason = "target_changed"; return result; }
    const impl::TryCatch caught(isolate);
    v8::Local<v8::Value> value;
    v8::Local<v8::Value> key;
    if (!runtime_scalar_to_js(env, String(property.name), key, result.reason)) {
        clear_runtime_access_exception(isolate);
        result.reason = "not_ready";
        return result;
    }
    result.entered = true;
    if (!self->Get(context, key).ToLocal(&value) || caught.has_caught()) {
        clear_runtime_access_exception(isolate);
        result.reason = "getter_failed";
        return result;
    }
    if (!runtime_scalar_from_js(env, value, property.type, result.value, result.reason)) {
        clear_runtime_access_exception(isolate);
        if (!result.reason) result.reason = "type_mismatch";
    }
    return result;
}

RuntimeScriptAccess write_runtime_script_scalar(const RuntimeScriptSnapshot& snapshot,
    const RuntimeExportInfo& property, const Variant& value) {
    RuntimeScriptAccess result;
    Object* owner = ::ObjectDB::get_instance(snapshot.owner_id);
    if (!GodotJSScriptInstance::verify_runtime(owner, snapshot)) { result.reason = "target_changed"; return result; }
    Environment* env = snapshot.environment.get();
    v8::Isolate* isolate = env->get_isolate();
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handles(isolate);
    const v8::Local<v8::Context> context = env->get_context();
    v8::Context::Scope context_scope(context);
    v8::Local<v8::Object> self;
    if (!env->try_get_object(snapshot.object_id, self)) { result.reason = "target_changed"; return result; }
    const impl::TryCatch caught(isolate);
    v8::Local<v8::Value> converted;
    if (!runtime_scalar_to_js(env, value, converted, result.reason)) {
        clear_runtime_access_exception(isolate);
        if (!result.reason) result.reason = "encoding_failed";
        return result;
    }
    v8::Local<v8::Value> key;
    if (!runtime_scalar_to_js(env, String(property.name), key, result.reason)) {
        clear_runtime_access_exception(isolate);
        result.reason = "encoding_failed";
        return result;
    }
    result.entered = true;
    const v8::Maybe<bool> written = self->Set(context, key, converted);
    if (caught.has_caught() || written.IsNothing() || !written.FromMaybe(false)) {
        clear_runtime_access_exception(isolate);
        result.reason = "setter_failed";
    }
    return result;
}
}


GodotJSScriptInstanceBase::ScriptCallProfilingScope::ScriptCallProfilingScope(const ScriptProfilingInfo& p_info, const StringName& p_method)
            : info_(p_info), method_(p_method)
{
    start_time_ = OS::get_singleton()->get_ticks_usec();
}

GodotJSScriptInstanceBase::ScriptCallProfilingScope::~ScriptCallProfilingScope()
{
    GodotJSScriptLanguage::get_singleton()->add_script_call_profile_info(
        info_.path_,
        info_.class_,
        method_,
        OS::get_singleton()->get_ticks_usec() - start_time_);
}

GodotJSScriptInstanceBase::~GodotJSScriptInstanceBase()
{
    jsb_check(owner_);

    // When script binding fails due to an invalid script, we delete the invalid script instance.
    if (script_.is_valid())
    {
        jsb_check(script_->get_language());
        const GodotJSScriptLanguage* lang = (GodotJSScriptLanguage*) script_->get_language();
        MutexLock lock(lang->mutex_);
        script_->instances_.erase(owner_);
    }
}

jsb::ScriptClassInfoPtr GodotJSScriptInstance::get_script_class() const
{
    return env_->get_script_class(class_id_);
}

void GodotJSScriptInstance::postbind()
{
    // Store initial value for cached props
    for (auto& it : this->script_->script_class_info_.properties)
    {
        if (it.value.cache)
        {
            Variant value;
            env_->get_script_property_value(object_id_, it.value, value);
            property_cache_.insert(it.key, value);
        }
    }
}

void GodotJSScriptInstance::cache_property(const StringName& name, const Variant& value)
{
    property_cache_.insert(name, value);
}

bool GodotJSScriptInstance::set(const StringName& p_name, const Variant& p_value)
{
    if (const auto& it = script_->script_class_info_.properties.find(p_name); it)
    {
        return env_->set_script_property_value(object_id_, it->value, p_value);
    }
    return false;
}

bool GodotJSScriptInstance::get(const StringName& p_name, Variant& r_ret) const
{
    const Variant* cached_value = property_cache_.getptr(p_name);

    if (cached_value)
    {
        r_ret = *cached_value;
        return true;
    }

    if (const auto& it = script_->script_class_info_.properties.find(p_name); it)
    {
        return env_->get_script_property_value(object_id_, it->value, r_ret);
    }

    return false;
}

void GodotJSScriptInstance::get_property_list(List<PropertyInfo>* p_properties) const
{
    script_->get_script_property_list(p_properties);
}

const Variant GodotJSScriptInstance::get_rpc_config() const
{
    return get_script_class()->rpc_config;
}

Variant::Type GodotJSScriptInstance::get_property_type(const StringName& p_name, bool* r_is_valid) const
{
    const jsb::ScriptClassInfoPtr class_info = get_script_class();
    if (const HashMap<StringName, jsb::ScriptPropertyInfo>::ConstIterator it = class_info->properties.find(p_name))
    {
        if (r_is_valid) *r_is_valid = true;
        return it->value.type;
    }
    if (r_is_valid) *r_is_valid = false;
    return Variant::NIL;
}

void GodotJSScriptInstance::validate_property(PropertyInfo& p_property) const
{
    //TODO
}

bool GodotJSScriptInstance::property_can_revert(const StringName& p_name) const
{
    //TODO
    return false;
}

bool GodotJSScriptInstance::property_get_revert(const StringName& p_name, Variant& r_ret) const
{
    //TODO
    return false;
}

void GodotJSScriptInstance::get_method_list(List<MethodInfo>* p_list) const
{
    script_->get_script_method_list(p_list);
}

bool GodotJSScriptInstance::has_method(const StringName& p_method) const
{
    return script_->has_method(p_method);
}

Variant GodotJSScriptInstance::callp(const StringName& p_method, const Variant** p_args, int p_argcount, Callable::CallError& r_error)
{
#if JSB_DEBUG
    if (profiling_info_.path_.is_empty())
    {
        profiling_info_.path_ = script_->get_path();
        profiling_info_.class_ = get_script_class()->js_class_name;
    }
    ScriptCallProfilingScope profiling_scope(profiling_info_, p_method);
#endif
    return env_->call_script_method(class_id_, object_id_, p_method, p_args, p_argcount, r_error);
}

void GodotJSScriptInstance::notification(int p_notification, bool p_reversed)
{
    if (p_reversed &&
        (p_notification == Object::NOTIFICATION_PREDELETE
        || p_notification == Object::NOTIFICATION_PREDELETE_CLEANUP))
    {
        // the JS counterpart is garbage collected (which finally caused Godot Object deleting)
        // so, some of the reversed notifications can not be handled by script instances
        return;
    }

    // Check if environment is being disposed to avoid calling into a destroyed JS context
    if (!env_ || env_->is_disposing())
    {
        return;
    }

    // since `NOTIFICATION_READY` is not reversed, `notification` will be posted after `callp`.
    // so, we can't `call_prelude` here with `NOTIFICATION_READY`

    //TODO find the method named `_notification`, cal it with `p_notification` as `argv`
    //TODO call it at all type levels? @seealso `GDScriptInstance::notification`
    Variant value = p_notification;
    const Variant* argv[] = {&value};
    Callable::CallError error;
    callp(jsb_string_name(_notification), argv, 1, error);
}
