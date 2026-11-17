#include "jsb_native_world.h"
#include "jsb_environment.h"
#include "jsb_type_convert.h"
#include "scene/main/node.h"
#include "scene/main/scene_tree.h"
#include "core/version.h"
#include "core/config/engine.h"
#include <atomic>
#include <limits>
#if JSB_WITH_WEB
#include <emscripten/emscripten.h>
#endif

namespace jsb {
namespace {
std::mutex active_mutex;
std::shared_ptr<NativeWorld> active_world;
std::atomic<uint64_t> next_world{0};
std::atomic<uintptr_t> next_native_capability{0};
template<typename UInt> UInt allocate_identity(std::atomic<UInt>& counter) {
    UInt previous = counter.load(std::memory_order_relaxed);
    do {
        if (previous == std::numeric_limits<UInt>::max()) return 0;
    } while (!counter.compare_exchange_weak(previous, previous + 1, std::memory_order_relaxed));
    return previous + 1;
}
thread_local uint32_t native_interop_depth = 0;
constexpr size_t MAX_CHANGES = 4096;
void put(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& object, const char* name, const v8::Local<v8::Value>& value) {
    object->Set(context, impl::Helper::new_string_ascii(context->GetIsolate(), name), value).Check();
}
v8::Local<v8::String> number(v8::Isolate* isolate, uint64_t value) { return impl::Helper::new_string(isolate, uitos(value)); }
enum Op { ACQUIRE, OPEN, WATCH, CLAIM, RETIRE, RELINQUISH, CLOSE, TAKE, STATUS, CHECKPOINT, SET_CLEANUP, VALIDATE_ENTRY, SCHEDULE_CHECKPOINT, FORMAT_STACK, RELEASE_BATCH };
void release_batch(const v8::FunctionCallbackInfo<v8::Value>& info, Environment* env, const std::shared_ptr<NativeWorld>& world) {
    auto* isolate = info.GetIsolate(); auto context = isolate->GetCurrentContext();
    auto fail = [&](const char* message) { impl::Helper::throw_error(isolate, message); };
    if (info.Length() != 3 || !info[0]->IsExternal() || !info[1]->IsArray() || !info[2]->IsArray()) { fail("E_NATIVE_RELEASE_BATCH: scope, descriptors and frontier arrays required"); return; }
    if (!env->is_native_cleanup_checkpoint() || NativeWorld::inside_interop() || !world->can_commit()
        || Engine::get_singleton()->is_in_physics_frame() || !SceneTree::get_singleton()) { fail("E_NATIVE_RELEASE_CHECKPOINT: owner destruction checkpoint required"); return; }
#if JSB_WITH_WEB
    if (!jsbi_CanDestroyCheckpoint(isolate->rt())) { fail("E_NATIVE_RELEASE_CHECKPOINT: unwound Web owner checkpoint required"); return; }
#endif
    NativeInteropScope interop; // Descriptor getters cannot recursively submit destruction.
    struct Record { uint64_t id = 0, parent = 0; bool opaque = false; std::vector<uint64_t> children; };
    std::vector<Record> records; std::vector<uint64_t> frontier, ids;
    const auto descriptors = info[1].As<v8::Array>(), roots = info[2].As<v8::Array>();
    constexpr uint32_t MAX_RELEASE_NODES = 100000;
    const uint32_t descriptor_count = descriptors->Length(), frontier_count = roots->Length();
    if (descriptor_count > MAX_RELEASE_NODES || frontier_count > descriptor_count) { fail("E_NATIVE_RELEASE_BUDGET"); return; }
    const auto read_node = [&](const v8::Local<v8::Value>& value, uint64_t& id, bool nullable = false) {
        if (nullable && value->IsNullOrUndefined()) { id = 0; return true; }
        Object* object = nullptr;
        if (!TypeConvert::js_to_gd_obj(isolate, context, value, object) || !Object::cast_to<Node>(object)) return false;
        id = (uint64_t) object->get_instance_id(); return true;
    };
    uint32_t child_count = 0;
    // Decode every JS value before validating native state: getters/proxies may
    // reenter, so no raw Node/Scope pointer survives this decoding phase.
    for (uint32_t i = 0; i < descriptor_count; ++i) {
        v8::HandleScope locals(isolate); v8::Local<v8::Value> value, node, parent, children, opaque;
        if (!descriptors->Get(context, i).ToLocal(&value) || !value->IsObject()) { fail("E_NATIVE_RELEASE_DESCRIPTOR"); return; }
        const auto descriptor = value.As<v8::Object>();
        if (!descriptor->Get(context, impl::Helper::new_string_ascii(isolate, "node")).ToLocal(&node)
            || !descriptor->Get(context, impl::Helper::new_string_ascii(isolate, "parent")).ToLocal(&parent)
            || !descriptor->Get(context, impl::Helper::new_string_ascii(isolate, "children")).ToLocal(&children)
            || !descriptor->Get(context, impl::Helper::new_string_ascii(isolate, "opaque")).ToLocal(&opaque)
            || !children->IsArray() || !opaque->IsBoolean()) { fail("E_NATIVE_RELEASE_DESCRIPTOR"); return; }
        Record record; record.opaque = opaque->BooleanValue(isolate);
        if (!read_node(node, record.id) || !read_node(parent, record.parent, true)) { fail("E_NATIVE_RELEASE_OBJECT"); return; }
        const auto list = children.As<v8::Array>();
        const uint32_t length = list->Length();
        if (length > MAX_RELEASE_NODES - child_count) { fail("E_NATIVE_RELEASE_BUDGET"); return; }
        child_count += length;
        for (uint32_t j = 0; j < length; ++j) {
            v8::HandleScope child_locals(isolate); v8::Local<v8::Value> child; uint64_t id;
            if (!list->Get(context, j).ToLocal(&child) || !read_node(child, id)) { fail("E_NATIVE_RELEASE_CHILD"); return; }
            record.children.push_back(id);
        }
        ids.push_back(record.id); records.push_back(std::move(record));
    }
    for (uint32_t i = 0; i < frontier_count; ++i) {
        v8::HandleScope locals(isolate); v8::Local<v8::Value> value; uint64_t id;
        if (!roots->Get(context, i).ToLocal(&value) || !read_node(value, id)) { fail("E_NATIVE_RELEASE_FRONTIER"); return; }
        frontier.push_back(id);
    }
    auto* scope = world->resolve_scope(info[0].As<v8::External>()->Value(), env->binding_epoch());
    if (!scope || !env->is_native_cleanup_checkpoint() || !world->can_commit()) { fail("E_NATIVE_RELEASE_SCOPE"); return; }
    const uint64_t revision = world->revision();
    std::unordered_map<uint64_t, const Record*> index;
    for (const auto& record : records) if (!index.emplace(record.id, &record).second) { fail("E_NATIVE_RELEASE_DUPLICATE"); return; }
    std::unordered_set<uint64_t> covered;
    for (uint64_t id : frontier) {
        const auto record = index.find(id);
        if (record == index.end() || index.count(record->second->parent) || !covered.insert(id).second) { fail("E_NATIVE_RELEASE_FRONTIER"); return; }
    }
    // Every public descendant must either be in this receipt-ready batch, or
    // belong to an explicitly opaque native subtree. Never free an unready or
    // foreign child as a side effect of deleting its parent.
    for (const auto& record : records) {
        Node* node = Object::cast_to<Node>(compat::ObjectDB::get_instance(ObjectID(record.id)));
        if (!node || node->is_queued_for_deletion() || !world->owns_claim(scope->token, ObjectID(record.id))
            || (node->get_parent() ? (uint64_t) node->get_parent()->get_instance_id() : 0) != record.parent) { fail("E_NATIVE_RELEASE_OWNERSHIP"); return; }
        if (!record.opaque) {
            if ((size_t) node->get_child_count(false) != record.children.size()) { fail("E_NATIVE_RELEASE_CHILDREN"); return; }
            for (size_t j = 0; j < record.children.size(); ++j)
                if ((uint64_t) node->get_child(j, false)->get_instance_id() != record.children[j] || !index.count(record.children[j])) { fail("E_NATIVE_RELEASE_CHILDREN"); return; }
        }
        std::vector<uint64_t> path; uint64_t cursor = record.id;
        while (!covered.count(cursor)) {
            const auto next = index.find(cursor);
            if (next == index.end() || path.size() >= records.size()) { fail("E_NATIVE_RELEASE_FRONTIER"); return; }
            path.push_back(cursor); cursor = next->second->parent;
        }
        for (uint64_t id : path) covered.insert(id);
    }
    // Godot also destroys opaque and internal descendants. Snapshot the entire
    // physical cascade on the owner thread, outside the World lock; an opaque
    // descriptor grants no authority over a separately claimed descendant.
    std::vector<uint64_t> pending = frontier;
    std::unordered_set<uint64_t> cascade;
    while (!pending.empty()) {
        const uint64_t id = pending.back(); pending.pop_back();
        if (!cascade.insert(id).second) { fail("E_NATIVE_RELEASE_FRONTIER: overlapping native frontiers"); return; }
        Node* node = Object::cast_to<Node>(compat::ObjectDB::get_instance(ObjectID(id)));
        if (!node) { fail("E_NATIVE_RELEASE_OBJECT"); return; }
        const uint32_t count = node->get_child_count(true);
        if (count > MAX_RELEASE_NODES - cascade.size() - pending.size()) { fail("E_NATIVE_RELEASE_BUDGET"); return; }
        for (uint32_t i = 0; i < count; ++i) pending.push_back((uint64_t) node->get_child(i, true)->get_instance_id());
    }
    if (!world->retire_batch(scope, ids, cascade, revision)) { fail("E_NATIVE_RELEASE_CHANGED: native revision or complete subtree ownership changed during batch validation"); return; }
    // queue_free only writes Godot's delete queue; it neither detaches nor runs
    // script callbacks. The owner loop drains it after this VM frame returns.
    for (uint64_t id : frontier) Object::cast_to<Node>(compat::ObjectDB::get_instance(ObjectID(id)))->queue_free();
    info.GetReturnValue().Set(v8::Boolean::New(isolate, true));
}
void dispatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* isolate = info.GetIsolate();
    const auto context = isolate->GetCurrentContext();
    Environment* env = Environment::wrap(isolate);
    auto world = env->get_native_world();
    auto fail = [&](const char* message) { impl::Helper::throw_error(isolate, message); };
    if (!world || env->is_disposing() || !env->is_caller_thread()) { fail("E_NATIVE_WORLD_THREAD: live owner environment required"); return; }
    const int op = info.Data().As<v8::Int32>()->Value();
    if (op == FORMAT_STACK) {
        if (info.Length() != 1 || !info[0]->IsString()) { fail("E_SOURCE_MAP: stack string required"); return; }
        info.GetReturnValue().Set(impl::Helper::new_string(isolate, env->get_source_map_cache().process_source_position(impl::Helper::to_string(isolate, info[0]), nullptr))); return;
    }
    if (op == VALIDATE_ENTRY) {
        bool valid = false; impl::TryCatch catcher(isolate);
        v8::Local<v8::Value> host, validator, result;
        if (info.Length() >= 1 && context->Global()->Get(context, impl::Helper::new_string_ascii(isolate, "__godotjsRuntimeHost")).ToLocal(&host)
            && host->IsObject() && host.As<v8::Object>()->Get(context, impl::Helper::new_string_ascii(isolate, "isEntryCapability")).ToLocal(&validator) && validator->IsFunction()) {
            v8::Local<v8::Value> args[] = {info[0], info.Length() > 1 ? info[1] : v8::Local<v8::Value>(v8::Undefined(isolate))};
            if (validator.As<v8::Function>()->Call(context, host, 2, args).ToLocal(&result) && result->IsBoolean()) valid = result->BooleanValue(isolate);
        }
        info.GetReturnValue().Set(v8::Boolean::New(isolate, valid)); return;
    }
    if (op == SET_CLEANUP) {
        if (info.Length() != 3 || !info[0]->IsFunction() || !info[1]->IsFunction() || !info[2]->IsFunction()
            || !env->set_native_cleanup(info[0].As<v8::Function>(), info[1].As<v8::Function>(), info[2].As<v8::Function>())) { fail("E_NATIVE_CLEANUP_HANDLER: three owner callbacks required, registration is exclusive"); return; }
        info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return;
    }
    if (op == ACQUIRE) {
        if (!Thread::is_main_thread()) { fail("E_NATIVE_WORLD_THREAD: Node renderer requires the main owner"); return; }
        if (info.Length() != 1 || !info[0]->IsString() || !world->acquire_renderer(impl::Helper::to_string(isolate, info[0]))) { fail("E_RENDERER_WORLD_MODE: native world already selected another renderer"); return; }
        info.GetReturnValue().Set(number(isolate, world->id())); return;
    }
    if (op == CHECKPOINT) {
        auto result = v8::Object::New(isolate);
        const bool can_commit = world->can_commit() && !Engine::get_singleton()->is_in_physics_frame();
        put(context, result, "canCommitStructure", v8::Boolean::New(isolate, can_commit));
        bool can_destroy = env->is_native_cleanup_checkpoint() && !NativeWorld::inside_interop() && can_commit;
#if JSB_WITH_WEB
        can_destroy = can_destroy && jsbi_CanDestroyCheckpoint(isolate->rt());
#endif
        put(context, result, "canDestroy", v8::Boolean::New(isolate, can_destroy));
        info.GetReturnValue().Set(result); return;
    }
#if JSB_WITH_WEB
    if (op == SCHEDULE_CHECKPOINT) {
        if (info.Length() != 1 || !info[0]->IsFunction() || !jsbi_ScheduleCheckpoint(isolate->rt(), info[0]->stack_pos_)) { fail("E_NATIVE_CHECKPOINT_SCHEDULE: live owner callback required"); return; }
        info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return;
    }
#endif
    if (!Thread::is_main_thread()) { fail("E_NATIVE_WORLD_THREAD: Node observation requires the main owner"); return; }
    if (op == RELEASE_BATCH) { release_batch(info, env, world); return; }
    if (op == OPEN) {
        auto* scope = world->open_scope(env->binding_epoch());
        if (!scope) { fail("E_NATIVE_WORLD_SEALED"); return; }
        info.GetReturnValue().Set(v8::External::New(isolate, reinterpret_cast<void*>(uintptr_t(scope->token)))); return;
    }
    NativeWorld::Scope* scope = nullptr;
    if (info.Length() && info[0]->IsExternal()) scope = world->resolve_scope(info[0].As<v8::External>()->Value(), env->binding_epoch());
    if (!scope) { fail("E_NATIVE_SCOPE: foreign or closed scope"); return; }
    if (op == WATCH || op == CLAIM || op == RETIRE || op == RELINQUISH) {
        Object* object = nullptr;
        if (info.Length() != 2 || !TypeConvert::js_to_gd_obj(isolate, context, info[1], object) || !Object::cast_to<Node>(object)) { fail("E_NATIVE_SCOPE_OBJECT: live Node required"); return; }
        bool accepted = false;
        if (op == WATCH) accepted = world->watch(scope, object);
        if (op == CLAIM) accepted = world->watch(scope, object) && world->claim(scope, object->get_instance_id());
        if (op == RETIRE) accepted = world->retire(scope, object->get_instance_id());
        if (op == RELINQUISH) accepted = world->relinquish(scope, object->get_instance_id());
        if (!accepted) { fail("E_NATIVE_CLAIM: conflicting or foreign native lifetime"); return; }
        info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return;
    }
    if (op == TAKE) {
        const auto batch = world->take_changes(scope);
        auto result = v8::Object::New(isolate);
        put(context, result, "revision", number(isolate, batch.revision));
        put(context, result, "sequence", number(isolate, batch.sequence));
        put(context, result, "mutationInProgress", v8::Boolean::New(isolate, batch.mutation_in_progress));
        put(context, result, "overflow", v8::Boolean::New(isolate, batch.overflow));
        put(context, result, "sealed", v8::Boolean::New(isolate, batch.sealed));
        put(context, result, "wrongThread", v8::Boolean::New(isolate, batch.wrong_thread));
        auto changes = v8::Array::New(isolate, batch.changes.size());
        for (size_t i = 0; i < batch.changes.size(); ++i) {
            // Each record is retained by the output Array. Temporary names and
            // scalar handles must not accumulate across a 4096-record batch.
            v8::HandleScope change_scope(isolate);
            const auto& change = batch.changes[i]; auto item = v8::Object::New(isolate);
            put(context, item, "kind", impl::Helper::new_string_ascii(isolate, change.retired ? "native-retired" : "structure"));
            put(context, item, "objectId", number(isolate, change.object));
            put(context, item, "parentId", number(isolate, change.parent));
            put(context, item, "sequence", number(isolate, change.sequence));
            changes->Set(context, i, item).Check();
        }
        put(context, result, "changes", changes); info.GetReturnValue().Set(result); return;
    }
    if (op == CLOSE || op == STATUS) {
        const auto state = op == CLOSE ? world->close_scope(scope) : world->status(scope);
        auto result = v8::Object::New(isolate);
        put(context, result, "pending", v8::Int32::New(isolate, state.claims));
        put(context, result, "retiring", v8::Int32::New(isolate, state.retiring));
        put(context, result, "quarantined", v8::Int32::New(isolate, state.quarantined));
        put(context, result, "sealed", v8::Boolean::New(isolate, state.sealed));
        info.GetReturnValue().Set(result);
    }
}
}

