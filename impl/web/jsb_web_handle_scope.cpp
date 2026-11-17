#include "jsb_web_handle_scope.h"
#include "jsb_web_isolate.h"
namespace v8
{
    HandleScope::HandleScope(Isolate* isolate)
    {
        isolate_ = isolate;
        jsb_check(isolate_->is_owner_thread() && !isolate_->is_disposed());
        ++isolate_->handle_scope_depth_;
        jsbi_StackEnter(isolate_->rt());
    }

    HandleScope::~HandleScope()
    {
        jsb_check(isolate_->is_owner_thread() && !isolate_->is_disposed());
        jsbi_StackExit(isolate_->rt());
        jsb_check(isolate_->handle_scope_depth_ > 0);
        --isolate_->handle_scope_depth_;
    }

}
