import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {nativeReleaseFixture,digest} from '../../../packages/engine/test/fixtures/native-release.mjs';
import {readBrowserTestSite,runReportedBrowserTest,browserTestFailureStatus,listenBrowserTestServer,closeBrowserTestServer} from './browser-contract-report.mjs';
import {runEngineContractGroups,REQUIRED_CONTRACT_GROUPS} from './browser-engine-contracts-test.mjs';

const execute=promisify(execFile);
async function temporary(t){const directory=await mkdtemp(path.join(tmpdir(),'godotjs-core-report-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
const candidate={release:{runtimeProfile:'full-engine-v1',id:'a'.repeat(64)},descriptorHash:'b'.repeat(64),candidateId:'c'.repeat(64)};
function passedCase(command){
 return {name:command.name,status:'passed',report:{status:'passed',profile:candidate.release.runtimeProfile,releaseId:candidate.release.id,descriptorHash:candidate.descriptorHash,candidateId:candidate.candidateId,
  engineExecuted:true,sessions:[{runId:'synthetic-unit-run',revision:1,buildKey:'d'.repeat(64),generation:1,documentId:'synthetic-unit-document',workerId:'synthetic-unit-worker',runConfigurationHash:'e'.repeat(64),executionBackend:'worker',presentationBackend:'direct'}]}};
}
async function syntheticSite(directory){
 const {manifest,files}=await nativeReleaseFixture();
 for(const [name,bytes]of files){await mkdir(path.dirname(path.join(directory,name)),{recursive:true});await writeFile(path.join(directory,name),bytes);}
 const descriptor=Buffer.from(JSON.stringify(manifest));await writeFile(path.join(directory,'engine-release.json'),descriptor);
 const site={schemaVersion:3,runtimeProfile:manifest.runtimeProfile,engineReleaseId:manifest.id,payloads:{...manifest.payloads,'engine-release.json':{sha256:digest(descriptor),bytes:descriptor.length}}};
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify(site));return {manifest,site};
}

test('preflight distinguishes missing prerequisites from supplied corrupt JSON, descriptor and payload bytes',async t=>{
 const directory=await temporary(t);
 await assert.rejects(readBrowserTestSite(directory),error=>browserTestFailureStatus(error,'preflight')==='blocked');
 await writeFile(path.join(directory,'manifest.json'),'{');
 await assert.rejects(readBrowserTestSite(directory),error=>browserTestFailureStatus(error,'preflight')==='failed');
 await syntheticSite(directory);
 const value=await readBrowserTestSite(directory);assert.equal(value.release.runtimeProfile,'engine-2d-v1');
 await writeFile(path.join(directory,'engine/game.js'),'tampered bytes');
 await assert.rejects(readBrowserTestSite(directory),/E_TEST_SITE_PAYLOAD/);
 await syntheticSite(directory);await writeFile(path.join(directory,'engine-release.json'),'{}');
 await assert.rejects(readBrowserTestSite(directory),/E_TEST_SITE_RELEASE/);
});

test('failed steps block dependants while independent work continues and the first error survives reporting failure',async t=>{
 const directory=await temporary(t),order=[];let server;
 const report=await runReportedBrowserTest({scope:'unit-report-lifecycle',reportFile:directory,print:false,setExitCode:false,run:async suite=>{
  server=createServer();suite.defer(()=>{order.push('closed');return closeBrowserTestServer(server);});await listenBrowserTestServer(server);
  suite.defer(()=>{order.push('cleanup-error');throw Error('secondary cleanup failure');});
  await suite.step('first',()=>{throw Error('original contract failure');});
  await suite.step('dependent',()=>assert.fail('blocked body must not execute'),{after:['first']});
  await suite.step('independent',()=>{order.push('independent');});
  return {status:'passed'};
 }});
 assert.deepEqual(order,['independent','cleanup-error','closed']);assert.equal(server.listening,false);
 assert.equal(report.status,'failed');assert.match(report.error.message,/original contract failure/);
 assert.equal(report.steps[1].blockedBy,'first');assert.equal(report.steps[2].status,'passed');
 assert.equal(report.cleanupErrors.length,1);assert.equal(report.reportError.code,'EISDIR');
});

test('required group failure does not skip independent processes and required blocking never passes',async t=>{
 const directory=await temporary(t),called=[];
 const preflight=async()=>candidate;
 const report=await runEngineContractGroups({directory,reportFile:path.join(directory,'aggregate.json'),preflight,print:false,setExitCode:false,
  runCommand:async command=>{called.push(command.name);return command.env?.PLAYGROUND_CONTRACT_GROUP==='failure-recovery'?{name:command.name,status:'failed',report:{status:'failed',error:'original child failure'}}:passedCase(command);}});
 assert.equal(report.status,'failed');assert.equal(report.groups.find(group=>group.name==='replacement').status,'passed');
 assert.deepEqual(called,['runtime-host','runtime-host','isolated-consumer','react-entry','schema4-entry','native-resources']);
 const blocked=await runEngineContractGroups({directory,reportFile:path.join(directory,'blocked.json'),print:false,setExitCode:false,
  preflight:async()=>{throw Object.assign(Error('missing candidate'),{code:'ENOENT'});},runCommand:()=>assert.fail('blocked groups must not launch')});
 assert.equal(blocked.status,'blocked');assert.deepEqual(blocked.requiredGroups,[...REQUIRED_CONTRACT_GROUPS]);
 assert(blocked.groups.slice(1).every(group=>group.status==='blocked'&&group.blockedBy==='preflight'));
 assert.equal(blocked.engineExecuted,false);
});

test('aggregation accepts matching real-run evidence and preserves required child blocking',async t=>{
 const directory=await temporary(t),options={directory,preflight:async()=>candidate,print:false,setExitCode:false};
 const passed=await runEngineContractGroups({...options,reportFile:path.join(directory,'passed.json'),runCommand:async command=>passedCase(command)});
 assert.equal(passed.status,'passed');assert.equal(passed.engineExecuted,true);
 assert(passed.groups.every(group=>group.status==='passed'));
 const blocked=await runEngineContractGroups({...options,reportFile:path.join(directory,'blocked-child.json'),runCommand:async command=>command.name==='isolated-consumer'?{name:command.name,status:'blocked',report:{status:'blocked',reason:'browser unavailable'}}:passedCase(command)});
 assert.equal(blocked.status,'blocked');assert.equal(blocked.groups.find(group=>group.name==='replacement').status,'blocked');
 assert.equal(blocked.groups.find(group=>group.name==='entry-resources').status,'passed');
});

for(const field of ['profile','releaseId','descriptorHash','candidateId'])test(`aggregation rejects a passed child with mismatched ${field} and continues independent groups`,async t=>{
 const directory=await temporary(t),called=[];
 const report=await runEngineContractGroups({directory,reportFile:path.join(directory,'aggregate.json'),preflight:async()=>candidate,print:false,setExitCode:false,
  runCommand:async command=>{called.push(command.name);const result=passedCase(command);if(command.env?.PLAYGROUND_CONTRACT_GROUP==='lifecycle')result.report[field]='another-candidate';return result;}});
 assert.equal(report.status,'failed');const failed=report.groups.find(group=>group.name==='lifecycle').cases[0];
 assert.equal(failed.error.code,'E_TEST_CONTRACT_IDENTITY');assert.match(failed.reason,new RegExp(field));
 assert.equal(report.groups.find(group=>group.name==='replacement').status,'passed');assert.equal(called.length,6);
});

for(const [name,change]of [
 ['missing report',result=>{delete result.report;}],
 ['inconsistent report status',result=>{result.report.status='blocked';}],
 ['false execution flag',result=>{result.report.engineExecuted=false;}],
 ['missing execution flag',result=>{delete result.report.engineExecuted;}],
 ['missing sessions',result=>{delete result.report.sessions;}],
 ['empty sessions',result=>{result.report.sessions=[];}],
 ['incomplete Worker identity',result=>{delete result.report.sessions[0].workerId;}],
 ['wrong execution backend',result=>{result.report.sessions[0].executionBackend='legacy';}],
 ['wrong presenter',result=>{result.report.sessions[0].presentationBackend='bitmap';}],
])test(`aggregation cannot pass required cases with ${name}`,async t=>{
 const directory=await temporary(t);
 const report=await runEngineContractGroups({directory,reportFile:path.join(directory,'aggregate.json'),preflight:async()=>candidate,print:false,setExitCode:false,
  runCommand:async command=>{const result=passedCase(command);change(result);return result;}});
 assert.equal(report.status,'failed');assert(report.groups.slice(1).every(group=>group.status==='failed'));
 const failed=report.groups[1].cases[0];assert.match(failed.error.code,/E_TEST_CONTRACT_(REPORT|EXECUTION)/);
});

test('all real script entry points emit blocked JSON and nonzero without a matching site',async t=>{
 const directory=await temporary(t),missing=path.join(directory,'missing');
 const scripts=[['browser-runtime-host-test.mjs','PLAYGROUND_RUNTIME_HOST_REPORT'],['browser-schema4-flow-test.mjs','PLAYGROUND_SCHEMA4_REPORT'],['browser-resource-converters-test.mjs','PLAYGROUND_RESOURCE_REPORT'],['browser-engine-contracts-consumer-test.mjs','PLAYGROUND_CONSUMER_REPORT'],['browser-engine-contracts-test.mjs','PLAYGROUND_ENGINE_CONTRACT_REPORT']];
 for(const [script,variable]of scripts){
  const output=path.join(directory,script+'.json');
  await assert.rejects(execute(process.execPath,[fileURLToPath(new URL(script,import.meta.url))],{env:{...process.env,PLAYGROUND_TEST_DIRECTORY:missing,[variable]:output},timeout:15000,maxBuffer:1024*1024}),error=>error.code===1);
  const report=JSON.parse(await readFile(output,'utf8'));assert.equal(report.status,'blocked',script);
  assert(!report.runId&&!report.nativeExit&&!report.sessions?.length,script+' must not invent a run');
 }
});
