const test=require('node:test'),assert=require('node:assert/strict'),React=require('react');
const {EngineSession,createRoot,EngineNode,useFrame}=require('../dist/engine');
const fixture=require('./engine-native-fixture.cjs'),h=React.createElement;
const node=(ctor,native={},other={})=>h(EngineNode,{ctor,native,...other}),quiet={onError:()=>{}};

test('render queues; explicit safe scopes cannot override native physics',async()=>{
 const f=fixture(),root=f.setup({immediate:false,...quiet});root.render(node(f.Label,{text:'queued'}));assert.equal(f.container.children.length,0);
 f.setPhysics(true);let entered=false;root.session.runSafe(()=>{entered=true;root.flush();});root.flush();assert(!entered);assert.equal(f.container.children.length,0);
 f.setPhysics(false);root.flush();assert.equal(f.container.children[0].get('text'),'queued');root.shutdown();await f.flushDeletes();
});

test('session phase applies across roots, including explicit cross-root flush',async()=>{
 const f=fixture(),a=f.setup(quiet),mount=new f.Node(),b=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet}));assert.equal(a.session,b.session);
 b.render(node(f.Label,{text:'before'}));let observed;
 function App(){useFrame('physics',()=>{b.render(node(f.Label,{text:'after'}));b.flush();observed=mount.children[0].get('text');});return null;}
 a.render(h(App));a.physics(.02);assert.equal(observed,'before');b.flush();assert.equal(mount.children[0].get('text'),'after');a.shutdown();b.shutdown();await f.flushDeletes();
});

test('an engine-owned stage check can defer the whole session',async()=>{
 const f=fixture();let allowed=false;const session=new EngineSession(f.godot,{canCommit:()=>allowed,requestPump:()=>{}}),root=f.setup({session,immediate:false,...quiet});
 root.render(node(f.Label));root.flush();assert.equal(f.container.children.length,0);allowed=true;session.runSafe(()=>root.flush());assert.equal(f.container.children.length,1);root.shutdown();await f.flushDeletes();
});

test('a suspended transition never publishes its useFrame callback',async()=>{
 const f=fixture(),root=f.setup(quiet),seen=[],never=new Promise(()=>{});let update;
 function App(){const [value,set]=React.useState(1);update=set;useFrame('process',()=>seen.push(value));if(value===2)React.use(never);return node(f.Label,{text:String(value)});}
 root.render(h(React.Suspense,{fallback:null},h(App)));root.process(.1);React.startTransition(()=>update(2));root.flush();root.process(.1);
 assert.deepEqual(seen,[1,1]);assert.equal(f.container.children[0].get('text'),'1');root.shutdown();await f.flushDeletes();
});

test('detached hosts survive ref, layout and passive cleanup before free',async()=>{
 const f=fixture(),mount=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),events=[];let object;
 function App(){const ref=React.useRef(null);React.useLayoutEffect(()=>{object=ref.current;return()=>events.push(['layout',object.alive]);},[]);React.useEffect(()=>()=>events.push(['passive',object.alive]),[]);return node(f.Label,{}, {ref:value=>{ref.current=value;if(value)return()=>events.push(['ref',value.alive]);}});}
 root.render(h(App));root.unmount();for(const kind of ['ref','layout','passive'])assert(events.some(([key,live])=>key===kind&&live));assert(object.alive);await Promise.resolve();assert(!object.alive);assert.equal(root.getStats().freed,1);root.shutdown();
});

test('StrictMode effect replay retains the same host without retirement',async()=>{
 const f=fixture(),root=f.setup({strictMode:true,...quiet}),events=[];let object;
 function App(){const ref=React.useRef();React.useEffect(()=>{object=ref.current;events.push(['mount',object.alive]);return()=>events.push(['cleanup',object.alive]);},[]);return node(f.Label,{}, {ref});}
 root.render(h(App));assert.equal(root.getStats().created,1);assert.equal(root.getStats().releaseRequested,0);assert(events.some(([kind])=>kind==='cleanup'));assert(events.every(([,live])=>live));root.shutdown();await f.flushDeletes();assert.equal(root.getStats().freed,1);
});

