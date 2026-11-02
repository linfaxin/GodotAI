const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const ts = require('typescript');
const n = require('../dist/native-interfaces.js');

const schema = () => ({version:1,nativeLeaf:'Node2D',callbacks:['_ready','_process','_input'],rpc:{rpcPing:{arguments:['string','dto','networkId'],mode:'anyPeer',sync:'local',transferMode:'unreliableOrdered',channel:2},rpcAuthority:{arguments:['integer']}}});
const token = () => n.defineNativeInterface('player',schema());
function harness() {
  const queue=[],errors=[],sent=[];let live=true;
  const registry=new n.NativeInterfaceRegistry({isAlive:()=>live,enqueue:fn=>queue.push(fn),onError:e=>errors.push(e),send:(...args)=>{sent.push(args);return 0;}});
  const key={slot:1,revision:7},handle={nativeKey:key};const t=token();
  registry.bind('18446744073709551615',key,t,handle);
  return {registry,key,handle,t,errors,sent,dispatch:(method,args=[])=>n.dispatchNativeInterface('18446744073709551615',t.profile,t.schemaHash,method,args),drain:()=>{while(queue.length)queue.shift()();},kill:()=>{live=false;}};
}

test('static schema canonical SHA-256 agrees with standard crypto and normalizes defaults',()=>{
  const input=schema(),normalized=n.validateNativeInterfaceSchema(input);
  assert.equal(n.nativeInterfaceSchemaHash(input),createHash('sha256').update(JSON.stringify(normalized)).digest('hex'));
  assert.deepEqual(normalized.rpc.rpcAuthority,{arguments:['integer'],mode:'authority',sync:'remote',transferMode:'reliable',channel:0});
  const reordered={rpc:{rpcAuthority:{arguments:['integer']},rpcPing:input.rpc.rpcPing},callbacks:['_input','_ready','_process'],nativeLeaf:'Node2D',version:1};
  assert.equal(n.nativeInterfaceSchemaHash(input),n.nativeInterfaceSchemaHash(reordered));
  assert.equal(n.nativeInterfaceSchemaHash(input),n.nativeInterfaceSchemaHash(normalized));
  assert(Object.isFrozen(normalized.rpc.rpcPing.arguments));
});

test('invalid static native schemas and inherited native method overrides are rejected',()=>{
  const bad=[null,[],{}, {...schema(),version:2},{...schema(),nativeLeaf:'PackedScene'},{...schema(),dynamic:true},{...schema(),callbacks:['_ready','_ready']},{...schema(),callbacks:['_enter_tree']},{...schema(),rpc:{queue_free:{arguments:[]}}},{...schema(),rpc:{rpc_id:{arguments:[]}}},{...schema(),rpc:{rpcPing:{arguments:['Node']}}},{...schema(),rpc:{rpcPing:{arguments:[],mode:'disabled'}}},{...schema(),rpc:{rpcPing:{arguments:[],channel:-1}}},{...schema(),rpc:{rpcPing:{arguments:[],channel:256}}},{...schema(),rpc:{rpcPing:{arguments:[],unknown:true}}}];
  for(const input of bad)assert.throws(()=>n.validateNativeInterfaceSchema(input),/E_NATIVE_INTERFACE/);
  let called=false;
  assert.throws(()=>n.validateNativeInterfaceSchema({version:1,nativeLeaf:'Node',get callbacks(){called=true;return[];}}));
  const args=[];Object.defineProperty(args,'0',{enumerable:true,get(){called=true;return 'string';}});args.length=1;
  assert.throws(()=>n.validateNativeInterfaceSchema({version:1,nativeLeaf:'Node',rpc:{rpcPing:{arguments:args}}}));
  assert.equal(called,false);
});

test('only minted exact-leaf construction tokens normalize; profile selection is immutable data',()=>{
  const t=token();assert(Object.isFrozen(t));
  assert.deepEqual(n.normalizeNativeInterfaceProp(t,'Node2D'),{scriptProfile:'player',interfaceId:'player',schemaHash:t.schemaHash});
  assert.deepEqual(n.normalizeNativeInterfaceProps({name:'Player',nativeInterface:t},'Node2D'),{name:'Player',nativeScriptProfile:'player'});
  assert.equal(n.getNativeInterfaceToken({nativeInterface:t}),t);
  assert.throws(()=>n.normalizeNativeInterfaceProp({...t},'Node2D'),/Untrusted/);
  assert.throws(()=>n.normalizeNativeInterfaceProp(t,'Node'),/does not match/);
  assert.throws(()=>n.normalizeNativeInterfaceProps({nativeInterface:t,nativeScriptProfile:'other'},'Node2D'),/Conflicting/);
  assert.throws(()=>n.defineNativeInterface('../escape',schema()));
});

