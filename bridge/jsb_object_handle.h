#ifndef GODOTJS_OBJECT_HANDLE_H
#define GODOTJS_OBJECT_HANDLE_H

#include "jsb_bridge_pch.h"
#include <atomic>

namespace jsb
{
    enum EInternalFields
    {
        IF_Pointer = 0,   // pointer to object (used by object/variant both)
        IF_ClassType = 1, // class type for non-valuetype objects (not a Variant)

        IF_VariantFieldCount = 1,
        IF_ObjectFieldCount = 2,
    };

    // Stable for one binding, independently of ObjectDB slot relocation and native
    // address reuse. Native callbacks/queued work own shared references; only the
    // Environment's thread may touch reference or gc_lease.
    struct ObjectBindingTicket : std::enable_shared_from_this<ObjectBindingTicket>
    {
        void* pointer = nullptr;
        NativeObjectID id;
        ObjectID godot_id;
        uint64_t environment_epoch = 0;
        uint64_t generation = 0;
        bool godot_object = false;
        std::atomic<bool> active{true};
        v8::Global<v8::Object> reference;
        std::shared_ptr<ObjectBindingTicket> gc_lease;
    };

    // godot Object classes or c++ native wrapped classes are registered in an object registry in Environment.
    // godot Variant (valuetype) DO NOT have it's ObjectHandle.
    struct ObjectHandle
    {
        NativeClassID class_id;

        uint32_t ref_count_;

        // True when a non-refcounted Godot Object is explicitly JS-owned
        // (constructed from JS via native class constructor path).
        // Engine-owned non-refcounted objects (for example sub-objects returned
        // from APIs) must stay false so GC finalization only unbinds them.
        bool js_owned_non_ref_ = false;

        // React ownership is optional. Zero preserves the legacy binding path.
        // Both fields are accessed under ObjectDB's lock, including from the
        // background InstanceBindingCallbacks::free_callback path.
        uint64_t react_owner_token = 0;
        ObjectID react_object_id;
        bool react_expected_release = false;
        String react_retirement_batch;

#if JSB_DEBUG
        // The raw pointer to the native object.
        // It must be a unique pointer which implies that different objects have different addresses.
        //NOTE it's useless at runtime now. we hold it here to validate the object binding for debugging only.
        void* pointer;
#endif

        // this reference is initially weak and hooked on v8 gc callback.
        // it becomes a strong reference after the `ref_count_` explicitly increased.
        std::shared_ptr<ObjectBindingTicket> binding;
    };

}

#endif
