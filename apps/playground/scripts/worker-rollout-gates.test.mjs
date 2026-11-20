import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assessWorkerRollout,assertWorkerPerformanceEvidence} from './worker-rollout-gates.mjs';
import {createWorkerRegressionBudget,assessPerformanceBudget} from './performance-acceptance.mjs';
import {digest,siteIdentity,performanceComparisonInputs} from './site-evidence.mjs';
import {performanceSiteFixture} from './fixtures/performance-site.mjs';
import {WORKER_CAPABILITY_LEDGER,assessWorkerCapabilityEvidence,assessWorkerCapabilityCase,assertOriginalPlatformProbeReport,assertWorkerCapabilityProbeReport} from './worker-capability-ledger.mjs';

test('engineering GO cannot become a default-switch GO without every supported profile and target',async()=>{
 const result=await assessWorkerRollout({candidates:[]});assert.equal(result.engineering,'go');assert.equal(result.defaultSwitch,'blocked');assert.equal(result.publication,'blocked');assert.equal(result.failures.length,4);
});
test('published networking, microphone and resource contracts remain mandatory beyond the demo matrix',()=>{
 for(const id of ['webrtc','websocket','http','microphone','resources','legacy-contract','midi','vibrate','pwa','tts'])assert(WORKER_CAPABILITY_LEDGER.some(capability=>capability.id===id));
 const receipt={schemaVersion:3,status:'passed',profile:'engine-2d-v1',releaseId:'release',descriptorHash:'descriptor',candidateId:'candidate',siteHash:'site',acceptanceBatchId:'batch'};
 const cases=WORKER_CAPABILITY_LEDGER.filter(item=>item.profiles.includes(receipt.profile)).flatMap(capability=>['direct','bitmap'].flatMap(presentationBackend=>['production','development'].flatMap(sdkMode=>['snake','camel'].map(naming=>({capability:capability.id,presentationBackend,sdkMode,naming,executionBackend:'worker',status:'passed',sessions:[{runId:'actual-run',documentId:'actual-document',workerId:'actual-worker',runConfigurationHash:'a'.repeat(64)}],probe:{path:'capability-probe.json',sha256:'d'.repeat(64)},evidence:[{path:'actual-report.json',sha256:'b'.repeat(64)}]})))));
 const browserCases=['chromium','firefox','webkit'].flatMap(name=>cases.map(item=>({...item,classification:'bridged',browser:{name,version:'synthetic-browser',platform:'linux',settingsTier:'default'}})));
 const report={...receipt,cases:browserCases};assert.equal(assessWorkerCapabilityEvidence(receipt,report).status,'passed');
 assert.equal(assessWorkerCapabilityEvidence(receipt,{...report,cases:browserCases.filter(item=>item.capability!=='webrtc')}).status,'blocked');
 assert.equal(assessWorkerCapabilityEvidence(receipt,{...report,acceptanceBatchId:'old-batch'}).status,'blocked');
});
test('original unsupported WebXR requires exact native/browser negative evidence; hardware absence and pending bridges remain blocked',()=>{
 const receipt={profile:'full-engine-v1',releaseId:'release',descriptorHash:'descriptor',candidateId:'candidate',siteHash:'site'},browser={name:'firefox',version:'exact-version',platform:'linux',settingsTier:'default'};
 const probe={path:'native-webxr-probe.json',sha256:'b'.repeat(64),kind:'native-platform-capability-probe',capability:'webxr',realm:'window-native-engine',status:'unsupported',cause:'api-not-exposed',environment:{secureContext:true,policyAllowed:true,hardware:'not-required',blocked:false}};
 const item={capability:'webxr',classification:'original-platform-unsupported',status:'passed',executionBackend:'worker',browser,probe:{path:'worker-probe.json',sha256:'d'.repeat(64)},sessions:[{runId:'worker-run',documentId:'worker-document',workerId:'worker',runConfigurationHash:'a'.repeat(64)}],evidence:[{path:'worker-webxr-report.json',sha256:'c'.repeat(64)}],baseline:{...receipt,browser,executionBackend:'legacy',nativeSourceCertified:true,workerRuntimeInstalled:false,probe}};
 assert.equal(assessWorkerCapabilityCase(receipt,item),true);
 const {path:ignored,sha256:ignoredHash,...result}=probe;
 const report={...receipt,...result,schemaVersion:1,browser,executionBackend:'legacy',nativeSourceCertified:true,workerRuntimeInstalled:false,observations:{native:{sessionSupported:false},browser:{apiPath:'navigator.xr',exposed:false}}};
 assert.doesNotThrow(()=>assertOriginalPlatformProbeReport(receipt,item,report));
 for(const change of [value=>{value.baseline.browser={...browser,version:'other-version'};},value=>{value.baseline.probe.environment.hardware='unavailable';},value=>{value.baseline.probe.environment.policyAllowed=false;},value=>{value.baseline.executionBackend='worker';},value=>{value.classification='pending-bridge';}]){
  const value=structuredClone(item);change(value);assert.equal(assessWorkerCapabilityCase(receipt,value),false);
 }
 assert.throws(()=>assertOriginalPlatformProbeReport(receipt,item,{...report,observations:{}}),/E_WORKER_PLATFORM_BASELINE_OBSERVATIONS/);
 assert.throws(()=>assertOriginalPlatformProbeReport(receipt,item,{...report,executionBackend:'worker'}),/E_WORKER_PLATFORM_BASELINE_PROBE/);
 assert(!WORKER_CAPABILITY_LEDGER.some(capability=>capability.id==='scene-3d-xr'));
 assert(WORKER_CAPABILITY_LEDGER.some(capability=>capability.id==='scene-3d'));
});
test('a broad demo report cannot stand in for a capability-specific real Worker probe',async()=>{
 const {DEFAULT_WORKER_RUN_CONFIGURATION:configuration,hashWorkerRunConfiguration}=await import('../../../scripts/jsb.react-browser/src/worker-protocol.ts');
 const hash=await hashWorkerRunConfiguration(configuration),producer={path:'apps/playground/scripts/browser-capability-probe-test.mjs',sha256:'e'.repeat(64)};
 const receipt={schemaVersion:3,status:'passed',profile:'engine-2d-v1',releaseId:'release',descriptorHash:'descriptor',candidateId:'candidate',siteHash:'site',acceptanceBatchId:'batch',testSources:{[producer.path]:producer.sha256}},browser={name:'chromium',version:'exact',platform:'linux',settingsTier:'default'};
 const item={capability:'midi',classification:'bridged',executionBackend:'worker',presentationBackend:'direct',sdkMode:'production',naming:'snake',status:'passed',browser,sessions:[{runId:'run',documentId:'document',workerId:'worker',runConfigurationHash:hash}],probe:{path:'midi.json',sha256:'a'.repeat(64)},evidence:[{path:'midi.raw.json',sha256:'b'.repeat(64)}]};
 const report={...receipt,...item,schemaVersion:3,kind:'worker-capability-probe',testMode:'real-engine',runConfiguration:configuration,runConfigurationHash:hash,producer,checks:{nativeDeviceCallback:true},observations:{supported:true,midi:{inputEvents:3,nativeEvents:3,closed:true}}};
 assert.doesNotThrow(()=>assertWorkerCapabilityProbeReport(receipt,item,report));
 for(const change of [value=>{value.kind='demo-regressions';},value=>{value.capability='host-browser';},value=>{value.producer.sha256='f'.repeat(64);},value=>{value.sessions[0].workerId='other-worker';},value=>{value.observations={};},value=>{value.observations={supported:true,apiPresent:true};},value=>{value.checks.nativeDeviceCallback=false;}]){
  const value=structuredClone(report);change(value);assert.throws(()=>assertWorkerCapabilityProbeReport(receipt,item,value),/E_WORKER_CAPABILITY_PROBE/);
 }
});

