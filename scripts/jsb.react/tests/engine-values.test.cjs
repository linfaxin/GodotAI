const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {EngineNode}=require('../dist/engine');
const {captureValue,sameValue}=require('../dist/engine-native');
const fixture=require('./engine-native-fixture.cjs');

test('every packed Variant snapshots mutations independently and distinguishes its type',()=>{
 const f=fixture(),G={...f.godot},names=['PackedByteArray','PackedInt32Array','PackedInt64Array','PackedFloat32Array','PackedFloat64Array','PackedStringArray','PackedVector2Array','PackedVector3Array','PackedColorArray','PackedVector4Array'];
 for(const name of names)G[name]=class{constructor(items=[]){this.items=items.slice();}duplicate(){return new this.constructor(this.items);}size(){return this.items.length;}get_indexed(i){return this.items[i];}set_indexed(i,v){this.items[i]=v;}};
 for(const name of names){
  const value=new G[name]([1]),before=captureValue(G,value);value.set_indexed(0,9);
  assert.equal(before.value.get_indexed(0),1,name);assert(!sameValue(before,captureValue(G,value)),name);
  assert(sameValue(captureValue(G,new G[name]([9])),captureValue(G,value)),name);
 }
 assert(!sameValue(captureValue(G,new G.PackedInt32Array([1])),captureValue(G,new G.PackedFloat32Array([1]))));
 const resource=new f.Material();assert.equal(captureValue(G,resource).value,resource);
});

test('controlled packed properties update on mutation and restore an independent baseline',()=>{
 const f=fixture();
 class PackedVector2Array{constructor(items=[]){this.items=items.map(v=>new f.Vector2(v));}duplicate(){return new PackedVector2Array(this.items);}size(){return this.items.length;}get_indexed(i){return new f.Vector2(this.items[i]);}set_indexed(i,v){this.items[i]=new f.Vector2(v);}}
 f.godot.PackedVector2Array=PackedVector2Array;
 class Line extends f.Node{
  constructor(){super();this.properties.points=new PackedVector2Array([new f.Vector2(3,4)]);}
  get(name){return name==='points'?this.properties.points.duplicate():super.get(name);}
  set(name,value){return super.set(name,name==='points'?value.duplicate():value);}
 }
 const root=f.setup(),ref=React.createRef(),points=new PackedVector2Array([new f.Vector2(1,2)]);
 const draw=native=>root.render(React.createElement(EngineNode,{ctor:Line,ref,native}));
 draw({points});points.set_indexed(0,new f.Vector2(9,2));draw({points});assert.equal(ref.current.get('points').get_indexed(0).x,9);
 draw({});assert.equal(ref.current.get('points').get_indexed(0).x,3);
 root.shutdown();f.flushDeletes();
});
