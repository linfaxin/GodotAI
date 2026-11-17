
#if !defined(_3D_DISABLED)
#include "scene/3d/visual_instance_3d.h"
#endif
#include "scene/gui/code_edit.h"
#include "scene/gui/menu_button.h"
#include "scene/gui/popup_menu.h"
#include "scene/resources/syntax_highlighter.h"
#include "scene/gui/tab_bar.h"
#include "scene/gui/text_edit.h"
#include "scene/gui/item_list.h"
#include "scene/gui/tab_container.h"
#include "jsb_engine_host_operations.h"
#include "jsb_environment.h"
#include "jsb_native_world.h"
#include "jsb_type_convert.h"
#include "../internal/jsb_variant_util.h"

#include "scene/main/node.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "scene/gui/control.h"
#include "scene/gui/line_edit.h"
#include "scene/gui/label.h"
#include "scene/gui/rich_text_label.h"
#include "scene/2d/tile_map_layer.h"
#include "scene/2d/path_2d.h"

#if !defined(_3D_DISABLED)
#include "scene/3d/path_3d.h"
#endif
#include "scene/gui/container.h"
#include "scene/gui/base_button.h"
#include "scene/resources/particle_process_material.h"
#include "scene/2d/gpu_particles_2d.h"

#if !defined(_3D_DISABLED)
#include "scene/3d/gpu_particles_3d.h"
#endif

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/3d/physics/spring_arm_3d.h"
#endif
#include "scene/resources/packed_scene.h"

#if !defined(_3D_DISABLED)
#include "scene/resources/skeleton_profile.h"
#endif
#if !defined(_3D_DISABLED)
#include "scene/3d/skeleton_3d.h"
#endif
#if !defined(_3D_DISABLED)
#include "scene/3d/node_3d.h"
#endif
#include "scene/2d/node_2d.h"
#include "scene/2d/physics/character_body_2d.h"

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/3d/physics/character_body_3d.h"
#endif
#include "scene/2d/physics/kinematic_collision_2d.h"

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/3d/physics/kinematic_collision_3d.h"
#endif
#include "scene/gui/scroll_container.h"

#if !defined(_3D_DISABLED)
#include "scene/3d/camera_3d.h"
#endif
#include "scene/2d/camera_2d.h"
#include "scene/main/canvas_item.h"
#include "scene/resources/material.h"
#include "scene/resources/atlas_texture.h"
#include "scene/resources/shader.h"
#include "scene/2d/navigation/navigation_agent_2d.h"

#if !defined(_3D_DISABLED) && !defined(NAVIGATION_3D_DISABLED)
#include "scene/3d/navigation/navigation_agent_3d.h"
#endif
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

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/resources/3d/shape_3d.h"
#endif
#include "scene/resources/world_2d.h"

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/resources/3d/world_3d.h"
#endif
#include "servers/physics_2d/physics_server_2d.h"

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "servers/physics_3d/physics_server_3d.h"
#endif
#include "scene/main/viewport.h"
#include "scene/gui/container.h"
#include "scene/gui/subviewport_container.h"

#if !defined(_3D_DISABLED)
#include "scene/3d/mesh_instance_3d.h"
#endif
#include "scene/2d/physics/collision_object_2d.h"

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
#include "scene/3d/physics/collision_object_3d.h"
#endif
#include "servers/audio/audio_server.h"
#include "core/io/image.h"
#include <atomic>
#include <cmath>

