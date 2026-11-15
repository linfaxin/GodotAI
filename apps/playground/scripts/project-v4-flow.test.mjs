import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProject,exportProject,newEngineProject,projectCompileRequest,projectStorageDocument,renameProjectFile} from '../src/project-model.ts';
import {compileEngineProject} from '../src/engine-project.ts';
import {createProjectStorage} from '../src/project-storage.ts';
import {defaultProject} from '../src/project-templates.ts';
import {database} from './project-storage-fixture.mjs';
import {createImportReceipt} from '@godot-js/project-tools/import-receipts';
import {createBrowserResourceConverters} from '@godot-js/project-tools/resource-converters';

const original=()=>({schemaVersion:4,runtime:'engine',engineProfile:'full-engine-v1',launch:{kind:'script',module:'res://src/start.ts',export:'start'},files:{
 '/src/start.ts':'export function start(ctx:any){return()=>{}}',
 '/project.godot':'[application]\nrun/main_scene="res://stale-old-main.tscn"\n',
 '/asset.bin':[0,255,128],'/README.md':'original notes',
},editor:{selected:'/src/start.ts',mode:'development',customEditorSetting:{keep:true}},customMetadata:{retain:'yes'}});
const packedText=(result,path)=>{const item=result.index[path];assert(item,path);return new TextDecoder().decode(result.pack.slice(item.offset,item.offset+item.size));};

