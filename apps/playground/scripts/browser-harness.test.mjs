import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {siteIdentity,digest} from './site-evidence.mjs';
import {withAcceptanceContext,defaultTestDirectory,browserEnvironmentEvidence,browserLaunchArgumentEvidence} from './browser-harness.mjs';
const browser={browserType:()=>({name:()=> 'chromium'}),version:()=> 'test'};
test('native and Worker aliases share ordinary output while shell fixtures stay separate',()=>{
 const previous=process.env.PLAYGROUND_TEST_DIRECTORY;delete process.env.PLAYGROUND_TEST_DIRECTORY;
 try{
  assert(defaultTestDirectory({shellOnly:false}).endsWith(path.join('apps','playground','dist')));
  assert(defaultTestDirectory({shellOnly:false,worker:true}).endsWith(path.join('apps','playground','dist')));
  assert(defaultTestDirectory({shellOnly:true}).endsWith(path.join('apps','playground','dist-shell')));
  process.env.PLAYGROUND_TEST_DIRECTORY='/explicit/candidate';assert.equal(defaultTestDirectory({shellOnly:false}),path.resolve('/explicit/candidate'));
 }finally{if(previous===undefined)delete process.env.PLAYGROUND_TEST_DIRECTORY;else process.env.PLAYGROUND_TEST_DIRECTORY=previous;}
});
test('software drivers and native hooks cannot certify default browser settings; display/audio routing stays explicit metadata',()=>{
 const displayOnly=browserEnvironmentEvidence({DISPLAY:':90',PLAYGROUND_VIRTUAL_DISPLAY:'1',PLAYGROUND_AUDIO_DEVICE_KIND:'pulse-null-sink',PULSE_SERVER:'unix:/private/audio/socket'});
 assert.equal(displayOnly.settingsTier,'default');assert.equal(displayOnly.environment.display,':90');assert.equal(displayOnly.environment.virtualDisplay,true);assert.equal(displayOnly.environment.audioDeviceKind,'pulse-null-sink');assert.equal(displayOnly.environment.pulseServerConfigured,true);assert(!JSON.stringify(displayOnly).includes('/private/audio/socket'));
 for(const overrides of [{LIBGL_ALWAYS_SOFTWARE:'1'},{MESA_LOADER_DRIVER_OVERRIDE:'llvmpipe'},{WEBKIT_DISABLE_DMABUF_RENDERER:'1'},{LD_PRELOAD:'/private/native-hook.so'},{PLAYGROUND_BROWSER_SETTINGS_TIER:'environment-override'}])assert.equal(browserEnvironmentEvidence(overrides).settingsTier,'environment-override');
 const hook=browserEnvironmentEvidence({LD_PRELOAD:'/private/native-hook.so',UNRELATED_SECRET:'never-record-me'});assert.equal(hook.envOverrides.LD_PRELOAD,true);assert(!JSON.stringify(hook).includes('native-hook.so'));assert(!JSON.stringify(hook).includes('never-record-me'));
});
test('default browser settings remove autoplay bypass while preserving requested, effective and container argument evidence',()=>{
 const args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage'];
 const defaults=browserLaunchArgumentEvidence(args,{defaultSettings:true});
 assert.deepEqual(defaults.requestedLaunchArgs,args);assert.notEqual(defaults.requestedLaunchArgs,args);assert.deepEqual(defaults.launchArgs,['--no-sandbox','--disable-dev-shm-usage']);assert.deepEqual(defaults.containerArgs,defaults.launchArgs);assert.deepEqual(defaults.featureLaunchArgs,[]);assert.deepEqual(defaults.removedLaunchArgs,['--autoplay-policy=no-user-gesture-required']);assert.equal(defaults.settingsTier,'default');
 const explicit=browserLaunchArgumentEvidence(args,{defaultSettings:false});
 assert.deepEqual(explicit.launchArgs,args);assert.deepEqual(explicit.requestedLaunchArgs,args);assert.deepEqual(explicit.featureLaunchArgs,['--autoplay-policy=no-user-gesture-required']);assert.equal(explicit.settingsTier,'environment-override');
 assert.deepEqual(args,['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage']);
});
test('shell reports have no invented engine identity and cannot enter product acceptance',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'shell-evidence-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(path.join(directory,'shell-profile.json'),JSON.stringify({runtimeProfile:'engine-2d-v1',shellOnly:true}));
 const report=await withAcceptanceContext({status:'passed'},{directory,browser,testMode:'shell',contextFile:undefined});
 assert.equal(report.releaseId,null);assert.equal(report.descriptorHash,null);assert.equal(report.profile,'engine-2d-v1');assert.equal(report.testMode,'shell');
 await assert.rejects(withAcceptanceContext({status:'passed'},{directory,browser,testMode:'shell',contextFile:'product-context.json'}),/E_TEST_SHELL_PRODUCT_CONTEXT/);
});
test('candidate identity follows the manifest and reports cannot borrow another run or version',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'candidate-evidence-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(path.join(directory,'engine-release.json'),JSON.stringify({id:'engine-v1',runtimeProfile:'engine-2d-v1'}));
 const embeddedCandidateId='f'.repeat(64);
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify({engineReleaseId:'engine-v1',candidateId:embeddedCandidateId,payloads:{}}));
 const identity=await siteIdentity(directory);assert.equal(identity.candidateId,digest(await readFile(path.join(directory,'manifest.json'))));
 assert.notEqual(identity.candidateId,embeddedCandidateId,'An embedded field cannot replace the identity of the complete manifest bytes');
 const contextFile=path.join(tmpdir(),'candidate-context-'+crypto.randomUUID()+'.json');t.after(()=>rm(contextFile,{force:true}));
 await writeFile(contextFile,JSON.stringify({...identity,runId:'acceptance-run'}));
 const report=await withAcceptanceContext({status:'passed',releaseId:'engine-v1'},{directory,browser,contextFile});assert.equal(report.runId,'acceptance-run');assert.equal(report.candidateId,identity.candidateId);
 await assert.rejects(withAcceptanceContext({status:'passed',releaseId:'engine-v2'},{directory,browser,contextFile}),/E_TEST_RELEASE_ID/);
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify({engineReleaseId:'engine-v1',payloads:{},changed:true}));
 await assert.rejects(withAcceptanceContext({status:'passed'},{directory,browser,contextFile}),/E_TEST_CANDIDATE_DRIFT/);
});
