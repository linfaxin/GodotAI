import assert from 'node:assert/strict';
import test from 'node:test';
import {createWorkerBrowserClient,createWorkerBrowserHost,installWorkerBrowserBridge} from '../dist/worker-browser.js';
const tick=()=>new Promise(done=>setTimeout(done,5));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('test callback deadline');}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(t,options={}){
 const peers=[],messages=[],errors=[],hostErrors=[],commands=[],results=[];
 class NativeChannel{
  constructor(label,config={}){Object.assign(this,{label,protocol:'',readyState:'connecting',ordered:true,negotiated:false,id:null,maxPacketLifeTime:null,maxRetransmits:null,bufferedAmount:0,...config});}
  open(){this.readyState='open';this.onopen?.(new Event('open'));}
  send(data){if(options.sendError)throw options.sendError;messages.push(data);}
  close(){if(options.closeError)throw options.closeError;if(options.channelCloseGate){this.readyState='closing';void options.channelCloseGate.promise.then(()=>{this.readyState='closed';this.onclose?.(new Event('close'));});return;}this.readyState='closed';this.onclose?.(new Event('close'));}
 }
 class NativePeer{
  constructor(config){Object.assign(this,{connectionState:'new',iceConnectionState:'new',iceGatheringState:'new',signalingState:'stable',localDescription:null,remoteDescription:null,config,channels:[]});peers.push(this);}
  async createOffer(){this.offerCalls=(this.offerCalls??0)+1;if(options.offerGate)await options.offerGate.promise;if(options.offerError)throw options.offerError;return{type:'offer',sdp:'real host offer'};}
  async createAnswer(){return{type:'answer',sdp:'real host answer'};}
  async setLocalDescription(description){if(options.localGate)await options.localGate.promise;this.localDescription={...description,toJSON:()=>description};this.signalingState='have-local-offer';this.onsignalingstatechange?.(new Event('signalingstatechange'));}
  async setRemoteDescription(description){if(options.remoteGate)await options.remoteGate.promise;this.remoteDescription={...description,toJSON:()=>description};}
  async addIceCandidate(candidate){this.candidate=candidate;}
  createDataChannel(label,config){const c=new NativeChannel(label,config);this.channels.push(c);return c;}
  setConfiguration(config){this.config=config;}
  restartIce(){this.restarted=true;}
  close(){this.connectionState='closed';for(const c of this.channels)c.close();this.onconnectionstatechange?.(new Event('connectionstatechange'));}
 }
 const channel=new MessageChannel();
 const host=createWorkerBrowserHost({port:channel.port1,RTCPeerConnection:NativePeer,onError:e=>hostErrors.push(e),...options.limits});
 const client=createWorkerBrowserClient({port:channel.port2,onError:e=>errors.push(e),...options.limits});
 channel.port1.addEventListener('message',event=>{if(event.data.type==='command')commands.push(event.data);});
 channel.port2.addEventListener('message',event=>{if(event.data.type==='result')results.push(event.data);});
 t.after(()=>{client.dispose();host.dispose();});
 return{peers,messages,errors,hostErrors,commands,results,host,client,NativeChannel};
}

test('SDP promises complete only from the host; native state/ICE are mirrored through callbacks',async t=>{
 const gate=deferred(),f=fixture(t,{offerGate:gate}),peer=new f.client.RTCPeerConnection({iceServers:[]});
 let resolved=false;const offer=peer.createOffer().then(value=>{resolved=true;return value;});
 await until(()=>f.peers.length===1);await tick();assert.equal(resolved,false);
 gate.resolve();assert.deepEqual(await offer,{type:'offer',sdp:'real host offer'});
 await peer.setLocalDescription({type:'offer',sdp:'local'});assert.equal(peer.localDescription.sdp,'local');assert.equal(peer.signalingState,'have-local-offer');
 await peer.setRemoteDescription({type:'answer',sdp:'remote'});assert.equal(peer.remoteDescription.sdp,'remote');
 await peer.addIceCandidate({candidate:'candidate'});assert.equal(f.peers[0].candidate.candidate,'candidate');
 let candidate;peer.onicecandidate=event=>candidate=event.candidate;f.peers[0].onicecandidate({candidate:{toJSON:()=>({candidate:'native-ice',sdpMid:'0'})}});
 await until(()=>candidate);assert.equal(candidate.candidate,'native-ice');
 f.peers[0].connectionState='connected';f.peers[0].onconnectionstatechange(new Event('connectionstatechange'));
 await until(()=>peer.connectionState==='connected');
});

