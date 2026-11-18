import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {createPackedConsumer} from './fixtures/packed-consumer.mjs';
import {nativeReleaseFixture,sealRelease,digest} from '../../engine/test/fixtures/native-release.mjs';
import {hashJson} from '../dist/hash.js';
import {createEngineIdentity,nativeEngineIdentityInputs,createExtensionIdentity,nativeExtensionIdentityInputs} from '@godot-js/engine/identities';

async function libraries() {
  const root=path.dirname(ts.getDefaultLibFilePath({target:ts.ScriptTarget.ES2022})),files={};
  async function load(name){const file='lib.'+name+'.d.ts',virtual='/lib/'+file;if(files[virtual])return;
    const source=await readFile(path.join(root,file),'utf8');files[virtual]=source;
    await Promise.all([...source.matchAll(/<reference lib="([^"]+)"/g)].map(match=>load(match[1])));}
  await load('es2022');return files;
}
async function transportFixture(directory) {
  const fixture=await nativeReleaseFixture();
  delete fixture.manifest.api.ir;
  fixture.manifest.engine.version='4.6.1';
  fixture.manifest.execution.artifactSetAbi=1;
  fixture.manifest.runtimeAbi={protocolVersion:2,host:1,audio:1,presentation:1};
  const runtimeAssets={};
  for(const name of ['preview.js','runtime.worker.js','runtime.audio.worklet.js']) {
    const asset=fixture.asset(name,'/* synthetic transport fixture: never executed */');
    runtimeAssets[name]={sha256:asset.sha256,bytes:asset.bytes};
    if(name==='preview.js')fixture.manifest.engine.host=asset;
  }
  const types={...fixture.types,...await libraries()};
  fixture.manifest.api.typeSnapshot=fixture.asset('types.json',JSON.stringify(types));
  fixture.manifest.api.namingProfiles.snake.typeSnapshot=fixture.manifest.api.typeSnapshot;
  fixture.manifest.sdk.typesHash=await hashJson(Object.fromEntries(Object.entries(types).filter(([name])=>name!=='/godot/index.d.ts')));
  fixture.manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(fixture.manifest));
  fixture.manifest.extensionId=await createExtensionIdentity(nativeExtensionIdentityInputs(fixture.manifest));
  sealRelease(fixture.manifest);
  const descriptor=Buffer.from(JSON.stringify(fixture.manifest));
  const site={schemaVersion:3,runtimeProfile:fixture.manifest.runtimeProfile,engineRelease:'engine-release.json',
    engineReleaseId:fixture.manifest.id,engineId:fixture.manifest.engineId,extensionId:fixture.manifest.extensionId,
    runtime:{executionBackend:'worker',presentationBackends:['direct','bitmap'],defaultPresentationBackend:'direct',
      abi:fixture.manifest.runtimeAbi,entry:'runtime.worker.js',audioWorklet:'runtime.audio.worklet.js',assets:runtimeAssets},
    payloads:{...fixture.manifest.payloads,'engine-release.json':{sha256:digest(descriptor),bytes:descriptor.length}}};
  const root=path.join(directory,'release');await mkdir(root);
  for(const [name,bytes]of fixture.files){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
  await writeFile(path.join(root,'engine-release.json'),descriptor);
  await writeFile(path.join(root,'manifest.json'),JSON.stringify(site));
  return fixture.manifest;
}

test('packed engine and project tools execute preparation/build/artifact contracts outside the workspace', {timeout:240000}, async t=>{
  const consumer=await createPackedConsumer();t.after(consumer.dispose);
  const manifest=await transportFixture(consumer.directory);
  const result=await consumer.execute(await readFile(new URL('./fixtures/packed-node-consumer.mjs',import.meta.url),'utf8'));
  const report=JSON.parse(result.stdout);
  assert.equal(report.status,'passed');assert.equal(report.releaseId,manifest.id);
  assert.deepEqual(report.artifacts.map(item=>item.variant),['single-pack','pack-set']);
  assert.equal(report.requiredExtensionId,null);
  assert(consumer.browserBundle.includes('engineContractsConsumer'));
  assert(consumer.browserInputs.some(name=>name.includes('@godot-js/engine/dist/browser/dedicated/worker-runner.js')));
  assert(consumer.browserInputs.some(name=>name.includes('@godot-js/project-tools/dist/environment.js')));
});
