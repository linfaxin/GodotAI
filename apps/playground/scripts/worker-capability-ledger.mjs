import {canonical} from './site-evidence.mjs';
import {runConfigurationHash} from './worker-candidate.mjs';
/** The compatibility baseline is published API/docs plus shipped product
 * behavior. Passing the demo matrix cannot remove a capability from it. */
export const WORKER_CAPABILITY_LEDGER=Object.freeze([
 ['native-react','Native Godot handles and React reconciliation execute in the same Worker'],
 ['scene-2d','2D canvas, shader, lighting and sprite rendering'],
 ['physics-navigation-2d','2D physics, collisions, raycasts, navigation and TileMap'],
 ['gui-input','Native GUI, pointer, keyboard, touch and focus behavior'],
 ['ime','Text composition, native control focus and input-method geometry'],
 ['accessibility','Published native GUI accessibility behavior'],
 ['resources','Published image/font/audio/packed-resource formats, import and load behavior'],
 ['text','Font fallback, CJK glyph coverage and profile-specific shaping behavior'],
 ['script-bindings','GDScript, native bindings, snake/camel names and source locations'],
 ['audio-sample-stream','Actual audible sample and stream playback, restart and cleanup'],
 ['audio-positional','Actual positional sample graph output'],
 ['microphone','Explicit user-gesture microphone access, input transfer and retirement'],
 ['http','HTTP requests, cancellation and resource loading'],
 ['websocket','WebSocket including multiplayer API behavior'],
 ['webrtc','WebRTC peer/data-channel behavior through the versioned host ABI'],
 ['clipboard','Clipboard read/write under the published gesture and permission contract'],
 ['fullscreen','Fullscreen requests, state and retirement'],
 ['pointer-lock','Pointer-lock requests, state and retirement'],
 ['file-dialog','File selection and bounded binary ingress'],
 ['drag-drop','Files/directories, native completion fences and bounded binary ingress'],
 ['downloads','Native download/save behavior and object-URL cleanup'],
 ['url-open','Published URL opening and gesture behavior'],
 ['gamepad','Gamepad discovery, event/state forwarding and retirement'],
 ['midi','Web MIDI permissions, native device events and retirement'],
 ['vibrate','Published handheld vibration behavior and platform boundary'],
 ['pwa','Published PWA discovery/update behavior including optional registration denial'],
 ['tts','Text-to-speech voices, requests, completion and cancellation'],
 ['storage-isolation','Virtual FS/persistence and project/origin isolation'],
 ['lifecycle','Failure cancellation, fresh workers, heartbeat and bounded cleanup'],
 ['legacy-contract','Worker-only execution, retired legacy entry and documented synchronous-DOM boundary'],
].map(([id,contract])=>Object.freeze({id,contract,profiles:Object.freeze(['full-engine-v1','engine-2d-v1']),implementationStatus:'requires-candidate-evidence'})).concat([
 Object.freeze({id:'scene-3d',contract:'Published full-profile 3D scene/render/physics/navigation capability',profiles:Object.freeze(['full-engine-v1']),implementationStatus:'requires-candidate-evidence'}),
 Object.freeze({id:'webxr',contract:'Published WebXR capability and original per-browser platform boundary',profiles:Object.freeze(['full-engine-v1']),implementationStatus:'requires-candidate-evidence'}),
]));
export const WORKER_CAPABILITY_CLASSIFICATIONS=Object.freeze(['native-usable','bridged','original-platform-unsupported','versioned-change','pending-bridge']);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const artifact=value=>value&&typeof value.path==='string'&&value.path.length>0&&hash(value.sha256);
function originalPlatformProof(receipt,item){
 const baseline=item.baseline,probe=baseline?.probe;
 // A negative native baseline is allowed only for the same exact browser,
 // default settings and native release. Missing hardware/permissions/environment
 // cannot be reclassified as original platform non-support.
 return baseline?.executionBackend==='legacy'&&baseline.nativeSourceCertified===true&&baseline.workerRuntimeInstalled===false&&
  ['profile','releaseId','descriptorHash','candidateId','siteHash'].every(key=>baseline[key]===receipt[key])&&
  ['name','version','platform','settingsTier'].every(key=>baseline.browser?.[key]===item.browser[key])&&
  artifact(probe)&&probe.kind==='native-platform-capability-probe'&&probe.capability===item.capability&&probe.realm==='window-native-engine'&&probe.status==='unsupported'&&
  ['api-not-exposed','native-platform-not-supported'].includes(probe.cause)&&probe.environment?.secureContext===true&&probe.environment?.policyAllowed===true&&
  ['not-required','available'].includes(probe.environment?.hardware)&&probe.environment?.blocked===false;
}

