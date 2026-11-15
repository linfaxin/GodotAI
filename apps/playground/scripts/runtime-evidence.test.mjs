import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRuntimeEvidence,RUNTIME_BASELINE_FRAMES} from './runtime-evidence.mjs';
import {runtimeEvidenceFixture} from './fixtures/runtime-evidence.mjs';

const release={engine:{worklets:[{sha256:'a'.repeat(64)},{sha256:'b'.repeat(64)}]}};
for(const browser of ['chromium','firefox','webkit'])test(browser+' runtime evidence requires real pressure, worklet integrity and complete cleanup',()=>{
 const good={...runtimeEvidenceFixture(browser,release.engine.worklets),browser:{name:browser}};
 assert.doesNotThrow(()=>assertRuntimeEvidence(good,release));
 for(const change of [
  value=>{value.lifecycleLoops=0;},value=>{value.lifecycleLoops--;},value=>{value.frames=[];},value=>{value.audio=[];},value=>{value.browser.name='constructor';},
  value=>{value.errors=['unexpected error'];},value=>{value.warnings=['leaked context'];},value=>{delete value.errors;},
  value=>{value.checks=[];},value=>{value.frames.at(-1).documentId=value.frames[0].documentId;},
  value=>{value.frames.at(-1).url='http://editor.test/preview.html?editorOrigin=http%3A%2F%2Feditor.test';},
  value=>{value.audio.find(event=>event.type==='worklet-loaded').sha256='c'.repeat(64);},
  value=>{value.audio=value.audio.filter(event=>event.type!=='context-closed');},
  value=>{value.audio.find(event=>event.type==='context-closed').state='running';},
  value=>{value.audio.push({...value.audio.find(event=>event.type==='context-closed')});},
  value=>{value.audio=value.audio.filter(event=>event.documentId!==value.frames.at(-1).documentId||event.type!=='worklet-output');},
  value=>{value.audio.find(event=>event.documentId===value.frames.at(-1).documentId&&event.type==='context-closed').output[0].peak=0;},
  value=>{value.workletNetworkRequests--;},
 ]){const value=structuredClone(good);change(value);assert.throws(()=>assertRuntimeEvidence(value,release),/E_SITE_RUNTIME_EVIDENCE/);}
});
function forcedTailFixture(){
 const value={...runtimeEvidenceFixture('firefox',release.engine.worklets),browser:{name:'firefox'}};
 value.sessionCleanup=value.frames.map(frame=>({documentId:frame.documentId,cleanup:{mode:'clean'}}));
 const source=value.frames.at(-1),sourceAudio=value.audio.filter(event=>event.documentId===source.documentId);
 for(const [index,forced]of [true,false].entries()){
  const frame={...source,documentId:'fixture-tail-'+index};value.frames.push(frame);
  value.sessionCleanup.push({documentId:frame.documentId,cleanup:{mode:forced?'forced':'clean'},...(forced?{forced:true}:{})});
  for(const event of sourceAudio){if(forced&&event.type==='worklet-output')continue;value.audio.push({...structuredClone(event),documentId:frame.documentId,...(forced&&event.type==='context-closed'?{output:[]}:{} )});}
 }
 value.workletNetworkRequests=value.frames.length*release.engine.worklets.length;return value;
}
test('new forced/recovery tail does not replace or shift the fixed pressure interval',()=>{
 const good=forcedTailFixture();assert.doesNotThrow(()=>assertRuntimeEvidence(good,release));
 for(const change of [
  value=>{const id=value.frames[RUNTIME_BASELINE_FRAMES].documentId;value.audio=value.audio.filter(event=>event.documentId!==id||event.type!=='worklet-output');},
  value=>{value.frames[RUNTIME_BASELINE_FRAMES].runtime='react';},
  value=>{value.sessionCleanup.at(-2).documentId=value.frames[RUNTIME_BASELINE_FRAMES].documentId;},
  value=>{delete value.sessionCleanup.at(-2).forced;},
  value=>{value.sessionCleanup.at(-1).cleanup.mode='forced';},
  value=>{value.frames.splice(RUNTIME_BASELINE_FRAMES,1);},
  value=>{const id=value.frames.at(-1).documentId;value.audio=value.audio.filter(event=>event.documentId!==id||event.type!=='worklet-output');},
  value=>{value.frames.push({...value.frames.at(-1),documentId:'extra-tail'});},
 ]){const value=structuredClone(good);change(value);assert.throws(()=>assertRuntimeEvidence(value,release),/E_SITE_RUNTIME_EVIDENCE/);}
});
