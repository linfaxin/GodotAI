import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProject,filePath,addProjectFiles,renameProjectFile,canRenameProjectFile,exportProject,resolveProjectMainScene,projectProfileMatches} from '../src/project-model.ts';
import {renamedProjectFiles} from '../src/project-rename.ts';
import {defaultProject,demoProject,migrateDemoProject} from '../src/project-templates.ts';
import {resolveResourceUidFromCache,resourceUidTextToId} from '@godot-js/react-build/resource-uids';
import {prepareScriptRename} from '@godot-js/react-build/script-renames';
const input=()=>({schemaVersion:3,engineProfile:'full-engine-v1',runtime:'react',demoId:'shader',entry:'/src/App.tsx',selected:'/README.md',files:{'/src/App.tsx':'export default function App(){return null;}','/README.md':'说明','/assets/image.png':[0,128,255]},controls:{speed:1},mode:'development'});
test('project import round-trips text, binary attachments, selection and runtime settings',()=>{
 const source=input(),project=parseProject(JSON.parse(JSON.stringify(source)));assert.deepEqual(project,source);
 project.files['/assets/image.png'][0]=42;assert.equal(source.files['/assets/image.png'][0],0);
 const legacy=parseProject({files:source.files,config:{entry:'/src/App.tsx',mode:'development'}});assert.equal(legacy.entry,'/src/App.tsx');assert.equal(legacy.mode,'development');
 assert.equal(legacy.schemaVersion,3);assert.equal(legacy.runtime,'react');
 assert.equal(legacy.demoId,'react');
 for(const runtime of ['godot','react'])assert.equal(parseProject({...source,runtime,demoId:undefined}).demoId,runtime==='godot'?'native':'react');
});
test('invalid imports cannot introduce path traversal, duplicate files or a missing entry',()=>{
 for(const value of [{...input(),entry:'/missing.tsx'},{...input(),files:{'/src/../App.tsx':'x'}},{...input(),files:{'src/App.tsx':'x','/src/App.tsx':'y'}},{...input(),files:{...input().files,'/assets/bad.png':[-1]}},{...input(),controls:{speed:Infinity}}])assert.throws(()=>parseProject(value));
 assert.equal(filePath('src/组件.tsx'),'/src/组件.tsx');assert.throws(()=>filePath('src/../../outside.tsx'));
});
test('project file limits reject oversized imports before changing caller data',()=>{
 const source=input();source.files={...source.files,...Object.fromEntries(Array.from({length:65},(_,i)=>['/notes/'+i+'.txt','x']))};const before=JSON.stringify(source);assert.throws(()=>parseProject(source),/64/);assert.equal(JSON.stringify(source),before);
});
test('original exported documents retain source, selection and configuration',()=>{
 const source=input();const {files,selected,entry,mode}=source;
 const project=parseProject({schemaVersion:1,runtimeRelease:'original-release',project:{config:{entry,mode,profileId:'core-ui-v1'},files,selected}});
 assert.deepEqual(project.files,files);assert.equal(project.entry,entry);assert.equal(project.selected,selected);assert.equal(project.mode,mode);
});
test('migration retains exact original exports and attachments across later edits and reimport',()=>{
 const original={schemaVersion:1,runtimeRelease:'old',project:{...input(),schemaVersion:1,config:{profileId:'old-profile'},files:{...input().files,'/project.godot':'[application]\nconfig/name="Keep original"\nrun/main_scene="res://generated/legacy-host.tscn"\n','/assets/scene.scn':[1,2,3]}}};
 const project=parseProject(original);assert.equal(project.runtime,'react');assert.equal(project.schemaVersion,3);
 project.files['/README.md']='edited';project.files['/assets/scene.scn'][0]=9;
 assert.deepEqual(exportProject(project,'original'),original);assert.deepEqual(original.project.files['/assets/scene.scn'],[1,2,3]);
 const reimport=parseProject(exportProject(project));assert.deepEqual(exportProject(reimport,'original'),original);assert.equal(reimport.files['/README.md'],'edited');assert.equal(reimport.runtime,'react');
 assert.equal(reimport.files['/project.godot'],original.project.files['/project.godot']);
});
test('native scripts and scenes are accepted without filtering native resource data',()=>{
 const raw='config_version=5\n[application]\nrun/main_scene="res://world/Main.tscn" ; preserve comment\n[other]\nvalue=42\n';
 const scene='[gd_scene load_steps=1 format=3]\n[node name="Main" type="Node2D"]\n';
 const native={...input(),runtime:'godot',entry:'',selected:'/world/Main.tscn',files:{'/project.godot':raw,'/world/Main.tscn':scene,'/assets/unknown.tres':'[gd_resource type="CustomResource" format=3]\ncustom=true','/assets/native.bin':[0,255]}};
 const parsed=parseProject(native);assert.equal(parsed.mainScene,'res://world/Main.tscn');assert.equal(parsed.mainSceneSource,'project');assert.deepEqual(parsed.files,native.files);assert.equal(parsed.entry,'');
 for(const extension of ['ts','js','tsx','jsx'])assert.equal(parseProject({...input(),runtime:'godot',entry:'/src/main.'+extension,files:{['/src/main.'+extension]:'export default class Main {}'}}).entry,'/src/main.'+extension);
 assert.equal(parseProject({...native,mainScene:'res://world/Other.scn',files:{...native.files,'/world/Other.scn':[1,2,3]}}).mainScene,'res://world/Other.scn');
 assert.throws(()=>parseProject({...native,files:{'/project.godot':raw}}),/主场景/);
 assert.throws(()=>parseProject({...input(),schemaVersion:2,runtime:undefined}),/运行模式/);
 assert.throws(()=>parseProject({...input(),schemaVersion:4}),/版本/);
});
test('project.godot UID main scenes resolve to existing files without config rewrites',()=>{
 const files={'/project.godot':'[application]\nrun/main_scene="uid://native42"\n','/world/Main.tscn':'[gd_scene format=3 uid="uid://native42"]\n[node name="Main" type="Node"]\n'};
 assert.equal(resolveProjectMainScene({files}),'res://world/Main.tscn');
 assert.equal(parseProject({...input(),runtime:'godot',entry:'',files}).files['/project.godot'],files['/project.godot']);
 assert.throws(()=>resolveProjectMainScene({files:{'/project.godot':files['/project.godot']}}),/UID/);
});
test('derived main scene follows edited project.godot and retains authoritative UID text on export',()=>{
 const config=uid=>'[application]\nrun/main_scene="uid://'+uid+'" ; native UID\n';
 const scene=uid=>'[gd_scene format=3 uid="uid://'+uid+'"]\n[node name="Main" type="Node"]\n';
 const project=parseProject({...input(),runtime:'godot',entry:'',files:{'/project.godot':config('first'),'/First.tscn':scene('first'),'/Second.tscn':scene('second')}});
 assert.equal(project.mainScene,'res://First.tscn');assert.equal(project.mainSceneSource,'project');
 project.files['/project.godot']=config('second');
 assert.equal(resolveProjectMainScene(project),'res://Second.tscn');
 const updated=parseProject(project);assert.equal(updated.mainScene,'res://Second.tscn');assert.equal(updated.mainSceneSource,'project');
 const exported=exportProject(project);assert.equal(exported.mainScene,'res://Second.tscn');assert.equal(exported.files['/project.godot'],config('second'));assert.equal(parseProject(exported).mainSceneSource,'project');
 const explicit=parseProject({...project,mainScene:'res://First.tscn',mainSceneSource:undefined});assert.equal(explicit.mainSceneSource,'explicit');assert.equal(explicit.mainScene,'res://First.tscn');
 assert.throws(()=>parseProject({...project,mainSceneSource:'cached'}),/来源/);
 const entryOnly=parseProject({...input(),runtime:'godot',entry:'/Main.ts',files:{'/Main.ts':'export default class Main {}'}});assert.equal(entryOnly.mainScene,undefined);assert.equal(entryOnly.mainSceneSource,undefined);
});
test('binary native main scenes resolve from the original Godot UID cache without rewriting config',()=>{
 const config='config_version=5\n[application]\nrun/main_scene="uid://ebd"\n';
 const cachePath=path=>{const encoded=new TextEncoder().encode(path),bytes=new Uint8Array(16+encoded.length),view=new DataView(bytes.buffer);view.setUint32(0,1,true);view.setBigUint64(4,4661n,true);view.setUint32(12,encoded.length,true);bytes.set(encoded,16);return [...bytes];};
 const files={'/project.godot':config,'/.godot/uid_cache.bin':cachePath('res://native/Main.scn'),'/native/Main.scn':[82,83,82,67,0,1,2]};
 const project=parseProject({...input(),runtime:'godot',entry:'',files});assert.equal(project.mainScene,'res://native/Main.scn');assert.equal(project.mainSceneSource,'project');assert.deepEqual(project.files,files);
 const exported=exportProject(project);assert.equal(exported.files['/project.godot'],config);assert.deepEqual(exported.files['/.godot/uid_cache.bin'],files['/.godot/uid_cache.bin']);assert.equal(parseProject(exported).mainScene,'res://native/Main.scn');
 const explicit=parseProject({...project,mainScene:'uid://ebd',mainSceneSource:'explicit'});assert.equal(explicit.mainSceneSource,'explicit');assert.equal(explicit.mainScene,'res://native/Main.scn');
 assert.throws(()=>parseProject({...project,files:{...files,'/.godot/uid_cache.bin':[1,0,0]}}),/UID/);
 assert.throws(()=>parseProject({...project,files:{...files,'/.godot/uid_cache.bin':cachePath('res://native/Missing.scn')}}),/已有的场景/);
 assert.throws(()=>parseProject({...project,files:{...files,'/.godot/uid_cache.bin':cachePath('res://native/Main.res'),'/native/Main.res':[1,2]}}),/tscn 或 scn/);
});
test('new project templates explicitly opt into native or React engine runtime',()=>{
 const native=defaultProject(),react=defaultProject('react');assert.equal(native.runtime,'godot');assert.equal(react.runtime,'react');
 assert.equal(native.schemaVersion,3);assert.ok(!native.migration);assert.match(native.files[native.entry],/extends Node2D/);
 assert.equal(native.mainScene,'res://main.tscn');assert.match(native.files['/project.godot'],/run\/main_scene="res:\/\/main.tscn"/);assert.match(native.files['/main.tscn'],/path="res:\/\/src\/Main.ts"/);assert.match(native.files['/main.tscn'],/\[node name="Main" type="Node2D"\]/);
 assert.match(react.files[react.entry],/import \{EngineNode\} from "@godot-js\/react\/engine"/);assert.match(react.files[react.entry],/import \{Label\} from "godot"/);assert.match(react.files[react.entry],/<EngineNode ctor=\{Label\} native=\{\{text:"Hello React \+ Godot"\}\}/);
 assert.equal(parseProject(native).entry,native.entry);assert.equal(parseProject(react).entry,react.entry);
});
test('unchanged rename preserves the entry and attachments; invalid renames are atomic',()=>{
 const project={...input(),runtime:'react'},before=structuredClone(project);
 assert.equal(renameProjectFile(project,project.entry,project.entry),false);assert.deepEqual(project,before);
 for(const path of ['/README.md','/src/App.txt']){assert.throws(()=>renameProjectFile(project,project.entry,path));assert.deepEqual(project,before);}
 assert.equal(renameProjectFile(project,project.entry,'src/Renamed.tsx'),true);assert.equal(project.entry,'/src/Renamed.tsx');assert.equal(project.files[project.entry],before.files[before.entry]);assert.ok(!Object.hasOwn(project.files,before.entry));
});
test('asset batches enforce file count, duplicates and total UTF-8 bytes without partial writes',()=>{
 const project=input(),before=structuredClone(project);
 const tooMany=Array.from({length:62},(_,i)=>['/assets/'+i+'.png',[0,128,255]]);
 for(const additions of [tooMany,[['/assets/a.png',[1]],['/assets/a.png',[2]]],[['/assets/a.png',[1]],['/assets/huge.tres','界'.repeat(2796203)]]]){
  assert.throws(()=>addProjectFiles(project,additions));assert.deepEqual(project,before);
 }
 const valid=tooMany.slice(0,61);addProjectFiles(project,valid);assert.equal(Object.keys(project.files).length,64);assert.deepEqual(parseProject(project),project);
});