test('DTO codec accepts bounded data and rejects native objects, functions, prototypes and accessors',()=>{
  const copied=n.snapshotNativeDTO({array:[null,true,1,'hello'], nested:{networkId:'player:4'}});
  assert(Object.isFrozen(copied));assert(Object.isFrozen(copied.array));assert.equal(Object.getPrototypeOf(copied),null);
  const cycle={};cycle.self=cycle;
  const getter={get x(){throw Error('getter executed');}};
  const array=[];Object.defineProperty(array,'0',{get(){throw Error('array getter executed');},enumerable:true});array.length=1;
  const bad=[undefined,NaN,Infinity,BigInt(1),()=>{},new Date(),Object.create({}),{nativeKey:{slot:1},read(){}},cycle,getter,array,Array(2),JSON.parse('{"__proto__":{}}'),{constructor:1},'x'.repeat(65537)];
  for(const input of bad)assert.throws(()=>n.snapshotNativeDTO(input),/E_NATIVE_INTERFACE/);
  let deep=null;for(let i=0;i<34;i++)deep=[deep];assert.throws(()=>n.snapshotNativeDTO(deep),/nesting/);
  assert.deepEqual(n.encodeNativeRpcArguments(token(),'rpcPing',['hi',{x:1},'player:3']),['hi','{"x":1}','player:3']);
  assert.throws(()=>n.encodeNativeRpcArguments(token(),'rpcPing',['hi',{},'with spaces']));
  assert.throws(()=>n.encodeNativeRpcArguments(token(),'rpcAuthority',[Number.MAX_SAFE_INTEGER+1]));
  assert.throws(()=>n.encodeNativeRpcArguments(token(),'queue_free',[]));
});

test('ready waits for layout registration, executes once, and queued events use newest committed handlers',()=>{
  const h=harness(),seen=[];
  assert.equal(h.dispatch('_ready'),true);h.drain();assert.deepEqual(seen,[]);
  const first=h.registry.commit(h.handle,h.t,{_ready:()=>seen.push('ready'),rpcPing:()=>seen.push('old')});
  assert.equal(h.dispatch('rpcPing',['hello','{"x":1}','player:1']),true);
  first();const second=h.registry.commit(h.handle,h.t,{_ready:()=>seen.push('ready again'),rpcPing:(...args)=>seen.push(args)});
  h.drain();assert.equal(seen.length,2);assert.equal(seen[0],'ready again');assert.equal(seen[1][1].x,1);
  assert(Object.isFrozen(seen[1][1]));
  second();h.registry.commit(h.handle,h.t,{_ready:()=>seen.push('duplicate')});h.dispatch('_ready');h.drain();assert.equal(seen.length,2);
  h.registry.dispose();
});

test('unmount, native invalidation, revision reuse and RootLifetime disposal cancel queued work',()=>{
  for(const invalidate of ['unmount','native','unbind','dispose']){
    const h=harness();let calls=0;
    const cleanup=h.registry.commit(h.handle,h.t,{_process:()=>calls++});h.dispatch('_process',[0.1]);
    if(invalidate==='unmount')cleanup();else if(invalidate==='native')h.kill();else if(invalidate==='unbind')h.registry.unbind(h.key);else h.registry.dispose();
    h.drain();assert.equal(calls,0,invalidate);h.registry.dispose();assert.equal(h.dispatch('_process',[0.1]),false);
  }
  const h=harness();h.registry.unbind(h.key);
  const key={slot:1,revision:8},handle={nativeKey:key};h.registry.bind('2',key,h.t,handle);
  assert.throws(()=>h.registry.commit(h.handle,h.t,{}),/live root/);
  h.registry.dispose();
});

