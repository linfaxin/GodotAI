import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,loaded,flush,running,until} from './fixtures/worker-runtime-lifecycle.mjs';

test('late Worker loader result is disposed without constructing Native or fabricating an exit',async()=>{
 let resolve,disposed=0,constructed=0;const f=await fixture(()=>new Promise(done=>resolve=done));f.run();await until(()=>resolve);f.stop();resolve({dispose(){disposed++;},Engine:class{constructor(){constructed++;}}});await flush();
 assert.equal(disposed,1);assert.equal(constructed,0);assert(f.messages.some(m=>m.type==='worker-termination-required'));assert(!f.messages.some(m=>m.type==='native-exit'||m.phase==='running'));f.uninstall();
});
test('Worker Promise failure retains the source stack and one genuine synchronous Native exit',async()=>{
 let config,disposed=0,quit=0;const f=await fixture(async()=>loaded({dispose(){disposed++;},onQuit(c){config=c;quit++;c.onExit(0);}}));await running(f);
 const error=f.error('PROMISE_ERROR');error.stack='Error: PROMISE_ERROR\n at res://src/user.ts:9:4';let consumed=0;const event={reason:error,preventDefault(){consumed++;}};
 f.event('unhandledrejection',event);config.onExit(0);f.event('unhandledrejection',event);await flush();const fatal=f.messages.filter(m=>m.type==='worker-fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.stack,error.stack);assert.equal(fatal[0].diagnostic.message,'PROMISE_ERROR');assert.equal(f.messages.filter(m=>m.type==='native-exit').length,1);assert.equal(disposed,1);assert.equal(quit,1);assert.equal(consumed,1);assert.equal(f.timers.size,0);assert.equal(f.sandbox.console.log,f.originalLog);f.uninstall();
});
test('Worker error events retain the actual Error and fallback source coordinates',async()=>{
 const f=await fixture(async()=>loaded({onQuit(c){c.onExit(0);}}));await running(f);let consumed=0;f.event('error',{error:f.error('script failure'),message:'fallback',filename:'res://src/main.ts',lineno:4,colno:7,preventDefault(){consumed++;}});
 const fatal=f.messages.find(m=>m.type==='worker-fatal');assert.equal(fatal.diagnostic.message,'script failure');assert.match(fatal.diagnostic.stack,/script failure/);assert.equal(fatal.diagnostic.filename,'res://src/main.ts');assert.equal(fatal.diagnostic.line,4);assert.equal(fatal.diagnostic.column,7);assert.equal(consumed,1);f.uninstall();
});
test('unexpected rejection during Worker stop is reported without inventing a Native exit',async()=>{
 let config;const f=await fixture(async()=>{const value=loaded(),Original=value.Engine;value.Engine=class extends Original{constructor(c){super(c);config=c;}};return value;});await running(f);f.stop();let consumed=0;
 f.event('unhandledrejection',{reason:f.error('shutdown rejection'),preventDefault(){consumed++;}});assert.equal(consumed,1);assert.equal(f.messages.filter(m=>m.type==='worker-fatal').length,1);assert(!f.messages.some(m=>m.type==='native-exit'));config.onExit(0);assert.equal(f.messages.filter(m=>m.type==='native-exit').length,1);f.uninstall();
});
test('repeated Worker stop and Native exit stay idempotent; ordinary Godot errors remain logs',async()=>{
 let config,quit=0,disposed=0;const f=await fixture(async()=>{const value=loaded({dispose(){disposed++;},onQuit(){quit++;}}),Original=value.Engine;value.Engine=class extends Original{constructor(c){super(c);config=c;}};return value;});await running(f);config.onPrintError('ordinary engine error');assert(!f.messages.some(m=>m.type==='worker-fatal'));f.stop();f.stop();assert.equal(quit,1);assert(!f.messages.some(m=>m.type==='native-exit'));config.onExit(0);config.onExit(1);assert.equal(f.messages.filter(m=>m.type==='native-exit').length,1);assert.equal(f.messages.find(m=>m.type==='native-exit').code,0);assert.equal(disposed,1);assert.equal(f.timers.size,0);f.uninstall();
});
test('Worker React recovery stays nonfatal and an uncaught diagnostic closes exactly once',async()=>{
 let quit=0,disposed=0;const f=await fixture(async()=>loaded({dispose(){disposed++;},onQuit(c){quit++;c.onExit(0);}}));await running(f);const report=f.scope.__godotjsReportReactError;
 assert.equal(report(JSON.stringify({kind:'caught',message:'handled',stack:'at res://src/App.tsx:3:1'})),true);assert(!f.messages.some(m=>m.type==='worker-fatal'));assert(f.messages.some(m=>m.type==='log'&&m.level==='warn'));
 const raw=JSON.stringify({kind:'uncaught',message:'failed',stack:'Error: failed\n at res://src/App.tsx:7:2'});report(raw);report(raw);await flush();const fatal=f.messages.filter(m=>m.type==='worker-fatal');assert.equal(fatal.length,1);assert.equal(fatal[0].diagnostic.source,'godotjs');assert.match(fatal[0].diagnostic.stack,/App.tsx:7:2/);assert.equal(quit,1);assert.equal(disposed,1);assert.equal(report(raw),false);assert.equal(f.timers.size,0);f.uninstall();
});
