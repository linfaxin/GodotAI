const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot,EngineNode,createNativeComponent,useFrame}=require('../dist/engine');
const fixture=require('./engine-native-fixture.cjs');
const h=React.createElement;
const node=(ctor,native={},other={})=>h(EngineNode,{ctor,native,...other});

test('direct constructors, real refs, controlled unset, Variant snapshots and Resource identity',()=>{
  const f=fixture(),root=f.setup();const ref=React.createRef();const v=new f.Vector2(1,2),material=new f.Material();
  root.render(node(f.Label,{text:'hello',position:v,material},{ref}));const label=ref.current;
  assert.ok(label instanceof f.Label);assert.equal(label.get('material'),material);assert.equal(label.get('text'),'hello');
  v.x=9;root.render(node(f.Label,{position:v,material},{ref}));assert.equal(ref.current,label);assert.equal(label.get('text'),'default');assert.equal(label.get('position').x,9);
  root.render(node(f.Label,{}, {ref}));assert.deepEqual(label.get('position'),new f.Vector2());assert.equal(label.get('material'),null);
  assert.equal(root.getErrors().length,0);root.shutdown();f.flushDeletes();assert.equal(ref.current,null);assert.equal(label.alive,false);assert.equal(f.container.alive,true);
});

test('StrictMode and suspended abandoned preparation allocate only committed native nodes',()=>{
  const f=fixture(),root=f.setup({strictMode:true});let renders=0;
  function Item(){renders++;return node(f.Label,{text:'strict'});}
  root.render(h(Item));assert.ok(renders>=2);assert.equal(root.getStats().created,1);
  root.unmount();f.flushDeletes();const created=root.getStats().created;
  const never=new Promise(()=>{});function Waiting(){React.use(never);return node(f.Label);}
  root.render(h(React.Suspense,{fallback:null},node(f.Node,{name:'abandoned'},{children:h(Waiting)})));
  assert.equal(root.getStats().created,created);root.shutdown();assert.equal(f.container.children.length,0);
});

test('all keys reorder actual native children while borrowed portal preserves external nodes',()=>{
  const f=fixture(),root=f.setup(),mount=new f.Node(),foreign=new f.Node();f.tree.add_child(mount);mount.add_child(foreign);
  const draw=order=>root.render(h(React.Fragment,null,...order.map(key=>node(f.Label,{name:key},{key})),root.portal(node(f.Label,{name:'portal'}),mount)));
  draw(['a','b','c']);const a=f.container.children[0];draw(['c','a','b']);assert.deepEqual(f.container.children.map(n=>n.get('name')),['c','a','b']);assert.equal(f.container.children[1],a);
  draw(['b','c','a']);assert.deepEqual(f.container.children.map(n=>n.get('name')),['b','c','a']);
  root.shutdown();f.flushDeletes();assert.deepEqual(mount.children,[foreign]);assert.ok(mount.alive&&foreign.alive);assert.equal(root.getStats().liveRecords,0);
});

test('signal aliases use current callback without reconnect and unmount safely during emission',()=>{
  const f=fixture(),root=f.setup({publicName:s=>s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())});const ref=React.createRef(),seen=[];
  const draw=callback=>root.render(node(f.Label,{customValue:1},{ref,on:{valueChanged:callback}}));
  draw(v=>seen.push(['old',v]));const label=ref.current;draw(v=>seen.push(['new',v]));
  assert.equal(root.getStats().connections,1);label.emit_signal('value_changed',2);assert.deepEqual(seen,[['new',2]]);
  root.render(node(f.Label,{}, {ref,on:{pressed:()=>root.unmount()}}));label.emit_signal('pressed');assert.equal(ref.current,null);assert.equal(root.getStats().liveRecords,0);assert.equal(label.alive,true);f.flushDeletes();assert.equal(label.alive,false);
  root.shutdown();assert.equal(root.getErrors().length,0);
});

