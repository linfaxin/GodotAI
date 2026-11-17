import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {BrowserEngineSession,installWorkerRuntimeHost,runtimeWorkerBootstrap} from '../dist/engine-session.js';
import {createRuntimeBinding} from '../../../packages/engine/dist/runtime-host.js';
function installHost(scope,id){scope.globalThis=scope;vm.createContext(scope);vm.runInContext('('+installWorkerRuntimeHost.toString()+')('+JSON.stringify(identity.runId)+','+id+',('+createRuntimeBinding.toString()+'))',scope);}
const realm=(scope,value)=>vm.runInContext('('+JSON.stringify(value)+')',scope);

const identity={runId:'session-test',buildKey:'build-test',revision:1,generation:'gen-test'};
function fixture(){
 const workers=[],contexts=[],urls=new Map(),revoked=[],timers=new Map();let serial=0;
 class Target extends EventTarget{}
 class Worker extends Target{
  constructor(url,options){super();this.url=url;this.options=options;this.sent=[];this.terminated=0;workers.push(this);}
  postMessage(message){this.sent.push(message);}
  terminate(){this.terminated++;}
  deliver(message){this.dispatchEvent(new MessageEvent('message',{data:message}));}
 }
 class AudioContext{constructor(){this.state='running';this.closed=0;contexts.push(this);}async close(){this.closed++;this.state='closed';}}
 const scope={Worker,AudioContext,EventTarget:Target,crossOriginIsolated:true,SharedArrayBuffer,
  location:{href:'https://preview.test/preview.html'},URL:{createObjectURL(blob){const url='blob:test/'+(++serial);urls.set(url,blob);return url;},revokeObjectURL(url){revoked.push(url);}},
  setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},setInterval(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},clearInterval(id){timers.delete(id);}};
 return{scope,Worker,workers,contexts,urls,revoked,timers,Target};
}

test('native resource creation uses an explicit owner without replacing browser constructors',async()=>{
 const f=fixture(),originalAudio=f.scope.AudioContext;
 const session=new BrowserEngineSession({identity,scope:f.scope,hostResourceAbi:1});
 assert.equal(f.scope.AudioContext,originalAudio);
 const config={getModuleConfig(){return {};}};
 session.installResourceOwner({config});const module=config.getModuleConfig(),own=module.godotjsOwnResource;
 assert.throws(()=>session.attachEngine({rtenv:{}}),/E_HOST_RESOURCE_ABI/);
 session.attachEngine({rtenv:{godotjsHostResourceAbi:1}});
 const audio=new originalAudio();let stopped=0,closed=0,ports=0,lost=false;
 assert.equal(own('audio',audio),true);assert.equal(own('audio',audio),true);
 own('media',{getTracks:()=>[{readyState:'live',stop(){stopped++;}}]});
 own('network',{close(){closed++;}});own('port',{close(){ports++;}});
 own('gl',{isContextLost:()=>lost,getExtension:()=>({loseContext(){lost=true;}})});
 const receipt=await session.dispose('clean');
 assert.equal(receipt.status,'complete');assert.equal(receipt.audioContexts,1);assert.equal(audio.closed,1);
 assert.equal(stopped,1);assert.equal(closed,1);assert.equal(ports,1);assert.equal(lost,true);
 assert.equal(own('media',{getTracks:()=>[{stop(){stopped++;}}]}),false);
 assert.equal(own('network',{close(){closed++;}}),false);
 const lateAudio=new originalAudio();assert.equal(own('audio',lateAudio),false);
 await Promise.resolve();assert.equal(lateAudio.closed,1);assert.equal(stopped,2);assert.equal(closed,2);
 assert.equal(f.scope.AudioContext,originalAudio);
});

