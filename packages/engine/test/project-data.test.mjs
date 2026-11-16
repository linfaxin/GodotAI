import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeBinding} from '../dist/runtime-host.js';
import {isProjectData} from '../dist/browser/protocol.js';

// Readers and both factory directions must agree before any transport reserves
// credits. Keep this matrix independent of either implementation's helpers.
function agrees(value,expected,label){
 let owned,serialized;
 const runtime=createRuntimeBinding({sessionId:'data-conformance',role:'engine',onProject(data,json){owned=data;serialized=json;return true;}});
 assert.equal(isProjectData(value),expected,label+' reader');
 assert.equal(runtime.emitProjectEvent(value),expected,label+' event producer');
 assert.equal(runtime.receiveProjectCommand(value),expected,label+' command consumer');
 if(expected){
  assert.equal(isProjectData(owned),true,label+' owned wire data');
  assert(new TextEncoder().encode(serialized).byteLength<=262144,label+' UTF-8 budget');
 }
 runtime.settle();
}

test('ordinary dense arrays and the node boundary use the same producer and reader budgets',()=>{
 const snapshot={type:'snapshot',ids:Array(25000).fill(0)};
 assert.equal(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,50027);
 agrees(snapshot,true,'25k IDs');
 agrees({ids:Array(32766).fill(0)},true,'32768 nodes');
 agrees({ids:Array(32767).fill(0)},false,'32769 nodes');
 agrees({ids:Array(32769).fill(0)},false,'array length');
});

test('actual JSON UTF-8 bytes include escaping, non-ASCII characters and the 256 KiB boundary',()=>{
 const overhead=new TextEncoder().encode(JSON.stringify({data:['']})).byteLength,room=262144-overhead;
 for(const [label,unit]of [['ASCII','a'],['CJK','汉'],['emoji','🙂'],['escaped newline','\n'],['lone surrogate','\ud800']]){
  const unitBytes=new TextEncoder().encode(JSON.stringify(unit)).byteLength-2;
  const text=unit.repeat(Math.floor(room/unitBytes))+'a'.repeat(room%unitBytes);
  const exact={data:[text]},oversized={data:[text+'a']};
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).byteLength,262144,label);
  agrees(exact,true,label+' exact limit');agrees(oversized,false,label+' over limit');
 }
});

test('depth and plain JSON values agree without accepting sparse or decorated arrays',()=>{
 const chain=depth=>{let value=0;for(let index=0;index<depth;index++)value={next:value};return value;};
 agrees(chain(16),true,'depth 16');agrees(chain(17),false,'depth 17');
 const plain=Object.create(null);plain.values=[null,true,false,0,-0,1.25,'text',{},[]];
 agrees(plain,true,'null prototype');
 const sparse=[];sparse.length=1;agrees({items:sparse},false,'sparse array');
 const decorated=[1];decorated.extra=2;agrees({items:decorated},false,'array property');
 const hidden={};Object.defineProperty(hidden,'x',{value:1});agrees(hidden,false,'hidden property');
 const symbol={x:1};symbol[Symbol('extra')]=2;agrees(symbol,false,'symbol property');
 const circular={};circular.self=circular;agrees(circular,false,'cycle');
 for(const value of [null,[],1,'text',new Date(),{x:undefined},{x:NaN},{x:Infinity},{x:1n},{x:Symbol('value')},{x(){}}])agrees(value,false,'non-JSON data');
});

test('validation never invokes project accessors or serializers',()=>{
 let reads=0;
 const object={};Object.defineProperty(object,'x',{enumerable:true,get(){reads++;return 1;}});
 const array=[];Object.defineProperty(array,'0',{enumerable:true,get(){reads++;return 1;}});
 const serializer={toJSON(){reads++;return {x:1};}};
 agrees(object,false,'object getter');agrees({items:array},false,'array getter');agrees(serializer,false,'custom serializer');
 Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){reads++;throw Error('inherited serializer');}});
 try{agrees({items:[{x:1}]},true,'inherited serializer');}finally{delete Object.prototype.toJSON;}
 assert.equal(reads,0);
});
