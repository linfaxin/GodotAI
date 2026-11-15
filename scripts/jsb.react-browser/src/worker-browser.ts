/** Host ABI 1 WebRTC broker for Godot's native WebRTC bridge.
 * Constructors/createDataChannel allocate local handles synchronously. State
 * getters are last host-observed mirrors, not synchronous remote queries.
 * SDP/ICE operations resolve only after the real browser operation. send()
 * accepts a bounded local queue; later browser failures are error events.
 * A fresh, private MessagePort belongs to exactly one preview run. */
export interface WorkerBrowserLimits {
  maxPeers?: number; maxChannels?: number; maxMessageBytes?: number;
  maxPendingCommands?: number; maxPendingEvents?: number; maxBufferedBytes?: number;
}
export interface WorkerBrowserOptions extends WorkerBrowserLimits {
  port: MessagePort;
  onError?: (error: Error) => void;
}
export interface WorkerRTCDataChannel extends EventTarget {
  readonly handle:string;readonly owner:string;readonly bufferedAmount:number;
  readyState:RTCDataChannelState;id:number|null;label:string;protocol:string;ordered:boolean;negotiated:boolean;
  maxPacketLifeTime:number|null;maxRetransmits:number|null;binaryType:BinaryType;bufferedAmountLowThreshold:number;
  onopen?:((event:Event)=>void)|null;onclose?:((event:Event)=>void)|null;
  onerror?:((event:Event&{error?:Error})=>void)|null;onmessage?:((event:Event&{data:unknown})=>void)|null;
  send(data:string|ArrayBuffer|ArrayBufferView):void;close():void;
}
export interface WorkerRTCPeerConnection extends EventTarget {
  readonly handle:string;connectionState:RTCPeerConnectionState;iceConnectionState:RTCIceConnectionState;
  iceGatheringState:RTCIceGatheringState;signalingState:RTCSignalingState;
  localDescription:RTCSessionDescriptionInit|null;remoteDescription:RTCSessionDescriptionInit|null;
  ondatachannel?:((event:Event&{channel:WorkerRTCDataChannel})=>void)|null;
  onicecandidate?:((event:Event&{candidate:RTCIceCandidateInit|null})=>void)|null;
  onconnectionstatechange?:((event:Event)=>void)|null;onsignalingstatechange?:((event:Event)=>void)|null;
  oniceconnectionstatechange?:((event:Event)=>void)|null;onicegatheringstatechange?:((event:Event)=>void)|null;
  onerror?:((event:Event&{error?:Error})=>void)|null;
  createOffer(options?:RTCOfferOptions):Promise<RTCSessionDescriptionInit>;
  createAnswer(options?:RTCAnswerOptions):Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?:RTCLocalSessionDescriptionInit):Promise<void>;
  setRemoteDescription(description:RTCSessionDescriptionInit):Promise<void>;
  addIceCandidate(candidate:RTCIceCandidateInit|null):Promise<void>;
  createDataChannel(label:string,configuration?:RTCDataChannelInit):WorkerRTCDataChannel;
  getConfiguration():RTCConfiguration;setConfiguration(configuration:RTCConfiguration):void;
  restartIce():void;getStats():Promise<RTCStatsReport>;close():void;
}
export interface WorkerBrowserClient {
  RTCPeerConnection:new(configuration?:RTCConfiguration)=>WorkerRTCPeerConnection;
  RTCIceCandidate:new(init?:RTCIceCandidateInit)=>RTCIceCandidateInit&{toJSON():RTCIceCandidateInit};
  RTCSessionDescription:new(init:RTCSessionDescriptionInit)=>RTCSessionDescriptionInit&{toJSON():RTCSessionDescriptionInit};
  dispose():void;
}
const defaults = {maxPeers:16,maxChannels:64,maxMessageBytes:1024*1024,maxPendingCommands:128,maxPendingEvents:256,maxBufferedBytes:4*1024*1024};
const isTeardown=(operation:string)=>operation==='peer.close'||operation==='channel.close';
function limits(options: WorkerBrowserLimits) {
  const result={...defaults};
  for(const key of Object.keys(defaults) as (keyof typeof defaults)[])if(options[key]!==undefined){const value=options[key]!;if(!Number.isSafeInteger(value)||value<1||value>64*1024*1024)throw new RangeError('E_RTC_BUDGET: '+key);result[key]=value;}
  return result;
}
const failure=(message:string)=>new DOMException(message,'InvalidStateError');
const errorText=(error:unknown)=>error instanceof Error?error.message.slice(0,4096):String(error).slice(0,4096);
const bytesOf=(value:string|ArrayBuffer|ArrayBufferView)=>typeof value==='string'?new TextEncoder().encode(value).byteLength:value.byteLength;
function dto<T>(value:T,max=65536):T{const json=JSON.stringify(value);if(json===undefined||json.length>max)throw new RangeError('E_RTC_DTO_BUDGET');return JSON.parse(json);}
function handle(value:unknown):value is string{return typeof value==='string'&&/^[phc]-[0-9]+$/.test(value);}
const peerSnapshot=(peer:RTCPeerConnection)=>({connectionState:peer.connectionState,iceConnectionState:peer.iceConnectionState,iceGatheringState:peer.iceGatheringState,signalingState:peer.signalingState,localDescription:peer.localDescription?.toJSON()??null,remoteDescription:peer.remoteDescription?.toJSON()??null});
const channelSnapshot=(channel:RTCDataChannel)=>({readyState:channel.readyState,bufferedAmount:channel.bufferedAmount,id:channel.id,label:channel.label,protocol:channel.protocol,ordered:channel.ordered,negotiated:channel.negotiated,maxPacketLifeTime:channel.maxPacketLifeTime,maxRetransmits:channel.maxRetransmits});

