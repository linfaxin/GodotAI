/** Actual direct-renderer virtual host behavior and authoritative scope proof. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(repository,'scripts/jsb.react/package.json')),{build}=require('esbuild');
const argv=process.argv.slice(2),arg=(name,fallback)=>{const at=argv.indexOf(name);return at<0?fallback:argv[at+1];};
const binary=path.resolve(arg('--godot',process.env.GODOT??path.join(repository,'tests/bin/godot-host-qjs'))),out=path.resolve(arg('--out',path.join(repository,'work/engine-host-operations')));
const audio=argv.includes('--audio'),signals=argv.includes('--signals'),bareOnly=argv.includes('--bare');
await fs.mkdir(out,{recursive:true});const project=await fs.mkdtemp(path.join(out,'native-'));await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Engine HostOperations"\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="Probe" type="Node"]\nscript=ExtResource("1")\n');
await fs.writeFile(path.join(project,'mix.tres'),'[gd_resource type="AudioBusLayout" format=3]\n[resource]\nbus/0/name = &"Fx"\nbus/0/solo = false\nbus/0/mute = false\nbus/0/bypass_fx = false\nbus/0/volume_db = 0.0\nbus/0/send = &"Master"\n');
await fs.writeFile(path.join(project,'shape.tres'),'[gd_resource type="RectangleShape2D" format=3]\n[resource]\nsize = Vector2(8, 8)\n');
const source=`import * as React from 'react';import {createRoot} from '@godot-js/react/engine';import * as C from '@godot-js/react/engine-components';const G=require('godot'),internal=require('godot-jsb').internal;
const h=React.createElement,refs:any={},seen:any={menuSignals:0,contacts:[],navigation:[],foreign:[]},audio=${audio},signals=${signals},bareOnly=${bareOnly},countBuses=()=>Number(G.AudioServer.bus_count??G.AudioServer.busCount??G.AudioServer.get_bus_count?.()??G.AudioServer.getBusCount?.()),initialBuses=countBuses();
const contact=(event:any)=>{if(!Object.isFrozen(event)||!event.collider?.isValid()||!event.colliderShape?.isValid()||!event.localShape?.isValid()||event.colliderShapeIndex!==0||event.localShapeIndex!==0)throw Error('shape contact did not snapshot claimed shape handles');seen.contacts.push(event);};
const navigation=(event:any)=>{if(!Object.isFrozen(event)||event.position.x!==3||event.position.y!==4||event.owner.type!=='StaticBody2D'||'rid'in event||'unsafe'in event)throw Error('navigation signal exposed raw native fields');seen.navigation.push(event);};
function App(){
 refs.menu=C.useNodeRef();refs.code=C.useNodeRef();refs.option=C.useNodeRef();refs.rich=C.useNodeRef();refs.control=C.useNodeRef();refs.bus=C.useNodeRef();refs.bare=C.useNodeRef();refs.mover=C.useNodeRef();
 C.useNativeReady(refs.bare,(handle:any)=>()=>{seen.bareCleanup=handle.read('name');seen.bareReadable=handle.isValid();});
 C.useNativeReady(refs.control,(handle:any)=>()=>{seen.layoutCleanup=handle.read('layout').join(',');seen.layoutReadable=handle.isValid();});
 React.useEffect(()=>{if(bareOnly)return;const handle=refs.code.current;return()=>{seen.passiveCleanup=handle.read('searchText');seen.passiveReadable=handle.isValid();};},[]);
 C.useProcess(refs.mover,{writes:['position']},(node:any)=>{if(seen.moved)return;node.setPosition({x:11,y:13});seen.moved=true;});
 C.useProcess(refs.menu,{writes:['menuState']},(node:any)=>{if(seen.checked)return;node.command('setMenuItemChecked',7,true);seen.checked=node.command('isMenuItemChecked',7);seen.menuRect=node.command('getMenuRect');});
 C.useProcess(refs.code,{writes:['lineMarkers']},(node:any)=>{if(seen.bookmark)return;node.command('setLineAsBookmarked',0,true);seen.bookmark=node.command('isLineBookmarked',0);seen.search=node.command('search','two',0,0,0);});
 C.useProcess(refs.rich,{writes:['richText']},(node:any)=>{if(seen.appended)return;node.command('appendText','!');seen.rich=node.command('getParsedText');seen.appended=true;});
 C.useProcess(refs.bus,{writes:['audioBus']},(node:any)=>{if(!audio||seen.audio)return;node.command('setBusVolume',-6);seen.audio=node.command('getBusVolume')===-6;});
 if(bareOnly)return h(React.Fragment,null,h(C.Node,{ref:refs.bare}),h(C.Node2D,{name:'Mover',ref:refs.mover,engineOwned:['position']}));
 return h(React.Fragment,null,
  h(C.Node,{ref:refs.bare}),h(C.Node2D,{name:'Mover',ref:refs.mover,engineOwned:['position']}),
  signals?h(C.Area2D,{name:'Area',position:{x:100,y:100},onBodyEntered:(value:any)=>seen.foreign.push(value),onBodyShapeEntered:contact,onBodyShapeExited:contact,onAreaShapeEntered:contact,onAreaShapeExited:contact},h(C.CollisionShape2D,{name:'AreaShape',shape:C.asset('shape','RectangleShape2D')})):null,
  signals?h(C.StaticBody2D,{name:'Body',position:{x:1000,y:1000}},h(C.CollisionShape2D,{name:'BodyShape',shape:C.asset('shape','RectangleShape2D')})):null,
  signals?h(C.Area2D,{name:'AreaPeer',position:{x:2000,y:2000}},h(C.CollisionShape2D,{name:'PeerShape',shape:C.asset('shape','RectangleShape2D')})):null,
  signals?h(C.Node2D,{name:'NavParent'},h(C.NavigationAgent2D,{name:'Agent',onWaypointReached:navigation,onLinkReached:navigation})):null,
  audio?h(C.Node,{name:'BusControl',ref:refs.bus,busName:'Fx',engineOwned:['audioBus']}):null,
  h(C.MenuButton,{name:'Menu',ref:refs.menu,engineOwned:['menuState'],initial:{items:[{id:7,text:'Check',checkable:true}]},onIdPressed:(id:number)=>{if(id===7)seen.menuSignals++;}}),
  h(C.CodeEdit,{name:'Code',ref:refs.code,text:'one\\ntwo',searchText:'two',drawBookmarks:true,engineOwned:['lineMarkers']}),
  h(C.OptionButton,{name:'Options',ref:refs.option,items:['one','two']}),
  h(C.RichTextLabel,{name:'Rich',ref:refs.rich,engineOwned:['richText'],initial:{text:'hello'}}),
  h(C.Control,{name:'Layout',ref:refs.control,layout:{anchors:[0,0,0,0],offsets:[2,3,40,50]}}));
}
export default class Probe extends G.Node{
 root:any;frames=0;closing=false;failed=false;scope:any;
 fail(error:any){if(this.failed)return;this.failed=true;console.error('ENGINE_HOST_OPERATIONS_FAILED '+String(error));this.get_tree().quit(1);}
 _ready(){try{this.root=createRoot(this,{autoProcess:false,onError:(error:any)=>this.fail(error)});const services=C.configureEngineComponents(this.root,{profileId:bareOnly?'core-ui-v1':'showcase-v1',assets:{...(audio?{mix:{uri:'res://mix.tres',type:'AudioBusLayout'}}:{}),...(signals?{shape:{uri:'res://shape.tres',type:'RectangleShape2D'}}:{})}});if(audio)services.preloadAssets(['mix']);this.root.render(h(App));this.root.flush();}catch(error){this.fail(error);}}
 _process(delta:number){if(this.failed)return;try{if(this.closing){this.root.session.drainClose();return;}this.root.processFrame(delta);this.frames++;
  if(!bareOnly&&this.frames===3){this.get_node('Menu').get_popup().emit_signal('id_pressed',7);
   if(signals){const area=this.get_node('Area'),body=this.get_node('Body'),peer=this.get_node('AreaPeer');for(const name of ['body_shape_entered','body_shape_exited'])area.emit_signal(name,body.get_rid(),body,0,0);for(const name of ['area_shape_entered','area_shape_exited'])area.emit_signal(name,peer.get_rid(),peer,0,0);
    const unmanaged=new G.StaticBody2D();area.emit_signal('body_entered',unmanaged);unmanaged.free();const data=new G.GDictionary();data.set('position',new G.Vector2(3,4));data.set('type',0);data.set('owner',body);data.set('rid',body.get_rid());data.set('unsafe','must drop');for(const name of ['waypoint_reached','link_reached'])this.get_node('NavParent/Agent').emit_signal(name,data);
   }
  }
  if(this.frames===6){
   if(!bareOnly&&(!seen.checked||!seen.bookmark||seen.search.x!==0||seen.search.y!==1||seen.menuSignals!==1))throw Error('virtual command or signal '+JSON.stringify(seen));
   if(!bareOnly&&(seen.rich!=='hello!'||refs.code.current.read('searchText')!=='two'||refs.option.current.read('items').join(',')!=='one,two'||refs.control.current.read('layout').join(',')!=='0,0,0,0,2,3,40,50'))throw Error('virtual property hydration '+JSON.stringify({rich:refs.rich.current.read('text'),search:refs.code.current.read('searchText'),options:refs.option.current.read('items'),layout:refs.control.current.read('layout')}));
   if(!seen.moved||refs.mover.current.readPosition().x!==11||refs.mover.current.readPosition().y!==13)throw Error('standard native property setter command');
   if(signals&&(seen.contacts.length!==4||seen.navigation.length!==2||seen.foreign.length!==1||seen.foreign[0]?.kind!=='unmanaged-node'||typeof seen.foreign[0]?.objectId!=='string'||'get_instance_id'in seen.foreign[0]))throw Error('native signal translation '+JSON.stringify({contacts:seen.contacts.length,navigation:seen.navigation.length,foreign:seen.foreign}));
   if(audio&&(!seen.audio||countBuses()!==initialBuses+1||refs.bus.current.read('busName')!=='Fx'))throw Error('scoped audio registration');
   const node=this.get_node(bareOnly?'Mover':'Menu'),scope=this.root.nativeOperationContext(node).scope,foreign=internal.native_runtime.openScope();this.scope=scope;let refused=false;
   try{internal.native_host_operations.read(foreign,node,'name');}catch(error){refused=String(error).includes('E_ENGINE_HOST_CLAIM');}internal.native_runtime.closeScope(foreign);if(!refused)throw Error('cross-scope operation admitted');
   let legacy=!internal.react;try{if(internal.react)internal.react.openRoot(this,'mixed','mixed');}catch(error){legacy=String(error).includes('E_RENDERER_WORLD_MODE');}if(!legacy)throw Error('legacy renderer mixed into engine world');
   const stale=bareOnly?refs.mover.current:refs.menu.current;this.closing=true;this.root.close().then((result:any)=>{if(result.status!=='complete'||stale.isValid())throw Error('close '+result.status);if(!seen.bareReadable||typeof seen.bareCleanup!=='string'||!seen.bareCleanup)throw Error('first bare Node cleanup read');if(!bareOnly&&(seen.layoutCleanup!=='0,0,0,0,2,3,40,50'||seen.passiveCleanup!=='two'||!seen.layoutReadable||!seen.passiveReadable))throw Error('readonly virtual cleanup '+JSON.stringify({layout:seen.layoutCleanup,passive:seen.passiveCleanup,layoutReadable:seen.layoutReadable,passiveReadable:seen.passiveReadable}));let rejected=false;try{internal.native_host_operations.finalize(scope);}catch(error){rejected=String(error).includes('E_ENGINE_HOST_SCOPE');}if(!rejected)throw Error('closed scope admitted');if(audio&&countBuses()!==initialBuses)throw Error('scoped audio cleanup leaked');console.log('ENGINE_HOST_OPERATIONS_OK '+JSON.stringify({commands:['menu','bookmark','search','rich','native-property-setter'],properties:['menu','options','search','layout'],menuSignals:seen.menuSignals,shapeSignals:seen.contacts.length,navigationSignals:seen.navigation.length,foreignSignals:seen.foreign.length,cleanupReads:['layout-virtual','passive-virtual','first-bare-node'],scopedAudio:audio?'registered-operated-released':'not-requested',crossScope:'rejected',closedScope:'rejected',legacyWorld:'rejected',close:result.status}));this.get_tree().quit(0);}).catch((error:any)=>this.fail(error));
  }
 }catch(error){this.fail(error);}}
 _physics_process(delta:number){if(this.root&&!this.failed&&!this.closing)this.root.physicsFrame(delta);}
}`;
await fs.writeFile(path.join(project,'Probe.ts'),source);
const bundle=await build({stdin:{contents:source,resolveDir:project,sourcefile:'Probe.ts',loader:'ts'},outfile:path.join(project,'.godot/GodotJS/Probe.js'),bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',external:['godot','godot-jsb'],inject:[path.join(repository,'scripts/jsb.react/dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'engine-sdk',setup(b){b.onResolve({filter:/^(?:react|@godot-js\/react)(?:\/.*)?$/},args=>({path:require.resolve(args.path)}));}}]});
await fs.writeFile(path.join(project,'.godot/GodotJS/Probe.js'),bundle.outputFiles[0].contents);
const execution=spawnSync(binary,['--headless','--path',project,'--quit-after','120','--fixed-fps','60'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const logs=(execution.stdout??'')+(execution.stderr??'');await fs.writeFile(path.join(project,'native.log'),logs);
let passed=execution.status===0&&!execution.error&&logs.includes('ENGINE_HOST_OPERATIONS_OK ')&&!logs.includes('ENGINE_HOST_OPERATIONS_FAILED');
let bareReport;
if(passed&&!bareOnly){const nested=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--godot',binary,'--out',path.join(out,'bare-node'),'--bare'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(nested.stdout)process.stdout.write(nested.stdout);if(nested.stderr)process.stderr.write(nested.stderr);passed=nested.status===0&&!nested.error;try{bareReport=JSON.parse(await fs.readFile(path.join(out,'bare-node/report.json'),'utf8'));}catch{bareReport={status:'failed'};}}
const report={status:passed?'passed':'failed',scope:bareOnly?'actual-native-core-bare-node-cleanup':'actual-native-direct-renderer-host-operations',binary,project,exitCode:execution.status,...(bareReport?{bareNode:bareReport}:{}),log:path.join(project,'native.log')};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(logs);console.log(JSON.stringify(report,null,2));if(!passed)process.exitCode=1;
