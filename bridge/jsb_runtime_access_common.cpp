#include "jsb_runtime_access_common.h"
#include "core/config/engine.h"
#include "core/io/json.h"
#include "core/math/math_funcs.h"
#include "core/os/thread.h"
#include "main/main.h"
#include "scene/main/window.h"
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <locale.h>
#if defined(__APPLE__)
#include <xlocale.h>
#endif
namespace jsb::runtime_access {
namespace {
constexpr int MAX_PATH_BYTES = 2048;
constexpr int MAX_PATH_COMPONENTS = 128;

struct JsonNumberLocale {
#ifdef WINDOWS_ENABLED
    const _locale_t value = _create_locale(LC_NUMERIC, "C");
    ~JsonNumberLocale() { if (value) _free_locale(value); }
    double parse(const char* text, char** end) const { return _strtod_l(text, end, value); }
#else
    const locale_t value = newlocale(LC_NUMERIC_MASK, "C", nullptr);
    ~JsonNumberLocale() { if (value) freelocale(value); }
    double parse(const char* text, char** end) const { return strtod_l(text, end, value); }
#endif
};
}
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
    static const JsonNumberLocale locale;
    if (!locale.value) return false;
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
        const std::string token(start, cursor);
        char* parsed_end = nullptr;
        // strtod_l may set ERANGE for a representable subnormal. Reject
        // overflow by checking the result, rather than the range flag.
        const double number = locale.parse(token.c_str(), &parsed_end);
        if (parsed_end != token.c_str() + token.size() || !Math::is_finite(number)) return false;
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
namespace { constexpr double MAX_SAFE_INTEGER = 9007199254740991.0; }
Dictionary frame() {
    Engine* engine = Engine::get_singleton();
    Dictionary result;
    result["process"] = uitos(engine ? engine->get_process_frames() : 0);
    result["physics"] = uitos(engine ? engine->get_physics_frames() : 0);
    result["drawn"] = uitos(engine ? engine->get_frames_drawn() : 0);
    return result;
}
Dictionary maximum_frame() {
    Dictionary result;
    result["process"] = "18446744073709551615";
    result["physics"] = "18446744073709551615";
    result["drawn"] = "18446744073709551615";
    return result;
}
static bool append_json_string(std::string& output, const String& value) {
    static const char hex[] = "0123456789abcdef";
    output += '"';
    for (int index = 0; index < value.length(); ++index) {
        const uint32_t code = value[index];
        if (code < 0x20) {
            output += "\\u00"; output += hex[code >> 4]; output += hex[code & 15];
        } else if (code == '"' || code == '\\') {
            output += '\\'; output += static_cast<char>(code);
        } else if (code < 0x80) output += static_cast<char>(code);
        else if (code < 0x800) {
            output += static_cast<char>(0xc0 | (code >> 6));
            output += static_cast<char>(0x80 | (code & 63));
        } else if (code >= 0xd800 && code <= 0xdfff) return false;
        else if (code < 0x10000) {
            output += static_cast<char>(0xe0 | (code >> 12));
            output += static_cast<char>(0x80 | ((code >> 6) & 63));
            output += static_cast<char>(0x80 | (code & 63));
        } else if (code <= 0x10ffff) {
            output += static_cast<char>(0xf0 | (code >> 18));
            output += static_cast<char>(0x80 | ((code >> 12) & 63));
            output += static_cast<char>(0x80 | ((code >> 6) & 63));
            output += static_cast<char>(0x80 | (code & 63));
        } else return false;
    }
    output += '"';
    return true;
}
static bool append_json(std::string& output, const Variant& value, int depth = 0) {
    if (depth > 64) return false;
    switch (value.get_type()) {
        case Variant::NIL: output += "null"; return true;
        case Variant::BOOL: output += bool(value) ? "true" : "false"; return true;
        case Variant::FLOAT:
            if (const double number = value; number == 0.0 && std::signbit(number)) {
                output += "-0.0";
                return true;
            }
            [[fallthrough]];
        case Variant::INT: {
            const CharString number = JSON::stringify(value, "", false, true).utf8();
            output.append(number.get_data(), number.length()); return true;
        }
        case Variant::STRING: return append_json_string(output, value);
        case Variant::ARRAY: {
            output += '[';
            const Array items = value;
            for (int index = 0; index < items.size(); ++index) {
                if (index) output += ',';
                if (!append_json(output, items[index], depth + 1)) return false;
            }
            output += ']'; return true;
        }
        case Variant::DICTIONARY: {
            output += '{';
            const Dictionary object = value;
            const Array names = object.keys();
            for (int index = 0; index < names.size(); ++index) {
                if (index) output += ',';
                if (names[index].get_type() != Variant::STRING || !append_json_string(output, names[index])) return false;
                output += ':';
                if (!append_json(output, object[names[index]], depth + 1)) return false;
            }
            output += '}'; return true;
        }
        default: return false;
    }
}
CharString stringify(const Variant& value) {
    std::string output;
    if (!append_json(output, value)) return CharString();
    CharString result;
    result.resize_uninitialized(output.size() + 1);
    std::memcpy(result.ptrw(), output.data(), output.size());
    result.ptrw()[output.size()] = 0;
    return result;
}
int json_size(const Variant& value) {
    const CharString bytes = stringify(value);
    return bytes.length() ? bytes.length() : 1000000000;
}
bool scalar_type(Variant::Type type) { return type == Variant::BOOL || type == Variant::INT || type == Variant::FLOAT || type == Variant::STRING; }
String wire_type(Variant::Type type) {
    switch (type) {
        case Variant::BOOL: return "bool";
        case Variant::INT: return "int";
        case Variant::FLOAT: return "float";
        case Variant::STRING: return "string";
        case Variant::VECTOR2: return "vector2";
        default: return String();
    }
}
Variant::Type variant_type(const String& type) {
    if (type == "bool") return Variant::BOOL;
    if (type == "int") return Variant::INT;
    if (type == "float") return Variant::FLOAT;
    if (type == "string") return Variant::STRING;
    if (type == "vector2") return Variant::VECTOR2;
    return Variant::NIL;
}
bool keys(const Dictionary& object, std::initializer_list<const char*> required, std::initializer_list<const char*> optional) {
    for (const char* key : required) if (!object.has(key)) return false;
    for (const Variant& raw : object.keys()) {
        if (raw.get_type() != Variant::STRING) return false;
        const String key = raw;
        bool found = false;
        for (const char* allowed : required) if (key == allowed) found = true;
        for (const char* allowed : optional) if (key == allowed) found = true;
        if (!found) return false;
    }
    return true;
}
bool valid_name(const Variant& raw, String& name) {
    if (raw.get_type() != Variant::STRING) return false;
    name = raw;
    if (name.is_empty() || name.utf8().length() > 256) return false;
    for (int i = 0; i < name.length(); ++i) if (name[i] == 0 || (name[i] >= 0xd800 && name[i] <= 0xdfff)) return false;
    return true;
}
// The structure parser replaces every numeric token with an exact small index.
bool indexed_number(const Variant& indexed, const std::vector<double>& numbers, double& result) {
    if (indexed.get_type() != Variant::INT && indexed.get_type() != Variant::FLOAT) return false;
    const double index = indexed;
    if (index < 0 || index >= numbers.size() || std::floor(index) != index) return false;
    result = numbers[static_cast<size_t>(index)];
    return Math::is_finite(result);
}
bool integer(const Variant& indexed, const std::vector<double>& numbers, int minimum, int maximum, int& result) {
    double value;
    if (!indexed_number(indexed, numbers, value) || std::floor(value) != value || value < minimum || value > maximum) return false;
    result = static_cast<int>(value); return true;
}
bool unicode_escapes_valid(const char* data, uint32_t size) {
    auto hex = [](char ch) -> int { if (ch >= '0' && ch <= '9') return ch - '0'; if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10; if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10; return -1; };
    bool quoted = false;
    for (uint32_t i = 0; i < size; ++i) {
        if (data[i] == '"') { quoted = !quoted; continue; }
        if (!quoted || data[i] != '\\') continue;
        if (++i >= size) return false;
        if (data[i] != 'u') continue;
        if (i + 4 >= size) return false;
        int code = 0;
        for (int n = 0; n < 4; ++n) { const int digit = hex(data[++i]); if (digit < 0) return false; code = code * 16 + digit; }
        if (code >= 0xdc00 && code <= 0xdfff) return false;
        if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 6 >= size || data[i + 1] != '\\' || data[i + 2] != 'u') return false;
            i += 2; int low = 0;
            for (int n = 0; n < 4; ++n) { const int digit = hex(data[++i]); if (digit < 0) return false; low = low * 16 + digit; }
            if (low < 0xdc00 || low > 0xdfff) return false;
        }
    }
    return true;
}
Dictionary typed(const Variant& value) {
    Dictionary result;
    result["type"] = wire_type(value.get_type());
    result["value"] = value.get_type() == Variant::VECTOR2 ? Variant(coordinates(value)) : value;
    return result;
}
const char* decode_value(const Variant& raw, const std::vector<double>& numbers, Variant& value) {
    if (raw.get_type() != Variant::DICTIONARY) return "invalid_input";
    const Dictionary object = raw;
    if (!keys(object, {"type", "value"}) || object["type"].get_type() != Variant::STRING) return "invalid_input";
    const Variant::Type type = variant_type(object["type"]);
    const Variant payload = object["value"];
    if (type == Variant::BOOL) {
        if (payload.get_type() != Variant::BOOL) return "type_mismatch";
        value = payload; return nullptr;
    }
    if (type == Variant::STRING) {
        if (payload.get_type() != Variant::STRING) return "type_mismatch";
        const String text = payload;
        if (text.utf8().length() > 1024) return "out_of_range";
        value = text; return nullptr;
    }
    if (type == Variant::INT || type == Variant::FLOAT) {
        double parsed;
        if (!indexed_number(payload, numbers, parsed)) return "type_mismatch";
        if (type == Variant::INT) {
            if (std::floor(parsed) != parsed || parsed < -MAX_SAFE_INTEGER || parsed > MAX_SAFE_INTEGER) return "out_of_range";
            value = static_cast<int64_t>(parsed);
        } else value = parsed;
        return nullptr;
    }
    if (type == Variant::VECTOR2) {
        if (payload.get_type() != Variant::DICTIONARY) return "type_mismatch";
        const Dictionary position = payload;
        double x, y;
        if (!keys(position, {"x", "y"}) || !indexed_number(position["x"], numbers, x) || !indexed_number(position["y"], numbers, y)) return "type_mismatch";
        const double maximum = std::numeric_limits<real_t>::max();
        if (std::abs(x) > maximum || std::abs(y) > maximum) return "out_of_range";
        value = Vector2(static_cast<real_t>(x), static_cast<real_t>(y));
        return nullptr;
    }
    return "unsupported";
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
