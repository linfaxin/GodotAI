#ifndef GODOTJS_TEST_SOURCE_MAP_H
#define GODOTJS_TEST_SOURCE_MAP_H

#include "../internal/jsb_source_map.h"
#include "../internal/jsb_source_map_cache.h"
#include "../internal/jsb_format.h"
#include "tests/test_macros.h"

#include <climits>
#include <cstring>
#include <initializer_list>

namespace jsb::tests::source_maps
{
    inline String vlq(int64_t p_value)
    {
        static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint64_t value = p_value < 0 ? ((uint64_t) -p_value << 1) | 1 : (uint64_t) p_value << 1;
        String result;
        do
        {
            unsigned int digit = value & 31;
            value >>= 5;
            if (value) digit |= 32;
            result += String::chr(alphabet[digit]);
        } while (value);
        return result;
    }

    inline String segment(std::initializer_list<int64_t> p_fields)
    {
        String result;
        for (int64_t field : p_fields) result += vlq(field);
        return result;
    }

    inline bool mappings(internal::SourceMap& r_map, const String& p_mappings)
    {
        const CharString bytes = p_mappings.utf8();
        return r_map.parse_mappings(bytes.get_data(), bytes.length());
    }

    inline String json(const String& p_mappings, const String& p_sources = "[\"App.tsx\"]", const String& p_names = "[]")
    {
        return String("{\"version\":3,\"sourceRoot\":\"res://src\",\"sources\":") + p_sources
            + ",\"names\":" + p_names + ",\"mappings\":\"" + p_mappings + "\"}";
    }

    TEST_CASE("[jsb.source-map] generated and source deltas are cumulative")
    {
        internal::SourceMap map;
        internal::IndexedSourcePosition position;
        REQUIRE(mappings(map, "AAAA,UAAU,UAAU"));
        REQUIRE(map.find(0, 10, position));
        CHECK(position.index == 0);
        CHECK(position.column == 10);
        REQUIRE(map.find(0, 20, position));
        CHECK(position.column == 20);

        REQUIRE(mappings(map, "ACAA,KCAA"));
        REQUIRE(map.find(0, 5, position));
        CHECK(position.index == 2);

        // Valid encoders may emit segments out of generated-column order.
        REQUIRE(mappings(map, segment({10, 0, 0, 10}) + "," + segment({-5, 0, 0, -5})));
        REQUIRE(map.find(0, 8, position));
        CHECK(position.column == 5);
        REQUIRE(map.find(0, 10, position));
        CHECK(position.column == 10);
    }

    TEST_CASE("[jsb.source-map] greatest lower bound and unmapped intervals")
    {
        internal::SourceMap map;
        internal::IndexedSourcePosition position;
        REQUIRE(mappings(map, "AAAA,UAAU"));
        REQUIRE(map.find(0, 8, position));
        CHECK(position.column == 0);
        REQUIRE(map.find(0, 10, position));
        CHECK(position.column == 10);

        REQUIRE(mappings(map, "AAAA,K,KAAU"));
        REQUIRE(map.find(0, 4, position));
        CHECK_FALSE(map.find(0, 5, position));
        CHECK(position.index == -1);
        CHECK_FALSE(map.find(0, 9, position));
        REQUIRE(map.find(0, 10, position));
        CHECK(position.column == 10);

        REQUIRE(mappings(map, "AAAA,A"));
        CHECK_FALSE(map.find(0, 0, position));
    }

    TEST_CASE("[jsb.source-map] line resets preserve signed original deltas")
    {
        internal::SourceMap map;
        internal::IndexedSourcePosition position;
        const String encoded = segment({0, 2, 5, 8, 1}) + "," + segment({10, -1, -2, -5, -1})
            + ";" + segment({4, -1, 4, 6, 1});
        REQUIRE(mappings(map, encoded));
        REQUIRE(map.find(0, 10, position));
        CHECK(position.index == 1);
        CHECK(position.line == 3);
        CHECK(position.column == 3);
        CHECK_FALSE(map.find(1, 3, position));
        REQUIRE(map.find(1, 4, position));
        CHECK(position.index == 0);
        CHECK(position.line == 7);
        CHECK(position.column == 9);
        CHECK_FALSE(map.find(2, 4, position));

        REQUIRE(mappings(map, "AAAA;;AACA"));
        CHECK_FALSE(map.find(1, 0, position));
        REQUIRE(map.find(2, 0, position));
        CHECK(position.line == 1);
    }

