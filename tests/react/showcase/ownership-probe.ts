declare const require:(id:string)=>any;const G=require('godot');
import {createGodotPort} from '../../../scripts/jsb.react/dist/godot';
import {emptyResourcePlan} from '../../../apps/playground/src/project-resources';
import {installProjectResources} from '../../../apps/playground/src/native-project-resources';
const invoke=(o:any,n:string,...a:any[])=>(o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,a);
const assert=(v:any,m:string)=>{if(!v)throw Error(m);};
export default class OwnershipProbe extends G.Node{
 _ready(){let installed:any,port:any;try{
  const plan=emptyResourcePlan('ownership');for(const [name,x]of[['a',1],['b',2]] as const)plan.scenes['/'+name+'.scene.json']={type:'Node3D',props:{name:'Scene'},children:[{type:'Node3D',props:{name:'Child',position:{x,y:0,z:0}}}]};
  installed=installProjectResources(G,plan);const native=createGodotPort(this,{rootId:'ownership',rootInstance:'ownership'});port=native.port;port.beginStage('initial');
  const a=port.loadAsset(installed.assets['/a.scene.json'].uri,'PackedScene'),b=port.loadAsset(installed.assets['/b.scene.json'].uri,'PackedScene'),host=port.create('Node3D'),child=port.create('Node3D');port.append(native.containerKey,host,0);port.append(host,child,0);
  for(let i=0;i<20;i++){port.set(host,'__react_packed_scene',i%2?a:b);port.audit();assert(port.children(host).length===1,'prefab children stay private');}
  port.set(host,'__react_packed_scene',a);
  const badPath=installed.assets['/a.scene.json'].uri.replace(/\d+\.tscn$/,'bad.tscn'),file=invoke(G.FileAccess,'open',invoke(G.ProjectSettings,'globalize_path',badPath),2);invoke(file,'store_string','[gd_scene format=3]\n[node name="Bad" type="Node3D"]\n[node name="Escape" type="AnimationPlayer" parent="."]\nroot_node = NodePath("../..")\n');invoke(file,'close');
  const bad=port.loadAsset(badPath,'PackedScene');let rejected=false;try{port.set(host,'__react_packed_scene',bad);}catch(error){rejected=String(error).includes('E_SCENE_PROFILE');}assert(rejected,'escaping native animation target rejected');port.audit();port.endStage();port.beginStage('process');assert((port.command(host,'__react_scene_position',['Child']) as any).x===1,'replacement is transactional');
  for(const path of ['../outside','/root','Child:position']){let rejected=false;try{port.command(host,'__react_scene_position',[path]);}catch(error){rejected=String(error).includes('E_SCENE_COMMAND');}assert(rejected,'scene query cannot escape');}
  port.endStage();port.beginStage('safe');port.set(host,'__react_packed_scene',null);port.audit();port.endStage();
  port.beginStage('safe');const va=port.create('SubViewport'),vb=port.create('SubViewport'),ta=port.create('TextureRect'),tb=port.create('TextureRect');port.set(va,'gui_disable_input',true);port.set(vb,'gui_disable_input',true);port.set(va,'name','ViewA');port.set(vb,'name','ViewB');port.append(native.containerKey,va,1);port.append(native.containerKey,vb,2);port.append(va,ta,0);port.append(vb,tb,0);
  const rejectAudit=(code:string)=>{let rejected=false;try{port.audit();}catch(error){rejected=String(error).includes(code);}assert(rejected,code);};
  port.set(ta,'__react_viewport_texture','..');rejectAudit('E_VIEWPORT_PATH');port.set(ta,'__react_viewport_texture','../../ViewB');port.set(tb,'__react_viewport_texture','../../ViewA');rejectAudit('E_VIEWPORT_CYCLE');port.set(tb,'__react_viewport_texture','');port.audit();
  let master=false;try{port.set(host,'__react_bus','Master');}catch(error){master=String(error).includes('E_AUDIO_BUS');}assert(master,'Master bus cannot be controlled');port.endStage();
  port.beginStage('process');const texture=port.command(va,'get_texture',[]);port.endStage();port.beginStage('safe');port.set(ta,'__react_viewport_texture','');port.set(ta,'texture',texture);rejectAudit('E_VIEWPORT_PATH');port.set(ta,'texture',null);port.audit();port.endStage();
  port.beginStage('cleanup');port.remove(native.containerKey,va);port.free(va);port.remove(native.containerKey,vb);port.free(vb);port.remove(native.containerKey,host);port.free(host);port.quiesce();port.endStage();port.close();port=undefined;
  invoke(G.DirAccess,'remove_absolute',invoke(G.ProjectSettings,'globalize_path',badPath));const cleanup=installed.dispose();assert(cleanup.failures===0,'all generated files removed');installed=undefined;
  console.log('SHOWCASE_OWNERSHIP_OK '+JSON.stringify({replacements:20,privateChildren:true,transactional:true,paths:true,viewportFeedback:true,masterProtected:true,cleanup:true}));invoke(invoke(this,'get_tree'),'quit',0);
 }catch(error){console.error('SHOWCASE_OWNERSHIP_FAILED',String(error),(error as any).stack);try{port?.endStage();port?.beginStage('cleanup');port?.quiesce();port?.forceClose();port?.endStage();}catch{}installed?.dispose();invoke(invoke(this,'get_tree'),'quit',1);}}
}
