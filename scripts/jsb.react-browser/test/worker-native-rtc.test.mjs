import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {patchWorkerRuntimeFile,WORKER_RUNTIME_PATHS} from '../../release/patch-web-worker-runtime.mjs';
import {createWorkerBrowserClient,createWorkerBrowserHost} from '../dist/worker-browser.js';

const path='modules/webrtc/library_godot_webrtc.js';
const original=await readFile(new URL('./fixtures/godot-4.6.1-webrtc.js',import.meta.url),'utf8');
const source=patchWorkerRuntimeFile(path,original).code;
function fixture({worker=true,script=source,Peer}={}){
 const entries=new Map(),log=[],errors=[],created=[];let serial=0;
 class NativePeer{
  connectionState='new';signalingState='stable';closeCalls=0;
  constructor(){created.push(this);}
  close(){this.closeCalls++;log.push('close');assert.equal(this.onconnectionstatechange,null);assert.equal(this.ondatachannel,null);this.connectionState='closed';this.signalingState='closed';}
 }
 const library={},scope={console,Promise,ArrayBuffer,Blob,TextEncoder,TextDecoder,Uint8Array,RTCIceCandidate:class{constructor(value){Object.assign(this,value);}},RTCPeerConnection:Peer??NativePeer,IDHandler:{add:value=>{const id=++serial;entries.set(id,value);return id;},get:id=>entries.get(id),remove:id=>{log.push('remove');entries.delete(id);}},GodotRuntime:{error:value=>errors.push(value),get_func:fn=>fn,parseString:value=>value,allocString:value=>value,free(){}},LibraryManager:{library},autoAddDeps(){},mergeInto:Object.assign};
 if(worker)scope.WorkerGlobalScope=class{static[Symbol.hasInstance](){return true;}};
 let runnable=script;for(const symbol of ['GodotRTCPeerConnection','GodotRTCDataChannel'])runnable=runnable.replace('const '+symbol+' =','const '+symbol+'Library =').replace('autoAddDeps('+symbol+',','autoAddDeps('+symbol+'Library,').replace('mergeInto(LibraryManager.library, '+symbol+');','mergeInto(LibraryManager.library, '+symbol+'Library);');
 runInNewContext(runnable+'\nglobalThis.GodotRTCPeerConnection=GodotRTCPeerConnectionLibrary.$GodotRTCPeerConnection;globalThis.GodotRTCDataChannel=GodotRTCDataChannelLibrary.$GodotRTCDataChannel;',scope);
 const create=()=>library.godot_js_rtc_pc_create('{}',1,()=>{},()=>{},()=>{},()=>{},()=>{});
 return{scope,library,entries,log,errors,created,create};
}
test('RTC patch pins official 4.6.1 bytes, is idempotent and rejects partial edits',()=>{
 assert.equal(createHash('sha256').update(original).digest('hex'),'c9321eb9398917f689f6a07b5265ca3b8b392e5080b81a6edd89d6084c948a6e');
 assert.equal(WORKER_RUNTIME_PATHS.length,10);assert(WORKER_RUNTIME_PATHS.includes(path));assert.equal(patchWorkerRuntimeFile(path,source).changed,false);
 for(const value of [original+'\n// drift',source.replace('conn.close();\n\t\t\t\t}','// omitted close\n\t\t\t\t}')])assert.throws(()=>patchWorkerRuntimeFile(path,value),/E_WORKER_RUNTIME_PATCH_UNSUPPORTED/);
});
test('actual patched peer destroy closes once before releasing its native id; legacy retains upstream behavior',()=>{
 for(const worker of [true,false]){
  const f=fixture({worker}),id=f.create(),peer=f.entries.get(id);let callbacks=0;
  for(const key of ['onconnectionstatechange','oniceconnectionstatechange','onicegatheringstatechange','onsignalingstatechange','onicecandidate','ondatachannel'])peer[key]=()=>callbacks++;
  f.library.godot_js_rtc_pc_destroy(id);f.library.godot_js_rtc_pc_destroy(id);f.library.godot_js_rtc_pc_destroy(9999);
  assert.equal(peer.closeCalls,worker?1:0);assert.equal(f.entries.size,0);assert.equal(callbacks,0);
  assert.deepEqual(f.log,worker?['close','remove']:['remove']);
  for(const key of ['onconnectionstatechange','oniceconnectionstatechange','onicegatheringstatechange','onsignalingstatechange','onicecandidate','ondatachannel'])assert.equal(peer[key],null);
 }
 const upstream=fixture({script:original}),id=upstream.create(),peer=upstream.entries.get(id);upstream.library.godot_js_rtc_pc_destroy(id);assert.equal(peer.closeCalls,0,'reproduces the lost close before the fix');
});
test('Worker close failure stays visible while finally retiring the native id',()=>{
 const f=fixture(),id=f.create(),failure=Error('real close failed');f.entries.get(id).close=()=>{throw failure;};
 assert.throws(()=>f.library.godot_js_rtc_pc_destroy(id),error=>error===failure);assert.equal(f.entries.size,0);assert.deepEqual(f.errors,[]);
 f.library.godot_js_rtc_pc_destroy(id);
});
test('stock DataChannel destroy already closes explicitly in both realms and clears callbacks first',()=>{
 for(const worker of [true,false]){
  const f=fixture({worker});let closes=0;
  const channel={onopen(){},onclose(){},onerror(){},onmessage(){},close(){closes++;for(const name of ['onopen','onclose','onerror','onmessage'])assert.equal(this[name],null);}};
  const id=f.scope.IDHandler.add(channel);f.library.godot_js_rtc_datachannel_destroy(id);f.library.godot_js_rtc_datachannel_destroy(id);
  assert.equal(closes,1);assert.equal(f.entries.size,0);
 }
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await tick();}throw Error('RTC lifecycle deadline');}
test('patched stock native import retires real SDK broker handles across repeated initialize replacements',async t=>{
 const created=[],errors=[];
 class BrowserPeer{
  connectionState='new';iceConnectionState='new';iceGatheringState='new';signalingState='stable';localDescription=null;remoteDescription=null;closes=0;
  constructor(){created.push(this);}
  close(){this.closes++;this.connectionState=this.iceConnectionState='closed';this.signalingState='closed';this.onconnectionstatechange?.(new Event('connectionstatechange'));}
 }
 const ports=new MessageChannel(),host=createWorkerBrowserHost({port:ports.port1,RTCPeerConnection:BrowserPeer,maxPeers:1,onError:e=>errors.push(e)}),client=createWorkerBrowserClient({port:ports.port2,maxPeers:1,onError:e=>errors.push(e)});
 t.after(()=>{client.dispose();host.dispose();});
 const f=fixture({Peer:client.RTCPeerConnection});
 // C++ constructs with initialize({}), then an explicit initialize destroys
 // the previous native id. The same actual JS imports are used here, with
 // the production SDK's real strong Maps and MessagePorts (no browser/GPU).
 for(let n=0;n<12;n++){
  const id=f.create();assert(id>0);await until(()=>created.length===n+1);f.library.godot_js_rtc_pc_destroy(id);await until(()=>created[n].connectionState==='closed');
  assert.equal(created[n].closes,1);assert.equal(f.entries.size,0);assert.deepEqual(errors,[]);
 }
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const microtasks=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
test('actual pending offer and local errors cannot reenter native userdata after Worker destroy or id reuse',async()=>{
 for(const worker of [true,false])for(const operation of ['offer-resolve','offer-reject','local-reject']){
  const f=fixture({worker}),id=f.create(),ref=f.entries.get(id),pending=deferred();let callbacks=0;
  const done=()=>callbacks++,failed=()=>callbacks++;
  if(operation.startsWith('offer')){ref.createOffer=()=>pending.promise;f.library.godot_js_rtc_pc_offer_create(id,123,done,failed);}
  else{ref.setLocalDescription=()=>pending.promise;f.library.godot_js_rtc_pc_local_description_set(id,'offer','sdp',123,failed);}
  f.library.godot_js_rtc_pc_destroy(id);f.entries.set(id,{signalingState:'stable'});
  if(operation==='offer-resolve')pending.resolve({type:'offer',sdp:'late'});else pending.reject(Error('late error'));
  await microtasks();assert.equal(callbacks,worker?0:1,operation);assert.equal(f.errors.length,worker||operation==='offer-resolve'?0:1);
 }
 // Normal live operations still call their original native callbacks.
 const f=fixture(),id=f.create();let completed=0;f.entries.get(id).createOffer=()=>Promise.resolve({type:'offer',sdp:'live'});f.library.godot_js_rtc_pc_offer_create(id,7,()=>completed++,()=>assert.fail());await microtasks();assert.equal(completed,1);
});
test('pending remote and answer chains are fenced before more work and before old native callbacks',async()=>{
 for(const worker of [true,false])for(const stage of ['remote-resolve','remote-reject','answer-resolve','answer-reject']){
  const f=fixture({worker}),id=f.create(),ref=f.entries.get(id),remote=deferred(),answer=deferred();let callbacks=0,answers=0;
  ref.setRemoteDescription=()=>remote.promise;ref.createAnswer=()=>{answers++;return answer.promise;};
  f.library.godot_js_rtc_pc_remote_description_set(id,'offer','sdp',123,()=>callbacks++,()=>callbacks++);
  if(stage.startsWith('answer')){remote.resolve();await microtasks();assert.equal(answers,1);}
  f.library.godot_js_rtc_pc_destroy(id);f.entries.set(id,{signalingState:'stable'});
  if(stage==='remote-resolve'){remote.resolve();answer.resolve({type:'answer',sdp:'late'});}
  else if(stage==='remote-reject')remote.reject(Error('late remote'));
  else if(stage==='answer-resolve')answer.resolve({type:'answer',sdp:'late'});
  else answer.reject(Error('late answer'));
  await microtasks();assert.equal(callbacks,worker?0:1,stage);if(stage==='remote-resolve')assert.equal(answers,worker?0:1);
 }
});
test('Worker ICE late rejection is retired, while active rejection remains observable',async()=>{
 for(const stale of [true,false]){
  const f=fixture(),id=f.create(),ref=f.entries.get(id),pending=deferred();let continuation;
  pending.promise.catch=callback=>{continuation=Promise.prototype.catch.call(pending.promise,callback);void continuation.catch(()=>{});return continuation;};
  ref.addIceCandidate=()=>pending.promise;f.library.godot_js_rtc_pc_ice_candidate_add(id,'0',0,'candidate');
  if(stale){f.library.godot_js_rtc_pc_destroy(id);f.entries.set(id,{signalingState:'stable'});}
  const error=Error('ICE rejected');pending.reject(error);
  if(stale)await continuation;else await assert.rejects(continuation,e=>e===error);
 }
});
test('Worker callback fence independently requires original identity and a still-open connection',async()=>{
 for(const state of ['closed-same-id','replaced-id']){
  const f=fixture(),id=f.create(),ref=f.entries.get(id),pending=deferred();let callbacks=0;ref.createOffer=()=>pending.promise;
  f.library.godot_js_rtc_pc_offer_create(id,123,()=>callbacks++,()=>callbacks++);
  if(state==='closed-same-id'){ref.close=()=>{ref.signalingState='closed';};f.library.godot_js_rtc_pc_close(id);assert.equal(f.entries.get(id),ref);}
  else{f.entries.set(id,{signalingState:'stable'});assert.equal(ref.signalingState,'stable');}
  pending.resolve({type:'offer',sdp:'stale'});await microtasks();assert.equal(callbacks,0,state);
 }
});
