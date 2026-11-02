#ifndef GODOTJS_SOURCE_MAP_H
#define GODOTJS_SOURCE_MAP_H
#include "jsb_internal_pch.h"
#include "jsb_macros.h"

namespace jsb::internal
{
    struct IndexedSourcePosition
    {
        int index = -1;
        int line = 0;
        int column = 0;
    };

    struct SourcePosition
    {
        String function;
        String filename;
        // Stack traces and editor diagnostics are one-based. Zero means unknown.
        int line = 0;
        int column = 0;
    };

    struct SourceMap
    {
    private:
        struct InternalPosition
        {
            int result_column = 0;
            int source_index = -1;
            int source_line = 0;
            int source_column = 0;
            int name_index = -1;
            int segment_order = 0;
        };

        struct InternalPositionLess
        {
            bool operator()(const InternalPosition& p_left, const InternalPosition& p_right) const
            {
                return p_left.result_column < p_right.result_column
                    || (p_left.result_column == p_right.result_column && p_left.segment_order < p_right.segment_order);
            }
        };

        struct DecodeState
        {
            int result_column = 0;
            int source_index = 0;
            int source_line = 0;
            int source_column = 0;
            int name_index = 0;
        };

        struct InternalLine
        {
            Vector<InternalPosition> elements;
            int result_line = 0;
            bool needs_sort = false;
        };

        Vector<InternalLine> source_lines_;
        Vector<String> sources_;
        String source_root_;

    public:
        // input string is `mappings` (not the whole json), example: `;;;AAAA,iCAA6B;AAC7B,MAAa,QAAQ;CAAI`
        bool parse_mappings(const char* p_mappings, size_t p_len);

        // parse sourcemap json string
        bool parse(const String& p_source_map);

        // input: js source position [line, column]
        // output: ts source position
        //NOTE line & column are both zero-based
        bool find(int p_line, int p_column, IndexedSourcePosition& r_pos) const;

        // Columnless stacks only map if the whole generated line is unambiguous.
        bool find_line(int p_line, IndexedSourcePosition& r_pos) const;
        bool has_source(int p_index) const;
        const String& get_source_root() const;
        const String& get_source(int index) const;

    private:
        void clear();
        bool decode(int p_line, const char* p_token, const char* p_end, DecodeState& r_state);
        const InternalLine* find_generated_line(int p_line) const;
        InternalLine& operator[](int p_line);
    };
}
#endif