test('data-channel handles are immediate; open, binary payloads and native send errors are asynchronous',async t=>{
 const f=fixture(t),peer=new f.client.RTCPeerConnection(),channel=peer.createDataChannel('game',{ordered:false});
 assert.equal(channel.label,'game');assert.equal(channel.readyState,'connecting');assert.equal(channel.ordered,false);
 assert.throws(()=>channel.send('early'),/not open/);await until(()=>f.peers[0]?.channels.length);
 const native=f.peers[0].channels[0];native.open();await until(()=>channel.readyState==='open');
 const buffer=new Uint8Array([1,2,3]).buffer;channel.send(buffer);assert.equal(buffer.byteLength,3,'native send semantics do not detach caller bytes');
 await until(()=>f.messages.length===1);assert.deepEqual(new Uint8Array(f.messages[0]),new Uint8Array([1,2,3]));
 let received;channel.onmessage=event=>received=event.data;const incoming=new Uint8Array([4,5]).buffer;native.onmessage({data:incoming});
 await until(()=>received);assert.deepEqual(new Uint8Array(received),new Uint8Array([4,5]));
 let closeCalls=0;channel.onclose=()=>closeCalls++;channel.close();await until(()=>channel.readyState==='closed');assert.equal(closeCalls,1);
});

test('incoming native channels and messages preserve host metadata and callbacks',async t=>{
 const f=fixture(t),peer=new f.client.RTCPeerConnection();await until(()=>f.peers.length);
 let incoming;peer.ondatachannel=event=>incoming=event.channel;
 const native=new f.NativeChannel('incoming',{id:7,protocol:'game-v1',readyState:'open'});f.peers[0].ondatachannel({channel:native});
 await until(()=>incoming);assert.equal(incoming.label,'incoming');assert.equal(incoming.id,7);assert.equal(incoming.protocol,'game-v1');assert.equal(incoming.readyState,'open');
 let received;incoming.onmessage=event=>received=event.data;native.onmessage({data:'native text'});await until(()=>received);assert.equal(received,'native text');
});

test('host failures reject promises or raise real channel error events rather than claiming success',async t=>{
 const error=new Error('native operation refused'),f=fixture(t,{offerError:error,sendError:error}),peer=new f.client.RTCPeerConnection();
 await assert.rejects(peer.createOffer(),/native operation refused/);
 const channel=peer.createDataChannel('game');await until(()=>f.peers[0]?.channels.length);f.peers[0].channels[0].open();await until(()=>channel.readyState==='open');
 let eventError;channel.onerror=event=>eventError=event.error;channel.send('queued, not remote success');await until(()=>eventError);assert.match(eventError.message,/native operation refused/);
});

test('budgets bound native handles and send queues; unsupported Blob delivery is explicit',async t=>{
 const f=fixture(t,{limits:{maxPeers:1,maxChannels:1,maxMessageBytes:4,maxBufferedBytes:8}}),peer=new f.client.RTCPeerConnection();
 assert.throws(()=>new f.client.RTCPeerConnection(),/PEER_LIMIT/);const channel=peer.createDataChannel('game');assert.throws(()=>peer.createDataChannel('extra'),/CHANNEL_LIMIT/);
 await until(()=>f.peers[0]?.channels.length);f.peers[0].channels[0].open();await until(()=>channel.readyState==='open');
 assert.throws(()=>channel.send('12345'),/BACKPRESSURE/);assert.throws(()=>channel.binaryType='blob',/ArrayBuffer/);
 await assert.rejects(peer.getStats(),/not the complete browser/);
});

test('an unconsumed event burst is bounded and closes native connections',async t=>{
 const f=fixture(t,{limits:{maxPendingEvents:1}}),peer=new f.client.RTCPeerConnection();await until(()=>f.peers.length);
 f.peers[0].onicecandidate({candidate:null});f.peers[0].onicecandidate({candidate:null});
 await until(()=>f.hostErrors.length);assert.match(f.hostErrors[0].message,/EVENT_BACKPRESSURE/);assert.equal(f.peers[0].connectionState,'closed');await until(()=>peer.connectionState==='closed');
});

test('disposal rejects pending operations, closes native resources and ignores late results',async t=>{
 const gate=deferred(),f=fixture(t,{offerGate:gate}),peer=new f.client.RTCPeerConnection(),pending=peer.createOffer();
 const rejected=assert.rejects(pending,/DISPOSED/);await until(()=>f.peers.length);f.client.dispose();await rejected;
 await until(()=>f.peers[0].connectionState==='closed');gate.resolve();await tick();assert.equal(f.errors.length,0);
 assert.throws(()=>new f.client.RTCPeerConnection(),/DISPOSED/);
});

