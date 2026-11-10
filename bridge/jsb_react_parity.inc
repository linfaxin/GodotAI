        String install_audio_layout(Root& root, const Ref<Resource>& resource)
        {
            if (!resource->is_class("AudioBusLayout") || root.audio_layouts.has(resource->get_instance_id())) return {};
            struct Bus { StringName name, send; float volume; bool mute, solo; Vector<Ref<AudioEffect>> effects; Vector<bool> enabled; };
            Vector<Bus> buses; HashSet<StringName> names;
            for (int i=0;i<17;++i) {
                bool valid=false;const Variant value=resource->get("bus/"+itos(i)+"/name",&valid);if(!valid)break;
                const String name=value;if(i==16||name.is_empty()||name.length()>64||name=="Master"||root.audio_buses.has(name)||names.has(name))return "E_AUDIO_LAYOUT: invalid or duplicate scoped bus";
                Bus bus;bus.name=name;bus.send=resource->get("bus/"+itos(i)+"/send");bus.volume=resource->get("bus/"+itos(i)+"/volume_db");bus.mute=resource->get("bus/"+itos(i)+"/mute");bus.solo=resource->get("bus/"+itos(i)+"/solo");
                if(bus.send!="Master"&&!names.has(bus.send))return "E_AUDIO_LAYOUT: sends must target a preceding scoped bus";
                if(!std::isfinite(bus.volume)||bus.volume < -80 || bus.volume > 12)return "E_AUDIO_LAYOUT: invalid bus volume";
                for(int e=0;e<9;++e){bool exists=false;const Variant effect_value=resource->get("bus/"+itos(i)+"/effect/"+itos(e)+"/effect",&exists);if(!exists)break;Ref<AudioEffect> effect=effect_value;if(e==8||effect.is_null()||!effect->get_script().is_null())return "E_AUDIO_LAYOUT: invalid effect";const String type=effect->get_class();if(type!="AudioEffectReverb"&&type!="AudioEffectLowPassFilter"&&type!="AudioEffectCompressor"&&type!="AudioEffectLimiter")return "E_AUDIO_LAYOUT: unsupported effect";bus.effects.push_back(effect->duplicate());bus.enabled.push_back(resource->get("bus/"+itos(i)+"/effect/"+itos(e)+"/enabled"));}
                names.insert(name);buses.push_back(bus);
            }
            if(buses.is_empty()||root.audio_buses.size()+buses.size()>16)return "E_AUDIO_LAYOUT: expected at most sixteen scoped buses";
            AudioServer* server=AudioServer::get_singleton();
            for(const Bus& bus:buses){const String physical="__godot_react_"+uitos(root.token)+"_"+String(bus.name);server->add_bus();const int index=server->get_bus_count()-1;server->set_bus_name(index,physical);root.audio_buses.insert(bus.name,physical);server->set_bus_volume_db(index,bus.volume);server->set_bus_mute(index,bus.mute);server->set_bus_solo(index,bus.solo);server->set_bus_send(index,bus.send=="Master"?StringName("Master"):root.audio_buses[bus.send]);for(int e=0;e<bus.effects.size();++e){server->add_bus_effect(index,bus.effects[e]);server->set_bus_effect_enabled(index,e,bus.enabled[e]);}}
            root.audio_layouts.insert(resource->get_instance_id());return {};
        }

        void close_audio_buses(Root& root)
        {
            AudioServer* server=AudioServer::get_singleton();
            for(const KeyValue<StringName,StringName>& bus:root.audio_buses){const int index=server->get_bus_index(bus.value);if(index>0)server->remove_bus(index);}
            root.audio_buses.clear();root.audio_layouts.clear();
        }

        String bind_viewports(Root& root)
        {
            struct Binding {Node* target;SubViewport* source;};Vector<Binding> bindings;
            HashMap<ObjectID,Vector<ObjectID>> edges;
            for(KeyValue<uint64_t,Owned>& pair:root.nodes){
                Node* node=resolve(root,NativeObjectID(pair.key));if(!node||!node->is_inside_tree())continue;
                if(SubViewport* viewport=Object::cast_to<SubViewport>(node))if(!viewport->is_input_disabled()&&!Object::cast_to<SubViewportContainer>(viewport->get_parent()))return "E_VIEWPORT_INPUT: interactive viewport requires an owned SubViewportContainer";
                if(!node->is_class("Sprite2D")&&!node->is_class("TextureRect"))continue;
                SubViewport* source=nullptr;
                if(!pair.value.viewport_path.is_empty()){
                    const NodePath path(pair.value.viewport_path);source=path.is_absolute()?nullptr:Object::cast_to<SubViewport>(node->get_node_or_null(path));
                }else{
                    Ref<ViewportTexture> texture=node->get("texture");if(texture.is_null())continue;
                    for(const KeyValue<uint64_t,Owned>& candidate:root.nodes)if(SubViewport* viewport=Object::cast_to<SubViewport>(resolve(root,NativeObjectID(candidate.key))))if(viewport->get_texture()==texture){source=viewport;break;}
                }
                const NativeObjectID key=source?environment->try_get_object_id(source):NativeObjectID();
                if(!source||!source->is_inside_tree()||!root.nodes.has(*key)||source->is_ancestor_of(node))return "E_VIEWPORT_PATH: texture source must be an owned, separate SubViewport";
                if(SubViewport* parent=Object::cast_to<SubViewport>(node->get_viewport()))edges[parent->get_instance_id()].push_back(source->get_instance_id());
                bindings.push_back({node,source});
            }
            HashSet<ObjectID> visiting,done;
            std::function<bool(ObjectID)> visit=[&](ObjectID id){if(visiting.has(id))return false;if(done.has(id))return true;visiting.insert(id);if(const Vector<ObjectID>* next=edges.getptr(id))for(ObjectID child:*next)if(!visit(child))return false;visiting.erase(id);done.insert(id);return true;};
            for(const KeyValue<ObjectID,Vector<ObjectID>>& edge:edges)if(!visit(edge.key))return "E_VIEWPORT_CYCLE: render texture feedback is not allowed";
            for(const Binding& binding:bindings)binding.target->set("texture",binding.source->get_texture());
            return {};
        }

        bool advanced_query(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {
            const bool three=operation.ends_with("3"),ray=operation.begins_with("ray"),motion=operation.begins_with("motion");
            if(args.size()!=11||args[3].get_type()!=Variant::FLOAT||double(args[3])<0||double(args[3])>4294967295.0||Math::floor(double(args[3]))!=double(args[3])||args[4].get_type()!=Variant::BOOL||args[5].get_type()!=Variant::BOOL||args[6].get_type()!=Variant::FLOAT||double(args[6])<0||double(args[6])>10000||args[7].get_type()!=Variant::ARRAY||args[8].get_type()!=Variant::FLOAT||double(args[8])<1||double(args[8])>64||Math::floor(double(args[8]))!=double(args[8])||args[9].get_type()!=Variant::BOOL||args[10].get_type()!=Variant::BOOL)return false;
            const Array excluded=args[7];if(excluded.size()>64)return false;
            HashSet<RID> exclusions;
            for(int i=0;i<excluded.size();++i){if(excluded[i].get_type()!=Variant::OBJECT)return false;Node* target=Object::cast_to<Node>(static_cast<Object*>(excluded[i]));const NativeObjectID key=target?environment->try_get_object_id(target):NativeObjectID();if(!target||!root.nodes.has(*key))return false;if(three){CollisionObject3D* body=Object::cast_to<CollisionObject3D>(target);if(!body)return false;exclusions.insert(body->get_rid());}else{CollisionObject2D* body=Object::cast_to<CollisionObject2D>(target);if(!body)return false;exclusions.insert(body->get_rid());}}
            const uint32_t mask=uint32_t(int64_t(args[3]));const int limit=int(args[8]);Array hits;
            if(three){
                Node3D* spatial=Object::cast_to<Node3D>(node);PhysicsDirectSpaceState3D* space=spatial&&spatial->get_world_3d().is_valid()?spatial->get_world_3d()->get_direct_space_state():nullptr;if(!space)return false;
                if(ray){if(args[1].get_type()!=Variant::VECTOR3||args[2].get_type()!=Variant::VECTOR3)return false;PhysicsDirectSpaceState3D::RayParameters parameters;parameters.from=args[1];parameters.to=args[2];parameters.exclude=exclusions;parameters.collision_mask=mask;parameters.collide_with_areas=args[4];parameters.collide_with_bodies=args[5];parameters.hit_from_inside=args[9];parameters.hit_back_faces=args[10];PhysicsDirectSpaceState3D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}result=hits;return true;}
                if(args[0].get_type()!=Variant::OBJECT||args[1].get_type()!=Variant::TRANSFORM3D||args[2].get_type()!=Variant::VECTOR3)return false;Ref<Shape3D> shape=args[0];if(shape.is_null())return false;const Transform3D transform=args[1];if(Math::abs(transform.basis.determinant())<1e-10)return false;
                PhysicsDirectSpaceState3D::ShapeParameters parameters;parameters.shape_rid=shape->get_rid();parameters.transform=transform;parameters.motion=args[2];parameters.margin=args[6];parameters.exclude=exclusions;parameters.collision_mask=mask;parameters.collide_with_areas=args[4];parameters.collide_with_bodies=args[5];
                if(motion){real_t safe=1,unsafe=1;space->cast_motion(parameters,safe,unsafe);result=Vector2(safe,unsafe);return true;}
                PhysicsDirectSpaceState3D::ShapeResult results[64];const int count=space->intersect_shape(parameters,results,limit);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}result=hits;return true;
            }
            else {
                Node2D* spatial=Object::cast_to<Node2D>(node);PhysicsDirectSpaceState2D* space=spatial&&spatial->get_world_2d().is_valid()?spatial->get_world_2d()->get_direct_space_state():nullptr;if(!space)return false;
                if(ray){if(args[1].get_type()!=Variant::VECTOR2||args[2].get_type()!=Variant::VECTOR2)return false;PhysicsDirectSpaceState2D::RayParameters parameters;parameters.from=args[1];parameters.to=args[2];parameters.exclude=exclusions;parameters.collision_mask=mask;parameters.collide_with_areas=args[4];parameters.collide_with_bodies=args[5];parameters.hit_from_inside=args[9];PhysicsDirectSpaceState2D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}result=hits;return true;}
                if(args[0].get_type()!=Variant::OBJECT||args[1].get_type()!=Variant::TRANSFORM2D||args[2].get_type()!=Variant::VECTOR2)return false;Ref<Shape2D> shape=args[0];if(shape.is_null())return false;const Transform2D transform=args[1];if(Math::abs(transform.determinant())<1e-10)return false;
                PhysicsDirectSpaceState2D::ShapeParameters parameters;parameters.shape_rid=shape->get_rid();parameters.transform=transform;parameters.motion=args[2];parameters.margin=args[6];parameters.exclude=exclusions;parameters.collision_mask=mask;parameters.collide_with_areas=args[4];parameters.collide_with_bodies=args[5];
                if(motion){real_t safe=1,unsafe=1;space->cast_motion(parameters,safe,unsafe);result=Vector2(safe,unsafe);return true;}
                PhysicsDirectSpaceState2D::ShapeResult results[64];const int count=space->intersect_shape(parameters,results,limit);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}result=hits;return true;
            }
            return false;
        }

        bool tree_state_at(AnimationTree* tree,const String& path,const String& operation,const StringName& name,Variant& result)
        {
            if(!tree||!path.begins_with("parameters/")||!path.ends_with("/playback")||path.contains("..")||path.length()>256)return false;
            bool valid=false;Ref<AnimationNodeStateMachinePlayback> playback=tree->get(path,&valid);if(!valid||playback.is_null())return false;
            Ref<AnimationNode> node=tree->get_root_animation_node();const String route=path.trim_prefix("parameters/").trim_suffix("playback").trim_suffix("/");
            if(!route.is_empty())for(const String& part:route.split("/")){Ref<AnimationNodeBlendTree> blend=node;Ref<AnimationNodeStateMachine> machine=node;if(blend.is_valid()&&blend->has_node(part))node=blend->get_node(part);else if(machine.is_valid()&&machine->has_node(part))node=machine->get_node(part);else return false;}
            Ref<AnimationNodeStateMachine> machine=node;if(machine.is_null())return false;
            if(operation=="state"){result=playback->get_current_node();return true;}
            if(!machine->has_node(name))return false;if(operation=="travel")playback->travel(name);else playback->start(name);return true;
        }

        bool prepare_prefab(Root& root,Node* scope,Node* node)
        {
            if(!prepare_usability_prefab(root,node)||!prepare_composition_prefab(node)||!prepare_workflow_prefab(node)||!prepare_refinement_prefab(root,scope,node))return false;
            if(BaseButton* button=Object::cast_to<BaseButton>(node)){Ref<ButtonGroup> source=button->get_button_group(),copy;if(source.is_valid()){if(!private_group(root,source,button,copy))return false;button->set_button_group(copy);}}

            if(SubViewport* viewport=Object::cast_to<SubViewport>(node))if(!viewport->is_input_disabled()&&!Object::cast_to<SubViewportContainer>(viewport->get_parent()))return false;
            if(node->has_meta("__godot_react_viewport_path")){
                const String text=node->get_meta("__godot_react_viewport_path");const NodePath path(text);
                if(!text.is_empty()){
                    Node* candidate=path.is_absolute()||path.get_subname_count()?nullptr:node->get_node_or_null(path);SubViewport* source=Object::cast_to<SubViewport>(candidate);
                    if(!source||!scope->is_ancestor_of(source)||source->is_ancestor_of(node)||(!node->is_class("Sprite2D")&&!node->is_class("TextureRect")))return false;
                    // Prefab render consumers are kept in the outer viewport to avoid feedback cycles.
                    for(Node* parent=node->get_parent();parent&&parent!=scope;parent=parent->get_parent())if(Object::cast_to<SubViewport>(parent))return false;
                    node->set("texture",source->get_texture());
                }
            }
            if(node->is_class("AudioStreamPlayer")||node->is_class("AudioStreamPlayer2D")||node->is_class("AudioStreamPlayer3D")){const StringName logical=node->get("bus");if(const StringName* physical=root.audio_buses.getptr(logical))node->set("bus",*physical);}
            for(int i=0;i<node->get_child_count(false);++i)if(!prepare_prefab(root,scope,node->get_child(i,false)))return false;return true;
        }
