import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const encode=value=>new TextEncoder().encode(value);
const uid=id=>{const alphabet='abcdefghijklmnopqrstuvwxy012345678';let text='';do{text=alphabet[id%alphabet.length]+text;id=Math.floor(id/alphabet.length);}while(id);return 'uid://'+text;};

/** Raw Godot project: no React, resource-schema translation, editor import or native bridge. */
export async function createBootFixture(options={}){
 const files=new Map(),sources={};
 const put=(path,contents)=>files.set('res://'+path,typeof contents==='string'?encode(contents):new Uint8Array(contents));
 const script=(name,source)=>{sources[name]=source;put('src/'+name+'.ts',source);const out=ts.transpileModule(source,{fileName:name+'.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:false,sourceMap:true,inlineSources:true,experimentalDecorators:false}});const map=JSON.parse(out.sourceMapText);map.sources=['res://src/'+name+'.ts'];map.file=name+'.js';put('.godot/GodotJS/src/'+name+'.js',out.outputText);put('.godot/GodotJS/src/'+name+'.js.map',JSON.stringify(map));};
 const shared=`import * as G from 'godot';
export {G};
export function call(o:any,n:string,...args:any[]){const f=o[n]??o[n.replace(/_([a-z])/g,(_:string,x:string)=>x.toUpperCase())];if(typeof f!=='function')throw Error('Missing '+n);return f.apply(o,args);}
export function check(value:any,message:string){if(!value)throw Error(message);}
export function state(node:any):any{return call(node,'get_node','/root/FirstAuto');}
export function fail(node:any,error:any){console.error('P0_BOOT_FAILED '+String(error)+' '+error?.stack);call(call(node,'get_tree'),'quit',1);}
`;
 script('shared',shared);
 script('cycle-a',`import {valueB,readA} from './cycle-b';export const valueA=5;export function readCycle(){return valueB+readA();}`);
 script('cycle-b',`import {valueA} from './cycle-a';export const valueB=7;export function readA(){return valueA;}`);
 script('first-auto',`import {G,call,check,fail} from './shared';
export default class FirstAuto extends G.Node{
 report:any={kind:'boot',order:[],entries:{},sceneLoads:0}; current=''; frames=0; switching=false;pendingKind='';
 _enter_tree(){this.report.order.push('first-enter');}
 _ready(){this.report.order.push('first-ready');}
 _process(_dt:number){try{
  if(++this.frames>500)throw Error('Boot fixture frame deadline');
  if(!this.current&&this.pendingKind){const next=this.pendingKind;this.pendingKind='';this.launch(next);return;}if(!this.current||this.switching)return;
  const data=this.report.entries[this.current];if(!data||data.process<3||data.physics<3)return;
  check(data.ready&&data.entered&&data.currentScene&&data.signal===17,'Lifecycle/signal '+this.current);
  check(data.decorated===23,'Modern export accessor '+this.current);
  check(data.inherited===true,'Script inheritance '+this.current);check(Math.abs(data.physicsDelta-1/48)<.0001,'Native physics tick configuration '+this.current);
  if(this.current!=='scene'){check(data.sceneFilePath==='','Dynamic script must retain empty scene_file_path');}
  const order=['Node','Node2D','Control','scene'],index=order.indexOf(this.current);
  if(index<3){this.switching=true;const next=order[index+1];if(next==='scene'){const code=call(call(this,'get_tree'),'change_scene_to_file','res://scenes/main.tscn');check(code===0,'Load native scene');}else this.launch(next);return;}
  if(this.report.sceneLoads===1){this.switching=true;check(call(call(this,'get_tree'),'reload_current_scene')===0,'Native scene reload');return;}
  check(this.report.sceneLoads===2,'Scene reload must construct another root');
  check(this.report.order.slice(0,5).join(',')==='first-enter,second-enter,first-ready,second-ready,launcher-ready','Autoload order '+this.report.order.join(','));
  for(const kind of ['Node','Node2D','Control'])check(this.report.entries[kind].exited,'Previous dynamic root was not retired '+kind);
  console.log('P0_BOOT_REPORT '+JSON.stringify(this.report));this.current='';call(call(this,'get_tree'),'quit',0);
 }catch(error){this.current='';fail(this,error);}}
 launch(kind:string){const path=kind==='Node'?'node-entry':kind==='Node2D'?'node2d-entry':'control-entry';const resource=call(G.ResourceLoader,'load','res://src/'+path+'.ts');check(resource&&call(resource,'can_instantiate'),'Load script '+kind);const base=String(call(resource,'get_instance_base_type'));check(base===kind,'Script native base '+kind+' got '+base);const node=call(resource,'new');check(node&&call(node,'is_class',kind),'Script.new result '+kind);check(call(call(this,'get_tree'),'change_scene_to_node',node)===0,'change_scene_to_node '+kind);}
}`);
 script('second-auto',`import {G,call,state} from './shared';export default class SecondAuto extends G.Node{_enter_tree(){state(this).report.order.push('second-enter');}_ready(){state(this).report.order.push('second-ready');}}`);
 script('node-base',`import {G} from './shared';export default class NodeBase extends G.Node{inherited(){return true;}}`);
 script('node2d-base',`import {G} from './shared';export default class Node2DBase extends G.Node2D{inherited(){return true;}}`);
 script('control-base',`import {G} from './shared';export default class ControlBase extends G.Control{inherited(){return true;}}`);
 const entrySource=(kind,base,scene=false)=>`import Base from './${base}';import {G,call,state,check,fail} from './shared';import {createClassBinder} from 'godot.annotations';
const bind=createClassBinder();
@bind()
export default class Entry extends Base{
 @bind.export(G.Variant.Type.TYPE_INT) accessor decorated:number=23;
 @bind.signal() accessor pulse:any;
 data:any;
 _enter_tree(){const s=state(this);this.data={entered:true,ready:false,process:0,physics:0,signal:0};s.report.entries['${kind}']=this.data;}
 _ready(){try{const s=state(this);this.data.ready=true;this.data.currentScene=call(this,'get_tree').current_scene===this;this.data.sceneFilePath=String(this.scene_file_path);this.data.decorated=this.decorated;this.data.inherited=this.inherited();this.pulse.connect(G.Callable.create((v:number)=>this.data.signal=v));this.pulse.emit(17);s.current='${kind}';s.switching=false;${scene?`s.report.sceneLoads++;const shape=call(this,'get_node','Inner/Collision').shape;check(shape.size.x===14&&shape.size.y===18,'Nested scene TRES reference');this.data.nested=true;this.data.actualScenePath=String(this.scene_file_path);check(this.data.actualScenePath==='res://scenes/main.tscn','Real scene_file_path');`:''}}catch(error){fail(this,error);}}
 _process(_dt:number){if(this.data)this.data.process++;}
 _physics_process(_dt:number){if(this.data){this.data.physics++;this.data.physicsDelta=_dt;}}
 _exit_tree(){if(this.data)this.data.exited=true;}
}`;
 script('node-entry',entrySource('Node','node-base'));
 script('node2d-entry',entrySource('Node2D','node2d-base'));
 script('control-entry',entrySource('Control','control-base'));
 script('scene-entry',entrySource('scene','node2d-base',true));
 script('launcher',`import {G,call,state,check,fail} from './shared';import {readCycle} from './cycle-a';
export default class Launcher extends G.Node{
 _ready(){try{const s=state(this);s.report.order.push('launcher-ready');
 check(readCycle()===12,'Circular CommonJS module graph');s.report.circularImports=true;
 check(call(G.ProjectSettings,'get_setting','p0/marker')==='configured-before-start','ProjectSettings startup');
 check(call(G.ProjectSettings,'get_setting','physics/common/physics_ticks_per_second')===48,'Physics project config');
 check(call(G.InputMap,'has_action','p0_jump'),'InputMap project action');
 s.report.config={marker:call(G.ProjectSettings,'get_setting','p0/marker'),physicsTicks:call(G.ProjectSettings,'get_setting','physics/common/physics_ticks_per_second'),inputAction:call(G.InputMap,'has_action','p0_jump'),autoloadPath:String(call(call(this,'get_node','/root/SecondAuto'),'get_name'))};
 check(call(G.ResourceUID,'has_id',4660),'UID cache did not load');const shape=call(G.ResourceLoader,'load',call(G.ResourceUID,'id_to_text',4660));check(shape&&shape.size.x===14,'UID resource load');s.report.uid={id:4660,path:String(call(G.ResourceUID,'get_id_path',4660)),size:shape.size.x};
 const texture=call(G.ResourceLoader,'load','res://assets/derived/light.png');check(texture&&call(texture,'get_width')>0,'Preimport texture remap');
 const font=call(G.ResourceLoader,'load','res://assets/font.tres');check(font&&call(font,'get_height',20)>0,'Native font data resource');
 const bytes=call(G.FileAccess,'get_file_as_bytes','res://assets/rigged.glb'),document=new G.GLTFDocument(),gltfState=new G.GLTFState();check(call(document,'append_from_buffer',bytes,'res://assets/',gltfState,0)===0,'GLTF runtime append');const model=call(document,'generate_scene',gltfState,30,false,false);check(model,'GLTF runtime generate');let meshes=0,skeletons=0;const visit=(n:any)=>{if(call(n,'is_class','MeshInstance3D'))meshes++;if(call(n,'is_class','Skeleton3D'))skeletons++;for(let i=0;i<call(n,'get_child_count');i++)visit(call(n,'get_child',i));};visit(model);check(meshes>0&&skeletons>0,'GLTF mesh/skin closure');call(model,'free');
 s.report.resources={textureClass:String(call(texture,'get_class')),textureWidth:call(texture,'get_width'),textureHeight:call(texture,'get_height'),fontClass:String(call(font,'get_class')),fontHeight:call(font,'get_height',20),gltfMeshes:meshes,gltfSkeletons:skeletons};s.pendingKind='Node';
 }catch(error){fail(this,error);}}
}`);
 const scene=(type,name,scriptName)=>`[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/${scriptName}.ts" id="1"]\n[node name="${name}" type="${type}"]\nscript = ExtResource("1")\n`;
 put('scenes/launcher.tscn',scene('Node','Launcher','launcher'));
 put('scenes/second-auto.tscn',scene('Node','SecondAuto','second-auto'));
 put('scenes/inner.tscn','[gd_scene load_steps=2 format=3]\n[ext_resource type="Shape2D" path="../assets/shape.tres" id="1"]\n[node name="Inner" type="Node2D"]\n[node name="Collision" type="CollisionShape2D" parent="."]\nshape = ExtResource("1")\n');
 put('scenes/main.tscn','[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://src/scene-entry.ts" id="1"]\n[ext_resource type="PackedScene" path="res://scenes/inner.tscn" id="2"]\n[node name="NativeScene" type="Node2D"]\nscript = ExtResource("1")\n[node name="Inner" parent="." instance=ExtResource("2")]\n');
 put('assets/shape.tres',`[gd_resource type="RectangleShape2D" format=3 uid="${uid(4660)}"]\n[resource]\nsize = Vector2(14,18)\n`);
 const uidRows=[[4660,'res://assets/shape.tres'],[4661,'res://scenes/launcher.tscn']];let size=4;for(const [,p]of uidRows)size+=12+Buffer.byteLength(p);const uidCache=Buffer.alloc(size);uidCache.writeUInt32LE(uidRows.length);let cursor=4;for(const [id,path]of uidRows){uidCache.writeBigUInt64LE(BigInt(id),cursor);cursor+=8;const b=Buffer.from(path);uidCache.writeUInt32LE(b.length,cursor);cursor+=4;b.copy(uidCache,cursor);cursor+=b.length;}put('.godot/uid_cache.bin',uidCache);
 const font=await readFile(resolve(repo,'tests/react/showcase/fixtures/ui-subset.ttf'));put('assets/font.tres','[gd_resource type="FontFile" format=3]\n[resource]\ndata = PackedByteArray('+[...font].join(',')+')\n');
 put('assets/rigged.glb',await readFile(resolve(repo,'tests/react/showcase/fixtures/rigged.glb')));
 for(const path of ['assets/derived/light.png','assets/derived/light.png.import','.godot/imported/light.png-b205a31c0558d2d4af2658df6760b42b.ctex'])put(path,await readFile(resolve(repo,'apps/playground/project',path)));
 put('.godot/global_script_class_cache.cfg','list=Array[Dictionary]([])\n');
 put('project.godot',`config_version=5\n[application]\nconfig/name="P0 raw boot"\nrun/main_scene="${options.uidMain?uid(4661):'res://scenes/launcher.tscn'}"\n[autoload]\nFirstAuto="*res://src/first-auto.ts"\nSecondAuto="*res://scenes/second-auto.tscn"\n[display]\nwindow/size/viewport_width=160\nwindow/size/viewport_height=120\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[physics]\ncommon/physics_ticks_per_second=48\n[input]\np0_jump={"deadzone":0.5,"events":[]}\n[p0]\nmarker="configured-before-start"\n[GodotJS]\nruntime/debugger/debugger_port=0\n`);
 return {name:options.uidMain?'boot-uid':'boot',files,sources,marker:'P0_BOOT_REPORT',failureMarker:'P0_BOOT_FAILED',expectedEntries:['Node','Node2D','Control','scene']};
}

export async function writeBootProject(directory,options={}){
 const fixture=await createBootFixture(options);for(const [uri,bytes]of fixture.files){const path=resolve(directory,uri.slice(6));await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}return fixture;
}

export async function createBootFaultFixture(){
 const source=`import {Node2D} from 'godot';
export default class FaultEntry extends Node2D {
 frames=0;readyBegan=false;
 _ready(){this.readyBegan=true;throw Error('P0_EXPECTED_READY_FAILURE');}
 _process(_dt:number){if(++this.frames===3){console.log('P0_BOOT_FAULT_REPORT '+JSON.stringify({readyBegan:this.readyBegan,processContinued:true,frames:this.frames}));this.get_tree().quit(0);}}
}
`;
 const out=ts.transpileModule(source,{fileName:'fault-entry.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:false,sourceMap:true,inlineSources:true}});
 const map=JSON.parse(out.sourceMapText);map.sources=['res://src/fault-entry.ts'];map.file='fault-entry.js';
 const files=new Map(Object.entries({
  'res://src/fault-entry.ts':source,
  'res://.godot/GodotJS/src/fault-entry.js':out.outputText,
  'res://.godot/GodotJS/src/fault-entry.js.map':JSON.stringify(map),
  'res://main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/fault-entry.ts" id="1"]\n[node name="FaultEntry" type="Node2D"]\nscript = ExtResource("1")\n',
  'res://project.godot':'config_version=5\n[application]\nconfig/name="P0 native error mapping"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n',
 }).map(([path,text])=>[path,encode(text)]));
 return {name:'boot-fault',files,marker:'P0_BOOT_FAULT_REPORT',expectedError:'P0_EXPECTED_READY_FAILURE',expectedSource:'src/fault-entry.ts:4'};
}
