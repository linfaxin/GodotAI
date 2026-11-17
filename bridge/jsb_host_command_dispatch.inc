// Shared virtual commands. Caller supplies its admitted dispatch phase.
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

#if !defined(_3D_DISABLED)
            if(method_text=="__react_blend_names"){
                MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(root->stage!="process"||!mesh||info[3].As<v8::Array>()->Length()!=0){fail("E_BLEND_SHAPE: invalid target");return;}Array names;for(int i=0;i<mesh->get_blend_shape_count();++i)names.push_back(mesh->get_mesh()->get_blend_shape_name(i));v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,names,encoded))return;info.GetReturnValue().Set(encoded);return;
            }
#endif

            if(method_text.begins_with("__react_tween_")||method_text.begins_with("__react_multimesh_")||method_text.begins_with("__react_query_")){
                const bool query=method_text.begins_with("__react_query_");if(root->stage!=(query?"physics":"process")){fail("E_COMMAND_PHASE: extension command outside frame phase");return;}
                const auto input=info[3].As<v8::Array>();std::vector<Variant> args(input->Length());
                for(uint32_t i=0;i<input->Length();++i){v8::Local<v8::Value> item;if(!input->Get(context,i).ToLocal(&item)||!state.safe_from_js(*root,context,item,args[i])){fail("E_COMMAND_CODEC: invalid extension argument");return;}}
                Variant result;bool valid=false;
                if(method_text.begins_with("__react_tween_")){
                    const String operation=method_text.trim_prefix("__react_tween_");
                    if(operation=="start"&&args.size()==1&&args[0].get_type()==Variant::ARRAY){Array plan=args[0];bool okay=plan.size()>=2&&plan.size()<=129&&plan[0].get_type()==Variant::ARRAY;Array config=okay?Array(plan[0]):Array();okay=okay&&config.size()==1&&config[0].get_type()==Variant::FLOAT&&double(config[0])==Math::floor(double(config[0]));int loops=okay?int(config[0]):-1;okay=okay&&loops>=0&&loops<=1000000;double duration=0;
                        for(int i=1;okay&&i<plan.size();++i){if(plan[i].get_type()!=Variant::ARRAY){okay=false;break;}Array step=plan[i];if(step.size()!=7||step[0].get_type()!=Variant::STRING){okay=false;break;}String property=step[0];Variant current=node->get(property);if((property!="position"&&property!="rotation"&&property!="scale")||current.get_type()!=step[1].get_type()||step[2].get_type()!=Variant::FLOAT||step[3].get_type()!=Variant::FLOAT||double(step[2])<0||double(step[3])<0||double(step[2])>86400||double(step[3])>86400||step[4].get_type()!=Variant::FLOAT||step[5].get_type()!=Variant::FLOAT||double(step[4])!=Math::floor(double(step[4]))||double(step[5])!=Math::floor(double(step[5]))||int(step[4])<0||int(step[4])>11||int(step[5])<0||int(step[5])>3||step[6].get_type()!=Variant::BOOL)okay=false;else duration+=double(step[2])+double(step[3]);}
                        if(okay&&duration>0&&node->is_inside_tree()&&(Object::cast_to<Node2D>(node)||node->is_class("Node3D"))){Ref<Tween> tween=node->create_tween();tween->set_loops(loops);for(int i=1;i<plan.size();++i){Array step=plan[i];if(bool(step[6]))tween->parallel();else tween->chain();Ref<PropertyTweener> property=tween->tween_property(node,NodePath(String(step[0])),step[1],step[2]);property->set_delay(step[3]);property->set_trans(Tween::TransitionType(int(step[4])));property->set_ease(Tween::EaseType(int(step[5])));}if(owned->tween.is_valid())owned->tween->kill();owned->tween=tween;valid=true;}
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
#if defined(_3D_DISABLED) || defined(PHYSICS_3D_DISABLED)
                    if(three){fail("E_EXTENSION_COMMAND: 3D physics is unavailable");return;}
#endif
                    if((ray||shape)&&args.size()==(ray?5:6)&&args[1].get_type()==vector&&args[2].get_type()==Variant::FLOAT&&double(args[2])>=0&&double(args[2])<=4294967295.0&&Math::floor(double(args[2]))==double(args[2])&&args[3].get_type()==Variant::BOOL&&args[4].get_type()==Variant::BOOL){Array hits;const uint32_t mask=uint32_t(int64_t(args[2]));const bool areas=args[3],bodies=args[4];if(!ray&&(args[5].get_type()!=Variant::FLOAT||double(args[5])<1||double(args[5])>64||Math::floor(double(args[5]))!=double(args[5]))){fail("E_QUERY: invalid result limit");return;}const int max=ray?1:int(args[5]);

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
                        if(three){Node3D* spatial=Object::cast_to<Node3D>(node);PhysicsDirectSpaceState3D* space=spatial&&spatial->get_world_3d().is_valid()?spatial->get_world_3d()->get_direct_space_state():nullptr;if(space){if(ray&&args[0].get_type()==vector){PhysicsDirectSpaceState3D::RayParameters parameters;parameters.from=args[0];parameters.to=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState3D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}valid=true;}else if(shape){Ref<Shape3D> resource=args[0];if(resource.is_valid()){PhysicsDirectSpaceState3D::ShapeParameters parameters;parameters.shape_rid=resource->get_rid();parameters.transform.origin=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState3D::ShapeResult results[64];int count=space->intersect_shape(parameters,results,max);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}valid=true;}}}}else
#endif

                        {Node2D* spatial=Object::cast_to<Node2D>(node);PhysicsDirectSpaceState2D* space=spatial&&spatial->get_world_2d().is_valid()?spatial->get_world_2d()->get_direct_space_state():nullptr;if(space){if(ray&&args[0].get_type()==vector){PhysicsDirectSpaceState2D::RayParameters parameters;parameters.from=args[0];parameters.to=args[1];parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState2D::RayResult hit;if(space->intersect_ray(parameters,hit)){hits.push_back(hit.collider);hits.push_back(hit.position);hits.push_back(hit.normal);hits.push_back(hit.shape);}valid=true;}else if(shape){Ref<Shape2D> resource=args[0];if(resource.is_valid()){PhysicsDirectSpaceState2D::ShapeParameters parameters;parameters.shape_rid=resource->get_rid();parameters.transform.set_origin(args[1]);parameters.collision_mask=mask;parameters.collide_with_areas=areas;parameters.collide_with_bodies=bodies;PhysicsDirectSpaceState2D::ShapeResult results[64];int count=space->intersect_shape(parameters,results,max);for(int i=0;i<count;++i){Array hit;hit.push_back(compat::ObjectDB::get_instance(results[i].collider_id));hit.push_back(results[i].shape);hits.push_back(hit);}valid=true;}}}}
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
                        AnimationPlayer* player=Object::cast_to<AnimationPlayer>(target);
#if !defined(_3D_DISABLED)
                        Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(target);
#endif
                        if(operation=="animations"&&input->Length()==1&&player){List<StringName> names;player->get_animation_list(&names);Array values;for(const StringName& name:names)values.push_back(name);result=values;valid=true;}
                        else if(operation=="play"&&input->Length()==5&&player){String name;Variant blend,speed,back;if(string_arg(1,name)&&player->has_animation(name)&&value_arg(2,blend,Variant::FLOAT)&&value_arg(3,speed,Variant::FLOAT)&&value_arg(4,back,Variant::BOOL)){player->play(name,blend,speed,back);valid=true;}}
                        else if(operation=="pause"&&input->Length()==1&&player){player->pause();valid=true;}
                        else if(operation=="seek"&&input->Length()==3&&player){Variant seconds,update;if(value_arg(1,seconds,Variant::FLOAT)&&double(seconds)>=0&&value_arg(2,update,Variant::BOOL)){player->seek(seconds,update);valid=true;}}
                        else if(operation=="stop"&&input->Length()==2&&player){Variant keep;if(value_arg(1,keep,Variant::BOOL)){player->stop(keep);valid=true;}}
                        else if(operation=="advance"&&input->Length()==2){if(AnimationMixer* mixer=Object::cast_to<AnimationMixer>(target)){Variant delta;if(value_arg(1,delta,Variant::FLOAT)){mixer->advance(delta);valid=true;}}}
                        else if(operation=="position2d"&&input->Length()==1){if(Node2D* spatial=Object::cast_to<Node2D>(target)){result=spatial->get_position();valid=true;}}

#if !defined(_3D_DISABLED)
                        else if(operation=="position"&&input->Length()==1){if(Node3D* spatial=Object::cast_to<Node3D>(target)){result=spatial->get_position();valid=true;}}
#endif
                        else if(operation=="is_playing"&&input->Length()==1&&player){result=player->is_playing();valid=true;}
                        else if(operation=="animation_position"&&input->Length()==1&&player){result=player->get_current_animation_position();valid=true;}

#if !defined(_3D_DISABLED)
                        else if(operation=="blend_names"&&input->Length()==1){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Array names;for(int i=0;i<mesh->get_blend_shape_count();++i)names.push_back(mesh->get_mesh()->get_blend_shape_name(i));result=names;valid=true;}}
                        else if(operation=="blend_get"&&input->Length()==2){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Variant index;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<mesh->get_blend_shape_count()){result=mesh->get_blend_shape_value(index);valid=true;}}}
                        else if(operation=="blend_set"&&input->Length()==3){if(MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(target)){Variant index,value;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<mesh->get_blend_shape_count()&&value_arg(2,value,Variant::FLOAT)){mesh->set_blend_shape_value(index,value);valid=true;}}}

