        String bind_surfaces(Root& root)
        {

#if !defined(_3D_DISABLED)
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(MeshInstance3D* node=Object::cast_to<MeshInstance3D>(resolve(root,NativeObjectID(pair.key)))){
                const int count=node->get_mesh().is_valid()?node->get_mesh()->get_surface_count():0;
                if(pair.value.surface_materials.size()>count)return "E_SURFACE_MATERIAL: override index exceeds mesh surface count";
            }
            for(KeyValue<uint64_t,Owned>& pair:root.nodes)if(MeshInstance3D* node=Object::cast_to<MeshInstance3D>(resolve(root,NativeObjectID(pair.key)))){
                const int count=node->get_mesh().is_valid()?node->get_mesh()->get_surface_count():0;
                for(int i=0;i<count;++i){Ref<Material> material;if(i<pair.value.surface_materials.size())material=pair.value.surface_materials[i];if(material.is_null()) {Ref<ShaderMaterial> source=node->get_mesh()->surface_get_material(i);if(source.is_valid())material=source;}
                    material=private_material(pair.value,i,material);if(node->get_surface_override_material(i)!=material)node->set_surface_override_material(i,material);}
            }

#endif
            return {};
        }

        bool audio_effect_parameter(AudioServer* server,int bus,const String& operation,const std::vector<Variant>& args,Variant& result)
        {
            const bool set=operation=="effect_set";
            if(args.size()!=(set?3:2)||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=server->get_bus_effect_count(bus)||args[1].get_type()!=Variant::STRING)return false;
            const Ref<AudioEffect> effect=server->get_bus_effect(bus,int(args[0]));if(effect.is_null())return false;
            struct Rule {const char* type;const char* name;double minimum,maximum;};
            static const Rule rules[]={
                {"AudioEffectReverb","room_size",0,1},{"AudioEffectReverb","damping",0,1},{"AudioEffectReverb","spread",0,1},{"AudioEffectReverb","dry",0,1},{"AudioEffectReverb","wet",0,1},{"AudioEffectReverb","predelay_msec",0,500},
                {"AudioEffectLowPassFilter","cutoff_hz",20,20000},{"AudioEffectLowPassFilter","resonance",0,1},{"AudioEffectLowPassFilter","gain",0,4},{"AudioEffectLowPassFilter","db",0,3},
                {"AudioEffectCompressor","threshold",-60,0},{"AudioEffectCompressor","ratio",1,48},{"AudioEffectCompressor","gain",-60,24},{"AudioEffectCompressor","attack_us",20,2000},{"AudioEffectCompressor","release_ms",20,2000},{"AudioEffectCompressor","mix",0,1},
                {"AudioEffectLimiter","ceiling_db",-20,0},{"AudioEffectLimiter","threshold_db",-30,0},{"AudioEffectLimiter","soft_clip_db",0,6},{"AudioEffectLimiter","soft_clip_ratio",1,20}};
            const StringName name=String(args[1]);
            for(const Rule& rule:rules)if(effect->get_class()==StringName(rule.type)&&name==StringName(rule.name)){
                if(set){if(args[2].get_type()!=Variant::FLOAT||double(args[2])<rule.minimum||double(args[2])>rule.maximum||(name=="db"&&double(args[2])!=Math::floor(double(args[2]))))return false;effect->set(name,args[2]);}
                result=effect->get(name);return true;
            }
            return false;
        }

        Dictionary collision_value(const Ref<KinematicCollision2D>& collision)
        {
            Dictionary value;if(collision.is_null())return value;
            value["position"]=collision->get_position();value["normal"]=collision->get_normal();value["travel"]=collision->get_travel();value["remainder"]=collision->get_remainder();value["colliderVelocity"]=collision->get_collider_velocity();value["collider"]=collision->get_collider();value["colliderShape"]=collision->get_collider_shape_index();value["depth"]=collision->get_depth();return value;
        }

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
        Dictionary collision_value(const Ref<KinematicCollision3D>& collision)
        {
            Dictionary value;if(collision.is_null()||collision->get_collision_count()==0)return value;
            value["position"]=collision->get_position();value["normal"]=collision->get_normal();value["travel"]=collision->get_travel();value["remainder"]=collision->get_remainder();value["colliderVelocity"]=collision->get_collider_velocity();value["collider"]=collision->get_collider();value["colliderShape"]=collision->get_collider_shape_index();value["depth"]=collision->get_depth();
            Array contacts;for(int i=0;i<MIN(collision->get_collision_count(),32);++i){Dictionary contact;contact["position"]=collision->get_position(i);contact["normal"]=collision->get_normal(i);contact["colliderVelocity"]=collision->get_collider_velocity(i);contact["collider"]=collision->get_collider(i);contact["colliderShape"]=collision->get_collider_shape_index(i);contacts.push_back(contact);}value["contacts"]=contacts;return value;
        }