test('the window engine installs the same native owner lifecycle gate as worker backends',async()=>{
 const f=fixture();let closing=0,released=0;
 const session=new BrowserEngineSession({identity,scope:f.scope,onClosing(){closing++;}});
 const binding=f.scope.__godotjsRuntimeHost;binding.assignRole('engine');binding.beginNativeEpoch('window-owner');
 const module={godotjsLifecycleVersion:1,godotjsCheckpointAbi:1,godotjsReleaseExit(){released++;},godotjsScheduleCleanupCheckpoint(callback){void Promise.resolve().then(callback);return true;}};
 f.scope.__godotjsInstallLifecycle(module);module.godotjsBeginExit();
 for(let i=0;i<20;i++)await Promise.resolve();assert.equal(closing,1);assert.equal(released,1);
 const receipt=await session.dispose('clean');assert.equal(receipt.status,'complete');assert.equal(f.scope.__godotjsInstallLifecycle,undefined);assert.equal(module.godotjsBeginExit,undefined);
});

test('session tracks every pthread, only native engine progress counts, and stale messages cannot update it',async()=>{
 const f=fixture(),progress=[],roles=[],projects=[];
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread',requiresCrossOriginIsolation:true,onProgress:value=>progress.push(value),onWorkerRole:value=>roles.push(value),onProject:value=>projects.push(value)});
 const engine=new f.scope.Worker('https://preview.test/engine.worker.js'),script=new f.scope.Worker('https://preview.test/engine.worker.js');
 const packet=(worker,id,type,fields={})=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:id,type,role:'engine',...fields});
 packet(engine,1,'role');packet(script,2,'role',{role:'script-worker'});
 packet(script,2,'progress',{sequence:1,role:'script-worker'});packet(engine,1,'progress',{sequence:1});packet(engine,1,'progress',{sequence:1});packet(engine,1,'progress',{sequence:99,sessionId:'old-session'});
 assert.equal(progress.length,1);assert.deepEqual(roles.map(item=>item.role),['engine','script-worker']);
 packet(engine,1,'project',{data:{type:'chunk',text:'x'.repeat(65536)}});assert.equal(projects.length,1);
 assert.equal(session.command({type:'controls',speed:2}),true);assert.equal(engine.sent.filter(item=>item.type==='project-command').length,1);assert.equal(script.sent.length,0);
 assert.equal(engine.sent[0].sessionId,identity.runId);
 const source=await f.urls.get(engine.url).text();assert.match(source,/__godotjsRuntimeBootstrapConfig/);assert(source.includes('"url":"https://preview.test/engine.worker.js"'));assert.match(source,/importScripts/);assert(!source.includes('.toString()'));
 const cleanup=await session.dispose('forced');assert.equal(cleanup.workers,2);assert.equal(cleanup.terminatedWorkers,2);assert.equal(engine.terminated,1);assert.equal(script.terminated,1);
 assert.equal(session.command({type:'action'}),false);assert.equal(f.scope.Worker,f.Worker);assert.equal(f.revoked.length,2);
 packet(engine,1,'progress',{sequence:2});assert.equal(progress.length,1);
});

test('draining ignores late pthread progress while retaining final summary and consumption receipts',async()=>{
 const f=fixture(),progress=[];
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread',onProgress:value=>progress.push(value)});
 const worker=new f.scope.Worker('https://preview.test/thread.js');
 const send=(type,fields={})=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type,...fields});
 send('role');send('epoch',{data:{epoch:'native-A'}});session.beginDrain();send('progress',{sequence:1});
 send('project',{sequence:4,data:{type:'late-event'}});send('summary',{data:{schemaVersion:1,epoch:'native-A',sealed:true,overflow:false,entries:[]}});
 assert.equal(progress.length,0);assert(worker.sent.some(m=>m.type==='project-receipt'&&m.sequence===4));assert.equal(session.sessionFacts().runtimeSummary,'sealed');await session.dispose();
});

test('cleanup-only suppresses queued business timers and refuses new timer work',async()=>{
 const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope});let calls=0;
 f.scope.setTimeout(()=>calls++,0);f.scope.setInterval(()=>calls++,0);
 const pending=[...f.timers.values()];session.beginDrain();for(const callback of pending)callback();
 assert.equal(calls,0);assert.equal(f.scope.setTimeout(()=>calls++,0),0);assert.equal(f.scope.setInterval(()=>calls++,0),0);
 await session.dispose();assert.equal(calls,0);
});

