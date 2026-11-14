#!/usr/bin/env node
// Real browser WebRTC loopback through the production Worker/iframe broker.
// No ICE servers or external signaling service; this is not a Godot engine seal.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const require=createRequire(new URL('../../apps/playground/package.json',import.meta.url)),{build}=require('esbuild'),{chromium}=require('playwright');
const source=new URL('../jsb.react-browser/src/worker-browser.ts',import.meta.url).pathname;
const common={bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'};
const host=(await build({...common,stdin:{contents:`import {createWorkerBrowserHost} from ${JSON.stringify(source)};globalThis.makeHost=createWorkerBrowserHost;`,resolveDir:process.cwd(),sourcefile:'rtc-host.ts'}})).outputFiles[0].text;
const worker=(await build({...common,stdin:{contents:`import {createWorkerBrowserClient} from ${JSON.stringify(source)};
onmessage=async({data})=>{let client;try{client=createWorkerBrowserClient({port:data.port,onError:error=>postMessage({type:'broker-error',message:error.message})});
 const a=new client.RTCPeerConnection({iceServers:[]}),b=new client.RTCPeerConnection({iceServers:[]});
 let ready=false;const iceA=[],iceB=[];a.onicecandidate=e=>{if(e.candidate){if(ready)b.addIceCandidate(e.candidate).catch(error=>postMessage({type:'error',message:error.message}));else iceA.push(e.candidate);}};b.onicecandidate=e=>{if(e.candidate){if(ready)a.addIceCandidate(e.candidate).catch(error=>postMessage({type:'error',message:error.message}));else iceB.push(e.candidate);}};
 b.ondatachannel=e=>{e.channel.onmessage=event=>{if(typeof event.data==='string')e.channel.send('echo:'+event.data);else e.channel.send(event.data);};};
 a.onconnectionstatechange=()=>postMessage({type:'state',peer:'a',value:a.connectionState});b.onconnectionstatechange=()=>postMessage({type:'state',peer:'b',value:b.connectionState});const channel=a.createDataChannel('native-broker'),received=[];
 const completed=new Promise((resolve,reject)=>{channel.onerror=e=>reject(e.error);channel.onopen=()=>{channel.send('hello');const bytes=new Uint8Array([3,1,4]);channel.send(bytes);postMessage({type:'send-owned',bytes:bytes.byteLength});};channel.onmessage=e=>{received.push(typeof e.data==='string'?e.data:[...new Uint8Array(e.data)]);if(received.length===2)resolve(received);};});
 const offer=await a.createOffer();await a.setLocalDescription(offer);await b.setRemoteDescription(offer);const answer=await b.createAnswer();await b.setLocalDescription(answer);await a.setRemoteDescription(answer);ready=true;await Promise.all([...iceA.map(c=>b.addIceCandidate(c)),...iceB.map(c=>a.addIceCandidate(c))]);
 postMessage({type:'negotiated',a:a.localDescription?.type,b:b.localDescription?.type,iceA:iceA.length,iceB:iceB.length});const messages=await completed;postMessage({type:'passed',messages,worker:self instanceof WorkerGlobalScope,shared:typeof SharedArrayBuffer,a:a.connectionState,b:b.connectionState});
 a.close();b.close();client.dispose();postMessage({type:'disposed'});
}catch(error){postMessage({type:'error',message:String(error),stack:error?.stack});client?.dispose();}};`,resolveDir:process.cwd(),sourcefile:'rtc-worker.ts'}})).outputFiles[0].text;
const server=createServer((request,response)=>{if(request.url==='/host.js')response.writeHead(200,{'content-type':'text/javascript'}).end(host);else if(request.url==='/worker.js')response.writeHead(200,{'content-type':'text/javascript'}).end(worker);else response.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><script src="/host.js"></script>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));let browser;
const output=resolve(process.env.WORKER_RTC_REPORT_DIR??new URL('../../work/worker-validation/webrtc-results',import.meta.url).pathname);await mkdir(output,{recursive:true});
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(()=>new Promise((resolve,reject)=>{const events=[],ports=new MessageChannel(),host=globalThis.makeHost({port:ports.port1,onError:error=>events.push({type:'host-error',message:error.message})}),worker=new Worker('/worker.js');const timer=setTimeout(()=>{worker.terminate();host.dispose();reject(Error('RTC loopback deadline '+JSON.stringify(events)));},20000);worker.onmessage=({data})=>{events.push(data);if(data.type==='error'||data.type==='broker-error'){clearTimeout(timer);worker.terminate();host.dispose();reject(Error(JSON.stringify(events)));}else if(data.type==='disposed'){clearTimeout(timer);worker.terminate();host.dispose();resolve(events);}};worker.postMessage({port:ports.port2},[ports.port2]);}));
 assert.deepEqual(errors,[]);assert(!result.some(x=>x.type==='host-error'));const passed=result.find(x=>x.type==='passed');assert.equal(passed.worker,true);assert.equal(passed.shared,'undefined');assert(passed.messages.includes('echo:hello'));assert(passed.messages.some(x=>Array.isArray(x)&&x.join(',')==='3,1,4'));assert.equal(result.find(x=>x.type==='send-owned').bytes,3);
 const report={kind:'real-browser-worker-webrtc-loopback',status:'passed',browser:browser.version(),sourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),workerSha256:createHash('sha256').update(worker).digest('hex'),events:result};await writeFile(join(output,'webrtc.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){
 const policy=await readFile('/etc/chromium/policies/managed/misc.json','utf8').then(JSON.parse).catch(()=>undefined);
 const environmentBlock=policy?.WebRtcIPHandling==='disable_non_proxied_udp'&&String(error).includes('RTC loopback deadline');
 const report={kind:'real-browser-worker-webrtc-loopback',status:environmentBlock?'blocked':'failed',environment:environmentBlock?{reason:'Managed browser policy disables non-proxied UDP; native ICE loopback did not connect.',policy:'WebRtcIPHandling=disable_non_proxied_udp',source:'/etc/chromium/policies/managed/misc.json'}:undefined,browser:browser?.version(),sourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),workerSha256:createHash('sha256').update(worker).digest('hex'),error:String(error)};await writeFile(join(output,'webrtc.json'),JSON.stringify(report,null,2)+'\n');throw error;
}finally{await browser?.close();await new Promise(done=>server.close(done));}
