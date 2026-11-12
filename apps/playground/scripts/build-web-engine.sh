#!/usr/bin/env bash
set -euo pipefail
: "${GODOT_SOURCE:?Set GODOT_SOURCE to the Godot 4.6.1 source directory}"
command -v emcc >/dev/null
command -v scons >/dev/null
task_repo="$(cd "$(dirname "$0")/../../.." && pwd)"
task_profile="${ENGINE_PROFILE:-full-engine-v1}"
task_target="${ENGINE_TARGET:-template_debug}"
task_lto="${ENGINE_LTO:-none}"
task_module_mode="${ENGINE_MODULE_MODE:-baseline}"
task_jobs="${JOBS:-4}"
cd "$task_repo"
task_layout="$(node scripts/test/package-browser-engine-artifact.mjs --paths --repository "$task_repo" \
  --profile "$task_profile" --target "$task_target" --lto "$task_lto" --module-mode "$task_module_mode" --jobs "$task_jobs")"
mapfile -t task_paths <<< "$task_layout"
task_build_dir="${task_paths[0]}"
task_report="${task_paths[2]}"
task_template_out="${task_paths[3]}"
mkdir -p "$(dirname "$task_report")"
task_lock="$task_report.lock"
if ! mkdir "$task_lock"; then
  echo "This engine configuration is already building: $task_lock" >&2
  exit 1
fi
trap 'rmdir "$task_lock"' EXIT
task_build_report="$task_build_dir/bin/godotjs-web-build-report-$$.json"
# Set this only after building and freezing shared SDK inputs for a build matrix.
if [ "${SKIP_ENGINE_JS_BUILD:-0}" != 1 ]; then pnpm build:engine-js; fi
node scripts/test/build-browser-engine.mjs \
  --godot-source "$GODOT_SOURCE" --build-dir "$task_build_dir" \
  --out "$task_build_report" --profile "$task_profile" --target "$task_target" \
  --lto "$task_lto" --module-mode "$task_module_mode" --jobs "$task_jobs"
task_development=()
if [ "${ENGINE_DEVELOPMENT:-0}" = 1 ]; then task_development+=(--development); fi
node scripts/test/package-browser-engine-artifact.mjs --report "$task_build_report" \
  --publish "$task_report" --template-out "$task_template_out" "${task_development[@]}"
echo "Engine template: $task_template_out"
echo "Engine report: $task_report"