test('cleanup throwing and shutdown reentry never double-free',async()=>{
 const f=fixture(),mount=new f.Node(),reports=[],root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,onError:e=>reports.push(e)}));let object,count=0;
 function App(){const ref=React.useRef();React.useEffect(()=>{object=ref.current;return()=>{count++;assert(object.alive);root.shutdown();throw Error('cleanup failure');};},[]);return node(f.Label,{}, {ref});}
 root.render(h(App));root.shutdown();root.shutdown();assert.equal(count,1);assert(object.alive);await Promise.resolve();assert(!object.alive);assert.equal(f.calls.filter(([kind,target])=>kind==='free'&&target===object).length,1);assert(reports.some(e=>String(e).includes('cleanup failure')));
});

test('queue_free follows cleanup; actual free count follows native destruction',async()=>{
 const f=fixture(),root=f.setup(quiet);let object,cleaned=false;
 function App(){const ref=React.useRef();React.useEffect(()=>{object=ref.current;return()=>{assert(object.alive);assert(!f.calls.some(([kind,target])=>kind==='queue_free'&&target===object));cleaned=true;};},[]);return node(f.Label,{}, {ref});}
 root.render(h(App));root.unmount();assert(cleaned&&object.alive);assert.equal(root.getStats().releaseRequested,0);await Promise.resolve();assert.equal(root.getStats().releaseRequested,1);assert.equal(root.getStats().freed,0);assert.equal(root.getStats().pendingReleases,1);await f.flushDeletes();assert.equal(root.getStats().freed,1);root.shutdown();
});

test('signal delivery waits until the native callback has returned',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();let calls=0;root.render(node(f.Label,{}, {ref,on:{pressed:()=>{calls++;root.unmount();}}}));const object=ref.current;
 f.setAutoPump(false);object.emit_signal('pressed');assert.equal(calls,0);assert.equal(ref.current,object);root.flush();assert.equal(calls,1);assert.equal(ref.current,null);assert(object.alive);await f.flushDeletes();assert(!object.alive);root.shutdown();
});

test('native declarations reconcile at host commits, not continuously each frame',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef(),draw=()=>root.render(node(f.Label,{text:'declared'},{ref}));draw();ref.current.set('text','native write');root.process(.1);assert.equal(ref.current.get('text'),'native write');draw();assert.equal(ref.current.get('text'),'declared');root.render(node(f.Label,{}, {ref}));assert.equal(ref.current.get('text'),'default');root.shutdown();await f.flushDeletes();
});

test('constructor arguments reject mutation without a new key',async()=>{
 const f=fixture(),root=f.setup(quiet),value=new f.Vector2(1,2);root.render(node(f.Label,{}, {args:[value]}));value.x=9;root.render(node(f.Label,{}, {args:[value]}));assert(root.getErrors().some(e=>String(e).includes('E_ENGINE_ARGUMENTS')));assert.equal(root.getStats().cleanExit,false);root.shutdown();await f.flushDeletes();await Promise.resolve();assert.equal(root.getStats().liveRecords,0);
});

test('public-child contamination preserves its ownership island and foreign nodes',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();root.render(node(f.Node,{}, {ref,children:node(f.Label)}));const island=ref.current,foreign=new f.Node();island.add_child(foreign);root.flush();
 await Promise.resolve();assert.equal(root.getStats().state,'disposed');assert.equal(root.getStats().cleanExit,false);assert(root.getErrors().some(e=>String(e).includes('E_ENGINE_STRUCTURE')));assert(island.alive&&foreign.alive);assert.equal(foreign.parent,island);assert(!f.calls.some(([kind,target])=>(kind==='free'||kind==='queue_free')&&target===island));
});

test('opaque constructors and ready callbacks own their public subtrees',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();class Composite extends f.Node{constructor(){super();this.add_child(new f.Label());}enterTree(){super.enterTree();if(!this.extra){this.extra=new f.Label();this.add_child(this.extra);}}}
 root.render(node(Composite,{}, {ref,childScope:'native-owned-opaque'}));const object=ref.current;assert.equal(object.children.length,2);object.add_child(new f.Label());root.flush();assert.equal(root.getErrors().length,0);root.shutdown();await f.flushDeletes();assert(!object.alive);assert.equal(f.objects.size,2);
});

test('opaque scope rejects direct React children and unregistered nested roots',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();root.render(node(f.Node,{}, {ref,childScope:'native-owned-opaque'}));const mount=new f.Node();ref.current.add_child(mount);assert.throws(()=>createRoot(mount,{godot:f.godot,autoProcess:false}),/E_ENGINE_NESTED_ROOT/);
 root.render(node(f.Node,{}, {childScope:'native-owned-opaque',children:node(f.Label)}));assert(root.getErrors().some(e=>String(e).includes('E_ENGINE_OPAQUE')));root.shutdown();await f.flushDeletes();
});

