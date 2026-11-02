#ifndef GODOTJS_REACT_RUN_LEASE_H
#define GODOTJS_REACT_RUN_LEASE_H

#include "jsb_internal_pch.h"

namespace jsb::internal
{
    class ReactRunLease
    {
    public:
        // Source-project runs participate in the publisher's double-check
        // marker protocol. Immutable packed games need no development lease.
        static Error acquire(const String& p_root_id, const String& p_instance, String& r_path, String& r_error);
        static void release(const String& p_path);
        static bool shutdown_requested(const String& p_path);
    };
}

#endif
