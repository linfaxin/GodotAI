#ifndef GODOTJS_TESTS_REACT_BRIDGE_H
#define GODOTJS_TESTS_REACT_BRIDGE_H

#include "jsb_test_helpers.h"
#include "../bridge/jsb_object_db.h"
#include "../bridge/jsb_type_convert.h"
#include "../bridge/jsb_react_bridge.h"
#include "scene/main/node.h"
#include "core/object/callable_method_pointer.h"
#include <atomic>

namespace jsb::tests
{
    inline void react_test_free_detached_node(Node* p_node)
    {
        if (p_node && !p_node->get_parent()) memdelete(p_node);
    }

    TEST_CASE("[jsb] React ObjectDB ownership removal is atomic and revisioned")
    {
        ObjectDB database(4);
        int native = 0;
        ObjectHandlePtr handle;
        const NativeObjectID original = database.add_object(&native, &handle);
        REQUIRE(handle);
#if JSB_DEBUG
        handle->pointer = &native;
#endif
        handle = nullptr;
        REQUIRE(database.set_react_owner(original, 42));
        CHECK(database.get_react_owner(&native) == 42);
        CHECK_FALSE(database.set_react_owner(original, 43));

        // A GC-empty wrapper cannot silently replace an owned facade's ID.
        CHECK_FALSE(database.add_object(&native, &handle));
        CHECK_FALSE(handle);
        CHECK(database.try_get_object_id(&native) == original);
        REQUIRE(database.set_react_expected_release(original, "batch-42"));
        handle = database.try_get_object(&native);
        const ObjectDB::RemovedIdentity removed = database.remove_object_and_take_identity(handle, &native);
        CHECK_FALSE(handle);
        CHECK(removed.id == original);
        CHECK(removed.react_owner_token == 42);
        CHECK(removed.expected_release);
        CHECK(removed.retirement_batch == "batch-42");
        CHECK_FALSE(database.has_object(original));

        const NativeObjectID replacement = database.add_object(&native, &handle);
        REQUIRE(handle);
#if JSB_DEBUG
        handle->pointer = &native;
#endif
        CHECK(replacement != original);
        handle = nullptr;
        CHECK(database.get_react_owner(&native) == 0);
        handle = database.try_get_object(&native);
        database.remove_object(handle, &native);
    }

    TEST_CASE("[jsb] React NativeKey shared G0 fixture preserves both uint32 fields")
    {
        CurrentWorkingDirectory::reset();
        const String path = "modules/" JSB_MODULE_NAME_STRING "/scripts/jsb.react/src/contracts/fixtures/native-key-v1.json";
        REQUIRE(FileAccess::exists(path));
        const Variant parsed = JSON::parse_string(FileAccess::get_file_as_string(path));
        REQUIRE(parsed.get_type() == Variant::DICTIONARY);
        const Dictionary fixture = parsed;
        const uint32_t slot = (uint32_t) (int64_t) fixture.get("slot", 0);
        const uint32_t revision = (uint32_t) (int64_t) fixture.get("revision", 0);
        const NativeObjectID key((int32_t) slot, revision);
        CHECK(key.get_index() == INT32_MAX);
        CHECK(key.get_revision() == UINT32_MAX);
        CHECK(key.get_index() == (int32_t) slot);
        CHECK(key.get_revision() == revision);
    }

