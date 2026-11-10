        bool rich_text_valid(const String& text,bool bbcode) {
            if(text.length()>128000)return false;if(!bbcode)return true;Vector<String> stack;int offset=0,count=0,cells=0;
            while(true){const int start=text.find("[",offset);if(start<0)break;if(!stack.is_empty()&&stack[stack.size()-1]=="table"&&!text.substr(offset,start-offset).strip_edges().is_empty())return false;const int end=text.find("]",start+1);if(end<0)break;offset=end+1;if(++count>4096)return false;const String tag=text.substr(start+1,end-start-1);if(tag=="lb"||tag=="rb"||tag=="br"){if(!stack.is_empty()&&stack[stack.size()-1]=="table")return false;continue;}
                if(tag.begins_with("/")){if(stack.is_empty()||stack[stack.size()-1]!=tag.substr(1))return false;stack.resize(stack.size()-1);continue;}
                const int equals=tag.find("=");const String name=equals<0?tag:tag.substr(0,equals),value=equals<0?String():tag.substr(equals+1);
                if(name=="table"){if(stack.has("table")||value.length()<1||value.length()>2||!value.is_valid_int()||value.to_int()<1||value.to_int()>16)return false;for(int j=0;j<value.length();++j)if(value[j]<'0'||value[j]>'9')return false;}
                else if(name=="cell"){if(equals>=0||stack.is_empty()||stack[stack.size()-1]!="table"||++cells>1024)return false;}
                else if(name=="color"||name=="bgcolor"){if((value.length()!=7&&value.length()!=9)||!value.begins_with("#")||!value.substr(1).is_valid_hex_number(false))return false;}
                else if(name=="font_size"){if(value.length()<1||value.length()>3||!value.is_valid_int()||value.to_int()<1||value.to_int()>256)return false;for(int j=0;j<value.length();++j)if(value[j]<'0'||value[j]>'9')return false;}
                else if(name=="url"||name=="hint"){if(value.is_empty()||value.length()>256||value.contains("[")||value.contains("]"))return false;for(int j=0;j<value.length();++j)if(value[j]<32)return false;}
                else if(name=="ul"||name=="ol"||name=="indent"||name=="b"||name=="i"||name=="u"||name=="s"||name=="code"||name=="center"||name=="left"||name=="right"||name=="fill"){if(equals>=0)return false;}
                else { return false; }
                if(!stack.is_empty()&&stack[stack.size()-1]=="table"&&name!="cell")return false;
                stack.push_back(name);if(stack.size()>32)return false;
            }return stack.is_empty();
        }
