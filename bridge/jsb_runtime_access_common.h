#ifndef JSB_RUNTIME_ACCESS_COMMON_H
#define JSB_RUNTIME_ACCESS_COMMON_H
#include "jsb_runtime_observation.h"
#include "jsb_native_world.h"
#include "core/variant/dictionary.h"
#include "core/variant/array.h"
#include "scene/main/scene_tree.h"
#include <functional>
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
#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
char* buffer();
uint32_t execute_buffer(uint32_t size, const std::function<CharString(const char*, uint32_t)>& handler);
#endif
}
#endif
