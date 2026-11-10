#include "scene/3d/visual_instance_3d.h"
#include "scene/gui/code_edit.h"
#include "scene/gui/menu_button.h"
#include "scene/gui/popup_menu.h"
#include "scene/resources/syntax_highlighter.h"
#include "scene/gui/tab_bar.h"
#include "scene/gui/text_edit.h"
#include "scene/gui/item_list.h"
#include "scene/gui/tab_container.h"
#include "jsb_react_bridge.h"
#include "jsb_environment.h"
#include "jsb_type_convert.h"
#include "../internal/jsb_react_run_lease.h"
#include "../internal/jsb_react_local_resources.h"
#include "../internal/jsb_react_manifest.h"

#include "scene/main/node.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "scene/gui/control.h"
#include "scene/gui/line_edit.h"
#include "scene/gui/label.h"
#include "scene/gui/rich_text_label.h"
#include "scene/2d/tile_map_layer.h"
#include "scene/2d/path_2d.h"
#include "scene/3d/path_3d.h"
#include "scene/gui/container.h"
#include "scene/gui/base_button.h"
#include "scene/resources/particle_process_material.h"
#include "scene/2d/gpu_particles_2d.h"
#include "scene/3d/gpu_particles_3d.h"
#include "scene/3d/physics/spring_arm_3d.h"
#include "scene/resources/packed_scene.h"
#include "scene/resources/skeleton_profile.h"
#include "scene/3d/skeleton_3d.h"
#include "scene/3d/node_3d.h"
#include "scene/2d/node_2d.h"
#include "scene/2d/physics/character_body_2d.h"
#include "scene/3d/physics/character_body_3d.h"
#include "scene/2d/physics/kinematic_collision_2d.h"
#include "scene/3d/physics/kinematic_collision_3d.h"
#include "scene/gui/scroll_container.h"
#include "scene/3d/camera_3d.h"
#include "scene/2d/camera_2d.h"
#include "scene/main/canvas_item.h"
#include "scene/resources/material.h"
#include "scene/resources/atlas_texture.h"
#include "scene/resources/shader.h"
#include "scene/2d/navigation/navigation_agent_2d.h"
#include "scene/3d/navigation/navigation_agent_3d.h"
#include "scene/animation/animation_player.h"
#include "scene/animation/animation_tree.h"
#include "scene/animation/animation_node_state_machine.h"
#include "scene/animation/animation_blend_tree.h"
#include <functional>
#include "core/io/resource_loader.h"
#include "core/object/script_language.h"
#include "core/version.h"
#include "scene/animation/tween.h"
#include "scene/gui/option_button.h"
#include "scene/gui/range.h"
#include "scene/resources/multimesh.h"
#include "scene/resources/font.h"
#include "scene/resources/style_box.h"
#include "scene/resources/2d/shape_2d.h"
#include "scene/resources/3d/shape_3d.h"
#include "scene/resources/world_2d.h"
#include "scene/resources/3d/world_3d.h"
#include "servers/physics_2d/physics_server_2d.h"
#include "servers/physics_3d/physics_server_3d.h"
#include "scene/main/viewport.h"
#include "scene/gui/container.h"
#include "scene/gui/subviewport_container.h"
#include "scene/3d/mesh_instance_3d.h"
#include "scene/2d/physics/collision_object_2d.h"
#include "scene/3d/physics/collision_object_3d.h"
#include "servers/audio/audio_server.h"
#include "core/io/image.h"
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
                Object* object = p_value.get_validated_object();
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

