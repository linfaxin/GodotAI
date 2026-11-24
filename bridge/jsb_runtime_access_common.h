#ifndef JSB_RUNTIME_ACCESS_COMMON_H
#define JSB_RUNTIME_ACCESS_COMMON_H
#include "jsb_runtime_observation.h"
#include "jsb_native_world.h"
#include "core/variant/dictionary.h"
#include "core/variant/array.h"
#include "scene/main/scene_tree.h"
#include <functional>
#include <initializer_list>
#include <string>
#include <vector>
namespace jsb::runtime_access {
Dictionary error_reply(const char* code, const char* message);
Dictionary success_reply(const Dictionary& result);
bool valid_component(const String& name);
bool read_path(const Variant& raw, String& path, Vector<String>& components);
bool read_integer(const Dictionary& request, const char* key, int fallback, int lower, int upper, int& value);
bool is_public_node(const Node* node, const SceneTree* tree);
Node* find_node(const SceneTree* tree, const Vector<String>& components);
String instance_id(const Node* node);
const char* active_scene_error(std::shared_ptr<NativeWorld>& world, const SceneTree*& tree);
Dictionary coordinates(const Vector2& position);
bool read_instance_id(const Variant& raw, String& id);
bool parse_request(const char* request, uint32_t size, Dictionary& parsed, std::vector<double>* numbers = nullptr);
// Property-only codecs preserve business strings, including U+0000 and U+FEFF.
bool decode_utf8_exact(const char* bytes, uint32_t size, String& string);
bool parse_properties_request(const char* request, uint32_t size, Dictionary& parsed, std::vector<double>& numbers);
// Shared bounded request and result codecs for runtime scripting operations.
Dictionary frame();
Dictionary maximum_frame();
CharString stringify(const Variant& value);
int json_size(const Variant& value);
bool scalar_type(Variant::Type type);
String wire_type(Variant::Type type);
Variant::Type variant_type(const String& type);
bool keys(const Dictionary& object, std::initializer_list<const char*> required, std::initializer_list<const char*> optional = {});
bool valid_name(const Variant& raw, String& name);
bool indexed_number(const Variant& indexed, const std::vector<double>& numbers, double& result);
bool integer(const Variant& indexed, const std::vector<double>& numbers, int minimum, int maximum, int& result);
bool unicode_escapes_valid(const char* data, uint32_t size);
Dictionary typed(const Variant& value);
const char* decode_value(const Variant& raw, const std::vector<double>& numbers, Variant& value);
#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
char* buffer();
uint32_t execute_buffer(uint32_t size, const std::function<CharString(const char*, uint32_t)>& handler);
#endif
}
#endif
