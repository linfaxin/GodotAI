import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {canonical,digest} from './site-evidence.mjs';
import {collectManifestPayloads} from './profile-resources.mjs';
import {describeWorkerCandidate,WORKER_NATIVE_PATCH_FILES,runConfigurationHash} from './worker-candidate.mjs';
import {WORKER_RUNTIME_ABI} from '../../../scripts/release/engine-profiles.mjs';
import {sealSiteAcceptance} from './seal-site-acceptance.mjs';
import {describeWorkerSdkSources,WORKER_SDK_PACKAGES} from './worker-sdk-proof.mjs';

test('schema-3 sealing cannot mix legacy reports, presenter identities, old SDK sources or override-browser evidence',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'worker-site-seal-')),site=path.join(root,'site'),reports=path.join(root,'reports'),repo=fileURLToPath(new URL('../../../',import.meta.url));
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(site);await mkdir(reports);
 for(const [name,entry]of [['main.js.map','apps/playground/src/main.ts'],['compiler.worker.js.map','apps/playground/src/compiler.worker.ts'],['preview.js.map','apps/playground/preview.ts'],['runtime.worker.js.map','apps/playground/runtime.worker.ts'],['runtime.audio.worklet.js.map','scripts/jsb.react-browser/src/worker-audio-worklet.ts']])await writeFile(path.join(site,name),JSON.stringify({sources:['../../../'+entry],sourcesContent:[await readFile(path.join(repo,entry),'utf8')]}));
 for(const name of ['preview.js','runtime.worker.js','runtime.audio.worklet.js'])await writeFile(path.join(site,name),'synthetic '+name);
 const implementation={path:'scripts/release/patch-web-worker-runtime.mjs',sha256:digest('synthetic patch')},patchId='godotjs-web-worker-runtime-v1',files=Object.fromEntries(WORKER_NATIVE_PATCH_FILES.map(name=>[name,digest(name)])),recipe={args:['platform=web','threads=no','dlink_enabled=no','use_quickjs_ng=no'],patches:Object.entries(files).map(([path,afterSha256])=>({patchId,path,afterSha256,beforeSha256:digest('before '+path),implementation}))};
 const sourceInputs=await describeWorkerSdkSources(repo),outputs=Object.fromEntries(WORKER_SDK_PACKAGES.map(directory=>[directory+'/dist/index.js',{sha256:digest('synthetic'),bytes:9}])),sdkBuild={schemaVersion:1,kind:'worker-sdk-source-build-proof',packages:WORKER_SDK_PACKAGES,sourceInputs,sourceSnapshotHash:digest(canonical(sourceInputs)),outputs,outputSnapshotHash:digest(canonical(outputs))};
 const release={schemaVersion:2,runtimeProfile:'full-engine-v1',runtimeAbi:WORKER_RUNTIME_ABI,verifiedRelease:{},engine:{worklets:[{path:'engine/game.audio.worklet.js',sha256:digest('synthetic audio')},{path:'engine/game.audio.position.worklet.js',sha256:digest('synthetic position')}]},payloads:{},build:{sourceCertified:true,sdkBuild,workerPatch:{patchId,version:1,implementation,files},engineRecipe:recipe,recipeSha256:digest(canonical(recipe)),godotSource:{inputs:files,snapshotHash:digest(canonical(files))}}};
 release.id=digest(canonical(release));release.verifiedRelease.releaseId=release.id;await writeFile(path.join(site,'engine-release.json'),JSON.stringify(release));
 const resource=Buffer.from('synthetic resources'),asset={path:'resource.bin',bytes:resource.length,sha256:digest(resource)};await writeFile(path.join(site,asset.path),resource);
 await writeFile(path.join(site,'resource-build.json'),JSON.stringify({runtimeProfile:release.runtimeProfile,engineReleaseId:release.id,exporter:{path:'/synthetic/editor',version:'4.6.1.test',sha256:digest('editor')},generatedManifest:asset,output:asset,demoPack:asset}));
 await writeFile(path.join(site,'manifest.json'),JSON.stringify({schemaVersion:3,runtimeProfile:release.runtimeProfile,engineReleaseId:release.id,runtime:await describeWorkerCandidate(site,release),payloads:await collectManifestPayloads(site)}));
 await sealSiteAcceptance(site,reports,{begin:true});const context=JSON.parse(await readFile(path.join(reports,'site-start.json'),'utf8'));
 assert(context.acceptanceBatchId);assert(!Object.hasOwn(context,'runId'));
 for(const plan of context.reportPlan){
  const configuration={executionBackend:'worker',presentationBackend:plan.presentationBackend,runtimeProtocolVersion:2,hostAbiVersion:1,audioAbiVersion:1,presentationAbiVersion:1,budgets:{cleanupTimeoutMs:1000}},hash=runConfigurationHash(configuration),lifecycleLoops=plan.browser==='chromium'?50:2;
  const report={...Object.fromEntries(['schemaVersion','profile','releaseId','descriptorHash','candidateId','siteHash','acceptanceBatchId'].map(key=>[key,context[key]])),status:'passed',testMode:'real-engine',browser:{name:plan.browser,version:'synthetic-test',settingsTier:'default'},runConfiguration:configuration,runConfigurationHash:hash,lifecycleLoops,checks:Array.from({length:14},(_,index)=>'synthetic-'+index),errors:[],warnings:[],sessions:Array.from({length:plan.suite==='runtime'?15+lifecycleLoops:1},(_,index)=>({runId:plan.name+'-run-'+index,documentId:plan.name+'-document-'+index,workerId:plan.name+'-worker-'+index,runConfigurationHash:hash,runConfiguration:configuration,runtime:index===1?'react':'godot',executionBackend:'worker',presentationBackend:plan.presentationBackend,workerState:'native-exited',workerErrors:[],glErrors:[],exit:{reason:'clean-exit',engineOutcome:{kind:'native-exit',code:0},hostCleanup:{status:'complete'}},audio:{driver:'AudioWorklet',kind:'worklet',closed:true,contextsCreated:1,contextsClosed:1,liveNodes:0,latePackets:0,transferredChunksOwned:0,outputPeak:0.2,outputChecks:4}}))};
  if(plan.suite==='editor'||plan.suite==='delivery')report.executionScope=plan.suite==='editor'?'compiler-worker':'http-delivery';
  if(plan.suite==='runtime'){
   report.sessions[13].audio={...report.sessions[13].audio,driver:'Dummy',kind:'dummy',contextsCreated:0,contextsClosed:0,outputChecks:0,outputPeak:0};
   report.frames=report.sessions.map(session=>({documentId:session.documentId,runId:session.runId,workerId:session.workerId,runConfigurationHash:session.runConfigurationHash,runtime:session.runtime,url:'http://preview.test/preview.html?editorOrigin=http%3A%2F%2Feditor.test'}));
   const downloaded=[...release.engine.worklets,{path:'runtime.audio.worklet.js',sha256:digest('synthetic runtime.audio.worklet.js')}];
   const bodyFor=asset=>Buffer.from(asset.path.includes('position')?'synthetic position':asset.path.startsWith('engine/')?'synthetic audio':'synthetic runtime.audio.worklet.js');
   report.workletResponses=report.sessions.flatMap((_,sessionIndex)=>downloaded.map((asset,assetIndex)=>({sequence:sessionIndex*downloaded.length+assetIndex+1,url:'http://preview.test/'+asset.path,status:200,etag:'"'+asset.sha256+'"',requestIfNoneMatch:null,captureKind:'response-body',sha256:asset.sha256,bytes:bodyFor(asset).length,bodyBase64:bodyFor(asset).toString('base64')})));report.workletNetworkRequests=report.workletResponses.length;
   report.runnerLogs=report.sessions.map(session=>({documentId:session.documentId,phase:'stopped',lines:[]}));
  }
  await writeFile(path.join(reports,plan.name+'.json'),JSON.stringify(report));
 }
 assert.equal((await sealSiteAcceptance(site,reports)).status,'passed');await sealSiteAcceptance(site,reports,{verify:true});
 const filename=path.join(reports,context.reportPlan[0].name+'.json'),original=await readFile(filename),positive=JSON.parse(original);
 for(const [change,pattern]of [[value=>{value.schemaVersion=2;value.runId=context.acceptanceBatchId;},/E_SITE_WORKER_EVIDENCE/],[value=>{value.browser.settingsTier='environment-override';},/E_SITE_EVIDENCE_BROWSER_SETTINGS/],[value=>{value.runConfiguration.presentationBackend='bitmap';},/E_SITE_EVIDENCE_MATRIX/],[value=>{value.sessions.at(-1).audio.transferredChunksOwned=1;},/E_SITE_WORKER_EVIDENCE/],[value=>{value.sessions.at(-1).exit.engineOutcome={kind:'terminate-issued'};},/E_SITE_WORKER_EVIDENCE/],[value=>{value.workletResponses[0].sha256=digest('changed response');},/E_SITE_WORKER_EVIDENCE/],[value=>{value.runnerLogs[0].lines=[{level:'warn',text:'WARNING: native playback warning'}];},/E_SITE_WORKER_EVIDENCE/]]){
  const value=structuredClone(positive);change(value);await writeFile(filename,JSON.stringify(value));await assert.rejects(sealSiteAcceptance(site,reports),pattern);await writeFile(filename,original);
 }
 const cached=structuredClone(positive),seeds=new Map();
 for(const response of cached.workletResponses){
  const seed=seeds.get(response.url);
  if(!seed){seeds.set(response.url,response);continue;}
  response.status=304;response.captureKind='cache-revalidation';response.requestIfNoneMatch=response.etag;response.revalidatedFrom=seed.sequence;delete response.bodyBase64;
 }
 await writeFile(filename,JSON.stringify(cached));assert.equal((await sealSiteAcceptance(site,reports)).status,'passed');
 for(const mutate of [value=>{value.workletResponses[3].revalidatedFrom=4;},value=>{value.workletResponses[3].etag='"unknown"';},value=>{value.workletResponses[0].bodyBase64=Buffer.from('wrong bytes').toString('base64');},value=>{value.workletResponses[3].status=302;}]){
  const value=structuredClone(cached);mutate(value);await writeFile(filename,JSON.stringify(value));await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_WORKER_EVIDENCE/);
 }
 await writeFile(filename,original);
 const sourceMap=path.join(site,'runtime.worker.js.map'),map=JSON.parse(await readFile(sourceMap,'utf8'));map.sourcesContent[0]+='\n// stale source';await writeFile(sourceMap,JSON.stringify(map));await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_SOURCE_DRIFT/);
});
