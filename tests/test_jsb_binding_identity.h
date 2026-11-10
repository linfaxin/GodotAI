#ifndef GODOTJS_TEST_BINDING_IDENTITY_H
#define GODOTJS_TEST_BINDING_IDENTITY_H

#include "jsb_test_helpers.h"
#include "../bridge/jsb_environment.h"
#include "../bridge/jsb_type_convert.h"
#include "core/object/ref_counted.h"
#include "scene/main/node.h"

namespace jsb
{
    // Queue the same captured identities as native/GC callbacks, while allowing
    // the allocator-independent regression to choose the replacement address.
    struct BindingIdentityTestAccess
    {
        static void queue_old_lifetime(Environment* p_env, void* p_address,
            const std::shared_ptr<ObjectBindingTicket>& p_ticket)
        {
            p_env->add_async_call(Environment::AsyncCall::TYPE_REF, p_address, p_ticket);
            p_env->add_async_call(Environment::AsyncCall::TYPE_DEREF, p_address, p_ticket);
            p_env->add_async_call(Environment::AsyncCall::TYPE_GC_FREE, p_address, p_ticket);
        }

        static uint32_t reference_count(Environment* p_env, void* p_address)
        {
            const ObjectHandlePtr handle = p_env->object_db_.try_get_object(p_address);
            return handle ? handle->ref_count_ : UINT32_MAX;
        }

        static void collect(Environment* p_env) { p_env->_on_gc_request(); }
    };
}