#endif


        bool gameplay_command(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {

#if !defined(_3D_DISABLED)
            if(operation=="surface_material"){MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(root.stage!="process"||!mesh||mesh->get_mesh().is_null()||args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=mesh->get_mesh()->get_surface_count())return false;const int index=int(args[0]);Ref<Material> material=mesh->get_surface_override_material(index);if(material.is_null())material=mesh->get_mesh()->surface_get_material(index);result=material;return true;}
#endif
#if !defined(_3D_DISABLED)
            if(operation=="surface_count"){MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(root.stage!="process"||!mesh||!args.is_empty())return false;result=mesh->get_mesh().is_valid()?mesh->get_mesh()->get_surface_count():0;return true;}
#endif
            if(operation=="scroll_get"||operation=="scroll_set"){
                ScrollContainer* control=Object::cast_to<ScrollContainer>(node);if(!control||root.stage!="process")return false;
                if(operation=="scroll_set"){if(args.size()!=1||args[0].get_type()!=Variant::VECTOR2I)return false;const Vector2i position=args[0];if(position.x<0||position.y<0)return false;control->set_h_scroll(position.x);control->set_v_scroll(position.y);}else if(!args.is_empty())return false;
                result=Vector2i(control->get_h_scroll(),control->get_v_scroll());return true;
            }
            const bool physics_body=node->is_class("AnimatableBody2D")||node->is_class("AnimatableBody3D")||node->is_class("CharacterBody2D")||node->is_class("CharacterBody3D")||node->is_class("RigidBody2D")||node->is_class("RigidBody3D")||node->is_class("StaticBody2D")||node->is_class("StaticBody3D");
            if(root.stage!=(physics_body?"physics":"process"))return false;
            Node2D* two=Object::cast_to<Node2D>(node);
#if !defined(_3D_DISABLED)
            Node3D* three=Object::cast_to<Node3D>(node);
#endif

            if(operation=="slide_count"||operation=="slide_collision"||operation=="move_collide"||operation=="test_move"){
                CharacterBody2D* body2=Object::cast_to<CharacterBody2D>(node);
#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
                CharacterBody3D* body3=Object::cast_to<CharacterBody3D>(node);if(!body2&&!body3)return false;
                const int count=body2?body2->get_slide_collision_count():body3->get_slide_collision_count();
#else
                if(!body2)return false;
                const int count=body2->get_slide_collision_count();
#endif
                if(operation=="slide_count"){if(!args.is_empty())return false;result=count;return true;}
                if(operation=="slide_collision"){
                    if(args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=count)return false;
                    Variant native=node->call("get_slide_collision",int(args[0]));if(body2){const Ref<KinematicCollision2D> collision=native;result=collision_value(collision);}
#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
                    else{const Ref<KinematicCollision3D> collision=native;result=collision_value(collision);}
#endif
                    return true;
                }
                if(args.size()!=3||args[2].get_type()!=Variant::FLOAT||double(args[2])<0||double(args[2])>1000)return false;
                const Variant::Type vector=body2?Variant::VECTOR2:Variant::VECTOR3;
                if(operation=="move_collide"){
                    if(args[0].get_type()!=vector||args[1].get_type()!=Variant::BOOL)return false;
                    Variant native=node->call("move_and_collide",args[0],args[1],args[2]);if(body2){const Ref<KinematicCollision2D> collision=native;if(collision.is_valid())result=collision_value(collision);}
#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
                    else{const Ref<KinematicCollision3D> collision=native;if(collision.is_valid())result=collision_value(collision);}
#endif
                    return true;
                }
                if(args[0].get_type()!=(body2?Variant::TRANSFORM2D:Variant::TRANSFORM3D)||args[1].get_type()!=vector)return false;
                if(body2){const Transform2D transform=args[0];if(Math::abs(transform.determinant())<1e-10)return false;Ref<KinematicCollision2D> collision;collision.instantiate();if(body2->test_move(transform,args[1],collision,args[2]))result=collision_value(collision);}

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
                else{const Transform3D transform=args[0];if(Math::abs(transform.basis.determinant())<1e-10)return false;Ref<KinematicCollision3D> collision;collision.instantiate();if(body3->test_move(transform,args[1],collision,args[2]))result=collision_value(collision);}
#endif
                return true;
            }
#if !defined(_3D_DISABLED)
            if(!two&&!three)return false;
#else
            if(!two)return false;
#endif
            if(operation=="global_position"||operation=="transform"||operation=="global_transform"){
                if(!args.is_empty())return false;
                if(two){
                    if(operation=="global_position")result=two->get_global_position();
                    else if(operation=="transform")result=two->get_transform();
                    else result=two->get_global_transform();
                }
#if !defined(_3D_DISABLED)
                else{
                    if(operation=="global_position")result=three->get_global_position();
                    else if(operation=="transform")result=three->get_transform();
                    else result=three->get_global_transform();
                }
#endif
                return true;
            }
            if(operation=="to_global"||operation=="to_local"){
                if(args.size()!=1||args[0].get_type()!=(two?Variant::VECTOR2:Variant::VECTOR3))return false;
                if(two){if(operation=="to_local"&&Math::abs(two->get_global_transform().determinant())<1e-10)return false;result=operation=="to_global"?two->to_global(args[0]):two->to_local(args[0]);}

#if !defined(_3D_DISABLED)
                else{if(operation=="to_local"&&Math::abs(three->get_global_transform().basis.determinant())<1e-10)return false;result=operation=="to_global"?three->to_global(args[0]):three->to_local(args[0]);}
#endif
                return true;
            }
            if(operation=="look_at"){
                if(two){if(args.size()!=1||args[0].get_type()!=Variant::VECTOR2)return false;const Vector2 target=args[0];if(target.distance_squared_to(two->get_global_position())<1e-10)return false;two->look_at(target);}

#if !defined(_3D_DISABLED)
                else{if(args.size()!=2||args[0].get_type()!=Variant::VECTOR3||args[1].get_type()!=Variant::VECTOR3)return false;const Vector3 target=args[0],up=args[1],direction=target-three->get_global_position();if(direction.length_squared()<1e-10||up.length_squared()<1e-10||direction.cross(up).length_squared()<1e-10)return false;three->look_at(target,up);}
#endif
                return true;
            }
            return false;
        }
