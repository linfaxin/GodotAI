import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm,copyFile,chmod,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {browserEnginePaths,browserEngineVariant,resolvePlaygroundEngine} from '../../../scripts/release/browser-engine-artifacts.mjs';
import {packageBrowserEngineArtifact,inspectBrowserEngineArtifact,publishBrowserEngineArtifact} from '../../../scripts/test/package-browser-engine-artifact.mjs';
import {measureBrowserEngine} from '../../../scripts/test/measure-browser-engine.mjs';
import {digest} from '../../../scripts/release/web-release-utils.mjs';
import {isSourceCertified} from '../../../scripts/release/engine-build-proof.mjs';
import {engineBuildFixture} from './fixtures/engine-build-report.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
async function workspace(t){const root=await mkdtemp(path.join(tmpdir(),'engine-artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('default artifact/build paths isolate both module modes and LTO recipes',()=>{
 const variants=[];
 for(const lto of ['none','thin'])for(const moduleMode of ['baseline','explicit'])variants.push(browserEnginePaths({repository:'/fixture/repository',profile:'engine-2d-v1',target:'template_release',lto,moduleMode}));
 for(const key of ['configurationId','reportPath','templatePath','buildDirectory'])assert.equal(new Set(variants.map(value=>value[key])).size,4,key);
 assert.equal(browserEnginePaths({repository:repo,jobs:2}).configurationId,browserEnginePaths({repository:repo,jobs:8}).configurationId);
 assert.notEqual(browserEnginePaths({repository:repo,lto:'thin',jobs:2}).configurationId,browserEnginePaths({repository:repo,lto:'thin',jobs:8}).configurationId);
 assert.throws(()=>browserEnginePaths({repository:repo,moduleMode:'unknown'}),/E_BROWSER_MODULE_MODE/);
 const environment={...process.env};for(const name of ['GODOT_WEB_BUILD_DIR','ENGINE_BUILD_REPORT','WEB_TEMPLATE_OUT'])delete environment[name];
 const result=spawnSync(process.execPath,['scripts/test/package-browser-engine-artifact.mjs','--paths','--repository','/fixture/repository','--profile','engine-2d-v1','--target','template_release','--lto','thin','--module-mode','explicit'],{cwd:repo,encoding:'utf8',env:environment});
 assert.equal(result.status,0,result.stderr);
 const expected=variants.at(-1);assert.deepEqual(result.stdout.trim().split('\n'),[expected.buildDirectory,expected.artifactDirectory,expected.reportPath,expected.templatePath]);
});

test('the real shell wrapper isolates parallel recipes and preserves current reports after compiler failure',async t=>{
 const root=await workspace(t),repository=path.join(root,'repository'),bin=path.join(root,'bin');
 await mkdir(path.join(repository,'apps/playground/scripts'),{recursive:true});await mkdir(path.join(repository,'scripts/test'),{recursive:true});await mkdir(bin);
 await copyFile(path.join(repo,'apps/playground/scripts/build-web-engine.sh'),path.join(repository,'apps/playground/scripts/build-web-engine.sh'));
 const tool=path.join(repo,'scripts/test/package-browser-engine-artifact.mjs');
 await writeFile(path.join(repository,'scripts/test/package-browser-engine-artifact.mjs'),`import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,[${JSON.stringify(tool)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`);
 const node=path.join(bin,'node');
 await writeFile(node,'#!'+process.execPath+'\n'+`const fs=require('node:fs'),{spawnSync}=require('node:child_process'),args=process.argv.slice(2);if(args[0]==='scripts/test/build-browser-engine.mjs'){fs.writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(args));process.exit(42);}const r=spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1);\n`);await chmod(node,0o755);
 for(const name of ['emcc','scons']){const filename=path.join(bin,name);await writeFile(filename,'#!/bin/sh\nexit 0\n');await chmod(filename,0o755);}
 const outcomes=await Promise.all(['none','thin'].flatMap(lto=>['baseline','explicit'].map(async moduleMode=>{
  const paths=browserEnginePaths({repository,profile:'engine-2d-v1',target:'template_release',lto,moduleMode});await mkdir(path.dirname(paths.reportPath),{recursive:true});await writeFile(paths.reportPath,'last successful report');
  const capture=path.join(root,lto+'-'+moduleMode+'.json'),env={...process.env,PATH:bin+path.delimiter+process.env.PATH,GODOT_SOURCE:'/fixture/unused',SKIP_ENGINE_JS_BUILD:'1',ENGINE_PROFILE:'engine-2d-v1',ENGINE_TARGET:'template_release',ENGINE_LTO:lto,ENGINE_MODULE_MODE:moduleMode,JOBS:'4',CAPTURE_ARGS:capture};
  for(const name of ['ENGINE_BUILD_REPORT','GODOT_WEB_BUILD_DIR','WEB_TEMPLATE_OUT'])delete env[name];
  await assert.rejects(promisify(execFile)('bash',['apps/playground/scripts/build-web-engine.sh'],{cwd:repository,env}),error=>error.code===42);
  const args=JSON.parse(await readFile(capture)),value=flag=>args[args.indexOf(flag)+1];
  assert.equal(value('--build-dir'),paths.buildDirectory);assert.notEqual(value('--out'),paths.reportPath);
  assert.equal(await readFile(paths.reportPath,'utf8'),'last successful report');await assert.rejects(access(paths.reportPath+'.lock'),{code:'ENOENT'});
  return value('--build-dir');
 })));
 assert.equal(new Set(outcomes).size,4);
});

test('portable artifact preserves original proof bytes and remeasures after original tree removal',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'original'));
 const originalBytes=await readFile(source.reportPath),out=path.join(root,'artifact');
 await packageBrowserEngineArtifact({report:source.reportPath,out});
 assert.deepEqual(await readFile(path.join(out,'engine-report.original.json')),originalBytes);
 const moved=path.join(root,'downloaded','artifact');await cp(out,moved,{recursive:true});await rm(out,{recursive:true});await rm(path.dirname(source.reportPath),{recursive:true});
 const checked=await inspectBrowserEngineArtifact(moved);assert.equal(checked.status,'verified');assert.equal(checked.report.template.path,'engine-template.zip');assert.equal(isSourceCertified(checked.report),true);
 const measured=await measureBrowserEngine({report:path.join(moved,'engine-report.json')});assert.equal(measured.sizes.raw.bytes,8);assert.equal(measured.archive.sha256,source.report.template.sha256);
 assert.equal(checked.manifest.sourceReportSha256,digest(originalBytes));
});

