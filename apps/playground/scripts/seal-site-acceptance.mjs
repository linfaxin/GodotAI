import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical,digest,sitePayloads,siteCandidateId} from './site-evidence.mjs';
import {isEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {assessStoppedAudio} from './feature-audio-evidence.mjs';
import {assertRuntimeEvidence} from './runtime-evidence.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const json=async file=>JSON.parse(await readFile(file,'utf8'));
export const REQUIRED_SITE_REPORTS=Object.freeze(['runtime','editor','bridge','projects','demo-regressions','react-demos','workbench','delivery']);
export const REQUIRED_2D_SITE_REPORTS=Object.freeze(['features','features.firefox','features.webkit','runtime.firefox','runtime.webkit']);
export const REQUIRED_2D_FEATURE_CHECKS=Object.freeze(['physicsRay','physicsCollision','navigation','tilemapRendered','textMetrics','textRendered','cjkGlyphCoverage','audioStarted','audioStopped','audioRestarted','nativeButtonInput','nativeCleanup']);
export async function sealSiteAcceptance(directory,reports,{verify=false,begin=false}={}){
 directory=path.resolve(directory);reports=path.resolve(reports);
 const release=await json(path.join(directory,'engine-release.json'));
 if(release.schemaVersion!==2||!isEngineProfile(release.runtimeProfile))throw Error('E_SITE_PROFILE');
 if(release.build?.sourceCertified!==true)throw Error('E_SITE_UNCERTIFIED_SOURCE');
 const resources=await json(path.join(directory,'resource-build.json'));
 if(resources.runtimeProfile!==release.runtimeProfile||resources.engineReleaseId!==release.id)throw Error('E_SITE_RESOURCE_IDENTITY');
 const identity=structuredClone(release);delete identity.id;delete identity.verifiedRelease.releaseId;
 if(digest(canonical(identity))!==release.id)throw Error('E_SITE_RELEASE_ID');
 const sources={};
 for(const [mapName,entry]of [['main.js.map','apps/playground/src/main.ts'],['compiler.worker.js.map','apps/playground/src/compiler.worker.ts'],['preview.js.map','apps/playground/preview.ts']]){
  const map=await json(path.join(directory,mapName)),expected=await readFile(path.join(repo,entry),'utf8');
  const suffix=entry.includes('/src/')?'src/'+path.basename(entry):path.basename(entry);
  // Embedded source identity remains valid when the immutable site is moved
  // from a CI staging directory into an artifact or another serving directory.
  const index=map.sources.findIndex((source,index)=>source.replaceAll('\\','/').endsWith('/'+suffix)&&map.sourcesContent?.[index]===expected);
  if(index<0)throw Error('E_SITE_ENTRY: '+entry);
  sources[entry]=digest(map.sourcesContent[index]);
 }
 const payloads=await sitePayloads(directory);
 for(const name of ['generatedManifest','output','demoPack']){
  const item=resources[name];
  if(!item||typeof item.path!=='string'||item.path.startsWith('/')||item.path.split('/').some(part=>part==='..'||part==='.'||!part)||item.path.includes('\\')||payloads[item.path]?.sha256!==item.sha256||(item.bytes!==undefined&&payloads[item.path]?.bytes!==item.bytes))throw Error('E_SITE_RESOURCE_PAYLOAD: '+name);
 }
 for(const name of ['exporter',...(resources.importer?['importer']:[])]){
  const tool=resources[name];if(!tool||typeof tool.path!=='string'||typeof tool.version!=='string'||!/^4\.6\.1(?:\.|$)/.test(tool.version)||typeof tool.sha256!=='string'||!/^[a-f0-9]{64}$/.test(tool.sha256))throw Error('E_SITE_RESOURCE_TOOL: '+name);
 }

 for(const [name,asset]of Object.entries(release.payloads))if(payloads[name]?.sha256!==asset.sha256||payloads[name]?.bytes!==asset.bytes)throw Error('E_SITE_PAYLOAD: '+name);
 const siteHash=digest(canonical(payloads));
 const descriptorHash=digest(await readFile(path.join(directory,'engine-release.json'))),candidateId=await siteCandidateId(directory,descriptorHash);
 const base={schemaVersion:2,application:'default-playground',profile:release.runtimeProfile,releaseId:release.id,descriptorHash,candidateId,sources,siteHash,payloads};
 const start=path.join(reports,'site-start.json');
 if(begin){const candidate={...base,runId:randomUUID()};await mkdir(reports,{recursive:true});await writeFile(start,JSON.stringify(candidate,null,2)+'\n');return {status:'prepared',profile:candidate.profile,releaseId:candidate.releaseId,candidateId:candidate.candidateId,siteHash:candidate.siteHash,runId:candidate.runId,context:start,files:Object.keys(payloads).length};}
 const prepared=await json(start),candidate={...base,runId:prepared.runId};
 if(typeof candidate.runId!=='string'||!candidate.runId||canonical(prepared)!==canonical(candidate))throw Error('E_SITE_TEST_INPUT_DRIFT');
 const started=(await stat(start)).mtimeMs;
 const evidence={};
 const required=[...REQUIRED_SITE_REPORTS,...(release.runtimeProfile==='engine-2d-v1'?REQUIRED_2D_SITE_REPORTS:[])];
 for(const name of required){
  if((await stat(path.join(reports,name+'.json'))).mtimeMs<started)throw Error('E_SITE_STALE_EVIDENCE: '+name);
  const bytes=await readFile(path.join(reports,name+'.json')),result=JSON.parse(bytes);
  if(result.status!=='passed')throw Error('E_SITE_ACCEPTANCE: '+name);
  for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash','runId'])if(result[key]!==candidate[key])throw Error('E_SITE_EVIDENCE_IDENTITY: '+name+' '+key);
  if(result.testMode!=='real-engine'||!['chromium','firefox','webkit'].includes(result.browser?.name)||typeof result.browser?.version!=='string'||!result.browser.version)throw Error('E_SITE_EVIDENCE_MODE: '+name);
  if(name==='features'||name.startsWith('features.')){
   const expectedBrowser=name==='features'?'chromium':name.slice('features.'.length),sessions=name==='features'?2:1;
   if(result.browser.name!==expectedBrowser)throw Error('E_SITE_EVIDENCE_BROWSER: '+name);
   if(result.suite!=='2d-features'||result.engine?.javascript!==release.engine?.javascript?.sha256||result.engine?.wasm!==(release.engine?.wasm?.decodedSha256??release.engine?.wasm?.sha256))throw Error('E_SITE_FEATURE_ENGINE');
   if(!Array.isArray(result.cases)||result.cases.length<2*sessions||!result.cases.every(item=>['snake','camel'].includes(item.naming)&&item.status==='passed'&&item.result?.status==='passed')||!['snake','camel'].every(naming=>new Set(result.cases.filter(item=>item.naming===naming).map(item=>item.session)).size>=sessions))throw Error('E_SITE_FEATURE_CASES');
   if(result.font?.cjkRequired!==true)throw Error('E_SITE_FEATURE_TEXT: CJK coverage is mandatory');
   for(const item of result.cases){
    if(!REQUIRED_2D_FEATURE_CHECKS.every(check=>item.result.checks?.[check]===true))throw Error('E_SITE_FEATURE_CHECKS');
    if(item.exitCode!==0||!['errors','consoleErrors','nativeErrors','lifecycleWarnings'].every(key=>Array.isArray(item[key])&&item[key].length===0))throw Error('E_SITE_FEATURE_RUNTIME');
    const text=item.result.observations?.text;
    if(text?.cjkCovered!==true||text.text!=='中文'||!Number.isInteger(text.renderedPixels)||text.renderedPixels<=5)throw Error('E_SITE_FEATURE_TEXT');
    if(!Array.isArray(item.audio)||!item.audio.length||!item.audio.every(record=>record.closed===true&&record.state==='closed'&&record.closeCalls===1&&Array.isArray(record.worklets)&&record.worklets.length>=2&&Array.isArray(record.meters)))throw Error('E_SITE_FEATURE_AUDIO');
    const meters=item.audio.flatMap(record=>record.meters);
    if(!meters.some(meter=>Number.isFinite(meter.initialPeak)&&meter.initialPeak>0.001)||!meters.some(meter=>Number.isFinite(meter.restartedPeak)&&meter.restartedPeak>0.001)||!meters.some(meter=>Number.isInteger(meter.quietSamples)&&meter.quietSamples>0)||!meters.every(meter=>Number.isFinite(meter.stoppedPeak)&&meter.stoppedPeak>=0&&meter.stoppedPeak<0.001))throw Error('E_SITE_FEATURE_AUDIO');
    if(!meters.every(meter=>{const observed=assessStoppedAudio(meter.stoppedSamples);return observed.status==='passed'&&['drainMs','quietMs','quietSamples','stoppedPeak'].every(key=>observed[key]===meter[key]);}))throw Error('E_SITE_FEATURE_AUDIO: stopped sample evidence');
   }
  }
  if((name==='runtime'&&result.browser.name!=='chromium')||(name.startsWith('runtime.')&&result.browser.name!==name.slice('runtime.'.length)))throw Error('E_SITE_EVIDENCE_BROWSER: '+name);
  if(name==='runtime'||name.startsWith('runtime.'))assertRuntimeEvidence(result,release);
  evidence[name]={sha256:digest(bytes),bytes:bytes.length};
 }
 const receipt={...candidate,status:'passed',evidence};
 const filename=path.join(reports,'site-acceptance.json');
 if(verify){if(canonical(await json(filename))!==canonical(receipt))throw Error('E_SITE_ACCEPTANCE_DRIFT');}
 else{await mkdir(reports,{recursive:true});await writeFile(filename,JSON.stringify(receipt,null,2)+'\n');}
 return {status:'passed',releaseId:release.id,siteHash:receipt.siteHash,files:Object.keys(payloads).length,receipt:filename};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [directory,reports,...flags]=process.argv.slice(2);
 if(!directory||!reports)throw Error('Usage: seal-site-acceptance.mjs <site> <reports> [--begin|--verify]');
 console.log(JSON.stringify(await sealSiteAcceptance(directory,reports,{verify:flags.includes('--verify'),begin:flags.includes('--begin')}),null,2));
}
