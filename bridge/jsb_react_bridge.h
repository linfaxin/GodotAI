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
    };
}

#endif
