import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {nativeHostFixture,observeNativeHost,observeNativeHostPorts,hasNativeFullscreenDenial,assessNativeHostCase,assertNativeHostSession,buildNativeHostProbe,blockedNativeHostHardware,HOST_CAPABILITIES} from './browser-native-host-capabilities.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';
import {DEFAULT_WORKER_RUN_CONFIGURATION} from '../../../scripts/jsb.react-browser/dist/worker-protocol.js';

const sdkVendor=new TextEncoder().encode('module.exports={React:{createElement(){}},engineReact:{createRoot(){}}};');
const options={capability:'url-open',token:'native-host-unit',popupUrl:'http://127.0.0.1:8080/__host_popup?token=native-host-unit',sdkVendor};
const clean={reason:'clean-exit',engineOutcome:{kind:'native-exit',code:0},hostCleanup:{status:'complete'}};

test('fullscreen denial requires an exact same-port request/reply pair after the actual Native request',()=>{
 const identity={runId:'run',documentId:'document',workerId:'worker',runConfigurationHash:'a'.repeat(64)};
 const native=[{stage:'requested',capability:'fullscreen',origin:'native-delayed-no-gesture',requestedAtUnixMs:100}];
 const command={...identity,operation:'host-fullscreen-command',phase:'received',portId:'port-1',observedAtUnixMs:101,packet:{...identity,protocolVersion:2,type:'host-command',commandSequence:4,command:{type:'dom-command',operation:'fullscreen',requestId:3}}};
 const reply={...identity,operation:'host-fullscreen-reply',phase:'sent',portId:'port-1',observedAtUnixMs:102,packet:{...identity,protocolVersion:2,type:'host-state',state:{type:'dom-state',requestId:3,error:'E_WORKER_USER_ACTIVATION_REQUIRED'}}};
 assert.equal(hasNativeFullscreenDenial(native,[command,reply]),true);
 const check=(request,response)=>hasNativeFullscreenDenial(native,[request,response]);
 for(const patch of [{workerId:'other'},{portId:'other'},{observedAtUnixMs:99},{packet:{...reply.packet,runId:'other'}},{packet:{...reply.packet,state:{...reply.packet.state,requestId:999}}},{packet:{...reply.packet,state:{...reply.packet.state,error:'unrelated E_WORKER_USER_ACTIVATION_REQUIRED text'}}}])assert.equal(check(command,{...reply,...patch}),false);
 assert.equal(check({...command,packet:{...command.packet,command:{...command.packet.command,operation:'clipboard-read'}}},reply),false);
 assert.equal(check({...command,observedAtUnixMs:99},reply),false);
 assert.equal(hasNativeFullscreenDenial([],[command,reply]),false);
 const browser=[command,reply,{operation:'activation-after-delay',activation:false}];
 assert.equal(assessNativeHostCase('fullscreen',{negative:true,native,browser,exit:clean}).status,'passed');
 assert.equal(assessNativeHostCase('fullscreen',{negative:true,native,browser:browser.slice(0,1),logs:['E_WORKER_USER_ACTIVATION_REQUIRED'],exit:clean}).status,'blocked','A log cannot replace the actual fullscreen request/reply pair');
});

test('passive port observation preserves native send arguments/results and never starts ports or observes other operations',()=>{
 const records=[],sent=[],sentinel={nativeResult:true};let starts=0;
 class Port {
  constructor(){this.listeners=[];}
  addEventListener(type,callback){if(type==='message')this.listeners.push(callback);}
  postMessage(...args){sent.push({port:this,args});return sentinel;}
  start(){starts++;}
 }
 class Channel {constructor(){this.port1=new Port();this.port2=new Port();}}
 const identity={runId:'run',documentId:'document',workerId:'worker',runConfigurationHash:'b'.repeat(64)};
 const scope={MessageChannel:Channel,MessagePort:Port,location:{pathname:'/preview.html'},__playgroundRuntimeSession:()=>identity,__recordNativeHost:value=>records.push(value)};
 vm.runInNewContext('('+String(observeNativeHostPorts)+')()',scope);
 const channel=new scope.MessageChannel();assert(channel instanceof Channel);
 const incoming={...identity,protocolVersion:2,type:'host-command',commandSequence:1,command:{type:'dom-command',operation:'fullscreen',requestId:5}};
 for(const listener of channel.port1.listeners)listener({data:incoming});
 const wrongRun={...identity,runId:'wrong',protocolVersion:2,type:'host-state',state:{type:'dom-state',requestId:5,error:'E_WORKER_USER_ACTIVATION_REQUIRED'}};
 channel.port1.postMessage(wrongRun);assert.equal(records.length,1);
 const response={...identity,protocolVersion:2,type:'host-state',state:{type:'dom-state',requestId:5,error:'E_WORKER_USER_ACTIVATION_REQUIRED'}},transfer=[];
 assert.equal(channel.port1.postMessage(response,transfer),sentinel);
 assert.equal(sent.at(-1).args[0],response);assert.equal(sent.at(-1).args[1],transfer);
 assert.equal(records.length,2);assert.equal(starts,0);
 assert.equal(hasNativeFullscreenDenial([{stage:'requested',capability:'fullscreen',origin:'native-delayed-no-gesture',requestedAtUnixMs:0}],records),true);
 const count=records.length;
 for(const listener of channel.port1.listeners)listener({data:{...incoming,command:{...incoming.command,operation:'clipboard-read',requestId:6}}});
 channel.port1.postMessage({...response,state:{...response.state,requestId:6,result:'private clipboard contents'}});
 assert.equal(records.length,count);assert(!JSON.stringify(records).includes('private clipboard contents'));
});

