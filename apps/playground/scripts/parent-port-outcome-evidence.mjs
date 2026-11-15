import {randomUUID} from 'node:crypto';
import {installPassiveRecorder} from './browser-harness.mjs';
import {canonical} from './site-evidence.mjs';

const keys=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
const validIdentity=value=>value&&keys.every(key=>['revision','generation'].includes(key)?typeof value[key]==='string'&&value[key]||Number.isSafeInteger(value[key])&&value[key]>=0:typeof value[key]==='string'&&value[key]);
const same=(a,b)=>validIdentity(a)&&validIdentity(b)&&keys.every(key=>a[key]===b[key]);
const identityKey=value=>JSON.stringify(keys.map(key=>value?.[key]));
function fail(message,observation){const error=Error('E_PARENT_PORT_OUTCOME: '+message);error.observation=observation;throw error;}

/** Self-contained context init script. It observes a persistent parent realm's
 * original native MessagePort delivery before the application's onmessage
 * handler can dispose the iframe. No start, ACK, evaluation, reply or mutation
 * of application messages is performed. */
export function observeParentPortMessages({recorderName}){
 if(globalThis.parent!==globalThis)return;
 const prototype=MessagePort.prototype,descriptor=Object.getOwnPropertyDescriptor(prototype,'onmessage');
 if(!descriptor?.get||!descriptor.set||!descriptor.configurable)throw Error('E_PARENT_PORT_OBSERVER_DESCRIPTOR');
 const add=EventTarget.prototype.addEventListener,ports=new WeakMap(),identities=new Map(),realmId=crypto.randomUUID();let portSequence=0;
 const keys=['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'];
 const valid=value=>value&&typeof value==='object'&&value.protocolVersion===2&&keys.every(key=>['revision','generation'].includes(key)?typeof value[key]==='string'&&value[key]||Number.isSafeInteger(value[key])&&value[key]>=0:typeof value[key]==='string'&&value[key]);
 const matches=(a,b)=>keys.every(key=>a[key]===b[key]);
 const reject=message=>{void globalThis[recorderName]({source:'parent-port-observer-error',message});};
 Object.defineProperty(prototype,'onmessage',{...descriptor,set:function(value){
  // Validate the original interface brand before adding an observer listener
  // or touching its bookkeeping on a borrowed/invalid receiver.
  Reflect.apply(descriptor.get,this,[]);
  if(typeof value==='function'&&!ports.has(this)){
   const state={portId:realmId+':'+(++portSequence),sequence:0,connected:null};
   const port=this;
   Reflect.apply(add,port,['message',event=>{
    if(event.isTrusted!==true||event.target!==port||event.currentTarget!==port)return;
    const data=event.data;if(!valid(data))return;
    const sequence=++state.sequence;
    if(state.invalid)return;
    if(data.type==='connected'){
     const identity=JSON.stringify(keys.map(key=>data[key]));
     if(state.connected||identities.has(identity)&&identities.get(identity)!==state.portId){state.invalid=true;reject('port rebind or second port reused the same identity');return;}
     identities.set(identity,state.portId);state.connected=structuredClone(data);state.connectedSequence=sequence;state.connectedAtMs=performance.now();return;
    }
    if(data.type!=='exit-report'||!state.connected||!matches(data,state.connected))return;
    const receipt=structuredClone(data);
    void globalThis[recorderName]({schemaVersion:1,source:'parent-port',parentURL:location.href,portId:state.portId,
     connected:state.connected,connectedSequence:state.connectedSequence,receiptSequence:sequence,
     connectedAtMs:state.connectedAtMs,receiptAtMs:performance.now(),receipt});
   }]);
   ports.set(port,state);
  }
  return Reflect.apply(descriptor.set,this,[value]);
 }});
}

