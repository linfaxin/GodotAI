/** Minimum product acceptance, independent of the producer's status string. */
export const RUNTIME_LIFECYCLE_MINIMUM=Object.freeze({chromium:50,firefox:2,webkit:2});
export const RUNTIME_BASELINE_FRAMES=13;

export function assertRuntimeEvidence(result,release){
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
