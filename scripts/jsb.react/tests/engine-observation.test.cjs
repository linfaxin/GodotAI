const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot,EngineNode}=require('../dist/engine');
const fixture=require('./engine-observation-fixture.cjs');
const h=React.createElement,quiet={onError(){}};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('published host count excludes replaced hosts before their actual native retirement',async()=>{
 const f=fixture();f.setAutoPump(false);
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 const draw=prefix=>root.render(h(React.Fragment,null,...[0,1].map(key=>h(EngineNode,{ctor:f.Label,key:prefix+key}))));
 draw('old');assert.equal(root.getStats().publishedRecords,2);
 draw('new');const replaced=root.getStats();
 assert.equal(replaced.publishedRecords,2);assert.equal(replaced.liveRecords,4);
 assert.equal(replaced.freed,0,'publication does not pretend the retired native hosts are destroyed');
 root.requestShutdown();await settle();assert.equal(root.getStats().publishedRecords,0);
 await f.flushDeletes();assert.equal((await root.close()).status,'complete');
 assert.equal(root.getStats().publishedRecords,0);assert.equal(root.getStats().freed,4);
});

test('verified native observation keeps 1000 and 10000-node idle work independent of node count',async()=>{
 for(const count of [1000,10000]){
  const f=fixture();f.setAutoPump(false);
  const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
  root.render(h(React.Fragment,null,...Array.from({length:count},(_,key)=>h(EngineNode,{ctor:f.Label,key}))));await settle();
  const before=root.getStats();f.resetReads();
  for(let counter=1;counter<=3;counter++)root.processFrame(.016,{epoch:'observed',counter});
  const after=root.getStats();assert.equal(f.reads,0,String(count));
  for(const key of ['auditRecordsVisited','retirementRecordsVisited','releaseRecordsVisited','portalRecordsVisited','publicationRecordsVisited'])assert.equal(after[key],before[key],count+':'+key);
  assert.equal(after.liveRecords,count);assert.equal(after.fullAudits,before.fullAudits);
  root.requestShutdown();await f.flushDeletes();assert.equal((await root.close()).status,'complete');
  assert.equal(f.claims.size,0);assert([...f.scopes].every(scope=>!scope.active));
 }
});

test('native changes inspect only the affected records and overflow restores a complete baseline',async()=>{
 const f=fixture(),refs=Array.from({length:100},()=>React.createRef());f.setAutoPump(false);
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 root.render(h(React.Fragment,null,...refs.map((ref,key)=>h(EngineNode,{ctor:f.Label,key,ref}))));await settle();
 f.overflow();const previous=root.getStats();root.processFrame(.016,{epoch:'native',counter:1});assert(root.getStats().fullAudits>previous.fullAudits);
 const stable=root.getStats();f.resetReads();root.processFrame(.016,{epoch:'native',counter:2});assert.equal(f.reads,0);assert.equal(root.getStats().auditRecordsVisited,stable.auditRecordsVisited);
 const outside=new f.Node();f.container.remove_child(refs[50].current);outside.add_child(refs[50].current);
 root.processFrame(.016,{epoch:'native',counter:3});await f.flushDeletes();
 assert.equal((await root.close()).status,'failed');assert.equal(refs[50].current,null);
 assert(outside.children[0]?.alive,'An external owner retains the transferred native node');
 assert([...f.claims.values()].some(item=>item.state==='quarantined'));
});

test('a raw native callback cannot commit during a structural fence',async()=>{
 const f=fixture();f.setAutoPump(false);let root,ref=React.createRef(),renders=0;
 class CallbackLabel extends f.Label {}
 root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}),false);
 function App(){renders++;return h(EngineNode,{ctor:CallbackLabel,ref});}
 // The initial render itself is already active. A native enterTree callback
 // queues replacement work, while the fence prevents a nested native commit.
 CallbackLabel.prototype.enterTree=function(){const before=f.calls.length;root.render(h(EngineNode,{ctor:f.Label,native:{text:'after-fence'}}));root.flush();assert.equal(f.calls.length,before);f.Label.prototype.enterTree.call(this);};
 root.render(h(App));root.flush();await settle();root.flush();
 assert.equal(f.container.children.length,1);assert.equal(f.container.children[0].get('text'),'after-fence');
 assert.deepEqual(root.getErrors(),[]);root.requestShutdown();await f.flushDeletes();assert.equal((await root.close()).status,'complete');
});

test('an actual native runtime without an owner checkpoint never authorizes native destruction',async()=>{
 const f=fixture();f.setAutoPump(false);f.native.checkpointAbi=0;
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 root.render(h(EngineNode,{ctor:f.Label}));const node=f.container.children[0];root.requestShutdown();root.pump();await settle();
 assert.equal(node.alive,true);assert.equal(f.calls.filter(call=>call[0]==='free'||call[0]==='queue_free').length,0);
 root.sealClose();assert.equal((await root.close()).status,'unconfirmed');
});

