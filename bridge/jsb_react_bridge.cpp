#include "jsb_react_bridge.h"
#include "jsb_environment.h"
#include "jsb_type_convert.h"
#include "../internal/jsb_react_run_lease.h"
#include "../internal/jsb_react_local_resources.h"
#include "../internal/jsb_react_manifest.h"

#include "scene/main/node.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "core/io/resource_loader.h"
#include "core/object/script_language.h"
#include "core/version.h"
#include <atomic>
#include <cmath>

namespace jsb
{
    namespace
    {
        struct GlobalOwner
        {
            EnvironmentID environment = nullptr;
            uint64_t root = 0;
        };
        SpinLock global_owner_lock;
        HashMap<ObjectID, GlobalOwner> global_owners;
        std::atomic<uint32_t> global_owner_count{0};

        GlobalOwner global_owner(ObjectID p_object)
        {
            if (!global_owner_count.load(std::memory_order_acquire)) return {};
            global_owner_lock.lock();
            const GlobalOwner* owner = global_owners.getptr(p_object);
            const GlobalOwner result = owner ? *owner : GlobalOwner();
            global_owner_lock.unlock();
            return result;
        }

        bool global_claim(ObjectID p_object, EnvironmentID p_environment, uint64_t p_root, bool& r_inserted)
        {
            r_inserted = false;
            global_owner_lock.lock();
            if (const GlobalOwner* existing = global_owners.getptr(p_object))
            {
                const bool same = existing->environment == p_environment && existing->root == p_root;
                global_owner_lock.unlock();
                return same;
            }
            global_owners.insert(p_object, GlobalOwner{p_environment, p_root});
            global_owner_count.fetch_add(1, std::memory_order_release);
            r_inserted = true;
            global_owner_lock.unlock();
            return true;
        }

        void global_release(ObjectID p_object, EnvironmentID p_environment, uint64_t p_root)
        {
            global_owner_lock.lock();
            const GlobalOwner* existing = global_owners.getptr(p_object);
            if (existing && existing->environment == p_environment && existing->root == p_root)
            {
                global_owners.erase(p_object);
                global_owner_count.fetch_sub(1, std::memory_order_release);
            }
            global_owner_lock.unlock();
        }

        enum Operation
        {
            OPEN_ROOT, CLOSE_ROOT, BEGIN_STAGE, END_STAGE, CREATE, READ, SET,
            APPEND, REMOVE, FREE, CHILDREN, INFO, IS_ALIVE, CONNECT, DISCONNECT,
            INVALIDATIONS, AUDIT, LOAD_ASSET, RELEASE_ASSET, CALL, SET_OWNER,
            SHUTDOWN_REQUESTED, NATIVE_IDENTITY, NATIVE_RPC, LOCALIZE_ASSET, FINISH_ASSET_SCOPE, RELEASE_ASSET_SCOPE, QUIESCE_ROOT, FORMAT_STACK,
        };

        void put(const v8::Local<v8::Context>& p_context, const v8::Local<v8::Object>& p_object,
                 const char* p_name, const v8::Local<v8::Value>& p_value)
        {
            p_object->Set(p_context, impl::Helper::new_string_ascii(p_context->GetIsolate(), p_name), p_value).Check();
        }

        v8::Local<v8::Value> field(const v8::Local<v8::Context>& p_context,
                                   const v8::Local<v8::Object>& p_object, const char* p_name)
        {
            v8::Local<v8::Value> value;
            if (!p_object->Get(p_context, impl::Helper::new_string_ascii(p_context->GetIsolate(), p_name)).ToLocal(&value))
                return v8::Undefined(p_context->GetIsolate());
            return value;
        }

        bool read_key(const v8::Local<v8::Context>& p_context, const v8::Local<v8::Value>& p_value, NativeObjectID& r_id)
        {
            if (!p_value->IsObject()) return false;
            const v8::Local<v8::Object> object = p_value.As<v8::Object>();
            const v8::Local<v8::Value> slot = field(p_context, object, "slot");
            const v8::Local<v8::Value> revision = field(p_context, object, "revision");
            if (!slot->IsUint32() || !revision->IsUint32()) return false;
            const uint32_t index = slot.As<v8::Uint32>()->Value();
            const uint32_t rev = revision.As<v8::Uint32>()->Value();
            if (index > INT32_MAX || rev == 0) return false;
            r_id = NativeObjectID((int32_t) index, rev);
            return true;
        }

        v8::Local<v8::Object> write_key(const v8::Local<v8::Context>& p_context, NativeObjectID p_id)
        {
            v8::Isolate* isolate = p_context->GetIsolate();
            const v8::Local<v8::Object> object = v8::Object::New(isolate);
            put(p_context, object, "slot", v8::Uint32::NewFromUnsigned(isolate, (uint32_t) p_id.get_index()));
            put(p_context, object, "revision", v8::Uint32::NewFromUnsigned(isolate, p_id.get_revision()));
            return object;
        }

        bool is_structural(const StringName& p_method)
        {
            const String method = p_method;
            return method == "free" || method == "queue_free" || method == "add_child"
                || method == "add_sibling" || method == "remove_child" || method == "move_child"
                || method == "reparent" || method == "replace_by" || method == "duplicate"
                || method == "set_name" || method == "set_owner" || method == "set_script"
                || method == "set_unique_name_in_owner";
        }

        bool is_navigation(const StringName& p_method)
        {
            const String method = p_method;
            return method == "change_scene_to_file" || method == "change_scene_to_packed"
                || method == "change_scene_to_node" || method == "reload_current_scene"
                || method == "unload_current_scene" || method == "set_current_scene" || method == "quit";
        }

        bool is_reflection_write(const StringName& p_method)
        {
            const String method = p_method;
            return method == "call" || method == "callv" || method == "call_deferred"
                || method == "set" || method == "set_deferred" || method == "set_indexed"
                || method.begins_with("set_") || method == "show" || method == "hide";
        }

        bool is_reader(const StringName& p_method)
        {
            const String method = p_method;
            return method.begins_with("get_") || method.begins_with("is_") || method.begins_with("has_")
                || method.begins_with("can_") || method == "find_child" || method == "find_children"
                || method == "find_parent" || method == "to_string" || method == "tr" || method == "tr_n";
        }

        bool is_indirect_write(const StringName& p_method)
        {
            const String method = p_method;
            return method == "call_group" || method == "call_group_flags" || method == "set_group"
                || method == "set_group_flags" || method == "notify_group" || method == "notify_group_flags"
                || method == "propagate_call" || method == "propagate_notification";
        }

        bool carries_owned_object(Environment* p_environment, const Variant& p_value, int p_depth = 0)
        {
            // Reflection accepts recursively nested argument lists. Bound the
            // walk so cyclic/deep payloads fail closed instead of recursing.
            if (p_depth > 16) return true;
            if (p_value.get_type() == Variant::OBJECT)
            {
                Object* object = p_value;
                return object && ReactBridge::is_owned(object);
            }
            if (p_value.get_type() == Variant::CALLABLE)
            {
                const Callable callable = p_value;
                return !ReactBridge::allows_callable(callable, nullptr, 0, p_depth + 1);
            }
            if (p_value.get_type() == Variant::ARRAY)
            {
                const Array values = p_value;
                for (int i = 0; i < values.size(); ++i)
                    if (carries_owned_object(p_environment, values[i], p_depth + 1)) return true;
            }
            if (p_value.get_type() == Variant::DICTIONARY)
            {
                const Dictionary values = p_value;
                const Array keys = values.keys();
                for (int i = 0; i < keys.size(); ++i)
                    if (carries_owned_object(p_environment, keys[i], p_depth + 1)
                        || carries_owned_object(p_environment, values.get(keys[i], Variant()), p_depth + 1)) return true;
            }
            return false;
        }

        bool allowed_class(const StringName& p_type)
        {
            // No custom ClassDB/GDExtension type is silently accepted. A type is
            // only available to authors when its runtime profile is certified.
            static const char* types[] = { "Node", "Node2D", "Node3D", "Control", "VBoxContainer", "HBoxContainer",
                "Label", "Button", "CanvasLayer", "LineEdit", "HSlider", "Sprite2D", "CharacterBody2D",
                "CollisionShape2D", "StaticBody2D", "RigidBody2D", "Area2D", "AnimationPlayer", "Camera2D",
                "CharacterBody3D", "CollisionShape3D", "StaticBody3D", "RigidBody3D", "Area3D", "Camera3D",
                "MeshInstance3D", "SubViewport", "SubViewportContainer", "ColorRect", "PointLight2D",
                "LightOccluder2D", "CanvasModulate", "DirectionalLight3D", "WorldEnvironment", "AudioStreamPlayer", "RayCast3D" };
            for (const char* type : types) if (p_type == StringName(type)) return true;
            return false;
        }

        bool allowed_asset_type(const StringName& p_type)
        {
            return p_type == StringName("Resource") || p_type == StringName("CanvasItemMaterial")
                || p_type == StringName("Texture2D") || p_type == StringName("ImageTexture")
                || p_type == StringName("CompressedTexture2D") || p_type == StringName("Shape2D")
                || p_type == StringName("CapsuleShape2D") || p_type == StringName("RectangleShape2D")
                || p_type == StringName("CircleShape2D") || p_type == StringName("Shape3D")
                || p_type == StringName("CapsuleShape3D") || p_type == StringName("BoxShape3D")
                || p_type == StringName("SphereShape3D") || p_type == StringName("ConvexPolygonShape3D") || p_type == StringName("Theme")
                || p_type == StringName("Mesh") || p_type == StringName("ArrayMesh") || p_type == StringName("BoxMesh")
                || p_type == StringName("SphereMesh") || p_type == StringName("CylinderMesh")
                || p_type == StringName("ShaderMaterial") || p_type == StringName("StandardMaterial3D")
                || p_type == StringName("Environment") || p_type == StringName("OccluderPolygon2D")
                || p_type == StringName("AudioStream") || p_type == StringName("AudioStreamOggVorbis");
        }

