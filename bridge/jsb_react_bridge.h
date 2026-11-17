#ifndef GODOTJS_REACT_BRIDGE_H
#define GODOTJS_REACT_BRIDGE_H

#include "jsb_bridge_pch.h"
#include <memory>

namespace jsb
{
    class Environment;

    // Native half of godot-react-native/1. Public SDK refs never contain this
    // object or the opaque root capabilities accepted by its JS entry points.
    class ReactBridge
    {
#if JSB_WITH_LEGACY_REACT
        struct Impl;
        std::unique_ptr<Impl> impl_;

    public:
        explicit ReactBridge(Environment* p_environment);
        ~ReactBridge();
        ReactBridge(const ReactBridge&) = delete;
        ReactBridge& operator=(const ReactBridge&) = delete;

        void install(const v8::Local<v8::Context>& p_context, const v8::Local<v8::Object>& p_internal);
        void notify_removed(NativeObjectID p_id, uint64_t p_owner, ObjectID p_object_id, bool p_expected, const String& p_retirement_batch);
        void dispose();
        bool has_active_roots() const;
        bool allows_method(Object* p_receiver, const StringName& p_method, const Variant** p_args, int p_argc) const;
        bool allows_free(Object* p_object) const;
        static bool is_owned(Object* p_object);
        static bool protects_structure(Object* p_object);
        static bool allows_bound_method(Object* p_receiver, const StringName& p_method, const Variant** p_args, int p_argc, int p_depth = 0);
        static bool allows_bound_free(Object* p_object);
        static bool allows_callable(const Callable& p_callable, const Variant** p_args = nullptr, int p_argc = 0, int p_depth = 0);
        void invoke_signal(uint64_t p_connection, const Variant** p_args, int p_argc) const;

    private:
        static void dispatch(const v8::FunctionCallbackInfo<v8::Value>& p_info);
#else
    public:
        // Existing generic bridge callsites keep their signatures while the
        // deprecated ownership/audit implementation is absent from the build.
        explicit ReactBridge(Environment*) {}
        void install(const v8::Local<v8::Context>&, const v8::Local<v8::Object>&) {}
        void notify_removed(NativeObjectID, uint64_t, ObjectID, bool, const String&) {}
        void dispose() {}
        bool has_active_roots() const { return false; }
        bool allows_method(Object*, const StringName&, const Variant**, int) const { return true; }
        bool allows_free(Object*) const { return true; }
        static bool is_owned(Object*) { return false; }
        static bool protects_structure(Object*) { return false; }
        static bool allows_bound_method(Object*, const StringName&, const Variant**, int, int = 0) { return true; }
        static bool allows_bound_free(Object*) { return true; }
        static bool allows_callable(const Callable&, const Variant** = nullptr, int = 0, int = 0) { return true; }
        void invoke_signal(uint64_t, const Variant**, int) const {}
#endif
    };
}

#endif
