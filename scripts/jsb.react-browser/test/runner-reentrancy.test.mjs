import assert from 'node:assert/strict';
import test from 'node:test';
import {PreviewRunner} from '../dist/runner.js';
import {PREVIEW_PROTOCOL, isPreviewEnvelope, previewDiagnostic} from '../dist/protocol.js';

const release={releaseId:'reentrant',profile:'native',engineJs:{url:'http://preview.test/godot.js',sha256:'a'.repeat(64)},engineWasm:{url:'http://preview.test/godot.wasm',sha256:'b'.repeat(64)}};
const artifact={revision:1,buildKey:'reentrant',generation:'p0',pack:new Uint8Array([1,2,3]),manifest:{generation:'p0'}};
const phases=['preloading','initializing','starting','waiting-ready','running'];
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function fixture(){
 const originals=Object.fromEntries(['MessageChannel','setTimeout','clearTimeout','setInterval','clearInterval'].map(k=>[k,globalThis[k]]));
 let timerId=0;const timers=new Map(),channels=[],attached=[],frames=[],messages=[];
 globalThis.setTimeout=(fn)=>{const id=++timerId;timers.set(id,fn);return id;};
 globalThis.setInterval=globalThis.setTimeout;
 globalThis.clearTimeout=id=>timers.delete(id);globalThis.clearInterval=globalThis.clearTimeout;
 class Port{closed=false;onmessage=null;close(){this.closed=true;this.onmessage=null;}start(){}postMessage(data){if(this.closed)throw Error('closed port');messages.push(data);this.other.onmessage?.({data});}}
 globalThis.MessageChannel=class{constructor(){this.port1=new Port();this.port2=new Port();this.port1.other=this.port2;this.port2.other=this.port1;channels.push(this);}};
 const document={location:{origin:'http://editor.test'},createElement(){const frame={removed:false,setAttribute(){},remove(){this.removed=true;const i=attached.indexOf(this);if(i>=0)attached.splice(i,1);},contentWindow:{postMessage(identity,origin,[remote]){assert.equal(origin,'http://preview.test');frame.remote=remote;frame.identity=identity;remote.onmessage=({data})=>{if(data.type==='stop'){remote.postMessage({...identity,protocolVersion:PREVIEW_PROTOCOL,type:'exited',code:0});remote.close();}};}}};frames.push(frame);return frame;}};
 const container={ownerDocument:document,append(frame){attached.push(frame);}};
 const runner=new PreviewRunner({container,previewUrl:'http://preview.test/preview.html',release});
 const send=(frame,fields)=>frame.remote?.postMessage({...frame.identity,protocolVersion:PREVIEW_PROTOCOL,...fields});
 const drive=async()=>{await flush();const frame=attached.at(-1);if(!frame)return;frame.onload?.();if(frame.removed)return;send(frame,{type:'connected'});for(const phase of phases){if(frame.removed)break;send(frame,{type:'phase',phase});}await flush();};
 return {runner,timers,channels,attached,frames,messages,send,drive,async close(){await runner.dispose();for(const c of channels){c.port1.close();c.port2.close();}assert.equal(timers.size,0,'No expired phase or heartbeat timer survives');for(const [k,v]of Object.entries(originals))globalThis[k]=v;}};
}

test('synchronous stop and dispose in every startup state create no retired frame, timer or false success',async t=>{
 for(const action of ['stop','dispose'])for(const state of ['loading-frame','handshaking','downloading',...phases])await t.test(action+' at '+state,async()=>{
  const f=fixture();let stopped,observed=false;
  f.runner.subscribe(event=>{if(event.type==='state'&&event.state===state&&!observed){observed=true;stopped=f.runner[action]();}});
  try{
   const run=f.runner.run(artifact);const rejected=assert.rejects(run,/E_RUN_ENDED/);
   await f.drive();await rejected;await stopped;
   assert(observed);assert.equal(f.attached.length,0);assert.equal(f.timers.size,0);
   if(state==='loading-frame')assert(f.channels[0].port1.closed&&f.channels[0].port2.closed,'Both untransferred ports close');
   if(state==='downloading')assert(!f.messages.some(m=>m.type==='run'),'Cancelled download must not send the pack');
   if(state==='handshaking')assert.equal(f.frames[0].identity,undefined,'Cancelled handshake must not post to the retired frame');
  }finally{await f.close();}
 });
});

