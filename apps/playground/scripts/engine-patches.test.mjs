import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createContext,runInContext} from 'node:vm';
import {buildBrowserEngine} from '../../../scripts/test/build-browser-engine.mjs';
import {applyWebEnginePatches} from '../../../scripts/release/patch-web-engine.mjs';
import {digest,canonical} from '../../../scripts/release/web-release-utils.mjs';
import {THREADLESS_GROUP_WAIT_ORIGINAL} from '../../../scripts/release/patch-web-threadless-groups.mjs';
import {PROXY_ENTRY_ORIGINAL,patchProxyEntry} from '../../../scripts/release/patch-web-proxy-entry.mjs';
import {patchShaderUtf8} from '../../../scripts/release/patch-web-shader-utf8.mjs';

async function fixture(root){
 const sources={
  SConstruct:'# source-only fixture',
  'platform/web/detect.py':await readFile(new URL('./fixtures/godot-4.6.1-web-detect.py',import.meta.url),'utf8'),
  'platform/web/js/patches/patch_em_gl.js':await readFile(new URL('./fixtures/godot-4.6.1-patch-em-gl.js',import.meta.url),'utf8'),
  'core/object/worker_thread_pool.cpp':THREADLESS_GROUP_WAIT_ORIGINAL,
  'platform/web/js/engine/config.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-config.js',import.meta.url),'utf8'),
  'servers/audio/audio_server.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-audio-server.cpp',import.meta.url),'utf8'),
  'main/main.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-main.cpp',import.meta.url),'utf8'),
  'platform/web/web_main.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-web-main.cpp',import.meta.url),'utf8'),
  'scene/main/scene_tree.h':await readFile(new URL('../../../scripts/test/fixtures/godot-4.6.1-scene-tree.h',import.meta.url),'utf8'),
  'scene/main/scene_tree.cpp':await readFile(new URL('../../../scripts/test/fixtures/godot-4.6.1-scene-tree.cpp',import.meta.url),'utf8'),
  'platform/web/display_server_web.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-display-server-web.cpp',import.meta.url),'utf8'),
  'platform/web/audio_driver_web.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-audio-driver-web.cpp',import.meta.url),'utf8'),
  'platform/web/js/engine/engine.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-engine.js',import.meta.url),'utf8'),
  'drivers/gles3/shaders/scene.glsl':'out highp vec3 vertex_interp;\nvoid main() {\n\tgl_PointSize = point_size;\n}\n#[fragment]\nin highp vec3 vertex_interp;\nvoid main() {\n#CODE : FRAGMENT\n#endif // !USE_SHADOW_TO_OPACITY\n}\n',
  'servers/rendering/renderer_rd/shaders/scene_forward_aa_inc.glsl':'#ifdef ALPHA_HASH_USED\nhalf compute_alpha_hash_threshold(vec3 pos, float scale) { return half(0.5); }\n#endif // ALPHA_HASH_USED\n',
  'drivers/gles3/storage/texture_storage.cpp':'void TextureStorage::_create_render_target_backbuffer(RenderTarget *rt) {\nint count = MAX(1, Image::get_image_required_mipmaps(width, height, format) - 4);\n\tif (rt->size.x > 40 && rt->size.y > 40) { allocate(); }\n}\nvoid TextureStorage::_clear_render_target(RenderTarget *rt) {}',
  'scene/main/viewport.cpp':'tooltip_owner->add_child(gui.tooltip_popup);',
  'platform/web/js/libs/library_godot_os.js':'navigator.serviceWorker.getRegistration().then(GodotPWA.updateState.bind(null, cb));',
  'platform/web/js/libs/library_godot_audio.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-audio.js',import.meta.url),'utf8'),
  'platform/web/js/libs/library_godot_input.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-input.js',import.meta.url),'utf8'),
  'modules/webrtc/library_godot_webrtc.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-webrtc.js',import.meta.url),'utf8'),
  'modules/webxr/native/library_godot_webxr.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-webxr.js',import.meta.url),'utf8'),
 };
 for(const [path,source]of Object.entries(sources)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),source);}
 return sources;
}