test('native platform finish has a private cleanup scheduler after business admission closes',async()=>{
 const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope,hostResourceAbi:1});
 const config={getModuleConfig(){return {};}};session.installResourceOwner({config});const module=config.getModuleConfig();
 session.beginDrain();let completed=0;
 assert.equal(f.scope.setTimeout(()=>completed+=100,0),0);
 module.godotjsScheduleCleanup(()=>completed++);
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(completed,1);
 module.godotjsScheduleCleanup(()=>completed+=100);
 await session.dispose();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(completed,1);
});

test('whole-session disposal closes audio, pooled workers, timers, callbacks and canvas exactly once',async()=>{
 const f=fixture();const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 new f.scope.Worker('https://preview.test/thread.js');new f.scope.Worker('https://preview.test/thread.js');
 const audio=new f.scope.AudioContext();f.scope.setTimeout(()=>{throw Error('retired timer ran');},100);f.scope.setInterval(()=>{},100);
 const target=new f.Target();let clicks=0;target.addEventListener('click',()=>clicks++);target.dispatchEvent(new Event('click'));assert.equal(clicks,1);
 let pools=0,removed=0;const canvas={width:640,height:480,remove(){removed++;}};
 session.attachEngine({rtenv:{PThread:{terminateAllThreads(){pools++;}}},config:{canvas}});
 const first=session.dispose('clean'),second=session.dispose('forced');assert.equal(first,second);
 const receipt=await first;target.dispatchEvent(new Event('click'));
 assert.equal(receipt.mode,'clean');assert.equal(pools,1);assert.equal(audio.closed,1);assert.equal(receipt.closedAudioContexts,1);assert.equal(receipt.clearedTimers,2);assert.equal(f.timers.size,0);assert.equal(clicks,1);assert.equal(canvas.width,0);assert.equal(removed,1);
 assert.deepEqual(receipt.errors,[]);
 await new BrowserEngineSession({identity:{...identity,runId:'replacement'},scope:f.scope}).dispose();
});

test('isolation requirements fail before mutating the host realm',()=>{
 const f=fixture();f.scope.crossOriginIsolated=false;
 assert.throws(()=>new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread',requiresCrossOriginIsolation:true}),/E_SESSION_REQUIRES_ISOLATION/);
 assert.equal(f.scope.Worker,f.Worker);assert.equal(f.scope.__godotjsRuntimeHost,undefined);
});

test('trusted host gestures resume proxy audio and retired sessions remove their activation handlers',async()=>{
 const f=fixture(),listeners=new Map();let resumes=0;
 f.scope.addEventListener=(type,callback)=>listeners.set(type,callback);
 f.scope.removeEventListener=(type,callback)=>{if(listeners.get(type)===callback)listeners.delete(type);};
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 session.attachEngine({rtenv:{resumeAudio(){resumes++;}}});
 listeners.get('pointerdown')({isTrusted:false});assert.equal(resumes,0);
 listeners.get('pointerdown')({isTrusted:true});listeners.get('keydown')({isTrusted:true});assert.equal(resumes,2);
 const retired=listeners.get('pointerdown');await session.dispose();assert.equal(listeners.size,0);
 retired({isTrusted:true});assert.equal(resumes,2);
});

test('worker bootstrap binds native role, bounded diagnostics and commands without touching native transfer messages',async()=>{
 const sent=[],listeners=[];let time=1000;
 const scope={postMessage:message=>sent.push(message),addEventListener:(name,fn)=>listeners.push(fn),Date:{now:()=>time}};
 scope.globalThis=scope;
 installHost(scope,3);
 const host=scope.__godotjsRuntimeHost;assert.equal(host.role,'host');host.markProgress();assert.equal(sent.length,0);
 host.assignRole('engine');host.markProgress();host.markProgress();time+=300;host.markProgress();
 assert.deepEqual(sent.map(item=>item.type),['role','progress','progress']);assert.equal(host.reportDiagnostic(realm(scope,{message:'error',kind:'caught'})),true);
 assert.equal(host.emitProjectEvent(realm(scope,{type:'chunk',part:0,text:'asset'})),true);
 let stopped=0;listeners[0]({data:{__jsbMessage:true,data:'native'},stopImmediatePropagation(){stopped++;}});assert.equal(stopped,0);
 const command={data:{__godotjsRuntime:2,sessionId:identity.runId,type:'project-command',sequence:1,data:{type:'reset'}},stopImmediatePropagation(){stopped++;}};
 command.data=realm(scope,command.data);listeners[0](command);let received;host.bindProjectCommand(value=>{received=value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(received.type,'reset');assert.equal(stopped,1);
 assert.throws(()=>host.assignRole('script-worker'),/E_RUNTIME_ROLE_REASSIGN/);
 assert.match(runtimeWorkerBootstrap('https://preview.test/thread.mjs',identity.runId,4,true),/await import/);
});

test('registered script workers can report failures and logs but cannot fake engine progress or project events',async()=>{
 const f=fixture(),diagnostics=[],logs=[],progress=[],project=[];
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread',onDiagnostic:item=>diagnostics.push(item),onLog:(level,text)=>logs.push({level,text}),onProgress:item=>progress.push(item),onProject:item=>project.push(item)});
 const worker=new f.scope.Worker('https://preview.test/script.worker.js');
 const send=(type,fields={})=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'script-worker',type,...fields});
 send('role');send('diagnostic',{data:{kind:'runtime',message:'child failed',stack:'res://worker.ts:4:2'}});send('log',{data:{level:'error',text:'recoverable native error'}});send('progress',{sequence:1});send('project',{data:{type:'fake'}});
 assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].workerRole,'script-worker');assert.equal(diagnostics[0].workerId,1);assert.equal(logs.length,1);assert.equal(progress.length,0);assert.equal(project.length,0);
 await session.dispose();
});

