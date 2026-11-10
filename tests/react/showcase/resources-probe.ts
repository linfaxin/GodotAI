declare const require:(id:string)=>any;
const G=require('godot');
import * as React from '../../../scripts/jsb.react/node_modules/react';
import * as SDK from '../../../scripts/jsb.react/dist';
import {createGodotPort} from '../../../scripts/jsb.react/dist/godot';
import {emptyResourcePlan} from '../../../apps/playground/src/project-resources';
import {installProjectResources} from '../../../apps/playground/src/native-project-resources';
import {ProjectScene,Services} from '../../../apps/playground/src/api';
const invoke=(o:any,n:string,...a:any[])=>(o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,a);
const assert=(v:unknown,message:string)=>{if(!v)throw Error(message);};
export default class ResourcesProbe extends G.Node {
 private testRoot:any;private installation:any;private ticks=0;private next2:any;private next3:any;
 _physics_process(dt:number){if(!this.testRoot)return;try{this.testRoot.pump();this.testRoot.physics(dt);if(++this.ticks<10)return;assert(this.next2&&Math.abs(this.next2.x-2)<.01&&Math.abs(this.next2.y-2)<.01,'2D navigation path');assert(this.next3&&Math.abs(this.next3.x-2)<.01&&Math.abs(this.next3.z-2)<.01,'3D navigation path');this.testRoot.shutdown();this.testRoot=undefined;this.installation.dispose();assert(!invoke(G.FileAccess,'file_exists',this.installation.assets.image.uri),'resource cleanup');this.installation=undefined;console.log('SHOWCASE_RESOURCES_OK '+JSON.stringify({animationX:5,tiles:true,grid:true,scene:true,navigation2D:true,navigation3D:true,cleanup:true}));invoke(invoke(this,'get_tree'),'quit',0);}catch(error){console.error('SHOWCASE_RESOURCES_FAILED',String(error));try{this.testRoot?.shutdown();}catch{}this.testRoot=undefined;this.installation?.dispose();invoke(invoke(this,'get_tree'),'quit',1);}}