test('registry rejects cross-root handles, duplicate registrations, wrong profiles and malicious wire data',()=>{
  const h=harness();
  assert.throws(()=>h.registry.commit({nativeKey:h.key},h.t,{}),/live root/);
  assert.throws(()=>h.registry.commit(h.handle,n.defineNativeInterface('other',schema()),{}),/schema/);
  assert.throws(()=>h.registry.commit(h.handle,h.t,{queue_free(){}}),/Undeclared/);
  const cleanup=h.registry.commit(h.handle,h.t,{rpcPing(){}});
  assert.throws(()=>h.registry.commit(h.handle,h.t,{}),/Only one/);
  assert.equal(h.dispatch('rpcPing',['x','{"constructor":1}','p:1']),false);
  assert.equal(h.dispatch('rpcPing',['x','{"x":1}',{rawNode:true}]),false);
  assert.equal(h.dispatch('_process',[-1]),false);
  assert.equal(n.dispatchNativeInterface('18446744073709551615','wrong',h.t.schemaHash,'rpcPing',[]),false);
  assert.equal(n.dispatchNativeInterface(18446744073709551615,h.t.profile,h.t.schemaHash,'_ready',[]),false);
  assert.equal(h.errors.length,3);cleanup();h.registry.dispose();
});

test('RPC send reports local Error only, encodes DTOs, validates peers and expires with root',()=>{
  const h=harness();
  assert.deepEqual(h.registry.send(h.handle,h.t,'rpcPing',['hi',{count:2},'player:9'],3),{localError:0});
  assert.deepEqual(h.sent[0],[h.key,'rpcPing',['hi','{"count":2}','player:9'],3]);
  assert.throws(()=>h.registry.send(h.handle,h.t,'rpcPing',['hi',{},'player:9'],0),/peer ID/);
  h.registry.dispose();assert.throws(()=>h.registry.send(h.handle,h.t,'rpcPing',['hi',{},'player:9']),/no longer live/);
});

test('RPC sender identity is captured before native dispatch ends and reaches handlers as immutable DTO',()=>{
  const h=harness();let received;
  h.registry.commit(h.handle,h.t,{rpcPing:(...args)=>{received=args[3];}});
  const context={senderPeerId:9};
  assert.equal(n.dispatchNativeInterface('18446744073709551615',h.t.profile,h.t.schemaHash,'rpcPing',['x','{}','player:9'],context),true);
  context.senderPeerId=0;h.drain();assert.equal(received.senderPeerId,9);assert(Object.isFrozen(received));
  assert.equal(n.dispatchNativeInterface('18446744073709551615',h.t.profile,h.t.schemaHash,'rpcPing',['x','{}','player:9'],{senderPeerId:-1}),false);
  h.registry.dispose();
});

test('committed refs wait for a later host, skip detached refs and rebind after a new native lifetime',()=>{
  const h=harness(),ref={current:null},seen=[];
  const cleanup=h.registry.commitRef(ref,h.t,{_ready:()=>seen.push('ready'),_process:()=>seen.push('process')});
  h.drain();assert.deepEqual(seen,[]);
  const key={slot:2,revision:1},handle={nativeKey:key};h.registry.bind('2',key,h.t,handle);ref.current=handle;
  n.dispatchNativeInterface('2',h.t.profile,h.t.schemaHash,'_ready',[]);h.drain();assert.deepEqual(seen,['ready']);
  ref.current=null;n.dispatchNativeInterface('2',h.t.profile,h.t.schemaHash,'_process',[0.1]);h.drain();assert.deepEqual(seen,['ready']);
  ref.current=handle;n.dispatchNativeInterface('2',h.t.profile,h.t.schemaHash,'_process',[0.1]);h.drain();assert.deepEqual(seen,['ready','process']);
  h.registry.unbind(key);const nextKey={slot:2,revision:2},nextHandle={nativeKey:nextKey};h.registry.bind('3',nextKey,h.t,nextHandle);ref.current=nextHandle;
  n.dispatchNativeInterface('3',h.t.profile,h.t.schemaHash,'_ready',[]);h.drain();assert.deepEqual(seen,['ready','process','ready']);
  cleanup();n.dispatchNativeInterface('3',h.t.profile,h.t.schemaHash,'_process',[0.1]);h.drain();assert.equal(seen.length,3);h.registry.dispose();
});

