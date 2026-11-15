'use strict';
// Native semantics needed by the direct renderer. Values copy on get/set;
// Resources and Objects preserve identity, as they do in Godot Variant.
module.exports=function engineFixture(){
  let serial=0;const objects=new Set(),pending=[],calls=[],roots=new Set(),emitting=new WeakSet();let autoPump=true;
  class Vector2{constructor(x=0,y=0){if(x instanceof Vector2){this.x=x.x;this.y=x.y;}else{this.x=x;this.y=y;}}}
  const copy=value=>value instanceof Vector2?new Vector2(value):value;
  class Callable{static create(callback){return callback;}}
  class Node{
    constructor(){this.id=++serial;this.alive=true;this.parent=null;this.children=[];this.signals=new Map();this.properties={name:'Node',text:'default',visible:true,position:new Vector2(0,0),material:null,custom_value:0,readonly_value:1};objects.add(this);calls.push(['create',this]);}
    is_class(name){return name==='Node'||name===this.constructor.name;}
    get_instance_id(){return this.id;}
    get_property_list(){return Object.keys(this.properties).map(name=>({name,usage:name==='readonly_value'?1<<28:6}));}
    get_signal_list(){return ['pressed','value_changed','ready'].map(name=>({name}));}
    get(name){return copy(this.properties[name]);}
    set(name,value){if(!this.alive)throw Error('dead setter');this.properties[name]=copy(value);calls.push(['set',this,name,value]);if(name==='custom_value')this.emit_signal('value_changed',value);}
    get_children(includeInternal=false){return this.children.filter(child=>includeInternal||!child.internal);}
    get_parent(){return this.parent;}
    get_index(){return this.parent?this.parent.children.indexOf(this):-1;}
    add_child(child){if(child.parent)throw Error('already parented');child.parent=this;this.children.push(child);calls.push(['add',this,child]);if(this.is_inside_tree())child.enterTree();}
    enterTree(){this.emit_signal('ready');for(const child of this.children)child.enterTree();}
    remove_child(child){if(child.parent!==this)throw Error('not a child');this.children.splice(this.children.indexOf(child),1);child.parent=null;calls.push(['remove',this,child]);}
    move_child(child,index){const previous=this.children.indexOf(child);if(previous<0)throw Error('missing child');this.children.splice(previous,1);this.children.splice(index<0?this.children.length:index,0,child);}
    is_inside_tree(){return this===tree||!!this.parent?.is_inside_tree();}
    get_tree(){return this.is_inside_tree()?tree:null;}
    get_process_delta_time(){return .016;}
    get_physics_process_delta_time(){return .02;}
    connect(name,callback){let slots=this.signals.get(name);if(!slots)this.signals.set(name,slots=new Set());if(slots.has(callback))return 1;slots.add(callback);calls.push(['connect',this,name]);return 0;}
    is_connected(name,callback){return !!this.signals.get(name)?.has(callback);}
    disconnect(name,callback){this.signals.get(name)?.delete(callback);calls.push(['disconnect',this,name]);}
    emit_signal(name,...args){const nested=emitting.has(this);emitting.add(this);try{for(const callback of [...(this.signals.get(name)??[])])callback(...args);}finally{if(!nested)emitting.delete(this);}if(autoPump)for(const root of roots)root.pump();}
    queue_free(){calls.push(['queue_free',this]);pending.push(this);}
    free(){if(emitting.has(this))throw Error("Object is locked and can't be freed");if(!this.alive)throw Error('double free');calls.push(['free',this]);for(const child of [...this.children])child.free();if(this.parent)this.parent.remove_child(this);this.alive=false;objects.delete(this);this.signals.clear();}
  }
  class Label extends Node{}
  class Material{}
  const tree=new Node();tree.get_signal_list=()=>['process_frame','physics_frame'].map(name=>({name}));
  let physicsFrame=false;const godot={Node,Label,Material,Vector2,Callable,Engine:{is_in_physics_frame:()=>physicsFrame},is_instance_valid:object=>!!object?.alive};
  const container=new Node();tree.add_child(container);
  const drive=(root,immediate=true)=>{roots.add(root);if(immediate){const render=root.render.bind(root);root.render=element=>{render(element);root.flush();};}return root;};
  return {godot,Node,Label,Material,Vector2,tree,container,calls,objects,drive,
    setPhysics(value){physicsFrame=value;},setAutoPump(value){autoPump=value;},
    step(){for(const root of roots)root.pump();},
    async flushDeletes(){for(let pass=0;pass<100;pass++){await Promise.resolve();while(pending.length){const object=pending.shift();if(object.alive)object.free();}for(const root of roots){root.pump();root.getStats();}if(!pending.length&&![...roots].some(root=>root.hasRetirements()))return;}throw Error('Native retirement did not settle');},
    setup(options={}){const {createRoot}=require('../dist/engine');const {immediate=true,...nativeOptions}=options;return drive(createRoot(container,{godot,autoProcess:false,...nativeOptions}),immediate);}};
};
