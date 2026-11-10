        bool details_command(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {
            if(root.stage!="process")return false;
            auto integer=[&](int index,int64_t minimum,int64_t maximum)->bool{return index<args.size()&&args[index].get_type()==Variant::FLOAT&&double(args[index])==Math::floor(double(args[index]))&&double(args[index])>=minimum&&double(args[index])<=maximum;};
            if(operation.begins_with("tile_")){
                TileMapLayer* tile=Object::cast_to<TileMapLayer>(node);if(!tile)return false;
                if(operation=="tile_rect"&&args.is_empty()){const Rect2i rect=tile->get_used_rect();if(rect.size.x<0||rect.size.y<0)return false;Dictionary data;data["position"]=rect.position;data["size"]=rect.size;result=data;return true;}
                if(operation=="tile_alternative"&&args.size()==1&&args[0].get_type()==Variant::VECTOR2I){result=tile->get_cell_alternative_tile(args[0]);return true;}
                Array cells;if(operation=="tile_cells"&&args.is_empty())cells=tile->get_used_cells();else if(operation=="tile_filter"&&args.size()==3&&integer(0,-1,INT32_MAX)&&args[1].get_type()==Variant::VECTOR2I&&integer(2,-1,INT32_MAX))cells=tile->get_used_cells_by_id(int(args[0]),args[1],int(args[2]));else return false;
                if(cells.size()>65536)return false;result=cells;return true;
            }
            if(operation.begins_with("grid_")){
                if(!node->is_class("GridMap"))return false;
                if(operation=="grid_orientation"&&args.size()==1&&args[0].get_type()==Variant::VECTOR3I){result=node->call("get_cell_item_orientation",args[0]);return true;}
                Array cells;if(operation=="grid_cells"&&args.is_empty())cells=node->call("get_used_cells");else if(operation=="grid_filter"&&args.size()==1&&integer(0,0,INT32_MAX))cells=node->call("get_used_cells_by_item",int(args[0]));else return false;
                if(cells.size()>65536)return false;result=cells;return true;
            }
            if(operation=="path_ratio"){
                if(args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])<0||double(args[0])>1)return false;
                if(PathFollow2D* follow=Object::cast_to<PathFollow2D>(node)){Path2D* path=Object::cast_to<Path2D>(follow->get_parent());if(!path||path->get_curve().is_null()||path->get_curve()->get_baked_length()<=0)return false;follow->set_progress_ratio(args[0]);return true;}
                if(PathFollow3D* follow=Object::cast_to<PathFollow3D>(node)){Path3D* path=Object::cast_to<Path3D>(follow->get_parent());if(!path||path->get_curve().is_null()||path->get_curve()->get_baked_length()<=0)return false;follow->set_progress_ratio(args[0]);return true;}return false;
            }
            Label* label=Object::cast_to<Label>(node);if(!label)return false;
            if(operation=="label_ratio"&&args.size()==1&&args[0].get_type()==Variant::FLOAT&&double(args[0])>=0&&double(args[0])<=1){label->set_visible_ratio(args[0]);return true;}
            if(!args.is_empty())return false;
            if(operation=="label_ratio_get"){result=label->get_visible_ratio();return true;}
            if(operation=="label_characters"){result=label->get_total_character_count();return true;}
            if(operation=="label_lines"){result=label->get_line_count();return true;}
            if(operation=="label_visible_lines"){result=label->get_visible_line_count();return true;}
            return false;
        }
