#include "jsb_web_broker.h"
#include "jsb_web_isolate.h"

namespace jsb::impl
{
    uintptr_t Broker::SetWeakCallback(v8::Isolate* isolate, HandleID value, void* parameter, void* callback)
    {
        const v8::HandleScope handle_scope(isolate);
        const jsb::impl::StackPosition sp = jsbi_handle_PushStack(isolate->rt(), value);
        const jsb::impl::InternalDataID index = (jsb::impl::InternalDataID)(uintptr_t) jsbi_GetOpaque(isolate->rt(), sp);
        const jsb::impl::InternalDataPtr data = isolate->get_internal_data(index);
        JSB_WEB_LOG(VeryVerbose, "update internal data JSObject:%d id:%d pc:%d,%d (last:%d,%d)",
            sp, index,
            (uintptr_t) parameter, (uintptr_t) callback,
            (uintptr_t) data->weak.parameter, (uintptr_t) data->weak.callback);
        jsb_checkf(!callback || !data->weak.callback, "overriding an existing value is not allowed");
        data->weak.parameter = (void*) parameter;
        data->weak.callback = (void*) callback;
        return (uintptr_t) *index;
    }

    void Broker::CancelWeakCallback(v8::Isolate* isolate, uintptr_t p_internal_data_id)
    {
        // A WeakRef can be dead before FinalizationRegistry delivers its
        // callback. Resolve the captured generational slot without the target.
        const auto data = isolate->internal_data_.try_get_value_scoped((InternalDataID) p_internal_data_id);
        if (data)
        {
            data->weak.parameter = nullptr;
            data->weak.callback = nullptr;
        }
    }

    JSRuntime Broker::get_engine(v8::Isolate* isolate)
    {
        return isolate->rt();
    }
}
