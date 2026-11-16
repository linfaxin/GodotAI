import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PreviewRunner} from '../dist/runner.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const code=(await build({entryPoints:[path.join(root,'apps/playground/preview-pthread.ts')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',plugins:[{name:'test-engine-loader',setup(builder){builder.onResolve({filter:/(?:^@godot-js\/engine\/browser\/verified-loader$|verified-loader\.js$)/},()=>({path:'loader',namespace:'test'}));builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export function loadVerifiedEngine(...args){ return globalThis.__load(...args); }',loader:'js'}));}}]})).outputFiles[0].text;
const identity={runId:'preview-test',revision:1,generation:'gen',buildKey:'build'};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function fixture(load,{execution,Worker,AudioContext}={}){
 const listeners=new Map(),messages=[],timers=new Set();let id=0;
 const console={log(){},warn(){},error(){}};const originalLog=console.log;
 const parent={postMessage(){}};
 const port={onmessage:null,closed:0,start(){},close(){this.closed++;},postMessage(message){assert.equal(this.closed,0,'Terminal telemetry must be sent before closing the control port');messages.push(message);}};
 const sandbox={Worker,AudioContext,Blob,URL,Uint8Array,AbortController,DOMException,queueMicrotask,setTimeout,clearTimeout,console,parent,location:{href:'http://preview.test/preview.html?editorOrigin=http://editor.test'},document:{getElementById(){return{hidden:false};}},
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
  setInterval(){const handle=++id;timers.add(handle);return handle;},clearInterval(handle){timers.delete(handle);},requestAnimationFrame(callback){callback();},__load:load};
 // Production preview shortcuts register on window; this realm's window is
 // the same event target/global as its existing lifecycle listeners.
 sandbox.window=sandbox;
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 for(const fn of listeners.get('message'))fn({origin:'http://editor.test',source:parent,ports:[port],data:{...identity,type:'connect',protocolVersion:1,editorOrigin:'http://editor.test'}});
 const event=(name,value)=>{for(const fn of [...listeners.get(name)??[]])fn(value);};
 return{sandbox,port,messages,timers,listeners,originalLog,event,packet(value){return vm.runInContext('('+JSON.stringify(value)+')',sandbox);},run(){port.onmessage({data:{...identity,type:'run',protocolVersion:1,artifact:{pack:new Uint8Array([1]),compatibility:'legacy-artifact-v1'},release:{...(execution?{execution}:{})}}});},stop(){port.onmessage?.({data:{...identity,type:'stop',protocolVersion:1}});}};
}

async function runnerReport(terminal){
 let peer,runIdentity;
 const release={releaseId:'preview-lifecycle',profile:'core-ui-v1',engineJs:{url:'http://preview.test/godot.js',sha256:'a'.repeat(64)},engineWasm:{url:'http://preview.test/godot.wasm',sha256:'b'.repeat(64)}};
 const document={location:{origin:'http://editor.test'},defaultView:{crossOriginIsolated:true},createElement(){return {setAttribute(){},remove(){},contentWindow:{postMessage(packet,origin,ports){
  runIdentity=packet;peer=ports[0];
  const send=fields=>peer.postMessage({...runIdentity,...fields,protocolVersion:1});
  peer.onmessage=event=>{if(event.data.type==='run')for(const phase of ['preloading','initializing','starting','waiting-ready','running'])send({type:'phase',phase});};
  peer.start();send({type:'connected'});
 }}};}};
 const runner=new PreviewRunner({container:{ownerDocument:document,append(frame){queueMicrotask(()=>frame.onload());}},previewUrl:'http://preview.test/preview.html',release,allowLegacyArtifacts:true});
 let resolveExit;const exit=new Promise(resolve=>{resolveExit=resolve;});
 runner.subscribe(event=>{if(event.type==='exit')resolveExit(event.report);});
 await runner.run({revision:1,buildKey:'preview-lifecycle',generation:1,pack:new Uint8Array([1]),manifest:{generation:1}});
 peer.postMessage({...terminal,runId:runIdentity.runId,revision:runIdentity.revision,generation:runIdentity.generation,buildKey:runIdentity.buildKey,protocolVersion:1});
 try{return await exit;}finally{await runner.dispose();peer.close();}
}

test('the first browser failure remains the terminal fact when native quit also fails',async()=>{
 let config,f;
 f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{
  constructor(value){config=value;}async preloadFile(){}
  async init(){const host=f.sandbox.__godotjsRuntimeHost;host.assignRole('engine');host.beginNativeEpoch('native-A');}
  async start(){}
  requestQuit(){const host=f.sandbox.__godotjsRuntimeHost;host.reportDiagnostic(f.packet({kind:'runtime',message:'later cleanup failure'}));host.endNativeEpoch('native-A');config.onExit(0);}
 }}));
 f.run();await flush();f.event('error',{error:Error('first browser failure'),message:'first browser failure',preventDefault(){}});await flush();
 const terminal=f.messages.find(message=>message.type==='fatal');assert(terminal);
 const report=await runnerReport(terminal);
 assert.equal(report.reason,'crashed');assert.equal(report.diagnostic.message,'first browser failure');
 assert.equal(report.sessionFacts.failure.message,'first browser failure');assert.equal(report.sessionFacts.nativeExit.code,0);
});

