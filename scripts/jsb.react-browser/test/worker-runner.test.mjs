import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkerPreviewRunner} from '../dist/worker-runner.js';
import {WORKER_PROTOCOL} from '../dist/worker-protocol.js';
import {boundedWorkerCleanup} from '../dist/worker-session.js';

const asset=name=>({url:`http://preview.test/${name}`,sha256:'a'.repeat(64)});
const release={releaseId:'worker-test',profile:'core-ui-v1',engineJs:asset('godot.js'),engineWasm:asset('godot.wasm'),
 runtimeWorker:asset('runtime.worker.js'),runtimeAudioWorklet:asset('runtime.audio.worklet.js'),runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1}};
const artifact={revision:'revision-1',buildKey:'build-1',generation:42,pack:new Uint8Array([1,2,3]),manifest:{generation:42}};
const phases=['preloading','initializing','starting','waiting-ready','running'];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)assert.fail('Timed out waiting for runner state');await pause(1);}}
const clean={engineOutcome:{kind:'native-exit',code:0},hostCleanup:{status:'complete'}};

function fixture({pauseAt,frameLoad=true,connect=true,heartbeat=true,stopReply=clean,deadlines={},configuration,release:descriptor=release}={}){
 const frames=[],hosts=[],events=[],messages=[],intervals=[];
 const document={location:{origin:'http://editor.test'},visibilityState:'visible',createElement(){
  const frame={attributes:{},setAttribute(name,value){this.attributes[name]=value;},remove(){this.removed=true;},contentWindow:{
   postMessage(identity,origin,ports){
    assert.equal(origin,'http://preview.test');assert.equal(identity.editorOrigin,'http://editor.test');
    const port=ports[0],host={identity,port,sequence:0,resumeEpoch:0,send(fields){port.postMessage({...identity,protocolVersion:WORKER_PROTOCOL,...fields});}};
    hosts.push(host);port.unref?.();
    port.onmessage=event=>{
     const message=event.data;messages.push(message);
     if(message.type==='stop'){
      if(stopReply)void Promise.resolve(typeof stopReply==='function'?stopReply(host,message):stopReply).then(reply=>{if(reply)host.send({type:'exit-report',...reply});});
      return;
     }
     if(message.type!=='run')return;
     assert.equal(message.artifact.manifest.generation,message.generation);
     assert.equal(message.configuration.runtimeProtocolVersion,2);
     if(heartbeat)intervals.push(setInterval(()=>host.send({type:'worker-heartbeat',sequence:host.sequence++,resumeEpoch:host.resumeEpoch}),5));
     if(pauseAt==='downloading')return;
     for(const phase of phases){host.send({type:'phase',phase});if(phase===pauseAt)return;}
    };
    port.start();if(connect)host.send({type:'connected'});
   },
  }};frames.push(frame);return frame;
 }};
 const container={ownerDocument:document,append(frame){if(frameLoad)setTimeout(()=>frame.onload?.(),0);}};
 const runner=new WorkerPreviewRunner({container,previewUrl:'http://preview.test/preview.html',release:descriptor,configuration,
  deadlines:{'loading-frame':300,handshaking:300,downloading:300,preloading:300,initializing:300,starting:300,'waiting-ready':300,running:0,heartbeat:1000,stopping:30,...deadlines}});
 runner.subscribe(event=>events.push(event));
 return {runner,document,frames,hosts,events,messages,get host(){return hosts.at(-1);},
  async cleanup(){intervals.forEach(clearInterval);await runner.dispose();hosts.forEach(host=>host.port.close());}};
}

for(const {name,budgets,texts,expected}of [
 {name:'higher configured count and byte limits',budgets:{maxLogMessages:1500,maxLogBytes:1000000},texts:Array(1501).fill('x'.repeat(256)),expected:Array(1500).fill('x'.repeat(256))},
 {name:'UTF-8 bytes and rejected-log credit',budgets:{maxLogMessages:2,maxLogBytes:6},texts:['汉汉汉','汉','abc','x'],expected:['汉','abc']},
 {name:'zero configured count',budgets:{maxLogMessages:0,maxLogBytes:100},texts:['hidden'],expected:[]},
 {name:'zero configured bytes',budgets:{maxLogMessages:10,maxLogBytes:0},texts:['hidden'],expected:[]},
])test('editor log forwarding honors '+name,async()=>{
 const f=fixture({configuration:{budgets},heartbeat:false});
 try{
  await f.runner.run(artifact);
  for(const text of texts)f.host.send({type:'log',level:'log',text});
  f.host.send({type:'project',data:{type:'log-barrier'}});await until(()=>f.events.some(e=>e.type==='project'&&e.data.type==='log-barrier'));
  assert.deepEqual(f.events.filter(e=>e.type==='log').map(e=>e.text),expected);
 }finally{await f.cleanup();}
});

