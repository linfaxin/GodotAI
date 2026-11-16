import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchWebLifecycleFile,webLifecycleBuildProof,WEB_LIFECYCLE_PATHS,WEB_LIFECYCLE_PATCH} from '../patch-web-lifecycle.mjs';
import {patchWorkerRuntimeFile} from '../patch-web-worker-runtime.mjs';

const fixture=path=>new URL(path==='platform/web/web_main.cpp'?'../../jsb.react-browser/test/fixtures/godot-4.6.1-web-main.cpp':'../../test/fixtures/godot-4.6.1-'+path.split('/').at(-1).replace('_','-'),import.meta.url);
const source=path=>readFile(fixture(path),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('the native exit gate composes with both pinned Web execution backends',async()=>{
 for(const dedicated of [false,true]){
  const original=await source('platform/web/web_main.cpp');
  const patch=dedicated?patchWorkerRuntimeFile:patchWebLifecycleFile;
  const first=patch('platform/web/web_main.cpp',original);
  assert.equal(patch('platform/web/web_main.cpp',first.code).code,first.code);
  assert.match(first.code,/godotjs_begin_exit\(\)/);
  assert.match(first.code,/if \(godotjs_begin_exit\(\)\) return;/);
  assert.match(first.code,/globalThis\.__godotjsInstallLifecycle/);
  assert.match(first.code,/Module\['godotjsReleaseExit'\] = Module\['_godotjs_release_exit'\]/);
  const tick=first.code.slice(first.code.indexOf('static void godotjs_cleanup_only_callback()'),first.code.indexOf('static bool godotjs_begin_exit()'));
  assert(tick.indexOf("Module['godotjsCleanupTick']")<tick.indexOf('tree->godotjs_flush_delete_queue()'));
  assert(tick.indexOf('if (!godotjs_exit_released) return;')<tick.indexOf('godot_js_os_finish_async'));
  assert.doesNotMatch(tick,/main_loop_iterate|MessageQueue|physics_process\(/);
  assert.throws(()=>patch('platform/web/web_main.cpp',first.code.replace('godotjs_exit_keepalive = true','godotjs_exit_keepalive = false')),/PATCH_UNSUPPORTED/);
 }
});

test('the narrow native flush uses only SceneTree deletion and is not script bound',async()=>{
 for(const path of ['scene/main/scene_tree.h','scene/main/scene_tree.cpp']){
  const original=await source(path),first=patchWebLifecycleFile(path,original);
  assert.equal(patchWebLifecycleFile(path,first.code).code,first.code);
  assert.match(first.code,/GODOTJS_WEB_LIFECYCLE_V1/);
  assert.throws(()=>patchWebLifecycleFile(path,original+'\n'),/PATCH_UNSUPPORTED/);
  if(path.endsWith('.cpp')){
   assert.match(first.code,/void SceneTree::godotjs_flush_delete_queue\(\) \{\n\t_flush_delete_queue\(\);\n\}/);
   assert.doesNotMatch(first.code,/D_METHOD\("godotjs_flush_delete_queue"/);
  }
 }
});

test('lifecycle capability requires the full source patch closure',async()=>{
 for(const dedicated of [false,true]){
  const patches=[];
  for(const path of WEB_LIFECYCLE_PATHS){
   const original=await source(path),patch=dedicated&&path==='platform/web/web_main.cpp'?patchWorkerRuntimeFile(path,original):patchWebLifecycleFile(path,original);
   patches.push({path,patchId:patch.patchId,afterSha256:hash(patch.code),implementation:{path:patch.patchId===WEB_LIFECYCLE_PATCH?'scripts/release/patch-web-lifecycle.mjs':'scripts/release/patch-web-worker-runtime.mjs',sha256:hash('fixture implementation')}});
  }
  const proof=webLifecycleBuildProof(patches);
  assert.equal(proof.lifecycleAbi,1);assert.equal(proof.lifecyclePatch.abi,1);
  assert.deepEqual(Object.keys(proof.lifecyclePatch.files),WEB_LIFECYCLE_PATHS);
  for(let i=0;i<patches.length;i++)assert.throws(()=>webLifecycleBuildProof(patches.filter((_,index)=>index!==i)),/E_WEB_LIFECYCLE_PROOF/);
 }
});
