import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BROWSER_ASSET_CAPABILITIES,compileAssets,decodeBrowserImage} from '../dist/assets.js';

const encode=value=>new TextEncoder().encode(value);
const text=bytes=>new TextDecoder().decode(bytes);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Actual browser-produced 2x1 PNG, also read by the native WASM browser probe.
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4AWL6z8Dwn6HhvwMAAAD//42RXTgAAAAGSURBVAMAEMwDwM6HwqYAAAAASUVORK5CYII=','base64'));
const jpeg=new Uint8Array([255,216,255,224,0,2,255,217]);
function snapshot(assets,files){return{revision:'r1',sourceHash:'source',files:new Map(Object.entries(files).map(([path,value])=>[path,typeof value==='string'?encode(value):value])),config:{schemaVersion:1,entry:'src/App.tsx',dependencies:{},mode:'production',profileId:'core-ui-v1',assets}};}
const options={generation:'generation-1',decodeImage:async()=>({width:2,height:1,rgba:new Uint8Array([255,0,0,255,0,128,255,64])})};

test('PNG is decoded into Godot ImageTexture with the actual native Image.data dictionary',async()=>{
  let received;
  const source=snapshot({logo:{source:'/assets/logo.png',type:'Texture2D'}},{'/assets/logo.png':png});
  const result=await compileAssets(source,{...options,decodeImage:async(bytes,mime,init)=>{received={bytes,mime,init};return options.decodeImage();}});
  assert.equal(received.mime,'image/png');assert.deepEqual(received.bytes,png);
  const resource=result.resources.logo,output=result.files.get(resource.uri),body=text(output);
  assert.match(body,/^\[gd_resource type="ImageTexture" load_steps=2 format=3\]/);
  assert.match(body,/\[sub_resource type="Image" id="Image_asset"\]/);
  assert.match(body,/data = \{\n"data": PackedByteArray\(255,0,0,255,0,128,255,64\),/);
  assert.match(body,/"format": "RGBA8"/);assert.match(body,/"height": 1/);assert.match(body,/"width": 2/);assert.match(body,/"mipmaps": false/);
  assert.match(body,/image = SubResource\("Image_asset"\)/);
  assert(!body.includes('ExtResource('));assert(!body.includes('script'));
  assert.equal(resource.type,'Texture2D');assert.equal(resource.sha256,sha(output));
  assert.deepEqual(resource.importedArtifacts,[resource.uri]);
  assert.equal(result.sourceHashes['res://assets/logo.png'],sha(png));
  assert.deepEqual(result.sourceOrigins[resource.uri],{source:'res://assets/logo.png',line:0,column:0});
  assert(!result.files.has('res://assets/logo.png'));
});

test('JPEG uses browser decoder contract; duplicate source aliases share a sealed artifact',async()=>{
  let mime;
  const result=await compileAssets(snapshot({a:{source:'assets/a.jpg',type:'Texture2D'},b:{source:'res://assets/a.jpg',type:'Texture2D'}},{'/assets/a.jpg':jpeg}),{...options,decodeImage:async(_bytes,value)=>{mime=value;return options.decodeImage();}});
  assert.equal(mime,'image/jpeg');assert.equal(result.files.size,1);assert.equal(result.resources.a.uri,result.resources.b.uri);
});

test('allowlisted material and shapes are re-emitted from parsed values without scripts or stale UIDs',async()=>{
  const fixtures={
    '/assets/material.tres':'[gd_resource type="CanvasItemMaterial" format=3 uid="uid://old"]\n\n[resource]\nresource_name = "snow\\\"man"\nblend_mode = 1\nlight_mode = 2\nparticles_animation = true\nparticles_anim_h_frames = 4\nparticles_anim_v_frames = 2\nparticles_anim_loop = false\n',
    '/assets/rectangle.tres':'[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(8, 12)\n',
    '/assets/circle.tres':'[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = 4.5\n',
    '/assets/capsule.tres':'[gd_resource type="CapsuleShape2D" format=3]\n[resource]\nradius = 3\nheight = 8\n',
    '/assets/resource.tres':'[gd_resource type="Resource" format=3]\n[resource]\nresource_local_to_scene = false\n',
  };
  const assets=Object.fromEntries(Object.entries(fixtures).map(([source,body])=>[source.split('/').at(-1).split('.')[0],{source,type:/type="([^"]+)"/.exec(body)[1]}]));
  const result=await compileAssets(snapshot(assets,fixtures),options);
  assert.equal(result.files.size,5);
  for(const[id,resource]of Object.entries(result.resources)) {
    const output=result.files.get(resource.uri);assert.equal(resource.sha256,sha(output));assert(!text(output).includes('uid://'));assert(!text(output).includes('script'));
    assert.equal(resource.type,assets[id].type);
  }
  assert.match(text(result.files.get(result.resources.rectangle.uri)),/size = Vector2\(8, 12\)/);
});

test('external resource closure is frozen recursively and references only generated artifacts',async()=>{
  const result=await compileAssets(snapshot({base:{source:'/assets/base.tres',type:'Resource'}},{
    '/assets/base.tres':'[gd_resource type="Resource" load_steps=2 format=3]\n[ext_resource type="CircleShape2D" path="res://assets/circle.tres" id="shape"]\n[resource]\nresource_name = "base"\n',
    '/assets/circle.tres':'[gd_resource type="CircleShape2D" format=3]\n[resource]\nradius = 5\n',
  }),options);
  assert.equal(Object.keys(result.resources).length,2);assert.equal(result.files.size,2);
  const base=result.resources.base,child=result.resources[base.dependencies[0]];
  assert(child);assert.match(text(result.files.get(base.uri)),new RegExp(child.uri.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert(!text(result.files.get(base.uri)).includes('path="res://assets/circle.tres"'));
});

test('arbitrary scene imports are rejected with prevalidated native template requirement',async()=>{
  for(const[source,type,body]of [['/assets/scene.tscn','PackedScene','[gd_scene format=3]'],['/assets/raw.tscn','Resource','[gd_scene format=3]']])
    await assert.rejects(compileAssets(snapshot({scene:{source,type}},{[source]:body}),options),error=>error.code==='E_TEMPLATE_PREVALIDATION_REQUIRED'&&error.message.includes('SceneState'));
});

test('self-declared prevalidated packages cannot enable the disabled template capability',async()=>{
  assert.equal(BROWSER_ASSET_CAPABILITIES.templates,false);
  assert.equal(BROWSER_ASSET_CAPABILITIES.prevalidatedTemplatePackages,false);
  const scene=encode('[gd_scene format=3]\n[node name="Root" type="Node"]\n');
  const forged={schemaVersion:1,runtimeRelease:'fixture-release',profileId:'core-ui-v1',sourceHashes:{'res://assets/scene.tscn':sha(scene)},plan:{schemaVersion:1,assetId:'scene',nodes:[],resources:[]},certification:{kind:'godot-native-scene-state-v1',engineTarget:'web',certificateSha256:sha(scene)}};
  await assert.rejects(compileAssets(snapshot({scene:{source:'/assets/scene.template.json',type:'PackedScene'}},{'/assets/scene.template.json':JSON.stringify(forged),'/assets/scene.tscn':scene}),options),error=>error.code==='E_TEMPLATE_PREVALIDATION_REQUIRED'&&error.message.includes('self-declared certificates'));
  // A native resource cannot smuggle a PackedScene dependency into the closure.
  const root='[gd_resource type="Resource" format=3]\n[ext_resource type="PackedScene" path="res://assets/scene.template.json" id="scene"]\n[resource]\n';
  await assert.rejects(compileAssets(snapshot({root:{source:'/assets/root.tres',type:'Resource'}},{'/assets/root.tres':root,'/assets/scene.template.json':JSON.stringify(forged)}),options),error=>error.code==='E_TEMPLATE_PREVALIDATION_REQUIRED');
});

test('indirect resource scripts are rejected throughout the closed graph',async()=>{
  const root='[gd_resource type="Resource" format=3]\n[ext_resource type="Resource" path="res://assets/child.tres" id="child"]\n[resource]\n';
  const child='[gd_resource type="Resource" format=3]\n[ext_resource type="Script" path="res://assets/evil.gd" id="evil"]\n[resource]\n';
  await assert.rejects(compileAssets(snapshot({root:{source:'/assets/root.tres',type:'Resource'}},{'/assets/root.tres':root,'/assets/child.tres':child,'/assets/evil.gd':'extends Resource\nfunc _init():\n push_error("MUST_NOT_EXECUTE")\n'}),options),error=>error.code==='E_ASSET_SCRIPT');
});

test('resource scripts, unsupported objects, properties, sections and malformed text cannot enter closure',async()=>{
  for(const[body,code]of [
    ['[gd_resource type="Resource" format=3]\n[resource]\nscript = ExtResource("1")\n','E_ASSET_SCRIPT'],
    ['[gd_resource type="Resource" format=3]\n[ext_resource type="Script" path="res://evil.gd" id="1"]\n[resource]\n','E_ASSET_SCRIPT'],
    ['[gd_resource type="Resource" format=3]\n[sub_resource type="GDScript" id="1"]\n[resource]\n','E_ASSET_SECTION'],
    ['[gd_resource type="Resource" format=3]\n[resource]\nmetadata/unsafe = "thing"\n','E_ASSET_PROPERTY'],
    ['[gd_resource type="Resource" format=3]\n[resource]\nresource_name = load("res://evil")\n','E_ASSET_VALUE'],
    ['[gd_resource type="Resource" format=3]\n[resource]\nresource_name = "unterminated','E_ASSET_SYNTAX'],
    ['[gd_resource type="Resource" format=3]\n[resource]\nresource_local_to_scene = true\n','E_ASSET_LOCAL_RESOURCE'],
    ['[gd_resource type="Resource" format=3]\n[resource]\n[resource]\n','E_ASSET_HEADER'],
  ]) await assert.rejects(compileAssets(snapshot({asset:{source:'/assets/a.tres',type:'Resource'}},{'/assets/a.tres':body}),options),error=>error.code===code,code);
});

test('shape/material values, declared types, asset paths and cyclic resources are checked',async()=>{
  for(const[type,property]of [['CircleShape2D','radius = -1'],['RectangleShape2D','size = Vector2(0, 4)'],['CanvasItemMaterial','blend_mode = 5'],['CanvasItemMaterial','particles_animation = 1'],['CapsuleShape2D','height = 1e999']])
    await assert.rejects(compileAssets(snapshot({asset:{source:'/assets/a.tres',type}},{'/assets/a.tres':`[gd_resource type="${type}" format=3]\n[resource]\n${property}\n`}),options),error=>['E_ASSET_PROPERTY','E_ASSET_VALUE'].includes(error.code));
  await assert.rejects(compileAssets(snapshot({asset:{source:'/assets/a.tres',type:'Resource'}},{'/assets/a.tres':'[gd_resource type="CircleShape2D" format=3]\n[resource]\n'}),options),error=>error.code==='E_ASSET_TYPE');
  await assert.rejects(compileAssets(snapshot({asset:{source:'../../evil.tres',type:'Resource'}},{}),options),error=>error.code==='E_ASSET_PATH');
  const cycle='[gd_resource type="Resource" format=3]\n[ext_resource type="Resource" path="res://assets/a.tres" id="self"]\n[resource]\n';
  await assert.rejects(compileAssets(snapshot({asset:{source:'/assets/a.tres',type:'Resource'}},{'/assets/a.tres':cycle}),options),error=>error.code==='E_ASSET_CYCLE');
});

test('decoder output, PNG/JPEG magic, byte budgets and cancellation fail before artifact publication',async()=>{
  const source=snapshot({logo:{source:'/assets/logo.png',type:'Texture2D'}},{'/assets/logo.png':png});
  await assert.rejects(compileAssets(source,{...options,decodeImage:async()=>({width:2,height:1,rgba:new Uint8Array(3)})}),error=>error.code==='E_IMAGE_DATA');
  await assert.rejects(compileAssets(source,{...options,decodeImage:async()=>({width:4097,height:1,rgba:new Uint8Array(0)})}),error=>error.code==='E_IMAGE_BUDGET');
  await assert.rejects(compileAssets(source,{...options,budgets:{maxOutputBytes:10}}),error=>error.code==='E_ASSET_BUDGET');
  await assert.rejects(compileAssets(snapshot({logo:{source:'/assets/logo.png',type:'Texture2D'}},{'/assets/logo.png':encode('not a PNG')}),options),error=>error.code==='E_IMAGE_FORMAT');
  const largePng=png.slice();new DataView(largePng.buffer).setUint32(16,5000);
  const preflightOptions={...options,decodeImage:async()=>{throw Error('Dimension budget must fail before decoder allocation');}};
  await assert.rejects(compileAssets(snapshot({logo:{source:'/assets/logo.png',type:'Texture2D'}},{'/assets/logo.png':largePng}),preflightOptions),error=>error.code==='E_IMAGE_BUDGET');
  const largeJpeg=new Uint8Array([255,216,255,192,0,8,8,0,1,0x13,0x88,0]);
  await assert.rejects(compileAssets(snapshot({logo:{source:'/assets/logo.jpg',type:'Texture2D'}},{'/assets/logo.jpg':largeJpeg}),preflightOptions),error=>error.code==='E_IMAGE_BUDGET');
  const controller=new AbortController();controller.abort();await assert.rejects(compileAssets(source,{...options,signal:controller.signal}),{name:'AbortError'});
  if(typeof globalThis.createImageBitmap!=='function') await assert.rejects(decodeBrowserImage(png,'image/png',{}),error=>error.code==='E_IMAGE_DECODER');
});

test('generation and original snapshot bytes are not writable through the asset result',async()=>{
  const original=png.slice(),source=snapshot({logo:{source:'/assets/logo.png',type:'Texture2D'}},{'/assets/logo.png':original});
  const result=await compileAssets(source,options),first=text(result.files.get(result.resources.logo.uri));
  original.fill(0);assert.equal(text(result.files.get(result.resources.logo.uri)),first);
  await assert.rejects(compileAssets(source,{...options,generation:'../escape'}),error=>error.code==='E_ASSET_GENERATION');
});
