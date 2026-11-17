#include "jsb_artifact_set.h"

#include "core/crypto/crypto_core.h"
#include "core/io/file_access.h"
#include "core/io/file_access_pack.h"
#include "core/io/json.h"
#include "core/templates/hash_map.h"
#include "core/templates/hash_set.h"

namespace jsb {
namespace {
constexpr uint64_t MAX_PACK_BYTES = 256ULL * 1024 * 1024;
constexpr uint64_t MAX_SET_BYTES = 512ULL * 1024 * 1024;
constexpr int MAX_FILES = 10000;
const char *INDEX_PATH = "res://.godotjs/artifact-set-index.json";
struct Entry { String path; String source; String md5; uint64_t bytes = 0; uint64_t offset = 0; };
struct Pack { String path; String sha256; uint64_t bytes = 0; };

bool digest(const String &p_text) {
    if (p_text.length() != 64) return false;
    for (int i = 0; i < p_text.length(); ++i) if (!((p_text[i] >= '0' && p_text[i] <= '9') || (p_text[i] >= 'a' && p_text[i] <= 'f'))) return false;
    return true;
}
bool integer(const Variant &p_value, uint64_t &r_value, uint64_t p_maximum) {
    if (p_value.get_type() != Variant::INT && p_value.get_type() != Variant::FLOAT) return false;
    const double number = p_value;
    if (!(number >= 0 && number <= double(p_maximum))) return false;
    r_value = uint64_t(number);
    return double(r_value) == number;
}
bool resource_path(const String &p_path) {
    if (!p_path.begins_with("res://") || p_path.length() <= 6 || p_path.strip_edges() != p_path) return false;
    const String name = p_path.substr(6);
    if (name.begins_with("/") || name.contains("\\") || name.contains(":") || name.contains("%") || name.contains("?") || name.contains("#")) return false;
    for (int i = 0; i < name.length(); ++i) if (name[i] < 32 || name[i] == 127) return false;
    for (const String &part : name.split("/", true)) if (part.is_empty() || part == "." || part == "..") return false;
    return true;
}
bool bootstrap_only(const String &p_path) {
    const String path = p_path.to_lower();
    return path == "res://project.godot" || path == "res://project.binary" || path == "res://override.cfg"
        || path == "res://.godot/uid_cache.bin" || path == "res://.godot/global_script_class_cache.cfg"
        || path.begins_with("res://.godotjs/") || path.begins_with("res://.playground/")
        || (path.begins_with("res://.godot/") && !path.begins_with("res://.godot/imported/") && !path.begins_with("res://.godot/exported/")) || path.ends_with("/global_script_class_cache.cfg");
}
Error read_directory(const String &p_filename, const String &p_source, HashMap<String, Entry> &r_union, Vector<Entry> *r_entries = nullptr) {
    Ref<FileAccess> file = FileAccess::open(p_filename, FileAccess::READ);
    if (file.is_null()) return ERR_CANT_OPEN;
    const uint64_t length = file->get_length();
    if (length < 108 || length > MAX_PACK_BYTES || file->get_32() != PACK_HEADER_MAGIC || file->get_32() != 3) return ERR_FILE_CORRUPT;
    file->seek(20);
    if (file->get_32() != 2) return ERR_UNAVAILABLE;
    const uint64_t base = file->get_64(), directory = file->get_64();
    if (base < 104 || directory < base || directory > length - 4) return ERR_FILE_CORRUPT;
    for (int i = 0; i < 16; ++i) if (file->get_32() != 0) return ERR_UNAVAILABLE;
    file->seek(directory);
    const uint32_t count = file->get_32();
    if (count > MAX_FILES || count > (length - directory - 4) / 40) return ERR_FILE_CORRUPT;
    HashSet<String> seen;
    Vector<Entry> ranges;
    for (uint32_t i = 0; i < count; ++i) {
        if (file->get_position() > length - 4) return ERR_FILE_CORRUPT;
        const uint32_t path_length = file->get_32();
        if (!path_length || path_length > 4096 || path_length % 4 || uint64_t(path_length) + 36 > length - file->get_position()) return ERR_FILE_CORRUPT;
        Vector<uint8_t> raw = file->get_buffer(path_length);
        int end = raw.size();
        while (end && raw[end - 1] == 0) --end;
        String path;
        if (path.append_utf8(reinterpret_cast<const char *>(raw.ptr()), end) != OK) return ERR_FILE_CORRUPT;
        path = "res://" + path;
        if (!resource_path(path) || seen.has(path.to_lower())) return ERR_FILE_CORRUPT;
        seen.insert(path.to_lower());
        Entry entry;
        entry.path = path; entry.source = p_source;
        const uint64_t relative = file->get_64(); entry.bytes = file->get_64();
        if (relative > directory - base || entry.bytes > directory - base - relative) return ERR_FILE_CORRUPT;
        entry.offset = base + relative;
        uint8_t expected[16];
        if (file->get_buffer(expected, 16) != 16 || file->get_32() != 0) return ERR_FILE_CORRUPT;
        entry.md5 = String::hex_encode_buffer(expected, 16);
        const uint64_t cursor = file->get_position();
        file->seek(entry.offset);
        Vector<uint8_t> data = file->get_buffer(entry.bytes);
        uint8_t actual[16];
        if (uint64_t(data.size()) != entry.bytes || CryptoCore::md5(data.ptr(), data.size(), actual) != OK || String::hex_encode_buffer(actual, 16) != entry.md5) return ERR_FILE_CORRUPT;
        file->seek(cursor);
        if (p_source != "bootstrap" && bootstrap_only(path)) return ERR_INVALID_DATA;
        ranges.push_back(entry);
        if (r_entries) r_entries->push_back(entry);
        if (path == INDEX_PATH) continue;
        const String key = path.to_lower();
        if (r_union.has(key)) return ERR_ALREADY_EXISTS;
        r_union.insert(key, entry);
    }
    if (file->get_position() != length) return ERR_FILE_CORRUPT;
    struct RangeOrder { bool operator()(const Entry &a, const Entry &b) const { return a.offset == b.offset ? a.bytes < b.bytes : a.offset < b.offset; } };
    ranges.sort_custom<RangeOrder>();
    uint64_t previous = base;
    for (const Entry &entry : ranges) {
        if (entry.bytes && entry.offset < previous) return ERR_FILE_CORRUPT;
        previous = MAX(previous, entry.offset + entry.bytes);
    }
    return OK;
}
}

Error prepare_artifact_set(const String &p_main_pack) {
    if (p_main_pack.is_empty()) return OK;
    PackedData *packed = PackedData::get_singleton();
    if (!packed) return ERR_UNCONFIGURED;
    const Error bootstrap_mount = packed->add_pack(p_main_pack, false, 0);
    if (bootstrap_mount != OK) return bootstrap_mount;
    if (!FileAccess::exists(INDEX_PATH)) return OK; // Existing single-PCK projects.
    Ref<FileAccess> index_file = FileAccess::open(INDEX_PATH, FileAccess::READ);
    if (index_file.is_null() || index_file->get_length() > 8 * 1024 * 1024) return ERR_FILE_CORRUPT;
    const Variant value = JSON::parse_string(index_file->get_as_text());
    if (value.get_type() != Variant::DICTIONARY) return ERR_PARSE_ERROR;
    const Dictionary index = value;
    uint64_t schema = 0;
    if (!integer(index.get("schemaVersion", Variant()), schema, 1) || schema != 1 || index.get("resources", Variant()).get_type() != Variant::ARRAY || index.get("files", Variant()).get_type() != Variant::ARRAY) return ERR_INVALID_DATA;
    const Array resources = index["resources"], files = index["files"];
    if (resources.size() > 128 || files.size() > MAX_FILES) return ERR_OUT_OF_MEMORY;
    HashMap<String, Entry> actual;
    Error error = read_directory(p_main_pack, "bootstrap", actual);
    if (error != OK) return error;
    Vector<Pack> verified;
    HashSet<String> pack_ids;
    uint64_t total = FileAccess::open(p_main_pack, FileAccess::READ)->get_length();
    for (int i = 0; i < resources.size(); ++i) {
        if (resources[i].get_type() != Variant::DICTIONARY) return ERR_INVALID_DATA;
        const Dictionary descriptor = resources[i];
        if (descriptor.size() != 3 || descriptor.get("path", Variant()).get_type() != Variant::STRING || descriptor.get("sha256", Variant()).get_type() != Variant::STRING) return ERR_INVALID_DATA;
        Pack pack; pack.path = descriptor["path"]; pack.sha256 = descriptor["sha256"];
        if (!digest(pack.sha256) || pack.path != "packs/" + pack.sha256 + ".pck" || !integer(descriptor.get("bytes", Variant()), pack.bytes, MAX_PACK_BYTES) || pack.bytes < 108 || pack_ids.has(pack.sha256)) return ERR_INVALID_DATA;
        pack_ids.insert(pack.sha256);
        pack.path = p_main_pack.get_base_dir().path_join(pack.path);
        Ref<FileAccess> resource = FileAccess::open(pack.path, FileAccess::READ);
        if (resource.is_null() || resource->get_length() != pack.bytes || (total += pack.bytes) > MAX_SET_BYTES || FileAccess::get_sha256(pack.path) != pack.sha256) return ERR_FILE_CORRUPT;
        error = read_directory(pack.path, pack.sha256, actual);
        if (error != OK) return error;
        verified.push_back(pack);
    }
    if (actual.size() != uint32_t(files.size())) return ERR_INVALID_DATA;
    HashSet<String> described;
    for (int i = 0; i < files.size(); ++i) {
        if (files[i].get_type() != Variant::DICTIONARY) return ERR_INVALID_DATA;
        const Dictionary row = files[i];
        if (row.size() != 4 || row.get("path", Variant()).get_type() != Variant::STRING || row.get("source", Variant()).get_type() != Variant::STRING || row.get("md5", Variant()).get_type() != Variant::STRING) return ERR_INVALID_DATA;
        const String path = row["path"], key = path.to_lower();
        const Entry *entry = actual.getptr(key);
        uint64_t size = 0;
        if (!entry || described.has(key) || entry->path != path || entry->source != String(row["source"]) || entry->md5 != String(row["md5"]) || !integer(row.get("bytes", Variant()), size, MAX_PACK_BYTES) || entry->bytes != size) return ERR_INVALID_DATA;
        described.insert(key);
    }
    // No project code has run yet. Validate the complete set before mounting
    // any child; later native mount failures still abort Main::setup.
    for (const Pack &pack : verified) {
        error = packed->add_pack(pack.path, false, 0);
        if (error != OK) return error;
    }
    return OK;
}
}