test('native fixtures execute the selected candidate SDK and contain real Godot API calls',()=>{
 for(const sdkMode of ['production','development'])for(const naming of ['snake','camel'])for(const capability of HOST_CAPABILITIES){
  const files=nativeHostFixture({...options,capability,sdkMode,naming});
  assert.deepEqual(files.get('res://.godot/GodotJS/.playground/host-vendor.js'),sdkVendor);
  const source=new TextDecoder().decode(files.get('res://.godot/GodotJS/NativeHostProbe.js'));
  assert.doesNotThrow(()=>new Function(source));
  assert(source.includes("require('res://.godot/GodotJS/.playground/host-vendor.js')"));
  assert(source.includes('"sdkMode":"'+sdkMode+'"'));
  assert(source.includes("log('ready',{sdkMode:C.sdkMode})"));
  assert(source.includes("call(T('DisplayServer'),'clipboard_set'"));
  assert(source.includes("call(T('OS'),'shell_open'"));
  assert(source.includes("call(T('Input'),'set','mouse_mode',2)"));
  assert(source.includes("get(T('Input'),'mouse_mode')"));
  assert(!/get_mouse_mode|set_mouse_mode/.test(source));
  assert(new TextDecoder().decode(files.get('res://project.godot')).includes('driver/driver="Dummy"'));
 }
 for(const patch of [{sdkVendor:new Uint8Array()},{sdkMode:'unknown'},{activationDelayMs:5000},{popupUrl:'https://example.com/'},{popupUrl:'http://127.0.0.1.evil/'},{popupUrl:'http://user:pass@127.0.0.1/'}])assert.throws(()=>nativeHostFixture({...options,...patch}),/E_NATIVE_HOST_/);
});

test('native no-gesture denial requires actual log evidence, no browser call and complete retirement',()=>{
 const negative={negative:true,native:[{stage:'requested'}],browser:[{operation:'activation-after-delay',activation:false}],logs:['ERROR E_WORKER_USER_ACTIVATION_REQUIRED'],exit:clean};
 assert.equal(assessNativeHostCase('pointer-lock',negative).status,'passed');
 for(const patch of [{logs:[]},{browser:[]},{browser:[...negative.browser,{operation:'pointer-lock',phase:'called'}]},{exit:{...clean,hostCleanup:{status:'timed-out'}}},{exit:{...clean,reason:'forced-worker-termination'}},{native:[]}])assert.equal(assessNativeHostCase('pointer-lock',{...negative,...patch}).status,'blocked');
 assert.equal(assessNativeHostCase('pointer-lock',{...negative,native:[...negative.native,{stage:'error',message:'unexpected fault'}]}).status,'failed');
});

test('positive host effects require native observations and retirement rather than API presence',()=>{
 const basic={native:[{stage:'requested'},{stage:'finished',fullscreen:false,pointerLocked:false}],exit:clean};
 const cases={
  clipboard:{native:[...basic.native,{stage:'clipboard-native-cache',matchesSynthetic:true}],browser:['clipboard-write','clipboard-read'].map(operation=>({operation,phase:'resolved',matchesSynthetic:true}))},
  fullscreen:{native:[...basic.native,{stage:'native-state',fullscreen:true}],browser:[{operation:'fullscreenchange',active:true},{operation:'fullscreenchange',active:false}]},
  'pointer-lock':{native:[...basic.native,{stage:'native-state',pointerLocked:true}],browser:[{operation:'pointerlockchange',active:true},{operation:'pointerlockchange',active:false}]},
  downloads:{downloads:[{matchesSynthetic:true}],browser:[{operation:'download-url',phase:'created'},{operation:'download-url',phase:'revoked'}]},
  'url-open':{popupHits:1,browser:[{operation:'url-open',phase:'called',activation:true,localTarget:true}]},
 };
 for(const [capability,effect]of Object.entries(cases)){
  const observed={...basic,...effect};
  assert.equal(assessNativeHostCase(capability,observed).status,'passed',capability);
  assert.equal(assessNativeHostCase(capability,{...observed,exit:{...clean,hostCleanup:{status:'failed'}}}).status,'blocked',capability);
  assert.equal(assessNativeHostCase(capability,{...basic,browser:[{operation:'inventory',apiAvailable:true}]}).status,'blocked',capability);
 }
});

