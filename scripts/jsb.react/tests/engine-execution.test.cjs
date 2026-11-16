const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot,EngineNode,EngineSession,useFrame}=require('../dist/engine');
const {configureScheduler,scheduleHostTimeout}=require('../dist/scheduler');
const fixture=require('./engine-native-fixture.cjs');
const fs=require('node:fs');
const ts=require('typescript');
const h=React.createElement;
const token=(counter,epoch='native-A')=>({epoch,counter});
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const quiet={onError(){}};
function bindingFixture(){
 const source=fs.readFileSync(require.resolve('../../../packages/engine/src/runtime-host.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};new Function('exports','module',code)(mod.exports,mod);
 const binding=mod.exports.createRuntimeBinding({sessionId:'script-session',role:'engine'});binding.beginNativeEpoch('native-script');return binding;
}

test('automatic idle maintenance scans 1000 nodes once per native frame across 1, 5 and 10 roots',async()=>{
 const observed=[];
 for(const count of [1,5,10]){
  const f=fixture();f.setAutoPump(false);let reads=0;
  const getChildren=f.Node.prototype.get_children;
  f.Node.prototype.get_children=function(...args){reads++;return getChildren.apply(this,args);};
  const roots=[];
  for(let i=0;i<count;i++){
   const mount=new f.Node();f.tree.add_child(mount);
   const root=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet}),false);roots.push(root);
   root.render(h(React.Fragment,null,...Array.from({length:1000/count},(_,key)=>h(EngineNode,{ctor:f.Label,key}))));root.flush();
  }
  await settle();reads=0;
  for(const root of roots)root.processFrame(.016,token(1));
  observed.push(reads);assert.equal(reads,2000,`${count} roots must share the two full audit passes`);
  reads=0;for(const root of roots)root.processFrame(.016,token(1));assert.equal(reads,0);
  for(const root of roots)root.processFrame(.016,token(2));assert.equal(reads,2000,'new frames retain external native audits');
  for(const root of roots)root.requestShutdown();const closes=roots.map(root=>root.close());
  await f.flushDeletes();assert((await Promise.all(closes)).every(result=>result.status==='complete'));
 }
 assert.deepEqual(observed,[2000,2000,2000]);
});

test('updating a nested native subtree audits in linear work instead of rescanning its island per property',async()=>{
 for(const count of [50,100,500]){
  const f=fixture();f.setAutoPump(false);let reads=0;
  const getChildren=f.Node.prototype.get_children;
  f.Node.prototype.get_children=function(...args){reads++;return getChildren.apply(this,args);};
  const root=f.setup({immediate:false,...quiet});
  const view=value=>h(EngineNode,{ctor:f.Node},...Array.from({length:count},(_,key)=>h(EngineNode,{ctor:f.Label,key,native:{text:String(value)}})));
  root.render(view(0));root.flush();await settle();reads=0;
  root.render(view(1));root.flush();
  assert(reads<=20*count+100,`${count} children used ${reads} native child-list reads`);
  assert.equal(f.container.children[0].children.length,count);
  assert(f.container.children[0].children.every(child=>child.get('text')==='1'));
  assert.deepEqual(root.getErrors(),[]);root.requestShutdown();await f.flushDeletes();
 }
});

test('render-side raw transfer is audited again before the first native commit write',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef(),outside=new f.Node();let transfer=false;
 function App({value}){
  if(transfer){transfer=false;f.container.remove_child(ref.current);outside.add_child(ref.current);}
  return h(EngineNode,{ctor:f.Label,ref,native:{text:value}});
 }
 root.render(h(App,{value:'before'}));const object=ref.current;
 transfer=true;root.render(h(App,{value:'after'}));await settle();
 assert.equal(object.parent,outside);assert.equal(object.get('text'),'before');assert(object.alive);
 assert.equal(root.getStats().cleanExit,false);assert(!f.calls.some(([kind,target])=>(kind==='free'||kind==='queue_free')&&target===object));outside.free();
});

