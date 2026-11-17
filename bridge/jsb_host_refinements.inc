        bool refine_aabb(const AABB& box) const {
            for(int k=0;k<3;++k)if(!std::isfinite(box.position[k])||!std::isfinite(box.size[k])||Math::abs(box.position[k])>1e6||box.size[k]<0||box.size[k]>1e6)return false;return true;
        }
        int64_t refine_batch_bytes(const Ref<MultiMesh>& mesh) const {
            if(mesh.is_null())return 0;if(mesh->get_instance_count()<0||mesh->get_instance_count()>65536||!refine_aabb(mesh->get_custom_aabb()))return 33554433;
            return int64_t(mesh->get_instance_count())*((mesh->get_transform_format()==MultiMesh::TRANSFORM_2D?8:12)+(mesh->is_using_colors()?4:0)+(mesh->is_using_custom_data()?4:0))*4;
        }
        int64_t refine_subtree_bytes(Node* node) const {
            if(!node)return 0;Vector<Node*> stack;stack.push_back(node);int budget=2048;int64_t bytes=0;while(!stack.is_empty()){Node* item=stack[stack.size()-1];stack.resize(stack.size()-1);if(--budget<0)return 33554433;if(item->is_class("MultiMeshInstance2D")||item->is_class("MultiMeshInstance3D")){Ref<MultiMesh> mesh=item->get("multimesh");bytes+=refine_batch_bytes(mesh);if(bytes>33554432)return bytes;}for(int j=0;j<item->get_child_count(false);++j)stack.push_back(item->get_child(j,false));}return bytes;
        }
        bool refine_batch_budget(Root& root,Node* replacing,int64_t extra) const {
            int64_t total=extra;for(const KeyValue<uint64_t,Owned>& pair:root.nodes){Node* item=Object::cast_to<Node>(compat::ObjectDB::get_instance(pair.value.object));if(item&&item!=replacing&&(item->is_class("MultiMeshInstance2D")||item->is_class("MultiMeshInstance3D"))){Ref<MultiMesh> mesh=item->get("multimesh");total+=refine_batch_bytes(mesh);}if(pair.value.prefab_root.is_valid())total+=refine_subtree_bytes(Object::cast_to<Node>(compat::ObjectDB::get_instance(pair.value.prefab_root)));if(total>33554432)return false;}return total<=33554432;
        }
        Ref<MultiMesh> refine_copy_batch(const Ref<MultiMesh>& source) {
            Ref<MultiMesh> copy;if(source.is_null())return copy;copy.instantiate();copy->set_transform_format(source->get_transform_format());copy->set_use_colors(source->is_using_colors());copy->set_use_custom_data(source->is_using_custom_data());copy->set_mesh(source->get_mesh());copy->set_instance_count(source->get_instance_count());const PackedFloat32Array buffer=source->get("buffer");if(!buffer.is_empty())copy->set("buffer",buffer);copy->set_visible_instance_count(source->get_visible_instance_count());copy->set_custom_aabb(source->get_custom_aabb());return copy;
        }
        bool refine_clip_walk(Node* node,bool mask,bool group,Node* changed,int mode,int& budget) const {
            if(--budget<0)return false;
            if(node->is_class("SubViewport")||node->is_class("Window")||node->is_class("CanvasLayer")){mask=false;group=false;}
            const bool own_group=node->is_class("CanvasGroup");CanvasItem* canvas=Object::cast_to<CanvasItem>(node);const bool own_mask=canvas&&(node==changed?mode:int(canvas->get_clip_children_mode()))!=0;
            if((own_mask&&(mask||group||own_group))||(own_group&&mask))return false;
            for(int j=0;j<node->get_child_count(false);++j)if(!refine_clip_walk(node->get_child(j,false),mask||own_mask,group||own_group,changed,mode,budget))return false;return true;
        }
        bool refine_clips(Node* node,Node* parent,Node* changed=nullptr,int mode=0) const {
            bool mask=false,group=false;for(Node* item=parent;item;item=item->get_parent()){if(item->is_class("SubViewport")||item->is_class("Window")||item->is_class("CanvasLayer"))break;group|=item->is_class("CanvasGroup");if(CanvasItem* canvas=Object::cast_to<CanvasItem>(item))mask|=canvas->get_clip_children_mode()!=CanvasItem::CLIP_CHILDREN_DISABLED;}
            int budget=4096;return refine_clip_walk(node,mask,group,changed,mode,budget);
        }
        template<class CurveType> bool refine_curve_budget(const Ref<CurveType>& curve,bool closed) const {
            if(curve.is_null()||curve->get_point_count()>4096)return false;const int count=curve->get_point_count();const double interval=curve->get_bake_interval();if(!std::isfinite(interval)||interval<.001||interval>1000)return false;double length=0;
            for(int j=0;j<count;++j){const auto point=curve->get_point_position(j),in=curve->get_point_in(j),out=curve->get_point_out(j);if(!point.is_finite()||!in.is_finite()||!out.is_finite())return false;for(int k=0;k<point.AXIS_COUNT;++k)if(Math::abs(point[k])>1e6||Math::abs(in[k])>1e6||Math::abs(out[k])>1e6)return false;}
            for(int j=0;j<count-1+(closed&&count>1?1:0);++j){const auto a=curve->get_point_position(j%count),b=curve->get_point_position((j+1)%count),c=a+curve->get_point_out(j%count),d=b+curve->get_point_in((j+1)%count);length+=a.distance_to(c)+c.distance_to(d)+d.distance_to(b);if(4*length/interval+4*count>65536)return false;}return 4*length/interval+4*count<=65536;
        }
        bool refine_property(Root& root,Owned& owned,Node* node,const String& name,const Variant& value){
            if(name=="clip_children")return value.get_type()==Variant::INT&&int64_t(value)>=0&&int64_t(value)<=2&&refine_clips(node,node->get_parent(),node,int(value));
            if(name=="custom_aabb")return value.get_type()==Variant::AABB&&refine_aabb(value);
            if(name=="curve"){
                if(value.is_null())return true;if(Path2D* path=Object::cast_to<Path2D>(node)){Ref<Curve2D> curve=value;return refine_curve_budget(curve,false);}
#if !defined(_3D_DISABLED)
                if(Path3D* path=Object::cast_to<Path3D>(node)){Ref<Curve3D> curve=value;return curve.is_valid()&&refine_curve_budget(curve,curve->is_closed());}
#endif

            }
            if(name=="rendering_quadrant_size"||name=="physics_quadrant_size")return value.get_type()==Variant::INT&&int64_t(value)>=1&&int64_t(value)<=256;
            if(name=="y_sort_origin")return value.get_type()==Variant::INT&&int64_t(value)>=-32768&&int64_t(value)<=32767;
            if(name=="minimap_width")return value.get_type()==Variant::INT&&int64_t(value)>=8&&int64_t(value)<=256;
            if(node->is_class("CPUParticles2D")&&(name.begins_with("anim_speed_")||name.begins_with("anim_offset_"))&&!name.ends_with("curve"))return value.get_type()==Variant::FLOAT&&double(value)>=0&&double(value)<=(name.begins_with("anim_speed_")?1000:1);
            return true;
        }
        bool refine_search(Owned& owned,Node* node,const String& name,const Variant& value,bool set,Variant& result){
            TextEdit* edit=Object::cast_to<TextEdit>(node);if(!edit)return false;const bool text=name=="__react_refine_search_text";if(!text&&name!="__react_refine_search_flags")return false;
            if(set){if(text){if(value.get_type()!=Variant::STRING||String(value).length()>1024)return false;owned.search_text=value;edit->set_search_text(owned.search_text);}else{if(value.get_type()!=Variant::INT||int64_t(value)<0||int64_t(value)>7)return false;owned.search_flags=int(value);edit->set_search_flags(owned.search_flags);}}
            result=text?Variant(owned.search_text):Variant(owned.search_flags);return true;
        }
        bool refine_command(Root& root,Owned& owned,Node* node,const String& op,const Array& args,Variant& result){
            const auto integer=[](const Variant& value,int min,int max){return value.get_type()==Variant::FLOAT&&double(value)==Math::floor(double(value))&&double(value)>=min&&double(value)<=max;};

#if !defined(_3D_DISABLED)
            if(op=="setOverlayShaderParameter"||op=="getOverlayShaderParameter"){
                const bool set=op=="setOverlayShaderParameter";if(!Object::cast_to<GeometryInstance3D>(node)||args.size()!=(set?2:1)||args[0].get_type()!=Variant::STRING)return false;Array call;call.push_back(-3.0);for(int j=0;j<args.size();++j)call.push_back(args[j]);return behavior_command(root,owned,node,set?"shader_set":"shader_get",call,result,true);
            }
#endif

            if(node->is_class("MultiMeshInstance2D")||node->is_class("MultiMeshInstance3D")){
                Ref<MultiMesh> mesh=node->get("multimesh");if(mesh.is_null())return false;const int count=mesh->get_instance_count();
                if(op=="getVisibleInstanceCount"&&args.is_empty()){result=mesh->get_visible_instance_count();return true;}
                if(op=="setVisibleInstanceCount"&&args.size()==1&&integer(args[0],-1,count)){mesh->set_visible_instance_count(int(args[0]));return true;}
                if(op=="getInstanceBounds"&&args.is_empty()){result=mesh->get_custom_aabb();return true;}
                if(op=="setInstanceBounds"&&args.size()==1&&args[0].get_type()==Variant::AABB&&refine_aabb(args[0])){mesh->set_custom_aabb(args[0]);return true;}
                if((op=="getInstanceCustomData"||op=="getInstanceColor")&&args.size()==1&&integer(args[0],0,count-1)){const bool custom=op=="getInstanceCustomData";if(custom?!mesh->is_using_custom_data():!mesh->is_using_colors())return false;result=custom?mesh->get_instance_custom_data(int(args[0])):mesh->get_instance_color(int(args[0]));return true;}
                if(op=="setInstanceCustomData"&&args.size()==2&&integer(args[0],0,count-1)&&args[1].get_type()==Variant::COLOR&&mesh->is_using_custom_data()){const Color v=args[1];for(int j=0;j<4;++j)if(!std::isfinite(v[j])||Math::abs(v[j])>65504)return false;mesh->set_instance_custom_data(int(args[0]),v);return true;}return false;
            }
            if(Path2D* path=Object::cast_to<Path2D>(node)){
                const Ref<Curve2D> curve=path->get_curve();if(!refine_curve_budget(curve,false))return false;const double length=curve->get_baked_length();if(op=="getCurveLength"&&args.is_empty()){result=length;return true;}
                if((op=="getClosestCurvePoint"||op=="getClosestCurveOffset")&&args.size()==1&&args[0].get_type()==Variant::VECTOR2){const Vector2 point=args[0];if(Math::abs(point.x)>1e6||Math::abs(point.y)>1e6)return false;result=op=="getClosestCurvePoint"?Variant(length>0?curve->get_closest_point(point):(curve->get_point_count()?curve->get_point_position(0):Vector2())):Variant(length>0?curve->get_closest_offset(point):0.0);return true;}
                if((op=="sampleCurve"||op=="sampleCurveTransform")&&args.size()==(op=="sampleCurve"?2:3)&&args[0].get_type()==Variant::FLOAT&&Math::abs(double(args[0]))<=1e6&&args[1].get_type()==Variant::BOOL&&(args.size()==2||args[2].get_type()==Variant::BOOL)){const double at=CLAMP(double(args[0]),0.0,length);const Vector2 point=length>0?curve->sample_baked(at,args[1]):(curve->get_point_count()?curve->get_point_position(0):Vector2());result=op=="sampleCurve"?Variant(point):Variant(length>0?curve->sample_baked_with_rotation(at,args[1]):Transform2D(0,point));return true;}return false;
            }

#if !defined(_3D_DISABLED)
            if(Path3D* path=Object::cast_to<Path3D>(node)){
                const Ref<Curve3D> curve=path->get_curve();if(curve.is_null()||!refine_curve_budget(curve,curve->is_closed()))return false;const double length=curve->get_baked_length();if(op=="getCurveLength"&&args.is_empty()){result=length;return true;}
                if((op=="getClosestCurvePoint"||op=="getClosestCurveOffset")&&args.size()==1&&args[0].get_type()==Variant::VECTOR3){const Vector3 point=args[0];for(int j=0;j<3;++j)if(Math::abs(point[j])>1e6)return false;result=op=="getClosestCurvePoint"?Variant(length>0?curve->get_closest_point(point):(curve->get_point_count()?curve->get_point_position(0):Vector3())):Variant(length>0?curve->get_closest_offset(point):0.0);return true;}
                if((op=="sampleCurve"||op=="sampleCurveTransform")&&args.size()==(op=="sampleCurve"?2:3)&&args[0].get_type()==Variant::FLOAT&&Math::abs(double(args[0]))<=1e6&&args[1].get_type()==Variant::BOOL&&(args.size()==2||args[2].get_type()==Variant::BOOL)){const double at=CLAMP(double(args[0]),0.0,length);const Vector3 point=length>0?curve->sample_baked(at,args[1]):(curve->get_point_count()?curve->get_point_position(0):Vector3());result=op=="sampleCurve"?Variant(point):Variant(length>0?curve->sample_baked_with_rotation(at,args[1],args[2]):Transform3D(Basis(),point));return true;}return false;
            }
#endif

            if(TileMapLayer* map=Object::cast_to<TileMapLayer>(node)){if(op=="updateInternals"&&args.is_empty()){map->update_internals();return true;}return false;}
            if(RichTextLabel* label=Object::cast_to<RichTextLabel>(node)){if(op=="getHintAt"&&args.size()==1&&args[0].get_type()==Variant::VECTOR2){const Vector2 at=args[0];if(at.x<0||at.y<0||at.x>label->get_size().x||at.y>label->get_size().y)return false;const String hint=static_cast<Control*>(label)->get_tooltip(at);if(hint.length()>256)return false;result=hint;return true;}return false;}
            TextEdit* edit=Object::cast_to<TextEdit>(node);if(!edit)return false;
            if(op=="search"&&args.size()==4&&args[0].get_type()==Variant::STRING&&String(args[0]).length()<=1024&&integer(args[1],0,7)&&integer(args[2],0,edit->get_line_count()-1)){const int line=int(args[2]);if(!integer(args[3],0,edit->get_line(line).length()))return false;result=edit->search(args[0],int(args[1]),line,int(args[3]));return true;}
            if(op=="getTextRect"&&args.size()==2&&integer(args[0],0,edit->get_line_count()-1)&&integer(args[1],0,edit->get_line(int(args[0])).length())){const Rect2i box=edit->get_rect_at_line_column(int(args[0]),int(args[1]));result=Rect2(Vector2(box.position),Vector2(MAX(0,box.size.x),MAX(0,box.size.y)));return true;}
            CodeEdit* code=Object::cast_to<CodeEdit>(edit);if(!code)return false;const bool line_ok=args.size()>=1&&integer(args[0],0,code->get_line_count()-1);const int line=line_ok?int(args[0]):0;
            if((op=="canFoldLine"||op=="isLineFolded")&&args.size()==1&&line_ok){result=op=="canFoldLine"?code->can_fold_line(line):code->is_line_folded(line);return true;}
            if((op=="foldLine"||op=="unfoldLine"||op=="toggleFoldableLine")&&args.size()==1&&line_ok&&code->is_line_folding_enabled()){if(op=="foldLine"){if(!code->can_fold_line(line)&&!code->is_line_folded(line))return false;code->fold_line(line);}else if(op=="unfoldLine")code->unfold_line(line);else code->toggle_foldable_line(line);return true;}
            if((op=="foldAllLines"||op=="unfoldAllLines")&&args.is_empty()&&code->is_line_folding_enabled()){if(op=="foldAllLines")code->fold_all_lines();else code->unfold_all_lines();return true;}
            if(op=="getFoldedLines"&&args.is_empty()){const PackedInt32Array values=code->get_folded_lines();if(values.size()>4096)return false;Array out;for(int j=0;j<values.size();++j)out.push_back(values[j]);result=out;return true;}
            if(op!="setLineAsBookmarked"&&op!="setLineAsBreakpoint"&&op!="setLineAsExecuting"&&op!="isLineBookmarked"&&op!="isLineBreakpointed"&&op!="isLineExecuting"&&op!="getBookmarkedLines"&&op!="getBreakpointedLines"&&op!="getExecutingLines"&&op!="clearBookmarkedLines"&&op!="clearBreakpointedLines"&&op!="clearExecutingLines")return false;
            const bool bookmark=op.contains("Bookmarked"),breakpoint=op.contains("Breakpoint"),executing=op.contains("Executing");if(!bookmark&&!breakpoint&&!executing)return false;
            const PackedInt32Array values=bookmark?code->get_bookmarked_lines():breakpoint?code->get_breakpointed_lines():code->get_executing_lines();
            if(op.begins_with("get")&&args.is_empty()){if(values.size()>4096)return false;Array out;for(int j=0;j<values.size();++j)out.push_back(values[j]);result=out;return true;}
            if(op.begins_with("clear")&&args.is_empty()){if(bookmark)code->clear_bookmarked_lines();else if(breakpoint)code->clear_breakpointed_lines();else code->clear_executing_lines();return true;}
            if(op.begins_with("isLine")&&args.size()==1&&line_ok){result=bookmark?code->is_line_bookmarked(line):breakpoint?code->is_line_breakpointed(line):code->is_line_executing(line);return true;}
            if(op.begins_with("setLineAs")&&args.size()==2&&line_ok&&args[1].get_type()==Variant::BOOL){if(bool(args[1])&&values.size()>=4096&&!values.has(line))return false;if(bookmark)code->set_line_as_bookmarked(line,args[1]);else if(breakpoint)code->set_line_as_breakpoint(line,args[1]);else code->set_line_as_executing(line,args[1]);return true;}return false;
        }
        bool prepare_refinement_prefab(Root& root,Node* scope,Node* node){
            if(scope==node&&(!refine_clips(node,node->get_parent())||!refine_batch_budget(root,nullptr,refine_subtree_bytes(node))))return false;
            if(node->is_class("MultiMeshInstance2D")||node->is_class("MultiMeshInstance3D")){Ref<MultiMesh> source=node->get("multimesh");node->set("multimesh",refine_copy_batch(source));}

#if !defined(_3D_DISABLED)
            if(GeometryInstance3D* geometry=Object::cast_to<GeometryInstance3D>(node)){if(!refine_aabb(geometry->get_custom_aabb()))return false;Ref<ShaderMaterial> shader=geometry->get_material_overlay();if(shader.is_valid())geometry->set_material_overlay(shader->duplicate());}
#endif

            if(Path2D* path=Object::cast_to<Path2D>(node))if(path->get_curve().is_valid()&&!refine_curve_budget(path->get_curve(),false))return false;

#if !defined(_3D_DISABLED)
            if(Path3D* path=Object::cast_to<Path3D>(node))if(path->get_curve().is_valid()&&!refine_curve_budget(path->get_curve(),path->get_curve()->is_closed()))return false;
#endif

            return true;
        }
