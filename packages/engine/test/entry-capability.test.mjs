import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntimeBinding} from '../dist/runtime-host.js';

const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
const binding=()=>createRuntimeBinding({sessionId:'entry-capability',role:'engine'});

test('entry capabilities use local identity and reject copied, borrowed and foreign handles',()=>{
 const owner=binding(),entry=owner.openEntry(),cap=entry.capability;
 const other=binding(),foreign=other.openEntry();
 assert(Object.isFrozen(cap));assert.equal(cap.host,entry.host);assert.equal(cap.lifetime,entry.lifetime);
 assert.equal(owner.isEntryCapability(cap,entry.host),true);
 assert.equal(owner.isEntryCapability({...cap},entry.host),false);
 assert.equal(owner.isEntryCapability(foreign.capability,foreign.host),false);
 assert.equal(owner.isEntryCapability(cap,{...entry.host}),false);
 assert.throws(()=>cap.assertActive(foreign.host),/E_RUNTIME_ENTRY/);
 assert.throws(()=>cap.assertActive.call({...cap},entry.host),/E_RUNTIME_ENTRY/);
 assert.throws(()=>cap.assertActive.call(foreign.capability,foreign.host),/E_RUNTIME_ENTRY/);
 const participant={beginClose(){},tick(){},seal(){},close(){}};
 assert.throws(()=>cap.attachCleanup.call({...cap},participant),/E_RUNTIME_ENTRY/);
 assert.equal(owner.closeProgress().pendingCleanups,0);
 entry.finishStartup();entry.close();
 assert.equal(owner.isEntryCapability(cap),false);assert.throws(()=>cap.assertActive(),/E_RUNTIME_CLOSING/);
});

test('capability cleanup remains registered until actual async close completes',async()=>{
 const owner=binding(),entry=owner.openEntry(),events=[];let finish;
 const detach=entry.capability.attachCleanup({beginClose(){events.push('begin');},tick(){events.push('tick');},seal(){events.push('seal');},close(){events.push('close');return new Promise(resolve=>finish=resolve);}});
 entry.finishStartup();owner.beginClose();await owner.drainClose();
 assert.equal(owner.closeProgress().status,'pending');assert.equal(events.filter(value=>value==='close').length,1);
 detach();assert.equal(owner.closeProgress().pendingCleanups,1);
 finish();await flush();assert.equal(owner.closeProgress().status,'complete');
 owner.endNativeEpoch('untracked');assert.equal(events.includes('seal'),false);
});

test('serialized runtime factory creates authenticated capabilities without module state',async()=>{
 const realm=vm.createContext({});
 vm.runInContext(`this.owner=(${createRuntimeBinding.toString()})({sessionId:'serialized-cap',role:'engine'});this.entry=owner.openEntry();this.calls=0;entry.capability.attachCleanup({beginClose(){},tick(){},seal(){},close(){calls++;}});entry.finishStartup();owner.beginClose();`,realm);
 await realm.owner.drainClose();await flush();assert.equal(realm.calls,1);
 assert.equal(realm.owner.closeProgress().status,'complete');
});