uintptr_t native_capability_token() { return allocate_identity(next_native_capability); }
bool native_managed_cleanup_active() { const auto world = NativeWorld::current(); return world && world->is_closing(); }
NativeWorld::NativeWorld(uint64_t id) : id_(id), owner_thread_(Thread::get_caller_id()) {}
std::shared_ptr<NativeWorld> NativeWorld::begin() {
    std::lock_guard<std::mutex> lock(active_mutex);
    if (!active_world) {
        const uint64_t id = allocate_identity(next_world);
        CRASH_COND_MSG(!id, "Native world identity space exhausted");
        active_world = std::make_shared<NativeWorld>(id);
    }
    return active_world;
}
std::shared_ptr<NativeWorld> NativeWorld::current() { std::lock_guard<std::mutex> lock(active_mutex); return active_world; }
void NativeWorld::end(const std::shared_ptr<NativeWorld>& world) {
    if (!world) return; world->seal();
    std::lock_guard<std::mutex> lock(active_mutex);
    if (active_world == world) active_world.reset();
}
void NativeWorld::mutation(ObjectID parent, ObjectID child, bool begin) { if (auto world = current()) world->changed(parent, child, begin); }
void NativeWorld::retired(ObjectID object) { if (auto world = current()) world->removed(object); }
void native_observer_mutation(ObjectID parent, ObjectID child, bool begin) { NativeWorld::mutation(parent, child, begin); }
void native_observer_retired(ObjectID object) { NativeWorld::retired(object); }
void NativeWorld::enter_interop() { ++native_interop_depth; }
void NativeWorld::leave_interop() { if (native_interop_depth) --native_interop_depth; }
bool NativeWorld::inside_interop() { return native_interop_depth != 0; }
bool NativeWorld::acquire_renderer(const String& mode) {
    if (mode != "engine" && mode != "legacy") return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (sealed_ || closing_ || (!renderer_mode_.is_empty() && renderer_mode_ != mode)) return false;
    renderer_mode_ = mode; return true;
}
String NativeWorld::renderer_mode() const { std::lock_guard<std::mutex> lock(mutex_); return renderer_mode_; }
void NativeWorld::begin_closing() { std::lock_guard<std::mutex> lock(mutex_); closing_ = true; }
bool NativeWorld::is_closing() const { std::lock_guard<std::mutex> lock(mutex_); return closing_ || sealed_; }
NativeWorld::Scope* NativeWorld::open_scope(uint64_t environment) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (sealed_ || closing_ || scopes_.size() >= 4096) return nullptr;
    const uintptr_t token = native_capability_token();
    if (!token) return nullptr;
    auto scope = std::make_unique<Scope>(); scope->environment = environment; scope->token = token;
    auto* result = scope.get(); scopes_.emplace(scope->token, std::move(scope)); return result;
}
NativeWorld::Scope* NativeWorld::resolve_scope(void* capability, uint64_t environment) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = scopes_.find(reinterpret_cast<uintptr_t>(capability));
    if (found == scopes_.end() || sealed_ || !found->second->active || found->second->environment != environment) return nullptr;
    return found->second.get();
}
bool NativeWorld::valid_scope(const Scope* scope, uint64_t environment) const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& candidate : scopes_) if (candidate.second.get() == scope) return !sealed_ && scope->active && scope->environment == environment;
    return false;
}
bool NativeWorld::watch(Scope* scope, Object* object) {
    if (Thread::get_caller_id() != owner_thread_) return false;
    Node* node = Object::cast_to<Node>(object); if (!node) return false;
    const uint64_t id = (uint64_t) node->get_instance_id(); std::vector<uint64_t> parents;
    for (Node* parent = node->get_parent(); parent; parent = parent->get_parent()) parents.push_back((uint64_t) parent->get_instance_id());
    std::lock_guard<std::mutex> lock(mutex_);
    if (sealed_ || !scope->active) return false;
    scope->watched.insert(id); for (uint64_t parent : parents) scope->ancestors.insert(parent); return true;
}
bool NativeWorld::claim(Scope* scope, ObjectID object) {
    std::lock_guard<std::mutex> lock(mutex_); const uint64_t id = (uint64_t) object;
    if (sealed_ || !scope->active) return false;
    auto creator = creators_.find(id); if (creator != creators_.end() && creator->second != scope->environment) return false;
    auto old = claims_.find(id); if (old != claims_.end()) return old->second.scope == scope->token && old->second.state == ClaimState::Live;
    claims_.emplace(id, Claim{scope->token, scope->environment, ClaimState::Live}); ++scope->claim_count; return true;
}
bool NativeWorld::retire(Scope* scope, ObjectID object) {
    std::lock_guard<std::mutex> lock(mutex_); auto found = claims_.find((uint64_t) object);
    if (sealed_ || found == claims_.end() || found->second.scope != scope->token || found->second.state == ClaimState::Quarantined) return false;
    if (found->second.state != ClaimState::Retiring) ++scope->retiring_count;
    found->second.state = ClaimState::Retiring; return true;
}
uint64_t NativeWorld::revision() const { std::lock_guard<std::mutex> lock(mutex_); return revision_; }
bool NativeWorld::retire_batch(Scope* scope, const std::vector<uint64_t>& objects, const std::unordered_set<uint64_t>& cascade, uint64_t revision) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (sealed_ || !scope || !scope->active || mutation_depth_ || revision_ != revision) return false;
    const std::unordered_set<uint64_t> accepted(objects.begin(), objects.end());
    if (accepted.size() != objects.size()) return false;
    for (uint64_t id : objects) {
        const auto found = claims_.find(id);
        if (!cascade.count(id) || found == claims_.end() || found->second.scope != scope->token || found->second.environment != scope->environment || found->second.state != ClaimState::Live) return false;
    }
    // Unknown native-owned descendants may cascade. Every claimed descendant,
    // including internal/opaque Nodes, must be live and explicitly ready in
    // this same batch. Validate before changing any claim, under one lock.
    for (uint64_t id : cascade) {
        const auto found = claims_.find(id);
        if (found != claims_.end() && (!accepted.count(id) || found->second.scope != scope->token
            || found->second.environment != scope->environment || found->second.state != ClaimState::Live)) return false;
    }
    for (uint64_t id : objects) { claims_.at(id).state = ClaimState::Retiring; ++scope->retiring_count; }
    return true;
}
bool NativeWorld::relinquish(Scope* scope, ObjectID object) {
    std::lock_guard<std::mutex> lock(mutex_); auto found = claims_.find((uint64_t) object);
    if (sealed_ || found == claims_.end() || found->second.scope != scope->token) return false;
    if (found->second.state != ClaimState::Quarantined) {
        if (found->second.state == ClaimState::Retiring) --scope->retiring_count;
        ++scope->quarantined_count;
    }
    found->second.state = ClaimState::Quarantined; return true;
}
NativeWorld::Status NativeWorld::status_locked(const Scope* scope) const {
    Status result; result.sealed = sealed_;
    if (scope) { result.claims = scope->claim_count; result.retiring = scope->retiring_count; result.quarantined = scope->quarantined_count; return result; }
    for (const auto& pair : claims_) if (!scope || pair.second.scope == scope->token) {
        ++result.claims; result.retiring += pair.second.state == ClaimState::Retiring; result.quarantined += pair.second.state == ClaimState::Quarantined;
    }
    return result;
}
NativeWorld::Status NativeWorld::status(const Scope* scope) const { std::lock_guard<std::mutex> lock(mutex_); return status_locked(scope); }
NativeWorld::Status NativeWorld::close_scope(Scope* scope) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto result = status_locked(scope);
    // Keep observation and claims alive until actual retirement. Quarantined
    // ownership is a failed/unconfirmed handoff, never a successful release.
    if (!result.claims) scopes_.erase(scope->token);
    return result;
}
NativeWorld::Batch NativeWorld::take_changes(Scope* scope) {
    std::lock_guard<std::mutex> lock(mutex_); Batch result;
    result.revision = revision_; result.sequence = sequence_; result.mutation_in_progress = mutation_depth_ != 0;
    result.overflow = scope->overflow; result.sealed = sealed_; result.wrong_thread = scope->wrong_thread;
    result.changes.swap(scope->changes); scope->overflow = false; return result;
}
bool NativeWorld::permits_binding(ObjectID object, uint64_t environment) const {
    std::lock_guard<std::mutex> lock(mutex_); const auto found = claims_.find((uint64_t) object);
    return found == claims_.end() || (!sealed_ && found->second.environment == environment && found->second.state != ClaimState::Quarantined);
}
bool NativeWorld::has_live_claim(ObjectID object) const {
    std::lock_guard<std::mutex> lock(mutex_); const auto found = claims_.find((uint64_t) object);
    return found != claims_.end() && found->second.state != ClaimState::Quarantined;
}
bool NativeWorld::owns_claim(uint64_t scope_token, ObjectID object) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto scope = scopes_.find(scope_token);
    if (sealed_ || scope == scopes_.end() || !scope->second->active) return false;
    const auto found = claims_.find((uint64_t) object);
    return found != claims_.end() && found->second.scope == scope_token && found->second.environment == scope->second->environment && found->second.state == ClaimState::Live;
}
bool NativeWorld::suppress_finalization(ObjectID object, uint64_t environment) const {
    std::lock_guard<std::mutex> lock(mutex_); const auto found = claims_.find((uint64_t) object);
    // A claim grants destruction to its native release ledger, never wrapper
    // GC. Explicit Node.free()/native deletion still retires via ObjectDB.
    return found != claims_.end();
}
void NativeWorld::note_creator(ObjectID object, uint64_t environment) { std::lock_guard<std::mutex> lock(mutex_); creators_.emplace((uint64_t) object, environment); }
void NativeWorld::seal_environment(uint64_t environment) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& pair : claims_) if (pair.second.environment == environment && pair.second.state != ClaimState::Quarantined) {
        auto found = scopes_.find(pair.second.scope);
        if (found != scopes_.end()) {
            if (pair.second.state == ClaimState::Retiring) --found->second->retiring_count;
            ++found->second->quarantined_count;
        }
        pair.second.state = ClaimState::Quarantined;
    }
    // Metadata stays until native retirement/world seal. There are no VM refs.
    for (auto i = scopes_.begin(); i != scopes_.end();) {
        if (i->second->environment != environment) { ++i; continue; }
        i->second->active = false;
        if (!i->second->claim_count) i = scopes_.erase(i); else ++i;
    }
}
void NativeWorld::seal() { std::lock_guard<std::mutex> lock(mutex_); sealed_ = true; for (auto& scope : scopes_) scope.second->active = false; }
bool NativeWorld::can_commit() const {
    if (Thread::get_caller_id() != owner_thread_) return false;
    std::lock_guard<std::mutex> lock(mutex_); return !sealed_ && mutation_depth_ == 0;
}
bool NativeWorld::mutation_in_progress() const { std::lock_guard<std::mutex> lock(mutex_); return mutation_depth_ != 0; }
void NativeWorld::changed(ObjectID parent, ObjectID child, bool begin) {
    const uint64_t p = (uint64_t) parent, c = (uint64_t) child;
    std::lock_guard<std::mutex> lock(mutex_); if (sealed_) return;
    if (begin) ++mutation_depth_; else if (mutation_depth_) --mutation_depth_;
    ++revision_; const uint64_t sequence = ++sequence_;
    for (auto& entry : scopes_) { auto& scope = entry.second; if (scope->active && (scope->watched.count(p) || scope->watched.count(c) || scope->ancestors.count(c))) {
        scope->wrong_thread |= Thread::get_caller_id() != owner_thread_;
        if (scope->changes.size() >= MAX_CHANGES) scope->overflow = true;
        else scope->changes.push_back(Change{sequence, c, p, false});
    }}
}
void NativeWorld::removed(ObjectID object) {
    const uint64_t id = (uint64_t) object;
    std::lock_guard<std::mutex> lock(mutex_); if (sealed_) return;
    auto claim = claims_.find(id);
    if (claim != claims_.end()) {
        auto scope = scopes_.find(claim->second.scope);
        if (scope != scopes_.end()) {
            --scope->second->claim_count;
            if (claim->second.state == ClaimState::Retiring) --scope->second->retiring_count;
            if (claim->second.state == ClaimState::Quarantined) --scope->second->quarantined_count;
            if (!scope->second->active && !scope->second->claim_count) scopes_.erase(scope);
        }
        claims_.erase(claim);
    }
    creators_.erase(id); ++revision_; const uint64_t sequence = ++sequence_;
    for (auto& entry : scopes_) { auto& scope = entry.second; if (scope->active && (scope->watched.count(id) || scope->ancestors.count(id))) {
        if (scope->changes.size() >= MAX_CHANGES) scope->overflow = true;
        else scope->changes.push_back(Change{sequence, id, 0, true});
        scope->watched.erase(id); scope->ancestors.erase(id);
    }}
}
void NativeWorld::install(Environment* environment, const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal) {
    auto* isolate = context->GetIsolate(); auto api = v8::Object::New(isolate);
    auto world = environment->get_native_world();
    put(context, api, "abi", v8::Int32::New(isolate, 1));
    put(context, api, "legacyReact", v8::Boolean::New(isolate, JSB_WITH_LEGACY_REACT != 0));
    auto descriptor = v8::Object::New(isolate);
#if JSB_WITH_V8
    const char* engine = "v8";
#elif JSB_WITH_QUICKJS
    const char* engine = "quickjs";
#elif JSB_WITH_JAVASCRIPTCORE
    const char* engine = "jsc";
#else
    const char* engine = "web";
#endif
#if defined(GODOT_VERSION_MAJOR)
    const String version_hash = GODOT_VERSION_HASH, version_build = GODOT_VERSION_FULL_BUILD;
#else
    const String version_hash = VERSION_HASH, version_build = VERSION_FULL_BUILD;
#endif
    put(context, descriptor, "engine", impl::Helper::new_string_ascii(isolate, engine));
    put(context, descriptor, "godotVersion", impl::Helper::new_string(isolate, version_build + (version_hash.is_empty() ? String() : String(".") + version_hash.left(9))));
    put(context, descriptor, "nativeRuntimeAbi", v8::Int32::New(isolate, 1));
    put(context, descriptor, "nativeBridgeAbi", impl::Helper::new_string_ascii(isolate, "godot-engine-native/1"));
    put(context, internal, "engine_descriptor", descriptor);
    put(context, internal, "format_stack", JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, FORMAT_STACK)));
