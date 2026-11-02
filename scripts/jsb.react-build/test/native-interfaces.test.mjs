import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { generateNativeInterface } from '../dist/native-interfaces.js';
const require = createRequire(import.meta.url);
const native = require('@godot-js/react/native-interfaces');

const schema={version:1,nativeLeaf:'Node2D',callbacks:['_ready','_process','_physics_process','_input','_unhandled_input'],rpc:{rpcPing:{arguments:['string','dto','networkId'],mode:'anyPeer',sync:'local',transferMode:'unreliableOrdered',channel:2},rpcAuthority:{arguments:['integer','boolean','number']}}};
function compile(source, fileName='Fixture.ts') {
  const result=ts.transpileModule(source,{fileName,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:false},reportDiagnostics:true});
  assert.deepEqual(result.diagnostics,[]);return result.outputText;
}
function evaluate(code, imports) {
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:id=>{assert(Object.hasOwn(imports,id),`unexpected import ${id}`);return imports[id];},Object,Symbol,Reflect,console});return module.exports;
}

test('generated Script.ts has stable exact-leaf identity and distinct profile paths',()=>{
  const a=generateNativeInterface(schema,{profile:'player'}),b=generateNativeInterface(schema,{profile:'enemy'});
  assert.equal(a.nativeLeaf,'Node2D');assert.equal(a.schemaHash,native.nativeInterfaceSchemaHash(schema));
  assert.equal(a.relativeSource,`generated/react/native/player-${a.schemaHash}.ts`);
  assert.notEqual(a.relativeSource,b.relativeSource);assert.equal(a.schemaHash,b.schemaHash);
  const oldGeneration=generateNativeInterface(schema,{profile:'player',generation:'gen-old'}),newGeneration=generateNativeInterface(schema,{profile:'player',generation:'gen-new'});
  assert.equal(newGeneration.relativeSource,`generated/react/native/gen-new/player-${a.schemaHash}.ts`);
  assert.notEqual(oldGeneration.relativeSource,newGeneration.relativeSource);assert.equal(oldGeneration.schemaHash,newGeneration.schemaHash);
  assert.match(a.source,/export default class ReactNative_player_\w+ extends Node2D/);
  assert.match(a.source,/invokeNative\(this, "get_meta", "__godot_react_identity"\)/);
  assert.doesNotMatch(a.source,/set_script|add_child|get_instance_id|new Node/);
  assert.equal(compile(a.source).includes('__esDecorate'),true);
  assert.equal(generateNativeInterface({...schema,callbacks:[...schema.callbacks].reverse()},{profile:'player'}).source,a.source);
});

