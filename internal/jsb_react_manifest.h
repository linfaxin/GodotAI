#ifndef GODOTJS_REACT_MANIFEST_H
#define GODOTJS_REACT_MANIFEST_H

#include "jsb_internal_pch.h"

namespace jsb::internal
{
    // Read-only integration with the compiler's sealed publication protocol.
    // This class never evaluates a JavaScript module to discover dependencies.
    class ReactManifest
    {
    public:
        static constexpr const char* ACTIVE_PATH = "res://generated/react/active.json";
        static constexpr const char* LOCK_PATH = "res://generated/react/.publish-lock";
        static bool is_enabled();
        static bool is_canonical_path(const String& p_path);
        static Error validate_manifest(const Dictionary& p_manifest, String& r_error);
        static Error validate_active_descriptor(const Dictionary& p_active, String& r_error);
        static Error load_active(Dictionary& r_manifest, String& r_manifest_path, String& r_error, bool p_verify_artifacts = true);
        static bool is_managed_output(const String& p_path);
        static void get_script_dependencies(const String& p_path, List<String>* r_dependencies);
        static void collect_export_files(const Dictionary& p_manifest, PackedStringArray& r_paths, bool p_source_maps);
    };
}

#endif