#ifdef GODOTJS_NATIVE_OBSERVER_ABI
    put(context, api, "observationAbi", v8::Int32::New(isolate, GODOTJS_NATIVE_OBSERVER_ABI));
#else
    put(context, api, "observationAbi", v8::Int32::New(isolate, 0));
#endif
    put(context, api, "worldId", number(isolate, world->id()));
    put(context, api, "environmentId", number(isolate, environment->binding_epoch()));
#if !JSB_WITH_JAVASCRIPTCORE
    put(context, api, "checkpointAbi", v8::Int32::New(isolate, 1));
#else
    put(context, api, "checkpointAbi", v8::Int32::New(isolate, 0));
#endif
#if defined(GODOTJS_NATIVE_LIFECYCLE_ABI) && !JSB_WITH_WEB && (JSB_WITH_QUICKJS || JSB_WITH_V8)
    put(context, api, "lifecycleAbi", v8::Int32::New(isolate, GODOTJS_NATIVE_LIFECYCLE_ABI));
#else
    put(context, api, "lifecycleAbi", v8::Int32::New(isolate, 0));
#endif
    for (const auto& method : {std::pair<const char*,int>{"acquireRendererWorld",ACQUIRE},{"openScope",OPEN},{"watch",WATCH},{"claim",CLAIM},{"requestRelease",RETIRE},{"relinquish",RELINQUISH},{"closeScope",CLOSE},{"takeChanges",TAKE},{"status",STATUS},{"checkpoint",CHECKPOINT},{"setCleanupHandlers",SET_CLEANUP}})
        put(context, api, method.first, JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, method.second)));
    put(context, internal, "native_runtime", api);
    put(context, api, "requestReleaseBatch", JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, RELEASE_BATCH)));