test('opaque owner waits for registered portal cleanup before native destruction',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();let child,owner,cleaned=false;class Composite extends f.Node{constructor(){super();this.mount=new f.Node();this.add_child(this.mount);}}
 const ownerElement=()=>node(Composite,{}, {key:'owner',ref,childScope:'native-owned-opaque'});root.render(ownerElement());owner=ref.current;
 function Content(){const ref=React.useRef();React.useEffect(()=>{child=ref.current;return()=>{assert(owner.alive&&child.alive);cleaned=true;};},[]);return node(f.Label,{}, {ref});}
 root.render(h(React.Fragment,null,ownerElement(),root.portal(h(Content),owner.mount)));root.render(root.portal(h(Content),owner.mount));assert(cleaned);assert(owner.alive&&child.alive);assert.equal(root.getStats().state,'disposing');await f.flushDeletes();assert.equal(root.getStats().state,'disposed');assert(!owner.alive&&!child.alive);assert.equal(root.getStats().cleanExit,true);
});

test('Suspense hides opaque visuals beneath a nonvisual Node without retirement',async()=>{
 const f=fixture(),root=f.setup(quiet),never=new Promise(()=>{});let group;class Group extends f.Node{constructor(){super();delete this.properties.visible;group=this;this.visual=new f.Label();this.add_child(this.visual);}}
 function Wait({suspend}){if(suspend)React.use(never);return null;}
 const draw=suspend=>root.render(h(React.Suspense,{fallback:null},node(Group,{}, {key:'group',childScope:'native-owned-opaque'}),h(Wait,{suspend})));draw(false);assert.equal(group.visual.get('visible'),true);draw(true);assert.equal(group.visual.get('visible'),false);assert.equal(root.getStats().releaseRequested,0);draw(false);assert.equal(group.visual.get('visible'),true);root.shutdown();await f.flushDeletes();
});

test('partial native mutation faults and cleans published effects before freeing',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();let cleaned=false,object;class Fragile extends f.Label{set(name,value){if(name==='text'&&value==='fail')throw Error('native setter failed');super.set(name,value);}}
 function App({text}){React.useEffect(()=>{object=ref.current;return()=>{assert(object.alive);cleaned=true;};},[]);return node(Fragile,{text},{ref});}
 root.render(h(App,{text:'ok'}));root.render(h(App,{text:'fail'}));assert(cleaned);await Promise.resolve();assert.equal(root.getStats().state,'disposed');assert.equal(root.getStats().cleanExit,false);assert(root.getErrors().some(e=>String(e).includes('native setter failed')));await f.flushDeletes();assert(!object.alive);
});

test('unpublished allocation failure does not fabricate a deletion receipt',async()=>{
 const f=fixture(),mount=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet}));root.render(node(f.Label,{unknown_property:1}));await Promise.resolve();assert.equal(root.getStats().state,'disposed');assert.equal(root.getStats().created,1);assert.equal(root.getStats().freed,1);assert.equal(root.getStats().cleanExit,false);
});

test('idle validation remains linear for deep host chains',async()=>{
 const counts=[];for(const size of [20,40]){const f=fixture(),root=f.setup(quiet);let reads=0;const original=f.Node.prototype.get_instance_id;f.Node.prototype.get_instance_id=function(){reads++;return original.call(this);};let element=null;for(let i=0;i<size;i++)element=node(f.Node,{}, {children:element});root.render(element);reads=0;root.flush();counts.push(reads);root.shutdown();await f.flushDeletes();}assert(counts[1]<=counts[0]*2.2,JSON.stringify(counts));
});

test('native callback stack delays destruction even when shutdown explicitly flushes',async()=>{
 const f=fixture(),mount=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),ref=React.createRef();root.render(node(f.Label,{}, {ref}));const object=ref.current;
 root.session.runNativeCallback(()=>{root.shutdown();root.flush();assert(object.alive);assert.equal(root.getStats().releaseRequested,0);});root.flush();assert(object.alive);await Promise.resolve();assert(!object.alive);assert.equal(root.getStats().freed,1);
});

