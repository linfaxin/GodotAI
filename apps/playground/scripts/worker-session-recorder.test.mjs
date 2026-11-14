import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installWorkerSessionRecorder} from './browser-harness.mjs';

function fixture(transport){
 const calls=[],errors=[],events=new Map();let tick;
 const scope={console:{error:value=>errors.push(value)},addEventListener:(name,callback)=>events.set(name,callback),setInterval:(callback,ms)=>{assert.equal(ms,50);tick=callback;},__recordWorkerAcceptanceSession:transport??(value=>{calls.push(value);return Promise.resolve();})};
 vm.runInNewContext('('+String(installWorkerSessionRecorder)+')({})',scope);
 return {scope,calls,errors,event:value=>events.get('playground-runtime-session')({detail:value}),tick:()=>tick()};
}
const snapshot=(patch={})=>Object.freeze({workerId:'worker-1',workerState:'running',memory:{serial:1},...patch});

test('actual init deduplicates repeated event/poll references and old late events while sending every changed object',()=>{
 const f=fixture(),first=snapshot(),updated=snapshot({memory:{serial:2}});
 f.scope.__playgroundRuntimeSession=()=>first;f.event(first);for(let n=0;n<20;n++)f.tick();assert.deepEqual(f.calls,[first]);
 f.event(updated);f.scope.__playgroundRuntimeSession=updated;f.tick();f.event(first);
 assert.deepEqual(f.calls,[first,updated]);assert.deepEqual(f.errors,[]);
});

test('closing, native exit and asynchronous cleanup snapshots all reach Node exactly once',()=>{
 const f=fixture(),states=[snapshot(),snapshot({closing:true}),snapshot({workerState:'native-exited'}),snapshot({workerState:'native-exited',exit:{hostCleanup:{status:'complete'}}})];
 for(const value of states){f.event(value);f.scope.__playgroundRuntimeSession=()=>value;f.tick();f.tick();}
 assert.deepEqual(f.calls,states);assert.equal(f.calls.at(-1).exit.hostCleanup.status,'complete');
});

test('invalid pre-identity objects are not marked seen and fresh worker identities remain observable',()=>{
 const f=fixture(),pending={workerState:'uncreated'};f.event(pending);f.scope.__playgroundRuntimeSession=pending;f.tick();assert.equal(f.calls.length,0);
 pending.workerId='worker-1';f.tick();const next=snapshot({workerId:'worker-2'});f.event(next);
 assert.deepEqual(f.calls,[pending,next]);
});

test('local transport throws/rejections stay explicit and can retry the same reference',async()=>{
 let attempts=0;const f=fixture(()=>{if(++attempts===1)return Promise.reject(Error('transport failure'));return Promise.resolve();}),value=snapshot();
 f.event(value);await new Promise(resolve=>setImmediate(resolve));assert.match(f.errors[0],/E_WORKER_SESSION_RECORDER: transport failure/);
 f.event(value);f.event(value);assert.equal(attempts,2);
 const thrown=fixture(()=>{throw Error('synchronous failure');});thrown.event(value);assert.match(thrown.errors[0],/synchronous failure/);
 const missing=fixture();delete missing.scope.__recordWorkerAcceptanceSession;missing.event(value);assert.match(missing.errors[0],/Passive transport unavailable/);missing.scope.__recordWorkerAcceptanceSession=item=>missing.calls.push(item);missing.event(value);assert.deepEqual(missing.calls,[value]);
});

test('getter errors remain failures rather than disappearing behind deduplication',()=>{
 const f=fixture();f.scope.__playgroundRuntimeSession=()=>{throw Error('actual getter failure');};assert.throws(()=>f.tick(),/actual getter failure/);
});