test('artifact integrity rejects modified reports, archives and missing compiler logs',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source')),out=path.join(root,'artifact');
 await packageBrowserEngineArtifact({report:source.reportPath,out});
 for(const name of ['engine-template.zip','engine-report.original.json','engine-report.json','build.log']){
  const filename=path.join(out,name),original=await readFile(filename);await writeFile(filename,'changed');
  await assert.rejects(inspectBrowserEngineArtifact(out),/E_ENGINE_ARTIFACT_INTEGRITY/);await writeFile(filename,original);
 }
 await rm(source.reportPath+'.log');await assert.rejects(packageBrowserEngineArtifact({report:source.reportPath,out:path.join(root,'no-log')}),/E_ENGINE_ARTIFACT_LOG/);
});

test('artifact rejects a rehashed portable report that changes source proof beyond the path',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source')),out=path.join(root,'artifact');await packageBrowserEngineArtifact({report:source.reportPath,out});
 const filename=path.join(out,'engine-report.json'),report=JSON.parse(await readFile(filename));report.sourceCertified=false;const bytes=Buffer.from(JSON.stringify(report));await writeFile(filename,bytes);
 const manifest=JSON.parse(await readFile(path.join(out,'artifact.json')));manifest.files['engine-report.json']={sha256:digest(bytes),bytes:bytes.length};await writeFile(path.join(out,'artifact.json'),JSON.stringify(manifest));
 await assert.rejects(inspectBrowserEngineArtifact(out),/E_ENGINE_ARTIFACT_PROVENANCE/);
});

