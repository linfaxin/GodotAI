const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const E=require('../dist/engine'),C=require('../dist/engine-components');
const fixture=require('./engine-native-fixture.cjs');
const {getHostSchema}=require('../dist/schema');
const h=React.createElement;
function setup(options={}){
 const f=fixture();f.setAutoPump(false);
 class Color{constructor(r,g,b,a){Object.assign(this,{r,g,b,a});}}
 f.godot.Color=Color;
 for(const type of ['Node2D','Label','Button']){
  const Host=class extends f.Node{
   constructor(){super();for(const property of Object.values(getHostSchema(type).properties))if(!Object.hasOwn(this.properties,property.nativeName))this.properties[property.nativeName]=property.defaultValue;}
   set_position(value){this.set('position',value);}
   get_signal_list(){return [...new Set([...super.get_signal_list().map(item=>item.name),...Object.values(getHostSchema(type).signals).map(item=>item.nativeName)])].map(name=>({name}));}
  };
  Object.defineProperty(Host,'name',{value:type});f.godot[type]=Host;
 }
 const root=f.setup({onError(){}}),services=C.configureEngineComponents(root,{mode:'development',...options});
 return {...f,root,services};
}
async function close(f){f.root.requestShutdown();await f.flushDeletes();assert.equal((await f.root.close()).status,'complete');}

test('engine component handles retain initial baselines and phase-scoped engine-owned commands',async()=>{
 const f=setup(),ref=React.createRef();let commands,ready=0,cleanups=0;
 function App({initial=2}){C.useNativeReady(ref,()=>{ready++;return()=>cleanups++;});C.useProcess(ref,{writes:['position']},value=>{commands=value;value.setPosition({x:7,y:9});});return h(C.Node2D,{name:'Mover',ref,engineOwned:['position'],initial:{position:{x:initial,y:3}}});}
 f.root.render(h(App));assert.equal(ref.current.type,'Node2D');assert.deepEqual(ref.current.readPosition(),{x:2,y:3});assert.equal(ready,1);
 f.root.processFrame(.016);assert.deepEqual(ref.current.readPosition(),{x:7,y:9});assert.throws(()=>commands.setPosition({x:0,y:0}),/E_STALE_COMMAND/);
 f.root.render(h(App,{initial:99}));assert.deepEqual(ref.current.readPosition(),{x:7,y:9});assert.equal(ready,1);assert.equal(f.services.getDiagnostics().length,1);
 const old=ref.current;await close(f);assert.equal(cleanups,1);assert.equal(ref.current,null);assert.equal(old.isValid(),false);assert.throws(()=>old.readPosition(),/E_ENGINE_REF/);
});

test('engine component control removal restores its initial baseline and event slots use current callbacks',async()=>{
 const f=setup(),ref=React.createRef();let first=0,second=0;
 f.root.render(h(C.Button,{name:'Action',ref,initial:{text:'baseline'},text:'controlled',onPressed:()=>first++}));
 const node=C.engineHandleNode(ref.current,f.root);assert.equal(node.get('text'),'controlled');
 f.root.render(h(C.Button,{name:'Action',ref,initial:{text:'baseline'},onPressed:()=>second++}));assert.equal(node.get('text'),'baseline');
 node.emit_signal('pressed');f.root.pump();assert.equal(first,0);assert.equal(second,1);await close(f);
});

test('input dispatch delivers an immutable snapshot and rejects escaped command reads',async()=>{
 const f=setup(),ref=React.createRef();let seen,commands;
 function App(){C.useInput(ref,(value,event)=>{commands=value;seen=event;});return h(C.Node2D,{name:'Input',ref});}
 f.root.render(h(App));const event={get_class(){return 'InputEventKey';},keycode:65,pressed:true,position:{x:2,y:4},nativeMethod(){}};
 C.dispatchEngineInput(f.root,event);event.keycode=90;event.position.x=50;
 assert.equal(seen.keycode,65);assert.deepEqual(seen.position,{x:2,y:4});assert(Object.isFrozen(seen));assert(Object.isFrozen(seen.position));assert.equal(seen.nativeMethod,undefined);assert.throws(()=>commands.readPosition(),/E_STALE_COMMAND/);await close(f);
});