test('editor commands keep count and UTF-8 byte credits until their exact Worker consumption receipts',async()=>{
 const f=fixture({configuration:{budgets:{maxProjectEvents:2,maxProjectBytes:128}}});
 try{
  await f.runner.run(artifact);const data={type:'knob',value:'x'.repeat(32)};
  assert.equal(f.runner.command(data),true);assert.equal(f.runner.command(data),true);assert.equal(f.runner.command(data),false);
  await until(()=>f.messages.filter(m=>m.type==='project-command').length===2);
  const commands=f.messages.filter(m=>m.type==='project-command');assert.deepEqual(commands.map(m=>m.commandSequence),[1,2]);
  f.host.send({type:'project-command-receipt',commandSequence:1,workerId:'retired'});await pause(5);assert.equal(f.runner.command(data),false);
  f.host.send({type:'project-command-receipt',commandSequence:1});await pause(5);assert.equal(f.runner.command(data),true);
  f.host.send({type:'project-command-receipt',commandSequence:1});await pause(5);assert.equal(f.runner.command(data),false,'duplicate ACK cannot spend another ticket');
  f.host.send({type:'project-command-receipt',commandSequence:2});await pause(5);
  assert.equal(f.runner.command({type:'knob',value:'界'.repeat(48)}),false,'UTF-8 bytes, not JS character count');assert.equal(f.runner.command(data),true);
  await f.runner.stop();assert.equal(f.runner.command(data),false);
  const old=f.host;await f.runner.run({...artifact,revision:2});assert.equal(f.runner.command(data),true);assert.equal(f.runner.command(data),true);
  old.send({type:'project-command-receipt',commandSequence:1});await pause(5);assert.equal(f.runner.command(data),false,'retired run cannot free current credits');
 }finally{await f.cleanup();}
});

test('Worker runner rejects protocol 1 handshake and legacy exited receipts',async()=>{
 const f=fixture({connect:false});
 try{
  const running=f.runner.run(artifact);await until(()=>f.host);
  f.host.send({type:'connected',protocolVersion:1});await pause(10);
  assert.equal(f.runner.state,'handshaking');assert.equal(f.messages.length,0);
  f.host.send({type:'connected'});const result=await running;
  assert.equal(result.state,'running');assert.equal(result.documentId,f.host.identity.documentId);
  f.host.send({type:'exited',protocolVersion:1,code:0});f.host.send({type:'exited',code:0});await pause(10);
  assert.equal(f.runner.state,'running');assert.equal(f.events.filter(event=>event.type==='exit').length,0);
  assert.equal((await f.runner.stop()).reason,'clean-exit');
 }finally{await f.cleanup();}
});

test('every identity component fences telemetry and exit receipts',async()=>{
 const f=fixture();
 try{
  const result=await f.runner.run(artifact);
  for(const key of ['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash']){
   const invalid=key==='runConfigurationHash'?'b'.repeat(64):'stale';
   f.host.send({type:'exit-report',...clean,[key]:invalid});
   f.host.send({type:'project',data:{type:'stats',key},[key]:invalid});
  }
  f.host.send({type:'exit-report',...clean,documentId:undefined});await pause(10);
  assert.equal(f.runner.state,'running');assert.equal(f.events.filter(event=>event.type==='project'||event.type==='exit').length,0);
  assert.equal(artifact.pack.byteLength,3,'runner transfers its snapshot only');
  const sent=f.messages.find(message=>message.type==='run');assert.equal(sent.runConfigurationHash,result.runConfigurationHash);
  f.host.send({type:'project',data:{type:'stats',frames:1}});await until(()=>f.events.some(event=>event.type==='project'));
  assert.equal((await f.runner.stop()).reason,'clean-exit');
 }finally{await f.cleanup();}
});

