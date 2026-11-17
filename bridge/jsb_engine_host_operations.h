#ifndef GODOTJS_ENGINE_HOST_OPERATIONS_H
#define GODOTJS_ENGINE_HOST_OPERATIONS_H
#include "jsb_bridge_pch.h"
#include <memory>
namespace jsb {
class Environment;
// Resource and domain operations for direct renderer scopes. This provider
// neither owns Nodes nor creates a second ownership or scene audit registry.
class EngineHostOperations {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    explicit EngineHostOperations(Environment* environment);
    ~EngineHostOperations();
    void install(const v8::Local<v8::Context>& context,const v8::Local<v8::Object>& internal);
    void dispose();
    void invoke_signal(uint64_t connection,const Variant** args,int count);
private:
    static void dispatch(const v8::FunctionCallbackInfo<v8::Value>& info);
};
}
#endif
