#ifndef GODOTJS_NATIVE_HOOKS_H
#define GODOTJS_NATIVE_HOOKS_H

// Deliberately independent of VM headers/module compile flags: included by
// Godot core translation units, which are not built with GodotJS's environment.
#include "core/object/object_id.h"
#include <cstdint>
namespace jsb {
// Shared by every integer-backed native External capability domain. Tokens
// never alias across registries and exhaustion permanently fails closed.
uintptr_t native_capability_token();
bool native_managed_cleanup_active();
void native_observer_mutation(ObjectID parent, ObjectID child, bool begin);
void native_observer_retired(ObjectID object);
class NativeMutationScope {
    ObjectID parent_, child_;
public:
    NativeMutationScope(ObjectID parent, ObjectID child) : parent_(parent), child_(child) { native_observer_mutation(parent_, child_, true); }
    ~NativeMutationScope() { native_observer_mutation(parent_, child_, false); }
};
}
#endif
