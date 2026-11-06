#!/usr/bin/env bash
set -euo pipefail
# Use Godot 4.6.1 source with this checkout mounted at modules/GodotJS.
: "${GODOT_SOURCE:?Set GODOT_SOURCE to the Godot 4.6.1 source directory}"
command -v emcc >/dev/null
command -v scons >/dev/null
task_repo="$(cd "$(dirname "$0")/../../.." && pwd)"
if [ "$(realpath "$GODOT_SOURCE/modules/GodotJS/bridge")" != "$task_repo/bridge" ]; then
  echo "GODOT_SOURCE/modules/GodotJS must reference this checkout" >&2
  exit 1
fi
cd "$task_repo"
pnpm build:engine-js
cd "$GODOT_SOURCE"
scons -j"${JOBS:-4}" platform=web target=template_debug \
  threads=no dlink_enabled=no use_closure_compiler=no optimize=speed debug_symbols=no \
  skip_js_runtime=yes modules_enabled_by_default=no module_GodotJS_enabled=yes \
  module_regex_enabled=yes module_gdscript_enabled=yes module_freetype_enabled=yes \
  module_svg_enabled=yes module_text_server_fb_enabled=yes module_gltf_enabled=yes \
  module_ogg_enabled=yes module_vorbis_enabled=yes \
  module_godot_physics_2d_enabled=yes module_godot_physics_3d_enabled=yes
echo "Template: $GODOT_SOURCE/bin/godot.web.template_debug.wasm32.nothreads.zip"
