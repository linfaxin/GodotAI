import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileEngineProject,EngineProjectBuildError} from '../src/engine-project.ts';
import {defaultProject} from '../src/project-templates.ts';
import {renameProjectFile} from '../src/project-model.ts';
import {prepareScriptRename} from '@godot-js/react-build/script-renames';

const bytes=value=>new TextEncoder().encode(value);
const read=(result,name)=>{const entry=result.index[name];assert.ok(entry,'Missing packed file: '+name);return new TextDecoder().decode(result.pack.subarray(entry.offset,entry.offset+entry.size));};
function withNativeNamespace(result,external){
 let namespace;
 return name=>{
  if(name!==result.manifest.runtimeModules.godot)return external(name);
  if(!namespace){const module={exports:{}};vm.runInNewContext(read(result,name),{module,exports:module.exports,require:external});namespace=module.exports;}
  return namespace;
 };
}
const scene='[gd_scene format=3 uid="uid://d1t"]\n[node name="Main" type="Node2D"]\n';
const config='config_version=5\n[application]\nconfig/name="Original native project"\nrun/main_scene="uid://d1t"\n[autoload]\nServices="*res://Services.ts"\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=true\n[physics]\n3d/physics_engine="GodotPhysics3D"\n';
const existingCache=()=>{const name=bytes('res://kept.tres'),out=new Uint8Array(16+name.length),view=new DataView(out.buffer);view.setUint32(0,1,true);view.setBigUint64(4,99n,true);view.setUint32(12,name.length,true);out.set(name,16);return [...out];};

