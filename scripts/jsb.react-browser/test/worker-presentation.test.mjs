import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPresentation, createPresentationHost, drawingBufferSize, installPresentationHooks } from '../dist/worker-presentation.js';

const geometry = {width:100,height:50,dpr:2,epoch:0};
class Canvas extends EventTarget {
  width=0; height=0; style={}; captures=0;
  transferToImageBitmap() { this.captures++; return bitmap(this.width,this.height); }
}
function bitmap(width,height) { return {width,height,closed:0,close(){this.closed++;}}; }
function worker(overrides={}) {
  const canvas=new Canvas(), frames=[], errors=[];
  const presentation=createWorkerPresentation({runId:'run',canvas,geometry,mode:'bitmap',sendFrame:frame=>frames.push(frame),onFatal:error=>errors.push(error),...overrides});
  return {canvas,frames,errors,presentation};
}
function render(p,id,serial=id) {p.beginIteration(id);p.commit(serial,id);p.endIteration(id,serial);}
test('bitmap captures actual committed iteration only, never skipped loop or independent frame',()=>{
  const {canvas,frames,presentation:p}=worker();
  p.beginIteration(1);p.endIteration(1,0);assert.equal(canvas.captures,0);
  p.beginIteration(2);p.commit(1,1);p.endIteration(2,0);assert.equal(canvas.captures,0);
  render(p,3,1);assert.equal(frames.length,1);
  p.endIteration(3,1);assert.equal(canvas.captures,1);p.dispose();
});
test('one run-wide credit survives resize and requires original exact ACK',()=>{
  const {frames,presentation:p}=worker();render(p,1);
  p.resize({...geometry,epoch:1,width:120});render(p,2);assert.equal(frames.length,1);
  assert.equal(p.ack({...frames[0],resizeEpoch:1}),false);
  assert.equal(p.ack({...frames[0],runId:'old-run'}),false);
  assert.equal(p.ack(frames[0]),true);assert.equal(p.ack(frames[0]),false);
  render(p,3);assert.equal(frames.length,2);assert.equal(frames[1].resizeEpoch,1);
  assert.equal(p.stats().peakOutstanding,1);assert.equal(p.stats().inFlightEstimatedBytes,240*100*4);p.dispose();
});
test('native draw gate waits only for the exact bitmap credit across resize and XR transitions',()=>{
  let xr=false;const {presentation:p,frames}=worker({isXRActive:()=>xr});
  assert.equal(p.canDraw(),true);render(p,1);assert.equal(p.canDraw(),false);
  const before=p.stats();for(let i=0;i<5;i++)assert.equal(p.canDraw(),false);assert.deepEqual(p.stats(),before);
  p.setVisible(false);p.resize({...geometry,epoch:1,width:0});assert.equal(p.canDraw(),false);
  assert.equal(p.ack({...frames[0],resizeEpoch:1}),false);assert.equal(p.canDraw(),false);
  xr=true;assert.equal(p.canDraw(),true);xr=false;assert.equal(p.canDraw(),false);
  assert.equal(p.ack(frames[0]),true);assert.equal(p.canDraw(),true);
  // Visibility/zero size do not add a second draw gate after release.
  p.setVisible(true);p.resize({...geometry,epoch:2});render(p,2);assert.equal(p.canDraw(),false);
  p.dispose();assert.equal(p.canDraw(),true);assert.equal(p.ack(frames[1]),false);
  const direct=worker({mode:'direct'}).presentation;render(direct,1);assert.equal(direct.canDraw(),true);direct.dispose();
});
test('draw ABI preserves existing hook, restores ownership, and opens on teardown',()=>{
  const {presentation:p,frames}=worker(),previous=()=>undefined,module={godotWorkerDrawAllowed:previous};
  const restore=installPresentationHooks(module,p);assert.equal(module.godotWorkerDrawAllowed(),true);
  render(p,1);assert.equal(module.godotWorkerDrawAllowed(),false);
  p.ack(frames[0]);assert.equal(module.godotWorkerDrawAllowed(),true);
  p.dispose();assert.equal(module.godotWorkerDrawAllowed(),true);restore();assert.equal(module.godotWorkerDrawAllowed,previous);
  const w=worker(),restricted={godotWorkerDrawAllowed:()=>false},undo=installPresentationHooks(restricted,w.presentation);
  assert.equal(restricted.godotWorkerDrawAllowed(),false);
  const later=()=>true;restricted.godotWorkerDrawAllowed=later;undo();assert.equal(restricted.godotWorkerDrawAllowed,later);w.presentation.dispose();
});
test('teardown resolves the live native reset once, without resetting resize credit',()=>{
  const module={};let resets=0;
  const {presentation:p,frames}=worker({resetDrawCredit:()=>module.godotWorkerResetDrawCredit?.()});
  render(p,1);module.godotWorkerResetDrawCredit=()=>{resets++;assert.equal(p.canDraw(),true);};
  p.resize({...geometry,epoch:1});assert.equal(resets,0);assert.equal(p.canDraw(),false);
  p.dispose();p.dispose();assert.equal(resets,1);assert.equal(p.ack(frames[0]),false);
  // Native cleanup may already have removed its live alias.
  delete module.godotWorkerResetDrawCredit;
  const stopped=worker({resetDrawCredit:()=>module.godotWorkerResetDrawCredit?.()});stopped.presentation.dispose();assert.equal(resets,1);
  const failed=worker({resetDrawCredit:()=>resets++,sendFrame(){throw Error('closed data port');}});
  render(failed.presentation,1);assert.equal(resets,2);assert.equal(failed.presentation.canDraw(),true);assert.equal(failed.errors.length,1);
});
test('post hook parks GL first and requires native completed same iteration',()=>{
  const {frames,presentation:p}=worker(),order=[];
  const module={postMainLoop(){order.push('park');assert.equal(frames.length,0);}};
  const restore=installPresentationHooks(module,p);
  module.godotWorkerBeginIteration(1);module.godotWorkerCommit(1,1);module.postMainLoop();assert.equal(frames.length,0);
  module.godotWorkerEndIteration(1,1);module.postMainLoop();assert.equal(frames.length,1);assert.deepEqual(order,['park','park']);
  restore();assert.equal(module.godotWorkerCommit,undefined);p.dispose();
});
test('direct observes monotonic native commits without owning bitmap lifecycle or replacing other frame hooks',()=>{
  const {canvas,presentation:p}=worker({mode:'direct'}),calls=[],observedCounts=[];
  const module={godotWorkerBeginIteration:id=>calls.push(['begin',id]),godotWorkerEndIteration:(id,serial)=>calls.push(['end',id,serial]),
    godotWorkerDrawAllowed:()=>{calls.push(['draw']);return true;},postMainLoop:()=>calls.push(['park']),godotWorkerCommit:(serial,id)=>{calls.push(['commit',serial,id]);observedCounts.push(p.stats().committed);}};
  const original={...module},restore=installPresentationHooks(module,p);
  for(const name of ['godotWorkerBeginIteration','godotWorkerEndIteration','godotWorkerDrawAllowed','postMainLoop'])assert.equal(module[name],original[name]);
  // The native caller's other hooks (including XR/GL owners) still execute.
  module.godotWorkerBeginIteration(7);if(module.godotWorkerDrawAllowed()!==false)module.godotWorkerCommit(4,7);module.godotWorkerEndIteration(7,4);module.postMainLoop();
  assert.deepEqual(calls,[['begin',7],['draw'],['commit',4,7],['end',7,4],['park']]);
  // Subsequent successful commits do not need bitmap begin/end notifications.
  module.godotWorkerCommit(4,8);module.godotWorkerCommit(3,9);module.godotWorkerCommit(NaN,10);module.godotWorkerCommit(5,11);
  assert.equal(p.stats().committed,2);assert.equal(p.stats().captured,0);assert.equal(p.stats().outstanding,0);assert.equal(canvas.captures,0);
  p.dispose();module.godotWorkerCommit(6,12);assert.equal(p.stats().committed,2);
  assert.deepEqual(observedCounts,[1,1,1,1,2,2]);
  restore();assert.equal(module.godotWorkerCommit,original.godotWorkerCommit);module.postMainLoop();assert.deepEqual(calls.at(-1),['park']);
});
test('direct context loss closes commit observation and cleanup preserves a later hook owner',()=>{
  const {canvas,presentation:p,errors}=worker({mode:'direct'}),module={},restore=installPresentationHooks(module,p);
  module.godotWorkerCommit(1,1);canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));module.godotWorkerCommit(2,2);
  assert.equal(p.stats().committed,1);assert.equal(errors.length,1);
  const nextOwner=()=>{};module.godotWorkerCommit=nextOwner;restore();assert.equal(module.godotWorkerCommit,nextOwner);
  assert.equal(module.godotWorkerBeginIteration,undefined);assert.equal(module.godotWorkerEndIteration,undefined);assert.equal(module.godotWorkerDrawAllowed,undefined);assert.equal(module.postMainLoop,undefined);
});
test('real canvas event methods stay native and context loss ends run exactly once',()=>{
  const canvas=new Canvas(),add=canvas.addEventListener,{presentation:p,errors}=worker({canvas});
  assert.equal(canvas.addEventListener,add);canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
  canvas.dispatchEvent(new Event('webglcontextlost'));render(p,1);assert.equal(errors.length,1);assert.equal(canvas.captures,0);
});
test('direct is immutable default; visibility and zero size pause bitmap only',()=>{
  const canvas=new Canvas(),options={runId:'run',canvas,geometry,sendFrame(){throw Error('direct transferred');},onFatal(){}};
  const direct=createWorkerPresentation(options);options.mode='bitmap';render(direct,1);assert.equal(canvas.captures,0);direct.dispose();
  const {presentation:p,frames}=worker();p.setVisible(false);render(p,1);assert.equal(frames.length,0);p.setVisible(true);
  p.resize({...geometry,width:0,epoch:1});render(p,2);assert.equal(frames.length,0);p.dispose();
});
test('aggregate budgets include an old-size outstanding bitmap and do not mutate on failed resize',()=>{
  const {presentation:p,frames}=worker({limits:{maxDimension:1000,maxPixels:1000000,maxAggregateBytes:330000}});
  render(p,1);assert.equal(p.stats().aggregateEstimatedBytes,320000);
  assert.throws(()=>p.resize({...geometry,width:110,epoch:1}),/PRESENTATION_BUDGET/);assert.equal(p.geometry.epoch,0);
  p.ack(frames[0]);assert.equal(p.resize({...geometry,width:110,epoch:1}),true);p.dispose();
  assert.throws(()=>drawingBufferSize({...geometry,width:Infinity}),/GEOMETRY/);
  assert.throws(()=>drawingBufferSize({...geometry,width:100000}),/BUDGET/);
});
test('Host initial allocation and resize reject aggregate bytes before touching a canvas',()=>{
 let creates=0,contexts=0;const canvas={width:0,height:0,getContext(){contexts++;return{transferFromImageBitmap(){}};}};
 const initial={width:2,height:2,dpr:1,epoch:0},limits={maxDimension:100,maxPixels:10000,maxAggregateBytes:128};
 const options={runId:'run',canvas,geometry:{...initial,width:8,height:8},limits,mode:'bitmap',createOffscreen(){creates++;return new Canvas();},sendAck(){},onFatal:assert.fail};
 assert.throws(()=>createPresentationHost(options),/PRESENTATION_BUDGET/);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(contexts,0);assert.equal(creates,0);
 const host=createPresentationHost({...options,geometry:initial});assert.equal(contexts,1);assert.equal(creates,1);
 assert.throws(()=>host.resize({...initial,width:8,height:8,epoch:1}),/PRESENTATION_BUDGET/);assert.equal(canvas.width,2);assert.equal(canvas.height,2);assert.equal(host.geometry.epoch,0);host.dispose();
});
test('Host keeps an old bitmap reservation until matching Worker geometry and consumption checkpoints',()=>{
 const g={width:10,height:10,dpr:1,epoch:0},limits={maxDimension:100,maxPixels:10000,maxAggregateBytes:2000},frames=[],acks=[];
 const canvas={width:0,height:0,getContext:()=>({transferFromImageBitmap(){}})};
 const host=createPresentationHost({runId:'run',canvas,geometry:g,mode:'bitmap',limits,createOffscreen:()=>new Canvas(),sendAck:ack=>acks.push(ack),onFatal:assert.fail});
 const p=createWorkerPresentation({runId:'run',canvas:host.offscreen,geometry:g,mode:'bitmap',limits,sendFrame:frame=>frames.push(frame),onFatal:assert.fail});render(p,1);
 const small={...g,width:5,height:5,epoch:1};host.resize(small);p.resize(small);const before=p.checkpoint();
 assert.equal(host.observeWorkerCheckpoint(before,10),true);assert.equal(host.stats().reservedBitmapBytes,400);assert.equal(host.stats().pendingGeometryReservations,2);
 assert.equal(host.observeWorkerCheckpoint({...before,outstanding:null},10),false);assert.equal(host.observeWorkerCheckpoint({...before,outstanding:{...before.outstanding,runId:'old'}},11),false);
 assert.equal(host.consume(frames[0]),false);assert.equal(p.ack(acks[0]),true);assert.equal(host.observeWorkerCheckpoint(p.checkpoint(),12),true);
 assert.equal(host.stats().reservedBitmapBytes,100);assert.equal(host.stats().pendingGeometryReservations,1);assert.equal(host.observeWorkerCheckpoint(before,11),false);
 host.dispose();p.dispose();
});
test('unacknowledged Host geometry reservations are bounded and released by actual Worker progress',()=>{
 const g={width:1,height:1,dpr:1,epoch:0},canvas={width:0,height:0,getContext:()=>({transferFromImageBitmap(){}})};
 const host=createPresentationHost({runId:'run',canvas,geometry:g,mode:'bitmap',createOffscreen:()=>new Canvas(),sendAck(){},onFatal:assert.fail});
 for(let epoch=1;epoch<1024;epoch++)host.resize({...g,epoch});assert.throws(()=>host.resize({...g,epoch:1024}),/RESIZE_BACKPRESSURE/);assert.equal(host.geometry.epoch,1023);
 assert.equal(host.observeWorkerCheckpoint({geometryEpoch:1023,outstanding:null},1),true);assert.equal(host.stats().pendingGeometryReservations,1);assert.equal(host.resize({...g,epoch:1024}),true);host.dispose();
});
test('a size admitted for a hidden canvas without capture does not invent an impossible bitmap reservation',()=>{
 const g={width:10,height:10,dpr:1,epoch:0},canvas={width:0,height:0,getContext:()=>({transferFromImageBitmap(){}})};
 const host=createPresentationHost({runId:'run',canvas,geometry:g,mode:'bitmap',limits:{maxDimension:100,maxPixels:10000,maxAggregateBytes:1300},createOffscreen:()=>new Canvas(),sendAck(){},onFatal:assert.fail});
 assert.equal(host.stats().reservedBitmapBytes,0);assert.equal(host.resize({...g,width:9,height:9,epoch:1}),true);assert.equal(host.stats().aggregateReservedBytes,1296);host.dispose();
});
test('Host independently rejects a frame above aggregate bytes before bitmaprenderer consumption',()=>{
 const g={width:10,height:10,dpr:1,epoch:0},errors=[],acks=[];let consumed=0;
 const host=createPresentationHost({runId:'run',canvas:{width:0,height:0,getContext:()=>({transferFromImageBitmap(){consumed++;}})},geometry:g,mode:'bitmap',limits:{maxDimension:100,maxPixels:10000,maxAggregateBytes:1300},createOffscreen:()=>new Canvas(),sendAck:ack=>acks.push(ack),onFatal:error=>errors.push(error)});
 const image=bitmap(10,10);assert.equal(host.consume({runId:'run',frameId:1,resizeEpoch:0,width:10,height:10,bitmap:image}),false);assert.equal(consumed,0);assert.match(errors[0].message,/PRESENTATION_BUDGET/);assert.equal(image.closed,1);assert.equal(acks.length,1);host.dispose();
});
test('failed transfer send releases bitmap and marks fatal',()=>{
  let sent;const {presentation:p,errors}=worker({sendFrame(frame){sent=frame;throw Error('channel closed');}});
  render(p,1);assert.equal(sent.bitmap.closed,1);assert.equal(errors.length,1);assert.equal(p.stats().outstanding,0);
});
test('host releases and ACKs stale old-epoch frames as well as successful frames',()=>{
  const canvas=new Canvas(),acks=[],drawn=[];
  canvas.style.width='100%';canvas.style.height='100%';
  canvas.getContext=kind=>({transferFromImageBitmap:frame=>drawn.push(frame)});
  const host=createPresentationHost({runId:'run',canvas,geometry,mode:'bitmap',createOffscreen:()=>new Canvas(),sendAck:ack=>acks.push(ack),onFatal:assert.fail});
  host.resize({...geometry,width:120,epoch:1});
  assert.equal(canvas.style.width,'100%');assert.equal(canvas.style.height,'100%');
  const stale={type:'present-frame',runId:'run',frameId:1,resizeEpoch:0,width:200,height:100,bitmap:bitmap(200,100)};
  assert.equal(host.consume(stale),false);assert.equal(stale.bitmap.closed,1);assert.equal(acks[0].resizeEpoch,0);
  const current={...stale,frameId:2,resizeEpoch:1,width:240,bitmap:bitmap(240,100)};
  assert.equal(host.consume(current),true);assert.equal(drawn.length,1);assert.equal(acks.length,2);host.dispose();
});
test('host accounts its retained bitmap after ACK until backing resize or disposal clears it',()=>{
  const canvas=new Canvas(),acks=[];canvas.getContext=()=>({transferFromImageBitmap(){}});
  const host=createPresentationHost({runId:'run',canvas,geometry,mode:'bitmap',createOffscreen:()=>new Canvas(),sendAck:ack=>acks.push(ack),onFatal:assert.fail});
  assert.equal(host.stats().retainedBitmap,null);
  const frame={type:'present-frame',runId:'run',frameId:1,resizeEpoch:0,width:200,height:100,bitmap:bitmap(200,100)};
  host.consume(frame);assert.equal(acks.length,1);assert.equal(frame.bitmap.closed,1);
  assert.deepEqual(host.stats().retainedBitmap,{runId:'run',frameId:1,resizeEpoch:0,width:200,height:100,estimatedBytes:80000});assert.equal(host.stats().provesOnscreenPresentation,false);
  host.resize({...geometry,epoch:1});assert.equal(host.stats().retainedBitmap.frameId,1);
  host.resize({...geometry,width:120,epoch:2});assert.equal(host.stats().retainedBitmap,null);assert.deepEqual(host.stats().drawingBuffer,{width:240,height:100,estimatedBytes:96000});
  host.consume({...frame,frameId:2,resizeEpoch:2,width:240,bitmap:bitmap(240,100)});assert.equal(host.stats().retainedBitmap.estimatedBytes,96000);
  host.dispose();assert.equal(host.stats().retainedBitmap,null);assert.equal(host.stats().drawingBuffer.estimatedBytes,0);assert.equal(host.stats().closed,true);
});