test('generated modern decorators register real createClassBinder RPC metadata and all stubs forward DTOs',()=>{
  const captured=[],dispatched=[],prototypes=[];
  class Node {get_meta(){return '18446744073709551615';}get_multiplayer(){return {get_remote_sender_id:()=>7};}}
  class Node2D extends Node {}
  const annotationsSource=readFileSync(new URL('../../jsb.runtime/src/godot.annotations.ts',import.meta.url),'utf8');
  const annotations=evaluate(compile(annotationsSource,'godot.annotations.ts'),{'godot.lib.api':{
    jsb:{internal:{names:{get_member:value=>value,get_enum_value:value=>value},add_script_rpc:(prototype,method,config)=>{captured.push({method,config});prototypes.push(prototype);}}},
    proxy:{object_proxy:value=>value,key_only_proxy:value=>value},Node,Resource:class{},Variant:{Type:{TYPE_OBJECT:24}},PropertyHint:{},PropertyUsageFlags:{},ProxyTarget:Symbol(),FloatType:Symbol(),IntegerType:Symbol(),
  }});
  const generated=generateNativeInterface(schema,{profile:'player'});
  const result=evaluate(compile(generated.source),{
    godot:{Node2D,InputEvent:class{},MultiplayerAPI:{RPCMode:{RPC_MODE_AUTHORITY:2,RPC_MODE_ANY_PEER:1}},MultiplayerPeer:{TransferMode:{TRANSFER_MODE_RELIABLE:2,TRANSFER_MODE_UNRELIABLE:0,TRANSFER_MODE_UNRELIABLE_ORDERED:1}}},
    'godot.annotations':annotations,
    '@godot-js/react/native-interfaces':{dispatchNativeInterface:(...args)=>dispatched.push(args)},
  });
  assert.deepEqual(captured.map(item=>item.method).sort(),['rpcAuthority','rpcPing']);
  const ping=captured.find(item=>item.method==='rpcPing').config;
  assert.equal(ping.rpc_mode,1);assert.equal(ping.call_local,true);assert.equal(ping.transfer_mode,1);assert.equal(ping.channel,2);
  const authority=captured.find(item=>item.method==='rpcAuthority').config;
  assert.equal(authority.rpc_mode,2);assert.equal(authority.call_local,false);assert.equal(authority.transfer_mode,2);assert.equal(authority.channel,0);
  const instance=new result.default();assert(instance instanceof Node2D);assert(prototypes.every(proto=>proto===result.default.prototype));
  instance._ready();instance._process(0.1);instance._physics_process(0.2);
  const event={get_class:()=> 'InputEventKey',as_text:()=> 'Space',is_pressed:()=>true,is_echo:()=>false};
  instance._input(event);instance._unhandled_input(event);instance.rpcPing('hello','{"x":1}','player:1');
  assert.deepEqual(dispatched.map(item=>item[3]),['_ready','_process','_physics_process','_input','_unhandled_input','rpcPing']);
  assert(dispatched.every(item=>item[0]==='18446744073709551615'&&item[1]==='player'&&item[2]===generated.schemaHash));
  const dto=dispatched[3][4][0];assert.equal(dto.type,'InputEventKey');assert.equal(dto.text,'Space');assert(Object.isFrozen(dto));assert.notEqual(dto,event);
  assert.equal(dispatched[5][5].senderPeerId,7);assert(Object.isFrozen(dispatched[5][5]));
  Node.prototype.get_meta=undefined;Node.prototype.getMeta=()=> '18446744073709551615';
  Node.prototype.get_multiplayer=undefined;Node.prototype.getMultiplayer=()=>({getRemoteSenderId:()=>9});
  instance._input({getClass:()=> 'InputEventKey',asText:()=> 'Enter',isPressed:()=>true,isEcho:()=>false});
  instance.rpcPing('camel','{}','player:2');
  assert.equal(dispatched[6][4][0].text,'Enter');assert.equal(dispatched[7][5].senderPeerId,9);
  Node.prototype.getMultiplayer=undefined;Node.prototype.multiplayer={get_remote_sender_id:()=>11};
  instance.rpcPing('property','{}','player:3');assert.equal(dispatched[8][5].senderPeerId,11);
  instance._input({getClass:()=> 'InputEventAction',asText:()=> 'ui_accept',pressed:false,echo:false});
  assert.equal(dispatched[9][4][0].pressed,false);assert.equal(dispatched[9][4][0].echo,false);
});

test('generator rejects invalid static schemas, traversals and noncanonical runtime singletons',()=>{
  assert.throws(()=>generateNativeInterface({...schema,rpc:{rpcPing:{arguments:['Node']}}},{profile:'player'}));
  for(const profile of ['../escape','Player','a/b',''])assert.throws(()=>generateNativeInterface(schema,{profile}));
  for(const generatedDir of ['../src','/tmp/generated','res://generated/react','src','a//b'])assert.throws(()=>generateNativeInterface(schema,{profile:'player',generatedDir}));
  assert.throws(()=>generateNativeInterface(schema,{profile:'player',runtimeModule:'./other-runtime'}),/canonical singleton/);
  assert.throws(()=>generateNativeInterface(schema,{profile:'player',generation:'../escape'}),/generation identity/);
});
