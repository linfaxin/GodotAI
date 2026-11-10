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
node "$task_repo/scripts/release/patch-web-engine.mjs" "$GODOT_SOURCE"
cd "$task_repo"
pnpm build:engine-js
cd "$GODOT_SOURCE"
scons -j"${JOBS:-4}" platform=web target=template_debug \
  threads=no dlink_enabled=no use_closure_compiler=no optimize=speed debug_symbols=no \
  skip_js_runtime=yes use_quickjs_ng=no modules_enabled_by_default=yes \
  module_GodotJS_enabled=yes module_text_server_fb_enabled=yes \
  module_godotai_api_probe_enabled=no tests=no
# Export only the completed archive. Intermediate SDK bin files are never the
# default template selected by the playground pipeline.
task_template_out="${WEB_TEMPLATE_OUT:-$task_repo/work/playground/engine-template/full-engine.zip}"
mkdir -p "$(dirname "$task_template_out")"
cp "$GODOT_SOURCE/bin/godot.web.template_debug.wasm32.nothreads.zip" "$task_template_out.tmp"
mv "$task_template_out.tmp" "$task_template_out"
echo "Full engine template: $task_template_out"
