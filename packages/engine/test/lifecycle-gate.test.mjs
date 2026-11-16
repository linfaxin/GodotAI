import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntimeBinding} from '../dist/runtime-host.js';
import {installNativeLifecycleGate} from '../dist/browser/lifecycle-gate.js';

const flush=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};

test('native gate retains services until every registered cleanup settles',async()=>{
  const events=[];
  const binding=createRuntimeBinding({sessionId:'gate',role:'engine'});
  binding.beginNativeEpoch('native-1');
  const a=binding.openEntry(),b=binding.openEntry();let finish;
  a.lifetime.onCancel(()=>events.push('cancel-a'));
  b.lifetime.onCancel(()=>events.push('cancel-b'));
  a.finishStartup(()=>new Promise(resolve=>{events.push('cleanup-a');finish=resolve;}));
  b.finishStartup(()=>events.push('cleanup-b'));
  const module={godotjsLifecycleVersion:1,godotjsReleaseExit(){events.push('release-native');}};
  const gate=installNativeLifecycleGate(module,binding);
  module.godotjsBeginExit();await flush();
  assert.deepEqual(events.slice(0,2),['cancel-a','cancel-b']);
  assert(!events.includes('release-native'));
  finish();await flush();module.godotjsCleanupTick();await flush();
  assert.equal(events.at(-1),'release-native');
  module.godotjsBeginExit();module.godotjsCleanupTick();await flush();
  assert.equal(events.filter(value=>value==='release-native').length,1);
  assert.equal(binding.snapshotSummary().sealed,false,'a ready gate does not invent native destruction');
  gate.dispose();assert.equal(module.godotjsBeginExit,undefined);
});

test('pending startup cannot be mistaken for complete cleanup',async()=>{
  const binding=createRuntimeBinding({sessionId:'pending',role:'engine'});binding.beginNativeEpoch('native');
  const entry=binding.openEntry();let released=0;
  const module={godotjsLifecycleVersion:1,godotjsReleaseExit(){released++;}};
  const gate=installNativeLifecycleGate(module,binding);gate.beginClose();await flush();
  for(let n=0;n<3;n++){gate.tick();await flush();}
  assert.equal(released,0);assert.equal(binding.closeProgress().pendingStartup,1);
  entry.finishStartup();gate.tick();await flush();assert.equal(released,0);
  module.godotjsBeginExit();await flush();assert.equal(released,1);
  gate.dispose();
});

test('gate serialization has no module closure and an obsolete owner cannot release a replacement',async()=>{
  const context=vm.createContext({});
  const factory=vm.runInContext('('+installNativeLifecycleGate.toString()+')',context);
  let epoch='old',release=0,complete;
  const binding={snapshotSummary:()=>({epoch}),beginClose(){},drainClose:()=>new Promise(resolve=>{complete=resolve;})};
  const module={godotjsLifecycleVersion:1,godotjsReleaseExit(){release++;}};
  const gate=factory(module,binding);gate.beginClose();await flush();
  epoch='new';complete({status:'complete',pendingStartup:0,pendingCleanups:0});await flush();
  assert.equal(release,0);gate.dispose();
});

test('a claimed native lifecycle ABI requires its actual module exports',()=>{
  assert.throws(()=>installNativeLifecycleGate({},{}),/E_NATIVE_LIFECYCLE_ABI/);
  assert.throws(()=>installNativeLifecycleGate({godotjsLifecycleVersion:1},{}),/E_NATIVE_LIFECYCLE_ABI/);
});

for (const action of ['endNativeEpoch','settle']) test('a '+action+' binding cannot release a native gate',async()=>{
  const binding=createRuntimeBinding({sessionId:action,role:'engine'});binding.beginNativeEpoch('native');
  let releases=0;const module={godotjsLifecycleVersion:1,godotjsReleaseExit(){releases++;}};
  const gate=installNativeLifecycleGate(module,binding);gate.beginClose();await flush();
  binding[action]('native');module.godotjsBeginExit();gate.tick();await flush();
  assert.equal(binding.closeProgress().canNativeCleanup,false);assert.equal(releases,0);gate.dispose();
});
