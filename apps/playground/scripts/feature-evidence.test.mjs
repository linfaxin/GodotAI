import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {validateFeatureNamings,run2dFeatureAcceptance,create2dFeatureFixture,observeFeaturePage,featureExecutionMode,buildWorkerFeatureHarness,assertFeatureWorkerSession} from './browser-2d-features-test.mjs';
import {assessStoppedAudio} from './feature-audio-evidence.mjs';
import {runBasicTextAcceptance} from './browser-basic-text-test.mjs';
import {isBrowserConsoleWarning} from './browser-harness.mjs';

test('Firefox JavaScript warnings delivered as log events retain their exact raw warning evidence',()=>{
 const events=new EventEmitter(),observed=observeFeaturePage(events);
 const warnings=[
  '[JavaScript Warning: "Feature Policy: Skipping unsupported feature name “autoplay”." {file: "http://127.0.0.1:45653/__2d_feature_editor.js" line: 419}]',
  '[JavaScript Warning: "Feature Policy: Skipping unsupported feature name “midi”." {file: "http://127.0.0.1:45653/__2d_feature_editor.js" line: 419}]',
  '[JavaScript Warning: "Feature Policy: Skipping unsupported feature name “xr-spatial-tracking”." {file: "http://127.0.0.1:45653/__2d_feature_editor.js" line: 419}]',
  '[JavaScript Warning: "A browser warning without source metadata."]',
 ];
 for(const message of warnings){assert.equal(isBrowserConsoleWarning('log',message),true);events.emit('console',{type:()=> 'log',text:()=>message});}
 assert.equal(isBrowserConsoleWarning('warning','ordinary warning'),true);
 for(const message of ['ordinary log mentioning warning','Feature Policy: Skipping unsupported feature name “autoplay”.','prefix '+warnings[0],warnings[0]+' suffix','[JavaScript warning: "wrong case"]','[JavaScript Warning: missing quoted message]']){
  assert.equal(isBrowserConsoleWarning('log',message),false,message);
  events.emit('console',{type:()=> 'log',text:()=>message});
 }
 assert.deepEqual(observed.warnings,warnings);
 assert.deepEqual(observed.consoleErrors,[]);
});

test('browser WebGL console errors remain failures even when no page exception is raised',()=>{
 const events=new EventEmitter(),observed=observeFeaturePage(events);
 const webgl='WebGL: INVALID_OPERATION: glBlitFramebuffer: Read and write color attachments cannot be the same image.';
 events.emit('console',{type:()=> 'log',text:()=> 'GODOTJS_2D_FEATURES_READY'});
 events.emit('console',{type:()=> 'warning',text:()=> 'browser warning'});
 events.emit('console',{type:()=> 'error',text:()=>webgl});
 assert.deepEqual(observed.errors,[]);
 assert.deepEqual(observed.consoleErrors,[webgl]);
 assert.deepEqual(observed.warnings,['browser warning']);
 assert.deepEqual(observed.logs,['GODOTJS_2D_FEATURES_READY','browser warning',webgl]);
 events.emit('pageerror',Error('actual page exception'));
 assert.deepEqual(observed.errors,['Error: actual page exception']);
});

test('audio evidence requires a bounded real tail followed by continuous observed silence',()=>{
 const samples=Array.from({length:29},(_,i)=>({ms:i*25,peak:i<4?0.09:0}));
 assert.deepEqual(assessStoppedAudio(samples),{status:'passed',drainMs:100,quietMs:600,quietSamples:25,stoppedPeak:0});
 for(const invalid of [[],samples.map(s=>({...s,peak:0.09})),samples.slice(0,20),samples.filter(s=>s.ms<300||s.ms>450),samples.map(s=>({...s,ms:s.ms+301})),[{ms:0,peak:NaN}],[{ms:0,peak:0},{ms:0,peak:0}]])assert.equal(assessStoppedAudio(invalid).status,'failed');
 // Silence followed by resumed output is never treated as a passed stop.
 assert.equal(assessStoppedAudio([...samples,{ms:725,peak:0.09}]).status,'failed');
});

