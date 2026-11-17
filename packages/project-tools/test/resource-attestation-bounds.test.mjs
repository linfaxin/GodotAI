import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// The override permits an isolated source bundle during development, without
// changing the workspace's SDK outputs. Normal package tests use built entries.
const {createBrowserResourceConverters,createResourceExecutionCache,ResourceConverterRegistry,pcmWavConverter,BINARY_RESOURCE_TARGET_ABI}=
 await import(process.env.RESOURCE_CONVERTERS_MODULE??'../dist/resource-converters.js');
const text=value=>new TextEncoder().encode(value);
const legacyTarget={resourceAbi:'godot-4-text-resource-v1',features:{engine:'history-fixture'}};
const request={resource:'res://tone.wav',converter:'godotjs/wav-pcm'};
function wav(revision=0){
 const bytes=new Uint8Array(46),view=new DataView(bytes.buffer);
 bytes.set(text('RIFF'));view.setUint32(4,bytes.length-8,true);bytes.set(text('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
 view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);bytes.set(text('data'),36);view.setUint32(40,2,true);bytes.set([revision>>8,revision&255],44);
 return bytes;
}
const source=revision=>new Map([[request.resource,wav(revision)]]);
const withOutputs=(files,result)=>new Map([...files,...result.files]);
const bytesEqual=(left,right)=>assert.deepEqual([...left],[...right]);

test('a long-lived registry bounds real WAV execution history across 1000 revisions',async()=>{
 const registry=createBrowserResourceConverters(undefined,{cache:createResourceExecutionCache({maxBytes:1024})});
 let first,last;
 for(let revision=0;revision<1000;revision++){
  const converted=await registry.run([request],source(revision),legacyTarget);
  assert.equal(converted.telemetry.executed,1);
  if(revision===0)first=converted;
  last=converted;
  const stats=registry.executionHistoryStats;
  assert(stats.entries<=stats.maxEntries);assert(stats.bytes<=stats.maxBytes);
 }
 const stats=registry.executionHistoryStats;
 assert.equal(stats.maxEntries,512);assert.equal(stats.maxBytes,64*1024);
 assert(stats.entries>0&&stats.entries<1000);
 const recent=await registry.run([request],withOutputs(source(999),last),legacyTarget,last.receipts);
 assert.deepEqual(recent.telemetry,{executed:0,cacheHits:1});
 const evicted=await registry.run([request],withOutputs(source(0),first),legacyTarget,first.receipts);
 assert.deepEqual(evicted.telemetry,{executed:1,cacheHits:0});
 assert.deepEqual(evicted.receipts,first.receipts);bytesEqual(evicted.files,first.files);
});

test('execution history applies both LRU entry and byte budgets',async()=>{
 for(const executionHistory of [{maxEntries:2,maxBytes:1024},{maxEntries:10,maxBytes:256}]){
  const registry=createBrowserResourceConverters(undefined,{executionHistory});
  const a=await registry.run([request],source(1),legacyTarget),b=await registry.run([request],source(2),legacyTarget);
  assert.equal((await registry.run([request],withOutputs(source(1),a),legacyTarget,a.receipts)).telemetry.cacheHits,1);
  await registry.run([request],source(3),legacyTarget);
  assert.equal((await registry.run([request],withOutputs(source(1),a),legacyTarget,a.receipts)).telemetry.cacheHits,1,'A was touched after B and remains recent');
  assert.equal((await registry.run([request],withOutputs(source(2),b),legacyTarget,b.receipts)).telemetry.executed,1,'B was least recently used');
  assert(registry.executionHistoryStats.entries<=executionHistory.maxEntries);
  assert(registry.executionHistoryStats.bytes<=executionHistory.maxBytes);
 }
});

test('zero and smaller-than-one-attestation budgets disable history safely',async()=>{
 for(const executionHistory of [{maxEntries:0},{maxBytes:0},{maxBytes:127}]){
  const registry=createBrowserResourceConverters(undefined,{executionHistory});
  const first=await registry.run([request],source(0),legacyTarget);
  const second=await registry.run([request],withOutputs(source(0),first),legacyTarget,first.receipts);
  assert.equal(second.telemetry.executed,1);assert.equal(second.telemetry.cacheHits,0);
  assert.equal(registry.executionHistoryStats.entries,0);assert.equal(registry.executionHistoryStats.bytes,0);
  assert.deepEqual(second.receipts,first.receipts);bytesEqual(second.files,first.files);
 }
});

test('large receipts retain only their bounded digest and budget options are captured',async()=>{
 const executionHistory={maxEntries:1,maxBytes:128},registry=createBrowserResourceConverters(undefined,{executionHistory});
 executionHistory.maxBytes=0;executionHistory.maxEntries=0;
 const target={...legacyTarget,features:{metadata:'x'.repeat(128*1024)}};
 const first=await registry.run([request],source(0),target);
 assert(JSON.stringify(first.receipts[0]).length>128*1024);
 assert.deepEqual(registry.executionHistoryStats,{entries:1,bytes:128,maxEntries:1,maxBytes:128});
 assert.equal((await registry.run([request],withOutputs(source(0),first),target,first.receipts)).telemetry.cacheHits,1);
 assert(Object.isFrozen(registry.executionHistoryStats));
});

test('a forged receipt with matching forged output hashes cannot use another receipt attestation',async()=>{
 const registry=new ResourceConverterRegistry().register(pcmWavConverter);
 const files=source(0),actual=await registry.run([request],files,legacyTarget);
 const forged=structuredClone(actual.receipts),payload=text('not a converted WAV'),path=forged[0].outputs.find(item=>item.path.endsWith('.tres')).path;
 const supplied=withOutputs(files,actual);supplied.set(path,payload);
 forged[0].outputs.find(item=>item.path===path).sha256=createHash('sha256').update(payload).digest('hex');
 const rebuilt=await registry.run([request],supplied,legacyTarget,forged);
 assert.deepEqual(rebuilt.telemetry,{executed:1,cacheHits:0});bytesEqual(rebuilt.files,actual.files);
 const imported=await new ResourceConverterRegistry().register(pcmWavConverter).run([request],withOutputs(files,actual),legacyTarget,actual.receipts);
 assert.equal(imported.telemetry.executed,1,'Imported receipt JSON is not another registry execution proof');
});

test('a nondeterministic host converter reexecutes after its attestation is evicted',async()=>{
 let calls=0;
 const registry=new ResourceConverterRegistry({executionHistory:{maxEntries:1}}).register({...pcmWavConverter,convert(context){calls++;return pcmWavConverter.convert(context);}});
 const a=await registry.run([request],source(1),legacyTarget);
 assert.equal((await registry.run([request],withOutputs(source(1),a),legacyTarget,a.receipts)).telemetry.cacheHits,1);
 await registry.run([request],source(2),legacyTarget);
 const before=calls,again=await registry.run([request],withOutputs(source(1),a),legacyTarget,a.receipts);
 assert.equal(calls,before+1);assert.equal(again.telemetry.executed,1);
});

test('verified persistent deterministic cache still reuses unchanged bytes with execution history disabled',async()=>{
 const records=new Map(),storage={async read(key){return records.get(key)?.slice();},async write(key,bytes){records.set(key,bytes.slice());}};
 const create=()=>createBrowserResourceConverters(undefined,{cache:createResourceExecutionCache({storage}),executionHistory:{maxBytes:0}});
 const target={resourceAbi:BINARY_RESOURCE_TARGET_ABI,features:{engine:'persistent-history-fixture'}},files=source(0),firstRegistry=create();
 const first=await firstRegistry.run([request],files,target);
 assert.equal(first.telemetry.executed,1);assert(records.size>0);assert.equal(firstRegistry.executionHistoryStats.entries,0);
 const secondRegistry=create(),second=await secondRegistry.run([request],files,target);
 assert.deepEqual(second.telemetry,{executed:0,cacheHits:1});assert.equal(secondRegistry.executionHistoryStats.entries,0);
 assert.deepEqual(second.receipts,first.receipts);bytesEqual(second.files,first.files);
});

test('execution history rejects invalid budgets',()=>{
 for(const executionHistory of [{maxEntries:-1},{maxEntries:0.5},{maxEntries:Infinity},{maxBytes:-1},{maxBytes:NaN},{maxBytes:Number.MAX_SAFE_INTEGER+1}])
  assert.throws(()=>new ResourceConverterRegistry({executionHistory}),/Invalid execution history budget/);
});