test('scope installer restores only constructors it owns',async t=>{
 const channel=new MessageChannel(),original=function Original(){},scope={RTCPeerConnection:original};
 const bridge=installWorkerBrowserBridge(channel.port1,{scope});assert.notEqual(scope.RTCPeerConnection,original);assert.equal(typeof scope.RTCIceCandidate,'function');
 bridge.dispose();bridge.dispose();assert.equal(scope.RTCPeerConnection,original);assert.equal('RTCIceCandidate'in scope,false);channel.port2.close();
});


test('peer close fences a late create result and rejects real SDP results which arrive after closure',async t=>{
 const immediate=fixture(t),first=new immediate.client.RTCPeerConnection();first.close();await until(()=>immediate.peers.length);await tick();await tick();assert.equal(first.connectionState,'closed');assert.equal(first.signalingState,'closed');assert.equal(immediate.peers[0].connectionState,'closed');
 const offerGate=deferred(),localGate=deferred(),remoteGate=deferred(),f=fixture(t,{offerGate,localGate,remoteGate}),peer=new f.client.RTCPeerConnection();
 const offer=assert.rejects(peer.createOffer(),/PEER_CLOSED/),local=assert.rejects(peer.setLocalDescription({type:'offer',sdp:'late local'}),/PEER_CLOSED/),remote=assert.rejects(peer.setRemoteDescription({type:'answer',sdp:'late remote'}),/PEER_CLOSED/);
 await until(()=>f.peers.length);await tick();peer.close();offerGate.resolve();localGate.resolve();remoteGate.resolve();await Promise.all([offer,local,remote]);await tick();
 assert.equal(peer.connectionState,'closed');assert.equal(peer.iceConnectionState,'closed');assert.equal(peer.signalingState,'closed');assert.equal(peer.localDescription,null);assert.equal(peer.remoteDescription,null);assert.equal(f.errors.length,0);
 await assert.rejects(peer.createOffer(),/PEER_CLOSED/);assert.throws(()=>peer.createDataChannel('late'),/PEER_CLOSED/);
});

test('late configuration/restart snapshots and failures cannot revive a closed peer',async t=>{
 const f=fixture(t),peer=new f.client.RTCPeerConnection({iceServers:[]});await until(()=>f.peers.length);await tick();peer.setConfiguration({iceTransportPolicy:'relay'});peer.restartIce();peer.close();await until(()=>f.peers[0].connectionState==='closed');await tick();await tick();assert.equal(peer.connectionState,'closed');assert.equal(peer.signalingState,'closed');assert.deepEqual(peer.getConfiguration(),{iceServers:[]});assert.equal(f.errors.length,0);
});

test('late channel create/send/open snapshots cannot reverse closing and close is emitted once',async t=>{
 const gate=deferred(),f=fixture(t,{channelCloseGate:gate}),peer=new f.client.RTCPeerConnection(),channel=peer.createDataChannel('close-before-create-reply');let closes=0,opens=0;channel.onclose=()=>closes++;channel.onopen=()=>opens++;channel.close();
 await until(()=>f.peers[0]?.channels.length);await tick();await tick();assert.equal(channel.readyState,'closing');f.peers[0].channels[0].open();await tick();assert.equal(channel.readyState,'closing');assert.equal(opens,0);gate.resolve();await until(()=>channel.readyState==='closed');assert.equal(closes,1);peer.close();await tick();assert.equal(channel.readyState,'closed');assert.equal(closes,1);
 const sendGate=deferred(),g=fixture(t,{channelCloseGate:sendGate}),other=new g.client.RTCPeerConnection(),sending=other.createDataChannel('send-before-close');await until(()=>g.peers[0]?.channels.length);g.peers[0].channels[0].open();await until(()=>sending.readyState==='open');sending.send('queued before close');sending.close();await until(()=>g.messages.length);await tick();await tick();assert.equal(sending.readyState,'closing');sendGate.resolve();await until(()=>sending.readyState==='closed');
});