for(const timedOut of [false,true])test('loader cleanup failure reports failed host cleanup'+(timedOut?' while preserving an audio timeout':''),async()=>{
 let config,f;
 const AudioContext=class{constructor(){this.state='running';}close(){return new Promise(()=>{});}};
 f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){throw Error('loader dispose failed');},Engine:class{
  constructor(value){config=value;}async preloadFile(){}
  async init(){const host=f.sandbox.__godotjsRuntimeHost;host.assignRole('engine');host.beginNativeEpoch('native-A');if(timedOut)new f.sandbox.AudioContext();}
  async start(){}requestQuit(){}
 }}),timedOut?{AudioContext}:{});
 f.run();await flush();f.sandbox.__godotjsRuntimeHost.endNativeEpoch('native-A');config.onExit(0);await flush();
 const deadline=Date.now()+3000;
 while(!f.messages.some(message=>message.type==='exited')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 const terminal=f.messages.find(message=>message.type==='exited');assert(terminal);
 const report=await runnerReport(terminal),expected=timedOut?'timed-out':'failed';
 assert(terminal.cleanup.errors.includes('loader dispose failed'));
 assert.equal(terminal.cleanup.status,expected);assert.equal(report.sessionFacts.hostCleanup,expected);
 assert.equal(report.reason,'host-cleanup-failed');assert.equal(report.code,0);
});

test('a loader resolving after stop disposes its late result and cannot construct an engine',async()=>{
 let resolve;let dispose=0,construct=0;
 const f=fixture(()=>new Promise(done=>resolve=done));f.run();await flush();f.stop();
 resolve({dispose(){dispose++;},Engine:class{constructor(){construct++;}}});await flush();
 assert.equal(dispose,1);assert.equal(construct,0);assert.equal(f.timers.size,0);assert.equal(f.sandbox.console.log,f.originalLog);
 assert.equal(f.port.closed,1);
 assert(!f.messages.some(m=>m.type==='fatal'||m.type==='exited'||m.phase==='running'));
});

