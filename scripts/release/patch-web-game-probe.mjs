/** Independent, checked patch edges for the optional native GameProbe ABI. */
export const GAME_PROBE_PATCH = 'godotjs-web-game-probe-v1';
export const GAME_PROBE_REMOVAL_PATCH = 'godotjs-web-game-probe-removal-v1';
const include = '#include "modules/GodotJS/bridge/jsb_runtime_game_probe.h"';
const webInclude = '#ifdef WEB_ENABLED\n' + include + '\n#endif';
const exports = `extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_game_probe_abi() { return 1; }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_game_probe_stage(uint32_t size, uint32_t remaining_us) {
\treturn jsb::game_probe::stage(size, remaining_us);
}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_game_probe_take() { return jsb::game_probe::take(); }
extern "C" EMSCRIPTEN_KEEPALIVE void godotjs_game_probe_clear() { jsb::game_probe::clear(); }
`;
const edits = {
  'main/main.cpp': [
    ['/* Static members */', webInclude + '\n\n/* Static members */'],
    ['\t\tRenderingServer::get_singleton()->draw(p_present, draw_step); // flush visual commands',
      '\t\tjsb::game_probe::arm_draw();\n\t\tRenderingServer::get_singleton()->draw(p_present, draw_step); // flush visual commands'],
  ],
  'servers/rendering/rendering_server_default.cpp': [
    ['void RenderingServerDefault::draw(bool p_present, double frame_step) {',
      webInclude + '\n\nvoid RenderingServerDefault::draw(bool p_present, double frame_step) {\n#ifdef WEB_ENABLED\n\tjsb::game_probe::DrawScope probe_scope;\n\tconst bool probe_draw = jsb::game_probe::take_draw();\n#endif'],
    ['\t\t_draw(p_present, frame_step);',
      '#ifdef WEB_ENABLED\n\t\tprobe_scope.enable(probe_draw);\n#endif\n\t\t_draw(p_present, frame_step);'],
  ],
  'servers/rendering/renderer_viewport.cpp': [
    ['void RendererViewport::draw_viewports(bool p_swap_buffers) {',
      webInclude + '\n\nvoid RendererViewport::draw_viewports(bool p_swap_buffers) {'],
    ['\t\t\t// render standard mono camera\n\t\t\t_draw_viewport(vp);',
      '\t\t\t// render standard mono camera\n\t\t\t_draw_viewport(vp);\n#ifdef WEB_ENABLED\n\t\t\tif (vp->viewport_render_direct_to_screen && vp->viewport_to_screen == DisplayServer::MAIN_WINDOW_ID && RSG::rasterizer->is_low_end()) {\n\t\t\t\tjsb::game_probe::reject_direct_to_screen(vp->self);\n\t\t\t}\n#endif'],
    ['\t\t\t\t\tRSG::rasterizer->blit_render_targets_to_screen(vp->viewport_to_screen, &blit, 1);',
      '#ifdef WEB_ENABLED\n\t\t\t\t\tjsb::game_probe::ViewportScope probe_scope(vp->self, vp->viewport_to_screen == DisplayServer::MAIN_WINDOW_ID);\n#endif\n\t\t\t\t\tRSG::rasterizer->blit_render_targets_to_screen(vp->viewport_to_screen, &blit, 1);'],
  ],
  'drivers/gles3/rasterizer_gles3.cpp': [
    ['void RasterizerGLES3::_blit_render_target_to_screen(',
      webInclude + '\n\nvoid RasterizerGLES3::_blit_render_target_to_screen('],
    ['\tglBindTexture(GL_TEXTURE_2D, 0);\n}\n\n// is this p_screen useless',
      '\tglBindTexture(GL_TEXTURE_2D, 0);\n#ifdef WEB_ENABLED\n\tjsb::game_probe::complete_blit();\n#endif\n}\n\n// is this p_screen useless'],
  ],
  'platform/web/display_server_web.cpp': [
    ['extern "C" void godot_web_worker_frame_committed();', 'extern "C" void godot_web_worker_frame_committed(bool own_context);'],
    ['godot_web_worker_frame_committed();', 'godot_web_worker_frame_committed(emscripten_webgl_get_current_context() == webgl_ctx);'],
  ],
  'platform/web/web_main.cpp': [
    ['#include <emscripten/eventloop.h>\n#include "servers/audio/audio_server.h"', include + '\n#include <emscripten/eventloop.h>\n#include "servers/audio/audio_server.h"'],
    ['extern "C" void godot_web_worker_frame_committed() {', exports + 'extern "C" void godot_web_worker_frame_committed(bool own_context) {'],
    ['\tworker_commit_serial++;', '\tworker_commit_serial++;\n\tjsb::game_probe::commit(worker_iteration, worker_commit_serial, own_context);'],
    ['\tworker_in_iteration = true;', '\tworker_in_iteration = true;\n\tjsb::game_probe::begin_iteration();'],
    ['\tworker_in_iteration = false;', '\tworker_in_iteration = false;\n\tjsb::game_probe::end_iteration(worker_iteration, should_exit);'],
  ],
};
export const GAME_PROBE_PATHS = Object.freeze(Object.keys(edits));

export function patchGameProbe(path, source) {
  const changes = edits[path];
  if (!changes) throw Error('E_GAME_PROBE_PATCH_PATH: ' + path);
  for (const [before, after, count = 1] of changes) {
    if (source.split(after).length - 1 === count) continue;
    const occurrences = source.split(before).length - 1;
    if (occurrences !== count) throw Error('E_GAME_PROBE_PATCH: ' + path + ' ' + before);
    source = source.replaceAll(before, after);
  }
  return source;
}

export function unpatchGameProbe(path, source) {
  for (const [before, after] of [...(edits[path] ?? [])].reverse()) source = source.replaceAll(after, before);
  return source;
}