test('raw native signals cannot release either root through explicit synchronous pumps',async()=>{
 const f=fixture(),a=f.drive(createRoot(new f.Node(),{godot:f.godot,autoProcess:false,...quiet})),b=f.drive(createRoot(new f.Node(),{godot:f.godot,autoProcess:false,...quiet})),refA=React.createRef(),refB=React.createRef();
 a.render(node(f.Label,{}, {ref:refA}));b.render(node(f.Label,{}, {ref:refB}));const emitter=refA.current,other=refB.current;
 // Connect through Godot itself, bypassing the renderer's tracked on handlers.
 emitter.connect('pressed',()=>{a.unmount();b.shutdown();a.flush();b.flush();assert(emitter.alive&&other.alive);assert.equal(a.getStats().releaseRequested,0);assert.equal(b.getStats().releaseRequested,0);});
 emitter.emit_signal('pressed');a.flush();b.flush();assert(emitter.alive&&other.alive);
 await Promise.resolve();assert(!emitter.alive&&!other.alive);assert.equal(a.getStats().freed,1);assert.equal(b.getStats().freed,1);assert.deepEqual(a.getErrors(),[]);assert.deepEqual(b.getErrors(),[]);a.shutdown();await f.flushDeletes();
});

test('a synchronous host wakeup cannot authorize native destruction',async()=>{
 const f=fixture();let session;session=new EngineSession(f.godot,{requestPump:()=>session.pump()});
 const root=f.drive(createRoot(new f.Node(),{godot:f.godot,session,autoProcess:false,...quiet})),ref=React.createRef();root.render(node(f.Label,{}, {ref}));const object=ref.current;
 object.connect('pressed',()=>{root.shutdown();root.session.runSafe(()=>root.flush());assert(object.alive);assert.equal(root.getStats().releaseRequested,0);});
 object.emit_signal('pressed');assert(object.alive);await Promise.resolve();assert(!object.alive);assert.equal(root.getStats().cleanExit,true);assert.equal(root.getStats().freed,1);
});

for(const method of ['free','queue_free'])test(`failed ${method} retains the ownership island and records a non-clean exit`,async()=>{
 const f=fixture(),mount=method==='free'?new f.Node():f.container,reports=[];let attempts=0;
 class RefusesRelease extends f.Label{[method](){attempts++;throw Error('native release rejected');}}
 const root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,onError:value=>reports.push(value)})),ref=React.createRef();root.render(node(RefusesRelease,{}, {ref}));const object=ref.current;
 root.shutdown();assert(object.alive);await Promise.resolve();await Promise.resolve();
 assert(object.alive);assert.equal(attempts,1);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().pendingReleases,0);assert.equal(root.getStats().orphaned,1);assert.equal(root.getStats().cleanExit,false);assert.equal(root.getStats().state,'disposed');assert(reports.some(value=>String(value).includes('native release rejected')));
 root.flush();await Promise.resolve();assert.equal(attempts,1);f.Node.prototype.free.call(object);
});

test('a silent failed immediate free cannot produce a successful release receipt',async()=>{
 const f=fixture();let attempts=0;class RefusesRelease extends f.Label{free(){attempts++;}}
 const root=f.drive(createRoot(new f.Node(),{godot:f.godot,autoProcess:false,...quiet})),ref=React.createRef();root.render(node(RefusesRelease,{}, {ref}));const object=ref.current;root.shutdown();await Promise.resolve();
 assert(object.alive);assert.equal(attempts,1);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().cleanExit,false);assert(root.getErrors().some(value=>String(value).includes('E_ENGINE_RELEASE')));f.Node.prototype.free.call(object);
});

for(const failure of ['throw','unconfirmed'])test(`a retired child with ${failure} release is retained with its live parent without retry`,async()=>{
 const f=fixture();let attempts=0;
 // A bounded fallback makes a regression report its retries instead of hanging
 // the test runner in an unbounded sequence of rejected release checkpoints.
 class RejectChild extends f.Label{free(){attempts++;if(attempts<=2){if(failure==='throw')throw Error('child release rejected');return;}super.free();}}
 const mount=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),parentRef=React.createRef(),childRef=React.createRef();
 root.render(node(f.Node,{}, {ref:parentRef,children:node(RejectChild,{}, {ref:childRef})}));const parent=parentRef.current,child=childRef.current;
 root.render(node(f.Node,{}, {ref:parentRef}));assert(parent.alive&&child.alive);await Promise.resolve();await Promise.resolve();
 assert.equal(attempts,1);assert(parent.alive&&child.alive);assert.equal(root.getStats().orphaned,2);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().freed,0);assert.equal(root.getStats().cleanExit,false);assert.equal(root.getStats().state,'disposed');
 root.flush();await Promise.resolve();assert.equal(attempts,1);assert(!f.calls.some(([kind,target])=>kind==='free'&&(target===parent||target===child)));f.Node.prototype.free.call(child);f.Node.prototype.free.call(parent);
});