for(const transferred of ['ancestor','later-sibling'])test(`a native setter transferring an ${transferred} cannot expose the next write to its new owner`,async()=>{
 const f=fixture(),outside=new f.Node(),parentRef=React.createRef(),aRef=React.createRef(),bRef=React.createRef();let armed=false;
 const session=new EngineSession(f.godot,{writeProperty(object,name,value){
  object.set(name,value);
  if(armed&&object===aRef.current&&name==='text'){
   armed=false;const moved=transferred==='ancestor'?parentRef.current:bRef.current;
   moved.get_parent().remove_child(moved);outside.add_child(moved);
  }
  return {accepted:true,value:object.get(name)};
 }}),root=f.setup({session,...quiet});
 const view=value=>h(EngineNode,{ctor:f.Node,ref:parentRef},
  h(EngineNode,{ctor:f.Label,ref:aRef,native:{text:String(value),custom_value:value}}),
  h(EngineNode,{ctor:f.Label,ref:bRef,native:{text:String(value)}}));
 root.render(view(0));const parent=parentRef.current,a=aRef.current,b=bRef.current;
 armed=true;root.render(view(1));await settle();
 const moved=transferred==='ancestor'?parent:b;
 assert.equal(moved.parent,outside);assert(moved.alive);assert.equal(root.getStats().cleanExit,false);
 assert.equal(transferred==='ancestor'?a.get('custom_value'):b.get('text'),transferred==='ancestor'?0:'0');
 assert(!f.calls.some(([kind,target])=>(kind==='free'||kind==='queue_free')&&[parent,a,b].includes(target)));
 outside.free();if(parent.alive)parent.free();
});

test('same-frame render, setState and due scheduler timers are never hidden by automatic coalescing',async()=>{
 const f=fixture();f.setAutoPump(false);const root=f.setup({immediate:false,...quiet});let update;
 function App(){const [value,set]=React.useState(0);update=set;return h(EngineNode,{ctor:f.Label,native:{text:String(value)}});}
 root.render(h(App));root.flush();await settle();
 root.processFrame(.016,token(1));update(1);root.processFrame(.016,token(1));
 assert.equal(f.container.children[0].get('text'),'1');
 let now=100;configureScheduler({now:()=>now});
 try{
  scheduleHostTimeout(()=>update(2),10);root.processFrame(.016,token(1));
  assert.equal(f.container.children[0].get('text'),'1');
  now=110;root.processFrame(.016,token(1));assert.equal(f.container.children[0].get('text'),'2');
  root.render(h(EngineNode,{ctor:f.Label,native:{text:'explicit'}}));root.processFrame(.016,token(1));
  assert.equal(f.container.children[0].get('text'),'explicit');
 }finally{configureScheduler({now:()=>Date.now()});root.requestShutdown();await f.flushDeletes();}
});

test('automatic roots preserve individual deltas, inactive roots, physics steps and manual driving',async()=>{
 const f=fixture();f.setAutoPump(false);const a=f.setup({...quiet}),mount=new f.Node();f.tree.add_child(mount);
 const b=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet}));const calls=[];
 function App({id}){useFrame('process',delta=>calls.push([id,'p',delta]));useFrame('physics',delta=>calls.push([id,'f',delta]));return null;}
 a.render(h(App,{id:'a'}));b.render(h(App,{id:'b'}));await settle();
 a.processFrame(.01,token(1));a.processFrame(.02,token(1));
 assert.deepEqual(calls,[['a','p',.01]],'driving a never wakes b');
 b.processFrame(.03,token(1));a.physicsFrame(.04,token(1));a.physicsFrame(.05,token(2));a.physicsFrame(.06,token(2));
 a.process(.07);a.process(.08);a.physicsFrame(.09,token(1,'native-B'));
 assert.deepEqual(calls,[['a','p',.01],['b','p',.03],['a','f',.04],['a','f',.05],['a','p',.07],['a','p',.08],['a','f',.09]]);
 a.requestShutdown();b.requestShutdown();await f.flushDeletes();
});

