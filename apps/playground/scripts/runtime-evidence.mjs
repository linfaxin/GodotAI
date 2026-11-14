import {assertParentPortOutcomeEvidence} from './parent-port-outcome-evidence.mjs';
import {assertWorkletResponseEvidence} from './worklet-response-evidence.mjs';
import {assertWorkerRuntimeAbi} from '../../../scripts/release/engine-profiles.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';
/** Minimum product acceptance, independent of the producer's status string. */
export const RUNTIME_LIFECYCLE_MINIMUM=Object.freeze({chromium:50,firefox:2,webkit:2});
export const RUNTIME_BASELINE_FRAMES=13;
export const WORKER_RUNTIME_BASELINE_FRAMES=15;

/** A batch groups reports; session run/document/worker identifiers describe
 * actual fresh browser realms and must never be synthesized from that batch. */
export function assertWorkerSessionEvidence(result,{runtime=false}={}){
 const fail=detail=>{throw Error('E_SITE_WORKER_EVIDENCE: '+detail);};
 if(result.schemaVersion!==3||typeof result.acceptanceBatchId!=='string'||!result.acceptanceBatchId||Object.hasOwn(result,'runId'))fail('schema/batch identity');
 const configuration=result.runConfiguration;
 if(configuration?.executionBackend!=='worker'||!['direct','bitmap'].includes(configuration.presentationBackend))fail('execution configuration');
 try{if(result.runConfigurationHash!==runConfigurationHash(configuration))fail('configuration hash');}catch{fail('configuration hash/ABI');}
 if(!Array.isArray(result.sessions)||!result.sessions.length)fail('missing real sessions');
 const unique=Object.fromEntries(['runId','documentId','workerId'].map(key=>[key,new Set()]));
 for(const session of result.sessions){
  for(const key of Object.keys(unique)){
   if(typeof session[key]!=='string'||!session[key]||session[key]===result.acceptanceBatchId||unique[key].has(session[key]))fail('reused '+key);
   unique[key].add(session[key]);
  }
  if(session.executionBackend!=='worker'||session.presentationBackend!==configuration.presentationBackend||session.runConfigurationHash!==result.runConfigurationHash||!(runtime?['terminated','native-exited']:['running','terminated','native-exited']).includes(session.workerState))fail('session configuration or retirement');
  if(!['godot','react'].includes(session.runtime))fail('session runtime');
  if(session.glErrors?.length!==0||!Array.isArray(session.workerErrors))fail('worker/GL error observations');
  const expected=session.expectedFailure;
  if(expected){
   if(!session.terminalObservation)fail('missing actual parent-port terminal observation');
   try{assertParentPortOutcomeEvidence(session);}catch(error){fail(String(error.message??error));}
   const marker=result.suite==='engine-bridge'&&['render','commit','frame'].includes(expected.kind)?'BRIDGE_FAILURE_'+expected.kind.toUpperCase():result.suite==='workbench'&&expected.kind==='render'?'PLAYGROUND_EXPECTED_FAILURE':undefined;
   const sourcePath=expected.sourcePath;
   if(typeof sourcePath!=='string'||!sourcePath.startsWith('res://')||/[\x00-\x1f\x7f:?#\\]/u.test(sourcePath.slice(6))||sourcePath.slice(6).split('/').some(part=>!part||part==='.'||part==='..'))fail('unproved authored source path');
   if(runtime||!marker||expected.marker!==marker||expected.authoredSource!==true||expected.iframeDisposed!==true||typeof expected.logs!=='string'||!expected.logs.includes(expected.marker)||!expected.logs.includes(sourcePath+':')||!session.workerErrors.some(value=>String(value).includes(expected.marker))||session.workerErrors.some(value=>!String(value).includes(expected.marker))||session.exit?.hostCleanup?.status!=='complete'||!['crashed','forced-worker-termination'].includes(session.exit?.reason))fail('unproved expected failure');
  }else if(session.workerErrors.length)fail('unexpected Worker errors');
 }
 if(runtime){
  const minimum=RUNTIME_LIFECYCLE_MINIMUM[result.browser?.name];
  if(!minimum||!Number.isSafeInteger(result.lifecycleLoops)||result.lifecycleLoops<minimum||result.lifecycleLoops>100||result.sessions.length<WORKER_RUNTIME_BASELINE_FRAMES+result.lifecycleLoops)fail('lifecycle pressure');
  if(!['godot','react'].every(value=>result.sessions.some(session=>session.runtime===value)))fail('native/React coverage');
  if(!['errors','warnings'].every(key=>Array.isArray(result[key])&&result[key].length===0))fail('errors/warnings');
  if(!Array.isArray(result.checks)||result.checks.length<14||new Set(result.checks).size!==result.checks.length)fail('suite checks');
  for(const session of result.sessions){
   if(session.exit?.reason!=='clean-exit'||session.exit?.hostCleanup?.status!=='complete'||session.exit?.engineOutcome?.kind!=='native-exit'||session.exit?.engineOutcome?.code!==0)fail('normal stop requires native exit zero and completed cleanup');
   const audio=session.audio;
   if(!['AudioWorklet','Dummy'].includes(audio?.driver)||audio.kind!==(audio.driver==='Dummy'?'dummy':'worklet'))fail('native audio descriptor');
   if(audio?.closed!==true||audio.contextsCreated!==audio.contextsClosed||audio.contextsCreated<(audio.driver==='Dummy'?0:1)||audio.liveNodes!==0||audio.latePackets!==0||audio.transferredChunksOwned!==0)fail('audio cleanup');
   if(audio.driver==='Dummy'&&(audio.contextsCreated!==0||audio.outputChecks!==0))fail('Dummy resources');
  }
  if(!result.sessions.some(session=>session.audio?.driver==='Dummy'))fail('missing explicit Dummy run');
  for(const session of result.sessions.slice(-result.lifecycleLoops))if(session.runtime!=='godot'||!Number.isFinite(session.audio?.outputPeak)||session.audio.outputPeak<=0.01||!Number.isSafeInteger(session.audio?.outputChecks)||session.audio.outputChecks<1)fail('pressure playback');
 }
}

export function assertRuntimeEvidence(result,release,runtimeCandidate){
 if(release.runtimeAbi){
  assertWorkerRuntimeAbi(release.runtimeAbi);
  assertWorkerSessionEvidence(result,{runtime:true});
  const fail=detail=>{throw Error('E_SITE_WORKER_EVIDENCE: '+detail);};
  const sessions=result.sessions,frames=result.frames;
  if(!Array.isArray(frames)||frames.length!==sessions.length||new Set(frames.map(frame=>frame.documentId)).size!==frames.length)fail('missing real frame observations');
  for(const session of sessions){
   const frame=frames.find(frame=>frame.documentId===session.documentId);
   if(!frame||['runId','workerId','runConfigurationHash','runtime'].some(key=>frame[key]!==session[key]))fail('frame/session identity');
   try{const url=new URL(frame.url),editor=new URL(url.searchParams.get('editorOrigin'));if(!['http:','https:'].includes(url.protocol)||url.origin===editor.origin||!url.pathname.endsWith('/preview.html'))fail('preview origin');}catch{fail('preview URL');}
  }
  const worklets=[...(release.engine?.worklets??[]),{path:runtimeCandidate?.audioWorklet,sha256:runtimeCandidate?.assets?.[runtimeCandidate?.audioWorklet]?.sha256}];
  if(worklets.length!==3||worklets.some(asset=>typeof asset.path!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))||new Set(worklets.map(asset=>asset.path)).size!==3)fail('declared worklet resources');
  const responses=result.workletResponses;
  if(result.workletNetworkRequests!==sessions.length*worklets.length||!Array.isArray(responses)||responses.length!==result.workletNetworkRequests)fail('worklet network evidence');
  const roots=new Set(frames.map(frame=>new URL('.',frame.url).href));if(roots.size!==1)fail('preview root changed');
  try{assertWorkletResponseEvidence(responses,new Map(worklets.map(asset=>[new URL(asset.path,[...roots][0]).href,asset.sha256])));}catch(error){fail(String(error.message??error));}
  for(const asset of worklets){
   const expected=new URL(asset.path,[...roots][0]).href,found=responses.filter(response=>response.url===expected);
   if(found.length!==sessions.length||found.some(response=>response.sha256!==asset.sha256))fail('worklet response integrity');
  }
  if(!Array.isArray(result.runnerLogs)||!sessions.every(session=>result.runnerLogs.some(record=>record.documentId===session.documentId&&record.phase==='stopped'&&Array.isArray(record.lines))))fail('runner log observations');
  for(const record of result.runnerLogs)for(const line of record.lines??[])if(typeof line.text!=='string'||!['log','warn','error'].includes(line.level)||line.level!=='log'||/(?:^|\n)\s*(?:WARNING:|\[WARN\]|ERROR:|SCRIPT ERROR:)/.test(line.text))fail('runner error or warning');
  return;
 }
 if(result.schemaVersion===3||result.runConfiguration?.executionBackend==='worker')throw Error('E_SITE_RUNTIME_EVIDENCE: Worker evidence requires an ABI-declared release');
 const fail=detail=>{throw Error('E_SITE_RUNTIME_EVIDENCE: '+detail);};
 const minimum=Object.hasOwn(RUNTIME_LIFECYCLE_MINIMUM,result.browser?.name)?RUNTIME_LIFECYCLE_MINIMUM[result.browser.name]:undefined;
 if(!minimum||!Number.isSafeInteger(result.lifecycleLoops)||result.lifecycleLoops<minimum||result.lifecycleLoops>100)fail('lifecycle minimum');
 if(!['errors','warnings'].every(key=>Array.isArray(result[key])&&result[key].length===0))fail('errors or warnings');
 if(!Array.isArray(result.checks)||result.checks.length<14||result.checks.some(value=>typeof value!=='string'||!value.trim())||new Set(result.checks).size!==result.checks.length)fail('suite checks');
 const frames=result.frames;
 if(!Array.isArray(frames)||frames.length<RUNTIME_BASELINE_FRAMES+result.lifecycleLoops)fail('missing frames');
 const ids=new Set();
 for(const frame of frames){
  if(!frame||typeof frame.documentId!=='string'||!frame.documentId||ids.has(frame.documentId)||!['godot','react'].includes(frame.runtime))fail('reused or invalid iframe');
  ids.add(frame.documentId);
  try{const url=new URL(frame.url),editor=new URL(url.searchParams.get('editorOrigin'));if(!['http:','https:'].includes(url.protocol)||url.origin===editor.origin||!url.pathname.endsWith('/preview.html'))fail('preview origin');}catch{fail('preview URL');}
 }
 if(!['godot','react'].every(runtime=>frames.some(frame=>frame.runtime===runtime)))fail('missing native or React runs');
 const worklets=release.engine?.worklets?.map(asset=>asset.decodedSha256??asset.sha256);
 if(!Array.isArray(worklets)||worklets.length!==2||new Set(worklets).size!==2||worklets.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))fail('release worklets');
 if(result.workletNetworkRequests!==frames.length*worklets.length)fail('worklet network count');
 if(!Array.isArray(result.audio)||!result.audio.length||result.audio.some(event=>!ids.has(event.documentId)||!Number.isSafeInteger(event.contextId)||event.contextId<0||!['context-created','context-closed','worklet-loaded','worklet-output'].includes(event.type)))fail('audio events');
 for(const frame of frames){
  const events=result.audio.filter(event=>event.documentId===frame.documentId);
  const created=events.filter(event=>event.type==='context-created'),closed=events.filter(event=>event.type==='context-closed');
  const contexts=new Set(created.map(event=>event.contextId));
  if(!contexts.size||contexts.size!==created.length||closed.length!==created.length||new Set(closed.map(event=>event.contextId)).size!==contexts.size||events.some(event=>!contexts.has(event.contextId)))fail('context lifecycle');
  for(const contextId of contexts){
   const close=closed.find(event=>event.contextId===contextId),loaded=events.filter(event=>event.contextId===contextId&&event.type==='worklet-loaded');
   if(close?.state!=='closed'||!Array.isArray(close.output)||loaded.length!==worklets.length||new Set(loaded.map(event=>event.sha256)).size!==worklets.length||loaded.some(event=>!worklets.includes(event.sha256)||typeof event.url!=='string'||!event.url.startsWith('blob:')))fail('unclosed context or unverified worklet');
  }
 }
 // The producer appends the additional pressure runs after its 13 baseline
 // sessions. A claimed count alone cannot stand in for actual fresh sessions.
 for(const frame of frames.slice(-result.lifecycleLoops)){
  const events=result.audio.filter(event=>event.documentId===frame.documentId);
  const audible=value=>value.name==='godot-processor'&&Number.isFinite(value.peak)&&value.peak>0.01&&Number.isSafeInteger(value.checks)&&value.checks>0;
  if(frame.runtime!=='godot'||!events.some(event=>event.type==='worklet-output'&&audible(event))||!events.some(event=>event.type==='context-closed'&&event.output.some(audible)))fail('missing pressure playback');
 }
}