        bool mutable_property(const StringName& p_name)
        {
            const String name = p_name;
            static const char* names[] = { "name", "position", "global_position", "rotation", "scale", "visible",
                "modulate", "self_modulate", "text", "disabled", "toggle_mode", "button_pressed", "flat",
                "custom_minimum_size", "size_flags_horizontal", "size_flags_vertical", "mouse_filter", "focus_mode",
                "alignment", "vertical_alignment", "layer", "offset", "transform", "material", "texture",
                "velocity", "linear_velocity", "angular_velocity", "shape", "collision_layer", "collision_mask",
                "gravity_scale", "freeze", "monitoring", "monitorable", "enabled", "size", "anchor_left",
                "anchor_top", "anchor_right", "anchor_bottom", "offset_left", "offset_top", "offset_right",
                "offset_bottom", "value", "min_value", "max_value", "step", "placeholder_text", "editable",
                "max_length", "process_mode", "process_priority", "physics_process_priority", "up_direction",
                "motion_mode", "floor_max_angle", "floor_snap_length", "floor_stop_on_slope", "floor_constant_speed",
                "floor_block_on_wall", "max_slides", "wall_min_slide_angle", "safe_margin", "slide_on_ceiling",
                "constant_linear_velocity", "constant_angular_velocity", "one_way_collision", "one_way_collision_margin",
                "color", "energy", "texture_scale", "shadow_enabled", "occluder", "mesh", "material_override",
                "environment", "current", "fov", "near", "far", "light_color", "light_energy", "centered", "stream", "volume_db",
                "projection", "mass", "linear_damp", "angular_damp", "sleeping", "target_position", "exclude_parent" };
            for (const char* candidate : names) if (name == candidate) return true;
            return false;
        }

        bool stored_equivalent(Node* p_node, const StringName& p_property, const Variant& p_requested, const Variant& p_stored)
        {
            const bool requested_null = p_requested.get_type() == Variant::NIL
                || (p_requested.get_type() == Variant::OBJECT && p_requested.is_null());
            const bool stored_null = p_stored.get_type() == Variant::NIL
                || (p_stored.get_type() == Variant::OBJECT && p_stored.is_null());
            if (requested_null && stored_null) return true;
            if (p_requested.get_type() != p_stored.get_type()) return false;
            if (p_requested.get_type() == Variant::FLOAT)
            {
                const double requested = p_requested;
                const double stored = p_stored;
                // Godot properties may store real_t or fixed float fields even
                // though Variant::FLOAT itself holds a double.
                return stored == requested || stored == (double) (real_t) requested || stored == (double) (float) requested;
            }
            if (p_requested.get_type() == Variant::VECTOR2)
            {
                Vector2 expected = p_requested;
                if (p_property == StringName("up_direction")) expected = expected.normalized();
                if (p_property == StringName("scale") && p_node->is_class("Node2D"))
                {
                    if (Math::is_zero_approx(expected.x)) expected.x = CMP_EPSILON;
                    if (Math::is_zero_approx(expected.y)) expected.y = CMP_EPSILON;
                }
                return expected == Vector2(p_stored);
            }
            if (p_requested.get_type() == Variant::VECTOR3)
            {
                // Node3D reconstructs Euler angles and scale from its basis.
                const Vector3 requested = p_requested;
                const Vector3 stored = p_stored;
                return requested.is_equal_approx(stored);
            }
            return p_requested == p_stored;
        }

        class ReactSignalCallable final : public CallableCustom
        {
            EnvironmentID environment_;
            ObjectID emitter_;
            uint64_t connection_;

        public:
            ReactSignalCallable(EnvironmentID p_environment, ObjectID p_emitter, uint64_t p_connection)
                : environment_(p_environment), emitter_(p_emitter), connection_(p_connection) {}
            static bool equal(const CallableCustom* p_a, const CallableCustom* p_b)
            {
                const auto* a = static_cast<const ReactSignalCallable*>(p_a);
                const auto* b = static_cast<const ReactSignalCallable*>(p_b);
                return a->environment_ == b->environment_ && a->connection_ == b->connection_;
            }
            static bool less(const CallableCustom* p_a, const CallableCustom* p_b)
            {
                return static_cast<const ReactSignalCallable*>(p_a)->connection_ < static_cast<const ReactSignalCallable*>(p_b)->connection_;
            }
            CompareEqualFunc get_compare_equal_func() const override { return equal; }
            CompareLessFunc get_compare_less_func() const override { return less; }
            uint32_t hash() const override { return (uint32_t) connection_ ^ (uint32_t) (connection_ >> 32); }
            ObjectID get_object() const override { return emitter_; }
            String get_as_text() const override { return "React signal bridge"; }
            bool is_valid() const override { return compat::ObjectDB::get_instance(emitter_) != nullptr; }
            void call(const Variant** p_args, int p_count, Variant& r_return, Callable::CallError& r_error) const override
            {
                r_return = Variant();
                if (!Thread::is_main_thread())
                {
                    // Background signals are outside the certified profile.
                    // Reject before touching the environment or callback map.
                    r_error.error = Callable::CallError::CALL_ERROR_INVALID_METHOD;
                    return;
                }
                const auto environment = Environment::_access(environment_);
                if (!environment || environment->is_disposing() || !environment->is_caller_thread())
                {
                    r_error.error = Callable::CallError::CALL_ERROR_INVALID_METHOD;
                    return;
                }
                if (ReactBridge* bridge = environment->get_react_bridge_if_exists()) bridge->invoke_signal(connection_, p_args, p_count);
                r_error.error = Callable::CallError::CALL_OK;
            }
        };
    }

    struct ReactBridge::Impl
    {
        struct Owned
        {
            ObjectID object;
            NativeObjectID parent;
            ObjectID owner;
            ObjectID script;
            StringName name;
            Vector<NativeObjectID> children;
            bool attachment = false;
            // Native ownership must outlive JS reachability. The SDK receives
            // only NativeKeys, so no public wrapper keeps this Node alive.
            std::shared_ptr<v8::Global<v8::Object>> wrapper;
        };

        struct Removed
        {
            NativeObjectID id;
            uint64_t token;
            bool expected;
            String retirement_batch;
        };

        struct Root
        {
            struct AssetScope
            {
                NativeObjectID root;
                std::shared_ptr<internal::ReactLocalResources> resources;
                Vector<String> assets;
            };
            uint64_t token = 0;
            bool active = true;
            bool quiescing = false;
            String id;
            String instance;
            String stage;
            String lease_path;
            NativeObjectID attachment;
            ObjectID attachment_object;
            HashMap<uint64_t, Owned> nodes;
            HashMap<String, Ref<Resource>> assets;
            HashMap<uint64_t, String> asset_ids;
            HashMap<String, String> asset_scopes;
            HashMap<String, AssetScope> scopes;
            HashMap<String, StringName> native_scripts;
            bool managed_generation = false;
            std::vector<Removed> pending_invalidations;
        };

        struct Connection
        {
            Root* root = nullptr;
            NativeObjectID node;
            StringName signal;
            Callable callable;
            v8::Global<v8::Function> callback;
        };

        Environment* environment;
        std::vector<std::unique_ptr<Root>> roots;
        HashMap<uint64_t, Connection*> connections;
        internal::DoubleBuffered<Removed> removals;
        std::atomic<bool> accepting{true};
        uint64_t next_root = 1;
        uint64_t next_connection = 1;
        uint64_t next_name = 1;
        uint64_t next_retirement = 1;
        int active_roots = 0;

        explicit Impl(Environment* p_environment) : environment(p_environment) {}

        Root* root(const v8::Local<v8::Value>& p_capability) const
        {
            if (!p_capability->IsExternal()) return nullptr;
            void* ptr = p_capability.As<v8::External>()->Value();
            for (const auto& entry : roots) if (entry.get() == ptr) return entry.get();
            return nullptr;
        }

        Node* resolve(Root& p_root, NativeObjectID p_id) const
        {
            const Owned* owned = p_root.nodes.getptr(*p_id);
            if (!owned) return nullptr;
            Object* object = compat::ObjectDB::get_instance(owned->object);
            if (!object || environment->try_get_object_id(object) != p_id
                || environment->react_owner_for_pointer(object) != p_root.token) return nullptr;
            return Object::cast_to<Node>(object);
        }

        NativeObjectID own(Root& p_root, Node* p_node, bool p_attachment)
        {
            v8::Local<v8::Object> js_object;
            const auto context = environment->get_isolate()->GetCurrentContext();
            if (!TypeConvert::gd_obj_to_js(environment->get_isolate(), context, p_node, js_object)) return {};
            const NativeObjectID key = environment->try_get_object_id(p_node);
            if (!key) return {};
            const ObjectID object_id = p_node->get_instance_id();
            bool inserted = false;
            if (!global_claim(object_id, environment->id(), p_root.token, inserted)) return {};
            if (!environment->claim_react_owner(key, p_root.token, !p_attachment, object_id))
            {
                if (inserted) global_release(object_id, environment->id(), p_root.token);
                return {};
            }
            Owned owned;
            owned.object = p_node->get_instance_id();
            owned.name = p_node->get_name();
            owned.owner = p_node->get_owner() ? p_node->get_owner()->get_instance_id() : ObjectID();
            Object* script = p_node->get_script();
            owned.script = script ? script->get_instance_id() : ObjectID();
            owned.attachment = p_attachment;
            owned.wrapper = std::make_shared<v8::Global<v8::Object>>(environment->get_isolate(), js_object);
            p_root.nodes.insert(*key, owned);
            return key;
        }

        bool mutation_stage(const Root& p_root) const
        {
            return p_root.stage == "initial" || p_root.stage == "safe" || p_root.stage == "cleanup";
        }