test('raw native changes between automatic drivers are inspected before a root callback',async()=>{
 const f=fixture();f.setAutoPump(false);const a=f.setup(quiet),mount=new f.Node(),outside=new f.Node();f.tree.add_child(mount);f.tree.add_child(outside);
 const b=f.drive(createRoot(mount,{godot:f.godot,autoProcess:false,...quiet}));let called=0;const ref=React.createRef();
 function App(){useFrame('process',()=>called++);return h(EngineNode,{ctor:f.Label,ref});}
 b.render(h(App));await settle();a.processFrame(.016,token(1));
 const moved=ref.current;mount.remove_child(moved);outside.add_child(moved);
 b.processFrame(.016,token(1));assert.equal(called,0);assert.equal(b.getStats().cleanExit,false);
 await settle();assert.equal(moved.parent,outside);assert.equal(moved.alive,true);
 a.requestShutdown();await f.flushDeletes();outside.free();
});

test('an unavailable maintenance checkpoint does not consume the same-frame external audit',async()=>{
 const f=fixture();f.setAutoPump(false);let allowed=true;
 const session=new EngineSession(f.godot,{canCommit:()=>allowed}),root=f.setup({session,...quiet}),ref=React.createRef(),outside=new f.Node();f.tree.add_child(outside);
 root.render(h(EngineNode,{ctor:f.Label,ref}));await settle();
 allowed=false;root.processFrame(.01,token(1));
 const moved=ref.current;f.container.remove_child(moved);outside.add_child(moved);
 allowed=true;root.processFrame(.02,token(1));assert.equal(root.getStats().cleanExit,false);
 await settle();assert.equal(moved.alive,true);assert.equal(moved.parent,outside);outside.free();
});

test('root close is idempotent and waits after logical disposal until native deletion is confirmed',async()=>{
 const f=fixture(),root=f.setup(quiet),ref=React.createRef();root.render(h(EngineNode,{ctor:f.Label,ref}));const object=ref.current;
 const close=root.close();assert.equal(root.close(),close);let completed=false;void close.then(()=>completed=true);
 await settle();assert.equal(root.getStats().state,'disposed');assert.equal(object.alive,true);assert.equal(completed,false);
 assert.deepEqual(root.getCloseProgress(),{status:'pending',logicalDisposed:true,pendingReleases:1});
 await f.flushDeletes();assert.deepEqual(await close,{status:'complete',pendingReleases:0});assert.equal(root.close(),close);
});

test('one live entry can repeatedly close native roots without retaining cleanup slots',async()=>{
 const f=fixture(),binding=bindingFixture(),entry=binding.openEntry();entry.finishStartup();
 globalThis.__godotjsRuntimeHost=binding;
 try{
  for(let i=0;i<256;i++){
   const root=f.setup({runtimeHost:entry.host,...quiet});root.render(h(EngineNode,{ctor:f.Label}));
   const closing=root.close();await settle();
   assert.equal(binding.closeProgress().pendingCleanups,1,'The registration remains while native destruction is pending');
   await f.flushDeletes();assert.equal((await closing).status,'complete');
   assert.equal(binding.closeProgress().pendingCleanups,0,'Actual release retires the registration');
  }
  binding.beginClose();await binding.drainClose();assert.equal(binding.closeProgress().status,'complete');
 }finally{binding.settle();delete globalThis.__godotjsRuntimeHost;}
});

test('a completed and retired root never reads native source maps after its entry seals',async()=>{
 const f=fixture(),binding=bindingFixture(),entry=binding.openEntry();entry.finishStartup();globalThis.__godotjsRuntimeHost=binding;
 try{
  const root=f.setup({runtimeHost:entry.host,...quiet}),closing=root.close();await f.flushDeletes();assert.equal((await closing).status,'complete');
  assert.equal(binding.closeProgress().pendingCleanups,0);binding.endNativeEpoch('native-script');
  let reads=0;Object.defineProperty(f.godot,'FileAccess',{get(){reads++;throw Error('Native source access after release');}});
  root.recordError({stack:'at stale (res://.godot/GodotJS/src/App.js:2:3)'});root.getStats();root.getCloseProgress();
  assert.equal(reads,0);
 }finally{binding.settle();delete globalThis.__godotjsRuntimeHost;}
});

