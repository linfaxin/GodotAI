import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {WORKER_RUNTIME_ABI,assertWorkerRuntimeAbi} from '../../../scripts/release/engine-profiles.mjs';
import {WORKER_RUNTIME_PATHS,WORKER_RUNTIME_PATCH} from '../../../scripts/release/patch-web-worker-runtime.mjs';
import {digest,canonical} from './site-evidence.mjs';

export const WORKER_CANDIDATE_ASSETS=Object.freeze({host:'preview.js',worker:'runtime.worker.js',audio:'runtime.audio.worklet.js'});
export const WORKER_NATIVE_PATCH_FILES=WORKER_RUNTIME_PATHS;
/** A protocol constant is not proof of a native build. Cross-check the checked
 * patch receipt against both the recipe and the snapshotted compiled sources. */
export function assertWorkerBuildProof(report){
 assertWorkerRuntimeAbi(report?.runtimeAbi);
 const proof=report.workerPatch,hash=/^[a-f0-9]{64}$/;
 if(report.kind!=='godot-js-browser-engine-build'||report.status!=='built'||proof?.patchId!==WORKER_RUNTIME_PATCH||proof.version!==1||proof.implementation?.path!=='scripts/release/patch-web-worker-runtime.mjs'||!hash.test(proof.implementation?.sha256)||digest(canonical(report.recipe))!==report.recipeSha256)throw Error('E_WORKER_BUILD_PROOF');
 const switches=Object.fromEntries((report.recipe.args??[]).filter(value=>typeof value==='string'&&value.includes('=')).map(value=>{const index=value.indexOf('=');return[value.slice(0,index),value.slice(index+1)];}));
 if(switches.platform!=='web'||switches.threads!=='no'||switches.dlink_enabled!=='no'||switches.use_quickjs_ng!=='no')throw Error('E_WORKER_BUILD_PROOF_THREADS: an ordinary threadless Web build is required');
 const files=Object.keys(proof.files??{});
 if(files.length!==WORKER_NATIVE_PATCH_FILES.length||WORKER_NATIVE_PATCH_FILES.some(name=>!files.includes(name)))throw Error('E_WORKER_BUILD_PROOF_FILES');
 for(const name of WORKER_NATIVE_PATCH_FILES){
  const receipt=report.recipe?.patches?.filter(item=>item.patchId===proof.patchId&&item.path===name);
  if(receipt?.length!==1||!hash.test(proof.files[name])||receipt[0].afterSha256!==proof.files[name]||report.godotSource?.inputs?.[name]!==proof.files[name]||canonical(receipt[0].implementation)!==canonical(proof.implementation)||!hash.test(receipt[0].beforeSha256))throw Error('E_WORKER_BUILD_PROOF_FILE: '+name);
 }
 if(digest(canonical(report.godotSource?.inputs))!==report.godotSource?.snapshotHash)throw Error('E_WORKER_BUILD_PROOF_SOURCE');
 return proof;
}
/** Static bytes are hashed before manifest.json exists; no candidate/release
 * identifier is embedded in a bundle after this point. */
export async function describeWorkerCandidate(directory,release){
 assertWorkerRuntimeAbi(release.runtimeAbi);
 const assets={};
 for(const name of Object.values(WORKER_CANDIDATE_ASSETS)){
  const bytes=await readFile(path.join(directory,name));assets[name]={sha256:digest(bytes),bytes:bytes.length};
 }
 return {executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',abi:{...WORKER_RUNTIME_ABI},entry:WORKER_CANDIDATE_ASSETS.worker,audioWorklet:WORKER_CANDIDATE_ASSETS.audio,assets};
}
export function assertWorkerCandidate(manifest,release,payloads){
 if(Object.keys(payloads).some(name=>/^preview\.legacy\./.test(name)))throw Error('E_WORKER_CANDIDATE_RETIRED_ENTRY');
 const runtime=manifest.runtime;assertWorkerRuntimeAbi(release.runtimeAbi);assertWorkerRuntimeAbi(runtime?.abi);
 if(manifest.schemaVersion!==3||runtime.executionBackend!=='worker'||canonical(runtime.presentationBackends)!==canonical(['direct','bitmap'])||runtime.defaultPresentationBackend!=='direct'||runtime.entry!==WORKER_CANDIDATE_ASSETS.worker||runtime.audioWorklet!==WORKER_CANDIDATE_ASSETS.audio)throw Error('E_WORKER_CANDIDATE_RUNTIME');
 for(const [role,name]of Object.entries(WORKER_CANDIDATE_ASSETS)){
  const asset=runtime.assets?.[name];
  if(!asset||!/^[a-f0-9]{64}$/.test(asset.sha256)||asset.sha256!==payloads[name]?.sha256||asset.bytes!==payloads[name]?.bytes||manifest.payloads?.[name]?.sha256!==asset.sha256||manifest.payloads?.[name]?.bytes!==asset.bytes)throw Error('E_WORKER_CANDIDATE_ASSET: '+role);
 }
 return runtime;
}
/** Match canonicalWorkerRunConfiguration in the shared browser protocol. */
export function runConfigurationHash(configuration){
 const {executionBackend,presentationBackend,runtimeProtocolVersion,hostAbiVersion,audioAbiVersion,presentationAbiVersion,budgets}=configuration??{};
 const keys=['executionBackend','presentationBackend','runtimeProtocolVersion','hostAbiVersion','audioAbiVersion','presentationAbiVersion','budgets'];
 if(!configuration||Object.keys(configuration).length!==keys.length||Object.keys(configuration).some(key=>!keys.includes(key)))throw Error('E_WORKER_RUN_CONFIGURATION_FIELDS');
 if(executionBackend!=='worker'||!['direct','bitmap'].includes(presentationBackend)||runtimeProtocolVersion!==WORKER_RUNTIME_ABI.protocolVersion||hostAbiVersion!==WORKER_RUNTIME_ABI.host||audioAbiVersion!==WORKER_RUNTIME_ABI.audio||presentationAbiVersion!==WORKER_RUNTIME_ABI.presentation||!budgets||typeof budgets!=='object'||Array.isArray(budgets))throw Error('E_WORKER_RUN_CONFIGURATION');
 if(Object.keys(budgets).length>32)throw Error('E_WORKER_RUN_CONFIGURATION_BUDGET');
 for(const [name,value]of Object.entries(budgets))if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)||!Number.isSafeInteger(value)||value<0)throw Error('E_WORKER_RUN_CONFIGURATION_BUDGET');
 return digest(JSON.stringify({executionBackend,presentationBackend,runtimeProtocolVersion,hostAbiVersion,audioAbiVersion,presentationAbiVersion,budgets:Object.fromEntries(Object.entries(budgets).sort(([a],[b])=>a<b?-1:a>b?1:0))}));
}
export function workerAcceptancePlan(profile){
 const entries=[];
 for(const presentationBackend of ['direct','bitmap']){
  for(const suite of ['runtime','editor','bridge','projects','demo-regressions','react-demos','workbench','delivery'])entries.push({suite,browser:'chromium',presentationBackend});
  for(const browser of ['firefox','webkit'])entries.push({suite:'runtime',browser,presentationBackend});
  if(profile==='engine-2d-v1')for(const browser of ['chromium','firefox','webkit'])entries.push({suite:'features',browser,presentationBackend});
 }
 return entries.map(entry=>({...entry,name:[entry.suite,'worker',entry.presentationBackend,entry.browser].join('.')}));
}
