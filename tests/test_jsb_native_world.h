#ifndef GODOTJS_TEST_NATIVE_WORLD_H
#define GODOTJS_TEST_NATIVE_WORLD_H
#include "jsb_test_helpers.h"
#include "test_jsb_binding_identity.h"
#include "../bridge/jsb_native_world.h"
#include "../bridge/jsb_type_convert.h"
#include "../bridge/jsb_native_lifecycle.h"

namespace jsb::tests {
inline bool native_world_eval(const std::shared_ptr<Environment>& env, const char* source) {
    v8::Isolate::Scope isolate_scope(env->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(env.get());
    impl::TryCatch caught(env->get_isolate()); Error error = OK;
    env->eval_source(source, strlen(source), "native-world-test.js", error); Utils::print_exception(caught);
    return error == OK && !caught.has_caught();
}

TEST_CASE("[jsb] Environment registry never promotes constructing or expired owners") {
    GodotJSScriptLanguageIniter initer;
    const Thread::ID owner_thread = Thread::get_caller_id();
    std::atomic<Environment*> lookup{nullptr}, deferred_delete{nullptr};
    std::atomic<unsigned> requested{0}, completed{0}, failures{0}, reads{0};
    std::atomic<bool> expect_live{false}, stop{false};
    std::thread reader([&] {
        while (!stop.load(std::memory_order_acquire)) {
            const unsigned request = requested.load(std::memory_order_acquire);
            if (request == completed.load(std::memory_order_relaxed)) { OS::get_singleton()->delay_usec(10); continue; }
            {
                Environment* address = lookup.load(std::memory_order_relaxed);
                const bool expected = expect_live.load(std::memory_order_relaxed);
                const auto found = Environment::_access(address);
                const auto snapshot = Environment::all_environments();
                bool listed = false;
                for (const auto& env : snapshot) if (env.get() == address) listed = true;
                if (bool(found) != expected || listed != expected) failures.fetch_add(1);
                if (Environment::_access()) failures.fetch_add(1); // no VM belongs to this reader
                reads.fetch_add(1);
            } // Return every strong snapshot before the owner's next reset.
            completed.store(request, std::memory_order_release);
        }
    });
    auto inspect = [&](bool live) {
        expect_live.store(live, std::memory_order_relaxed);
        const unsigned request = requested.fetch_add(1, std::memory_order_release) + 1;
        while (completed.load(std::memory_order_acquire) != request) OS::get_singleton()->delay_usec(10);
    };
    for (unsigned iteration = 0; iteration < 64; ++iteration) {
        Environment::CreateParams params; params.thread_id = owner_thread;
        Environment* raw = new Environment(params);
        lookup.store(raw, std::memory_order_relaxed);
        inspect(false); // Constructor returned, but no shared owner exists yet.
        std::shared_ptr<Environment> env(raw, [&](Environment* retiring) {
            // The control block is already at strong zero. Keep the native
            // allocation present so the reader deterministically hits the old
            // raw->shared_from_this window, without running any foreign VM code.
            if (Thread::get_caller_id() != owner_thread) {
                failures.fetch_add(1); deferred_delete.store(retiring); return;
            }
            inspect(false);
            retiring->dispose(); retiring->dispose(); delete retiring;
        });
        env->init();
        inspect(true);
        std::weak_ptr<Environment> weak = env;
        env.reset();
        if (!weak.expired()) failures.fetch_add(1);
        inspect(false); // Stale pointer lookup remains a key-only miss.
    }
    stop.store(true, std::memory_order_release); reader.join();
    if (Environment* leaked = deferred_delete.exchange(nullptr)) { leaked->dispose(); delete leaked; }
    CHECK(failures.load() == 0);
    CHECK(reads.load() == 256);

    // Destruction is valid even if init() never published this allocation.
    {
        Environment::CreateParams params; params.thread_id = owner_thread;
        auto unpublished = std::make_shared<Environment>(params);
        CHECK_FALSE(bool(Environment::_access(unpublished.get())));
        std::weak_ptr<Environment> weak = unpublished;
        unpublished->dispose(); unpublished->dispose(); unpublished.reset();
        CHECK(weak.expired());
    }

    // A successful reader promotion pins the owner. Its deleter only posts the
    // raw allocation back here, so no VM teardown executes on the reader thread.
    {
        Environment::CreateParams params; params.thread_id = owner_thread;
        std::atomic<Environment*> retirement{nullptr};
        std::atomic<bool> pinned{false}, release_pin{false};
        std::atomic<unsigned> retirements{0};
        auto env = std::shared_ptr<Environment>(new Environment(params), [&](Environment* value) {
            retirements.fetch_add(1); retirement.store(value, std::memory_order_release);
        });
        env->init(); Environment* address = env.get(); std::weak_ptr<Environment> weak = env;
        std::thread holder([&] {
            const auto pin = Environment::_access(address);
            if (!pin) failures.fetch_add(1);
            pinned.store(true, std::memory_order_release);
            while (!release_pin.load(std::memory_order_acquire)) OS::get_singleton()->delay_usec(10);
        });
        while (!pinned.load(std::memory_order_acquire)) OS::get_singleton()->delay_usec(10);
        env.reset();
        CHECK_FALSE(weak.expired()); CHECK(retirements.load() == 0);
        release_pin.store(true, std::memory_order_release); holder.join();
        CHECK(weak.expired()); CHECK(retirements.load() == 1);
        CHECK_FALSE(bool(Environment::_access(address)));
        Environment* retired = retirement.exchange(nullptr);
        REQUIRE(retired); retired->dispose(); retired->dispose(); delete retired;
    }
    CHECK(failures.load() == 0);
}

TEST_CASE("[jsb] owner runtime release permits a production snapshot's foreign final drop") {
    GodotJSScriptLanguageIniter initer;
    const auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
    const Thread::ID owner = Thread::get_caller_id();
    Environment::CreateParams params; params.thread_id = owner;
    auto env = std::make_shared<Environment>(params); env->init();
    REQUIRE(native_world_eval(env, "globalThis.retainedNativeValue=new (require('godot').Vector2)(3,4);"));
    Environment* address = env.get(); std::weak_ptr<Environment> weak = env;
    std::atomic<bool> acquired{false}, release_pin{false}; std::atomic<unsigned> failures{0};
    std::thread reader([&] {
        std::shared_ptr<Environment> pin;
        {
            const auto snapshot = Environment::all_environments();
            for (const auto& value : snapshot) if (value.get() == address) pin = value;
        }
        if (!pin) failures.fetch_add(1);
        acquired.store(true, std::memory_order_release);
        while (!release_pin.load(std::memory_order_acquire)) OS::get_singleton()->delay_usec(10);
        if (pin && (!pin->runtime_released() || pin->runtime_release_thread() != owner || pin->get_isolate() != nullptr)) failures.fetch_add(1);
        if (pin) pin->release_runtime_on_owner(); // Already released: idempotent, no VM call.
        pin.reset(); // Production make_shared deleter now runs on this reader.
    });
    while (!acquired.load(std::memory_order_acquire)) OS::get_singleton()->delay_usec(10);
    env->dispose(); CHECK_FALSE(env->runtime_released());
    env->release_runtime_on_owner(); env->release_runtime_on_owner();
    CHECK(env->runtime_released()); CHECK(env->runtime_release_thread() == owner);
    CHECK(env->get_isolate() == nullptr);
    env.reset(); CHECK_FALSE(weak.expired());
    release_pin.store(true, std::memory_order_release); reader.join();
    CHECK(weak.expired()); CHECK(failures.load() == 0);
    CHECK(native_world_eval(primary, "if(new (require('godot').Vector2)(3,4).length()!==5)throw Error('foreign cleanup touched owner runtime');"));
}

TEST_CASE("[jsb] transfer reference experiment balances fresh existing and nonref receivers") {
    GodotJSScriptLanguageIniter initer;
    auto sender = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto receiver = std::make_shared<Environment>(Environment::CreateParams()); receiver->init();
    for (bool prebound : {false, true}) {
        Ref<Resource> resource; resource.instantiate();
        REQUIRE(resource->get_reference_count() == 1);
        {
            v8::Isolate::Scope isolate_scope(sender->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(sender.get());
            v8::Local<v8::Object> object;
            REQUIRE(TypeConvert::gd_obj_to_js(sender->get_isolate(), sender->get_context(), resource.ptr(), object));
        }
        if (prebound) {
            v8::Isolate::Scope isolate_scope(receiver->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(receiver.get());
            v8::Local<v8::Object> object;
            REQUIRE(TypeConvert::gd_obj_to_js(receiver->get_isolate(), receiver->get_context(), resource.ptr(), object));
        }
        CHECK(resource->get_reference_count() == (prebound ? 3 : 2));
        {
            TransferData transfer;
            REQUIRE(sender->prepare_transfer_out({}, 0, Variant(resource), transfer));
            sender->finalize_transfer_out(transfer);
            v8::Isolate::Scope isolate_scope(receiver->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(receiver.get());
            receiver->transfer_in_bind(receiver->get_context(), transfer);
            CHECK(resource->get_reference_count() == 3);
        }
        CHECK(resource->get_reference_count() == 2);
        {
            TransferData transfer;
            REQUIRE(receiver->prepare_transfer_out({}, 0, Variant(resource), transfer));
            receiver->finalize_transfer_out(transfer);
            v8::Isolate::Scope isolate_scope(sender->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(sender.get());
            sender->transfer_in_bind(sender->get_context(), transfer);
            CHECK(resource->get_reference_count() == 3);
        }
        CHECK(resource->get_reference_count() == 2);
    }
    Node* node = memnew(Node); const ObjectID node_id = node->get_instance_id();
    {
        v8::Isolate::Scope isolate_scope(sender->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(sender.get());
        v8::Local<v8::Object> object;
        REQUIRE(TypeConvert::gd_obj_to_js(sender->get_isolate(), sender->get_context(), node, object));
    }
    {
        TransferData transfer;
        REQUIRE(sender->prepare_transfer_out({}, 0, Variant(node), transfer));
        sender->finalize_transfer_out(transfer);
        v8::Isolate::Scope isolate_scope(receiver->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(receiver.get());
        receiver->transfer_in_bind(receiver->get_context(), transfer);
        CHECK(compat::ObjectDB::get_instance(node_id) == node);
    }
    memdelete(node);
    CHECK(compat::ObjectDB::get_instance(node_id) == nullptr);
    receiver->dispose();
}

TEST_CASE("[jsb] source batch validation preserves earlier bindings after getter invalidation") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    v8::Isolate::Scope isolate_scope(env->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(env.get());
    Ref<Resource> first; first.instantiate(); Node* later = memnew(Node);
    v8::Local<v8::Object> first_wrapper, later_wrapper;
    REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), first.ptr(), first_wrapper));
    REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), later, later_wrapper));
    env->get_context()->Global()->Set(env->get_context(), impl::Helper::new_string_ascii(env->get_isolate(), "__laterTransferSource"), later_wrapper).Check();
    TransferData first_transfer, later_transfer;
    REQUIRE(env->prepare_transfer_out({}, 0, Variant(first), first_transfer));
    REQUIRE(env->prepare_transfer_out({}, 1, Variant(later), later_transfer));
    REQUIRE(native_world_eval(env, "Object.values({get serialized(){__laterTransferSource.free();return 0;}}); delete globalThis.__laterTransferSource;"));
    v8::Global<v8::Object> first_pin, later_pin;
    REQUIRE(env->validate_transfer_out(first_transfer, first_pin));
    {
        impl::TryCatch caught(env->get_isolate());
        CHECK_FALSE(env->validate_transfer_out(later_transfer, later_pin));
        REQUIRE(caught.has_caught()); String message; caught.get_message(&message);
        CHECK(message.contains("E_NATIVE_TRANSFER"));
    }
    CHECK(env->verify_object(first.ptr(), first_wrapper));
    CHECK(first->get_reference_count() == 3);
    // No finalize has run: dropping the rejected batch preserves the source.
}

TEST_CASE("[jsb] transfer transport RAII releases cancelled rejected and duplicated payloads") {
    GodotJSScriptLanguageIniter initer;
    auto sender = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto receiver = std::make_shared<Environment>(Environment::CreateParams()); receiver->init();
    Ref<Resource> resource; resource.instantiate();
    {
        v8::Isolate::Scope isolate_scope(sender->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(sender.get());
        v8::Local<v8::Object> object;
        REQUIRE(TypeConvert::gd_obj_to_js(sender->get_isolate(), sender->get_context(), resource.ptr(), object));
    }
    CHECK(resource->get_reference_count() == 2);
    {
        TransferData prepared;
        REQUIRE(sender->prepare_transfer_out({}, 0, Variant(resource), prepared));
        TransferData duplicate = prepared;
        CHECK(resource->get_reference_count() == 4);
        // Cancelling before source finalization leaves its wrapper intact.
    }
    CHECK(resource->get_reference_count() == 2);
    {
        TransferData outgoing;
        REQUIRE(sender->prepare_transfer_out({}, 0, Variant(resource), outgoing));
        TransferData duplicate = outgoing;
        sender->finalize_transfer_out(outgoing);
        CHECK(resource->get_reference_count() == 3);
        sender->finalize_transfer_out(duplicate);
        CHECK(resource->get_reference_count() == 3);
        receiver->request_native_cleanup(OS::get_singleton()->get_ticks_usec() + 2000000);
        v8::Isolate::Scope isolate_scope(receiver->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(receiver.get());
        receiver->transfer_in_bind(receiver->get_context(), outgoing);
        CHECK(resource->get_reference_count() == 3);
        // Rejecting/cancelling after enqueue drops only the transport Variants.
    }
    CHECK(resource->get_reference_count() == 1);
    receiver->dispose();
}

TEST_CASE("[jsb] async transfer buffers and late owner publication retain no Resource references") {
    GodotJSScriptLanguageIniter initer;
    auto sender = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto retiring = std::make_shared<Environment>(Environment::CreateParams()); retiring->init();
    Ref<Resource> resource; resource.instantiate();
    BindingIdentityTestAccess::discard_transfer(Variant(resource));
    CHECK(resource->get_reference_count() == 1);
#if !JSB_WITH_WEB
    {
        std::vector<TransferData> transfers;
        transfers.emplace_back(NativeObjectID(), 0, Variant(resource));
        retiring->post_message(Message(Message::TYPE_MESSAGE, {}, Buffer(), std::move(transfers)));
    }
    CHECK(resource->get_reference_count() == 2);
#endif
    retiring->dispose();
    CHECK(resource->get_reference_count() == 1);
    {
        v8::Isolate::Scope isolate_scope(sender->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(sender.get());
        v8::Local<v8::Object> object;
        REQUIRE(TypeConvert::gd_obj_to_js(sender->get_isolate(), sender->get_context(), resource.ptr(), object));
    }
    Environment::transfer_to_host(sender.get(), retiring.get(), {}, Variant(resource));
    CHECK(resource->get_reference_count() == 1);
#if !JSB_WITH_WEB
    std::thread late([&] {
        for (int index = 0; index < 100; ++index) {
            std::vector<TransferData> transfers;
            transfers.emplace_back(NativeObjectID(), 0, Variant(resource));
            retiring->post_message(Message(Message::TYPE_MESSAGE, {}, Buffer(), std::move(transfers)));
        }
    });
    late.join();
    CHECK(resource->get_reference_count() == 1);
#endif
}

TEST_CASE("[jsb] realm disposal releases only owned Variant payloads and seals late access") {
    GodotJSScriptLanguageIniter initer;
    auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto retiring = std::make_shared<Environment>(Environment::CreateParams()); retiring->init();
    Ref<Resource> resource; resource.instantiate();
    Array shared; shared.push_back(resource);
    Variant* retired_cell = retiring->alloc_variant(Variant(shared));
    Variant* active_cell = primary->alloc_variant(Variant(shared));
    {
        v8::Isolate::Scope isolate_scope(retiring->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(retiring.get());
        const auto context = retiring->get_context();
        Error error = OK;
        const char* source = "{ const g=require('godot'),v=new g.Vector2(3,4),d=new g.GDictionary(); globalThis.__lateNative=[()=>new g.Vector2(1,2),()=>v.length(),()=>v.x,()=>d.get('key')]; }";
        retiring->eval_source(source, strlen(source), "late-value.js", error);
        REQUIRE(error == OK);
        v8::Local<v8::Value> late;
        REQUIRE(context->Global()->Get(context, impl::Helper::new_string_ascii(retiring->get_isolate(), "__lateNative")).ToLocal(&late));
        REQUIRE(late->IsArray());
        retiring->dispose(); retiring->dispose();
        CHECK(retired_cell->get_type() == Variant::NIL);
        CHECK(active_cell->get_type() == Variant::ARRAY);
        CHECK(Array(*active_cell).size() == 1);
        CHECK(shared.size() == 1);
        CHECK(shared[0].get_validated_object() == resource.ptr());
        for (uint32_t index = 0; index < 4; ++index) {
            const auto callback = late.As<v8::Array>()->Get(context, index).ToLocalChecked().As<v8::Function>();
            impl::TryCatch caught(retiring->get_isolate());
            CHECK(callback->Call(context, context->Global(), 0, nullptr).IsEmpty());
            REQUIRE(caught.has_caught());
            String message; caught.get_message(&message);
            CHECK(message.contains("E_NATIVE_EPOCH_SEALED"));
        }
    }
    retiring->dealloc_variant(retired_cell);
    primary->dealloc_variant(active_cell);
}

TEST_CASE("[jsb] native Variant retainer is private and cannot be detached by public properties") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    REQUIRE(native_world_eval(env, R"JS((() => {
        const g=require('godot'); const v=new g.Vector2(3,4); const d=new g.GDictionary();
        for(const value of [v,d])for(const key of Reflect.ownKeys(value)) {
            const descriptor=Object.getOwnPropertyDescriptor(value,key);
            if(key==='0'||descriptor?.value instanceof ArrayBuffer)throw Error('public native cell retainer');
        }
        v[0]='user'; delete v[0]; d[0]='user'; delete d[0];
        if(v.length()!==5||v.x!==3||v.y!==4)throw Error('native cell detached');
        d.set('key',42); if(d.get('key')!==42)throw Error('dictionary cell detached');
        globalThis.__retainerFixture={v,d};
    })())JS"));
    {
        v8::Isolate::Scope isolate_scope(env->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(env.get());
        BindingIdentityTestAccess::collect(env.get());
    }
    REQUIRE(native_world_eval(env, R"JS((() => {
        const {v,d}=globalThis.__retainerFixture;
        if(v.length()!==5||v.x!==3||v.y!==4||d.get('key')!==42)throw Error('native cell released during GC');
        delete globalThis.__retainerFixture;
    })())JS"));
}

TEST_CASE("[jsb] native world renderer mode is exclusive and independent of roots") {
    NativeWorld world(999);
    CHECK(world.acquire_renderer("engine"));
    CHECK(world.acquire_renderer("engine"));
    CHECK_FALSE(world.acquire_renderer("legacy"));
    CHECK_FALSE(world.acquire_renderer("unknown"));
    world.seal(); CHECK_FALSE(world.acquire_renderer("engine"));
}

TEST_CASE("[jsb] native world identity is shared across environments and sealing is local") {
    GodotJSScriptLanguageIniter initer;
    auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto foreign = std::make_shared<Environment>(Environment::CreateParams()); foreign->init();
    CHECK(bool(primary->get_native_world() == foreign->get_native_world()));
    CHECK(primary->binding_epoch() != foreign->binding_epoch());
    foreign->dispose();
    CHECK(primary->get_native_world()->can_commit());
}

#if !JSB_WITH_WEB && (JSB_WITH_QUICKJS || JSB_WITH_V8)
TEST_CASE("[jsb] failed native owner cleanup cannot be overwritten by another owner's success") {
    GodotJSScriptLanguageIniter initer;
    auto failed = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto successful = std::make_shared<Environment>(Environment::CreateParams()); successful->init();
    const int original_exit = OS::get_singleton()->get_exit_code();
    {
        v8::Isolate::Scope isolate_scope(successful->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(successful.get());
        auto context = successful->get_context();
        auto reset_exit = v8::Function::New(context, [](const v8::FunctionCallbackInfo<v8::Value>&) { OS::get_singleton()->set_exit_code(0); }).ToLocalChecked();
        context->Global()->Set(context, impl::Helper::new_string_ascii(successful->get_isolate(), "__successfulExit"), reset_exit).Check();
    }
    REQUIRE(native_world_eval(failed, "require('godot-jsb').internal.native_runtime.setCleanupHandlers(()=>{},()=>({status:'failed',pendingStartup:0,pendingCleanups:0}),()=>{});"));
    REQUIRE(native_world_eval(successful, "(()=>{let ticks=0;require('godot-jsb').internal.native_runtime.setCleanupHandlers(()=>{},()=>{__successfulExit();return {status:++ticks===1?'closing':'complete',pendingStartup:0,pendingCleanups:ticks===1?1:0};},()=>{});})()"));
    REQUIRE(jsb_native_lifecycle_begin_exit());
    bool ready = false; for (int i = 0; i < 5 && !ready; ++i) ready = jsb_native_lifecycle_step();
    CHECK(ready); CHECK(OS::get_singleton()->get_exit_code() == 1);
    successful->dispose(); OS::get_singleton()->set_exit_code(original_exit);
}
#endif

#if !JSB_WITH_LEGACY_REACT
TEST_CASE("[jsb] production native bridge omits the legacy renderer pipeline") {
    GodotJSScriptLanguageIniter initer;
    CHECK(native_world_eval(GodotJSScriptLanguage::get_singleton()->get_environment(), R"JS((() => {
        const internal=require('godot-jsb').internal;
        if(internal.native_runtime.legacyReact!==false||internal.react!==undefined)throw Error('Legacy renderer unexpectedly installed');
        if(!internal.engine_run_lease||!internal.resource_scopes||!internal.native_host_operations)throw Error('Neutral engine providers not installed');
    })())JS"));
}
#endif

TEST_CASE("[jsb] retirement preserves every separately held cascade descendant atomically") {
    for (const auto state : {NativeWorld::ClaimState::Live, NativeWorld::ClaimState::Retiring, NativeWorld::ClaimState::Quarantined}) {
        NativeWorld world(1);
        auto* owner = world.open_scope(1); auto* other = world.open_scope(2);
        REQUIRE(owner); REQUIRE(other);
        REQUIRE(world.claim(owner, ObjectID(uint64_t(101))));
        REQUIRE(world.claim(owner, ObjectID(uint64_t(102))));
        REQUIRE(world.claim(other, ObjectID(uint64_t(103))));
        if (state == NativeWorld::ClaimState::Retiring) REQUIRE(world.retire(other, ObjectID(uint64_t(103))));
        if (state == NativeWorld::ClaimState::Quarantined) REQUIRE(world.relinquish(other, ObjectID(uint64_t(103))));
        const auto before = world.status(other);
        CHECK_FALSE(world.retire_batch(owner, {101, 102}, {101, 102, 103, 104}, world.revision()));
        CHECK(world.owns_claim(owner->token, ObjectID(uint64_t(101))));
        CHECK(world.owns_claim(owner->token, ObjectID(uint64_t(102))));
        CHECK(world.status(owner).retiring == 0);
        CHECK(world.status(other).claims == before.claims);
        CHECK(world.status(other).retiring == before.retiring);
        CHECK(world.status(other).quarantined == before.quarantined);
    }
}

TEST_CASE("[jsb] retirement needs a complete ready claim batch but permits unknown native descendants") {
    NativeWorld world(1); auto* owner = world.open_scope(1); REQUIRE(owner);
    REQUIRE(world.claim(owner, ObjectID(uint64_t(201))));
    REQUIRE(world.claim(owner, ObjectID(uint64_t(202))));
    CHECK_FALSE(world.retire_batch(owner, {201}, {201, 202, 203}, world.revision()));
    CHECK(world.status(owner).retiring == 0);
    CHECK_FALSE(world.retire_batch(owner, {201, 202}, {201, 203}, world.revision()));
    CHECK(world.status(owner).retiring == 0);
    CHECK_FALSE(world.retire_batch(owner, {201, 201}, {201, 202, 203}, world.revision()));
    CHECK(world.status(owner).retiring == 0);
    CHECK(world.retire_batch(owner, {201, 202}, {201, 202, 203}, world.revision()));
    CHECK(world.status(owner).retiring == 2);
}

TEST_CASE("[jsb] native observer distinguishes binding unlink from actual retirement") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    JSB_TESTS_EXECUTION_SCOPE(env.get()); auto world = env->get_native_world();
    Node* node = memnew(Node); const ObjectID id = node->get_instance_id();
    v8::Local<v8::Object> wrapper; REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), node, wrapper));
    auto* scope = world->open_scope(env->binding_epoch()); REQUIRE(scope);
    REQUIRE(world->watch(scope, node)); REQUIRE(world->claim(scope, id));
    node->free_instance_binding(env.get());
    CHECK(compat::ObjectDB::get_instance(id) == node);
    CHECK(world->take_changes(scope).changes.empty());
    CHECK(world->status(scope).claims == 1);
    memdelete(node);
    const auto changes = world->take_changes(scope);
    REQUIRE(changes.changes.size() == 1);
    CHECK(changes.changes[0].retired);
    CHECK(changes.changes[0].object == (uint64_t) id);
    CHECK(world->close_scope(scope).claims == 0);
}