test('local patch CLI and the actual CI snapshot builder produce identical engine sources',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-patch-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'upstream'),local=join(root,'local'),built=join(root,'ci');
 await fixture(source);await cp(source,local,{recursive:true});
 const run=spawnSync(process.execPath,[new URL('../../../scripts/release/patch-web-engine.mjs',import.meta.url).pathname,local],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const localPatches=JSON.parse(run.stdout);
 // Snapshot mode executes real source copying and patching; no fake SCons
 // build/template or certification is produced by this fixture.
 const out=join(root,'report.json');
 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,'snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert.equal(report.status,'snapshotted');assert.equal(report.recipe.patches.length,21);
 assert.deepEqual(report.runtimeAbi,{protocolVersion:2,host:1,audio:1,presentation:1,lifecycle:1});
 assert.equal(report.execution.lifecycleAbi,1);assert.equal(report.lifecyclePatch.abi,1);
 assert.equal(Object.keys(report.workerPatch.files).length,10);
 assert.deepEqual(report.recipe.patches,localPatches);
 assert(localPatches.some(patch=>patch.implementation.path==='impl/web/patches/patch-web-renderer.py'));
 assert(localPatches.some(patch=>patch.implementation.path==='impl/web/patches/patch-native-tooltips.py'));
 assert(!localPatches.some(patch=>patch.implementation.path.startsWith('apps/')));
 for(const patch of localPatches){
  assert.equal(patch.changed,true);assert.match(patch.implementation.sha256,/^[a-f0-9]{64}$/);
  const finalPatch=localPatches.findLast(item=>item.path===patch.path);
  assert.equal(digest(await readFile(join(built,patch.path))),finalPatch.afterSha256);
  assert.equal(await readFile(join(local,patch.path),'utf8'),await readFile(join(built,patch.path),'utf8'));
 }
 assert.match(await readFile(join(built,'drivers/gles3/shaders/scene.glsl'),'utf8'),/alpha < alpha_hash_threshold/);
 assert.match(await readFile(join(built,'drivers/gles3/storage/texture_storage.cpp'),'utf8'),/rt->size.x > 0 && rt->size.y > 0/);
 assert.match(await readFile(join(built,'scene/main/viewport.cpp'),'utf8'),/Node::INTERNAL_MODE_BACK/);
 const again=await applyWebEnginePatches(local);assert.ok(again.every(p=>!p.changed&&p.beforeSha256===p.afterSha256));
});
test('a rejected late patch leaves all upstream files unchanged',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-patch-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sources=await fixture(root);sources['platform/web/js/libs/library_godot_audio.js']='unsupported audio source';
 await writeFile(join(root,'platform/web/js/libs/library_godot_audio.js'),sources['platform/web/js/libs/library_godot_audio.js']);
 await assert.rejects(applyWebEnginePatches(root),/E_AUDIO_PATCH_UNSUPPORTED/);
 for(const [path,source]of Object.entries(sources))assert.equal(await readFile(join(root,path),'utf8'),source,path);
});

test('an unsupported worker-group source rejects the whole patch plan without partial writes', async t => {
 const root=await mkdtemp(join(tmpdir(),'engine-worker-patch-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sources=await fixture(root);
 sources['core/object/worker_thread_pool.cpp']=sources['core/object/worker_thread_pool.cpp'].replace('groups.erase(p_group);','unknown_upstream_cleanup();');
 await writeFile(join(root,'core/object/worker_thread_pool.cpp'),sources['core/object/worker_thread_pool.cpp']);
 await assert.rejects(applyWebEnginePatches(root),/E_THREADLESS_GROUP_PATCH_UNSUPPORTED/);
 for(const [path,source] of Object.entries(sources))assert.equal(await readFile(join(root,path),'utf8'),source,path);
});

test('an unsupported presentation config rejects the whole patch plan before any source write',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-presentation-patch-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sources=await fixture(root);sources['platform/web/js/engine/config.js']+='\n// unknown upstream change\n';
 await writeFile(join(root,'platform/web/js/engine/config.js'),sources['platform/web/js/engine/config.js']);
 await assert.rejects(applyWebEnginePatches(root),/E_PRESENTATION_PATCH_UNSUPPORTED/);
 for(const [path,source]of Object.entries(sources))assert.equal(await readFile(join(root,path),'utf8'),source,path);
});

test('proxy entry patch removes only the obsolete runtime export and is idempotent',async()=>{
 const source=await readFile(new URL('./fixtures/godot-4.6.1-web-detect.py',import.meta.url),'utf8');
 const first=patchProxyEntry(source);assert.equal(first.code.includes(PROXY_ENTRY_ORIGINAL),false);assert.match(first.code,/callMain/);
 assert.deepEqual(patchProxyEntry(first.code),first);
 assert.throws(()=>patchProxyEntry(source+PROXY_ENTRY_ORIGINAL),/E_PROXY_ENTRY_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchProxyEntry('unsupported detect.py'),/E_PROXY_ENTRY_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchProxyEntry(first.code.replace('Exported callMain','changed callMain')),/E_PROXY_ENTRY_PATCH_UNSUPPORTED/);
});

test('shader source decoding works without Emscripten UTF8Decoder on normal and shared heaps',async()=>{
 const original=await readFile(new URL('./fixtures/godot-4.6.1-patch-em-gl.js',import.meta.url),'utf8');
 const patched=patchShaderUtf8(original);assert.deepEqual(patchShaderUtf8(patched.code),patched);
 assert.throws(()=>patchShaderUtf8(original+'\n'),/E_SHADER_UTF8_PATCH_UNSUPPORTED/);
 assert.throws(()=>patchShaderUtf8(patched.code.replace('godotShaderDecoder.decode','unknownDecoder.decode')),/E_SHADER_UTF8_PATCH_UNSUPPORTED/);
 for(const buffer of [new ArrayBuffer(512),new SharedArrayBuffer(512)]){
  const bytes=new Uint8Array(buffer),words=new Uint32Array(buffer),first='// 漢字🙂\n',second='void main() {}',encoder=new TextEncoder();
  bytes.set(encoder.encode(first),64);bytes.set(encoder.encode(second),128);words[4]=64;words[5]=128;words[8]=encoder.encode(first).length;words[9]=encoder.encode(second).length;
  let decoders=0;const stringCalls=[];
  class Decoder extends TextDecoder{constructor(encoding){super(encoding);decoders++;}}
  const GL={},context=createContext({ArrayBuffer,TextDecoder:Decoder,HEAPU8:bytes,HEAPU32:words,GL,addOnPostRun:callback=>callback(),UTF8ToString:(ptr,len)=>{stringCalls.push({ptr,len});let end=ptr;while(bytes[end])end++;return new TextDecoder().decode(bytes.slice(ptr,end));}});
  runInContext(patched.code,context);assert.equal(runInContext('typeof UTF8Decoder',context),'undefined');
  assert.equal(GL.getSource(0,2,16,32),first+second);assert.equal(GL.getSource(0,2,16,32),first+second);assert.equal(decoders,1);
  assert.equal(GL.getSource(0,2,16,0),first+second);assert.equal(stringCalls.length,2);
 }

});

test('an unsupported final XR source rejects the entire native patch plan before writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-xr-patch-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sources=await fixture(root);sources['modules/webxr/native/library_godot_webxr.js']+='\n// unrecognized upstream change\n';
 await writeFile(join(root,'modules/webxr/native/library_godot_webxr.js'),sources['modules/webxr/native/library_godot_webxr.js']);
 await assert.rejects(applyWebEnginePatches(root),/E_WORKER_XR_PATCH_UNSUPPORTED/);
 for(const [path,source]of Object.entries(sources))assert.equal(await readFile(join(root,path),'utf8'),source,path);
});


