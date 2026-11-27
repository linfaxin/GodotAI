import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createContext,runInContext} from 'node:vm';
import {buildBrowserEngine} from '../../../scripts/test/build-browser-engine.mjs';
import {applyWebEnginePatches} from '../../../scripts/release/patch-web-engine.mjs';
import {digest,canonical,assertSourcePatchChains} from '../../../scripts/release/web-release-utils.mjs';
import {GAME_PROBE_PATCH,GAME_PROBE_PATHS,GAME_PROBE_REMOVAL_PATCH} from '../../../scripts/release/patch-web-game-probe.mjs';
import {INPUT_SCRIPT_PATCH,INPUT_SCRIPT_PATHS,INPUT_SCRIPT_REMOVAL_PATCH,unpatchInputScript} from '../../../scripts/release/patch-web-input-script.mjs';
import {THREADLESS_GROUP_WAIT_ORIGINAL} from '../../../scripts/release/patch-web-threadless-groups.mjs';
import {PROXY_ENTRY_ORIGINAL,patchProxyEntry} from '../../../scripts/release/patch-web-proxy-entry.mjs';
import {patchShaderUtf8} from '../../../scripts/release/patch-web-shader-utf8.mjs';
import {RUNTIME_PROPERTIES_QUIT_PATCH} from '../../../scripts/release/patch-runtime-properties-quit.mjs';

