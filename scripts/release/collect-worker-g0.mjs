import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {executionFromReport,assertExecutionAssets} from './execution-contract.mjs';
import {isSourceCertified} from './engine-build-proof.mjs';
import {validateEngineProfile} from './engine-profiles.mjs';
import {collectG0Receipt,G0_CASES} from './g0-readiness.mjs';
import {canonicalIdentityJson,assertRuntimeTargetIdentity} from './release-identities.mjs';
import {inspectBrowserEngineArtifact} from '../test/package-browser-engine-artifact.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=detail=>{throw Error('E_WORKER_G0: '+detail);};
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const validCleanup=value=>!!value&&Number.isSafeInteger(value.workers)&&value.workers>0&&value.terminatedWorkers===value.workers&&Array.isArray(value.errors)&&value.errors.length===0;
const json=async path=>JSON.parse(await readFile(path,'utf8'));
async function copyEvidence(source,target){await mkdir(dirname(target),{recursive:true});if(resolve(source)!==resolve(target))await copyFile(source,target);return sha(await readFile(target));}
async function copyParentTestLog(sourceParent,targetParent){
  const report=await json(sourceParent),path=report.log?.path??report.tests?.report,expected=report.log?.sha256??report.tests?.reportSha256;
  if(path===undefined&&expected===undefined)return;
  if(typeof path!=='string'||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||!hash(expected))fail('Invalid parent test log');
  if(await copyEvidence(resolve(dirname(sourceParent),path),resolve(dirname(targetParent),path))!==expected)fail('Parent test log changed');
}
function rejects(operation){try{operation();return false;}catch{return true;}}
async function scopeIdentitySuite(source,{directory,execution,build,engineReport,engineBytes,sourceSnapshotHash,validationBatchId}){
  const suite=await json(source),limitations=[],observed=Object.fromEntries(G0_CASES['execution-identity'].checks.map(key=>[key,false]));
  let candidateMatches=suite.nativeArtifact?.reportSha256===sha(engineBytes),portableManifestHash;
  if(!candidateMatches){
    try{
      const portable=await inspectBrowserEngineArtifact(dirname(engineReport));
      candidateMatches=portable.manifest.sourceReportSha256===suite.nativeArtifact?.reportSha256&&portable.manifest.files['engine-report.json'].sha256===sha(engineBytes)&&canonicalIdentityJson(portable.report)===canonicalIdentityJson(build);
      if(candidateMatches)portableManifestHash=sha(await readFile(resolve(dirname(engineReport),'artifact.json')));
    }catch{ /* An unrelated or invalid portable view cannot bridge report identities. */ }
  }
  let fresh=suite.kind==='w5-implementation-validation'&&suite.status==='passed'&&suite.tests?.failed===0&&suite.tests?.passed>0&&candidateMatches;
  const inputs=suite.source?.inputs??{};
  if(!Object.keys(inputs).length||sha(canonicalIdentityJson(inputs))!==suite.source?.snapshotHash)fresh=false;
  for(const [filename,expected]of Object.entries(inputs)){
    const actual=resolve(repository,filename);if(!actual.startsWith(repository+sep)){fresh=false;continue;}
    try{if(sha(await readFile(actual))!==expected){fresh=false;limitations.push('Tested source changed: '+filename);}}catch{fresh=false;limitations.push('Tested source is unavailable: '+filename);}
  }
  try{if(sha(await readFile(resolve(dirname(source),suite.tests.report)))!==suite.tests.reportSha256)fresh=false;}catch{fresh=false;}
  if(fresh){
    observed.completeAssetClosure=true;
    const corrupt=build.template.assets.map(asset=>({...asset}));const worker=execution.workerAssets?.[0];
    if(worker){corrupt.find(asset=>asset.path===worker.path).sha256='0'.repeat(64);observed.wrongAssetRejected=rejects(()=>assertExecutionAssets(execution,corrupt));}
    observed.wrongModelRejected=rejects(()=>executionFromReport({...build,execution:{...execution,executionModel:'window'}}));
    observed.wrongExtensionRejected=rejects(()=>assertRuntimeTargetIdentity({engineId:build.template.sha256,extensionId:sha('extension A')},{engineId:build.template.sha256,extensionId:sha('extension B')}));
    const {loadVerifiedEngine}=await import('@godot-js/engine/browser/verified-loader');
    const main=build.template.assets.find(asset=>asset.path==='godot.js'),wasm=build.template.assets.find(asset=>asset.path==='godot.wasm');
    try{await loadVerifiedEngine({releaseId:'g0-validation',profile:build.runtimeProfile,execution:{...execution,hostProtocolVersion:99},engineJs:{url:'https://g0.invalid/godot.js',sha256:main.sha256},engineWasm:{url:'https://g0.invalid/godot.wasm',sha256:wasm.sha256},workerAssets:execution.workerAssets.map(asset=>({url:'https://g0.invalid/'+asset.path,name:asset.path.split('/').at(-1),sha256:asset.sha256,bytes:asset.bytes,role:asset.role}))});}catch(error){observed.wrongProtocolRejected=String(error).includes('E_ENGINE_HOST_PROTOCOL');}
  }else limitations.push('The supplied unit suite does not bind the current producer sources, passing test log and candidate build.');
  const parentPath='parents/execution-identity-unit.json',parentHash=await copyEvidence(source,resolve(directory,parentPath));
  if(fresh)await copyParentTestLog(source,resolve(directory,parentPath));
  const producerHash=sha(canonicalIdentityJson({unitSuite:parentHash,unitSources:suite.source?.snapshotHash??null,candidateEngineReport:sha(engineBytes),portableManifestHash:portableManifestHash??null,collector:sha(await readFile(fileURLToPath(import.meta.url)))}));
  return {schemaVersion:1,status:fresh&&Object.values(observed).every(value=>value===true)?'passed':'unverified',caseId:'execution-identity',evidenceKind:'node-test',validationBatchId,sourceSnapshotHash,producerHash,observed,details:{candidateEngineReportSha256:sha(engineBytes),testedEngineReportSha256:suite.nativeArtifact?.reportSha256,portableManifestHash},limitations:[...limitations,'Node validators and loader version rejection were exercised; this is not browser runtime evidence.'],parentEvidence:{path:parentPath,sha256:parentHash,caseId:'execution-identity',testSuite:true}};
}

