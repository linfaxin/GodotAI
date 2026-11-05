#ifndef GODOTJS_SOURCE_MAP_CACHE_H
#define GODOTJS_SOURCE_MAP_CACHE_H

#include "jsb_internal_pch.h"
#include "jsb_source_map.h"
#include "modules/regex/regex.h"

namespace jsb::internal
{
    struct SourceMapCache
    {
        // try to translate the source positions in stacktrace
        String process_source_position(const String& p_stacktrace, SourcePosition* r_position = nullptr);

        void invalidate(const String& p_filename);

        void clear();

        // Native module evaluators prepend a wrapper on the first source line.
        // Only registered modules receive this correction; raw stack fallbacks
        // and scripts evaluated without a wrapper retain their real coordinates.
        void set_first_line_column_offset(const String& p_filename, int p_columns);
        bool remove_module_wrapper_offset(SourcePosition& r_position) const;

        // Stack coordinates are one-based; column zero is explicitly unknown.
        bool parse_stack_frame(const String& p_line, SourcePosition& r_position);
        static String resolve_source_path(const String& p_generated_file, const String& p_source_root, const String& p_source);
        static bool map_source_position(const SourcePosition& p_generated, const SourceMap& p_map, SourcePosition& r_original);

    private:
        SourceMap* find_source_map(const String& p_filename);

        Ref<RegEx> source_map_match1_;
        Ref<RegEx> source_map_match2_;
        Ref<RegEx> source_map_match3_;
        HashMap<String, SourceMap> cached_source_maps_;
        HashMap<String, int> first_line_column_offsets_;
    };
}

#endif
