const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const SDK=require('../dist');
const {MockNativePort}=require('../dist/testing');
const h=React.createElement;
function setup(){const port=new MockNativePort();const container=port.createContainer();const root=SDK.createRoot(port,container,{generation:'test',mode:'production'});return {root,port,container};}
function child(port,key,name){return port.children(key).find(k=>port.info(k).name===name);}

test('real React context/state reconcile stable keys and current committed events',()=>{
 const {root,port,container}=setup();const Context=React.createContext('');let setOrder;let setVersion;const seen=[];
 function App(){const [order,set]=React.useState(['a','b']);setOrder=set;const version=arguments[0].version??0;return h(Context.Provider,{value:'ctx'},h(SDK.VBoxContainer,{name:'box'},...order.map(id=>h(Item,{key:id,id,version}))));}
 function Item({id,version}){return h(SDK.Button,{name:id,text:React.useContext(Context)+id,onPressed:()=>seen.push([id,version])});}
 try{root.render(h(App));const box=child(port,container,'box');const a=child(port,box,'a');port.emit(a,'pressed');root.render(h(App,{version:1}));root.pump();assert.deepEqual(seen,[['a',1]]);setOrder(['b','a']);root.flush();root.pump();assert.equal(port.children(box)[1],a);assert.equal(port.read(a,'text'),'ctxa');assert.equal(root.getErrors().length,0);}finally{root.shutdown();}assert.equal(port.liveCount(),1);assert.equal(port.connectionCount(),0);
});

test('cleanup observes live read-only facade until passive cleanup is settled',()=>{
 const {root,port}=setup();let captured;const checks=[];
 function App(){const ref=SDK.useNodeRef();React.useLayoutEffect(()=>{captured=ref.current;checks.push(['layout',captured.isValid()]);return()=>checks.push(['layout-clean',captured.isValid(),captured.read('text')]);},[]);React.useEffect(()=>()=>checks.push(['passive-clean',captured.isValid(),captured.read('text')]),[]);return h(SDK.Label,{ref,text:'live'});}
 root.render(h(App));assert.equal(Object.isFrozen(captured),true);assert.equal(captured.queueFree,undefined);assert.throws(()=>captured.read('script'),/E_PROPERTY_UNSUPPORTED/);root.shutdown();assert.deepEqual(checks,[['layout',true],['layout-clean',true,'live'],['passive-clean',true,'live']]);assert.equal(captured.isValid(),false);assert.equal(root.getCleanupReceipts().length,1);assert.equal(root.getStats().hostRecords,0);assert.equal(port.liveCount(),1);
});

test('controlled values reset to original initial baseline and setter echoes are suppressed',()=>{
 const {root,port,container}=setup();let change;const seen=[];
 function App(){const [on,set]=React.useState(true);change=set;return h(SDK.Button,{name:'button',toggleMode:true,initial:{buttonPressed:false},...(on?{buttonPressed:true}:{}),onToggled:v=>seen.push(v)});}
 try{root.render(h(App));const key=child(port,container,'button');assert.equal(port.read(key,'button_pressed'),true);change(false);root.flush();root.pump();assert.equal(port.read(key,'button_pressed'),false);assert.deepEqual(seen,[]);port.emit(key,'toggled',true);root.pump();assert.deepEqual(seen,[true]);}finally{root.shutdown();}
});

test('process command leases expire and React structural writes wait for pump',()=>{
 const {root,port,container}=setup();let expired;let count=0;
 function App(){const ref=SDK.useNodeRef();const [text,set]=React.useState('before');SDK.useProcess(ref,{writes:['position']},(commands)=>{expired=commands;commands.setPosition(SDK.vec2(2,3));if(!count++)set('after');});return h(SDK.Node2D,{ref,name:'actor',engineOwned:['position']},h(SDK.Label,{name:'label',text}));}
 try{root.render(h(App));const actor=child(port,container,'actor');const label=child(port,actor,'label');root.process(.016);assert.deepEqual(port.read(actor,'position'),{x:2,y:3});assert.equal(port.read(label,'text'),'before');assert.throws(()=>expired.setPosition({x:4,y:5}),/E_STALE_COMMAND/);root.pump();assert.equal(port.read(label,'text'),'after');}finally{root.shutdown();}
});

test('foreign physical deletion is detected and faults the root',()=>{
 const {root,port,container}=setup();root.render(h(SDK.Label,{name:'target',text:'x'}));port.externalFree(child(port,container,'target'));assert.throws(()=>root.pump(),/E_FOREIGN_MUTATION/);assert.equal(root.state,'faulted');root.shutdown();assert.equal(root.state,'disposed');
});

