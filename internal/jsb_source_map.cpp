#include "jsb_source_map.h"

#include <climits>
#include <cstdint>

namespace jsb::internal
{
    namespace
    {
        int base64_value(unsigned char p_character)
        {
            if (p_character >= 'A' && p_character <= 'Z') return p_character - 'A';
            if (p_character >= 'a' && p_character <= 'z') return p_character - 'a' + 26;
            if (p_character >= '0' && p_character <= '9') return p_character - '0' + 52;
            if (p_character == '+') return 62;
            if (p_character == '/') return 63;
            return -1;
        }

        bool add_nonnegative(int p_previous, int p_delta, int& r_result)
        {
            const int64_t result = (int64_t) p_previous + p_delta;
            if (result < 0 || result > INT_MAX) return false;
            r_result = (int) result;
            return true;
        }

        bool decode_vlq(const char*& r_token, const char* p_end, int& r_value)
        {
            uint64_t value = 0;
            unsigned int shift = 0;
            while (r_token < p_end)
            {
                const int digit = base64_value((unsigned char) *r_token++);
                if (digit < 0 || shift > 30) return false;
                value |= (uint64_t) (digit & 31) << shift;
                if (value > UINT32_MAX) return false;
                if ((digit & 32) == 0)
                {
                    const uint64_t magnitude = value >> 1;
                    if (magnitude > INT_MAX) return false;
                    r_value = (value & 1) ? -(int) magnitude : (int) magnitude;
                    return true;
                }
                shift += 5;
            }
            return false;
        }
    }

    void SourceMap::clear()
    {
        source_lines_.clear();
        sources_.clear();
        source_root_ = String();
    }

    bool SourceMap::decode(int p_line, const char* p_token, const char* p_end, DecodeState& r_state)
    {
        int fields[5] = {};
        int count = 0;
        while (p_token < p_end)
        {
            if (count == 5 || !decode_vlq(p_token, p_end, fields[count])) return false;
            ++count;
        }
        if (count != 1 && count != 4 && count != 5) return false;

        DecodeState next = r_state;
        if (!add_nonnegative(next.result_column, fields[0], next.result_column)) return false;

        InternalPosition position;
        position.result_column = next.result_column;
        if (count > 1)
        {
            if (!add_nonnegative(next.source_index, fields[1], next.source_index)
                || !add_nonnegative(next.source_line, fields[2], next.source_line)
                || !add_nonnegative(next.source_column, fields[3], next.source_column)) return false;
            position.source_index = next.source_index;
            position.source_line = next.source_line;
            position.source_column = next.source_column;
            if (count == 5)
            {
                if (!add_nonnegative(next.name_index, fields[4], next.name_index)) return false;
                position.name_index = next.name_index;
            }
        }
        InternalLine& line = (*this)[p_line];
        position.segment_order = line.elements.size();
        if (!line.elements.is_empty() && position.result_column < line.elements[line.elements.size() - 1].result_column)
            line.needs_sort = true;
        line.elements.push_back(position);
        r_state = next;
        return true;
    }

    SourceMap::InternalLine& SourceMap::operator[](int p_line)
    {
        const int size = source_lines_.size();
        if (size == 0 || source_lines_[size - 1].result_line != p_line)
        {
            source_lines_.push_back({ {}, p_line });
            return source_lines_.write[size];
        }
        return source_lines_.write[size - 1];
    }

    bool SourceMap::parse_mappings(const char* p_mappings, size_t p_len)
    {
        clear();
        if (p_len == 0) return true;
        if (!p_mappings || p_len > INT_MAX) return false;

        int line = 0;
        size_t cursor = 0;
        DecodeState state;
        while (cursor < p_len)
        {
            if (p_mappings[cursor] == ';')
            {
                if (line == INT_MAX) { clear(); return false; }
                ++line;
                state.result_column = 0;
                ++cursor;
                continue;
            }

            const size_t start = cursor;
            while (cursor < p_len && p_mappings[cursor] != ',' && p_mappings[cursor] != ';') ++cursor;
            if (start == cursor || !decode(line, p_mappings + start, p_mappings + cursor, state))
            {
                clear();
                return false;
            }
            if (cursor < p_len && p_mappings[cursor] == ',')
            {
                ++cursor;
                if (cursor == p_len || p_mappings[cursor] == ',' || p_mappings[cursor] == ';')
                {
                    clear();
                    return false;
                }
            }
        }
        for (int i = 0; i < source_lines_.size(); ++i)
        {
            InternalLine& current = source_lines_.write[i];
            if (current.needs_sort) current.elements.sort_custom<InternalPositionLess>();
        }
        return true;
    }

