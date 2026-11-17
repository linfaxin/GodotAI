        bool presentation_command(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {
            LineEdit* edit=Object::cast_to<LineEdit>(node);if(root.stage!="process"||!edit||!operation.begins_with("edit_"))return false;
            const String action=operation.trim_prefix("edit_");const int length=edit->get_text().length();if(length>65536)return false;
            auto index=[&](int j,int minimum,int maximum)->bool{return j<args.size()&&args[j].get_type()==Variant::FLOAT&&double(args[j])==Math::floor(double(args[j]))&&double(args[j])>=minimum&&double(args[j])<=maximum;};
            if(args.is_empty()){
                if(action=="selectAll"){edit->select_all();return true;}if(action=="deselect"){edit->deselect();return true;}
                if(action=="hasSelection"){result=edit->has_selection();return true;}if(action=="getSelectedText"){result=edit->get_selected_text();return true;}
                if(action=="getCaretColumn"){result=edit->get_caret_column();return true;}
                if(action=="getSelectionFromColumn"){result=edit->get_selection_from_column();return true;}if(action=="getSelectionToColumn"){result=edit->get_selection_to_column();return true;}
                if(action=="deleteCharAtCaret"&&edit->is_editable()){edit->delete_char();return true;}return false;
            }
            if(action=="setCaretColumn"&&args.size()==1&&index(0,0,length)){edit->set_caret_column(int(args[0]));return true;}
            if(action=="select"&&args.size()==2&&index(0,0,length)&&index(1,-1,length)){const int from=args[0],to=int(args[1])==-1?length:int(args[1]);if(from>to)return false;edit->select(from,to);return true;}
            if(action=="deleteText"&&args.size()==2&&index(0,0,length)&&index(1,0,length)&&int(args[0])<=int(args[1])&&edit->is_editable()){edit->delete_text(int(args[0]),int(args[1]));return true;}
            if(action=="insertTextAtCaret"&&args.size()==1&&args[0].get_type()==Variant::STRING&&edit->is_editable()){const String text=args[0];if(text.length()+length>65536)return false;edit->insert_text_at_caret(text);return true;}
            return false;
        }
