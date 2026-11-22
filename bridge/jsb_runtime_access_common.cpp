#include "jsb_runtime_access_common.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/math/math_funcs.h"
#include "core/os/thread.h"
#include "main/main.h"
#include "scene/main/window.h"
#include <cstring>
#include <locale>
#include <sstream>
namespace jsb::runtime_access {
namespace { constexpr int MAX_PATH_BYTES = 2048; constexpr int MAX_PATH_COMPONENTS = 128; }
Dictionary error_reply(const char* code, const char* message) {
    Dictionary error;
    error["code"] = code;
    error["message"] = message;
    Dictionary reply;
    reply["ok"] = false;
    reply["error"] = error;
    return reply;
}

Dictionary success_reply(const Dictionary& result) {
    Dictionary reply;
    reply["ok"] = true;
    reply["result"] = result;
    return reply;
}

bool valid_component(const String& name) {
    if (name.is_empty() || name[0] == '%' || name == "." || name == ".." || name.length() > MAX_PATH_BYTES) return false;
    for (int index = 0; index < name.length(); ++index) {
        const char32_t character = name[index];
        if (character < 0x20 || character == 0x7f || (character >= 0xd800 && character <= 0xdfff) ||
            character == ':' || character == '/') return false;
    }
    return true;
}

bool read_path(const Variant& raw, String& path, Vector<String>& components) {
    if (raw.get_type() != Variant::STRING) return false;
    path = raw;
    if (path.length() < 2 || path.length() > MAX_PATH_BYTES || path[0] != '/' || path.utf8().length() > MAX_PATH_BYTES) return false;
    components = path.substr(1).split("/");
    if (components.size() > MAX_PATH_COMPONENTS) return false;
    for (const String& name : components) if (!valid_component(name)) return false;
    return true;
}

bool read_integer(const Dictionary& request, const char* key, int fallback, int lower, int upper, int& value) {
    const Variant raw = request.get(key, fallback);
    if (raw.get_type() != Variant::INT && raw.get_type() != Variant::FLOAT) return false;
    const double number = raw;
    if (!Math::is_finite(number) || number < lower || number > upper || number != static_cast<int>(number)) return false;
    value = static_cast<int>(number);
    return true;
}

bool is_public_node(const Node* node, const SceneTree* tree) {
    return node && node->is_inside_tree() && node->get_tree() == tree &&
        !node->is_queued_for_deletion() && node->get_internal_mode() == Node::INTERNAL_MODE_DISABLED;
}

Node* find_node(const SceneTree* tree, const Vector<String>& components) {
    Node* node = tree->get_root();
    if (!is_public_node(node, tree)) return nullptr;
    if (components.is_empty()) return node;
    if (node->get_name() != StringName(components[0])) return nullptr;
    for (int index = 1; index < components.size(); ++index) {
        // Resolve a single canonical name. This does not populate the ordered
        // child cache, and checks every ancestor against the public tree scope.
        node = node->get_node_or_null(NodePath(components[index]));
        if (!is_public_node(node, tree)) return nullptr;
    }
    return node;
}

String instance_id(const Node* node) {
    return uitos(static_cast<uint64_t>(node->get_instance_id()));
}

const char* active_scene_error(std::shared_ptr<NativeWorld>& world, const SceneTree*& tree) {
    if (!Thread::is_main_thread() || Main::is_iterating() || NativeWorld::inside_interop()) return "not_ready";
    world = NativeWorld::current();
    if (world && world->is_closing()) return "run_ended";
    const Engine* engine = Engine::get_singleton();
    tree = SceneTree::get_singleton();
    if (!world || !engine || engine->is_in_physics_frame() || !tree || !tree->get_root() || !world->can_commit()) return "not_ready";
    return nullptr;
}

Dictionary coordinates(const Vector2& position) {
    Dictionary value;
    value["x"] = position.x;
    value["y"] = position.y;
    return value;
}

bool read_instance_id(const Variant& raw, String& id) {
    if (raw.get_type() != Variant::STRING) return false;
    id = raw;
    if (id.is_empty() || id.length() > 20 || id[0] == '0') return false;
    for (int index = 0; index < id.length(); ++index) {
        if (id[index] < '0' || id[index] > '9') return false;
    }
    return id.length() < 20 || id <= "18446744073709551615";
}

bool index_json_numbers(const char* request, uint32_t size, std::string& json, std::vector<double>& numbers) {
    const char* end = request + size;
    bool in_string = false;
    for (const char* cursor = request; cursor != end;) {
        const char ch = *cursor++;
        if (ch == '"') in_string = !in_string;
        if (in_string && ch == '\\' && cursor != end) {
            json += ch;
            json += *cursor++;
            continue;
        }
        if (in_string || (ch != '-' && (ch < '0' || ch > '9'))) {
            json += ch;
            continue;
        }

        const char* start = cursor - 1;
        while (cursor != end && std::strchr("0123456789.+-eE", *cursor)) ++cursor;
        if (cursor != end && !std::strchr(" \t\r\n,]}", *cursor)) return false;
        std::istringstream token(std::string(start, cursor));
        token.imbue(std::locale::classic());
        double number;
        if (!(token >> number) || !token.eof()) return false;
        json += std::to_string(numbers.size());
        numbers.push_back(number);
    }
    return true;
}

bool parse_request(const char* request, uint32_t size, Dictionary& parsed, std::vector<double>* numbers) {
    if (!request || size == 0 || size > RUNTIME_OBSERVATION_REQUEST_BYTES || std::memchr(request, 0, size)) return false;
    std::string indexed;
    if (numbers) {
        if (!index_json_numbers(request, size, indexed, *numbers)) return false;
        request = indexed.data();
        size = indexed.size();
    }
    String source;
    JSON parser;
    if (source.append_utf8(request, size) != OK || parser.parse(source) != OK ||
        parser.get_data().get_type() != Variant::DICTIONARY) return false;
    parsed = parser.get_data();
    return true;
}

namespace {
bool utf8_codepoint(const char* bytes, uint32_t size, uint32_t& offset, char32_t& out) {
    if (offset >= size) return false;
    const uint8_t first = static_cast<uint8_t>(bytes[offset++]);
    if (first < 0x80) { out = first; return true; }
    uint32_t value = 0, count = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) { value = first & 0x1f; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { value = first & 0x0f; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { value = first & 0x07; count = 3; minimum = 0x10000; }
    else return false;
    if (count > size - offset) return false;
    while (count--) {
        const uint8_t next = static_cast<uint8_t>(bytes[offset++]);
        if ((next & 0xc0) != 0x80) return false;
        value = (value << 6) | (next & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    out = value;
    return true;
}

bool hex_quad(const char* bytes, uint32_t size, uint32_t& offset, uint32_t& out) {
    if (size - offset < 4) return false;
    out = 0;
    for (int index = 0; index < 4; ++index) {
        const char ch = bytes[offset++];
        const int digit = ch >= '0' && ch <= '9' ? ch - '0'
            : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10
            : ch >= 'A' && ch <= 'F' ? ch - 'A' + 10 : -1;
        if (digit < 0) return false;
        out = (out << 4) | static_cast<uint32_t>(digit);
    }
    return true;
}

bool json_string_token(const char* bytes, uint32_t size, uint32_t& offset, String& out) {
    if (offset >= size || bytes[offset++] != '"') return false;
    Vector<char32_t> characters;
    while (offset < size) {
        const uint8_t ch = static_cast<uint8_t>(bytes[offset]);
        if (ch == '"') {
            ++offset;
            out = String::utf32_unchecked(Span<char32_t>(characters.ptr(), characters.size()));
            return true;
        }
        char32_t value;
        if (ch == '\\') {
            if (++offset >= size) return false;
            switch (bytes[offset++]) {
                case '"': value = '"'; break;
                case '\\': value = '\\'; break;
                case '/': value = '/'; break;
                case 'b': value = 8; break;
                case 'f': value = 12; break;
                case 'n': value = 10; break;
                case 'r': value = 13; break;
                case 't': value = 9; break;
                case 'u': {
                    uint32_t code;
                    if (!hex_quad(bytes, size, offset, code)) return false;
                    if (code >= 0xd800 && code <= 0xdbff) {
                        if (size - offset < 6 || bytes[offset++] != '\\' || bytes[offset++] != 'u') return false;
                        uint32_t low;
                        if (!hex_quad(bytes, size, offset, low) || low < 0xdc00 || low > 0xdfff) return false;
                        code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
                    value = code;
                    break;
                }
                default: return false;
            }
        } else {
            if (ch < 0x20 || !utf8_codepoint(bytes, size, offset, value)) return false;
        }
        characters.push_back(value);
    }
    return false;
}

bool restore_string(const Variant& indexed, const Vector<String>& strings, String& out) {
    if (indexed.get_type() != Variant::STRING) return false;
    const String token = indexed;
    if (token.is_empty() || token.length() > 10) return false;
    uint64_t index = 0;
    for (int offset = 0; offset < token.length(); ++offset) {
        if (token[offset] < '0' || token[offset] > '9') return false;
        index = index * 10 + token[offset] - '0';
    }
    if (index >= static_cast<uint64_t>(strings.size())) return false;
    out = strings[static_cast<int>(index)];
    return true;
}

bool restore_strings(const Variant& indexed, const Vector<String>& strings, Variant& out, int depth = 0) {
    if (depth > 64) return false;
    if (indexed.get_type() == Variant::STRING) {
        String restored;
        if (!restore_string(indexed, strings, restored)) return false;
        out = restored;
    } else if (indexed.get_type() == Variant::ARRAY) {
        const Array source = indexed;
        Array restored;
        for (const Variant& value : source) {
            Variant entry;
            if (!restore_strings(value, strings, entry, depth + 1)) return false;
            restored.push_back(entry);
        }
        out = restored;
    } else if (indexed.get_type() == Variant::DICTIONARY) {
        const Dictionary source = indexed;
        Dictionary restored;
        for (const Variant& key : source.keys()) {
            String name;
            Variant value;
            if (!restore_string(key, strings, name) || restored.has(name)
                || !restore_strings(source[key], strings, value, depth + 1)) return false;
            restored[name] = value;
        }
        out = restored;
    } else out = indexed;
    return true;
}
}

bool decode_utf8_exact(const char* bytes, uint32_t size, String& string) {
    if (!bytes && size != 0) return false;
    Vector<char32_t> characters;
    uint32_t offset = 0;
    while (offset < size) {
        char32_t value;
        if (!utf8_codepoint(bytes, size, offset, value)) return false;
        characters.push_back(value);
    }
    string = String::utf32_unchecked(Span<char32_t>(characters.ptr(), characters.size()));
    return true;
}

bool parse_properties_request(const char* request, uint32_t size, Dictionary& parsed, std::vector<double>& numbers) {
    if (!request || size == 0 || size > RUNTIME_OBSERVATION_REQUEST_BYTES || std::memchr(request, 0, size)) return false;
    std::string indexed;
    Vector<String> strings;
    indexed.reserve(size);
    for (uint32_t offset = 0; offset < size;) {
        if (request[offset] == '"') {
            String token;
            if (!json_string_token(request, size, offset, token)) return false;
            indexed += '"';
            indexed += std::to_string(strings.size());
            indexed += '"';
            strings.push_back(token);
        } else indexed += request[offset++];
    }
    numbers.clear();
    Dictionary structure;
    if (!parse_request(indexed.data(), indexed.size(), structure, &numbers)) return false;
    Variant restored;
    if (!restore_strings(structure, strings, restored)) return false;
    parsed = restored;
    return true;
}
#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
namespace { char shared_buffer[RUNTIME_OBSERVATION_RESULT_BYTES]; bool buffer_in_use = false; }
char* buffer() { return Thread::is_main_thread() && !buffer_in_use ? shared_buffer : nullptr; }
uint32_t execute_buffer(uint32_t size, const std::function<CharString(const char*, uint32_t)>& handler) {
    if (!Thread::is_main_thread() || buffer_in_use) return 0;
    struct Scope { Scope() { buffer_in_use = true; } ~Scope() { buffer_in_use = false; } } scope;
    const CharString result = handler(shared_buffer, size);
    if (result.length() <= 0 || result.length() > int(RUNTIME_OBSERVATION_RESULT_BYTES)) return 0;
    memcpy(shared_buffer, result.get_data(), result.length());
    return result.length();
}
#endif
}
