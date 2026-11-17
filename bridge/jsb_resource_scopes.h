#ifndef GODOTJS_RESOURCE_SCOPES_H
#define GODOTJS_RESOURCE_SCOPES_H

#include "jsb_bridge_pch.h"
#include <memory>

namespace jsb {
class Environment;
/** Owner-environment local-to-scene resource scopes. No renderer/profile policy,
 * JS callbacks or Node ownership is stored in this registry. */
class ResourceScopes {
    struct Impl;
    std::unique_ptr<Impl> impl_;
    static void dispatch(const v8::FunctionCallbackInfo<v8::Value>& info);
public:
    explicit ResourceScopes(Environment* environment);
    ~ResourceScopes();
    void install(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal);
    void dispose();
};
}
#endif
