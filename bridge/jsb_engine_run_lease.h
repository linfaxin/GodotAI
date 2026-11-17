#ifndef GODOTJS_ENGINE_RUN_LEASE_H
#define GODOTJS_ENGINE_RUN_LEASE_H
#include "jsb_bridge_pch.h"
#include <unordered_map>
class Node;

namespace jsb {
class Environment;
// Development publisher admission only. This grants no renderer or Node rights.
class EngineRunLease {
    struct Lease { String path; ObjectID attachment; bool closed = false; };
    Environment* environment_;
    bool registered_ = false;
    std::unordered_map<uintptr_t, Lease> leases_;
    String audit(Node* pending) const;
    static void dispatch(const v8::FunctionCallbackInfo<v8::Value>& info);
public:
    explicit EngineRunLease(Environment* environment);
    ~EngineRunLease();
    void install(const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal);
    void dispose();
};
}
#endif
