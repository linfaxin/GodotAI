#include "jsb_web_isolate.h"

#include "jsb_web_catch.h"
#include "jsb_web_handle.h"
#include "jsb_web_context.h"
#include "jsb_web_function_interop.h"

namespace v8
{
    Isolate *Isolate::New(const CreateParams &params)
    {
        Isolate* isolate = memnew(Isolate);
        return isolate;
    }

    Isolate::Isolate() : ref_count_(1), disposed_(false), handle_scope_(nullptr)
    {
        rt_ = jsbi_NewEngine(this);
    }

    Isolate::~Isolate()
    {
        jsb_check(!rt_);
    }

    void Isolate::_release()
    {
        JSB_WEB_LOG(VeryVerbose, "release web runtime");

        // cleanup
        jsb_check(!handle_scope_);

        // Browser GC cannot be forced before shutdown. Release outstanding
        // native value storage while its Environment is still alive. Object
        // weak callbacks are deliberately skipped: Environment::dispose has
        // already drained object_db_. Remove each slot before its callback so
        // reentrant cleanup cannot finalize it twice.
        while (!internal_data_.is_empty())
        {
            const auto index = internal_data_.get_first_index();
            jsb::impl::InternalData data = *internal_data_.get_value_scoped(index);
            internal_data_.remove_at(index);
            if (data.value_type_deleter && data.weak.callback)
            {
                const auto callback = (WeakCallbackInfo<void>::Callback) data.weak.callback;
                const WeakCallbackInfo<void> info(this, data.weak.parameter, data.internal_fields);
                callback(info);
            }
        }

        // dispose the runtime
        jsbi_FreeEngine(rt_);
        rt_ = {};

        memdelete(this);
    }

    void Isolate::Dispose()
    {
        jsb_check(!disposed_);
        disposed_ = true;
        _remove_reference();
    }

    void Isolate::SetData(int index, void* data)
    {
        jsb_check(index == 0);
        embedder_data_ = data;
    }

    Local<Context> Isolate::GetCurrentContext()
    {
        return Local<Context>(Data(this, 0));
    }

}
