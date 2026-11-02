#include "jsb_react_manifest.h"

#include "jsb_path_util.h"
#include "jsb_settings.h"

namespace jsb::internal
{
    namespace
    {
        bool read_object(const String& p_path, Dictionary& r_value)
        {
            if (!FileAccess::exists(p_path)) return false;
            const Variant parsed = JSON::parse_string(FileAccess::get_file_as_string(p_path));
            if (parsed.get_type() != Variant::DICTIONARY) return false;
            r_value = parsed;
            return true;
        }

        bool valid_digest(const String& p_digest)
        {
            if (p_digest.length() != 64) return false;
            for (int i = 0; i < p_digest.length(); ++i)
            {
                const char32_t ch = p_digest[i];
                if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
            }
            return true;
        }

        void append_unique(PackedStringArray& r_paths, const String& p_path)
        {
            if (ReactManifest::is_canonical_path(p_path) && !r_paths.has(p_path)) r_paths.append(p_path);
        }

        bool is_code(const String& p_path)
        {
            return p_path.ends_with(".js") || p_path.ends_with(".cjs") || p_path.ends_with(".mjs") || p_path.ends_with(".json");
        }
    }

    bool ReactManifest::is_enabled()
    {
        return (bool) ProjectSettings::get_singleton()->get_setting("godotjs/react/enabled", false)
            || FileAccess::exists("res://godot-react.config.mjs");
    }

    bool ReactManifest::is_canonical_path(const String& p_path)
    {
        if (!(p_path.begins_with("res://") && p_path.length() > 6
            && !p_path.contains("\\") && !p_path.contains("\n") && !p_path.contains("\r")
            && p_path.simplify_path() == p_path && p_path.find("//", 6) < 0
            && p_path.strip_edges() == p_path)) return false;
        for (int i = 6; i < p_path.length(); ++i)
        {
            if (p_path[i] < 32 || p_path[i] == 127 || p_path[i] == '?' || p_path[i] == '#'
                || p_path[i] == '%' || p_path[i] == ':') return false;
        }
        return true;
    }

    Error ReactManifest::load_active(Dictionary& r_manifest, String& r_manifest_path, String& r_error, bool p_verify_artifacts)
    {
        r_manifest.clear();
        r_manifest_path = String();
        r_error = String();
        if (!is_enabled()) return ERR_UNCONFIGURED;
        if (DirAccess::dir_exists_absolute(LOCK_PATH))
        {
            r_error = "E_BUILD_NOT_READY: a React publication is in progress";
            return ERR_BUSY;
        }
        Dictionary active;
        if (!read_object(ACTIVE_PATH, active) || validate_active_descriptor(active, r_error) != OK)
        {
            r_error = "E_BUILD_NOT_READY: missing or invalid React active descriptor";
            return ERR_FILE_CORRUPT;
        }
        const String manifest_path = active.get("manifestPath", "");
        const String manifest_digest = active.get("manifestSha256", "");
        if (!is_canonical_path(manifest_path) || !valid_digest(manifest_digest)
            || FileAccess::get_sha256(manifest_path) != manifest_digest)
        {
            r_error = "E_GENERATION_MISMATCH: sealed React manifest hash does not match";
            return ERR_FILE_CORRUPT;
        }
        Dictionary manifest;
        if (!read_object(manifest_path, manifest) || (int) manifest.get("schemaVersion", 0) != 1
            || String(manifest.get("generation", "")) != String(active.get("generation", ""))
            || String(manifest.get("runtimeAbi", "")) != "godot-react/1"
            || String(manifest.get("nativeBridgeAbi", "")) != "godot-react-native/1")
        {
            r_error = "E_MANIFEST_ABI: incompatible React manifest";
            return ERR_FILE_CORRUPT;
        }
        for (const char* name : { "entries", "modules", "resources", "nativeScripts", "artifacts" })
        {
            if (manifest.get(name, Variant()).get_type() != Variant::DICTIONARY)
            {
                r_error = String("E_MANIFEST_ABI: missing manifest table ") + name;
                return ERR_FILE_CORRUPT;
            }
        }
        if (validate_manifest(manifest, r_error) != OK) return ERR_FILE_CORRUPT;
        if (Dictionary(manifest.get("artifacts", Variant())).has(manifest_path))
        {
            r_error = "E_MANIFEST_ABI: the manifest cannot own its own hash";
            return ERR_FILE_CORRUPT;
        }
        if (p_verify_artifacts)
        {
            const Dictionary artifacts = manifest.get("artifacts", Variant());
            const Array paths = artifacts.keys();
            for (int i = 0; i < paths.size(); ++i)
            {
                const String artifact_path = paths[i];
                const Variant value = artifacts.get(paths[i], Variant());
                if (!is_canonical_path(artifact_path) || value.get_type() != Variant::DICTIONARY)
                {
                    r_error = "E_MANIFEST_ABI: invalid artifact path or descriptor";
                    return ERR_FILE_CORRUPT;
                }
                const Dictionary artifact = value;
                // Imported resources retain their native importer/remap lifecycle.
                if (String(artifact.get("owner", "")) != "compiler") continue;
                // A PCK contains transformed/remapped scene and Script
                // resources. Their source bytes (and optional source maps)
                // need not exist there. Immutable executable modules retain
                // their original bytes and are always checked at startup.
                if (ProjectSettings::get_singleton()->is_using_datapack() && !is_code(artifact_path)) continue;
                const String digest = artifact.get("sha256", "");
                if (!valid_digest(digest) || !FileAccess::exists(artifact_path)
                    || FileAccess::get_sha256(artifact_path) != digest)
                {
                    r_error = String("E_GENERATION_MISMATCH: invalid React artifact ") + artifact_path;
                    return ERR_FILE_CORRUPT;
                }
            }
        }
        r_manifest = manifest;
        r_manifest_path = manifest_path;
        return OK;
    }