test('phase notifications cannot bypass the connected handshake and artifact dispatch',async()=>{
 const f=fixture({connect:false});
 try{
  const pending=f.runner.run(artifact);await until(()=>f.host);
  for(const phase of ['downloading',...phases])f.host.send({type:'phase',phase});await pause(10);
  assert.equal(f.runner.state,'handshaking');assert.equal(f.messages.some(message=>message.type==='run'),false);
  f.host.send({type:'connected'});assert.equal((await pending).state,'running');
  assert.equal(f.messages.filter(message=>message.type==='run').length,1);
 }finally{await f.cleanup();}
});

test('missing host Worker termination receipt is only forced frame disposal',async()=>{
 const f=fixture({stopReply:false});
 try{
  await f.runner.run(artifact);const report=await f.runner.stop();
  assert.equal(report.reason,'forced-frame-disposal');assert.equal(Object.hasOwn(report,'code'),false);
  assert.equal(f.frames[0].removed,true);assert.equal(f.messages.filter(message=>message.type==='stop').length,1);
  assert.equal(f.events.filter(event=>event.type==='exit').length,1);
 }finally{await f.cleanup();}
});

test('only native zero plus complete host cleanup is clean',async t=>{
 for(const [outcome,cleanup,reason,code]of [
  [{kind:'native-exit',code:0},{status:'complete'},'clean-exit',0],
  [{kind:'native-exit',code:0},{status:'failed'},'crashed',0],
  [{kind:'native-exit',code:0},{status:'timed-out'},'crashed',0],
  [{kind:'native-exit',code:7},{status:'complete'},'crashed',7],
  [{kind:'terminate-issued'},{status:'complete'},'forced-worker-termination',undefined],
  [{kind:'startup-failed'},{status:'complete'},'crashed',undefined],
 ])await t.test(`${outcome.kind}/${outcome.code??'-'}/${cleanup.status}`,async()=>{
  const f=fixture({stopReply:{engineOutcome:outcome,hostCleanup:cleanup}});
  try{await f.runner.run(artifact);const report=await f.runner.stop();assert.equal(report.reason,reason);assert.deepEqual(report.engineOutcome,outcome);assert.deepEqual(report.hostCleanup,cleanup);
   if(code===undefined)assert.equal(Object.hasOwn(report,'code'),false);else assert.equal(report.code,code);
  }finally{await f.cleanup();}
 });
});

test('incomplete or malformed exit receipts cannot manufacture clean exit',async()=>{
 const f=fixture();
 try{
  await f.runner.run(artifact);
  for(const receipt of [{engineOutcome:{kind:'native-exit',code:0}},
   {hostCleanup:{status:'complete'}},{...clean,engineOutcome:{kind:'native-exit',code:Infinity}},
   {...clean,hostCleanup:{status:'unknown'}},{...clean,engineOutcome:{kind:'native-exit',code:0,unexpected:true}},
   {...clean,detail:{invalid:'must reject before slice'}}])f.host.send({type:'exit-report',...receipt});
  await pause(10);assert.equal(f.runner.state,'running');assert.equal(f.events.filter(event=>event.type==='exit').length,0);
  await f.runner.stop();
 }finally{await f.cleanup();}
});

test('native zero with stalled host cleanup settles without a clean exit and permits the next run',async()=>{
 const f=fixture({deadlines:{stopping:100},stopReply:async()=>({engineOutcome:{kind:'native-exit',code:0},
  hostCleanup:await boundedWorkerCleanup(()=>new Promise(()=>{}),10)})});
 try{
  const first=await f.runner.run(artifact);
  const result=await f.runner.run({...artifact,revision:'after-cleanup-timeout'});
  const report=f.events.find(event=>event.type==='exit').report;
  assert.equal(report.runId,first.runId);assert.equal(report.reason,'crashed');assert.equal(report.code,0);
  assert.equal(report.hostCleanup.status,'timed-out');assert.equal(f.frames[0].removed,true);
  assert.equal(result.revision,'after-cleanup-timeout');assert.equal(f.runner.state,'running');assert.equal(f.frames.length,2);
 }finally{await f.cleanup();}
});