test('versioned execution contract requires removed legacy entry while preserving the synchronous DOM boundary',()=>{
 const item={capability:'legacy-contract',classification:'versioned-change',status:'passed',executionBackend:'worker',presentationBackend:'direct',sdkMode:'production',naming:'snake',browser:{name:'chromium',version:'test',platform:'linux',settingsTier:'default'},sessions:[{runId:'run',documentId:'document',workerId:'worker',runConfigurationHash:'a'.repeat(64)}],probe:{path:'worker-only.json',sha256:'b'.repeat(64)},evidence:[{path:'worker-only.raw.json',sha256:'c'.repeat(64)}],change:{hostAbiVersion:1,legacyExecution:'removed',workerSynchronousDom:'explicit-unsupported',documentation:{path:'contract.md',sha256:'d'.repeat(64)}}};
 assert.equal(assessWorkerCapabilityCase({},item),true);assert.equal(assessWorkerCapabilityCase({},{...item,change:{...item.change,legacyExecution:'explicit-preserved'}}),false);
});

test('public rollout gate blocks the obsolete single-report performance contract',async()=>{
 await assert.rejects(assertWorkerPerformanceEvidence({},'passing-direct.json'),/Both direct and bitmap/);
 await assert.rejects(assertWorkerPerformanceEvidence({},undefined),/Both direct and bitmap/);
});

