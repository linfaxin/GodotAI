import {createHash} from 'node:crypto';
import {canonicalIdentityJson,nativeEngineIdentityInputs,nativeExtensionIdentityInputs} from '../../packages/engine/src/identities.ts';
export {canonicalIdentityJson} from '../../packages/engine/src/identities.ts';
export {assertRuntimeTargetIdentity} from '../../packages/engine/src/identities.ts';
export {nativeEngineIdentityInputs} from '../../packages/engine/src/identities.ts';

/** Domain-separated JSON identities; none hashes its own serialized output. */
const identity = (kind, inputs) => createHash('sha256').update(canonicalIdentityJson({kind, inputs})).digest('hex');
const rejectKeys = (inputs, forbidden) => {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw Error('E_IDENTITY_INPUT: Expected object');
  for (const key of forbidden) if (key in inputs) throw Error('E_IDENTITY_SELF_REFERENCE: ' + key);
};
export function createEngineIdentity(inputs) {
  rejectKeys(inputs, ['engineId', 'id', 'url', 'releaseRoot', 'timestamp', 'createdAt', 'react', 'extensionId']);
  return identity('godotjs-engine-v1', inputs);
}
export function createExtensionIdentity(inputs) {
  rejectKeys(inputs, ['extensionId', 'id', 'url', 'timestamp', 'createdAt']);
  return identity('godotjs-extension-v1', inputs);
}
export function createBuildKey(inputs) {
  rejectKeys(inputs, ['buildKey', 'artifactId', 'packSha256', 'outputHashes', 'revision', 'runId']);
  return identity('godotjs-build-key-v1', inputs);
}
export function createArtifactIdentity(inputs) {
  rejectKeys(inputs, ['artifactId', 'id', 'runId', 'revision']);
  if (!/^[a-f0-9]{64}$/.test(inputs.buildKey ?? '') || !/^[a-f0-9]{64}$/.test(inputs.packSha256 ?? '')) throw Error('E_IDENTITY_ARTIFACT: Expected build key and final pack hash');
  return identity('godotjs-artifact-v1', inputs);
}

/** Recompute identities from the sealed native descriptor, not its combined
 * compiler type snapshot (which also contains optional React declarations). */
export function fullEngineIdentities(manifest){
  const execution=manifest.execution??manifest.engine?.execution;
  const api=manifest.api;
  if(!execution||!api?.namingProfiles||!manifest.engine||!manifest.sdk)throw Error('E_IDENTITY_MANIFEST: Missing native engine identity inputs');
  const inputs=nativeEngineIdentityInputs(manifest);
  return {engineId:createEngineIdentity(inputs),extensionId:createExtensionIdentity(nativeExtensionIdentityInputs(manifest))};
}
export function assertFullEngineIdentities(manifest){
  const actual=fullEngineIdentities(manifest);
  if(actual.engineId!==manifest.engineId||actual.extensionId!==manifest.extensionId)throw Error('E_IDENTITY_MANIFEST: Declared engine or extension identity differs from sealed content');
  return actual;
}