    TEST_CASE("[jsb.source-map] malformed VLQ and overflow fail without partial state")
    {
        const char* invalid[] = { "=", "!", "g", "/", "AA", "AAA", "AAAAAA", ",AAAA", "AAAA,", "AAAA,,AAAA", "AAAA,;", "ggggggggA", "///////A" };
        internal::SourceMap map;
        internal::IndexedSourcePosition position;
        for (const char* encoded : invalid)
        {
            REQUIRE(mappings(map, "AAAA"));
            CHECK_FALSE(map.parse_mappings(encoded, std::strlen(encoded)));
            CHECK_FALSE(map.find(0, 0, position));
        }
        CHECK_FALSE(mappings(map, segment({-1, 0, 0, 0})));
        CHECK_FALSE(mappings(map, segment({0, -1, 0, 0})));
        CHECK_FALSE(mappings(map, segment({0, 0, -1, 0})));
        CHECK_FALSE(mappings(map, segment({0, 0, 0, -1})));
        CHECK_FALSE(mappings(map, segment({0, 0, 0, 0, -1})));
        CHECK_FALSE(mappings(map, segment({INT_MIN, 0, 0, 0})));
        CHECK_FALSE(mappings(map, segment({INT_MAX, 0, 0, 0}) + "," + segment({1, 0, 0, 0})));
        CHECK_FALSE(map.parse_mappings(nullptr, 1));
        CHECK_FALSE(map.parse_mappings("A", (size_t) INT_MAX + 1));
        CHECK(map.parse_mappings(nullptr, 0));
        CHECK_FALSE(map.find(-1, 0, position));
        CHECK_FALSE(map.find(0, -1, position));
    }

    TEST_CASE("[jsb.source-map] JSON validation bounds and repeated parse")
    {
        internal::SourceMap map;
        REQUIRE(map.parse(json("AAAA", "[\"Old.tsx\",\"Unused.tsx\"]")));
        CHECK(map.get_source(0) == "Old.tsx");
        REQUIRE(map.parse(json("AAAA")));
        CHECK(map.get_source(0) == "App.tsx");
        CHECK_FALSE(map.has_source(1));
        CHECK(map.get_source(-1).is_empty());
        CHECK(map.get_source(INT_MAX).is_empty());

        const String bad[] = {
            "{", "null", "[]", "{}", "{\"version\":2,\"sources\":[],\"mappings\":\"\"}",
            "{\"version\":3,\"sources\":null,\"mappings\":\"\"}",
            "{\"version\":3,\"sources\":[1],\"mappings\":\"AAAA\"}",
            "{\"version\":3,\"sources\":[],\"mappings\":4}",
            "{\"version\":3,\"sources\":[],\"mappings\":\"\",\"sections\":[]}",
            json("ACAA"), json("AAAAC"), json("AAAA", "[]"), json("AAAA", "[\"App.tsx\"]", "[7]")
        };
        internal::IndexedSourcePosition position;
        for (const String& input : bad)
        {
            REQUIRE(map.parse(json("AAAA")));
            CHECK_FALSE(map.parse(input));
            CHECK_FALSE(map.has_source(0));
            CHECK(map.get_source_root().is_empty());
            CHECK_FALSE(map.find(0, 0, position));
        }
        const String names = segment({0, 0, 0, 0, 1}) + "," + segment({2, 0, 0, 0, 1});
        CHECK_FALSE(map.parse(json(names, "[\"App.tsx\"]", "[\"a\",\"b\"]")));
        CHECK(map.parse(json(names, "[\"App.tsx\"]", "[\"a\",\"b\",\"c\"]")));
        CHECK(map.parse(json("", "[]")));
    }

    TEST_CASE("[jsb.source-map] unknown columns never fabricate a source location")
    {
        internal::SourceMap map;
        internal::IndexedSourcePosition position;
        REQUIRE(mappings(map, "AAAA,UAAU"));
        REQUIRE(map.find_line(0, position));
        CHECK(position.index == 0);
        CHECK(position.line == 0);
        CHECK_FALSE(map.find_line(1, position));
        CHECK_FALSE(map.find_line(-1, position));
        REQUIRE(mappings(map, "AAAA,KCAA"));
        CHECK_FALSE(map.find_line(0, position));
        REQUIRE(mappings(map, "AAAA,KACA"));
        CHECK_FALSE(map.find_line(0, position));
        REQUIRE(mappings(map, "AAAA,K,KAAU"));
        CHECK_FALSE(map.find_line(0, position));
        REQUIRE(mappings(map, "KAAA"));
        CHECK_FALSE(map.find_line(0, position));
    }