test('native script renames update scenes, autoloads and sidecars atomically',()=>{
 const project=defaultProject();
 project.files['/src/Main.ts.uid']='uid://mainscript';
 project.files['/project.godot']+='\n[autoload]\nService="*res://src/Main.ts"\n';
 project.files['/nested/Other.tscn']='[gd_scene format=3]\n[ext_resource type="Script" path="../src/Main.ts" id="1"]\n; path="res://src/Main.ts"\n[node name="Other" type="Node"]\ntext="Main.ts"\n';
 assert.equal(renameProjectFile(project,project.entry,'src/Renamed.ts'),true);
 assert.equal(project.entry,'/src/Renamed.ts');
 assert.match(project.files['/main.tscn'],/path="res:\/\/src\/Renamed.ts"/);
 assert.match(project.files['/project.godot'],/Service="\*res:\/\/src\/Renamed.ts"/);
 assert.match(project.files['/nested/Other.tscn'],/path="\.\.\/src\/Renamed.ts"/);
 assert.match(project.files['/nested/Other.tscn'],/; path="res:\/\/src\/Main.ts"/);
 assert.match(project.files['/nested/Other.tscn'],/text="Main.ts"/);
 assert.equal(project.files['/src/Renamed.ts.uid'],'uid://mainscript');
 assert.equal(project.files['/src/Main.ts.uid'],undefined);
 assert.deepEqual(parseProject(project),project);
});
test('moving native scenes rebases relative resources and keeps UID references stable',()=>{
 const project=defaultProject();
 project.files['/main.tscn']='[gd_scene format=3 uid="uid://main"]\n[ext_resource type="Script" path="src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n';
 project.files['/main.tscn.uid']='uid://main';
 project.files['/project.godot']=project.files['/project.godot'].replace('res://main.tscn','uid://main');
 const name=new TextEncoder().encode('res://main.tscn'),cache=new Uint8Array(16+name.length),view=new DataView(cache.buffer);
 view.setUint32(0,1,true);view.setBigUint64(4,resourceUidTextToId('uid://main'),true);view.setUint32(12,name.length,true);cache.set(name,16);
 project.files['/.godot/uid_cache.bin']=[...cache];
 renameProjectFile(project,'/main.tscn','world/Main.tscn');
 assert.equal(project.mainScene,'res://world/Main.tscn');
 assert.match(project.files['/world/Main.tscn'],/path="\.\.\/src\/Main.ts"/);
 assert.match(project.files['/project.godot'],/run\/main_scene="uid:\/\/main"/);
 assert.equal(project.files['/world/Main.tscn.uid'],'uid://main');
 assert.equal(resolveResourceUidFromCache('uid://main',Uint8Array.from(project.files['/.godot/uid_cache.bin'])),'res://world/Main.tscn');
 assert.deepEqual(parseProject(project),project);
 const pathProject=defaultProject();renameProjectFile(pathProject,'/main.tscn','world/世界.tscn');
 assert.equal(pathProject.mainScene,'res://world/世界.tscn');assert.match(pathProject.files['/project.godot'],/res:\/\/world\/世界.tscn/);
});
test('the low-level resource updater preserves import sidecars and byte-encoded references',()=>{
 const project=defaultProject();project.files['/assets/icon.png']=[137,80];
 project.files['/assets/icon.png.import']='[remap]\nuid="uid://icon"\npath="res://.godot/imported/icon.ctex"\n[deps]\nsource_file="res://assets/icon.png"\ndest_files=["res://.godot/imported/icon.ctex"]\n';
 const resource='[gd_resource type="Resource" format=3]\n[ext_resource type="Texture2D" path="res://assets/icon.png" id="1"]\n';
 project.files['/asset.tres']=[...new TextEncoder().encode(resource)];
 project.files=renamedProjectFiles(project.files,'/assets/icon.png','/assets/new.png',true);
 assert.deepEqual(project.files['/assets/new.png'],[137,80]);
 assert.match(project.files['/assets/new.png.import'],/source_file="res:\/\/assets\/new.png"/);
 assert.match(project.files['/assets/new.png.import'],/path="res:\/\/\.godot\/imported\/icon.ctex"/);
 assert.match(new TextDecoder().decode(Uint8Array.from(project.files['/asset.tres'])),/res:\/\/assets\/new.png/);
});
test('unsafe native renames preserve the complete original project',()=>{
 const cases=[
  project=>{project.files['/src/Main.ts.uid']='uid://script';project.files['/src/Renamed.ts.uid']='uid://other';},
  project=>{project.files['/binary.scn']=[82,83,82,67];},
  project=>{project.files['/.godot/uid_cache.bin']=[1,0,0];},
  project=>{project.files['/bad.tres']=[255,255];},
  project=>{project.files['/src/renamed.ts']='collision';},
 ];
 for(const prepare of cases){const project=defaultProject();prepare(project);const before=structuredClone(project);assert.throws(()=>renameProjectFile(project,project.entry,'src/Renamed.ts'));assert.deepEqual(project,before);}
});
test('the low-level resource updater preserves shader comments',()=>{
 const project=defaultProject();project.files['/shaders/common.gdshaderinc']='vec4 colour(){return vec4(1.0);}';
 project.files['/shaders/main.gdshader']='#include "common.gdshaderinc"\n// "res://shaders/common.gdshaderinc"\n/* "res://shaders/common.gdshaderinc" */\nshader_type spatial;';
 project.files=renamedProjectFiles(project.files,'/shaders/common.gdshaderinc','/shared/common.gdshaderinc',true);
 assert.match(project.files['/shaders/main.gdshader'],/#include "\.\.\/shared\/common.gdshaderinc"/);
 assert.match(project.files['/shaders/main.gdshader'],/\/\/ "res:\/\/shaders\/common.gdshaderinc"/);
});

test('prepared script rename edits update incoming and outgoing dependencies as one transaction',()=>{
 const project=defaultProject();project.files[project.entry]='import {Node2D} from "godot";import {value} from "./value";export default class Main extends Node2D {_ready(){console.log(value);}}';project.files['/src/value.ts']='export const value=42;';
 const before=structuredClone(project);assert.throws(()=>renameProjectFile(project,'/src/value.ts','src/renamed.ts'),/编译器/);assert.deepEqual(project,before);
 renameProjectFile(project,'/src/value.ts','src/renamed.ts',prepareScriptRename(project.files,'/src/value.ts','/src/renamed.ts'));
 assert.match(project.files[project.entry],/from "\.\/renamed"/);
 renameProjectFile(project,project.entry,'world/Main.ts',prepareScriptRename(project.files,project.entry,'/world/Main.ts'));
 assert.match(project.files[project.entry],/from "\.\.\/src\/renamed"/);assert.match(project.files['/main.tscn'],/res:\/\/world\/Main.ts/);
 const plan=prepareScriptRename(project.files,'/src/renamed.ts','/src/value.ts');project.files[project.entry]+='\n// newer edit';
 const changed=structuredClone(project);assert.throws(()=>renameProjectFile(project,'/src/renamed.ts','src/value.ts',plan),/项目已变化/);assert.deepEqual(project,changed);
});
test('native dependency updates preserve user text while handling Godot literal syntax',()=>{
 const project=defaultProject();project.files['/Old.tres']='[gd_resource type="Resource" format=3]\n[resource]\n';
 project.files['/main.tscn']+='\n[ext_resource type="Resource" path="res://Old.tres" id="2"]\n[node name="PathLabel" type="Label" parent="."]\ntext="res://Old.tres"\nmetadata/path="res://Old.tres"\n';
 const gd=`extends Node
const A = preload('res://Old.tres')
const B = preload("res://Old.tres")
const C = load(r'res://Old.tres')
const D = ResourceLoader.load("res://Old.tres")
var label = 'res://Old.tres'
var documentation = """preload('res://Old.tres') # text"""
# preload("res://Old.tres")
`;
 project.files['/Main.gd']=gd;
 const before=structuredClone(project);assert.throws(()=>renameProjectFile(project,'/Old.tres','New.tres'),/尚未开放/);assert.deepEqual(project,before);
 delete project.files['/Main.gd'];project.files=renamedProjectFiles(project.files,'/Old.tres','/New.tres',true);
 assert.match(project.files['/main.tscn'],/path="res:\/\/New.tres"/);
 assert.match(project.files['/main.tscn'],/text="res:\/\/Old.tres"/);
 assert.match(project.files['/main.tscn'],/metadata\/path="res:\/\/Old.tres"/);
});
test('framework rename boundaries reject resource/declaration edits without changing the project',()=>{
 for(const runtime of ['godot','react']){
  const project=defaultProject(runtime);project.files['/Old.tres']='[gd_resource type="Resource" format=3]\n[resource]\n';project.files['/types.d.ts']='declare const value:number;';
  for(const [old,next]of [['/Old.tres','/New.tres'],['/types.d.ts','/new-types.d.ts'],[project.entry,'/renamed.d.ts']]){
   const before=structuredClone(project);assert.equal(canRenameProjectFile(project,old)&&canRenameProjectFile(project,next),false);assert.throws(()=>renameProjectFile(project,old,next),/尚未开放/);assert.deepEqual(project,before);
  }
 }
});

test('removed renderer documents upgrade bundled demos only once and retain original edits',()=>{
 const old={...input(),schemaVersion:2,runtime:'legacy-react',entry:'/src/ShaderLab.tsx',selected:'/src/ShaderLab.tsx',files:{'/src/ShaderLab.tsx':'// my old shader changes','/assets/kept.bin':[0,255]}};
 const demo={id:'shader',file:'ShaderLab.tsx',source:'export default function Modern(){return null;}',name:'Shader',hint:'Native React',controls:[{key:'speed',value:2}]};
 const migrated=migrateDemoProject(parseProject(old),demo);assert.equal(migrated.runtime,'react');assert.equal(migrated.files[migrated.entry],demo.source);assert.deepEqual(exportProject(migrated,'original'),old);assert.equal(migrated.controls.speed,1);
 migrated.files[migrated.entry]+='\n// native edit after migration';const restored=parseProject(exportProject(migrated));assert.strictEqual(migrateDemoProject(restored,demo),restored);assert.match(restored.files[restored.entry],/native edit after migration/);
 const custom=parseProject({...old,entry:'/src/Custom.tsx',files:{'/src/Custom.tsx':'// custom source'}});assert.strictEqual(migrateDemoProject(custom,demo),custom);
});

test('migrated demo controls respect the new scene bounds while original values remain exportable',()=>{
 const old={...input(),schemaVersion:2,runtime:'legacy-react',entry:'/src/ShaderLab.tsx',files:{'/src/ShaderLab.tsx':'// old shader'},controls:{speed:999}};
 const demo={id:'shader',file:'ShaderLab.tsx',source:'export default function App(){return null;}',name:'Shader',hint:'Native React',controls:[{key:'speed',value:1,min:0,max:3}]};
 const next=migrateDemoProject(parseProject(old),demo);assert.equal(next.controls.speed,3);assert.equal(exportProject(next,'original').controls.speed,999);
});


test('schema3 preserves explicit and unknown profile identities and helper API requirements',()=>{
 for(const engineProfile of ['full-engine-v1','engine-2d-v1','future-native-v8']){
  const source={...input(),engineProfile,demoApiVersion:1},project=parseProject(source);
  assert.deepEqual(exportProject(project),source);assert.equal(projectProfileMatches(project,engineProfile),true);
  assert.equal(projectProfileMatches(project,'another-v1'),false);
 }
 for(const engineProfile of [undefined,'','../full',' full-engine-v1','UPPER'])assert.throws(()=>parseProject({...input(),engineProfile}),/engineProfile/);
 for(const demoApiVersion of [0,-1,1.5,'1'])assert.throws(()=>parseProject({...input(),demoApiVersion}),/API/);
});
test('schema2 migrates once to full while retaining an earlier original document chain',()=>{
 const old={...input(),schemaVersion:2};delete old.engineProfile;
 const migrated=parseProject(old);assert.equal(migrated.schemaVersion,3);assert.equal(migrated.engineProfile,'full-engine-v1');assert.deepEqual(exportProject(migrated,'original'),old);
 assert.deepEqual(parseProject(exportProject(migrated)),migrated);
 const original={schemaVersion:1,project:{config:{entry:old.entry},files:old.files}};
 const chained={...old,migration:{fromSchemaVersion:1,removedRenderer:false,originalDocument:original}};
 assert.deepEqual(parseProject(chained).migration,chained.migration);assert.deepEqual(exportProject(parseProject(chained),'original'),original);
});
test('native and demo templates bind the requested target profile without cross-profile remapping',()=>{
 for(const runtime of ['godot','react']){const project=defaultProject(runtime,'engine-2d-v1');assert.equal(project.schemaVersion,3);assert.equal(project.engineProfile,'engine-2d-v1');assert.equal(project.migration,undefined);}
 const demo={id:'match3',file:'Match3.tsx',source:'export default function App(){return null;}',name:'Match3',hint:'2D',controls:[]};
 const project=demoProject(demo,'engine-2d-v1');assert.equal(project.engineProfile,'engine-2d-v1');assert.equal(project.demoApiVersion,1);assert.equal(project.demoId,'match3');
});