test('publishing keeps old immutable builds and default resolution automatically loads certified evidence',async t=>{
 const root=await workspace(t),repository=path.join(root,'repository');await mkdir(repository);
 const source=await engineBuildFixture(path.join(root,'source'));
 const paths=browserEnginePaths({repository,profile:'engine-2d-v1'});
 const first=await publishBrowserEngineArtifact({report:source.reportPath,publish:paths.reportPath,templateOut:paths.templatePath});
 const before=await readFile(path.join(first.artifact,'engine-report.original.json'));
 assert.deepEqual(await readFile(paths.reportPath),await readFile(path.join(first.artifact,'engine-report.published.json')),'the exact report bound into product candidates remains in the immutable bundle');
 const resolved=await resolvePlaygroundEngine({repository,profile:'engine-2d-v1'});
 assert.equal(resolved.sourceCertified,true);assert.equal(resolved.reportPath,paths.reportPath);assert.equal(resolved.templateHash,source.report.template.sha256);assert.equal(resolved.template,path.join(first.artifact,'engine-template.zip'));
 const next=structuredClone(source.report);next.source={...next.source,dirty:'another recorded build'};await writeFile(source.reportPath,JSON.stringify(next));
 const second=await publishBrowserEngineArtifact({report:source.reportPath,publish:paths.reportPath,templateOut:paths.templatePath});
 assert.notEqual(second.artifact,first.artifact);assert.deepEqual(await readFile(path.join(first.artifact,'engine-report.original.json')),before);assert.equal((await inspectBrowserEngineArtifact(first.artifact)).status,'verified');
 assert.equal((await resolvePlaygroundEngine({repository,profile:'engine-2d-v1'})).report.source.dirty,'another recorded build');
 const rawDirectory=path.join(root,'unproven');await mkdir(rawDirectory);const rawTemplate=path.join(rawDirectory,'raw.zip');await copyFile(source.template,rawTemplate);
 await assert.rejects(resolvePlaygroundEngine({repository,profile:'engine-2d-v1',templatePath:rawTemplate}),/E_PLAYGROUND_SOURCE/);
 const raw=await resolvePlaygroundEngine({repository,profile:'engine-2d-v1',templatePath:rawTemplate,development:true});assert.equal(raw.report,undefined);assert.equal(raw.sourceCertified,false);
});

test('ordinary build resolution fails closed for missing, uncertified, mismatched or modified inputs',async t=>{
 const root=await workspace(t),repository=path.join(root,'repository');await mkdir(repository);
 await assert.rejects(resolvePlaygroundEngine({repository,profile:'engine-2d-v1'}),/E_PLAYGROUND_SOURCE/);
 const source=await engineBuildFixture(path.join(root,'source'));
 const configuration={repository,profile:'engine-2d-v1',reportPath:source.reportPath};
 for(const change of [value=>{value.sourceCertified=false;},value=>{value.source.inputs['fixture.cpp']='wrong';}]){
  const report=structuredClone(source.report);change(report);await writeFile(source.reportPath,JSON.stringify(report));await assert.rejects(resolvePlaygroundEngine(configuration),/E_PLAYGROUND_SOURCE/);
 }
 await writeFile(source.reportPath,JSON.stringify(source.report));
 await assert.rejects(resolvePlaygroundEngine({...configuration,profile:'full-engine-v1'}),/E_PLAYGROUND_ENGINE_REPORT/);
 await assert.rejects(resolvePlaygroundEngine({...configuration,lto:'thin'}),/E_PLAYGROUND_ENGINE_REPORT/);
 await assert.rejects(resolvePlaygroundEngine({...configuration,moduleMode:'explicit'}),/E_PLAYGROUND_ENGINE_REPORT/);
 await assert.rejects(resolvePlaygroundEngine({...configuration,templatePath:'relative.zip'}),/absolute/);
 await writeFile(source.template,'modified');await assert.rejects(resolvePlaygroundEngine(configuration),/template bytes differ/);
});

