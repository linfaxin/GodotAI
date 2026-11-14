import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerDom } from '../dist/worker-dom.js';
import { createInputHost } from '../dist/worker-dom-host.js';

const geometry={width:100,height:50,dpr:2,epoch:0,left:10,top:20};
class Canvas extends EventTarget {width=200;height=100;}
function setup() {
  const commands=[],canvas=new Canvas(),scope={OffscreenCanvas:Canvas,URL,navigator:{userAgent:'test',maxTouchPoints:2}};
  const dom=createWorkerDom({canvas,geometry,scope,sendHostCommand:command=>commands.push(command)});
  dom.applyHostState({type:'dom-state',clipboard:{write:true,read:true}});
  return {dom,scope,commands,canvas};
}
test('facade keeps OffscreenCanvas identity/native event target and restores own descriptors',()=>{
  const {dom,scope,canvas}=setup(),add=canvas.addEventListener;
  assert.ok(canvas instanceof scope.HTMLCanvasElement);assert.equal(scope.window.window,scope.window);
  assert.equal(scope.document.getElementById('canvas'),canvas);assert.equal(canvas.addEventListener,add);
  let lost=0;canvas.addEventListener('webglcontextlost',()=>lost++);canvas.dispatchEvent(new Event('webglcontextlost'));assert.equal(lost,1);
  dom.dispose();assert.equal(scope.window,undefined);assert.equal(canvas.focus,undefined);assert.equal(canvas.addEventListener,add);
});
test('navigator snapshots read branded native getters on the real Navigator instance',()=>{
  const navigator={};Object.defineProperty(navigator,'userAgent',{get(){assert.equal(this,navigator);return 'branded agent';}});
  const scope={OffscreenCanvas:Canvas,URL,navigator},dom=createWorkerDom({canvas:new Canvas(),geometry,scope,sendHostCommand(){}});
  assert.equal(scope.navigator.userAgent,'branded agent');dom.dispose();assert.equal(scope.navigator,navigator);
});
test('window fallback preserves real Worker constructors, static members and branded methods',()=>{
  class Canvas extends EventTarget{}class Socket{}const scope={OffscreenCanvas:Canvas,URL,navigator:{},Array,JSON,Promise,WebSocket:Socket,fetch(){assert.equal(this,scope);return 'fetch';}};
  const dom=createWorkerDom({canvas:new Canvas(),geometry,scope,sendHostCommand(){}});
  assert.equal(dom.window.Array,Array);assert.equal(dom.window.Array.isArray,Array.isArray);assert.equal(dom.window.JSON,JSON);assert.equal(dom.window.Promise,Promise);assert.equal(dom.window.WebSocket,Socket);assert.equal(dom.window.fetch(),'fetch');
  assert.equal(dom.window.window,dom.window);assert.equal(dom.window.self,dom.window);assert.throws(()=>dom.window.parent,/UNSUPPORTED_DOM/);
  let received=0;dom.window.addEventListener('focus',()=>received++);dom.window.dispatchEvent(new Event('focus'));assert.equal(received,1);dom.dispose();
});
test('release input is remapped to latest geometry without dropping older resize epoch',()=>{
  const {dom,canvas}=setup(),events=[];canvas.addEventListener('touchcancel',event=>events.push(event));
  dom.resize({...geometry,width:200,height:100,epoch:1});
  const packet={type:'dom-input',sequence:1,target:'canvas',event:'touchcancel',geometry,fields:{changedTouches:[{identifier:5,normalizedX:.5,normalizedY:.5}],touches:[]}};
  assert.equal(dom.dispatchInput(packet),true);assert.equal(events[0].changedTouches[0].clientX,110);assert.equal(events[0].changedTouches[0].clientY,70);
  assert.equal(dom.dispatchInput(packet),false);dom.dispose();
});
test('IME ordering and host value reflection do not echo value commands',()=>{
  const {dom,commands}=setup(),element=dom.document.createElement('div'),seen=[];
  element.contentEditable='true';dom.document.body.appendChild(element);element.addEventListener('compositionupdate',event=>seen.push(event.data));
  const before=commands.length;dom.dispatchInput({type:'dom-input',sequence:1,target:'element-1',event:'compositionupdate',fields:{data:'中文',value:'中文',selectionEnd:2}});
  assert.deepEqual(seen,['中文']);assert.equal(element.value,'中文');assert.equal(commands.length,before);
  assert.throws(()=>{element.innerHTML='<script></script>';},/DOM_HTML/);dom.dispose();
});
test('native IME start/end clears update the local mirror without replaying a delayed DOM clear',()=>{
  const {dom,commands}=setup(),ime=dom.document.createElement('div');ime.className='ime';ime.contentEditable='true';
  ime.addEventListener('compositionstart',()=>{ime.innerHTML='';});ime.addEventListener('compositionend',()=>{ime.innerHTML='';});
  let before=commands.length;dom.dispatchInput({type:'dom-input',sequence:1,target:'element-1',event:'compositionstart',fields:{data:''}});
  dom.dispatchInput({type:'dom-input',sequence:2,target:'element-1',event:'compositionend',fields:{data:'中文'}});assert.equal(commands.length,before);assert.equal(ime.innerHTML,'');
  // An explicit clear outside those native dispatches still crosses the ABI.
  ime.innerHTML='';assert.equal(commands.at(-1).operation,'property');assert.equal(commands.at(-1).name,'innerHTML');
  ime.addEventListener('compositionupdate',()=>{ime.innerHTML='';});before=commands.length;
  dom.dispatchInput({type:'dom-input',sequence:3,target:'element-1',event:'compositionupdate',fields:{data:'中'}});assert.equal(commands.length,before+1);dom.dispose();
});
test('clipboard request resolves once and disposal rejects remaining work',async()=>{
  const {dom,commands}=setup();const result=dom.window.navigator.clipboard.readText();
  dom.applyHostState({type:'dom-state',requestId:commands.at(-1).requestId,result:'hello'});assert.equal(await result,'hello');
  const abandoned=dom.window.navigator.clipboard.readText();dom.dispose();await assert.rejects(abandoned,/DOM_CLOSED/);
});
test('clipboard capabilities preserve the host native method availability',()=>{
  const {dom}=setup();dom.applyHostState({type:'dom-state',clipboard:{write:false,read:false}});assert.equal(dom.window.navigator.clipboard,undefined);
  dom.applyHostState({type:'dom-state',clipboard:{write:true,read:false}});assert.equal(typeof dom.window.navigator.clipboard.writeText,'function');assert.equal(dom.window.navigator.clipboard.readText,undefined);dom.dispose();
});
test('download clones its Blob before immediate URL revocation',()=>{
  const {dom,commands}=setup(),blob=new Blob(['bytes']),url=dom.window.URL.createObjectURL(blob),anchor=dom.document.createElement('a');
  anchor.href=url;anchor.download='out.bin';anchor.click();dom.window.URL.revokeObjectURL(url);
  const command=commands.find(command=>command.operation==='download');assert.equal(command.value.blob,blob);assert.equal(command.value.filename,'out.bin');dom.dispose();
});
test('speech mirrors capabilities and routes callbacks to the original utterance',()=>{
  const {dom,scope,commands}=setup();assert.equal('speechSynthesis' in dom.window,false);
  dom.applyHostState({type:'dom-state',speech:{available:true,speaking:false,paused:false,voices:[{name:'voice',lang:'en',voiceURI:'voice',localService:true,default:true}]}});
  const utterance=new scope.SpeechSynthesisUtterance('hello'),seen=[];utterance.addEventListener('boundary',event=>seen.push([event.currentTarget,event.charIndex]));dom.window.speechSynthesis.speak(utterance);
  const id=commands.at(-1).value.id;dom.applyHostState({type:'dom-state',speech:{available:true,speaking:true,paused:false,voices:[],event:{id,type:'boundary',charIndex:3}}});
  assert.deepEqual(seen,[[utterance,3]]);assert.equal(dom.window.speechSynthesis.speaking,true);assert.throws(()=>dom.window.alert('blocking'),/UNSUPPORTED/);dom.dispose();
});