#if JSB_WITH_WEB
    put(context, api, "scheduleCheckpoint", JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, SCHEDULE_CHECKPOINT)));
#endif
    put(context, internal, "acquire_renderer_world", JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, ACQUIRE)));
    put(context, internal, "validate_entry_capability", JSB_NEW_FUNCTION(context, dispatch, v8::Int32::New(isolate, VALIDATE_ENTRY)));
}
}

#if JSB_WITH_WEB
namespace jsb {
uint32_t Environment::enter_web_native_checkpoint() {
    if (!is_caller_thread() || !Thread::is_main_thread() || is_disposing() || web_checkpoint_ticket_
        || native_cleanup_checkpoint_ || NativeWorld::inside_interop() || !native_world_->can_commit()) return 0;
    static std::atomic<uint32_t> next_ticket{0}; const uint32_t ticket = allocate_identity(next_ticket);
    if (!ticket) return 0;
    web_checkpoint_ticket_ = ticket; native_cleanup_checkpoint_ = true; return ticket;
}
void Environment::leave_web_native_checkpoint(uint32_t ticket) {
    if (!is_caller_thread() || !ticket || ticket != web_checkpoint_ticket_) return;
    native_cleanup_checkpoint_ = false; web_checkpoint_ticket_ = 0;
}
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t jsni_native_checkpoint_enter(uintptr_t opaque) {
    // Never dereference an opaque pointer supplied by JS. Match a live registry
    // member first, retaining it only for this call and without holding its lock.
    for (const auto& env : jsb::Environment::all_environments())
        if (env->is_runtime_owner_thread() && !env->runtime_released()
            && reinterpret_cast<uintptr_t>(env->get_isolate()) == opaque) return env->enter_web_native_checkpoint();
    return 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE void jsni_native_checkpoint_leave(uintptr_t opaque, uint32_t ticket) {
    for (const auto& env : jsb::Environment::all_environments())
        if (env->is_runtime_owner_thread() && !env->runtime_released()
            && reinterpret_cast<uintptr_t>(env->get_isolate()) == opaque) { env->leave_web_native_checkpoint(ticket); return; }
}
#endif