test('Promise failures preserve source stack and cleanup only once even if quit exits synchronously',async()=>{
 let config;let dispose=0,quit=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){dispose++;},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){quit++;config.onExit(0);}}}));
 f.run();await flush();assert(f.messages.some(m=>m.phase==='running'));
 const error=new Error('P0_PROMISE_ERROR');error.stack='Error: P0_PROMISE_ERROR\n    at res://src/user.ts:9:4';
 let consumed=0;const event={reason:error,preventDefault(){consumed++;}};
 f.event('unhandledrejection',event);config.onExit(0);f.event('unhandledrejection',event);await flush();
 const fatal=f.messages.filter(m=>m.type==='fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.stack,error.stack);
 assert.equal(fatal[0].diagnostic.message,'P0_PROMISE_ERROR');assert(!f.messages.some(m=>m.type==='exited'));
 assert.equal(dispose,1);assert.equal(quit,1);assert.equal(f.timers.size,0);assert.equal(f.sandbox.console.log,f.originalLog);
 assert.equal(consumed,1,'Only the failure delivered to the parent is consumed');
 assert.equal(f.port.closed,1);
});

test('error events use the actual Error and retain fallback source coordinates',async()=>{
 let config;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){config.onExit(0);}}}));
 f.run();await flush();const error=new Error('script failure');
 let consumed=0;
 f.event('error',{error,message:'fallback',filename:'res://src/main.ts',lineno:4,colno:7,preventDefault(){consumed++;}});await flush();
 const fatal=f.messages.find(m=>m.type==='fatal');assert.equal(fatal.diagnostic.message,'script failure');assert.match(fatal.diagnostic.stack,/script failure/);
 assert.equal(fatal.diagnostic.filename,'res://src/main.ts');assert.equal(fatal.diagnostic.line,4);assert.equal(fatal.diagnostic.column,7);
 assert.equal(consumed,1,'The structured fatal replaces the browser default error report');
});

test('a rejection ignored during cooperative stop is not silently consumed',async()=>{
 let config;let consumed=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){}}}));
 f.run();await flush();f.stop();
 f.event('unhandledrejection',{reason:new Error('unexpected shutdown rejection'),preventDefault(){consumed++;}});
 assert.equal(consumed,0);assert(!f.messages.some(m=>m.type==='fatal'));
 config.onExit(0);await flush();assert.equal(f.messages.filter(m=>m.type==='exited').length,1);
});

test('normal exit after repeated stop remains one genuine exit, and ordinary Godot errors are logs',async()=>{
 let config;let dispose=0,quit=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){dispose++;},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){quit++;}}}));
 f.run();await flush();config.onPrintError('ordinary engine error');assert(!f.messages.some(m=>m.type==='fatal'));
 f.stop();f.stop();assert.equal(quit,1);assert(!f.messages.some(m=>m.type==='exited'));
 config.onExit(0);config.onExit(1);await flush();assert.equal(f.messages.filter(m=>m.type==='exited').length,1);assert.equal(f.messages.find(m=>m.type==='exited').code,0);
 assert.equal(dispose,1);assert.equal(f.timers.size,0);
 assert.equal(f.port.closed,1);
});

test('React failures preserve ErrorBoundary recovery and report an uncaught diagnostic only once',async()=>{
 let config,quit=0,disposed=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){disposed++;},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){quit++;config.onExit(0);}}}));
 f.run();await flush();const report=f.sandbox.__godotjsReportReactError;
 assert.equal(report(JSON.stringify({kind:'caught',message:'handled',stack:'at res://src/App.tsx:3:1'})),true);
 assert(!f.messages.some(message=>message.type==='fatal'));assert(f.messages.some(message=>message.type==='log'&&message.level==='warn'));
 const raw=JSON.stringify({kind:'uncaught',message:'failed',stack:'Error: failed\n at res://src/App.tsx:7:2'});
 report(raw);report(raw);await flush();
 const fatal=f.messages.filter(message=>message.type==='fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.source,'godotjs');assert.match(fatal[0].diagnostic.stack,/App.tsx:7:2/);
 assert.equal(quit,1);assert.equal(disposed,1);assert.equal(f.sandbox.__godotjsReportReactError,undefined);assert.equal(report(raw),false);
 assert.equal(f.timers.size,0);
});