    const SourceMap::InternalLine* SourceMap::find_generated_line(int p_line) const
    {
        int begin = 0;
        int end = source_lines_.size();
        while (begin < end)
        {
            const int middle = begin + (end - begin) / 2;
            if (source_lines_[middle].result_line < p_line) begin = middle + 1;
            else end = middle;
        }
        return begin < source_lines_.size() && source_lines_[begin].result_line == p_line
            ? &source_lines_[begin] : nullptr;
    }

    bool SourceMap::find(int p_line, int p_column, IndexedSourcePosition& r_pos) const
    {
        r_pos = IndexedSourcePosition();
        if (p_line < 0 || p_column < 0) return false;
        const InternalLine* line = find_generated_line(p_line);
        if (!line) return false;

        // Upper bound followed by the previous element is greatest lower bound.
        int begin = 0;
        int end = line->elements.size();
        while (begin < end)
        {
            const int middle = begin + (end - begin) / 2;
            if (line->elements[middle].result_column <= p_column) begin = middle + 1;
            else end = middle;
        }
        if (begin == 0) return false;
        const InternalPosition& position = line->elements[begin - 1];
        if (position.source_index < 0) return false;
        r_pos.index = position.source_index;
        r_pos.line = position.source_line;
        r_pos.column = position.source_column;
        return true;
    }

    bool SourceMap::find_line(int p_line, IndexedSourcePosition& r_pos) const
    {
        r_pos = IndexedSourcePosition();
        if (p_line < 0) return false;
        const InternalLine* line = find_generated_line(p_line);
        if (!line || line->elements.is_empty()) return false;
        const InternalPosition& first = line->elements[0];
        if (first.result_column != 0 || first.source_index < 0) return false;
        for (const InternalPosition& position : line->elements)
        {
            if (position.source_index != first.source_index || position.source_line != first.source_line) return false;
        }
        r_pos.index = first.source_index;
        r_pos.line = first.source_line;
        r_pos.column = 0; // The original column is unknown.
        return true;
    }

    bool SourceMap::parse(const String& p_source_map)
    {
        clear();
        Ref<JSON> parser;
        parser.instantiate();
        if (parser->parse(p_source_map) != OK || parser->get_data().get_type() != Variant::DICTIONARY) return false;
        const Dictionary json = parser->get_data();
        const Variant version = json.get("version", Variant());
        if ((version.get_type() != Variant::INT && version.get_type() != Variant::FLOAT)
            || (double) version != 3.0 || json.has("sections")) return false;
        const Variant mappings_value = json.get("mappings", Variant());
        const Variant sources_value = json.get("sources", Variant());
        const Variant root_value = json.get("sourceRoot", Variant());
        const Variant names_value = json.get("names", Variant());
        if (mappings_value.get_type() != Variant::STRING || sources_value.get_type() != Variant::ARRAY
            || (root_value.get_type() != Variant::NIL && root_value.get_type() != Variant::STRING)
            || (names_value.get_type() != Variant::NIL && names_value.get_type() != Variant::ARRAY)) return false;

        const Array sources = sources_value;
        const Array names = names_value.get_type() == Variant::ARRAY ? (Array) names_value : Array();
        Vector<String> parsed_sources;
        for (int i = 0; i < sources.size(); ++i)
        {
            if (sources[i].get_type() != Variant::STRING) return false;
            parsed_sources.push_back(sources[i]);
        }
        for (int i = 0; i < names.size(); ++i)
        {
            if (names[i].get_type() != Variant::STRING) return false;
        }

        const CharString mappings = ((String) mappings_value).utf8();
        if (!parse_mappings(mappings.get_data(), mappings.length())) return false;
        for (const InternalLine& line : source_lines_)
        {
            for (const InternalPosition& position : line.elements)
            {
                if (position.source_index >= parsed_sources.size() || position.name_index >= names.size())
                {
                    clear();
                    return false;
                }
            }
        }
        sources_ = parsed_sources;
        source_root_ = root_value.get_type() == Variant::STRING ? (String) root_value : String();
        return true;
    }

    bool SourceMap::has_source(int p_index) const
    {
        return p_index >= 0 && p_index < sources_.size();
    }

    const String& SourceMap::get_source(int p_index) const
    {
        if (has_source(p_index)) return sources_[p_index];
        static const String empty;
        return empty;
    }

    const String& SourceMap::get_source_root() const
    {
        return source_root_;
    }
}
