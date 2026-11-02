#include "jsb_source_map_cache.h"
#include "jsb_path_util.h"
#include "jsb_settings.h"
#include "jsb_format.h"
#include "jsb_logger.h"

#include <climits>

namespace jsb::internal
{
    namespace
    {
        bool stack_coordinate(const String& p_value, int& r_coordinate)
        {
            // Avoid overflowing String::to_int() on a hostile stack frame.
            if (p_value.is_empty() || p_value.length() > 10) return false;
            const int64_t value = p_value.to_int();
            if (value <= 0 || value > INT_MAX) return false;
            r_coordinate = (int) value;
            return true;
        }

        String source_map_key(const String& p_filename)
        {
            String key = p_filename.simplify_path();
            if (ProjectSettings::get_singleton() && !key.contains("://") && key.is_absolute_path())
            {
                key = ProjectSettings::get_singleton()->localize_path(key);
            }
            return key;
        }
    }

    bool SourceMapCache::parse_stack_frame(const String& p_line, SourcePosition& r_position)
    {
        r_position = SourcePosition();
        if (source_map_match1_.is_null())
            source_map_match1_ = RegEx::create_from_string(R"(^\s*at\s+(.+?)\s+\((.+\.(?:js|cjs|mjs)):(\d+)(?::(\d+))?\)\s*$)");
        if (source_map_match2_.is_null())
            source_map_match2_ = RegEx::create_from_string(R"(^\s*at\s+(.+\.(?:js|cjs|mjs)):(\d+)(?::(\d+))?\s*$)");
        if (source_map_match3_.is_null())
            source_map_match3_ = RegEx::create_from_string(R"(^\s*(.*?)@(.+\.(?:js|cjs|mjs)):(\d+)(?::(\d+))?\s*$)");

        Ref<RegExMatch> match = source_map_match1_->search(p_line);
        int file_group = 2;
        if (!match.is_valid())
        {
            match = source_map_match2_->search(p_line);
            file_group = 1;
        }
        if (!match.is_valid())
        {
            match = source_map_match3_->search(p_line);
            file_group = 2;
        }
        if (!match.is_valid()) return false;

        SourcePosition parsed;
        if (file_group == 2) parsed.function = match->get_string(1);
        parsed.filename = match->get_string(file_group);
        if (!stack_coordinate(match->get_string(file_group + 1), parsed.line)) return false;
        const String column = match->get_string(file_group + 2);
        if (!column.is_empty() && !stack_coordinate(column, parsed.column)) return false;
        r_position = parsed;
        return true;
    }

    String SourceMapCache::resolve_source_path(const String& p_generated_file, const String& p_source_root, const String& p_source)
    {
        const String source = p_source.replace("\\", "/");
        const String root = p_source_root.replace("\\", "/");
        if (PathUtil::is_absolute_path(source) || source.is_absolute_path()) return source.simplify_path();
        const String base = PathUtil::is_absolute_path(root) || root.is_absolute_path()
            ? root : p_generated_file.replace("\\", "/").get_base_dir().path_join(root);
        return base.path_join(source).simplify_path();
    }

    bool SourceMapCache::map_source_position(const SourcePosition& p_generated, const SourceMap& p_map, SourcePosition& r_original)
    {
        if (p_generated.line <= 0 || p_generated.column < 0) return false;
        IndexedSourcePosition position;
        const bool mapped = p_generated.column > 0
            ? p_map.find(p_generated.line - 1, p_generated.column - 1, position)
            : p_map.find_line(p_generated.line - 1, position);
        if (!mapped || !p_map.has_source(position.index) || position.line == INT_MAX
            || (p_generated.column > 0 && position.column == INT_MAX)) return false;
        const String& source = p_map.get_source(position.index);
        if (source.is_empty()) return false;

        SourcePosition original;
        original.function = p_generated.function;
        original.filename = resolve_source_path(p_generated.filename, p_map.get_source_root(), source);
        original.line = position.line + 1;
        original.column = p_generated.column > 0 ? position.column + 1 : 0;
        r_original = original;
        return true;
    }

    String SourceMapCache::process_source_position(const String& p_stacktrace, SourcePosition* r_position)
    {
        if (r_position) *r_position = SourcePosition();
        if (p_stacktrace.is_empty()) return p_stacktrace;
#if JSB_WITH_SOURCEMAP
        const bool enabled = Settings::get_sourcemap_enabled();
#else
        const bool enabled = false;
#endif
        bool have_original = false;
        bool have_raw = false;
        SourcePosition first_raw;
        Vector<String> lines = p_stacktrace.split("\n");
        for (String& line : lines)
        {
            SourcePosition generated;
            if (!parse_stack_frame(line, generated)) continue;
            if (!have_raw)
            {
                first_raw = generated;
                have_raw = true;
            }
            if (!enabled) continue;
            const SourceMap* map = find_source_map(generated.filename);
            SourcePosition original;
            if (!map || !map_source_position(generated, *map, original)) continue;

            // Older GodotJS project presets put project-relative sources next
            // to a fixed ../../../ sourceRoot. Keep this narrow compatibility
            // path only when standard URL resolution does not name a file.
            const String& root = map->get_source_root();
            if (!FileAccess::exists(original.filename) && root == "../../../"
                && source_map_key(generated.filename).begins_with(Settings::get_jsb_out_res_path().trim_suffix("/") + "/"))
            {
                IndexedSourcePosition index;
                const bool found = generated.column > 0
                    ? map->find(generated.line - 1, generated.column - 1, index)
                    : map->find_line(generated.line - 1, index);
                if (found && map->has_source(index.index))
                {
                    const String candidate = String("res://").path_join(map->get_source(index.index)).simplify_path();
                    if (FileAccess::exists(candidate)) original.filename = candidate;
                }
            }

            if (!original.filename.contains("://") || original.filename.begins_with("res://")
                || original.filename.begins_with("user://"))
                original.filename = PathUtil::to_platform_specific_path(original.filename);

            const String location = original.column > 0
                ? jsb_format("%s:%d:%d", original.filename, original.line, original.column)
                : jsb_format("%s:%d", original.filename, original.line);
            line = original.function.is_empty() ? jsb_format("    at %s", location)
                : jsb_format("    at %s (%s)", original.function, location);
            if (!have_original && r_position)
            {
                *r_position = original;
                have_original = true;
            }
        }
        if (!have_original && have_raw && r_position) *r_position = first_raw;
        if (!enabled) return p_stacktrace;

        String result;
        for (int i = 0; i < lines.size(); ++i)
        {
            if (i == 0 && lines[i] == "Error") continue;
            if (!result.is_empty()) result += "\n";
            result += lines[i];
        }
        return result;
    }

    void SourceMapCache::invalidate(const String& p_filename)
    {
        if (cached_source_maps_.erase(source_map_key(p_filename)))
            JSB_LOG(Verbose, "invalidating source map cache of file %s", p_filename);
    }

    void SourceMapCache::clear()
    {
        source_map_match1_.unref();
        source_map_match2_.unref();
        source_map_match3_.unref();
        cached_source_maps_.clear();
    }

    SourceMap* SourceMapCache::find_source_map(const String& p_filename)
    {
        const String key = source_map_key(p_filename);
        HashMap<String, SourceMap>::Iterator existing = cached_source_maps_.find(key);
        if (existing != cached_source_maps_.end()) return &existing->value;
        const String filename = key + ".map";
        if (!FileAccess::exists(filename)) return nullptr;
        SourceMap parsed;
        if (!parsed.parse(FileAccess::get_file_as_string(filename))) return nullptr;
        return &cached_source_maps_.insert(key, parsed)->value;
    }
}
