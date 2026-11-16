"""Backport Godot's existing alpha hash to its GLES3 shader (Godot MIT license).

The hash function comes from the same engine checkout's RD renderer. A varying
carries deformed object coordinates so instancing/movement keep a stable pattern.
Only explicit ALPHA_HASH_USED shaders change. Small canvas targets also need a
level-zero backbuffer for CanvasGroup; the upstream 40px guard skips allocation.
All anchors are checked before write.
"""
from pathlib import Path
import sys
import json

def patched(source: str, helper: str) -> str:
    block = helper.split('#endif // ALPHA_HASH_USED', 1)[0] + '#endif // ALPHA_HASH_USED\n'
    block = block.replace('half', 'float')
    marker = '// GODOTAI_GLES3_ALPHA_HASH_V1\n'
    if marker in source:
        if (marker + block not in source or source.count(marker) != 1 or
                any(token not in source for token in ['out highp vec3 alpha_hash_object_pos;', 'in highp vec3 alpha_hash_object_pos;', 'compute_alpha_hash_threshold(alpha_hash_object_pos, alpha_hash_scale)', 'alpha_hash_object_pos = vertex;'])):
            raise ValueError('Existing Alpha Hash patch differs from this engine source')
        return source
    replacements = [
        ('out highp vec3 vertex_interp;', 'out highp vec3 vertex_interp;\n#ifdef ALPHA_HASH_USED\nout highp vec3 alpha_hash_object_pos;\n#endif'),
        ('in highp vec3 vertex_interp;', 'in highp vec3 vertex_interp;\n#ifdef ALPHA_HASH_USED\nin highp vec3 alpha_hash_object_pos;\n#endif'),
        ('\tgl_PointSize = point_size;', '''#ifdef ALPHA_HASH_USED
#ifdef VERTEX_WORLD_COORDS_USED
    alpha_hash_object_pos = (inverse(model_matrix) * vec4(vertex, 1.0)).xyz;
#else
    alpha_hash_object_pos = vertex;
#endif
#endif
\tgl_PointSize = point_size;'''),
        ('#endif // !USE_SHADOW_TO_OPACITY', '''#endif // !USE_SHADOW_TO_OPACITY
#ifdef ALPHA_HASH_USED
#ifndef USE_SHADOW_TO_OPACITY
    float alpha_hash_threshold = compute_alpha_hash_threshold(alpha_hash_object_pos, alpha_hash_scale);
#ifdef RENDER_MATERIAL
    alpha = alpha < alpha_hash_threshold ? 0.0 : 1.0;
#else
    if (alpha < alpha_hash_threshold) { discard; }
    alpha = 1.0;
#endif
#endif
#endif''')]
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError('Unsupported GLES3 shader layout: ' + before)
        source = source.replace(before, after)
    before, sep, after = source.rpartition('void main() {')
    if not sep or '#CODE : FRAGMENT' not in after:
        raise ValueError('Unsupported fragment main layout')
    return before + marker + block + '\n' + sep + after

def patched_backbuffer(source: str) -> str:
    marker = '// GODOTAI_GLES3_SMALL_CANVAS_BACKBUFFER_V1\n'
    before = '\tif (rt->size.x > 40 && rt->size.y > 40) {'
    after = '\t' + marker + '\tif (rt->size.x > 0 && rt->size.y > 0) {'
    start = source.find('void TextureStorage::_create_render_target_backbuffer(RenderTarget *rt) {')
    end = source.find('void TextureStorage::_clear_render_target(RenderTarget *rt) {', start)
    if start < 0 or end < 0:
        raise ValueError('Unsupported canvas backbuffer layout')
    body = source[start:end]
    if marker in source:
        if after not in body or source.count(marker) != 1 or before in body:
            raise ValueError('Existing small canvas backbuffer patch differs')
        return source
    if body.count(before) != 1 or 'MAX(1, Image::get_image_required_mipmaps' not in body:
        raise ValueError('Unsupported canvas backbuffer allocation guard')
    return source[:start] + body.replace(before, after) + source[end:]

if __name__ == '__main__':
    root = Path(sys.argv[1]); shader = root/'drivers/gles3/shaders/scene.glsl'
    helper = root/'servers/rendering/renderer_rd/shaders/scene_forward_aa_inc.glsl'
    storage = root/'drivers/gles3/storage/texture_storage.cpp'
    source = shader.read_text(); result = patched(source, helper.read_text())
    canvas_source = storage.read_text(); canvas_result = patched_backbuffer(canvas_source)
    if '--json' in sys.argv:
        print(json.dumps({'drivers/gles3/shaders/scene.glsl': result,
                          'drivers/gles3/storage/texture_storage.cpp': canvas_result}))
    else:
        if result != source: shader.write_text(result)
        if canvas_result != canvas_source: storage.write_text(canvas_result)
        print('GLES3 Alpha Hash and small canvas backbuffers: ready')
