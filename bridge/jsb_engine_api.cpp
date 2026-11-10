#include "jsb_engine_api.h"

#include "../internal/jsb_naming_util.h"
#include "../internal/jsb_string_names.h"
#include "../jsb.gen.h"
#include "core/config/engine.h"
#include "core/core_constants.h"
#include "core/io/json.h"
#include "core/object/class_db.h"
#include "core/os/os.h"
#include "core/version.h"
#include "core/variant/type_info.h"

namespace jsb {
namespace {
Dictionary bound_operator(const char *name, Variant::Type left, Variant::Type right, Variant::Type result, bool unary) {
    Dictionary out; out["publicName"] = name; out["leftType"] = int(left); out["rightType"] = int(right);
    out["returnType"] = int(result); out["unary"] = unary; return out;
}

Dictionary binding_operators() {
    Dictionary by_type;
    // The same definition drives the reflect/static binder. Variant's full
    // validated-operator table alone would incorrectly promise extra JS methods.
#define JSB_TYPE_BEGIN(InType) { using CurrentType = InType; Array entries;
#define JSB_TYPE_END() by_type[int(GetTypeInfo<CurrentType>::VARIANT_TYPE)] = entries; }
#define JSB_DEFINE_OVERLOADED_BINARY_BEGIN(Op) { const char *name = #Op;
#define JSB_DEFINE_OVERLOADED_BINARY_END() }
#define JSB_DEFINE_BINARY_OVERLOAD(R, A, B) entries.push_back(bound_operator(name, GetTypeInfo<A>::VARIANT_TYPE, GetTypeInfo<B>::VARIANT_TYPE, GetTypeInfo<R>::VARIANT_TYPE, false));
#define JSB_DEFINE_UNARY(Op) entries.push_back(bound_operator(#Op, GetTypeInfo<CurrentType>::VARIANT_TYPE, Variant::NIL, GetTypeInfo<CurrentType>::VARIANT_TYPE, true));
#define JSB_DEFINE_COMPARATOR(Op) entries.push_back(bound_operator(#Op, GetTypeInfo<CurrentType>::VARIANT_TYPE, GetTypeInfo<CurrentType>::VARIANT_TYPE, Variant::BOOL, false));
#define Number double
#include "../internal/jsb_primitive_operators.def.h"
#undef Number
#undef JSB_TYPE_BEGIN
#undef JSB_TYPE_END
#undef JSB_DEFINE_OVERLOADED_BINARY_BEGIN
#undef JSB_DEFINE_OVERLOADED_BINARY_END
#undef JSB_DEFINE_BINARY_OVERLOAD
#undef JSB_DEFINE_UNARY
#undef JSB_DEFINE_COMPARATOR
    return by_type;
}

Dictionary builtin_binding_kinds() {
    Dictionary by_type;
#define DEF(TypeName) by_type[int(GetTypeInfo<TypeName>::VARIANT_TYPE)] = "value";
#include "jsb_primitive_types.def.h"
#undef DEF
    by_type[int(Variant::STRING)] = "utility";
    return by_type;
}

Dictionary value_info(const Variant &value, int depth = 0) {
    Dictionary out;
    const Variant::Type type = value.get_type();
    out["type"] = int(type);
    if (depth > 12) { out["truncated"] = true; return out; }
    // Never include ObjectIDs, process addresses, or resource instance names in
    // API identity. Integer text also preserves values outside JS safe integers.
    if (type == Variant::OBJECT) {
        const Object *object = value;
        out["className"] = object ? String(object->get_class()) : String();
        out["isNull"] = object == nullptr;
    } else if (type == Variant::ARRAY) {
        const Array array = value; Array items;
        for (int i = 0; i < array.size(); ++i) items.push_back(value_info(array[i], depth + 1));
        out["items"] = items;
    } else if (type == Variant::DICTIONARY) {
        const Dictionary dictionary = value; Array entries;
        for (const Variant &key : dictionary.keys()) {
            Dictionary entry; entry["key"] = value_info(key, depth + 1); entry["value"] = value_info(dictionary[key], depth + 1); entries.push_back(entry);
        }
        out["entries"] = entries;
    } else {
        out["text"] = value.stringify();
        if (type == Variant::BOOL || type == Variant::STRING || type == Variant::STRING_NAME) out["value"] = value;
        if (type == Variant::INT) out["integer"] = itos(int64_t(value));
    }
    return out;
}

Dictionary property_info(const PropertyInfo &property, bool argument = false) {
    Dictionary out = Dictionary(property);
    out["nativeName"] = property.name;
    out["publicName"] = argument ? internal::NamingUtil::get_parameter_name(property.name) : internal::NamingUtil::get_member_name(property.name);
    return out;
}

Dictionary method_info(const MethodInfo &method) {
    Dictionary out;
    out["nativeName"] = method.name;
    out["publicName"] = internal::NamingUtil::get_member_name(method.name);
    out["flags"] = method.flags;
    out["return"] = property_info(method.return_val);
    out["returnMetadata"] = method.return_val_metadata;
    out["hasReturnValue"] = method.return_val.type != Variant::NIL || bool(method.return_val.usage & PROPERTY_USAGE_NIL_IS_VARIANT);
    Array args, defaults, metadata;
    for (const PropertyInfo &arg : method.arguments) args.push_back(property_info(arg, true));
    for (const Variant &value : method.default_arguments) defaults.push_back(value_info(value));
    for (int value : method.arguments_metadata) metadata.push_back(value);
    out["args"] = args; out["defaultArgs"] = defaults; out["argumentsMetadata"] = metadata;
    return out;
}
}

Dictionary describe_engine_api() {
    Dictionary out;
    out["schemaVersion"] = 1;
    out["apiVersion"] = "godotjs-engine-api/1";
    out["namingVersion"] = "godotjs-public-names/1";
    out["engineVersion"] = VERSION_FULL_CONFIG;
    out["engineVersionInfo"] = Engine::get_singleton()->get_version_info();
    out["bindingVersion"] = JSB_STRINGIFY(JSB_MAJOR_VERSION) "." JSB_STRINGIFY(JSB_MINOR_VERSION) "." JSB_STRINGIFY(JSB_PATCH_VERSION);
    out["bindingNaming"] = internal::Settings::get_camel_case_bindings_enabled() ? "camel" : "snake";
    out["platform"] = OS::get_singleton()->get_name();
#ifdef JSB_ENGINE_MODULES_JSON
    out["modules"] = JSON::parse_string(JSB_ENGINE_MODULES_JSON);
#else
    out["modules"] = Array();
#endif
    Dictionary policy;
    policy["excludeGetSetMethods"] = bool(JSB_EXCLUDE_GETSET_METHODS);
    policy["bigInt"] = bool(JSB_WITH_BIGINT);
    policy["sharedResources"] = true;
    out["bindingPolicy"] = policy;
    Array classes, builtins, utilities, globals, singletons;
    LocalVector<StringName> class_names; ClassDB::get_class_list(class_names); class_names.sort();
    for (const StringName &name : class_names) {
        Dictionary cls;
        cls["nativeName"] = name; cls["publicName"] = internal::NamingUtil::get_class_name(name);
        cls["parent"] = ClassDB::get_parent_class(name);
        cls["apiType"] = int(ClassDB::get_api_type(name));
        cls["exposed"] = ClassDB::is_class_exposed(name); cls["enabled"] = ClassDB::is_class_enabled(name);
        cls["constructible"] = ClassDB::can_instantiate(name); cls["abstract"] = ClassDB::is_abstract(name); cls["virtual"] = ClassDB::is_virtual(name);
        Array methods, properties, signals, constants, enums;
        const ClassDB::ClassInfo *class_info = ClassDB::classes.getptr(name);
        HashSet<StringName> absorbed_methods;
        List<PropertyInfo> property_list; ClassDB::get_property_list(name, &property_list, true);
        for (const PropertyInfo &property : property_list) {
            Dictionary info = property_info(property);
            const ClassDB::PropertySetGet *getset = class_info ? class_info->property_setget.getptr(property.name) : nullptr;
            if (getset) {
                info["getter"] = getset->getter; info["setter"] = getset->setter; info["index"] = getset->index;
                const bool ignored = internal::StringNames::get_singleton().is_ignored(property.name);
                info["binding"] = ignored ? "methods" : "property";
                if (!ignored && getset->index < 0 && JSB_EXCLUDE_GETSET_METHODS) {
                    if (!getset->getter.is_empty()) absorbed_methods.insert(getset->getter);
                    if (!getset->setter.is_empty()) absorbed_methods.insert(getset->setter);
                }
            } else info["binding"] = "metadata";
            properties.push_back(info);
        }
        List<MethodInfo> method_list; ClassDB::get_method_list(name, &method_list, true);
        for (const MethodInfo &method : method_list) {
            Dictionary info = method_info(method); info["binding"] = absorbed_methods.has(method.name) ? "accessor" : "method"; methods.push_back(info);
        }
        List<MethodInfo> signal_list; ClassDB::get_signal_list(name, &signal_list, true);
        for (const MethodInfo &signal : signal_list) signals.push_back(method_info(signal));
        List<String> constant_list; ClassDB::get_integer_constant_list(name, &constant_list, true);
        for (const String &constant : constant_list) {
            Dictionary info; info["nativeName"] = constant;
            const StringName enumeration = ClassDB::get_integer_constant_enum(name, constant, true);
            info["publicName"] = enumeration.is_empty() ? internal::NamingUtil::get_constant_name(constant) : internal::NamingUtil::get_enum_value_name(constant);
            info["integer"] = itos(ClassDB::get_integer_constant(name, constant));
            info["enum"] = enumeration; constants.push_back(info);
        }
        List<StringName> enum_list; ClassDB::get_enum_list(name, &enum_list, true);
        for (const StringName &enumeration : enum_list) {
            Dictionary info; info["nativeName"] = enumeration; info["publicName"] = internal::NamingUtil::get_enum_name(enumeration);
            info["bitfield"] = ClassDB::is_enum_bitfield(name, enumeration, true); enums.push_back(info);
        }
        cls["methods"] = methods; cls["properties"] = properties; cls["signals"] = signals; cls["constants"] = constants; cls["enums"] = enums; classes.push_back(cls);
    }
    const Dictionary bound_operators = binding_operators(), binding_kinds = builtin_binding_kinds();
    for (int index = Variant::NIL; index < Variant::VARIANT_MAX; ++index) {
        const Variant::Type type = Variant::Type(index); Dictionary builtin;
        builtin["type"] = index; builtin["nativeName"] = Variant::get_type_name(type); builtin["publicName"] = internal::NamingUtil::get_class_name(Variant::get_type_name(type));
        builtin["keyed"] = Variant::is_keyed(type);
        const String binding_kind = binding_kinds.get(index, "unbound");
        builtin["bindingKind"] = binding_kind;
        Dictionary extras;
        if (binding_kind == "value") extras["builtinType"] = "__builtin_type__";
        if (Variant::has_indexing(type)) {
            builtin["elementType"] = int(Variant::get_indexed_element_type(type));
            if (binding_kind == "value") {
                extras["getIndexed"] = internal::NamingUtil::get_member_name("get_indexed");
                extras["setIndexed"] = internal::NamingUtil::get_member_name("set_indexed");
            }
        }
        if (binding_kind == "value" && Variant::is_keyed(type)) {
            extras["getKeyed"] = internal::NamingUtil::get_member_name("get_keyed");
            extras["setKeyed"] = internal::NamingUtil::get_member_name("set_keyed");
        }
        if (type == Variant::PACKED_BYTE_ARRAY) extras["toArrayBuffer"] = internal::NamingUtil::get_member_name("to_array_buffer");
        builtin["bindingExtras"] = extras;
        builtin["bindingOperators"] = binding_kind == "value" ? bound_operators.get(index, Array()) : Variant(Array());
        Array constructors, methods, properties, constants, enums, operators;
        List<MethodInfo> constructor_list; Variant::get_constructor_list(type, &constructor_list);
        for (const MethodInfo &constructor : constructor_list) constructors.push_back(method_info(constructor));
        List<StringName> method_list; Variant::get_builtin_method_list(type, &method_list);
        for (const StringName &method : method_list) {
            Dictionary info = method_info(Variant::get_builtin_method_info(type, method)); info["hasReturnValue"] = Variant::has_builtin_method_return_value(type, method);
            if (type == Variant::STRING && String(info["publicName"]) == "length") info["publicName"] = "length_";
            methods.push_back(info);
        }
        List<StringName> property_list; Variant::get_member_list(type, &property_list);
        for (const StringName &property : property_list) properties.push_back(property_info(PropertyInfo(Variant::get_member_type(type, property), property)));
        List<StringName> constant_list; Variant::get_constants_for_type(type, &constant_list);
        for (const StringName &constant : constant_list) {
            const StringName enumeration = Variant::get_enum_for_enumeration(type, constant);
            Dictionary info; info["nativeName"] = constant;
            info["publicName"] = enumeration == StringName() ? internal::NamingUtil::get_constant_name(constant) : internal::NamingUtil::get_enum_value_name(constant);
            info["value"] = value_info(Variant::get_constant_value(type, constant)); info["enum"] = enumeration; constants.push_back(info);
        }
        List<StringName> enum_list; Variant::get_enums_for_type(type, &enum_list);
        for (const StringName &enumeration : enum_list) {
            Dictionary info; info["nativeName"] = enumeration; info["publicName"] = internal::NamingUtil::get_enum_name(enumeration); enums.push_back(info);
        }
        for (int op = Variant::OP_EQUAL; op < Variant::OP_MAX; ++op) for (int right = Variant::NIL; right < Variant::VARIANT_MAX; ++right) {
            const auto operation = Variant::Operator(op); const auto rhs = Variant::Type(right);
            if (!Variant::get_validated_operator_evaluator(operation, type, rhs)) continue;
            Dictionary info; info["operator"] = op; info["rightType"] = right; info["returnType"] = int(Variant::get_operator_return_type(operation, type, rhs)); operators.push_back(info);
        }
        builtin["constructors"] = constructors; builtin["methods"] = methods; builtin["properties"] = properties; builtin["constants"] = constants; builtin["enums"] = enums; builtin["operators"] = operators; builtins.push_back(builtin);
    }
    List<StringName> utility_list; Variant::get_utility_function_list(&utility_list);
    for (const StringName &name : utility_list) {
        Dictionary info = method_info(Variant::get_utility_function_info(name));
        info["publicName"] = internal::StringNames::get_singleton().get_replaced_name(name);
        info["hasReturnValue"] = Variant::has_utility_function_return_value(name); utilities.push_back(info);
    }
    for (int i = 0; i < CoreConstants::get_global_constant_count(); ++i) {
        const StringName name = CoreConstants::get_global_constant_name(i); Dictionary info;
        info["nativeName"] = name; info["publicName"] = internal::NamingUtil::get_constant_name(name);
        info["enumValueName"] = internal::NamingUtil::get_enum_value_name(name);
        info["enumPublicName"] = internal::NamingUtil::get_enum_name(CoreConstants::get_global_constant_enum(i));
        info["bitfield"] = CoreConstants::is_global_constant_bitfield(i);
        info["integer"] = itos(CoreConstants::get_global_constant_value(i)); info["enum"] = CoreConstants::get_global_constant_enum(i); globals.push_back(info);
    }
    List<Engine::Singleton> singleton_list; Engine::get_singleton()->get_singletons(&singleton_list);
    for (const Engine::Singleton &singleton : singleton_list) {
        Dictionary info; info["nativeName"] = singleton.name; info["publicName"] = internal::NamingUtil::get_class_name(singleton.name);
        info["className"] = singleton.ptr ? singleton.ptr->get_class() : String(); singletons.push_back(info);
    }
    out["classes"] = classes; out["builtins"] = builtins; out["utilities"] = utilities; out["globalConstants"] = globals; out["singletons"] = singletons;
    return out;
}
}
