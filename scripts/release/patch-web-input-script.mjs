export const INPUT_SCRIPT_PATCH = 'godotjs-web-input-script-v1';
export const INPUT_SCRIPT_REMOVAL_PATCH = 'godotjs-web-input-script-removal-v1';
export const INPUT_SCRIPT_EXPORTS = Object.freeze(['abi', 'buffer', 'stage', 'cancel', 'take']
  .map(name => `_godotjs_input_script_${name}`));
export const INPUT_SCRIPT_WASM_MARKER = '// godotjs-input-script-wasm-sha256:';

const include = '#if defined(WEB_ENABLED) && !defined(THREADS_ENABLED)\n#include "modules/GodotJS/bridge/jsb_runtime_input_script.h"\n#endif';
const guard = source => `#ifdef GODOTJS_INPUT_SCRIPT_ABI\n${source}\n#endif`;
const legacyScenePause = 'void SceneTree::set_pause(bool p_enabled) {';
const legacyScenePauseBlock = `${include}\n${guard('namespace jsb::input_script { void pause(); }')}\n\n${legacyScenePause}`;
const hook = (anchor, code) => [anchor, `${anchor}\n${guard(code)}`];
function sceneAssignment(indent, next, prefix = '', suffix = '') {
  const assignment = `${indent}current_scene = ${next};`;
  const notify = guard(`${indent}jsb::input_script::scene_will_change(current_scene, ${next});`);
  return [prefix + assignment + suffix, prefix + notify + '\n' + assignment + suffix];
}
const bind = original => [original, `#ifdef GODOTJS_INPUT_SCRIPT_ABI\n${original.replace(/&Input::(\w+)/, '&Input::godotjs_$1')}\n#else\n${original}\n#endif`];
const parseInput = '_parse_input_event_impl(const Ref<InputEvent> &p_event, bool p_is_emulated';
const oldParseInput = `${parseInput}, bool p_dispatch`;
const scriptEvent = args => guard(`void Input::godotjs_script_event(const Ref<InputEvent> &event, bool dispatch) {
\t_THREAD_SAFE_METHOD_
\t_parse_input_event_impl(${args});
}`);
const eventParameter = '\tEXTRACT_PARAM_OR_FAIL(p_event, rp_event);';
const earlyKeyTakeover = hook(eventParameter, `\t// Give the incoming key priority before it enters the regular input queue.
\tRef<InputEventKey> key = p_event;
\tif (key.is_valid()) {
\t\tRef<InputEventKey> release = jsb::input_script::take_over_key(*key.ptr());
\t\tif (release.is_valid()) _parse_input_event_impl(release, false, false);
\t}`)[1];
const methods = `bool Input::godotjs_is_action_pressed(const StringName &action, bool exact) const {
\treturn (!exact && jsb::input_script::pressed(action)) || is_action_pressed(action, exact);
}

float Input::godotjs_get_action_strength(const StringName &action, bool exact) const {
\treturn !exact && jsb::input_script::pressed(action) ? 1.0f : get_action_strength(action, exact);
}

float Input::godotjs_get_axis(const StringName &negative, const StringName &positive) const {
\treturn godotjs_get_action_strength(positive, false) - godotjs_get_action_strength(negative, false);
}

void Input::godotjs_action_release(const StringName &action) {
\tjsb::input_script::release(action);
\taction_release(action);
}`;
const exports = `extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_input_script_abi() { return GODOTJS_INPUT_SCRIPT_ABI; }
extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t godotjs_input_script_buffer() { return reinterpret_cast<uintptr_t>(jsb::input_script::buffer()); }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_input_script_stage(uint32_t seq, uint32_t size, uint32_t us) {
\treturn jsb::input_script::stage(seq, size, us);
}
extern "C" EMSCRIPTEN_KEEPALIVE void godotjs_input_script_cancel(uint32_t seq, uint32_t reason) { jsb::input_script::cancel(seq, reason); }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_input_script_take(uint32_t seq) { return jsb::input_script::take(seq); }`;
const linkAnchor = 'sys_env.Depends(build[0], sys_env["JS_LIBS"])';
const bindLinkedWasm = `# Record the exact WASM produced by this link, before wrapping or packaging the JavaScript.
def bind_input_script_wasm(target, source, env):
    from hashlib import sha256
    from pathlib import Path

    javascript, wasm = (Path(node.abspath) for node in target)
    digest = sha256(wasm.read_bytes()).hexdigest()
    with javascript.open("ab") as glue:
        glue.write(("\\n${INPUT_SCRIPT_WASM_MARKER}" + digest + "\\n").encode("ascii"))


sys_env.AddPostAction(build[0], sys_env.Action(bind_input_script_wasm, "Binding Input Script WebAssembly"))

${linkAnchor}`;

