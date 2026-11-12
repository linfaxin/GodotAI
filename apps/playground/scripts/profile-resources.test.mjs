import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {catalog} from '../src/catalog.ts';
import {TWO_D_ASSET_IDS,profileCatalog,assertResourceManifest} from './profile-resources.mjs';
import {prepareAssets} from './prepare-assets.mjs';
import {verifyResourcePack} from './build-demo-runtime.mjs';

test('registered 2D catalog includes all four native 2D examples and full keeps eight',()=>{
 assert.deepEqual(profileCatalog(catalog,'engine-2d-v1').map(d=>d.id),['shader','lights','match3','dungeon']);
 assert.equal(profileCatalog(catalog,'full-engine-v1').length,8);
 assert.throws(()=>profileCatalog(catalog.filter(d=>d.id!=='lights'),'engine-2d-v1'),/catalog/);
 assert.throws(()=>profileCatalog(catalog,'unknown-profile'),/PROFILE/);
});

test('2D resource preparation has an explicit closed asset set and isolated outputs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'2d-resources-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=path.join(root,'export'),workDirectory=path.join(root,'conversion');
 await mkdir(path.join(project,'assets/derived'),{recursive:true});
 await writeFile(path.join(project,'assets/derived','old-3d-model.res'),'stale model');
 const assets=await prepareAssets({runtimeProfile:'engine-2d-v1',project,workDirectory});
 assert.deepEqual(Object.keys(assets).sort(),[...TWO_D_ASSET_IDS].sort());
 const generated=await readFile(path.join(project,'generated/assets.js'),'utf8');
 assert.match(generated,/exports.models = \{\};/);
 const hub=await readFile(path.join(project,'asset-hub.tres'),'utf8');
 assert(!/Mesh|Shape3D|Environment/.test(hub));
 assert(!(await readdir(path.join(project,'assets/derived'))).includes('old-3d-model.res'));
 const receipt=JSON.parse(await readFile(path.join(project,'generated/resource-inputs.json'),'utf8'));
 assert.equal(receipt.runtimeProfile,'engine-2d-v1');assert.equal(receipt.demoApiVersion,1);
 assert.equal(Object.keys(receipt.inputs).length,14); // eight PNGs, three sounds, three shaders
 assert(receipt.inputs['project/shaders/hologram.gdshader']);
 assert.equal(receipt.importer,null);assert.deepEqual(receipt.models,{});
 assertResourceManifest({assets,models:{}},'engine-2d-v1');
 assert.throws(()=>assertResourceManifest({assets:{...assets,model:{uri:'res://assets/model.res',type:'Mesh'}},models:{}},'engine-2d-v1'),/asset set|3D/);
});

test('resource closure rejects missing roots and removed imported/remapped dependencies',()=>{
 const bytes=value=>new TextEncoder().encode(value),assets={image:{uri:'res://assets/image.png',type:'Texture2D'},shader:{uri:'res://assets/shader.tres',type:'ShaderMaterial'}};
 const files=new Map([
  ['res://assets/image.png.import',bytes('[remap]\npath="res://.godot/imported/image.ctex"')],
  ['res://.godot/imported/image.ctex',new Uint8Array([1])],
  ['res://assets/shader.tres.remap',bytes('[remap]\npath="res://.godot/exported/shader.res"')],
  ['res://.godot/exported/shader.res',new Uint8Array([2])],
 ]);
 verifyResourcePack(files,{assets});
 const noCache=new Map(files);noCache.delete('res://.godot/imported/image.ctex');
 assert.throws(()=>verifyResourcePack(noCache,{assets}),/DEPENDENCY_MISSING/);
 const noRemap=new Map(files);noRemap.delete('res://assets/shader.tres.remap');
 assert.throws(()=>verifyResourcePack(noRemap,{assets}),/RESOURCE_MISSING/);
});
