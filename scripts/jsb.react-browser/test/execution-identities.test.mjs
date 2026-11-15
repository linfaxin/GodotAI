import test from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../dist/identities.js';
import * as producer from '../../release/release-identities.mjs';
import {validateExecution} from '../dist/execution.js';
import {loadRuntimeRelease} from '../dist/release.js';
import {createHash} from 'node:crypto';

test('browser and release producer calculate identical independent identities',async()=>{
 const inputs={assets:[{path:'godot.js',sha256:'a'.repeat(64)}],abi:{binding:1,host:1},unicode:'中文'};
 for(const name of ['createEngineIdentity','createExtensionIdentity','createBuildKey'])assert.equal(await browser[name](inputs),producer[name](inputs));
 const final={buildKey:producer.createBuildKey(inputs),packSha256:'b'.repeat(64),outputs:[{path:'main.js',hash:'c'.repeat(64)}]};
 assert.equal(await browser.createArtifactIdentity(final),producer.createArtifactIdentity(final));
 assert.throws(()=>browser.createBuildKey({packSha256:'b'.repeat(64)}),/SELF_REFERENCE/);
 assert.throws(()=>browser.createEngineIdentity({...inputs,react:'19'}),/SELF_REFERENCE/);
});
test('pure execution reader requires actual worker code closure and coherent thread metadata',()=>{
 const value={schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded'};
 assert.doesNotThrow(()=>validateExecution(value));
 assert.throws(()=>validateExecution({...value,wasmThreads:false}),/Inconsistent thread model/);
 assert.throws(()=>validateExecution({...value,requiresCrossOriginIsolation:false}),/Inconsistent thread model/);
 assert.throws(()=>validateExecution({...value,workerBootstrap:'separate'}),/Missing worker asset/);
});
test('browser/native identity readers bind actual host assets and keep old host-free descriptors compatible',async()=>{
 const manifest={execution:{schemaVersion:1,executionModel:'window',wasmThreads:false,proxyToPthread:false,requiresCrossOriginIsolation:false,hostProtocolVersion:1},engine:{javascript:{path:'engine.js',sha256:'a'.repeat(64)},wasm:{path:'engine.wasm',sha256:'b'.repeat(64)},worklets:[]},modules:['GodotJS'],api:{bindingVersion:'1',namingVersion:'1',codegenVersion:'1',namingProfiles:{snake:{actualAPIHash:'c'.repeat(64),declarationsHash:'d'.repeat(64)}}}};
 manifest.engineId=producer.createEngineIdentity(producer.nativeEngineIdentityInputs(manifest));await browser.assertNativeEngineIdentity(manifest);
 const oldId=manifest.engineId;manifest.engine.host={path:'preview.js',sha256:'e'.repeat(64),bytes:23};
 await assert.rejects(browser.assertNativeEngineIdentity(manifest),/differs from sealed content/);
 manifest.engineId=producer.createEngineIdentity(producer.nativeEngineIdentityInputs(manifest));assert.notEqual(manifest.engineId,oldId);await browser.assertNativeEngineIdentity(manifest);
 assert.equal(await browser.createEngineIdentity(browser.nativeEngineIdentityInputs(manifest)),manifest.engineId);
});
test('project/session identity boundaries reject a wrong optional React extension',async t=>{
 const engineId='a'.repeat(64),extensionId='b'.repeat(64);
 assert.doesNotThrow(()=>browser.assertRuntimeTargetIdentity({engineId,extensionId},{engineId}));
 assert.throws(()=>browser.assertRuntimeTargetIdentity({engineId,extensionId},{engineId,extensionId:'c'.repeat(64)}),/E_RUNTIME_TARGET_EXTENSION/);
 const payload={schemaVersion:1,files:[],profiles:[],engine:{threads:false,target:'template_debug'},engineId,extensionId};
 const id=createHash('sha256').update(browser.canonicalIdentityJson(payload)).digest('hex');
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({...payload,id})));
 assert.equal((await loadRuntimeRelease('https://preview.test/release.json',{expectedEngineId:engineId,expectedExtensionId:extensionId})).release.engineId,engineId);
 await assert.rejects(loadRuntimeRelease('https://preview.test/release.json',{expectedEngineId:engineId,expectedExtensionId:'c'.repeat(64)}),/E_RUNTIME_TARGET_EXTENSION/);
});