test('native startup loads res URIs and every supported source extension from the output index',{timeout:30000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS binary is unavailable');return;}
 const project=defaultProject();
 project.files[project.entry]=`import {Node2D} from 'godot';import {value as a} from 'res://src/ordinary';import {value as b} from 'res://src/ordinary.ts';import {value as c} from './esm.mjs';import {value as d} from './typed.mts';import {value as e} from './common.cts';import settings from 'res://src/settings.json';
export default class Main extends Node2D {_ready(){if(a+b+c+d+e+settings.value!==252)throw Error('Module mapping differs');console.log('FRAMEWORK_MODULES_OK');}}`;
 for(const file of ['ordinary.ts','esm.mjs','typed.mts','common.cts'])project.files['/src/'+file]='export const value=42;';project.files['/src/settings.json']='{"value":42}';
 const result=await compileEngineProject({runtime:'godot',entry:project.entry,files:project.files}),directory=await mkdtemp(path.join(tmpdir(),'framework-module-index-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const pack=path.join(directory,'project.pck');await writeFile(pack,result.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{encoding:'utf8',timeout:15000});const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.match(output,/FRAMEWORK_MODULES_OK/);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
});

test('native and React startup agree on duplicate main_scene assignments and repeated sections',async()=>{
 for(const repeated of [false,true]){
  const config='config_version=5\n[application]\nrun/main_scene="res://First.tscn"\n'+(repeated?'[other]\nkeep=42\n[application]\n':'')+'run/main_scene="res://Second.tscn"\n';
  const files={'/project.godot':config,'/First.tscn':scene,'/Second.tscn':scene.replace('uid://d1t','uid://second'),'/App.tsx':'export default function App(){return null;}'};
  const native=await compileEngineProject({runtime:'godot',files});assert.equal(native.manifest.mainScene,'res://Second.tscn');assert.equal(read(native,'res://project.godot'),config);
  for(const options of [{runtime:'godot',mainScene:'/First.tscn'},{runtime:'react',entry:'/App.tsx',vendor:bytes('exports.React = {}; exports.engineReact = {};')}]){
   const result=await compileEngineProject({...options,files});
   const values=[...read(result,'res://project.godot').matchAll(/^run\/main_scene="([^"]*)"/gm)].map(match=>match[1]);
   assert.equal(values.length,2);assert.ok(values.every(value=>value===result.manifest.mainScene));
  }
 }
});

test('real native launches honor duplicate scene overrides, React startup and renamed attached scripts',{timeout:45000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS binary is unavailable');return;}
 const {buildEngineVendor}=await import('./full-engine-release.mjs'),vendor=await buildEngineVendor();
 const directory=await mkdtemp(path.join(tmpdir(),'engine-project-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const first='[gd_scene format=3]\n[node name="First" type="Node"]\n',second=first.replace('First','Second');
 const files={'/project.godot':'config_version=5\n[application]\nrun/main_scene="res://First.tscn"\n[application]\nrun/main_scene="res://Second.tscn"\n[autoload]\nObserve="*res://Observe.ts"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '/First.tscn':first,'/Second.tscn':second,'/Observe.ts':'import {Node,ProjectSettings} from "godot"; export default class Observe extends Node {_ready(){console.log("REVIEW_SELECTED "+ProjectSettings.get_setting("application/run/main_scene"));}}'};
 const renamed=defaultProject();renamed.files[renamed.entry]=renamed.files[renamed.entry].replace('_ready() {','_ready() { console.log("REVIEW_RENAMED_READY");');renameProjectFile(renamed,renamed.entry,'src/Renamed.ts');
 const cases=[
  [{runtime:'godot',files},'REVIEW_SELECTED res://Second.tscn'],
  [{runtime:'godot',mainScene:'/First.tscn',files},'REVIEW_SELECTED res://First.tscn'],
  [{runtime:'react',entry:'/App.tsx',files:{...files,'/App.tsx':'export default function App(){console.log("REVIEW_REACT_ENTRY");return null;}'},vendor},'REVIEW_REACT_ENTRY'],
  [{runtime:'godot',entry:renamed.entry,files:renamed.files},'REVIEW_RENAMED_READY'],
 ];
 for(const [index,[options,marker]]of cases.entries()){
  const result=await compileEngineProject(options),pack=path.join(directory,index+'.pck');await writeFile(pack,result.pack);
  const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{encoding:'utf8',timeout:12000,maxBuffer:2*1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.ok(output.includes(marker),output);
  assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
  if(options.runtime==='react')assert.ok(output.includes('REVIEW_SELECTED '+result.manifest.mainScene),output);
 }
});

test('native engine runs renamed script dependencies, preserved text and every native import form',{timeout:45000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS binary is unavailable');return;}
 const directory=await mkdtemp(path.join(tmpdir(),'engine-rename-interop-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const project=defaultProject();
 project.files['/src/Main.ts']='import {Node2D} from "godot";import {value} from "./value";export default class Main extends Node2D {_ready(){console.log("RENAME_DEPENDENCY "+value);}}';
 project.files['/src/value.ts']='export const value=42;';
 renameProjectFile(project,'/src/value.ts','lib/renamed.ts',prepareScriptRename(project.files,'/src/value.ts','/lib/renamed.ts'));
 renameProjectFile(project,project.entry,'world/Main.ts',prepareScriptRename(project.files,project.entry,'/world/Main.ts'));
 const interop=defaultProject();interop.files['/src/barrel.ts']='export * as G from "godot";export {default as DefaultG} from "godot";';interop.files['/src/star.ts']='export * from "godot";';
 interop.files[interop.entry]=`import * as G from "godot";import DefaultG from "godot";import {G as Again,DefaultG as Forwarded} from "./barrel";import {Node,Vector2,sin,Error as Errors,OK,GArray} from "./star";
if(G!==DefaultG||G!==Again||G!==Forwarded||G!==require('godot')||G.Node!==Node||G.Vector2!==Vector2||G.GArray!==GArray||sin(0)!==0||Number(Errors.OK)!==Number(OK))throw Error('Native exports or namespace identity differ');
import('godot').then(dynamic=>{if(dynamic!==G)throw Error('Dynamic namespace differs');console.log('NATIVE_DYNAMIC_OK');});
export default class Main extends G.Node2D {_ready(){console.log('NATIVE_INTEROP_OK');}}`;
 const gd=defaultProject();delete gd.files[gd.entry];gd.entry='';gd.files['/main.tscn']='[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Main.gd" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n';
 gd.files['/Main.gd']="extends Node\nconst R = preload('res://Old.tres')\nfunc _ready():\n\tprint('GD_PRELOAD_OK')\n";
 gd.files['/Old.tres']='[gd_resource type="Resource" format=3]\n[resource]\n';assert.throws(()=>renameProjectFile(gd,'/Old.tres','New.tres'),/尚未开放/);
 const text=defaultProject();text.files['/Old.tres']='[gd_resource type="Resource" format=3]\n[resource]\n';text.files['/main.tscn']+='\n[node name="PathLabel" type="Label" parent="."]\ntext="res://Old.tres"\n';
 text.files[text.entry]='import {Node2D} from "godot";export default class Main extends Node2D {_ready(){console.log("PRESERVED_TEXT "+this.get_node("PathLabel").get("text"));}}';assert.throws(()=>renameProjectFile(text,'/Old.tres','New.tres'),/尚未开放/);
 for(const [index,[current,markers]]of [[project,['RENAME_DEPENDENCY 42']],[interop,['NATIVE_DYNAMIC_OK','NATIVE_INTEROP_OK']],[gd,['GD_PRELOAD_OK']],[text,['PRESERVED_TEXT res://Old.tres']]].entries()){
  const result=await compileEngineProject({runtime:'godot',entry:current.entry||undefined,files:current.files}),pack=path.join(directory,index+'.pck');await writeFile(pack,result.pack);
  const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','8'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);for(const marker of markers)assert.ok(output.includes(marker),output);
 }
});

test('native project packing preserves configuration, UIDs, imported resources and original TypeScript',async()=>{
 const files={'res://project.godot':config,'/project.binary':[4,5,6],'/main.tscn':scene,
  '/Services.ts':'export default class Services {}','/src/helper.ts':'export const value: number = 42;',
  '/src/main.ts':'import {value} from "./helper.ts"; export const result = value;',
  '/materials/native.tres':'[gd_resource type="ShaderMaterial" format=3]\n',
  '/shaders/native.gdshader':'shader_type canvas_item;\n','/main.tscn.uid':'uid://d1t','/kept.tres':'[gd_resource type="Resource" format=3]\n',
  '/.godot/uid_cache.bin':existingCache(),'/assets/picture.png':[137,80,78,71],
  '/assets/picture.png.import':'[remap]\npath="res://.godot/imported/picture.png-a.ctex"\n',
  '/.godot/imported/picture.png-a.ctex':[1,0,255],'/custom/arbitrary-format.bin':[8,9,10]};
 const before=structuredClone(files),result=await compileEngineProject({files,runtime:'godot'});
 assert.deepEqual(files,before);assert.equal(result.manifest.mainScene,'uid://d1t');
 assert.equal(read(result,'res://project.godot'),config);assert.equal(result.index['res://project.binary'],undefined);
 for(const name of ['main.tscn','materials/native.tres','shaders/native.gdshader','main.tscn.uid','src/helper.ts'])assert.equal(read(result,'res://'+name),files['/'+name]);
 assert.deepEqual([...result.pack.subarray(result.index['res://.godot/imported/picture.png-a.ctex'].offset,result.index['res://.godot/imported/picture.png-a.ctex'].offset+3)],[1,0,255]);
 assert.ok(!result.manifest.files.some(name=>name.includes('vendor')||name.includes('node_modules/react')));
 assert.match(read(result,'res://.godot/GodotJS/src/main.js'),/require\("res:\/\/\.godot\/GodotJS\/src\/helper.js"\)/);
 const sourceMap=JSON.parse(read(result,'res://.godot/GodotJS/src/main.js.map'));
 assert.deepEqual(sourceMap.sources,['res://src/main.ts']);assert.deepEqual(sourceMap.sourcesContent,[files['/src/main.ts']]);
 assert.deepEqual(result.diagnostics.map(d=>d.code),['W_ENGINE_STALE_PROJECT_BINARY']);
});

test('native relative modules and JSON stay separate rather than using a handwritten module loader',async()=>{
 const result=await compileEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,
  '/src/Main.ts':'import settings from "./settings.json"; import {n} from "./nested/value"; export const answer = settings.x + n;',
  '/src/nested/value.ts':'export const n = 2;', '/src/settings.json':'{"x":40}', '/src/common.cjs':'exports.enabled = true;',
  '/src/esm.mts':'export const esm: number = 9;', '/src/also-esm.mjs':'export const esm = 10;'}});
 assert.match(read(result,'res://.godot/GodotJS/src/Main.js'),/require\("res:\/\/\.godot\/GodotJS\/src\/nested\/value.js"\)/);
 assert.equal(read(result,'res://.godot/GodotJS/src/settings.json'),'{"x":40}');
 assert.equal(read(result,'res://src/settings.json'),'{"x":40}');
 assert.match(read(result,'res://.godot/GodotJS/src/common.cjs'),/exports.enabled = true/);
 for(const name of ['esm','also-esm']){assert.match(read(result,'res://.godot/GodotJS/src/'+name+'.js'),/exports.esm/);assert.doesNotMatch(read(result,'res://.godot/GodotJS/src/'+name+'.js'),/^export /m);}
 assert.doesNotMatch(read(result,'res://.godot/GodotJS/src/Main.js'),/__load|__modules|__candidates/);
});

test('react bootstrap owns lifecycle once and keeps user autoload/native settings',async()=>{
 const result=await compileEngineProject({runtime:'react',entry:'/src/App.tsx',vendor:bytes('exports.React = {};'),files:{'/project.godot':config,
  '/src/App.tsx':'import * as React from "react"; export default function App(){return null;}', '/main.tscn':scene}});
 const project=read(result,'res://project.godot');
 assert.match(project,/Services="\*res:\/\/Services.ts"/);assert.match(project,/camel_case_bindings_enabled=true/);assert.match(project,/3d\/physics_engine="GodotPhysics3D"/);
 assert.match(project,/run\/main_scene="res:\/\/\.playground\/engine-bootstrap.tscn"/);
 for(const specifier of ['@godot-js/react','@godot-js/react/engine'])assert.match(read(result,'res://.godot/GodotJS/node_modules/'+specifier+'/index.js'),/\["engineReact"\]/);
 assert.equal(result.index['res://.godot/GodotJS/node_modules/godot/index.js'],undefined);
 const calls=[],root={render:value=>calls.push(['render',value]),pump:d=>calls.push(['pump',d]),process:d=>calls.push(['process',d]),physics:d=>calls.push(['physics',d]),shutdown:reason=>calls.push(['shutdown',reason])};
 class Node {}
 function App(){}
 const entry={default:App};
 const module={exports:{}},require=withNativeNamespace(result,specifier=>{
  if(specifier==='godot')return {Node};
  if(specifier==='godot-jsb')return {internal:{names:{get_member:name=>name,get_class:name=>name}}};
  if(specifier==='res://.godot/GodotJS/node_modules/react/index.js')return {isValidElement:()=>false,createElement:(type,props)=>({type,props})};
  if(specifier==='res://.godot/GodotJS/node_modules/@godot-js/react/engine/index.js')return {createRoot:(node,options)=>{calls.push(['createRoot',node,options]);return root;}};
  if(specifier==='res://.godot/GodotJS/src/App.js')return entry;
  throw Error(specifier);
 });
 vm.runInNewContext(read(result,'res://.godot/GodotJS/.playground/engine-bootstrap.js'),{require,module,exports:module.exports});
 const bootstrap=new module.exports.default();bootstrap._ready();bootstrap._process(.1);bootstrap._physics_process(.2);bootstrap._exit_tree();bootstrap._exit_tree();bootstrap._process(.3);
 assert.equal(calls[0][0],'createRoot');assert.equal(calls[0][2].autoProcess,false);
 assert.deepEqual(calls.map(call=>call[0]),['createRoot','render','process','physics','shutdown']);
 assert.equal(calls[1][1].type,App);
 const original=Error('original startup failure'),cleanup=Error('cleanup failure'),secondary=[];
 root.render=()=>{throw original;};root.shutdown=()=>{throw cleanup;};
 const failedModule={exports:{}};
 vm.runInNewContext(read(result,'res://.godot/GodotJS/.playground/engine-bootstrap.js'),{require,module:failedModule,exports:failedModule.exports,console:{error:(...args)=>secondary.push(args)}});
 const failed=new failedModule.exports.default();assert.throws(()=>failed._ready(),error=>error===original);
 assert.equal(secondary.length,1);assert.equal(secondary[0][1],cleanup);failed._exit_tree();
});

test('pre-emitted CommonJS keeps its own source map and missing maps are reported honestly',async()=>{
 const source='export const answer: number = 42;';
 const emitted=ts.transpileModule(source,{fileName:'/src/value.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,inlineSourceMap:true,inlineSources:true}}).outputText;
 const options={runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,'/src/value.ts':source}};
 const mapped=await compileEngineProject({...options,generatedJs:{'/src/value.ts':emitted}});
 assert.deepEqual(JSON.parse(read(mapped,'res://.godot/GodotJS/src/value.js.map')).sources,['res://src/value.ts']);
 assert.doesNotMatch(read(mapped,'res://.godot/GodotJS/src/value.js'),/sourceMappingURL=data:/);
 const plain=await compileEngineProject({...options,generatedJs:{'/src/value.ts':'exports.answer = 99;'}});
 assert.equal(read(plain,'res://.godot/GodotJS/src/value.js'),'exports.answer = 99;');
 assert.equal(plain.index['res://.godot/GodotJS/src/value.js.map'],undefined);
 assert.equal(plain.diagnostics[0].code,'W_ENGINE_SOURCE_MAP');
});

test('native namespace/default imports do not probe lazy godot __esModule, including worker pre-emitted code',async()=>{
 const source='import * as G from "godot"; import DefaultG from "godot"; import React from "react"; export const same = G === DefaultG; export const node = new G.Node(); export const ordinaryDefault = React.marker; export const shorthand = {DefaultG}; export {DefaultG}; export const shadow = (DefaultG: number) => DefaultG + 1;';
 const emitted=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,inlineSourceMap:true}}).outputText;
 const result=await compileEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,'/interop.ts':source},
  generatedJs:{'/interop.ts':emitted},runtimeModules:{react:bytes('exports.marker = 42;')}});
 class Node {}
 const native=new Proxy({Node},{get:(target,key)=>{if(key==='__esModule')throw Error('Native namespace metadata probe');return target[key];}});
 const module={exports:{}};
 vm.runInNewContext(read(result,'res://.godot/GodotJS/interop.js'),{module,exports:module.exports,require:withNativeNamespace(result,name=>name==='godot'?native:name==='res://.godot/GodotJS/node_modules/react/index.js'?{marker:42}:(()=>{throw Error('Unexpected module '+name);})())});
 assert.equal(module.exports.same,true);assert.ok(module.exports.node instanceof Node);assert.equal(module.exports.ordinaryDefault,42);
 assert.equal(module.exports.DefaultG.Node,native.Node);assert.equal(module.exports.shorthand.DefaultG,module.exports.DefaultG);assert.equal(module.exports.shadow(41),42);
 assert.deepEqual(JSON.parse(read(result,'res://.godot/GodotJS/interop.js.map')).sources,['res://interop.ts']);
});