test('session facts retain the host first failure over a later source cleanup failure',async()=>{
 const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 const worker=new f.scope.Worker('https://preview.test/thread.js');
 const send=(type,fields={})=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type,...fields});
 send('role');send('diagnostic',{data:{kind:'runtime',message:'later source cleanup failure'}});
 const first={kind:'runtime',message:'first host failure',stack:'at res://start.ts:7:2'};
 assert.deepEqual(session.sessionFacts({failure:first}).failure,first);
 assert.equal(session.sessionFacts().failure.message,'later source cleanup failure');
 await session.dispose();
});

test('worker async failures are reported after handlers can consume them, without turning ordinary logs into fatal errors',async()=>{
 const sent=[],listeners=new Map();
 const scope={postMessage:message=>sent.push(message),addEventListener:(name,fn)=>listeners.set(name,fn)};scope.globalThis=scope;
 installHost(scope,2);
 const host=scope.__godotjsRuntimeHost;host.assignRole('script-worker');host.reportLog('error','ordinary native error');
 const handled={reason:new Error('handled'),defaultPrevented:false};listeners.get('unhandledrejection')(handled);handled.defaultPrevented=true;
 const failure={reason:new Error('uncaught async worker failure'),defaultPrevented:false};listeners.get('unhandledrejection')(failure);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.filter(item=>item.type==='log').length,1);
 const diagnostics=sent.filter(item=>item.type==='diagnostic');assert.equal(diagnostics.length,1);assert.match(diagnostics[0].data.message,/uncaught async/);assert.equal(diagnostics[0].role,'script-worker');
});

test('worker console preserves DevTools output and forwards bounded safe logs without synthesizing fatal errors',()=>{
 const sent=[],original=[];let getters=0;
 const console=Object.fromEntries(['log','info','debug','warn','error'].map(level=>[level,(...args)=>original.push({level,args})]));
 const scope={console,postMessage:message=>sent.push(message),addEventListener(){}};scope.globalThis=scope;
 installHost(scope,2);
 scope.__godotjsRuntimeHost.assignRole('engine');
 const object={get message(){getters++;throw Error('getter must not run');},toJSON(){getters++;throw Error('serializer must not run');}};
 scope.console.log('WORKER_LOG',42,object);scope.console.warn('w'.repeat(5000));scope.console.error('ordinary error');scope.console.info('info');scope.console.debug('debug');
 assert.equal(original.length,5);assert.equal(getters,0);
 const logs=sent.filter(item=>item.type==='log');assert.equal(logs.length,5);assert.equal(logs[0].data.text,'WORKER_LOG 42 [object]');assert.equal(logs[1].data.text.length,4096);assert.equal(logs[2].data.level,'error');assert.equal(logs[3].data.level,'log');assert.equal(sent.filter(item=>item.type==='diagnostic').length,0);
 assert.equal(scope.console.error.__godotjsConsoleForwarded,true);
});

