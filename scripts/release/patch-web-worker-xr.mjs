/** Checked Godot 4.6.1 WebXR imports. Legacy Window behavior is preserved. */
import {createHash} from 'node:crypto';
export const WORKER_XR_PATH='modules/webxr/native/library_godot_webxr.js';
export const WORKER_XR_PATHS=Object.freeze([WORKER_XR_PATH]);
const originalHash="ccfbbf5eb50f45fe8fdf36816a2cb9d06509494d336a951bda122eef13baf963";
const edits=[
 [
  "\tgodot_webxr_is_supported: function () {",
  "\tgodot_webxr_is_supported: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.isSupported() ? 1 : 0;\n\t\t}"
 ],
 [
  "\tgodot_webxr_is_session_supported: function (p_session_mode, p_callback) {",
  "\tgodot_webxr_is_session_supported: function (p_session_mode, p_callback) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst mode = GodotRuntime.parseString(p_session_mode), callback = GodotRuntime.get_func(p_callback);\n\t\t\tglobalThis.__godotWorkerXR.isSessionSupported(mode, function (supported) { const value = GodotRuntime.allocString(mode); try { callback(value, supported ? 1 : 0); } finally { GodotRuntime.free(value); } });\n\t\t\treturn;\n\t\t}"
 ],
 [
  "\tgodot_webxr_initialize: function (p_session_mode, p_required_features, p_optional_features, p_requested_reference_spaces, p_on_session_started, p_on_session_ended, p_on_session_failed, p_on_input_event, p_on_simple_event) {",
  "\tgodot_webxr_initialize: function (p_session_mode, p_required_features, p_optional_features, p_requested_reference_spaces, p_on_session_started, p_on_session_ended, p_on_session_failed, p_on_input_event, p_on_simple_event) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tGodotWebXR.monkeyPatchRequestAnimationFrame(true);\n\t\t\tconst split = function (value) { return GodotRuntime.parseString(value).split(',').map(function (item) { return item.trim(); }).filter(Boolean); };\n\t\t\tconst textCall = function (callback, values) { const pointers = values.map(function (value) { return GodotRuntime.allocString(value); }); try { GodotRuntime.get_func(callback).apply(null, pointers); } finally { pointers.forEach(GodotRuntime.free); } };\n\t\t\tconst gl = GL.getContext(_emscripten_webgl_get_current_context()).GLctx;\n\t\t\tglobalThis.__godotWorkerXR.initialize({ mode: GodotRuntime.parseString(p_session_mode), requiredFeatures: split(p_required_features), optionalFeatures: split(p_optional_features), referenceSpaces: split(p_requested_reference_spaces) }, {\n\t\t\t started: function (reference, features, blend) { textCall(p_on_session_started, [reference, features, blend]); },\n\t\t\t ended: function () { GodotRuntime.get_func(p_on_session_ended)(); },\n\t\t\t failed: function (message) { textCall(p_on_session_failed, [message]); },\n\t\t\t input: function (type, id) { GodotRuntime.get_func(p_on_input_event)(type, id); },\n\t\t\t simple: function (name) { textCall(p_on_simple_event, [name]); },\n\t\t\t wakeMainLoop: function () { GodotWebXR.pauseResumeMainLoop(); }\n\t\t\t}, {\n\t\t\t gl: gl,\n\t\t\t registerTexture: function (texture) { return GodotWebXR.getTextureId(texture); },\n\t\t\t releaseTexture: function (id, texture) { if (GL.textures[id] === texture) { GL.textures[id] = null; gl.deleteTexture(texture); } }\n\t\t\t});\n\t\t\treturn;\n\t\t}"
 ],
 [
  "\tgodot_webxr_uninitialize: function () {",
  "\tgodot_webxr_uninitialize: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tglobalThis.__godotWorkerXR.uninitialize();\n\t\t\tGodotWebXR.monkeyPatchRequestAnimationFrame(false);GodotWebXR.pauseResumeMainLoop();return;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_view_count: function () {",
  "\tgodot_webxr_get_view_count: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.getViewCount();\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_render_target_size: function (r_size) {",
  "\tgodot_webxr_get_render_target_size: function (r_size) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst size = globalThis.__godotWorkerXR.getRenderTargetSize(); if (!size) return false;\n\t\t\tGodotRuntime.setHeapValue(r_size, size[0], 'i32'); GodotRuntime.setHeapValue(r_size + 4, size[1], 'i32'); return true;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_transform_for_view: function (p_view, r_transform) {",
  "\tgodot_webxr_get_transform_for_view: function (p_view, r_transform) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst matrix = globalThis.__godotWorkerXR.getTransformForView(p_view); if (!matrix) return false; for (let i = 0; i < 16; i++) GodotRuntime.setHeapValue(r_transform + i * 4, matrix[i], 'float'); return true;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_projection_for_view: function (p_view, r_transform) {",
  "\tgodot_webxr_get_projection_for_view: function (p_view, r_transform) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst matrix = globalThis.__godotWorkerXR.getProjectionForView(p_view); if (!matrix) return false; for (let i = 0; i < 16; i++) GodotRuntime.setHeapValue(r_transform + i * 4, matrix[i], 'float'); return true;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_color_texture: function () {",
  "\tgodot_webxr_get_color_texture: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.getColorTexture();\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_depth_texture: function () {",
  "\tgodot_webxr_get_depth_texture: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.getDepthTexture();\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_velocity_texture: function () {",
  "\tgodot_webxr_get_velocity_texture: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.getVelocityTexture();\n\t\t}"
 ],
 [
  "\tgodot_webxr_update_input_source: function (p_input_source_id, r_target_pose, r_target_ray_mode, r_touch_index, r_has_grip_pose, r_grip_pose, r_has_standard_mapping, r_button_count, r_buttons, r_axes_count, r_axes, r_has_hand_data, r_hand_joints, r_hand_radii) {",
  "\tgodot_webxr_update_input_source: function (p_input_source_id, r_target_pose, r_target_ray_mode, r_touch_index, r_has_grip_pose, r_grip_pose, r_has_standard_mapping, r_button_count, r_buttons, r_axes_count, r_axes, r_has_hand_data, r_hand_joints, r_hand_radii) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst input = globalThis.__godotWorkerXR.getInputSource(p_input_source_id); if (!input) return false;\n\t\t\tfor (let i = 0; i < 16; i++) { GodotRuntime.setHeapValue(r_target_pose + i * 4, input.target[i], 'float'); if (input.grip) GodotRuntime.setHeapValue(r_grip_pose + i * 4, input.grip[i], 'float'); }\n\t\t\tGodotRuntime.setHeapValue(r_target_ray_mode, input.targetRayMode, 'i32'); GodotRuntime.setHeapValue(r_touch_index, input.touchIndex, 'i32'); GodotRuntime.setHeapValue(r_has_grip_pose, input.grip ? 1 : 0, 'i32');\n\t\t\tGodotRuntime.setHeapValue(r_has_standard_mapping, input.standardMapping ? 1 : 0, 'i32'); GodotRuntime.setHeapValue(r_button_count, input.buttons.length, 'i32'); GodotRuntime.setHeapValue(r_axes_count, input.axes.length, 'i32');\n\t\t\tinput.buttons.forEach(function (value, index) { GodotRuntime.setHeapValue(r_buttons + index * 4, value, 'float'); }); input.axes.forEach(function (value, index) { GodotRuntime.setHeapValue(r_axes + index * 4, value, 'float'); });\n\t\t\tconst hand = r_hand_joints !== 0 && r_hand_radii !== 0 && input.handJoints && input.handRadii;\n\t\t\tif (hand) { input.handJoints.forEach(function (value, index) { GodotRuntime.setHeapValue(r_hand_joints + index * 4, value, 'float'); }); input.handRadii.forEach(function (value, index) { GodotRuntime.setHeapValue(r_hand_radii + index * 4, value, 'float'); }); }\n\t\t\tGodotRuntime.setHeapValue(r_has_hand_data, hand ? 1 : 0, 'i32'); return true;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_visibility_state: function () {",
  "\tgodot_webxr_get_visibility_state: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst value = globalThis.__godotWorkerXR.getVisibilityState(); return value ? GodotRuntime.allocString(value) : 0;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_bounds_geometry: function (r_points) {",
  "\tgodot_webxr_get_bounds_geometry: function (r_points) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst points = globalThis.__godotWorkerXR.getBoundsGeometry(); if (!points.length) return 0; const buffer = GodotRuntime.malloc(points.length * 4); points.forEach(function (value, index) { GodotRuntime.setHeapValue(buffer + index * 4, value, 'float'); }); GodotRuntime.setHeapValue(r_points, buffer, 'i32'); return points.length / 3;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_frame_rate: function () {",
  "\tgodot_webxr_get_frame_rate: function () {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\treturn globalThis.__godotWorkerXR.getFrameRate();\n\t\t}"
 ],
 [
  "\tgodot_webxr_update_target_frame_rate: function (p_frame_rate) {",
  "\tgodot_webxr_update_target_frame_rate: function (p_frame_rate) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tglobalThis.__godotWorkerXR.updateTargetFrameRate(p_frame_rate); return;\n\t\t}"
 ],
 [
  "\tgodot_webxr_get_supported_frame_rates: function (r_frame_rates) {",
  "\tgodot_webxr_get_supported_frame_rates: function (r_frame_rates) {\n\t\t// GODOTJS_WORKER_XR_V1: real XRSession remains in its Window owner.\n\t\tif (globalThis.__godotWorkerXR) {\n\t\t\tconst rates = globalThis.__godotWorkerXR.getSupportedFrameRates(); if (!rates.length) return 0; const buffer = GodotRuntime.malloc(rates.length * 4); rates.forEach(function (value, index) { GodotRuntime.setHeapValue(buffer + index * 4, value, 'float'); }); GodotRuntime.setHeapValue(r_frame_rates, buffer, 'i32'); return rates.length;\n\t\t}"
 ],
 [
  "\t\trequestAnimationFrame: (callback) => {",
  "\t\trequestAnimationFrame: (callback) => {\n\t\t\tif (globalThis.__godotWorkerXR && globalThis.__godotWorkerXR.active) { globalThis.__godotWorkerXR.requestAnimationFrame(callback); return; }"
 ]
];
const hash=value=>createHash('sha256').update(value).digest('hex');
const count=(source,value)=>source.split(value).length-1;
export function patchWorkerXR(source){
 if(typeof source!=='string')throw Error('E_WORKER_XR_PATCH_UNSUPPORTED');
 if(hash(source)!==originalHash){let original=source;for(const [before,after]of [...edits].reverse()){if(count(original,after)!==1)throw Error('E_WORKER_XR_PATCH_UNSUPPORTED: changed or partial');original=original.replace(after,before);}if(hash(original)!==originalHash)throw Error('E_WORKER_XR_PATCH_UNSUPPORTED: modified');return {code:source,changed:false};}
 let code=source;for(const [before,after]of edits){if(count(code,before)!==1)throw Error('E_WORKER_XR_PATCH_UNSUPPORTED: anchor');code=code.replace(before,after);}return {code,changed:true};
}
