import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBrowserArtifact} from '../dist/browser/index.js';
import {createCompilerEnvironment, compileBuildPlan, compileResultMetadata} from '../dist/compiler.js';
import {createBuildPlan, createSourceSnapshot} from '../dist/build-plan.js';
import {assertArtifactSet} from '@godot-js/engine/artifact-set';

const releaseId = 'a'.repeat(64), engineId = 'b'.repeat(64), extensionId = 'c'.repeat(64);
const target = () => ({releaseId, descriptorSha256: 'd'.repeat(64), engineProfile: 'full-engine-v1', engineId, extensionId,
  artifactReceiptVersion: 2, artifactSetAbi: 1});

// Exercise the real compiler/metadata projection. These fixture builds test
// artifact admission, rather than claiming checked or real-engine execution.
async function compiled({set = false, sdk = false, native = engineId} = {}) {
  const snapshot = await createSourceSnapshot({'/start.ts': 'export function start() {}', '/assets/data.bin': new Uint8Array([1, 2, 3])});
  const plan = await createBuildPlan(snapshot, {kind: 'script', module: '/start.ts'});
  const environment = await createCompilerEnvironment({target: {engineReleaseId: releaseId, engineProfile: 'full-engine-v1',
    engineId: native, artifactSetAbi: 1, ...(sdk ? {extensionId} : {})}, declarations: {}});
  const result = await compileBuildPlan(plan, {environment, artifactSet: set});
  return {result, output: {variant: result.variant, manifest: compileResultMetadata(result),
    ...(set ? {artifactSet: result.artifactSet} : {pack: result.pack})}};
}
const options = output => ({output, target: target(), revision: 3, generation: 'run-input-3'});

test('single-pack admits real compiler metadata and returns independently transferable bytes', async () => {
  const {result, output} = await compiled();
  const artifact = await prepareBrowserArtifact(options(output));
  assert.equal(artifact.variant, 'single-pack');
  assert.equal(artifact.buildKey, result.buildKey);
  assert.equal(artifact.artifactId, result.artifactId);
  assert.equal(artifact.packSha256, result.receipt.packSha256);
  assert.equal(artifact.manifest.sourceHash, result.sourceHash);
  assert.equal(artifact.manifest.generation, 'run-input-3');
  assert.deepEqual(artifact.pack, result.pack);
  assert.notEqual(artifact.pack.buffer, result.pack.buffer);
  const moved = structuredClone(artifact, {transfer: [artifact.pack.buffer]});
  assert.equal(artifact.pack.byteLength, 0);
  assert.deepEqual(moved.pack, result.pack);
  assert(result.pack.byteLength > 0);
  await prepareBrowserArtifact(options(output));
});

test('single-pack captures exact byte views, metadata, target and identity before awaiting', async () => {
  const {output} = await compiled();
  const original = output.pack.slice(), padded = new Uint8Array(original.length + 8);
  padded.set(original, 4);
  const input = {...output, pack: padded.subarray(4, original.length + 4), manifest: {...output.manifest, context: {candidate: 'captured'}}};
  const request = options(input), pending = prepareBrowserArtifact(request);
  input.pack.fill(0); input.manifest.context.candidate = 'changed'; input.manifest.artifactId = 'f'.repeat(64);
  request.target.engineId = 'f'.repeat(64); request.target.releaseId = 'f'.repeat(64);
  request.revision = 99; request.generation = 'changed'; request.output = {variant: 'invalid'};
  const artifact = await pending;
  assert.deepEqual(artifact.pack, original);
  assert.equal(artifact.revision, 3);
  assert.equal(artifact.generation, 'run-input-3');
  assert.equal(artifact.manifest.context.candidate, 'captured');
});

test('expected release and native target are independent of the artifact; SDK is required only when the project requests it', async () => {
  const ordinary = (await compiled()).output;
  await prepareBrowserArtifact({...options(ordinary), target: {...target(), extensionId: 'e'.repeat(64)}});
  await assert.rejects(prepareBrowserArtifact({...options(ordinary), target: {...target(), releaseId: 'e'.repeat(64)}}), /E_ARTIFACT_ENGINE_RELEASE/);
  await assert.rejects(prepareBrowserArtifact({...options(ordinary), target: {...target(), engineProfile: 'engine-2d-v1'}}), /E_ARTIFACT_ENGINE_PROFILE/);
  await assert.rejects(prepareBrowserArtifact({...options(ordinary), target: {...target(), engineId: 'e'.repeat(64)}}), /E_RUNTIME_TARGET_ENGINE/);
  const sdk = (await compiled({sdk: true})).output;
  await prepareBrowserArtifact(options(sdk));
  await assert.rejects(prepareBrowserArtifact({...options(sdk), target: {...target(), extensionId: 'e'.repeat(64)}}), /E_RUNTIME_TARGET_EXTENSION/);
  await assert.rejects(prepareBrowserArtifact({...options(sdk), target: {...target(), extensionId: undefined}}), /E_RUNTIME_TARGET_EXTENSION/);
});