test('forced session cleanup stops microphone tracks and closes host networking after removing callbacks',async()=>{
 const f=fixture();let stops=0,socketEvents=0;
 const media={getTracks(){return[{readyState:'live',stop(){stops++;}}];}};
 f.scope.navigator={mediaDevices:{async getUserMedia(){return media;}}};
 class WebSocket extends f.Target{constructor(){super();this.closed=0;this.onclose=()=>socketEvents++;}close(){this.closed++;this.onclose?.();this.dispatchEvent(new Event('close'));}}
 f.scope.WebSocket=WebSocket;
 const original=f.scope.navigator.mediaDevices.getUserMedia;
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 await f.scope.navigator.mediaDevices.getUserMedia({audio:true});
 const socket=new f.scope.WebSocket('wss://server.test');socket.addEventListener('close',()=>socketEvents++);
 const receipt=await session.dispose('forced');assert.equal(stops,1);assert.equal(socket.closed,1);assert.equal(socketEvents,0);assert.equal(receipt.mediaStreams,1);assert.equal(receipt.stoppedMediaTracks,1);assert.equal(receipt.closedNetworkResources,1);assert.equal(f.scope.navigator.mediaDevices.getUserMedia,original);
});

test('media permission resolving after session end cannot leave a live microphone stream',async()=>{
 const f=fixture();let resolve,stops=0;
 f.scope.navigator={mediaDevices:{getUserMedia(){return new Promise(done=>resolve=done);}}};
 const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 const pending=f.scope.navigator.mediaDevices.getUserMedia({audio:true});await session.dispose();
 resolve({getTracks(){return[{stop(){stops++;}}];}});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(stops,1);
});

test('session closes both MessageChannel ends and AudioWorklet ports and loses only observed WebGL contexts',async()=>{
 const f=fixture();let portCloses=0,lossRequests=0,getContextCalls=0,removed=0,lost=false;
 const port=()=>({onmessage(){throw Error('retired port callback');},onmessageerror(){},close(){assert.equal(this.onmessage,null);assert.equal(this.onmessageerror,null);portCloses++;}});
 f.scope.MessageChannel=class{constructor(){this.port1=port();this.port2=port();}};
 f.scope.AudioWorkletNode=class{constructor(){this.port=port();}};
 const gl={isContextLost(){return lost;},getExtension(name){assert.equal(name,'WEBGL_lose_context');return{loseContext(){lost=true;lossRequests++;}};}};
 f.scope.HTMLCanvasElement=class extends f.Target{constructor(){super();this.width=128;this.height=128;}getContext(kind){getContextCalls++;return kind==='2d'?{}:gl;}remove(){removed++;}};
 const session=new BrowserEngineSession({identity,scope:f.scope});
 new f.scope.MessageChannel();new f.scope.AudioWorkletNode({},'mixer');const canvas=new f.scope.HTMLCanvasElement();canvas.getContext('2d');canvas.getContext('webgl2');
 const callsBeforeCleanup=getContextCalls;const receipt=await session.dispose('forced');
 assert.equal(receipt.messagePorts,3);assert.equal(receipt.closedMessagePorts,3);assert.equal(portCloses,3);assert.equal(receipt.glContexts,1);assert.equal(receipt.lostGlContexts,1);assert.equal(receipt.glLossRequested,1);assert.equal(lossRequests,1);assert.equal(getContextCalls,callsBeforeCleanup,'cleanup must not create an unrelated GL context');assert.equal(removed,1);assert.deepEqual(receipt.errors,[]);
});

