import * as React from 'react';
import {DirectRoot,EngineNode,useFrame} from './react-direct';
declare const require:(id:string)=>any;
const G=require('godot');
const call=(o:any,n:string,...args:any[])=>{const fn=o[n]??o[n.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())];return fn.apply(o,args);};
const assert=(value:any,message:string)=>{if(!value)throw Error('P0_REACT: '+message);};
const checks:Record<string,boolean>={commitOnly:false,abandonedRender:false,strictNoDuplicate:false,nativeRef:false,variantProps:false,removedPropertyRestore:false,resourceIdentity:false,resourceSharing:false,signalUpdate:false,signalCleanup:false,signalReentrantUnmount:false,externalFree:false,portalBorrowed:false,processHook:false,physicsHook:false,physicsQuery:false,unmount:false,allocationAccounting:false,noLegacyBridge:false};
export default class P0ReactProbe extends G.Node {
 private root!:DirectRoot;private owned:any;private a:any;private b:any;private button:any;private portalChild:any;private mount:any;private borrowed:any;private sentinel:any;private shared:any;private body:any;
 private frame=0;private processCalls=0;private physicsCalls=0;private pressed=0;private inPhysics=false;private done=false;private suspendedCalls=0;private baselineChildren=0;private reentrantRoot?:DirectRoot;private reentrantButton:any;private reentrantCalls=0;private ownedId='';private reentrantContainer:any;
 _ready(){try{
  this.mount=new G.Node2D();call(this.mount,'set_name','DirectMount');call(this,'add_child',this.mount);
  this.borrowed=new G.Node2D();call(this.borrowed,'set_name','BorrowedMount');call(this,'add_child',this.borrowed);this.sentinel=new G.Node();call(this.sentinel,'set_name','ExternalSentinel');call(this.borrowed,'add_child',this.sentinel);this.baselineChildren=call(this.borrowed,'get_child_count');
  this.body=new G.StaticBody2D();this.body.position=new G.Vector2(0,20);const collision=new G.CollisionShape2D(),shape=new G.RectangleShape2D();shape.size=new G.Vector2(20,20);collision.shape=shape;call(this.body,'add_child',collision);call(this.mount,'add_child',this.body);
  this.shared=new G.CanvasItemMaterial();this.root=new DirectRoot(G,this.mount);
  const never=new Promise(()=>{}),self=this;
  function Suspender():never{self.suspendedCalls++;throw never;}
  this.root.render(React.createElement(React.Suspense,{fallback:React.createElement(EngineNode,{ctor:G.Node2D,native:{name:'Fallback'}})},React.createElement(React.Fragment,null,React.createElement(EngineNode,{ctor:G.Node2D,native:{name:'Abandoned'}}),React.createElement(Suspender))));
  checks.commitOnly=this.root.stats.created===1&&this.root.stats.prepared>this.root.stats.created;
  checks.abandonedRender=this.suspendedCalls>0&&!call(this.mount,'get_node_or_null','Abandoned')&&!!call(this.mount,'get_node_or_null','Fallback');
  this.root.render(this.tree(1));
  checks.nativeRef=this.owned instanceof G.Node2D&&typeof this.owned.get_instance_id==='function'&&call(this.owned,'get_parent')===this.mount;
  this.ownedId=String(call(this.owned,'get_instance_id'));
  checks.variantProps=call(this.owned,'get','position').x===12&&call(this.owned,'get','position').y===34&&String(call(this.owned,'get_name'))==='Owned';
  checks.resourceIdentity=this.a.material===this.shared&&this.b.material===this.shared&&this.a.material===this.b.material;
  this.a.material.blend_mode=1;checks.resourceSharing=this.b.material.blend_mode===1;
  checks.strictNoDuplicate=call(this.owned,'get_child_count')===3&&this.root.frames.process.size===1&&this.root.frames.physics.size===1;
  call(this.button,'emit_signal','pressed');assert(this.pressed===1,'first signal handler');
  this.root.render(this.tree(10));call(this.button,'emit_signal','pressed');checks.signalUpdate=this.pressed===11&&call(call(this.button,'get_signal_connection_list','pressed'),'size')===1;
  checks.portalBorrowed=call(this.portalChild,'get_parent')===this.borrowed&&call(this.sentinel,'get_parent')===this.borrowed;
  // Navigation/structural calls are deliberately made directly, proving no legacy ownership root was claimed.
  const moved=new G.Node2D();call(this.owned,'add_child',moved);call(moved,'reparent',this.borrowed);call(this.borrowed,'remove_child',moved);call(moved,'free');checks.noLegacyBridge=true;
 }catch(error){this.finish(error);}}
 private tree(increment:number,position=true){const self=this;
  function Frames(){useFrame('process',()=>self.processCalls++);useFrame('physics',()=>{self.physicsCalls++;checks.physicsHook=self.inPhysics;const query=call(G.PhysicsRayQueryParameters2D,'create',new G.Vector2(0,0),new G.Vector2(0,40)),space=call(self.mount,'get_world_2d').direct_space_state,hit=call(space,'intersect_ray',query);if(call(hit,'size')>0)checks.physicsQuery=call(hit,'get','collider')===self.body;});return null;}
  // Keep a stable function component across updates, otherwise effect remounting would mask duplicate registrations.
  (this as any).Frames??=Frames;
  return React.createElement(React.StrictMode,null,React.createElement(EngineNode,{ctor:G.Node2D,native:{name:'Owned',...(position?{position:new G.Vector2(12,34)}:{})},ref:(node:any)=>{if(node)this.owned=node;}},React.createElement(EngineNode,{ctor:G.Sprite2D,native:{name:'A',material:this.shared},ref:(node:any)=>{if(node)this.a=node;}}),React.createElement(EngineNode,{ctor:G.Sprite2D,native:{name:'B',material:this.shared,position:new G.Vector2(increment,0)},ref:(node:any)=>{if(node)this.b=node;}}),React.createElement(EngineNode,{ctor:G.Button,native:{name:'Button',text:'native'},on:{pressed:()=>this.pressed+=increment},ref:(node:any)=>{if(node)this.button=node;}})),React.createElement((this as any).Frames),this.root.portal(React.createElement(EngineNode,{ctor:G.Node2D,native:{name:'PortalOwned'},ref:(node:any)=>{if(node)this.portalChild=node;}}),this.borrowed));
 }
 _process(dt:number){if(this.done||!this.root)return;try{this.root.process(dt);this.frame++;
  if(this.frame===4){checks.processHook=this.processCalls>=4;call(this.b,'free');}
  if(this.frame===5){this.root.render(this.tree(20));checks.externalFree=!this.root.alive(this.b)&&this.root.stats.invalidations>0;}
  if(this.frame===6){this.root.render(this.tree(20,false));const position=call(this.owned,'get','position');checks.removedPropertyRestore=position.x===0&&position.y===0;}
  if(this.frame===7){this.root.render(this.tree(20));checks.removedPropertyRestore=checks.removedPropertyRestore&&call(this.owned,'get','position').x===12;}
  if(this.frame===8){const connections=this.root.stats.connections,pressed=this.pressed;this.root.render(null);call(this.button,'emit_signal','pressed');checks.signalCleanup=connections===1&&this.root.stats.disconnects===1&&this.pressed===pressed;checks.unmount=this.root.frames.process.size===0&&this.root.frames.physics.size===0;}
  if(this.frame===9){const container=new G.Node2D();this.reentrantContainer=container;call(this,'add_child',container);this.reentrantRoot=new DirectRoot(G,container);this.reentrantRoot.render(React.createElement(EngineNode,{ctor:G.Button,ref:(node:any)=>{if(node)this.reentrantButton=node;},on:{pressed:()=>{this.reentrantCalls++;this.reentrantRoot!.render(null);}}}));call(this.reentrantButton,'emit_signal','pressed');checks.signalReentrantUnmount=this.reentrantCalls===1&&this.reentrantRoot.stats.disconnects===1&&call(container,'get_child_count')===0;}
  if(this.frame===12){checks.portalBorrowed=checks.portalBorrowed&&this.root.alive(this.borrowed)&&this.root.alive(this.sentinel)&&call(this.borrowed,'get_child_count')===this.baselineChildren;checks.unmount=checks.unmount&&!this.root.alive(this.owned)&&!this.root.alive(this.a)&&!this.root.alive(this.button)&&!this.root.alive(this.portalChild)&&call(this.mount,'get_child_count')===1;checks.signalReentrantUnmount=checks.signalReentrantUnmount&&!this.root.alive(this.reentrantButton)&&this.reentrantRoot!.errors.length===0;checks.allocationAccounting=this.root.stats.created===this.root.stats.freed+this.root.stats.invalidations&&this.reentrantRoot!.stats.created===1&&this.reentrantRoot!.stats.freed===1;assert(this.root.errors.length===0,'React errors '+JSON.stringify(this.root.errors));for(const [name,ok]of Object.entries(checks))assert(ok,name);this.finish();}
 }catch(error){this.finish(error);}}
 _physics_process(dt:number){if(this.done||!this.root)return;try{this.inPhysics=true;this.root.physics(dt);}catch(error){this.finish(error);}finally{this.inPhysics=false;}}
 private finish(error?:unknown){if(this.done)return;this.done=true;const cleanup=this.root?{frames:[this.root.frames.process.size,this.root.frames.physics.size],alive:{owned:this.root.alive(this.owned),a:this.root.alive(this.a),b:this.root.alive(this.b),button:this.root.alive(this.button),portalChild:this.root.alive(this.portalChild)},mountChildren:call(this.mount,'get_child_count'),identity:{ownedOriginal:this.ownedId,ownedCurrent:this.root.alive(this.owned)?String(call(this.owned,'get_instance_id')):null,reentrantContainer:this.reentrantContainer?String(call(this.reentrantContainer,'get_instance_id')):null,sameRef:this.owned===this.reentrantContainer}}:undefined;const report={status:error?'failed':'passed',checks,frames:this.frame,processCalls:this.processCalls,physicsCalls:this.physicsCalls,stats:this.root?.stats,cleanup,errors:this.root?.errors??[],...(error?{error:String(error),stack:(error as any)?.stack}:{} )};console.log('P0_REACT_REPORT '+JSON.stringify(report));call(call(this,'get_tree'),'quit',error?1:0);}
}