test('uncertified local templates require development and cannot acquire certification by packaging',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source'));
 await rm(source.reportPath);await rm(source.reportPath+'.log');
 const config={repository:root,profile:'engine-2d-v1',templatePath:source.template};
 await assert.rejects(resolvePlaygroundEngine(config),/E_PLAYGROUND_SOURCE/);
 const result=await resolvePlaygroundEngine({...config,development:true});assert.equal(result.sourceCertified,false);assert.equal(result.report,undefined);
 const report={...source.report,sourceCertified:false};await writeFile(source.reportPath,JSON.stringify(report));await writeFile(source.reportPath+'.log','Synthetic build fixture, not a real compiler log\n');
 await assert.rejects(packageBrowserEngineArtifact({report:source.reportPath,out:path.join(root,'denied')}),/E_ENGINE_ARTIFACT_SOURCE/);
 const packed=await packageBrowserEngineArtifact({report:source.reportPath,out:path.join(root,'development'),development:true});assert.equal(packed.manifest.development,true);assert.equal(packed.report.sourceCertified,false);
});

test('adjacent portable report is auto discovered for an explicit absolute template',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source')),out=path.join(root,'artifact');await packageBrowserEngineArtifact({report:source.reportPath,out});
 const result=await resolvePlaygroundEngine({repository:root,profile:'engine-2d-v1',templatePath:path.join(out,'engine-template.zip')});assert.equal(result.sourceCertified,true);assert.equal(result.reportPath,path.join(out,'engine-report.json'));
 assert.deepEqual(browserEngineVariant(source.report),{lto:'none',moduleMode:'baseline',jobs:4});
});

test('published default reports repackage with their immutable compiler log after the build tree is gone',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source'));
 const paths=browserEnginePaths({repository:path.join(root,'repository'),profile:'engine-2d-v1'});
 const published=await publishBrowserEngineArtifact({report:source.reportPath,publish:paths.reportPath,templateOut:paths.templatePath});
 const input=await readFile(paths.reportPath);
 await rm(path.dirname(source.reportPath),{recursive:true});
 // A stale adjacent log must not hide the matching log in the referenced bundle.
 await writeFile(paths.reportPath+'.log','stale log from another build');
 const out=path.join(root,'repacked');await packageBrowserEngineArtifact({report:paths.reportPath,out});
 assert.deepEqual(await readFile(path.join(out,'engine-report.original.json')),input);
 assert.equal((await inspectBrowserEngineArtifact(out)).status,'verified');
 assert.equal(digest(await readFile(path.join(out,'build.log'))),source.report.logSha256);
 await rm(path.dirname(paths.reportPath),{recursive:true});
 assert.equal((await measureBrowserEngine({report:path.join(out,'engine-report.json')})).sizes.raw.bytes,8);
});

test('publication rejects input/output and immutable-artifact overlap before writing any destination',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source'));
 const inputs=[source.reportPath,source.template,source.reportPath+'.log'],before=await Promise.all(inputs.map(filename=>readFile(filename)));
 const publish=path.join(root,'destination','report.json'),templateOut=path.join(root,'destination','template.zip');
 const artifact=path.join(path.dirname(publish),'releases',digest(before[0]),'portable');
 const alias=path.join(root,'source-alias');await symlink(path.dirname(source.template),alias,'dir');
 for(const overrides of [
  {publish:source.template},{publish:source.reportPath},{publish:source.reportPath+'.log'},
  {templateOut:source.template},{templateOut:source.reportPath},{templateOut:source.reportPath+'.log'},
  {publish:path.join(alias,path.basename(source.template))},{publish:path.dirname(source.template)},
  {publish:templateOut},{templateOut:path.join(artifact,'engine-report.json')},
 ]){
  await assert.rejects(publishBrowserEngineArtifact({report:source.reportPath,publish,templateOut,...overrides}),/E_ENGINE_ARTIFACT_OUTPUT/);
  for(let index=0;index<inputs.length;index++)assert.deepEqual(await readFile(inputs[index]),before[index]);
 }
 await assert.rejects(access(path.dirname(publish)),{code:'ENOENT'});
 await assert.rejects(access(path.join(path.dirname(source.template),'releases')),{code:'ENOENT'});
});