test('native cleanup of a recorded GL context is idempotent at the session boundary',async()=>{
 const f=fixture();let lost=false,extensionReads=0;
 const gl={isContextLost(){return lost;},getExtension(){extensionReads++;throw Error('already lost context must not be queried');}};
 f.scope.HTMLCanvasElement=class extends f.Target{getContext(){return gl;}remove(){}};
 const session=new BrowserEngineSession({identity,scope:f.scope});new f.scope.HTMLCanvasElement().getContext('webgl');lost=true;
 const receipt=await session.dispose('clean');assert.equal(receipt.glContexts,1);assert.equal(receipt.lostGlContexts,1);assert.equal(receipt.glLossRequested,0);assert.equal(extensionReads,0);assert.deepEqual(receipt.errors,[]);
});

test('an audio close deadline settles once without letting a late close rewrite the receipt',async()=>{
 const f=fixture();let finishClose;
 f.scope.AudioContext=class{state='running';close(){return new Promise(resolve=>finishClose=resolve);}};
 const session=new BrowserEngineSession({identity,scope:f.scope,cleanupTimeoutMs:5});
 new f.scope.AudioContext();
 const receipt=await session.dispose('clean');
 assert.equal(receipt.status,'timed-out');assert.equal(receipt.closedAudioContexts,0);assert.match(receipt.errors[0],/E_SESSION_CLEANUP_TIMEOUT/);
 const snapshot=JSON.stringify(receipt);finishClose();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(JSON.stringify(receipt),snapshot);assert.equal(await session.dispose(),receipt);
});

test('pthread command credits are bounded and only exact consumption receipts release them',async()=>{
 const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'}),worker=new f.scope.Worker('https://preview.test/thread.js');
 const packet=(type,fields={})=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type,...fields});packet('role');
 for(let index=0;index<64;index++)assert.equal(session.command({index}),true);
 assert.equal(session.command({index:64}),false);
 packet('command-receipt',{sequence:999});assert.equal(session.command({index:65}),false);
 packet('command-receipt',{sequence:1,sessionId:'old'});assert.equal(session.command({index:66}),false);
 packet('command-receipt',{sequence:1});assert.equal(session.command({index:67}),true);
 session.beginDrain();assert.equal(session.command({index:68}),false);
 await session.dispose();
});

test('pthread runtime retains early commands until binding, deduplicates sequences and consumes without awaiting application work',async()=>{
 const sent=[],listeners=[];const scope={postMessage:message=>sent.push(message),addEventListener:(name,fn)=>{if(name==='message')listeners.push(fn);}};installHost(scope,4);
 const host=scope.__godotjsRuntimeHost;host.assignRole('engine');host.beginNativeEpoch('entry-test');const entry=host.openEntry();
 const command=(sequence,data)=>listeners[0]({data:realm(scope,{__godotjsRuntime:2,sessionId:identity.runId,type:'project-command',sequence,data}),stopImmediatePropagation(){}});
 command(1,{n:1});command(1,{n:99});assert.equal(sent.filter(packet=>packet.type==='command-receipt').length,0);
 let received,resolve;entry.host.bindProjectCommand(data=>{received=data;return new Promise(done=>resolve=done);});
 assert.equal(received,undefined);await new Promise(done=>setImmediate(done));assert.equal(received.n,1);
 assert.equal(sent.filter(packet=>packet.type==='command-receipt').length,1);
 entry.close();resolve();await new Promise(done=>setImmediate(done));
});

test('a native exit waits for every registered source epoch rather than the first sealed Worker',async()=>{
 const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread'});
 const engine=new f.scope.Worker('https://preview.test/thread.js'),script=new f.scope.Worker('https://preview.test/thread.js');
 const packet=(worker,id,role,type,data)=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:id,role,type,data});
 const summary=epoch=>({schemaVersion:1,epoch,sealed:true,overflow:false,entries:[]});
 packet(engine,1,'engine','role');packet(script,2,'script-worker','role');packet(engine,1,'engine','epoch',{epoch:'engine-A'});packet(script,2,'script-worker','epoch',{epoch:'script-A'});
 packet(engine,1,'engine','summary',summary('engine-A'));
 let settled=false;const wait=session.waitForRuntimeSummary(1000).then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);
 assert.equal(session.sessionFacts({nativeExit:{code:0}}).runtimeSummary,'unconfirmed');
 packet(script,2,'script-worker','summary',summary('script-A'));await wait;assert.equal(settled,true);
 assert.equal(session.sessionFacts({nativeExit:{code:0}}).runtimeSummary,'sealed');
 await session.dispose('clean');
});

