        int64_t subtree_particles(Node* node) const
        {
            if(!node)return 0;int64_t total=0;Vector<Node*> pending;pending.push_back(node);int budget=2048;while(!pending.is_empty()){Node* item=pending[pending.size()-1];pending.remove_at(pending.size()-1);if(--budget<0)return 65537;if(item->is_class("GPUParticles2D")||item->is_class("GPUParticles3D")){const int64_t count=item->get("amount");if(count<1||count>16384)return 65537;total+=count;if(total>65536)return total;}for(int j=0;j<item->get_child_count(true);++j)pending.push_back(item->get_child(j,true));}return total;
        }
        bool private_group(Root& root,const Ref<ButtonGroup>& source,BaseButton* button,Ref<ButtonGroup>& copy)
        {
            if(source.is_null())return true;const ObjectID id=source->get_instance_id();if(!root.button_groups.has(id)){Vector<ObjectID> unused;for(const KeyValue<ObjectID,Ref<ButtonGroup>>& entry:root.button_groups){List<BaseButton*> members;entry.value->get_buttons(&members);if(members.is_empty()||(members.size()==1&&members.front()->get()==button))unused.push_back(entry.key);}for(ObjectID key:unused)root.button_groups.erase(key);if(root.button_groups.size()>=32)return false;Ref<ButtonGroup> duplicate=source->duplicate();root.button_groups.insert(id,duplicate);}copy=root.button_groups[id];List<BaseButton*> members;copy->get_buttons(&members);return button->get_button_group()==copy||members.size()<64;
        }

        bool free_control(Control* control) const { return control && !Object::cast_to<Container>(control->get_parent()); }

        bool layout_tween(Owned& owned, Control* control, const String& action, const Array& args, Variant& result)
        {
            if(!free_control(control))return false;
            Ref<Tween>* current=owned.property_tweens.getptr("layout");
            if(action=="isRunning"&&args.is_empty()){result=current&&current->is_valid()&&(*current)->is_running();return true;}
            if(action=="cancel"&&args.is_empty()){if(current&&current->is_valid())(*current)->kill();owned.property_tweens.erase("layout");return true;}
            if(action=="start"){
                if(args.size()!=1||args[0].get_type()!=Variant::ARRAY||!control->is_inside_tree())return false;
                const Array plan=args[0];if(plan.size()<2||plan.size()>129||plan[0].get_type()!=Variant::ARRAY)return false;
                const Array config=plan[0];if(config.size()!=1||config[0].get_type()!=Variant::FLOAT||double(config[0])!=Math::floor(double(config[0]))||double(config[0])<0||double(config[0])>1000000)return false;
                Array steps;double duration=0;
                for(int j=1;j<plan.size();++j){if(plan[j].get_type()!=Variant::ARRAY)return false;Array step=plan[j];if(step.size()!=7||step[0].get_type()!=Variant::STRING)return false;String property=step[0];if(property=="pivotOffset")property="pivot_offset";
                    if(property!="position"&&property!="size"&&property!="rotation"&&property!="scale"&&property!="pivot_offset")return false;
                    if(property=="rotation"){if(step[1].get_type()!=Variant::FLOAT||Math::abs(double(step[1]))>1e6)return false;}
                    else{if(step[1].get_type()!=Variant::VECTOR2)return false;const Vector2 v=step[1];if(Math::abs(v.x)>1e6||Math::abs(v.y)>1e6)return false;if(property=="size"&&(v.x<control->get_combined_minimum_size().x||v.y<control->get_combined_minimum_size().y))return false;if(property=="scale"&&(v.x<=0||v.y<=0))return false;}
                    for(int k=2;k<=5;++k)if(step[k].get_type()!=Variant::FLOAT)return false;
                    if(double(step[2])<0||double(step[2])>86400||double(step[3])<0||double(step[3])>86400||double(step[4])!=Math::floor(double(step[4]))||double(step[4])<0||double(step[4])>11||double(step[5])!=Math::floor(double(step[5]))||double(step[5])<0||double(step[5])>3||step[6].get_type()!=Variant::BOOL)return false;
                    duration+=double(step[2])+double(step[3]);step[0]=property;steps.push_back(step);
                }
                if(duration<=0)return false;Ref<Tween> tween=control->create_tween();tween->set_loops(int(config[0]));for(int j=0;j<steps.size();++j){const Array step=steps[j];if(bool(step[6]))tween->parallel();else tween->chain();Ref<PropertyTweener> property=tween->tween_property(control,NodePath(String(step[0])),step[1],step[2]);property->set_delay(step[3]);property->set_trans(Tween::TransitionType(int(step[4])));property->set_ease(Tween::EaseType(int(step[5])));}if(current&&current->is_valid())(*current)->kill();owned.property_tweens.insert("layout",tween);return true;
            }
            if(!current||current->is_null()||!(*current)->is_valid())return false;
            if(action=="pause"&&args.is_empty()){(*current)->pause();return true;}
            if(action=="resume"&&args.is_empty()){(*current)->play();return true;}
            if(action=="advance"&&args.size()==1&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=0&&double(args[0])<=86400){(*current)->custom_step(args[0]);return true;}
            return false;
        }

        bool interaction_command(Root& root,Owned& owned,Node* node,const String& operation,const Array& args,Variant& result)
        {

#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
            if(operation.begins_with("spring_")){
                SpringArm3D* arm=Object::cast_to<SpringArm3D>(node);if(!arm||root.stage!="physics")return false;
                for(int j=owned.exceptions.size()-1;j>=0;--j){const NativeObjectID id=owned.exceptions[j];Node* target=resolve(root,id);if(target&&target->is_inside_tree())continue;if(const RID* rid=owned.exception_rids.getptr(*id))arm->remove_excluded_object(*rid);owned.exception_rids.erase(*id);owned.exceptions.remove_at(j);}
                if(operation=="spring_list"&&args.is_empty()){Array list;for(NativeObjectID id:owned.exceptions)if(Node* target=resolve(root,id))list.push_back(target);result=list;return true;}
                if(operation=="spring_clear"&&args.is_empty()){arm->clear_excluded_objects();owned.exceptions.clear();owned.exception_rids.clear();return true;}
                if(args.size()!=1||args[0].get_type()!=Variant::OBJECT)return false;CollisionObject3D* target=Object::cast_to<CollisionObject3D>(static_cast<Object*>(args[0]));const NativeObjectID id=target?environment->try_get_object_id(target):NativeObjectID();if(!target||!root.nodes.has(*id)||!target->is_inside_tree())return false;
                if(operation=="spring_add"){if(owned.exceptions.has(id))return true;if(owned.exceptions.size()>=64)return false;arm->add_excluded_object(target->get_rid());owned.exceptions.push_back(id);owned.exception_rids.insert(*id,target->get_rid());return true;}
                if(operation=="spring_remove"){if(owned.exceptions.has(id)){arm->remove_excluded_object(target->get_rid());owned.exceptions.erase(id);owned.exception_rids.erase(*id);}return true;}return false;
            }
#endif

            if(root.stage!="process")return false;
            if(operation.begins_with("layout_"))return layout_tween(owned,Object::cast_to<Control>(node),operation.trim_prefix("layout_"),args,result);
            if(operation.begins_with("ui_")){
                Control* control=Object::cast_to<Control>(node);if(!free_control(control)||args.size()!=1)return false;const String property=operation.trim_prefix("ui_");
                if(property=="rotation"){if(args[0].get_type()!=Variant::FLOAT||Math::abs(double(args[0]))>1e6)return false;control->set_rotation(args[0]);return true;}
                if(args[0].get_type()!=Variant::VECTOR2)return false;const Vector2 value=args[0];if(Math::abs(value.x)>1e6||Math::abs(value.y)>1e6)return false;
                if(property=="position")control->set_position(value);else if(property=="size"){if(value.x<control->get_combined_minimum_size().x||value.y<control->get_combined_minimum_size().y)return false;control->set_size(value);}else if(property=="scale"){if(value.x<=0||value.y<=0)return false;control->set_scale(value);}else if(property=="pivot")control->set_pivot_offset(value);else return false;return true;
            }
            if(operation=="gpu_restart"){
                if(!args.is_empty())return false;if(GPUParticles2D* two=Object::cast_to<GPUParticles2D>(node)){two->restart();return true;}
#if !defined(_3D_DISABLED)
                if(GPUParticles3D* three=Object::cast_to<GPUParticles3D>(node)){three->restart();return true;}
#endif
                return false;
            }
            if(operation=="group_pressed"||operation=="group_buttons"){
                BaseButton* button=Object::cast_to<BaseButton>(node);if(!button||!args.is_empty())return false;Ref<ButtonGroup> group=button->get_button_group();if(group.is_null()){result=operation=="group_buttons"?Variant(Array()):Variant();return true;}
                auto managed=[&](BaseButton* item)->bool{if(!item)return false;const NativeObjectID id=environment->try_get_object_id(item);return root.nodes.has(*id)&&item->is_inside_tree();};
                if(operation=="group_pressed"){BaseButton* selected=group->get_pressed_button();if(managed(selected))result=selected;return true;}
                List<BaseButton*> buttons;group->get_buttons(&buttons);if(buttons.size()>64)return false;Array list;for(BaseButton* item:buttons)if(managed(item))list.push_back(item);result=list;return true;
            }
            if(operation=="blend_set"||operation=="blend_get"){
                AnimationPlayer* player=Object::cast_to<AnimationPlayer>(node);const bool set=operation=="blend_set";if(!player||args.size()!=(set?3:2)||args[0].get_type()!=Variant::STRING||args[1].get_type()!=Variant::STRING)return false;const StringName from=String(args[0]),to=String(args[1]);if(!player->has_animation(from)||!player->has_animation(to))return false;if(set){if(args[2].get_type()!=Variant::FLOAT||double(args[2])<0||double(args[2])>600)return false;player->set_blend_time(from,to,args[2]);}result=player->get_blend_time(from,to);return true;
            }
            return false;
        }

        Variant navigation_event(Root& root,const Variant& value)
        {
            Dictionary output;if(value.get_type()!=Variant::DICTIONARY)return output;const Dictionary input=value;
            for(const char* field:{"position","type","owner","link_entry_position","link_exit_position"}){
                if(!input.has(field))continue;const Variant item=input[field];
                if(String(field)=="type"){if(item.get_type()==Variant::INT&&(int64_t(item)==0||int64_t(item)==1))output[field]=item;}
                else if(String(field)=="owner"){Object* object=item.get_type()==Variant::OBJECT?static_cast<Object*>(item):nullptr;if(object){const NativeObjectID id=environment->try_get_object_id(object);if(root.nodes.has(*id))output[field]=item;else output[field]=Variant();}}
                else if(item.get_type()==Variant::VECTOR2||item.get_type()==Variant::VECTOR3){const String key=String(field)=="link_entry_position"?"linkEntryPosition":String(field)=="link_exit_position"?"linkExitPosition":"position";output[key]=item;}
            }return output;
        }
