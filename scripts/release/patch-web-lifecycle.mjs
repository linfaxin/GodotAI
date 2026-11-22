import {patchRuntimePropertiesQuitFile,unpatchRuntimePropertiesQuitFile,RUNTIME_PROPERTIES_QUIT_PATCH} from './patch-runtime-properties-quit.mjs';
/** Godot 4.6.1 owner-thread exit gate. Cleanup runs before Web atexit closes
 * audio, browser services or the filesystem; it never advances business frames. */
import {createHash} from 'node:crypto';

export const WEB_LIFECYCLE_PATCH='godotjs-web-lifecycle-v1';
export const WEB_LIFECYCLE_ABI=1;
export const WEB_LIFECYCLE_PATHS=Object.freeze(['platform/web/web_main.cpp','scene/main/scene_tree.h','scene/main/scene_tree.cpp']);
const hash=source=>createHash('sha256').update(source).digest('hex');
const count=(source,text)=>source.split(text).length-1;

const lifecycleFunctions=`// GODOTJS_WEB_LIFECYCLE_V1: managed exits retain native services until release.
static bool godotjs_exit_released = false;
static bool godotjs_exit_keepalive = false;

extern "C" EMSCRIPTEN_KEEPALIVE void godotjs_release_exit() {
\tgodotjs_exit_released = true;
}

static void godotjs_cleanup_only_callback() {
\t// The callback only schedules/drains registered cleanup. It does not run
\t// SceneTree process/physics or the general deferred business message queue.
\tEM_ASM({
\t\tModule['godotjsNativeCleanupTicks'] = (Module['godotjsNativeCleanupTicks'] || 0) + 1;
\t\tconst callback = Module['godotjsCleanupTick'];
\t\tif (typeof callback === 'function') callback();
\t});
#ifdef MODULE_GODOTJS_ENABLED
\tjsb_web_native_lifecycle_cleanup_tick();
#endif
\t// All JS/native callback stacks above have returned before destruction.
\tSceneTree *tree = SceneTree::get_singleton();
\tif (tree) tree->godotjs_flush_delete_queue();
\tif (!godotjs_exit_released) return;
\temscripten_cancel_main_loop();
\temscripten_set_main_loop(exit_callback, -1, false);
\tif (godotjs_exit_keepalive) {
\t\tgodotjs_exit_keepalive = false;
\t\temscripten_runtime_keepalive_pop();
\t}
\tEM_ASM({ Module['godotjsNativeExitPhase'] = 'native-cleanup'; });
\tgodot_js_os_finish_async(cleanup_after_sync);
}

static bool godotjs_begin_exit() {
\tconst bool managed = EM_ASM_INT({ return typeof Module['godotjsBeginExit'] === 'function' ? 1 : 0; });
\tif (!managed) return false;
\t// Admission closes in native code before any JS cleanup can enqueue work.
#ifdef MODULE_GODOTJS_ENABLED
\tjsb_web_native_lifecycle_begin_exit();
#endif
\tgodotjs_exit_keepalive = true;
\temscripten_runtime_keepalive_push();
\temscripten_set_main_loop(godotjs_cleanup_only_callback, -1, false);
\tEM_ASM({
\t\tModule['godotjsNativeExitPhase'] = 'preparing';
\t\tModule['godotjsBeginExit']();
\t});
\treturn true;
}

`;

// Also composed into the ordinary Worker patch, so one checked transformation
// owns web_main.cpp and repeated whole-patch application remains idempotent.
export const WEB_LIFECYCLE_MAIN_EDITS=Object.freeze([
 ['#include <cstdlib>','#include <cstdlib>\n#include <emscripten/eventloop.h>\n#include "modules/modules_enabled.gen.h"\n#ifdef MODULE_GODOTJS_ENABLED\n#include "modules/GodotJS/bridge/jsb_native_lifecycle.h"\n#endif'],
 ['void main_loop_callback() {',lifecycleFunctions+'void main_loop_callback() {'],
 ['\t\temscripten_cancel_main_loop(); // Cancel current loop and set the cleanup one.','\t\temscripten_cancel_main_loop(); // Cancel current loop and set the cleanup one.\n\t\tif (godotjs_begin_exit()) return;'],
 ['\tgodot_init_profiler();',`\tgodot_init_profiler();
\tgodotjs_exit_released = false;
\tgodotjs_exit_keepalive = false;
\tEM_ASM({
\t\tModule['godotjsLifecycleVersion'] = 1;
\t\tModule['godotjsReleaseExit'] = Module['_godotjs_release_exit'];
\t\tModule['godotjsNativeCleanupTicks'] = 0;
\t\tModule['godotjsNativeExitPhase'] = 'running';
\t\tconst install = globalThis.__godotjsInstallLifecycle;
\t\tif (typeof install === 'function') install(Module);
\t});`],
]);