namespace jsb { namespace {
enum Operation { READ,SET,CALL,TOUCH,FORGET,DISPOSE_SCOPE,FINALIZE,REGISTER_ASSET,CONNECT,DISCONNECT,QUIESCE };
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

#include "jsb_host_operations_helpers.inc"
class EngineHostSignalCallable final:public CallableCustom {
 EnvironmentID environment_;ObjectID emitter_;uint64_t connection_;
public:
 EngineHostSignalCallable(EnvironmentID environment,ObjectID emitter,uint64_t connection):environment_(environment),emitter_(emitter),connection_(connection){}
 static bool equal(const CallableCustom* left,const CallableCustom* right){const auto* a=static_cast<const EngineHostSignalCallable*>(left);const auto* b=static_cast<const EngineHostSignalCallable*>(right);return a->environment_==b->environment_&&a->connection_==b->connection_;}
 static bool less(const CallableCustom* left,const CallableCustom* right){const auto* a=static_cast<const EngineHostSignalCallable*>(left);const auto* b=static_cast<const EngineHostSignalCallable*>(right);return a->environment_==b->environment_?a->connection_<b->connection_:uintptr_t(a->environment_)<uintptr_t(b->environment_);}
 CompareEqualFunc get_compare_equal_func()const override{return equal;}CompareLessFunc get_compare_less_func()const override{return less;}
 uint32_t hash()const override{return uint32_t(connection_)^uint32_t(connection_>>32)^uint32_t(uintptr_t(environment_));}
 ObjectID get_object()const override{return emitter_;}String get_as_text()const override{return "Engine scoped signal";}
 bool is_valid()const override{return compat::ObjectDB::get_instance(emitter_)!=nullptr;}
 void call(const Variant** args,int count,Variant& result,Callable::CallError& error)const override{
  result=Variant();if(!Thread::is_main_thread()){error.error=Callable::CallError::CALL_ERROR_INVALID_METHOD;return;}
  const auto environment=Environment::_access(environment_);if(!environment||environment->is_disposing()||!environment->is_caller_thread()){error.error=Callable::CallError::CALL_ERROR_INVALID_METHOD;return;}
  environment->get_engine_host_operations().invoke_signal(connection_,args,count);error.error=Callable::CallError::CALL_OK;
 }
};
}
struct EngineHostOperations::Impl {
 struct Owned {ObjectID object;StringName name;
#include "jsb_host_operation_state.inc"
 };
 struct Root {
  uint64_t token=0;bool active=true;bool quiescing=false;bool closing=false;uint32_t operations=0;String stage;Vector<NativeObjectID> deferred_forget;std::unordered_set<uint64_t> connections;
  HashMap<StringName,StringName> audio_buses;HashSet<ObjectID> audio_layouts;HashMap<ObjectID,Ref<ButtonGroup>> button_groups;
  HashMap<uint64_t,Owned> nodes;HashMap<String,Ref<Resource>> assets;HashMap<uint64_t,String> asset_ids;HashMap<String,String> asset_scopes;
 };
 struct Connection {uint64_t scope=0;NativeObjectID node;ObjectID emitter;StringName signal;Callable callable;v8::Global<v8::Function> callback;};
 std::unordered_map<uint64_t,std::unique_ptr<Connection>> connections;uint64_t next_connection=0;
 Environment* environment;std::shared_ptr<NativeWorld> world;std::unordered_map<uint64_t,std::unique_ptr<Root>> roots;
 explicit Impl(Environment* env):environment(env),world(env->get_native_world()){}
 Root* root(NativeWorld::Scope* scope){auto& result=roots[scope->token];if(!result){result=std::make_unique<Root>();result->token=scope->token;}return result.get();}
 Node* resolve(Root& root,NativeObjectID id) const {const Owned* state=root.nodes.getptr(*id);if(!state||!world->owns_claim(root.token,state->object))return nullptr;Node* node=Object::cast_to<Node>(compat::ObjectDB::get_instance(state->object));return node&&environment->try_get_object_id(node)==id?node:nullptr;}
 Owned* touch(Root& root,Node* node,bool readonly=false){
  if(!world->owns_claim(root.token,node->get_instance_id()))return nullptr;const auto key=environment->try_get_object_id(node);if(!key)return nullptr;
  if(!root.nodes.has(*key)){if(root.quiescing&&!readonly)return nullptr;Owned state;state.object=node->get_instance_id();state.name=node->get_name();root.nodes.insert(*key,state);}
  Owned* state=root.nodes.getptr(*key);
  if(!readonly&&!state->text_limit.is_valid())if(TextEdit* edit=Object::cast_to<TextEdit>(node)){state->text_limit=Callable(memnew(ReactTextLimitCallable(node->get_instance_id())));if(!edit->is_connected("text_changed",state->text_limit))edit->connect("text_changed",state->text_limit);}
  return state;
 }
 bool mutation_stage(const Root& root) const {return (root.stage=="initial"||root.stage=="safe"||root.stage=="cleanup")&&world->can_commit();}
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
            if(TypeConvert::is_variant(p_value.As<v8::Object>())){Variant native_value;if(!TypeConvert::js_to_gd_var(p_context->GetIsolate(),p_context,p_value,native_value)||native_value.get_type()==Variant::OBJECT||native_value.get_type()==Variant::CALLABLE||native_value.get_type()==Variant::SIGNAL)return false;r_value=native_value;return p_hint==Variant::NIL||native_value.get_type()==p_hint;}
            Object* native_object=nullptr;
            if(TypeConvert::js_to_gd_obj(p_context->GetIsolate(),p_context,p_value,native_object)&&native_object){
                if(Node* node=Object::cast_to<Node>(native_object)){if(!world->owns_claim(p_root.token,node->get_instance_id()))return false;r_value=node;return p_hint==Variant::NIL||p_hint==Variant::OBJECT;}
                Resource* resource=Object::cast_to<Resource>(native_object);if(!resource||!allowed_asset_type(resource->get_class())||!resource->get_script().is_null())return false;
                if(resource->is_class("ViewportTexture")){bool live=false;for(const KeyValue<uint64_t,Owned>& entry:p_root.nodes)if(SubViewport* viewport=Object::cast_to<SubViewport>(resolve(p_root,NativeObjectID(entry.key))))if(viewport->is_inside_tree()&&viewport->get_texture().ptr()==resource){live=true;break;}if(!live)return false;}
                r_value=Ref<Resource>(resource);return p_hint==Variant::NIL||p_hint==Variant::OBJECT;
            }
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
            case Variant::OBJECT: {
                Object* object=p_value.get_validated_object();if(!object){r_value=v8::Null(isolate);return true;}
                if(Node* node=Object::cast_to<Node>(object)){if(!world->owns_claim(p_root.token,node->get_instance_id())){auto result=v8::Object::New(isolate);put(p_context,result,"kind",impl::Helper::new_string_ascii(isolate,"unmanaged-node"));put(p_context,result,"objectId",impl::Helper::new_string(isolate,uitos((uint64_t)node->get_instance_id())));r_value=result;return true;}}
                else if(Resource* resource=Object::cast_to<Resource>(object)){if(!allowed_asset_type(resource->get_class())||!resource->get_script().is_null())return false;}
                else return false;
                return TypeConvert::gd_var_to_js(isolate,p_context,p_value,r_value);
            }
            default: return false;
            }
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

#include "jsb_host_parity.inc"
#include "jsb_host_behaviors.inc"
#include "jsb_host_interactions.inc"
#include "jsb_host_presentation.inc"
#include "jsb_host_details.inc"
#include "jsb_host_precision.inc"
#include "jsb_host_fidelity.inc"
#include "jsb_host_usability.inc"
#include "jsb_host_composition.inc"
#include "jsb_host_workflows.inc"
#include "jsb_host_refinements.inc"
#include "jsb_host_gameplay.inc"

