const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const fixture=require('./engine-native-fixture.cjs');
const {EngineNode}=require('../dist/engine');
const sdk=require('../dist/engine-native-interfaces');
const h=React.createElement;
const token=()=>sdk.defineNativeInterface('endpoint',{version:1,nativeLeaf:'Node',callbacks:['_ready','_physics_process','_input'],rpc:{rpcPing:{arguments:['dto'],mode:'anyPeer'}}});
function setup(){
 const f=fixture();f.setAutoPump(false);const root=f.setup({onError(){}}),t=token();sdk.engineNativeInterfaces(root,'native-world-fixture');
 class Endpoint extends f.Node {
  set_meta(key,value){(this.metadata??={})[key]=value;}
  get_meta(key){return this.metadata?.[key];}
  enterTree(){this.callback('_ready',[]);super.enterTree();}
  callback(name,args,context){return sdk.dispatchNativeInterface(this.get_meta('__godot_react_identity'),t.profile,t.schemaHash,name,args,context);}
  rpc(...args){this.sent=args;return 0;}
  rpc_id(...args){this.sent=args;return 0;}
 }
 return {...f,root,t,Endpoint};
}
test('pure NativeInterface contracts and engine entry do not load the legacy renderer/schema',()=>{
 const script=`require(${JSON.stringify(path.resolve(__dirname,'../dist/native-interface-contracts'))});require(${JSON.stringify(path.resolve(__dirname,'../dist/engine-native-interfaces'))});if(Object.keys(require.cache).some(file=>/[\\/]dist[\\/](runtime|schema[\\/]index)\\.js$/.test(file)))throw Error('Legacy dependency leaked');`;
 execFileSync(process.execPath,['-e',script],{stdio:'pipe'});
});
test('engine endpoints bind before native ready, wait for layout handlers and preserve RPC sender',async()=>{
 const f=setup(),ref=React.createRef(),seen=[];let send;
 function App(){send=sdk.useEngineNativeInterface(ref,f.t,{_ready:()=>seen.push('ready'),_physics_process:delta=>seen.push(delta),rpcPing:(dto,context)=>seen.push([dto.value,context.senderPeerId])});return h(EngineNode,{ctor:f.Endpoint,nativeInterface:f.t,ref});}
 f.root.render(h(App));f.root.pump();assert.deepEqual(seen,['ready']);
 const identity=ref.current.get_meta('__godot_react_identity');assert.match(identity,/^ni1:native-world-fixture:/);
 f.setPhysics(true);assert.equal(ref.current.callback('_physics_process',[.02]),true);f.setPhysics(false);f.root.pump();assert.deepEqual(seen,['ready',.02]);
 assert.equal(ref.current.callback('rpcPing',['{"value":4}'],{senderPeerId:7}),true);f.root.pump();assert.deepEqual(seen,['ready',.02,[4,7]]);
 assert.deepEqual(send.send('rpcPing',[{value:9}],{peerId:3}),{localError:0});assert.deepEqual(ref.current.sent,[3,'rpcPing','{"value":9}']);
 f.root.requestShutdown();assert.equal(sdk.dispatchNativeInterface(identity,f.t.profile,f.t.schemaHash,'_ready',[]),false);
 await f.flushDeletes();assert.equal((await f.root.close()).status,'complete');
});
test('engine endpoint retirement, replacement and async handlers revoke stale identities',async()=>{
 const f=setup(),ref=React.createRef(),seen=[];
 function App({id,async=false}){sdk.useEngineNativeInterface(ref,f.t,{_input:async?()=>Promise.resolve():()=>seen.push(id)});return h(EngineNode,{key:id,ctor:f.Endpoint,nativeInterface:f.t,ref});}
 f.root.render(h(App,{id:'a'}));f.root.pump();const old=ref.current.get_meta('__godot_react_identity');
 f.root.render(h(App,{id:'b'}));f.root.pump();assert.equal(sdk.dispatchNativeInterface(old,f.t.profile,f.t.schemaHash,'_input',[{}]),false);
 const node=ref.current;assert.equal(node.callback('_input',[{}]),true);f.root.requestShutdown();f.root.pump();assert.deepEqual(seen,[]);await f.flushDeletes();
 const next=setup(),nextRef=React.createRef();
 function AsyncApp(){sdk.useEngineNativeInterface(nextRef,next.t,{_input:()=>Promise.resolve()});return h(EngineNode,{ctor:next.Endpoint,nativeInterface:next.t,ref:nextRef});}
 next.root.render(h(AsyncApp));next.root.pump();assert.equal(nextRef.current.callback('_input',[{}]),true);next.root.pump();assert.equal(nextRef.current.callback('_input',[{}]),false);assert.match(String(next.root.getErrors()[0]),/synchronous/);next.root.requestShutdown();await next.flushDeletes();
});