test('ready emissions during commit settle after native refs and can shutdown reentrantly',()=>{
  const f=fixture(),root=f.setup();const ref=React.createRef();let ready=0;
  root.render(node(f.Label,{}, {ref,on:{ready:()=>{assert.ok(ref.current);ready++;root.shutdown();}}}));
  assert.equal(ready,1);assert.equal(root.getStats().state,'disposed');assert.equal(ref.current,null);assert.equal(root.getErrors().length,0);f.flushDeletes();assert.equal(f.container.children.length,0);
});

test('external free, identity reuse and reparent cannot release a foreign native object',()=>{
  const f=fixture(),root=f.setup();const ref=React.createRef();root.render(node(f.Label,{text:'original'},{ref}));const original=ref.current;
  original.free();original.alive=true;original.id+=1000;original.properties.text='replacement';f.objects.add(original);
  root.render(node(f.Label,{text:'must not write'},{ref}));root.shutdown();assert.equal(original.get('text'),'replacement');assert.equal(original.alive,true);assert.equal(root.getStats().invalidations,1);
  const mount=new f.Node(),outside=new f.Node();const other=createRoot(mount,{godot:f.godot,autoProcess:false});other.render(node(f.Label,{}, {ref}));const reparented=ref.current;mount.remove_child(reparented);outside.add_child(reparented);other.pump();other.shutdown();assert.equal(reparented.parent,outside);assert.equal(reparented.alive,true);
});

test('adoption is explicit ownership and borrowed mounts are never adopted implicitly',()=>{
  const f=fixture(),root=f.setup(),existing=new f.Label(),ref=React.createRef();
  root.render(h(EngineNode,{object:existing,ownership:'adopt',ref,native:{text:'adopted'}}));assert.equal(ref.current,existing);assert.equal(root.getStats().adopted,1);root.shutdown();f.flushDeletes();assert.equal(existing.alive,false);
  const replacement=createRoot(f.container,{godot:f.godot,autoProcess:false});assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false}),/E_ENGINE_OWNERSHIP/);replacement.shutdown();
  const detached=new f.Node();assert.throws(()=>createRoot(detached,{godot:f.godot}),/E_ENGINE_AUTOPROCESS/);createRoot(detached,{godot:f.godot,autoProcess:false}).shutdown();
});

test('multiple roots share scheduler ingress without losing updates or frame subscriptions',()=>{
  const f=fixture(),a=f.setup(),mount=new f.Node(),b=createRoot(mount,{godot:f.godot,autoProcess:false});const ticks=[],setters=[];
  function App({id}){const [value,set]=React.useState(0);setters[id]=set;useFrame('process',d=>ticks.push([id,d]));return node(f.Label,{text:String(value)});}
  a.render(h(App,{id:0}));b.render(h(App,{id:1}));setters[0](1);setters[1](2);a.shutdown();b.pump();assert.equal(mount.children[0].get('text'),'2');b.process(.1);assert.deepEqual(ticks,[[1,.1]]);assert.equal(b.getErrors().length,0);b.shutdown();f.flushDeletes();
});

test('physics callbacks retain direct native methods and defer React structural commits to pump',()=>{
  const f=fixture(),root=f.setup();let ref=React.createRef(),count=0;
  function App(){useFrame('physics',delta=>{assert.equal(delta,.02);ref.current.set('position',new f.Vector2(5,6));if(!count++)root.render(node(f.Label,{text:'after'}));});return node(f.Label,{text:'before'},{ref});}
  root.render(h(App));const first=ref.current;root.physics(.02);assert.equal(first.get('position').x,5);assert.equal(first.get('text'),'before');root.pump();assert.equal(f.container.children[0].get('text'),'after');root.shutdown();f.flushDeletes();
});

test('automatic SceneTree subscriptions disconnect and handle externally released root mount',()=>{
  const f=fixture(),root=f.setup({autoProcess:true});let ticks=0;
  function App(){useFrame('process',()=>ticks++);return node(f.Label);}
  root.render(h(App));f.tree.emit_signal('process_frame');assert.equal(ticks,1);f.container.free();assert.doesNotThrow(()=>f.tree.emit_signal('process_frame'));assert.equal(root.getStats().state,'disposed');assert.equal(f.tree.signals.get('process_frame').size,0);assert.equal(f.tree.signals.get('physics_frame').size,0);
});