test('runtime modules are copied by specifier and native modules cannot be shadowed',async()=>{
 const result=await compileEngineProject({runtime:'react',entry:'/App.tsx',files:{'/App.tsx':'export default function App(){return null;}'},runtimeModules:{
  react:bytes('module.exports = React;'),'@godot-js/react/engine':bytes('module.exports = EngineReact;'),
  'res://.godot/GodotJS/node_modules/local/helper/index.js':bytes('exports.ok = true;')}});
 assert.equal(read(result,'res://.godot/GodotJS/node_modules/local/helper/index.js'),'exports.ok = true;');
 assert.equal(result.manifest.runtimeModules.react,'res://.godot/GodotJS/node_modules/react/index.js');
 for(const specifier of ['godot','res://.godot/GodotJS/node_modules/godot-jsb/index.js','../outside','res://../outside.js'])
  await assert.rejects(compileEngineProject({runtime:'godot',files:{'/main.tscn':scene},mainScene:'/main.tscn',runtimeModules:{[specifier]:bytes('')}}),EngineProjectBuildError);
});

test('unimported known resources warn, native/unknown binary files remain available',async()=>{
 const result=await compileEngineProject({runtime:'godot',mainScene:'/main.tscn',files:{'/main.tscn':scene,
  '/music.ogg':[1,2,3],'/picture.png':[137,80],'/font.ttf':[0,1],'/game.res':[0,255],'/custom.dat':[3,4],
  '/broken.glb':[0,1],'/broken.glb.import':'[remap]\npath="res://.godot/imported/missing.scn"\n'}});
 assert.deepEqual(result.diagnostics.map(item=>[item.file,item.code]),[
  ['res://music.ogg','W_ENGINE_IMPORT_REQUIRED'],['res://picture.png','W_ENGINE_IMPORT_REQUIRED'],['res://font.ttf','W_ENGINE_IMPORT_REQUIRED'],['res://broken.glb','W_ENGINE_IMPORT_CACHE_MISSING']]);
 assert.ok(result.index['res://game.res']);assert.ok(result.index['res://custom.dat']);
 assert.ok(result.diagnostics.every(item=>item.category==='warning'));
});

