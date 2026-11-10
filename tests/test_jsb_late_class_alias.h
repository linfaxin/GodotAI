#ifndef GODOTJS_TEST_LATE_CLASS_ALIAS_H
#define GODOTJS_TEST_LATE_CLASS_ALIAS_H

#include "jsb_test_helpers.h"
#include "../bridge/jsb_environment.h"
#include "../internal/jsb_naming_util.h"
#include "../internal/jsb_string_names.h"
#include "core/object/ref_counted.h"

namespace jsb::tests
{
    class BindingDelayedHTTPAlias : public RefCounted
    {
        GDCLASS(BindingDelayedHTTPAlias, RefCounted);

    protected:
        static void _bind_methods() {}
    };

    TEST_CASE("[jsb] camel aliases resolve classes registered after Environment initialization")
    {
        GodotJSScriptLanguageIniter initer;
        struct RestoreSetting
        {
            const String name = "GodotJS/runtime/core/camel_case_bindings_enabled";
            const Variant previous = ProjectSettings::get_singleton()->get_setting(name, false);
            ~RestoreSetting() { ProjectSettings::get_singleton()->set_setting(name, previous); }
        } restore;
        ProjectSettings::get_singleton()->set_setting(restore.name, true);
        const auto env = std::make_shared<Environment>(Environment::CreateParams());
        env->init();

        const StringName original_name = BindingDelayedHTTPAlias::get_class_static();
        const StringName public_name = internal::NamingUtil::get_class_name(original_name);
        REQUIRE(public_name != original_name);
        REQUIRE_FALSE(ClassDB::class_exists(original_name));
        REQUIRE(internal::StringNames::get_singleton().get_original_name(public_name) == public_name);
        ClassDB::register_class<BindingDelayedHTTPAlias>();
        REQUIRE(ClassDB::class_exists(original_name));

        {
            v8::Isolate::Scope isolate_scope(env->get_isolate());
            JSB_TESTS_EXECUTION_SCOPE(env.get());
            static constexpr char source[] = R"JS((() => {
                const G = require('godot');
                const names = require('godot-jsb').internal.names;
                const original = 'BindingDelayedHTTPAlias';
                const alias = names.get_class(original);
                const ctor = G[alias];
                if (typeof ctor !== 'function') throw Error('Late class alias did not resolve');
                if (G[alias] !== ctor) throw Error('Late class constructor was not cached');
                if (names.get_internal_mapping(alias) !== original) throw Error('Late alias did not roundtrip');
                const instance = new ctor();
                if (!G[names.get_member('is_instance_valid')](instance)) throw Error('Late native class was not constructed');
                if (String(instance[names.get_member('get_class')]()) !== original) throw Error('Wrong native class');
            })())JS";
            Error error = OK;
            env->eval_source(source, sizeof(source) - 1, "late-class-alias-test.js", error);
            CHECK(error == OK);
        }
        CHECK(internal::StringNames::get_singleton().get_original_name(public_name) == original_name);
        env->dispose();
    }
}

#endif