const layouts={
 'platform/web/web_main.cpp':{sha256:'ad80db0d9bce7e9f46ca02f756f12cf883d279655b317442e1a6f55d70ac293f',edits:WEB_LIFECYCLE_MAIN_EDITS},
 'scene/main/scene_tree.h':{sha256:'04631893652d5b8255ecf78f006b4ea106d3acff904a068053b59047e2387fd3',edits:[
  ['\tvoid queue_delete(RequiredParam<Object> rp_object);','\tvoid queue_delete(RequiredParam<Object> rp_object);\n\n#ifdef WEB_ENABLED\n\t// GODOTJS_WEB_LIFECYCLE_V1: native owner-thread teardown only; not script bound.\n\tvoid godotjs_flush_delete_queue();\n#endif'],
 ]},
 'scene/main/scene_tree.cpp':{sha256:'ff390847c015422bfdb1f4401bc393ddedb1d04f327cc320e298ba700bbd8394',edits:[
  ['void SceneTree::queue_delete(RequiredParam<Object> rp_object) {','#ifdef WEB_ENABLED\n// GODOTJS_WEB_LIFECYCLE_V1: consume only deletions, never deferred business calls.\nvoid SceneTree::godotjs_flush_delete_queue() {\n\t_flush_delete_queue();\n}\n#endif\n\nvoid SceneTree::queue_delete(RequiredParam<Object> rp_object) {'],
 ]},
};

export function patchWebLifecycleFile(path,source){
 const withoutQuit=unpatchRuntimePropertiesQuitFile(path,source);
 if(withoutQuit!==source){
  const result=patchWebLifecycleFile(path,withoutQuit);
  const code=patchRuntimePropertiesQuitFile(path,result.code).code;
  return {...result,code,changed:code!==source};
 }
 const layout=layouts[path];
 if(!layout||typeof source!=='string')throw Error('E_WEB_LIFECYCLE_PATCH_UNSUPPORTED: '+path);
 if(hash(source)!==layout.sha256){
  let original=source;
  for(const [before,after]of [...layout.edits].reverse()){
   if(count(original,after)!==1)throw Error('E_WEB_LIFECYCLE_PATCH_UNSUPPORTED: changed or partial '+path);
   original=original.replace(after,before);
  }
  if(hash(original)!==layout.sha256)throw Error('E_WEB_LIFECYCLE_PATCH_UNSUPPORTED: modified '+path);
  return {code:source,changed:false,patchId:WEB_LIFECYCLE_PATCH};
 }
 let code=source;
 for(const [before,after]of layout.edits){
  if(count(code,before)!==1)throw Error('E_WEB_LIFECYCLE_PATCH_UNSUPPORTED: anchor '+path);
  code=code.replace(before,after);
 }
 return {code,changed:true,patchId:WEB_LIFECYCLE_PATCH};
}

/** Advertise the ability only from the complete, actually applied source set.
 * Ordinary Worker web_main is owned by its composed checked patch. */
export function webLifecycleBuildProof(patches){
 const files={};
 for(const path of WEB_LIFECYCLE_PATHS){
  const expected=path==='platform/web/web_main.cpp'?new Set([WEB_LIFECYCLE_PATCH,'godotjs-web-worker-runtime-v1']):new Set([WEB_LIFECYCLE_PATCH]);
  const record=patches.findLast(item=>item.path===path&&expected.has(item.patchId)),latest=patches.findLast(item=>item.path===path);
  if(!record||!latest||(!expected.has(latest.patchId)&&!(path==='scene/main/scene_tree.cpp'&&latest.patchId==='godotjs-managed-shutdown-queue-v1')&&!(path==='scene/main/scene_tree.h'&&latest.patchId===RUNTIME_PROPERTIES_QUIT_PATCH))||!(/^[a-f0-9]{64}$/).test(latest.afterSha256)||!record.implementation?.sha256)throw Error('E_WEB_LIFECYCLE_PROOF: '+path);
  files[path]={sha256:latest.afterSha256,implementation:record.implementation};
 }
 return {lifecycleAbi:WEB_LIFECYCLE_ABI,lifecyclePatch:{abi:WEB_LIFECYCLE_ABI,patchId:WEB_LIFECYCLE_PATCH,files}};
}