test('a pending native release keeps its native world owned by the existing session',async()=>{
 const f=fixture(),root=f.setup(quiet);root.render(h(EngineNode,{ctor:f.Label}));const close=root.close();await settle();
 assert.equal(root.getStats().state,'disposed');assert.equal(root.getCloseProgress().pendingReleases,1);
 const replacement=new EngineSession(f.godot);
 assert.throws(()=>createRoot(f.container,{godot:f.godot,session:replacement,autoProcess:false,...quiet}),/E_ENGINE_SESSION/);
 await f.flushDeletes();assert.equal((await close).status,'complete');
 const next=f.drive(createRoot(f.container,{godot:f.godot,session:replacement,autoProcess:false,...quiet}));
 assert.equal(next.session,replacement);next.requestShutdown();await f.flushDeletes();assert.equal((await next.close()).status,'complete');
});

test('sealed close publishes unconfirmed without querying native handles or hanging its promise',async()=>{
 const f=fixture(),root=f.setup(quiet);root.render(h(EngineNode,{ctor:f.Label}));const close=root.close();await settle();
 let nativeReads=0;f.godot.is_instance_valid=()=>{nativeReads++;throw Error('sealed native access');};
 f.godot.Engine.is_in_physics_frame=()=>{nativeReads++;throw Error('sealed native phase access');};
 const result=root.sealClose();assert.deepEqual(result,{status:'unconfirmed',pendingReleases:1});assert.deepEqual(await close,result);
 root.getCloseProgress();root.getStats();root.process(.1);root.physics(.1);root.processFrame(.1);root.session.drainClose();
 assert.equal(nativeReads,0);assert.equal(root.sealClose(),result);
});

test('a failed native liveness observation never certifies a pending release as destroyed',async()=>{
 const f=fixture(),root=f.setup(quiet);root.render(h(EngineNode,{ctor:f.Label}));const close=root.close();await settle();
 const check=f.godot.is_instance_valid;f.godot.is_instance_valid=()=>{throw Error('native observation unavailable');};
 assert.deepEqual(root.getCloseProgress(),{status:'pending',logicalDisposed:true,pendingReleases:1});
 let completed=false;void close.then(()=>completed=true);await settle();assert.equal(completed,false);
 f.godot.is_instance_valid=()=>undefined;assert.equal(root.getCloseProgress().status,'pending');
 f.godot.is_instance_valid=check;await f.flushDeletes();assert.equal((await close).status,'complete');
});

test('native ObjectDB identity remains authoritative if an old wrapper becomes invalid before destruction',async()=>{
 const f=fixture(),root=f.setup(quiet);root.render(h(EngineNode,{ctor:f.Label}));const close=root.close();await settle();
 f.godot.instance_from_id=id=>[...f.objects].find(object=>BigInt(object.id)===BigInt(id))??null;
 const check=f.godot.is_instance_valid;f.godot.is_instance_valid=()=>false;
 assert.equal(root.getCloseProgress().status,'pending');assert.equal(root.getCloseProgress().pendingReleases,1);
 f.godot.is_instance_valid=check;await f.flushDeletes();assert.equal((await close).status,'complete');
});

test('failed native release is terminal for close and never retried',async()=>{
 const f=fixture(),root=f.setup(quiet);let attempts=0;
 class Broken extends f.Label{queue_free(){attempts++;throw Error('release failed');}}
 root.render(h(EngineNode,{ctor:Broken}));const close=root.close();await settle();root.session.drainClose();
 assert.deepEqual(await close,{status:'failed',pendingReleases:0});assert.equal(attempts,1);
});

test('an effect cleanup error cannot resolve root close as complete',async()=>{
 const f=fixture(),root=f.setup(quiet);
 function App(){React.useEffect(()=>()=>{throw Error('effect cleanup rejected');},[]);return null;}
 root.render(h(App));await settle();const close=root.close();await settle();
 assert.deepEqual(await close,{status:'failed',pendingReleases:0});
 assert(root.getErrors().some(value=>value.message==='effect cleanup rejected'));
});

