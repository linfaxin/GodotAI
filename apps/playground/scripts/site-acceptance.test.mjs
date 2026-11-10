import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,utimes,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {canonical,sha256} from './full-engine-release.mjs';
import {sealSiteAcceptance} from './seal-site-acceptance.mjs';

test('default candidate receipts reject changed bytes, wrong entry, stale or failed evidence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'default-site-acceptance-')),site=path.join(root,'site'),reports=path.join(root,'reports');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(site);await mkdir(reports);
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 for(const [name,source]of [['main.js.map','apps/playground/src/main.ts'],['compiler.worker.js.map','apps/playground/src/compiler.worker.ts'],['preview.js.map','apps/playground/preview.ts']])await writeFile(path.join(site,name),JSON.stringify({version:3,sources:['res://'+source],sourcesContent:[await readFile(path.join(repo,source),'utf8')],mappings:''}));
 const release={schemaVersion:2,runtimeProfile:'full-engine-v1',verifiedRelease:{},payloads:{}};
 release.id=sha256(canonical(release));release.verifiedRelease.releaseId=release.id;
 await writeFile(path.join(site,'engine-release.json'),JSON.stringify(release));await writeFile(path.join(site,'index.html'),'original');
 await sealSiteAcceptance(site,reports,{begin:true});
 for(const name of ['runtime','editor','bridge','projects','legacy','usability','refinements'])await writeFile(path.join(reports,name+'.json'),JSON.stringify({status:'passed',releaseId:release.id}));
 await sealSiteAcceptance(site,reports);await sealSiteAcceptance(site,reports,{verify:true});
 await writeFile(path.join(site,'index.html'),'changed');await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_TEST_INPUT_DRIFT/);await writeFile(path.join(site,'index.html'),'original');
 const main=path.join(site,'main.js.map'),originalMap=await readFile(main);
 await writeFile(main,JSON.stringify({sources:['res://apps/playground/main.ts'],sourcesContent:[await readFile(path.join(repo,'apps/playground/main.ts'),'utf8')]}));
 await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_ENTRY/);await writeFile(main,originalMap);
 for(const name of ['runtime','usability','refinements']){
  const report=path.join(reports,name+'.json'),originalReport=await readFile(report);
  await writeFile(report,JSON.stringify({status:'failed',releaseId:release.id}));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_ACCEPTANCE/);await writeFile(report,originalReport);
  await utimes(report,new Date(0),new Date(0));await assert.rejects(sealSiteAcceptance(site,reports,{verify:true}),/E_SITE_STALE_EVIDENCE/);await utimes(report,new Date(),new Date());
 }
 await sealSiteAcceptance(site,reports,{verify:true});
});
