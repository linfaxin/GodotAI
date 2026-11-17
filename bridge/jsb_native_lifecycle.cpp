#include "jsb_native_lifecycle.h"
#include "jsb_environment.h"
#include "jsb_native_world.h"
#include "core/os/os.h"
#include "scene/main/scene_tree.h"
#if JSB_WITH_V8 && !JSB_WITH_WEB
#include <condition_variable>
#include <chrono>
#include <thread>
#endif

namespace jsb {
namespace {
struct CleanupExecutionBudget {
    std::atomic<bool>& aborted;
#if JSB_WITH_QUICKJS
    v8::Isolate* isolate; uint64_t previous;
    explicit CleanupExecutionBudget(v8::Isolate* value, uint64_t microseconds, std::atomic<bool>& state) : aborted(state), isolate(value), previous(value->BeginExecutionBudget(microseconds)) {}
    ~CleanupExecutionBudget() { if (isolate->IsExecutionTerminating()) aborted.store(true); isolate->EndExecutionBudget(previous); }
#elif JSB_WITH_V8 && !JSB_WITH_WEB
    std::mutex mutex; std::condition_variable completed; bool done = false; std::thread watchdog;
    explicit CleanupExecutionBudget(v8::Isolate* isolate, uint64_t microseconds, std::atomic<bool>& state)
        : aborted(state), watchdog([this, isolate, microseconds] {
            std::unique_lock<std::mutex> lock(mutex);
            if (!completed.wait_for(lock, std::chrono::microseconds(microseconds), [this] { return done; })) {
                aborted.store(true, std::memory_order_release);
                isolate->TerminateExecution(); // Deadline abort; never used as a resumable job yield.
            }
        }) {}
    ~CleanupExecutionBudget() {
        { std::lock_guard<std::mutex> lock(mutex); done = true; }
        completed.notify_one(); watchdog.join(); // Must finish before isolate disposal.
    }
#else
    explicit CleanupExecutionBudget(v8::Isolate*, uint64_t, std::atomic<bool>& state) : aborted(state) {}
#endif
};
}
bool Environment::set_native_cleanup(const v8::Local<v8::Function>& begin, const v8::Local<v8::Function>& tick, const v8::Local<v8::Function>& seal) {
    if (is_disposing() || !is_caller_thread() || has_native_cleanup() || native_world_->is_closing()) return false;
    native_cleanup_begin_.Reset(isolate_, begin); native_cleanup_tick_.Reset(isolate_, tick); native_cleanup_seal_.Reset(isolate_, seal);
    native_cleanup_registered_.store(true, std::memory_order_release);
    return true;
}
uint64_t Environment::native_cleanup_budget_us() const {
    const uint64_t deadline = native_cleanup_deadline_us_.load(std::memory_order_acquire);
    if (!deadline) return 2000000;
    const uint64_t now = OS::get_singleton()->get_ticks_usec();
    return deadline > now ? deadline - now : 1;
}
void Environment::begin_native_cleanup() {
    if (!has_native_cleanup() || native_cleanup_started_ || is_disposing()) return;
    native_cleanup_started_ = true;
    CleanupExecutionBudget budget(isolate_, native_cleanup_budget_us(), native_cleanup_aborted_);
    v8::Isolate::Scope isolate_scope(isolate_); v8::HandleScope handle_scope(isolate_);
    auto context = get_context(); v8::Context::Scope context_scope(context);
    impl::TryCatch catcher(isolate_); v8::Local<v8::Value> ignored;
    if (!native_cleanup_begin_.Get(isolate_)->Call(context, v8::Undefined(isolate_), 0, nullptr).ToLocal(&ignored)) native_cleanup_failed_ = true;
}
void Environment::seal_native_cleanup() {
#if JSB_WITH_JAVASCRIPTCORE
    // JSC's public API cannot bound this callback. Managed JSC shutdown is
    // explicitly unconfirmed; native seal/quarantine still runs in dispose().
    return;
#endif
    // An aborted VM cannot run another callback, even a facts-only seal.
    // The native seal below remains authoritative and quarantines leftovers.
    if (native_cleanup_seal_.IsEmpty() || native_cleanup_aborted_.load() || isolate_->IsExecutionTerminating()) return;
    CleanupExecutionBudget budget(isolate_, native_cleanup_budget_us(), native_cleanup_aborted_);
    v8::Isolate::Scope isolate_scope(isolate_); v8::HandleScope handle_scope(isolate_);
    auto context = get_context(); v8::Context::Scope context_scope(context);
    impl::TryCatch catcher(isolate_); v8::Local<v8::Value> ignored;
    if (!native_cleanup_seal_.Get(isolate_)->Call(context, v8::Undefined(isolate_), 0, nullptr).ToLocal(&ignored)) OS::get_singleton()->set_exit_code(1);
}
bool Environment::tick_native_cleanup(uint32_t job_budget) {
    if (!has_native_cleanup() || is_disposing()) return true;
    begin_native_cleanup();
    if (native_cleanup_aborted_.load() || isolate_->IsExecutionTerminating()) {
        ERR_PRINT("E_NATIVE_CLEANUP_ABORT: cleanup execution exceeded its VM deadline; remaining releases are unconfirmed");
        native_cleanup_failed_ = true; native_cleanup_phase_.store(4, std::memory_order_release); OS::get_singleton()->set_exit_code(1); return true;
    }
    bool ready = false;
    {
        CleanupExecutionBudget budget(isolate_, native_cleanup_budget_us(), native_cleanup_aborted_);
        v8::Isolate::Scope isolate_scope(isolate_); v8::HandleScope handle_scope(isolate_);
        auto context = get_context(); v8::Context::Scope context_scope(context);
        impl::TryCatch catcher(isolate_); v8::Local<v8::Value> progress;
        if (!native_cleanup_tick_.Get(isolate_)->Call(context, v8::Undefined(isolate_), 0, nullptr).ToLocal(&progress)) native_cleanup_failed_ = true;
        else if (progress->IsObject()) {
            const auto value = progress.As<v8::Object>();
            auto field = [&](const char* name) { v8::Local<v8::Value> field_value; if (!value->Get(context, impl::Helper::new_string_ascii(isolate_, name)).ToLocal(&field_value)) { native_cleanup_failed_ = true; return v8::Local<v8::Value>(v8::Undefined(isolate_)); } return field_value; };
            const auto state = field("status");
            const String status = state->IsString() ? impl::Helper::to_string(isolate_, state) : String();
            const auto startup = field("pendingStartup"), cleanups = field("pendingCleanups");
            ready = startup->IsNumber() && cleanups->IsNumber()
                && startup->NumberValue(context).FromMaybe(-1) == 0 && cleanups->NumberValue(context).FromMaybe(-1) == 0
                && (status == "complete" || status == "failed" || status == "unconfirmed");
            if (status == "failed" || status == "unconfirmed") native_cleanup_failed_ = true;
        }
    }
    // Internal ref/GC bookkeeping is needed for release confirmation, but
    // ordinary worker dispatch and transfer callbacks are not cleanup work.
    if (native_cleanup_aborted_.load() || isolate_->IsExecutionTerminating()) {
        native_cleanup_failed_ = true; native_cleanup_phase_.store(4, std::memory_order_release);
        OS::get_singleton()->set_exit_code(1);
        ERR_PRINT("E_NATIVE_CLEANUP_ABORT: cleanup execution exceeded its VM deadline; remaining releases are unconfirmed");
        return true;
    }
    exec_cleanup_async_calls();
#if JSB_WITH_QUICKJS
    native_cleanup_checkpoint_ = true;
    const auto jobs = isolate_->PumpPendingJobs(job_budget, 2000, native_cleanup_budget_us());
    native_cleanup_checkpoint_ = false;
    native_cleanup_failed_ |= jobs.failed;
#elif JSB_WITH_V8 && !JSB_WITH_WEB
    {
        // V8's public API has no single-job pump. A checkpoint that completes
        // within this wall-clock budget succeeds; exhaustion aborts the world.
        CleanupExecutionBudget budget(isolate_, native_cleanup_budget_us(), native_cleanup_aborted_);
        native_cleanup_checkpoint_ = true;
        v8::Isolate::Scope isolate_scope(isolate_); v8::HandleScope handle_scope(isolate_);
        auto context = get_context(); v8::Context::Scope context_scope(context);
        isolate_->PerformMicrotaskCheckpoint();
        native_cleanup_checkpoint_ = false;
    }
    native_cleanup_failed_ |= isolate_->IsExecutionTerminating();
#endif
    exec_cleanup_async_calls();
    if (isolate_->IsExecutionTerminating() || native_cleanup_aborted_.load()) {
        native_cleanup_failed_ = true;
        ERR_PRINT("E_NATIVE_CLEANUP_ABORT: cleanup execution exceeded its VM deadline; remaining releases are unconfirmed");
    }
    if (native_cleanup_failed_) OS::get_singleton()->set_exit_code(1);
    if (ready) native_cleanup_phase_.store(native_cleanup_failed_ ? 4 : 2, std::memory_order_release);
    return ready;
}
}

