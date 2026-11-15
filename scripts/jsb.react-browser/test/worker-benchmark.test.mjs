import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerBenchmark} from '../dist/worker-benchmark.js';

test('benchmark keeps separate delivery, actual Native callback, capture and Host consumption times',()=>{
 let now=12;const timing=new WorkerBenchmark(4,()=>now);
 timing.inputReceived({sequence:1,event:'keydown',fields:{code:'KeyJ'},timing:{capturedAtMs:10,forwardedAtMs:11,trusted:true}});
 now=13;timing.inputDispatched(1,true);
 assert.equal(timing.snapshot().inputs[0].nativeConsumedAtMs,null,'DOM dispatch alone is not Native application consumption');
 now=15;assert(timing.nativeInputConsumed('keydown','KeyJ'));assert.equal(timing.nativeInputConsumed('keydown','KeyJ'),false);
 timing.frameCaptured({frameId:1,resizeEpoch:0},16,18);now=23;
 timing.frameAcknowledged({frameId:1,resizeEpoch:1,timing:{receivedAtMs:19,consumedAtMs:20,disposition:'consumed'}});
 assert.equal(timing.snapshot().frames[0].ackReceivedAtMs,null);
 timing.frameAcknowledged({frameId:1,resizeEpoch:0,timing:{receivedAtMs:19,consumedAtMs:20,disposition:'consumed'}});
 now=50;timing.frameAcknowledged({frameId:1,resizeEpoch:0});
 const state=timing.snapshot();assert.equal(state.inputs[0].nativeConsumedAtMs,15);assert.equal(state.frames[0].ackReceivedAtMs,23);assert.equal(state.frames[0].hostConsumedAtMs,20);assert.equal(state.frames[0].hostDisposition,'consumed');
 state.inputs[0].nativeConsumedAtMs=999;assert.equal(timing.snapshot().inputs[0].nativeConsumedAtMs,15,'observations are independent copies');
});

test('benchmark storage is bounded and invalid clocks or unaccepted input cannot become latency samples',()=>{
 let now=10;const timing=new WorkerBenchmark(1,()=>now);
 timing.inputReceived({sequence:1,event:'keydown',fields:{},timing:{capturedAtMs:12,forwardedAtMs:11,trusted:true}});
 assert.equal(timing.snapshot().inputs.length,0);
 for(let seq=1;seq<=3;seq++){timing.inputReceived({sequence:seq,event:'keydown',fields:{code:'KeyJ'},timing:{capturedAtMs:1,forwardedAtMs:2,trusted:true}});timing.inputDispatched(seq,true);timing.frameCaptured({frameId:seq,resizeEpoch:0},3,4);}
 assert.equal(timing.snapshot().inputs.length,1);assert.equal(timing.snapshot().frames.length,1);assert.equal(timing.snapshot().evictedInputs,2);assert.equal(timing.snapshot().evictedFrames,2);
 timing.inputDispatched(3,false);assert.equal(timing.snapshot().inputs.length,0);
 now=3;timing.frameAcknowledged({frameId:3,resizeEpoch:0});assert.equal(timing.snapshot().frames[0].ackReceivedAtMs,null);assert(timing.snapshot().rejectedSamples>=3);
 for(const limit of [0,-1,4097,Infinity])assert.throws(()=>new WorkerBenchmark(limit),/BUDGET/);
});

test('cross-realm rounding preserves Native and Host observations without repairing their clocks',()=>{
 let now=19.9;const timing=new WorkerBenchmark(4,()=>now);
 timing.inputReceived({sequence:1,event:'keydown',fields:{code:'KeyJ'},timing:{capturedAtMs:20,forwardedAtMs:20.1,trusted:true}});
 now=20.2;timing.inputDispatched(1,true);now=25;assert(timing.nativeInputConsumed('keydown','KeyJ'));
 timing.frameCaptured({frameId:1,resizeEpoch:0},1,3);now=5;
 timing.frameAcknowledged({frameId:1,resizeEpoch:0,timing:{receivedAtMs:2.9,consumedAtMs:3.1,disposition:'consumed'}});
 const state=timing.snapshot();assert.equal(state.inputs[0].workerReceivedAtMs,19.9);assert.equal(state.inputs[0].nativeConsumedAtMs,25);assert.equal(state.frames[0].hostReceivedAtMs,2.9);assert.equal(state.frames[0].hostConsumedAtMs,3.1);assert.equal(state.rejectedSamples,0);
});
