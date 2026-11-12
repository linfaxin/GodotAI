import test from 'node:test';
import assert from 'node:assert/strict';
import {ENGINE_PROFILES,getEngineProfile,engineBuildArgs,validateEngineProfile} from '../../../scripts/release/engine-profiles.mjs';

test('official profiles reject unknown identities and keep native 2D distinct from legacy',()=>{
 assert.throws(()=>getEngineProfile('game-2d-v1'),/E_ENGINE_PROFILE/);
 assert.throws(()=>getEngineProfile('__proto__'),/E_ENGINE_PROFILE/);
 const two=getEngineProfile('engine-2d-v1');
 assert.equal(two.runtimeFamily,'native');assert.equal(two.audio,true);
 assert.deepEqual(two.demoIds,['shader','lights','match3','dungeon']);
 assert.equal(getEngineProfile().id,'full-engine-v1');
});
test('local and CI args use explicit size optimization, target and optional LTO',()=>{
 const args=engineBuildArgs({profile:'engine-2d-v1',target:'template_release',lto:'thin',jobs:3});
 for(const flag of ['disable_3d=yes','disable_physics_3d=yes','disable_navigation_3d=yes','disable_xr=yes','modules_enabled_by_default=yes','target=template_release','lto=thin','linkflags=-Wl,--thinlto-jobs=3','optimize=size','-j3'])assert.ok(args.includes(flag),flag);
 assert.equal(engineBuildArgs({lto:'none',jobs:4}).some(flag=>flag.startsWith('linkflags=')),false);
 assert.ok(engineBuildArgs({profile:'engine-2d-v1',moduleMode:'explicit'}).includes('module_basis_universal_enabled=yes'));
 assert.throws(()=>engineBuildArgs({target:'editor'}),/E_BROWSER_TARGET/);
 assert.throws(()=>engineBuildArgs({jobs:0}),/E_BROWSER_JOBS/);
});
test('actual modules, features and classes must prove the requested profile',()=>{
 const two=ENGINE_PROFILES['engine-2d-v1'];
 const evidence={modules:[...two.modules],features:{...two.features},classes:[...two.requiredClasses,'Vector3','Transform3D']};
 assert.equal(validateEngineProfile(two.id,evidence),two);
 assert.throws(()=>validateEngineProfile(two.id,{...evidence,modules:evidence.modules.filter(name=>name!=='regex')}),/E_ENGINE_MODULES/);
 assert.throws(()=>validateEngineProfile(two.id,{...evidence,modules:[...evidence.modules,'gltf']}),/E_ENGINE_MODULES/);
 assert.throws(()=>validateEngineProfile(two.id,{...evidence,modules:[...evidence.modules,'untracked_module']}),/E_ENGINE_MODULES/);
 assert.doesNotThrow(()=>validateEngineProfile(two.id,{...evidence,modules:[...evidence.modules,'objectdb_profiler']}));
 assert.throws(()=>validateEngineProfile(two.id,{...evidence,classes:[...evidence.classes,'Node3D']}),/E_ENGINE_CLASSES/);
 assert.throws(()=>validateEngineProfile(two.id,{...evidence,features:{...evidence.features,disable_3d:false}}),/E_ENGINE_FEATURES/);
});
