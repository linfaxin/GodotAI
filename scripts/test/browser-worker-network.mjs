#!/usr/bin/env node
/** Native HTTPRequest/WebSocketPeer through the unchanged schema-3 production
 * UI, official iframe host and verified runtime Worker. The only added server
 * behavior is an RFC6455 echo upgrade at the preview origin; site bytes/CSP are
 * unchanged. This does not use WebRTC, external network services or DOM RPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launchBrowser,withAcceptanceContext,installPassiveRecorder} from '../../apps/playground/scripts/browser-harness.mjs';
import {createStaticServer} from '../../apps/playground/scripts/serve.mjs';
import {siteIdentity} from '../../apps/playground/scripts/site-evidence.mjs';
const repository=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??path.join(repository,'apps/playground/dist'));
const presenter=process.env.PLAYGROUND_PRESENTATION_BACKEND??'direct';assert(['direct','bitmap'].includes(presenter));
const output=path.resolve(process.env.PLAYGROUND_WORKER_NETWORK_REPORT??path.join(repository,`work/worker-migration/network-${process.env.BROWSER??'chromium'}-${presenter}.json`));
const timeout=Number(process.env.PLAYGROUND_WORKER_NETWORK_TIMEOUT??120000);
const servers=[createStaticServer(directory),createStaticServer(directory)],sockets=new Set(),echoes=[],browserErrors=[],sessions=new Map();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
let browser,context,page,identity,activeStage='candidate',httpEvidence,websocketEvidence,scopeEvidence;
function serverFrame(opcode,payload){const length=payload.length;assert(length<=65535);const header=length<126?Buffer.from([0x80|opcode,length]):Buffer.from([0x80|opcode,126,length>>8,length&255]);return Buffer.concat([header,payload]);}
// Small, deliberately strict RFC6455 endpoint: masked FIN text/binary frames,
// ping/pong and close. Invalid/fragmented/oversized frames terminate explicitly.
servers[1].on('upgrade',(request,socket,head)=>{
 if(request.url!=='/native-network-echo'||request.headers.upgrade?.toLowerCase()!=='websocket'||request.headers['sec-websocket-version']!=='13'||typeof request.headers['sec-websocket-key']!=='string'){socket.destroy();return;}
 const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffered=Buffer.alloc(0);
 function consume(data){buffered=Buffer.concat([buffered,data]);if(buffered.length>131072){socket.destroy(Error('WebSocket echo input budget'));return;}
  while(buffered.length>=2){const first=buffered[0],second=buffered[1],opcode=first&15;if(!(first&128)||(first&0x70)||!(second&128)||![1,2,8,9,10].includes(opcode)){socket.destroy(Error('Invalid WebSocket echo frame'));return;}let length=second&127,offset=2;if(length===127){socket.destroy(Error('WebSocket echo payload budget'));return;}if(length===126){if(buffered.length<4)return;length=buffered.readUInt16BE(2);offset=4;}if(length>65535||(opcode>=8&&length>125)){socket.destroy(Error('WebSocket echo payload budget'));return;}if(buffered.length<offset+4+length)return;const mask=buffered.subarray(offset,offset+4),payload=Buffer.from(buffered.subarray(offset+4,offset+4+length));for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];buffered=buffered.subarray(offset+4+length);
   if(opcode===8){socket.end(serverFrame(8,payload));return;}if(opcode===9){socket.write(serverFrame(10,payload));continue;}if(opcode===10)continue;echoes.push({opcode,bytes:payload.length,sha256:sha(payload)});socket.write(serverFrame(opcode,payload));
  }
 }
 socket.on('data',consume);if(head.length)consume(head);
});
const source=(httpUrl,wsUrl)=>`import {Node2D,HTTPRequest,WebSocketPeer,PackedByteArray,JavaScriptBridge,Callable} from 'godot';
const send=(type:string,value:any={})=>JavaScriptBridge.get_interface('window')!.call('__godotjsProjectEvent',JSON.stringify({type,...value}));
export default class Main extends Node2D{
 http!:HTTPRequest;socket!:WebSocketPeer;sent=false;received=0;httpDone=false;wsDone=false;done=false;
 _ready(){
  const json=JavaScriptBridge.get_interface('JSON'),array=JavaScriptBridge.get_interface('Array'),websocket=JavaScriptBridge.get_interface('WebSocket');
  if(!json||!array||!websocket)throw Error('Worker global interface missing');
  const empty=JavaScriptBridge.create_object('Array');
  send('network-scope',{json:String(json.call('stringify','native-worker')),array:!!array.call('isArray',empty),identity:!!JavaScriptBridge.eval('window.JSON===JSON&&window.Array===Array&&window.WebSocket===WebSocket',true),worker:!!JavaScriptBridge.eval('globalThis instanceof WorkerGlobalScope',true)});
  this.http=new HTTPRequest();this.add_child(this.http);this.http.timeout=15;
  this.http.request_completed.connect(Callable.create((result:any,status:any,headers:any,body:any)=>{send('network-http',{result:Number(result),status:Number(status),body:body.get_string_from_utf8(),bytes:Number(body.size())});this.httpDone=true;}));
  const code=this.http.request(${JSON.stringify(httpUrl)});if(Number(code)!==0)throw Error('Native HTTPRequest rejected: '+code);
  this.socket=new WebSocketPeer();const connected=this.socket.connect_to_url(${JSON.stringify(wsUrl)});if(Number(connected)!==0)throw Error('Native WebSocketPeer rejected: '+connected);
 }
 _process(){
  if(!this.socket)return;this.socket.poll();const state=Number(this.socket.get_ready_state());
  if(state===1&&!this.sent){this.sent=true;const binary=new PackedByteArray();binary.push_back(0);binary.push_back(255);binary.push_back(17);const a=this.socket.send_text('native-worker-text'),b=this.socket.send(binary,1);if(Number(a)!==0||Number(b)!==0)throw Error('Native socket send refused');}
  while(Number(this.socket.get_available_packet_count())>0){const data=this.socket.get_packet(),string=this.socket.was_string_packet(),bytes:number[]=[];for(let i=0;i<Number(data.size());i++)bytes.push(Number(data.get(i)));send('network-ws',{string,text:string?data.get_string_from_utf8():null,bytes});if(++this.received===2){this.wsDone=true;this.socket.close(1000,'native acceptance complete');}}
  if(this.httpDone&&this.wsDone&&!this.done){this.done=true;send('network-complete');}
  if(state===3&&!this.wsDone)throw Error('Native socket closed before echo: '+this.socket.get_close_code()+' '+this.socket.get_close_reason());
 }
 _exit_tree(){this.socket?.close();this.http?.cancel_request();}
}`;
async function event(type){await page.waitForFunction(type=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));if(state?.engine?.state==='exited'&&document.querySelector('#status')?.textContent==='运行错误')throw Error(document.querySelector('#logs')?.textContent);return state?.events.some(event=>event.type===type);},type,{timeout});return (await page.evaluate(()=>globalThis.__playgroundWorkbench.inspect())).events.filter(event=>event.type===type);}
try{
 identity=await siteIdentity(directory);const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));assert.equal(manifest.schemaVersion,3);assert.equal(manifest.runtime.executionBackend,'worker');assert(manifest.runtime.presentationBackends.includes(presenter));
 await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));const [editorOrigin,previewOrigin]=servers.map(server=>'http://127.0.0.1:'+server.address().port),httpUrl=previewOrigin+'/catalog.json',wsUrl=previewOrigin.replace('http:','ws:')+'/native-network-echo';
 const project={schemaVersion:3,engineProfile:identity.profile,runtime:'godot',demoId:'native',entry:'/src/Main.ts',selected:'/src/Main.ts',mode:'production',controls:{},files:{'/project.godot':'config_version=5\n[application]\nconfig/name="Native Worker network acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n','/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n','/src/Main.ts':source(httpUrl,wsUrl)}};
 browser=await launchBrowser({headless:true,args:['--no-sandbox']});context=await browser.newContext({viewport:{width:1440,height:1000}});await installPassiveRecorder(context,'__recordNetworkSession',(_source,value)=>{if(value?.workerId)sessions.set(value.workerId,structuredClone(value));});await context.addInitScript(()=>addEventListener('playground-runtime-session',event=>{void globalThis.__recordNetworkSession(event.detail);}));page=await context.newPage();page.on('pageerror',error=>browserErrors.push(String(error)));page.setDefaultTimeout(timeout);
 activeStage='production-ui-import';await page.goto(`${editorOrigin}/?project=native&executionBackend=worker&presentationBackend=${presenter}&previewOrigin=${encodeURIComponent(previewOrigin)}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready,null,{timeout});await page.locator('#import').setInputFiles({name:'native-worker-network.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});await page.waitForFunction(source=>{const state=globalThis.__playgroundWorkbench?.inspect();return state?.project.files[state.project.entry]===source;},project.files[project.entry],{timeout});
 activeStage='native-network';await event('network-complete');const state=await page.evaluate(()=>globalThis.__playgroundWorkbench.inspect());scopeEvidence=(await event('network-scope'))[0];assert.equal(scopeEvidence.json,'"native-worker"');assert.equal(scopeEvidence.array,true);assert.equal(scopeEvidence.identity,true);assert.equal(scopeEvidence.worker,true);
 const received=(await event('network-http'))[0],catalog=await fs.readFile(path.join(directory,'catalog.json'));assert.equal(received.result,0);assert.equal(received.status,200);assert.equal(received.bytes,catalog.length);assert.equal(sha(received.body),sha(catalog));httpEvidence={result:received.result,status:received.status,bytes:received.bytes,sha256:sha(received.body)};
 websocketEvidence=await event('network-ws');assert.equal(websocketEvidence.length,2);assert(websocketEvidence.some(packet=>packet.string&&packet.text==='native-worker-text'));assert(websocketEvidence.some(packet=>!packet.string&&packet.bytes.join(',')==='0,255,17'));assert.deepEqual(echoes.map(frame=>frame.opcode).sort(),[1,2]);assert.equal(state.engine.state,'running');
 activeStage='cleanup';const iframe=await page.locator('#preview iframe').elementHandle();assert(iframe);const preview=await iframe.contentFrame();await iframe.dispose();const current=await preview.evaluate(()=>{const value=globalThis.__playgroundRuntimeSession;return typeof value==='function'?value():value;});assert(current?.workerId);await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout:20000});for(let count=0;count<100&&sessions.get(current.workerId)?.exit?.hostCleanup?.status!=='complete';count++)await new Promise(resolve=>setTimeout(resolve,25));const completed=sessions.get(current.workerId);assert.equal(completed?.exit?.hostCleanup?.status,'complete');assert(completed);assert.equal(completed.executionBackend,'worker');assert.equal(completed.presentationBackend,presenter);assert.deepEqual(browserErrors,[]);assert.equal((await siteIdentity(directory)).siteHash,identity.siteHash,'Candidate changed during network acceptance');
 const report=await withAcceptanceContext({kind:'worker-native-network',status:'passed',candidateId:identity.candidateId,siteHash:identity.siteHash,presentationBackend:presenter,fixtureSha256:sha(project.files['/src/Main.ts']),scope:scopeEvidence,http:httpEvidence,websocket:websocketEvidence,echoes,sessions:[...sessions.values()],browserErrors},{directory,browser});await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){const report={kind:'worker-native-network',status:'failed',activeStage,error:String(error),stack:error.stack,candidate:identity?{candidateId:identity.candidateId,siteHash:identity.siteHash}:null,scope:scopeEvidence,http:httpEvidence,websocket:websocketEvidence,echoes,sessions:[...sessions.values()],browserErrors,last:await page?.evaluate(()=>({inspect:globalThis.__playgroundWorkbench?.inspect(),logs:document.querySelector('#logs')?.textContent})).catch(()=>null)};await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));process.exitCode=1;
}finally{await context?.close();await browser?.close();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(close));}
