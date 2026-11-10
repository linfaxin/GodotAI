// P0-only instrumentation. Not part of the product engine or public API.
#include "register_types.h"
#include "core/core_constants.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/object/class_db.h"
#include "core/object/ref_counted.h"
#include "core/variant/variant.h"

namespace {
Dictionary typed_default(const Variant &p_value) {
    Dictionary out;
    out["type"] = int(p_value.get_type());
    out["text"] = p_value.stringify();
    if (p_value.get_type() == Variant::BOOL || p_value.get_type() == Variant::STRING || p_value.get_type() == Variant::STRING_NAME) out["value"] = p_value;
    // Decimal text preserves int64 precision, including values outside JS safe integers.
    if (p_value.get_type() == Variant::INT) out["integer"] = itos(int64_t(p_value));
    return out;
}

Dictionary describe_method(const MethodInfo &p_method) {
    Dictionary out;
    out["name"] = p_method.name;
    out["flags"] = p_method.flags;
    out["return"] = Dictionary(p_method.return_val);
    out["return_metadata"] = p_method.return_val_metadata;
    out["has_return_value"] = p_method.return_val.type != Variant::NIL || bool(p_method.return_val.usage & PROPERTY_USAGE_NIL_IS_VARIANT);
    Array args, defaults, metadata;
    for (const PropertyInfo &arg : p_method.arguments) args.push_back(Dictionary(arg));
    for (const Variant &value : p_method.default_arguments) defaults.push_back(typed_default(value));
    for (int value : p_method.arguments_metadata) metadata.push_back(value);
    out["args"] = args;
    out["default_args"] = defaults;
    out["arguments_metadata"] = metadata;
    return out;
}

class P0EngineApiProbe : public RefCounted {
    GDCLASS(P0EngineApiProbe, RefCounted);
protected:
    static void _bind_methods() { ClassDB::bind_static_method("P0EngineApiProbe", D_METHOD("describe_json"), &P0EngineApiProbe::describe_json); }
public:
    static String describe_json() {
        Dictionary out;
        out["schemaVersion"] = 1;
        out["instrumentation"] = "P0-only generic runtime metadata; not a production release";
        out["excludedInstrumentationClass"] = "P0EngineApiProbe";
        Array classes, builtins, utilities, globals, singletons;
        LocalVector<StringName> names;
        ClassDB::get_class_list(names);
        names.sort();
        for (const StringName &name : names) {
            if (name == StringName("P0EngineApiProbe")) continue;
            Dictionary cls;
            cls["name"] = name;
            cls["parent"] = ClassDB::get_parent_class(name);
            cls["constructible"] = ClassDB::can_instantiate(name);
            cls["api_type"] = int(ClassDB::get_api_type(name));
            Array methods, props, signals, constants, enums;
            List<MethodInfo> method_list, signal_list;
            List<PropertyInfo> prop_list;
            ClassDB::get_method_list(name, &method_list, true);
            ClassDB::get_signal_list(name, &signal_list, true);
            ClassDB::get_property_list(name, &prop_list, true);
            for (const MethodInfo &method : method_list) methods.push_back(describe_method(method));
            for (const MethodInfo &signal : signal_list) signals.push_back(describe_method(signal));
            for (const PropertyInfo &property : prop_list) {
                Dictionary info = Dictionary(property);
                if (!(property.usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_SUBGROUP))) {
                    info["getter"] = ClassDB::get_property_getter(name, property.name);
                    info["setter"] = ClassDB::get_property_setter(name, property.name);
                }
                props.push_back(info);
            }
            List<String> constant_list;
            ClassDB::get_integer_constant_list(name, &constant_list, true);
            for (const String &constant : constant_list) {
                Dictionary value;
                value["name"] = constant;
                value["integer"] = itos(ClassDB::get_integer_constant(name, constant));
                value["enum"] = ClassDB::get_integer_constant_enum(name, constant, true);
                constants.push_back(value);
            }
            List<StringName> enum_list;
            ClassDB::get_enum_list(name, &enum_list, true);
            for (const StringName &enum_name : enum_list) enums.push_back(String(enum_name));
            cls["methods"] = methods; cls["properties"] = props; cls["signals"] = signals; cls["constants"] = constants; cls["enums"] = enums;
            classes.push_back(cls);
        }
        for (int index = Variant::NIL; index < Variant::VARIANT_MAX; ++index) {
            const Variant::Type type = Variant::Type(index);
            Dictionary builtin;
            builtin["type"] = index; builtin["name"] = Variant::get_type_name(type);
            builtin["keyed"] = Variant::is_keyed(type);
            if (Variant::has_indexing(type)) builtin["element_type"] = int(Variant::get_indexed_element_type(type));
            Array constructors, methods, properties, constants, enums, operators;
            List<MethodInfo> constructor_list;
            Variant::get_constructor_list(type, &constructor_list);
            for (const MethodInfo &constructor : constructor_list) constructors.push_back(describe_method(constructor));
            List<StringName> method_list, member_list, constant_list, enum_list;
            Variant::get_builtin_method_list(type, &method_list);
            for (const StringName &method_name : method_list) {
                Dictionary method = describe_method(Variant::get_builtin_method_info(type, method_name));
                method["has_return_value"] = Variant::has_builtin_method_return_value(type, method_name);
                methods.push_back(method);
            }
            Variant::get_member_list(type, &member_list);
            for (const StringName &member : member_list) {
                Dictionary property; property["name"] = member; property["type"] = int(Variant::get_member_type(type, member)); properties.push_back(property);
            }
            Variant::get_constants_for_type(type, &constant_list);
            for (const StringName &constant : constant_list) {
                Dictionary value; value["name"] = constant; value["value"] = typed_default(Variant::get_constant_value(type, constant)); constants.push_back(value);
            }
            Variant::get_enums_for_type(type, &enum_list);
            for (const StringName &enum_name : enum_list) {
                Dictionary enumeration; enumeration["name"] = enum_name; Array entries;
                List<StringName> entry_list; Variant::get_enumerations_for_enum(type, enum_name, &entry_list);
                for (const StringName &entry : entry_list) { Dictionary value; value["name"] = entry; value["integer"] = itos(Variant::get_enum_value(type, enum_name, entry)); entries.push_back(value); }
                enumeration["values"] = entries; enums.push_back(enumeration);
            }
            for (int op = Variant::OP_EQUAL; op < Variant::OP_MAX; ++op) for (int right = Variant::NIL; right < Variant::VARIANT_MAX; ++right) {
                const auto operation = Variant::Operator(op); const auto rhs = Variant::Type(right);
                if (!Variant::get_validated_operator_evaluator(operation, type, rhs)) continue;
                Dictionary value; value["operator"] = op; value["right_type"] = right; value["return_type"] = int(Variant::get_operator_return_type(operation, type, rhs)); operators.push_back(value);
            }
            builtin["constructors"] = constructors; builtin["methods"] = methods; builtin["properties"] = properties;
            builtin["constants"] = constants; builtin["enums"] = enums; builtin["operators"] = operators;
            builtins.push_back(builtin);
        }
        List<StringName> utility_list;
        Variant::get_utility_function_list(&utility_list);
        for (const StringName &name : utility_list) {
            Dictionary method = describe_method(Variant::get_utility_function_info(name));
            method["has_return_value"] = Variant::has_utility_function_return_value(name);
            utilities.push_back(method);
        }
        for (int i = 0; i < CoreConstants::get_global_constant_count(); ++i) {
            Dictionary value;
            value["name"] = CoreConstants::get_global_constant_name(i);
            value["integer"] = itos(CoreConstants::get_global_constant_value(i));
            value["enum"] = CoreConstants::get_global_constant_enum(i);
            globals.push_back(value);
        }
        List<Engine::Singleton> singleton_list;
        Engine::get_singleton()->get_singletons(&singleton_list);
        for (const Engine::Singleton &singleton : singleton_list) {
            Dictionary value; value["name"] = singleton.name; value["class"] = singleton.ptr ? singleton.ptr->get_class() : String(); singletons.push_back(value);
        }
        out["classes"] = classes; out["builtins"] = builtins; out["utilities"] = utilities; out["global_constants"] = globals; out["singletons"] = singletons;
        return JSON::stringify(out);
    }
};
}

void initialize_godotai_api_probe_module(ModuleInitializationLevel p_level) {
    if (p_level == MODULE_INITIALIZATION_LEVEL_SCENE) GDREGISTER_CLASS(P0EngineApiProbe);
}
void uninitialize_godotai_api_probe_module(ModuleInitializationLevel) {}