async function fixture(root){
 const sources={
  SConstruct:'# source-only fixture',
  'platform/web/js/libs/library_godot_runtime.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-runtime.js',import.meta.url),'utf8'),
  'platform/web/js/libs/library_godot_display.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-display.js',import.meta.url),'utf8'),
  'modules/websocket/library_godot_websocket.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-websocket.js',import.meta.url),'utf8'),
  'scene/main/node.h':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-node.h',import.meta.url),'utf8'),
  'scene/main/node.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-node.cpp',import.meta.url),'utf8'),
  'core/object/object.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-object.cpp',import.meta.url),'utf8'),
  'core/input/input.h':'class Input : public Object {\n\tvoid _parse_input_event_impl(const Ref<InputEvent> &p_event, bool p_is_emulated);\n\tvoid release_pressed_events();\n\tvoid flush_buffered_events();\n};\n',
  'core/input/input.cpp':[
   'void Input::_parse_input_event_impl(const Ref<InputEvent> &p_event, bool p_is_emulated) {',
   '\tif (event_dispatch_function && emulate_touch_from_mouse && !p_is_emulated && mb->get_button_index() == MouseButton::LEFT) {',
   '\t\tevent_dispatch_function(touch_event);', '\t}',
   '\tif (event_dispatch_function) {', '\t\t_THREAD_SAFE_UNLOCK_', '\t\tevent_dispatch_function(p_event);', '\t}', '}',
   'void Input::release_pressed_events() {', '}', 'void Input::_bind_methods() {',
   '\tClassDB::bind_method(D_METHOD("is_action_pressed", "action", "exact_match"), &Input::is_action_pressed, DEFVAL(false));',
   '\tClassDB::bind_method(D_METHOD("get_action_strength", "action", "exact_match"), &Input::get_action_strength, DEFVAL(false));',
   '\tClassDB::bind_method(D_METHOD("get_axis", "negative_action", "positive_action"), &Input::get_axis);',
   '\tClassDB::bind_method(D_METHOD("action_release", "action"), &Input::action_release);', '}', '',
  ].join('\n'),
  'platform/web/detect.py':await readFile(new URL('./fixtures/godot-4.6.1-web-detect.py',import.meta.url),'utf8'),
  'platform/web/SCsub':'sys_env.Depends(build[0], sys_env["JS_LIBS"])\n',
  'platform/web/js/patches/patch_em_gl.js':await readFile(new URL('./fixtures/godot-4.6.1-patch-em-gl.js',import.meta.url),'utf8'),
  'core/object/worker_thread_pool.cpp':THREADLESS_GROUP_WAIT_ORIGINAL,
  'platform/web/js/engine/config.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-config.js',import.meta.url),'utf8'),
  'servers/audio/audio_server.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-audio-server.cpp',import.meta.url),'utf8'),
  'main/main.cpp':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-main.cpp',import.meta.url),'utf8'),
  'servers/rendering/rendering_server_default.cpp':'void RenderingServerDefault::draw(bool p_present, double frame_step) {\n\tif (create_thread) {\n\t} else {\n\t\t_draw(p_present, frame_step);\n\t}\n}\n',
  'servers/rendering/renderer_viewport.cpp':'void RendererViewport::draw_viewports(bool p_swap_buffers) {\n\t\t\t// render standard mono camera\n\t\t\t_draw_viewport(vp);\n\t\t\t\t\tRSG::rasterizer->blit_render_targets_to_screen(vp->viewport_to_screen, &blit, 1);\n}\n',
  'drivers/gles3/rasterizer_gles3.cpp':'void RasterizerGLES3::_blit_render_target_to_screen() {\n\tglBindTexture(GL_TEXTURE_2D, 0);\n}\n\n// is this p_screen useless\n',
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
  'platform/web/js/libs/library_godot_os.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-os.js',import.meta.url),'utf8'),
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
 assert.equal(spawnSync('git',['init','--quiet',source]).status,0);
 assert.equal(spawnSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
  '-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','Fixture']).status,0);
 const run=spawnSync(process.execPath,[new URL('../../../scripts/release/patch-web-engine.mjs',import.meta.url).pathname,local],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const localPatches=JSON.parse(run.stdout);
 // Snapshot mode executes real source copying and patching; no fake SCons
 // build/template or certification is produced by this fixture.
 const out=join(root,'report.json');
 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,'snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert.equal(report.status,'snapshotted');assert.equal(report.recipe.patches.length,48);
 assert.equal(report.recipe.patches.filter(record=>record.patchId==='godotjs-web-game-probe-v1').length,6);
 assert.deepEqual(report.recipe.patches.filter(record=>record.patchId===INPUT_SCRIPT_PATCH).map(patch=>patch.path),INPUT_SCRIPT_PATHS);
 assertSourcePatchChains(report);
 assert.match(await readFile(join(built,'platform/web/SCsub'),'utf8'),/AddPostAction\(build\[0\], sys_env\.Action\(bind_input_script_wasm,/);
 assert.match(await readFile(join(built,'platform/web/web_main.cpp'),'utf8'),/EMSCRIPTEN_KEEPALIVE uint32_t godotjs_game_probe_abi\(\)/);
 const sceneTree=await readFile(join(built,'scene/main/scene_tree.cpp'),'utf8');
 for(const member of ['paused','suspended'])assert.match(sceneTree,new RegExp(member+' = p_enabled;\\n#ifdef GODOTJS_INPUT_SCRIPT_ABI\\n\\tif \\(p_enabled\\) jsb::input_script::pause\\(\\);'));
 assert.match(sceneTree,/jsb::input_script::scene_will_change\(current_scene, p_scene\);\n#endif\n\tcurrent_scene = p_scene;/);
 for(const id of ['godotjs-artifact-set-early-mount-v1','godotjs-host-resource-owner-v1','godotjs-native-observer-v1'])assert(report.recipe.patches.some(record=>record.patchId===id));
 assert.equal(report.execution.artifactSetAbi,1);assert.equal(report.execution.hostResourceAbi,1);assert.equal(report.nativeObserverPatch.abi,1);assert.equal(report.execution.shutdownQueueAbi,1);
 assert.deepEqual(report.runtimeAbi,{protocolVersion:2,host:1,audio:1,presentation:1,lifecycle:1});
 assert.equal(report.execution.lifecycleAbi,1);assert.equal(report.lifecyclePatch.abi,1);
 const quitPatches=report.recipe.patches.filter(record=>record.patchId===RUNTIME_PROPERTIES_QUIT_PATCH);
 assert.equal(quitPatches.length,1);
 const [quit]=quitPatches;
 assert.equal(quit.path,'scene/main/scene_tree.h');
 assert.equal(quit.implementation.path,'scripts/release/patch-runtime-properties-quit.mjs');
 assert.equal(quit.implementation.sha256,digest(await readFile(new URL('../../../scripts/release/patch-runtime-properties-quit.mjs',import.meta.url))));
 const headerLifecycle=report.recipe.patches.find(record=>record.path===quit.path&&record.patchId==='godotjs-web-lifecycle-v1');
 assert.equal(quit.beforeSha256,headerLifecycle.afterSha256,'quit observation composes after lifecycle');
 assert.equal(report.godotSource.inputs[quit.path],quit.afterSha256);
 assert.equal(report.lifecyclePatch.files[quit.path].sha256,quit.afterSha256,'lifecycle seals the final composed header');
 const header=await readFile(join(built,quit.path),'utf8');
 assert.match(header,/bool godotjs_is_quit_requested\(\) const \{ return _quit; \}/);
 assert.doesNotMatch(header,/D_METHOD\("godotjs_is_quit_requested"/);
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
 const again=await applyWebEnginePatches(local);
 for(const path of new Set(again.map(patch=>patch.path))){
  assert.equal(again.find(patch=>patch.path===path).beforeSha256,again.findLast(patch=>patch.path===path).afterSha256,path);
  assert.deepEqual(await readFile(join(local,path)),await readFile(join(built,path)),path);
 }
});

test('Full debug omits Input Script for a source archive inside an unrelated Git worktree',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-archive-source-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal(spawnSync('git',['init','--quiet',root]).status,0);
 assert.equal(spawnSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test',
  '-c','commit.gpgsign=false','commit','--allow-empty','--quiet','-m','Fixture']).status,0);
 const source=join(root,'archive'),built=join(root,'build'),out=join(root,'report.json');
 await fixture(source);
 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,profile:'full-engine-v1',target:'template_debug',
  development:true,'snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert.equal(report.godotSource.commit,'unknown');
 assert(report.recipe.patches.some(patch=>patch.patchId===GAME_PROBE_PATCH));
 assert(!report.recipe.patches.some(patch=>patch.patchId===INPUT_SCRIPT_PATCH));
 assert.doesNotMatch(await readFile(join(built,'platform/web/web_main.cpp'),'utf8'),/godotjs_input_script_abi/);
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
 assert(!report.recipe.patches.some(record=>record.patchId==='godotjs-web-game-probe-v1'));
 assert.doesNotMatch(await readFile(join(built,'platform/web/web_main.cpp'),'utf8'),/godotjs_game_probe_abi/);
 assert.notEqual(report.recipeSha256,digest(canonical({...report.recipe,args:report.recipe.args.map(arg=>arg==='linkflags=-Wl,--thinlto-jobs=4'?'linkflags=-Wl,--thinlto-jobs=8':arg)})));assert.notEqual(report.recipeSha256,digest(canonical({...report.recipe,environment:{...report.recipe.environment,EMCC_CORES:'8'}})));
 assert.match(await readFile(join(built,'SConstruct'),'utf8'),/resolvedLinkFlags/);assert(report.godotSource.inputs.SConstruct);
});