test('session admission rejects cross-run identity, stale configuration, wrong pack and incomplete Dummy cleanup',()=>{
 const configuration=structuredClone(DEFAULT_WORKER_RUN_CONFIGURATION);
 const identity={runId:'unit-run',documentId:'unit-document',workerId:'unit-worker',runConfigurationHash:runConfigurationHash(configuration)};
 const exit={...identity,...clean};
 const session={...identity,runConfiguration:configuration,buildKey:'a'.repeat(64),executionBackend:'worker',runtime:'godot',workerState:'native-exited',exit,workerErrors:[],glErrors:[],audio:{driver:'Dummy',kind:'dummy',closed:true,contextsCreated:0,contextsClosed:0,liveNodes:0,transferredChunksOwned:0,latePackets:0}};
 const entry={exit,packSha256:session.buildKey,states:[{identity}],native:[{stage:'ready',sdkMode:'production'}],sdkMode:'production',sdkVendor:{sdkMode:'production',sha256:'b'.repeat(64)}};
 const check=(s=session,e=entry)=>assertNativeHostSession(s,e,{presentationBackend:'direct',sdkMode:'production'});
 assert.doesNotThrow(()=>check());
 for(const patch of [{workerId:'different'},{buildKey:'different'},{runConfiguration:{...configuration,presentationBackend:'bitmap'}},{workerState:'terminated'},{workerErrors:['unexpected fault']},{glErrors:['GL error']},{audio:{...session.audio,liveNodes:1}}])assert.throws(()=>check({...session,...patch}));
 assert.throws(()=>check(session,{...entry,states:[]}));
 assert.throws(()=>check(session,{...entry,native:[{stage:'ready',sdkMode:'development'}]}));
});

test('hardware inventory and environment overrides cannot create a passing capability probe',()=>{
 const blocked=blockedNativeHostHardware([{gamepads:4,midiApi:true,ttsVoices:20,vibrateApi:true}]);
 assert.equal(blocked.length,4);assert(blocked.every(item=>item.status==='blocked'&&item.cause==='device-lifecycle-not-measured'));
 assert.equal(buildNativeHostProbe({browser:{settingsTier:'default'}},'clipboard',[],{}).status,'blocked');
 const entry={status:'passed',native:[],browser:[],sessions:[]};
 assert.equal(buildNativeHostProbe({browser:{settingsTier:'environment-override'}},'clipboard',[entry],{}).status,'blocked');
});

test('browser observer preserves actual API results and handles absent speech synthesis without collecting clipboard contents',async()=>{
 const records=[],listeners=new Map(),nativeRead='preexisting-private-clipboard';
 class Canvas {requestFullscreen(){return Promise.resolve('native-result');}requestPointerLock(){return undefined;}}
 class Document {exitFullscreen(){return Promise.resolve();}exitPointerLock(){}}
 class LocalURL extends URL {static createObjectURL(){return 'blob:unit';}static revokeObjectURL(){}}
 const scope={navigator:{clipboard:{writeText(){return Promise.resolve();},readText(){return Promise.resolve(nativeRead);}},userActivation:{isActive:false}},location:{pathname:'/preview.html',href:'http://127.0.0.1/preview.html',hostname:'127.0.0.1'},performance:{now:()=>1},document:{fullscreenEnabled:true,fullscreenElement:null,pointerLockElement:null,addEventListener:(name,callback)=>listeners.set(name,callback)},HTMLCanvasElement:Canvas,Document,URL:LocalURL,Blob,isSecureContext:true,setTimeout(){},addEventListener:(name,callback)=>listeners.set(name,callback),__recordNativeHost:value=>records.push(value),open:()=>null};
 scope.window=scope;
 vm.runInNewContext('('+String(observeNativeHost)+')({token:"native-host-unit"})',scope);
 assert.equal(records.find(value=>value.operation==='inventory').ttsVoices,0);
 assert.equal(await scope.navigator.clipboard.readText(),nativeRead);
 assert.equal(await new Canvas().requestFullscreen(),'native-result');
 assert(!JSON.stringify(records).includes(nativeRead));
 assert.equal(records.find(value=>value.operation==='clipboard-read'&&value.phase==='resolved').matchesSynthetic,false);
});