#endif
#if !defined(_3D_DISABLED)
                        else if(operation=="bone_reset"&&input->Length()==1&&skeleton){skeleton->reset_bone_poses();valid=true;}
#endif
#if !defined(_3D_DISABLED)
                        else if(operation.begins_with("bone_set_")&&input->Length()==3&&skeleton){Variant index,value;const bool rotation=operation=="bone_set_rotation";if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<skeleton->get_bone_count()&&value_arg(2,value,rotation?Variant::QUATERNION:Variant::VECTOR3)){if(rotation)skeleton->set_bone_pose_rotation(index,value);else if(operation=="bone_set_position")skeleton->set_bone_pose_position(index,value);else if(operation=="bone_set_scale")skeleton->set_bone_pose_scale(index,value);else{fail("E_SCENE_COMMAND: unknown bone command");return;}valid=true;}}
#endif
#if !defined(_3D_DISABLED)
                        else if(operation=="bone_count"&&input->Length()==1&&skeleton){result=skeleton->get_bone_count();valid=true;}
#endif
#if !defined(_3D_DISABLED)
                        else if((operation=="bone_position"||operation=="bone_rotation")&&input->Length()==2&&skeleton){Variant index;if(value_arg(1,index,Variant::INT)&&int64_t(index)>=0&&int64_t(index)<skeleton->get_bone_count()){result=operation=="bone_position"?Variant(skeleton->get_bone_pose_position(index)):Variant(skeleton->get_bone_pose_rotation(index));valid=true;}}
#endif
                        else if((operation=="parameter"||operation=="parameter_integer"||operation=="parameter_boolean"||operation=="parameter_vector2")&&input->Length()==3){String name;Variant value;const Variant::Type hint=operation=="parameter_integer"?Variant::INT:operation=="parameter_boolean"?Variant::BOOL:operation=="parameter_vector2"?Variant::VECTOR2:Variant::FLOAT;if(string_arg(1,name)&&value_arg(2,value,hint))valid=tree_parameter(Object::cast_to<AnimationTree>(target),name,value);}
                        else if((operation=="travel"||operation=="start")&&input->Length()==2){String name;if(string_arg(1,name))valid=tree_state(Object::cast_to<AnimationTree>(target),operation,name,result);}
                        else if(operation=="state"&&input->Length()==1)valid=tree_state(Object::cast_to<AnimationTree>(target),"state",StringName(),result);
                    }
                }
                if(!valid){fail("E_SCENE_COMMAND: invalid scene path, command, parameter or target type");return;}
                if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMMAND_CODEC: scene result is not value data");return;}info.GetReturnValue().Set(encoded);return;
            }