test('invalid paths, unavailable npm, source collisions and TS syntax stop before publishing a pack',async()=>{
 const base={runtime:'godot',mainScene:'/main.tscn'};
 for(const files of [{'/../main.tscn':scene},{'/main.tscn':scene,'res://main.tscn':'other'},
  {'/main.tscn':scene,'/Main.ts':'import x from "package-not-included"; export {x};'},
  {'/main.tscn':scene,'/Main.ts':'export const n = 1;','/Main.tsx':'export const n = 2;'},
  {'/main.tscn':scene,'/Main.ts':'export const = ;'}]){
  await assert.rejects(compileEngineProject({...base,files}),error=>error instanceof EngineProjectBuildError&&error.diagnostics.some(item=>item.category==='error'));
 }
 await assert.rejects(compileEngineProject({runtime:'godot',files:{'/note.txt':'no startup'}}),/main_scene/);
});

test('native binary-only projects remain authoritative and explicit mainScene overrides only that setting',async()=>{
 const binary=await compileEngineProject({runtime:'godot',files:{'/project.binary':[1,2,3],'/main.scn':[5,6]}});
 assert.equal(binary.manifest.projectSettings,'binary');assert.equal(binary.index['res://project.godot'],undefined);
 const explicit=await compileEngineProject({runtime:'godot',files:{'/project.godot':config,'/main.tscn':scene},mainScene:'/main.tscn'});
 assert.match(read(explicit,'res://project.godot'),/run\/main_scene="res:\/\/main.tscn"/);
 assert.match(read(explicit,'res://project.godot'),/Services="\*res:\/\/Services.ts"/);
 const byteProject=await compileEngineProject({runtime:'godot',files:{'/project.godot':[...bytes(config)],'/main.tscn':scene}});
 assert.equal(read(byteProject,'res://project.godot'),config);
});

