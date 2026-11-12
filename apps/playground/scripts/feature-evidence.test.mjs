import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {validateFeatureNamings,run2dFeatureAcceptance,create2dFeatureFixture,observeFeaturePage} from './browser-2d-features-test.mjs';
import {assessStoppedAudio} from './feature-audio-evidence.mjs';
import {runBasicTextAcceptance} from './browser-basic-text-test.mjs';

test('browser WebGL console errors remain failures even when no page exception is raised',()=>{
 const events=new EventEmitter(),observed=observeFeaturePage(events);
 const webgl='WebGL: INVALID_OPERATION: glBlitFramebuffer: Read and write color attachments cannot be the same image.';
 events.emit('console',{type:()=> 'log',text:()=> 'GODOTJS_2D_FEATURES_READY'});
 events.emit('console',{type:()=> 'warning',text:()=> 'browser warning'});
 events.emit('console',{type:()=> 'error',text:()=>webgl});
 assert.deepEqual(observed.errors,[]);
 assert.deepEqual(observed.consoleErrors,[webgl]);
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