export function assessWorkerCapabilityCase(receipt,item){
 if(!item||item.status!=='passed'||item.browser?.settingsTier!=='default'||typeof item.browser.version!=='string'||!item.browser.version||typeof item.browser.platform!=='string'||!item.browser.platform||item.executionBackend!=='worker'||!Array.isArray(item.sessions)||!item.sessions.length||item.sessions.some(session=>typeof session.runId!=='string'||typeof session.documentId!=='string'||typeof session.workerId!=='string'||!hash(session.runConfigurationHash))||!artifact(item.probe)||!Array.isArray(item.evidence)||!item.evidence.length||item.evidence.some(asset=>!artifact(asset)))return false;
 if(['native-usable','bridged'].includes(item.classification))return true;
 if(item.classification==='original-platform-unsupported')return originalPlatformProof(receipt,item);
 // The only agreed intentional semantic boundary is synchronous browser-global
 // interop. An arbitrary unimplemented host API cannot use this classification.
 if(item.classification==='versioned-change')return item.capability==='legacy-contract'&&item.change?.hostAbiVersion===1&&item.change?.legacyExecution==='removed'&&item.change?.workerSynchronousDom==='explicit-unsupported'&&artifact(item.change?.documentation);
 return false;
}
export function assertOriginalPlatformProbeReport(receipt,item,report){
 if(!originalPlatformProof(receipt,item)||report?.schemaVersion!==1||report.executionBackend!=='legacy'||report.nativeSourceCertified!==true||report.workerRuntimeInstalled!==false)throw Error('E_WORKER_PLATFORM_BASELINE_PROBE');
 const baseline=item.baseline;
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(report[key]!==baseline[key])throw Error('E_WORKER_PLATFORM_BASELINE_IDENTITY: '+key);
 for(const key of ['name','version','platform','settingsTier'])if(report.browser?.[key]!==baseline.browser[key])throw Error('E_WORKER_PLATFORM_BASELINE_BROWSER: '+key);
 for(const key of ['kind','capability','realm','status','cause','environment'])if(canonical(report[key])!==canonical(baseline.probe[key]))throw Error('E_WORKER_PLATFORM_BASELINE_RESULT: '+key);
 for(const realm of ['native','browser'])if(!report.observations?.[realm]||typeof report.observations[realm]!=='object'||Array.isArray(report.observations[realm])||!Object.keys(report.observations[realm]).length)throw Error('E_WORKER_PLATFORM_BASELINE_OBSERVATIONS');
}
export function assertWorkerCapabilityProbeReport(receipt,item,report){
 if(!assessWorkerCapabilityCase(receipt,item)||report?.schemaVersion!==3||report.kind!=='worker-capability-probe'||report.status!=='passed'||report.testMode!=='real-engine')throw Error('E_WORKER_CAPABILITY_PROBE');
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash','acceptanceBatchId'])if(report[key]!==receipt[key])throw Error('E_WORKER_CAPABILITY_PROBE_IDENTITY: '+key);
 for(const key of ['capability','classification','executionBackend','presentationBackend','sdkMode','naming'])if(report[key]!==item[key])throw Error('E_WORKER_CAPABILITY_PROBE_CASE: '+key);
 if(canonical(report.browser)!==canonical(item.browser)||!Array.isArray(report.sessions)||!item.sessions.every(session=>report.sessions.some(actual=>['runId','documentId','workerId','runConfigurationHash'].every(key=>actual[key]===session[key]))))throw Error('E_WORKER_CAPABILITY_PROBE_SESSION');
 if(!report.runConfiguration||runConfigurationHash(report.runConfiguration)!==report.runConfigurationHash||report.runConfiguration.presentationBackend!==item.presentationBackend||report.sessions.some(session=>session.runConfigurationHash!==report.runConfigurationHash))throw Error('E_WORKER_CAPABILITY_PROBE_CONFIGURATION');
 if(typeof report.producer?.path!=='string'||receipt.testSources?.[report.producer.path]!==report.producer.sha256)throw Error('E_WORKER_CAPABILITY_PROBE_SOURCE');
 if(!report.observations||typeof report.observations!=='object'||Array.isArray(report.observations)||!Object.keys(report.observations).length||!report.checks||typeof report.checks!=='object'||Array.isArray(report.checks)||!Object.keys(report.checks).length||Object.values(report.checks).some(value=>value!==true))throw Error('E_WORKER_CAPABILITY_PROBE_OBSERVATIONS');
 if(['native-usable','bridged'].includes(item.classification)&&report.observations.supported!==true)throw Error('E_WORKER_CAPABILITY_PROBE_SUPPORT');
 if(item.classification==='original-platform-unsupported'&&(report.observations.supported!==false||report.observations.preservedOriginalBoundary!==true))throw Error('E_WORKER_CAPABILITY_PROBE_SUPPORT');
 if(item.classification==='versioned-change'&&(report.observations.explicitLegacyAvailable!==false||report.observations.workerSynchronousDomUnsupported!==true))throw Error('E_WORKER_CAPABILITY_PROBE_SUPPORT');
 if(['native-usable','bridged'].includes(item.classification)){
  const observed=report.observations,positive=value=>Number.isSafeInteger(value)&&value>0;
  // API presence or an inline XR session cannot certify missing hardware.
  // These are actual native-facing observations, not platform feature flags.
  if(item.capability==='webxr'&&(!['immersive-vr','immersive-ar'].includes(observed.xr?.sessionMode)||observed.xr.sessionStarted!==true||!positive(observed.xr.presentedFrames)||!positive(observed.xr.nativeViewFrames)||observed.xr.sessionEnded!==true||observed.xr.resourcesRetired!==true))throw Error('E_WORKER_CAPABILITY_PROBE_HARDWARE: immersive WebXR session/frame/retirement evidence required');
  if(item.capability==='microphone'&&(!positive(observed.microphone?.inputFrames)||!Number.isFinite(observed.microphone.inputPeak)||observed.microphone.inputPeak<=0.001||observed.microphone.closed!==true))throw Error('E_WORKER_CAPABILITY_PROBE_HARDWARE: actual microphone input and retirement required');
  if(['midi','gamepad'].includes(item.capability)&&(!positive(observed[item.capability]?.inputEvents)||!positive(observed[item.capability]?.nativeEvents)||observed[item.capability]?.closed!==true))throw Error('E_WORKER_CAPABILITY_PROBE_HARDWARE: actual device/native events and retirement required');
  if(item.capability==='vibrate'&&(observed.vibrate?.hardwareAvailable!==true||observed.vibrate?.requestAccepted!==true||!positive(observed.vibrate?.nativeCalls)))throw Error('E_WORKER_CAPABILITY_PROBE_HARDWARE: actual vibration device/request evidence required');
  if(item.capability==='tts'&&(!positive(observed.tts?.voices)||observed.tts?.started!==true||observed.tts?.completed!==true||observed.tts?.cancelled!==true||!positive(observed.tts?.nativeCallbacks)))throw Error('E_WORKER_CAPABILITY_PROBE_HARDWARE: actual voices, speech lifecycle and native callbacks required');
 }
}

