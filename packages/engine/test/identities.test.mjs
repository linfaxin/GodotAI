import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeReleaseIdentity,assertNativeTypeSnapshot,assertSiteDescriptorIdentity,nativeExtensionIdentityInputs,createExtensionIdentity,assertArtifactReceipt,createArtifactIdentity} from '../dist/identities.js';
import {nativeReleaseFixture,digest,sealRelease} from './fixtures/native-release.mjs';

test('native release validates complete descriptor, extension, runtime module and payload identities',async()=>{
 const {manifest}=await nativeReleaseFixture();await assertNativeReleaseIdentity(manifest);
 const changed=structuredClone(manifest);changed.sdk.vendor={...changed.sdk.vendor,sha256:digest('other vendor')};changed.sdk.vendors.production=changed.sdk.vendor;
 await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_RELEASE/);
 sealRelease(changed);await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_EXTENSION/);
 changed.extensionId=await createExtensionIdentity(nativeExtensionIdentityInputs(changed));sealRelease(changed);
 await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_ASSET/);
 const wrapper=structuredClone(manifest);wrapper.sdk.runtimeModules['@godot-js/react'].sha256=digest('other wrapper');sealRelease(wrapper);
 await assert.rejects(assertNativeReleaseIdentity(wrapper),/E_IDENTITY_EXTENSION/);
 const label=structuredClone(manifest);label.verifiedRelease.releaseId=digest('wrong label');await assert.rejects(assertNativeReleaseIdentity(label),/E_IDENTITY_RELEASE/);
});
test('SDK identity v2 cannot omit types, executable modules or their exported declaration contract',async()=>{
 const {manifest}=await nativeReleaseFixture();
 for(const change of [value=>{delete value.sdk.typesHash;},value=>{value.sdk.runtimeModules={};},value=>{delete value.sdk.moduleContract;},value=>{value.sdk.moduleContract['@godot-js/react'].exportName='different';},value=>{value.sdk.vendors.production={...value.sdk.vendor,sha256:digest('different mode')};}]){
  const changed=structuredClone(manifest);change(changed);sealRelease(changed);await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_EXTENSION/);
 }
 const removed=structuredClone(manifest);delete removed.engineId;delete removed.extensionId;sealRelease(removed);await assert.rejects(assertNativeReleaseIdentity(removed),/Incomplete engine\/extension/);
});
test('legacy schema 2 still requires a valid complete ID, while missing modern identity fields stays readable',async()=>{
 const {manifest}=await nativeReleaseFixture({legacy:true});await assertNativeReleaseIdentity(manifest);
 const changed=structuredClone(manifest);changed.sdk.version='different';await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_RELEASE/);
 manifest.id='engine-r1';await assert.rejects(assertNativeReleaseIdentity(manifest),/E_IDENTITY_RELEASE/);
});
test('partial or empty SDK/API asset references cannot skip the payload closure',async()=>{
 const {manifest}=await nativeReleaseFixture({legacy:true});
 for(const field of ['path','sha256','bytes']){
  const changed=structuredClone(manifest);changed.sdk.vendor={...changed.sdk.vendor};delete changed.sdk.vendor[field];sealRelease(changed);
  await assert.rejects(assertNativeReleaseIdentity(changed),/E_IDENTITY_ASSET/);
  const types=structuredClone(manifest);types.api.typeSnapshot={...types.api.typeSnapshot};delete types.api.typeSnapshot[field];sealRelease(types);
  await assert.rejects(assertNativeReleaseIdentity(types),/E_IDENTITY_ASSET/);
 }
 const empty=structuredClone(manifest);empty.sdk.runtimeModules['@godot-js/react']={};sealRelease(empty);await assert.rejects(assertNativeReleaseIdentity(empty),/E_IDENTITY_ASSET/);
 const declaration=structuredClone(manifest);declaration.api.declarations['/godot/index.d.ts']={};sealRelease(declaration);await assert.rejects(assertNativeReleaseIdentity(declaration),/E_IDENTITY_ASSET/);
});
test('actual merged declarations preserve separate native and optional SDK identities',async()=>{
 const {manifest,types}=await nativeReleaseFixture();await assertNativeTypeSnapshot(manifest,types);
 await assert.rejects(assertNativeTypeSnapshot(manifest,{...types,'/godot/index.d.ts':'changed native types'}),/Native declarations/);
 await assert.rejects(assertNativeTypeSnapshot(manifest,{...types,'/engine-sdk/engine.d.ts':'changed SDK types'}),/SDK declarations/);
});
test('a site seal cannot omit or replace the referenced native descriptor',()=>{
 const reference={sha256:digest('descriptor'),bytes:10};assertSiteDescriptorIdentity({payloads:{'engine-release.json':reference}},reference,{required:true});
 assert.throws(()=>assertSiteDescriptorIdentity({payloads:{}},reference,{required:true}),/E_SITE_DESCRIPTOR_HASH/);
 assert.throws(()=>assertSiteDescriptorIdentity({payloads:{'engine-release.json':{...reference,sha256:digest('changed')}}},reference),/E_SITE_DESCRIPTOR_HASH/);
 assertSiteDescriptorIdentity({},reference);
});
test('artifact receipt binds actual pack bytes and every outer field; legacy admission is explicit',async()=>{
 const pack=new Uint8Array([1,2,3]),body={schemaVersion:2,buildKey:digest('build'),sourceHash:digest('source'),packSha256:digest(pack),outputs:[{path:'res://main.js',disposition:'generated',reason:'compile',outputHash:digest('main')}]};
 const receipt={...body,artifactId:await createArtifactIdentity(body)};
 await assertArtifactReceipt(receipt,{pack,buildKey:body.buildKey,artifactId:receipt.artifactId});
 for(const changed of [{...receipt,packSha256:digest('other pack')},{...receipt,outputs:[{...body.outputs[0],outputHash:digest('other output')}]},{...receipt,sourceHash:digest('other source')}])await assert.rejects(assertArtifactReceipt(changed,{pack}),/E_ARTIFACT_IDENTITY/);
 await assert.rejects(assertArtifactReceipt(receipt,{pack:new Uint8Array([4])}),/E_ARTIFACT_PACK_HASH/);
 await assert.rejects(assertArtifactReceipt(receipt,{buildKey:digest('different')}),/E_ARTIFACT_BUILD_KEY/);
 const legacy={...body,schemaVersion:1};await assert.rejects(assertArtifactReceipt(legacy,{pack}),/E_ARTIFACT_RECEIPT/);
 await assertArtifactReceipt(legacy,{pack,allowLegacy:true});assert.equal(await assertArtifactReceipt(undefined,{allowLegacy:true}),undefined);
 await assert.rejects(assertArtifactReceipt(undefined),/E_ARTIFACT_RECEIPT/);
});