    TEST_CASE("[jsb.source-map] stack parsing and one-based diagnostics")
    {
        internal::SourceMapCache cache;
        internal::SourcePosition generated, original;
        internal::SourceMap map;
        REQUIRE(map.parse(json("AAAA,UAAU,UAAU")));
        REQUIRE(cache.parse_stack_frame("    at render (res://generated/App.js:1:11)", generated));
        CHECK(generated.function == "render");
        CHECK(generated.line == 1);
        CHECK(generated.column == 11);
        REQUIRE(internal::SourceMapCache::map_source_position(generated, map, original));
        CHECK(original.filename == "res://src/App.tsx");
        CHECK(original.line == 1);
        CHECK(original.column == 11);

        REQUIRE(cache.parse_stack_frame("    at render (res://generated/App.js:1)", generated));
        CHECK(generated.column == 0);
        REQUIRE(internal::SourceMapCache::map_source_position(generated, map, original));
        CHECK(original.line == 1);
        CHECK(original.column == 0);
        REQUIRE(map.parse(json("AAAA,KACA")));
        CHECK_FALSE(internal::SourceMapCache::map_source_position(generated, map, original));

        REQUIRE(cache.parse_stack_frame("    at C:/build/App.cjs:4:2", generated));
        CHECK(generated.function.is_empty());
        CHECK(generated.filename == "C:/build/App.cjs");
        REQUIRE(cache.parse_stack_frame("render@res://build/App.mjs:2:7", generated));
        CHECK(generated.function == "render");
        CHECK(generated.line == 2);
        CHECK_FALSE(cache.parse_stack_frame("    at render (res://App.js:0:1)", generated));
        CHECK_FALSE(cache.parse_stack_frame("    at render (res://App.js:1:0)", generated));
        CHECK_FALSE(cache.parse_stack_frame("    at render (res://App.js:9999999999999)", generated));
        CHECK_FALSE(cache.parse_stack_frame("Error: res://App.js:1", generated));

        REQUIRE(map.parse(json(segment({0, 0, INT_MAX, 0}))));
        generated.filename = "res://App.js";
        generated.line = generated.column = 1;
        CHECK_FALSE(internal::SourceMapCache::map_source_position(generated, map, original));
        cache.clear();
        REQUIRE(cache.parse_stack_frame("    at res://App.js:2", generated));
        CHECK(generated.line == 2);
    }

    TEST_CASE("[jsb.source-map] source paths resolve relative to the map location")
    {
        using internal::SourceMapCache;
        CHECK(SourceMapCache::resolve_source_path("res://generated/maps/App.js", "../../src", "App.tsx") == "res://src/App.tsx");
        CHECK(SourceMapCache::resolve_source_path("res://generated/App.js", "res://src", "App.tsx") == "res://src/App.tsx");
        CHECK(SourceMapCache::resolve_source_path("res://generated/App.js", "res://src", "res://other/A.tsx") == "res://other/A.tsx");
        CHECK(SourceMapCache::resolve_source_path("C:\\build\\App.js", "../src", "App.tsx") == "C:/src/App.tsx");
        CHECK(SourceMapCache::resolve_source_path("https://host/maps/App.js", "../src", "App.tsx") == "https://host/src/App.tsx");
    }

    TEST_CASE("[jsb.source-map] registered CommonJS wrappers correct only first-line columns")
    {
        internal::SourceMapCache cache;
        internal::SourceMap map;
        internal::SourcePosition generated, original;
        REQUIRE(map.parse(json("AAAA,UAAU,UAAU")));
        constexpr int prefix = sizeof("(function(exports,require,module,__filename,__dirname){") - 1;
        cache.set_first_line_column_offset("res://generated/App.js", prefix);
        REQUIRE(cache.parse_stack_frame(jsb_format("    at render (res://generated/App.js:1:%d)", prefix + 11), generated));
        REQUIRE(cache.remove_module_wrapper_offset(generated));
        CHECK(generated.column == 11);
        REQUIRE(internal::SourceMapCache::map_source_position(generated, map, original));
        CHECK(original.filename == "res://src/App.tsx");
        CHECK(original.column == 11);
        // V8 origins may omit res://; both forms identify the same module.
        generated.filename = "generated/App.js";
        generated.column = prefix + 21;
        REQUIRE(cache.remove_module_wrapper_offset(generated));
        CHECK(generated.column == 21);
        generated.column = prefix;
        CHECK_FALSE(cache.remove_module_wrapper_offset(generated));
        generated.column = 0;
        REQUIRE(cache.remove_module_wrapper_offset(generated));
        CHECK(generated.column == 0);
        generated.line = 2;
        generated.column = 7;
        REQUIRE(cache.remove_module_wrapper_offset(generated));
        CHECK(generated.column == 7);
        cache.clear();
        generated.line = 1;
        generated.column = prefix + 11;
        REQUIRE(cache.remove_module_wrapper_offset(generated));
        CHECK(generated.column == prefix + 11);
    }
}

#endif