test('entry-only native projects run real Node2D and Control classes through native GodotJS registration',{timeout:30000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS binary is unavailable');return;}
 const directory=await mkdtemp(path.join(tmpdir(),'engine-project-native-'));
 try{
  for(const [extension,base] of [['ts','Node2D'],['js','Control']]){
   const result=await compileEngineProject({runtime:'godot',entry:'/src/Main.'+extension,files:{['/src/Main.'+extension]:
    'import {'+base+', Vector2} from "godot"; export default class Main extends '+base+' { _ready(){this.position=new Vector2(7,9); console.log("ENGINE_PROJECT_NATIVE_OK "+this.position.x);this.get_tree().quit();}}'}});
   const pack=path.join(directory,'entry-'+extension+'.pck');await writeFile(pack,result.pack);
   const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',pack,'--quit-after','60'],{encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
   const output=(run.stdout??'')+(run.stderr??'');
   assert.equal(run.status,0,output);assert.match(output,/ENGINE_PROJECT_NATIVE_OK 7/,output);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
  }
  const throwingSource='import {Node} from "godot";\nimport {value} from "@runtime/provided";\nexport default class Main extends Node {\n _ready(){\n  throw Error("ENGINE_PROJECT_EXPECTED_FAILURE "+value);\n }\n}';
  const emitted=ts.transpileModule(throwingSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,inlineSourceMap:true}}).outputText;
  const failure=await compileEngineProject({runtime:'godot',entry:'/src/Throw.ts',files:{'/src/Throw.ts':throwingSource},runtimeModules:{'@runtime/provided':bytes('exports.value=42;')},generatedJs:{'/src/Throw.ts':emitted}});
  const failurePack=path.join(directory,'throw.pck');await writeFile(failurePack,failure.pack);
  const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',failurePack,'--quit-after','3'],{encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.match(output,/ENGINE_PROJECT_EXPECTED_FAILURE 42/);assert.match(output,/res:\/\/src\/Throw.ts:5:/,output);assert.doesNotMatch(output,/failed to check out module/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a source-only native UID main scene boots with generated cache and unchanged scene/config text',{timeout:20000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS binary is unavailable');return;}
 const original='config_version=5\n[application]\nrun/main_scene="uid://d1t"\n[autoload]\nUIDAuto="*res://Auto.ts"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n';
 const nativeScene='[gd_scene load_steps=2 format=3 uid="uid://d1t"]\n[ext_resource type="Script" path="res://Main.ts" id="1"]\n[node name="UIDMain" type="Node2D"]\nscript=ExtResource("1")\n';
 const files={'/project.godot':original,'/scenes/main.tscn':nativeScene,
  '/Auto.ts':'import {Node} from "godot"; export default class Auto extends Node {_ready(){(globalThis as any).__uidAuto=true;}}',
  '/Main.ts':'import {Node2D,ResourceUID} from "godot"; export default class Main extends Node2D {_ready(){if(!(globalThis as any).__uidAuto)throw Error("Autoload order changed");const id=ResourceUID.text_to_id("uid://d1t");if(id!==4371)throw Error("Native UID value differs");console.log("ENGINE_PROJECT_UID_OK "+id);this.get_tree().quit();}}',
  '/Main.ts.uid':'uid://bc\n'};
 const result=await compileEngineProject({runtime:'godot',files});
 assert.equal(result.manifest.mainScene,'uid://d1t');assert.equal(read(result,'res://project.godot'),original);
 assert.equal(read(result,'res://scenes/main.tscn'),nativeScene);assert.equal(files['/.godot/uid_cache.bin'],undefined);
 const cached=result.index['res://.godot/uid_cache.bin'];assert.ok(cached);
 const view=new DataView(result.pack.buffer,cached.offset,cached.size);assert.equal(view.getUint32(0,true),2);
 const directory=await mkdtemp(path.join(tmpdir(),'engine-project-uid-'));
 try{
  const filename=path.join(directory,'uid.pck');await writeFile(filename,result.pack);
  const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','60'],{encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);assert.match(output,/ENGINE_PROJECT_UID_OK 4371/,output);assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('the production vendor and generated React bootstrap render native Label and drive frame/shutdown hooks',{timeout:30000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await Promise.all([readFile(engine),readFile(new URL('../../../scripts/jsb.react/dist/engine.js',import.meta.url))]);}
 catch{t.skip('Built full-engine SDK or native GodotJS binary is unavailable');return;}
 const {buildEngineVendor}=await import('./full-engine-release.mjs');
 const vendor=await buildEngineVendor({mode:'development'});
 const result=await compileEngineProject({runtime:'react',entry:'/src/App.tsx',vendor,files:{'/src/App.tsx':`
import * as React from 'react';
import * as G from 'godot';
import {EngineNode, useFrame} from '@godot-js/react';
export default function App(){
 const label=React.useRef<any>(null), frames=React.useRef(0), physics=React.useRef(0);
 useFrame('physics',()=>{physics.current++;});
 useFrame('process',()=>{
  if(++frames.current>=3&&physics.current>0){
   if(!label.current||label.current.text!=='Full engine pack')throw Error('Native Label did not render');
   console.log('ENGINE_PROJECT_REACT_OK '+JSON.stringify({frames:frames.current,physics:physics.current}));
   label.current.get_tree().quit();
  }
 });
 React.useLayoutEffect(()=>()=>{console.log('ENGINE_PROJECT_REACT_CLEANUP');},[]);
 return <EngineNode ctor={G.Label} native={{text:'Full engine pack'}} ref={label}/>;
}
`}});
 const directory=await mkdtemp(path.join(tmpdir(),'engine-project-react-'));
 try{
  const filename=path.join(directory,'react.pck');await writeFile(filename,result.pack);
  const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','120'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);
  assert.match(output,/ENGINE_PROJECT_REACT_OK /,output);assert.match(output,/ENGINE_PROJECT_REACT_CLEANUP/,output);
  assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
  assert.doesNotMatch(output,/failed to check out module/,output);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('the native demo API stays compiler-free under the production neutral bundler',async()=>{
 const {build}=await import('esbuild');
 const vendor=fileURLToPath(new URL('../src/api.tsx',import.meta.url));
 const performance=fileURLToPath(new URL('../../../scripts/jsb.react/dist/internal/performance.mjs',import.meta.url));
 const result=await build({entryPoints:[vendor],bundle:true,write:false,platform:'neutral',format:'cjs',target:'es2022',metafile:true,
  define:{'process.env.NODE_ENV':'"production"'},external:['godot','godot-jsb','res://*'],inject:[performance]});
 const inputs=Object.keys(result.metafile.inputs);
 assert.ok(!inputs.some(name=>/typescript|core\/engine-project|resource-uids/.test(name)),inputs.join('\n'));
 assert.ok(!Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>item.path==='typescript')));
});