test('layout and cleanup reentry settle without nested renderer commits or duplicate native frees',()=>{
  const f=fixture(),root=f.setup();let layout=0,cleanup=0;
  function App(){React.useLayoutEffect(()=>{layout++;root.render(node(f.Label,{text:'replacement'}));return()=>{cleanup++;root.shutdown();};},[]);return node(f.Label,{text:'initial'});}
  root.render(h(App));assert.equal(layout,1);assert.equal(cleanup,1);assert.equal(root.getStats().state,'disposed');assert.equal(root.getErrors().length,0);f.flushDeletes();assert.equal(f.container.children.length,0);
});

test('one root may request another root shutdown from a scheduled layout commit',()=>{
  const f=fixture(),a=f.setup(),mount=new f.Node(),b=createRoot(mount,{godot:f.godot,autoProcess:false});let update;
  function App(){const [close,set]=React.useState(false);update=set;React.useLayoutEffect(()=>{if(close)b.shutdown();},[close]);return node(f.Label);}
  a.render(h(App));b.render(node(f.Label));update(true);b.pump();assert.equal(b.getStats().state,'disposed');assert.equal(a.getErrors().length,0);assert.equal(b.getErrors().length,0);a.shutdown();f.flushDeletes();
});

test('invalid readonly/unknown properties and parented adoption fail without taking foreign ownership',()=>{
  for(const native of [{readonly_value:2},{missing:1}]){
    const f=fixture(),root=f.setup();root.render(node(f.Label,native));assert.ok(root.getErrors().some(e=>String(e).includes('E_ENGINE_PROPERTY')));root.shutdown();f.flushDeletes();assert.equal(f.container.children.length,0);assert.equal(f.objects.size,2);
  }
  const f=fixture(),root=f.setup(),parent=new f.Node(),foreign=new f.Label();parent.add_child(foreign);
  root.render(h(EngineNode,{object:foreign,ownership:'adopt'}));root.shutdown();assert.equal(foreign.parent,parent);assert.equal(foreign.alive,true);assert.ok(root.getErrors().some(e=>String(e).includes('E_ENGINE_OWNERSHIP')));
});

test('invalidated parent cannot receive new children and stale retirement cannot erase a new owner',()=>{
  const f=fixture(),a=f.setup(),ref=React.createRef();a.render(node(f.Node,{}, {ref}));const object=ref.current;
  object.free();object.alive=true;object.id+=1000;f.objects.add(object);a.pump();
  const mount=new f.Node(),b=createRoot(mount,{godot:f.godot,autoProcess:false});b.render(h(EngineNode,{object,ownership:'adopt'}));
  a.render(node(f.Node,{}, {ref,children:node(f.Label,{text:'must not attach'})}));assert.equal(object.children.length,0);a.shutdown();
  assert.throws(()=>b.portal(null,object),/E_ENGINE_OWNERSHIP/);b.shutdown();f.flushDeletes();assert.equal(object.alive,false);
});

test('recursive signal emission drains in order and final shutdown disconnects queued handlers',()=>{
  const f=fixture(),root=f.setup(),ref=React.createRef(),seen=[];
  root.render(node(f.Label,{}, {ref,on:{pressed:()=>{seen.push(seen.length);if(seen.length<3)ref.current.emit_signal('pressed');else root.shutdown();}}}));
  ref.current.emit_signal('pressed');assert.deepEqual(seen,[0,1,2]);assert.equal(root.getStats().state,'disposed');assert.equal(root.getErrors().length,0);f.flushDeletes();
});

test('retiring a nested subtree releases and accounts for every owned native child',()=>{
  const f=fixture(),root=f.setup();root.render(node(f.Node,{}, {children:node(f.Node,{}, {children:node(f.Label)})}));
  assert.equal(root.getStats().created,3);root.shutdown();assert.equal(root.getStats().freed,3);assert.equal(root.getStats().invalidations,0);assert.equal(root.getStats().liveRecords,0);f.flushDeletes();assert.equal(f.objects.size,2);
});
