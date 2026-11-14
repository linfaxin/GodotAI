#!/usr/bin/env node
/** Real Chromium autoplay boundary for the production audio bridge. This is not full-engine acceptance. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

const require = createRequire(new URL('../../apps/playground/package.json', import.meta.url));
const { chromium } = require('playwright');
const modules = new URL('../jsb.react-browser/dist/', import.meta.url);
const output = resolve(process.env.WORKER_AUDIO_ACTIVATION_REPORT_DIR ?? new URL('../../work/worker-validation/audio-activation/', import.meta.url).pathname);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const assets = new Map();
for (const name of ['worker-audio-protocol.js', 'worker-audio.js', 'worker-audio-host.js', 'worker-audio-worklet.js']) assets.set('/modules/' + name, await readFile(new URL(name, modules)));
const workerSource = `
import { WorkerAudioBridge } from '/modules/worker-audio.js';
self.onmessage = async ({data}) => {
 if(data.type!=='boot')return;
 try {
  const bridge=new WorkerAudioBridge(data.control,data.pcm,{...data.identity,onError:error=>postMessage({type:'error',message:error.message})});
  self.bridge=bridge;
  const descriptor=await bridge.prepare({mixRate:48000,latencyMs:50,driver:'AudioWorklet'});
  const initialized=bridge.init(48000,50,()=>{},()=>{});
  const outSamples=256*8*initialized.channels;
  const heap=new Float32Array(outSamples);let phase=0;
  function fill(position,samples){for(let index=position;index<position+samples;index+=initialized.channels){const value=.25*Math.sin(phase++*Math.PI*2*440/initialized.sampleRate);for(let channel=0;channel<initialized.channels;channel++)heap[index+channel]=value;}}
  fill(0,outSamples);
  bridge.streamCreate(initialized.channels);
  bridge.streamStart({outPtr:0,outSamples,inPtr:0,inSamples:0,heap:()=>heap,outCallback:fill,inCallback:()=>{}});
  const sampleFrames=4800,planar=new Float32Array(sampleFrames*2);
  for(let frame=0;frame<sampleFrames;frame++){const value=.05*Math.sin(frame*Math.PI*2*220/initialized.sampleRate);planar[frame]=value;planar[frame+sampleFrames]=value;}
  bridge.sampleRegister('activation-sample',planar,sampleFrames,'forward',0,sampleFrames);
  bridge.sampleStart('activation-voice','activation-sample',0,0,1,new Float32Array(8).fill(1));
  setInterval(()=>postMessage({type:'actual-sample-position',position:bridge.samplePosition('activation-voice')}),50);
  postMessage({type:'prepared',descriptor,initialized,realm:{document:typeof document,sharedArrayBuffer:typeof SharedArrayBuffer,heapIsArrayBuffer:heap.buffer instanceof ArrayBuffer}});
 }catch(error){postMessage({type:'error',message:error.message});}
};`;
const pageSource = `
import { WorkerAudioHost } from '/modules/worker-audio-host.js';
window.events=[];window.ticks=0;setInterval(()=>window.ticks++,20);
const identity={runId:'strict-autoplay-audio',audioEpoch:1};
const control=new MessageChannel(),pcm=new MessageChannel();
window.audioHost=new WorkerAudioHost(control.port1,pcm.port1,{...identity,workletUrl:'/modules/worker-audio-worklet.js',timeoutMs:15000,
 createContext:options=>{window.realContext=new AudioContext(options);return window.realContext;},
 onError:error=>window.events.push({type:'host-error',message:error.message})});
window.engineWorker=new Worker('/engine-worker.js',{type:'module'});
window.engineWorker.onmessage=event=>window.events.push(event.data);
window.engineWorker.onerror=event=>window.events.push({type:'worker-error',message:event.message});
engineWorker.postMessage({type:'boot',identity,control:control.port2,pcm:pcm.port2},[control.port2,pcm.port2]);
window.snapshot=()=>({events:window.events,ticks:window.ticks,userActivation:{hasBeenActive:navigator.userActivation.hasBeenActive,isActive:navigator.userActivation.isActive},contextState:window.realContext?.state??null,audio:window.audioHost.snapshot()});
document.querySelector('button').addEventListener('click',async event=>{
 const activation={hasBeenActive:navigator.userActivation.hasBeenActive,isActive:navigator.userActivation.isActive,isTrusted:event.isTrusted};
 try {await audioHost.resumeFromGesture();window.events.push({type:'gesture-resumed',activation,state:realContext.state});}
 catch(error){window.events.push({type:'gesture-error',message:error.message});}
});
window.cleanup=async()=>{await audioHost.close();engineWorker.terminate();return window.snapshot();};`;
assets.set('/engine-worker.js', Buffer.from(workerSource)); assets.set('/page.js', Buffer.from(pageSource));
assets.set('/', Buffer.from('<!doctype html><meta charset="utf-8"><title>Strict autoplay audio boundary</title><button type="button">Resume audio with a real gesture</button><script type="module" src="/page.js"></script>'));
const report = { kind: 'worker-audio-strict-autoplay-boundary', scope: 'Production WorkerAudioHost + WorkerAudioBridge + actual AudioWorklet in Chromium; no full Godot-engine claim.', createdAt: new Date().toISOString(), status: 'failed', browser: {}, servedAssets: Object.fromEntries([...assets].map(([path, bytes]) => [path, { sha256: digest(bytes), bytes: bytes.length }])), checks: [] };
const server = createServer((request, response) => {
 const path = new URL(request.url, 'http://localhost').pathname, bytes = assets.get(path);
 if (!bytes) { response.writeHead(404).end(); return; }
 response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'; style-src 'none'; object-src 'none'; base-uri 'none'" }).end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
 const args = ['--no-sandbox', '--autoplay-policy=document-user-activation-required'];
 browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium', headless: true, args });
 const context = await browser.newContext(); page = await context.newPage();
 const cdp = await context.newCDPSession(page);
 const command = await cdp.send('Browser.getBrowserCommandLine');
 report.browser = { name: 'chromium', version: browser.version(), args, actualAutoplayArgs: command.arguments.filter(value => /autoplay-policy/.test(value)) };
 assert.deepEqual(report.browser.actualAutoplayArgs, ['--autoplay-policy=document-user-activation-required']);
 report.console = []; page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
 page.on('pageerror', error => report.console.push({ type: 'pageerror', text: error.message }));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const evaluate = async expression => { const result=await cdp.send('Runtime.evaluate',{expression,userGesture:false,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value; };
 const observe = () => evaluate('window.snapshot?.()');
 const waitFor = async (predicate, timeout=10000) => { const until=Date.now()+timeout;while(Date.now()<until){const snapshot=await observe();if(predicate(snapshot))return snapshot;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Observation timed out after '+timeout+'ms'); };
 await waitFor(snapshot=>snapshot?.contextState);
 let preparationError;
 try { await waitFor(snapshot=>snapshot?.events.some(event=>event.type==='prepared'),6000); }
 catch(error) { preparationError = error.message; }
 report.beforeGesture = await observe();
 const preparedBeforeGesture = report.beforeGesture.events.find(event => event.type === 'prepared');
 report.checks.push({ name: 'prepare-completes-without-user-activation', passed: !!preparedBeforeGesture, ...(preparationError ? { error: preparationError } : {}) });
 assert.equal(report.beforeGesture.userActivation.hasBeenActive, false);
 assert.equal(report.beforeGesture.contextState, 'suspended');
 assert(report.beforeGesture.ticks > 0);
 report.checks.push({ name: 'strict-policy-keeps-real-context-suspended-with-no-click', passed: true });
 await page.locator('button').click();
 await waitFor(snapshot=>snapshot?.events.some(event=>event.type==='gesture-resumed'));
 await waitFor(snapshot=>snapshot?.events.some(event=>event.type==='prepared')&&snapshot.audio.outputPeak>.01&&snapshot.audio.outputChecks>0);
 report.afterGesture = await observe();
 const resumed = report.afterGesture.events.find(event => event.type === 'gesture-resumed');
 assert.equal(resumed.activation.isActive, true); assert.equal(resumed.activation.isTrusted, true); assert.equal(report.afterGesture.contextState, 'running');
 assert(report.afterGesture.audio.outputPeak > .01); assert(report.afterGesture.audio.outputChecks > 0);
 const prepared = report.afterGesture.events.find(event => event.type === 'prepared');
 assert.equal(prepared.realm.document, 'undefined'); assert.equal(prepared.realm.sharedArrayBuffer, 'undefined'); assert.equal(prepared.realm.heapIsArrayBuffer, true);
 report.checks.push({ name: 'real-click-resumes-and-produces-real-master-output', passed: true });
 await waitFor(snapshot=>snapshot?.events.some(event=>event.type==='actual-sample-position'&&event.position>.01));
 report.realSamplePosition=(await observe()).events.filter(event=>event.type==='actual-sample-position').at(-1).position;
 report.checks.push({name:'actual-sample-position-worklet-generation-ack-starts-and-reports-rendered-frames',passed:true});
 report.afterClose = await evaluate('window.cleanup()');
 assert.equal(report.afterClose.contextState, 'closed'); assert.equal(report.afterClose.audio.liveNodes, 0); assert.equal(report.afterClose.audio.transferredChunksOwned, 0);
 report.checks.push({ name: 'graceful-close-flushes-and-closes-the-real-context', passed: true });
 assert(preparedBeforeGesture, 'prepare waited for a user gesture under strict autoplay');
 report.status = 'passed';
} catch(error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
 if (page && !report.afterClose) { try { report.afterCleanup = (await (await page.context().newCDPSession(page)).send('Runtime.evaluate',{expression:'(async()=>{await window.audioHost?.forceClose();window.engineWorker?.terminate();return window.snapshot?.();})()',userGesture:false,awaitPromise:true,returnByValue:true})).result.value; } catch {} }
 await browser?.close(); await new Promise(resolve => server.close(resolve));
 report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, checks: report.checks, contextBeforeGesture: report.beforeGesture?.contextState, contextAfterGesture: report.afterGesture?.contextState, outputPeak: report.afterGesture?.audio.outputPeak, report: join(output, 'verification.json'), error: report.error }, null, 2));