/** The iframe owns real native connections and closes every one on disposal. */
export function createWorkerBrowserHost(options:WorkerBrowserOptions&{RTCPeerConnection?:typeof RTCPeerConnection}) {
  const budget=limits(options),port=options.port,Constructor=options.RTCPeerConnection??globalThis.RTCPeerConnection;
  const peers=new Map<string,RTCPeerConnection>(),channels=new Map<string,RTCDataChannel>(),channelPeers=new Map<string,string>();
  const eventSizes=new Map<number,number>();let eventSerial=0,remoteChannels=0,eventBytes=0,pending=0,pendingTeardown=0,closed=false;
  const report=(error:unknown)=>{try{options.onError?.(new Error(errorText(error)));}catch{/* diagnostics cannot prevent cleanup */}};
  const release=()=>{
    for(const channel of channels.values()){channel.onopen=channel.onclose=channel.onerror=channel.onmessage=channel.onbufferedamountlow=null;try{channel.close();}catch{}}
    for(const peer of peers.values()){peer.onconnectionstatechange=peer.oniceconnectionstatechange=peer.onicegatheringstatechange=peer.onsignalingstatechange=peer.onicecandidate=peer.ondatachannel=null;try{peer.close();}catch{}}
    peers.clear();channels.clear();channelPeers.clear();eventSizes.clear();eventBytes=0;
  };
  const fatal=(error:unknown)=>{if(closed)return;closed=true;report(error);try{port.postMessage({rtc:1,type:'fatal',error:errorText(error)});}catch{}release();};
  const postEvent=(target:string,event:string,data:Record<string,unknown>={},size=0,transfer:Transferable[]=[])=>{
    if(closed)return;
    if(size>budget.maxMessageBytes||eventSizes.size>=budget.maxPendingEvents||eventBytes+size>budget.maxBufferedBytes){fatal(new Error('E_RTC_EVENT_BACKPRESSURE'));return;}
    const sequence=++eventSerial;eventSizes.set(sequence,size);eventBytes+=size;
    try{port.postMessage({rtc:1,type:'event',sequence,target,event,data},transfer);}catch(error){fatal(error);}
  };
  const attachChannel=(id:string,peerId:string,channel:RTCDataChannel)=>{
    if(channels.size>=budget.maxChannels){channel.close();throw new RangeError('E_RTC_CHANNEL_LIMIT');}
    channels.set(id,channel);channelPeers.set(id,peerId);channel.binaryType='arraybuffer';
    channel.onopen=()=>postEvent(id,'open',{state:channelSnapshot(channel)});
    channel.onclose=()=>{postEvent(id,'close',{state:channelSnapshot(channel)});channels.delete(id);channelPeers.delete(id);};
    channel.onerror=event=>postEvent(id,'error',{error:errorText((event as RTCErrorEvent).error??'WebRTC data channel error'),state:channelSnapshot(channel)});
    channel.onbufferedamountlow=()=>postEvent(id,'bufferedamountlow',{state:channelSnapshot(channel)});
    channel.onmessage=event=>{
      if(typeof event.data==='string')postEvent(id,'message',{data:event.data},bytesOf(event.data));
      else if(event.data instanceof ArrayBuffer)postEvent(id,'message',{data:event.data},event.data.byteLength,[event.data]);
      else fatal(new Error('E_RTC_MESSAGE_TYPE'));
    };
  };
  const respond=(request:number,result:unknown,error?:unknown)=>{if(!closed)try{port.postMessage({rtc:1,type:'result',request,result,error:error===undefined?undefined:errorText(error)});}catch(reason){fatal(reason);}};
  const execute=async(message:Record<string,any>)=>{
    const {operation,id,args=[]}=message;
    if(!handle(id)||!Array.isArray(args)||typeof operation!=='string')throw new TypeError('E_RTC_COMMAND');
    if(operation==='peer.create'){
      if(peers.has(id)||peers.size>=budget.maxPeers)throw new RangeError('E_RTC_PEER_LIMIT');
      if(typeof Constructor!=='function')throw new Error('E_RTC_UNAVAILABLE');
      const peer=new Constructor(dto(args[0]??{}));peers.set(id,peer);
      for(const type of ['connectionstatechange','iceconnectionstatechange','icegatheringstatechange','signalingstatechange'] as const)peer['on'+type as 'onconnectionstatechange']=()=>postEvent(id,type,{state:peerSnapshot(peer)});
      peer.onicecandidate=event=>postEvent(id,'icecandidate',{candidate:event.candidate?.toJSON()??null});
      peer.ondatachannel=event=>{try{const channelId='h-'+(++remoteChannels);attachChannel(channelId,id,event.channel);postEvent(id,'datachannel',{channelId,state:channelSnapshot(event.channel)});}catch(error){fatal(error);}};
      return peerSnapshot(peer);
    }
    const peer=peers.get(id);
    if(operation==='peer.close'){
      if(peer){peer.close();for(const [channelId,owner]of channelPeers)if(owner===id){channels.get(channelId)?.close();channels.delete(channelId);channelPeers.delete(channelId);}peers.delete(id);}
      return null;
    }
    if(operation==='channel.create'){
      if(!peer||!handle(args[0])||typeof args[1]!=='string'||args[1].length>65535)throw failure('E_RTC_CHANNEL_CREATE');
      const channel=peer.createDataChannel(args[1],dto(args[2]??{}));attachChannel(args[0],id,channel);return channelSnapshot(channel);
    }
    if(operation.startsWith('channel.')){
      const channel=channels.get(id);if(!channel)throw failure('E_RTC_CHANNEL_MISSING');
      if(operation==='channel.send'){
        const data=args[0];if(typeof data!=='string'&&!(data instanceof ArrayBuffer))throw new TypeError('E_RTC_MESSAGE_TYPE');
        if(bytesOf(data)>budget.maxMessageBytes||channel.bufferedAmount+bytesOf(data)>budget.maxBufferedBytes)throw new RangeError('E_RTC_SEND_BACKPRESSURE');
        if(typeof data==='string')channel.send(data);else channel.send(data);return channelSnapshot(channel);
      }
      if(operation==='channel.close'){channel.close();return channelSnapshot(channel);}
      if(operation==='channel.threshold'){if(!Number.isSafeInteger(args[0])||args[0]<0||args[0]>budget.maxBufferedBytes)throw new RangeError('E_RTC_THRESHOLD');channel.bufferedAmountLowThreshold=args[0];return channelSnapshot(channel);}
      throw new Error('E_RTC_OPERATION');
    }
    if(!peer)throw failure('E_RTC_PEER_MISSING');
    switch(operation){
      case 'peer.offer':return dto(await peer.createOffer(dto(args[0]??{})));
      case 'peer.answer':return dto(await peer.createAnswer(dto(args[0]??{})));
      case 'peer.local':await peer.setLocalDescription(dto(args[0]));return peerSnapshot(peer);
      case 'peer.remote':await peer.setRemoteDescription(dto(args[0]));return peerSnapshot(peer);
      case 'peer.ice':await peer.addIceCandidate(dto(args[0]));return null;
      case 'peer.restart':peer.restartIce();return peerSnapshot(peer);
      case 'peer.config':peer.setConfiguration(dto(args[0]));return peerSnapshot(peer);
      default:throw new Error('E_RTC_OPERATION');
    }
  };
  const onmessage=(event:MessageEvent)=>{
    const message=event.data;if(!message||message.rtc!==1||closed)return;
    if(message.type==='ack'){const size=eventSizes.get(message.sequence);if(size!==undefined){eventBytes-=size;eventSizes.delete(message.sequence);}return;}
    if(message.type==='dispose'){closed=true;release();return;}
    if(message.type!=='command'||!Number.isSafeInteger(message.request)||message.request<1)return;
    // Closing a native handle must progress even when SDP operations are still
    // pending. This lane is bounded by the run's handle limits, not ordinary work.
    const teardown=isTeardown(message.operation);
    if(teardown?pendingTeardown>=budget.maxPeers+budget.maxChannels:pending>=budget.maxPendingCommands){fatal(new Error('E_RTC_COMMAND_BACKPRESSURE'));return;}
    if(teardown)pendingTeardown++;else pending++;
    void execute(message).then(result=>respond(message.request,result),error=>respond(message.request,undefined,error)).finally(()=>{if(teardown)pendingTeardown--;else pending--;});
  };
  port.addEventListener('message',onmessage);port.start();
  return{dispose(){if(!closed){closed=true;release();}port.removeEventListener('message',onmessage);port.close();}};
}