class Node extends EventTarget {
  constructor(tag,document){super();this.tagName=tag.toUpperCase();this.ownerDocument=document;this.style={};this.tabIndex=-1;this.children=[];this.value='';this.selectionStart=0;this.selectionEnd=0;}
  appendChild(node){this.children.push(node);node.parentElement=this;return node;}
  remove(){this.removed=true;}
  get innerHTML(){return this.textContent??'';}
  set innerHTML(value){this.textContent=value;}
  click(){this.ownerDocument.clicks=(this.ownerDocument.clicks??0)+1;this.ownerDocument.lastDownload=this.download;}
  focus(){this.ownerDocument.activeElement=this;this.dispatchEvent(new Event('focus'));}
  blur(){this.ownerDocument.activeElement=null;this.dispatchEvent(new Event('blur'));}
  getBoundingClientRect(){return {left:10,top:20,width:100,height:50};}
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
}
function hostSetup(t){
  const document=new EventTarget(),window=new EventTarget(),states=[],inputs=[],errors=[];
  Object.assign(document,{defaultView:window,visibilityState:'visible',fullscreenEnabled:true,baseURI:'https://example.test/',createElement:tag=>new Node(tag,document),exitPointerLock(){document.pointerLockElement=null;document.dispatchEvent(new Event('pointerlockchange'));},exitFullscreen:async()=>{document.fullscreenElement=null;document.dispatchEvent(new Event('fullscreenchange'));}});
  document.body=new Node('body',document);document.head=new Node('head',document);
  Object.assign(window,{navigator:{getGamepads:()=>[],maxTouchPoints:0,userActivation:{isActive:false}},screen:{width:1920,height:1080},URL,open(url){window.opened=(window.opened??0)+1;window.openedUrls??=[];window.openedUrls.push(url);}});
  const canvas=new Node('canvas',document);document.body.appendChild(canvas);canvas.requestFullscreen=()=>{window.fullscreens=(window.fullscreens??0)+1;document.fullscreenElement=canvas;return Promise.resolve();};canvas.requestPointerLock=()=>{window.locks=(window.locks??0)+1;document.pointerLockElement=canvas;document.dispatchEvent(new Event('pointerlockchange'));return Promise.resolve();};
  const host=createInputHost({canvas,geometry,sendInput:packet=>inputs.push(packet),sendState:state=>states.push(state),onError:error=>errors.push(error)});t.after(()=>host.dispose());
  return {host,canvas,document,window,states,inputs,errors};
}
for(const operation of ['fullscreen','pointer-lock','pointer-lock-void'])test(`disposal waits for late ${operation} grant and actual compensating exit`,async t=>{
 const f=hostSetup(t);f.window.navigator.userActivation.isActive=true;
 let grant,exit,exits=0,finished=false;
 const gate=new Promise(resolve=>grant=resolve),exitGate=new Promise(resolve=>exit=resolve),pointer=operation!=='fullscreen',property=pointer?'pointerLockElement':'fullscreenElement';
 const granted=()=>{f.document[property]=f.canvas;f.document.dispatchEvent(new Event(pointer?'pointerlockchange':'fullscreenchange'));};
 f.canvas[pointer?'requestPointerLock':'requestFullscreen']=()=>operation==='pointer-lock-void'?undefined:gate.then(granted);
 if(pointer)f.document.exitPointerLock=()=>{exits++;void exitGate.then(()=>{f.document.pointerLockElement=null;f.document.dispatchEvent(new Event('pointerlockchange'));});};
 else f.document.exitFullscreen=()=>{exits++;return exitGate.then(()=>{f.document.fullscreenElement=null;});};
 assert.equal(f.host.command({type:'dom-command',operation:pointer?'pointer-lock':'fullscreen',requestId:1}),true);
 const disposal=f.host.dispose();assert.equal(f.host.dispose(),disposal);void disposal.then(()=>finished=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(exits,0);
 if(operation==='pointer-lock-void')granted();else grant();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(exits,1);assert.equal(finished,false,'real exit is still pending');
 exit();await disposal;assert.equal(f.document[property],null);assert.equal(finished,true);assert.deepEqual(f.errors,[]);
});
test('unresolved privileged operations have a Host-side admission limit',async t=>{
 const f=hostSetup(t);f.window.navigator.userActivation.isActive=true;let grant;
 const gate=new Promise(resolve=>grant=resolve);f.canvas.requestFullscreen=()=>gate.then(()=>{f.document.fullscreenElement=f.canvas;});
 for(let i=1;i<=32;i++)assert.equal(f.host.command({type:'dom-command',operation:'fullscreen',requestId:i}),true);
 assert.equal(f.host.command({type:'dom-command',operation:'fullscreen',requestId:33}),false);assert.match(f.states.at(-1).error,/REQUEST_BUDGET/);
 const disposal=f.host.dispose();grant();await disposal;assert.equal(f.document.fullscreenElement,null);
});
for(const api of ['promise','void'])test(`concurrent ${api} pointer-lock requests share one browser operation and late cleanup`,async t=>{
 const f=hostSetup(t),grants=[];let exits=0;
 f.window.navigator.userActivation.isActive=true;
 f.canvas.requestPointerLock=()=>{let resolve;const promise=new Promise(r=>resolve=r);grants.push(()=>{f.document.pointerLockElement=f.canvas;f.document.dispatchEvent(new Event('pointerlockchange'));resolve();});return api==='promise'?promise:undefined;};
 f.document.exitPointerLock=()=>{exits++;f.document.pointerLockElement=null;f.document.dispatchEvent(new Event('pointerlockchange'));};
 for(const requestId of [1,2])assert.equal(f.host.command({type:'dom-command',operation:'pointer-lock',requestId}),true);
 const disposal=f.host.dispose();let finished=false;void disposal.then(()=>{finished=true;});
 for(let i=0;i<10;i++)await Promise.resolve();const premature=finished;
 for(const grant of grants){grant();for(let i=0;i<20;i++)await Promise.resolve();}
 await disposal;const lateLock=f.document.pointerLockElement===f.canvas;
 if(lateLock)f.document.exitPointerLock();
 assert.equal(premature,false);assert.equal(grants.length,1);assert.equal(lateLock,false);assert.equal(exits,1);
});
test('Promise pointer-lock cleanup waits for its own native result despite a document grant event',async t=>{
 const f=hostSetup(t);let grant;const gate=new Promise(resolve=>grant=resolve);f.window.navigator.userActivation.isActive=true;f.canvas.requestPointerLock=()=>gate;
 f.host.command({type:'dom-command',operation:'pointer-lock',requestId:1});const disposal=f.host.dispose();let finished=false;void disposal.then(()=>{finished=true;});
 f.document.pointerLockElement=f.canvas;f.document.dispatchEvent(new Event('pointerlockchange'));
 for(let i=0;i<20;i++)await Promise.resolve();const premature=finished;
 grant();await disposal;assert.equal(premature,false);assert.equal(f.document.pointerLockElement,null);
});
test('void pointer-lock with existing ownership still waits for its new grant event before cleanup completes',async t=>{
 const f=hostSetup(t);let exits=0;f.window.navigator.userActivation.isActive=true;f.document.pointerLockElement=f.canvas;f.canvas.requestPointerLock=()=>undefined;
 f.document.exitPointerLock=()=>{exits++;f.document.pointerLockElement=null;f.document.dispatchEvent(new Event('pointerlockchange'));};
 f.host.command({type:'dom-command',operation:'pointer-lock',requestId:1});const disposal=f.host.dispose();let finished=false;void disposal.then(()=>{finished=true;});
 for(let i=0;i<20;i++)await Promise.resolve();const premature=finished;
 f.document.pointerLockElement=f.canvas;f.document.dispatchEvent(new Event('pointerlockchange'));await disposal;
 const lateLock=f.document.pointerLockElement===f.canvas;if(lateLock)f.document.exitPointerLock();
 assert.equal(premature,false);assert.equal(lateLock,false);assert.equal(exits,2);
});

test('host rejects activation requests now, never replays an old request on a future click',async t=>{
  const {host,window,canvas,states}=hostSetup(t);
  assert.equal(host.command({type:'dom-command',operation:'fullscreen',requestId:1}),false);assert.match(states.at(-1).error,/USER_ACTIVATION/);
  assert.equal(host.command({type:'dom-command',operation:'open',value:'https://example.test/',requestId:2}),false);
  window.navigator.userActivation.isActive=true;canvas.dispatchEvent(new Event('pointerdown'));canvas.dispatchEvent(new Event('mousedown'));
  assert.equal(window.fullscreens,undefined);assert.equal(window.opened,undefined);
  assert.equal(host.command({type:'dom-command',operation:'fullscreen',requestId:3}),true);await Promise.resolve();assert.equal(window.fullscreens,1);
});
test('host accepts only constrained editable nodes, forwards release outside canvas, and cleans listeners',t=>{
  const {host,window,document,inputs,canvas}=hostSetup(t);
  assert.equal(host.command({type:'dom-command',operation:'create',target:'element-1',name:'script'}),false);
  assert.equal(host.command({type:'dom-command',operation:'create',target:'element-1',name:'div'}),true);
  assert.equal(host.command({type:'dom-command',operation:'property',target:'element-1',name:'innerHTML',value:'<img>'}),false);
  assert.equal(host.command({type:'dom-command',operation:'append',target:'element-1'}),true);
  const ime=document.body.children.at(-1);ime.value='a';ime.dispatchEvent(new Event('input'));assert.equal(inputs.at(-1).fields.value,'a');
  canvas.dispatchEvent(new Event('mousedown'));const release=new Event('mouseup');Object.defineProperties(release,{clientX:{value:60},clientY:{value:45}});window.dispatchEvent(release);
  assert.equal(inputs.at(-1).target,'window');assert.equal(inputs.at(-1).fields.normalizedX,.5);
  host.dispose();const count=inputs.length;window.dispatchEvent(new Event('mouseup'));assert.equal(inputs.length,count);assert.equal(ime.removed,true);
});
test('host IME clears at start before forwarding, preserves preedit updates, and snapshots end before clearing',t=>{
  const {host,document,inputs}=hostSetup(t);
  host.command({type:'dom-command',operation:'create',target:'element-1',name:'div'});
  host.command({type:'dom-command',operation:'property',target:'element-1',name:'className',value:'ime'});
  host.command({type:'dom-command',operation:'append',target:'element-1'});const ime=document.body.children.at(-1);delete ime.value;ime.textContent='old';
  ime.dispatchEvent(new Event('compositionstart'));assert.equal(ime.textContent,'');assert.equal(inputs.at(-1).fields.value,'');
  ime.textContent='中文';ime.dispatchEvent(new Event('compositionupdate'));assert.equal(ime.textContent,'中文');
  const end=new Event('compositionend');Object.defineProperty(end,'data',{value:'中文'});ime.dispatchEvent(end);
  assert.equal(inputs.at(-1).fields.data,'中文');assert.equal(inputs.at(-1).fields.value,'中文');assert.equal(ime.textContent,'');
});
test('input host gates outside moves, pairs only canvas presses, and synthesizes releases on blur',t=>{
  const {window,canvas,inputs,document}=hostSetup(t);
  window.dispatchEvent(new Event('mousemove'));window.dispatchEvent(new Event('mouseup'));assert.equal(inputs.length,0);
  canvas.dispatchEvent(new Event('mousedown'));document.activeElement=null;window.dispatchEvent(new Event('mousemove'));assert.equal(inputs.at(-1).event,'mousemove');
  window.dispatchEvent(new Event('mouseup'));assert.equal(inputs.at(-1).event,'mouseup');const released=inputs.length;
  window.dispatchEvent(new Event('mouseup'));window.dispatchEvent(new Event('mousemove'));assert.equal(inputs.length,released);
  canvas.dispatchEvent(new Event('mousedown'));const down=new Event('keydown');Object.defineProperties(down,{key:{value:'j'},code:{value:'KeyJ'}});canvas.dispatchEvent(down);
  canvas.blur();assert.equal(inputs.filter(value=>value.event==='mouseup').length,2);assert.equal(inputs.filter(value=>value.event==='keyup'&&value.fields.code==='KeyJ').length,1);
  const afterBlur=inputs.length;window.dispatchEvent(new Event('mouseup'));window.dispatchEvent(new Event('mousemove'));assert.equal(inputs.length,afterBlur);
});
test('wheel blocks browser scrolling only while canvas focus, lock or its held sequence captures it',t=>{
  const {canvas,document,inputs}=hostSetup(t);
  const free=new Event('wheel',{cancelable:true});canvas.dispatchEvent(free);assert.equal(free.defaultPrevented,false);assert.equal(inputs.length,0);
  canvas.focus();const focused=new Event('wheel',{cancelable:true});canvas.dispatchEvent(focused);assert.equal(focused.defaultPrevented,true);assert.equal(inputs.at(-1).event,'wheel');
  canvas.blur();document.pointerLockElement=canvas;const locked=new Event('wheel',{cancelable:true});canvas.dispatchEvent(locked);assert.equal(locked.defaultPrevented,true);
});
test('pointerdown stays uncancelled so the browser can generate native mouse compatibility events',t=>{
  const {canvas}=hostSetup(t),pointer=new Event('pointerdown',{cancelable:true});canvas.dispatchEvent(pointer);assert.equal(pointer.defaultPrevented,false);
  const mouse=new Event('mousedown',{cancelable:true});canvas.dispatchEvent(mouse);assert.equal(mouse.defaultPrevented,true);
});
test('host clones a bounded drop once, rejects concurrent drops and accepts only the matching completion ticket',async t=>{
  const {host,canvas,inputs,errors}=hostSetup(t),file=new File(['saved bytes'],'dropped.txt');
  function drop(){const event=new Event('drop',{cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});canvas.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
  drop();await new Promise(resolve=>setTimeout(resolve,0));const packet=inputs.find(value=>value.event==='drop');assert.equal(await packet.fields.drop.entries[0].file.text(),'saved bytes');
  drop();assert.match(errors.at(-1).message,/DROP_BUSY/);assert.equal(host.command({type:'dom-command',operation:'drop-release',value:{dropId:999}}),false);
  assert.equal(host.command({type:'dom-command',operation:'drop-release',value:{dropId:packet.fields.drop.dropId}}),true);drop();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(inputs.filter(value=>value.event==='drop').length,2);
});
test('native paste receives the text captured by the host clipboard event',()=>{
  const {dom}=setup();let text;dom.window.addEventListener('paste',event=>{text=event.clipboardData.getData('text');});
  dom.dispatchInput({type:'dom-input',sequence:1,target:'window',event:'paste',fields:{clipboardText:'中文 paste'}});assert.equal(text,'中文 paste');dom.dispose();
});
test('host downloads cloned Blob and refuses navigational schemes on open',async t=>{
  const {host,document,window,states}=hostSetup(t);
  assert.equal(host.command({type:'dom-command',operation:'download',value:{blob:new Blob(['saved']),filename:'result.bin'}}),true);
  assert.equal(document.clicks,1);assert.equal(document.lastDownload,'result.bin');
  window.navigator.userActivation.isActive=true;
  host.command({type:'dom-command',operation:'open',value:'javascript:alert(1)',requestId:1});await Promise.resolve();
  assert.match(states.at(-1).error,/OPEN_SCHEME/);assert.equal(window.opened,undefined);
});
test('shell_open delegates tel and legal custom schemes to the activated browser',async t=>{
  const {host,window}=hostSetup(t);window.navigator.userActivation.isActive=true;
  assert.equal(host.command({type:'dom-command',operation:'open',value:'tel:+12345678',requestId:1}),true);
  assert.equal(host.command({type:'dom-command',operation:'open',value:'web+custom-app:launch?item=1',requestId:2}),true);await Promise.resolve();
  assert.deepEqual(window.openedUrls,['tel:+12345678','web+custom-app:launch?item=1']);
});
test('host TTS emits lifecycle data from its actual utterance',t=>{
  const {host,window,states}=hostSetup(t),speech=new EventTarget();
  class Utterance extends EventTarget {constructor(text){super();this.text=text;}}
  window.SpeechSynthesisUtterance=Utterance;window.speechSynthesis=speech;
  Object.assign(speech,{speaking:false,paused:false,getVoices:()=>[{name:'Voice',lang:'en',voiceURI:'voice',localService:true,default:true}],speak(utterance){this.latest=utterance;this.speaking=true;},cancel(){this.speaking=false;}});
  assert.equal(host.command({type:'dom-command',operation:'tts-speak',value:{id:1,text:'words',rate:1,pitch:1,volume:.5,voiceName:'Voice'}}),true);
  const event=new Event('boundary');Object.defineProperty(event,'charIndex',{value:2});speech.latest.dispatchEvent(event);
  assert.deepEqual(states.at(-1).speech.event,{id:1,type:'boundary',charIndex:2});assert.equal(states.at(-1).speech.speaking,true);
});

test('logical HTTP base resolves global and window fetch while preserving Request identity and options',async()=>{
 const calls=[],physical={href:'blob:https://preview.test/verified-id'},nativeFetch=function(input,init){assert.equal(this,scope);calls.push({input,init});return Promise.resolve('ok');};
 const scope={OffscreenCanvas:Canvas,URL,navigator:{},location:physical,fetch:nativeFetch};const descriptor=Object.getOwnPropertyDescriptor(scope,'fetch');
 const dom=createWorkerDom({canvas:new Canvas(),geometry,scope,baseUrl:'https://preview.test/app/preview.html?run=1#hash',sendHostCommand(){}});
 try{
  const init={credentials:'include',headers:{'x-test':'1'}};await scope.fetch('./echo',init);await dom.window.fetch('/echo');await dom.window.fetch(new URL('https://other.test/absolute'));
  const request=new Request('https://preview.test/request',{method:'POST',body:'hello'});await scope.fetch(request,init);
  assert.deepEqual(calls.map(c=>typeof c.input==='string'?c.input:c.input.url),['https://preview.test/app/echo','https://preview.test/echo','https://other.test/absolute','https://preview.test/request']);
  assert.equal(calls[0].init,init);assert.equal(calls[3].input,request);assert.equal(calls[3].init,init);
  assert.equal(scope.location,physical);assert.equal(dom.window.location.href,'https://preview.test/app/preview.html?run=1#hash');assert.equal(String(dom.window.location),dom.window.location.href);assert.equal(dom.document.baseURI,dom.window.location.href);assert(Object.isFrozen(dom.window.location));
  const invalid=scope.fetch('https://[');assert(invalid instanceof Promise);await assert.rejects(invalid,TypeError);assert.equal(calls.length,4);
 }finally{dom.dispose();}assert.deepEqual(Object.getOwnPropertyDescriptor(scope,'fetch'),descriptor);
});

test('invalid logical document base fails before installing DOM or replacing fetch',()=>{
 for(const baseUrl of ['blob:https://preview.test/id','file:///tmp/preview.html','https://user:pass@preview.test/a','./relative']){
  const canvas=new Canvas(),scope={OffscreenCanvas:Canvas,URL,navigator:{},fetch};const before=Object.getOwnPropertyDescriptors(scope);
  assert.throws(()=>createWorkerDom({canvas,geometry,scope,baseUrl,sendHostCommand(){}}));assert.deepEqual(Object.getOwnPropertyDescriptors(scope),before);assert.equal(canvas.focus,undefined);
 }
});