test('2D release strips the Game Probe and Input Script patches from a previously patched source',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-game-probe-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const clean=join(root,'clean'),source=join(root,'patched'),built=join(root,'build'),out=join(root,'report.json');
 await fixture(clean);await cp(clean,source,{recursive:true});
 await applyWebEnginePatches(source);
 await applyWebEnginePatches(clean,{gameProbe:false});

 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,profile:'engine-2d-v1',target:'template_release',
  'snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert(!report.recipe.patches.some(patch=>patch.patchId===GAME_PROBE_PATCH));
 const removed=report.recipe.patches.filter(patch=>patch.patchId===GAME_PROBE_REMOVAL_PATCH);
 assert.deepEqual(removed.map(patch=>patch.path),GAME_PROBE_PATHS);
 assert(!report.recipe.patches.some(patch=>patch.patchId===INPUT_SCRIPT_PATCH));
 assert.deepEqual(report.recipe.patches.filter(patch=>patch.patchId===INPUT_SCRIPT_REMOVAL_PATCH).map(patch=>patch.path),INPUT_SCRIPT_PATHS);
 assertSourcePatchChains(report);
 for(const path of new Set([...GAME_PROBE_PATHS,...INPUT_SCRIPT_PATHS])){
  const original=await readFile(join(source,path));
  const expected=await readFile(join(clean,path));
  assert.notDeepEqual(original,expected,path);
  assert.deepEqual(await readFile(join(built,path)),expected,path);
  assert.equal(report.godotSource.inputs[path],digest(expected),path);
 }
});

