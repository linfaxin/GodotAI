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

const repo=fileURLToPath(new URL('../../',import.meta.url));
const execute=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
export async function applyWebEnginePatches(root,{python='python3'}={}) {
 const planned=[];
 const add=async(path,code,patchId,implementation)=>{
  const before=await readFile(resolve(root,path),'utf8');
  planned.push({code,record:{patchId,path,beforeSha256:hash(before),afterSha256:hash(code),changed:before!==code,
   implementation:{path:implementation,sha256:hash(await readFile(resolve(repo,implementation)))}}});
 };
 // Compute every patch before writing: unsupported source layouts leave the
 // input tree intact. Python's JSON mode calls the same checked pure patchers.
 for(const [script,patchIds] of [
  ['apps/playground/scripts/patch-web-renderer.py',{'drivers/gles3/shaders/scene.glsl':'godotjs-gles3-alpha-hash-v1','drivers/gles3/storage/texture_storage.cpp':'godotjs-gles3-small-canvas-backbuffer-v1'}],
  ['apps/playground/scripts/patch-native-tooltips.py',{'scene/main/viewport.cpp':'godotjs-private-tooltip-v1'}],
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
  ['platform/web/js/libs/library_godot_os.js',patchOptionalPwa,'scripts/release/patch-web-optional-pwa.mjs'],
  ['platform/web/js/libs/library_godot_audio.js',patchAudioLifecycle,'scripts/release/patch-web-audio-lifecycle.mjs'],
  ['core/object/worker_thread_pool.cpp',patchThreadlessGroups,'scripts/release/patch-web-threadless-groups.mjs'],
  ['platform/web/js/engine/config.js',patchPresentationBoundary,'scripts/release/patch-web-presentation-boundary.mjs'],
 ]) {
  const result=apply(await readFile(resolve(root,path),'utf8'));
  await add(path,result.code,result.patchId,implementation);
 }
 for(const {code,record}of planned)if(record.changed)await writeFile(resolve(root,record.path),code);
 return planned.map(({record})=>record);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.argv[2])throw Error('Usage: node patch-web-engine.mjs <godot-source>');
 console.log(JSON.stringify(await applyWebEnginePatches(resolve(process.argv[2]))));
}
