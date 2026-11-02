#include "jsb_react_manifest.h"

#include <cmath>
#include <initializer_list>

namespace jsb::internal
{
    namespace
    {
        using Fields = std::initializer_list<const char*>;
        bool text(const Variant& p_value)
        {
            if (p_value.get_type() != Variant::STRING || String(p_value).is_empty()) return false;
            const String value = p_value;
            for (int i = 0; i < value.length(); ++i) if (!value[i]) return false;
            return true;
        }
        bool number(const Variant& p_value)
        {
            return (p_value.get_type() == Variant::INT || p_value.get_type() == Variant::FLOAT)
                && std::isfinite((double) p_value);
        }
        bool integer(const Variant& p_value)
        {
            return number(p_value) && (double) p_value >= 0 && (double) p_value <= 9007199254740991.0
                && std::floor((double) p_value) == (double) p_value;
        }
        bool digest(const Variant& p_value)
        {
            if (!text(p_value)) return false;
            const String value = p_value;
            if (value.length() != 64) return false;
            for (int i = 0; i < value.length(); ++i)
                if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
            return true;
        }
        bool one_of(const Variant& p_value, Fields p_values)
        {
            if (!text(p_value)) return false;
            for (const char* value : p_values) if (String(p_value) == value) return true;
            return false;
        }
        bool object(const Variant& p_value)
        {
            if (p_value.get_type() != Variant::DICTIONARY) return false;
            const Dictionary value = p_value;
            const Array keys = value.keys();
            for (int i = 0; i < keys.size(); ++i)
                if (!text(keys[i]) || one_of(keys[i], { "__proto__", "prototype", "constructor" })) return false;
            return true;
        }
        bool shape(const Variant& p_value, Fields p_required, Fields p_optional = {})
        {
            if (!object(p_value)) return false;
            const Dictionary value = p_value;
            for (const char* field : p_required) if (!value.has(field)) return false;
            const Array keys = value.keys();
            for (int i = 0; i < keys.size(); ++i)
            {
                bool allowed = false;
                for (const char* field : p_required) if (keys[i] == Variant(field)) allowed = true;
                for (const char* field : p_optional) if (keys[i] == Variant(field)) allowed = true;
                if (!allowed) return false;
            }
            return true;
        }
        bool strings(const Variant& p_value)
        {
            if (p_value.get_type() != Variant::ARRAY) return false;
            const Array value = p_value;
            HashSet<String> seen;
            for (int i = 0; i < value.size(); ++i)
            {
                if (!text(value[i]) || seen.has(value[i])) return false;
                seen.insert(value[i]);
            }
            return true;
        }
        bool edges(const Dictionary& p_table)
        {
            const Array ids = p_table.keys();
            for (int i = 0; i < ids.size(); ++i)
            {
                const Dictionary value = p_table.get(ids[i], Variant());
                const Variant dependencies = value.get("dependencies", Variant());
                if (!strings(dependencies)) return false;
                const Array array = dependencies;
                for (int j = 0; j < array.size(); ++j) if (!p_table.has(array[j])) return false;
            }
            return true;
        }
    }

    Error ReactManifest::validate_active_descriptor(const Dictionary& p_active, String& r_error)
    {
        r_error = String();
        // Godot JSON parses every number as FLOAT. Variant's C++ comparison
        // operators distinguish FLOAT from INT, unlike JSON's number model.
        const Variant version = p_active.get("schemaVersion", Variant());
        if (!shape(p_active, { "schemaVersion", "generation", "manifestPath", "manifestSha256", "state" })
            || !integer(version) || (double) version != 1.0
            || !text(p_active.get("generation", Variant()))
            || !one_of(p_active.get("state", Variant()), { "READY" })
            || !text(p_active.get("manifestPath", Variant()))
            || !is_canonical_path(p_active.get("manifestPath", Variant()))
            || !digest(p_active.get("manifestSha256", Variant())))
        {
            r_error = "E_BUILD_NOT_READY: invalid active descriptor contract";
            return ERR_FILE_CORRUPT;
        }
        return OK;
    }