namespace {
uint64_t closing_world = 0;
uint64_t deadline_us = 0;
unsigned ready_ticks = 0;
bool closing_failed = false;
std::vector<std::weak_ptr<jsb::Environment>> closing_environments;
}
bool jsb_native_lifecycle_is_closing() {
    const auto world = jsb::NativeWorld::current();
    return world && closing_world == world->id();
}
void jsb_web_native_lifecycle_begin_exit() {
#if JSB_WITH_WEB
    const auto world = jsb::NativeWorld::current(); if (!world) return;
    world->begin_closing();
    const uint64_t deadline = OS::get_singleton()->get_ticks_usec() + 2000000;
    for (const auto& env : jsb::Environment::all_environments()) env->request_native_cleanup(deadline);
#endif
}
void jsb_web_native_lifecycle_cleanup_tick() {
#if JSB_WITH_WEB
    // The Web owner hook calls this after its JS cleanup callback returns.
    // It does not run timers, worker messages, Script methods or general jobs.
    for (const auto& env : jsb::Environment::all_environments())
        if (env->is_caller_thread() && !env->is_disposing() && env->native_cleanup_phase() != 0) env->exec_cleanup_async_calls();
#endif
}
bool jsb_native_lifecycle_begin_exit() {
#if defined(GODOTJS_NATIVE_LIFECYCLE_ABI) && !JSB_WITH_WEB && (JSB_WITH_QUICKJS || JSB_WITH_V8)
    const auto world = jsb::NativeWorld::current(); if (!world) return false;
    if (closing_world == world->id()) return true;
    const auto environments = jsb::Environment::all_environments();
    bool managed = false;
    for (const auto& env : environments) if (env->has_native_cleanup()) managed = true;
    if (!managed) return false;
    world->begin_closing(); closing_environments.clear();
    for (const auto& env : environments) if (env->has_native_cleanup()) closing_environments.push_back(env);
    closing_world = world->id(); deadline_us = OS::get_singleton()->get_ticks_usec() + 2000000; ready_ticks = 0; closing_failed = false;
    // Broadcast to every entry/environment before awaiting any individual one.
    for (const auto& env : environments) env->request_native_cleanup(deadline_us);
    for (const auto& env : environments) if (env->has_native_cleanup() && env->is_caller_thread() && !env->is_disposing()) env->begin_native_cleanup();
    return true;
#elif defined(GODOTJS_NATIVE_LIFECYCLE_ABI) && !JSB_WITH_WEB && JSB_WITH_JAVASCRIPTCORE
    const auto world = jsb::NativeWorld::current(); if (!world) return false;
    const auto environments = jsb::Environment::all_environments(); bool managed = false;
    for (const auto& env : environments) managed |= env->has_native_cleanup();
    if (managed) {
        world->begin_closing();
        const uint64_t deadline = OS::get_singleton()->get_ticks_usec();
        for (const auto& env : environments) env->request_native_cleanup(deadline);
        OS::get_singleton()->set_exit_code(1);
        ERR_PRINT("E_NATIVE_CLEANUP_UNSUPPORTED: JavaScriptCore has no public bounded job pump; managed cleanup remains unconfirmed");
    }
    return false;
#else
    return false;
#endif
}
bool jsb_native_lifecycle_step() {
#if defined(GODOTJS_NATIVE_LIFECYCLE_ABI) && !JSB_WITH_WEB && (JSB_WITH_QUICKJS || JSB_WITH_V8)
    if (!jsb_native_lifecycle_is_closing()) return true;
    bool ready = true;
    for (const auto& target : closing_environments) {
        const auto env = target.lock();
        if (!env) { closing_failed = true; continue; }
        const unsigned phase = env->native_cleanup_phase();
        if (phase == 3 || phase == 4) { closing_failed = true; continue; }
        if (phase == 2) continue;
        if (env->is_caller_thread() && !env->is_disposing()) {
            ready = env->tick_native_cleanup() && ready;
            closing_failed |= env->native_cleanup_phase() == 4;
        }
        else ready = false; // Foreign VM must acknowledge on its owner loop.
    }
    // Every VM/JS callback has returned. Never flush the general deferred queue.
    if (auto* tree = SceneTree::get_singleton()) tree->godotjs_flush_native_delete_queue();
    // A later owner's successful callback must never turn an earlier failed
    // cleanup into a successful process exit by calling quit(0).
    if (closing_failed) OS::get_singleton()->set_exit_code(1);
    ready_ticks = ready ? ready_ticks + 1 : 0;
    if (ready_ticks >= 2) return true;
    if (OS::get_singleton()->get_ticks_usec() >= deadline_us) {
        OS::get_singleton()->set_exit_code(1);
        ERR_PRINT("E_NATIVE_CLEANUP_TIMEOUT: unfinished entry cleanup remains unconfirmed");
        return true;
    }
    OS::get_singleton()->delay_usec(1000);
    return false;
#else
    return true;
#endif
}