        String bind_focus(Root& root)
        {
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(Control* control=Object::cast_to<Control>(resolve(root,NativeObjectID(pair.key))))for(const KeyValue<StringName,NodePath>& entry:pair.value.focus_paths){
                if(!control->is_inside_tree()||entry.value.is_empty())continue;Node* target=control->get_node_or_null(entry.value);const NativeObjectID id=target?environment->try_get_object_id(target):NativeObjectID();if(!target||!target->is_inside_tree()||!root.nodes.has(*id)||!Object::cast_to<Control>(target))return "E_FOCUS_PATH: "+String(control->get_name())+" -> "+String(entry.value)+" must target a live Control in this Root";
            }
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(Control* control=Object::cast_to<Control>(resolve(root,NativeObjectID(pair.key))))for(const KeyValue<StringName,NodePath>& entry:pair.value.focus_paths)if(control->is_inside_tree())control->set(entry.key,entry.value);
            return {};
        }


 void disconnect(uint64_t id){auto found=connections.find(id);if(found==connections.end())return;auto& connection=*found->second;if(Node* emitter=Object::cast_to<Node>(compat::ObjectDB::get_instance(connection.emitter)))if(emitter->is_connected(connection.signal,connection.callable))emitter->disconnect(connection.signal,connection.callable);if(auto root=roots.find(connection.scope);root!=roots.end())root->second->connections.erase(id);connection.callback.Reset();connections.erase(found);}
 void forget(Root& root,NativeObjectID key){if(root.operations){if(!root.deferred_forget.has(key))root.deferred_forget.push_back(key);return;}Vector<uint64_t> ending;for(uint64_t id:root.connections){auto found=connections.find(id);if(found!=connections.end()&&found->second->node==key)ending.push_back(id);}for(uint64_t id:ending)disconnect(id);Owned* state=root.nodes.getptr(*key);if(!state)return;if(state->tween.is_valid())state->tween->kill();for(const KeyValue<StringName,Ref<Tween>>& item:state->property_tweens)if(item.value.is_valid())item.value->kill();if(Node* node=Object::cast_to<Node>(compat::ObjectDB::get_instance(state->object))){if(state->text_limit.is_valid()&&node->is_connected("text_changed",state->text_limit))node->disconnect("text_changed",state->text_limit);}root.nodes.erase(*key);}
 void quiesce(Root& root){if(root.quiescing)return;root.quiescing=true;Vector<uint64_t> ending;for(uint64_t id:root.connections)ending.push_back(id);for(uint64_t id:ending)disconnect(id);for(KeyValue<uint64_t,Owned>& item:root.nodes){if(item.value.tween.is_valid())item.value.tween->kill();item.value.tween.unref();for(const KeyValue<StringName,Ref<Tween>>& tween:item.value.property_tweens)if(tween.value.is_valid())tween.value->kill();item.value.property_tweens.clear();}}
 void close(Root& root){root.active=false;if(root.operations){root.closing=true;return;}Vector<uint64_t> ending;for(uint64_t id:root.connections)ending.push_back(id);for(uint64_t id:ending)disconnect(id);Vector<NativeObjectID> keys;for(const KeyValue<uint64_t,Owned>& item:root.nodes)keys.push_back(NativeObjectID(item.key));for(NativeObjectID key:keys)forget(root,key);close_audio_buses(root);root.assets.clear();root.asset_ids.clear();root.active=false;root.closing=false;}
 void leave(Root& root){if(--root.operations)return;if(root.closing){const uint64_t token=root.token;close(root);roots.erase(token);return;}Vector<NativeObjectID> keys=root.deferred_forget;root.deferred_forget.clear();for(NativeObjectID key:keys)forget(root,key);}
 String finalize(Root& root){
  Vector<NativeObjectID> stale;for(const KeyValue<uint64_t,Owned>& item:root.nodes)if(!resolve(root,NativeObjectID(item.key)))stale.push_back(NativeObjectID(item.key));for(NativeObjectID key:stale)forget(root,key);
  int64_t particles=0;for(const KeyValue<uint64_t,Owned>& entry:root.nodes){Node* item=resolve(root,NativeObjectID(entry.key));if(!item)continue;if(item->is_class("GPUParticles2D")||item->is_class("GPUParticles3D"))particles+=int64_t(item->get("amount"));if(entry.value.prefab_root.is_valid())particles+=subtree_particles(Object::cast_to<Node>(compat::ObjectDB::get_instance(entry.value.prefab_root)));if(particles>65536)return "E_GPU_BUDGET: scope particle count";}
  // Explicit commit finalization refreshes semantic paths after sibling changes.
  // It never traverses the application SceneTree or runs on frame ticks.
  unbind_joints(root);
  String error=bind_focus(root);if(!error.is_empty())return error;error=bind_joints(root);if(!error.is_empty())return error;error=bind_surfaces(root);if(!error.is_empty())return error;return bind_viewports(root);
 }
};
EngineHostOperations::EngineHostOperations(Environment* env):impl_(std::make_unique<Impl>(env)){}
EngineHostOperations::~EngineHostOperations(){dispose();}
void EngineHostOperations::dispose(){if(!impl_)return;for(auto& item:impl_->roots)impl_->close(*item.second);impl_->roots.clear();}
void EngineHostOperations::install(const v8::Local<v8::Context>& context,const v8::Local<v8::Object>& internal){
 auto* isolate=context->GetIsolate();auto object=v8::Object::New(isolate);
 const struct {const char* name;int operation;} methods[]={{"read",READ},{"write",SET},{"invoke",CALL},{"touch",TOUCH},{"forget",FORGET},{"disposeScope",DISPOSE_SCOPE},{"finalize",FINALIZE},{"registerAsset",REGISTER_ASSET},{"connect",CONNECT},{"disconnect",DISCONNECT},{"quiesceScope",QUIESCE}};
 for(const auto& method:methods)put(context,object,method.name,JSB_NEW_FUNCTION(context,dispatch,v8::Int32::New(isolate,method.operation)));
 put(context,object,"abi",impl::Helper::new_string_ascii(isolate,"godot-engine-host-operations/1"));put(context,internal,"native_host_operations",object);
}
void EngineHostOperations::invoke_signal(uint64_t id,const Variant** input,int count){
 if(!impl_||!Thread::is_main_thread()||!impl_->environment->is_caller_thread()||impl_->environment->is_disposing()||count<0||count>64)return;
 auto found=impl_->connections.find(id);if(found==impl_->connections.end())return;
 auto root_entry=impl_->roots.find(found->second->scope);if(root_entry==impl_->roots.end()||!root_entry->second->active||root_entry->second->quiescing)return;auto& root=*root_entry->second;
 Node* node=impl_->resolve(root,found->second->node);if(!node)return;
 struct Guard{Impl& state;Impl::Root& root;Guard(Impl& s,Impl::Root& r):state(s),root(r){++root.operations;}~Guard(){state.leave(root);}} guard(*impl_,root);NativeInteropScope interop;
 auto* isolate=impl_->environment->get_isolate();v8::Isolate::Scope isolate_scope(isolate);v8::HandleScope handles(isolate);const auto context=impl_->environment->get_context();if(context.IsEmpty())return;v8::Context::Scope context_scope(context);
 const auto callback=found->second->callback.Get(isolate);const NativeObjectID owner_key=found->second->node;const StringName signal=found->second->signal;const bool shape=signal==StringName("body_shape_entered")||signal==StringName("body_shape_exited")||signal==StringName("area_shape_entered")||signal==StringName("area_shape_exited");
 const bool navigation=signal==StringName("waypoint_reached")||signal==StringName("link_reached");std::vector<v8::Local<v8::Value>> args(shape?1:count);
 if(shape){Variant value;if(!impl_->shape_contact_event(root,node,input,count,value)||!impl_->safe_to_js(root,context,value,args[0])){JSB_LOG(Error,"E_ENGINE_HOST_SIGNAL_CODEC: invalid shape contact");return;}}
 else for(int index=0;index<count;++index){const Variant value=navigation?impl_->navigation_event(root,*input[index]):*input[index];if(!impl_->safe_to_js(root,context,value,args[index])){JSB_LOG(Error,"E_ENGINE_HOST_SIGNAL_CODEC: unsupported argument");return;}}
 if(!root.active||!impl_->resolve(root,owner_key))return;const impl::TryCatch catcher(isolate);v8::Local<v8::Value> ignored;if(!callback->Call(context,v8::Undefined(isolate),args.size(),args.data()).ToLocal(&ignored))JSB_LOG(Error,"E_ENGINE_HOST_SIGNAL_CALLBACK: queue callback failed");impl_->environment->notify_microtasks_run();
}
void EngineHostOperations::dispatch(const v8::FunctionCallbackInfo<v8::Value>& info){
 auto* isolate=info.GetIsolate();const auto context=isolate->GetCurrentContext();Environment* environment=Environment::wrap(isolate);
 auto fail=[&](const String& error){impl::Helper::throw_error(isolate,error);};
 if(!environment->is_caller_thread()||!Thread::is_main_thread()||environment->is_disposing()){fail("E_ENGINE_HOST_THREAD: live owner environment required");return;}
 Impl& state=*environment->get_engine_host_operations().impl_;const int op=info.Data().As<v8::Int32>()->Value();
 NativeWorld::Scope* scope=info.Length()&&info[0]->IsExternal()?state.world->resolve_scope(info[0].As<v8::External>()->Value(),environment->binding_epoch()):nullptr;
 if(!scope||state.world->renderer_mode()!="engine"){if(op==FORGET||op==DISCONNECT)return;fail("E_ENGINE_HOST_SCOPE: active engine scope required");return;}
 Impl::Root* root=state.root(scope);
 if(op==DISPOSE_SCOPE){const uint64_t token=root->token;const bool in_flight=root->operations>0;state.close(*root);if(!in_flight)state.roots.erase(token);return;}
 if(!root->active){fail("E_ENGINE_HOST_CLOSED");return;}
 struct OperationGuard {Impl& state;Impl::Root& root;String phase;OperationGuard(Impl& s,Impl::Root& r):state(s),root(r),phase(r.stage){++root.operations;}~OperationGuard(){root.stage=phase;state.leave(root);}} guard(state,*root);
 NativeInteropScope interop;
 if(op==DISCONNECT){if(info.Length()!=2||!info[1]->IsNumber()){fail("E_ENGINE_HOST_CONNECTION: connection id required");return;}const double value=info[1].As<v8::Number>()->Value();if(value<1||value>9007199254740991.0||value!=Math::floor(value)){fail("E_ENGINE_HOST_CONNECTION: invalid connection id");return;}const uint64_t id=uint64_t(value);auto found=state.connections.find(id);if(found!=state.connections.end()&&found->second->scope!=root->token){fail("E_ENGINE_HOST_CONNECTION: foreign connection");return;}state.disconnect(id);return;}
 if(op==QUIESCE){state.quiesce(*root);return;}
 if(root->quiescing&&op!=READ&&op!=FORGET){fail("E_ENGINE_HOST_QUIESCING: only cleanup reads are admitted");return;}
 if(op==FINALIZE){if(!state.world->can_commit()){fail("E_ENGINE_HOST_CHECKPOINT");return;}const String error=state.finalize(*root);if(!error.is_empty())fail(error);return;}
 if(op==REGISTER_ASSET){
  Object* raw=nullptr;if(info.Length()!=3||!info[1]->IsString()||!TypeConvert::js_to_gd_obj(isolate,context,info[2],raw)){fail("E_ENGINE_HOST_ASSET: id and native Resource required");return;}
  const String id=impl::Helper::to_string(isolate,info[1]);Resource* resource=Object::cast_to<Resource>(raw);
  if(id.is_empty()||id.length()>1024||!resource||!allowed_asset_type(resource->get_class())||!resource->get_script().is_null()){fail("E_ENGINE_HOST_ASSET: unsupported resource");return;}
  if(const Ref<Resource>* prior=root->assets.getptr(id)){if(prior->ptr()!=resource)fail("E_ENGINE_HOST_ASSET: id already registered");return;}
  HashSet<ObjectID> seen;int budget=4096;if(!validate_scene_resource(Ref<Resource>(resource),seen,budget)){fail("E_ENGINE_HOST_ASSET: resource graph outside bounded profile");return;}
  const String error=state.install_audio_layout(*root,Ref<Resource>(resource));if(!error.is_empty()){fail(error);return;}
  if(!root->active){fail("E_ENGINE_HOST_RETIRED: resource registration closed its scope");return;}root->assets.insert(id,Ref<Resource>(resource));root->asset_ids.insert((uint64_t)resource->get_instance_id(),id);return;
 }
 Object* object=nullptr;
 if(info.Length()<2||!TypeConvert::js_to_gd_obj(isolate,context,info[1],object)){if(op==FORGET)return;fail("E_ENGINE_HOST_OBJECT: live native Node required");return;}
 if(op==FORGET){if(!object)return;const auto key=environment->try_get_object_id(object);const Impl::Owned* owned=root->nodes.getptr(*key);if(owned&&owned->object==object->get_instance_id())state.forget(*root,key);return;}
 Node* node=Object::cast_to<Node>(object);if(!node||!state.world->owns_claim(root->token,node->get_instance_id())){fail("E_ENGINE_HOST_CLAIM: target does not belong to this live scope");return;}
 const NativeObjectID key=environment->try_get_object_id(node);
 Impl::Owned* owned=state.touch(*root,node,op==READ);if(!owned){fail("E_ENGINE_HOST_CLAIM");return;}
 if(op==TOUCH)return;
 if(op==CONNECT){
  if(info.Length()!=4||!info[2]->IsString()||!info[3]->IsFunction()||!state.world->can_commit()){fail("E_ENGINE_HOST_SIGNAL: connect requires a safe checkpoint and callback");return;}
  StringName signal=impl::Helper::to_string(isolate,info[2]);Node* emitter=node;
  if(signal==StringName("__react_workflows_menu_id")){MenuButton* menu=Object::cast_to<MenuButton>(node);if(!menu){fail("E_ENGINE_HOST_SIGNAL: MenuButton required");return;}emitter=menu->get_popup();signal=StringName("id_pressed");}
  if(!emitter->has_signal(signal)||state.next_connection>=9007199254740991ULL){fail("E_ENGINE_HOST_SIGNAL: signal absent or connection budget exceeded");return;}
  const uint64_t id=++state.next_connection;auto connection=std::make_unique<Impl::Connection>();connection->scope=root->token;connection->node=key;connection->emitter=emitter->get_instance_id();connection->signal=signal;connection->callback.Reset(isolate,info[3].As<v8::Function>());connection->callable=Callable(memnew(EngineHostSignalCallable(environment->id(),connection->emitter,id)));
  if(emitter->connect(signal,connection->callable)!=OK){fail("E_ENGINE_HOST_SIGNAL: native connection failed");return;}state.connections.emplace(id,std::move(connection));root->connections.insert(id);info.GetReturnValue().Set(v8::Number::New(isolate,double(id)));return;
 }
 const int argc=info.Length()>4?info.Length()-1:info.Length();root->stage=info.Length()>4&&info[4]->IsString()?impl::Helper::to_string(isolate,info[4]):String("safe");
 auto verify=[&](){if(!root->active||state.resolve(*root,key)!=node){fail("E_ENGINE_HOST_RETIRED: operation retired its target");return false;}return true;};
#include "jsb_host_property_dispatch.inc"
 if(op==CALL){if(argc!=4||!info[2]->IsString()||!info[3]->IsArray()){fail("E_ENGINE_HOST_ARGUMENTS");return;}const StringName method=impl::Helper::to_string(isolate,info[2]);const String method_text=method;
#include "jsb_host_command_dispatch.inc"
#include "jsb_host_native_command_dispatch.inc"
 }
 fail("E_ENGINE_HOST_UNSUPPORTED: unknown domain operation");
}
}
