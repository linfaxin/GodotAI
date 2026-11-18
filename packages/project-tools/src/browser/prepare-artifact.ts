import {assertArtifactSet, type ArtifactSet} from '@godot-js/engine/artifact-set';
import {assertArtifactReceipt, assertRuntimeTargetIdentity} from '@godot-js/engine/identities';
import {isIdentity, type BrowserArtifact, type Revision} from '@godot-js/engine/browser/protocol';
import type {ReleaseFacts} from '@godot-js/engine/release-assets';
import {ProjectToolError} from '../errors.js';
import {canonicalJson} from '../hash.js';
import {captureBytes} from '../owned-bytes.js';

/** The serializable part of a compile response, after compileResultMetadata.
 * Compiler environments, plans and caches remain in their originating realm. */
export type CompiledArtifactData =
  | {variant: 'single-pack'; pack: Uint8Array; manifest: Readonly<Record<string, unknown>>}
  | {variant: 'pack-set'; artifactSet: ArtifactSet; manifest: Readonly<Record<string, unknown>>};

export interface PrepareBrowserArtifactOptions {
  output: CompiledArtifactData;
  /** Facts from the independently prepared release, not the compile response. */
  target: ReleaseFacts;
  revision: Revision;
  generation: Revision;
}

const digest = /^[a-f0-9]{64}$/;
const MAX_PACK_BYTES = 64 * 1024 * 1024;
function reject(code: string, message: string): never {
  throw new ProjectToolError(code, message, {stage: 'artifact'});
}
function requireDigest(value: unknown, code: string, name: string): asserts value is string {
  if (typeof value !== 'string' || !digest.test(value)) reject(code, `Expected ${name}`);
}
function captureTarget(input: ReleaseFacts): ReleaseFacts {
  if (!input || typeof input !== 'object') reject('E_ARTIFACT_TARGET', 'Expected prepared release facts');
  const {releaseId, descriptorSha256, engineProfile, engineId, extensionId, artifactReceiptVersion, artifactSetAbi} = input;
  requireDigest(releaseId, 'E_ARTIFACT_TARGET', 'release ID');
  requireDigest(descriptorSha256, 'E_ARTIFACT_TARGET', 'descriptor hash');
  if (typeof engineProfile !== 'string' || !engineProfile || engineProfile.length > 256)
    reject('E_ARTIFACT_TARGET', 'Expected engine profile');
  if (engineId !== undefined) requireDigest(engineId, 'E_ARTIFACT_TARGET', 'engine ID');
  if (extensionId !== undefined) {
    requireDigest(extensionId, 'E_ARTIFACT_TARGET', 'extension ID');
    if (engineId === undefined) reject('E_ARTIFACT_TARGET', 'Extension requires a sealed engine target');
  }
  if (artifactReceiptVersion !== undefined && artifactReceiptVersion !== 2 || artifactSetAbi !== undefined && artifactSetAbi !== 1)
    reject('E_ARTIFACT_TARGET', 'Unsupported artifact contract');
  return {releaseId, descriptorSha256, engineProfile, ...(engineId === undefined ? {} : {engineId}),
    ...(extensionId === undefined ? {} : {extensionId}), ...(artifactReceiptVersion === undefined ? {} : {artifactReceiptVersion}),
    ...(artifactSetAbi === undefined ? {} : {artifactSetAbi})};
}
function captureManifest(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('E_ARTIFACT_MANIFEST', 'Expected compilation metadata');
  try { return JSON.parse(canonicalJson(value)) as Record<string, unknown>; }
  catch (error) { throw new ProjectToolError('E_ARTIFACT_MANIFEST', 'Expected finite JSON compilation metadata', error); }
}
function assertTarget(target: ReleaseFacts, project: Readonly<Record<string, unknown>>): void {
  if (project.engineReleaseId !== target.releaseId) reject('E_ARTIFACT_ENGINE_RELEASE', 'Compilation targets a different release');
  if (project.engineProfile !== target.engineProfile) reject('E_ARTIFACT_ENGINE_PROFILE', 'Compilation targets a different profile');
  if (target.engineId === undefined) {
    if (project.engineId !== undefined || project.extensionId !== undefined)
      reject('E_RUNTIME_TARGET_IDENTITY', 'Release has no sealed native target');
    return;
  }
  const engineId = project.engineId, extensionId = project.extensionId;
  requireDigest(engineId, 'E_RUNTIME_TARGET_IDENTITY', 'project engine ID');
  if (extensionId !== undefined) requireDigest(extensionId, 'E_RUNTIME_TARGET_IDENTITY', 'required project extension ID');
  assertRuntimeTargetIdentity({engineId: target.engineId, ...(target.extensionId === undefined ? {} : {extensionId: target.extensionId})},
    {engineId, ...(extensionId === undefined ? {} : {extensionId})});
}

