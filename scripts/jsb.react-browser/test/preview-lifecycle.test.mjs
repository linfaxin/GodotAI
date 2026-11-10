import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const code=(await build({entryPoints:[path.join(root,'apps/playground/preview.ts')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',plugins:[{name:'test-engine-loader',setup(builder){builder.onResolve({filter:/verified-loader\.js$/},()=>({path:'loader',namespace:'test'}));builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export function loadVerifiedEngine(...args){ return globalThis.__load(...args); }',loader:'js'}));}}]})).outputFiles[0].text;
const identity={runId:'preview-test',revision:1,generation:'gen',buildKey:'build'};
const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function fixture(load){
 const listeners=new Map(),messages=[],timers=new Set();let id=0;
 const console={log(){},warn(){},error(){}};const originalLog=console.log;
 const parent={postMessage(){}};
 const port={onmessage:null,start(){},postMessage(message){messages.push(message);}};
 const sandbox={URL,Uint8Array,AbortController,DOMException,queueMicrotask,console,parent,location:{href:'http://preview.test/preview.html?editorOrigin=http://editor.test'},document:{getElementById(){return{hidden:false};}},
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
  setInterval(){const handle=++id;timers.add(handle);return handle;},clearInterval(handle){timers.delete(handle);},requestAnimationFrame(callback){callback();},__load:load};
 vm.runInNewContext(code,sandbox);
 for(const fn of listeners.get('message'))fn({origin:'http://editor.test',source:parent,ports:[port],data:{...identity,type:'connect',protocolVersion:1,editorOrigin:'http://editor.test'}});
 const event=(name,value)=>{for(const fn of [...listeners.get(name)??[]])fn(value);};
 return{sandbox,port,messages,timers,listeners,originalLog,event,run(){port.onmessage({data:{...identity,type:'run',protocolVersion:1,artifact:{pack:new Uint8Array([1])},release:{}}});},stop(){port.onmessage?.({data:{...identity,type:'stop',protocolVersion:1}});}};
}

test('a loader resolving after stop disposes its late result and cannot construct an engine',async()=>{
 let resolve;let dispose=0,construct=0;
 const f=fixture(()=>new Promise(done=>resolve=done));f.run();f.stop();
 resolve({dispose(){dispose++;},Engine:class{constructor(){construct++;}}});await flush();
 assert.equal(dispose,1);assert.equal(construct,0);assert.equal(f.timers.size,0);assert.equal(f.sandbox.console.log,f.originalLog);
 assert(!f.messages.some(m=>m.type==='fatal'||m.type==='exited'||m.phase==='running'));
});

test('Promise failures preserve source stack and cleanup only once even if quit exits synchronously',async()=>{
 let config;let dispose=0,quit=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){dispose++;},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){quit++;config.onExit(0);}}}));
 f.run();await flush();assert(f.messages.some(m=>m.phase==='running'));
 const error=new Error('P0_PROMISE_ERROR');error.stack='Error: P0_PROMISE_ERROR\n    at res://src/user.ts:9:4';
 let consumed=0;const event={reason:error,preventDefault(){consumed++;}};
 f.event('unhandledrejection',event);config.onExit(0);f.event('unhandledrejection',event);
 const fatal=f.messages.filter(m=>m.type==='fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.stack,error.stack);
 assert.equal(fatal[0].diagnostic.message,'P0_PROMISE_ERROR');assert(!f.messages.some(m=>m.type==='exited'));
 assert.equal(dispose,1);assert.equal(quit,1);assert.equal(f.timers.size,0);assert.equal(f.sandbox.console.log,f.originalLog);
 assert.equal(consumed,1,'Only the failure delivered to the parent is consumed');
});

test('error events use the actual Error and retain fallback source coordinates',async()=>{
 let config;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){config.onExit(0);}}}));
 f.run();await flush();const error=new Error('script failure');
 let consumed=0;
 f.event('error',{error,message:'fallback',filename:'res://src/main.ts',lineno:4,colno:7,preventDefault(){consumed++;}});
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
 config.onExit(0);assert.equal(f.messages.filter(m=>m.type==='exited').length,1);
});

test('normal exit after repeated stop remains one genuine exit, and ordinary Godot errors are logs',async()=>{
 let config;let dispose=0,quit=0;
 const f=fixture(async()=>({basePath:'/engine',installWorklets(){},dispose(){dispose++;},Engine:class{constructor(value){config=value;}async preloadFile(){}async init(){}async start(){}requestQuit(){quit++;}}}));
 f.run();await flush();config.onPrintError('ordinary engine error');assert(!f.messages.some(m=>m.type==='fatal'));
 f.stop();f.stop();assert.equal(quit,1);assert(!f.messages.some(m=>m.type==='exited'));
 config.onExit(0);config.onExit(1);assert.equal(f.messages.filter(m=>m.type==='exited').length,1);assert.equal(f.messages.find(m=>m.type==='exited').code,0);
 assert.equal(dispose,1);assert.equal(f.timers.size,0);
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