test('native removal callbacks can transfer a retired host without React reclaiming it',async()=>{
 const f=fixture(),mount=new f.Node(),outside=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),ref=React.createRef();
 root.render(node(f.Label,{}, {ref}));const object=ref.current;
 mount.remove_child=function(child){f.Node.prototype.remove_child.call(this,child);outside.add_child(child);};
 root.unmount();assert(object.alive);assert.equal(object.parent,outside);await Promise.resolve();await Promise.resolve();
 assert(object.alive);assert.equal(object.parent,outside);assert.equal(root.getStats().orphaned,1);assert.equal(root.getStats().cleanExit,false);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().freed,0);assert.equal(root.getStats().state,'disposed');assert(!f.calls.some(([kind,target])=>(kind==='free'||kind==='queue_free')&&target===object));outside.free();
});

test('native removal callbacks during a release checkpoint retain the whole transferred island',async()=>{
 const f=fixture(),mount=new f.Node(),outside=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),parentRef=React.createRef(),childRef=React.createRef();
 root.render(node(f.Node,{}, {ref:parentRef,children:node(f.Label,{}, {ref:childRef})}));const parent=parentRef.current,child=childRef.current;
 parent.remove_child=function(object){f.Node.prototype.remove_child.call(this,object);outside.add_child(object);};
 root.shutdown();assert(parent.alive&&child.alive);await Promise.resolve();await Promise.resolve();
 assert(parent.alive&&child.alive);assert.equal(child.parent,outside);assert.equal(root.getStats().orphaned,2);assert.equal(root.getStats().cleanExit,false);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().freed,0);assert.equal(root.getStats().state,'disposed');assert(!f.calls.some(([kind,target])=>(kind==='free'||kind==='queue_free')&&(target===parent||target===child)));outside.free();f.Node.prototype.free.call(parent);
});

test('a retired detached node transferred before the checkpoint is retained',async()=>{
 const f=fixture(),mount=new f.Node(),outside=new f.Node(),root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),ref=React.createRef();root.render(node(f.Label,{}, {ref}));const object=ref.current;
 root.unmount();outside.add_child(object);await Promise.resolve();assert(object.alive);assert.equal(object.parent,outside);assert.equal(root.getStats().cleanExit,false);assert.equal(root.getStats().releaseRequested,0);assert.equal(root.getStats().orphaned,1);outside.free();
});

test('a native detach failure at a release checkpoint faults only its owning root',async()=>{
 const f=fixture(),a=f.drive(createRoot(new f.Node(),{godot:f.godot,autoProcess:false,...quiet})),b=f.setup(quiet),parentRef=React.createRef(),childRef=React.createRef();
 a.render(node(f.Node,{}, {ref:parentRef,children:node(f.Label,{}, {ref:childRef})}));b.render(node(f.Label));const parent=parentRef.current,child=childRef.current;
 parent.remove_child=()=>{throw Error('native detach rejected');};
 a.shutdown();await Promise.resolve();await Promise.resolve();assert(parent.alive&&child.alive);assert.equal(a.getStats().cleanExit,false);assert.equal(a.getStats().releaseRequested,0);assert.equal(a.getStats().orphaned,2);assert(a.getErrors().some(value=>String(value).includes('native detach rejected')));assert.equal(b.getStats().state,'running');assert.equal(b.getStats().cleanExit,true);assert.deepEqual(b.getErrors(),[]);
 parent.remove_child=f.Node.prototype.remove_child;parent.free();b.shutdown();await f.flushDeletes();
});

test('portal ownership dependencies reject cycles between roots',async()=>{
 const f=fixture(),a=f.setup(quiet),mount=new f.Node(),b=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),refA=React.createRef(),refB=React.createRef();
 class Composite extends f.Node{constructor(){super();this.mount=new f.Node();this.add_child(this.mount);}}
 a.render(node(Composite,{}, {ref:refA,childScope:'native-owned-opaque'}));b.render(node(Composite,{}, {ref:refB,childScope:'native-owned-opaque'}));
 a.portal(null,refB.current.mount);assert.throws(()=>b.portal(null,refA.current.mount),/E_ENGINE_PORTAL_CYCLE/);a.shutdown();b.shutdown();await f.flushDeletes();
});