/** Capture before hashing and return buffers owned by this run input. The
 * caller may transfer them without detaching compiler/cache-owned buffers. */
export async function prepareBrowserArtifact(options: PrepareBrowserArtifactOptions): Promise<BrowserArtifact> {
  if (!options || typeof options !== 'object') reject('E_ARTIFACT_INPUT', 'Expected artifact preparation options');
  const {output, revision, generation} = options;
  const target = captureTarget(options.target);
  if (!output || output.variant !== 'single-pack' && output.variant !== 'pack-set')
    reject('E_ARTIFACT_VARIANT', 'Expected single-pack or pack-set compilation');
  const variant = output.variant, manifest = captureManifest(output.manifest);
  if (manifest.variant !== variant) reject('E_ARTIFACT_VARIANT', 'Compilation metadata has a different variant');
  const buildKey = manifest.buildKey, sourceHash = manifest.sourceHash, artifactId = manifest.artifactId;
  requireDigest(buildKey, 'E_ARTIFACT_BUILD_KEY', 'final build key');
  requireDigest(sourceHash, 'E_ARTIFACT_SOURCE_HASH', 'source hash');
  requireDigest(artifactId, 'E_ARTIFACT_IDENTITY', 'artifact ID');
  if (!isIdentity({runId: 'prepare', revision, buildKey, generation}) || manifest.generation !== undefined && manifest.generation !== generation)
    reject('E_ARTIFACT_GENERATION', 'Expected consistent revision and generation');
  manifest.generation = generation;
  assertTarget(target, manifest);

  if (output.variant === 'pack-set') {
    if (target.artifactSetAbi !== 1) reject('E_ARTIFACT_SET_ABI', 'Matched target does not support early set mounting');
    if (manifest.artifactSetId !== artifactId) reject('E_ARTIFACT_IDENTITY', 'Outer set identity differs');
    // assertArtifactSet captures the complete manifest/map/byte closure before
    // its first await; later caller mutations cannot change this admission.
    const artifactSet = await assertArtifactSet(output.artifactSet);
    assertTarget(target, artifactSet.manifest.target);
    if (artifactSet.manifest.target.artifactSetAbi !== 1) reject('E_ARTIFACT_SET_ABI', 'Set target does not declare its mounting ABI');
    for (const name of ['engineReleaseId', 'engineProfile', 'engineId', 'extensionId'])
      if (manifest[name] !== artifactSet.manifest.target[name]) reject('E_ARTIFACT_TARGET', `Set and compilation ${name} differ`);
    if (artifactSet.manifest.artifactSetId !== artifactId) reject('E_ARTIFACT_IDENTITY', 'Compilation and mounted set differ');
    delete manifest.artifactReceipt;
    delete manifest.packSha256;
    return {variant, revision, generation, buildKey, artifactId, artifactSet, manifest};
  }

  if (!(output.pack instanceof Uint8Array) || !output.pack.byteLength || output.pack.byteLength > MAX_PACK_BYTES)
    reject('E_ARTIFACT_PACK', 'Expected a nonempty pack within the browser byte limit');
  const pack = captureBytes(output.pack);
  requireDigest(manifest.packSha256, 'E_ARTIFACT_PACK_HASH', 'pack hash');
  const receipt = await assertArtifactReceipt(manifest.artifactReceipt, {pack, buildKey, artifactId});
  if (receipt!.sourceHash !== sourceHash) reject('E_ARTIFACT_SOURCE_HASH', 'Source metadata differs from its receipt');
  if (receipt!.packSha256 !== manifest.packSha256) reject('E_ARTIFACT_PACK_HASH', 'Pack metadata differs from its receipt');
  delete manifest.artifactSetId;
  return {variant, revision, generation, buildKey, artifactId, packSha256: receipt!.packSha256, pack, manifest};
}
