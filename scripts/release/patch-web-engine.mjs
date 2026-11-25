/** The complete pinned Web patch set, shared by local and CI engine builds. */
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {patchAudioLifecycle} from './patch-web-audio-lifecycle.mjs';
import {patchOptionalPwa} from './patch-web-optional-pwa.mjs';
import {patchThreadlessGroups} from './patch-web-threadless-groups.mjs';
import {patchPresentationBoundary} from './patch-web-presentation-boundary.mjs';
import {patchProxyEntry} from './patch-web-proxy-entry.mjs';
import {patchShaderUtf8} from './patch-web-shader-utf8.mjs';
import {patchAudioServerFinish} from './patch-web-audio-server-finish.mjs';
import {patchWorkerRuntimeFile,WORKER_RUNTIME_PATHS} from './patch-web-worker-runtime.mjs';
import {patchWebLifecycleFile} from './patch-web-lifecycle.mjs';
import {patchRuntimePropertiesQuitFile,RUNTIME_PROPERTIES_QUIT_PATHS} from './patch-runtime-properties-quit.mjs';
import {patchArtifactSetMount,unpatchArtifactSetMount} from './patch-artifact-set-mount.mjs';
import {NATIVE_OBSERVER_PATHS,patchNativeObserverFile} from './patch-native-observer.mjs';
import {HOST_RESOURCE_PATHS,patchHostResourceFile,unpatchHostResourceFile} from './patch-web-resource-owner.mjs';
import {MANAGED_SHUTDOWN_PATHS,patchManagedShutdownQueue,unpatchManagedShutdownQueue} from './patch-managed-shutdown-queue.mjs';
import {AUDIO_WORKLET_FINISH_PATH,patchAudioWorkletFinish,unpatchAudioWorkletFinish} from './patch-web-audio-worklet-finish.mjs';