/** Derive scoped facts from producer observations. Never parse an error string
 * for successes, promote a failed suite, or infer a browser run from a build. */
export async function collectWorkerG0({engineReport,runtimeReport,out,identityReport,projectReport}={}){
  if(!engineReport||!runtimeReport)fail('Pass actual engine and runtime reports');
  const engineBytes=await readFile(engineReport),build=JSON.parse(engineBytes),rawBytes=await readFile(runtimeReport),raw=JSON.parse(rawBytes);
  if(!isSourceCertified(build))fail('Actual source-bound build evidence is required');
  const execution=executionFromReport(build,{requireWorkerAssets:true});assertExecutionAssets(execution,build.template.assets);
  validateEngineProfile(build.runtimeProfile,{modules:build.modules,features:{...build.resolvedBuildOptions,...build.resolvedFeatures},forBuild:true});
  if(sha(await readFile(resolve(dirname(engineReport),build.template.path)))!==build.template.sha256)fail('Actual template bytes changed');
  const directory=resolve(out??dirname(runtimeReport)+'/g0');await mkdir(directory,{recursive:true});
  const parentPath='parents/runtime.json',parentHash=await copyEvidence(runtimeReport,resolve(directory,parentPath));
  const runtimeDirectory=dirname(resolve(runtimeReport));
  const artifactPaths=[];
  let producerFilesVerified=true;
  for(const [key,path]of [['host','session.js'],['pack','project.pck'],['editorHtml','index.html'],['previewHtml','preview.html']]){
    const expected=raw.producerInputs?.[key];
    if(!hash(expected)){producerFilesVerified=false;continue;}
    const source=resolve(runtimeDirectory,'site',path),bytes=await readFile(source);
    if(sha(bytes)!==expected)fail('Runtime producer input changed: '+key);
    const outputPath='producer/'+path;await copyEvidence(source,resolve(directory,outputPath));artifactPaths.push(outputPath);
  }
  // New producers archive their exact harness; earlier reports retain the
  // recorded hash without pretending it is today's mutable source file.
  let harnessArchived=false;
  try{
    const source=resolve(runtimeDirectory,'producer/harness.mjs'),bytes=await readFile(source);
    if(sha(bytes)!==raw.producerInputs?.harness)fail('Archived runtime harness changed');
    const outputPath='producer/harness.mjs';await copyEvidence(source,resolve(directory,outputPath));artifactPaths.push(outputPath);harnessArchived=true;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  for(const asset of build.template.assets){
    if(!/\.(?:js|mjs|wasm)$/.test(asset.path))continue;
    const source=resolve(runtimeDirectory,'site/engine',asset.path),prefix=resolve(runtimeDirectory,'site/engine')+sep;
    if(!source.startsWith(prefix))fail('Unsafe template asset path');
    const bytes=await readFile(source);
    if(sha(bytes)!==asset.sha256||bytes.length!==asset.bytes)fail('Runtime input differs from sealed template: '+asset.path);
    const sourcePath='artifacts/'+asset.path;await copyEvidence(source,resolve(directory,sourcePath));artifactPaths.push({path:asset.path,sourcePath});
  }
  const eligible=producerFilesVerified&&raw.kind==='godotjs-worker-integration'&&hash(raw.producerHash)&&raw.producerHash===sha(JSON.stringify(raw.producerInputs))&&raw.sourceSnapshotHash===build.source.snapshotHash&&raw.engineReportHash===sha(engineBytes)&&raw.templateSha256===build.template.sha256&&typeof raw.validationBatchId==='string'&&!!raw.validationBatchId;
  const sourceSnapshotHash=build.source.snapshotHash,producerHash=eligible?raw.producerHash:sha(await readFile(fileURLToPath(import.meta.url))),validationBatchId=eligible?raw.validationBatchId:'unverified-'+sha(rawBytes).slice(0,16);
  const environment={browser:raw.browser?.name,browserVersion:raw.browser?.version,os:raw.os??raw.environment?.os,topOrigin:raw.origins?.editor,previewOrigin:raw.origins?.preview,responseHeaders:raw.responseHeaders};
  const browserKnown=['chromium','firefox','webkit','safari'].includes(environment.browser)&&!!environment.browserVersion&&!!environment.os;
  const scoped=raw.cases?.find(item=>item.status==='passed');
  const forced=raw.cases?.find(item=>item.status==='passed'&&item.cleanup?.mode==='forced');
  const facts={};
  const start=scoped?.start??{},ready=scoped?.ready??{},lifecycle=ready.reactLifecycle??{},roles=scoped?.roles??[];
  facts['engine-execution']={completeModuleBuild:eligible&&start.modules===build.modules.length,sameEngineRealm:start.documentAbsent===true&&start.role==='engine'&&ready.reactValue===7&&roles.some(item=>item.role==='engine'),physicsObserved:ready.collided===true&&ready.physicsFrames>0,glOwnershipRecorded:scoped?.gl?.some(item=>['host','engine'].includes(item.owner)&&['webgl','webgl2','experimental-webgl'].includes(item.type))===true};
  facts['worker-routing']={explicitRoles:roles.some(item=>item.role==='engine')&&roles.some(item=>item.role==='script-worker'),echoReturned:ready.echo===true,variantTransferred:ready.echo===true,workerExited:validCleanup(scoped?.cleanup)};
  let separateOrigins=false;try{const top=new URL(environment.topOrigin),preview=new URL(environment.previewOrigin);separateOrigins=top.protocol==='https:'&&preview.protocol==='https:'&&top.origin!==preview.origin;}catch{}
  const isolation=raw.isolation??{},platform=raw.platformProbe??{};
  const pinnedTls=raw.browser?.name==='chromium'&&(raw.launchArgs??[]).some(arg=>arg.startsWith('--ignore-certificate-errors-spki-list='))&&!(raw.launchArgs??[]).includes('--ignore-certificate-errors');
  const audio=scoped?.id==='session-0'?scoped.audio:scoped?.audioStart!==undefined?scoped.audio?.slice(scoped.audioStart):[];
  facts['isolated-host']={trustedHttps:separateOrigins&&(pinnedTls||raw.tlsTrust==='system-ca')&&isolation.top?.secure===true&&isolation.preview?.secure===true&&start.workerSecure===true,separateOrigins,topIsolated:isolation.top?.isolated===true,previewIsolated:isolation.preview?.isolated===true,workerIsolated:start.workerIsolated===true,sabAvailable:isolation.top?.sab===true&&isolation.preview?.sab===true&&start.sab===true,inputObserved:ready.inputs>0,audioObserved:audio?.some(item=>item.peak>0.01&&item.checks>0)===true,syncHostProbed:start.syncHost?.screen?.x>0&&start.syncHost?.screen?.y>0&&typeof start.syncHost?.display==='string',imeXrProbed:typeof platform.ime?.compositionEvent==='boolean'&&typeof platform.ime?.beforeInput==='boolean'&&typeof platform.xr?.api==='boolean'&&typeof platform.xr?.immersiveVR==='boolean'};
  facts['session-termination']={engineHung:forced?.termination?.engineHung===true,hostResponsive:forced?.termination?.hostResponsive===true,allOwnedThreadsStopped:validCleanup(forced?.cleanup),hostAudioClosed:forced?.cleanup?.audioContexts>0&&forced.cleanup.closedAudioContexts===forced.cleanup.audioContexts&&forced.audio?.every(item=>item.state==='closed')===true,portsClosed:Number.isSafeInteger(forced?.cleanup?.messagePorts)&&forced.cleanup.messagePorts===forced.cleanup.closedMessagePorts,staleSessionRejected:forced?.staleSessionRejected===true||raw.staleSessionRejected===true,nextSessionRunning:raw.status==='passed'&&validCleanup(raw.afterForcedRestart)};
  facts['react-native']={crossRootPhaseGuard:lifecycle.phase?.passed===true&&lifecycle.phase.sharedSession===true&&lifecycle.phase.commitsBefore===lifecycle.phase.commitsDuring&&lifecycle.phase.commitsAfter>lifecycle.phase.commitsBefore,cleanupBeforeFree:lifecycle.detached?.passed===true&&lifecycle.detached.aliveInRef===true&&lifecycle.detached.aliveInLayout===true&&lifecycle.detached.aliveInPassive===true&&lifecycle.detached.validAfterFree===false,destroyedExactlyOnce:lifecycle.detached?.releaseRequested===1&&lifecycle.detached.freed===1&&lifecycle.detached.pendingReleases===0,opaquePortalLifecycle:lifecycle.opaque?.passed===true&&lifecycle.opaque.ownerAliveAtCleanup===true&&lifecycle.opaque.portalAliveAtCleanup===true&&lifecycle.opaque.pendingReleases===0};
  const caseReports={};
  for(const [id,observed]of Object.entries(facts)){
    const parent=id==='session-termination'?forced:scoped;
    const missing=G0_CASES[id].checks.filter(key=>observed[key]!==true),limitations=[];
    if(!eligible)limitations.push('Runtime producer/source/build provenance is missing or differs from the candidate.');
    if(!browserKnown)limitations.push('Actual browser version and OS were not recorded.');
    if(!parent)limitations.push('The parent producer contains no passed scoped runtime case.');
    if(missing.length)limitations.push('Unverified observations: '+missing.join(', '));
    if(raw.status!=='passed')limitations.push('The parent suite did not pass; this report claims only its explicitly passed scoped case.');
    if(!harnessArchived)limitations.push('The producer recorded its harness hash but did not archive those source bytes; no equivalence to the current mutable harness is claimed.');
    if(id==='isolated-host')limitations.push('IME/XR coverage is a DOM capability and isSessionSupported probe, not OS composition or an XR device session. TLS may use the recorded certificate SPKI pin; this is not production CA/deployment acceptance.');
    const status=eligible&&browserKnown&&parent&&missing.length===0?'passed':'unverified';
    const report={schemaVersion:1,status,caseId:id,evidenceKind:'browser-runtime',validationBatchId,sourceSnapshotHash,producerHash,environment,observed,limitations,...(parent?{parentEvidence:{path:parentPath,sha256:parentHash,caseId:parent.id}}:{}),details:{start,ready,cleanup:parent?.cleanup,gl:scoped?.gl,platformProbe:platform}};
    const path='cases/'+id+'.json';await mkdir(dirname(resolve(directory,path)),{recursive:true});await writeFile(resolve(directory,path),JSON.stringify(report,null,2)+'\n');caseReports[id]=path;
  }
  // These reports have their own immutable producers. They never gain browser
  // evidence labels just because the enclosing candidate has run in a Worker.
  for(const [id,source]of [['execution-identity',identityReport],['project-write',projectReport]]){
    if(!source)continue;
    let report=await json(source);
    if(id==='execution-identity'&&report.kind==='w5-implementation-validation')report=await scopeIdentitySuite(source,{directory,execution,build,engineReport,engineBytes,sourceSnapshotHash,validationBatchId});
    else if(report.parentEvidence){
      const parentPath='parents/'+id+'-producer.json',parentHash=await copyEvidence(resolve(dirname(source),report.parentEvidence.path),resolve(directory,parentPath));
      if(parentHash!==report.parentEvidence.sha256)fail('Independent producer parent changed: '+id);
      if(report.status==='passed'&&report.parentEvidence.testSuite)await copyParentTestLog(resolve(dirname(source),report.parentEvidence.path),resolve(directory,parentPath));
      report={...report,parentEvidence:{...report.parentEvidence,path:parentPath}};
    }
    if(report.caseId!==id||report.evidenceKind==='browser-runtime'||report.validationBatchId!==validationBatchId||report.sourceSnapshotHash!==sourceSnapshotHash||!hash(report.producerHash))fail('Supply an independently scoped, candidate-bound nonbrowser report for '+id);
    const path='cases/'+id+'.json';await writeFile(resolve(directory,path),JSON.stringify(report,null,2)+'\n');caseReports[id]=path;
  }
  const result=await collectG0Receipt({root:directory,sourceSnapshotHash,producerHash,validationBatchId,execution,artifactPaths,caseReports});
  await writeFile(resolve(directory,'g0-receipt.json'),JSON.stringify(result.receipt,null,2)+'\n');
  await writeFile(resolve(directory,'readiness.json'),JSON.stringify(result.readiness,null,2)+'\n');
  return {directory,...result};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};for(let index=2;index<process.argv.length;index+=2)options[process.argv[index].replace(/^--/,'')]=process.argv[index+1];
  try{const result=await collectWorkerG0({engineReport:options['engine-report'],runtimeReport:options['runtime-report'],out:options.out,identityReport:options['identity-report'],projectReport:options['project-report']});console.log(JSON.stringify({directory:result.directory,clearedBlockers:result.readiness.clearedBlockers,defaultReleaseReady:false}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
