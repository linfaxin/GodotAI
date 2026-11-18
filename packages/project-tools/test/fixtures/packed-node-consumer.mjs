import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {prepareCompilerEnvironmentInput} from '@godot-js/project-tools/environment';
import {createCompilerEnvironment,compileProject,compileResultMetadata} from '@godot-js/project-tools/compiler';
import {createSourceSnapshot,createBuildPlan} from '@godot-js/project-tools/build-plan';
import {checkProjectTypes,snapshotTextFiles} from '@godot-js/project-tools/type-environment';
import {prepareBrowserArtifact} from '@godot-js/project-tools/browser';
import {prepareWorkerRelease} from '@godot-js/engine/browser/release-adapter';

const descriptorBytes=new Uint8Array(await readFile('./release/engine-release.json'));
const siteManifestBytes=new Uint8Array(await readFile('./release/manifest.json'));
const reads=[];
const prepared=await prepareCompilerEnvironmentInput({descriptorBytes,naming:'snake',selection:{kind:'engine'},
  async readRawAsset(asset,options){options.signal?.throwIfAborted();reads.push(asset.path);
    const bytes=new Uint8Array(await readFile(new URL('./release/'+asset.path,import.meta.url)));
    assert(bytes.length<=options.maxStoredBytes);return bytes;}});
assert.equal(prepared.facts.api.status,'unknown');
assert.equal(prepared.facts.resources.status,'available');
assert(!reads.some(name=>/vendor|runtime-/.test(name)),'engine-only preparation reads no SDK runtime');
const environment=await createCompilerEnvironment(prepared.input);
assert.equal(environment.vendor,undefined);
assert.equal(environment.identity.target.extensionId,undefined);
const snapshot=await createSourceSnapshot({'/start.ts':'import {Node} from "godot"; export function start(){ return new Node(); }'});
const plan=await createBuildPlan(snapshot,{kind:'script',module:'/start.ts'});
assert.deepEqual(checkProjectTypes(environment.createTypeEnvironment(snapshotTextFiles(snapshot))),[]);
const artifacts=[];
for(const artifactSet of [false,true]) {
  const compiled=await compileProject({plan,environment,artifactSet});
  const manifest=compileResultMetadata(compiled);
  const output=artifactSet?{variant:'pack-set',artifactSet:compiled.artifactSet,manifest}:
    {variant:'single-pack',pack:compiled.pack,manifest};
  const artifact=await prepareBrowserArtifact({output,target:prepared.facts.release,revision:7,generation:'packed-7'});
  assert.equal(artifact.buildKey,compiled.buildKey);assert.equal(artifact.revision,7);
  assert.equal(artifact.generation,'packed-7');assert.equal(artifact.manifest.generation,'packed-7');
  assert.equal(artifact.variant,compiled.variant);
  if(artifactSet) {
    assert.equal(artifact.artifactId,compiled.artifactSet.manifest.artifactSetId);
    assert.equal(artifact.packSha256,undefined);
  } else {
    assert.deepEqual(artifact.pack,compiled.pack);
    const captured=artifact.pack.slice();compiled.pack[0]^=255;assert.deepEqual(artifact.pack,captured);
  }
  artifacts.push({variant:compiled.variant,buildKey:compiled.buildKey,artifactId:compiled.artifactId});
}
const worker=await prepareWorkerRelease({descriptorBytes,siteManifestBytes,
  previewBaseUrl:'https://preview.example/releases/packed-fixture/',presentationBackend:'direct',
  allowedOrigins:['https://preview.example'],cachePolicy:'revalidate'});
assert.equal(worker.facts.releaseId,prepared.facts.release.releaseId);
assert.equal(worker.release.runtimeWorker.url,'https://preview.example/releases/packed-fixture/runtime.worker.js');
assert.equal(worker.release.runtimeAudioWorklet.url,'https://preview.example/releases/packed-fixture/runtime.audio.worklet.js');
assert.match(worker.facts.candidateId,/^[a-f0-9]{64}$/);
assert.equal(globalThis.document,undefined);
const require=createRequire(import.meta.url);
for(const name of ['react','react-reconciler','@godot-js/react'])assert.throws(()=>require.resolve(name),{code:'MODULE_NOT_FOUND'});
console.log(JSON.stringify({status:'passed',releaseId:worker.facts.releaseId,artifacts,reads,requiredExtensionId:prepared.facts.requiredExtensionId??null}));
