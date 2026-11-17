#include "jsb_engine_run_lease.h"
#include "jsb_environment.h"
#include "jsb_native_world.h"
#include "jsb_type_convert.h"
#include "../internal/jsb_react_manifest.h"
#include "../internal/jsb_react_run_lease.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include <atomic>
#include <algorithm>
#include <vector>
#include <limits>

namespace jsb {
namespace {
std::vector<EngineRunLease*> admission_owners; // Owner-thread-only; never owns an Environment.
enum Op { OPEN, SHUTDOWN, CLOSE };
}
EngineRunLease::EngineRunLease(Environment* environment) : environment_(environment) {
    // Worker imports expose the same namespace but cannot admit Node trees.
    if (Thread::is_main_thread()) { admission_owners.push_back(this); registered_ = true; }
}
EngineRunLease::~EngineRunLease() { dispose(); }
void EngineRunLease::dispose() {
    for (const auto& item : leases_) internal::ReactRunLease::release(item.second.path);
    leases_.clear();
    if (registered_) { admission_owners.erase(std::remove(admission_owners.begin(), admission_owners.end(), this), admission_owners.end()); registered_ = false; }
}
String EngineRunLease::audit(Node* pending) const {
    if (!ProjectSettings::get_singleton()->get_autoload_list().is_empty()) return "E_REACT_AUTOLOAD: managed applications cannot create autoload Node trees";
    SceneTree* tree = SceneTree::get_singleton(); Node* infrastructure = tree ? tree->get_root() : nullptr;
    if (!infrastructure) return "E_REACT_SCENE_TREE: managed application requires the game SceneTree";
    std::vector<Node*> nodes{infrastructure};
    while (!nodes.empty()) {
        Node* node = nodes.back(); nodes.pop_back();
        bool known = node == infrastructure || node == pending || environment_->get_native_world()->has_live_claim(node->get_instance_id());
        if (!known) for (const auto* owner : admission_owners) for (const auto& pair : owner->leases_) {
            if (pair.second.attachment != node->get_instance_id()) continue;
            if (pair.second.closed && node->get_child_count(false)) return "E_FOREIGN_MUTATION: closed application attachment gained public children";
            known = true;
        }
        if (!known) return "E_FOREIGN_MUTATION: unregistered public Node in the game SceneTree: " + String(node->get_path());
        for (int i = 0; i < node->get_child_count(false); ++i) nodes.push_back(node->get_child(i, false));
    }
    return {};
}
void EngineRunLease::install(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal) {
    auto* isolate = context->GetIsolate(); auto api = v8::Object::New(isolate);
    const char* names[] = {"open", "shutdownRequested", "close"};
    for (int op = OPEN; op <= CLOSE; ++op) api->Set(context, impl::Helper::new_string_ascii(isolate, names[op]), v8::Function::New(context, dispatch, v8::Int32::New(isolate, op)).ToLocalChecked()).Check();
    internal->Set(context, impl::Helper::new_string_ascii(isolate, "engine_run_lease"), api).Check();
}
void EngineRunLease::dispatch(const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* isolate = info.GetIsolate(); auto context = isolate->GetCurrentContext(); auto* env = Environment::wrap(isolate);
    const auto fail = [&](const String& message) { impl::Helper::throw_error(isolate, message); };
    if (!env->is_caller_thread() || !Thread::is_main_thread() || env->is_disposing()) { fail("E_RUN_LEASE_THREAD: live main owner required"); return; }
    auto& state = env->get_engine_run_lease(); const int op = info.Data().As<v8::Int32>()->Value();
    if (op == OPEN) {
        if (env->get_native_world()->is_closing()) { fail("E_RUN_LEASE_CLOSING: native world no longer admits application startup"); return; }
        Object* object = nullptr;
        if (info.Length() != 4 || !TypeConvert::js_to_gd_obj(isolate, context, info[0], object) || !Object::cast_to<Node>(object)
            || !info[1]->IsString() || !info[2]->IsString() || !info[3]->IsString()) { fail("E_RUN_LEASE_ARGUMENT: Node/root id/instance/generation required"); return; }
        Node* node = Object::cast_to<Node>(object);
        if (node->get_child_count(false) || node->is_queued_for_deletion()) { fail("E_RUN_LEASE_ATTACHMENT: empty live attachment required"); return; }
        for (const auto* owner : admission_owners) for (const auto& pair : owner->leases_) if (!pair.second.closed && pair.second.attachment == node->get_instance_id()) { fail("E_RUN_LEASE_ATTACHMENT: attachment already admitted"); return; }
        String path, reason;
        if (internal::ReactRunLease::acquire(impl::Helper::to_string(isolate, info[1]), impl::Helper::to_string(isolate, info[2]), path, reason) != OK) { fail("E_RUN_ACTIVE: " + reason); return; }
        const String generation = impl::Helper::to_string(isolate, info[3]);
        if (internal::ReactManifest::is_enabled() || !generation.is_empty()) {
            Dictionary manifest; String manifest_path;
            if (generation.is_empty() || internal::ReactManifest::load_active(manifest, manifest_path, reason, false) != OK || String(manifest.get("generation", Variant())) != generation
                || String(manifest.get("nativeBridgeAbi", "")) != "godot-engine-native/1") {
                internal::ReactRunLease::release(path); fail("E_BUILD_GENERATION: startup ticket does not match leased active generation: " + reason); return;
            }
            reason = state.audit(node);
            if (!reason.is_empty()) { internal::ReactRunLease::release(path); fail(reason); return; }
        }
        // Prune retired attachment tombstones; live closed launchers remain auditable.
        for (auto it = state.leases_.begin(); it != state.leases_.end();) {
            if (it->second.closed && !compat::ObjectDB::get_instance(it->second.attachment)) it = state.leases_.erase(it); else ++it;
        }
        const uintptr_t token = native_capability_token();
        if (!token) { internal::ReactRunLease::release(path); fail("E_RUN_LEASE_BUDGET: native lease identity exhausted"); return; }
        state.leases_.emplace(token, Lease{path, node->get_instance_id(), false});
        info.GetReturnValue().Set(v8::External::New(isolate, reinterpret_cast<void*>(token))); return;
    }
    if (info.Length() != 1 || !info[0]->IsExternal()) { fail("E_RUN_LEASE_CAPABILITY: opaque lease required"); return; }
    const auto found = state.leases_.find(reinterpret_cast<uintptr_t>(info[0].As<v8::External>()->Value()));
    if (found == state.leases_.end()) { fail("E_RUN_LEASE_CAPABILITY: foreign or retired lease"); return; }
    if (op == SHUTDOWN) { info.GetReturnValue().Set(v8::Boolean::New(isolate, !found->second.closed && internal::ReactRunLease::shutdown_requested(found->second.path))); return; }
    internal::ReactRunLease::release(found->second.path); found->second.path = String(); found->second.closed = true;
}
}
