const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot,useRuntimeHost}=require('../dist/engine');
const fixture=require('./engine-native-fixture.cjs');

test('runtime services belong to their injected root, with no process global fallback',async()=>{
  const f=fixture(),seen=[];
  const a={apiVersion:1,sessionId:'entry-a',role:'engine'},b={apiVersion:1,sessionId:'entry-b',role:'engine'};
  globalThis.__godotjsRuntimeHost={sessionId:'wrong-global'};
  function App({id}){seen.push([id,useRuntimeHost()]);return null;}
  const rootA=f.setup({runtimeHost:a}),mountB=new f.Node(),rootB=f.drive(createRoot(mountB,{godot:f.godot,autoProcess:false,runtimeHost:b}));
  const mountNative=new f.Node(),native=f.drive(createRoot(mountNative,{godot:f.godot,autoProcess:false}));
  try{
    rootA.render(React.createElement(App,{id:'a'}));rootB.render(React.createElement(App,{id:'b'}));native.render(React.createElement(App,{id:'native'}));
    assert.deepEqual(seen,[['a',a],['b',b],['native',undefined]]);
    assert.deepEqual(rootA.getErrors(),[]);assert.deepEqual(rootB.getErrors(),[]);assert.deepEqual(native.getErrors(),[]);
  }finally{delete globalThis.__godotjsRuntimeHost;rootA.shutdown();rootB.shutdown();native.shutdown();await f.flushDeletes();}
});
