#!/usr/bin/env node
/** Real-browser observation transparency. No Playwright evaluate, waitForFunction
 * or exposed binding is used before the activation assertions. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser,installPassiveRecorder,browserLaunchEvidence,observedWorkerSessions,observedWorkerOutcomes} from './browser-harness.mjs';

export async function verifyPassiveRecorder({out}={}){
 const server=createServer((request,response)=>{if(new URL(request.url,'http://fixture').pathname==='/favicon.ico'){response.writeHead(204).end();return;}response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end('<!doctype html><button id="activate">Activate</button>'+ (request.url==='/frame'?'':'<iframe src="/frame"></iframe>'));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const records=[],errors=[];let browser,context,cdp;
 const report={schemaVersion:1,kind:'passive-recorder-activation-proof',status:'running',method:'console event text only; Chromium CDP Runtime.evaluate with userGesture:false for state reads'};
 try{
  browser=await launchBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});context=await browser.newContext();
  const recorder=await installPassiveRecorder(context,'__passiveActivationRecord',(_source,value)=>records.push(value));
  context.on('console',message=>{const text=message.text();if(!text.startsWith('__godot_passive_recorder_'))return;try{const packet=JSON.parse(text.slice(text.indexOf(':')+1)),snapshot=packet.args?.[0];if(snapshot?.fixtureStage&&snapshot.workerId==='activation-fixture-'+snapshot.fixtureRealm)records.push({realm:snapshot.fixtureRealm,kind:'session-snapshot',stage:snapshot.fixtureStage,...snapshot.fixtureActivation});}catch(error){errors.push('Console metadata observer: '+String(error));}});
  await context.addInitScript(()=>{
   if(location.protocol!=='http:'||!['/','/frame'].includes(location.pathname))return;
   let sequence=0;
   const record=(kind,detail={})=>void globalThis.__passiveActivationRecord({...detail,realm:location.pathname,kind,sequence:++sequence,hasBeenActive:navigator.userActivation.hasBeenActive,isActive:navigator.userActivation.isActive});
   setInterval(()=>record('periodic'),20);addEventListener('click',event=>{if(event.isTrusted)record('trusted-click');});
   // Synthetic frozen fixtures exercise the actual auto-installed session
   // collector, including event/poll duplicates and asynchronous finalization.
   // They assert transport behavior, never an engine capability.
   setTimeout(()=>{
    let current;
    const publish=(fixtureStage,fields={})=>{current=Object.freeze({workerId:'activation-fixture-'+location.pathname,workerState:'running',fixtureStage,fixtureRealm:location.pathname,fixtureActivation:{hasBeenActive:navigator.userActivation.hasBeenActive,isActive:navigator.userActivation.isActive},...fields});dispatchEvent(new CustomEvent('playground-runtime-session',{detail:current}));};
    globalThis.__playgroundRuntimeSession=()=>current;
    publish('running-initial');setInterval(()=>dispatchEvent(new CustomEvent('playground-runtime-session',{detail:current})),10);
    setTimeout(()=>publish('running-memory',{memory:{serial:2}}),100);
    setTimeout(()=>publish('closing',{closing:true}),150);
    setTimeout(()=>publish('native-exited',{workerState:'native-exited'}),200);
    setTimeout(()=>publish('terminal',{workerState:'native-exited',exit:{hostCleanup:{status:'complete'}}}),250);
   },0);
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
  cdp=await context.newCDPSession(page);await cdp.send('Runtime.enable');
  const read=async()=>{const response=await cdp.send('Runtime.evaluate',{expression:'({top:{hasBeenActive:navigator.userActivation.hasBeenActive,isActive:navigator.userActivation.isActive},frame:{hasBeenActive:document.querySelector("iframe").contentWindow.navigator.userActivation.hasBeenActive,isActive:document.querySelector("iframe").contentWindow.navigator.userActivation.isActive}})',userGesture:false,returnByValue:true});if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));return response.result.value;};
  report.before=await read();const deadline=Date.now()+15000;
  while((records.filter(record=>record.realm==='/').length<15||records.filter(record=>record.realm==='/frame').length<15||!['/','/frame'].every(realm=>records.some(record=>record.realm===realm&&record.kind==='session-snapshot'&&record.stage==='terminal')))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert(records.filter(record=>record.realm==='/').length>=15);assert(records.filter(record=>record.realm==='/frame').length>=15);report.afterRecords=await read();
  assert.deepEqual(report.before,{top:{hasBeenActive:false,isActive:false},frame:{hasBeenActive:false,isActive:false}});
  assert.deepEqual(report.afterRecords,report.before);assert(records.every(record=>record.hasBeenActive===false&&record.isActive===false));
  report.sessionRecorderFixture={synthetic:true,scope:'Transport reference deduplication and terminal delivery only; no engine capability asserted',realms:{}};
  for(const realm of ['/','/frame']){const stages=records.filter(record=>record.realm===realm&&record.kind==='session-snapshot').map(record=>record.stage);assert.deepEqual(stages,['running-initial','running-memory','closing','native-exited','terminal']);report.sessionRecorderFixture.realms[realm]=stages;}
  const nodeDeadline=Date.now()+5000,complete=value=>value.fixtureStage==='terminal'&&value.exit?.hostCleanup?.status==='complete';
  while((observedWorkerOutcomes(browser).filter(complete).length!==2||observedWorkerSessions(browser).filter(complete).length!==2)&&Date.now()<nodeDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  for(const values of [observedWorkerOutcomes(browser),observedWorkerSessions(browser)]){assert.equal(values.length,2);assert(values.every(complete));}
  report.sessionRecorderFixture.nodeOutcomes=observedWorkerOutcomes(browser).map(({workerId,fixtureStage,exit})=>({workerId,fixtureStage,exit}));
  report.recordsBeforeGesture=records.map(record=>({...record}));await recorder.flush();assert.deepEqual(errors,[]);
  await page.frameLocator('iframe').locator('#activate').click();const clickedDeadline=Date.now()+5000;
  while(!records.some(record=>record.kind==='trusted-click'&&record.realm==='/frame')&&Date.now()<clickedDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert(records.some(record=>record.kind==='trusted-click'&&record.realm==='/frame'&&record.hasBeenActive));report.afterRealClick=await read();assert.equal(report.afterRealClick.frame.hasBeenActive,true);
  await recorder.flush();report.browser={name:'chromium',version:browser.version(),...browserLaunchEvidence(browser)};report.recordsAfterGesture=records.slice(report.recordsBeforeGesture.length);report.errors=errors;report.status='passed';
 }catch(error){report.status='failed';report.error=String(error.stack??error);throw Object.assign(error,{passiveRecorderReport:report});}
 finally{await cdp?.detach().catch(()=>{});await context?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));if(out){out=path.resolve(out);await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');}}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const index=process.argv.indexOf('--out');
 try{const report=await verifyPassiveRecorder({out:index<0?undefined:process.argv[index+1]});console.log(JSON.stringify(report,null,2));}catch(error){console.error(error.stack??error);process.exitCode=1;}
}