 _ready(){let installed:any,root:any,native:any;try{
  const plan=emptyResourcePlan('native_resources');plan.images.image={width:2,height:1,rgba:[255,0,0,255,0,255,0,255]};
  plan.sounds.sound={format:0,stereo:false,mixRate:8000,data:[0,1,2,3]};
  plan.definitions={material:{type:'StandardMaterial3D',properties:{albedo_texture:'image'}},mesh:{type:'BoxMesh',properties:{size:{x:1,y:2,z:1},material:'material'}},shape:{type:'BoxShape3D',properties:{size:{x:1,y:2,z:1}}},frames:{type:'SpriteFrames',animations:{default:{fps:5,frames:[{texture:'image',region:[0,0,1,1]},{texture:'image',region:[1,0,1,1]}]}}},library:{type:'AnimationLibrary',animations:{move:{length:1,tracks:[{path:'Mover:position',keys:[[0,{x:0,y:0}],[1,{x:10,y:0}]]}]}}},tiles:{type:'TileSet',texture:'image',tileSize:{x:1,y:1},tiles:[{x:0,y:0}]},grid:{type:'MeshLibrary',items:[{mesh:'mesh',shape:'shape'}]},nav2:{type:'NavigationPolygon',vertices:[{x:0,y:0},{x:10,y:0},{x:0,y:10}],polygons:[[0,1,2]]},nav3:{type:'NavigationMesh',vertices:[{x:0,y:0,z:0},{x:10,y:0,z:0},{x:0,y:0,z:10}],polygons:[[0,2,1]]}};
  plan.definitions.frames.animations.walk={fps:5,frames:['image','image','image']};
  plan.definitions.shader={type:'ShaderMaterial',code:'shader_type canvas_item;\nvoid fragment(){COLOR=vec4(1.0,0.0,0.0,1.0);}'};
  plan.scenes['/box.scene.json']={type:'MeshInstance3D',props:{name:'Box',mesh:{asset:'mesh'}}};
  installed=installProjectResources(G,plan);
  native=createGodotPort(this,{rootId:'resource-probe',rootInstance:'resources'});
  root=SDK.createRoot(native.port,native.containerKey,{generation:'resources',profileId:'showcase-v1',assets:installed.assets,mode:'production'});
  root.preloadAssets(Object.keys(installed.assets));root.pump();
  const errors=root.getErrors();if(errors.length)throw errors[0];
  function Shader(){const material=SDK.useAsset(SDK.asset('shader','ShaderMaterial'));return React.createElement(SDK.ColorRect,{material,size:{x:4,y:4}});}
  let controlledSprite:any;function ControlledSprite(){const spriteFrames=SDK.useAsset(SDK.asset('frames','SpriteFrames'));return React.createElement(SDK.AnimatedSprite2D,{spriteFrames,animation:'walk',frame:2,frameProgress:.25,ref:(value:any)=>controlledSprite=value});}
  let mover:any,playing=false,tileWritten=false,gridWritten=false;
  function Animation(){const library=SDK.useAsset(SDK.asset('library','AnimationLibrary')),ref=SDK.useNodeRef<'AnimationPlayer'>();SDK.useProcess(ref,{writes:['animationLibraries','playback']},c=>{assert(c.command('addLibrary','',library)===0,'library bind');c.command('play','move',-1,1,false);c.command('advance',.5);});return React.createElement(SDK.AnimationPlayer,{ref,callbackModeProcess:2,engineOwned:['animationLibraries','playback']});}
  function Sprite(){const frames=SDK.useAsset(SDK.asset('frames','SpriteFrames')),ref=SDK.useNodeRef<'AnimatedSprite2D'>();SDK.useProcess(ref,{writes:['animation','frame','frameProgress']},c=>{c.command('play','default',1,false);playing=c.command('isPlaying');});return React.createElement(SDK.AnimatedSprite2D,{ref,spriteFrames:frames,engineOwned:['animation','frame','frameProgress']});}
  function Tile(){const tiles=SDK.useAsset(SDK.asset('tiles','TileSet')),ref=SDK.useNodeRef<'TileMapLayer'>();SDK.useProcess(ref,{writes:['cells']},c=>{c.command('setCell',{x:-2,y:3},0,{x:0,y:0},0);assert(c.command('getCellSourceId',{x:-2,y:3})===0,'tile source');assert(JSON.stringify(c.command('getCellAtlasCoords',{x:-2,y:3}))==='{"x":0,"y":0}','integer result');tileWritten=true;});return React.createElement(SDK.TileMapLayer,{ref,tileSet:tiles,engineOwned:['cells']});}
  function Grid(){const library=SDK.useAsset(SDK.asset('grid','MeshLibrary')),ref=SDK.useNodeRef<'GridMap'>();SDK.useProcess(ref,{writes:['cells']},c=>{c.command('setCellItem',{x:1,y:0,z:-1},0,0);assert(c.command('getCellItem',{x:1,y:0,z:-1})===0,'grid item');gridWritten=true;});return React.createElement(SDK.GridMap,{ref,meshLibrary:library,engineOwned:['cells']});}
  const probe=this;
  function Navigation(){const polygon=SDK.useAsset(SDK.asset('nav2','NavigationPolygon')),mesh=SDK.useAsset(SDK.asset('nav3','NavigationMesh')),ref2=SDK.useNodeRef<'NavigationAgent2D'>(),ref3=SDK.useNodeRef<'NavigationAgent3D'>();SDK.usePhysicsProcess(ref2,{},c=>{if(probe.ticks>3)probe.next2=c.command('getNextPathPosition');});SDK.usePhysicsProcess(ref3,{},c=>{if(probe.ticks>3)probe.next3=c.command('getNextPathPosition');});return React.createElement(SDK.Node,null,React.createElement(SDK.NavigationRegion2D,{navigationPolygon:polygon}),React.createElement(SDK.Node2D,{position:{x:1,y:1}},React.createElement(SDK.NavigationAgent2D,{ref:ref2,targetPosition:{x:2,y:2},pathDesiredDistance:.01,targetDesiredDistance:.01})),React.createElement(SDK.NavigationRegion3D,{navigationMesh:mesh}),React.createElement(SDK.Node3D,{position:{x:1,y:0,z:1}},React.createElement(SDK.NavigationAgent3D,{ref:ref3,targetPosition:{x:2,y:0,z:2},pathDesiredDistance:.01,targetDesiredDistance:.01})));}
  root.render(React.createElement(Services.Provider,{value:{scenes:installed.scenes} as any},React.createElement(SDK.Node,null,React.createElement(SDK.Node2D,null,React.createElement(SDK.Node2D,{name:'Mover',ref:(v:any)=>mover=v,engineOwned:['transform2d']}),React.createElement(Animation)),React.createElement(Shader),React.createElement(ControlledSprite),React.createElement(Sprite),React.createElement(Tile),React.createElement(Grid),React.createElement(Navigation),React.createElement(ProjectScene,{name:'/box.scene.json'}))));
  root.pump();assert(controlledSprite.read('frame')===2&&controlledSprite.read('frameProgress')===.25,'non-default sprite construction');root.process(.016);assert(Math.abs(mover.readPosition().x-5)<.01,'animation updated native transform');assert(playing&&tileWritten&&gridWritten,'sprite/tile/grid commands ran');assert(root.getHostGraph().some((node:any)=>node.type==='MeshInstance3D'),'project scene instantiated');
  this.testRoot=root;this.installation=installed;
 }catch(error){console.error('SHOWCASE_RESOURCES_FAILED',String(error),(error as any).stack);try{root?.shutdown();}catch{}try{installed?.dispose();}catch{}invoke(invoke(this,'get_tree'),'quit',1);}}
}
