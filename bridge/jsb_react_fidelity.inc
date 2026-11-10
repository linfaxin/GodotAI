        bool fidelity_property(Node* node,const StringName& name,const Variant& value)
        {
            const String field=name;
            if(field=="path_search_max_polygons")return value.get_type()==Variant::INT&&int64_t(value)>=1&&int64_t(value)<=4096;
            if(field=="layout_direction")return value.get_type()==Variant::INT&&int64_t(value)>=0&&int64_t(value)<=4;
            if(field=="anchor_mode")return value.get_type()==Variant::INT&&int64_t(value)>=0&&int64_t(value)<=1;
            if(field=="round_precision")return value.get_type()==Variant::INT&&int64_t(value)>=1&&int64_t(value)<=64;
            if(field=="size_flags_stretch_ratio")return double(value)>=.001&&double(value)<=1024;
            if(field=="sharp_limit")return double(value)>=0&&double(value)<=128;
            if(field=="invert_border")return double(value)>=0&&double(value)<=10000;
            if(field=="path_search_max_distance"||field=="path_return_max_radius")return double(value)>=0&&double(value)<=1e6;
            if(field=="vertex_colors")return value.get_type()==Variant::PACKED_COLOR_ARRAY&&PackedColorArray(value).size()<=256;
            if(node->is_class("Polygon2D")&&(field=="offset"||field=="texture_offset"||field=="texture_scale")){const Vector2 v=value;return Math::abs(v.x)<=10000&&Math::abs(v.y)<=10000&&(field!="texture_scale"||(v.x!=0&&v.y!=0));}
            if(node->is_class("CPUParticles2D")||node->is_class("CPUParticles3D")){
                for(const char* prefix:{"angle","radial_accel","tangential_accel","orbit_velocity","hue_variation"})if(field==String(prefix)+"_min"||field==String(prefix)+"_max"){const double maximum=String(prefix)=="angle"?3600:String(prefix)=="orbit_velocity"?1000:String(prefix)=="hue_variation"?1:10000;return Math::abs(double(value))<=maximum;}
            }
            return true;
        }
        bool fidelity_command(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {
            if(root.stage!="process")return false;
            if(operation=="camera_align"){
                if(!node->is_class("Camera2D")||!args.is_empty())return false;node->call("align");return true;
            }
            if(operation=="camera_project"){
                if(!node->is_class("Camera3D")||args.size()!=2||args[0].get_type()!=Variant::VECTOR2||args[1].get_type()!=Variant::FLOAT)return false;
                const Vector2 point=args[0];const double depth=args[1];if(depth<=0||depth>1e6||Math::abs(point.x)>1e6||Math::abs(point.y)>1e6)return false;result=node->call("project_position",point,depth);return true;
            }
            AnimationPlayer* player=Object::cast_to<AnimationPlayer>(node);if(!player)return false;
            if(operation=="animation_reset"){if(!args.is_empty())return false;player->reset_section();return true;}
            const bool backwards=operation=="animation_backwards";
            if((!backwards&&operation!="animation_section")||args.size()!=(backwards?4:6)||args[0].get_type()!=Variant::STRING)return false;
            const StringName animation=String(args[0]);if(!player->has_animation(animation))return false;
            for(int j=1;j<(backwards?4:5);++j)if(args[j].get_type()!=Variant::FLOAT)return false;
            const double start=args[1],end=args[2],blend=args[3],length=player->get_animation(animation)->get_length();
            if(start<0||end<=start||end>length||end>600||blend<-1||blend>60)return false;
            if(backwards){player->play_section_backwards(animation,start,end,blend);return true;}
            if(args[5].get_type()!=Variant::BOOL)return false;const double speed=args[4];if(Math::abs(speed)>16)return false;
            player->play_section(animation,start,end,blend,speed,bool(args[5]));return true;
        }