test('the previous Input Script SceneTree patch can be upgraded or disabled', async t => {
 const root=await mkdtemp(join(tmpdir(),'engine-input-script-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const current=join(root,'current'), outdated=join(root,'outdated'), disabled=join(root,'disabled');
 await fixture(current);await cp(current,disabled,{recursive:true});
 await applyWebEnginePatches(current);
 await applyWebEnginePatches(disabled,{gameProbe:false});
 await cp(current,outdated,{recursive:true});
 const path='scene/main/scene_tree.cpp';
 const expected=await readFile(join(current,path),'utf8');
 const previous=unpatchInputScript(path,expected).replace('void SceneTree::set_pause(bool p_enabled) {',
  '#if defined(WEB_ENABLED) && !defined(THREADS_ENABLED)\n#include "modules/GodotJS/bridge/jsb_runtime_input_script.h"\n#endif\n' +
  '#ifdef GODOTJS_INPUT_SCRIPT_ABI\nnamespace jsb::input_script { void pause(); }\n#endif\n\n' +
  'void SceneTree::set_pause(bool p_enabled) {').replace(/\t(paused|suspended) = p_enabled;/g,
  '$&\n#ifdef GODOTJS_INPUT_SCRIPT_ABI\n\tif (p_enabled) jsb::input_script::pause();\n#endif');
 await writeFile(join(outdated,path),previous);
 await applyWebEnginePatches(outdated);
 assert.equal(await readFile(join(outdated,path),'utf8'),expected);
 await writeFile(join(outdated,path),previous);
 const removed=await applyWebEnginePatches(outdated,{gameProbe:false});
 assert(removed.some(patch=>patch.path===path&&patch.patchId===INPUT_SCRIPT_REMOVAL_PATCH&&patch.beforeSha256===digest(previous)));
 assert.deepEqual(await readFile(join(outdated,path)),await readFile(join(disabled,path)));
});

test('proxy-pthread snapshots retain the native pthread patch set without the Dedicated Worker ABI',async t=>{
 const root=await mkdtemp(join(tmpdir(),'engine-pthread-patch-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'upstream'),built=join(root,'pthread');await fixture(source);
 const out=join(root,'report.json');
 await buildBrowserEngine({'godot-source':source,'build-dir':built,out,'execution-model':'proxy-pthread','snapshot-only':true,scons:process.execPath,emcc:process.execPath});
 const report=JSON.parse(await readFile(out,'utf8'));
 assert.equal(report.execution.executionModel,'proxy-pthread');assert.equal(report.recipe.patches.length,28);
 assert.equal(report.execution.lifecycleAbi,1);assert.equal(report.lifecyclePatch.abi,1);
 assert.equal(report.runtimeAbi,undefined);assert.equal(report.workerPatch,undefined);
 const quit=report.recipe.patches.filter(record=>record.patchId===RUNTIME_PROPERTIES_QUIT_PATCH);
 assert.equal(quit.length,1);assert.equal(quit[0].path,'scene/main/scene_tree.h');
 assert.equal(report.lifecyclePatch.files[quit[0].path].sha256,quit[0].afterSha256);
 assert.equal(report.godotSource.inputs[quit[0].path],quit[0].afterSha256);
 assert.match(await readFile(join(built,quit[0].path),'utf8'),/bool godotjs_is_quit_requested\(\) const \{ return _quit; \}/);
 assert(report.recipe.args.includes('threads=yes'));assert(report.recipe.args.includes('proxy_to_pthread=yes'));
 assert(report.recipe.patches.some(item=>item.patchId==='godotjs-audio-server-finish-v1'));
});
