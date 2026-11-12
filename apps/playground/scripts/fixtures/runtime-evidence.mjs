import {RUNTIME_LIFECYCLE_MINIMUM,RUNTIME_BASELINE_FRAMES} from '../runtime-evidence.mjs';

/** Synthetic protocol evidence for validator unit tests, never product evidence. */
export function runtimeEvidenceFixture(browser,worklets){
 const lifecycleLoops=RUNTIME_LIFECYCLE_MINIMUM[browser],frames=[],audio=[];
 for(let index=0;index<RUNTIME_BASELINE_FRAMES+lifecycleLoops;index++){
  const documentId='fixture-'+index,contextId=0;
  frames.push({documentId,runtime:index===1?'react':'godot',url:'http://preview.test/preview.html?editorOrigin=http%3A%2F%2Feditor.test'});
  audio.push({documentId,contextId,type:'context-created',state:'running'});
  for(const asset of worklets)audio.push({documentId,contextId,type:'worklet-loaded',sha256:asset.decodedSha256??asset.sha256,url:'blob:http://preview.test/'+asset.sha256});
  const output={name:'godot-processor',peak:0.2,checks:4};
  audio.push({documentId,contextId,type:'worklet-output',...output},{documentId,contextId,type:'context-closed',state:'closed',output:[output]});
 }
 return {lifecycleLoops,frames,audio,checks:Array.from({length:14},(_,index)=>'fixture-check-'+index),workletNetworkRequests:frames.length*worklets.length,errors:[],warnings:[]};
}