TEST_CASE("[jsb] a live native claim survives public binding release and rejects transfer") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    REQUIRE(native_world_eval(env, "globalThis.__claimedNative = new (require('godot').Node)();"));
    v8::Isolate::Scope isolate_scope(env->get_isolate());
    Object* object = nullptr; const auto world = env->get_native_world();
    auto* scope = world->open_scope(env->binding_epoch()); ObjectID id;
    {
        JSB_TESTS_EXECUTION_SCOPE(env.get()); const auto context = env->get_context();
        REQUIRE(TypeConvert::js_to_gd_obj(env->get_isolate(), context, context->Global()->Get(context, impl::Helper::new_string_ascii(env->get_isolate(), "__claimedNative")).ToLocalChecked(), object));
        id = object->get_instance_id(); REQUIRE(world->watch(scope, object)); REQUIRE(world->claim(scope, id));
        impl::TryCatch caught(env->get_isolate()); TransferData transfer;
        CHECK_FALSE(env->prepare_transfer_out(NativeObjectID(), 0, Variant(object), transfer));
        REQUIRE(caught.has_caught()); String message; caught.get_message(&message);
        CHECK(message.contains("E_NATIVE_TRANSFER"));
        context->Global()->Set(context, impl::Helper::new_string_ascii(env->get_isolate(), "__claimedNative"), v8::Undefined(env->get_isolate())).Check();
    }
    // Non-refcounted Godot bindings are deliberately strong (external_rc=1).
    // Release that public native binding before requesting actual VM GC.
    object->free_instance_binding(env.get());
    env->get_isolate()->LowMemoryNotification(); env->update(0);
    CHECK_FALSE(bool(env->try_get_object_id(object)));
    REQUIRE(compat::ObjectDB::get_instance(id) == object); CHECK(world->status(scope).claims == 1);
    memdelete(object); CHECK(world->status(scope).claims == 0); world->close_scope(scope);
}