test('explicit and adjacent reports infer the same unset configuration and retain explicit constraints',async t=>{
 const root=await workspace(t);
 for(const target of ['template_debug','template_release'])for(const moduleMode of ['baseline','explicit'])for(const lto of ['none','thin']){
  const name=[target,moduleMode,lto].join('-'),source=await engineBuildFixture(path.join(root,name),{target,moduleMode,lto,jobs:3});
  const out=path.join(root,name+'-portable');await packageBrowserEngineArtifact({report:source.reportPath,out});
  const common={repository:root},adjacent=await resolvePlaygroundEngine({...common,templatePath:path.join(out,'engine-template.zip')}),explicit=await resolvePlaygroundEngine({...common,reportPath:path.join(out,'engine-report.json')});
  assert.deepEqual(adjacent.configuration,{profile:'engine-2d-v1',target,lto,moduleMode,jobs:3});
  assert.deepEqual(adjacent.configuration,explicit.configuration);assert.deepEqual(adjacent.defaults,explicit.defaults);
  assert.equal(adjacent.templateHash,explicit.templateHash);assert.equal(adjacent.reportSha256,explicit.reportSha256);
  for(const change of [{profile:'full-engine-v1'},{target:target==='template_debug'?'template_release':'template_debug'},{lto:lto==='none'?'thin':'none'},{moduleMode:moduleMode==='baseline'?'explicit':'baseline'},...(lto==='thin'?[{jobs:4}]:[])])await assert.rejects(resolvePlaygroundEngine({...common,templatePath:path.join(out,'engine-template.zip'),...change}),/E_PLAYGROUND_ENGINE_REPORT/);
 }
});

test('the product CLI infers adjacent ThinLTO/explicit release evidence before resource export',async t=>{
 const root=await workspace(t),source=await engineBuildFixture(path.join(root,'source'),{target:'template_release',lto:'thin',moduleMode:'explicit'}),out=path.join(root,'portable');await packageBrowserEngineArtifact({report:source.reportPath,out});
 const host=path.join(root,'host');await writeFile(host,'#!/bin/sh\necho REACHED_RESOURCE_EXPORTER >&2\nexit 37\n');await chmod(host,0o755);
 const env={...process.env,GODOT:host,GODOT_IMPORTER:host,GODOT_WEB_TEMPLATE:path.join(out,'engine-template.zip')};
 for(const key of ['ENGINE_BUILD_REPORT','ENGINE_PROFILE','ENGINE_TARGET','ENGINE_LTO','ENGINE_MODULE_MODE','JOBS'])delete env[key];
 const args=['apps/playground/scripts/build.mjs','--out',path.join(root,'site'),'--work-dir',path.join(root,'work'),'--skip-sdk-build'];
 for(const extra of [[],['--engine-report',path.join(out,'engine-report.json')]]){
  const result=spawnSync(process.execPath,[...args,...extra],{cwd:repo,encoding:'utf8',env});assert.equal(result.status,1);assert.match(result.stderr,/REACHED_RESOURCE_EXPORTER/);assert.doesNotMatch(result.stderr,/E_PLAYGROUND_ENGINE_REPORT/);
 }
 const mismatch=spawnSync(process.execPath,[...args,'--lto','none'],{cwd:repo,encoding:'utf8',env});assert.match(mismatch.stderr,/E_PLAYGROUND_ENGINE_REPORT/);assert.doesNotMatch(mismatch.stderr,/REACHED_RESOURCE_EXPORTER/);
 await assert.rejects(access(path.join(root,'site')),{code:'ENOENT'});
});