test('typed façade rejects conflicting ownership and a copied integration before native writes',async()=>{
 const f=setup();f.root.render(h(C.Node2D,{position:{x:1,y:2},engineOwned:['position']}));assert(f.root.getErrors().some(error=>String(error).includes('E_PROPERTY_OWNER_CONFLICT')));assert.equal(f.root.getStats().created,0);await close(f);
 const g=setup();g.root.render(h(E.EngineNode,{ctor:g.Node,__engineIntegration:{}}));assert(g.root.getErrors().some(error=>String(error).includes('E_ENGINE_INTEGRATION')));g.root.requestShutdown();await g.flushDeletes();assert.equal((await g.root.close()).status,'failed');
});

test('native resource descriptors can flow through validation and back to the same root',async()=>{
 const f=setup();class Resource{get_instance_id(){return 42949672961234n;}get_class(){return 'CanvasItemMaterial';}is_class(name){return name==='Resource'||name==='CanvasItemMaterial';}}
 const native=new Resource(),descriptor=C.engineAssetValue(f.root,native),copied={...descriptor};assert.equal(C.resolveEngineAsset(f.root,copied),native);
 const g=setup();assert.throws(()=>C.resolveEngineAsset(g.root,copied),/E_ASSET_UNREGISTERED/);await close(f);await close(g);
});

test('a native domain setter cannot write again after transferring its owning ancestor',async()=>{
 let outer,outside,transferred=false,writesAfter=0;
 const f=setup({domain:{write(root,node,property,value){if(transferred)writesAfter++;node.set(property.nativeName,value);if(property.publicName==='text'&&value==='move'){outer.parent.remove_child(outer);outside.add_child(outer);transferred=true;}return true;}}});
 const ref=React.createRef();outside=new f.Node();
 const view=(text,visible)=>h(E.EngineNode,{ctor:f.Node,ref},h(C.Label,{name:'Child',text,visible}));
 f.root.render(view('before',true));outer=ref.current;f.root.render(view('move',false));
 assert(transferred);assert.equal(writesAfter,0);assert(f.root.getErrors().some(error=>String(error).includes('transferred host')));
 f.root.requestShutdown();await f.flushDeletes();assert.equal((await f.root.close()).status,'failed');assert.equal(outer.alive,true);assert.equal(outer.parent,outside);
});

test('shutdown revokes commands but preserves read handles through layout and passive cleanup',async()=>{
 const order=[],f=setup({domain:{quiesceRoot(){order.push('quiesce');},disposeNode(){order.push('dispose-node');},disposeRoot(){order.push('dispose-root');}}});
 const ref=React.createRef();let layout,passive,captured;
 function App(){
  C.useNativeReady(ref,node=>()=>{layout=node.readPosition();order.push('layout-read');});
  React.useEffect(()=>{captured=ref.current;return()=>{passive=captured.readPosition();order.push('passive-read');};},[]);
  return h(C.Node2D,{ref,name:'CleanupReadable',initial:{position:{x:4,y:8}}});
 }
 f.root.render(h(App));f.root.requestShutdown();assert.equal(captured.isValid(),true);assert.equal(f.root.isNativeOwned(C.engineHandleNode(captured)),false);
 await f.flushDeletes();assert.equal((await f.root.close()).status,'complete');assert.deepEqual(layout,{x:4,y:8});assert.deepEqual(passive,{x:4,y:8});
 assert(order.indexOf('quiesce')<order.indexOf('layout-read'));assert(order.indexOf('layout-read')<order.indexOf('dispose-node'));assert(order.indexOf('passive-read')<order.indexOf('dispose-node'));assert(order.indexOf('dispose-node')<order.indexOf('dispose-root'));assert.equal(captured.isValid(),false);
});

test('native ready observes an independent child ref replacement after layout publication',async()=>{
 const f=setup(),ref=React.createRef(),seen=[],cleaned=[];let replace,parentRenders=0;
 function Child(){const [key,setKey]=React.useState(0);replace=setKey;return h(C.Node2D,{key,ref,name:'Child'+key,initial:{position:{x:key,y:2}}});}
 function App(){parentRenders++;C.useNativeReady(ref,node=>{seen.push(node.id);return()=>cleaned.push(node.readPosition().x);});return h(Child);}
 f.root.render(h(App));replace(1);f.root.flush();await Promise.resolve();f.root.pump();
 assert.equal(parentRenders,1);assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);assert.deepEqual(cleaned,[0]);await close(f);assert.deepEqual(cleaned,[0,1]);
});