for(const target of ['channel','peer'])test(`${target} close survives a full default command queue and stays idempotent`,async t=>{
 const f=fixture(t),peer=new f.client.RTCPeerConnection();await until(()=>f.results.length===1);
 const channel=peer.createDataChannel('burst');await until(()=>f.results.length===2);
 const native=f.peers[0].channels[0];native.open();await until(()=>channel.readyState==='open');
 let closes=0;channel.onclose=()=>closes++;
 for(let i=0;i<128;i++)channel.send('x');assert.throws(()=>channel.send('full'),/BACKPRESSURE/);
 const handle=target==='peer'?peer:channel;handle.close();handle.close();
 await until(()=>native.readyState==='closed'&&channel.readyState==='closed'&&f.messages.length===128);
 await until(()=>f.results.length===131);handle.close();await tick();
 assert.equal(f.commands.filter(m=>m.operation===target+'.close').length,1);
 assert.equal(closes,1);assert.deepEqual(f.errors,[]);assert.deepEqual(f.hostErrors,[]);
 if(target==='peer')assert.equal(f.peers[0].connectionState,'closed');
});

test('channel and peer close progress on the Host while ordinary native SDP credit remains occupied',async t=>{
 const gate=deferred(),f=fixture(t,{offerGate:gate,limits:{maxPendingCommands:1}}),peer=new f.client.RTCPeerConnection();
 await until(()=>f.results.length===1);const channel=peer.createDataChannel('pending-native');await until(()=>f.results.length===2);
 const native=f.peers[0].channels[0];native.open();await until(()=>channel.readyState==='open');
 const pending=assert.rejects(peer.createOffer(),/PEER_CLOSED/);await until(()=>f.peers[0].offerCalls===1);
 assert.throws(()=>channel.send('ordinary credit still occupied'),/BACKPRESSURE/);
 channel.close();peer.close();await until(()=>native.readyState==='closed'&&f.peers[0].connectionState==='closed');
 assert.equal(f.results.some(m=>m.request===3),false,'close must not await the native SDP promise');
 gate.resolve();await pending;await tick();assert.deepEqual(f.errors,[]);assert.deepEqual(f.hostErrors,[]);
 assert.equal(f.commands.filter(m=>m.operation==='channel.close').length,1);assert.equal(f.commands.filter(m=>m.operation==='peer.close').length,1);
});

test('retiring peer/channel handles retain bounded close credit until their own replies',async t=>{
 const wire=new MessageChannel(),commands=[],held=[],errors=[];
 const client=createWorkerBrowserClient({port:wire.port2,maxPeers:1,maxChannels:1,maxPendingCommands:1,onError:e=>errors.push(e)});
 const reply=(request,result)=>wire.port1.postMessage({rtc:1,type:'result',request,result});
 wire.port1.onmessage=({data})=>{if(data.type!=='command')return;commands.push(data);if(data.operation.endsWith('.close'))held.push(data);else reply(data.request,data.operation==='channel.create'?{readyState:'open'}:{});};
 wire.port1.start();t.after(()=>{client.dispose();wire.port1.close();});
 const peer=new client.RTCPeerConnection();await until(()=>commands.length===1);await tick();
 const channel=peer.createDataChannel('retiring');await until(()=>channel.readyState==='open');
 channel.close();await until(()=>held.length===1);
 wire.port1.postMessage({rtc:1,type:'event',sequence:1,target:channel.handle,event:'close',data:{state:{readyState:'closed'}}});
 await until(()=>channel.readyState==='closed');
 assert.throws(()=>peer.createDataChannel('close event is not its reply'),/CHANNEL_LIMIT/);
 peer.close();await until(()=>held.length===2);assert.throws(()=>new client.RTCPeerConnection(),/PEER_LIMIT/);
 for(let i=0;i<1000;i++){peer.close();channel.close();}
 reply(99999,null);reply(commands[0].request,{});await tick();assert.equal(held.length,2);
 assert.throws(()=>new client.RTCPeerConnection(),/PEER_LIMIT/);
 reply(held.find(c=>c.operation==='peer.close').request,null);await tick();
 const next=new client.RTCPeerConnection();await until(()=>commands.length===5);await tick();
 assert.throws(()=>next.createDataChannel('other reply cannot retire channel close'),/CHANNEL_LIMIT/);
 reply(held.find(c=>c.operation==='channel.close').request,{readyState:'closed'});await tick();
 const nextChannel=next.createDataChannel('credit returned');await until(()=>nextChannel.readyState==='open');assert.deepEqual(errors,[]);
});

test('actual native channel close failures remain explicit after entering closing',async t=>{
 const f=fixture(t,{closeError:new Error('native close refused')}),peer=new f.client.RTCPeerConnection();await until(()=>f.results.length===1);
 const channel=peer.createDataChannel('close-error');await until(()=>f.results.length===2);channel.close();
 await until(()=>f.errors.length===1);assert.match(f.errors[0].message,/native close refused/);channel.close();await tick();
 assert.equal(f.commands.filter(m=>m.operation==='channel.close').length,1);assert.equal(f.errors.length,1);
});