test('Web native release waits for the private native owner callback',async()=>{
 const f=fixture(),checkpoints=[];f.setAutoPump(false);let owner=false;
 f.native.scheduleCheckpoint=callback=>{checkpoints.push(callback);return true;};
 f.native.checkpoint=()=>({canCommitStructure:true,canDestroy:owner});
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 root.render(h(EngineNode,{ctor:f.Label}));const node=f.container.children[0];root.requestShutdown();root.pump();await settle();
 assert.equal(node.alive,true);assert.equal(f.calls.filter(call=>call[0]==='free'||call[0]==='queue_free').length,0);
 assert(checkpoints.length);owner=true;checkpoints.shift()();owner=false;await f.flushDeletes();assert.equal((await root.close()).status,'complete');
});

test('a receipt-ready native retirement island queues only its frontier and observes every native death',async()=>{
 const f=fixture();f.enableBatch();f.setAutoPump(false);
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 root.render(h(EngineNode,{ctor:f.Node},...Array.from({length:10000},(_,key)=>h(EngineNode,{ctor:f.Label,key}))));await settle();
 root.requestShutdown();await settle();assert.equal(f.calls.filter(call=>call[0]==='queue_free').length,1);assert.equal(root.getStats().pendingReleases,10001);assert.equal(root.getStats().freed,0);
 await f.flushDeletes();assert.equal((await root.close()).status,'complete');const stats=root.getStats();assert.equal(stats.freed,10001);assert.equal(stats.batchReleaseRequests,1);assert.equal(stats.releaseFrontiers,1);assert.equal(f.claims.size,0);
});

test('a changed retirement island is quarantined before the native batch can queue any object',async()=>{
 const f=fixture(),outside=new f.Node();let transferred;
 f.enableBatch(descriptors=>{if(transferred)return;transferred=descriptors[0].node;outside.add_child(transferred);});f.setAutoPump(false);
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 root.render(h(EngineNode,{ctor:f.Node},h(EngineNode,{ctor:f.Label})));root.requestShutdown();await settle();await f.flushDeletes();assert.equal((await root.close()).status,'failed');
 assert.equal(f.calls.filter(call=>call[0]==='queue_free'||call[0]==='free').length,0);assert.equal(transferred.alive,true);assert.equal(transferred.parent,outside);assert([...f.claims.values()].every(claim=>claim.state==='quarantined'));
});

for(const preRegistered of [false,true])test(`a retiring owner rejects late borrowed portal admission (${preRegistered?'existing':'new'} container)`,async()=>{
 const f=fixture();f.enableBatch();f.setAutoPump(false);
 const a=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 const ref=React.createRef();a.render(h(EngineNode,{ctor:f.Node,childScope:'native-owned-opaque',ref}));
 const owner=ref.current,mount=new f.Node();owner.add_child(mount);
 const outside=new f.Node(),b=f.drive(createRoot(outside,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 let portal;
 if(preRegistered){portal=b.portal(h(EngineNode,{ctor:f.Label}),mount);b.render(b.portal(null,mount));}
 const closing=a.close();await settle();assert(owner.is_queued_for_deletion());
 if(!preRegistered)assert.throws(()=>b.portal(h(EngineNode,{ctor:f.Label}),mount),/closing or retiring/);
 else{b.render(portal);b.flush();await settle();assert(b.getErrors().some(value=>String(value).includes('closing or retiring')));}
 assert.equal(mount.children.length,0,'no new native child enters the queued cascade');
 await f.flushDeletes();assert.equal((await closing).status,'complete');
 b.requestShutdown();await f.flushDeletes();await b.close();
});

test('portal admission checks queued unowned ancestors above the nearest owned node',async()=>{
 const f=fixture();f.setAutoPump(false);
 const ancestor=new f.Node();f.tree.add_child(ancestor);f.tree.remove_child(f.container);ancestor.add_child(f.container);
 const root=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 const ref=React.createRef();root.render(h(EngineNode,{ctor:f.Node,childScope:'native-owned-opaque',ref}));
 const mount=new f.Node();ref.current.add_child(mount);ancestor.queue_free();
 assert.throws(()=>root.portal(null,mount),/closing or retiring/);
 root.requestShutdown();await f.flushDeletes();await root.close();
});


test('a child constructor cannot close its portal owner between admission and native insertion',async()=>{
 const f=fixture();f.enableBatch();f.setAutoPump(false);
 const a=f.drive(createRoot(f.container,{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet})),ref=React.createRef();
 a.render(h(EngineNode,{ctor:f.Node,childScope:'native-owned-opaque',ref}));const mount=new f.Node();ref.current.add_child(mount);
 const b=f.drive(createRoot(new f.Node(),{godot:f.godot,nativeRuntime:f.native,autoProcess:false,...quiet}));
 class ClosingNode extends f.Node {constructor(){super();a.requestShutdown();}}
 b.render(b.portal(h(EngineNode,{ctor:ClosingNode}),mount));await settle();
 assert.equal(mount.children.length,0);assert(b.getErrors().some(value=>String(value).includes('closing or retiring')));
 await f.flushDeletes();assert.equal((await a.close()).status,'complete');assert.equal((await b.close()).status,'failed');
});
