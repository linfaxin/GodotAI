/** Native Godot owner-loop exit preparation. Web keeps its Emscripten gate. */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const NATIVE_LIFECYCLE_PATCH='godotjs-native-lifecycle-v1';
export const NATIVE_LIFECYCLE_PATHS=Object.freeze(['main/main.cpp','scene/main/scene_tree.h','scene/main/scene_tree.cpp']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const marker='GODOTJS_NATIVE_LIFECYCLE_V1';
const reject=detail=>{throw Error('E_NATIVE_LIFECYCLE_PATCH_UNSUPPORTED: '+detail);};
const occurrences=(source,value)=>source.split(value).length-1;
function replaceOne(source,before,after){if(occurrences(source,before)!==1)reject('anchor '+before.slice(0,70));return source.replace(before,after);}
const condition='#if defined(MODULE_GODOTJS_ENABLED) && !defined(WEB_ENABLED)';
const moduleInclude='#include "modules/modules_enabled.gen.h" // For mono.';
const nativeInclude=`\n\n${condition}\n// ${marker}: the owner loop, never a project callback, advances exit.\n#include "modules/GodotJS/bridge/jsb_native_lifecycle.h"\n#endif`;
const signature='bool Main::iteration() {';
const endSignature='void Main::force_redraw() {';
const originalIterationHash='98d4138c5b0ee1f6e86d9301eebb39ab4cfcbac85e372049b33a46e58fd08264';
const helper=`${condition}\n// ${marker}: retain the main loop until managed cleanup settles.\nstatic bool godotjs_native_finish_iteration(bool wants_exit) {\n\tif (wants_exit && jsb_native_lifecycle_begin_exit()) return false;\n\treturn wants_exit;\n}\n#endif\n\n`;
const entry=`\n${condition}\n\tif (jsb_native_lifecycle_is_closing()) return jsb_native_lifecycle_step();\n#endif`;
const exitBlock=indent=>`${condition}\n${indent}return godotjs_native_finish_iteration(exit);\n#else\n${indent}return exit;\n#endif`;
function iteration(source){const start=source.indexOf(signature),end=source.indexOf(endSignature,start);if(start<0||end<0||occurrences(source,signature)!==1)reject('Main::iteration layout');return {start,end,code:source.slice(start,end)};}
function main(source){
 if(source.includes(marker)){
  if(occurrences(source,nativeInclude)!==1||occurrences(source,helper)!==1||occurrences(source,signature+entry)!==1)reject('partial native exit gate');
  let original=source.replace(nativeInclude,'').replace(helper,'').replace(signature+entry,signature);
  for(const indent of ['\t','\t\t'])original=replaceOne(original,exitBlock(indent),indent+'return exit;');
  if(hash(iteration(original).code)!==originalIterationHash)reject('modified native exit gate');
  return {code:source,changed:false,patchId:NATIVE_LIFECYCLE_PATCH};
 }
 const body=iteration(source);
 if(hash(body.code)!==originalIterationHash)reject('unsupported Main::iteration revision');
 let code=replaceOne(source,moduleInclude,moduleInclude+nativeInclude);
 const updated=body.code.replace(signature,signature+entry).replace(/^(\t+)return exit;$/gm,(_,indent)=>exitBlock(indent));
 if(occurrences(updated,'return godotjs_native_finish_iteration(exit);')!==2)reject('native exit paths');
 code=replaceOne(code,body.code,helper+updated);
 return {code,changed:true,patchId:NATIVE_LIFECYCLE_PATCH};
}
const headerAnchor='\tvoid queue_delete(RequiredParam<Object> rp_object);';
const headerAddition=`\n\n${condition}\n#define GODOTJS_NATIVE_LIFECYCLE_ABI 1\n\t// ${marker}: private owner-thread deletion checkpoint.\n\tvoid godotjs_flush_native_delete_queue();\n#endif`;
const queueSignature='void SceneTree::queue_delete(RequiredParam<Object> rp_object) {';
const flushMethod=`${condition}\n// ${marker}: no process, physics or deferred business message dispatch.\nvoid SceneTree::godotjs_flush_native_delete_queue() {\n\t_flush_delete_queue();\n}\n#endif\n\n`;
function scene(path,source){
 if(path.endsWith('.h')){
  const include='#include "modules/modules_enabled.gen.h"';
  const anchor='#include "scene/main/scene_tree_fti.h"';
  if(source.includes(marker)){
   if(occurrences(source,headerAddition)!==1||occurrences(source,include)!==1)reject('partial SceneTree declaration');
   const original=source.replace(headerAddition,'').replace('\n'+include,'');
   if(scene(path,original).code!==source)reject('modified SceneTree declaration');
   return {code:source,changed:false,patchId:NATIVE_LIFECYCLE_PATCH};
  }
  let code=replaceOne(source,anchor,anchor+'\n'+include);
  code=replaceOne(code,headerAnchor,headerAnchor+headerAddition);
  return {code,changed:true,patchId:NATIVE_LIFECYCLE_PATCH};
 }
 if(source.includes(marker)){
  if(occurrences(source,flushMethod)!==1)reject('partial SceneTree implementation');
  const original=source.replace(flushMethod,'');
  if(scene(path,original).code!==source)reject('modified SceneTree implementation');
  return {code:source,changed:false,patchId:NATIVE_LIFECYCLE_PATCH};
 }
 return {code:replaceOne(source,queueSignature,flushMethod+queueSignature),changed:true,patchId:NATIVE_LIFECYCLE_PATCH};
}
export function patchNativeLifecycleFile(path,source){
 if(!NATIVE_LIFECYCLE_PATHS.includes(path)||typeof source!=='string')reject(path);
 return path==='main/main.cpp'?main(source):scene(path,source);
}
export async function applyNativeLifecyclePatches(root){
 const implementation={path:'scripts/release/patch-native-lifecycle.mjs',sha256:hash(await readFile(fileURLToPath(import.meta.url)))};
 const planned=await Promise.all(NATIVE_LIFECYCLE_PATHS.map(async path=>{
  const before=await readFile(resolve(root,path),'utf8'),result=patchNativeLifecycleFile(path,before);
  return {path,before,result};
 }));
 for(const {path,result}of planned)if(result.changed)await writeFile(resolve(root,path),result.code);
 return planned.map(({path,before,result})=>({path,patchId:result.patchId,beforeSha256:hash(before),afterSha256:hash(result.code),changed:result.changed,implementation}));
}
export function nativeLifecycleBuildProof(records){
 const files=Object.fromEntries(NATIVE_LIFECYCLE_PATHS.map(path=>{
  const record=records.findLast(item=>item.path===path&&item.patchId===NATIVE_LIFECYCLE_PATCH);
  if(!record||!(/^[a-f0-9]{64}$/).test(record.afterSha256))throw Error('E_NATIVE_LIFECYCLE_PROOF: '+path);
  const latest=records.findLast(item=>item.path===path);
  return [path,{sha256:latest.afterSha256,...(record.implementation?{implementation:record.implementation}:{})}];
 }));
 return {nativeLifecycleAbi:1,nativeLifecyclePatch:{abi:1,patchId:NATIVE_LIFECYCLE_PATCH,files}};
}
