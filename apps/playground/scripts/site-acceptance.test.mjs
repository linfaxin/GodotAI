import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,utimes,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {canonical,sha256} from './full-engine-release.mjs';
import {sealSiteAcceptance,REQUIRED_SITE_REPORTS,REQUIRED_2D_SITE_REPORTS,REQUIRED_2D_FEATURE_CHECKS} from './seal-site-acceptance.mjs';
import {runtimeEvidenceFixture} from './fixtures/runtime-evidence.mjs';

for(const profile of ['full-engine-v1','engine-2d-v1'])test(profile+' candidate receipts reject changed bytes, wrong entry, stale or failed evidence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'default-site-acceptance-')),site=path.join(root,'site'),reports=path.join(root,'reports');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(site);await mkdir(reports);
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 for(const [name,source]of [['main.js.map','apps/playground/src/main.ts'],['compiler.worker.js.map','apps/playground/src/compiler.worker.ts'],['preview.js.map','apps/playground/preview.ts']])await writeFile(path.join(site,name),JSON.stringify({version:3,sources:['res://'+source],sourcesContent:[await readFile(path.join(repo,source),'utf8')],mappings:''}));
 const release={schemaVersion:2,runtimeProfile:profile,build:{sourceCertified:true},verifiedRelease:{},engine:{javascript:{sha256:'b'.repeat(64)},wasm:{sha256:'c'.repeat(64)},worklets:[{sha256:'d'.repeat(64)},{sha256:'e'.repeat(64)}]},payloads:{}};
 release.id=sha256(canonical(release));release.verifiedRelease.releaseId=release.id;
 await writeFile(path.join(site,'engine-release.json'),JSON.stringify(release));const resourceBytes=Buffer.from('resource fixture');await writeFile(path.join(site,'resource.bin'),resourceBytes);
 for(const invalidProfile of [undefined,null,'','unknown-engine-v1']){
  await writeFile(path.join(site,'engine-release.json'),JSON.stringify({...release,runtimeProfile:invalidProfile}));
  await assert.rejects(sealSiteAcceptance(site,reports,{begin:true}),/E_SITE_PROFILE/);
 }
 await writeFile(path.join(site,'engine-release.json'),JSON.stringify(release));
 for(const sourceCertified of [undefined,false]){
  await writeFile(path.join(site,'engine-release.json'),JSON.stringify({...release,build:{sourceCertified}}));
  await assert.rejects(sealSiteAcceptance(site,reports,{begin:true}),/E_SITE_UNCERTIFIED_SOURCE/);
 }
 await writeFile(path.join(site,'engine-release.json'),JSON.stringify(release));
 const resourceAsset={path:'resource.bin',bytes:resourceBytes.length,sha256:sha256(resourceBytes)};
 await writeFile(path.join(site,'resource-build.json'),JSON.stringify({runtimeProfile:profile,engineReleaseId:release.id,exporter:{path:'/fixture/godot',version:'4.6.1.stable.fixture',sha256:'a'.repeat(64)},generatedManifest:resourceAsset,output:resourceAsset,demoPack:resourceAsset}));await writeFile(path.join(site,'index.html'),'original');
 await sealSiteAcceptance(site,reports,{begin:true});
 const context=JSON.parse(await readFile(path.join(reports,'site-start.json'),'utf8'));
 const report={status:'passed',...Object.fromEntries(['profile','releaseId','descriptorHash','candidateId','siteHash','runId'].map(key=>[key,context[key]])),testMode:'real-engine',browser:{name:'chromium',version:'test'}};
 const required=[...REQUIRED_SITE_REPORTS,...(profile==='engine-2d-v1'?REQUIRED_2D_SITE_REPORTS:[])];
 const featureCase=(naming,session)=>({naming,session,status:'passed',exitCode:0,errors:[],consoleErrors:[],nativeErrors:[],lifecycleWarnings:[],result:{status:'passed',checks:Object.fromEntries(REQUIRED_2D_FEATURE_CHECKS.map(name=>[name,true])),observations:{text:{cjkCovered:true,text:'中文',renderedPixels:40}}},audio:[{state:'closed',closed:true,closeCalls:1,worklets:['position','audio'],meters:[{initialPeak:0.1,restartedPeak:0.1,stoppedPeak:0,quietSamples:25,quietMs:600,drainMs:0,stoppedSamples:Array.from({length:25},(_,i)=>({ms:i*25,peak:0}))}]}]});
 for(const name of required){
  const feature=name==='features'||name.startsWith('features.');
  const browser=name.includes('.')?name.split('.')[1]:'chromium';
  await writeFile(path.join(reports,name+'.json'),JSON.stringify({...report,...(name==='runtime'||name.startsWith('runtime.')?runtimeEvidenceFixture(browser,release.engine.worklets):{}),...(feature?{suite:'2d-features',engine:{javascript:release.engine.javascript.sha256,wasm:release.engine.wasm.sha256},font:{cjkRequired:true},cases:['snake','camel'].flatMap(naming=>(name==='features'?[1,2]:[1]).map(session=>featureCase(naming,session)))}:{}),browser:{name:browser,version:'test'}}));
 }
 await sealSiteAcceptance(site,reports);await sealSiteAcceptance(site,reports,{verify:true});
 const runtimeFilename=path.join(reports,'runtime.json'),runtimeOriginal=await readFile(runtimeFilename);
 for(const change of [value=>{value.lifecycleLoops=0;value.frames=[];value.audio=[];},value=>{value.errors=['negative test'];},value=>{value.lifecycleLoops=5;}]){
  const value=JSON.parse(runtimeOriginal);change(value);await writeFile(runtimeFilename,JSON.stringify(value));
  await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_RUNTIME_EVIDENCE/);await writeFile(runtimeFilename,runtimeOriginal);
 }
 await writeFile(runtimeFilename,JSON.stringify({...JSON.parse(runtimeOriginal),browser:{name:'firefox',version:'test'}}));
 await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_EVIDENCE_BROWSER: runtime/);await writeFile(runtimeFilename,runtimeOriginal);
 await writeFile(path.join(site,'index.html'),'changed');await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_TEST_INPUT_DRIFT/);await writeFile(path.join(site,'index.html'),'original');
 const main=path.join(site,'main.js.map'),originalMap=await readFile(main);
 await writeFile(main,JSON.stringify({sources:['res://apps/playground/main.ts'],sourcesContent:[await readFile(path.join(repo,'apps/playground/main.ts'),'utf8')]}));
 await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_ENTRY/);await writeFile(main,originalMap);
 for(const name of ['runtime','react-demos','workbench']){
  const report=path.join(reports,name+'.json'),originalReport=await readFile(report);
  await writeFile(report,JSON.stringify({status:'failed',releaseId:release.id}));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_ACCEPTANCE/);await writeFile(report,originalReport);
  await utimes(report,new Date(0),new Date(0));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_STALE_EVIDENCE/);await utimes(report,new Date(),new Date());
 }
 for(const name of ['projects','react-demos','workbench']){
  const file=path.join(reports,name+'.json');
  for(const changed of [{runId:'other-run'},{releaseId:'other-release'},{siteHash:'other-site'}]){await writeFile(file,JSON.stringify({...report,...changed}));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_EVIDENCE_IDENTITY/);}
  await writeFile(file,JSON.stringify({...report,testMode:'shell'}));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_EVIDENCE_MODE/);await writeFile(file,JSON.stringify(report));
 }
 if(profile==='engine-2d-v1'){
  for(const name of ['features','features.firefox','features.webkit']){
   const filename=path.join(reports,name+'.json'),original=await readFile(filename),positive=JSON.parse(original);
   if(name!=='features'){
    await rm(filename);await assert.rejects(sealSiteAcceptance(site,reports),/ENOENT/);await writeFile(filename,original);
   }
   for(const [change,code]of [
    [value=>{value.browser.name=value.browser.name==='chromium'?'firefox':'chromium';},/E_SITE_EVIDENCE_BROWSER/],
    [value=>{value.cases=[];},/E_SITE_FEATURE_CASES/],
    [value=>{value.cases=value.cases.filter(item=>item.naming==='snake');},/E_SITE_FEATURE_CASES/],
    [value=>{value.engine.wasm='d'.repeat(64);},/E_SITE_FEATURE_ENGINE/],
    [value=>{value.cases[0].exitCode=1;},/E_SITE_FEATURE_RUNTIME/],
    [value=>{value.cases[0].consoleErrors=['WebGL: INVALID_OPERATION: glBlitFramebuffer: Read and write color attachments cannot be the same image.'];},/E_SITE_FEATURE_RUNTIME/],
    [value=>{delete value.cases[0].consoleErrors;},/E_SITE_FEATURE_RUNTIME/],
    [value=>{value.cases[0].nativeErrors=['real failure'];},/E_SITE_FEATURE_RUNTIME/],
    [value=>{value.cases[0].lifecycleWarnings=['leaked object'];},/E_SITE_FEATURE_RUNTIME/],
    [value=>{value.font.cjkRequired=false;},/E_SITE_FEATURE_TEXT/],
    [value=>{value.cases[0].result.observations.text.text='中文 2D';},/E_SITE_FEATURE_TEXT/],
    [value=>{value.cases[0].result.observations.text.renderedPixels=0;},/E_SITE_FEATURE_TEXT/],
    [value=>{value.cases[0].audio[0].closeCalls=2;},/E_SITE_FEATURE_AUDIO/],
    [value=>{value.cases[0].audio[0].meters[0].initialPeak=0;},/E_SITE_FEATURE_AUDIO/],
    [value=>{value.cases[0].audio[0].meters[0].restartedPeak=0;},/E_SITE_FEATURE_AUDIO/],
    [value=>{value.cases[0].audio[0].meters[0].quietSamples=0;},/E_SITE_FEATURE_AUDIO/],
    [value=>{value.cases[0].audio[0].meters[0].stoppedPeak=0.1;},/E_SITE_FEATURE_AUDIO/],
    [value=>{value.cases[0].audio[0].meters[0].stoppedSamples=[];},/E_SITE_FEATURE_AUDIO/],
    [value=>{for(const sample of value.cases[0].audio[0].meters[0].stoppedSamples)sample.peak=0.05;},/E_SITE_FEATURE_AUDIO/],
   ]){
    const value=structuredClone(positive);change(value);await writeFile(filename,JSON.stringify(value));
    await assert.rejects(sealSiteAcceptance(site,reports),code,name);await writeFile(filename,original);
   }
   for(const check of REQUIRED_2D_FEATURE_CHECKS){
    const value=structuredClone(positive);value.cases[0].result.checks[check]=false;await writeFile(filename,JSON.stringify(value));
    await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_FEATURE_CHECKS/,check);await writeFile(filename,original);
   }
   if(name==='features'){
    const value=structuredClone(positive);for(const item of value.cases)item.session=1;await writeFile(filename,JSON.stringify(value));
    await assert.rejects(sealSiteAcceptance(site,reports),/E_SITE_FEATURE_CASES/);await writeFile(filename,original);
   }
  }
 }
 await sealSiteAcceptance(site,reports,{verify:true});
});
