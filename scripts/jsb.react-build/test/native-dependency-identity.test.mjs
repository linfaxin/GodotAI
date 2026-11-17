import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {captureNativeDependencies,nativeDependencyManifestHash,nativeToolchainHash,nativeBuildSourceHash} from '../../../scripts/test/native-build-inputs.mjs';
const {discoverNativeReport,assertNativeDependencyCertified,assertSourceCertified}=await import(process.env.GODOTJS_NATIVE_TARGET_TEST_URL??new URL('../dist/native-target.js',import.meta.url).href);
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'native-dependency-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const contents={
  'SCsub':'deps_v8_version = "12.4.254.21"\ndeps_lws_version = "4.3"\n',
  'v8/include/v8.h':'V8 public header',
  'v8/include/v8-version.h':'#define V8_MAJOR_VERSION 12\n#define V8_MINOR_VERSION 4\n#define V8_BUILD_NUMBER 254\n#define V8_PATCH_LEVEL 21\n',
  'v8/linux.x86_64.release/libv8_monolith.a':'selected static V8 library',
  'lws/linux_x86_64_release/include/libwebsockets.h':'LWS public header',
  'lws/linux_x86_64_release/include/lws_config.h':'#define LWS_LIBRARY_VERSION "4.3.5-v4.3.7"',
  'lws/linux_x86_64_release/libwebsockets.a':'selected static LWS library',
 };
 for(const [file,bytes]of Object.entries(contents)){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),bytes);}
 const dependencyManifest=captureNativeDependencies(root,{engine:'v8',platform:'linuxbsd',arch:'x86_64'});
 const tools=Object.fromEntries(Object.entries({cc:'gcc',cxx:'g++',link:'g++',backendLinker:'ld',ar:'ar',scons:'scons',python:'python3'}).map(([role,command])=>[role,{command,executablePath:'/selected/'+command,executableSha256:hash(command),version:command+' fixture version 1'}]));
 const toolchain={schemaVersion:1,kind:'godotjs-native-toolchain',tools,producer:{node:process.version,nodeExecutableSha256:'d'.repeat(64)}};
 const recipe={kind:'test build recipe'},report={schemaVersion:1,status:'built',binarySha256:hash('selected binary'),sourceCommit:'a'.repeat(40),engine:'v8',flags:['platform=linuxbsd','arch=x86_64','target=editor','CC=gcc','CXX=g++','LINK=g++'],
  nativeInputSchemaVersion:3,inputs:{'bridge/runtime.cpp':'b'.repeat(64)},nativeIntegration:{},godotBuildRecipe:recipe,godotBuildRecipeSha256:hash(JSON.stringify(recipe)),dependencyManifest,toolchain};
 const refresh=r=>{r.dependencyManifestSha256=nativeDependencyManifestHash(r.dependencyManifest);r.toolchainSha256=nativeToolchainHash(r.toolchain);r.sourceSnapshotHash=nativeBuildSourceHash(r.inputs,r.nativeIntegration,r.godotBuildRecipeSha256,r);return r;};
 refresh(report);const binary=join(root,'godot'),reportPath=join(root,'react-native-build.json');await writeFile(binary,'selected binary');
 const discover=async r=>{await writeFile(reportPath,JSON.stringify(r));return discoverNativeReport(binary,root);};
 return {report,discover,refresh};
}
test('new source certification binds selected dependency and compiler identities to the target',async t=>{
 const {report,discover}=await fixture(t),value=await discover(report);
 assert.equal(value.target.buildFlags.native_dependency_certification,'complete');
 assert.equal(value.target.buildFlags.native_dependency_manifest_sha256,report.dependencyManifestSha256);
 assert.equal(value.target.buildFlags.native_toolchain_sha256,report.toolchainSha256);
 assert.doesNotThrow(()=>assertNativeDependencyCertified(value.target));
 assert.doesNotThrow(()=>assertSourceCertified({...value.target,godotSchemaHash:'c'.repeat(64)}));
});
test('old reports remain explicitly unattested and cannot satisfy the dependency gate',async t=>{
 const {report,discover}=await fixture(t),legacy=structuredClone(report);
 for(const field of ['nativeInputSchemaVersion','dependencyManifest','dependencyManifestSha256','toolchain','toolchainSha256'])delete legacy[field];
 const value=await discover(legacy);assert.equal(value.target.buildFlags.native_dependency_certification,'legacy-unattested');
 assert.throws(()=>assertNativeDependencyCertified(value.target),error=>error.code==='E_NATIVE_DEPENDENCIES_UNCERTIFIED');
 assert.doesNotThrow(()=>assertSourceCertified({...value.target,godotSchemaHash:'c'.repeat(64)}));
});
test('partial new reports cannot silently downgrade to legacy certification',async t=>{
 const {report,discover}=await fixture(t);
 for(const field of ['nativeInputSchemaVersion','dependencyManifest','dependencyManifestSha256','toolchain','toolchainSha256']){
  const incomplete=structuredClone(report);delete incomplete[field];await assert.rejects(discover(incomplete),error=>error.code==='E_NATIVE_REPORT',field);
 }
 for(const field of ['nativeInputSchemaVersion','dependencyManifest','dependencyManifestSha256','toolchain','toolchainSha256']){
  const partial={...report};for(const candidate of ['nativeInputSchemaVersion','dependencyManifest','dependencyManifestSha256','toolchain','toolchainSha256'])if(candidate!==field)delete partial[candidate];
  await assert.rejects(discover(partial),error=>error.code==='E_NATIVE_REPORT','only '+field);
 }
});
test('changed dependency bytes, changed compiler and unbound source summaries are rejected',async t=>{
 const {report,discover,refresh}=await fixture(t);
 for(const change of [
  r=>{r.dependencyManifest.files['v8/include/v8.h'].sha256='e'.repeat(64);},
  r=>{r.toolchain.tools.cxx.executableSha256='e'.repeat(64);},
  r=>{r.sourceSnapshotHash='f'.repeat(64);},
 ]){const changed=structuredClone(report);change(changed);await assert.rejects(discover(changed),error=>error.code==='E_NATIVE_REPORT');}
 const manifestOnly=structuredClone(report);manifestOnly.dependencyManifest.files['v8/include/v8.h'].sha256='e'.repeat(64);manifestOnly.dependencyManifestSha256=nativeDependencyManifestHash(manifestOnly.dependencyManifest);
 await assert.rejects(discover(manifestOnly),error=>error.code==='E_NATIVE_REPORT');
 for(const change of [
  r=>{delete r.dependencyManifest.files['v8/linux.x86_64.release/libv8_monolith.a'];},
  r=>{delete r.dependencyManifest.files['lws/linux_x86_64_release/include/lws_config.h'];},
  r=>{delete r.toolchain.tools.backendLinker;},
  r=>{r.dependencyManifest.target.arch='arm64';},
  r=>{r.flags=r.flags.map(flag=>flag==='CXX=g++'?'CXX=clang++':flag);},
  r=>{r.engine='qjs';r.dependencyManifest.target.engine='qjs';},
 ]){const changed=structuredClone(report);change(changed);refresh(changed);await assert.rejects(discover(changed),error=>error.code==='E_NATIVE_REPORT');}
});
