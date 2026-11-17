export const ARTIFACT_SET_MOUNT_PATCH='godotjs-artifact-set-early-mount-v1';
const include='#include "modules/modules_enabled.gen.h" // For mono.';
const includeAfter=include+'\n#ifdef MODULE_GODOTJS_ENABLED\n#include "modules/GodotJS/bridge/jsb_artifact_set.h"\n#endif';
const anchor='\tOS::get_singleton()->_in_editor = editor;\n\tif (globals->setup(project_path, main_pack, false, editor) == OK) {';
const replacement='\tOS::get_singleton()->_in_editor = editor;\n#ifdef MODULE_GODOTJS_ENABLED\n\t// GODOTJS_ARTIFACT_SET_EARLY_MOUNT_V1: before settings, UIDs, autoloads or scenes.\n\tif (jsb::prepare_artifact_set(main_pack) != OK) {\n\t\tOS::get_singleton()->printerr("E_ARTIFACT_SET_MOUNT: invalid pack set; this run must be discarded.\\n");\n\t\tgoto error;\n\t}\n#endif\n\tif (globals->setup(project_path, main_pack, false, editor) == OK) {';
const ownedInclude='#ifdef MODULE_GODOTJS_ENABLED\n#include "modules/GodotJS/bridge/jsb_artifact_set.h"\n#endif';
export function unpatchArtifactSetMount(source){
 if(!source.includes('GODOTJS_ARTIFACT_SET_EARLY_MOUNT_V1')&&!source.includes('bridge/jsb_artifact_set.h'))return source;
 if(source.split(ownedInclude).length!==2||source.split(replacement).length!==2)throw Error('E_ARTIFACT_SET_PATCH: partial patch');
 return source.replace(replacement,anchor).replace('\n'+ownedInclude,'');
}
export function patchArtifactSetMount(source){
 if(typeof source!=='string')throw Error('E_ARTIFACT_SET_PATCH');
 const edits=[[include,includeAfter],[anchor,replacement]];
 if(source.includes('GODOTJS_ARTIFACT_SET_EARLY_MOUNT_V1')){
  if(source.split(ownedInclude).length!==2||source.split(replacement).length!==2)throw Error('E_ARTIFACT_SET_PATCH: partial patch');
  return {code:source,changed:false,patchId:ARTIFACT_SET_MOUNT_PATCH};
 }
 let code=source;for(const [before,after]of edits){if(code.split(before).length!==2)throw Error('E_ARTIFACT_SET_PATCH: unsupported source layout');code=code.replace(before,after);}
 return {code,changed:true,patchId:ARTIFACT_SET_MOUNT_PATCH};
}
export function artifactSetMountBuildProof(patches){
 const record=patches.findLast(item=>item.path==='main/main.cpp'&&item.patchId===ARTIFACT_SET_MOUNT_PATCH);
 if(!record)throw Error('E_ARTIFACT_SET_PATCH: missing build source edge');
 const latest=patches.findLast(item=>item.path===record.path);
 return {artifactSetAbi:1,artifactSetPatch:{abi:1,patchId:ARTIFACT_SET_MOUNT_PATCH,path:record.path,sha256:latest.afterSha256,implementation:record.implementation}};
}