        String validate_node(Root& p_root, NativeObjectID p_id, Node*& r_node) const
        {
            r_node = resolve(p_root, p_id);
            return r_node ? String() : String("E_NATIVE_LOST: invalid, foreign or retired native lifetime");
        }

        bool safe_from_js(Root& p_root, const v8::Local<v8::Context>& p_context,
                          const v8::Local<v8::Value>& p_value, Variant& r_value, Variant::Type p_hint = Variant::NIL, int p_depth = 0)
        {
            if (p_depth > 64) return false;
            if (p_value->IsNull()) { r_value = Variant(); return p_hint == Variant::NIL || p_hint == Variant::OBJECT; }
            if (p_value->IsBoolean()) { r_value = p_value.As<v8::Boolean>()->Value(); return p_hint == Variant::NIL || p_hint == Variant::BOOL; }
            if (p_value->IsNumber())
            {
                const double n = p_value.As<v8::Number>()->Value();
                if (!std::isfinite(n)) return false;
                if (p_hint == Variant::INT)
                {
                    if (std::floor(n) != n || std::abs(n) > 9007199254740991.0) return false;
                    r_value = (int64_t) n;
                }
                else r_value = n;
                return p_hint == Variant::NIL || p_hint == Variant::INT || p_hint == Variant::FLOAT;
            }
            if (p_value->IsString())
            {
                const String s = impl::Helper::to_string(p_context->GetIsolate(), p_value);
                if (p_hint == Variant::STRING_NAME) r_value = StringName(s);
                else if (p_hint == Variant::NODE_PATH) r_value = NodePath(s);
                else r_value = s;
                return p_hint == Variant::NIL || p_hint == Variant::STRING || p_hint == Variant::STRING_NAME || p_hint == Variant::NODE_PATH;
            }
            if (p_value->IsArray())
            {
                if (p_hint != Variant::NIL && p_hint != Variant::ARRAY) return false;
                const auto input = p_value.As<v8::Array>();
                Array result;
                for (uint32_t i = 0; i < input->Length(); ++i)
                {
                    v8::Local<v8::Value> item;
                    Variant converted;
                    if (!input->Get(p_context, i).ToLocal(&item) || !safe_from_js(p_root, p_context, item, converted, Variant::NIL, p_depth + 1)) return false;
                    result.push_back(converted);
                }
                r_value = result;
                return true;
            }
            if (!p_value->IsObject()) return false;
            const auto object = p_value.As<v8::Object>();
            const auto kind_value = field(p_context, object, "kind");
            const String kind = kind_value->IsString() ? impl::Helper::to_string(p_context->GetIsolate(), kind_value) : String();
            auto number = [&](const char* name, double& value) {
                const auto field_value = field(p_context, object, name);
                if (!field_value->IsNumber()) return false;
                value = field_value.As<v8::Number>()->Value();
                return std::isfinite(value);
            };
            if (kind == "Vector2" || p_hint == Variant::VECTOR2)
            {
                if (p_hint != Variant::NIL && p_hint != Variant::VECTOR2) return false;
                double x, y;
                if (!number("x", x) || !number("y", y)) return false;
                if (!std::isfinite((real_t) x) || !std::isfinite((real_t) y)) return false;
                r_value = Vector2(x, y); return true;
            }
            if (kind == "Vector3" || p_hint == Variant::VECTOR3)
            {
                if (p_hint != Variant::NIL && p_hint != Variant::VECTOR3) return false;
                double x, y, z;
                if (!number("x", x) || !number("y", y) || !number("z", z)) return false;
                if (!std::isfinite((real_t) x) || !std::isfinite((real_t) y) || !std::isfinite((real_t) z)) return false;
                r_value = Vector3(x, y, z); return true;
            }
            if (kind == "Color" || p_hint == Variant::COLOR)
            {
                if (p_hint != Variant::NIL && p_hint != Variant::COLOR) return false;
                double r, g, b, a;
                if (!number("r", r) || !number("g", g) || !number("b", b) || !number("a", a)) return false;
                if (!std::isfinite((float) r) || !std::isfinite((float) g) || !std::isfinite((float) b) || !std::isfinite((float) a)) return false;
                r_value = Color(r, g, b, a); return true;
            }
            if (kind == "asset" || kind == "AssetRef")
            {
                const auto id = field(p_context, object, "id");
                if (!id->IsString()) return false;
                const Ref<Resource>* resource = p_root.assets.getptr(impl::Helper::to_string(p_context->GetIsolate(), id));
                if (!resource) return false;
                r_value = *resource; return p_hint == Variant::NIL || p_hint == Variant::OBJECT;
            }
            if (kind == "NodeId")
            {
                NativeObjectID key;
                if (!read_key(p_context, field(p_context, object, "key"), key)) return false;
                Node* node = resolve(p_root, key);
                if (!node) return false;
                r_value = node; return p_hint == Variant::NIL || p_hint == Variant::OBJECT;
            }
            return false; // No arbitrary Dictionary, Object or raw wrapper fallback.
        }