test('Godot internal children retain native lifecycle in managed scope',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();class Internal extends f.Node{constructor(){super();this.internalChild=new f.Node();this.internalChild.internal=true;this.add_child(this.internalChild);}}
 root.render(node(Internal,{}, {ref,children:node(f.Label)}));const object=ref.current;assert.equal(root.getErrors().length,0);root.shutdown();await f.flushDeletes();assert(!object.internalChild.alive);
});

test('native setter receipts reject failed writes and preserve normalized values',async()=>{
 const f=fixture();let writes=0;const session=new EngineSession(f.godot,{writeProperty(object,name,value){writes++;if(value==='reject')return {accepted:false,value:object.get(name)};object.set(name,typeof value==='number'?Math.round(value*1000)/1000:value);return {accepted:true,value:object.get(name)};}}),root=f.setup({session,...quiet}),ref=React.createRef();
 const draw=value=>root.render(node(f.Label,{custom_value:value},{ref}));draw(1/3);assert.equal(ref.current.get('custom_value'),.333);assert.equal(writes,1);draw(1/3);assert.equal(writes,1);ref.current.set('custom_value',.7);draw(1/3);assert.equal(writes,2);
 root.render(node(f.Label,{text:'reject'},{ref}));assert(root.getErrors().some(e=>String(e).includes('E_ENGINE_PROPERTY_WRITE')));assert.equal(root.getStats().cleanExit,false);root.shutdown();await f.flushDeletes();
});

test('queued signal value Variants are captured at emission',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef(),seen=[];root.render(node(f.Label,{}, {ref,on:{value_changed:value=>seen.push(value.x)}}));
 f.setAutoPump(false);const payload=new f.Vector2(1,2);ref.current.emit_signal('value_changed',payload);payload.x=9;root.flush();assert.deepEqual(seen,[1]);root.shutdown();await f.flushDeletes();
});

test('unsetting controlled visibility while revealing restores its original baseline',async()=>{
 const f=fixture(),root=f.setup(quiet),never=new Promise(()=>{}),ref=React.createRef();function Wait({suspend}){if(suspend)React.use(never);return null;}
 const draw=(suspend,native)=>root.render(h(React.Suspense,{fallback:null},node(f.Label,native,{ref}),h(Wait,{suspend})));
 draw(false,{visible:false});draw(true,{visible:false});draw(false,{});assert.equal(ref.current.get('visible'),true);root.shutdown();await f.flushDeletes();
});

test('a transferred portal mount is retained instead of freed through its old owner',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef(),outside=new f.Node();class Composite extends f.Node{constructor(){super();this.mount=new f.Node();this.add_child(this.mount);}}
 const component=()=>node(Composite,{}, {key:'owner',ref,childScope:'native-owned-opaque'});root.render(component());const owner=ref.current,mount=owner.mount;root.render(h(React.Fragment,null,component(),root.portal(node(f.Label),mount)));const child=mount.children[0];owner.remove_child(mount);outside.add_child(mount);root.flush();await f.flushDeletes();assert(mount.alive&&child.alive);assert.equal(mount.parent,outside);assert.equal(root.getStats().cleanExit,false);
});

test('moving an unregistered root mount under an opaque owner protects both islands',async()=>{
 const f=fixture(),a=f.setup(quiet),mount=new f.Node(),b=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet})),ref=React.createRef();
 a.render(node(f.Node,{}, {ref,childScope:'native-owned-opaque'}));const owner=ref.current;b.render(node(f.Label));const child=mount.children[0];owner.add_child(mount);a.shutdown();b.flush();await f.flushDeletes();assert(owner.alive&&mount.alive&&child.alive);assert.equal(a.getStats().cleanExit,false);assert.equal(b.getStats().cleanExit,false);
});

test('a signal callback cannot transfer a node and then let React write its new owner',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef(),outside=new f.Node();let update;
 function App(){const [text,set]=React.useState('before');update=set;return node(f.Label,{text},{ref,on:{pressed:()=>{f.container.remove_child(ref.current);outside.add_child(ref.current);update('after');}}});}
 root.render(h(App));const object=ref.current;object.emit_signal('pressed');root.flush();assert.equal(object.get('text'),'before');assert.equal(object.parent,outside);assert(object.alive);assert.equal(root.getStats().cleanExit,false);
});