test('a real Suspense child can materialize after its parent native-interface Hook committed',async()=>{
  const React=require('react'),sdk=require('../dist/index.js'),{MockNativePort}=require('../dist/testing.js');
  const port=new MockNativePort(),container=port.createContainer(),t=token();let resolve;const waiting=new Promise(done=>{resolve=done;});
  const ref=React.createRef(),seen=[];
  const root=sdk.createRoot(port,container,{generation:'suspense-native',nativeScriptProfiles:{player:{type:'Node2D',script:'res://generated/react/native/player.ts',schemaHash:t.schemaHash}}});
  function Child(){React.use(waiting);return React.createElement(sdk.Node2D,{ref,name:'LateEndpoint',nativeInterface:t});}
  function App(){sdk.useNativeInterface(ref,t,{_process:delta=>seen.push(delta)});return React.createElement(React.Suspense,{fallback:null},React.createElement(Child));}
  try{
    root.render(React.createElement(App));assert.equal(ref.current,null);assert.equal(root.state,'running');resolve();
    for(let turn=0;turn<40&&!ref.current;turn++){await new Promise(done=>setTimeout(done,10));root.pump();}
    assert(ref.current,'Suspense host did not reveal');
    const identity=port.nativeIdentity(ref.current.nativeKey);assert.equal(n.dispatchNativeInterface(identity,t.profile,t.schemaHash,'_process',[0.25]),true);root.pump();
    assert.deepEqual(seen,[0.25]);assert.deepEqual(root.getErrors(),[]);
  }finally{root.shutdown();}
});

test('thenable frame and input callbacks revoke the endpoint lease before more work can run',()=>{
  for(const method of ['_process','_input']){
    const h=harness();let calls=0;
    h.registry.commit(h.handle,h.t,{[method]:()=>{calls++;return Promise.resolve();}});
    const args=method==='_process'?[0.1]:[{type:'InputEventKey',text:'Space',pressed:true,echo:false}];
    h.dispatch(method,args);h.dispatch(method,args);h.drain();
    assert.equal(calls,1);assert.match(String(h.errors[0]),/endpoint lease revoked/);
    assert.equal(h.dispatch(method,args),false);
    assert.throws(()=>h.registry.send(h.handle,h.t,'rpcPing',['x',{},'player:1']),/no longer live/);
    h.registry.dispose();
  }
});

test('public Hook types reject async and Promise-or-void handlers while accepting typed DTO callbacks',()=>{
  const filename=path.join(__dirname,'native-interfaces-typecheck.ts');
  const source=`import {Button,useProcess,usePhysicsProcess,useInput,useNativeInterface,defineNativeInterface,type NodeRef} from '../dist/index';
declare const ref:NodeRef<'Node2D'>;
const token=defineNativeInterface('typecheck',{version:1,nativeLeaf:'Node2D',callbacks:['_process','_input'],rpc:{rpcPing:{arguments:['integer']}}});
useNativeInterface(ref,token,{_process:(delta:number)=>{delta.toFixed();},rpcPing:(count:number)=>{count.toFixed();}});
// @ts-expect-error Async callbacks cannot retain an endpoint lease.
useNativeInterface(ref,token,{_input:async()=>{}});
declare const conditional:()=>Promise<void>|void;
// @ts-expect-error A union containing a thenable is also asynchronous.
useNativeInterface(ref,token,{_process:conditional});
useProcess(ref,{},()=>{});usePhysicsProcess(ref,{},()=>{});useInput(ref,()=>{});
// @ts-expect-error Process callbacks are synchronous.
useProcess(ref,{},async()=>{});
// @ts-expect-error Physics callbacks are synchronous.
usePhysicsProcess(ref,{},async()=>{});
// @ts-expect-error Input callbacks are synchronous.
useInput(ref,async()=>{});
// @ts-expect-error A Promise union is asynchronous in process callbacks.
useProcess(ref,{},conditional);
// @ts-expect-error A Promise union is asynchronous in input callbacks.
useInput(ref,conditional);
Button({initial:{text:'ok',disabled:false}});
// @ts-expect-error Initial data uses the same host property codec.
Button({initial:{text:42}});
// @ts-expect-error Unknown native properties never enter initial data.
Button({initial:{nonsense:42}});
// @ts-expect-error Event handlers are not initial data.
Button({initial:{onPressed:()=>{}}});
// @ts-expect-error Construction identity is declared on the host.
Button({initial:{name:'wrong'}});
`;
  const options={noEmit:true,strict:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.Node16,moduleResolution:ts.ModuleResolutionKind.Node16};
  const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host);
  host.readFile=file=>file===filename?source:read(file);host.fileExists=file=>file===filename||exists(file);
  const program=ts.createProgram([filename],options,host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic=>ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n')),[]);
});
