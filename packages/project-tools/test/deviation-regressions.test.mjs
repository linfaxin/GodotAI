import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtifactIdentity} from '@godot-js/engine/identities';
import {createSourceSnapshot,createBuildPlan,prepareBuildPlan,packPreparedProject,packBuildPlan} from '../dist/build-plan.js';
import {prepareEngineProject,EngineProjectBuildError} from '../dist/engine-project.js';
import {hashBytes} from '../dist/hash.js';
import {readProjectDocument,writeProjectDocument} from '../dist/project-document.js';
import {inventoryImportCaches,createImportCacheObservations,parseImportCacheObservations,assessLegacyImportCaches,parseImportReceipt} from '../dist/import-receipts.js';
import {createBrowserResourceConverters} from '../dist/resource-converters.js';
import {prepareResourceUidCache,resolveResourceUidFromCache} from '../dist/resource-uids.js';

const enc=new TextEncoder(),dec=new TextDecoder();
const source=()=>({'/start.ts':'export function start(){}','/asset.bin':[1,2,3]});
const launch={kind:'script',module:'/start.ts'};
const planFor=async files=>createBuildPlan(await createSourceSnapshot(files),launch);
const wav=()=>[...Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACA/w==','base64')];
const legacy=()=>({...source(),'/tone.wav':wav(),'/tone.wav.import':'[params]\npath="res://unrelated.tres"\n[remap]\ntype="AudioStreamWAV"\npath="res://.godot/imported/tone.tres"\n','/.godot/imported/tone.tres':'[gd_resource type="AudioStreamWAV" format=3]\n[resource]\nformat=0\nmix_rate=8000\ndata=PackedByteArray(0,127)\n'});
const mapFor=files=>new Map(Object.entries(files).map(([path,value])=>['res:/'+path,typeof value==='string'?enc.encode(value):Uint8Array.from(value)]));

test('overlay exposes owned copies through every byte accessor and packing rejects forged stale audits',async()=>{
 const plan=await planFor(source()),prepared=await prepareBuildPlan(plan),overlay=prepared.overlay;
 overlay.files.get('res://asset.bin')[0]=9;
 for(const bytes of overlay.files.values())bytes.fill(255);
 for(const [,bytes]of overlay.files.entries())bytes.fill(254);
 for(const [,bytes]of overlay.files)bytes.fill(253);
 overlay.files.forEach(bytes=>bytes.fill(252));
 assert.equal(overlay.files.set,undefined);assert.throws(()=>prepared.overlay={files:new Map(),entries:[]},TypeError);
 const packed=await packPreparedProject(prepared),reference=await packBuildPlan(plan),entry=packed.index['res://asset.bin'];
 assert.deepEqual([...packed.pack.slice(entry.offset,entry.offset+entry.size)],[1,2,3]);assert.equal(packed.plan.buildKey,reference.plan.buildKey);assert.equal(packed.receipt.artifactId,reference.receipt.artifactId);
 for(const output of packed.receipt.outputs){if(!output.outputHash)continue;const index=packed.index[output.path];assert.equal(output.outputHash,await hashBytes(packed.pack.slice(index.offset,index.offset+index.size)));}
 const forged=new Map(overlay.files);forged.get('res://asset.bin')[0]=9;
 await assert.rejects(packPreparedProject({...prepared,overlay:{...overlay,files:forged}}),/E_PROJECT_OVERLAY/);
 const removed=new Map(overlay.files);removed.delete('res://asset.bin');await assert.rejects(packPreparedProject({...prepared,overlay:{...overlay,files:removed}}),/E_PROJECT_OVERLAY/);
 const vendor=enc.encode('exports.ok=true;'),originalVendor=vendor.slice(),options={vendor};
 const pending=prepareBuildPlan(plan,{compilerOptions:options});vendor.fill(0);options.vendor=enc.encode('different');
 const isolated=await pending;assert.deepEqual(isolated.prepared.files.get('res://.playground/vendor.js'),originalVendor);assert.equal(isolated.plan.inputs.compilation.options.vendor,await hashBytes(originalVendor));
});

test('outer schema2 artifact identity binds the exact final body without entering its own pack',async()=>{
 const plan=await planFor(source()),prepared=await prepareBuildPlan(plan),options={engineVersion:[4,6,1]};
 const pending=packPreparedProject(prepared,options);options.engineVersion[2]=99;
 const packed=await pending,{artifactId,...body}=packed.receipt;
 assert.equal(body.schemaVersion,2);assert.equal(artifactId,await createArtifactIdentity(body));assert.equal(body.packSha256,await hashBytes(packed.pack));assert.equal(new DataView(packed.pack.buffer).getUint32(16,true),1);
 assert(!dec.decode(packed.pack).includes(artifactId));assert(!Object.keys(packed.index).some(path=>path.endsWith('artifact-receipt.json')));
 const changed=await packBuildPlan(await planFor({...source(),'/asset.bin':[1,2,4]}));assert.notEqual(changed.receipt.artifactId,artifactId);
 assert.notEqual(await createArtifactIdentity({...body,outputs:body.outputs.map((value,index)=>index===0?{...value,reason:'different audit reason'}:value)}),artifactId);
});

test('old cache inventory is unverified; known edits reject until an executable converter rebuilds it',async()=>{
 const files=legacy(),baseline=createImportCacheObservations(files),plan=await planFor(files),first=await prepareBuildPlan(plan,{importCacheObservations:baseline});
 assert.deepEqual(inventoryImportCaches(mapFor(files))[0].outputs,['res://.godot/imported/tone.tres']);
 assert.equal(first.imports[0].status,'unverified');assert.equal(first.prepared.diagnostics.filter(item=>item.code==='W_ENGINE_IMPORT_UNVERIFIED').length,1);
 assert.equal(assessLegacyImportCaches(mapFor(files))[0].status,'unverified');assert.equal(assessLegacyImportCaches(mapFor(files),baseline)[0].status,'unverified');
 assert.throws(()=>parseImportReceipt(baseline[0]),/receipt/i);assert.throws(()=>parseImportCacheObservations([{...baseline[0],files:baseline[0].files.map(file=>({...file,bytes:-1}))}]),/fingerprint/);
 for(const edit of [
  value=>{value['/tone.wav'][45]=64;},
  value=>{value['/.godot/imported/tone.tres']+='; external cache edit';},
  value=>{value['/tone.wav.import']+='\n[params]\nresample=true\n';},
 ]){const changed=structuredClone(files);edit(changed);await assert.rejects(prepareBuildPlan(await planFor(changed),{importCacheObservations:baseline}),/E_IMPORT_STALE/);}
 const edited=structuredClone(files);edited['/tone.wav'][45]=64;
 const rebuilt=await packBuildPlan(await planFor(edited),{importCacheObservations:baseline,resourceImports:[{resource:'res://tone.wav',converter:'godotjs/wav-pcm'}],resourceConverters:createBrowserResourceConverters(),resourceTarget:{resourceAbi:'godot-4-text-resource-v1',features:{}}});
 assert.equal(rebuilt.imports[0].status,'fresh');assert(!rebuilt.prepared.diagnostics.some(item=>item.code==='W_ENGINE_IMPORT_UNVERIFIED'));
 const output=rebuilt.receipt.imports[0].outputs.find(file=>file.path.endsWith('.tres')).path;
 assert.match(dec.decode(rebuilt.prepared.files.get(output)),/PackedByteArray\(0,192\)/);assert.deepEqual(files['/tone.wav'],wav());
 const sync=prepareEngineProject({files,runtime:'engine',launch});assert(sync.diagnostics.some(item=>item.code==='W_ENGINE_IMPORT_UNVERIFIED'));
 const custom={...source(),'/source.custom':[1],'/source.custom.import':'[remap]\npath="res://.godot/imported/custom.res"\n','/.godot/imported/custom.res':[2]};
 assert(prepareEngineProject({files:custom,runtime:'engine',launch}).diagnostics.some(item=>item.file==='res://source.custom'&&item.code==='W_ENGINE_IMPORT_UNVERIFIED'));
 delete custom['/source.custom'];assert(prepareEngineProject({files:custom,runtime:'engine',launch}).diagnostics.some(item=>item.file==='res://source.custom'&&item.code==='W_ENGINE_IMPORT_UNVERIFIED'));
});

test('converter and native UID inventory use remap section and the final ConfigFile assignment',async()=>{
 const metadata='[params]\nuid="uid://cc"\n[remap]\nuid="uid://old"\n[params]\nuid="uid://dd"\n[remap]\nuid="uid://bb" ; authoritative\n';
 const files=new Map([['res://tone.wav',Uint8Array.from(wav())],['res://tone.wav.import',enc.encode(metadata)]]),index=prepareResourceUidCache(files);
 assert.equal(resolveResourceUidFromCache('uid://bb',index.cache),'res://tone.wav');assert.equal(resolveResourceUidFromCache('uid://cc',index.cache),undefined);assert.equal(resolveResourceUidFromCache('uid://old',index.cache),undefined);
 const converted=await createBrowserResourceConverters().run([{resource:'res://tone.wav',converter:'godotjs/wav-pcm'}],files,{resourceAbi:'godot-4-text-resource-v1',features:{}});
 assert.equal(converted.receipts[0].uid,'uid://bb');assert.match(dec.decode(converted.files.get('res://tone.wav.import')),/uid="uid:\/\/bb"/);assert.equal(dec.decode(files.get('res://tone.wav.import')),metadata);
});

test('all direct plan and synchronous compiler entry points reject mixed launch fields',async()=>{
 const files=source(),snapshot=await createSourceSnapshot(files);
 for(const invalid of [{...launch,path:'res://scene.tscn'},{kind:'scene',source:'project',module:'/start.ts'},{kind:'scene',source:'project',path:'res://scene.tscn'},null]){
  await assert.rejects(createBuildPlan(snapshot,invalid),/launch|mutually exclusive/i);
  assert.throws(()=>prepareEngineProject({runtime:'engine',files,launch:invalid}),error=>error instanceof EngineProjectBuildError&&error.diagnostics[0].code==='E_PROJECT_LAUNCH');
 }
});

test('schema4 metadata survives the neutral reader/writer alongside normalized known fields',async()=>{
 const document={schemaVersion:4,runtime:'engine',engineProfile:'full-engine-v1',launch,files:source(),customMetadata:{plugins:[{name:'future-tool',settings:{enabled:true}}]},futureField:[1,null,'value']};
 const read=await readProjectDocument(document);document.customMetadata.plugins[0].settings.enabled=false;
 const written=JSON.parse(await writeProjectDocument(read.document));assert.equal(written.customMetadata.plugins[0].settings.enabled,true);assert.deepEqual(written.futureField,[1,null,'value']);assert.deepEqual(written.files,source());
 const again=await readProjectDocument(written);assert.deepEqual(again.document,written);
});