test('a replacement requested synchronously from every startup state is the only active run',async t=>{
 for(const state of ['loading-frame','handshaking','downloading',...phases])await t.test(state,async()=>{
  const f=fixture();let replacement,observed=false;
  f.runner.subscribe(event=>{if(event.type==='state'&&event.state===state&&!observed){observed=true;replacement=f.runner.run({...artifact,revision:2});}});
  try{
   const first=f.runner.run(artifact);const rejected=assert.rejects(first,/E_RUN_ENDED/);
   await f.drive();await rejected;await flush();await f.drive();
   assert.equal((await replacement).revision,2);assert.equal(f.attached.length,1);assert.equal(f.frames.length,2);
   assert(f.frames[0].removed);assert.equal(f.runner.state,'running');await f.runner.stop();
   assert.equal(f.attached.length,0);assert.equal(f.timers.size,0);
  }finally{await f.close();}
 });
});

test('exit-state listeners may replace a run without an old exit overwriting the new state',async()=>{
 const f=fixture();let replacement;let exits=0;
 f.runner.subscribe(event=>{if(event.type==='state'&&event.state==='exited'&&!replacement)replacement=f.runner.run({...artifact,revision:2});if(event.type==='exit')exits++;});
 try{
  const first=f.runner.run(artifact);await f.drive();await first;await f.runner.stop();await flush();await f.drive();
  assert.equal((await replacement).revision,2);assert.equal(f.runner.state,'running');assert.equal(exits,1);
 }finally{await f.close();}
});

test('an ended session keeps its first report and stale callbacks cannot end a replacement',async()=>{
 const f=fixture();
 try{
  const first=f.runner.run(artifact);await f.drive();await first;const session=f.runner.active;const oldHandler=session.port.onmessage;
  const report=await f.runner.stop();assert.equal(f.runner.finish(session,'crashed',99,'late'),report);
  const next=f.runner.run({...artifact,revision:2});await f.drive();await next;
  oldHandler({data:{...session.identity,protocolVersion:PREVIEW_PROTOCOL,type:'fatal',text:'late'}});
  assert.equal(f.runner.state,'running');assert.equal(f.attached.length,1);
 }finally{await f.close();}
});

test('phase listeners changing a live run to stopping cannot reinstall the original timer',async()=>{
 const f=fixture();let stopping;
 f.runner.subscribe(event=>{if(event.type==='state'&&event.state==='downloading')stopping=f.runner.stop();});
 try{
  const first=f.runner.run(artifact);const rejected=assert.rejects(first,/E_RUN_ENDED/);await f.drive();await rejected;await stopping;
  assert.equal(f.timers.size,0);
 }finally{await f.close();}
});

test('diagnostics retain standard Error stack and reject malformed or oversized payloads',()=>{
 const identity={runId:'a',revision:1,generation:1,buildKey:'hash',protocolVersion:PREVIEW_PROTOCOL,type:'fatal',text:'failure'};
 const error=new Error('P0_PROMISE_ERROR');const diagnostic=previewDiagnostic(error);
 assert.match(diagnostic.stack,/P0_PROMISE_ERROR/);assert.equal(diagnostic.message,'P0_PROMISE_ERROR');
 assert(isPreviewEnvelope({...identity,diagnostic}));assert(isPreviewEnvelope(identity),'Legacy fatal text remains accepted');
 assert(!isPreviewEnvelope({...identity,diagnostic:{...diagnostic,stack:'x'.repeat(32769)}}));
 assert(!isPreviewEnvelope({...identity,diagnostic:{...diagnostic,line:NaN}}));
 let getterCalls=0;const hostile={get message(){getterCalls++;throw Error('must not run');},get stack(){getterCalls++;return 'unsafe';},toJSON(){throw Error('must not stringify');}};
 assert.equal(previewDiagnostic(hostile).message,'Unhandled preview error');assert.equal(getterCalls,0);
 assert.equal(previewDiagnostic(new Proxy({}, {getOwnPropertyDescriptor(){throw Error('bad descriptor');}})).message,'Unhandled preview error');
 const located=previewDiagnostic(undefined,{message:'fallback',filename:'res://src/main.ts',line:4,column:7});assert.equal(located.filename,'res://src/main.ts');assert.equal(located.message,'fallback');
 assert.equal(previewDiagnostic(null,{message:'script error'}).message,'script error');
});

test('fatal diagnostic reaches the terminal report without being truncated into detail',async()=>{
 const f=fixture();
 try{
  const run=f.runner.run(artifact);await f.drive();await run;const frame=f.attached[0];
  const diagnostic={source:'browser',message:'failure',stack:'Error: failure\n at res://src/main.ts:4:7\n'+'x'.repeat(6000)};
  const session=f.runner.active;f.send(frame,{type:'fatal',text:'failure',diagnostic});
  const report=await session.exitPromise;assert.equal(report.diagnostic.stack,diagnostic.stack);assert.equal(report.detail,'failure');
 }finally{await f.close();}
});