test('feature evidence rejects an empty, duplicate, or unknown naming matrix before I/O or browser startup',async()=>{
 for(const value of [[],['snake','snake'],['camel','camel'],['unknown'],['snake','camel','snake'],null,'snake']){
  assert.throws(()=>validateFeatureNamings(value),/E_FEATURE_NAMING/);
  await assert.rejects(run2dFeatureAcceptance({namings:value,engineJs:'/must-not-be-read.js'}),/E_FEATURE_NAMING/);
  await assert.rejects(runBasicTextAcceptance({namings:value,directory:'/must-not-be-read'}),/E_FEATURE_NAMING/);
 }
 for(const value of [['snake'],['camel'],['snake','camel']])assert.deepEqual(validateFeatureNamings(value),value);
});

test('the actual CJK PCK test configuration contains only Chinese label glyphs, with no Latin fallback to satisfy pixel counts',async()=>{
 for(const naming of ['snake','camel']){
  const fixture=await create2dFeatureFixture({naming,fontBytes:new Uint8Array([1]),requireCjk:true});
  const code=new TextDecoder().decode(fixture.files.get('res://feature-config.js'));
  const config=JSON.parse(code.slice('module.exports='.length).replace(/;\s*$/,''));
  assert.equal(config.naming,naming);assert.equal(config.requireCjk,true);
  assert.equal(config.labelText,'中文');assert.equal(/[A-Za-z0-9]/.test(config.labelText),false);
 }
 const fixture=await create2dFeatureFixture({fontBytes:new Uint8Array([1]),requireCjk:false});
 const code=new TextDecoder().decode(fixture.files.get('res://feature-config.js'));
 const config=JSON.parse(code.slice('module.exports='.length).replace(/;\s*$/,''));
 assert.equal(config.requireCjk,false);assert.equal(config.labelText,'Native 2D UI');
});

test('Worker candidates can never fall back to the direct main-thread feature runner',async()=>{
 const site={schemaVersion:3,runtime:{executionBackend:'worker'}},release={runtimeAbi:{protocolVersion:2}};
 assert.equal(featureExecutionMode(site,release),'worker');assert.equal(featureExecutionMode({schemaVersion:2},{}),'legacy');assert.equal(featureExecutionMode(undefined,undefined),'legacy');
 for(const [manifest,descriptor]of [[site,{}],[{schemaVersion:2},release],[undefined,release],[{schemaVersion:3,runtime:{executionBackend:'legacy'}},release]])assert.throws(()=>featureExecutionMode(manifest,descriptor),/E_FEATURE_WORKER_CANDIDATE/);
 await assert.rejects(buildWorkerFeatureHarness({build:{}}),/E_FEATURE_WORKER_SDK_PROOF/);
});

test('Worker feature acceptance requires matching real retired session and clean host audio evidence',()=>{
 const identity={runId:'session-run',documentId:'session-document',workerId:'session-worker',runConfigurationHash:'a'.repeat(64)},packSha256='b'.repeat(64);
 const session={...identity,buildKey:packSha256,executionBackend:'worker',runtime:'godot',workerState:'native-exited',exit:{reason:'clean-exit',engineOutcome:{kind:'native-exit',code:0},hostCleanup:{status:'complete'}},
  workerErrors:[],glErrors:[],audio:{closed:true,contextsCreated:1,contextsClosed:1,liveNodes:0,transferredChunksOwned:0}};
 assert.doesNotThrow(()=>assertFeatureWorkerSession(session,identity,packSha256));
 for(const invalid of [undefined,{...session,workerId:'stale'},{...session,executionBackend:'main-thread'},{...session,workerState:'running'},
  {...session,buildKey:'wrong-pack'},{...session,workerErrors:['native failure']},{...session,glErrors:['INVALID_OPERATION']},
  {...session,exit:{reason:'forced-worker-termination',engineOutcome:{kind:'terminate-issued'},hostCleanup:{status:'complete'}}},
  {...session,exit:{...session.exit,hostCleanup:{status:'timed-out'}}},{...session,audio:{...session.audio,closed:false}},
  {...session,audio:{...session.audio,contextsClosed:0}},{...session,audio:{...session.audio,liveNodes:1}},{...session,audio:{...session.audio,transferredChunksOwned:1}}])assert.throws(()=>assertFeatureWorkerSession(invalid,identity,packSha256));
});