test('pthread exit zero waits for the source summary and cannot erase a fatal arriving on the other transport',async()=>{
 let f,config,worker;
 class Thread extends EventTarget{constructor(){super();}postMessage(){}terminate(){}deliver(data){this.dispatchEvent(new MessageEvent('message',{data:f.packet(data)}));}}
 const execution={executionModel:'proxy-pthread'};
 f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{
  constructor(value){config=value;}
  async preloadFile(){}
  async init(){worker=new f.sandbox.Worker('https://preview.test/thread.js');
   const packet=(type,data)=>({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type,...data});
   worker.deliver(packet('role'));worker.deliver(packet('epoch',{data:{epoch:'native-A'}}));worker.deliver(packet('progress',{sequence:1}));
  }
  async start(){}requestQuit(){}
 }}),{execution,Worker:Thread});
 f.run();await flush();assert(f.messages.some(message=>message.phase==='running'),JSON.stringify(f.messages));
 config.onExit(0);await flush();assert(!f.messages.some(message=>message.type==='exited'||message.type==='fatal'));
 worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'summary',data:{schemaVersion:1,epoch:'native-A',sealed:true,overflow:false,entries:[],failure:{kind:'runtime',message:'latched before native exit'}}});
 await flush();
 const terminal=f.messages.find(message=>message.type==='fatal');assert(terminal);assert.equal(terminal.sessionFacts.nativeExit.code,0);assert.equal(terminal.sessionFacts.failure.message,'latched before native exit');assert.equal(terminal.sessionFacts.runtimeSummary,'sealed');
 assert(!f.messages.some(message=>message.type==='exited'));
});

test('native pthread closing cancels a startup wait without publishing a late running phase',async()=>{
 let f,config,worker;
 class Thread extends EventTarget{postMessage(){}terminate(){}deliver(data){this.dispatchEvent(new MessageEvent('message',{data:f.packet(data)}));}}
 f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{
  constructor(value){config=value;this.rtenv={_godotjs_release_exit(){}};}
  async preloadFile(){}
  async init(){worker=new f.sandbox.Worker('https://preview.test/thread.js');worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'role'});worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'epoch',data:{epoch:'native-A'}});}
  async start(){worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'closing'});}
  requestQuit(){throw Error('native quit must not be requested twice');}
 }}),{execution:{executionModel:'proxy-pthread',lifecycleAbi:1},Worker:Thread});
 f.run();await flush();assert(f.messages.some(m=>m.type==='closing'));assert(!f.messages.some(m=>m.phase==='running'||m.type==='fatal'));
 worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'progress',sequence:1});await flush();assert(!f.messages.some(m=>m.phase==='running'));
 worker.deliver({__godotjsRuntime:2,sessionId:identity.runId,workerId:1,role:'engine',type:'summary',data:{schemaVersion:1,epoch:'native-A',sealed:true,overflow:false,entries:[]}});config.onExit(0);await flush();
 assert.equal(f.messages.filter(m=>m.type==='exited').length,1);assert.equal(f.messages.find(m=>m.type==='exited').sessionFacts.runtimeSummary,'sealed');
});

test('managed fatal defers native quit and keeps its first failure when safe-point quit fails',async()=>{
 let f,quit=0;
 f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{
  constructor(){this.rtenv={_godotjs_release_exit(){}};}async preloadFile(){}async init(){}async start(){}
  requestQuit(){quit++;throw Error('later quit failure');}
 }}),{execution:{executionModel:'proxy-pthread',lifecycleAbi:1}});
 f.run();await flush();f.event('error',{error:Error('first managed browser failure'),message:'first managed browser failure',preventDefault(){}});
 assert.equal(quit,0,'native quit must wait until the error callback returns');await flush();
 const fatal=f.messages.find(m=>m.type==='fatal');assert(fatal);assert.equal(quit,1);assert.equal(fatal.diagnostic.message,'first managed browser failure');assert.equal(fatal.sessionFacts.failure.message,'first managed browser failure');assert.equal(fatal.sessionFacts.forcedTerminationIssued,true);
});
