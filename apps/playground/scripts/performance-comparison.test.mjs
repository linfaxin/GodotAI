import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performanceSiteFixture} from './fixtures/performance-site.mjs';
import {performanceComparisonInputs,assertPerformanceComparable,siteIdentity,canonical,digest} from './site-evidence.mjs';

test('material comparison retains distinct provenance and ignores only non-executable documentation/commit metadata',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'performance-material-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=await performanceSiteFixture(path.join(root,'old')),current=path.join(root,'current');await cp(original.directory,current,{recursive:true});
 const before=await performanceComparisonInputs(original.directory,{demos:['scene']}),oldIdentity=await siteIdentity(original.directory);
 const release=structuredClone(original.release);release.id=digest('new release with the same bytes');release.build.commit='new-commit';release.build.engineReportSha256=digest('new provenance report');
 const save=async(name,value)=>writeFile(path.join(current,name),JSON.stringify(value));
 await save('engine-release.json',release);await save('manifest.json',{...original.site,engineReleaseId:release.id});
 const filename='examples/scene.project.json',project=JSON.parse(await readFile(path.join(current,filename)));project.files['/README.md']='Worker documentation';await save(filename,project);
 const actualIdentity=await siteIdentity(current),after=await performanceComparisonInputs(current,{demos:['scene']});
 for(const key of ['releaseId','descriptorHash','candidateId','siteHash'])assert.notEqual(actualIdentity[key],oldIdentity[key],key+' must retain its real provenance');
 assertPerformanceComparable(before,after);
 // A changed Native payload cannot pass by copying the old material record.
 await writeFile(path.join(current,'engine/game.js'),'different Native JavaScript');
 await assert.rejects(performanceComparisonInputs(current,{demos:['scene']}),/E_PERFORMANCE_MATERIAL: bytes engine.javascript/);
});

test('material comparison rejects changes to the SDK, Native/API bytes, resources, scenario configuration and executable files',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'performance-material-drift-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const f=await performanceSiteFixture(root),baseline=await performanceComparisonInputs(root,{demos:['scene']});
 const mutations=[
  value=>{value.sdk.sourceSnapshotHash=digest('different SDK source');},
  value=>{value.sdk.outputSnapshotHash=digest('different SDK output');},
  value=>{value.inputs['sdk.module.react'].sha256=digest('different runtime module');},
  value=>{value.sdk.moduleExports.react='OtherReact';},
  value=>{value.inputs['engine.wasm'].sha256=digest('different Native');},
  value=>{value.inputs['api.camel.types'].sha256=digest('different API');},
  value=>{value.inputs['resources.enginePack'].sha256=digest('different resources');},
  value=>{value.workloads.scene=digest('different executable workload');},
  value=>{value.target='template_release';},
 ];
 for(const change of mutations){const value=structuredClone(baseline);change(value);const {sha256,...material}=value;value.sha256=digest(canonical(material));assert.throws(()=>assertPerformanceComparable(value,baseline),/E_PERFORMANCE_BASELINE_MATERIAL/);}
 assert.throws(()=>assertPerformanceComparable(undefined,baseline),/E_PERFORMANCE_BASELINE_MATERIAL/);
 const project=JSON.parse(await readFile(path.join(root,'examples/scene.project.json')));project.files['/src/App.tsx']+='\nthrow Error("drift");';await f.save('examples/scene.project.json',project);
 const changed=await performanceComparisonInputs(root,{demos:['scene']});assert.throws(()=>assertPerformanceComparable(changed,baseline),/E_PERFORMANCE_BASELINE_MATERIAL/);
});
