import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeLifecycleGate} from '../../../packages/engine/dist/browser/lifecycle-gate.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('cleanup-only drain requests the native owner checkpoint and releases its ticket before awaiting',async()=>{
 let ticket=false,released=0,drains=0;const queued=[];
 const module={godotjsLifecycleVersion:1,godotjsCheckpointAbi:1,godotjsReleaseExit(){assert.equal(ticket,false);released++;},
  godotjsScheduleCleanupCheckpoint(callback){queued.push(()=>{ticket=true;try{callback();}finally{ticket=false;}});return true;}};
 const binding={beginClose(){},snapshotSummary(){return {epoch:'live',sealed:false};},async drainClose(){assert.equal(ticket,true);drains++;await Promise.resolve();assert.equal(ticket,false);return {canNativeCleanup:true,pendingStartup:0,pendingCleanups:0,status:'complete'};}};
 const gate=installNativeLifecycleGate(module,binding);
 module.godotjsBeginExit();await flush();assert.equal(drains,0);assert.equal(released,0);
 queued.shift()();await flush();assert.equal(drains,1);assert.equal(released,1);
 gate.dispose();
});

test('an advertised checkpoint ABI without its actual scheduler cannot drain or release native state',async()=>{
 const errors=[];let drained=false,released=false;
 const module={godotjsLifecycleVersion:1,godotjsCheckpointAbi:1,godotjsReleaseExit(){released=true;}};
 const binding={beginClose(){},snapshotSummary(){return {epoch:'live',sealed:false};},drainClose(){drained=true;}};
 const gate=installNativeLifecycleGate(module,binding,{onError:error=>errors.push(error)});
 module.godotjsBeginExit();await flush();assert.equal(drained,false);assert.equal(released,false);assert.match(errors[0].message,/E_NATIVE_CHECKPOINT_SCHEDULE/);gate.dispose();
});
