import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assertBrowserSharedMemoryGrowth,SHARED_MEMORY_GROWTH_PROBE_BYTES,SHARED_MEMORY_GROWTH_PROBE_SHA256} from '../dist/browser/shared-memory-growth.js';
import {loadVerifiedEngine} from '../dist/browser/verified-loader.js';
import {installProbeWorker} from './fixtures/probe-worker.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

test('the fixed probe bytes and WAT source stay pinned',async()=>{
 assert.equal(SHARED_MEMORY_GROWTH_PROBE_BYTES.length,126);assert.equal(digest(SHARED_MEMORY_GROWTH_PROBE_BYTES),SHARED_MEMORY_GROWTH_PROBE_SHA256);assert(WebAssembly.validate(SHARED_MEMORY_GROWTH_PROBE_BYTES));
 assert.equal(digest(await readFile(new URL('./fixtures/shared-memory-growth.wat',import.meta.url))),'d8d5060f659241e63ae5e9781db51dacf2479b00043a9cb393a5bff64bb1b187');
});
test('retained instances read, copy and fill the grown range and close the probe scope',async t=>{
 const f=installProbeWorker(t);await assertBrowserSharedMemoryGrowth();assert.equal(f.workers.length,1);assert.equal(f.workers[0].terminated,1);assert.deepEqual(f.revoked,[f.created[0].url]);assert.equal(f.workers[0].onmessage,null);
});
test('a stale Worker instance fails before any engine fetch and still closes its scope',async t=>{
 const f=installProbeWorker(t,{mode:'failure'});let fetches=0;t.mock.method(globalThis,'fetch',async()=>{fetches++;throw Error('engine fetch must not happen');});
 const release={releaseId:'probe-release',profile:'full-engine-v1',engineJs:{url:'https://preview.test/game.js',sha256:'a'.repeat(64)},engineWasm:{url:'https://preview.test/game.wasm',sha256:'b'.repeat(64)},execution:{schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded'}};
 await assert.rejects(loadVerifiedEngine(release),/E_BROWSER_SHARED_MEMORY_GROWTH.*当前浏览器不支持/);assert.equal(fetches,0);assert.equal(f.workers[0].terminated,1);assert.deepEqual(f.revoked,[f.created[0].url]);
});
test('probe timeout and cancellation release Worker, callbacks and Blob URL',async t=>{
 const f=installProbeWorker(t,{mode:'silent'});await assert.rejects(assertBrowserSharedMemoryGrowth({timeoutMs:5}),/E_BROWSER_SHARED_MEMORY_GROWTH/);
 const controller=new AbortController(),pending=assertBrowserSharedMemoryGrowth({signal:controller.signal});while(f.workers.length<2)await new Promise(resolve=>setImmediate(resolve));controller.abort(new Error('cancel probe'));
 await assert.rejects(pending,/cancel probe/);assert(f.workers.every(worker=>worker.terminated===1));assert.equal(f.revoked.length,2);
});
