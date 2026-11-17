#ifndef GODOTJS_WEB_CONTEXT_H
#define GODOTJS_WEB_CONTEXT_H

#include "jsb_web_pch.h"
#include "jsb_web_handle.h"

namespace v8
{
    class Object;

    class Context : public Data
    {
    public:
        class Scope
        {
        public:
            Scope(Local<Context> context) {}
        };

        Isolate* GetIsolate() const { return isolate_; }

        void* GetAlignedPointerFromEmbedderData(int index) const;
        void SetAlignedPointerInEmbedderData(int index, void* data);

        static Local<Context> New(Isolate* isolate);
        Local<Object> Global() const;
    };

    template <>
    class Global<Context>
    {
        // clear all fields silently after moved
        void _clear()
        {
            isolate_ = nullptr;
        }

    public:
        Global() = default;
        Global(Isolate* isolate, Local<Context> value) { Reset(isolate, value); }

        Global(const Global&) = delete;
        Global& operator=(const Global&) = delete;

        ~Global() { Reset(); }

        Global(Global&& other) noexcept
        {
            isolate_ = other.isolate_;
            other._clear();
        }

        void Reset()
        {
            if (!isolate_) return;
            Isolate* retained = isolate_; isolate_ = nullptr;
            jsb::impl::Broker::release(retained);
        }

        void Reset(Isolate* isolate, Local<Context> value)
        {
            Reset();

            if (!isolate || value.IsEmpty() || jsb::impl::Broker::is_closed(isolate)) return;
            jsb::impl::Broker::retain(isolate); isolate_ = isolate;
        }

        void Reset(Isolate* isolate, const Global& value)
        {
            Reset(isolate, value.Get(isolate));
        }

        // Return true if no value held by this handle
        bool IsEmpty() const { return !isolate_ || jsb::impl::Broker::is_closed(isolate_); }

        Local<Context> Get(Isolate* isolate) const
        {
            if (!isolate_ || jsb::impl::Broker::is_closed(isolate_)) return {};
            jsb_check(isolate_ == isolate && jsb::impl::Broker::is_owner(isolate_));
            return Local<Context>(Data(isolate_, 0));
        }

    private:
        Isolate* isolate_ = nullptr;

    };
}

#endif
