import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {HOST_RESOURCE_PATHS,patchHostResourceFile,unpatchHostResourceFile,hostResourceBuildProof} from '../patch-web-resource-owner.mjs';
import {patchAudioLifecycle} from '../patch-web-audio-lifecycle.mjs';
import {patchShaderUtf8} from '../patch-web-shader-utf8.mjs';
import {patchOptionalPwa} from '../patch-web-optional-pwa.mjs';
import {WORKER_RUNTIME_PATHS,patchWorkerRuntimeFile} from '../patch-web-worker-runtime.mjs';

const fixture={
 'platform/web/js/libs/library_godot_os.js':'os',
 'platform/web/js/patches/patch_em_gl.js':'patch-em-gl',
 'platform/web/js/libs/library_godot_runtime.js':'runtime',
 'platform/web/js/libs/library_godot_audio.js':'audio',
 'platform/web/js/libs/library_godot_display.js':'display',
 'modules/websocket/library_godot_websocket.js':'websocket',
 'modules/webrtc/library_godot_webrtc.js':'webrtc',
};
const sha=value=>createHash('sha256').update(value).digest('hex');
test('host adoption patches compose with both native Web backends and reject edited source',async()=>{
 for(const worker of [false,true]){
  const records=[];
  for(const path of HOST_RESOURCE_PATHS){
   let before=await readFile(new URL('../../jsb.react-browser/test/fixtures/godot-4.6.1-'+fixture[path]+'.js',import.meta.url),'utf8');
   if(fixture[path]==='audio')before=patchAudioLifecycle(before).code;
   if(fixture[path]==='patch-em-gl')before=patchShaderUtf8(before).code;
   if(fixture[path]==='os')before=patchOptionalPwa(before).code;
   if(worker&&WORKER_RUNTIME_PATHS.includes(path))before=patchWorkerRuntimeFile(path,before).code;
   const patched=patchHostResourceFile(path,before);
   assert(patched.changed);assert.equal(patchHostResourceFile(path,patched.code).code,patched.code);
   assert.equal(unpatchHostResourceFile(path,patched.code),before);
   assert.throws(()=>patchHostResourceFile(path,patched.code+'\n'),/E_HOST_RESOURCE_PATCH/);
   const implementation={path:'scripts/release/patch-web-resource-owner.mjs',sha256:sha('test implementation')};
   records.push({path,patchId:patched.patchId,afterSha256:sha(patched.code),implementation});
  }
  const proof=hostResourceBuildProof(records);assert.equal(proof.hostResourceAbi,1);
  assert.deepEqual(Object.keys(proof.hostResourcePatch.files),HOST_RESOURCE_PATHS);
  for(let i=0;i<records.length;i++)assert.throws(()=>hostResourceBuildProof(records.filter((_,n)=>n!==i)),/E_HOST_RESOURCE_PROOF/);
 }
});

test('graphics ownership hooks install both before and after the Emscripten post-run checkpoint',async()=>{
 const path='platform/web/js/patches/patch_em_gl.js',before=await readFile(new URL('../../jsb.react-browser/test/fixtures/godot-4.6.1-patch-em-gl.js',import.meta.url),'utf8');
 const patched=patchHostResourceFile(path,patchShaderUtf8(before).code).code;
 for(const initialized of [false,true]){
  const queued=[],owned=[],context={GLctx:{driver:'actual-context'}},initial=()=>7;
  const scope={runtimeInitialized:initialized,TextDecoder,Module:{godotjsOwnResource(kind,value){owned.push([kind,value]);return true;}},GL:{createContext:initial,getContext:()=>context,deleteContext(){throw Error('live context deleted');}},addOnPostRun(callback){queued.push(callback);}};
  vm.runInNewContext(patched,scope);
  if(!initialized){assert.equal(scope.GL.createContext,initial);assert.equal(queued.length,1);queued[0]();}
  else assert.equal(queued.length,0);
  assert.notEqual(scope.GL.createContext,initial);assert.equal(scope.GL.createContext({},{}),7);
  assert.equal(owned.length,1);assert.equal(owned[0][0],'gl');assert.equal(owned[0][1],context.GLctx);
 }
});