    TEST_CASE("[jsb] React native bridge topology guards safe values and expected retirement [SceneTree]")
    {
        GodotJSScriptLanguageIniter initer;
        const auto environment = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(environment.get());
        Statistics before;
        environment->get_statistics(before);
        static constexpr char source[] = R"JS((function () {
            const assert = (value, message) => { if (!value) throw Error(message); };
            const rejected = (fn, code) => {
                try { fn(); } catch (error) { assert(String(error).includes(code), String(error)); return; }
                throw Error("operation was not rejected: " + code);
            };
            const Node = require("godot").Node;
            const attachment = new Node();
            const outside = new Node();
            const bridge = require("godot-jsb").internal.react;
            assert(bridge.abi === "godot-react-native/1", "native ABI");
            const root = bridge.openRoot(attachment, "native-tests", "topology-and-guards");
            const cap = root.cap;
            try {
                rejected(() => bridge.create(cap, "Label"), "E_PHASE");
                bridge.beginStage(cap, "initial");
                rejected(() => bridge.beginStage(cap, "safe"), "E_PHASE_REENTRY");
                rejected(() => bridge.create(cap, "SceneTree"), "E_HOST_PROFILE");
                const label = bridge.create(cap, "Label");
                bridge.set(cap, label, "name", "Title");
                bridge.set(cap, label, "text", "hello React");
                bridge.append(cap, root.key, label, 0);
                bridge.setOwner(cap, label, root.key);
                assert(bridge.read(cap, label, "text") === "hello React", "stored text");
                const position = bridge.read(cap, label, "position");
                assert(position.kind === "Vector2" && position.x === 0, "value encoding");
                rejected(() => bridge.set(cap, label, "script", null), "E_PROPERTY_PERMISSION");
                rejected(() => bridge.set(cap, label, "name", "Renamed"), "E_CONSTRUCTION_PROP");
                const raw = attachment.get_child(0);
                rejected(() => raw.set_name("Foreign"), "E_STRUCTURAL_PERMISSION");
                rejected(() => raw.call("queue_free"), "E_STRUCTURAL_PERMISSION");
                rejected(() => raw.queue_free(), "E_STRUCTURAL_PERMISSION");
                rejected(() => raw.free(), "E_STRUCTURAL_PERMISSION");
                rejected(() => outside.add_child(raw), "E_STRUCTURAL_PERMISSION");
                rejected(() => outside.call("add_child", raw), "E_STRUCTURAL_PERMISSION");
                rejected(() => outside.callv("add_child", [raw]), "E_STRUCTURAL_PERMISSION");
                bridge.audit(cap);
                const button = bridge.create(cap, "Button");
                rejected(() => bridge.set(cap, button, "button_pressed", true), "E_NATIVE_SET");
                bridge.set(cap, button, "toggle_mode", true);
                assert(bridge.set(cap, button, "button_pressed", true) === true, "stored setter acknowledgement");
                bridge.set(cap, button, "name", "Action");
                bridge.append(cap, root.key, button, 1);
                let pressed = 0;
                const connection = bridge.connect(cap, button, "pressed", () => pressed++);
                attachment.get_child(1).emit_signal("pressed");
                assert(pressed === 1, "signal bridge delivery");
                bridge.disconnect(cap, connection);
                bridge.remove(cap, root.key, button);
                bridge.free(cap, button, "fixture-batch");
                assert(!bridge.isAlive(cap, button), "retired key");
                const losses = bridge.takeInvalidations(cap);
                assert(losses.length === 1 && losses[0].expected && losses[0].retirementBatch === "fixture-batch", "expected native lifetime release");
                rejected(() => bridge.read(cap, button, "name"), "E_NATIVE_LOST");
                bridge.remove(cap, root.key, label);
                bridge.setOwner(cap, label, null);
                assert(bridge.read(cap, label, "owner") === null, "authorized owner clearing after detach");
                bridge.free(cap, label);
                bridge.audit(cap);
                bridge.endStage(cap);
                bridge.beginStage(cap, "cleanup");
                bridge.closeRoot(cap);
                bridge.endStage(cap);
                assert(!bridge.isAlive(cap, label), "closed root");
            } finally {
                try { bridge.endStage(cap); bridge.beginStage(cap, "cleanup"); bridge.closeRoot(cap, true); } catch (_) {}
                attachment.free(); outside.free();
            }
        })())JS";
        Error error = OK;
        environment->eval_source(source, std::size(source) - 1, "react-native-test.js", error);
        CHECK(error == OK);
        Statistics after;
        environment->get_statistics(after);
        CHECK(after.objects == before.objects);
    }

    TEST_CASE("[jsb] React native audit and background lifetime loss fail closed")
    {
        GodotJSScriptLanguageIniter initer;
        const auto environment = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(environment.get());
        auto evaluate = [&](const char* p_source) {
            Error error = OK;
            environment->eval_source(p_source, (int) strlen(p_source), "react-native-loss-test.js", error);
            CHECK(error == OK);
        };
        evaluate(R"JS(
            globalThis.__reactLossProbe = (() => {
                const attachment = new (require("godot").Node)();
                const bridge = require("godot-jsb").internal.react;
                const opened = bridge.openRoot(attachment, "native-tests", "background-lifetime-loss");
                bridge.beginStage(opened.cap, "initial");
                const key = bridge.create(opened.cap, "Node");
                bridge.set(opened.cap, key, "name", "Managed");
                bridge.append(opened.cap, opened.key, key, 0);
                const probe = { attachment, bridge, cap: opened.cap, key, calls: 0, connection: 0 };
                probe.connection = bridge.connect(opened.cap, key, "tree_entered", () => probe.calls++);
                bridge.endStage(opened.cap);
                return probe;
            })();
        )JS");
        const auto isolate = environment->get_isolate();
        const auto context = environment->get_context();
        const auto probe = context->Global()->Get(context, impl::Helper::new_string_ascii(isolate, "__reactLossProbe")).ToLocalChecked().As<v8::Object>();
        Object* object = nullptr;
        REQUIRE(TypeConvert::js_to_gd_obj(isolate, context,
            probe->Get(context, impl::Helper::new_string_ascii(isolate, "attachment")).ToLocalChecked(), object));
        Node* attachment = Object::cast_to<Node>(object);
        REQUIRE(attachment);
        REQUIRE(attachment->get_child_count(false) == 1);
        Node* child = attachment->get_child(0, false);

#if JSB_THREADING
        // The certified profile rejects background signals before accessing
        // any JS/context/connection registry, including a concurrent disconnect.
        std::atomic<bool> emitting{false};
        std::atomic<bool> disconnected{false};
        ERR_PRINT_OFF;
        std::thread signaling_thread([&]() {
            emitting.store(true, std::memory_order_release);
            while (!disconnected.load(std::memory_order_acquire)) child->emit_signal("tree_entered");
            for (int i = 0; i < 64; ++i) child->emit_signal("tree_entered");
        });
        while (!emitting.load(std::memory_order_acquire)) std::this_thread::yield();
        evaluate("__reactLossProbe.bridge.disconnect(__reactLossProbe.cap, __reactLossProbe.connection);");
        disconnected.store(true, std::memory_order_release);
        signaling_thread.join();
        ERR_PRINT_ON;
        evaluate("if (__reactLossProbe.calls !== 0) throw Error('background signal entered JS');");
#endif

        // Foreign C++ mutations do not pass through JSB setters. Audit must
        // observe them; JSB-only guards must never be advertised as core veto.
        child->set_name("ForeignName");
        evaluate(R"JS((() => {
            const p = globalThis.__reactLossProbe;
            try { p.bridge.audit(p.cap); } catch (error) {
                if (String(error).includes("E_FOREIGN_MUTATION")) return;
                throw error;
            }
            throw Error("foreign native mutation was not observed");
        })())JS");
        child->set_name("Managed");

        // InstanceBindingCallbacks retires the pointer immediately, while only
        // revisioned POD events and passive handles cross the thread boundary.