TEST_CASE("[jsb] native observer fences callbacks and detects detached reparent and free") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    CHECK(native_world_eval(env, R"JS((() => {
        const G=require('godot'), R=require('godot-jsb').internal.native_runtime;
        const assert=(x,m)=>{if(!x)throw Error(m);};
        assert(R.observationAbi===1,'actual observer hooks required');
        const scope=R.openScope(), mount=new G.Node(), parent=new G.Node(); R.watch(scope,mount);
        let fenced=false;
        const callback=G.Callable.create(()=>{const b=R.takeChanges(scope);fenced=b.mutationInProgress&&!R.checkpoint().canCommitStructure;});
        parent.connect('child_order_changed',callback); parent.add_child(mount);
        assert(fenced,'reentrant native callback escaped mutation fence');
        parent.disconnect('child_order_changed',callback);
        const after=R.takeChanges(scope);assert(!after.mutationInProgress&&after.changes.length,'end fence did not publish stable changes');
        const leaf=new G.Node(); R.claim(scope,leaf);const id=String(leaf.get_instance_id());
        R.requestRelease(scope,leaf);leaf.free();
        assert(R.takeChanges(scope).changes.some(x=>x.kind==='native-retired'&&x.objectId===id),'detached free not observed');
        assert(R.status(scope).pending===0,'native retirement did not clear claim');
        R.closeScope(scope);parent.free();
    })())JS"));
}

