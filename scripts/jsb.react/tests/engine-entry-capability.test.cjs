const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const React=require('react');
const {createRoot,EngineNode,useRuntimeHost}=require('../dist/engine');
const fixture=require('./engine-native-fixture.cjs');
const quiet={onError(){}};
function runtime(role='engine'){
 const source=fs.readFileSync(require.resolve('../../../packages/engine/src/runtime-host.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};new Function('exports','module',code)(mod.exports,mod);
 const binding=mod.exports.createRuntimeBinding({sessionId:'explicit-entry',role});binding.beginNativeEpoch('native');return binding;
}

test('explicit entry root never reads a global binding and waits for actual native deletion',async()=>{
 const f=fixture(),binding=runtime(),entry=binding.openEntry();let seen;
 Object.defineProperty(globalThis,'__godotjsRuntimeHost',{configurable:true,get(){throw Error('implicit global binding lookup');}});
 try{
  const root=f.setup({entry:entry.capability,...quiet});
  function App(){seen=useRuntimeHost();return React.createElement(EngineNode,{ctor:f.Label});}
  root.render(React.createElement(App));entry.finishStartup();assert.equal(seen,entry.host);assert.equal(root.runtimeManagedCleanup,true);
  binding.beginClose();await binding.drainClose();
  assert.equal(binding.closeProgress().status,'pending');assert.equal(root.getStats().pendingReleases,1);
  await f.flushDeletes();await binding.drainClose();
  assert.equal((await root.close()).status,'complete');assert.equal(binding.closeProgress().status,'complete');
 }finally{delete globalThis.__godotjsRuntimeHost;}
});

test('explicit capability rejects copied handles and cross-entry host before native inspection',()=>{
 const f=fixture(),binding=runtime(),entry=binding.openEntry(),other=binding.openEntry();let reads=0;
 const check=f.godot.is_instance_valid;f.godot.is_instance_valid=value=>{reads++;return check(value);};
 assert.throws(()=>createRoot(f.container,{godot:f.godot,entry:{...entry.capability},autoProcess:false}),/E_RUNTIME_ENTRY/);
 assert.throws(()=>createRoot(f.container,{godot:f.godot,entry:entry.capability,runtimeHost:other.host,autoProcess:false}),/E_RUNTIME_ENTRY/);
 entry.close();assert.throws(()=>createRoot(f.container,{godot:f.godot,entry:entry.capability,autoProcess:false}),/E_RUNTIME_CLOSING/);
 assert.equal(reads,0);
});

test('script worker lifetime capabilities cannot create native roots',()=>{
 const f=fixture(),binding=runtime('script-worker'),entry=binding.openEntry();let reads=0;
 const check=f.godot.is_instance_valid;f.godot.is_instance_valid=value=>{reads++;return check(value);};
 assert.throws(()=>createRoot(f.container,{godot:f.godot,entry:entry.capability,autoProcess:false}),/E_ENGINE_ROLE/);
 assert.throws(()=>createRoot(f.container,{godot:f.godot,runtimeHost:entry.host,autoProcess:false}),/E_ENGINE_ROLE/);
 assert.equal(reads,0);entry.finishStartup();entry.close();
});

test('failed automatic driver setup releases mount and entry reservations synchronously',async()=>{
 const f=fixture(),binding=runtime(),entry=binding.openEntry(),mount=new f.Node();
 assert.throws(()=>createRoot(mount,{godot:f.godot,entry:entry.capability}),/E_ENGINE_AUTOPROCESS/);
 assert.equal(binding.closeProgress().pendingCleanups,0);
 const root=f.drive(createRoot(mount,{godot:f.godot,entry:entry.capability,autoProcess:false,...quiet}));
 root.render(React.createElement(EngineNode,{ctor:f.Label}));entry.finishStartup();
 binding.beginClose();await f.flushDeletes();await binding.drainClose();assert.equal((await root.close()).status,'complete');
});

test('idle retirement and release maintenance visits no live records at 1000 nodes',async()=>{
 const f=fixture(),root=f.setup(quiet),view=()=>React.createElement(React.Fragment,null,...Array.from({length:1000},(_,key)=>React.createElement(EngineNode,{key,ctor:f.Label})));
 root.render(view());await Promise.resolve();const before=root.getStats();
 root.processFrame(.016,{epoch:'native',counter:1});const after=root.getStats();
 assert(after.auditRecordsVisited>before.auditRecordsVisited,'Full external structure audit remains until native observation is verified');
 for(const key of ['retirementRecordsVisited','releaseRecordsVisited','publicationRecordsVisited','portalRecordsVisited'])assert.equal(after[key],before[key],key);
 assert.equal(after.liveRecords,1000);root.requestShutdown();await f.flushDeletes();assert.equal((await root.close()).status,'complete');
 assert.equal(root.getStats().liveRecords,0);
});

test('error reporting never executes project stack/message getters or toString, including after seal',()=>{
 const f=fixture(),root=f.setup({onError(){}});let reads=0;
 const value={get stack(){reads++;return 'project stack';},get message(){reads++;return 'project message';},toString(){reads++;return 'project string';}};
 root.recordError(value);root.sealClose();root.recordError(value);assert.equal(reads,0);
 const g=fixture(),fallback=g.setup();const original=console.error,reported=[];console.error=value=>reported.push(value);
 try{fallback.recordError(value);fallback.sealClose();fallback.recordError(value);}finally{console.error=original;}
 assert.equal(reads,0);assert(reported.every(item=>typeof item==='string'));
});
