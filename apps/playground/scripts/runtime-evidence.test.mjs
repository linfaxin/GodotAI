import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRuntimeEvidence} from './runtime-evidence.mjs';
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