namespace jsb::tests
{
    TEST_CASE("[jsb] retired wrappers cannot resolve reallocated native objects")
    {
        GodotJSScriptLanguageIniter initer;
        const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(env.get());
        static constexpr char source[] = R"JS((() => {
            const G = require('godot');
            const assert = (value, message) => { if (!value) throw Error(message); };
            const alive = (value) => { try { return G.is_instance_valid(value); } catch (_) { return false; } };
            const old = new G.Node();
            const id = String(old.get_instance_id());
            const list = new G.GArray(); list.push_back(old);
            const dictionary = new G.GDictionary(); dictionary.set('old', old);
            const proxy = new Proxy(old, {});
            old.free();
            assert(!G.is_instance_valid(old), 'free must invalidate wrapper');
            const allocated = [];
            for (let i = 0; i < 256; ++i) {
                const fresh = new G.Node(); allocated.push(fresh);
                fresh.set_name('Fresh_' + i);
                assert(!G.is_instance_valid(old), 'old wrapper revived');
                assert(!alive(proxy), 'proxy revived old wrapper');
                assert(!G.is_instance_valid(list.get(0)), 'array revived old ObjectID');
                assert(!G.is_instance_valid(dictionary.get('old')), 'dictionary revived old ObjectID');
                try { old.set_name('STALE_WRITE'); } catch (_) {}
                try { proxy.set_name('STALE_PROXY_WRITE'); } catch (_) {}
                assert(String(fresh.get_name()) === 'Fresh_' + i, 'stale write reached fresh object');
                assert(String(fresh.get_instance_id()) !== id, 'native ObjectID was reused');
            }
            for (const fresh of allocated) fresh.free();
        })())JS";
        impl::TryCatch caught(env->get_isolate());
        Error error;
        env->eval_source(source, sizeof(source) - 1, "binding-identity-test.js", error);
        Utils::print_exception(caught);
        CHECK(error == OK);
        CHECK_FALSE(caught.has_caught());
    }

    TEST_CASE("[jsb] background retirement preserves ticket identity before owner cleanup")
    {
        GodotJSScriptLanguageIniter initer;
        const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(env.get());
        Node* original = memnew(Node);
        v8::Local<v8::Object> wrapper;
        REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), original, wrapper));
        const auto ticket = env->get_binding_ticket(original);
        REQUIRE(bool(ticket));
        CHECK(env->verify_binding(ticket));
        std::thread background([original] { memdelete(original); });
        background.join();
        CHECK_FALSE(ticket->active.load(std::memory_order_acquire));
        CHECK_FALSE(env->verify_binding(ticket));
        CHECK_FALSE(env->verify_object(original, wrapper));
        // No JS handle is reset on the background freeing thread.
        CHECK_FALSE(ticket->reference.IsEmpty());
        Node* replacement = memnew(Node);
        v8::Local<v8::Object> rebound;
        REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), replacement, rebound));
        CHECK_FALSE(env->verify_object(replacement, wrapper));
        CHECK(env->verify_object(replacement, rebound));
        CHECK(env->get_binding_ticket(replacement)->generation != ticket->generation);
        const uint32_t references = BindingIdentityTestAccess::reference_count(env.get(), replacement);
        std::thread late_messages([&] {
            BindingIdentityTestAccess::queue_old_lifetime(env.get(), replacement, ticket);
        });
        late_messages.join();
        // A queued release for the old lifetime must not reset its replacement.
        env->update(0);
        CHECK(ticket->reference.IsEmpty());
        CHECK(env->verify_object(replacement, rebound));
        CHECK(BindingIdentityTestAccess::reference_count(env.get(), replacement) == references);
        memdelete(replacement);
    }

    TEST_CASE("[jsb] real wrapper GC releases its exact ticket and managed native object")
    {
        GodotJSScriptLanguageIniter initer;
        const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
        RefCounted* native = memnew(RefCounted);
        const ObjectID native_id = native->get_instance_id();
        std::weak_ptr<ObjectBindingTicket> weak_ticket;
        {
            JSB_TESTS_EXECUTION_SCOPE(env.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), native, wrapper));
            weak_ticket = env->get_binding_ticket(native);
            CHECK_FALSE(weak_ticket.expired());
        }
        {
            JSB_TESTS_EXECUTION_SCOPE(env.get());
            BindingIdentityTestAccess::collect(env.get());
            env->update(0);
        }
        CHECK(compat::ObjectDB::get_instance(native_id) == nullptr);
        CHECK(weak_ticket.expired());
        if (Object* survivor = compat::ObjectDB::get_instance(native_id)) memdelete(survivor);
    }

    TEST_CASE("[jsb] RefCounted becomes weak after its multiple external owners release")
    {
        GodotJSScriptLanguageIniter initer;
        const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
        Ref<RefCounted> first;
        first.instantiate();
        Ref<RefCounted> second = first;
        Ref<RefCounted> third = first;
        RefCounted* native = first.ptr();
        const ObjectID native_id = native->get_instance_id();
        std::weak_ptr<ObjectBindingTicket> weak_ticket;
        {
            JSB_TESTS_EXECUTION_SCOPE(env.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), native, wrapper));
            weak_ticket = env->get_binding_ticket(native);
            CHECK(BindingIdentityTestAccess::reference_count(env.get(), native) == 1);
            first.unref();
            second.unref();
            third.unref();
            CHECK(native->get_reference_count() == 1);
            CHECK(BindingIdentityTestAccess::reference_count(env.get(), native) == 0);
        }
        {
            JSB_TESTS_EXECUTION_SCOPE(env.get());
            BindingIdentityTestAccess::collect(env.get());
            env->update(0);
        }
        CHECK(compat::ObjectDB::get_instance(native_id) == nullptr);
        CHECK(weak_ticket.expired());
        if (Object* survivor = compat::ObjectDB::get_instance(native_id)) memdelete(survivor);
    }

    TEST_CASE("[jsb] collected RefCounted wrapper replacement balances its native contribution")
    {
        GodotJSScriptLanguageIniter initer;
        const auto env = GodotJSScriptLanguage::get_singleton()->get_environment();
        for (const bool via_variant : {false, true})
        {
            RefCounted* native = memnew(RefCounted);
            const ObjectID native_id = native->get_instance_id();
            std::weak_ptr<ObjectBindingTicket> old_weak_ticket, new_weak_ticket;
            {
                JSB_TESTS_EXECUTION_SCOPE(env.get());
                v8::Local<v8::Object> wrapper;
                REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), native, wrapper));
                auto ticket = env->get_binding_ticket(native);
                old_weak_ticket = ticket;
                // The native contribution survives the weak first pass until
                // its deferred finalizer or a replacement balances it.
                ticket->reference.Reset();
                Variant holder;
                v8::Local<v8::Object> replacement;
                if (via_variant)
                {
                    holder = native;
                    v8::Local<v8::Value> value;
                    REQUIRE(TypeConvert::gd_var_to_js(env->get_isolate(), env->get_context(), holder, value));
                    replacement = value.As<v8::Object>();
                }
                else
                {
                    REQUIRE(TypeConvert::gd_obj_to_js(env->get_isolate(), env->get_context(), native, replacement));
                }
                CHECK_FALSE(ticket->active.load(std::memory_order_acquire));
                CHECK_FALSE(env->verify_object(native, wrapper));
                CHECK(env->verify_object(native, replacement));
                new_weak_ticket = env->get_binding_ticket(native);
                CHECK(BindingIdentityTestAccess::reference_count(env.get(), native) == (via_variant ? 1 : 0));
                holder = Variant();
                CHECK(native->get_reference_count() == 1);
                CHECK(BindingIdentityTestAccess::reference_count(env.get(), native) == 0);
                ticket.reset();
                CHECK(old_weak_ticket.expired());
            }
            {
                JSB_TESTS_EXECUTION_SCOPE(env.get());
                BindingIdentityTestAccess::collect(env.get());
                env->update(0);
            }
            CHECK(compat::ObjectDB::get_instance(native_id) == nullptr);
            CHECK(new_weak_ticket.expired());
            if (Object* survivor = compat::ObjectDB::get_instance(native_id)) memdelete(survivor);
        }
    }

    TEST_CASE("[jsb] dispose cancels pending GC leases and detaches foreign environment bindings")
    {
        GodotJSScriptLanguageIniter initer;
        const auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
        const auto foreign = std::make_shared<Environment>(Environment::CreateParams());
        foreign->init();
        Object* native = memnew(Object);
        std::weak_ptr<ObjectBindingTicket> weak_ticket;
        {
            v8::Isolate::Scope isolate_scope(foreign->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(foreign.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(foreign->get_isolate(), foreign->get_context(), native, wrapper));
            auto ticket = foreign->get_binding_ticket(native);
            weak_ticket = ticket;
            CHECK_FALSE(primary->verify_binding(ticket));
            // Simulate V8 between weak first/second passes. Native destruction
            // may deliver owner cleanup before V8 invokes its pending pass.
            ticket->gc_lease = ticket;
            ticket->reference.Reset();
            std::thread background([native] { memdelete(native); });
            background.join();
            foreign->update(0);
            ticket.reset();
            CHECK_FALSE(weak_ticket.expired());
        }
        foreign->dispose();
        CHECK(weak_ticket.expired());

        // A surviving engine object can be rebound after another Env disposes.
        Object* survivor = memnew(Object);
        const auto second = std::make_shared<Environment>(Environment::CreateParams());
        second->init();
        std::weak_ptr<ObjectBindingTicket> detached_ticket;
        {
            v8::Isolate::Scope isolate_scope(second->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(second.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(second->get_isolate(), second->get_context(), survivor, wrapper));
            detached_ticket = second->get_binding_ticket(survivor);
        }
        second->dispose();
        CHECK(detached_ticket.expired());
        {
            JSB_TESTS_EXECUTION_SCOPE(primary.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(primary->get_isolate(), primary->get_context(), survivor, wrapper));
            CHECK(primary->verify_object(survivor, wrapper));
            memdelete(survivor);
        }
    }
}
#endif
