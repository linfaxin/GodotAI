// Shared property behavior. Caller validates lifetime and scope.
        if (op == READ || op == SET)
        {
            if (argc < 3 || !info[2]->IsString()) { fail("E_PROPERTY: native property required"); return; }
            const StringName property = impl::Helper::to_string(isolate, info[2]);
            if(String(property).begins_with("__react_refine_")){
                Variant value,result;const bool text=property==StringName("__react_refine_search_text");if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,text?Variant::STRING:Variant::INT)){fail("E_REFINEMENT_PROPERTY: invalid stage or value");return;}}if(!state.refine_search(*owned,node,property,value,op==SET,result)){fail("E_REFINEMENT_PROPERTY: invalid search state");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_REFINEMENT_PROPERTY: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(String(property).begins_with("__react_workflows_")){
                Variant value,result;if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,property==StringName("__react_workflows_menu")?Variant::ARRAY:Variant::OBJECT)){fail("E_WORKFLOW_PROPERTY: invalid stage or value");return;}}if(!state.workflow_special(*owned,node,property,value,op==SET,result)){fail("E_WORKFLOW_PROPERTY: invalid data");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_WORKFLOW_PROPERTY: invalid output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(String(property).begins_with("__react_composition_")){
                Variant value,result;if(op==SET){const String property_name=property;const Variant::Type hint=property_name=="__react_composition_text"?Variant::STRING:Variant::ARRAY;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,hint)){fail("E_COMPOSITION_PROPERTY: invalid value or stage");return;}}
                if(!state.composition_special(*owned,node,property,value,op==SET,result)){fail("E_COMPOSITION_PROPERTY: invalid target, items, selection or text");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_COMPOSITION_PROPERTY: unsupported output");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(Object::cast_to<Control>(node)&&(String(property).begins_with("focus_neighbor_")||property==StringName("focus_next")||property==StringName("focus_previous"))){
                const String text=String(property);if(text!="focus_next"&&text!="focus_previous"&&text!="focus_neighbor_left"&&text!="focus_neighbor_top"&&text!="focus_neighbor_right"&&text!="focus_neighbor_bottom"){fail("E_FOCUS_PATH: unsupported direction");return;}
                if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!info[3]->IsString()){fail("E_FOCUS_PATH: path requires commit");return;}const String path_text=impl::Helper::to_string(isolate,info[3]);const NodePath path(path_text);if(path_text.length()>512||path.is_absolute()||path.get_subname_count()){fail("E_FOCUS_PATH: local Control path required");return;}owned->focus_paths.insert(property,path);node->set(property,NodePath());}
                const NodePath* path=owned->focus_paths.getptr(property);info.GetReturnValue().Set(impl::Helper::new_string(isolate,path?String(*path):String()));return;
            }
            if(property==StringName("process_material")&&(node->is_class("GPUParticles2D")||node->is_class("GPUParticles3D"))){
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,Variant::OBJECT)){fail("E_GPU_MATERIAL: registered material required");return;}Ref<ParticleProcessMaterial> source=value;if(!value.is_null()&&source.is_null()){fail("E_GPU_MATERIAL: ParticleProcessMaterial required");return;}if(owned->particle_source!=source){owned->particle_source=source;owned->particle_instance=source.is_valid()?Ref<ParticleProcessMaterial>(source->duplicate()):Ref<ParticleProcessMaterial>();}node->set(property,owned->particle_instance);if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->particle_source,result)){fail("E_GPU_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(property==StringName("button_group")){
                BaseButton* button=Object::cast_to<BaseButton>(node);if(!button){fail("E_BUTTON_GROUP: BaseButton required");return;}
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,Variant::OBJECT)){fail("E_BUTTON_GROUP: registered group required");return;}Ref<ButtonGroup> source=value;if(!value.is_null()&&source.is_null()){fail("E_BUTTON_GROUP: ButtonGroup required");return;}Ref<ButtonGroup> copy;if(!state.private_group(*root,source,button,copy)){fail("E_BUTTON_GROUP: group/member budget exceeded");return;}owned->group_source=source;button->set_button_group(copy);if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->group_source,result)){fail("E_BUTTON_GROUP: result");return;}info.GetReturnValue().Set(result);return;
            }
            if((node->is_class("Area2D")||node->is_class("Area3D"))&&(property==StringName("gravity_direction")||property==StringName("gravity_point_center")||property==StringName("gravity_point"))){
                const bool two=node->is_class("Area2D"),point_property=property==StringName("gravity_point"),center=property==StringName("gravity_point_center");
                if(owned->gravity_direction.get_type()==Variant::NIL)owned->gravity_direction=two?Variant(Vector2(0,1)):Variant(Vector3(0,-1,0));
                if(owned->gravity_point_center.get_type()==Variant::NIL)owned->gravity_point_center=two?Variant(Vector2()):Variant(Vector3());
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,point_property?Variant::BOOL:two?Variant::VECTOR2:Variant::VECTOR3)){fail("E_AREA_GRAVITY: invalid property value");return;}
                    if(point_property)node->set(property,value);else if(center)owned->gravity_point_center=value;else owned->gravity_direction=value;
                    const bool point=node->get("gravity_point");node->set(point?"gravity_point_center":"gravity_direction",point?owned->gravity_point_center:owned->gravity_direction);if(!verify())return;
                }
                const Variant value=point_property?node->get(property):center?owned->gravity_point_center:owned->gravity_direction;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,value,encoded)){fail("E_AREA_GRAVITY: invalid result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if ((node->is_class("Joint2D") || node->is_class("Joint3D")) && (property == StringName("node_a") || property == StringName("node_b"))) {
                if (op == SET) {
                    if (!state.mutation_stage(*root) || argc != 4 || !info[3]->IsString()) { fail("E_JOINT_PATH: local path requires commit"); return; }
                    const String text = impl::Helper::to_string(isolate, info[3]); const NodePath path(text);
                    if (path.is_absolute() || path.get_subname_count() || text.contains("../..") || text.length() > 512) { fail("E_JOINT_PATH: path escapes joint scope"); return; }
                    state.unbind_joints(*root); if (property == StringName("node_a")) owned->joint_a = path; else owned->joint_b = path;
                    if (!verify()) return;
                }
                info.GetReturnValue().Set(impl::Helper::new_string(isolate, String(property == StringName("node_a") ? owned->joint_a : owned->joint_b))); return;
            }
            if((property==StringName("material")&&Object::cast_to<CanvasItem>(node))||(property==StringName("material_override")&&node->is_class("MeshInstance3D"))||(property==StringName("material_overlay")&&node->is_class("GeometryInstance3D"))){
                const int slot=property==StringName("material")?-1:property==StringName("material_overlay")?-3:-2;Variant source;
                if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],source,Variant::OBJECT)){fail("E_MATERIAL: expected registered material");return;}Ref<Material> material=source;if(!source.is_null()&&material.is_null()){fail("E_MATERIAL: expected material");return;}node->set(property,state.private_material(*owned,slot,material));if(!verify())return;}
                else{if(const Ref<ShaderMaterial>* original=owned->shader_sources.getptr(slot))source=*original;else source=node->get(property);}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,source,result)){fail("E_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(String(property).begins_with("__react_usability_")){
                const String name=property;Variant value,result;const bool set=op==SET;
                const Variant::Type hint=name.begins_with("__react_usability_fontsize")?Variant::INT:name=="__react_usability_fontcolor"?Variant::COLOR:name.begins_with("__react_usability_font_")?Variant::OBJECT:Variant::STRING;
                if(set&&(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,hint))){fail("E_USABILITY_PROPERTY: invalid value or phase");return;}
                if(!state.usability_special(*root,*owned,node,name,value,set,result)){fail("E_USABILITY_PROPERTY: invalid target, bus, font or range");return;}if(!verify())return;v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,result,encoded)){fail("E_USABILITY_PROPERTY: cannot encode result");return;}info.GetReturnValue().Set(encoded);return;
            }

