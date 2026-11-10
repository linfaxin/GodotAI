        Ref<Material> private_material(Owned& owned,int slot,const Ref<Material>& source)
        {
            Ref<ShaderMaterial> shader=source;
            if(shader.is_null()){owned.shader_sources.erase(slot);owned.shader_instances.erase(slot);return source;}
            if(const Ref<ShaderMaterial>* previous=owned.shader_sources.getptr(slot))if(*previous==shader)return owned.shader_instances[slot];
            Ref<ShaderMaterial> copy=shader->duplicate();owned.shader_sources.insert(slot,shader);owned.shader_instances.insert(slot,copy);return copy;
        }

        bool static_shader_texture(Ref<Texture2D> texture)
        {
            for(int depth=0;depth<16&&texture.is_valid();++depth){if(texture->is_class("ViewportTexture"))return false;Ref<AtlasTexture> atlas=texture;if(atlas.is_null())return true;texture=atlas->get_atlas();}return false;
        }

        bool property_tween(Owned& owned,Node* node,const String& operation,const Array& args,Variant& result)
        {
            const int split=operation.find("_");if(split<0)return false;const String group=operation.left(split),action=operation.substr(split+1);
            if(group!="appearance"&&group!="value"&&group!="volume")return false;
            Ref<Tween>* current=owned.property_tweens.getptr(group);
            if(action=="isRunning"){if(!args.is_empty())return false;result=current&&current->is_valid()&&(*current)->is_running();return true;}
            if(action=="cancel"){if(!args.is_empty())return false;if(current&&current->is_valid())(*current)->kill();owned.property_tweens.erase(group);return true;}
            if(action=="start"){
                if(args.size()!=1||args[0].get_type()!=Variant::ARRAY||!node->is_inside_tree())return false;const Array plan=args[0];if(plan.size()<2||plan.size()>129||plan[0].get_type()!=Variant::ARRAY)return false;const Array config=plan[0];if(config.size()!=1||config[0].get_type()!=Variant::FLOAT||double(config[0])!=Math::floor(double(config[0]))||double(config[0])<0||double(config[0])>1000000)return false;
                Array steps;double duration=0;
                for(int i=1;i<plan.size();++i){if(plan[i].get_type()!=Variant::ARRAY)return false;Array step=plan[i];if(step.size()!=7||step[0].get_type()!=Variant::STRING||step[2].get_type()!=Variant::FLOAT||step[3].get_type()!=Variant::FLOAT||double(step[2])<0||double(step[3])<0||double(step[2])>86400||double(step[3])>86400||step[4].get_type()!=Variant::FLOAT||double(step[4])!=Math::floor(double(step[4]))||double(step[4])<0||double(step[4])>11||step[5].get_type()!=Variant::FLOAT||double(step[5])!=Math::floor(double(step[5]))||double(step[5])<0||double(step[5])>3||step[6].get_type()!=Variant::BOOL)return false;
                    String property=step[0];
                    if(group=="appearance"){
                        if(property=="selfModulate")property="self_modulate";else if(property=="defaultColor")property="default_color";
                        if(property!="modulate"&&property!="self_modulate"&&property!="color"&&property!="default_color")return false;
                        bool exists=false;const Variant before=node->get(property,&exists);if(!exists||before.get_type()!=Variant::COLOR||step[1].get_type()!=Variant::COLOR)return false;
                        const Color color=step[1];if(color.r < -16||color.r>16||color.g < -16||color.g>16||color.b < -16||color.b>16||color.a<0||color.a>1)return false;
                    }else{
                        if(step[1].get_type()!=Variant::FLOAT)return false;const double target=step[1];
                        if(group=="value"){Range* range=Object::cast_to<Range>(node);if(!range||target<range->get_min()||target>range->get_max())return false;property="value";}
                        else{if(!node->is_class("AudioStreamPlayer")&&!node->is_class("AudioStreamPlayer2D")&&!node->is_class("AudioStreamPlayer3D"))return false;if(target < -80||target>6)return false;property="volume_db";}
                    }
                    step[0]=property;steps.push_back(step);duration+=double(step[2])+double(step[3]);
                }
                if(duration<=0)return false;
                Ref<Tween> tween=node->create_tween();tween->set_loops(int(config[0]));for(int i=0;i<steps.size();++i){const Array step=steps[i];if(bool(step[6]))tween->parallel();else tween->chain();Ref<PropertyTweener> property=tween->tween_property(node,NodePath(String(step[0])),step[1],step[2]);property->set_delay(step[3]);property->set_trans(Tween::TransitionType(int(step[4])));property->set_ease(Tween::EaseType(int(step[5])));}if(current&&current->is_valid())(*current)->kill();owned.property_tweens.insert(group,tween);return true;
            }
            if(!current||current->is_null()||!(*current)->is_valid())return false;
            if(action=="pause"&&args.is_empty()){(*current)->pause();return true;}
            if(action=="resume"&&args.is_empty()){(*current)->play();return true;}
            if(action=="advance"&&args.size()==1&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=0&&double(args[0])<=86400){(*current)->custom_step(args[0]);return true;}
            return false;
        }

        bool behavior_command(Root& root,Owned& owned,Node* node,const String& operation,const Array& args,Variant& result,bool allow_overlay=false)
        {
            if(operation.begins_with("exception_")){
                if(root.stage!="physics")return false;
                const bool body=node->is_class("PhysicsBody2D")||node->is_class("PhysicsBody3D"),two=node->is_class("Node2D");
                if(!body&&!node->is_class("RayCast2D")&&!node->is_class("RayCast3D")&&!node->is_class("ShapeCast2D")&&!node->is_class("ShapeCast3D"))return false;
                bool pruned=false;
                for(int i=owned.exceptions.size()-1;i>=0;--i){const NativeObjectID id=owned.exceptions[i];Node* target=resolve(root,id);if(target&&target->is_inside_tree())continue;
                    if(body){if(const RID* rid=owned.exception_rids.getptr(*id)){if(PhysicsBody2D* source=Object::cast_to<PhysicsBody2D>(node))PhysicsServer2D::get_singleton()->body_remove_collision_exception(source->get_rid(),*rid);else if(PhysicsBody3D* source=Object::cast_to<PhysicsBody3D>(node))PhysicsServer3D::get_singleton()->body_remove_collision_exception(source->get_rid(),*rid);}}
                    owned.exception_rids.erase(*id);owned.exceptions.remove_at(i);pruned=true;
                }
                if(pruned&&!body){node->call("clear_exceptions");for(NativeObjectID id:owned.exceptions)if(Node* target=resolve(root,id))node->call("add_exception",target);}
                if(operation=="exception_list"){if(!args.is_empty())return false;Array nodes;for(NativeObjectID id:owned.exceptions)if(Node* target=resolve(root,id))if(target->is_inside_tree())nodes.push_back(target);result=nodes;return true;}
                if(operation=="exception_clear"){if(!args.is_empty())return false;for(NativeObjectID id:owned.exceptions)if(Node* target=resolve(root,id))node->call(body?"remove_collision_exception_with":"remove_exception",target);owned.exceptions.clear();owned.exception_rids.clear();return true;}
                if(args.size()!=1||args[0].get_type()!=Variant::OBJECT)return false;Node* target=Object::cast_to<Node>(static_cast<Object*>(args[0]));const NativeObjectID key=target?environment->try_get_object_id(target):NativeObjectID();
                if(!target||target==node||!root.nodes.has(*key)||!target->is_inside_tree()||!target->is_class(body?(two?"PhysicsBody2D":"PhysicsBody3D"):(two?"CollisionObject2D":"CollisionObject3D")))return false;
                if(operation=="exception_add"){if(owned.exceptions.has(key))return true;if(owned.exceptions.size()>=64)return false;node->call(body?"add_collision_exception_with":"add_exception",target);owned.exceptions.push_back(key);if(CollisionObject2D* object=Object::cast_to<CollisionObject2D>(target))owned.exception_rids.insert(*key,object->get_rid());else if(CollisionObject3D* object=Object::cast_to<CollisionObject3D>(target))owned.exception_rids.insert(*key,object->get_rid());return true;}
                if(operation=="exception_remove"){if(owned.exceptions.has(key)){node->call(body?"remove_collision_exception_with":"remove_exception",target);owned.exceptions.erase(key);owned.exception_rids.erase(*key);}return true;}
                return false;
            }
            if(operation=="path"||operation=="nav_distance"){
                if(root.stage!="physics"||!args.is_empty())return false;
                if(NavigationAgent2D* agent=Object::cast_to<NavigationAgent2D>(node)){if(operation=="nav_distance")result=agent->distance_to_target();else{const Vector<Vector2>& path=agent->get_current_navigation_path();if(path.size()>4096)return false;result=path;}return true;}
                if(NavigationAgent3D* agent=Object::cast_to<NavigationAgent3D>(node)){if(operation=="nav_distance")result=agent->distance_to_target();else{const Vector<Vector3>& path=agent->get_current_navigation_path();if(path.size()>4096)return false;result=path;}return true;}return false;
            }
            if(operation=="camera_update"){Camera2D* camera=Object::cast_to<Camera2D>(node);if(!camera||root.stage!="process"||!args.is_empty())return false;camera->force_update_scroll();return true;}
            if(operation=="canvas_transform"||operation=="local_viewport"||operation=="world_viewport"||operation=="viewport_local"||operation=="viewport_world"){
                CanvasItem* canvas=Object::cast_to<CanvasItem>(node);const bool inverse=operation=="viewport_local"||operation=="viewport_world";
                if(!canvas||root.stage!=(inverse?"input":"process"))return false;
                if(operation=="canvas_transform"){if(!args.is_empty())return false;result=canvas->get_canvas_transform();return true;}
                if(args.size()!=1||args[0].get_type()!=Variant::VECTOR2)return false;
                Transform2D transform=(operation=="local_viewport"||operation=="viewport_local")?canvas->get_global_transform_with_canvas():canvas->get_canvas_transform();
                if(inverse){if(Math::abs(transform.determinant())<1e-10)return false;transform=transform.affine_inverse();}result=transform.xform(Vector2(args[0]));return true;
            }
            if(root.stage!="process")return false;
            if(operation=="shader_set"||operation=="shader_get"){
                const bool set=operation=="shader_set";if(args.size()!=(set?3:2)||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0]) < (allow_overlay?-3:-2)||double(args[0])>63||args[1].get_type()!=Variant::STRING)return false;
                const int slot=int(args[0]);const StringName name=String(args[1]);Ref<ShaderMaterial> material;
                if(slot==-1&&Object::cast_to<CanvasItem>(node))material=node->get("material");
                else if(slot==-3&&Object::cast_to<GeometryInstance3D>(node))material=Object::cast_to<GeometryInstance3D>(node)->get_material_overlay();
                else if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node)){if(slot==-2)material=mesh->get_material_override();else if(slot>=0&&mesh->get_mesh().is_valid()&&slot<mesh->get_mesh()->get_surface_count())material=mesh->get_surface_override_material(slot);}
                if(material.is_null()||material->get_shader().is_null())return false;
                List<PropertyInfo> uniforms;material->get_shader()->get_shader_uniform_list(&uniforms);
                for(const PropertyInfo& uniform:uniforms)if(uniform.name==name){
                    if(set){Variant value=args[2];if(uniform.type==Variant::INT){if(value.get_type()!=Variant::FLOAT||double(value)!=Math::floor(double(value))||Math::abs(double(value))>2147483647)return false;value=int64_t(double(value));}
                        else if(uniform.type==Variant::OBJECT){Ref<Texture2D> texture=value;if(texture.is_null()||!static_shader_texture(texture))return false;}
                        else if(uniform.type==Variant::VECTOR4&&value.get_type()==Variant::COLOR){const Color color=value;value=Vector4(color.r,color.g,color.b,color.a);}
                        else if(value.get_type()!=uniform.type)return false;
                        material->set_shader_parameter(name,value);
                    }
                    result=material->get_shader_parameter(name);if(result.get_type()==Variant::VECTOR4){const Vector4 value=result;result=Color(value.x,value.y,value.z,value.w);}if(result.get_type()==Variant::OBJECT){Ref<Texture2D> texture=result;if(texture.is_null()||!static_shader_texture(texture))return false;}return true;
                }return false;
            }
            return property_tween(owned,node,operation,args,result);
        }