test('render preparation and suspended work do not allocate native business nodes',()=>{
 const {root,port}=setup();let resolve;const waiting=new Promise(r=>resolve=r);function Suspended(){React.use(waiting);return h(SDK.Label,{text:'later'});}
 root.render(h(Suspended));assert.equal(port.calls.filter(x=>x.op==='create').length,0);root.shutdown();resolve();assert.equal(port.liveCount(),1);
});

test('native ready callback and cleanup run once for a physical target',()=>{
 const {root}=setup();let count=0,cleanup=0;function App(){const ref=SDK.useNodeRef();SDK.useNativeReady(ref,handle=>{assert.equal(handle.isValid(),true);count++;return()=>cleanup++;});return h(SDK.Node,{ref});}
 root.render(h(App));root.pump();root.pump();assert.equal(count,1);root.shutdown();assert.equal(cleanup,1);
});

test('startup assets load through native gate and boot waits for asset retry publication',async()=>{
 const port=new MockNativePort();const container=port.createContainer();port.assets.set('res://mat.tres',{});const reports=[];const root=SDK.createRoot(port,container,{generation:'asset-test',assets:{mat:{uri:'res://mat.tres',type:'CanvasItemMaterial'}},onBoot:r=>reports.push(r)});
 function App(){const material=SDK.useAsset(SDK.asset('mat','CanvasItemMaterial'));return h(SDK.Node2D,{name:'assetNode',material});}
 try{root.preloadAssets(['mat']);root.render(h(App));assert.equal(port.calls.filter(x=>x.op==='create').length,0);assert.equal(reports.length,0);for(let i=0;i<5&&reports.length===0;i++){root.pump();await new Promise(r=>setTimeout(r,320));}root.pump();assert.equal(reports.length,1);assert.equal(root.getStats().hostRecords,1);assert.deepEqual(reports[0].startupAssets,{requested:['mat'],ready:['mat'],failures:[]});const node=child(port,container,'assetNode');assert.equal(port.read(node,'material').id,'res://mat.tres');assert.equal(port.calls.filter(x=>x.op==='create').length,1);}finally{root.shutdown();}
});

test('physics profile is explicit and commands verify property leases and argument codecs',()=>{
 const port=new MockNativePort();const container=port.createContainer();const root=SDK.createRoot(port,container,{generation:'physics',profileId:'behavior-physics-v1'});let stale;
 function App(){const ref=SDK.useNodeRef();SDK.usePhysicsProcess(ref,{writes:['position','velocity']},node=>{stale=node;node.setVelocity(SDK.vec2(0,12));assert.equal(node.moveAndSlide(),false);assert.throws(()=>node.setVelocity({x:NaN,y:0}),/E_PROPERTY_VALUE/);});return h(SDK.CharacterBody2D,{ref,name:'actor',initial:{position:SDK.vec2(0,2)},engineOwned:['position','velocity']});}
 try{root.render(h(App));root.physics(.016);assert.deepEqual(port.read(child(port,container,'actor'),'velocity'),{x:0,y:12});assert.throws(()=>stale.moveAndSlide(),/E_STALE_COMMAND/);}finally{root.shutdown();}
 const {getHostSchema}=require('../dist/schema');assert.throws(()=>getHostSchema('CharacterBody2D'),/E_HOST_UNSUPPORTED/);
});

test('native script selects construction before append and dispatches current registered handlers',()=>{
 const {dispatchNativeInterface}=require('../dist/native-interfaces');const token=SDK.defineNativeInterface('actor',{version:1,nativeLeaf:'Node2D',callbacks:['_ready','_process'],rpc:{rpcPing:{arguments:['integer']}}});const port=new MockNativePort();const container=port.createContainer();const calls=[];const original=port.create.bind(port);port.create=(type,script)=>{calls.push(['ctor',script]);return original(type);};const root=SDK.createRoot(port,container,{generation:'native',nativeScriptProfiles:{actor:{type:'Node2D',script:'res://generated/react/native/actor.ts',schemaHash:token.schemaHash}}});let sender;let version=0;const seen=[];
 function App(){const ref=SDK.useNodeRef();const current=version;sender=SDK.useNativeInterface(ref,token,{_ready:()=>seen.push(['ready',current]),_process:dt=>seen.push([dt,current]),rpcPing:n=>seen.push(['ping',n])});return h(SDK.Node2D,{ref,name:'actor',nativeInterface:token});}
 try{root.render(h(App));const key=child(port,container,'actor'),identity=port.nativeIdentity(key);assert.deepEqual(calls,[['ctor','res://generated/react/native/actor.ts']]);dispatchNativeInterface(identity,token.profile,token.schemaHash,'_ready',[]);dispatchNativeInterface(identity,token.profile,token.schemaHash,'_process',[.1]);version=1;root.render(h(App));root.pump();assert.deepEqual(seen,[['ready',1],[.1,1]]);assert.deepEqual(sender.send('rpcPing',[9]),{localError:0});root.shutdown();assert.equal(dispatchNativeInterface(identity,token.profile,token.schemaHash,'rpcPing',[9]),false);}finally{root.shutdown();}
});

