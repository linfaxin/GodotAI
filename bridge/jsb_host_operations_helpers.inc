        bool is_structural(const StringName& p_method)
        {
            const String method = p_method;
            return method == "free" || method == "queue_free" || method == "add_child"
                || method == "add_sibling" || method == "remove_child" || method == "move_child"
                || method == "reparent" || method == "replace_by" || method == "duplicate"
                || method == "set_name" || method == "set_owner" || method == "set_script"
                || method == "set_unique_name_in_owner";
        }

// Shared bounded domain helpers; no renderer ownership or VM roots.
#include "jsb_host_rich_text.inc"

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


#if !defined(_3D_DISABLED)
        bool apply_skeleton_profile(Skeleton3D* skeleton,const Ref<SkeletonProfile>& profile)
        {
            const int count=profile.is_valid()?profile->get_bone_size():0;
            if(count>256)return false;HashMap<StringName,int> names;
            for(int i=0;i<count;++i){const StringName name=profile->get_bone_name(i),parent=profile->get_bone_parent(i);if(name==StringName()||names.has(name)||(parent!=StringName()&&!names.has(parent)))return false;names.insert(name,i);}
            skeleton->clear_bones();
            for(int i=0;i<count;++i){skeleton->add_bone(profile->get_bone_name(i));const StringName parent=profile->get_bone_parent(i);if(parent!=StringName())skeleton->set_bone_parent(i,names[parent]);skeleton->set_bone_rest(i,profile->get_reference_pose(i));}
            skeleton->reset_bone_poses();return true;
        }
#endif


        bool validate_scene_targets(Node* root,Node* node,int& budget)
        {
            const Node* parent=node->get_parent();const bool private_ui=node->is_internal()&&parent&&((node->get_class()==StringName("SplitContainerDragger")&&parent->is_class("SplitContainer"))||(node->get_class()==StringName("TabBar")&&parent->is_class("TabContainer"))||(node->get_class()==StringName("PopupMenu")&&parent->is_class("MenuButton")));
            if(--budget<0||!node->get_script().is_null()||(!allowed_class(node->get_class())&&!private_ui))return false;
            if(node->is_class("Parallax2D")){const Vector2 size=node->get("repeat_size"),scale=node->get("scale");const int count=node->get("repeat_times");if(count<1||count>16||size.x<0||size.y<0||size.x>16384||size.y>16384||scale.x<=0||scale.y<=0)return false;}
            if(node->has_meta("__godot_react_profile"))
            {

#if !defined(_3D_DISABLED)
                Skeleton3D* skeleton=Object::cast_to<Skeleton3D>(node);Ref<SkeletonProfile> profile=node->get_meta("__godot_react_profile");
                if(!skeleton||profile.is_null()||!apply_skeleton_profile(skeleton,profile))return false;
#endif
#if defined(_3D_DISABLED)
                return false;
#endif
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

#include "jsb_host_text_limit.inc"

