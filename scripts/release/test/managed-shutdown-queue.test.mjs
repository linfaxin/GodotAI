import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MANAGED_SHUTDOWN_PATHS,patchManagedShutdownQueue,unpatchManagedShutdownQueue,managedShutdownBuildProof} from '../patch-managed-shutdown-queue.mjs';
import {patchWebLifecycleFile} from '../patch-web-lifecycle.mjs';
import {patchNativeLifecycleFile} from '../patch-native-lifecycle.mjs';
const fixture=path=>new URL('../../test/fixtures/'+(path==='main/main.cpp'?'godot-4.6.1-main-cleanup.cpp':'godot-4.6.1-scene-tree.cpp'),import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');

test('managed shutdown drops message/group business calls while preserving native deletion',async()=>{
 const records=[];
 for(const path of MANAGED_SHUTDOWN_PATHS){
  const before=await readFile(fixture(path),'utf8'),result=patchManagedShutdownQueue(path,before);
  assert.equal(patchManagedShutdownQueue(path,result.code).code,result.code);
  assert.equal(unpatchManagedShutdownQueue(path,result.code),before);
  assert.match(result.code,/native_managed_cleanup_active\(\)/);
  if(path==='main/main.cpp'){
   assert.equal(result.code.split('if (godotjs_managed_cleanup) message_queue->clear();').length-1,2);
   assert.equal(result.code.split('else message_queue->flush();').length-1,2);
   assert.match(result.code,/const bool godotjs_managed_cleanup = false/);
   const prefix="\n#ifdef WEB_ENABLED\n\tgodot_web_worker_reset_draw_credit();\n\tEM_ASM({ delete Module['godotWorkerResetDrawCredit']; });\n#endif";
   const composed=before.replace('void Main::cleanup(bool p_force) {','void Main::cleanup(bool p_force) {'+prefix);
   const patched=patchManagedShutdownQueue(path,composed).code;
   assert(patched.includes(prefix));assert.equal(unpatchManagedShutdownQueue(path,patched),composed);
   assert.equal(patchManagedShutdownQueue(path,patched).code,patched);
   assert.throws(()=>patchManagedShutdownQueue(path,composed.replace('godot_web_worker_reset_draw_credit();','unowned_reset();')),/E_SHUTDOWN_QUEUE_PATCH/);
  }else{
   const start=result.code.indexOf('void SceneTree::finalize()'),end=result.code.indexOf('void SceneTree::quit(',start),body=result.code.slice(start,end);
   assert.equal(body.split('_flush_delete_queue();').length-1,2);
   assert.match(body,/unique_group_calls.clear\(\)/);
   for(const patch of [patchWebLifecycleFile,patchNativeLifecycleFile]){
    const layered=patchManagedShutdownQueue(path,patch(path,before).code).code;
    assert.equal(patchManagedShutdownQueue(path,layered).code,layered);
    assert.equal(patch(path,unpatchManagedShutdownQueue(path,layered)).code,unpatchManagedShutdownQueue(path,layered));
   }
  }
  assert.throws(()=>patchManagedShutdownQueue(path,result.code.replace('native_managed_cleanup_active()','false')),/E_SHUTDOWN_QUEUE_PATCH/);
  records.push({path,patchId:result.patchId,afterSha256:hash(result.code),implementation:{path:'scripts/release/patch-managed-shutdown-queue.mjs',sha256:hash('test implementation')}});
 }
 const proof=managedShutdownBuildProof(records);assert.equal(proof.shutdownQueueAbi,1);
 assert.deepEqual(Object.keys(proof.shutdownQueuePatch.files),MANAGED_SHUTDOWN_PATHS);
 for(const path of MANAGED_SHUTDOWN_PATHS)assert.throws(()=>managedShutdownBuildProof(records.filter(record=>record.path!==path)),/E_SHUTDOWN_QUEUE_PROOF/);
});