test('startup cancellation fences every phase and never accepts late readiness',async t=>{
 for(const phase of ['loading-frame','handshaking','downloading',...phases])await t.test(phase,async()=>{
  const f=fixture({pauseAt:phase,frameLoad:phase!=='loading-frame',connect:phase!=='handshaking',stopReply:{engineOutcome:{kind:'terminate-issued'},hostCleanup:{status:'complete'}}});
  try{
   const running=f.runner.run(artifact),settled=phase==='running'?running:assert.rejects(running,/E_RUN_ENDED/);
   await until(()=>f.runner.state===phase);const host=f.host;const report=await f.runner.stop();await settled;
   assert.equal(report.reason,['loading-frame','handshaking'].includes(phase)?'forced-frame-disposal':'forced-worker-termination');
   assert.equal(Object.hasOwn(report,'code'),false);assert.equal(f.frames[0].removed,true);
   host?.send({type:'phase',phase:'running'});await pause(1);
   assert.equal(f.runner.state,'exited');assert.equal(f.events.filter(event=>event.type==='exit').length,1);
  }finally{await f.cleanup();}
 });
});

test('rapid run replacement stops the previous host and allocates only the newest pending frame',async()=>{
 const f=fixture({stopReply:false});
 try{
  const first=await f.runner.run(artifact),old=f.host;
  const middle=f.runner.run({...artifact,revision:'middle'}),middleRejected=assert.rejects(middle,{name:'AbortError'});
  const latest=f.runner.run({...artifact,revision:'latest'});const result=await latest;await middleRejected;
  assert.equal(result.revision,'latest');assert.notEqual(result.runId,first.runId);assert.notEqual(result.documentId,first.documentId);assert.notEqual(result.workerId,first.workerId);
  assert.equal(f.frames.length,2);assert.equal(f.frames[0].removed,true);assert.equal(f.runner.state,'running');
  old.send({type:'exit-report',...clean});old.send({type:'project',data:{type:'stats'}});await pause(5);
  assert.equal(f.runner.state,'running');assert.equal(f.events.filter(event=>event.type==='project').length,0);
  assert.equal(f.events.filter(event=>event.type==='exit').length,1);
 }finally{await f.cleanup();}
});

test('stop before asynchronous configuration hashing finishes prevents frame allocation',async()=>{
 const f=fixture();
 try{
  const pending=f.runner.run(artifact),rejected=assert.rejects(pending,{name:'AbortError'});
  assert.equal(await f.runner.stop(),undefined);await rejected;
  assert.equal(f.frames.length,0);assert.equal(f.events.filter(event=>event.type==='exit').length,0);
 }finally{await f.cleanup();}
});

test('a superseded configuration digest cannot stop a newer running session',async()=>{
 const f=fixture(),subtle=globalThis.crypto.subtle,original=subtle.digest,gates=[];
 subtle.digest=async function(...args){await new Promise(resolve=>gates.push(resolve));return Reflect.apply(original,this,args);};
 try{
  const stale=f.runner.run({...artifact,revision:'stale'}),rejected=assert.rejects(stale,{name:'AbortError'});
  const latest=f.runner.run({...artifact,revision:'latest'});
  await until(()=>gates.length===2);gates[1]();const result=await latest;
  gates[0]();await rejected;
  assert.equal(result.revision,'latest');assert.equal(f.runner.state,'running');
  assert.equal(f.frames.length,1);assert.equal(f.frames[0].removed,undefined);
  assert.equal(f.messages.some(message=>message.type==='stop'),false);
  assert.equal(f.events.some(event=>event.type==='exit'),false);
 }finally{subtle.digest=original;gates.forEach(resolve=>resolve());await f.cleanup();}
});

test('the run identity and transferred pack share one immutable artifact snapshot',async()=>{
 const f=fixture(),input={...artifact,pack:artifact.pack.slice(),manifest:{generation:artifact.generation}};
 try{
  const pending=f.runner.run(input);
  input.revision='changed-during-hash';input.buildKey='changed-during-hash';input.generation=99;input.manifest.generation=99;input.pack[0]=99;
  const result=await pending,sent=f.messages.find(message=>message.type==='run');
  assert.equal(result.revision,artifact.revision);assert.equal(result.buildKey,artifact.buildKey);assert.equal(result.generation,artifact.generation);
  assert.equal(sent.artifact.generation,result.generation);assert.equal(sent.artifact.manifest.generation,result.generation);assert.equal(sent.artifact.pack[0],1);
 }finally{await f.cleanup();}
});

test('duplicate exit receipts settle the run and emit exit exactly once',async()=>{
 const f=fixture();
 try{
  await f.runner.run(artifact);
  f.host.send({type:'exit-report',...clean});f.host.send({type:'exit-report',engineOutcome:{kind:'terminate-issued'},hostCleanup:{status:'timed-out'}});
  await until(()=>f.runner.state==='exited');await pause(5);
  const exits=f.events.filter(event=>event.type==='exit');assert.equal(exits.length,1);assert.equal(exits[0].report.reason,'clean-exit');
  assert.equal(await f.runner.stop(),undefined);assert.equal(f.frames[0].removed,true);
 }finally{await f.cleanup();}
});

