import {assertArtifactSet,artifactSetTransfers,type ArtifactSet} from '../artifact-set.js';
import {assertArtifactReceipt} from '../identities.js';
import type {BrowserArtifact} from './protocol.js';
import type {VerifiedRelease,GodotInstance} from './verified-loader.js';

export function assertArtifactSetTarget(set:ArtifactSet,release:VerifiedRelease):void {
 if(release.execution?.artifactSetAbi!==1)throw Error('E_ARTIFACT_SET_ABI: early native mounting is required');
 if(set.manifest.target.engineReleaseId!==release.releaseId)throw Error('E_ARTIFACT_ENGINE_RELEASE');
 if(set.manifest.target.engineProfile!==undefined&&set.manifest.target.engineProfile!==release.profile)throw Error('E_ARTIFACT_ENGINE_PROFILE');
}
/** Capture mutable inputs before digesting. Pack sets have their own identity;
 * a single-pack receipt never stands in for their actual mounted closure. */
export async function captureBrowserArtifact(artifact:BrowserArtifact,release:VerifiedRelease,allowLegacy=false):Promise<BrowserArtifact> {
 const captured:BrowserArtifact={...artifact,manifest:structuredClone(artifact.manifest),...(!artifact.artifactSet&&artifact.pack?{pack:new Uint8Array(artifact.pack)}:{})};
 const set=artifact.artifactSet?assertArtifactSet(artifact.artifactSet):undefined;
 if(set){
  captured.artifactSet=await set;assertArtifactSetTarget(captured.artifactSet,release);
  const setId=captured.artifactSet.manifest.artifactSetId,metadata=captured.manifest as {artifactId?:unknown;artifactSetId?:unknown};
  if(captured.artifactId!==undefined&&captured.artifactId!==setId||metadata.artifactId!==undefined&&metadata.artifactId!==setId||metadata.artifactSetId!==undefined&&metadata.artifactSetId!==setId)throw Error('E_ARTIFACT_IDENTITY');
  captured.variant='pack-set';delete captured.pack;delete captured.packSha256;
  captured.artifactId=captured.artifactSet.manifest.artifactSetId;
  const {artifactReceipt:_oldReceipt,packSha256:_oldPackHash,...manifest}=captured.manifest as Record<string,unknown>;
  captured.manifest={...manifest,artifactId:captured.artifactId,artifactSetId:captured.artifactId};
  return captured;
 }
 if(artifact.variant==='pack-set'||!captured.pack)throw Error('E_ARTIFACT_PACK');
 const receipt=await assertArtifactReceipt((captured.manifest as {artifactReceipt?:unknown}).artifactReceipt,{pack:captured.pack,buildKey:captured.buildKey,artifactId:captured.artifactId??(captured.manifest as {artifactId?:string}).artifactId,allowLegacy});
 if(receipt?.artifactId){captured.artifactId=receipt.artifactId;captured.manifest={...(captured.manifest as object),artifactId:receipt.artifactId};}
 return captured;
}
export function browserArtifactTransfers(artifact:BrowserArtifact):ArrayBuffer[]{return artifact.artifactSet?artifactSetTransfers(artifact.artifactSet):[artifact.pack!.buffer as ArrayBuffer];}
/** Staging bytes does not mount them. The source-bound Main::setup hook validates
 * and mounts the whole set before project settings, UIDs, autoloads and scenes. */
export async function preloadArtifactSet(engine:GodotInstance,set:ArtifactSet,assertActive:()=>void=()=>{}):Promise<void> {
 for(const descriptor of [set.manifest.bootstrap,...set.manifest.resources]){
  assertActive();await engine.preloadFile(set.packs.get(descriptor.sha256)!, '/'+descriptor.path);assertActive();
 }
}
