const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const SDK=require('../dist');
const Engine=require('../dist/engine');
const Legacy=require('../dist/legacy');
const {MockNativePort}=require('../dist/testing');
const fixture=require('./engine-native-fixture.cjs');

test('package default two-argument createRoot selects direct native rendering',()=>{
  const f=fixture(),root=SDK.createRoot(f.container,{godot:f.godot,autoProcess:false});
  try{
    assert.ok(root instanceof Engine.EngineRoot);assert.equal(SDK.EngineNode,Engine.EngineNode);assert.equal(SDK.useFrame,Engine.useFrame);
    const ref=React.createRef();root.render(React.createElement(SDK.EngineNode,{ctor:f.Label,ref,native:{text:'native default'}}));
    assert.ok(ref.current instanceof f.Label);assert.equal(ref.current.get('text'),'native default');assert.equal(root.getStats().created,1);assert.deepEqual(root.getErrors(),[]);
  }finally{root.shutdown();f.flushDeletes();}
  assert.equal(f.container.alive,true);
});

test('package default explicit three-argument createRoot preserves NativePort compatibility',()=>{
  const port=new MockNativePort(),container=port.createContainer();
  const root=SDK.createRoot(port,container,{generation:'legacy-dispatch',mode:'production'});
  try{
    assert.ok(root instanceof Legacy.ReactRoot);assert.equal(SDK.Label,Legacy.Label);
    root.render(React.createElement(SDK.Label,{text:'legacy compatible'}));
    const key=port.children(container)[0];assert.equal(port.read(key,'text'),'legacy compatible');assert.deepEqual(root.getErrors(),[]);
  }finally{root.shutdown();}
  assert.equal(port.liveCount(),1);
});

test('explicit legacy entry continues exposing its unchanged NativePort createRoot',()=>{
  const port=new MockNativePort(),container=port.createContainer();
  const root=Legacy.createRoot(port,container,{generation:'explicit-legacy',mode:'production'});
  try{assert.ok(root instanceof Legacy.ReactRoot);assert.equal(root instanceof Engine.EngineRoot,false);root.render(React.createElement(Legacy.Node));}
  finally{root.shutdown();}
  assert.equal(port.liveCount(),1);
});