test('single-pack rejects wrong source/build/pack/receipt identity and malformed run input', async () => {
  const {output} = await compiled();
  const changed = fields => ({...output, manifest: {...output.manifest, ...fields}});
  for (const [fields, code] of [
    [{sourceHash: 'e'.repeat(64)}, /E_ARTIFACT_SOURCE_HASH/],
    [{buildKey: 'e'.repeat(64)}, /E_ARTIFACT_BUILD_KEY/],
    [{artifactId: 'e'.repeat(64)}, /E_ARTIFACT_IDENTITY/],
    [{packSha256: 'e'.repeat(64)}, /E_ARTIFACT_PACK_HASH/],
    [{variant: 'pack-set'}, /E_ARTIFACT_VARIANT/],
    [{generation: 'different'}, /E_ARTIFACT_GENERATION/],
    [{artifactReceipt: {...output.manifest.artifactReceipt, schemaVersion: 1}}, /E_ARTIFACT_RECEIPT/],
  ]) await assert.rejects(prepareBrowserArtifact(options(changed(fields))), code);
  const corrupt = output.pack.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(prepareBrowserArtifact(options({...output, pack: corrupt})), /E_ARTIFACT_PACK_HASH/);
  await assert.rejects(prepareBrowserArtifact({...options(output), revision: -1}), /E_ARTIFACT_GENERATION/);
  await assert.rejects(prepareBrowserArtifact({...options(output), generation: ''}), /E_ARTIFACT_GENERATION/);
  await assert.rejects(prepareBrowserArtifact(options({...output, pack: new Uint8Array()})), /E_ARTIFACT_PACK/);
});

test('pack-set admits the actual closure and never presents a single-pack receipt/hash', async () => {
  const {result, output} = await compiled({set: true});
  const input = {...output, manifest: {...output.manifest, artifactReceipt: {stale: true}, packSha256: 'old-pack'}};
  const artifact = await prepareBrowserArtifact(options(input));
  assert.equal(artifact.variant, 'pack-set');
  assert.equal(artifact.artifactId, result.artifactSet.manifest.artifactSetId);
  assert.equal(artifact.manifest.artifactSetId, artifact.artifactId);
  assert.equal(artifact.buildKey, result.buildKey);
  assert.equal(artifact.manifest.sourceHash, result.sourceHash);
  assert.equal(artifact.pack, undefined);
  assert.equal(artifact.packSha256, undefined);
  assert.equal(artifact.manifest.artifactReceipt, undefined);
  assert.equal(artifact.manifest.packSha256, undefined);
  assert.equal(input.manifest.packSha256, 'old-pack');
  await assertArtifactSet(artifact.artifactSet);
  const transfers = [...artifact.artifactSet.packs.values()].map(bytes => bytes.buffer);
  structuredClone(artifact, {transfer: transfers});
  await assertArtifactSet(result.artifactSet);
});

test('pack-set captures the complete map, manifest and bytes before its first await', async () => {
  const {output} = await compiled({set: true});
  const originalId = output.artifactSet.manifest.artifactSetId, request = options(output);
  const pending = prepareBrowserArtifact(request);
  for (const bytes of output.artifactSet.packs.values()) bytes.fill(0);
  output.artifactSet.packs.clear();
  output.artifactSet.manifest.target.engineId = 'e'.repeat(64);
  request.output = {variant: 'invalid'}; request.target.artifactSetAbi = undefined;
  const artifact = await pending;
  assert.equal(artifact.artifactId, originalId);
  await assertArtifactSet(artifact.artifactSet);
});

test('pack-set rejects unsupported ABI, wrong outer identity and mismatched inner target/bytes', async () => {
  const {output} = await compiled({set: true});
  await assert.rejects(prepareBrowserArtifact({...options(output), target: {...target(), artifactSetAbi: undefined}}), /E_ARTIFACT_SET_ABI/);
  await assert.rejects(prepareBrowserArtifact(options({...output, manifest: {...output.manifest, artifactSetId: 'e'.repeat(64)}})), /E_ARTIFACT_IDENTITY/);
  const foreign = (await compiled({set: true, native: 'e'.repeat(64)})).output;
  await assert.rejects(prepareBrowserArtifact(options({...foreign, manifest: {...foreign.manifest, engineId}})), /E_RUNTIME_TARGET_ENGINE/);
  const packs = new Map([...output.artifactSet.packs].map(([name, bytes]) => [name, bytes.slice()]));
  packs.values().next().value[0] ^= 1;
  await assert.rejects(prepareBrowserArtifact(options({...output, artifactSet: {...output.artifactSet, packs}})), /E_ARTIFACT_SET/);
});