test('ThinLTO worker cap and compiler environment are part of the attested recipe',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-thin-recipe-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source'),built=join(root,'build');await fixture(source);
 const previous=Object.fromEntries(['EMCC_CORES','BINARYEN_CORES'].map(name=>[name,process.env[name]]));t.after(()=>{for(const [name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}});process.env.EMCC_CORES='4';process.env.BINARYEN_CORES='4';
 const out=join(root,'report.json');await buildBrowserEngine({'godot-source':source,'build-dir':built,out,profile:'engine-2d-v1',target:'template_release',lto:'thin',jobs:4,'snapshot-only':true,scons:process.execPath,emcc:process.execPath});const report=JSON.parse(await readFile(out,'utf8'));
 assert(report.recipe.args.includes('linkflags=-Wl,--thinlto-jobs=4'));assert.deepEqual(report.recipe.environment,{EMCC_CORES:'4',BINARYEN_CORES:'4'});assert.deepEqual(report.toolchains.environment,report.recipe.environment);assert.equal(report.recipeSha256,digest(canonical(report.recipe)));
 assert.notEqual(report.recipeSha256,digest(canonical({...report.recipe,args:report.recipe.args.map(arg=>arg==='linkflags=-Wl,--thinlto-jobs=4'?'linkflags=-Wl,--thinlto-jobs=8':arg)})));assert.notEqual(report.recipeSha256,digest(canonical({...report.recipe,environment:{...report.recipe.environment,EMCC_CORES:'8'}})));
 assert.match(await readFile(join(built,'SConstruct'),'utf8'),/resolvedLinkFlags/);assert(report.godotSource.inputs.SConstruct);
});


test('proxy-pthread snapshots retain the native pthread patch set without the Dedicated Worker ABI',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-pthread-patch-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'upstream'),built=join(root,'pthread');await fixture(source);
 const out=join(root,'report.json');
 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,'execution-model':'proxy-pthread','snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert.equal(report.execution.executionModel,'proxy-pthread');assert.equal(report.recipe.patches.length,13);
 assert.equal(report.execution.lifecycleAbi,1);assert.equal(report.lifecyclePatch.abi,1);
 assert.equal(report.runtimeAbi,undefined);assert.equal(report.workerPatch,undefined);
 assert(report.recipe.args.includes('threads=yes'));assert(report.recipe.args.includes('proxy_to_pthread=yes'));
 assert(report.recipe.patches.some(item=>item.patchId==='godotjs-audio-server-finish-v1'));
});