test('old heartbeat epoch and duplicate sequence cannot replay liveness after resume',async()=>{
 const f=fixture({heartbeat:false,deadlines:{heartbeat:60},stopReply:{engineOutcome:{kind:'terminate-issued'},hostCleanup:{status:'complete'}}});let stale;
 try{
  await f.runner.run(artifact);f.host.send({type:'worker-heartbeat',sequence:10,resumeEpoch:0});
  f.host.send({type:'visibility',visible:true,resumeEpoch:1});f.host.send({type:'worker-heartbeat',sequence:1,resumeEpoch:1});
  stale=setInterval(()=>{f.host.send({type:'worker-heartbeat',sequence:999,resumeEpoch:0});f.host.send({type:'worker-heartbeat',sequence:1,resumeEpoch:1});},5);
  await until(()=>f.runner.state==='exited');
  assert.equal(f.events.find(event=>event.type==='exit').report.reason,'forced-worker-termination');
  assert.match(f.messages.find(message=>message.type==='stop').detail,/heartbeat/i);
 }finally{clearInterval(stale);await f.cleanup();}
});

test('heartbeat cannot invent future resume epochs to reset the watchdog',async()=>{
 const f=fixture({heartbeat:false,deadlines:{heartbeat:60},stopReply:clean});let replay;
 try{
  await f.runner.run(artifact);let epoch=1;
  replay=setInterval(()=>f.host.send({type:'worker-heartbeat',sequence:0,resumeEpoch:epoch++}),5);
  await pause(150);assert.equal(f.runner.state,'exited','only a host visibility control message can authorize the next epoch');
 }finally{clearInterval(replay);await f.cleanup();}
});

test('native ready events emitted during startup are buffered in order and acknowledged after delivery',async()=>{
 const f=fixture({pauseAt:'starting'});
 try{
  const running=f.runner.run(artifact);await until(()=>f.runner.state==='starting');
  f.host.send({type:'project',projectSequence:1,data:{type:'native-ready'}});
  f.host.send({type:'project',projectSequence:2,data:{type:'native-size',width:320}});
  await pause(10);assert.equal(f.events.filter(event=>event.type==='project').length,0);
  assert.equal(f.messages.filter(message=>message.type==='project-receipt').length,0);
  f.host.send({type:'phase',phase:'waiting-ready'});f.host.send({type:'phase',phase:'running'});await running;
  await until(()=>f.messages.filter(message=>message.type==='project-receipt').length===2);
  assert.deepEqual(f.events.filter(event=>event.type==='project').map(event=>event.data.type),['native-ready','native-size']);
  assert.deepEqual(f.messages.filter(message=>message.type==='project-receipt').map(message=>message.projectSequence),[1,2]);
 }finally{await f.cleanup();}
});

test('startup project events are bounded and a fault cannot be reported as a clean run',async()=>{
 const f=fixture({pauseAt:'starting'});
 try{
  const running=f.runner.run(artifact);const ended=assert.rejects(running,/E_RUN_ENDED/);await until(()=>f.runner.state==='starting');
  for(let i=1;i<=65;i++)f.host.send({type:'project',projectSequence:i,data:{type:'flood',i}});
  await ended;await until(()=>f.runner.state==='exited');
  const exit=f.events.find(event=>event.type==='exit').report;
  assert.equal(exit.code,0);assert.equal(exit.reason,'crashed');assert.match(exit.diagnostic.message,/budget/i);
  assert.equal(f.events.filter(event=>event.type==='project').length,0);
 }finally{await f.cleanup();}
});

test('runner resolves relative release against preview rather than editor before crossing MessagePort',async()=>{
 const relative=structuredClone(release);for(const key of ['engineJs','engineWasm','runtimeWorker','runtimeAudioWorklet'])relative[key].url='./'+key+'.js';const before=structuredClone(relative),f=fixture({release:relative});
 try{await f.runner.run(artifact);const sent=f.messages.find(m=>m.type==='run').release;for(const key of ['engineJs','engineWasm','runtimeWorker','runtimeAudioWorklet'])assert.equal(sent[key].url,'http://preview.test/'+key+'.js');assert.deepEqual(relative,before);}finally{await f.cleanup();}
});
