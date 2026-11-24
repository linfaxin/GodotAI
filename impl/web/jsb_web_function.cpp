#include "jsb_web_function.h"

#include "jsb_web_context.h"

namespace v8
{
    MaybeLocal<Value> Function::Call(Local<Context> context, Local<Value> recv, int argc, Local<Value> argv[])
    {
        jsb::impl::StackPosition* vargv = jsb_stackalloc(jsb::impl::StackPosition, argc);
        for (int i = 0; i < argc; i++)
        {
            vargv[i] = argv[i]->stack_pos_;
        }
        const jsb::impl::StackPosition rval_sp = jsbi_Call(isolate_->rt(), recv->stack_pos_, stack_pos_, argc, vargv);
        if (rval_sp == jsb::impl::StackBase::Error)
        {
            return MaybeLocal<Value>();
        }
        return MaybeLocal<Value>(Data(isolate_, rval_sp));
    }

    MaybeLocal<Value> Function::CallRuntime(Local<Value> recv, int argc, Local<Value> argv[], bool& threw)
    {
        jsb::impl::StackPosition args[8];
        if (argc < 0 || argc > 8) return {};
        for (int i = 0; i < argc; ++i) args[i] = argv[i]->stack_pos_;
        const int32_t result = jsbi_RuntimeCall(isolate_->rt(), recv->stack_pos_, stack_pos_, argc, args);
        threw = result == -1;
        if (result < 0) return {};
        return MaybeLocal<Value>(Data(isolate_, result));
    }

    MaybeLocal<Function> Function::New(Local<Context> context, FunctionCallback callback, Local<Value> data, int length)
    {
        Isolate* isolate = context->isolate_;
        static_assert(sizeof(callback) == sizeof(void*));
        const jsb::impl::StackPosition func_sp = jsbi_NewCFunction(isolate->rt(), (jsb::impl::FunctionPointer) callback, data->stack_pos_, nullptr);
        if (func_sp == jsb::impl::StackBase::Error)
        {
            return MaybeLocal<Function>();
        }
        return MaybeLocal<Function>(Data(isolate, func_sp));
    }

    Local<Context> Function::GetCreationContextChecked() const
    {
        return Local<Context>(Data(isolate_, 0));
    }
}
