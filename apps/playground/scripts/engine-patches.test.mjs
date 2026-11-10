import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildBrowserEngine} from '../../../scripts/test/build-browser-engine.mjs';
import {applyWebEnginePatches} from '../../../scripts/release/patch-web-engine.mjs';
import {digest} from '../../../scripts/release/web-release-utils.mjs';

async function fixture(root){
 const sources={
  SConstruct:'# source-only fixture',
  'drivers/gles3/shaders/scene.glsl':'out highp vec3 vertex_interp;\nvoid main() {\n\tgl_PointSize = point_size;\n}\n#[fragment]\nin highp vec3 vertex_interp;\nvoid main() {\n#CODE : FRAGMENT\n#endif // !USE_SHADOW_TO_OPACITY\n}\n',
  'servers/rendering/renderer_rd/shaders/scene_forward_aa_inc.glsl':'#ifdef ALPHA_HASH_USED\nhalf compute_alpha_hash_threshold(vec3 pos, float scale) { return half(0.5); }\n#endif // ALPHA_HASH_USED\n',
  'drivers/gles3/storage/texture_storage.cpp':'void TextureStorage::_create_render_target_backbuffer(RenderTarget *rt) {\nint count = MAX(1, Image::get_image_required_mipmaps(width, height, format) - 4);\n\tif (rt->size.x > 40 && rt->size.y > 40) { allocate(); }\n}\nvoid TextureStorage::_clear_render_target(RenderTarget *rt) {}',
  'scene/main/viewport.cpp':'tooltip_owner->add_child(gui.tooltip_popup);',
  'platform/web/js/libs/library_godot_os.js':'navigator.serviceWorker.getRegistration().then(GodotPWA.updateState.bind(null, cb));',
  'platform/web/js/libs/library_godot_audio.js':await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-audio.js',import.meta.url),'utf8'),
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
 assert.equal(report.status,'snapshotted');assert.equal(report.recipe.patches.length,5);
 assert.deepEqual(report.recipe.patches,localPatches);
 for(const patch of localPatches){
  assert.equal(patch.changed,true);assert.match(patch.implementation.sha256,/^[a-f0-9]{64}$/);
  assert.equal(digest(await readFile(join(built,patch.path))),patch.afterSha256);
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