#if JSB_THREADING
        std::thread freeing_thread([child]() { memdelete(child); });
        freeing_thread.join();
#else
        memdelete(child);
#endif
        evaluate(R"JS((() => {
            const p = globalThis.__reactLossProbe;
            const lost = p.bridge.takeInvalidations(p.cap);
            if (lost.length !== 1 || lost[0].expected || p.bridge.isAlive(p.cap, p.key))
                throw Error("background lifetime was not atomically invalidated");
            p.bridge.beginStage(p.cap, "cleanup");
            p.bridge.closeRoot(p.cap, true);
            p.bridge.endStage(p.cap);
            p.attachment.free();
            delete globalThis.__reactLossProbe;
        })())JS");
    }

    TEST_CASE("[jsb] React forced cleanup preserves foreign children and tolerates reentrant loss")
    {
        GodotJSScriptLanguageIniter initer;
        const auto environment = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(environment.get());
        static constexpr char setup[] = R"JS(
            globalThis.__reactCleanupProbe = (() => {
                const attachment = new (require("godot").Node)();
                const bridge = require("godot-jsb").internal.react;
                const opened = bridge.openRoot(attachment, "native-tests", "reentrant-forced-close");
                bridge.beginStage(opened.cap, "initial");
                const key = bridge.create(opened.cap, "Node");
                bridge.append(opened.cap, opened.key, key, 0);
                bridge.endStage(opened.cap);
                return { attachment, bridge, cap: opened.cap };
            })();
        )JS";
        Error error = OK;
        environment->eval_source(setup, std::size(setup) - 1, "react-force-test.js", error);
        REQUIRE(error == OK);
        const auto isolate = environment->get_isolate();
        const auto context = environment->get_context();
        const auto probe = context->Global()->Get(context, impl::Helper::new_string_ascii(isolate, "__reactCleanupProbe")).ToLocalChecked().As<v8::Object>();
        Object* object = nullptr;
        REQUIRE(TypeConvert::js_to_gd_obj(isolate, context,
            probe->Get(context, impl::Helper::new_string_ascii(isolate, "attachment")).ToLocalChecked(), object));
        Node* attachment = Object::cast_to<Node>(object);
        REQUIRE(attachment);
        REQUIRE(attachment->get_child_count(false) == 1);
        Node* business = attachment->get_child(0, false);
        Node* foreign = memnew(Node);
        const ObjectID foreign_id = foreign->get_instance_id();
        business->add_child(foreign);
        // This callback deletes the owned candidate inside remove_child. The
        // close implementation must resolve its NativeKey before using it.
        attachment->connect("child_order_changed", callable_mp_static(&react_test_free_detached_node).bind(business), Object::CONNECT_ONE_SHOT);
        static constexpr char cleanup[] = R"JS((() => {
            const p = globalThis.__reactCleanupProbe;
            p.bridge.quiesceRoot(p.cap);
            p.bridge.beginStage(p.cap, "cleanup");
            p.bridge.closeRoot(p.cap, true);
            p.bridge.endStage(p.cap);
            p.attachment.free();
            delete globalThis.__reactCleanupProbe;
        })())JS";
        environment->eval_source(cleanup, std::size(cleanup) - 1, "react-force-test.js", error);
        CHECK(error == OK);
        Node* survivor = Object::cast_to<Node>(compat::ObjectDB::get_instance(foreign_id));
        REQUIRE(survivor);
        CHECK(survivor->get_parent() == nullptr);
        memdelete(survivor);
    }

    TEST_CASE("[jsb] React ownership guards existing and new foreign Environment bindings")
    {
        GodotJSScriptLanguageIniter initer;
        const auto primary = GodotJSScriptLanguage::get_singleton()->get_environment();
        const auto foreign = std::make_shared<Environment>(Environment::CreateParams());
        foreign->init();
        auto evaluate = [&](const std::shared_ptr<Environment>& p_env, const char* p_source) {
            v8::Isolate::Scope isolate_scope(p_env->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(p_env.get());
            Error error = OK;
            p_env->eval_source(p_source, (int) strlen(p_source), "react-cross-environment-test.js", error);
            CHECK(error == OK);
        };
        evaluate(foreign, "globalThis.__foreignNode = new (require('godot').Node)();");
        Object* attachment = nullptr;
        {
            v8::Isolate::Scope isolate_scope(foreign->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(foreign.get());
            const auto context = foreign->get_context();
            REQUIRE(TypeConvert::js_to_gd_obj(foreign->get_isolate(), context,
                context->Global()->Get(context, impl::Helper::new_string_ascii(foreign->get_isolate(), "__foreignNode")).ToLocalChecked(), attachment));
        }
        REQUIRE(attachment);
        Node* ancestor = memnew(Node);
        ancestor->add_child(Object::cast_to<Node>(attachment));
        const ObjectID attachment_id = attachment->get_instance_id();
        {
            v8::Isolate::Scope isolate_scope(foreign->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(foreign.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(foreign->get_isolate(), foreign->get_context(), ancestor, wrapper));
            foreign->get_context()->Global()->Set(foreign->get_context(), impl::Helper::new_string_ascii(foreign->get_isolate(), "__foreignAncestor"), wrapper).Check();
        }
        {
            v8::Isolate::Scope isolate_scope(primary->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(primary.get());
            v8::Local<v8::Object> wrapper;
            REQUIRE(TypeConvert::gd_obj_to_js(primary->get_isolate(), primary->get_context(), attachment, wrapper));
            primary->get_context()->Global()->Set(primary->get_context(), impl::Helper::new_string_ascii(primary->get_isolate(), "__reactCrossAttachment"), wrapper).Check();
        }
        evaluate(primary, "globalThis.__reactCrossRoot = require('godot-jsb').internal.react.openRoot(__reactCrossAttachment, 'native-tests', 'cross-environment');");
        CHECK(ReactBridge::is_owned(attachment));
        evaluate(foreign, R"JS((() => {
            for (const action of [() => __foreignNode.set_name('Foreign'), () => __foreignNode.free(), () => __foreignAncestor.free(), () => __foreignAncestor.call('queue_free')]) {
                let rejected = false;
                try { action(); } catch (error) { rejected = String(error).includes('E_STRUCTURAL_PERMISSION'); }
                if (!rejected) throw Error('existing foreign binding escaped ownership');
            }
        })())JS");
        {
            v8::Isolate::Scope isolate_scope(foreign->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(foreign.get());
            const impl::TryCatch catcher(foreign->get_isolate());
            TransferData transfer;
            CHECK_FALSE(foreign->prepare_transfer_out({}, 0, attachment, transfer));
            REQUIRE(catcher.has_caught());
            String message;
            catcher.get_message(&message);
            CHECK(message.contains("E_NATIVE_TRANSFER"));
        }
        const auto third = std::make_shared<Environment>(Environment::CreateParams());
        third->init();
        {
            v8::Isolate::Scope isolate_scope(third->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(third.get());
            const impl::TryCatch catcher(third->get_isolate());
            v8::Local<v8::Object> wrapper;
            CHECK_FALSE(TypeConvert::gd_obj_to_js(third->get_isolate(), third->get_context(), attachment, wrapper));
            REQUIRE(catcher.has_caught());
            String message;
            catcher.get_message(&message);
            CHECK(message.contains("E_NATIVE_REBIND"));
        }
        third->dispose();
        // This foreign wrapper was originally JS-owned. Its context disposal
        // may retire that binding, but must not destroy the claimed native Node.
        foreign->dispose();
        CHECK(compat::ObjectDB::get_instance(attachment_id) == attachment);
        evaluate(primary, R"JS((() => {
            const bridge = require('godot-jsb').internal.react;
            bridge.audit(__reactCrossRoot.cap);
            bridge.quiesceRoot(__reactCrossRoot.cap);
            bridge.closeRoot(__reactCrossRoot.cap);
            delete globalThis.__reactCrossRoot;
            delete globalThis.__reactCrossAttachment;
        })())JS");
        CHECK_FALSE(ReactBridge::is_owned(attachment));
        memdelete(ancestor);
    }

    TEST_CASE("[jsb] React Callable lifecycle preserves owned Nodes and readonly calls [SceneTree]")
    {
        GodotJSScriptLanguageIniter initer;
        const auto environment = GodotJSScriptLanguage::get_singleton()->get_environment();
        JSB_TESTS_EXECUTION_SCOPE(environment.get());
        static constexpr char source[] = R"JS((() => {
            const { Node, Timer, Callable } = require("godot");
            const bridge = require("godot-jsb").internal.react;
            const target = new Node(); target.set_name("CallableTarget");
            const outside = new Node(); const timer = new Timer();
            // Creation before ownership must preserve the ordinary legacy API.
            const freeBeforeClaim = new Callable(target, "free");
            const adoptBeforeClaim = new Callable(outside, "add_child").bind(target);
            const root = bridge.openRoot(target, "native-tests", "callable-lifecycle");
            const assert = (value, message) => { if (!value) throw Error(message); };
            const rejected = (fn) => {
                try { fn(); } catch (error) { assert(String(error).includes("E_STRUCTURAL_PERMISSION"), String(error)); return; }
                throw Error("Callable escaped the ownership permission");
            };
            try {
                rejected(() => new Callable(target, "free"));
                rejected(() => Callable.create(target, "set_name"));
                rejected(() => freeBeforeClaim.call());
                rejected(() => freeBeforeClaim.callv([]));
                rejected(() => freeBeforeClaim.call_deferred());
                rejected(() => adoptBeforeClaim.call());
                rejected(() => timer.timeout.connect(freeBeforeClaim));
                rejected(() => timer.connect("timeout", adoptBeforeClaim));
                const reader = new Callable(target, "get_name");
                assert(reader.call() === "CallableTarget", "readonly Callable.call");
                assert(reader.callv([]) === "CallableTarget", "readonly Callable.callv");
                assert(timer.timeout.connect(reader) === 0, "readonly callback admission");
                assert(timer.timeout.is_connected(reader), "callback identity preserved");
                timer.emit_signal("timeout");
                timer.timeout.disconnect(reader);
                assert(bridge.isAlive(root.cap, root.key), "the owned lifetime survived");
                bridge.audit(root.cap);
                bridge.quiesceRoot(root.cap); bridge.closeRoot(root.cap);
                // Once ownership closes, the same previously-created Callable
                // again has precisely its ordinary Godot lifetime semantics.
                freeBeforeClaim.call();
            } finally {
                try { bridge.beginStage(root.cap, "cleanup"); bridge.closeRoot(root.cap, true); } catch (_) {}
                outside.free(); timer.free();
            }
        })())JS";
        Error error = OK;
        environment->eval_source(source, std::size(source) - 1, "react-callable-lifecycle-test.js", error);
        CHECK(error == OK);
    }
}

#endif
