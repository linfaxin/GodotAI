        // Native edits (including a browser paste) share the bounded text contract.
        class ReactTextLimitCallable final : public CallableCustom {
            ObjectID emitter_;
        public:
            explicit ReactTextLimitCallable(ObjectID emitter):emitter_(emitter){}
            static bool equal(const CallableCustom* a,const CallableCustom* b){return static_cast<const ReactTextLimitCallable*>(a)->emitter_==static_cast<const ReactTextLimitCallable*>(b)->emitter_;}
            static bool less(const CallableCustom* a,const CallableCustom* b){return uint64_t(static_cast<const ReactTextLimitCallable*>(a)->emitter_)<uint64_t(static_cast<const ReactTextLimitCallable*>(b)->emitter_);}
            CompareEqualFunc get_compare_equal_func() const override{return equal;}
            CompareLessFunc get_compare_less_func() const override{return less;}
            uint32_t hash() const override{return uint32_t(uint64_t(emitter_));}
            ObjectID get_object() const override{return emitter_;}
            String get_as_text() const override{return "React TextEdit character budget";}
            bool is_valid() const override{return compat::ObjectDB::get_instance(emitter_)!=nullptr;}
            void call(const Variant**,int,Variant& result,Callable::CallError& error) const override {
                result=Variant();error.error=Callable::CallError::CALL_OK;
                if(!Thread::is_main_thread()){error.error=Callable::CallError::CALL_ERROR_INVALID_METHOD;return;}
                TextEdit* text=Object::cast_to<TextEdit>(compat::ObjectDB::get_instance(emitter_));if(!text)return;
                const String value=text->get_text();if(value.length()>65536)text->set_text(value.substr(0,65536));
            }
        };