function assertBinding(observation,identity){
 if(observation?.schemaVersion!==1||observation.source!=='parent-port'||typeof observation.portId!=='string'||!observation.portId||!same(observation.connected,identity)||!same(observation.receipt,identity)||observation.connected.protocolVersion!==2||observation.connected.type!=='connected'||observation.receipt.protocolVersion!==2||observation.receipt.type!=='exit-report')fail('unbound actual parent-port receipt',observation);
 if(!Number.isSafeInteger(observation.connectedSequence)||observation.connectedSequence<1||!Number.isSafeInteger(observation.receiptSequence)||observation.receiptSequence<=observation.connectedSequence||!Number.isFinite(observation.connectedAtMs)||!Number.isFinite(observation.receiptAtMs)||observation.receiptAtMs<observation.connectedAtMs)fail('invalid port event ordering',observation);
 try{if(!['http:','https:'].includes(new URL(observation.parentURL).protocol))fail('parent URL',observation);}catch{fail('parent URL',observation);}
}
function assertReceipt(receipt,snapshot){
 if(receipt.hostCleanup?.status!=='complete'||Object.keys(receipt.hostCleanup).length!==1)fail('actual Host cleanup failed or incomplete',receipt);
 const engine=receipt.engineOutcome;
 if(engine?.kind==='native-exit'){
  if(!Number.isSafeInteger(engine.code)||Object.keys(engine).length!==2||!['clean-exit','crashed'].includes(receipt.reason)||(receipt.reason==='clean-exit'&&engine.code!==0)||receipt.code!==engine.code)fail('invalid actual Native receipt',receipt);
 }else if(engine?.kind==='terminate-issued'){
  if(Object.keys(engine).length!==1||receipt.reason!=='forced-worker-termination'||Object.hasOwn(receipt,'code'))fail('invalid actual forced receipt',receipt);
 }else if(['startup-failed','runtime-failed'].includes(engine?.kind)){
  if(Object.keys(engine).some(key=>!['kind','detail'].includes(key))||(engine.detail!==undefined&&(typeof engine.detail!=='string'||engine.detail.length>4096))||receipt.reason!=='crashed'||Object.hasOwn(receipt,'code'))fail('invalid actual crash receipt',receipt);
 }else fail('unsupported actual terminal receipt',receipt);
 if(snapshot.exit)for(const key of [...keys,'reason','engineOutcome','hostCleanup','code'])if(canonical(snapshot.exit[key])!==canonical(receipt[key]))fail('existing snapshot exit disagrees with parent receipt',receipt);
}

/** Verify the explicit join without pretending the old snapshot's audio or
 * other fields were final. Both the snapshot and the complete raw port receipt
 * remain in the evidence. The receipt alone establishes terminal cleanup. */
export function assertParentPortOutcomeEvidence(session){
 const observation=session?.terminalObservation;if(!observation)fail('missing explicit parent-port terminal observation',session);
 assertBinding(observation,session);
 const snapshot=observation.snapshot;
 if(!same(snapshot,session)||Object.hasOwn(snapshot,'terminalObservation'))fail('missing original snapshot',observation);
 const original={...snapshot},actual={...session};delete original.exit;delete actual.exit;delete actual.terminalObservation;delete actual.expectedFailure;
 if(canonical(original)!==canonical(actual)||canonical(session.exit)!==canonical(observation.receipt))fail('joined evidence altered snapshot fields or receipt',observation);
 for(const key of ['snapshotReadAtMs','receiptReceivedAtMs','joinedAtMs'])if(!Number.isFinite(observation[key])||observation[key]<0)fail('missing Node observation clocks',observation);
 if(observation.joinedAtMs<observation.snapshotReadAtMs||observation.joinedAtMs<observation.receiptReceivedAtMs)fail('invalid Node join ordering',observation);
 assertReceipt(observation.receipt,snapshot);
}

export async function installParentPortReceiptObserver(context){
 const observations=new Map(),name='__parentPortReceipt_'+randomUUID().replaceAll('-','');
 const recorder=await installPassiveRecorder(context,name,(source,observation)=>{
  if(observation?.source==='parent-port-observer-error')fail(String(observation.message),observation);
  assertBinding(observation,observation.receipt);
  if(!source.page||source.page.url()!==observation.parentURL)fail('receipt did not come from current persistent parent page',observation);
  const key=identityKey(observation.receipt),previous=observations.get(key);
  if(previous&&(previous.portId!==observation.portId||canonical(previous.receipt)!==canonical(observation.receipt)))fail('conflicting terminal receipts',observation);
  observations.set(key,{...observation,receiptReceivedAtMs:performance.now()});
 });
 await context.addInitScript(observeParentPortMessages,{recorderName:name});
 return {readObservations:()=>structuredClone([...observations.values()]),assertHealthy:()=>recorder.assertHealthy(),async join(snapshot,{timeoutMs=10000,pollMs=25}={}){
  if(!validIdentity(snapshot)||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000||!Number.isFinite(pollMs)||pollMs<=0||pollMs>timeoutMs)fail('invalid join identity/deadline',snapshot);
  const snapshotReadAtMs=performance.now(),deadline=snapshotReadAtMs+timeoutMs;
  for(;;){
   recorder.assertHealthy();
   const observed=observations.get(identityKey(snapshot));
   if(observed){
    const terminalObservation={...structuredClone(observed),snapshot:structuredClone(snapshot),snapshotReadAtMs,joinedAtMs:performance.now()};
    const joined={...snapshot,exit:terminalObservation.receipt,terminalObservation};assertParentPortOutcomeEvidence(joined);return joined;
   }
   const remaining=deadline-performance.now();if(remaining<=0)fail('deadline expired without actual parent-port receipt',snapshot);
   await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,remaining)));
  }
 }};
}
