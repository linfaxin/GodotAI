import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease} from '../dist/browser/verified-loader.js';
import {prepareWorkerRelease} from '../dist/browser/release-adapter.js';
import {createEngineIdentity,nativeEngineIdentityInputs,createExtensionIdentity,nativeExtensionIdentityInputs} from '../dist/identities.js';
import {nativeReleaseFixture,digest,sealRelease} from './fixtures/native-release.mjs';

function release() {
  const asset=name=>({url:'https://engine.test/'+name,sha256:'a'.repeat(64)});
  return {releaseId:'release',profile:'full-engine-v1',engineTarget:'template_debug',engineJs:asset('godot.js'),engineWasm:asset('godot.wasm'),
    execution:{schemaVersion:1,executionModel:'window',wasmThreads:false,proxyToPthread:false,requiresCrossOriginIsolation:false,hostProtocolVersion:1,lifecycleAbi:1},
    runtimeAbi:{protocolVersion:2,host:1,audio:1,presentation:1,lifecycle:1,observation:1,runtimeProperties:1}};
}

test('verified properties releases require the supported debug recipe and observation/lifecycle pairing',()=>{
  assert.doesNotThrow(()=>validateRelease(release()));
  assert.equal(release().runtimeAbi.runtimeWrite,undefined);
  for(const change of [
    value=>value.runtimeAbi.runtimeProperties=2,
    value=>delete value.runtimeAbi.observation,
    value=>delete value.runtimeAbi.lifecycle,
    value=>value.profile='engine-2d-v1',
    value=>value.engineTarget='template_release',
    value=>Object.assign(value.execution,{executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,workerBootstrap:'embedded'}),
  ]) {const value=release();change(value);assert.throws(()=>validateRelease(value),/E_RELEASE_.*ABI/);}
  const historical=release();delete historical.runtimeAbi.runtimeProperties;
  assert.doesNotThrow(()=>validateRelease(historical));
});

test('raw Worker metadata preserves the optional properties capability without inventing old write support',async()=>{
  const {manifest,files,asset}=await nativeReleaseFixture();
  manifest.runtimeProfile=manifest.profile='full-engine-v1';
  manifest.engine.host=asset('preview.js','/* verified preview */');
  manifest.runtimeAbi=release().runtimeAbi;manifest.execution.lifecycleAbi=1;
  const runtimeAssets={};
  for(const name of ['preview.js','runtime.worker.js','runtime.audio.worklet.js']){
    const item=manifest.payloads[name]??asset(name,'/* runtime fixture '+name+' */');
    runtimeAssets[name]={sha256:item.sha256,bytes:item.bytes};
  }
  manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(manifest));
  manifest.extensionId=await createExtensionIdentity(nativeExtensionIdentityInputs(manifest));
  sealRelease(manifest);
  const descriptorBytes=new TextEncoder().encode(JSON.stringify(manifest,null,2)+'\n');
  const site={schemaVersion:3,runtimeProfile:'full-engine-v1',engineTarget:'template_debug',engineReleaseId:manifest.id,engineRelease:'engine-release.json',
    runtime:{executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',abi:{...manifest.runtimeAbi},entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:runtimeAssets},
    payloads:{...Object.fromEntries([...files].map(([name,bytes])=>[name,{sha256:digest(bytes),bytes:bytes.byteLength}])),
      'engine-release.json':{sha256:digest(descriptorBytes),bytes:descriptorBytes.byteLength}}};
  const prepared=await prepareWorkerRelease({descriptorBytes,siteManifestBytes:new TextEncoder().encode(JSON.stringify(site)),previewBaseUrl:'https://engine.test/',presentationBackend:'direct',allowedOrigins:['https://engine.test'],cachePolicy:'revalidate'});
  assert.equal(prepared.release.runtimeAbi.runtimeProperties,1);
  assert.equal(prepared.release.runtimeAbi.runtimeWrite,undefined);
});
