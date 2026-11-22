/** Non-script-bound Godot 4.6.1 exit-intent observation for property access. */
export const RUNTIME_PROPERTIES_QUIT_PATCH = 'godotjs-runtime-properties-quit-v1';
export const RUNTIME_PROPERTIES_QUIT_PATHS = Object.freeze(['scene/main/scene_tree.h']);
const anchor = '\tvoid quit(int p_exit_code = EXIT_SUCCESS);';
const addition = '\n\n#define GODOTJS_RUNTIME_PROPERTIES_QUIT_ABI 1\n\t// GODOTJS_RUNTIME_PROPERTIES_QUIT_V1: owner-thread observation; not script bound.\n\tbool godotjs_is_quit_requested() const { return _quit; }';
export function unpatchRuntimePropertiesQuitFile(path, source) {
  if (path !== 'scene/main/scene_tree.h') return source;
  if (!source.includes('GODOTJS_RUNTIME_PROPERTIES_QUIT_V1')) return source;
  if (source.split(addition).length !== 2) throw Error('E_RUNTIME_PROPERTIES_QUIT_PATCH: partial or modified accessor');
  return source.replace(addition, '');
}
export function patchRuntimePropertiesQuitFile(path, source) {
  if (!RUNTIME_PROPERTIES_QUIT_PATHS.includes(path) || typeof source !== 'string') throw Error('E_RUNTIME_PROPERTIES_QUIT_PATCH: unsupported source');
  const original = unpatchRuntimePropertiesQuitFile(path, source);
  if (original.split(anchor).length !== 2 || !original.includes('bool _quit = false;')) throw Error('E_RUNTIME_PROPERTIES_QUIT_PATCH: unsupported SceneTree layout');
  const code = original.replace(anchor, anchor + addition);
  return {code, changed: code !== source, patchId: RUNTIME_PROPERTIES_QUIT_PATCH};
}