#if !defined(_3D_DISABLED)
            if(property==StringName("__react_surface_materials")){
                MeshInstance3D* mesh=Object::cast_to<MeshInstance3D>(node);if(!mesh){fail("E_SURFACE_MATERIAL: MeshInstance3D required");return;}
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,Variant::ARRAY)){fail("E_SURFACE_MATERIAL: expected registered material array");return;}const Array materials=value;if(materials.size()>64){fail("E_SURFACE_MATERIAL: too many surfaces");return;}for(int i=0;i<materials.size();++i)if(materials[i].get_type()!=Variant::NIL){Ref<Resource> material=materials[i];if(material.is_null()||(!material->is_class("StandardMaterial3D")&&!material->is_class("ShaderMaterial"))){fail("E_SURFACE_MATERIAL: unsupported material");return;}}owned->surface_materials=materials;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->surface_materials,result)){fail("E_SURFACE_MATERIAL: result");return;}info.GetReturnValue().Set(result);return;
            }
#endif

            if(property==StringName("__react_layout")){
                Control* control=Object::cast_to<Control>(node);if(!control){fail("E_LAYOUT: layout requires Control");return;}
                if(op==SET){if(!state.mutation_stage(*root)||argc!=4){fail("E_LAYOUT: layout requires commit");return;}if(info[3]->IsNull()){owned->layout.clear();control->set_anchors_and_offsets_preset(Control::PRESET_TOP_LEFT);}else{Variant value;if(!state.safe_from_js(*root,context,info[3],value,Variant::ARRAY)){fail("E_LAYOUT: invalid layout");return;}Array edges=value;if(edges.size()!=8){fail("E_LAYOUT: expected eight layout edges");return;}for(int i=0;i<8;++i)if(edges[i].get_type()!=Variant::FLOAT||double(edges[i])<(i<4?0:-1e6)||double(edges[i])>(i<4?1:1e6)){fail("E_LAYOUT: invalid layout edge");return;}if(double(edges[0])>double(edges[2])||double(edges[1])>double(edges[3])){fail("E_LAYOUT: anchors must be ordered");return;}owned->layout=edges;for(int i=0;i<4;++i)control->set_anchor(Side(i),edges[i],false,true);for(int i=0;i<4;++i)control->set_offset(Side(i),edges[i+4]);}if(!verify())return;}
                v8::Local<v8::Value> result;if(!state.safe_to_js(*root,context,owned->layout.is_empty()?Variant():Variant(owned->layout),result)){fail("E_LAYOUT: result");return;}info.GetReturnValue().Set(result);return;
            }
            if(property==StringName("__react_viewport_texture")||property==StringName("__react_bus")){
                const bool viewport=property==StringName("__react_viewport_texture");if(viewport&&!node->is_class("Sprite2D")&&!node->is_class("TextureRect")){fail("E_VIEWPORT_PATH: unsupported texture target");return;}
                if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!info[3]->IsString()){fail("E_PROPERTY_PROFILE: binding requires a string and commit");return;}const String value=impl::Helper::to_string(isolate,info[3]);if(value.length()>512){fail("E_PROPERTY_PROFILE: binding too long");return;}if(viewport){const NodePath path(value);if(path.is_absolute()||path.get_subname_count()){fail("E_VIEWPORT_PATH: expected local source");return;}if(owned->viewport_path!=value){owned->viewport_path=value;node->set("texture",Variant());}}else{if(!value.is_empty()&&!root->audio_buses.has(value)){fail("E_AUDIO_BUS: bus is not registered in this root");return;}owned->audio_bus=value;}if(!verify())return;}
                info.GetReturnValue().Set(impl::Helper::new_string(isolate,viewport?owned->viewport_path:owned->audio_bus));return;
            }
            if(property==StringName("bus")&&(node->is_class("AudioStreamPlayer")||node->is_class("AudioStreamPlayer2D")||node->is_class("AudioStreamPlayer3D"))){
                String logical=node->get("bus");for(const KeyValue<StringName,StringName>& entry:root->audio_buses)if(entry.value==logical){logical=entry.key;break;}
                if(op==SET){if(!state.mutation_stage(*root)||argc!=4||!info[3]->IsString()){fail("E_AUDIO_BUS: bus requires commit");return;}logical=impl::Helper::to_string(isolate,info[3]);const StringName* scoped=root->audio_buses.getptr(logical);const String physical=scoped?String(*scoped):logical;if(AudioServer::get_singleton()->get_bus_index(physical)<0){fail("E_AUDIO_BUS: bus does not exist");return;}node->set("bus",physical);if(!verify())return;}
                info.GetReturnValue().Set(impl::Helper::new_string(isolate,logical));return;
            }
            const String prop_text=property;
            if(node->is_class("Label")&&(prop_text=="theme_override_colors/font_outline_color"||prop_text=="theme_override_colors/font_shadow_color"||prop_text=="theme_override_constants/outline_size"||prop_text=="theme_override_constants/shadow_offset_x"||prop_text=="theme_override_constants/shadow_offset_y"||prop_text=="theme_override_constants/shadow_outline_size")){
                Control* label=Object::cast_to<Control>(node);const bool color=prop_text.begins_with("theme_override_colors/");const StringName name=prop_text.get_slice("/",1);if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,color?Variant::COLOR:Variant::INT)){fail("E_LABEL_STYLE: invalid value or phase");return;}if(color)label->add_theme_color_override(name,value);else{const bool offset=String(name).begins_with("shadow_offset_");if(int64_t(value)<(offset?-256:0)||int64_t(value)>(offset?256:64)){fail("E_LABEL_STYLE: constant out of bounds");return;}label->add_theme_constant_override(name,value);}if(!verify())return;}const Variant stored=color?Variant(label->get_theme_color(name)):Variant(label->get_theme_constant(name));v8::Local<v8::Value> encoded;if(!state.safe_to_js(*root,context,stored,encoded)){fail("E_LABEL_STYLE: invalid result");return;}info.GetReturnValue().Set(encoded);return;
            }
            if(prop_text.begins_with("theme_override_"))
            {
                Control* control=Object::cast_to<Control>(node);if(!control){fail("E_PROPERTY_PROFILE: theme requires Control");return;}
                const bool font=prop_text=="theme_override_fonts/font",size=prop_text=="theme_override_font_sizes/font_size",color=prop_text=="theme_override_colors/font_color",style=prop_text=="theme_override_styles/separator"||prop_text=="theme_override_styles/panel"||(node->is_class("BaseButton")&&(prop_text=="theme_override_styles/normal"||prop_text=="theme_override_styles/hover"||prop_text=="theme_override_styles/pressed"||prop_text=="theme_override_styles/disabled"||prop_text=="theme_override_styles/focus"));
                const StringName style_name=style?StringName(prop_text.trim_prefix("theme_override_styles/")):StringName();
                if(!(font||size||color||style)&&!prop_text.begins_with("theme_override_constants/margin_")){fail("E_PROPERTY_PROFILE: unsupported theme override");return;}
                if(font||size||color||style){
                    if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,size?Variant::INT:color?Variant::COLOR:Variant::OBJECT)){fail("E_VALUE_CODEC: invalid theme value");return;}
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
                if(op==SET){Variant value;if(!state.mutation_stage(*root)||argc!=4||!state.safe_from_js(*root,context,info[3],value,mesh?Variant::OBJECT:Variant::ARRAY)){fail("E_VALUE_CODEC: invalid special property");return;}
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

#if !defined(_3D_DISABLED)
                Skeleton3D* skeleton=(prefab||library)?nullptr:Object::cast_to<Skeleton3D>(node);
                if(!prefab&&!library&&!skeleton){fail("E_PROPERTY_PROFILE: skeleton profile requires Skeleton3D");return;}
#else
                if(!prefab&&!library){fail("E_PROPERTY_PROFILE: 3D skeletons are unavailable in this engine");return;}
#endif
                if(op==SET)
                {
                    if(!state.mutation_stage(*root)||argc!=4){fail("E_PHASE: native scene configuration requires a commit");return;}
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

#if !defined(_3D_DISABLED)
                        Ref<SkeletonProfile> profile=value;
                        if(!value.is_null()&&profile.is_null()){fail("E_ASSET_TYPE: SkeletonProfile required");return;}
                        if(owned->skeleton_profile!=profile)
                        {
                            if(!apply_skeleton_profile(skeleton,profile)){fail("E_SKELETON_PROFILE: invalid bone hierarchy");return;}
                            owned->skeleton_profile=profile;
                        }
#endif

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
            if(op==SET&&(property==StringName("node_a")||property==StringName("node_b"))){if(argc!=4||!info[3]->IsString()){fail("E_JOINT_PATH: expected local path");return;}const String text=impl::Helper::to_string(isolate,info[3]);NodePath path(text);if(path.is_absolute()||path.get_subname_count()||text.contains("../..")){fail("E_JOINT_PATH: path escapes joint scope");return;}}
            if (op == READ)
            {
                v8::Local<v8::Value> result;
                if (!state.safe_to_js(*root, context, previous, result)) { fail("E_VALUE_CODEC: native value cannot cross the safe bridge"); return; }
                info.GetReturnValue().Set(result); return;
            }
            if (!state.mutation_stage(*root) || argc != 4 || !mutable_property(property)) { fail("E_PROPERTY_PERMISSION: " + String(property) + " unsupported property or wrong stage"); return; }
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
