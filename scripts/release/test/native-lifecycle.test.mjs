import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchNativeLifecycleFile,nativeLifecycleBuildProof,NATIVE_LIFECYCLE_PATHS,NATIVE_LIFECYCLE_PATCH} from '../patch-native-lifecycle.mjs';
import {patchArtifactSetMount} from '../patch-artifact-set-mount.mjs';

const fixtures={
 'main/main.cpp':'godot-4.6.1-main-iteration.cpp',
 'scene/main/scene_tree.h':'godot-4.6.1-scene-tree.h',
 'scene/main/scene_tree.cpp':'godot-4.6.1-scene-tree.cpp',
};
const source=path=>readFile(new URL('../../test/fixtures/'+fixtures[path],import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('native exit begins at either Main exit path and drains before business iteration',async()=>{
 const original=await source('main/main.cpp'),first=patchNativeLifecycleFile('main/main.cpp',original);
 assert.equal(patchNativeLifecycleFile('main/main.cpp',first.code).code,first.code);
 assert.equal(first.code.split('return godotjs_native_finish_iteration(exit);').length-1,2);
 assert(first.code.indexOf('jsb_native_lifecycle_is_closing()')<first.code.indexOf('GodotProfileZone("Main::iteration")'));
 assert.match(first.code,/wants_exit && jsb_native_lifecycle_begin_exit\(\)/);
 assert.match(first.code,/#if defined\(MODULE_GODOTJS_ENABLED\) && !defined\(WEB_ENABLED\)/);
 const composed=original.replace('bool Main::iteration() {','// Independent pre-start patch\nbool Main::iteration() {');
 assert.match(patchNativeLifecycleFile('main/main.cpp',composed).code,/Independent pre-start patch/);
 assert.throws(()=>patchNativeLifecycleFile('main/main.cpp',original.replace('iterating++;','iterating += 2;')),/PATCH_UNSUPPORTED/);
 assert.throws(()=>patchNativeLifecycleFile('main/main.cpp',first.code.replace('jsb_native_lifecycle_step()','missing_step()')),/PATCH_UNSUPPORTED/);
});

test('native deletion checkpoint is narrow, source-bound and not script exposed',async()=>{
 for(const path of NATIVE_LIFECYCLE_PATHS.filter(path=>path!=='main/main.cpp')){
  const original=await source(path),first=patchNativeLifecycleFile(path,original);
  assert.equal(patchNativeLifecycleFile(path,first.code).code,first.code);
  if(path.endsWith('.h'))assert.match(first.code,/#define GODOTJS_NATIVE_LIFECYCLE_ABI 1/);
  else {
   const method=first.code.slice(first.code.indexOf('void SceneTree::godotjs_flush_native_delete_queue()'),first.code.indexOf('void SceneTree::queue_delete('));
   assert.match(method,/\{\n\t_flush_delete_queue\(\);\n\}/);
   assert.doesNotMatch(method,/MessageQueue|physics_process|process\(/);
   assert.doesNotMatch(first.code,/D_METHOD\("godotjs_flush_native_delete_queue"/);
  }
  assert.throws(()=>patchNativeLifecycleFile(path,first.code.replace('godotjs_flush_native_delete_queue','broken_delete_queue')),/PATCH_UNSUPPORTED/);
 }
});

test('native exit and pre-settings pack mounting retain independent source edges',async()=>{
 const original=(await source('main/main.cpp')).replace('bool Main::iteration() {','\tOS::get_singleton()->_in_editor = editor;\n\tif (globals->setup(project_path, main_pack, false, editor) == OK) {\n\t}\n\nbool Main::iteration() {');
 for(const nativeFirst of [true,false]){
  const first=nativeFirst?patchNativeLifecycleFile('main/main.cpp',original).code:patchArtifactSetMount(original).code;
  const combined=nativeFirst?patchArtifactSetMount(first).code:patchNativeLifecycleFile('main/main.cpp',first).code;
  assert.equal(patchNativeLifecycleFile('main/main.cpp',combined).code,combined);
  assert.equal(patchArtifactSetMount(combined).code,combined);
 }
});

test('native lifecycle proof requires all actually patched owner-loop inputs',async()=>{
 const records=await Promise.all(NATIVE_LIFECYCLE_PATHS.map(async path=>{
  const patch=patchNativeLifecycleFile(path,await source(path));
  return {path,patchId:NATIVE_LIFECYCLE_PATCH,afterSha256:hash(patch.code)};
 }));
 assert.equal(nativeLifecycleBuildProof(records).nativeLifecycleAbi,1);
 for(const record of records)assert.throws(()=>nativeLifecycleBuildProof(records.filter(value=>value!==record)),/E_NATIVE_LIFECYCLE_PROOF/);
});