    bool ReactManifest::is_managed_output(const String& p_path)
    {
        if (!is_enabled()) return false;
        // The publisher owns this namespace even before a candidate is sealed.
        // Its journal/GC, not the legacy .js -> .ts heuristic, reclaims it.
        const String output = Settings::get_jsb_out_res_path();
        return p_path.begins_with(output.path_join("react-build") + "/")
            || p_path.begins_with(output.path_join("generated/react") + "/");
    }

    void ReactManifest::get_script_dependencies(const String& p_path, List<String>* r_dependencies)
    {
        Dictionary manifest;
        String path;
        String error;
        if (load_active(manifest, path, error, false) != OK) return;
        const Dictionary entries = manifest.get("entries", Variant());
        const Array keys = entries.keys();
        bool entry_script = false;
        for (int i = 0; i < keys.size(); ++i)
        {
            const Variant value = entries.get(keys[i], Variant());
            if (value.get_type() != Variant::DICTIONARY) continue;
            const Dictionary entry = value;
            if (String(entry.get("script", "")) != p_path) continue;
            entry_script = true;
            for (const char* field : { "resourceHub", "exportHub" })
            {
                const String dependency = entry.get(field, "");
                if (is_canonical_path(dependency)) r_dependencies->push_back(dependency);
            }
        }
        const Dictionary scripts = manifest.get("nativeScripts", Variant());
        const Array script_keys = scripts.keys();
        if (entry_script)
        {
            // NativeScript identities are resource dependencies, not ordinary
            // code files: the exporter's per-source remap must see each one.
            for (int i = 0; i < script_keys.size(); ++i)
            {
                const Variant value = scripts.get(script_keys[i], Variant());
                if (value.get_type() != Variant::DICTIONARY) continue;
                const Dictionary other = value;
                const String source = other.get("source", "");
                if (source != p_path && is_canonical_path(source)) r_dependencies->push_back(source);
            }
        }
        for (int i = 0; i < script_keys.size(); ++i)
        {
            const Variant value = scripts.get(script_keys[i], Variant());
            if (value.get_type() != Variant::DICTIONARY) continue;
            const Dictionary script = value;
            if (String(script.get("source", "")) != p_path) continue;
            const Array dependencies = script.get("dependencies", Array());
            for (int j = 0; j < dependencies.size(); ++j)
            {
                const String dependency = dependencies[j];
                if (is_canonical_path(dependency)) r_dependencies->push_back(dependency);
                else if (scripts.has(dependency))
                {
                    const Dictionary other = scripts.get(dependency, Variant());
                    const String source = other.get("source", "");
                    if (is_canonical_path(source)) r_dependencies->push_back(source);
                }
            }
        }
    }

    void ReactManifest::collect_export_files(const Dictionary& p_manifest, PackedStringArray& r_paths, bool p_source_maps)
    {
        append_unique(r_paths, ACTIVE_PATH);
        Dictionary active;
        if (read_object(ACTIVE_PATH, active)) append_unique(r_paths, active.get("manifestPath", ""));
        HashSet<String> script_outputs;
        const Dictionary scripts = p_manifest.get("nativeScripts", Dictionary());
        const Array script_ids = scripts.keys();
        for (int i = 0; i < script_ids.size(); ++i)
        {
            const Dictionary script = scripts.get(script_ids[i], Variant());
            script_outputs.insert(script.get("output", ""));
        }
        for (const char* table : { "modules", "artifacts" })
        {
            const Dictionary values = p_manifest.get(table, Dictionary());
            const Array keys = values.keys();
            for (int i = 0; i < keys.size(); ++i)
            {
                const Dictionary value = values.get(keys[i], Variant());
                const String path = String(table) == "modules" ? String(value.get("uri", "")) : String(keys[i]);
                if (script_outputs.has(path)) continue;
                if (is_code(path) || (p_source_maps && path.ends_with(".js.map"))) append_unique(r_paths, path);
            }
        }
    }
}