export function assessWorkerCapabilityEvidence(receipt,report){
 const failures=[];
 if(receipt?.schemaVersion!==3||receipt.status!=='passed')failures.push('An exact schema-3 site acceptance receipt is required.');
 if(report?.schemaVersion!==3||report.status!=='passed')failures.push('A schema-3 capability report is required.');
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash','acceptanceBatchId'])if(typeof receipt?.[key]!=='string'||report?.[key]!==receipt[key])failures.push('Capability identity differs: '+key);
 const cases=report?.cases??[];
 for(const capability of WORKER_CAPABILITY_LEDGER.filter(item=>item.profiles.includes(receipt?.profile))){
  const entries=cases.filter(item=>item.capability===capability.id);
  for(const browser of ['chromium','firefox','webkit'])for(const presentationBackend of ['direct','bitmap'])for(const sdkMode of ['production','development'])for(const naming of ['snake','camel']){
   const item=entries.find(item=>item.browser?.name===browser&&item.presentationBackend===presentationBackend&&item.sdkMode===sdkMode&&item.naming===naming);
   if(!assessWorkerCapabilityCase(receipt,item))failures.push([capability.id,browser,presentationBackend,sdkMode,naming].join(':'));
  }
 }
 return {status:failures.length?'blocked':'passed',failures};
}