test('scheduler adapter preserves user timer functions and publication receipts name separate barriers',()=>{
 const before=[globalThis.setTimeout,globalThis.clearTimeout,globalThis.setImmediate];require('../dist/scheduler');assert.deepEqual([globalThis.setTimeout,globalThis.clearTimeout,globalThis.setImmediate],before);const {root}=setup();let layoutPublication;function App(){React.useLayoutEffect(()=>{layoutPublication=root.getPublicationReceipts().map(x=>x.barrier);},[]);return h(SDK.Label,{text:'x'});}root.render(h(App));assert.deepEqual(layoutPublication,['nativeApplied']);assert.deepEqual(root.getPublicationReceipts().map(x=>x.barrier),['nativeApplied','layoutPublished']);root.shutdown();assert.equal(root.getCleanupReceipts()[0].barrier,'passiveSettled');
});

test('template component expands every host and binds owner, with isolated local asset scopes',async()=>{
 const hash='a'.repeat(64);const source={source:'res://template.tscn',line:1,column:1};const plan={schemaVersion:1,assetId:'box',source:'res://template.tscn',sourceHash:hash,snapshotHash:hash,profile:'template-local-v1',rootId:'root',nodes:[{nodeId:'root',nativeType:'Node2D',parentId:null,siblingOrder:0,name:'Template',initial:{material:SDK.asset('mat','CanvasItemMaterial')},ownerId:null,source},{nodeId:'leaf',nativeType:'Node2D',parentId:'root',siblingOrder:0,name:'Child',initial:{material:SDK.asset('mat','CanvasItemMaterial')},ownerId:'root',source}],resources:[{resourceId:'mat',type:'CanvasItemMaterial',uri:'res://mat.tres',sha256:hash,dependencies:[],sharingPolicy:'instance'}]};const Template=SDK.createTemplateComponent(plan);const port=new MockNativePort();const container=port.createContainer();port.assets.set('res://mat.tres',{});const root=SDK.createRoot(port,container,{generation:'template',assets:{mat:{uri:'res://mat.tres',type:'CanvasItemMaterial'}}});let handle;function App(){return h(React.Fragment,null,h(Template,{name:'One',ref:v=>{handle=v;}}),h(Template,{name:'Two'}));}
 try{root.render(h(App));for(let i=0;i<5&&root.getStats().hostRecords!==4;i++){root.pump();await new Promise(r=>setTimeout(r,320));}root.pump();const one=child(port,container,'One'),two=child(port,container,'Two');assert.ok(one&&two);const oneChild=port.children(one)[0];assert.equal(root.getStats().hostRecords,4);assert.equal(port.read(one,'material'),port.read(oneChild,'material'));assert.notEqual(port.read(one,'material'),port.read(two,'material'));assert.deepEqual(handle.read('material'),{kind:'asset',id:'mat',type:'CanvasItemMaterial',scope:'instance'});const finishes=port.calls.filter(x=>x.op==='finishScope');assert.equal(finishes.length,2);assert.equal(port.calls.findIndex(x=>x.op==='finishScope')<port.calls.findIndex(x=>x.op==='append'&&x.key.slot===one.slot&&x.key.revision===one.revision),true);}finally{root.shutdown();}assert.equal(port.calls.filter(x=>x.op==='releaseScope').length,2);assert.equal(port.liveCount(),1);
});