TEST_CASE("[jsb] native observer overflow batches bound temporary VM handles") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    CHECK(native_world_eval(env, R"JS((() => {
        const G=require('godot'),R=require('godot-jsb').internal.native_runtime;
        const scope=R.openScope(),parent=new G.Node(),child=new G.Node();R.watch(scope,parent);
        for(let i=0;i<5000;i++){parent.add_child(child);parent.remove_child(child);}
        const batch=R.takeChanges(scope);
        if(!batch.overflow||batch.changes.length!==4096)throw Error('Bounded dirty batch did not report overflow');
        R.closeScope(scope);parent.free();child.free();
    })())JS"));
}

TEST_CASE("[jsb] quarantined native lifetime survives source environment disposal until explicit native free") {
    GodotJSScriptLanguageIniter initer;
    auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
    auto owner = std::make_shared<Environment>(Environment::CreateParams()); owner->init();
    REQUIRE(native_world_eval(owner, "globalThis.__kept = new (require('godot').Node)();"));
    Node* kept = nullptr;
    {
        v8::Isolate::Scope isolate_scope(owner->get_isolate()); JSB_TESTS_EXECUTION_SCOPE(owner.get());
        Object* value = nullptr; const auto context = owner->get_context();
        REQUIRE(TypeConvert::js_to_gd_obj(owner->get_isolate(), context, context->Global()->Get(context, impl::Helper::new_string_ascii(owner->get_isolate(), "__kept")).ToLocalChecked(), value));
        kept = Object::cast_to<Node>(value);
    }
    REQUIRE(kept); Node* external_parent = memnew(Node); external_parent->add_child(kept);
    const ObjectID id = kept->get_instance_id(); auto world = owner->get_native_world();
    auto* scope = world->open_scope(owner->binding_epoch()); REQUIRE(world->watch(scope, kept));
    REQUIRE(world->claim(scope, id)); REQUIRE(world->relinquish(scope, id));
    CHECK(world->close_scope(scope).quarantined == 1);
    owner->dispose();
    CHECK(compat::ObjectDB::get_instance(id) == kept);
    CHECK(kept->get_parent() == external_parent);
    CHECK_FALSE(world->permits_binding(id, primary->binding_epoch()));
    CHECK(world->status(scope).quarantined == 1);
    memdelete(external_parent);
    CHECK(compat::ObjectDB::get_instance(id) == nullptr);
    CHECK(world->status(nullptr).claims == 0);
}