        bool safe_to_js(Root& p_root, const v8::Local<v8::Context>& p_context,
                        const Variant& p_value, v8::Local<v8::Value>& r_value, int p_depth = 0)
        {
            if (p_depth > 64) return false;
            auto* isolate = p_context->GetIsolate();
            switch (p_value.get_type())
            {
            case Variant::NIL: r_value = v8::Null(isolate); return true;
            case Variant::BOOL: r_value = v8::Boolean::New(isolate, (bool) p_value); return true;
            case Variant::INT:
                if (std::abs((double) (int64_t) p_value) > 9007199254740991.0) return false;
                r_value = v8::Number::New(isolate, (double) (int64_t) p_value); return true;
            case Variant::FLOAT:
                if (!std::isfinite((double) p_value)) return false;
                r_value = v8::Number::New(isolate, (double) p_value); return true;
            case Variant::STRING: case Variant::STRING_NAME: case Variant::NODE_PATH:
                r_value = impl::Helper::new_string(isolate, (String) p_value); return true;
            case Variant::VECTOR2:
                {
                    const Vector2 value = p_value;
                    if (!std::isfinite(value.x) || !std::isfinite(value.y)) return false;
                    auto result = v8::Object::New(isolate);
                    put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "Vector2"));
                    put(p_context, result, "x", v8::Number::New(isolate, value.x));
                    put(p_context, result, "y", v8::Number::New(isolate, value.y));
                    r_value = result; return true;
                }
            case Variant::VECTOR3:
                {
                    const Vector3 value = p_value;
                    if (!std::isfinite(value.x) || !std::isfinite(value.y) || !std::isfinite(value.z)) return false;
                    auto result = v8::Object::New(isolate);
                    put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "Vector3"));
                    put(p_context, result, "x", v8::Number::New(isolate, value.x));
                    put(p_context, result, "y", v8::Number::New(isolate, value.y));
                    put(p_context, result, "z", v8::Number::New(isolate, value.z));
                    r_value = result; return true;
                }
            case Variant::COLOR:
                {
                    const Color value = p_value;
                    if (!std::isfinite(value.r) || !std::isfinite(value.g) || !std::isfinite(value.b) || !std::isfinite(value.a)) return false;
                    auto result = v8::Object::New(isolate);
                    put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "Color"));
                    put(p_context, result, "r", v8::Number::New(isolate, value.r));
                    put(p_context, result, "g", v8::Number::New(isolate, value.g));
                    put(p_context, result, "b", v8::Number::New(isolate, value.b));
                    put(p_context, result, "a", v8::Number::New(isolate, value.a));
                    r_value = result; return true;
                }
            case Variant::ARRAY:
                {
                    const Array array = p_value;
                    auto result = v8::Array::New(isolate, array.size());
                    for (int i = 0; i < array.size(); ++i)
                    {
                        v8::Local<v8::Value> item;
                        if (!safe_to_js(p_root, p_context, array[i], item, p_depth + 1)) return false;
                        result->Set(p_context, i, item).Check();
                    }
                    r_value = result; return true;
                }
            case Variant::OBJECT:
                {
                    Object* object = p_value;
                    if (!object) { r_value = v8::Null(isolate); return true; }
                    auto result = v8::Object::New(isolate);
                    if (Node* node = Object::cast_to<Node>(object))
                    {
                        const auto key = environment->try_get_object_id(node);
                        if (key && p_root.nodes.has(*key))
                        {
                            put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "NodeId"));
                            put(p_context, result, "key", write_key(p_context, key));
                        }
                        else
                        {
                            put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "UnmanagedNode"));
                            put(p_context, result, "id", impl::Helper::new_string(isolate, uitos((uint64_t) node->get_instance_id())));
                        }
                        put(p_context, result, "type", impl::Helper::new_string(isolate, node->get_class()));
                        r_value = result; return true;
                    }
                    Resource* resource = Object::cast_to<Resource>(object);
                    if (!resource || !allowed_asset_type(resource->get_class()) || !resource->get_script().is_null()) return false;
                    const uint64_t object_id = (uint64_t) resource->get_instance_id();
                    String id;
                    if (const String* existing = p_root.asset_ids.getptr(object_id)) id = *existing;
                    else
                    {
                        id = resource->get_path().is_empty() ? String("@resource/") + uitos(object_id) : resource->get_path();
                        p_root.asset_ids.insert(object_id, id);
                        p_root.assets.insert(id, Ref<Resource>(resource));
                    }
                    put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, "asset"));
                    put(p_context, result, "id", impl::Helper::new_string(isolate, id));
                    put(p_context, result, "type", impl::Helper::new_string(isolate, resource->get_class()));
                    const String* scope = p_root.asset_scopes.getptr(id);
                    put(p_context, result, "scope", impl::Helper::new_string(isolate, scope ? *scope : String("shared")));
                    r_value = result; return true;
                }
            default: return false;
            }
        }

        void disconnect(uint64_t p_id)
        {
            Connection** found = connections.getptr(p_id);
            if (!found) return;
            Connection* connection = *found;
            if (Node* node = resolve(*connection->root, connection->node))
                if (node->is_connected(connection->signal, connection->callable)) node->disconnect(connection->signal, connection->callable);
            connections.erase(p_id);
            connection->callback.Reset();
            memdelete(connection);
        }

        String audit(Root& p_root) const
        {
            for (const KeyValue<uint64_t, Owned>& pair : p_root.nodes)
            {
                const NativeObjectID key(pair.key);
                Node* node = resolve(p_root, key);
                if (!node) return "E_NATIVE_LOST: owned object disappeared";
                if (node->get_name() != pair.value.name) return "E_FOREIGN_MUTATION: native name changed";
                if (!pair.value.attachment && String(node->get_meta("__godot_react_identity", Variant())) != uitos((uint64_t) node->get_instance_id()))
                    return "E_FOREIGN_MUTATION: native handler identity metadata changed";
                Object* script = node->get_script();
                if ((script ? script->get_instance_id() : ObjectID()) != pair.value.script) return "E_FOREIGN_MUTATION: native Script changed";
                if ((node->get_owner() ? node->get_owner()->get_instance_id() : ObjectID()) != pair.value.owner)
                    return "E_FOREIGN_MUTATION: native scene owner changed";
                if (node->get_child_count(false) != pair.value.children.size()) return "E_FOREIGN_MUTATION: public child count changed";
                for (int i = 0; i < pair.value.children.size(); ++i)
                    if (environment->try_get_object_id(node->get_child(i, false)) != pair.value.children[i]) return "E_FOREIGN_MUTATION: public child identity/order changed";
                if (!pair.value.attachment)
                {
                    Node* parent = node->get_parent();
                    const NativeObjectID actual = parent ? environment->try_get_object_id(parent) : NativeObjectID();
                    if (actual != pair.value.parent) return "E_FOREIGN_MUTATION: native parent changed";
                }
            }
            return audit_scene_tree();
        }

        String audit_scene_tree(Node* p_pending_attachment = nullptr, bool p_pending_managed = false) const
        {
            bool managed = p_pending_managed;
            for (const auto& root : roots) if (root->active && root->managed_generation) managed = true;
            if (!managed) return {};
            if (!ProjectSettings::get_singleton()->get_autoload_list().is_empty())
                return "E_REACT_AUTOLOAD: managed React projects cannot create autoload Node trees";
            SceneTree* tree = SceneTree::get_singleton();
            Window* infrastructure = tree ? tree->get_root() : nullptr;
            if (!infrastructure) return "E_REACT_SCENE_TREE: managed application requires the game SceneTree";
            Vector<Node*> pending;
            pending.push_back(infrastructure);
            while (!pending.is_empty())
            {
                Node* node = pending[pending.size() - 1];
                pending.resize(pending.size() - 1);
                bool known = node == infrastructure || node == p_pending_attachment;
                if (!known)
                {
                    const NativeObjectID key = environment->try_get_object_id(node);
                    for (const auto& root : roots)
                        if (root->active && key && root->nodes.has(*key) && resolve(*root, key) == node) { known = true; break; }
                    if (!known)
                    {
                        for (const auto& root : roots)
                        {
                            if (root->active || root->attachment_object != node->get_instance_id()) continue;
                            if (node->get_child_count(false) != 0)
                                return "E_FOREIGN_MUTATION: a closed application attachment gained public children";
                            // The launcher may remain briefly in SceneTree after
                            // releasing its empty app scope. Match its original
                            // native ObjectID lifetime, never a name/metadata.
                            known = true; break;
                        }
                    }
                }
                if (!known) return "E_FOREIGN_MUTATION: unregistered public Node in the game SceneTree: " + String(node->get_path());
                for (int i = 0; i < node->get_child_count(false); ++i) pending.push_back(node->get_child(i, false));
            }
            return {};
        }

        void apply_removal_owner_effect(Root& p_root, Node* p_node)
        {
            const auto key = environment->try_get_object_id(p_node);
            if (Owned* owned = p_root.nodes.getptr(*key))
            {
                // remove_child clears owners that cease to be ancestors. Do
                // not adopt arbitrary actual owners introduced by reentry.
                Node* expected_owner = Object::cast_to<Node>(compat::ObjectDB::get_instance(owned->owner));
                if (owned->owner.is_valid() && (!expected_owner || !expected_owner->is_ancestor_of(p_node))) owned->owner = ObjectID();
            }
            for (int i = 0; i < p_node->get_child_count(false); ++i) apply_removal_owner_effect(p_root, p_node->get_child(i, false));
        }

        void collect(Root& p_root, Node* p_node, Vector<NativeObjectID>& r_keys) const
        {
            const auto key = environment->try_get_object_id(p_node);
            if (p_root.nodes.has(*key)) r_keys.push_back(key);
            for (int i = 0; i < p_node->get_child_count(false); ++i) collect(p_root, p_node->get_child(i, false), r_keys);
        }

        void free_node(Root& p_root, Node* p_node, const String& p_batch = String())
        {
            Vector<NativeObjectID> keys;
            collect(p_root, p_node, keys);
            Vector<uint64_t> disconnects;
            for (const KeyValue<uint64_t, Connection*>& pair : connections)
                if (pair.value->root == &p_root && keys.has(pair.value->node)) disconnects.push_back(pair.key);
            for (uint64_t id : disconnects) disconnect(id);
            const String batch = p_batch.is_empty() ? String("@native/") + uitos(p_root.token) + "/" + uitos(next_retirement++) : p_batch;
            for (NativeObjectID key : keys) environment->mark_react_expected_release(key, batch);
            memdelete(p_node);
            for (NativeObjectID key : keys) p_root.nodes.erase(*key);
        }

        String strip_foreign_children(Root& p_root)
        {
            Vector<NativeObjectID> keys;
            for (const KeyValue<uint64_t, Owned>& pair : p_root.nodes) keys.push_back(NativeObjectID(pair.key));
            int budget = 10000;
            for (NativeObjectID key : keys)
            {
                int index = 0;
                while (Node* parent = resolve(p_root, key))
                {
                    if (index >= parent->get_child_count(false)) break;
                    Node* child = parent->get_child(index, false);
                    const auto child_key = environment->try_get_object_id(child);
                    if (child_key && p_root.nodes.has(*child_key)) { ++index; continue; }
                    if (--budget < 0) return "E_NATIVE_CLEANUP: foreign child detachment did not settle";
                    // A fault never transfers ownership of foreign public Nodes.
                    // Detach them before destroying a managed parent, preserving
                    // their lifetime. Resolve the parent again after callbacks.
                    parent->remove_child(child);
                }
            }
            return {};
        }

        String close(Root& p_root, bool p_force)
        {
            Vector<uint64_t> disconnects;
            for (const KeyValue<uint64_t, Connection*>& pair : connections)
                if (pair.value->root == &p_root) disconnects.push_back(pair.key);
            for (uint64_t id : disconnects) disconnect(id);
            if (p_force)
            {
                const String error = strip_foreign_children(p_root);
                if (!error.is_empty()) return error;
                while (true)
                {
                    Node* candidate = nullptr;
                    NativeObjectID candidate_key;
                    for (const KeyValue<uint64_t, Owned>& pair : p_root.nodes)
                    {
                        if (pair.value.attachment) continue;
                        Node* node = resolve(p_root, NativeObjectID(pair.key));
                        if (node && (!node->get_parent() || !p_root.nodes.has(*environment->try_get_object_id(node->get_parent()))
                            || environment->try_get_object_id(node->get_parent()) == p_root.attachment)) { candidate = node; candidate_key = NativeObjectID(pair.key); break; }
                    }
                    if (!candidate) break;
                    if (Node* parent = candidate->get_parent()) parent->remove_child(candidate);
                    // remove_child can invoke native/user callbacks that free
                    // the candidate. Never keep its raw pointer across them.
                    candidate = resolve(p_root, candidate_key);
                    if (!candidate) continue;
                    const String strip_error = strip_foreign_children(p_root);
                    if (!strip_error.is_empty()) return strip_error;
                    candidate = resolve(p_root, candidate_key);
                    if (candidate) free_node(p_root, candidate);
                }
            }
            for (const KeyValue<uint64_t, Owned>& pair : p_root.nodes)
            {
                global_release(pair.value.object, environment->id(), p_root.token);
                environment->claim_react_owner(NativeObjectID(pair.key), 0, false);
            }
            p_root.nodes.clear();
            for (const KeyValue<String, Root::AssetScope>& scope : p_root.scopes) scope.value.resources->clear();
            p_root.scopes.clear();
            p_root.assets.clear();
            p_root.asset_ids.clear();
            p_root.asset_scopes.clear();
            p_root.pending_invalidations.clear();
            p_root.active = false;
            p_root.stage = String();
            if (!p_root.lease_path.is_empty()) internal::ReactRunLease::release(p_root.lease_path);
            --active_roots;
            return {};
        }
    };

    ReactBridge::ReactBridge(Environment* p_environment) : impl_(std::make_unique<Impl>(p_environment)) {}
    ReactBridge::~ReactBridge() { dispose(); }

    bool ReactBridge::has_active_roots() const { return impl_->active_roots != 0; }

    void ReactBridge::notify_removed(NativeObjectID p_id, uint64_t p_owner, ObjectID p_object_id, bool p_expected, const String& p_retirement_batch)
    {
        global_release(p_object_id, impl_->environment->id(), p_owner);
        if (p_owner && impl_->accepting.load(std::memory_order_acquire)) impl_->removals.add(Impl::Removed{p_id, p_owner, p_expected, p_retirement_batch});
    }

    void ReactBridge::dispose()
    {
        if (!impl_->accepting.exchange(false, std::memory_order_acq_rel)) return;
        for (const auto& root : impl_->roots) if (root->active) (void) impl_->close(*root, false);
        auto& pending = impl_->removals.swap(); pending.clear();
        auto& pending_other = impl_->removals.swap(); pending_other.clear();
    }

    bool ReactBridge::allows_free(Object* p_object) const
    {
        return allows_bound_free(p_object);
    }

    bool ReactBridge::allows_method(Object* p_receiver, const StringName& p_method, const Variant** p_args, int p_argc) const
    {
        return allows_bound_method(p_receiver, p_method, p_args, p_argc);
    }

    bool ReactBridge::is_owned(Object* p_object)
    {
        return p_object && global_owner(p_object->get_instance_id()).root != 0;
    }

    bool ReactBridge::protects_structure(Object* p_object)
    {
        if (!p_object || !global_owner_count.load(std::memory_order_acquire)) return false;
        if (is_owned(p_object)) return true;
        Node* root = Object::cast_to<Node>(p_object);
        if (!root) return false;
        // Background Node mutation/transfer is outside this profile. Do not
        // inspect a live SceneTree from an arbitrary foreign Environment thread.
        if (!Thread::is_main_thread()) return true;
        Vector<Node*> pending;
        pending.push_back(root);
        while (!pending.is_empty())
        {
            Node* node = pending[pending.size() - 1];
            pending.resize(pending.size() - 1);
            if (is_owned(node)) return true;
            for (int i = 0; i < node->get_child_count(false); ++i) pending.push_back(node->get_child(i, false));
        }
        return false;
    }

    bool ReactBridge::allows_bound_free(Object* p_object) { return !protects_structure(p_object); }

    bool ReactBridge::allows_bound_method(Object* p_receiver, const StringName& p_method, const Variant** p_args, int p_argc, int p_depth)
    {
        if (!global_owner_count.load(std::memory_order_acquire)) return true;
        if (p_depth < 0 || p_depth > 16) return false;
        if (is_navigation(p_method) || is_indirect_write(p_method)) return false;
        const String method = p_method;
        const bool reflection_dispatch = method == "call" || method == "callv" || method == "call_deferred"
            || method == "set" || method == "set_deferred" || method == "set_indexed";
        if ((is_structural(p_method) || reflection_dispatch) && protects_structure(p_receiver)) return false;
        // Only audited private operations may write owned objects. Engine
        // signals remain usable as queued event inputs; arbitrary reflected
        // mutators (physics, RPC, focus, Tween, Script, etc.) do not pass through.
        if (is_owned(p_receiver)
            && !is_reader(p_method) && p_method != StringName("emit_signal")) return false;
        if (!is_reader(p_method) || is_structural(p_method) || is_reflection_write(p_method))
        {
            for (int i = 0; i < p_argc; ++i)
                if (carries_owned_object(nullptr, *p_args[i], p_depth + 1)) return false;
        }
        return true;
    }

    bool ReactBridge::allows_callable(const Callable& p_callable, const Variant** p_args, int p_argc, int p_depth)
    {
        if (!global_owner_count.load(std::memory_order_acquire)) return true;
        if (p_depth < 0 || p_depth > 16) return false;
        Object* target = p_callable.get_object();
        // CallableCustom::get_method emits an engine error by default. Bind and
        // unbind expose their underlying comparator, allowing named Object
        // callbacks to retain precise checks without querying opaque JS/native
        // function callbacks for a method they do not have.
        const Callable* base = p_callable.get_base_comparator();
        const StringName method = base && !base->is_custom() ? base->get_method() : StringName();
        const Array bound = p_callable.get_bound_arguments();
        std::vector<const Variant*> arguments;
        arguments.reserve(p_argc + bound.size());
        for (int i = 0; i < p_argc; ++i) arguments.push_back(p_args[i]);
        for (int i = 0; i < bound.size(); ++i) arguments.push_back(&bound[i]);
        if (method == StringName())
        {
            // Opaque native callbacks cannot acquire an unverified write right
            // to an owned target or a bound owned argument. Unbound JS handlers
            // still execute through the ordinary guarded JSB methods.
            if (protects_structure(target)) return false;
            for (const Variant* argument : arguments)
                if (carries_owned_object(nullptr, *argument, p_depth + 1)) return false;
            return true;
        }
        return allows_bound_method(target, method, arguments.data(), (int) arguments.size(), p_depth + 1);
    }

    void ReactBridge::invoke_signal(uint64_t p_connection, const Variant** p_args, int p_argc) const
    {
        if (!Thread::is_main_thread() || !impl_->environment->is_caller_thread()) return;
        Impl::Connection* const* found = impl_->connections.getptr(p_connection);
        if (!found || !(*found)->root->active || (*found)->root->quiescing || impl_->environment->is_disposing()) return;
        auto* isolate = impl_->environment->get_isolate();
        v8::Isolate::Scope isolate_scope(isolate);
        v8::HandleScope handle_scope(isolate);
        const auto context = impl_->environment->get_context();
        if (context.IsEmpty()) return;
        v8::Context::Scope context_scope(context);
        std::vector<v8::Local<v8::Value>> args;
        args.resize(p_argc);
        for (int i = 0; i < p_argc; ++i)
        {
            if (!impl_->safe_to_js(*(*found)->root, context, *p_args[i], args[i]))
            {
                JSB_LOG(Error, "E_SIGNAL_CODEC: unsupported React signal argument");
                return;
            }
        }
        const v8::Local<v8::Function> callback = (*found)->callback.Get(isolate);
        const impl::TryCatch catcher(isolate);
        v8::Local<v8::Value> ignored;
        if (!callback->Call(context, v8::Undefined(isolate), p_argc, args.data()).ToLocal(&ignored))
            JSB_LOG(Error, "E_SIGNAL_CALLBACK: React signal queue callback failed");
        impl_->environment->notify_microtasks_run();
    }

    void ReactBridge::install(const v8::Local<v8::Context>& p_context, const v8::Local<v8::Object>& p_internal)
    {
        auto* isolate = p_context->GetIsolate();
        auto object = v8::Object::New(isolate);
        put(p_context, object, "abi", impl::Helper::new_string_ascii(isolate, "godot-react-native/1"));
        put(p_context, object, "abiVersion", v8::Int32::New(isolate, 1));
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
        put(p_context, descriptor, "engine", impl::Helper::new_string_ascii(isolate, engine));
#if defined(GODOT_VERSION_MAJOR)
        const String version_hash = GODOT_VERSION_HASH;
        const String version_build = GODOT_VERSION_FULL_BUILD;
#else
        const String version_hash = VERSION_HASH;
        const String version_build = VERSION_FULL_BUILD;
#endif
        const String version = version_build + (version_hash.is_empty() ? String() : String(".") + version_hash.left(9));
        put(p_context, descriptor, "godotVersion", impl::Helper::new_string(isolate, version));
        put(p_context, descriptor, "nativeBridgeAbi", impl::Helper::new_string_ascii(isolate, "godot-react-native/1"));
        put(p_context, object, "descriptor", descriptor);
        static const struct { const char* name; int operation; } methods[] = {
            {"openRoot", OPEN_ROOT}, {"closeRoot", CLOSE_ROOT}, {"beginStage", BEGIN_STAGE}, {"endStage", END_STAGE},
            {"create", CREATE}, {"read", READ}, {"set", SET}, {"append", APPEND}, {"remove", REMOVE}, {"free", FREE},
            {"children", CHILDREN}, {"info", INFO}, {"isAlive", IS_ALIVE}, {"connect", CONNECT}, {"disconnect", DISCONNECT},
            {"takeInvalidations", INVALIDATIONS}, {"audit", AUDIT}, {"loadAsset", LOAD_ASSET}, {"releaseAsset", RELEASE_ASSET},
            {"call", CALL}, {"setOwner", SET_OWNER}, {"shutdownRequested", SHUTDOWN_REQUESTED}, {"nativeIdentity", NATIVE_IDENTITY},
            {"nativeRpc", NATIVE_RPC},
            {"localizeAsset", LOCALIZE_ASSET}, {"finishAssetScope", FINISH_ASSET_SCOPE}, {"releaseAssetScope", RELEASE_ASSET_SCOPE},
            {"quiesceRoot", QUIESCE_ROOT},
            {"formatStack", FORMAT_STACK},
        };
        for (const auto& method : methods)
            put(p_context, object, method.name, JSB_NEW_FUNCTION(p_context, dispatch, v8::Int32::New(isolate, method.operation)));
        put(p_context, p_internal, "react", object);
    }

    void ReactBridge::dispatch(const v8::FunctionCallbackInfo<v8::Value>& info)
    {
        auto* isolate = info.GetIsolate();
        const auto context = isolate->GetCurrentContext();
        Environment* environment = Environment::wrap(isolate);
        ReactBridge& bridge = environment->get_react_bridge();
        Impl& state = *bridge.impl_;
        const int op = info.Data().As<v8::Int32>()->Value();
        auto fail = [&](const String& error) { impl::Helper::throw_error(isolate, error); };
        if (!environment->is_caller_thread() || !Thread::is_main_thread() || environment->is_disposing())
        { fail("E_NATIVE_THREAD: React bridge requires the live main-thread environment"); return; }
        if (op == FORMAT_STACK)
        {
            if (info.Length() != 1 || !info[0]->IsString()) { fail("E_SOURCE_MAP: stack string required"); return; }
            const String stack = impl::Helper::to_string(isolate, info[0]);
            info.GetReturnValue().Set(impl::Helper::new_string(isolate, environment->get_source_map_cache().process_source_position(stack, nullptr)));
            return;
        }

        if (op == OPEN_ROOT)
        {
            Object* object = nullptr;
            if (info.Length() < 3 || !TypeConvert::js_to_gd_obj(isolate, context, info[0], object) || !object
                || !info[1]->IsString() || !info[2]->IsString()) { fail("E_ROOT_ARGUMENT: bootstrap node/root id/instance required"); return; }
            Node* node = Object::cast_to<Node>(object);
            if (!node || node->get_child_count(false) != 0 || environment->react_owner_for_pointer(node))
            { fail("E_ROOT_OWNERSHIP: attachment must be empty and unowned"); return; }
            auto root = std::make_unique<Impl::Root>();
            root->attachment_object = node->get_instance_id();
            root->token = state.next_root++;
            root->id = impl::Helper::to_string(isolate, info[1]);
            root->instance = impl::Helper::to_string(isolate, info[2]);
            String reason;
            const Error lease = internal::ReactRunLease::acquire(root->id, root->instance, root->lease_path, reason);
            if (lease != OK) { fail("E_RUN_ACTIVE: " + reason); return; }
            const String generation = info.Length() > 3 && info[3]->IsString() ? impl::Helper::to_string(isolate, info[3]) : String();
            const bool react_enabled = internal::ReactManifest::is_enabled();
            if (react_enabled || !generation.is_empty())
            {
                Dictionary manifest;
                String manifest_path;
                if (generation.is_empty() || internal::ReactManifest::load_active(manifest, manifest_path, reason, false) != OK
                    || String(manifest.get("generation", Variant())) != generation)
                {
                    internal::ReactRunLease::release(root->lease_path);
                    const String details = reason.is_empty() ? String("expected=") + generation + ", active=" + String(manifest.get("generation", "")) : reason;
                    fail("E_BUILD_GENERATION: startup ticket does not match the leased active generation: " + details); return;
                }
                root->managed_generation = true;
                const Dictionary profiles = manifest.get("nativeScriptProfiles", Dictionary());
                for (const KeyValue<Variant, Variant>& pair : profiles)
                {
                    if (pair.value.get_type() != Variant::DICTIONARY) continue;
                    const Dictionary profile = pair.value;
                    root->native_scripts.insert(String(profile.get("script", "")), StringName(String(profile.get("type", ""))));
                }
            }
            const String scene_error = state.audit_scene_tree(node, root->managed_generation);
            if (!scene_error.is_empty())
            {
                internal::ReactRunLease::release(root->lease_path);
                fail(scene_error); return;
            }
            root->attachment = state.own(*root, node, true);
            if (!root->attachment) { internal::ReactRunLease::release(root->lease_path); fail("E_ROOT_BINDING: cannot claim attachment"); return; }
            auto result = v8::Object::New(isolate);
            put(context, result, "cap", v8::External::New(isolate, root.get()));
            put(context, result, "key", write_key(context, root->attachment));
            state.roots.push_back(std::move(root)); ++state.active_roots;
            info.GetReturnValue().Set(result);
            return;
        }

        Impl::Root* root = info.Length() ? state.root(info[0]) : nullptr;
        if (!root) { fail("E_ROOT_CAPABILITY: invalid private root capability"); return; }
        if (op == IS_ALIVE && !root->active) { info.GetReturnValue().Set(v8::Boolean::New(isolate, false)); return; }
        if (op == END_STAGE && !root->active) { environment->notify_microtasks_run(); return; }
        if (op == CLOSE_ROOT && !root->active) return;
        if (!root->active) { fail("E_ROOT_DISPOSED: root has already closed"); return; }
        const auto verify = [&]() {
            const String error = state.audit(*root);
            if (!error.is_empty()) { fail(error); return false; }
            return true;
        };

        if (op == BEGIN_STAGE)
        {
            if (info.Length() != 2 || !info[1]->IsString() || !root->stage.is_empty()) { fail("E_PHASE_REENTRY: invalid or nested native stage"); return; }
            const String stage = impl::Helper::to_string(isolate, info[1]);
            if (stage != "initial" && stage != "safe" && stage != "cleanup" && stage != "process" && stage != "physics" && stage != "input")
            { fail("E_PHASE: unsupported native stage"); return; }
            if (root->quiescing && stage != "cleanup") { fail("E_ROOT_QUIESCING: only cleanup work may enter the retired root scope"); return; }
            root->stage = stage; return;
        }
        if (op == QUIESCE_ROOT) { root->quiescing = true; return; }
        if (op == END_STAGE)
        {
            root->stage = String();
            // Promise resolutions made by the renderer (assets/Suspense) need
            // a V8 checkpoint at the next normal Environment update. Never
            // drain user microtasks while a native commit is still active.
            environment->notify_microtasks_run();
            return;
        }
        if (op == SHUTDOWN_REQUESTED) { info.GetReturnValue().Set(v8::Boolean::New(isolate, internal::ReactRunLease::shutdown_requested(root->lease_path))); return; }
        if (op == CLOSE_ROOT)
        {
            const bool force = info.Length() > 1 && info[1]->IsBoolean() && info[1].As<v8::Boolean>()->Value();
            // A normal close only releases the empty scope after the renderer's
            // cleanup barrier. Forced destruction still needs mutation rights.
            if ((force && !state.mutation_stage(*root)) || (!root->stage.is_empty() && !state.mutation_stage(*root)))
            { fail("E_PHASE: root close requires idle or a cleanup stage"); return; }
            if (root->stage.is_empty() && !root->quiescing)
            { fail("E_ROOT_QUIESCING: idle close requires the renderer shutdown barrier"); return; }
            if (!force)
            {
                for (const KeyValue<uint64_t, Impl::Owned>& pair : root->nodes)
                    if (!pair.value.attachment && state.resolve(*root, NativeObjectID(pair.key))) { fail("E_ROOT_NOT_EMPTY: retire all business nodes before close"); return; }
            }
            const String error = state.close(*root, force);
            if (!error.is_empty()) fail(error);
            return;
        }
        if (op == INVALIDATIONS)
        {
            auto& removed = state.removals.swap();
            for (const auto& item : removed)
                for (const auto& candidate : state.roots)
                    if (candidate->token == item.token && candidate->active) candidate->pending_invalidations.push_back(item);
            removed.clear();
            auto result = v8::Array::New(isolate, (int) root->pending_invalidations.size());
            for (uint32_t i = 0; i < root->pending_invalidations.size(); ++i)
            {
                const auto& item = root->pending_invalidations[i];
                auto record = v8::Object::New(isolate);
                put(context, record, "key", write_key(context, item.id));
                put(context, record, "expected", v8::Boolean::New(isolate, item.expected));
                if (item.expected) put(context, record, "retirementBatch", impl::Helper::new_string(isolate, item.retirement_batch));
                put(context, record, "reason", impl::Helper::new_string_ascii(isolate, item.expected ? "released" : "native-lifetime-lost"));
                result->Set(context, i, record).Check();
            }
            root->pending_invalidations.clear(); info.GetReturnValue().Set(result); return;
        }
        if (op == AUDIT)
        {
            const String error = state.audit(*root);
            if (!error.is_empty()) { fail(error); return; }
            info.GetReturnValue().Set(v8::Boolean::New(isolate, true)); return;
        }
        if (op == DISCONNECT)
        {
            if (info.Length() != 2 || !info[1]->IsUint32()) { fail("E_CONNECTION: connection id required"); return; }
            const uint64_t id = info[1].As<v8::Uint32>()->Value();
            Impl::Connection** connection = state.connections.getptr(id);
            if (connection && (*connection)->root != root) { fail("E_CONNECTION: foreign connection"); return; }
            state.disconnect(id); return;
        }
        if (op == LOAD_ASSET)
        {
            if (info.Length() < 3 || !info[1]->IsString() || !info[2]->IsString()) { fail("E_ASSET: canonical path and allowed type required"); return; }
            const String path = impl::Helper::to_string(isolate, info[1]);
            const StringName type = impl::Helper::to_string(isolate, info[2]);
            if (!internal::ReactManifest::is_canonical_path(path) || !allowed_asset_type(type)
                || path.ends_with(".tscn") || path.ends_with(".scn") || path.ends_with(".gd") || path.ends_with(".ts") || path.ends_with(".js"))
            { fail("E_ASSET_PROFILE: unsupported asset path/type"); return; }
            const Ref<Resource> resource = ResourceLoader::load(path, type);
            if (resource.is_null() || !resource->is_class(type) || !resource->get_script().is_null()) { fail("E_ASSET_LOAD: missing, wrong type or scripted resource"); return; }
            root->assets.insert(path, resource);
            root->asset_ids.insert((uint64_t) resource->get_instance_id(), path);
            v8::Local<v8::Value> value;
            if (!state.safe_to_js(*root, context, resource, value)) { fail("E_ASSET_CODEC: cannot expose asset"); return; }
            info.GetReturnValue().Set(value); return;
        }
        if (op == RELEASE_ASSET)
        {
            if (info.Length() != 2 || !info[1]->IsString()) { fail("E_ASSET: asset id required"); return; }
            const String id = impl::Helper::to_string(isolate, info[1]);
            if (const Ref<Resource>* resource = root->assets.getptr(id)) root->asset_ids.erase((uint64_t) (*resource)->get_instance_id());
            root->assets.erase(id); return;
        }
        if (op == LOCALIZE_ASSET)
        {
            NativeObjectID scope_key;
            if (!state.mutation_stage(*root) || info.Length() != 4 || !info[1]->IsString() || !info[2]->IsString()
                || !read_key(context, info[3], scope_key))
            {
                fail("E_LOCAL_RESOURCE_ARGUMENT: source asset, scope token and native root required"); return;
            }
            const String source_id = impl::Helper::to_string(isolate, info[1]);
            const String token = impl::Helper::to_string(isolate, info[2]);
            const Ref<Resource>* source = root->assets.getptr(source_id);
            Node* scope_root = state.resolve(*root, scope_key);
            if (!source || token.is_empty() || !scope_root || scope_root->get_parent() || scope_root->is_inside_tree()
                || scope_key == root->attachment)
            { fail("E_LOCAL_RESOURCE_SCOPE: local assets require an owned detached template root"); return; }
            Impl::Root::AssetScope* scope = root->scopes.getptr(token);
            if (!scope)
            {
                Impl::Root::AssetScope created;
                created.root = scope_key;
                created.resources = std::make_shared<internal::ReactLocalResources>(scope_root);
                root->scopes.insert(token, created);
                scope = root->scopes.getptr(token);
            }
            if (scope->root != scope_key) { fail("E_LOCAL_RESOURCE_SCOPE: scope token belongs to another template instance"); return; }
            String reason;
            const Ref<Resource> result = scope->resources->remap(*source, reason);
            if (result.is_null()) { fail(reason); return; }
            const uint64_t object_id = (uint64_t) result->get_instance_id();
            const String id = "@scope/" + token + "/" + uitos(object_id);
            root->asset_ids.insert(object_id, id);
            root->assets.insert(id, result);
            root->asset_scopes.insert(id, token);
            if (!scope->assets.has(id)) scope->assets.push_back(id);
            v8::Local<v8::Value> encoded;
            if (!state.safe_to_js(*root, context, result, encoded)) { fail("E_LOCAL_RESOURCE_CODEC: local resource cannot cross the safe bridge"); return; }
            info.GetReturnValue().Set(encoded); return;
        }
        if (op == FINISH_ASSET_SCOPE || op == RELEASE_ASSET_SCOPE)
        {
            if (!state.mutation_stage(*root) || info.Length() != 2 || !info[1]->IsString())
            { fail("E_LOCAL_RESOURCE_SCOPE: scope operation requires a native commit"); return; }
            const String token = impl::Helper::to_string(isolate, info[1]);
            Impl::Root::AssetScope* scope = root->scopes.getptr(token);
            if (!scope) { if (op == RELEASE_ASSET_SCOPE) return; fail("E_LOCAL_RESOURCE_SCOPE: missing instance scope"); return; }
            if (op == FINISH_ASSET_SCOPE)
            {
                if (!state.resolve(*root, scope->root)) { fail("E_LOCAL_RESOURCE_SCOPE: template native root was retired"); return; }
                String reason;
                if (scope->resources->finish(reason) != OK) { fail(reason); return; }
                return;
            }
            for (const String& id : scope->assets)
            {
                if (const Ref<Resource>* resource = root->assets.getptr(id)) root->asset_ids.erase((uint64_t) (*resource)->get_instance_id());
                root->assets.erase(id); root->asset_scopes.erase(id);
            }
            scope->resources->clear(); root->scopes.erase(token); return;
        }
        if (op == CREATE)
        {
            if (!state.mutation_stage(*root)) { fail("E_PHASE: Node creation outside native commit"); return; }
            if (info.Length() < 2 || !info[1]->IsString()) { fail("E_HOST_TYPE: host type required"); return; }
            const StringName type = impl::Helper::to_string(isolate, info[1]);
            if (!allowed_class(type)) { fail("E_HOST_PROFILE: native class is not in the bridge allowlist"); return; }
            Node* node = nullptr;
            if (info.Length() > 2 && !info[2]->IsUndefined() && !info[2]->IsString())
            { fail("E_SCRIPT_PROFILE: generated leaf script path required"); return; }
            {
                node = Object::cast_to<Node>(ClassDB::instantiate(type));
                // Generated leaf NativeScripts are attached before publishing a
                // JS wrapper/NativeKey. Published hosts can never hot-swap one.
                if (node && info.Length() > 2 && info[2]->IsString())
                {
                    const String script_path = impl::Helper::to_string(isolate, info[2]);
                    const StringName* declared_type = root->native_scripts.getptr(script_path);
                    if (!internal::ReactManifest::is_canonical_path(script_path) || !script_path.contains("/native/")
                        || !script_path.ends_with(".ts") || (root->managed_generation && (!declared_type || *declared_type != type)))
                    { memdelete(node); fail("E_SCRIPT_PROFILE: expected a generated leaf NativeScript"); return; }
                    const Ref<Script> script = ResourceLoader::load(script_path, "Script");
                    if (script.is_null() || !script->can_instantiate() || script->get_instance_base_type() != type)
                    { memdelete(node); fail("E_SCRIPT_PROFILE: generated leaf NativeScript has the wrong native base"); return; }
                    node->set_script(script);
                    if (node->get_script() != Variant(script))
                    { memdelete(node); fail("E_SCRIPT_ATTACH: generated leaf NativeScript attachment failed"); return; }
                }
            }
            if (!node) { fail("E_HOST_CREATE: cannot instantiate native Node"); return; }
            if (node->get_class() != type || node->get_child_count(false) != 0 || node->get_parent())
            { memdelete(node); fail("E_HOST_CREATE: constructor has an unsupported native root or public children"); return; }
            node->set_meta("__godot_react_identity", uitos((uint64_t) node->get_instance_id()));
            node->set_name("React_" + uitos(root->token) + "_" + uitos(state.next_name++));
            const NativeObjectID key = state.own(*root, node, false);
            if (!key) { memdelete(node); fail("E_HOST_BINDING: cannot own native Node"); return; }
            if (!verify()) return;
            info.GetReturnValue().Set(write_key(context, key)); return;
        }

        NativeObjectID key;
        if (info.Length() < 2 || !read_key(context, info[1], key)) { fail("E_NATIVE_KEY: uint32 slot/revision required"); return; }
        Node* node = state.resolve(*root, key);
        if (op == IS_ALIVE) { info.GetReturnValue().Set(v8::Boolean::New(isolate, node != nullptr)); return; }
        if (!node) { fail("E_NATIVE_LOST: invalid, foreign or retired native lifetime"); return; }
        Impl::Owned* owned = root->nodes.getptr(*key);
        if (op == NATIVE_IDENTITY)
        {
            // Internal Script handler registry key only. Never cast an ObjectID
            // to a JS Number, and never expose a raw Node in return values.
            info.GetReturnValue().Set(impl::Helper::new_string(isolate, uitos((uint64_t) node->get_instance_id())));
            return;
        }
        if (op == NATIVE_RPC)
        {
            if (root->quiescing || root->stage.is_empty() || root->stage == "cleanup" || info.Length() < 4
                || !info[2]->IsString() || !info[3]->IsArray())
            { fail("E_RPC_PHASE: RPC requires a live synchronous command phase"); return; }
            const StringName method = impl::Helper::to_string(isolate, info[2]);
            const Ref<Script> script = node->get_script();
            const Variant rpc_config = script.is_valid() ? script->get_rpc_config() : Variant();
            const Dictionary declarations = rpc_config.get_type() == Variant::DICTIONARY ? Dictionary(rpc_config) : Dictionary();
            if (script.is_null() || script->get_instance_id() != owned->script || !declarations.has(method))
            { fail("E_RPC_PROFILE: RPC is not declared by the generated leaf Script"); return; }
            int peer = 0;
            if (info.Length() > 4 && !info[4]->IsUndefined())
            {
                if (!info[4]->IsInt32()) { fail("E_RPC_PEER: integer peer ID required"); return; }
                peer = info[4].As<v8::Int32>()->Value();
            }
            const auto input = info[3].As<v8::Array>();
            std::vector<Variant> values(input->Length());
            std::vector<const Variant*> args(input->Length());
            for (uint32_t i = 0; i < input->Length(); ++i)
            {
                v8::Local<v8::Value> value;
                if (!input->Get(context, i).ToLocal(&value) || !(value->IsNull() || value->IsBoolean() || value->IsNumber() || value->IsString())
                    || !state.safe_from_js(*root, context, value, values[i]))
                { fail("E_RPC_CODEC: certified RPC wire arguments must be finite scalar values"); return; }
                args[i] = &values[i];
            }
            const Error error = node->rpcp(peer, method, args.data(), (int) args.size());
            if (!verify()) return;
            info.GetReturnValue().Set(v8::Int32::New(isolate, (int) error));
            return;
        }
        if (op == INFO)
        {
            auto result = v8::Object::New(isolate);
            put(context, result, "type", impl::Helper::new_string(isolate, node->get_class()));
            put(context, result, "name", impl::Helper::new_string(isolate, node->get_name()));
            put(context, result, "alive", v8::Boolean::New(isolate, true));
            put(context, result, "ready", v8::Boolean::New(isolate, node->is_ready()));
            put(context, result, "insideTree", v8::Boolean::New(isolate, node->is_inside_tree()));
            put(context, result, "canProcess", v8::Boolean::New(isolate, node->is_inside_tree() && node->can_process()));
            put(context, result, "parent", owned->parent ? v8::Local<v8::Value>(write_key(context, owned->parent)) : v8::Local<v8::Value>(v8::Null(isolate)));
            info.GetReturnValue().Set(result); return;
        }
        if (op == CHILDREN)
        {
            auto result = v8::Array::New(isolate, node->get_child_count(false));
            for (int i = 0; i < node->get_child_count(false); ++i)
            {
                Node* child = node->get_child(i, false);
                const auto child_key = environment->try_get_object_id(child);
                if (!root->nodes.has(*child_key)) { fail("E_FOREIGN_MUTATION: unowned public child"); return; }
                result->Set(context, i, write_key(context, child_key)).Check();
            }
            info.GetReturnValue().Set(result); return;
        }
        if (op == CONNECT)
        {
            if (!state.mutation_stage(*root) || info.Length() != 4 || !info[2]->IsString() || !info[3]->IsFunction())
            { fail("E_SIGNAL: connect requires native commit, signal and callback"); return; }
            const StringName signal = impl::Helper::to_string(isolate, info[2]);
            if (!node->has_signal(signal)) { fail("E_SIGNAL: native signal not found"); return; }
            const uint64_t id = state.next_connection++;
            if (id > UINT32_MAX) { fail("E_CONNECTION_LIMIT: restart required"); return; }
            auto* connection = memnew(Impl::Connection);
            connection->root = root; connection->node = key; connection->signal = signal;
            connection->callback.Reset(isolate, info[3].As<v8::Function>());
            connection->callable = Callable(memnew(ReactSignalCallable(environment->id(), node->get_instance_id(), id)));
            const Error err = node->connect(signal, connection->callable);
            if (err != OK) { memdelete(connection); fail("E_SIGNAL_CONNECT: native connection failed"); return; }
            state.connections.insert(id, connection);
            info.GetReturnValue().Set(v8::Uint32::NewFromUnsigned(isolate, (uint32_t) id)); return;
        }
        if (op == READ || op == SET)
        {
            if (info.Length() < 3 || !info[2]->IsString()) { fail("E_PROPERTY: native property required"); return; }
            const StringName property = impl::Helper::to_string(isolate, info[2]);
            bool valid = false;
            const Variant previous = node->get(property, &valid);
            if (!valid) { fail("E_PROPERTY: unknown native property"); return; }
            if (op == READ)
            {
                v8::Local<v8::Value> result;
                if (!state.safe_to_js(*root, context, previous, result)) { fail("E_VALUE_CODEC: native value cannot cross the safe bridge"); return; }
                info.GetReturnValue().Set(result); return;
            }
            if (!state.mutation_stage(*root) || info.Length() != 4 || !mutable_property(property)) { fail("E_PROPERTY_PERMISSION: unsupported property or wrong stage"); return; }
            if (property == StringName("name") && node->get_parent()) { fail("E_CONSTRUCTION_PROP: name is fixed after attachment"); return; }
            Variant value;
            if (!state.safe_from_js(*root, context, info[3], value, previous.get_type())) { fail("E_VALUE_CODEC: invalid property value"); return; }
            node->set(property, value, &valid);
            if (!valid) { fail("E_NATIVE_SET: native rejected the property"); return; }
            node = state.resolve(*root, key);
            if (!node) { fail("E_NATIVE_LOST: property setter retired its target"); return; }
            if (property == StringName("name")) owned->name = node->get_name();
            if (!verify()) return;
            const Variant stored = node->get(property, &valid);
            v8::Local<v8::Value> encoded;
            if (!valid || !stored_equivalent(node, property, value, stored) || !state.safe_to_js(*root, context, stored, encoded))
            { fail("E_NATIVE_SET: stored value verification failed for " + String(property)); return; }
            info.GetReturnValue().Set(encoded); return;
        }
        if (op == SET_OWNER)
        {
            if (!state.mutation_stage(*root) || info.Length() != 3) { fail("E_PHASE: owner assignment requires native commit"); return; }
            Node* owner = nullptr;
            if (!info[2]->IsNull())
            {
                NativeObjectID owner_key;
                if (!read_key(context, info[2], owner_key) || !(owner = state.resolve(*root, owner_key)) || !owner->is_ancestor_of(node))
                { fail("E_OWNER: owner must be a managed ancestor"); return; }
            }
            node->set_owner(owner);
            node = state.resolve(*root, key);
            if (!node) { fail("E_NATIVE_LOST: owner setter retired its target"); return; }
            if (node->get_owner() != owner) { fail("E_OWNER: native owner assignment rejected"); return; }
            owned->owner = owner ? owner->get_instance_id() : ObjectID();
            verify(); return;
        }
        if (op == APPEND || op == REMOVE)
        {
            NativeObjectID child_key;
            if (!state.mutation_stage(*root) || info.Length() < 3 || !read_key(context, info[2], child_key))
            { fail("E_STRUCTURAL_PERMISSION: invalid native structural operation"); return; }
            Node* child = state.resolve(*root, child_key);
            if (!child || child == node || child->is_ancestor_of(node)) { fail("E_STRUCTURAL_TARGET: invalid child"); return; }
            Impl::Owned* child_record = root->nodes.getptr(*child_key);
            if (child_record->attachment) { fail("E_ROOT_ATTACHMENT: cannot move the application attachment"); return; }
            if (op == REMOVE)
            {
                if (child->get_parent() != node) { fail("E_NATIVE_PARENT: child is not attached to this parent"); return; }
                node->remove_child(child);
                child = state.resolve(*root, child_key);
                if (!child || !state.resolve(*root, key)) { fail("E_NATIVE_LOST: removal retired a structural target"); return; }
                if (child->get_parent()) { fail("E_NATIVE_REMOVE: native removal failed"); return; }
                owned->children.erase(child_key); child_record->parent = NativeObjectID();
                // Godot clears out-of-scope owners only in the final
                // _propagate_after_exit_tree pass of an in-tree parent.
                if (node->is_inside_tree()) state.apply_removal_owner_effect(*root, child);
                verify(); return;
            }
            if (info.Length() != 4 || !info[3]->IsInt32()) { fail("E_NATIVE_INDEX: integer insertion index required"); return; }
            int index = info[3].As<v8::Int32>()->Value();
            if (index < 0 || index > node->get_child_count(false)) { fail("E_NATIVE_INDEX: insertion index out of range"); return; }
            if (child->get_parent() && child->get_parent() != node) { fail("E_NATIVE_REPARENT: detach or remount before changing parent"); return; }
            for (int i = 0; i < node->get_child_count(false); ++i)
                if (node->get_child(i, false) != child && node->get_child(i, false)->get_name() == child->get_name())
                { fail("E_NATIVE_NAME: sibling name conflict"); return; }
            if (!child->get_parent()) node->add_child(child);
            node = state.resolve(*root, key); child = state.resolve(*root, child_key);
            if (!node || !child) { fail("E_NATIVE_LOST: insertion retired a structural target"); return; }
            index = MIN(index, node->get_child_count(false) - 1);
            node->move_child(child, index);
            node = state.resolve(*root, key); child = state.resolve(*root, child_key);
            if (!node || !child) { fail("E_NATIVE_LOST: reorder retired a structural target"); return; }
            if (child->get_parent() != node || child->get_index(false) != index) { fail("E_NATIVE_APPEND: native insertion/reorder failed"); return; }
            owned->children.erase(child_key); owned->children.insert(index, child_key);
            child_record->parent = key; verify(); return;
        }
        if (op == FREE)
        {
            if (!state.mutation_stage(*root) || owned->attachment || node->get_parent())
            { fail("E_NATIVE_FREE: detach a business deletion root before freeing it"); return; }
            const String error = state.audit(*root);
            if (!error.is_empty()) { fail(error); return; }
            const String batch = info.Length() > 2 && info[2]->IsString() ? impl::Helper::to_string(isolate, info[2]) : String();
            state.free_node(*root, node, batch); verify(); return;
        }
        if (op == CALL)
        {
            if (info.Length() != 4 || !info[2]->IsString() || !info[3]->IsArray()) { fail("E_COMMAND: command and arguments required"); return; }
            const StringName method = impl::Helper::to_string(isolate, info[2]);
            const String method_text = method;
            const bool reader = method_text.begins_with("get_") || method_text.begins_with("is_") || method_text.begins_with("has_");
            const bool physics = method_text == "move_and_slide" || method_text == "set_velocity" || method_text == "apply_impulse"
                || method_text == "apply_central_impulse" || method_text == "apply_force" || method_text == "apply_central_force"
                || method_text == "set_linear_velocity" || method_text == "set_angular_velocity" || method_text == "force_raycast_update";
            const bool transform = method_text == "set_position" || method_text == "set_global_position" || method_text == "set_rotation" || method_text == "set_scale";
            const bool cleanup = method_text == "stop" || method_text == "pause";
            const bool focus = method_text == "grab_focus" || method_text == "release_focus";
            const bool play = method_text == "play";
            const bool shader = method_text == "set_instance_shader_parameter";
            const bool projection = method_text == "project_ray_origin" || method_text == "project_ray_normal";
            if ((!reader && !physics && !transform && !cleanup && !focus && !play && !shader && !projection) || is_structural(method)) { fail("E_COMMAND_PROFILE: unsupported native command"); return; }
            if ((physics && root->stage != "physics") || (transform && root->stage != "physics" && root->stage != "process")
                || (shader && root->stage != "process")
                || ((cleanup || focus || play) && root->stage.is_empty())) { fail("E_COMMAND_PHASE: command outside authorized phase"); return; }
            MethodBind* binding = ClassDB::get_method(node->get_class(), method);
            if (!binding) { fail("E_COMMAND: method not found"); return; }
            const auto input = info[3].As<v8::Array>();
            if (!internal::VariantUtil::check_argc(binding->is_vararg(), input->Length(), binding->get_default_argument_count(), binding->get_argument_count()))
            { fail("E_COMMAND_ARGUMENT: incorrect argument count"); return; }
            std::vector<Variant> values(input->Length());
            std::vector<const Variant*> args(input->Length());
            for (uint32_t i = 0; i < input->Length(); ++i)
            {
                v8::Local<v8::Value> value;
                const Variant::Type hint = i < (uint32_t) binding->get_argument_count() ? binding->get_argument_type(i) : Variant::NIL;
                if (!input->Get(context, i).ToLocal(&value) || !state.safe_from_js(*root, context, value, values[i], hint)) { fail("E_COMMAND_CODEC: invalid argument"); return; }
                args[i] = &values[i];
            }
            Callable::CallError error;
            const Variant result = binding->call(node, args.data(), (int) args.size(), error);
            if (error.error != Callable::CallError::CALL_OK) { fail("E_COMMAND_NATIVE: native call failed"); return; }
            if (!verify()) return;
            v8::Local<v8::Value> encoded;
            if (!state.safe_to_js(*root, context, result, encoded)) { fail("E_COMMAND_CODEC: unsupported result"); return; }
            info.GetReturnValue().Set(encoded); return;
        }
        fail("E_NATIVE_OPERATION: unsupported bridge operation");
    }
}
