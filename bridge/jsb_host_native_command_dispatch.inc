// Shared schema-admitted native commands; caller validates scope and phase.
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

#if !defined(_3D_DISABLED)
            if(Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(node))if(method_text.contains("bone_")&&!values.empty()&&values[0].get_type()==Variant::INT&&(int64_t(values[0])<0||int64_t(values[0])>=skeleton->get_bone_count())){fail("E_SKELETON_BONE: bone index outside skeleton");return;}
#endif
            if(node->is_class("TabContainer")&&method_text=="set_current_tab"){const int count=node->call("get_tab_count");if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_TAB_INDEX: tab index outside current children");return;}}
            if((node->is_class("ShapeCast2D")||node->is_class("ShapeCast3D"))&&(method_text=="get_collider"||method_text=="get_collision_point"||method_text=="get_collision_normal")){const int count=node->call("get_collision_count");if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_SHAPE_INDEX: collision index outside current results");return;}}

#if !defined(_3D_DISABLED)
            if((method_text=="get_blend_shape_value"||method_text=="set_blend_shape_value")&&node->is_class("MeshInstance3D")){const int count=Object::cast_to<MeshInstance3D>(node)->get_blend_shape_count();if(values.empty()||int64_t(values[0])<0||int64_t(values[0])>=count){fail("E_BLEND_INDEX: index outside mesh blend shapes");return;}}
#endif
            if(method_text=="set_update_mode"&&(values.empty()||int64_t(values[0])<0||int64_t(values[0])>4)){fail("E_VIEWPORT_MODE: invalid update mode");return;}
            if(method_text=="queue"&&node->is_class("AnimationPlayer")&&(values.empty()||!Object::cast_to<AnimationPlayer>(node)->has_animation(values[0]))){fail("E_ANIMATION_NAME: unknown queued clip");return;}
            Callable::CallError error;
            const Variant result = binding->call(node, args.data(), (int) args.size(), error);
            if (error.error != Callable::CallError::CALL_OK) { fail("E_COMMAND_NATIVE: native call failed"); return; }
            if (!verify()) return;
            v8::Local<v8::Value> encoded;
            if (!state.safe_to_js(*root, context, result, encoded)) { fail("E_COMMAND_CODEC: unsupported result"); return; }
            info.GetReturnValue().Set(encoded); return;