test('schema4 resource recipes reach the product compiler with original files and converter receipts intact',async()=>{
 const wav=[...Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACA/w==','base64')];
 const source={...original(),resourceImports:[{resource:'res://assets/tone.wav',converter:'godotjs/wav-pcm'}]};source.files['/assets/tone.wav']=wav;
 const project=parseProject(source),request=projectCompileRequest(project);assert.deepEqual(request.resourceImports,[{resource:'res://assets/tone.wav',converter:'godotjs/wav-pcm',parameters:{}}]);
 const options={...request,files:project.files,resourceConverters:createBrowserResourceConverters(),resourceTarget:{resourceAbi:'godot-4-text-resource-v1',features:{engineId:'actual-engine'}}};
 const artifact=await compileEngineProject(options);assert.equal(artifact.receipt.imports[0].converter.id,'godotjs/wav-pcm');assert.equal(artifact.receipt.imports[0].target.features.engineId,'actual-engine');assert.match(packedText(artifact,'res://assets/tone.wav.import'),/AudioStreamWAV/);
 assert(artifact.overlay.some(item=>item.disposition==='generated'&&item.reason.includes('godotjs/wav-pcm')));assert.deepEqual(exportProject(project).files,source.files);assert.deepEqual(exportProject(project).resourceImports,source.resourceImports);
 const edited=structuredClone(project);edited.files['/assets/tone.wav'][45]=64;const changed=await compileEngineProject({...options,files:edited.files});assert.notEqual(changed.buildKey,artifact.buildKey);assert.notDeepEqual(changed.receipt.imports[0].outputs,artifact.receipt.imports[0].outputs);
 await assert.rejects(compileEngineProject({...options,resourceImports:[{resource:'res://assets/tone.wav',converter:'editor-only'}]}),error=>error.diagnostics?.some(item=>item.code==='E_RESOURCE_CONVERTER'));
 await assert.rejects(compileEngineProject({...request,files:project.files}),error=>error.diagnostics?.some(item=>item.code==='E_RESOURCE_CONVERTER'));
 const storage=createProjectStorage(Promise.resolve(database({selected:'new',projects:[],versions:{}})));storage.stage('new',project);await storage.save('new');assert.deepEqual(projectCompileRequest(new Map((await storage.load()).snapshot.projects).get('new')),request);
});

test('schema4 import/edit/compile/export preserves explicit startup and the original document',async()=>{
 const document=original(),saved=structuredClone(document),view=parseProject(document);
 assert.equal(view.schemaVersion,3);assert.equal(view.runtime,'godot');assert.equal(view.engineDocument.kind,'godotjs-schema4-view');assert.equal(view.entry,'/src/start.ts');assert.equal(view.mainScene,undefined);
 document.files['/asset.bin'][0]=99;
 view.files['/src/start.ts']='export function start(ctx:any){ console.log("edited"); return()=>{} }';view.selected='/README.md';view.mode='production';
 const request=projectCompileRequest(view);assert.equal(request.runtime,'engine');assert.equal(request.launch.kind,'script');
 const artifact=await compileEngineProject({...request,files:view.files});
 assert.match(packedText(artifact,'res://.playground/engine-bootstrap.ts'),/Script entry must export a start function/);
 assert.match(packedText(artifact,'res://project.godot'),/engine-bootstrap.tscn/);assert(artifact.receipt.packSha256);
 const exported=exportProject(view);assert.equal(exported.schemaVersion,4);assert.equal(exported.runtime,'engine');assert.deepEqual(exported.launch,saved.launch);
 assert.equal(exported.files['/project.godot'],saved.files['/project.godot']);assert.deepEqual(exported.files['/asset.bin'],[0,255,128]);assert.equal(exported.customMetadata.retain,'yes');assert.equal(exported.editor.customEditorSetting.keep,true);
 assert.equal(exported.editor.selected,'/README.md');assert.equal(exported.editor.mode,'production');assert.match(exported.files['/src/start.ts'],/edited/);
 assert.deepEqual(exportProject(view,'original'),saved);
 const importedAgain=parseProject(JSON.parse(JSON.stringify(exported)));assert.deepEqual(projectCompileRequest(importedAgain),request);assert.match(importedAgain.files[view.entry],/edited/);
});

test('explicit new-project entry and script renaming remain ordinary start functions',async()=>{
 const project=newEngineProject();assert.equal(projectCompileRequest(project).runtime,'engine');
 assert(renameProjectFile(project,'/src/start.ts','/src/renamed.ts'));
 assert.equal(project.entry,'/src/renamed.ts');assert.equal(projectCompileRequest(project).launch.module,'res://src/renamed.ts');
 const artifact=await compileEngineProject({...projectCompileRequest(project),files:project.files});
 assert.match(packedText(artifact,'res://.playground/engine-bootstrap.ts'),/renamed.js/);
 assert.equal(exportProject(project).launch.module,'res://src/renamed.ts');assert.equal(exportProject(project,'original').launch.module,'res://src/start.ts');
});

test('scene launch stays authoritative and follows project edits without changing the preserved UID text',async()=>{
 const uid='uid://bb',document={...original(),launch:{kind:'scene',source:'project'},files:{
  '/project.godot':'[application]\nrun/main_scene="'+uid+'"\n',
  '/scenes/one.tscn':'[gd_scene format=3 uid="'+uid+'"]\n[node name="One" type="Node"]\n',
  '/scenes/two.tscn':'[gd_scene format=3]\n[node name="Two" type="Node"]\n',
 }};
 const view=parseProject(document);assert.equal(view.entry,'');assert.equal(view.mainScene,'res://scenes/one.tscn');
 const artifact=await compileEngineProject({...projectCompileRequest(view),files:view.files});
 assert.equal(packedText(artifact,'res://project.godot'),document.files['/project.godot']);
 view.files['/project.godot']='[application]\nrun/main_scene="res://scenes/two.tscn"\n';
 const refreshed=parseProject(view);assert.equal(refreshed.mainScene,'res://scenes/two.tscn');assert.deepEqual(exportProject(refreshed).launch,{kind:'scene',source:'project'});
});

test('new format rejects conflicting/missing launch and keeps established schemas unchanged',()=>{
 for(const changed of [
  {...original(),runtime:'react'},
  {...original(),mainScene:'res://other.tscn'},
  {...original(),launch:{kind:'script',module:'res://src/start.ts',path:'res://other.tscn'}},
  {...original(),launch:{kind:'script',module:'res://src/missing.ts'}},
  {...original(),launch:{kind:'scene',source:'override',path:'res://missing.tscn'}},
 ])assert.throws(()=>parseProject(changed));
 const old=defaultProject('react'),copy=structuredClone(old);assert.equal(parseProject(old).engineDocument,undefined);assert.deepEqual(projectStorageDocument(old),copy);assert.deepEqual(exportProject(old),copy);
});

test('schema4 receipt claims remain unverified and edited source/output bytes stop compilation',async()=>{
 const encode=value=>new TextEncoder().encode(value),source='res://picture.png',output='res://.godot/imported/picture.ctex';
 const receipt=await createImportReceipt({resource:source,sourcePaths:[source],files:new Map([[source,encode('source')]]),outputFiles:new Map([[output,encode('converted')]]),outputPaths:[output],converter:{id:'unregistered-png',version:'1'},target:{resourceAbi:'godot/4.6',features:{}},parameters:{quality:1}});
 const doc={...original(),importReceipts:[receipt],files:{...original().files,'/picture.png':[...encode('source')],'/.godot/imported/picture.ctex':[...encode('converted')],'/picture.png.import':'[remap]\npath="'+output+'"\n'}};
 const view=parseProject(doc),request=projectCompileRequest(view);assert.deepEqual(request.importReceipts,[receipt]);
 const initial=await compileEngineProject({...request,files:view.files});assert(initial.diagnostics.some(item=>item.code==='W_ENGINE_IMPORT_UNVERIFIED'));
 for(const changed of [
  {...view.files,'/picture.png':[...encode('changed')]},
  {...view.files,'/.godot/imported/picture.ctex':[...encode('changed')]},
 ])await assert.rejects(compileEngineProject({...request,files:changed}),error=>error.diagnostics?.some(item=>item.code==='E_IMPORT_STALE'));
 assert.deepEqual(exportProject(view).importReceipts,[receipt]);
});

test('schema4 storage saves a protected envelope, reloads the launch, and retains exact original export',async()=>{
 const source=original(),old=defaultProject('react'),initial={selected:'new',projects:[['old',old],['new',source]],versions:{old:2,new:1}};
 const db=database(initial),storage=createProjectStorage(Promise.resolve(db)),loaded=await storage.load();
 assert.deepEqual(db.records.get('current'),initial);assert.deepEqual(loaded.migrated,[]);
 const project=new Map(loaded.snapshot.projects).get('new');project.files['/README.md']='edited';storage.stage('new',project);
 assert.deepEqual((await storage.save('new')).conflicts,[]);
 const stored=new Map(db.records.get('current').projects);assert.equal(stored.get('new').schemaVersion,4);assert.equal(stored.get('new').kind,'godotjs-editor-schema4');assert.deepEqual(stored.get('old'),old);
 const reloaded=new Map((await storage.load()).snapshot.projects).get('new');assert.equal(projectCompileRequest(reloaded).runtime,'engine');assert.equal(reloaded.files['/README.md'],'edited');assert.deepEqual(exportProject(reloaded,'original'),source);
});

test('schema4 interrupted saves, conflicting tabs and invalid recovery never replace project data',async()=>{
 const source=original(),initial={selected:'new',projects:[['new',source]],versions:{new:1}},db=database(initial),first=createProjectStorage(Promise.resolve(db)),second=createProjectStorage(Promise.resolve(db));
 first.remember(initial);second.remember(initial);
 const one=parseProject(source);one.files['/README.md']='first';first.stage('new',one);db.abortNext=true;
 await assert.rejects(first.save('new'),/injected/);assert.deepEqual(db.records.get('current'),initial);assert.equal(first.hasPending('new'),true);
 await first.save('new');const committed=structuredClone(db.records.get('current'));
 const two=parseProject(source);two.files['/README.md']='second';second.stage('new',two);assert.deepEqual((await second.save('new')).conflicts,['new']);assert.deepEqual(db.records.get('current'),committed);
 await assert.rejects(first.restore({projects:[['new',{...source,launch:{kind:'script',module:'res://missing.ts'}}]]}));assert.deepEqual(db.records.get('current'),committed);
 const restored=await first.restore(initial);assert(restored.snapshot);const view=parseProject(restored.snapshot.projects[0][1]);assert.equal(view.files['/README.md'],'original notes');assert.deepEqual(exportProject(view,'original'),source);assert.deepEqual(db.records.get('recovery'),committed);
});