test('property leases exclude alias conflicts and release inactive subscriptions',()=>{
 const port=new MockNativePort();const container=port.createContainer();const root=SDK.createRoot(port,container,{generation:'leases',profileId:'behavior-physics-v1'});let active=false;
 function App(){const ref=SDK.useNodeRef();SDK.usePhysicsProcess(ref,{writes:['position'],active},()=>{});SDK.usePhysicsProcess(ref,{writes:['transform2d']},()=>{});return h(SDK.CharacterBody2D,{ref,engineOwned:['position']});}
 root.render(h(App));active=true;assert.throws(()=>root.render(h(App)),/E_PROPERTY_WRITER_CONFLICT/);assert.equal(root.state,'faulted');root.shutdown();assert.equal(port.liveCount(),1);
});

test('shutdown invalidates pending native handlers before cleanup drains queues',()=>{
 const {dispatchNativeInterface}=require('../dist/native-interfaces');const token=SDK.defineNativeInterface('lifetime',{version:1,nativeLeaf:'Node2D',callbacks:['_process']});const port=new MockNativePort();const container=port.createContainer();const root=SDK.createRoot(port,container,{generation:'shutdown',nativeScriptProfiles:{lifetime:{type:'Node2D',script:'res://generated/react/native/lifetime.ts',schemaHash:token.schemaHash}}});let calls=0;function App(){const ref=SDK.useNodeRef();SDK.useNativeInterface(ref,token,{_process:()=>calls++});return h(SDK.Node2D,{ref,name:'native',nativeInterface:token});}root.render(h(App));const identity=port.nativeIdentity(child(port,container,'native'));dispatchNativeInterface(identity,token.profile,token.schemaHash,'_process',[.1]);root.shutdown();assert.equal(calls,0);assert.equal(root.getStats().queuedMicrotasks,0);
});

test('committed frame options are immutable and cannot acquire writes by caller mutation',()=>{
 const {root}=setup();const writes=[];const options={writes};let checked=0;function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,options,node=>{assert.throws(()=>node.setPosition({x:1,y:2}),/E_PROPERTY_OWNER_CONFLICT/);checked++;});return h(SDK.Node2D,{ref,engineOwned:['position']});}try{root.render(h(App));writes.push('position');root.process(.1);assert.equal(checked,1);}finally{root.shutdown();}
});

test('frame ordering follows current committed host preorder after keyed reordering',()=>{
 const {root}=setup();const seen=[];function Item({name}){const ref=SDK.useNodeRef();SDK.useProcess(ref,{},()=>seen.push(name));return h(SDK.Node,{ref,name});}function App({order}){return h(SDK.Node,{name:'world'},...order.map(name=>h(Item,{key:name,name})));}try{root.render(h(App,{order:['a','b']}));root.process(.1);assert.deepEqual(seen,['a','b']);seen.length=0;root.render(h(App,{order:['b','a']}));root.process(.1);assert.deepEqual(seen,['b','a']);}finally{root.shutdown();}
});

test('Suspense reveal restores immutable initial visibility baseline',async()=>{
 const {root,port,container}=setup();let suspend;let resolve;let waiting;function App(){const [blocked,set]=React.useState(false);suspend=set;if(blocked)React.use(waiting);return h(SDK.Node2D,{name:'hidden',initial:{visible:false}});}try{root.render(h(App));const key=child(port,container,'hidden');waiting=new Promise(r=>resolve=r);suspend(true);root.flush();root.pump();await new Promise(r=>setTimeout(r,350));root.pump();resolve();for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,160));root.pump();}assert.equal(port.read(key,'visible'),false);assert.equal(root.getStats().hostRecords,1);}finally{root.shutdown();}
});

test('mutable backend keys cannot redirect a command capability to another host',()=>{
 const port=new MockNativePort();const original=port.create.bind(port);port.create=type=>({...original(type)});const container=port.createContainer();const root=SDK.createRoot(port,container,{generation:'key-caps'});let victim;function App(){const a=SDK.useNodeRef();const b=SDK.useNodeRef();React.useLayoutEffect(()=>{victim=b.current;},[]);SDK.useProcess(a,{writes:['position']},commands=>{assert.equal(Object.isFrozen(commands.nativeKey),true);try{commands.nativeKey.slot=victim.nativeKey.slot;commands.nativeKey.revision=victim.nativeKey.revision;}catch{}commands.setPosition({x:2,y:3});});return h(SDK.Node,{name:'world'},h(SDK.Node2D,{ref:a,name:'writer',engineOwned:['position']}),h(SDK.Node2D,{ref:b,name:'victim',position:{x:0,y:0}}));}try{root.render(h(App));root.process(.1);assert.deepEqual(victim.readPosition(),{x:0,y:0});}finally{root.shutdown();}
});