test('sealing an already completed root preserves its result and prevents stale error source-map reads',async()=>{
 const f=fixture(),root=f.setup(quiet);root.render(h(EngineNode,{ctor:f.Label}));const close=root.close();await f.flushDeletes();
 const result=await close;let reads=0;Object.defineProperty(f.godot,'FileAccess',{get(){reads++;throw Error('old native epoch');}});
 assert.equal(root.sealClose(),result);root.recordError(Error('stale callback'));root.getStats();root.getCloseProgress();
 assert.equal(reads,0);assert.equal((await root.close()).status,'complete');
});

test('cancelled entries and closing realm bindings reject new roots before native inspection',async()=>{
 const f=fixture();let inspected=0;const check=f.godot.is_instance_valid;
 f.godot.is_instance_valid=(value)=>{inspected++;return check(value);};
 assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,lifetime:{cancelled:true}}),/E_ENGINE_CLOSING/);
 globalThis.__godotjsRuntimeHost={role:'engine',sessionId:'closing',closeProgress:()=>({closing:true})};
 try{
  assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,runtimeHost:{sessionId:'closing'}}),/E_ENGINE_CLOSING/);
  globalThis.__godotjsRuntimeHost.closeProgress=()=>({closing:false,accepting:false});
  assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,runtimeHost:{sessionId:'closing'}}),/E_ENGINE_CLOSING/);
  assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,runtimeHost:{sessionId:'old-session'}}),/E_ENGINE_CLOSING/);assert.equal(inspected,0);
 }
 finally{delete globalThis.__godotjsRuntimeHost;}
 const lifetime={cancelled:false},root=f.setup({lifetime,...quiet});let frames=0;
 function App(){useFrame('process',()=>frames++);return null;}
 root.render(h(App));lifetime.cancelled=true;root.process(.1);root.processFrame(.1,token(1));
 assert.equal(frames,0);assert.throws(()=>root.render(null),/E_ENGINE_DISPOSED/);
 root.requestShutdown();await f.flushDeletes();assert.equal((await root.close()).status,'complete');
});

test('ordinary script roots attach their close, tick and seal participants through the scoped host',async()=>{
 const f=fixture(),binding=bindingFixture(),entry=binding.openEntry();globalThis.__godotjsRuntimeHost=binding;
 try{
  const root=f.setup({runtimeHost:entry.host,...quiet});root.render(h(EngineNode,{ctor:f.Label}));entry.finishStartup();
  assert.equal(root.runtimeManagedCleanup,true);binding.beginClose('ordinary-script-stop');
  await binding.drainClose();await settle();assert.equal(root.getCloseProgress().pendingReleases,1);
  assert.equal(binding.closeProgress().status,'pending');
  await f.flushDeletes();for(let i=0;i<8;i++)await binding.drainClose();
  assert.equal(binding.closeProgress().status,'complete');assert.equal((await root.close()).status,'complete');
  binding.endNativeEpoch('native-script');assert.equal(root.getCloseProgress().status,'complete');
 }finally{binding.settle();delete globalThis.__godotjsRuntimeHost;}
});

test('entry cleanup ownership rejects closed and foreign hosts while another live entry remains usable',async()=>{
 const f=fixture(),binding=bindingFixture(),old=binding.openEntry();old.finishStartup();globalThis.__godotjsRuntimeHost=binding;
 try{
  assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,runtimeHost:{...old.host},...quiet}),/E_ENGINE_ENTRY/);
  old.close();await binding.drainClose();
  assert.throws(()=>createRoot(f.container,{godot:f.godot,autoProcess:false,runtimeHost:old.host,...quiet}),/E_ENGINE_ENTRY/);
  const next=binding.openEntry(),root=f.setup({runtimeHost:next.host,...quiet});next.finishStartup();
  assert.equal(root.runtimeManagedCleanup,true);next.close();await binding.drainClose();await f.flushDeletes();
  for(let i=0;i<4;i++)await binding.drainClose();assert.equal((await root.close()).status,'complete');
 }finally{binding.settle();delete globalThis.__godotjsRuntimeHost;}
});
