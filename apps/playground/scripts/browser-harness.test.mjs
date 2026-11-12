import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {siteIdentity,digest} from './site-evidence.mjs';
import {withAcceptanceContext} from './browser-harness.mjs';
const browser={browserType:()=>({name:()=> 'chromium'}),version:()=> 'test'};
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