const edits = {
  'platform/web/SCsub': [[linkAnchor, bindLinkedWasm]],
  'core/input/input.h': [hook('\tvoid release_pressed_events();', `\tbool godotjs_is_action_pressed(const StringName &, bool) const;
\tfloat godotjs_get_action_strength(const StringName &, bool) const;
\tfloat godotjs_get_axis(const StringName &, const StringName &) const;
\tvoid godotjs_action_release(const StringName &);`),
  ['class Input : public Object {', include + '\n\nclass Input : public Object {'],
  hook('\tvoid flush_buffered_events();', '\tvoid godotjs_script_event(const Ref<InputEvent> &, bool);'),
  [`void ${parseInput});`, `void ${oldParseInput} = true, bool p_scripted = false);`]],
  'core/input/input.cpp': [
    ['void Input::_bind_methods() {', guard(methods) + '\n\nvoid Input::_bind_methods() {'],
    bind('\tClassDB::bind_method(D_METHOD("is_action_pressed", "action", "exact_match"), &Input::is_action_pressed, DEFVAL(false));'),
    bind('\tClassDB::bind_method(D_METHOD("get_action_strength", "action", "exact_match"), &Input::get_action_strength, DEFVAL(false));'),
    bind('\tClassDB::bind_method(D_METHOD("get_axis", "negative_action", "positive_action"), &Input::get_axis);'),
    bind('\tClassDB::bind_method(D_METHOD("action_release", "action"), &Input::action_release);'),
    hook('void Input::release_pressed_events() {', '\tjsb::input_script::reset();'),
    [`void Input::${parseInput}) {`,
      scriptEvent('event, false, dispatch, true') + `\n\nvoid Input::${oldParseInput}, bool p_scripted) {`],
    ['\tif (event_dispatch_function) {\n\t\t_THREAD_SAFE_UNLOCK_\n\t\tevent_dispatch_function(p_event);',
      '\tif (p_dispatch && event_dispatch_function) {\n\t\t_THREAD_SAFE_UNLOCK_\n\t\tevent_dispatch_function(p_event);'],
    ['if (event_dispatch_function && emulate_touch_from_mouse && !p_is_emulated && mb->get_button_index() == MouseButton::LEFT)',
      'if (p_dispatch && event_dispatch_function && emulate_touch_from_mouse && !p_is_emulated && mb->get_button_index() == MouseButton::LEFT)'],
    ['\tRef<InputEventKey> k = p_event;', `\tRef<InputEventKey> k = p_event;
\tRef<InputEvent> scripted_release;
${guard('\tif (!p_scripted && k.is_valid()) scripted_release = jsb::input_script::take_over_key(*k.ptr());')}`],
    ['\t\tconst int event_index = InputMap::get_singleton()->event_get_index(p_event, E.key);',
      `\t\t// Scripted keys have no modifiers. Exact matching on release selects
\t\t// the same binding as the press instead of an earlier modified binding.
\t\tconst bool scripted_key_up = p_scripted && k.is_valid() && !k->is_pressed();
\t\tconst int incoming_index = InputMap::get_singleton()->event_get_index(p_event, E.key, scripted_key_up);
\t\tconst int scripted_index = scripted_release.is_valid() ? InputMap::get_singleton()->event_get_index(scripted_release, E.key, true) : -1;
\t\tconst bool had_scripted_binding = scripted_index >= 0 && scripted_index < int(MAX_EVENT);
\t\tconst bool release_only = incoming_index == -1 && had_scripted_binding;
\t\tconst int event_index = release_only ? scripted_index : incoming_index;
\t\tconst Ref<InputEvent> &action_event = release_only ? scripted_release : p_event;
\t\tif (had_scripted_binding && incoming_index >= 0 && incoming_index < int(MAX_EVENT)) {
\t\t\t// Update both bindings before evaluating the action's pressed state.
\t\t\tActionState::DeviceState &scripted = action_states[E.key].device_states[scripted_release->get_device()];
\t\t\tscripted.pressed[scripted_index] = false;
\t\t\tscripted.strength[scripted_index] = 0.0f;
\t\t\tscripted.raw_strength[scripted_index] = 0.0f;
\t\t}`],
    ...[
      '\t\tint device_id = p_event->get_device();',
      '\t\tbool is_pressed = p_event->is_action_pressed(E.key, true);',
      '\t\tdevice_state.strength[event_index] = p_event->get_action_strength(E.key);',
      '\t\tdevice_state.raw_strength[event_index] = p_event->get_action_raw_strength(E.key);',
      '\t\taction_state.exact = InputMap::get_singleton()->event_is_action(p_event, E.key, true);',
      '\t\t\taction_state.pressed_event_id = p_event->get_instance_id();',
      '\t\t\taction_state.released_event_id = p_event->get_instance_id();',
    ].map(line => [line, line.replace('p_event', 'action_event')]),
  ],
  'scene/main/scene_tree.cpp': [
    ['#include "core/config/project_settings.h"', include + '\n' + guard(`namespace jsb::input_script {
void pause();
void scene_will_change(const Node *current, const Node *next);
}`) + '\n\n#include "core/config/project_settings.h"'],
    hook('\tpaused = p_enabled;', '\tif (p_enabled) jsb::input_script::pause();'),
    hook('\tsuspended = p_enabled;', '\tif (p_enabled) jsb::input_script::pause();'),
    sceneAssignment('\t\t', 'nullptr', '\tif (current_scene == p_node) {\n'),
    sceneAssignment('\t', 'p_scene'),
    sceneAssignment('\t\t', 'pending_new_scene'),
    sceneAssignment('\t\t', 'nullptr', '', '\n\t\tpending_new_scene_id = ObjectID();'),
    sceneAssignment('\t\t', 'nullptr', '\t\tmemdelete(current_scene);\n'),
    sceneAssignment('\t', 'p_current'),
  ],
  'main/main.cpp': [
    ['/* Static members */', include + '\n\n/* Static members */'],
    ['\t\tEngine::get_singleton()->_in_physics = true;\n\t\tEngine::get_singleton()->_physics_frames++;',
      guard('\t\tjsb::input_script::before_physics();') + '\n\t\tEngine::get_singleton()->_in_physics = true;\n\t\tEngine::get_singleton()->_physics_frames++;'],
    ['\t\tEngine::get_singleton()->_in_physics = false;\n\t}',
      '\t\tEngine::get_singleton()->_in_physics = false;\n' + guard('\t\tjsb::input_script::after_physics();') + '\n\t}'],
  ],
  'platform/web/web_main.cpp': [
    ['static bool shutdown_complete = false;', include + '\n\nstatic bool shutdown_complete = false;'],
    ['extern "C" void godot_web_worker_frame_committed() {', guard(exports) + '\nextern "C" void godot_web_worker_frame_committed() {'],
    hook('static bool shutdown_complete = false;',
      'extern "C" EMSCRIPTEN_KEEPALIVE uint32_t godotjs_input_script_devices() { return 1; }'),
    hook('\tworker_in_iteration = true;', '\tjsb::input_script::begin_iteration(worker_iteration);'),
    ['\tEM_ASM({ if (Module[\'godotWorkerEndIteration\'])',
      guard(`\tjsb::input_script::end_iteration(should_exit);
\tEM_ASM({ if (Module['godotInputScriptTerminal']) Module['godotInputScriptTerminal'](); });`) +
      "\n\tEM_ASM({ if (Module['godotWorkerEndIteration'])"],
  ],
};
export const INPUT_SCRIPT_PATHS = Object.freeze(Object.keys(edits));

export function patchInputScript(path, source) {
  for (const [before, after] of edits[path]) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw Error('E_INPUT_SCRIPT_PATCH: ' + path + ' ' + before);
    source = source.replace(before, after);
  }
  return source;
}

export function unpatchInputScript(path, source) {
  for (const [before, after] of [...(edits[path] ?? [])].reverse()) source = source.replace(after, before);
  if (path === 'core/input/input.h')
    source = source.replace(`void ${oldParseInput} = true);`, `void ${parseInput});`);
  if (path === 'core/input/input.cpp')
    source = source.replace(earlyKeyTakeover, eventParameter)
      .replace(scriptEvent('event, false, dispatch') + `\n\nvoid Input::${oldParseInput}) {`, `void Input::${parseInput}) {`);
  // Builds recorded before same-step scene change tracking declared only the pause hook here.
  if (path === 'scene/main/scene_tree.cpp') source = source.replace(legacyScenePauseBlock, legacyScenePause);
  return source;
}
