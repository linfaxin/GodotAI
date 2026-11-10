        bool composition_property(Node* node,const String& property,const Variant& value) {
            if(property=="visibility_layer"||property=="canvas_cull_mask")return value.get_type()==Variant::INT&&int64_t(value)>=0&&int64_t(value)<=0xffffffffLL;
            if(property.begins_with("visibility_range_")||property=="extra_cull_margin")return value.get_type()==Variant::FLOAT&&double(value)>=0&&double(value)<=(property=="visibility_range_begin"||property=="visibility_range_end"?1e6:1e5);
            if(node->is_class("TextEdit")){
                if(property=="placeholder_text")return String(value).length()<=1024;
                if(property=="wrap_mode")return int64_t(value)>=0&&int64_t(value)<=1;
                if(property=="autowrap_mode")return int64_t(value)>=0&&int64_t(value)<=3;
                if(property=="scroll_vertical"||property=="scroll_horizontal")return double(value)>=0&&double(value)<=1e6;
            }
            if(node->is_class("ItemList")){
                if(property=="select_mode")return int64_t(value)>=0&&int64_t(value)<=2;
                if(property=="max_columns")return int64_t(value)>=0&&int64_t(value)<=64;
                if(property=="fixed_column_width")return int64_t(value)>=0&&int64_t(value)<=4096;
                if(property=="icon_mode")return int64_t(value)>=0&&int64_t(value)<=1;
                if(property=="icon_scale")return double(value)>=.01&&double(value)<=16;
                if(property=="max_text_lines")return int64_t(value)>=1&&int64_t(value)<=64;
                if(property=="fixed_icon_size"){const Vector2i size=value;return size.x>=0&&size.y>=0&&size.x<=1024&&size.y<=1024;}
            }
            if(node->is_class("SplitContainer")){
                if(property=="split_offset")return int64_t(value)>=-1e6&&int64_t(value)<=1e6;
                if(property=="dragger_visibility")return int64_t(value)>=0&&int64_t(value)<=2;
            }
            if(node->is_class("FlowContainer")){if(property=="alignment")return int64_t(value)>=0&&int64_t(value)<=2;if(property=="last_wrap_alignment")return int64_t(value)>=0&&int64_t(value)<=3;}
            if(node->is_class("TabContainer")){if(property=="tab_alignment")return int64_t(value)>=0&&int64_t(value)<=2;if(property=="tabs_position")return int64_t(value)>=0&&int64_t(value)<=1;}
            return true;
        }
        bool composition_special(Owned& owned,Node* node,const String& property,const Variant& value,bool set,Variant& result) {
            if(property=="__react_composition_text"){
                TextEdit* text=Object::cast_to<TextEdit>(node);if(!text)return false;
                if(set){if(value.get_type()!=Variant::STRING||String(value).length()>65536)return false;text->set_text(value);}
                result=text->get_text();return true;
            }
            ItemList* list=Object::cast_to<ItemList>(node);if(!list)return false;
            if(property=="__react_composition_items"){
                if(set){if(value.get_type()!=Variant::ARRAY)return false;Array entries=value;if(entries.size()>1024)return false;
                    for(int j=0;j<entries.size();++j){if(entries[j].get_type()!=Variant::ARRAY)return false;const Array entry=entries[j];if(entry.size()!=5||entry[0].get_type()!=Variant::STRING||String(entry[0]).length()>256||entry[2].get_type()!=Variant::BOOL||entry[3].get_type()!=Variant::BOOL||entry[4].get_type()!=Variant::STRING||String(entry[4]).length()>256)return false;if(!entry[1].is_null()){Ref<Texture2D> icon=entry[1];if(icon.is_null()||icon->is_class("ViewportTexture"))return false;}}
                    const PackedInt32Array selected=list->get_selected_items();list->clear();for(int j=0;j<entries.size();++j){const Array entry=entries[j];Ref<Texture2D> icon=entry[1];list->add_item(entry[0],icon,bool(entry[3]));list->set_item_disabled(j,entry[2]);list->set_item_metadata(j,entry[4]);}for(int j=0;j<selected.size();++j)if(selected[j]<list->get_item_count()&&!list->is_item_disabled(selected[j])&&list->is_item_selectable(selected[j]))list->select(selected[j],false);
                }
                Array entries;for(int j=0;j<list->get_item_count();++j){Array entry;entry.push_back(list->get_item_text(j));entry.push_back(list->get_item_icon(j));entry.push_back(list->is_item_disabled(j));entry.push_back(list->is_item_selectable(j));entry.push_back(list->get_item_metadata(j));entries.push_back(entry);}result=entries;return true;
            }
            if(property=="__react_composition_selected"){
                if(set){if(value.get_type()!=Variant::ARRAY)return false;const Array selected=value;if(selected.size()>1024||(list->get_select_mode()==ItemList::SELECT_SINGLE&&selected.size()>1))return false;HashSet<int> seen;for(int j=0;j<selected.size();++j){if(selected[j].get_type()!=Variant::FLOAT)return false;const double index=selected[j];if(index!=Math::floor(index)||index<0||index>=list->get_item_count()||seen.has(int(index))||list->is_item_disabled(int(index))||!list->is_item_selectable(int(index)))return false;seen.insert(int(index));}list->deselect_all();for(int j=0;j<selected.size();++j)list->select(int(selected[j]),false);}
                const PackedInt32Array selected=list->get_selected_items();Array entries;for(int j=0;j<selected.size();++j)entries.push_back(selected[j]);result=entries;return true;
            }
            return false;
        }
        bool composition_command(Owned& owned,Node* node,const String& op,const Array& args,Variant& result) {
            if(TextEdit* text=Object::cast_to<TextEdit>(node)){
                if(op=="setText"||op=="insertTextAtCaret"){if(args.size()!=1||args[0].get_type()!=Variant::STRING)return false;const String input=args[0];if(input.length()>65536||(op=="insertTextAtCaret"&&text->get_text().length()+input.length()-text->get_selected_text().length()>65536))return false;if(op=="setText")text->set_text(input);else text->insert_text_at_caret(input);return true;}
                if(op=="getLineCount"&&args.is_empty()){result=text->get_line_count();return true;}
                if(op=="getSelectedText"&&args.is_empty()){result=text->get_selected_text();return true;}
                if(op=="getCaretLine"&&args.is_empty()){result=text->get_caret_line();return true;}
                if(op=="getCaretColumn"&&args.is_empty()){result=text->get_caret_column();return true;}
                if(op=="hasUndo"&&args.is_empty()){result=text->has_undo();return true;}
                if(op=="hasRedo"&&args.is_empty()){result=text->has_redo();return true;}
                const auto index=[&](int j,int limit)->bool{return args[j].get_type()==Variant::FLOAT&&double(args[j])==Math::floor(double(args[j]))&&double(args[j])>=0&&double(args[j])<limit;};
                if(op=="getLine"){if(args.size()!=1||!index(0,text->get_line_count()))return false;result=text->get_line(int(args[0]));return true;}
                if(op=="select"){if(args.size()!=4||!text->is_selecting_enabled()||!index(0,text->get_line_count())||!index(2,text->get_line_count())||!index(1,text->get_line(int(args[0])).length()+1)||!index(3,text->get_line(int(args[2])).length()+1))return false;text->select(int(args[0]),int(args[1]),int(args[2]),int(args[3]));return true;}
                if(op=="setCaretPosition"){if(args.size()!=2||!index(0,text->get_line_count())||!index(1,text->get_line(int(args[0])).length()+1))return false;text->set_caret_line(int(args[0]));text->set_caret_column(int(args[1]));return true;}
                if(!args.is_empty())return false;if(op=="selectAll"){if(!text->is_selecting_enabled())return false;text->select_all();return true;}if(op=="deselect"){text->deselect();return true;}if(op=="undo"||op=="redo"){if(!text->is_editable())return false;if(op=="undo")text->undo();else text->redo();return true;}return false;
            }
            if(ItemList* list=Object::cast_to<ItemList>(node)){
                if(op=="deselectAll"&&args.is_empty()){list->deselect_all();return true;}
                if(op=="getItemCount"&&args.is_empty()){result=list->get_item_count();return true;}
                if(op=="getSelectedItems"&&args.is_empty())return composition_special(owned,node,"__react_composition_selected",Variant(),false,result);
                if(args.is_empty()||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=list->get_item_count())return false;const int index=int(args[0]);
                if(op=="select"){if(args.size()!=2||args[1].get_type()!=Variant::BOOL||list->is_item_disabled(index)||!list->is_item_selectable(index))return false;list->select(index,bool(args[1])||list->get_select_mode()==ItemList::SELECT_SINGLE);return true;}
                if(args.size()!=1)return false;if(op=="deselect"){list->deselect(index);return true;}if(op=="getItemRect"){result=list->get_item_rect(index);return true;}if(op=="getItemText"){result=list->get_item_text(index);return true;}if(op=="getItemMetadata"){result=list->get_item_metadata(index);return true;}return false;
            }
            if(op=="setSplitOffset"){if(!node->is_class("SplitContainer")||args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||Math::abs(double(args[0]))>1e6)return false;node->set("split_offset",int(args[0]));return true;}
            if(op=="getLineCount"&&node->is_class("FlowContainer")&&args.is_empty()){result=node->call("get_line_count");return true;}
            if(TabContainer* tabs=Object::cast_to<TabContainer>(node)){
                if(args.is_empty()||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>=tabs->get_tab_count())return false;const int index=int(args[0]);
                if(args.size()==1){if(op=="getTabRect"){Rect2 rect=tabs->get_tab_bar()->get_tab_rect(index);rect.position+=tabs->get_tab_bar()->get_position();result=rect;}else if(op=="getTabTitle")result=tabs->get_tab_title(index);else if(op=="isTabDisabled")result=tabs->is_tab_disabled(index);else if(op=="isTabHidden")result=tabs->is_tab_hidden(index);else return false;return true;}
                if(args.size()!=2)return false;if(op=="setTabTitle"){if(args[1].get_type()!=Variant::STRING||String(args[1]).length()>256)return false;tabs->set_tab_title(index,args[1]);return true;}
                if(op=="setTabIcon"){Ref<Texture2D> icon=args[1];if(!args[1].is_null()&&(icon.is_null()||icon->is_class("ViewportTexture")))return false;tabs->set_tab_icon(index,icon);return true;}
                if(args[1].get_type()!=Variant::BOOL)return false;if(op=="setTabDisabled"){tabs->set_tab_disabled(index,args[1]);return true;}if(op=="setTabHidden"){tabs->set_tab_hidden(index,args[1]);return true;}return false;
            }
            return false;
        }

        bool prepare_composition_prefab(Node* node) {
            if(TextEdit* text=Object::cast_to<TextEdit>(node)){if(text->get_text().length()>65536)return false;const Callable guard(memnew(ReactTextLimitCallable(node->get_instance_id())));if(!text->is_connected("text_changed",guard))text->connect("text_changed",guard);}
            if(ItemList* list=Object::cast_to<ItemList>(node)){
                if(list->get_item_count()>1024)return false;
                const Array metadata=node->get_meta("__godot_react_list_metadata",Array());if(!metadata.is_empty()&&metadata.size()!=list->get_item_count())return false;
                for(int j=0;j<list->get_item_count();++j){Variant meta=metadata.is_empty()?list->get_item_metadata(j):metadata[j];if(meta.is_null())meta=String();if(meta.get_type()!=Variant::STRING||String(meta).length()>256||list->get_item_text(j).length()>256)return false;list->set_item_metadata(j,meta);}
                if(node->has_meta("__godot_react_list_selected")){const Array selection=node->get_meta("__godot_react_list_selected");Array normalized;for(int j=0;j<selection.size();++j){if(selection[j].get_type()!=Variant::INT&&selection[j].get_type()!=Variant::FLOAT)return false;normalized.push_back(double(selection[j]));}Owned temporary;Variant output;if(!composition_special(temporary,node,"__react_composition_selected",normalized,true,output))return false;}
            }
            return true;
        }