#include "jsb_react_rich_text.inc"

        bool allowed_class(const StringName& p_type)
        {
            // No custom ClassDB/GDExtension type is silently accepted. A type is
            // only available to authors when its runtime profile is certified.
            static const char* types[] = { "CodeEdit", "MenuButton", "CheckButton", "HSeparator", "VSeparator", "TextEdit", "ItemList", "HSplitContainer", "VSplitContainer", "HFlowContainer", "VFlowContainer", "RichTextLabel", "VSlider", "HScrollBar", "VScrollBar", "CanvasGroup", "DirectionalLight2D", "Parallax2D", "GPUParticles2D", "GPUParticles3D", "TextureButton", "TextureProgressBar", "SpringArm3D", "CenterContainer", "AspectRatioContainer", "Sprite3D", "Label3D", "VisibleOnScreenNotifier2D", "VisibleOnScreenNotifier3D", "AnimatableBody2D", "AnimatableBody3D", "Line2D", "Polygon2D", "CollisionPolygon2D", "NinePatchRect", "Node", "Node2D", "Node3D", "Control", "VBoxContainer", "HBoxContainer",
                "Label", "Button", "CanvasLayer", "LineEdit", "HSlider", "Sprite2D", "CharacterBody2D",
                "PanelContainer", "MarginContainer", "ScrollContainer", "TextureRect", "ProgressBar",
                "CollisionShape2D", "StaticBody2D", "RigidBody2D", "Area2D", "AnimationPlayer", "Camera2D",
                "CharacterBody3D", "CollisionShape3D", "StaticBody3D", "RigidBody3D", "Area3D", "Camera3D",
                "MeshInstance3D", "SubViewport", "SubViewportContainer", "ColorRect", "PointLight2D",
                "LightOccluder2D", "CanvasModulate", "DirectionalLight3D", "WorldEnvironment", "AudioStreamPlayer", "RayCast3D", "RayCast2D", "AudioStreamPlayer2D", "AudioStreamPlayer3D",
                "OmniLight3D", "SpotLight3D", "CPUParticles2D", "CPUParticles3D", "Timer", "AnimatedSprite2D", "AnimatedSprite3D", "TileMapLayer", "GridMap",
                "NavigationRegion2D", "NavigationRegion3D", "NavigationAgent2D", "NavigationAgent3D", "Skeleton3D", "BoneAttachment3D", "AnimationTree", "CheckBox", "OptionButton", "SpinBox", "GridContainer", "TabContainer", "Path2D", "Path3D", "PathFollow2D", "PathFollow3D", "MultiMeshInstance2D", "MultiMeshInstance3D", "ShapeCast2D", "ShapeCast3D", "PinJoint2D", "DampedSpringJoint2D", "PinJoint3D", "HingeJoint3D", "SliderJoint3D", "NavigationLink2D", "NavigationLink3D", "NavigationObstacle2D", "NavigationObstacle3D" };
            for (const char* type : types) if (p_type == StringName(type)) return true;
            return false;
        }

        bool allowed_asset_type(const StringName& p_type)
        {
            return p_type == StringName("GradientTexture2D") || p_type == StringName("BitMap") || p_type == StringName("ParticleProcessMaterial") || p_type == StringName("CurveTexture") || p_type == StringName("ButtonGroup") || p_type == StringName("QuadMesh") || p_type == StringName("Curve") || p_type == StringName("Gradient") || p_type == StringName("GradientTexture1D") || p_type == StringName("ConvexPolygonShape2D") || p_type == StringName("ConcavePolygonShape2D") || p_type == StringName("WorldBoundaryShape2D") || p_type == StringName("SeparationRayShape2D") || p_type == StringName("ConcavePolygonShape3D") || p_type == StringName("WorldBoundaryShape3D") || p_type == StringName("SeparationRayShape3D") || p_type == StringName("Resource") || p_type == StringName("CanvasItemMaterial")
                || p_type == StringName("Texture2D") || p_type == StringName("ImageTexture")
                || p_type == StringName("CompressedTexture2D") || p_type == StringName("Shape2D")
                || p_type == StringName("CapsuleShape2D") || p_type == StringName("RectangleShape2D")
                || p_type == StringName("CircleShape2D") || p_type == StringName("Shape3D")
                || p_type == StringName("CapsuleShape3D") || p_type == StringName("BoxShape3D")
                || p_type == StringName("SphereShape3D") || p_type == StringName("ConvexPolygonShape3D") || p_type == StringName("Theme")
                || p_type == StringName("Mesh") || p_type == StringName("ArrayMesh") || p_type == StringName("BoxMesh")
                || p_type == StringName("SphereMesh") || p_type == StringName("CylinderMesh") || p_type == StringName("PlaneMesh")
                || p_type == StringName("ShaderMaterial") || p_type == StringName("StandardMaterial3D")
                || p_type == StringName("Sky") || p_type == StringName("ProceduralSkyMaterial") || p_type == StringName("PanoramaSkyMaterial") || p_type == StringName("Environment") || p_type == StringName("OccluderPolygon2D")
                || p_type == StringName("AudioStream") || p_type == StringName("AudioStreamOggVorbis") || p_type == StringName("AudioStreamWAV")
                || p_type == StringName("SpriteFrames") || p_type == StringName("AtlasTexture")
                || p_type == StringName("Animation") || p_type == StringName("AnimationLibrary")
                || p_type == StringName("TileSet") || p_type == StringName("MeshLibrary")
                || p_type == StringName("NavigationPolygon") || p_type == StringName("NavigationMesh") || p_type == StringName("SkeletonProfile")
                || p_type == StringName("PackedScene") || p_type == StringName("Skin")
                || p_type == StringName("AnimationNodeBlendTree") || p_type == StringName("AnimationNodeStateMachine")
                || p_type == StringName("AnimationNodeBlendSpace1D") || p_type == StringName("AnimationNodeBlendSpace2D") || p_type == StringName("Curve2D") || p_type == StringName("Curve3D") || p_type == StringName("MultiMesh") || p_type == StringName("FontFile") || p_type == StringName("StyleBoxTexture") || p_type == StringName("StyleBoxEmpty") || p_type == StringName("CodeHighlighter") || p_type == StringName("StyleBoxFlat") || p_type == StringName("PhysicsMaterial") || p_type == StringName("AudioBusLayout") || p_type == StringName("ViewportTexture");
        }

        bool validate_scene_resource(const Variant& value, HashSet<ObjectID>& seen, int& budget, int depth=0)
        {
            if (--budget<0 || depth>64) return false;
            if (value.get_type()==Variant::CALLABLE || value.get_type()==Variant::SIGNAL) return false;
            if (value.get_type()==Variant::ARRAY) { const Array values=value; for(int i=0;i<values.size();++i)if(!validate_scene_resource(values[i],seen,budget,depth+1))return false; }
            if (value.get_type()==Variant::DICTIONARY) { const Dictionary values=value; const Array keys=values.keys();for(int i=0;i<keys.size();++i)if(!validate_scene_resource(values[keys[i]],seen,budget,depth+1))return false; }
            if (value.get_type()!=Variant::OBJECT) return true;
            Object* object=value.get_validated_object();if(!object)return true;
            Resource* resource=Object::cast_to<Resource>(object);
            if(!resource || Object::cast_to<Script>(object) || !resource->get_script().is_null())return false;
            if(resource->is_class("ParticleProcessMaterial")&&!resource->is_local_to_scene())return false;
            if(seen.has(object->get_instance_id()))return true;seen.insert(object->get_instance_id());
            if(PackedScene* scene=Object::cast_to<PackedScene>(object))
            {
                const Ref<SceneState> state=scene->get_state();
                if(state.is_null()||state->get_connection_count()!=0||state->get_node_count()>2048)return false;
                for(int i=0;i<state->get_node_count();++i){const StringName type=state->get_node_type(i);if(type!=StringName()&&!allowed_class(type))return false;if(type==StringName("TextEdit")||type==StringName("CodeEdit"))for(int j=0;j<state->get_node_property_count(i);++j)if(state->get_node_property_name(i,j)==StringName("text")){const Variant text=state->get_node_property_value(i,j);if(text.get_type()!=Variant::STRING||String(text).length()>65536)return false;}if(type==StringName("RichTextLabel")){String text;bool bbcode=false;for(int j=0;j<state->get_node_property_count(i);++j){const StringName name=state->get_node_property_name(i,j);const Variant value=state->get_node_property_value(i,j);if(name==StringName("text")){if(value.get_type()!=Variant::STRING)return false;text=value;}if(name==StringName("bbcode_enabled")){if(value.get_type()!=Variant::BOOL)return false;bbcode=value;}}if(!rich_text_valid(text,bbcode))return false;}}
            }
            if(Animation* animation=Object::cast_to<Animation>(object))for(int i=0;i<animation->get_track_count();++i)if(animation->track_get_type(i)==Animation::TYPE_METHOD)return false;
            List<PropertyInfo> properties;resource->get_property_list(&properties);
            for(const PropertyInfo& property:properties)if((property.usage&PROPERTY_USAGE_STORAGE)&&!validate_scene_resource(resource->get(property.name),seen,budget,depth+1))return false;
            return true;
        }

        Node* scene_target(Node* root,const String& path)
        {
            if(!root||path.is_empty()||path.length()>512)return nullptr;
            const NodePath node_path(path);
            if(node_path.is_absolute()||node_path.get_subname_count())return nullptr;
            for(int i=0;i<node_path.get_name_count();++i)if(node_path.get_name(i)==StringName(".."))return nullptr;
            Node* target=root->get_node_or_null(node_path);
            return target&&(target==root||root->is_ancestor_of(target))?target:nullptr;
        }

        bool apply_skeleton_profile(Skeleton3D* skeleton,const Ref<SkeletonProfile>& profile)
        {
            const int count=profile.is_valid()?profile->get_bone_size():0;
            if(count>256)return false;HashMap<StringName,int> names;
            for(int i=0;i<count;++i){const StringName name=profile->get_bone_name(i),parent=profile->get_bone_parent(i);if(name==StringName()||names.has(name)||(parent!=StringName()&&!names.has(parent)))return false;names.insert(name,i);}
            skeleton->clear_bones();
            for(int i=0;i<count;++i){skeleton->add_bone(profile->get_bone_name(i));const StringName parent=profile->get_bone_parent(i);if(parent!=StringName())skeleton->set_bone_parent(i,names[parent]);skeleton->set_bone_rest(i,profile->get_reference_pose(i));}
            skeleton->reset_bone_poses();return true;
        }

        bool validate_scene_targets(Node* root,Node* node,int& budget)
        {
            const Node* parent=node->get_parent();const bool private_ui=node->is_internal()&&parent&&((node->get_class()==StringName("SplitContainerDragger")&&parent->is_class("SplitContainer"))||(node->get_class()==StringName("TabBar")&&parent->is_class("TabContainer"))||(node->get_class()==StringName("PopupMenu")&&parent->is_class("MenuButton")));
            if(--budget<0||!node->get_script().is_null()||(!allowed_class(node->get_class())&&!private_ui))return false;
            if(node->is_class("Parallax2D")){const Vector2 size=node->get("repeat_size"),scale=node->get("scale");const int count=node->get("repeat_times");if(count<1||count>16||size.x<0||size.y<0||size.x>16384||size.y>16384||scale.x<=0||scale.y<=0)return false;}
            if(node->has_meta("__godot_react_profile"))
            {
                Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(node);Ref<SkeletonProfile> profile=node->get_meta("__godot_react_profile");
                if(!skeleton||profile.is_null()||!apply_skeleton_profile(skeleton,profile))return false;
            }
            if(node->is_class("Joint2D")||node->is_class("Joint3D"))for(const char* property:{"node_a","node_b"}){const NodePath path=node->get(property);if(!path.is_empty()){Node* target=path.is_absolute()?nullptr:node->get_node_or_null(path);if(!target||!(target==root||root->is_ancestor_of(target))||!target->is_class(node->is_class("Joint2D")?"PhysicsBody2D":"PhysicsBody3D"))return false;}}
            if(Control* control=Object::cast_to<Control>(node))for(const char* property:{"focus_neighbor_left","focus_neighbor_top","focus_neighbor_right","focus_neighbor_bottom","focus_next","focus_previous"}){const NodePath path=control->get(property);if(!path.is_empty()){Node* target=path.is_absolute()||path.get_subname_count()?nullptr:control->get_node_or_null(path);if(!target||!(target==root||root->is_ancestor_of(target))||!Object::cast_to<Control>(target))return false;}}
            if(AnimationMixer* mixer=Object::cast_to<AnimationMixer>(node))
            {
                const NodePath path=mixer->get_root_node();
                if(path.is_absolute())return false;
                Node* target=node->get_node_or_null(path);
                if(!target||!(target==root||root->is_ancestor_of(target)))return false;
            }
            if(AnimationTree* tree=Object::cast_to<AnimationTree>(node))
            {
                const NodePath path=tree->get_animation_player();
                if(!path.is_empty()){Node* target=path.is_absolute()?nullptr:node->get_node_or_null(path);if(!target||!(target==root||root->is_ancestor_of(target)))return false;}
            }
            if(node->is_class("MeshInstance3D")&&!node->get("skin").is_null())
            {
                const NodePath path=node->get("skeleton");Node* target=path.is_absolute()?nullptr:node->get_node_or_null(path);
                if(!target||!(target==root||root->is_ancestor_of(target)))return false;
            }
            for(int i=0;i<node->get_child_count(true);++i)if(!validate_scene_targets(root,node->get_child(i,true),budget))return false;
            return true;
        }

        bool tree_parameter(AnimationTree* tree,const String& name,const Variant& value)
        {
            if(!tree||!name.begins_with("parameters/")||name.contains("..")||name.length()>256)return false;
            bool valid=false;const Variant current=tree->get(name,&valid);
            if(!valid||current.get_type()!=value.get_type()||!(value.get_type()==Variant::FLOAT||value.get_type()==Variant::BOOL||value.get_type()==Variant::INT||value.get_type()==Variant::VECTOR2))return false;
            tree->set(name,value,&valid);return valid;
        }

        bool tree_state(AnimationTree* tree,const String& method,const StringName& name,Variant& result)
        {
            if(!tree)return false;
            Ref<AnimationNodeStateMachinePlayback> playback=tree->get("parameters/playback");
            if(playback.is_null())return false;
            if(method=="state"){result=playback->get_current_node();return true;}
            Ref<AnimationNodeStateMachine> machine=tree->get_root_animation_node();
            if(machine.is_null()||!machine->has_node(name))return false;
            if(method=="travel")playback->travel(name);else playback->start(name);
            return true;
        }

        bool mutable_property(const StringName& p_name)
        {
            const String name = p_name;
            static const char* names[] = { "playback_type", "page","rounded","exp_edit","allow_greater","allow_lesser","clear_button_enabled","right_icon","selecting_enabled","keep_editing_on_text_submit","prefix","update_on_text_changed","indeterminate","clear_margin","fit_margin","use_mipmaps","render_target_clear_mode","size_2d_override","size_2d_override_stretch","area_mask","audio_bus_override","reverb_bus_enabled","reverb_bus_amount","reverb_bus_uniformity","emission_angle_enabled","emission_angle_degrees","emission_angle_filter_attenuation_db","attenuation_filter_cutoff_hz","attenuation_filter_db","bbcode_enabled","fit_content","scroll_active","scroll_following","selection_enabled", "clip_contents", "layout_direction", "size_flags_stretch_ratio", "ignore_rotation", "limit_enabled", "limit_smoothed", "anchor_mode", "texture_click_mask", "path_search_max_distance", "path_search_max_polygons", "path_return_max_radius", "vertex_colors", "texture_offset", "texture_rotation", "invert_enabled", "invert_border", "sharp_limit", "round_precision", "color_initial_ramp", "angle_min", "angle_max", "angle_curve", "radial_accel_min", "radial_accel_max", "radial_accel_curve", "tangential_accel_min", "tangential_accel_max", "tangential_accel_curve", "orbit_velocity_min", "orbit_velocity_max", "orbit_velocity_curve", "hue_variation_min", "hue_variation_max", "hue_variation_curve", "name", "position", "global_position", "rotation", "scale", "visible",
                "clip_children", "use_parent_material", "custom_aabb", "material_overlay", "anim_speed_min", "anim_speed_max", "anim_offset_min", "anim_offset_max", "anim_speed_curve", "anim_offset_curve", "occlusion_enabled", "y_sort_origin", "x_draw_order_reversed", "use_kinematic_bodies", "rendering_quadrant_size", "physics_quadrant_size", "minimap_draw", "minimap_width", "line_folding", "gutters_draw_fold_gutter", "gutters_draw_bookmarks", "gutters_draw_breakpoints_gutter", "gutters_draw_executing_lines", "top_level", "show_behind_parent", "grow_horizontal", "grow_vertical", "gutters_draw_line_numbers", "indent_size", "indent_use_spaces", "indent_automatic", "auto_brace_completion_enabled", "switch_on_hover", "visibility_layer", "canvas_cull_mask", "visibility_range_begin", "visibility_range_end", "visibility_range_begin_margin", "visibility_range_end_margin", "extra_cull_margin", "select_mode", "allow_reselect", "allow_search", "max_columns", "fixed_column_width", "same_column_width", "fixed_icon_size", "icon_mode", "icon_scale", "max_text_lines", "auto_height", "wrap_mode", "caret_blink", "scroll_vertical", "scroll_horizontal", "scroll_past_end_of_file", "highlight_current_line", "tab_input_mode", "split_offset", "collapsed", "dragger_visibility", "dragging_enabled", "touch_dragger_enabled", "last_wrap_alignment", "reverse_fill", "tab_alignment", "tabs_position", "clip_tabs", "all_tabs_in_front", "use_hidden_tabs_for_min_size", "modulate", "self_modulate", "text", "disabled", "toggle_mode", "button_pressed", "flat",
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
                "projection", "mass", "linear_damp", "angular_damp", "sleeping", "target_position", "exclude_parent",
                "horizontal_scroll_mode", "vertical_scroll_mode", "follow_focus", "expand_mode", "stretch_mode",
                "flip_h", "flip_v", "centered", "show_percentage", "fill_mode",
                "can_sleep", "contact_monitor", "max_contacts_reported", "collide_with_areas", "collide_with_bodies",
                "hit_from_inside", "hit_back_faces", "zoom", "position_smoothing_enabled", "position_smoothing_speed",
                "limit_left", "limit_top", "limit_right", "limit_bottom", "pitch_scale", "autoplay", "stream_paused", "bus",
                "max_distance", "attenuation", "unit_size", "max_db", "omni_range", "omni_attenuation",
                "spot_range", "spot_attenuation", "spot_angle", "emitting", "amount", "lifetime", "one_shot",
                "preprocess", "speed_scale", "explosiveness", "randomness", "local_coords", "spread", "direction", "gravity",
                "initial_velocity_min", "initial_velocity_max", "scale_amount_min", "scale_amount_max",
                "wait_time", "autostart", "paused", "ignore_time_scale", "secret",
                "sprite_frames", "animation", "frame", "frame_progress", "pixel_size", "root_node", "callback_mode_process",
                "tile_set", "collision_enabled", "navigation_enabled", "y_sort_enabled", "mesh_library", "cell_size",
                "navigation_polygon", "navigation_mesh", "navigation_layers", "travel_cost", "enter_cost",
                "path_desired_distance", "target_desired_distance", "radius", "max_speed", "avoidance_enabled",
                "show_rest_only", "tree_root", "anim_player", "active", "skin", "skeleton", "bone_name",
                "physics_material_override", "z_index", "z_as_relative", "texture_filter", "texture_repeat", "autowrap_mode", "clip_text", "max_lines_visible", "text_overrun_behavior", "horizontal_alignment", "vertical_alignment", "softness", "angular_limit_enabled", "angular_limit_lower", "angular_limit_upper", "motor_enabled", "motor_target_velocity", "length", "rest_length", "stiffness", "damping", "params/bias", "params/damping", "params/impulse_clamp", "angular_limit/enable", "angular_limit/lower", "angular_limit/upper", "angular_limit/softness", "motor/enable", "motor/target_velocity", "motor/max_impulse", "linear_limit/lower_distance", "linear_limit/upper_distance", "angular_limit/lower_angle", "angular_limit/upper_angle", "linear_limit/damping", "angular_limit/damping", "bidirectional", "start_position", "end_position", "avoidance_layers", "avoidance_mask", "avoidance_priority", "vertices", "height", "use_3d_avoidance", "transparent_bg", "disable_3d", "own_world_3d", "render_target_update_mode", "gui_disable_input", "stretch", "stretch_shrink", "columns", "current_tab", "tabs_visible", "selected", "editable", "suffix", "curve", "progress", "loop", "rotates", "rotation_mode", "node_a", "node_b", "disable_collision", "exclude_nodes_from_collision", "max_results",
                "action_mode", "button_mask", "keep_pressed_outside", "scroll_deadzone", "scroll_horizontal_custom_step", "scroll_vertical_custom_step", "path_height_offset", "keep_y_velocity", "light_mask", "range_item_cull_mask", "shadow_item_cull_mask", "occluder_light_mask", "shadow_color", "blend_mode", "cubic_interp", "tilt_enabled", "use_model_front", "cell_scale", "cell_center_x", "cell_center_y", "cell_center_z", "collision_priority", "visible_characters", "visible_characters_behavior", "scroll_scale", "scroll_offset", "repeat_size", "repeat_times", "autoscroll", "limit_begin", "limit_end", "follow_viewport", "ignore_camera_scroll", "follow_viewport_enabled", "follow_viewport_scale", "amount_ratio", "interp_to_end", "interpolate", "fract_delta", "draw_order", "stretch_margin_left", "stretch_margin_top", "stretch_margin_right", "stretch_margin_bottom", "radial_center_offset", "texture_progress_offset", "select_all_on_focus", "caret_blink", "caret_blink_interval", "texture_normal", "texture_pressed", "texture_hover", "texture_disabled", "texture_focused", "ignore_texture_size", "texture_under", "texture_over", "texture_progress", "tint_under", "tint_over", "tint_progress", "nine_patch_stretch", "radial_initial_angle", "radial_fill_degrees", "pivot_offset", "visibility_rect", "visibility_aabb", "draw_pass_1", "spring_length", "margin", "keep_aspect", "frustum_offset", "h_offset", "v_offset", "path_postprocessing", "simplify_path", "simplify_epsilon", "path_max_distance", "path_return_max_length", "lock_rotation", "linear_damp_mode", "angular_damp_mode", "center_of_mass_mode", "center_of_mass", "constant_force", "constant_torque", "axis_lock_linear_x", "axis_lock_linear_y", "axis_lock_linear_z", "axis_lock_angular_x", "axis_lock_angular_y", "axis_lock_angular_z", "tooltip_text", "mouse_default_cursor_shape", "icon", "expand_icon", "alignment", "use_top_left", "ratio", "stretch_mode", "alignment_horizontal", "alignment_vertical", "process_callback", "linear_accel_min", "linear_accel_max", "linear_accel_curve", "damping_min", "damping_max", "damping_curve", "angular_velocity_min", "angular_velocity_max", "angular_velocity_curve", "width_curve", "gradient", "rect", "aabb", "billboard", "modulate", "font", "font_size", "outline_size", "outline_modulate", "no_depth_test", "shaded", "double_sided", "fixed_size", "max_polyphony", "panning_strength", "attenuation_model", "sync_to_physics", "platform_floor_layers", "platform_wall_layers", "platform_on_leave", "gravity_space_override", "gravity", "gravity_direction", "gravity_point", "gravity_point_center", "gravity_point_unit_distance", "linear_damp_space_override", "angular_damp_space_override", "priority", "freeze_mode", "neighbor_distance", "max_neighbors", "time_horizon_agents", "time_horizon_obstacles", "emission_shape", "emission_sphere_radius", "emission_rect_extents", "emission_box_extents", "emission_points", "emission_normals", "use_fixed_seed", "seed", "fixed_fps", "color_ramp", "scale_amount_curve", "emission_ring_axis", "emission_ring_height", "emission_ring_radius", "emission_ring_inner_radius", "layers", "cast_shadow", "light_cull_mask", "cull_mask", "rotation_smoothing_enabled", "rotation_smoothing_speed", "drag_horizontal_enabled", "drag_vertical_enabled", "drag_horizontal_offset", "drag_vertical_offset", "drag_left_margin", "drag_top_margin", "drag_right_margin", "drag_bottom_margin", "points", "width", "default_color", "closed", "antialiased", "joint_mode", "begin_cap_mode", "end_cap_mode", "texture_mode", "polygon", "uv", "build_mode", "hframes", "vframes", "region_enabled", "region_rect", "region_filter_clip_enabled", "continuous_cd", "patch_margin_left", "patch_margin_top", "patch_margin_right", "patch_margin_bottom", "draw_center", "axis_stretch_horizontal", "axis_stretch_vertical", "theme_override_constants/margin_left", "theme_override_constants/margin_right",
                "theme_override_constants/margin_top", "theme_override_constants/margin_bottom" };

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
                if(p_property==StringName("value"))if(Range* range=Object::cast_to<Range>(p_node))if(range->get_step()>0&&Math::abs(stored-requested)<=MAX(1e-12*MAX(1.0,Math::abs(requested)),range->get_step()*1e-9))return true;
                return stored == requested || stored == (double) (real_t) requested || stored == (double) (float) requested;
            }
            if (p_requested.get_type() == Variant::VECTOR2)
            {
                Vector2 expected = p_requested;
                if(p_property==StringName("size"))if(Control* control=Object::cast_to<Control>(p_node))expected=expected.max(control->get_combined_minimum_size());
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

#include "jsb_react_text_limit.inc"

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
            Ref<Resource> prefab;
            ObjectID prefab_root;
            Ref<SkeletonProfile> skeleton_profile;
            Ref<MultiMesh> multimesh_source;
            Ref<ParticleProcessMaterial> particle_source,particle_instance;
            Ref<ButtonGroup> group_source;
            Ref<Tween> tween;
            HashMap<StringName,Ref<Tween>> property_tweens;
            Variant gravity_direction,gravity_point_center;
            HashMap<int,Ref<ShaderMaterial>> shader_sources,shader_instances;
            Vector<NativeObjectID> exceptions;
            HashMap<uint64_t,RID> exception_rids;
            HashMap<StringName,NodePath> focus_paths;
            NodePath joint_a, joint_b;
            bool joint_bound = false;
            Array layout;
            Array surface_materials;
            String viewport_path, audio_bus;
            String search_text;
            int search_flags=0;
            Ref<CodeHighlighter> highlighter_source;
            int rich_images=0;
            Callable text_limit;
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
            HashMap<StringName, StringName> audio_buses;
            HashSet<ObjectID> audio_layouts;
            HashMap<ObjectID,Ref<ButtonGroup>> button_groups;
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
            ObjectID emitter;
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
            // Guard native input before a newly owned widget can enter the tree.
            // Attachments keep their caller-owned editing behavior.
            if (!p_attachment) if (TextEdit* text = Object::cast_to<TextEdit>(p_node)) {
                owned.text_limit = Callable(memnew(ReactTextLimitCallable(object_id)));
                if (!text->is_connected("text_changed", owned.text_limit)) text->connect("text_changed", owned.text_limit);
            }
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
            if(kind=="PackedColorArray") {
                if(p_hint!=Variant::NIL&&p_hint!=Variant::PACKED_COLOR_ARRAY)return false;const auto values=field(p_context,object,"values");if(!values->IsArray()||values.As<v8::Array>()->Length()>256)return false;
                PackedColorArray colors;const auto input=values.As<v8::Array>();for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(p_context,j).ToLocal(&item)||!safe_from_js(p_root,p_context,item,value,Variant::COLOR,p_depth+1))return false;const Color color=value;if(color.r<0||color.r>16||color.g<0||color.g>16||color.b<0||color.b>16||color.a<0||color.a>1)return false;colors.push_back(color);}r_value=colors;return true;
            }
            if (kind == "PackedVector2Array" || kind == "PackedVector3Array") {
                const bool three = kind == "PackedVector3Array";
                if (p_hint != Variant::NIL && p_hint != (three ? Variant::PACKED_VECTOR3_ARRAY : Variant::PACKED_VECTOR2_ARRAY)) return false;
                const auto values = field(p_context, object, "values"); if (!values->IsArray()) return false;
                const auto input = values.As<v8::Array>(); if (input->Length() > 4096) return false;
                PackedVector2Array two_values; PackedVector3Array three_values;
                for (uint32_t i = 0; i < input->Length(); ++i) { v8::Local<v8::Value> item; Variant value;
                    if (!input->Get(p_context, i).ToLocal(&item) || !safe_from_js(p_root,p_context,item,value,three?Variant::VECTOR3:Variant::VECTOR2,p_depth+1)) return false;
                    if (three) three_values.push_back(value); else two_values.push_back(value);
                }
                r_value = three ? Variant(three_values) : Variant(two_values); return true;
            }
            if(kind=="AABB"){
                if(p_hint!=Variant::NIL&&p_hint!=Variant::AABB)return false;Variant position,size;if(!safe_from_js(p_root,p_context,field(p_context,object,"position"),position,Variant::VECTOR3,p_depth+1)||!safe_from_js(p_root,p_context,field(p_context,object,"size"),size,Variant::VECTOR3,p_depth+1))return false;const Vector3 extent=size;if(extent.x<0||extent.y<0||extent.z<0)return false;r_value=AABB(Vector3(position),extent);return true;
            }
            if(kind=="Rect2"){
                if(p_hint!=Variant::NIL&&p_hint!=Variant::RECT2)return false;Variant position,size;
                if(!safe_from_js(p_root,p_context,field(p_context,object,"position"),position,Variant::VECTOR2,p_depth+1)||!safe_from_js(p_root,p_context,field(p_context,object,"size"),size,Variant::VECTOR2,p_depth+1))return false;
                const Vector2 extent=size;if(extent.x<0||extent.y<0)return false;r_value=Rect2(Vector2(position),extent);return true;
            }
            if (kind == "Transform2D") {
                if (p_hint != Variant::NIL && p_hint != Variant::TRANSFORM2D) return false;
                const auto basis_value=field(p_context,object,"basis");if(!basis_value->IsObject())return false;const auto basis=basis_value.As<v8::Object>();Variant x,y,origin;
                if(!safe_from_js(p_root,p_context,field(p_context,basis,"x"),x,Variant::VECTOR2,p_depth+1)||!safe_from_js(p_root,p_context,field(p_context,basis,"y"),y,Variant::VECTOR2,p_depth+1)||!safe_from_js(p_root,p_context,field(p_context,object,"origin"),origin,Variant::VECTOR2,p_depth+1))return false;
                r_value=Transform2D(Vector2(x),Vector2(y),Vector2(origin));return true;
            }
            if (kind == "Quaternion")
            {
                if (p_hint != Variant::NIL && p_hint != Variant::QUATERNION) return false;
                double x,y,z,w;
                if (!number("x",x)||!number("y",y)||!number("z",z)||!number("w",w)) return false;
                const Quaternion q(x,y,z,w);
                if (!q.is_normalized()) return false;
                r_value=q;return true;
            }
            if (kind == "Transform3D")
            {
                if (p_hint != Variant::NIL && p_hint != Variant::TRANSFORM3D) return false;
                const auto basis_value = field(p_context, object, "basis");
                if (!basis_value->IsObject()) return false;
                const auto basis = basis_value.As<v8::Object>();
                Variant x,y,z,origin;
                if (!safe_from_js(p_root,p_context,field(p_context,basis,"x"),x,Variant::VECTOR3,p_depth+1)
                    || !safe_from_js(p_root,p_context,field(p_context,basis,"y"),y,Variant::VECTOR3,p_depth+1)
                    || !safe_from_js(p_root,p_context,field(p_context,basis,"z"),z,Variant::VECTOR3,p_depth+1)
                    || !safe_from_js(p_root,p_context,field(p_context,object,"origin"),origin,Variant::VECTOR3,p_depth+1)) return false;
                r_value=Transform3D(Basis(Vector3(x),Vector3(y),Vector3(z)),Vector3(origin));return true;
            }
            if (kind == "Vector2i" || kind == "Vector3i")
            {
                const bool three = kind == "Vector3i";
                if (p_hint != Variant::NIL && p_hint != (three ? Variant::VECTOR3I : Variant::VECTOR2I)) return false;
                double x, y, z = 0;
                if (!number("x", x) || !number("y", y) || (three && !number("z", z))) return false;
                for (const double component : { x, y, z })
                    if (component != std::floor(component) || component < INT32_MIN || component > INT32_MAX) return false;
                if (three) r_value = Vector3i((int32_t) x, (int32_t) y, (int32_t) z);
                else r_value = Vector2i((int32_t) x, (int32_t) y);
                return true;
            }
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
                if((*resource)->is_class("ViewportTexture")){bool live=false;for(const KeyValue<uint64_t,Owned>& pair:p_root.nodes)if(SubViewport* viewport=Object::cast_to<SubViewport>(resolve(p_root,NativeObjectID(pair.key))))if(viewport->is_inside_tree()&&viewport->get_texture().ptr()==resource->ptr()){live=true;break;}if(!live)return false;}
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
            case Variant::QUATERNION:
                {
                    const Quaternion q=p_value;
                    if (!q.is_finite()) return false;
                    auto result=v8::Object::New(isolate);
                    put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"Quaternion"));
                    put(p_context,result,"x",v8::Number::New(isolate,q.x));put(p_context,result,"y",v8::Number::New(isolate,q.y));
                    put(p_context,result,"z",v8::Number::New(isolate,q.z));put(p_context,result,"w",v8::Number::New(isolate,q.w));
                    r_value=result;return true;
                }
            case Variant::AABB:
                {const AABB box=p_value;auto result=v8::Object::New(isolate);v8::Local<v8::Value> position,size;if(!safe_to_js(p_root,p_context,box.position,position,p_depth+1)||!safe_to_js(p_root,p_context,box.size,size,p_depth+1))return false;put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"AABB"));put(p_context,result,"position",position);put(p_context,result,"size",size);r_value=result;return true;}
            case Variant::TRANSFORM3D:
                {
                    const Transform3D t=p_value;
                    auto result=v8::Object::New(isolate),basis=v8::Object::New(isolate);
                    const char* names[]={"x","y","z"};
                    for(int i=0;i<3;++i){v8::Local<v8::Value> column;if(!safe_to_js(p_root,p_context,t.basis.get_column(i),column,p_depth+1))return false;put(p_context,basis,names[i],column);}
                    v8::Local<v8::Value> origin;if(!safe_to_js(p_root,p_context,t.origin,origin,p_depth+1))return false;
                    put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"Transform3D"));put(p_context,result,"basis",basis);put(p_context,result,"origin",origin);
                    r_value=result;return true;
                }
            case Variant::VECTOR2I:
            case Variant::VECTOR3I:
                {
                    const bool three = p_value.get_type() == Variant::VECTOR3I;
                    const Vector3i v = three ? Vector3i(p_value) : Vector3i(Vector2i(p_value).x, Vector2i(p_value).y, 0);
                    auto result = v8::Object::New(isolate);
                    put(p_context, result, "kind", impl::Helper::new_string_ascii(isolate, three ? "Vector3i" : "Vector2i"));
                    put(p_context, result, "x", v8::Int32::New(isolate, v.x));
                    put(p_context, result, "y", v8::Int32::New(isolate, v.y));
                    if (three) put(p_context, result, "z", v8::Int32::New(isolate, v.z));
                    r_value = result; return true;
                }
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
            case Variant::RECT2:{const Rect2 rect=p_value;auto result=v8::Object::New(isolate);v8::Local<v8::Value> position,size;if(!safe_to_js(p_root,p_context,rect.position,position,p_depth+1)||!safe_to_js(p_root,p_context,rect.size,size,p_depth+1))return false;put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"Rect2"));put(p_context,result,"position",position);put(p_context,result,"size",size);r_value=result;return true;}
            case Variant::DICTIONARY:{const Dictionary values=p_value;const Array keys=values.keys();if(keys.size()>128)return false;auto result=v8::Object::New(isolate);for(int i=0;i<keys.size();++i){if(keys[i].get_type()!=Variant::STRING&&keys[i].get_type()!=Variant::STRING_NAME)return false;const String key=keys[i];if(key=="__proto__"||key=="constructor"||key=="prototype")return false;v8::Local<v8::Value> item;if(!safe_to_js(p_root,p_context,values[keys[i]],item,p_depth+1))return false;put(p_context,result,key.utf8().get_data(),item);}r_value=result;return true;}
            case Variant::PACKED_COLOR_ARRAY: { Array values; for(const Color& value:PackedColorArray(p_value))values.push_back(value);return safe_to_js(p_root,p_context,values,r_value,p_depth+1); }
            case Variant::PACKED_STRING_ARRAY: { Array values; for(const String& value:PackedStringArray(p_value))values.push_back(value);return safe_to_js(p_root,p_context,values,r_value,p_depth+1); }
            case Variant::PACKED_VECTOR2_ARRAY: { Array values; for(const Vector2& value:PackedVector2Array(p_value))values.push_back(value);return safe_to_js(p_root,p_context,values,r_value,p_depth+1); }
            case Variant::PACKED_VECTOR3_ARRAY: { Array values; for(const Vector3& value:PackedVector3Array(p_value))values.push_back(value);return safe_to_js(p_root,p_context,values,r_value,p_depth+1); }
            case Variant::TRANSFORM2D: { const Transform2D transform=p_value;auto result=v8::Object::New(isolate);auto basis=v8::Object::New(isolate);v8::Local<v8::Value> x,y,origin;if(!safe_to_js(p_root,p_context,transform[0],x,p_depth+1)||!safe_to_js(p_root,p_context,transform[1],y,p_depth+1)||!safe_to_js(p_root,p_context,transform[2],origin,p_depth+1))return false;put(p_context,basis,"x",x);put(p_context,basis,"y",y);put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"Transform2D"));put(p_context,result,"basis",basis);put(p_context,result,"origin",origin);r_value=result;return true; }
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
                    Object* object = p_value.get_validated_object();
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
                    if(resource->is_class("ViewportTexture")){bool owned=false;for(const KeyValue<uint64_t,Owned>& pair:p_root.nodes)if(SubViewport* viewport=Object::cast_to<SubViewport>(resolve(p_root,NativeObjectID(pair.key))))if(viewport->is_inside_tree()&&viewport->get_texture().ptr()==resource){owned=true;break;}if(!owned)return false;}
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
            if (Node* node = Object::cast_to<Node>(compat::ObjectDB::get_instance(connection->emitter)))
                if (node->is_connected(connection->signal, connection->callable)) node->disconnect(connection->signal, connection->callable);
            connections.erase(p_id);
            connection->callback.Reset();
            memdelete(connection);
        }

        void unbind_joints(Root& root)
        {
            for (KeyValue<uint64_t, Owned>& pair : root.nodes) if (pair.value.joint_bound) {
                if (Node* node = resolve(root, NativeObjectID(pair.key))) { node->set("node_a", NodePath()); node->set("node_b", NodePath()); }
                pair.value.joint_bound = false;
            }
        }

        String bind_joints(Root& root)
        {
            // Resolve the complete proposed graph before configuring any native constraint.
            for (KeyValue<uint64_t, Owned>& pair : root.nodes) {
                Node* node = resolve(root, NativeObjectID(pair.key));
                if (!node || !node->is_inside_tree() || (!node->is_class("Joint2D") && !node->is_class("Joint3D"))) continue;
                for (const NodePath& path : {pair.value.joint_a, pair.value.joint_b}) if (!path.is_empty()) {
                    Node* target = node->get_node_or_null(path);
                    const NativeObjectID key = target ? environment->try_get_object_id(target) : NativeObjectID();
                    if (!target || !root.nodes.has(*key) || !target->is_class(node->is_class("Joint2D") ? "PhysicsBody2D" : "PhysicsBody3D")) return "E_JOINT_PATH: endpoint must resolve to an owned physics body at commit";
                }
            }
            for (KeyValue<uint64_t, Owned>& pair : root.nodes) {
                Node* node = resolve(root, NativeObjectID(pair.key));
                if (!node || !node->is_inside_tree() || pair.value.joint_bound || (!node->is_class("Joint2D") && !node->is_class("Joint3D"))) continue;
                node->set("node_a", pair.value.joint_a); node->set("node_b", pair.value.joint_b); pair.value.joint_bound = true;
            }
            return {};
        }