test('foreign reparent fault still finishes shutdown and releases the backend root',()=>{
 const {root,port,container}=setup();const foreign=port.createContainer('foreign');root.render(h(SDK.Node,{name:'owned'}));const key=child(port,container,'owned');port.beginStage('safe');port.append(foreign,key,0);port.endStage();assert.throws(()=>root.pump(),/E_FOREIGN_MUTATION/);root.shutdown();assert.equal(root.state,'disposed');assert.equal(port.isAlive(key),false);assert.equal(port.isAlive(foreign),true);assert.equal(port.calls.some(x=>x.op==='forceClose'),true);root.shutdown();
});

test('an exception in onError cannot leave failed frame writers running',()=>{
 const port=new MockNativePort();const root=SDK.createRoot(port,port.createContainer(),{generation:'logger',onError(){throw Error('logger failure');}});let ticks=0;function App(){const ref=SDK.useNodeRef();SDK.useProcess(ref,{},()=>{ticks++;throw Error('frame failure');});return h(SDK.Node,{ref});}root.render(h(App));assert.throws(()=>root.process(.1),/frame failure/);root.process(.1);assert.equal(ticks,1);assert.equal(root.state,'faulted');assert.equal(root.getErrors().some(x=>String(x).includes('logger failure')),true);root.shutdown();
});

test('dependent Button setters follow schema order across initial and controlled writes',()=>{
 const {root,port,container}=setup();try{root.render(h(SDK.Button,{name:'button',buttonPressed:true,toggleMode:true}));const key=child(port,container,'button');assert.equal(port.read(key,'button_pressed'),true);root.render(h(SDK.Button,{name:'button',buttonPressed:false,toggleMode:false}));assert.equal(port.read(key,'button_pressed'),false);root.render(h(SDK.Button,{name:'button',buttonPressed:true,toggleMode:true}));assert.equal(port.read(key,'button_pressed'),true);root.render(h(SDK.Button,{key:'second',name:'button',initial:{buttonPressed:true},toggleMode:true}));assert.equal(port.read(child(port,container,'button'),'button_pressed'),true);}finally{root.shutdown();}
});

test('controlled Button state restores native clicks even without an event handler',()=>{
 const {root,port,container}=setup();try{root.render(h(SDK.Button,{name:'toggle',toggleMode:true,buttonPressed:false}));const key=child(port,container,'toggle');port.beginStage('input');port.set(key,'button_pressed',true);port.endStage();assert.equal(port.read(key,'button_pressed'),true);root.pump();assert.equal(port.read(key,'button_pressed'),false);assert.equal(root.getErrors().length,0);}finally{root.shutdown();}
});

test('controlled Button event state updates retain the newly committed native value',()=>{
 const {root,port,container}=setup();const seen=[];function App(){const [pressed,set]=React.useState(false);return h(SDK.Button,{name:'toggle',toggleMode:true,buttonPressed:pressed,onToggled:next=>{seen.push(next);set(next);}});}try{root.render(h(App));const key=child(port,container,'toggle');port.beginStage('input');port.set(key,'button_pressed',true);port.endStage();root.pump();assert.equal(port.read(key,'button_pressed'),true);assert.deepEqual(seen,[true]);root.pump();assert.deepEqual(seen,[true]);assert.equal(root.getErrors().length,0);}finally{root.shutdown();}
});

test('a realm rejects a second active Root before shared asynchronous work can cross native gates',async()=>{
 const firstPort=new MockNativePort(),secondPort=new MockNativePort();const firstContainer=firstPort.createContainer('first'),secondContainer=secondPort.createContainer('second');const first=SDK.createRoot(firstPort,firstContainer,{generation:'single',rootId:'first'});let update;function App(){const [text,set]=React.useState('before');update=set;return h(SDK.Label,{text});}try{first.render(h(App));assert.throws(()=>SDK.createRoot(secondPort,secondContainer,{generation:'single',rootId:'second'}),/E_MULTIPLE_ROOTS_UNSUPPORTED/);assert.equal(secondPort.calls.length,0);await Promise.resolve().then(()=>update('after'));first.pump();assert.equal(firstPort.read(firstPort.children(firstContainer)[0],'text'),'after');assert.equal(first.state,'running');assert.equal(first.getErrors().length,0);}finally{first.shutdown();}const second=SDK.createRoot(secondPort,secondContainer,{generation:'single',rootId:'second'});second.render(h(SDK.Label,{text:'next entry'}));second.shutdown();assert.equal(second.state,'disposed');
});
