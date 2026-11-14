import test from 'node:test';
import assert from 'node:assert/strict';
import {assessWorkerRollout} from './worker-rollout-gates.mjs';
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
