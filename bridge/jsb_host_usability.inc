        bool prepare_usability_prefab(Root& root,Node* node) {
            if(RichTextLabel* rich=Object::cast_to<RichTextLabel>(node))if(!rich_text_valid(rich->get_text(),rich->is_using_bbcode()))return false;
            for(const char* meta:{"__godot_react_area_audio_bus","__godot_react_area_reverb_bus"})if(node->has_meta(meta)){
                const bool reverb=String(meta)=="__godot_react_area_reverb_bus";if((!node->is_class("Area2D")&&!node->is_class("Area3D"))||(reverb&&!node->is_class("Area3D")))return false;
                const Variant entry=node->get_meta(meta);if(entry.get_type()!=Variant::STRING)return false;const String logical=entry;if(logical.length()>64)return false;const StringName* physical=root.audio_buses.getptr(logical);if(logical!="Master"&&!physical)return false;node->set(reverb?"reverb_bus_name":"audio_bus_name",physical?Variant(*physical):Variant(StringName("Master")));
            }return true;
        }
        bool usability_special(Root& root,Owned& owned,Node* node,const String& property,const Variant& value,bool set,Variant& result) {
            if(property=="__react_usability_audio_bus"||property=="__react_usability_reverb_bus"){
                const bool reverb=property=="__react_usability_reverb_bus";if((!node->is_class("Area2D")&&!node->is_class("Area3D"))||(reverb&&!node->is_class("Area3D")))return false;
                const StringName name=reverb?StringName("reverb_bus_name"):StringName("audio_bus_name");
                if(set){const String logical=value;if(logical.length()>64)return false;const StringName* physical=root.audio_buses.getptr(logical);if(logical!="Master"&&!physical)return false;node->set(name,physical?Variant(*physical):Variant(StringName("Master")));}
                String logical=node->get(name);for(const KeyValue<StringName,StringName>& bus:root.audio_buses)if(bus.value==StringName(logical)){logical=bus.key;break;}result=logical;return true;
            }
            RichTextLabel* rich=Object::cast_to<RichTextLabel>(node);if(!rich)return false;
            if(property.begins_with("__react_usability_font_")){
                const StringName theme=property.trim_prefix("__react_usability_font_");if(theme!="normal_font"&&theme!="bold_font"&&theme!="italics_font"&&theme!="bold_italics_font"&&theme!="mono_font")return false;
                if(set){Ref<Font> font=value;if(!value.is_null()&&font.is_null())return false;if(font.is_valid())rich->add_theme_font_override(theme,font);else rich->remove_theme_font_override(theme);}
                result=rich->has_theme_font_override(theme)?Variant(rich->get_theme_font(theme)):Variant();return true;
            }
            if(property=="__react_usability_fontsize"||property.begins_with("__react_usability_fontsize_")){
                const StringName theme=property=="__react_usability_fontsize"?StringName("normal_font_size"):StringName(property.trim_prefix("__react_usability_fontsize_"));if(theme!="normal_font_size"&&theme!="bold_font_size"&&theme!="italics_font_size"&&theme!="bold_italics_font_size"&&theme!="mono_font_size")return false;
                if(set){if(value.get_type()!=Variant::INT||int64_t(value)<1||int64_t(value)>256)return false;rich->add_theme_font_size_override(theme,value);}result=rich->get_theme_font_size(theme);return true;
            }
            if(property=="__react_usability_fontcolor"){if(set){if(value.get_type()!=Variant::COLOR)return false;rich->add_theme_color_override("default_color",value);}result=rich->get_theme_color("default_color");return true;}
            return false;
        }
        bool usability_property(Owned& owned,Node* node,const String& property,const Variant& value) {
            if(RichTextLabel* rich=Object::cast_to<RichTextLabel>(node)){
                if(property=="text"){if(!rich_text_valid(value,rich->is_using_bbcode()))return false;owned.rich_images=0;}
                if(property=="bbcode_enabled"&&bool(value)&&!rich_text_valid(rich->get_text(),true))return false;
            }
            if(property=="size_2d_override"){const Vector2i size=value;return size.x>=0&&size.y>=0&&size.x<=4096&&size.y<=4096;}
            if(property=="playback_type")return int64_t(value)>=0&&int64_t(value)<=2;
            if(property=="render_target_clear_mode")return int64_t(value)>=0&&int64_t(value)<=2;
            if(property=="clear_margin"||property=="fit_margin")return double(value)>=0&&double(value)<=1024;
            if(property=="page"){Range* range=Object::cast_to<Range>(node);return range&&double(value)>=0&&double(value)<=1e9&&double(value)<=range->get_max()-range->get_min();}
            if(property=="exp_edit"&&bool(value)){Range* range=Object::cast_to<Range>(node);return range&&range->get_min()>=0&&range->get_max()>range->get_min()&&(range->get_min()>0||range->get_max()>1);}
            if(property=="emission_angle_degrees")return double(value)>=0&&double(value)<=90;
            if(property=="attenuation_filter_cutoff_hz")return double(value)>=20&&double(value)<=20500;
            if(property=="emission_angle_filter_attenuation_db"||property=="attenuation_filter_db")return double(value)>=-80&&double(value)<=0;
            if(property=="reverb_bus_amount"||property=="reverb_bus_uniformity")return double(value)>=0&&double(value)<=1;
            if(property=="prefix"&&node->is_class("SpinBox"))return String(value).length()<=256;
            if(property=="alignment"&&node->is_class("LineEdit"))return int64_t(value)>=0&&int64_t(value)<=3;
            return true;
        }
        bool usability_command(Root& root,Owned& owned,Node* node,const String& op,const Array& args,Variant& result) {
            if(op=="rich_configure") {RichTextLabel* rich=Object::cast_to<RichTextLabel>(node);if(!mutation_stage(root)||!rich||args.size()!=2||args[0].get_type()!=Variant::STRING||args[1].get_type()!=Variant::BOOL||!rich_text_valid(args[0],bool(args[1])))return false;rich->set_use_bbcode(false);rich->set_text(args[0]);rich->set_use_bbcode(args[1]);owned.rich_images=0;return true;}
            if(root.stage!="process")return false;
            if(op=="range_ratio") {Range* range=Object::cast_to<Range>(node);if(!range||args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])<0||double(args[0])>1)return false;range->set_as_ratio(args[0]);return true;}
            if(op=="edit"||op=="unedit"){LineEdit* edit=Object::cast_to<LineEdit>(node);if(!edit||!args.is_empty())return false;if(op=="edit")edit->edit();else edit->unedit();return true;}
            if(op=="clear_mode"){SubViewport* viewport=Object::cast_to<SubViewport>(node);if(!viewport||args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>2)return false;viewport->set_clear_mode(SubViewport::ClearMode(int(args[0])));return true;}
            RichTextLabel* rich=Object::cast_to<RichTextLabel>(node);if(!rich)return false;
            if(op=="rich_set"||op=="rich_append"){
                if(args.size()!=1||args[0].get_type()!=Variant::STRING||!rich_text_valid(args[0],rich->is_using_bbcode()))return false;const String text=args[0];
                if(op=="rich_set"){rich->set_text(text);owned.rich_images=0;}else{if(rich->get_total_character_count()+text.length()>128000)return false;if(rich->is_using_bbcode())rich->append_text(text);else rich->add_text(text);}return true;
            }
            if(op=="rich_clear"){if(!args.is_empty())return false;rich->clear();owned.rich_images=0;return true;}
            if(op=="rich_image"){
                if(args.size()!=3||args[0].get_type()!=Variant::OBJECT||args[1].get_type()!=Variant::FLOAT||args[2].get_type()!=Variant::FLOAT||owned.rich_images>=64)return false;Ref<Texture2D> texture=args[0];if(texture.is_null()||rich->get_total_character_count()>=128000)return false;
                for(int j=1;j<=2;++j)if(double(args[j])<1||double(args[j])>4096||double(args[j])!=Math::floor(double(args[j])))return false;
                rich->add_image(texture,int(args[1]),int(args[2]));++owned.rich_images;return true;
            }
            if(op=="rich_select"||op=="rich_deselect"){if(!args.is_empty()||!rich->is_selection_enabled())return false;if(op=="rich_select")rich->select_all();else rich->deselect();return true;}
            if(op=="rich_scroll"){if(args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=rich->get_line_count())return false;rich->scroll_to_line(int(args[0]));return true;}
            if(op=="rich_ratio"){if(args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])<0||double(args[0])>1)return false;rich->set_visible_ratio(args[0]);return true;}
            return false;
        }