#if JSB_WITH_QUICKJS
TEST_CASE("[jsb] completed native scopes reuse storage without replaying old capabilities") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    CHECK(native_world_eval(env, R"JS((() => {
        const R=require('godot-jsb').internal.native_runtime;
        const old=R.openScope();R.closeScope(old);
        for(let i=0;i<5000;i++){const current=R.openScope();R.closeScope(current);}
        const current=R.openScope();let rejected=false;
        try{R.status(old);}catch(error){rejected=String(error).includes('E_NATIVE_SCOPE');}
        if(!rejected)throw Error('Retired capability replayed after scope storage reuse');
        R.closeScope(current);
    })())JS"));
}

TEST_CASE("[jsb] bounded native job pump yields from a replenishing promise queue") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    REQUIRE(native_world_eval(env, "globalThis.__stopJobs=false;Promise.resolve().then(function repeat(){if(!globalThis.__stopJobs)Promise.resolve().then(repeat);});"));
    const auto first = env->get_isolate()->PumpPendingJobs(8, 100000);
    CHECK(first.executed == 8); CHECK(first.pending); CHECK_FALSE(first.failed);
    REQUIRE(native_world_eval(env, "globalThis.__stopJobs=true;"));
    const auto last = env->get_isolate()->PumpPendingJobs(8, 100000);
    CHECK_FALSE(last.pending); CHECK_FALSE(last.failed);
}

TEST_CASE("[jsb] bounded native job pump interrupts a non-returning individual job") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    REQUIRE(native_world_eval(env, "Promise.resolve().then(()=>{while(true){}});"));
    const auto result = env->get_isolate()->PumpPendingJobs(8, 2000, 2000);
    CHECK(result.failed); CHECK(env->get_isolate()->IsExecutionTerminating());
}

TEST_CASE("[jsb] scheduling budget does not abort a legitimate atomic cleanup job") {
    GodotJSScriptLanguageIniter initer;
    auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
    REQUIRE(native_world_eval(env, "Promise.resolve().then(()=>{const start=Date.now();while(Date.now()-start<10){};});"));
    const auto result = env->get_isolate()->PumpPendingJobs(8, 2000, 100000);
    CHECK(result.executed == 1); CHECK_FALSE(result.failed); CHECK_FALSE(env->get_isolate()->IsExecutionTerminating());
}
#endif
}
#endif
