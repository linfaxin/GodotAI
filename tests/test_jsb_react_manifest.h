#ifndef GODOTJS_TESTS_REACT_MANIFEST_H
#define GODOTJS_TESTS_REACT_MANIFEST_H

#include "../internal/jsb_react_manifest.h"
#include "jsb_test_helpers.h"
#include "tests/test_macros.h"

namespace jsb::tests
{
    TEST_CASE("[jsb][react] active descriptor accepts real JSON numeric schema versions")
    {
        const Variant parsed = JSON::parse_string(R"JSON({"schemaVersion":1,"generation":"g1","manifestPath":"res://generated/react/manifests/g1.json","manifestSha256":"0000000000000000000000000000000000000000000000000000000000000000","state":"READY"})JSON");
        REQUIRE(parsed.get_type() == Variant::DICTIONARY);
        Dictionary active = parsed;
        CHECK(active.get("schemaVersion", Variant()).get_type() == Variant::FLOAT);
        String reason;
        CHECK(internal::ReactManifest::validate_active_descriptor(active, reason) == OK);
        active["schemaVersion"] = 1;
        CHECK(internal::ReactManifest::validate_active_descriptor(active, reason) == OK);
        active["schemaVersion"] = "1";
        CHECK(internal::ReactManifest::validate_active_descriptor(active, reason) == ERR_FILE_CORRUPT);
        active["schemaVersion"] = true;
        CHECK(internal::ReactManifest::validate_active_descriptor(active, reason) == ERR_FILE_CORRUPT);
        active["schemaVersion"] = 1.5;
        CHECK(internal::ReactManifest::validate_active_descriptor(active, reason) == ERR_FILE_CORRUPT);
    }

    TEST_CASE("[jsb][react] manifest paths are canonical resource paths")
    {
        CHECK(internal::ReactManifest::is_canonical_path("res://generated/react/active.json"));
        CHECK(internal::ReactManifest::is_canonical_path("res://.godot/GodotJS/react-build/g1/app.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a/../secret.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a//file.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a\\file.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a/\nfile.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("/tmp/file.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("user://file.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a/file.js?cache=1"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a/%66ile.js"));
        CHECK_FALSE(internal::ReactManifest::is_canonical_path("res://a/file.js "));
    }

    TEST_CASE("[jsb][react] native manifest consumes the shared wire conformance fixture")
    {
        CurrentWorkingDirectory::reset();
        const String path = "modules/" JSB_MODULE_NAME_STRING "/scripts/jsb.react/src/contracts/fixtures/runtime-manifest-v1.json";
        REQUIRE(FileAccess::exists(path));
        const Variant parsed = JSON::parse_string(FileAccess::get_file_as_string(path));
        REQUIRE(parsed.get_type() == Variant::DICTIONARY);
        const Dictionary fixture = parsed;
        String reason;
        CHECK(internal::ReactManifest::validate_manifest(fixture, reason) == OK);
        CHECK(reason.is_empty());

        Dictionary unknown = fixture.duplicate(true);
        unknown["futureField"] = true;
        CHECK(internal::ReactManifest::validate_manifest(unknown, reason) == ERR_FILE_CORRUPT);

        Dictionary broken_edge = fixture.duplicate(true);
        Dictionary modules = broken_edge["modules"];
        Dictionary app = modules["app"];
        Array missing;
        missing.push_back("absent-module");
        app["dependencies"] = missing;
        CHECK(internal::ReactManifest::validate_manifest(broken_edge, reason) == ERR_FILE_CORRUPT);

        Dictionary missing_source = fixture.duplicate(true);
        Dictionary profiles = missing_source["nativeScriptProfiles"];
        Dictionary profile = profiles["example"];
        profile["script"] = "res://generated/react/entries/missing.ts";
        CHECK(internal::ReactManifest::validate_manifest(missing_source, reason) == ERR_FILE_CORRUPT);

        Dictionary collision = fixture.duplicate(true);
        Dictionary artifacts = collision["artifacts"];
        artifacts["res://.godot/GodotJS/react-build/g1/app.js"] = artifacts["res://.godot/GodotJS/react-build/g1/App.js"];
        CHECK(internal::ReactManifest::validate_manifest(collision, reason) == ERR_FILE_CORRUPT);

        Dictionary wrong_shape = fixture.duplicate(true);
        Dictionary resources = wrong_shape["resources"];
        resources["wrong"] = 7;
        CHECK(internal::ReactManifest::validate_manifest(wrong_shape, reason) == ERR_FILE_CORRUPT);
    }

    TEST_CASE("[jsb][react] code closure preserves per-source NativeScript remapping")
    {
        Dictionary manifest;
        Dictionary modules;
        Dictionary view;
        view["uri"] = "res://.godot/GodotJS/react-build/g1/views/app.js";
        modules["view"] = view;
        manifest["modules"] = modules;
        Dictionary scripts;
        Dictionary entry;
        entry["source"] = "res://generated/react/entries/app.ts";
        entry["output"] = "res://.godot/GodotJS/generated/react/entries/app.js";
        scripts["entry"] = entry;
        manifest["nativeScripts"] = scripts;
        Dictionary artifacts;
        artifacts[view["uri"]] = Dictionary();
        artifacts[entry["output"]] = Dictionary();
        artifacts["res://.godot/GodotJS/react-build/g1/views/app.js.map"] = Dictionary();
        artifacts["res://assets/material.tres"] = Dictionary();
        manifest["artifacts"] = artifacts;

        PackedStringArray files;
        internal::ReactManifest::collect_export_files(manifest, files, false);
        CHECK(files.has(view["uri"]));
        CHECK_FALSE(files.has(entry["output"]));
        CHECK_FALSE(files.has("res://assets/material.tres"));
        CHECK_FALSE(files.has("res://.godot/GodotJS/react-build/g1/views/app.js.map"));

        PackedStringArray debug_files;
        internal::ReactManifest::collect_export_files(manifest, debug_files, true);
        CHECK(debug_files.has("res://.godot/GodotJS/react-build/g1/views/app.js.map"));
    }
}

#endif
