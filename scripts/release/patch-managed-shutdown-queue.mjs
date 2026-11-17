/** Drop queued business messages after managed cleanup; native deletion remains
 * SceneTree's responsibility. Only the pinned shutdown function bodies change. */
import {createHash} from 'node:crypto';
export const MANAGED_SHUTDOWN_PATCH='godotjs-managed-shutdown-queue-v1';
export const MANAGED_SHUTDOWN_PATHS=['main/main.cpp','scene/main/scene_tree.cpp'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const marker='GODOTJS_MANAGED_SHUTDOWN_QUEUE_V1';
const hooks='\n#ifdef MODULE_GODOTJS_ENABLED\n#include "modules/GodotJS/bridge/jsb_native_hooks.h"\n#endif\n';
const layouts={
 'main/main.cpp':{start:'void Main::cleanup(bool p_force) {',end:null,sha:'25337f61a4f9eeffd8fb69ed3773a4d656a1726469a3542266e41ca7623ea301',anchor:'#include "modules/modules_enabled.gen.h"',include:hooks,
  edits:[
   ['void Main::cleanup(bool p_force) {',`void Main::cleanup(bool p_force) {
\t// ${marker}: latch before module disposal, preserve delete-only retirement.
#ifdef MODULE_GODOTJS_ENABLED
\tconst bool godotjs_managed_cleanup = jsb::native_managed_cleanup_active();
#else
\tconst bool godotjs_managed_cleanup = false;
#endif`],
   ['\tmessage_queue->flush();','\tif (godotjs_managed_cleanup) message_queue->clear();\n\telse message_queue->flush();',2],
  ]},
 'scene/main/scene_tree.cpp':{start:'void SceneTree::finalize() {',end:'void SceneTree::quit(',sha:'0b04efe1e36f4fedfd04ca72c847dc06aff5bfd0ca7d7042423bb4e959a6d99e',anchor:'#include "scene_tree.h"',include:'\n#include "modules/modules_enabled.gen.h"'+hooks,
  edits:[['\t_flush_ugc();',`\t// ${marker}: unique deferred group calls are business work.
#ifdef MODULE_GODOTJS_ENABLED
\tif (jsb::native_managed_cleanup_active()) unique_group_calls.clear();
\telse _flush_ugc();
#else
\t_flush_ugc();
#endif`]],
 },
};
function body(source,layout){const start=source.indexOf(layout.start),end=layout.end?source.indexOf(layout.end,start):source.length;if(start<0||end<0||source.split(layout.start).length!==2)throw Error('E_SHUTDOWN_QUEUE_PATCH: unsupported function');return {start,end,code:source.slice(start,end)};}
const workerReset="\n#ifdef WEB_ENABLED\n\tgodot_web_worker_reset_draw_credit();\n\tEM_ASM({ delete Module['godotWorkerResetDrawCredit']; });\n#endif";
function bodyHash(code,layout){
 // The independently pinned Dedicated renderer owns this exact reset prefix.
 // Normalize it only for our hash; preserve it in every output/replay.
 if(layout.start.startsWith('void Main::cleanup')&&code.startsWith(layout.start+workerReset))code=layout.start+code.slice(layout.start.length+workerReset.length);
 return hash(code);
}
export function unpatchManagedShutdownQueue(path,source){
 const layout=layouts[path];if(!layout||!source.includes(marker))return source;
 let restored=source;
 for(const [from,to,count=1] of [...layout.edits].reverse()){
  if(restored.split(to).length!==count+1)throw Error('E_SHUTDOWN_QUEUE_PATCH: modified '+path);
  restored=restored.replaceAll(to,from);
 }
 if(restored.split(layout.include).length!==2)throw Error('E_SHUTDOWN_QUEUE_PATCH: include '+path);
 restored=restored.replace(layout.include,'');
 if(bodyHash(body(restored,layout).code,layout)!==layout.sha)throw Error('E_SHUTDOWN_QUEUE_PATCH: baseline '+path);
 return restored;
}
export function patchManagedShutdownQueue(path,source){
 const layout=layouts[path];if(!layout)throw Error('E_SHUTDOWN_QUEUE_PATCH: '+path);
 if(source.includes(marker)){unpatchManagedShutdownQueue(path,source);return {code:source,changed:false,patchId:MANAGED_SHUTDOWN_PATCH};}
 const original=body(source,layout);if(bodyHash(original.code,layout)!==layout.sha)throw Error('E_SHUTDOWN_QUEUE_PATCH: baseline '+path);
 let next=original.code;
 for(const [from,to,count=1] of layout.edits){if(next.split(from).length!==count+1)throw Error('E_SHUTDOWN_QUEUE_PATCH: anchor '+path);next=next.replaceAll(from,to);}
 let code=source.slice(0,original.start)+next+source.slice(original.end);
 if(code.split(layout.anchor).length!==2)throw Error('E_SHUTDOWN_QUEUE_PATCH: include anchor '+path);
 code=code.replace(layout.anchor,layout.anchor+layout.include);
 return {code,changed:true,patchId:MANAGED_SHUTDOWN_PATCH};
}
export function managedShutdownBuildProof(records){
 const files={};for(const path of MANAGED_SHUTDOWN_PATHS){const applied=records.findLast(r=>r.path===path&&r.patchId===MANAGED_SHUTDOWN_PATCH),last=records.findLast(r=>r.path===path);if(!applied?.implementation?.sha256||!last)throw Error('E_SHUTDOWN_QUEUE_PROOF: '+path);files[path]={sha256:last.afterSha256,implementation:applied.implementation};}
 return {shutdownQueueAbi:1,shutdownQueuePatch:{abi:1,patchId:MANAGED_SHUTDOWN_PATCH,files}};
}