#include "jsb_react_parity.inc"
#include "jsb_react_behaviors.inc"
#include "jsb_react_interactions.inc"
#include "jsb_react_presentation.inc"
#include "jsb_react_details.inc"
#include "jsb_react_precision.inc"
#include "jsb_react_fidelity.inc"
#include "jsb_react_usability.inc"
#include "jsb_react_composition.inc"
#include "jsb_react_workflows.inc"
#include "jsb_react_refinements.inc"
#include "jsb_react_gameplay.inc"

        String bind_focus(Root& root)
        {
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(Control* control=Object::cast_to<Control>(resolve(root,NativeObjectID(pair.key))))for(const KeyValue<StringName,NodePath>& entry:pair.value.focus_paths){
                if(!control->is_inside_tree()||entry.value.is_empty())continue;Node* target=control->get_node_or_null(entry.value);const NativeObjectID id=target?environment->try_get_object_id(target):NativeObjectID();if(!target||!target->is_inside_tree()||!root.nodes.has(*id)||!Object::cast_to<Control>(target))return "E_FOCUS_PATH: "+String(control->get_name())+" -> "+String(entry.value)+" must target a live Control in this Root";
            }
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(Control* control=Object::cast_to<Control>(resolve(root,NativeObjectID(pair.key))))for(const KeyValue<StringName,NodePath>& entry:pair.value.focus_paths)if(control->is_inside_tree())control->set(entry.key,entry.value);
            return {};
        }

        String audit(Root& p_root) const
        {
            int64_t particles=0;for(const KeyValue<uint64_t,Owned>& entry:p_root.nodes){Node* item=resolve(p_root,NativeObjectID(entry.key));if(!item||!item->is_inside_tree())continue;if(item->is_class("GPUParticles2D")||item->is_class("GPUParticles3D"))particles+=int64_t(item->get("amount"));if(entry.value.prefab_root.is_valid())particles+=subtree_particles(Object::cast_to<Node>(compat::ObjectDB::get_instance(entry.value.prefab_root)));}if(particles>65536)return "E_GPU_BUDGET: Root particle count";
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
                if((node->is_class("Joint2D")||node->is_class("Joint3D"))&&node->is_inside_tree())for(const char* property:{"node_a","node_b"}){const NodePath path=node->get(property);if(!path.is_empty()){Node* target=node->get_node_or_null(path);const NativeObjectID target_key=target?environment->try_get_object_id(target):NativeObjectID();if(!target||!p_root.nodes.has(*target_key)||!target->is_class(node->is_class("Joint2D")?"PhysicsBody2D":"PhysicsBody3D"))return "E_JOINT_PATH: joint endpoint must be an owned physics body";}}
                if (pair.value.prefab_root.is_valid())
                {
                    Node* prefab = Object::cast_to<Node>(compat::ObjectDB::get_instance(pair.value.prefab_root));
                    if (!prefab || prefab->get_parent() != node || !prefab->is_internal()) return "E_FOREIGN_MUTATION: native scene lifetime changed";
                }
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
            unbind_joints(p_root);
            Vector<NativeObjectID> keys;
            collect(p_root, p_node, keys);
            Vector<uint64_t> disconnects;
            for (const KeyValue<uint64_t, Connection*>& pair : connections)
                if (pair.value->root == &p_root && keys.has(pair.value->node)) disconnects.push_back(pair.key);
            for (uint64_t id : disconnects) disconnect(id);
            const String batch = p_batch.is_empty() ? String("@native/") + uitos(p_root.token) + "/" + uitos(next_retirement++) : p_batch;
            for (NativeObjectID key : keys) {if(Owned* owned=p_root.nodes.getptr(*key)){if(owned->tween.is_valid())owned->tween->kill();for(const KeyValue<StringName,Ref<Tween>>& item:owned->property_tweens)if(item.value.is_valid())item.value->kill();}environment->mark_react_expected_release(key, batch);}
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
            close_audio_buses(p_root);
            p_root.button_groups.clear();p_root.assets.clear();
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
        if (!impl_->resolve(*(*found)->root, (*found)->node)) return;
        auto* isolate = impl_->environment->get_isolate();
        v8::Isolate::Scope isolate_scope(isolate);
        v8::HandleScope handle_scope(isolate);
        const auto context = impl_->environment->get_context();
        if (context.IsEmpty()) return;
        v8::Context::Scope context_scope(context);
        std::vector<v8::Local<v8::Value>> args;
        const StringName signal=(*found)->signal;const bool shape=signal==StringName("body_shape_entered")||signal==StringName("body_shape_exited")||signal==StringName("area_shape_entered")||signal==StringName("area_shape_exited");
        const int count=shape?1:p_argc;args.resize(count);
        if(shape){Variant value;if(!impl_->shape_contact_event(*(*found)->root,impl_->resolve(*(*found)->root,(*found)->node),p_args,p_argc,value))return;if(!impl_->safe_to_js(*(*found)->root,context,value,args[0])){JSB_LOG(Error,"E_SIGNAL_CODEC: invalid shape contact");return;}}
        else for(int i=0;i<p_argc;++i){const bool navigation=signal==StringName("waypoint_reached")||signal==StringName("link_reached");const Variant value=navigation?impl_->navigation_event(*(*found)->root,*p_args[i]):*p_args[i];if(!impl_->safe_to_js(*(*found)->root,context,value,args[i])){JSB_LOG(Error,"E_SIGNAL_CODEC: unsupported React signal argument");return;}}
        const v8::Local<v8::Function> callback = (*found)->callback.Get(isolate);
        const impl::TryCatch catcher(isolate);
        v8::Local<v8::Value> ignored;
        if (!callback->Call(context, v8::Undefined(isolate), count, args.data()).ToLocal(&ignored))
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
            const String focus = state.bind_focus(*root); if(!focus.is_empty()){fail(focus);return;}
            const String bindings = state.bind_joints(*root); if (!bindings.is_empty()) { fail(bindings); return; }
            const String surfaces = state.bind_surfaces(*root); if(!surfaces.is_empty()){fail(surfaces);return;}
            const String viewports = state.bind_viewports(*root); if (!viewports.is_empty()) { fail(viewports); return; }
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
                || (type == StringName("PackedScene") && !(path.begins_with("res://playground_runtime_") && path.ends_with(".tscn")))
                || (path.ends_with(".tscn") && !(type == StringName("PackedScene") && path.begins_with("res://playground_runtime_"))) || path.ends_with(".scn") || path.ends_with(".gd") || path.ends_with(".ts") || path.ends_with(".js"))
            { fail("E_ASSET_PROFILE: unsupported asset path/type"); return; }
            const Ref<Resource> resource = ResourceLoader::load(path, type);
            if (resource.is_null() || !resource->is_class(type) || !resource->get_script().is_null()) { fail("E_ASSET_LOAD: missing, wrong type or scripted resource"); return; }
            if (type == StringName("PackedScene")) { HashSet<ObjectID> seen; int budget=20000; if (!validate_scene_resource(resource,seen,budget)) { fail("E_ASSET_PROFILE: native scenes must be closed, script-free graphs"); return; } }
            const String audio_error=state.install_audio_layout(*root,resource);if(!audio_error.is_empty()){fail(audio_error);return;}
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
            StringName signal = impl::Helper::to_string(isolate, info[2]);
            Node* emitter=node;
            if(signal==StringName("__react_workflows_menu_id")){MenuButton* menu=Object::cast_to<MenuButton>(node);if(!menu){fail("E_SIGNAL: menu owner required");return;}emitter=menu->get_popup();signal=StringName("id_pressed");}
            if (!emitter->has_signal(signal)) { fail("E_SIGNAL: native signal not found"); return; }
            const uint64_t id = state.next_connection++;
            if (id > UINT32_MAX) { fail("E_CONNECTION_LIMIT: restart required"); return; }
            auto* connection = memnew(Impl::Connection);
            connection->root = root; connection->node = key; connection->signal = signal; connection->emitter=emitter->get_instance_id();
            connection->callback.Reset(isolate, info[3].As<v8::Function>());
            connection->callable = Callable(memnew(ReactSignalCallable(environment->id(), emitter->get_instance_id(), id)));
            const Error err = emitter->connect(signal, connection->callable);
            if (err != OK) { memdelete(connection); fail("E_SIGNAL_CONNECT: native connection failed"); return; }
            state.connections.insert(id, connection);
            info.GetReturnValue().Set(v8::Uint32::NewFromUnsigned(isolate, (uint32_t) id)); return;
        }
        if (op == READ || op == SET)
        {
            if (info.Length() < 3 || !info[2]->IsString()) { fail("E_PROPERTY: native property required"); return; }
            const StringName property = impl::Helper::to_string(isolate, info[2]);
            if(String(property).begins_with("__react_refine_")){
                Variant value,result;const bool text=property==StringName("__react_refine_search_text");if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,text?Variant::STRING:Variant::INT)){fail("E_REFINEMENT_PROPERTY: invalid stage or value");return;}}if(!state.refine_search(*owned,node,property,value,op==SET,result)){fail("E_REFINEMENT_PROPERTY: invalid search state");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_REFINEMENT_PROPERTY: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(String(property).begins_with("__react_workflows_")){
                Variant value,result;if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,property==StringName("__react_workflows_menu")?Variant::ARRAY:Variant::OBJECT)){fail("E_WORKFLOW_PROPERTY: invalid stage or value");return;}}if(!state.workflow_special(*owned,node,property,value,op==SET,result)){fail("E_WORKFLOW_PROPERTY: invalid data");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_WORKFLOW_PROPERTY: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(String(property).begins_with("__react_composition_")){
                Variant value,result;if(op==SET){const String property_name=property;const Variant::Type hint=property_name=="__react_composition_text"?Variant::STRING:Variant::ARRAY;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,hint)){fail("E_COMPOSITION_PROPERTY: invalid value or stage");return;}}
                if(!state.composition_special(*owned,node,property,value,op==SET,result)){fail("E_COMPOSITION_PROPERTY: invalid target, items, selection or text");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMPOSITION_PROPERTY: unsupported output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(Object::cast_to<Control>(node)&&(String(property).begins_with("focus_neighbor_")||property==StringName("focus_next")||property==StringName("focus_previous"))){
                const String text=String(property);if(text!="focus_next"&&text!="focus_previous"&&text!="focus_neighbor_left"&&text!="focus_neighbor_top"&&text!="focus_neighbor_right"&&text!="focus_neighbor_bottom"){fail("E_FOCUS_PATH: unsupported direction");return;}
                if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!info[3]->IsString()){fail("E_FOCUS_PATH: path requires commit");return;}const String path_text=impl::Helper::to_string(isolate,info[3]);const NodePath path(path_text);if(path_text.length()>512||path.is_absolute()||path.get_subname_count()){fail("E_FOCUS_PATH: local Control path required");return;}owned->focus_paths.insert(property,path);node->set(property,NodePath());}
                const NodePath* path=owned->focus_paths.getptr(property);info.GetReturnValue().Set(impl::Helper::new_string(isolate,path?String(*path):String()));return;
            }
            if(property==StringName("process_material")&&(node->is_class("GPUParticles2D")||node->is_class("GPUParticles3D"))){
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,Variant::OBJECT)){fail("E_GPU_MATERIAL: registered material required");return;}Ref<ParticleProcessMaterial> source=value;if(!value.is_null()&&source.is_null()){fail("E_GPU_MATERIAL: ParticleProcessMaterial required");return;}if(owned->particle_source!=source){owned->particle_source=source;owned->particle_instance=source.is_valid()?Ref<ParticleProcessMaterial>(source->duplicate()):Ref<ParticleProcessMaterial>();}node->set(property,owned->particle_instance);if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->particle_source,result)){fail("E_GPU_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(property==StringName("button_group")){
                BaseButton* button=Object::cast_to<BaseButton>(node);if(!button){fail("E_BUTTON_GROUP: BaseButton required");return;}
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,Variant::OBJECT)){fail("E_BUTTON_GROUP: registered group required");return;}Ref<ButtonGroup> source=value;if(!value.is_null()&&source.is_null()){fail("E_BUTTON_GROUP: ButtonGroup required");return;}Ref<ButtonGroup> copy;if(!state.private_group(*root,source,button,copy)){fail("E_BUTTON_GROUP: group/member budget exceeded");return;}owned->group_source=source;button->set_button_group(copy);if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->group_source,result)){fail("E_BUTTON_GROUP: result");return;}info.GetReturnValue().Set(result);return;
            }
            if((node->is_class("Area2D")||node->is_class("Area3D"))&&(property==StringName("gravity_direction")||property==StringName("gravity_point_center")||property==StringName("gravity_point"))){
                const bool two=node->is_class("Area2D"),point_property=property==StringName("gravity_point"),center=property==StringName("gravity_point_center");
                if(owned->gravity_direction.get_type()==Variant::NIL)owned->gravity_direction=two?Variant(Vector2(0,1)):Variant(Vector3(0,-1,0));
                if(owned->gravity_point_center.get_type()==Variant::NIL)owned->gravity_point_center=two?Variant(Vector2()):Variant(Vector3());
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,point_property?Variant::BOOL:two?Variant::VECTOR2:Variant::VECTOR3)){fail("E_AREA_GRAVITY: invalid property value");return;}
                    if(point_property)node->set(property,value);else if(center)owned->gravity_point_center=value;else owned->gravity_direction=value;
                    const bool point=node->get("gravity_point");node->set(point?"gravity_point_center":"gravity_direction",point?owned->gravity_point_center:owned->gravity_direction);if(!verify())return;
                }
                const Variant value=point_property?node->get(property):center?owned->gravity_point_center:owned->gravity_direction;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,value,encoded)){fail("E_AREA_GRAVITY: invalid result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if ((node->is_class("Joint2D") || node->is_class("Joint3D")) && (property == StringName("node_a") || property == StringName("node_b"))) {
                if (op == SET) {
                    if (!state.mutation_stage(*root) || info.Length() != 4 || !info[3]->IsString()) { fail("E_JOINT_PATH: local path requires commit"); return; }
                    const String text = impl::Helper::to_string(isolate, info[3]); const NodePath path(text);
                    if (path.is_absolute() || path.get_subname_count() || text.contains("../..") || text.length() > 512) { fail("E_JOINT_PATH: path escapes joint scope"); return; }
                    state.unbind_joints(*root); if (property == StringName("node_a")) owned->joint_a = path; else owned->joint_b = path;
                    if (!verify()) return;
                }
                info.GetReturnValue().Set(impl::Helper::new_string(isolate, String(property == StringName("node_a") ? owned->joint_a : owned->joint_b))); return;
            }
            if((property==StringName("material")&&Object::cast_to<CanvasItem>(node))||(property==StringName("material_override")&&Object::cast_to<MeshInstance3D>(node))||(property==StringName("material_overlay")&&Object::cast_to<GeometryInstance3D>(node))){
                const int slot=property==StringName("material")?-1:property==StringName("material_overlay")?-3:-2;Variant source;
                if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],source,Variant::OBJECT)){fail("E_MATERIAL: expected registered material");return;}Ref<Material> material=source;if(!source.is_null()&&material.is_null()){fail("E_MATERIAL: expected material");return;}node->set(property,state.private_material(*owned,slot,material));if(!verify())return;}
                else{if(const Ref<ShaderMaterial>* original=owned->shader_sources.getptr(slot))source=*original;else source=node->get(property);}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,source,result)){fail("E_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(String(property).begins_with("__react_usability_")){
                const String name=property;Variant value,result;const bool set=op==SET;
                const Variant::Type hint=name.begins_with("__react_usability_fontsize")?Variant::INT:name=="__react_usability_fontcolor"?Variant::COLOR:name.begins_with("__react_usability_font_")?Variant::OBJECT:Variant::STRING;
                if(set&&(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,hint))){fail("E_USABILITY_PROPERTY: invalid value or phase");return;}
                if(!state.usability_special(*root,*owned,node,name,value,set,result)){fail("E_USABILITY_PROPERTY: invalid target, bus, font or range");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_USABILITY_PROPERTY: cannot encode result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(property==StringName("__react_surface_materials")){
                MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(!mesh){fail("E_SURFACE_MATERIAL: MeshInstance3D required");return;}
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,Variant::ARRAY)){fail("E_SURFACE_MATERIAL: expected registered material array");return;}const Array materials=value;if(materials.size()>64){fail("E_SURFACE_MATERIAL: too many surfaces");return;}for(int i=0;i<materials.size();++i)if(materials[i].get_type()!=Variant::NIL){Ref<Resource> material=materials[i];if(material.is_null()||(!material->is_class("StandardMaterial3D")&&!material->is_class("ShaderMaterial"))){fail("E_SURFACE_MATERIAL: unsupported material");return;}}owned->surface_materials=materials;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->surface_materials,result)){fail("E_SURFACE_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(property==StringName("__react_layout")){
                Control* control=Object::cast_to<Control>(node);if(!control){fail("E_LAYOUT: layout requires Control");return;}
                if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4){fail("E_LAYOUT: layout requires commit");return;}if(info[3]->IsNull()){owned->layout.clear();control->set_anchors_and_offsets_preset(Control::PRESET_TOP_LEFT);}else{Variant value;if(!state.safe_from_js(*root,context,info[3],value,Variant::ARRAY)){fail("E_LAYOUT: invalid layout");return;}Array edges=value;if(edges.size()!=8){fail("E_LAYOUT: expected eight layout edges");return;}for(int i=0;i<8;++i)if(edges[i].get_type()!=Variant::FLOAT||double(edges[i])<(i<4?0:-1e6)||double(edges[i])>(i<4?1:1e6)){fail("E_LAYOUT: invalid layout edge");return;}if(double(edges[0])>double(edges[2])||double(edges[1])>double(edges[3])){fail("E_LAYOUT: anchors must be ordered");return;}owned->layout=edges;for(int i=0;i<4;++i)control->set_anchor(Side(i),edges[i],false,true);for(int i=0;i<4;++i)control->set_offset(Side(i),edges[i+4]);}if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->layout.is_empty()?Variant():Variant(owned->layout),result)){fail("E_LAYOUT: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(property==StringName("__react_viewport_texture")||property==StringName("__react_bus")){
                const bool viewport=property==StringName("__react_viewport_texture");if(viewport&&!node->is_class("Sprite2D")&&!node->is_class("TextureRect")){fail("E_VIEWPORT_PATH: unsupported texture target");return;}
                if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!info[3]->IsString()){fail("E_PROPERTY_PROFILE: binding requires a string and commit");return;}const String value=impl::Helper::to_string(isolate,info[3]);if(value.length()>512){fail("E_PROPERTY_PROFILE: binding too long");return;}if(viewport){const NodePath path(value);if(path.is_absolute()||path.get_subname_count()){fail("E_VIEWPORT_PATH: expected local source");return;}if(owned->viewport_path!=value){owned->viewport_path=value;node->set("texture",Variant());}}else{if(!value.is_empty()&&!root->audio_buses.has(value)){fail("E_AUDIO_BUS: bus is not registered in this root");return;}owned->audio_bus=value;}if(!verify())return;}
                info.GetReturnValue().Set(impl::Helper::new_string(isolate,viewport?owned->viewport_path:owned->audio_bus));return;
            }
            if(property==StringName("bus")&&(node->is_class("AudioStreamPlayer")||node->is_class("AudioStreamPlayer2D")||node->is_class("AudioStreamPlayer3D"))){
                String logical=node->get("bus");for(const KeyValue<StringName,StringName>& entry:root->audio_buses)if(entry.value==logical){logical=entry.key;break;}
                if(op==SET){if(!state.mutation_stage(*root)||info.Length()!=4||!info[3]->IsString()){fail("E_AUDIO_BUS: bus requires commit");return;}logical=impl::Helper::to_string(isolate,info[3]);const StringName* scoped=root->audio_buses.getptr(logical);const String physical=scoped?String(*scoped):logical;if(AudioServer::get_singleton()->get_bus_index(physical)<0){fail("E_AUDIO_BUS: bus does not exist");return;}node->set("bus",physical);if(!verify())return;}
                info.GetReturnValue().Set(impl::Helper::new_string(isolate,logical));return;
            }
            const String prop_text=property;
            if(node->is_class("Label")&&(prop_text=="theme_override_colors/font_outline_color"||prop_text=="theme_override_colors/font_shadow_color"||prop_text=="theme_override_constants/outline_size"||prop_text=="theme_override_constants/shadow_offset_x"||prop_text=="theme_override_constants/shadow_offset_y"||prop_text=="theme_override_constants/shadow_outline_size")){
                Control* label=Object::cast_to<Control>(node);const bool color=prop_text.begins_with("theme_override_colors/");const StringName name=prop_text.get_slice("/",1);if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,color?Variant::COLOR:Variant::INT)){fail("E_LABEL_STYLE: invalid value or phase");return;}if(color)label->add_theme_color_override(name,value);else{const bool offset=String(name).begins_with("shadow_offset_");if(int64_t(value)<(offset?-256:0)||int64_t(value)>(offset?256:64)){fail("E_LABEL_STYLE: constant out of bounds");return;}label->add_theme_constant_override(name,value);}if(!verify())return;}const Variant stored=color?Variant(label->get_theme_color(name)):Variant(label->get_theme_constant(name));v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,stored,encoded)){fail("E_LABEL_STYLE: invalid result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(prop_text.begins_with("theme_override_"))
            {
                Control* control=Object::cast_to<Control>(node);if(!control){fail("E_PROPERTY_PROFILE: theme requires Control");return;}
                const bool font=prop_text=="theme_override_fonts/font",size=prop_text=="theme_override_font_sizes/font_size",color=prop_text=="theme_override_colors/font_color",style=prop_text=="theme_override_styles/separator"||prop_text=="theme_override_styles/panel"||(node->is_class("BaseButton")&&(prop_text=="theme_override_styles/normal"||prop_text=="theme_override_styles/hover"||prop_text=="theme_override_styles/pressed"||prop_text=="theme_override_styles/disabled"||prop_text=="theme_override_styles/focus"));
                const StringName style_name=style?StringName(prop_text.trim_prefix("theme_override_styles/")):StringName();
                if(!(font||size||color||style)&&!prop_text.begins_with("theme_override_constants/margin_")){fail("E_PROPERTY_PROFILE: unsupported theme override");return;}
                if(font||size||color||style){
                    if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,size?Variant::INT:color?Variant::COLOR:Variant::OBJECT)){fail("E_VALUE_CODEC: invalid theme value");return;}
                        if(size){if(int64_t(value)<1||int64_t(value)>256){fail("E_VALUE_CODEC: invalid font size");return;}control->add_theme_font_size_override("font_size",value);}
                        else if(color)control->add_theme_color_override("font_color",value);
                        else if(font){Ref<Font> resource=value;if(!value.is_null()&&resource.is_null()){fail("E_ASSET_TYPE: font required");return;}if(resource.is_valid())control->add_theme_font_override("font",resource);else control->remove_theme_font_override("font");}
                        else{Ref<StyleBox> resource=value;if(!value.is_null()&&resource.is_null()){fail("E_ASSET_TYPE: style required");return;}if(resource.is_valid())control->add_theme_style_override(style_name,resource);else control->remove_theme_style_override(style_name);}
                        if(!verify())return;
                    }
                    Variant result=size?Variant(control->get_theme_font_size("font_size")):color?Variant(control->get_theme_color("font_color")):font?(control->has_theme_font_override("font")?Variant(control->get_theme_font("font")):Variant()):(control->has_theme_stylebox_override(style_name)?Variant(control->get_theme_stylebox(style_name)):Variant());
                    v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_VALUE_CODEC: invalid theme result");return;}info.GetReturnValue().Set(encoded);return;
                }
            }
            if(property==StringName("__react_options")||property==StringName("__react_multimesh")){
                OptionButton* options=Object::cast_to<OptionButton>(node);const bool mesh=property==StringName("__react_multimesh");
                if((!mesh&&!options)||(mesh&&!node->is_class("MultiMeshInstance2D")&&!node->is_class("MultiMeshInstance3D"))){fail("E_PROPERTY_PROFILE: invalid special property target");return;}
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||info.Length()!=4||!state.safe_from_js(*root,context,info[3],value,mesh?Variant::OBJECT:Variant::ARRAY)){fail("E_VALUE_CODEC: invalid special property");return;}
                    if(mesh){Ref<MultiMesh> source=value;if(!value.is_null()&&source.is_null()){fail("E_ASSET_TYPE: MultiMesh required");return;}if(source.is_valid()&&(source->get_instance_count()>65536||source->get_transform_format()!=(node->is_class("MultiMeshInstance2D")?MultiMesh::TRANSFORM_2D:MultiMesh::TRANSFORM_3D))){fail("E_MULTIMESH: format/count mismatch");return;}if(owned->multimesh_source!=source){if(!state.refine_batch_budget(*root,node,state.refine_batch_bytes(source))){fail("E_MULTIMESH_BUDGET: Root buffers exceed 32 MB");return;}owned->multimesh_source=source;node->set("multimesh",state.refine_copy_batch(source));}}
                    else {Array items=value;if(items.size()>1024){fail("E_OPTIONS: too many options");return;}for(int i=0;i<items.size();++i)if(items[i].get_type()!=Variant::STRING||String(items[i]).length()>256){fail("E_OPTIONS: invalid item");return;}options->clear();for(int i=0;i<items.size();++i)options->add_item(items[i]);}
                    if(!verify())return;
                }
                Variant result;if(mesh)result=owned->multimesh_source;else{Array items;for(int i=0;i<options->get_item_count();++i)items.push_back(options->get_item_text(i));result=items;}
                v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_VALUE_CODEC: special property result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(property==StringName("__react_packed_scene")||property==StringName("__react_skeleton_profile")||property==StringName("__react_animation_library"))
            {
                const bool prefab=property==StringName("__react_packed_scene"),library=property==StringName("__react_animation_library");
                AnimationPlayer* player=library?Object::cast_to<AnimationPlayer>(node):nullptr;
                if(library&&!player){fail("E_PROPERTY_PROFILE: library requires AnimationPlayer");return;}
                if(prefab&&!node->is_class("Node2D")&&!node->is_class("Node3D")){fail("E_PROPERTY_PROFILE: scene host must be spatial");return;}
                Skeleton3D* skeleton=(prefab||library)?nullptr:Object::cast_to<Skeleton3D>(node);
                if(!prefab&&!library&&!skeleton){fail("E_PROPERTY_PROFILE: skeleton profile requires Skeleton3D");return;}
                if(op==SET)
                {
                    if(!state.mutation_stage(*root)||info.Length()!=4){fail("E_PHASE: native scene configuration requires a commit");return;}
                    Variant value;if(!state.safe_from_js(*root,context,info[3],value,Variant::OBJECT)){fail("E_ASSET_CODEC: registered scene/profile required");return;}
                    if(prefab)
                    {
                        Ref<PackedScene> scene=value;
                        if(!value.is_null()&&scene.is_null()){fail("E_ASSET_TYPE: PackedScene required");return;}
                        if(owned->prefab!=scene)
                        {
                            Node* instance=scene.is_valid()?scene->instantiate():nullptr;
                            int budget=4096;
                            if(scene.is_valid()&&(!instance||!validate_scene_targets(instance,instance,budget)||state.subtree_particles(instance)>65536||!state.prepare_prefab(*root,instance,instance))){if(instance)memdelete(instance);fail("E_SCENE_PROFILE: scene targets must remain inside the instance");return;}
                            if(owned->prefab_root.is_valid())if(Node* previous=Object::cast_to<Node>(compat::ObjectDB::get_instance(owned->prefab_root)))memdelete(previous);
                            owned->prefab=scene;owned->prefab_root=ObjectID();
                            if(instance){instance->set_name("__godot_react_prefab");node->add_child(instance,false,Node::INTERNAL_MODE_BACK);owned->prefab_root=instance->get_instance_id();}
                        }
                    }
                    else if(library)
                    {
                        Ref<AnimationLibrary> animation_library=value;
                        if(!value.is_null()&&animation_library.is_null()){fail("E_ASSET_TYPE: AnimationLibrary required");return;}
                        Ref<AnimationLibrary> previous=player->has_animation_library(StringName())?player->get_animation_library(StringName()):Ref<AnimationLibrary>();
                        if(previous!=animation_library){if(previous.is_valid())player->remove_animation_library(StringName());if(animation_library.is_valid()&&player->add_animation_library(StringName(),animation_library)!=OK){fail("E_ANIMATION_LIBRARY: cannot bind library");return;}}
                    }
                    else
                    {
                        Ref<SkeletonProfile> profile=value;
                        if(!value.is_null()&&profile.is_null()){fail("E_ASSET_TYPE: SkeletonProfile required");return;}
                        if(owned->skeleton_profile!=profile)
                        {
                            if(!apply_skeleton_profile(skeleton,profile)){fail("E_SKELETON_PROFILE: invalid bone hierarchy");return;}
                            owned->skeleton_profile=profile;
                        }
                    }
                    if(!verify())return;
                }
                v8::Local<v8::Value> encoded;const Variant result=prefab?Variant(owned->prefab):library?Variant(player->has_animation_library(StringName())?player->get_animation_library(StringName()):Ref<AnimationLibrary>()):Variant(owned->skeleton_profile);
                if(!state.safe_to_js(*root,context,result,encoded)){fail("E_ASSET_CODEC: cannot expose scene/profile reference");return;}info.GetReturnValue().Set(encoded);return;
            }
            bool valid = false;
            const String property_text = property;
            const bool margin_property = property_text == "theme_override_constants/margin_left"
                || property_text == "theme_override_constants/margin_right" || property_text == "theme_override_constants/margin_top"
                || property_text == "theme_override_constants/margin_bottom";
            Control* margin_control = margin_property && node->is_class("MarginContainer") ? Object::cast_to<Control>(node) : nullptr;
            if (margin_property && !margin_control) { fail("E_PROPERTY_PERMISSION: margin constants require MarginContainer"); return; }
            const StringName margin_name = margin_property ? StringName(property_text.trim_prefix("theme_override_constants/")) : StringName();
            const Variant previous = margin_control ? Variant(margin_control->get_theme_constant(margin_name)) : node->get(property, &valid);
            if (margin_control) valid = true;
            if (!valid) { fail("E_PROPERTY: unknown native property"); return; }
            if(op==SET&&(property==StringName("node_a")||property==StringName("node_b"))){if(info.Length()!=4||!info[3]->IsString()){fail("E_JOINT_PATH: expected local path");return;}const String text=impl::Helper::to_string(isolate,info[3]);NodePath path(text);if(path.is_absolute()||path.get_subname_count()||text.contains("../..")){fail("E_JOINT_PATH: path escapes joint scope");return;}}
            if (op == READ)
            {
                v8::Local<v8::Value> result;
                if (!state.safe_to_js(*root, context, previous, result)) { fail("E_VALUE_CODEC: native value cannot cross the safe bridge"); return; }
                info.GetReturnValue().Set(result); return;
            }
            if (!state.mutation_stage(*root) || info.Length() != 4 || !mutable_property(property)) { fail("E_PROPERTY_PERMISSION: " + String(property) + " unsupported property or wrong stage"); return; }
            if (property == StringName("name") && node->get_parent()) { fail("E_CONSTRUCTION_PROP: name is fixed after attachment"); return; }
            Variant value;
            if (!state.safe_from_js(*root, context, info[3], value, previous.get_type())) { fail("E_VALUE_CODEC: invalid property value"); return; }
            {int minimum=0,maximum=-1;if(property==StringName("process_mode"))maximum=4;else if(property==StringName("attenuation_model"))maximum=3;else if(property==StringName("center_of_mass_mode")||property==StringName("linear_damp_mode")||property==StringName("angular_damp_mode")||property==StringName("process_callback"))maximum=1;else if(property==StringName("billboard"))maximum=2;else if(property==StringName("mouse_default_cursor_shape"))maximum=16;else if(property==StringName("max_polyphony")){minimum=1;maximum=64;}if(maximum>=0&&(value.get_type()!=Variant::INT||int64_t(value)<minimum||int64_t(value)>maximum)){fail("E_VALUE_CODEC: enum or count out of range");return;}}
            if(!state.refine_property(*root,*owned,node,property,value)){fail("E_REFINEMENT_PROPERTY: invalid range, curve or clipping hierarchy");return;}
            if(!state.workflow_property(node,property,value)){fail("E_WORKFLOW_PROPERTY: bounded value required");return;}
            if(!state.composition_property(node,property,value)){fail("E_COMPOSITION_PROPERTY: value outside bounded profile");return;}
            if(!state.usability_property(*owned,node,property,value)){fail("E_USABILITY_PROPERTY: value outside bounded profile");return;}
            if(!state.fidelity_property(node,property,value)){fail("E_FIDELITY_PROPERTY: value outside bounded profile");return;}
            if((node->is_class("GPUParticles2D")||node->is_class("GPUParticles3D"))&&property==StringName("amount"))if(value.get_type()!=Variant::INT||int64_t(value)<1||int64_t(value)>16384){fail("E_GPU_BUDGET: per-emitter amount");return;}
            if(node->is_class("Parallax2D")){if(property==StringName("repeat_times")&&(int64_t(value)<1||int64_t(value)>16)){fail("E_PARALLAX_BUDGET: repeatTimes 1..16");return;}if(property==StringName("repeat_size")){const Vector2 size=value;if(size.x<0||size.y<0||size.x>16384||size.y>16384){fail("E_PARALLAX_BUDGET: repeatSize");return;}}if(property==StringName("scale")){const Vector2 scale=value;if(scale.x<=0||scale.y<=0){fail("E_PARALLAX_BUDGET: positive scale required");return;}}}
            if(Range* range=Object::cast_to<Range>(node)){if(property==StringName("min_value")&&double(value)>range->get_max())range->set_max(value);if(property==StringName("max_value")&&double(value)<range->get_min())range->set_min(value);}
            if (margin_control) margin_control->add_theme_constant_override(margin_name, value);
            else node->set(property, value, &valid);
            if (!valid) { fail("E_NATIVE_SET: native rejected the property"); return; }
            node = state.resolve(*root, key);
            if (!node) { fail("E_NATIVE_LOST: property setter retired its target"); return; }
            if (property == StringName("name")) owned->name = node->get_name();
            if (!verify()) return;
            const Variant stored = margin_property ? Variant(Object::cast_to<Control>(node)->get_theme_constant(margin_name)) : node->get(property, &valid);
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
            state.unbind_joints(*root);
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
            if(!state.refine_clips(child,node)){fail("E_CANVAS_CLIP_SCOPE: nested clipping or CanvasGroup combination");return;}
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
            if(method_text.begins_with("__react_refine_")){
                if(root->stage!="process"){fail("E_REFINEMENT_COMMAND: process required");return;}const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_REFINEMENT_COMMAND: invalid argument");return;}args.push_back(value);}Variant result;if(!state.refine_command(*root,*owned,node,method_text.trim_prefix("__react_refine_"),args,result)){fail("E_REFINEMENT_COMMAND: invalid target, bounds or state");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_REFINEMENT_COMMAND: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_workflows_")){
                if(root->stage!="process"){fail("E_WORKFLOW_COMMAND: process required");return;}const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_WORKFLOW_COMMAND: invalid argument");return;}args.push_back(value);}Variant result;if(!state.workflow_command(*owned,node,method_text.trim_prefix("__react_workflows_"),args,result)){fail("E_WORKFLOW_COMMAND: invalid target or bounds");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_WORKFLOW_COMMAND: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_composition_")){
                if(root->stage!="process"){fail("E_COMPOSITION_COMMAND: process phase required");return;}const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_COMPOSITION_COMMAND: invalid argument");return;}args.push_back(value);}Variant result;if(!state.composition_command(*owned,node,method_text.trim_prefix("__react_composition_"),args,result)){fail("E_COMPOSITION_COMMAND: invalid target, bounds or arguments");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMPOSITION_COMMAND: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_usability_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_USABILITY_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.usability_command(*root,*owned,node,method_text.trim_prefix("__react_usability_"),args,result)){fail("E_USABILITY_COMMAND: invalid target, phase, range or text");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_USABILITY_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_fidelity_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_FIDELITY_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.fidelity_command(*root,node,method_text.trim_prefix("__react_fidelity_"),args,result)){fail("E_FIDELITY_COMMAND: invalid phase, target, animation section or projection");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_FIDELITY_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_precision_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_PRECISION_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.precision_command(*root,node,method_text.trim_prefix("__react_precision_"),args,result)){fail("E_PRECISION_COMMAND: invalid target, phase, range or argument");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_PRECISION_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_details_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_DETAILS_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.details_command(*root,node,method_text.trim_prefix("__react_details_"),args,result)){fail("E_DETAILS_COMMAND: invalid target, phase, range, budget or argument");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_DETAILS_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_presentation_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_PRESENTATION_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.presentation_command(*root,node,method_text.trim_prefix("__react_presentation_"),args,result)){fail("E_PRESENTATION_COMMAND: invalid target, phase, range or argument");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_PRESENTATION_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_interaction_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t j=0;j<input->Length();++j){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,j).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_INTERACTION_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;if(!state.interaction_command(*root,*owned,node,method_text.trim_prefix("__react_interaction_"),args,result)){fail("E_INTERACTION_COMMAND: invalid target, phase or argument");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_INTERACTION_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_behavior_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t i=0;i<input->Length();++i){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,i).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_BEHAVIOR_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;
                if(!state.behavior_command(*root,*owned,node,method_text.trim_prefix("__react_behavior_"),args,result)){fail("E_BEHAVIOR_COMMAND: invalid phase, target or argument");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_BEHAVIOR_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_gameplay_")){
                const auto input=info[3].As<v8::Array>();Array args;for(uint32_t i=0;i<input->Length();++i){v8::Local<v8::Value> item;Variant value;if(!input->Get(context,i).ToLocal(&item)||!state.safe_from_js(*root,context,item,value)){fail("E_GAMEPLAY_ARGUMENT: invalid value");return;}args.push_back(value);}Variant result;
                if(!state.gameplay_command(*root,node,method_text.trim_prefix("__react_gameplay_"),args,result)){fail("E_GAMEPLAY_COMMAND: invalid phase, argument or target");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_GAMEPLAY_RESULT: unsupported result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text=="__react_viewport_pixel"){
                SubViewport* viewport=Object::cast_to<SubViewport>(node);const auto input=info[3].As<v8::Array>();v8::Local<v8::Value> item;Variant value;
                if(root->stage!="process"||!viewport||input->Length()!=1||!input->Get(context,0).ToLocal(&item)||!state.safe_from_js(*root,context,item,value,Variant::VECTOR2I)){fail("E_VIEWPORT_PIXEL: viewport pixel query requires process");return;}const Vector2i point=value;const Vector2i size=viewport->get_size();if(point.x<0||point.y<0||point.x>=size.x||point.y>=size.y){fail("E_VIEWPORT_PIXEL: pixel outside texture");return;}Ref<Image> data=viewport->get_texture()->get_image();const Color color=data.is_valid()&&!data->is_empty()?data->get_pixel(point.x,point.y):Color(0,0,0,0);v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,color,result))return;info.GetReturnValue().Set(result);return;
            }
            if(method_text.begins_with("__react_space_")){
                if(root->stage!="physics"){fail("E_COMMAND_PHASE: space queries require physics dispatch");return;}const auto input=info[3].As<v8::Array>();v8::Local<v8::Value> item;Variant value,result;
                if(input->Length()!=1||!input->Get(context,0).ToLocal(&item)||!state.safe_from_js(*root,context,item,value,Variant::ARRAY)||!state.advanced_query(*root,node,method_text.trim_prefix("__react_space_"),value,result)){fail("E_PHYSICS_QUERY: invalid scoped query");return;}
                if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMMAND_CODEC: query result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_audio_")){
                if(root->stage!="process"){fail("E_COMMAND_PHASE: audio bus commands require process");return;}const StringName* physical=root->audio_buses.getptr(owned->audio_bus);AudioServer* server=AudioServer::get_singleton();const int index=physical?server->get_bus_index(*physical):-1;if(index<1){fail("E_AUDIO_BUS: scoped bus required");return;}
                const auto input=info[3].As<v8::Array>();std::vector<Variant> args(input->Length());for(uint32_t i=0;i<input->Length();++i){v8::Local<v8::Value> item;if(!input->Get(context,i).ToLocal(&item)||!state.safe_from_js(*root,context,item,args[i])){fail("E_COMMAND_CODEC: audio argument");return;}}
                const String operation=method_text.trim_prefix("__react_audio_");Variant result;bool valid=false;
                if(operation=="volume"&&args.size()==1&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=-80&&double(args[0])<=12){server->set_bus_volume_db(index,args[0]);valid=true;}
                else if((operation=="mute"||operation=="solo")&&args.size()==1&&args[0].get_type()==Variant::BOOL){if(operation=="mute")server->set_bus_mute(index,args[0]);else server->set_bus_solo(index,args[0]);valid=true;}
                else if(operation=="effect"&&args.size()==2&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=0&&double(args[0])<server->get_bus_effect_count(index)&&Math::floor(double(args[0]))==double(args[0])&&args[1].get_type()==Variant::BOOL){server->set_bus_effect_enabled(index,int(args[0]),args[1]);valid=true;}
                else if((operation=="effect_set"||operation=="effect_get")&&state.audio_effect_parameter(server,index,operation,args,result)){valid=true;}
                else if(operation=="get_volume"&&args.empty()){result=server->get_bus_volume_db(index);valid=true;}
                else if(operation=="get_mute"&&args.empty()){result=server->is_bus_mute(index);valid=true;}
                else if(operation=="peaks"&&args.empty()){result=Vector2(server->get_bus_peak_volume_left_db(index,0),server->get_bus_peak_volume_right_db(index,0));valid=true;}
                if(!valid){fail("E_AUDIO_COMMAND: invalid bus operation");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMMAND_CODEC: audio result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text=="__react_blend_names"){
                MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(root->stage!="process"||!mesh||info[3].As<v8::Array>()->Length()!=0){fail("E_BLEND_SHAPE: invalid target");return;}Array names;for(int i=0;i<mesh->get_blend_shape_count();++i)names.push_back(mesh->get_mesh()->get_blend_shape_name(i));v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,names,encoded))return;info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_tween_")||method_text.begins_with("__react_multimesh_")||method_text.begins_with("__react_query_")){
                const bool query=method_text.begins_with("__react_query_");if(root->stage!=(query?"physics":"process")){fail("E_COMMAND_PHASE: extension command outside frame phase");return;}
                const auto input=info[3].As<v8::Array>();std::vector<Variant> args(input->Length());
                for(uint32_t i=0;i<input->Length();++i){v8::Local<v8::Value> item;if(!input->Get(context,i).ToLocal(&item)||!state.safe_from_js(*root,context,item,args[i])){fail("E_COMMAND_CODEC: invalid extension argument");return;}}
                Variant result;bool valid=false;
                if(method_text.begins_with("__react_tween_")){
                    const String operation=method_text.trim_prefix("__react_tween_");
                    if(operation=="start"&&args.size()==1&&args[0].get_type()==Variant::ARRAY){Array plan=args[0];bool okay=plan.size()>=2&&plan.size()<=129&&plan[0].get_type()==Variant::ARRAY;Array config=okay?Array(plan[0]):Array();okay=okay&&config.size()==1&&config[0].get_type()==Variant::FLOAT&&double(config[0])==Math::floor(double(config[0]));int loops=okay?int(config[0]):-1;okay=okay&&loops>=0&&loops<=1000000;double duration=0;
                        for(int i=1;okay&&i<plan.size();++i){if(plan[i].get_type()!=Variant::ARRAY){okay=false;break;}Array step=plan[i];if(step.size()!=7||step[0].get_type()!=Variant::STRING){okay=false;break;}String property=step[0];Variant current=node->get(property);if((property!="position"&&property!="rotation"&&property!="scale")||current.get_type()!=step[1].get_type()||step[2].get_type()!=Variant::FLOAT||step[3].get_type()!=Variant::FLOAT||double(step[2])<0||double(step[3])<0||double(step[2])>86400||double(step[3])>86400||step[4].get_type()!=Variant::FLOAT||step[5].get_type()!=Variant::FLOAT||double(step[4])!=Math::floor(double(step[4]))||double(step[5])!=Math::floor(double(step[5]))||int(step[4])<0||int(step[4])>11||int(step[5])<0||int(step[5])>3||step[6].get_type()!=Variant::BOOL)okay=false;else duration+=double(step[2])+double(step[3]);}
                        if(okay&&duration>0&&node->is_inside_tree()&&(Object::cast_to<Node2D>(node)||Object::cast_to<Node3D>(node))){Ref<Tween> tween=node->create_tween();tween->set_loops(loops);for(int i=1;i<plan.size();++i){Array step=plan[i];if(bool(step[6]))tween->parallel();else tween->chain();Ref<PropertyTweener> property=tween->tween_property(node,NodePath(String(step[0])),step[1],step[2]);property->set_delay(step[3]);property->set_trans(Tween::TransitionType(int(step[4])));property->set_ease(Tween::EaseType(int(step[5])));}if(owned->tween.is_valid())owned->tween->kill();owned->tween=tween;valid=true;}
                    }else if(operation=="running"&&args.empty()){result=owned->tween.is_valid()&&owned->tween->is_running();valid=true;}
                    else if(operation=="cancel"&&args.empty()){if(owned->tween.is_valid())owned->tween->kill();owned->tween.unref();valid=true;}
                    else if(owned->tween.is_valid()){if(operation=="pause"&&args.empty()){owned->tween->pause();valid=true;}else if(operation=="resume"&&args.empty()){owned->tween->play();valid=true;}else if(operation=="advance"&&args.size()==1&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=0&&double(args[0])<=86400){owned->tween->custom_step(args[0]);valid=true;}}
                }else if(method_text.begins_with("__react_multimesh_")){
                    Ref<MultiMesh> mesh=node->get("multimesh");if(mesh.is_valid()&&(node->is_class("MultiMeshInstance2D")||node->is_class("MultiMeshInstance3D"))){const String operation=method_text.trim_prefix("__react_multimesh_");
                        if(operation=="count"&&args.empty()){result=mesh->get_instance_count();valid=true;}
                        else if(operation=="buffer"&&args.size()==1&&args[0].get_type()==Variant::ARRAY){Array data=args[0];const int stride=(mesh->get_transform_format()==MultiMesh::TRANSFORM_2D?8:12)+(mesh->is_using_colors()?4:0)+(mesh->is_using_custom_data()?4:0);if(data.size()==mesh->get_instance_count()*stride){PackedFloat32Array buffer;buffer.resize(data.size());valid=true;for(int i=0;i<data.size();++i){if(data[i].get_type()!=Variant::FLOAT||!std::isfinite(float(double(data[i])))||(mesh->is_using_custom_data()&&i%stride>=stride-4&&Math::abs(double(data[i]))>65504)){valid=false;break;}buffer.set(i,data[i]);}if(valid)mesh->set("buffer",buffer);}}
                        else if(args.size()>=1&&args[0].get_type()==Variant::FLOAT&&double(args[0])==Math::floor(double(args[0]))&&double(args[0])>=0&&double(args[0])<mesh->get_instance_count()){const int index=int(args[0]);if(operation=="position"&&args.size()==1){const bool two=mesh->get_transform_format()==MultiMesh::TRANSFORM_2D;const int stride=(two?8:12)+(mesh->is_using_colors()?4:0)+(mesh->is_using_custom_data()?4:0);const PackedFloat32Array buffer=mesh->get("buffer");if(buffer.size()>=stride*(index+1)){const int start=index*stride;if(two)result=Vector2(buffer[start+3],buffer[start+7]);else result=Vector3(buffer[start+3],buffer[start+7],buffer[start+11]);}else if(two)result=mesh->get_instance_transform_2d(index).get_origin();else result=mesh->get_instance_transform(index).origin;valid=true;}else if(operation=="color"&&args.size()==2&&args[1].get_type()==Variant::COLOR&&mesh->is_using_colors()){mesh->set_instance_color(index,args[1]);valid=true;}else if(operation=="transform3"&&args.size()==2&&args[1].get_type()==Variant::TRANSFORM3D&&mesh->get_transform_format()==MultiMesh::TRANSFORM_3D){mesh->set_instance_transform(index,args[1]);valid=true;}else if(operation=="transform2"&&args.size()==4&&args[1].get_type()==Variant::VECTOR2&&args[2].get_type()==Variant::FLOAT&&args[3].get_type()==Variant::VECTOR2&&mesh->get_transform_format()==MultiMesh::TRANSFORM_2D){Transform2D transform(double(args[2]),Vector2(args[3]),0,Vector2(args[1]));mesh->set_instance_transform_2d(index,transform);valid=true;}}
                    }
                }else{
                    const bool three=method_text.ends_with("3"),ray=method_text=="__react_query_ray2"||method_text=="__react_query_ray3",shape=method_text=="__react_query_shape2"||method_text=="__react_query_shape3";
                    const Variant::Type vector=three?Variant::VECTOR3:Variant::VECTOR2;
                    if((ray||shape)&&args.size()==(ray?5:6)&&args[1].get_type()==vector&&args[2].get_type()==Variant::FLOAT&&double(args[2])>=0&&double(args[2])<=4294967295.0&&Math::floor(double(args[2]))==double(args[2])&&args[3].get_type()==Variant::BOOL&&args[4].get_type()==Variant::BOOL){Array hits;const uint32_t mask=uint32_t(int64_t(args[2]));const bool areas=args[3],bodies=args[4];if(!ray&&(args[5].get_type()!=Variant::FLOAT||double(args[5])<1||double(args[5])>64||Math::floor(double(args[5]))!=double(args[5]))){fail("E_QUERY: invalid result limit");return;}const int max=ray?1:int(args[5]);
                        if(three){Node3D* spatial=Object::cast_to<Node3D>(node);PhysicsDirectSpaceState3D* space=spatial&&spatial->get_world_3d().is_valid()?spatial->get_world_3d()->get_direct_space_state():nullptr;if(space){if(ray&&args[0].get_type()==vector){PhysicsDirectSpaceState3D::RayParameters parameters;parameters.from=args[0];parameters.to=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState3D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}valid=true;}else if(shape){Ref<Shape3D> resource=args[0];if(resource.is_valid()){PhysicsDirectSpaceState3D::ShapeParameters parameters;parameters.shape_rid=resource->get_rid();parameters.transform.origin=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState3D::ShapeResult results[64];int count=space->intersect_shape(parameters,results,max);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}valid=true;}}}}
                        else{Node2D* spatial=Object::cast_to<Node2D>(node);PhysicsDirectSpaceState2D* space=spatial&&spatial->get_world_2d().is_valid()?spatial->get_world_2d()->get_direct_space_state():nullptr;if(space){if(ray&&args[0].get_type()==vector){PhysicsDirectSpaceState2D::RayParameters parameters;parameters.from=args[0];parameters.to=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState2D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}valid=true;}else if(shape){Ref<Shape2D> resource=args[0];if(resource.is_valid()){PhysicsDirectSpaceState2D::ShapeParameters parameters;parameters.shape_rid=resource->get_rid();parameters.transform.set_origin(args[1]);parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState2D::ShapeResult results[64];int count=space->intersect_shape(parameters,results,max);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}valid=true;}}}}
                        result=hits;
                    }
                }
                if(!valid){fail("E_EXTENSION_COMMAND: invalid operation, target or arguments");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMMAND_CODEC: invalid extension result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(method_text.begins_with("__react_scene_")||method_text.begins_with("__react_tree_"))
            {
                if(root->stage!="process"){fail("E_COMMAND_PHASE: scene/tree commands require process dispatch");return;}
                const auto input=info[3].As<v8::Array>();
                auto string_arg=[&](uint32_t i,String& value){v8::Local<v8::Value> item;if(i>=input->Length()||!input->Get(context,i).ToLocal(&item)||!item->IsString())return false;value=impl::Helper::to_string(isolate,item);return true;};
                auto value_arg=[&](uint32_t i,Variant& value,Variant::Type hint){v8::Local<v8::Value> item;return i<input->Length()&&input->Get(context,i).ToLocal(&item)&&state.safe_from_js(*root,context,item,value,hint);};
                Variant result;bool valid=false;
                if(method_text.begins_with("__react_tree_"))
                {
                    AnimationTree* tree=Object::cast_to<AnimationTree>(node);String name;
                    const String operation=method_text.trim_prefix("__react_tree_");
                    if((operation=="travel_at"||operation=="start_at"||operation=="state_at")&&input->Length()==(operation=="state_at"?1:2)&&string_arg(0,name)){String state_name;if(operation=="state_at"||string_arg(1,state_name))valid=state.tree_state_at(tree,name,operation=="travel_at"?"travel":operation=="start_at"?"start":"state",state_name,result);}
                    else if(operation=="state"&&input->Length()==0)valid=tree_state(tree,"state",StringName(),result);
                    else if((operation=="travel"||operation=="start")&&input->Length()==1&&string_arg(0,name))valid=tree_state(tree,operation,name,result);
                    else if((operation=="number"||operation=="integer"||operation=="boolean"||operation=="vector2")&&input->Length()==2&&string_arg(0,name)){Variant value;const Variant::Type hint=operation=="number"?Variant::FLOAT:operation=="integer"?Variant::INT:operation=="boolean"?Variant::BOOL:Variant::VECTOR2;if(value_arg(1,value,hint))valid=tree_parameter(tree,name,value);}
                }
                else
                {
                    Node* scene=Object::cast_to<Node>(compat::ObjectDB::get_instance(owned->prefab_root));
                    const String operation=method_text.trim_prefix("__react_scene_");String path;
                    if(operation=="nodes"&&input->Length()==0&&scene){Array paths;Vector<Node*> pending;pending.push_back(scene);while(!pending.is_empty()){Node* current=pending[pending.size()-1];pending.resize(pending.size()-1);paths.push_back(scene->get_path_to(current));for(int i=current->get_child_count(false)-1;i>=0;--i)pending.push_back(current->get_child(i,false));}result=paths;valid=true;}
                    else if(string_arg(0,path))if(Node* target=scene_target(scene,path))
                    {
                        AnimationPlayer* player=Object::cast_to<AnimationPlayer>(target);Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(target);
                        if(operation=="blend_names"&&input->Length()==1){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Array names;for(int i=0;i<mesh->get_blend_shape_count();++i)names.push_back(mesh->get_mesh()->get_blend_shape_name(i));result=names;valid=true;}}
                        else if(operation=="blend_get"&&input->Length()==2){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Variant index;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<mesh->get_blend_shape_count()){result=mesh->get_blend_shape_value(index);valid=true;}}}
                        else if(operation=="blend_set"&&input->Length()==3){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Variant index,value;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<mesh->get_blend_shape_count()&&value_arg(2,value,Variant::FLOAT)){mesh->set_blend_shape_value(index,value);valid=true;}}}
                        else if(operation=="animations"&&input->Length()==1&&player){List<StringName> names;player->get_animation_list(&names);Array values;for(const StringName& name:names)values.push_back(name);result=values;valid=true;}
                        else if(operation=="play"&&input->Length()==5&&player){String name;Variant blend,speed,back;if(string_arg(1,name)&&player->has_animation(name)&&value_arg(2,blend,Variant::FLOAT)&&value_arg(3,speed,Variant::FLOAT)&&value_arg(4,back,Variant::BOOL)){player->play(name,blend,speed,back);valid=true;}}
                        else if(operation=="pause"&&input->Length()==1&&player){player->pause();valid=true;}
                        else if(operation=="seek"&&input->Length()==3&&player){Variant seconds,update;if(value_arg(1,seconds,Variant::FLOAT)&&double(seconds)>=0&&value_arg(2,update,Variant::BOOL)){player->seek(seconds,update);valid=true;}}
                        else if(operation=="stop"&&input->Length()==2&&player){Variant keep;if(value_arg(1,keep,Variant::BOOL)){player->stop(keep);valid=true;}}
                        else if(operation=="advance"&&input->Length()==2){if(AnimationMixer* mixer=Object::cast_to<AnimationMixer>(target)){Variant delta;if(value_arg(1,delta,Variant::FLOAT)){mixer->advance(delta);valid=true;}}}
                        else if(operation=="position2d"&&input->Length()==1){if(Node2D* spatial=Object::cast_to<Node2D>(target)){result=spatial->get_position();valid=true;}}
                        else if(operation=="position"&&input->Length()==1){if(Node3D* spatial=Object::cast_to<Node3D>(target)){result=spatial->get_position();valid=true;}}
                        else if(operation=="is_playing"&&input->Length()==1&&player){result=player->is_playing();valid=true;}
                        else if(operation=="animation_position"&&input->Length()==1&&player){result=player->get_current_animation_position();valid=true;}
                        else if(operation=="bone_reset"&&input->Length()==1&&skeleton){skeleton->reset_bone_poses();valid=true;}
                        else if(operation.begins_with("bone_set_")&&input->Length()==3&&skeleton){Variant index,value;const bool rotation=operation=="bone_set_rotation";if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<skeleton->get_bone_count()&&value_arg(2,value,rotation?Variant::QUATERNION:Variant::VECTOR3)){if(rotation)skeleton->set_bone_pose_rotation(index,value);else if(operation=="bone_set_position")skeleton->set_bone_pose_position(index,value);else if(operation=="bone_set_scale")skeleton->set_bone_pose_scale(index,value);else{fail("E_SCENE_COMMAND: unknown bone command");return;}valid=true;}}
                        else if(operation=="bone_count"&&input->Length()==1&&skeleton){result=skeleton->get_bone_count();valid=true;}
                        else if((operation=="bone_position"||operation=="bone_rotation")&&input->Length()==2&&skeleton){Variant index;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<skeleton->get_bone_count()){result=operation=="bone_position"?Variant(skeleton->get_bone_pose_position(index)):Variant(skeleton->get_bone_pose_rotation(index));valid=true;}}
                        else if((operation=="parameter"||operation=="parameter_integer"||operation=="parameter_boolean"||operation=="parameter_vector2")&&input->Length()==3){String name;Variant value;const Variant::Type hint=operation=="parameter_integer"?Variant::INT:operation=="parameter_boolean"?Variant::BOOL:operation=="parameter_vector2"?Variant::VECTOR2:Variant::FLOAT;if(string_arg(1,name)&&value_arg(2,value,hint))valid=tree_parameter(Object::cast_to<AnimationTree>(target),name,value);}
                        else if((operation=="travel"||operation=="start")&&input->Length()==2){String name;if(string_arg(1,name))valid=tree_state(Object::cast_to<AnimationTree>(target),operation,name,result);}
                        else if(operation=="state"&&input->Length()==1)valid=tree_state(Object::cast_to<AnimationTree>(target),"state",StringName(),result);
                    }
                }
                if(!valid){fail("E_SCENE_COMMAND: invalid scene path, command, parameter or target type");return;}
                if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMMAND_CODEC: scene result is not value data");return;}info.GetReturnValue().Set(encoded);return;
            }
            const bool reader = method_text.begins_with("get_") || method_text.begins_with("is_") || method_text.begins_with("has_");
            const bool physics = method_text == "move_and_slide" || method_text == "set_velocity" || method_text == "apply_impulse"
                || method_text == "apply_central_impulse" || method_text == "apply_force" || method_text == "apply_central_force"
                || method_text == "set_linear_velocity" || method_text == "set_angular_velocity" || method_text == "force_raycast_update" || method_text == "apply_torque" || method_text == "apply_torque_impulse" || method_text == "apply_floor_snap" || method_text == "set_target_position" || method_text == "force_shapecast_update";
            const bool transform = method_text == "set_position" || method_text == "set_global_position" || method_text == "set_rotation" || method_text == "set_scale";
            const bool cleanup = method_text == "stop" || method_text == "pause";
            const bool focus = method_text == "grab_focus" || method_text == "release_focus";
            const bool play = method_text == "play";
            const bool shader = method_text == "set_instance_shader_parameter";
            const bool projection = method_text == "project_local_ray_normal" || method_text == "unproject_position" || method_text == "project_ray_origin" || method_text == "project_ray_normal" || method_text == "local_to_map" || method_text == "map_to_local";
            const bool process_command = method_text == "seek" || method_text == "start" || method_text == "restart" || method_text == "reset_smoothing"
                || method_text == "add_animation_library" || method_text == "remove_animation_library"
                || method_text == "set_cell" || method_text == "erase_cell" || method_text == "clear"
                || method_text == "set_cells_terrain_connect" || method_text == "set_cell_item" || method_text == "advance" || method_text == "set_bone_pose_position" || method_text == "set_bone_pose_rotation"
                || method_text == "set_bone_pose_scale" || method_text == "reset_bone_poses" || method_text == "set_progress" || method_text == "set_current_tab" || method_text == "queue" || method_text == "clear_queue" || method_text == "set_blend_shape_value" || method_text == "set_update_mode";
            if ((!reader && !physics && !transform && !cleanup && !focus && !play && !shader && !projection && !process_command) || is_structural(method)) { fail("E_COMMAND_PROFILE: unsupported native command " + method_text); return; }
            if ((physics && root->stage != "physics") || (transform && root->stage != "physics" && root->stage != "process")
                || ((shader || process_command || projection) && root->stage != "process")
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
            if(node->is_class("Parallax2D")&&method_text=="set_scale"&&!values.empty()){const Vector2 scale=values[0];if(scale.x<=0||scale.y<=0){fail("E_PARALLAX_BUDGET: positive scale required");return;}}
            if(Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(node))if(method_text.contains("bone_")&&!values.empty()&&values[0].get_type()==Variant::INT&&(int64_t(values[0])<0||int64_t(values[0])>=skeleton->get_bone_count())){fail("E_SKELETON_BONE: bone index outside skeleton");return;}
            if(node->is_class("TabContainer")&&method_text=="set_current_tab"){const int count=node->call("get_tab_count");if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_TAB_INDEX: tab index outside current children");return;}}
            if((node->is_class("ShapeCast2D")||node->is_class("ShapeCast3D"))&&(method_text=="get_collider"||method_text=="get_collision_point"||method_text=="get_collision_normal")){const int count=node->call("get_collision_count");if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_SHAPE_INDEX: collision index outside current results");return;}}
            if((method_text=="get_blend_shape_value"||method_text=="set_blend_shape_value")&&node->is_class("MeshInstance3D")){const int count=Object::cast_to<MeshInstance3D>(node)->get_blend_shape_count();if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_BLEND_INDEX: index outside mesh blend shapes");return;}}
            if(method_text=="set_update_mode"&&(values.empty()||int64_t(values[0])<0||int64_t(values[0])>4)){fail("E_VIEWPORT_MODE: invalid update mode");return;}
            if(method_text=="queue"&&node->is_class("AnimationPlayer")&&(values.empty()||!Object::cast_to<AnimationPlayer>(node)->has_animation(values[0]))){fail("E_ANIMATION_NAME: unknown queued clip");return;}
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