test('typed controlled buttons restore from input events while uncontrolled buttons retain native state',async()=>{
 const f=setup(),controlled=React.createRef(),uncontrolled=React.createRef();let deliveries=0;
 const original=f.godot.Button.prototype.set;f.godot.Button.prototype.set=function(name,value){original.call(this,name,value);if(name==='button_pressed')this.emit_signal('toggled',value);};
 f.root.render(h(React.Fragment,null,h(C.Button,{ref:controlled,name:'Controlled',toggleMode:true,buttonPressed:false,onToggled:value=>{deliveries++;assert.equal(value,true);}}),h(C.Button,{ref:uncontrolled,name:'Uncontrolled',toggleMode:true})));
 const first=C.engineHandleNode(controlled.current),second=C.engineHandleNode(uncontrolled.current);first.set('button_pressed',true);second.set('button_pressed',true);f.root.pump();
 assert.equal(first.get('button_pressed'),false);assert.equal(second.get('button_pressed'),true);assert.equal(deliveries,1);assert.deepEqual(f.root.getErrors(),[]);
 f.root.render(h(C.Button,{ref:controlled,name:'Controlled',toggleMode:true,buttonPressed:false}));const noHandler=C.engineHandleNode(controlled.current);noHandler.set('button_pressed',true);f.root.pump();assert.equal(noHandler.get('button_pressed'),false);await close(f);
});

test('controlled input restoration uses the prop committed by the current event handler',async()=>{
 const f=setup(),ref=React.createRef();let deliveries=0;
 const original=f.godot.Button.prototype.set;f.godot.Button.prototype.set=function(name,value){original.call(this,name,value);if(name==='button_pressed')this.emit_signal('toggled',value);};
 function App(){const [pressed,setPressed]=React.useState(false);return h(C.Button,{name:'Controlled',ref,toggleMode:true,buttonPressed:pressed,onToggled:value=>{deliveries++;setPressed(value);}});}
 f.root.render(h(App));const node=C.engineHandleNode(ref.current);node.set('button_pressed',true);f.root.pump();assert.equal(node.get('button_pressed'),true);assert.equal(deliveries,1);await close(f);
});

test('native script profiles load the Script identity before caching the compiled constructor',async()=>{
 const f=fixture(),Module=require('node:module'),load=Module._load,calls=[];f.setAutoPump(false);
 class Color{constructor(r,g,b,a){Object.assign(this,{r,g,b,a});}}f.godot.Color=Color;
 const script={is_class:name=>name==='Script'};f.godot.ResourceLoader={load(uri,hint){calls.push(['script',uri,hint]);return script;}};
 class Endpoint extends f.Node{constructor(){super();for(const property of Object.values(getHostSchema('Node2D').properties))if(!Object.hasOwn(this.properties,property.nativeName))this.properties[property.nativeName]=property.defaultValue;}is_class(name){return name==='Node2D'||super.is_class(name);}set_meta(){}}
 Module._load=function(name,...args){if(name==='res://.godot/GodotJS/generated/native/endpoint.js'){calls.push(['module',name]);return {default:Endpoint};}if(name==='godot-jsb')return {internal:{native_runtime:{worldId:'profile-world'}}};return load.call(this,name,...args);};
 try{
  const root=f.setup({onError(){}}),token=C.defineNativeInterface('endpoint',{version:1,nativeLeaf:'Node2D'}),services=C.configureEngineComponents(root,{nativeScriptProfiles:{endpoint:{type:'Node2D',script:'res://generated/native/endpoint.ts',schemaHash:token.schemaHash}}}),ref=React.createRef();
  assert.deepEqual(calls.map(call=>call[0]),['script','module']);assert.equal(root.getStats().created,0);
  root.render(h(C.Node2D,{name:'Endpoint',ref,nativeInterface:token}));const node=C.engineHandleNode(ref.current);root.render(h(C.Node2D,{name:'Endpoint',ref,nativeInterface:token}));assert.equal(C.engineHandleNode(ref.current),node);assert.equal(calls.length,2);assert.equal(node instanceof Endpoint,true);
  root.requestShutdown();await f.flushDeletes();assert.equal((await root.close()).status,'complete');void services;
 }finally{Module._load=load;}
});
