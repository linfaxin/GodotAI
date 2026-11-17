#ifndef GODOTJS_NATIVE_WORLD_H
#define GODOTJS_NATIVE_WORLD_H

#include "jsb_bridge_pch.h"
#include "jsb_native_hooks.h"
#include "core/object/object_id.h"
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace jsb {
class Environment;

// Owns only native identity and plain records. Never owns an Environment, VM
// handle or callback. Each environment owns its own callback handles.
class NativeWorld : public std::enable_shared_from_this<NativeWorld> {
public:
    enum class ClaimState { Live, Retiring, Quarantined };
    struct Change { uint64_t sequence = 0; uint64_t object = 0; uint64_t parent = 0; bool retired = false; };
    struct Batch {
        uint64_t revision = 0;
        uint64_t sequence = 0;
        bool mutation_in_progress = false;
        bool overflow = false;
        bool sealed = false;
        bool wrong_thread = false;
        std::vector<Change> changes;
    };
    struct Scope {
        uint64_t token = 0;
        uint64_t environment = 0;
        bool active = true;
        bool overflow = false;
        bool wrong_thread = false;
        uint32_t claim_count = 0;
        uint32_t retiring_count = 0;
        uint32_t quarantined_count = 0;
        std::unordered_set<uint64_t> watched;
        std::unordered_set<uint64_t> ancestors;
        std::vector<Change> changes;
    };
    struct Claim {
        uint64_t scope = 0;
        uint64_t environment = 0;
        ClaimState state = ClaimState::Live;
    };
    struct Status { uint32_t claims = 0; uint32_t retiring = 0; uint32_t quarantined = 0; bool sealed = false; };

    static std::shared_ptr<NativeWorld> begin();
    static std::shared_ptr<NativeWorld> current();
    static void end(const std::shared_ptr<NativeWorld>& world);
    static void mutation(ObjectID parent, ObjectID child, bool begin);
    static void retired(ObjectID object);
    static void enter_interop();
    static void leave_interop();
    static bool inside_interop();

    explicit NativeWorld(uint64_t id);
    uint64_t id() const { return id_; }
    bool acquire_renderer(const String& mode);
    void begin_closing();
    bool is_closing() const;
    String renderer_mode() const;
    Scope* open_scope(uint64_t environment);
    Scope* resolve_scope(void* capability, uint64_t environment) const;
    bool valid_scope(const Scope* scope, uint64_t environment) const;
    bool watch(Scope* scope, Object* object);
    bool claim(Scope* scope, ObjectID object);
    bool retire(Scope* scope, ObjectID object);
    bool retire_batch(Scope* scope, const std::vector<uint64_t>& objects, const std::unordered_set<uint64_t>& cascade, uint64_t revision);
    uint64_t revision() const;
    bool relinquish(Scope* scope, ObjectID object);
    Status close_scope(Scope* scope);
    Status status(const Scope* scope) const;
    Batch take_changes(Scope* scope);
    bool permits_binding(ObjectID object, uint64_t environment) const;
    bool has_live_claim(ObjectID object) const;
    bool owns_claim(uint64_t scope_token, ObjectID object) const;
    bool suppress_finalization(ObjectID object, uint64_t environment) const;
    void note_creator(ObjectID object, uint64_t environment);
    void seal_environment(uint64_t environment);
    void confirm_retired(ObjectID object) { removed(object); }
    void seal();
    bool can_commit() const;
    bool mutation_in_progress() const;

    static void install(Environment* environment, const v8::Local<v8::Context>& context, const v8::Local<v8::Object>& internal);

private:
    void changed(ObjectID parent, ObjectID child, bool begin);
    void removed(ObjectID object);
    Status status_locked(const Scope* scope) const;
    const uint64_t id_;
    const Thread::ID owner_thread_;
    mutable std::mutex mutex_;
    String renderer_mode_;
    bool sealed_ = false;
    bool closing_ = false;
    uint32_t mutation_depth_ = 0;
    uint64_t revision_ = 0;
    uint64_t sequence_ = 0;
    std::unordered_map<uint64_t, std::unique_ptr<Scope>> scopes_;
    std::unordered_map<uint64_t, Claim> claims_;
    std::unordered_map<uint64_t, uint64_t> creators_;
};

// Used by the pinned Godot source patch. No JS, ObjectDB query or finalizer is
// called while a registry lock is held.
class NativeInteropScope {
public:
    NativeInteropScope() { NativeWorld::enter_interop(); }
    ~NativeInteropScope() { NativeWorld::leave_interop(); }
};
}
#endif