test('source inventory overflow stays unconfirmed even when every retained epoch is sealed',async t=>{
 for(const local of [false,true])await t.test(local?'local realm':'pthread Worker',async()=>{
  const f=fixture(),session=new BrowserEngineSession({identity,scope:f.scope,executionModel:local?'window':'proxy-pthread'});
  let begin,end,inventory,summaries;
  if(local){
   const host=f.scope.__godotjsRuntimeHost;host.assignRole('engine');begin=epoch=>host.beginNativeEpoch(epoch);end=epoch=>host.endNativeEpoch(epoch);
   inventory=session.localEpochs;summaries=session.localSummaries;
  }else{
   const worker=new f.scope.Worker('https://preview.test/thread.js');
   const packet=(type,data)=>worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type,data});packet('role');
   begin=epoch=>packet('epoch',{epoch});end=epoch=>packet('summary',{schemaVersion:1,epoch,sealed:true,overflow:false,entries:[]});
   const record=[...session.workers.values()][0];inventory=record.epochs;summaries=record.summaries;
  }
  for(let index=0;index<256;index++){begin('epoch-'+index);end('epoch-'+index);}
  assert.equal(session.sessionFacts({nativeExit:{code:0},hostCleanup:'complete'}).runtimeSummary,'sealed');
  // An idempotent registration at capacity does not consume another slot.
  begin('epoch-255');end('epoch-255');assert.equal(session.sessionFacts().runtimeSummary,'sealed');
  begin('epoch-256');end('epoch-256');
  assert.equal(session.sessionFacts({nativeExit:{code:0},hostCleanup:'complete'}).runtimeSummary,'unconfirmed');
  assert.equal(inventory.size,256);assert.equal(summaries.size,256);
  await session.dispose('clean');
 });
});

test('browser-global failures after native sealing reach the live owner without reopening the entry',async t=>{
 for(const name of ['error','unhandledrejection'])await t.test(name,async()=>{
  const f=fixture(),diagnostics=[];
  const session=new BrowserEngineSession({identity,scope:f.scope,executionModel:'proxy-pthread',onDiagnostic:value=>diagnostics.push(value)});
  const worker=new f.scope.Worker('https://preview.test/thread.js'),listeners=new Map();
  const scope={postMessage:packet=>worker.deliver(structuredClone(packet)),addEventListener:(type,callback)=>listeners.set(type,callback)};installHost(scope,1);
  const binding=scope.__godotjsRuntimeHost;binding.assignRole('engine');binding.beginNativeEpoch('sealed-native');
  const entry=binding.openEntry();entry.ready(false);entry.close();binding.endNativeEpoch('sealed-native');
  assert.equal(session.sessionFacts({nativeExit:{code:0}}).runtimeSummary,'sealed');
  assert.equal(entry.host.reportDiagnostic(realm(scope,{kind:'runtime',message:'old scoped failure'})),false);
  const handled={defaultPrevented:false,...(name==='error'?{error:Error('consumed')}:{reason:Error('consumed')})};
  listeners.get(name)(handled);handled.defaultPrevented=true;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(diagnostics.length,0);
  const failure=Error('physical teardown failed after seal');
  listeners.get(name)({defaultPrevented:false,...(name==='error'?{error:failure}:{reason:failure})});
  assert.equal(diagnostics.length,0,'browser event handling still allows default prevention on the current stack');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].message,failure.message);
  const facts=session.sessionFacts({nativeExit:{code:0},hostCleanup:'complete'});
  assert.equal(facts.failure.message,failure.message);assert.equal(facts.runtimeSummary,'sealed');
  assert.equal(binding.snapshotSummary().failure,undefined,'a sealed source snapshot remains immutable');
  assert.equal(entry.host.emitProjectEvent(realm(scope,{type:'stale'})),false);
  await session.dispose('clean');
 });
});
