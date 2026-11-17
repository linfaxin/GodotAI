import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {captureNativeModuleInputs,nativeBuildSourceHash,NATIVE_PRESET_INPUTS,captureNativeDependencies,nativeDependencyManifestHash,captureNativeToolchain,nativeToolchainHash} from './native-build-inputs.mjs';

test('native source identity binds included domain algorithms, generator recipes and embedded presets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-input-closure-'));
 try{
  const files=['SCsub','jsb_version.h','bridge/operations.cpp','bridge/commands.inc','weaver-editor/templates/SCsub','weaver-editor/templates/Node/node.ts.cs',...NATIVE_PRESET_INPUTS];
  for(const path of files){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'original '+path);}
  const capture=()=>nativeBuildSourceHash(captureNativeModuleInputs(root),{nativeLifecyclePatch:{files:{main:{sha256:'compiled-core',implementation:{sha256:'producer'}}}}},'recipe');
  const original=capture();
  for(const path of ['bridge/commands.inc','jsb_version.h','weaver-editor/templates/SCsub','weaver-editor/templates/Node/node.ts.cs',...NATIVE_PRESET_INPUTS]){
   await writeFile(join(root,path),'changed '+path);assert.notEqual(capture(),original,path+' must change native source identity');
   await writeFile(join(root,path),'original '+path);assert.equal(capture(),original);
  }
  await writeFile(join(root,'bridge/operations.gen.cpp'),'derived output');assert.equal(capture(),original);
  const inputs=captureNativeModuleInputs(root),proof={nativeLifecyclePatch:{files:{main:{sha256:'compiled-core',implementation:{sha256:'producer'}}}}};
  assert.equal(nativeBuildSourceHash(inputs,{...proof,patches:[{changed:true,beforeSha256:'pristine'}]},'recipe'),nativeBuildSourceHash(inputs,{...proof,patches:[{changed:false,beforeSha256:'already patched'}]},'recipe'));
  assert.notEqual(nativeBuildSourceHash(inputs,proof,'recipe'),nativeBuildSourceHash(inputs,{nativeLifecyclePatch:{files:{main:{sha256:'different-core',implementation:{sha256:'producer'}}}}},'recipe'));
 }finally{await rm(root,{recursive:true,force:true});}
});

async function dependencyFixture(root){
 const files={
  'SCsub':'deps_v8_version = "12.4.254.21"\ndeps_lws_version = "4.3"\n',
  'v8/include/v8.h':'#include "nested/detail.h"',
  'v8/include/nested/detail.h':'native v8 header',
  'v8/include/v8-version.h':'#define V8_MAJOR_VERSION 12\n#define V8_MINOR_VERSION 4\n#define V8_BUILD_NUMBER 254\n#define V8_PATCH_LEVEL 21\n',
  'v8/linux.x86_64.release/libv8_monolith.a':'selected v8 library',
  'lws/linux_x86_64_release/include/libwebsockets.h':'#include "lws_config.h"',
  'lws/linux_x86_64_release/include/lws_config.h':'#define LWS_LIBRARY_VERSION "4.3.5-v4.3.7"',
  'lws/linux_x86_64_release/libwebsockets.a':'selected lws library',
 };
 for(const [file,bytes]of Object.entries(files)){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),bytes);}
 return files;
}
test('selected external headers and libraries change the complete build identity independently of module inputs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-external-closure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=await dependencyFixture(root),target={engine:'v8',platform:'linuxbsd',arch:'x86_64'};
 const capture=()=>nativeDependencyManifestHash(captureNativeDependencies(root,target));
 const original=capture(),moduleInputs={'bridge/native.cpp':'a'.repeat(64)};
 const complete=()=>nativeBuildSourceHash(moduleInputs,{},'recipe',{dependencyManifestSha256:capture(),toolchainSha256:'b'.repeat(64)});
 const baseline=complete();
 for(const file of Object.keys(files).filter(file=>file!=='SCsub')){
  await writeFile(join(root,file),files[file]+'\nchanged dependency');
  assert.notEqual(capture(),original,file);assert.notEqual(complete(),baseline,file+' must change v3 identity');
  await writeFile(join(root,file),files[file]);assert.equal(complete(),baseline);
 }
 for(const file of ['v8/windows_x86_64_release/v8_monolith.lib','v8/linux.x86_64.release/unlinked.a','v8/linux.x86_64.release/object.o','lws/unused/debug/object.o']){
  await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),'not compiled');assert.equal(complete(),baseline,file+' is outside the selected target');
 }
 const manifest=captureNativeDependencies(root,target);
 assert.equal(manifest.dependencies.v8.headerVersion,'12.4.254.21');assert.equal(manifest.dependencies.lws.headerVersion,'4.3.5-v4.3.7');
 await rm(join(root,'lws/linux_x86_64_release/libwebsockets.a'));
 assert.throws(()=>captureNativeDependencies(root,target),/Missing dependency/);
});
test('QuickJS does not acquire an unused V8 or LWS dependency, and include symlinks fail closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-qjs-closure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target={engine:'qjs',platform:'linuxbsd',arch:'x86_64'},before=nativeDependencyManifestHash(captureNativeDependencies(root,target));
 await dependencyFixture(root);assert.equal(nativeDependencyManifestHash(captureNativeDependencies(root,target)),before);
 assert.deepEqual(captureNativeDependencies(root,target).dependencies,{});
 await symlink(join(root,'SCsub'),join(root,'v8/include/linked.h'));
 assert.throws(()=>captureNativeDependencies(root,{...target,engine:'v8'}),/symlink/);
});
test('missing version headers and incomplete environment tuples cannot certify a build',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-missing-dependency-'));t.after(()=>rm(root,{recursive:true,force:true}));await dependencyFixture(root);
 await rm(join(root,'v8/include/v8-version.h'));assert.throws(()=>captureNativeDependencies(root,{engine:'v8'}),/Missing dependency/);
 assert.throws(()=>nativeBuildSourceHash({}, {},'recipe',{dependencyManifestSha256:'a'.repeat(64)}),/Incomplete native build environment/);
});
test('selected tool executable bytes and reported versions are both bound',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-toolchain-'));t.after(()=>rm(root,{recursive:true,force:true}));const command=join(root,'test-driver');
 const script=tail=>'#!/bin/sh\nif [ "$1" = "-print-prog-name=ld" ]; then echo "$0"; else echo "test tool version 1"; fi\n'+tail;
 await writeFile(command,script(''));await chmod(command,0o755);
 const commands=Object.fromEntries(['scons','cc','cxx','link','ar','python'].map(role=>[role,command]));
 const original=captureNativeToolchain(commands),before=nativeToolchainHash(original);
 await writeFile(command,script('# changed executable without changing version\n'));
 const after=captureNativeToolchain(commands);assert.equal(after.tools.cxx.version,original.tools.cxx.version);assert.notEqual(nativeToolchainHash(after),before);
 assert.throws(()=>captureNativeToolchain({...commands,cxx:join(root,'missing')}),/Missing toolchain/);
});
