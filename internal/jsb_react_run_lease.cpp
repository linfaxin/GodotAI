#include "jsb_react_run_lease.h"
#include "jsb_react_manifest.h"

#include "core/os/time.h"

namespace jsb::internal
{
    namespace
    {
        constexpr const char* LEASES = "res://generated/react/run-leases";

        bool owned_path(const String& p_path)
        {
            return p_path.begins_with(String(LEASES) + "/") && p_path.ends_with(".json")
                && ReactManifest::is_canonical_path(p_path);
        }
    }

    Error ReactRunLease::acquire(const String& p_root_id, const String& p_instance, String& r_path, String& r_error)
    {
        r_path = String();
        r_error = String();
        if (ProjectSettings::get_singleton()->is_using_datapack()) return OK;
        if (DirAccess::dir_exists_absolute(ReactManifest::LOCK_PATH))
        {
            r_error = "E_BUILD_NOT_READY: publication owns the project";
            return ERR_BUSY;
        }
        if (p_instance.is_empty() || p_root_id.is_empty())
        {
            r_error = "E_RUN_LEASE: root and instance must be nonempty";
            return ERR_INVALID_PARAMETER;
        }
        Error err = DirAccess::make_dir_recursive_absolute(LEASES);
        if (err != OK && err != ERR_ALREADY_EXISTS)
        {
            r_error = "E_RUN_LEASE: cannot create run lease directory";
            return err;
        }
        const String path = String(LEASES).path_join(itos(OS::get_singleton()->get_process_id()) + "-" + p_instance.sha256_text() + ".json");
        if (FileAccess::exists(path))
        {
            r_error = "E_RUN_LEASE: duplicate instance lease";
            return ERR_ALREADY_IN_USE;
        }
        Dictionary marker;
        marker["schemaVersion"] = 1;
        marker["pid"] = (int64_t) OS::get_singleton()->get_process_id();
        marker["rootId"] = p_root_id;
        marker["rootInstance"] = p_instance;
        marker["createdAtMs"] = Time::get_singleton()->get_unix_time_from_system() * 1000.0;
        Ref<FileAccess> file = FileAccess::open(path, FileAccess::WRITE, &err);
        if (file.is_null())
        {
            r_error = "E_RUN_LEASE: cannot create instance marker";
            return err;
        }
        file->store_string(JSON::stringify(marker));
        file->flush();
        err = file->get_error();
        file.unref();
        if (err != OK)
        {
            DirAccess::remove_absolute(path);
            r_error = "E_RUN_LEASE: incomplete marker write";
            return err;
        }
        // If publication scanned just before marker creation, this check
        // prevents mounting the business graph while it owns the lock.
        if (DirAccess::dir_exists_absolute(ReactManifest::LOCK_PATH))
        {
            DirAccess::remove_absolute(path);
            r_error = "E_BUILD_NOT_READY: publication raced with root startup";
            return ERR_BUSY;
        }
        r_path = path;
        return OK;
    }

    void ReactRunLease::release(const String& p_path)
    {
        if (!owned_path(p_path)) return;
        if (FileAccess::exists(p_path + ".shutdown")) DirAccess::remove_absolute(p_path + ".shutdown");
        if (FileAccess::exists(p_path)) DirAccess::remove_absolute(p_path);
    }

    bool ReactRunLease::shutdown_requested(const String& p_path)
    {
        return owned_path(p_path) && FileAccess::exists(p_path + ".shutdown");
    }
}