import {GAME_PROBE_PATHS,GAME_PROBE_PATCH,GAME_PROBE_REMOVAL_PATCH,patchGameProbe,unpatchGameProbe} from './patch-web-game-probe.mjs';
import {INPUT_SCRIPT_PATHS,INPUT_SCRIPT_PATCH,INPUT_SCRIPT_REMOVAL_PATCH,patchInputScript,unpatchInputScript} from './patch-web-input-script.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const execute=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
export async function applyWebEnginePatches(root,{python='python3',executionModel='window',gameProbe=true,inputScript=gameProbe}={}) {
 const planned=[];
 const enableGameProbe=executionModel==='window'&&gameProbe;
 const enableInputScript=enableGameProbe&&inputScript;
 const gameProbeImplementation='scripts/release/patch-web-game-probe.mjs';
 const inputScriptImplementation='scripts/release/patch-web-input-script.mjs';
 const plannedSource=path=>planned.findLast(item=>item.record.path===path)?.code??readFile(resolve(root,path),'utf8');
 const add=async(path,code,patchId,implementation,baseline)=>{
  const before=baseline??await readFile(resolve(root,path),'utf8');
  planned.push({code,record:{patchId,path,beforeSha256:hash(before),afterSha256:hash(code),changed:before!==code,
   implementation:{path:implementation,sha256:hash(await readFile(resolve(repo,implementation)))}}});
 };
 // Compute every patch before writing: unsupported source layouts leave the
 // input tree intact. Python's JSON mode calls the same checked pure patchers.
 // Disabled profiles may start from a checkout already patched for Full Debug.
 const hadInputScript=(await readFile(resolve(root,'core/input/input.cpp'),'utf8')).includes('Input::godotjs_is_action_pressed');
 if(!enableGameProbe||enableInputScript||hadInputScript)for(const path of GAME_PROBE_PATHS){
  const before=await readFile(resolve(root,path),'utf8'),code=unpatchGameProbe(path,before);
  if(code!==before)await add(path,code,GAME_PROBE_REMOVAL_PATCH,gameProbeImplementation,before);
 }
 if(hadInputScript)for(const path of INPUT_SCRIPT_PATHS){
  const before=await plannedSource(path),code=unpatchInputScript(path,before);
  if(code!==before)await add(path,code,INPUT_SCRIPT_REMOVAL_PATCH,inputScriptImplementation,before);
 }
 for(const [script,patchIds] of [
  ['impl/web/patches/patch-web-renderer.py',{'drivers/gles3/shaders/scene.glsl':'godotjs-gles3-alpha-hash-v1','drivers/gles3/storage/texture_storage.cpp':'godotjs-gles3-small-canvas-backbuffer-v1'}],
  ['impl/web/patches/patch-native-tooltips.py',{'scene/main/viewport.cpp':'godotjs-private-tooltip-v1'}],
 ]) {
  const {stdout}=await execute(python,[resolve(repo,script),resolve(root),'--json'],{maxBuffer:16*1024*1024});
  const files=JSON.parse(stdout);
  if(Object.keys(files).length!==Object.keys(patchIds).length)throw Error('E_ENGINE_PATCH_OUTPUT: '+script);
  for(const [path,patchId]of Object.entries(patchIds)){
   if(typeof files[path]!=='string')throw Error('E_ENGINE_PATCH_OUTPUT: '+path);
   await add(path,files[path],patchId,script);
  }
 }
 for(const [path,apply,implementation]of [
  ['platform/web/detect.py',patchProxyEntry,'scripts/release/patch-web-proxy-entry.mjs'],
  ['platform/web/js/patches/patch_em_gl.js',patchShaderUtf8,'scripts/release/patch-web-shader-utf8.mjs'],
  ['platform/web/js/libs/library_godot_os.js',patchOptionalPwa,'scripts/release/patch-web-optional-pwa.mjs'],
  ['platform/web/js/libs/library_godot_audio.js',patchAudioLifecycle,'scripts/release/patch-web-audio-lifecycle.mjs'],
  ...(executionModel==='proxy-pthread'?[['servers/audio/audio_server.cpp',patchAudioServerFinish,'scripts/release/patch-web-audio-server-finish.mjs']]:[]),
  ['core/object/worker_thread_pool.cpp',patchThreadlessGroups,'scripts/release/patch-web-threadless-groups.mjs'],
  ['platform/web/js/engine/config.js',patchPresentationBoundary,'scripts/release/patch-web-presentation-boundary.mjs'],
 ]) {
  const baseline=await readFile(resolve(root,path),'utf8');
  const normalized=unpatchHostResourceFile(path,baseline),result=apply(normalized);
  if(result.code===normalized)result.code=baseline;
  await add(path,result.code,result.patchId,implementation,baseline);
 }
 // The Worker audio imports compose after the independently checked lifecycle
 // patch. Keep both receipts, binding the second receipt to the first output.
 for(const path of executionModel==='window'?WORKER_RUNTIME_PATHS:[]){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const earlier=unpatchGameProbe(path,before);
  let normalized=unpatchManagedShutdownQueue(path,unpatchHostResourceFile(path,path==='main/main.cpp'?unpatchArtifactSetMount(earlier):earlier));
  if(path===AUDIO_WORKLET_FINISH_PATH)normalized=unpatchAudioWorkletFinish(normalized);
  const result=patchWorkerRuntimeFile(path,normalized);
  if(result.code===normalized)result.code=before;
  await add(path,result.code,result.patchId,'scripts/release/patch-web-worker-runtime.mjs',before);
 }
 for(const path of ['scene/main/scene_tree.h','scene/main/scene_tree.cpp',...(executionModel==='proxy-pthread'?['platform/web/web_main.cpp']:[])]){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const normalized=unpatchManagedShutdownQueue(path,before);
  const result=patchWebLifecycleFile(path,normalized);
  await add(path,result.code===normalized?before:result.code,result.patchId,'scripts/release/patch-web-lifecycle.mjs',before);
 }
 {
  const path='main/main.cpp',before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchArtifactSetMount(before);
  await add(path,result.code,result.patchId,'scripts/release/patch-artifact-set-mount.mjs',before);
 }
 for(const path of HOST_RESOURCE_PATHS){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchHostResourceFile(path,before);
  await add(path,result.code,result.patchId,'scripts/release/patch-web-resource-owner.mjs',before);
 }
 for(const path of NATIVE_OBSERVER_PATHS){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchNativeObserverFile(path,before);
  await add(path,result.code,result.patchId,'scripts/release/patch-native-observer.mjs',before);
 }
 for(const path of MANAGED_SHUTDOWN_PATHS){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchManagedShutdownQueue(path,before);
  await add(path,result.code,result.patchId,'scripts/release/patch-managed-shutdown-queue.mjs',before);
 }
 {
  const path=AUDIO_WORKLET_FINISH_PATH,before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchAudioWorkletFinish(before);
  await add(path,result.code,result.patchId,'scripts/release/patch-web-audio-worklet-finish.mjs',before);
 }
 for(const path of RUNTIME_PROPERTIES_QUIT_PATHS){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  const result=patchRuntimePropertiesQuitFile(path,before);
  await add(path,result.code,result.patchId,'scripts/release/patch-runtime-properties-quit.mjs',before);
 }
 if(enableInputScript)for(const path of INPUT_SCRIPT_PATHS){
  const before=await plannedSource(path);
  await add(path,patchInputScript(path,before),INPUT_SCRIPT_PATCH,inputScriptImplementation,before);
 }
 if(enableGameProbe)for(const path of GAME_PROBE_PATHS){
  const before=planned.findLast(item=>item.record.path===path)?.code??await readFile(resolve(root,path),'utf8');
  await add(path,patchGameProbe(path,before),GAME_PROBE_PATCH,gameProbeImplementation,before);
 }
 const final=new Map(planned.map(item=>[item.record.path,item]));
 for(const [path,{code,record}]of final){
  const initial=planned.find(item=>item.record.path===path).record;
  if(initial.beforeSha256!==record.afterSha256)await writeFile(resolve(root,path),code);
 }
 return planned.map(({record})=>record);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.argv[2])throw Error('Usage: node patch-web-engine.mjs <godot-source>');
 console.log(JSON.stringify(await applyWebEnginePatches(resolve(process.argv[2]))));
}