    Error ReactManifest::validate_manifest(const Dictionary& p_manifest, String& r_error)
    {
        const auto reject = [&](const String& p_at) {
            r_error = "E_MANIFEST_ABI: invalid manifest contract at " + p_at;
            return ERR_FILE_CORRUPT;
        };
        r_error = String();
        if (!shape(p_manifest, { "schemaVersion", "generation", "sourceSnapshotHash", "compilerVersion", "runtimeAbi",
                "nativeBridgeAbi", "entryInterfaceHash", "mode", "target", "react", "profile", "entries", "modules",
                "resources", "nativeScripts", "artifacts", "sourceOrigins" }, { "nativeScriptProfiles" })) return reject("$");
        const auto get = [&](const char* name) { return p_manifest.get(name, Variant()); };
        if (!integer(get("schemaVersion")) || (int64_t) get("schemaVersion") != 1) return reject("schemaVersion");
        for (const char* field : { "generation", "compilerVersion", "runtimeAbi", "nativeBridgeAbi" })
            if (!text(get(field))) return reject(field);
        if (!digest(get("sourceSnapshotHash")) || !digest(get("entryInterfaceHash"))) return reject("hash");
        if (!one_of(get("mode"), { "development", "production" })) return reject("mode");
        if (!shape(get("target"), { "sourceCommit", "sourceDiffHash", "godotVersion", "buildFlags", "platform", "arch", "engine", "godotSchemaHash" })) return reject("target");
        const Dictionary target = get("target");
        for (const char* field : { "sourceCommit", "godotVersion", "platform", "arch" })
            if (!text(target.get(field, Variant()))) return reject(String("target.") + field);
        if (!digest(target.get("sourceDiffHash", Variant())) || !digest(target.get("godotSchemaHash", Variant()))
            || !one_of(target.get("engine", Variant()), { "quickjs", "v8", "jsc", "web" })
            || !object(target.get("buildFlags", Variant()))) return reject("target");
        const Dictionary flags = target.get("buildFlags", Variant());
        for (const KeyValue<Variant, Variant>& flag : flags)
            if (flag.value.get_type() != Variant::BOOL && flag.value.get_type() != Variant::STRING && !number(flag.value)) return reject("target.buildFlags");
        if (!shape(get("react"), { "react", "reconciler", "scheduler" })) return reject("react");
        const Dictionary react = get("react");
        for (const char* field : { "react", "reconciler", "scheduler" })
            if (!text(react.get(field, Variant()))) return reject(String("react.") + field);
        if (!shape(get("profile"), { "id", "version", "hash" })) return reject("profile");
        const Dictionary profile = get("profile");
        if (!text(profile.get("id", Variant())) || !integer(profile.get("version", Variant()))
            || (int64_t) profile.get("version", Variant()) != 1 || !digest(profile.get("hash", Variant()))) return reject("profile");
        for (const char* field : { "entries", "modules", "resources", "nativeScripts", "artifacts", "sourceOrigins" })
            if (!object(get(field))) return reject(field);
        const Dictionary modules = get("modules"), resources = get("resources"), scripts = get("nativeScripts"), artifacts = get("artifacts"), entries = get("entries"), origins = get("sourceOrigins");
        if (entries.is_empty()) return reject("entries");
        HashMap<String, String> paths;
        const auto uri = [&](const Variant& value) {
            if (!text(value) || !is_canonical_path(value)) return false;
            const String path = value, folded = path.to_lower();
            const String* previous = paths.getptr(folded);
            if (previous && *previous != path) return false;
            paths.insert(folded, path);
            return true;
        };
        for (const KeyValue<Variant, Variant>& pair : artifacts)
        {
            if (!uri(pair.key) || !shape(pair.value, { "sha256", "owner", "kind" })) return reject("artifacts");
            const Dictionary item = pair.value;
            if (!digest(item.get("sha256", Variant())) || !text(item.get("kind", Variant()))
                || !one_of(item.get("owner", Variant()), { "compiler", "native-importer" })) return reject("artifacts.descriptor");
            const String path = pair.key;
            if (path.get_file() == "active.json" || path.get_file() == "journal.json") return reject("artifacts.activation");
        }
        for (const KeyValue<Variant, Variant>& pair : modules)
        {
            if (!shape(pair.value, { "uri", "sha256", "dependencies", "kind" })) return reject("modules");
            const Dictionary item = pair.value;
            const Variant path = item.get("uri", Variant());
            if (!uri(path) || !digest(item.get("sha256", Variant())) || !artifacts.has(path)
                || !one_of(item.get("kind", Variant()), { "view", "vendor", "template", "model" })) return reject("modules.descriptor");
            const Dictionary artifact = artifacts.get(path, Variant());
            if (artifact.get("sha256", Variant()) != item.get("sha256", Variant())) return reject("modules.hash");
        }
        for (const KeyValue<Variant, Variant>& pair : scripts)
        {
            if (!shape(pair.value, { "source", "output", "sha256", "dependencies" })) return reject("nativeScripts");
            const Dictionary item = pair.value;
            const String source = item.get("source", ""), output = item.get("output", "");
            if (!uri(item.get("source", Variant())) || !uri(item.get("output", Variant())) || !digest(item.get("sha256", Variant()))
                || !source.ends_with(".ts") || source.begins_with("res://node_modules/") || !output.ends_with(".js")
                || !artifacts.has(source) || !artifacts.has(output)) return reject("nativeScripts.descriptor");
            const Dictionary artifact = artifacts.get(output, Variant());
            if (artifact.get("sha256", Variant()) != item.get("sha256", Variant())) return reject("nativeScripts.hash");
        }
        for (const KeyValue<Variant, Variant>& pair : resources)
        {
            if (!shape(pair.value, { "uri", "sha256", "type", "dependencies", "importedArtifacts" })) return reject("resources");
            const Dictionary item = pair.value;
            if (!uri(item.get("uri", Variant())) || !digest(item.get("sha256", Variant())) || !text(item.get("type", Variant()))
                || !strings(item.get("importedArtifacts", Variant()))) return reject("resources.descriptor");
            const Array imports = item.get("importedArtifacts", Variant());
            for (int i = 0; i < imports.size(); ++i)
                if (!uri(imports[i]) || !artifacts.has(imports[i])) return reject("resources.importedArtifacts");
        }
        if (!edges(modules) || !edges(resources) || !edges(scripts)) return reject("dependencies");
        const auto script_exists = [&](const Variant& path) {
            for (const KeyValue<Variant, Variant>& script : scripts)
            {
                const Dictionary value = script.value;
                if (value.get("source", Variant()) == path) return true;
            }
            return false;
        };
        for (const KeyValue<Variant, Variant>& pair : entries)
        {
            if (!shape(pair.value, { "id", "module", "exportName", "script", "scene", "startupAssets" }, { "resourceHub", "exportHub" })) return reject("entries");
            const Dictionary item = pair.value;
            if (item.get("id", Variant()) != pair.key || !text(item.get("module", Variant())) || !modules.has(item.get("module", Variant()))
                || !text(item.get("exportName", Variant())) || !strings(item.get("startupAssets", Variant()))
                || !script_exists(item.get("script", Variant())) || !String(item.get("scene", "")).ends_with(".tscn")) return reject("entries.descriptor");
            for (const char* field : { "script", "scene", "resourceHub", "exportHub" })
                if (item.has(field) && (!uri(item.get(field, Variant())) || !artifacts.has(item.get(field, Variant())))) return reject("entries.artifacts");
            const Array assets = item.get("startupAssets", Variant());
            for (int i = 0; i < assets.size(); ++i) if (!resources.has(assets[i])) return reject("entries.startupAssets");
        }
        for (const KeyValue<Variant, Variant>& pair : origins)
        {
            if (!uri(pair.key) || !artifacts.has(pair.key) || !shape(pair.value, { "source", "line", "column" })) return reject("sourceOrigins");
            const Dictionary item = pair.value;
            if (!uri(item.get("source", Variant())) || artifacts.has(item.get("source", Variant()))
                || !integer(item.get("line", Variant())) || !integer(item.get("column", Variant()))) return reject("sourceOrigins.descriptor");
        }
        if (p_manifest.has("nativeScriptProfiles"))
        {
            const Variant profiles_value = get("nativeScriptProfiles");
            if (!object(profiles_value)) return reject("nativeScriptProfiles");
            const Dictionary profiles = profiles_value;
            for (const KeyValue<Variant, Variant>& pair : profiles)
            {
                if (!shape(pair.value, { "type", "script", "schemaHash" })) return reject("nativeScriptProfiles");
                const Dictionary item = pair.value;
                const String type = item.get("type", "");
                if (!text(item.get("type", Variant())) || !type.is_valid_ascii_identifier() || !uri(item.get("script", Variant()))
                    || !script_exists(item.get("script", Variant())) || !digest(item.get("schemaHash", Variant()))) return reject("nativeScriptProfiles.descriptor");
            }
        }
        return OK;
    }
}
