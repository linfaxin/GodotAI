/** Pinned Godot 4.6.1 native identity/structure hooks. Hooks publish plain
 * facts; they never invoke JavaScript or retain raw pointers. */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const NATIVE_OBSERVER_PATCH='godotjs-native-observer-v1';
export const NATIVE_OBSERVER_PATHS=Object.freeze(['scene/main/node.h','scene/main/node.cpp','core/object/object.cpp']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const includes='\n#include "modules/modules_enabled.gen.h"\n#ifdef MODULE_GODOTJS_ENABLED\n#include "modules/GodotJS/bridge/jsb_native_hooks.h"\n#endif\n';
const fence=(parent,child)=>`\n#ifdef MODULE_GODOTJS_ENABLED\n\tjsb::NativeMutationScope godotjs_mutation(${parent}, ${child});\n#endif\n`;
const layouts={
 'scene/main/node.h':{sha256:'2dfcad4738af6ff71527b053ce646daec3a4ef7f0ff3b4f7fa8fe24e54dd3ec3',edits:[
  ['#pragma once','#pragma once\n\n// GODOTJS_NATIVE_OBSERVER_V1: matched Node and ObjectDB source hooks.\n#define GODOTJS_NATIVE_OBSERVER_ABI 1'],
 ]},
 'scene/main/node.cpp':{sha256:'925a1e180fd32c4ba7a937a5cf1e9fae46a7deea7ba190e5f32e5d7dccb3d5d1',edits:[
  ['#include "node.compat.inc"','#include "node.compat.inc"'+includes],
  ['void Node::_add_child_nocheck(Node *p_child, const StringName &p_name, InternalMode p_internal_mode) {','void Node::_add_child_nocheck(Node *p_child, const StringName &p_name, InternalMode p_internal_mode) {'+fence('get_instance_id()','p_child->get_instance_id()')],
  ['\tint motion_from = MIN(p_index, child_index);',fence('get_instance_id()','p_child->get_instance_id()')+'\n\tint motion_from = MIN(p_index, child_index);'],
  ['\tERR_FAIL_COND(p_child->data.parent != this);\n\n\t/**','\tERR_FAIL_COND(p_child->data.parent != this);\n'+fence('get_instance_id()','p_child->get_instance_id()')+'\n\t/**'],
 ]},
 'core/object/object.cpp':{sha256:'c30136c7f3b8f2d21870a5c2d497ab97fff1b0b5a9fba136542a718cb3d6241e',edits:[
  ['#include "object.h"','#include "object.h"'+includes],
  ['\tobject_slots[slot].object = nullptr;\n\n\tspin_lock.unlock();','\tobject_slots[slot].object = nullptr;\n\n\tspin_lock.unlock();\n#ifdef MODULE_GODOTJS_ENABLED\n\t// Identity is retired; never call into a registry under ObjectDB spin_lock.\n\tjsb::native_observer_retired(ObjectID(t));\n#endif'],
 ]},
};
export function patchNativeObserverFile(path,source){
 const layout=layouts[path];if(!layout||typeof source!=='string')throw Error('E_NATIVE_OBSERVER_PATCH_UNSUPPORTED: '+path);
 let original=source;
 if(hash(source)!==layout.sha256){
  for(const [before,after]of [...layout.edits].reverse()){
   if(original.split(after).length!==2)throw Error('E_NATIVE_OBSERVER_PATCH_UNSUPPORTED: partial or modified '+path);
   original=original.replace(after,before);
  }
  if(hash(original)!==layout.sha256)throw Error('E_NATIVE_OBSERVER_PATCH_UNSUPPORTED: baseline '+path);
  return {code:source,changed:false,patchId:NATIVE_OBSERVER_PATCH};
 }
 let code=source;for(const [before,after]of layout.edits){if(code.split(before).length!==2)throw Error('E_NATIVE_OBSERVER_PATCH_ANCHOR: '+path);code=code.replace(before,after);}
 return {code,changed:true,patchId:NATIVE_OBSERVER_PATCH};
}
export function nativeObserverBuildProof(records){
 const files={};for(const path of NATIVE_OBSERVER_PATHS){const item=records.findLast(record=>record.path===path&&record.patchId===NATIVE_OBSERVER_PATCH);if(!item||!item.implementation?.sha256||!(/^[a-f0-9]{64}$/).test(item.afterSha256))throw Error('E_NATIVE_OBSERVER_PROOF: '+path);files[path]={sha256:item.afterSha256,implementation:item.implementation};}
 return {observerAbi:1,nativeObserverPatch:{abi:1,patchId:NATIVE_OBSERVER_PATCH,files}};
}
export async function applyNativeObserverPatches(root){
 const implementation={path:'scripts/release/patch-native-observer.mjs',sha256:hash(await readFile(fileURLToPath(import.meta.url)))};
 const planned=await Promise.all(NATIVE_OBSERVER_PATHS.map(async path=>{const before=await readFile(resolve(root,path),'utf8');const result=patchNativeObserverFile(path,before);return {code:result.code,record:{path,patchId:result.patchId,beforeSha256:hash(before),afterSha256:hash(result.code),changed:result.changed,implementation}};}));
 for(const item of planned)if(item.record.changed)await writeFile(resolve(root,item.record.path),item.code);
 return planned.map(item=>item.record);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(!process.argv[2])throw Error('Usage: node patch-native-observer.mjs GODOT_SOURCE');console.log(JSON.stringify(await applyNativeObserverPatches(process.argv[2])));}