class BrowserMirror extends EventTarget {
  [key:string]:any;
  emit(type:string,values:Record<string,unknown>={}){const event=new Event(type);for(const [key,value]of Object.entries(values))Object.defineProperty(event,key,{value,enumerable:true});this.dispatchEvent(event);const callback=this['on'+type];if(typeof callback==='function')callback.call(this,event);}
}

export function createWorkerBrowserClient(options:WorkerBrowserOptions):WorkerBrowserClient {
  const budget=limits(options),port=options.port;
  const peers=new Map<string,Peer>(),channels=new Map<string,Channel>(),requests=new Map<number,{teardown:boolean;resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  // A locally removed mirror can still own an unacknowledged native close.
  // Keep that handle charged so repeated create/close cannot grow this lane.
  const ownedPeers=new Set<string>(),ownedChannels=new Set<string>();
  let serial=0,peerSerial=0,channelSerial=0,pendingCommands=0,closed=false,lastEvent=0;
  const report=(error:unknown)=>{try{options.onError?.(new Error(errorText(error)));}catch{}};
  const request=(operation:string,id:string,args:unknown[]=[],transfer:Transferable[]=[])=>{
    if(closed)return Promise.reject(failure('E_RTC_DISPOSED'));
    const teardown=isTeardown(operation);
    if(teardown?requests.size-pendingCommands>=budget.maxPeers+budget.maxChannels:pendingCommands>=budget.maxPendingCommands)return Promise.reject(new RangeError('E_RTC_COMMAND_BACKPRESSURE'));
    return new Promise<any>((resolve,reject)=>{const token=++serial;requests.set(token,{teardown,resolve,reject});if(!teardown)pendingCommands++;try{port.postMessage({rtc:1,type:'command',request:token,operation,id,args},transfer);}catch(error){requests.delete(token);if(!teardown)pendingCommands--;reject(error);}});
  };
  const failed=(target:BrowserMirror,error:unknown)=>{if(closed)return;report(error);target.emit('error',{error});};
  class Channel extends BrowserMirror {
    readonly handle:string;readonly owner:string;readyState:RTCDataChannelState='connecting';id:number|null=null;label='';protocol='';ordered=true;negotiated=false;maxPacketLifeTime:number|null=null;maxRetransmits:number|null=null;
    #hostBuffered=0;#localBuffered=0;#threshold=0;#closing=false;#terminal=false;#closeReported=false;#closePending=false;
    get binaryType():BinaryType{return 'arraybuffer';}
    set binaryType(value:BinaryType){if(value!=='arraybuffer')throw new DOMException('Worker host ABI 1 delivers ArrayBuffer messages','NotSupportedError');}
    constructor(handleId:string,owner:string,state:Record<string,unknown>={}){super();this.handle=handleId;this.owner=owner;Object.assign(this,state);channels.set(handleId,this);ownedChannels.add(handleId);}
    get bufferedAmount(){return this.#hostBuffered+this.#localBuffered;}
    get bufferedAmountLowThreshold(){return this.#threshold;}
    set bufferedAmountLowThreshold(value:number){if(!Number.isSafeInteger(value)||value<0||value>budget.maxBufferedBytes)throw new RangeError('E_RTC_THRESHOLD');this.#threshold=value;void request('channel.threshold',this.handle,[value]).catch(error=>this.fail(error));}
    update(state:any){if(!state||this.#terminal||closed)return;const {bufferedAmount,readyState,...properties}=state;Object.assign(this,properties);if(Number.isFinite(bufferedAmount))this.#hostBuffered=bufferedAmount;if(readyState==='closed'){this.#terminal=true;this.#closing=true;this.readyState='closed';}else if(readyState==='closing'){this.#closing=true;this.readyState='closing';}else if(!this.#closing&&readyState)this.readyState=readyState;}
    acceptsEvent(type:string){return type==='close'?!this.#closeReported:!this.#terminal&&!(this.#closing&&type==='open');}
    terminate(){if(this.#closeReported)return;this.#closeReported=true;this.#terminal=true;this.#closing=true;this.readyState='closed';channels.delete(this.handle);if(!this.#closePending)ownedChannels.delete(this.handle);this.emit('close');}
    fail(error:unknown){if(!this.#terminal&&!this.#closing&&!closed)failed(this,error);}
    failCreate(error:unknown){if(this.#terminal||closed)return;this.fail(error);this.terminate();}
    send(data:string|ArrayBuffer|ArrayBufferView){
      if(this.#closing||this.#terminal||this.readyState!=='open'||closed)throw failure('RTCDataChannel is not open');
      if(typeof data!=='string'&&!(data instanceof ArrayBuffer)&&!ArrayBuffer.isView(data))throw new TypeError('E_RTC_MESSAGE_TYPE');
      const size=bytesOf(data);if(size>budget.maxMessageBytes||this.bufferedAmount+size>budget.maxBufferedBytes||pendingCommands>=budget.maxPendingCommands)throw new RangeError('E_RTC_SEND_BACKPRESSURE');
      let payload:string|ArrayBuffer=data as string;const transfer:Transferable[]=[];
      if(typeof data!=='string'){const view=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);payload=view.slice().buffer;transfer.push(payload);}
      this.#localBuffered+=size;void request('channel.send',this.handle,[payload],transfer).then(state=>this.update(state),error=>this.fail(error)).finally(()=>{this.#localBuffered-=size;});
    }
    close(){if(this.#terminal||this.#closing||closed)return;this.#closing=true;this.#closePending=true;this.readyState='closing';void request('channel.close',this.handle).then(state=>this.update(state),error=>{if(!closed)report(error);}).finally(()=>{this.#closePending=false;if(this.#terminal)ownedChannels.delete(this.handle);});}
  }
  class Peer extends BrowserMirror {
    readonly handle:string;connectionState:RTCPeerConnectionState='new';iceConnectionState:RTCIceConnectionState='new';iceGatheringState:RTCIceGatheringState='new';signalingState:RTCSignalingState='stable';localDescription:RTCSessionDescriptionInit|null=null;remoteDescription:RTCSessionDescriptionInit|null=null;
    #configuration:RTCConfiguration;#closed=false;
    update(state:unknown){if(!this.#closed&&!closed)Object.assign(this,state);}
    fail(error:unknown){if(!this.#closed&&!closed)failed(this,error);}
    operation(operation:string,args:unknown[]=[]) {if(closed)return Promise.reject(failure('E_RTC_DISPOSED'));if(this.#closed)return Promise.reject(failure('E_RTC_PEER_CLOSED'));return request(operation,this.handle,args).then(value=>{if(closed)throw failure('E_RTC_DISPOSED');if(this.#closed)throw failure('E_RTC_PEER_CLOSED');return value;},error=>{if(this.#closed)throw failure('E_RTC_PEER_CLOSED');throw error;});}
    constructor(configuration:RTCConfiguration={}){super();if(closed)throw failure('E_RTC_DISPOSED');if(ownedPeers.size>=budget.maxPeers)throw new RangeError('E_RTC_PEER_LIMIT');this.handle='p-'+(++peerSerial);this.#configuration=dto(configuration);peers.set(this.handle,this);ownedPeers.add(this.handle);void request('peer.create',this.handle,[this.#configuration]).then(state=>this.update(state),error=>{if(this.#closed||closed)return;this.connectionState='failed';this.emit('connectionstatechange');this.fail(error);});}
    createOffer(options:RTCOfferOptions={}){return this.operation('peer.offer',[dto(options)]);}
    createAnswer(options:RTCAnswerOptions={}){return this.operation('peer.answer',[dto(options)]);}
    async setLocalDescription(description:RTCLocalSessionDescriptionInit={}){this.update(await this.operation('peer.local',[dto(description)]));}
    async setRemoteDescription(description:RTCSessionDescriptionInit){this.update(await this.operation('peer.remote',[dto(description)]));}
    async addIceCandidate(candidate:RTCIceCandidateInit|null){await this.operation('peer.ice',[dto(candidate)]);}
    createDataChannel(label:string,configuration:RTCDataChannelInit={}){
      if(this.#closed||closed)throw failure('E_RTC_PEER_CLOSED');if(ownedChannels.size>=budget.maxChannels)throw new RangeError('E_RTC_CHANNEL_LIMIT');if(typeof label!=='string'||label.length>65535)throw new TypeError('E_RTC_LABEL');
      const config=dto(configuration),id='c-'+(++channelSerial),channel=new Channel(id,this.handle,{label,protocol:config.protocol??'',ordered:config.ordered??true,negotiated:config.negotiated??false,id:config.id??null,maxPacketLifeTime:config.maxPacketLifeTime??null,maxRetransmits:config.maxRetransmits??null});
      void request('channel.create',this.handle,[id,label,config]).then(state=>channel.update(state),error=>channel.failCreate(error));return channel;
    }
    getConfiguration(){return dto(this.#configuration);}
    setConfiguration(configuration:RTCConfiguration){const config=dto(configuration);void this.operation('peer.config',[config]).then(state=>{if(this.#closed||closed)return;this.#configuration=config;this.update(state);},error=>this.fail(error));}
    restartIce(){void this.operation('peer.restart').then(state=>this.update(state),error=>this.fail(error));}
    getStats():Promise<RTCStatsReport>{return Promise.reject(new DOMException('Worker host ABI 1 exposes Godot WebRTC peer/data-channel operations, not the complete browser RTCPeerConnection API','NotSupportedError'));}
    close(){if(this.#closed)return;this.#closed=true;this.connectionState='closed';this.iceConnectionState='closed';this.signalingState='closed';peers.delete(this.handle);void request('peer.close',this.handle).catch(error=>{if(!closed)report(error);}).finally(()=>ownedPeers.delete(this.handle));for(const channel of channels.values())if(channel.owner===this.handle)channel.terminate();}
  }
  const shutdown=(error:Error,notify=true)=>{if(closed)return;closed=true;for(const pending of requests.values())pending.reject(error);requests.clear();pendingCommands=0;for(const peer of peers.values()){peer.connectionState='closed';peer.iceConnectionState='closed';peer.signalingState='closed';if(notify)peer.emit('error',{error});}for(const channel of channels.values())channel.terminate();peers.clear();channels.clear();ownedPeers.clear();ownedChannels.clear();};
  const onmessage=(event:MessageEvent)=>{
    const message=event.data;if(!message||message.rtc!==1||closed)return;
    if(message.type==='fatal'){const error=new Error(String(message.error).slice(0,4096));report(error);shutdown(error);return;}
    if(message.type==='result'){const pending=requests.get(message.request);if(!pending)return;requests.delete(message.request);if(!pending.teardown)pendingCommands--;if(message.error!==undefined)pending.reject(new Error(String(message.error).slice(0,4096)));else pending.resolve(message.result);return;}
    if(message.type!=='event'||!Number.isSafeInteger(message.sequence)||message.sequence<=lastEvent||!handle(message.target))return;lastEvent=message.sequence;
    try{
      const peer=peers.get(message.target),channel=channels.get(message.target),data=message.data??{};
      if(peer){if(data.state&&message.event!=='datachannel')peer.update(data.state);if(message.event==='datachannel'){
        if(!handle(data.channelId)||ownedChannels.size>=budget.maxChannels)throw new RangeError('E_RTC_CHANNEL_LIMIT');const incoming=new Channel(data.channelId,peer.handle);incoming.update(data.state);peer.emit('datachannel',{channel:incoming});
      }else peer.emit(message.event,{candidate:data.candidate??null,error:data.error?new Error(data.error):undefined});}
      else if(channel&&channel.acceptsEvent(message.event)){channel.update(data.state);if(message.event==='message'&&(typeof data.data!=='string'&&!(data.data instanceof ArrayBuffer)||bytesOf(data.data)>budget.maxMessageBytes))throw new RangeError('E_RTC_MESSAGE_BUDGET');if(message.event==='close')channel.terminate();else channel.emit(message.event,{data:data.data,error:data.error?new Error(data.error):undefined});}
    }catch(error){report(error);shutdown(new Error(errorText(error)));}
    finally{try{port.postMessage({rtc:1,type:'ack',sequence:message.sequence});}catch{}}
  };
  port.addEventListener('message',onmessage);port.start();
  class Candidate {candidate='';sdpMid:string|null=null;sdpMLineIndex:number|null=null;usernameFragment:string|null=null;constructor(init:RTCIceCandidateInit={}){Object.assign(this,dto(init));}toJSON(){return{candidate:this.candidate,sdpMid:this.sdpMid,sdpMLineIndex:this.sdpMLineIndex,usernameFragment:this.usernameFragment};}}
  class Description {type:RTCSdpType;sdp:string;constructor(init:RTCSessionDescriptionInit){this.type=init.type;this.sdp=init.sdp??'';}toJSON(){return{type:this.type,sdp:this.sdp};}}
  return{RTCPeerConnection:Peer,RTCIceCandidate:Candidate,RTCSessionDescription:Description,dispose(){if(!closed){try{port.postMessage({rtc:1,type:'dispose'});}catch{}shutdown(failure('E_RTC_DISPOSED'),false);}port.removeEventListener('message',onmessage);port.close();}};
}

/** Convenience installer; the caller owns this run's port and scope lifetime. */
export function installWorkerBrowserBridge(port:MessagePort,options:Omit<WorkerBrowserOptions,'port'>&{runId?:string;scope?:Record<string,unknown>}={}){
  const client=createWorkerBrowserClient({...options,port}),scope=options.scope??globalThis as unknown as Record<string,unknown>;
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const key of ['RTCPeerConnection','RTCIceCandidate','RTCSessionDescription'] as const){previous.set(key,Object.getOwnPropertyDescriptor(scope,key));Object.defineProperty(scope,key,{configurable:true,writable:true,value:client[key]});}
  return{...client,dispose(){client.dispose();for(const [key,descriptor]of previous){if(scope[key]!==client[key as keyof typeof client])continue;if(descriptor)Object.defineProperty(scope,key,descriptor);else delete scope[key];}}};
}