test('local rollout verification requires valid performance evidence for both presenters',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'worker-rollout-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const save=(filename,value)=>writeFile(filename,JSON.stringify(value,null,2)+'\n');
 const site=path.join(directory,'site');
 await performanceSiteFixture(site);
 const {payloads,...identity}=await siteIdentity(site),comparisonInputs=await performanceComparisonInputs(site,{demos:['scene']});
 const sources=Object.fromEntries(['browser-engine-performance.mjs','performance-acceptance.mjs','browser-harness.mjs','site-evidence.mjs'].map(name=>['apps/playground/scripts/'+name,'proof']));
 const producer={schemaVersion:1,kind:'worker-performance-tool',sources};
 const parameters={demos:['scene'],samplesPerDemo:3,thresholds:'No budget'};
 const hardware={platform:'linux',arch:'x64',node:'24',kernel:'unit-kernel',cpuModels:['cpu'],logicalCPUs:2,availableParallelism:2,totalMemoryBytes:4096,cgroupCpuMax:'200000 100000',cgroupMemoryMax:'4096',loadAverageStart:[1,1,1],loadAverageEnd:[2,2,2]};
 const baseline={schemaVersion:2,kind:'godotjs-browser-engine-performance',measurementStatus:'completed',measurementBatchId:'baseline-batch',identity:{...identity,releaseId:digest('historical release'),descriptorHash:digest('historical descriptor'),candidateId:digest('historical baseline'),siteHash:digest('historical site')},comparisonInputs,producer,parameters,hardware,measurementScope:{profile:identity.profile,executionBackend:'legacy',presentationBackend:'legacy',browser:'chromium',settingsTier:'default'},engine:{templateTarget:'template_debug'},scenarios:[{browser:{name:'chromium',version:'154',settingsTier:'default'}}],summary:{demos:{scene:{navigationToRunningMs:{p95:100},wasmMemoryCapacityPeakBytes:{max:1000},stopMs:{max:100},perSampleMedianTelemetryFPS:{median:60}}}}};
 const receipt={...identity,testSources:sources};
 const baselinePath=path.join(directory,'browser-engine-performance.legacy.json');await save(baselinePath,baseline);
 const baselineSha256=digest(await readFile(baselinePath));
 const files={baseline:baselinePath};
 const verify=()=>assertWorkerPerformanceEvidence(receipt,files,{target:'template_debug',site});
 let directBudget;
 for(const presentationBackend of ['direct','bitmap']){
  const budget=createWorkerRegressionBudget(baseline,{baselineSha256,presentationBackend});
  const report={...baseline,identity,measurementScope:budget.scope,parameters:{...parameters,thresholds:{budgetId:budget.id}},hardware:{...hardware,loadAverageStart:[3,3,3],loadAverageEnd:[4,4,4]}};
  report.performanceAcceptance=assessPerformanceBudget(report,budget);
  files[presentationBackend]={budget:path.join(directory,presentationBackend+'-budget.json'),report:path.join(directory,presentationBackend+'-report.json')};
  await save(files[presentationBackend].budget,budget);
  await save(files[presentationBackend].report,report);
  if(presentationBackend==='direct')directBudget=budget;
 }
 const valid=await verify();
 assert.equal(valid.direct.status,'passed');
 assert.equal(valid.bitmap.status,'passed');
 const directFile=files.direct.report, originalDirect=JSON.parse(await readFile(directFile));
 for(const [name,change,pattern]of [
  ['material',value=>{value.comparisonInputs.sdk.sourceSnapshotHash=digest('different SDK');},/E_PERFORMANCE_BASELINE_MATERIAL/],
  ['candidate',value=>{value.identity.candidateId=digest('other candidate');},/Performance identity differs/],
  ['producer',value=>{value.producer.sources['apps/playground/scripts/site-evidence.mjs']='old-tool';},/Performance tool sources differ/],
  ['hardware',value=>{value.hardware.logicalCPUs++;},/Performance hardware differs/],
  ['parameters',value=>{value.parameters.samplesPerDemo++;},/Performance parameters differ/],
  ['browser version',value=>{value.scenarios[0].browser.version='other-build';},/browser version differs/],
 ]){
  const altered=structuredClone(originalDirect);change(altered);await save(directFile,altered);
  await assert.rejects(verify,pattern,name);
 }
 await save(directFile,originalDirect);
 directBudget.metrics[0].value=999999;
 await save(files.direct.budget,directBudget);
 await assert.rejects(verify,/Fixed regression budget differs: direct/);
 await save(files.direct.budget,createWorkerRegressionBudget(baseline,{baselineSha256,presentationBackend:'direct'}));
 const bitmap=JSON.parse(await readFile(files.bitmap.report));
 bitmap.summary.demos.scene.perSampleMedianTelemetryFPS.median=7;
 await save(files.bitmap.report,bitmap);
 await assert.rejects(verify,/Fixed Worker regression budget failed: bitmap/);
});
