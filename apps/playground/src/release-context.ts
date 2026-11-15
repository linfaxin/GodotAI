import {getEngineProfile,isEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {assertRuntimeTargetIdentity} from '@godot-js/engine/identities';

/** One session pins an engine/SDK/type tuple; profile names only capabilities. */
export interface ReleaseContext {
 engineProfile:string;engineReleaseId:string;descriptorHash:string;releaseRoot:string;
 candidateId?:string;demoDescriptorHash?:string;publicAssets?:boolean;
}
export function assertReleaseContext(value:unknown):asserts value is ReleaseContext {
 const context=value as ReleaseContext;
 if(!context||!isEngineProfile(context.engineProfile)||typeof context.engineReleaseId!=='string'||!context.engineReleaseId||!(/^[a-f0-9]{64}$/i).test(context.descriptorHash??''))throw Error('E_RELEASE_CONTEXT');
 const root=new URL(context.releaseRoot);
 if(!['http:','https:'].includes(root.protocol)||root.username||root.password||root.search||root.hash||!root.pathname.endsWith('/'))throw Error('E_RELEASE_CONTEXT_ROOT');
 if(context.candidateId!==undefined&&(typeof context.candidateId!=='string'||!context.candidateId))throw Error('E_RELEASE_CONTEXT_CANDIDATE');
 if(context.demoDescriptorHash!==undefined&&!(/^[a-f0-9]{64}$/i).test(context.demoDescriptorHash))throw Error('E_RELEASE_CONTEXT_DEMO');
 if(context.publicAssets!==undefined&&typeof context.publicAssets!=='boolean')throw Error('E_RELEASE_CONTEXT_CACHE');
}
export function assertSameRelease(expected:ReleaseContext,actual:ReleaseContext):void {
 assertReleaseContext(expected);assertReleaseContext(actual);
 for(const key of ['engineProfile','engineReleaseId','descriptorHash','releaseRoot','candidateId','demoDescriptorHash','publicAssets'] as const){
  if(expected[key]!==actual[key])throw Error('E_RELEASE_CONTEXT_MISMATCH: '+key+'; 请刷新运行环境，编辑内容已保留');
 }
}
export function assertCompiledRelease(context:ReleaseContext,manifest:unknown):void {
 const value=manifest as {engineProfile?:unknown;engineReleaseId?:unknown;releaseContext?:unknown};
 if(!value||value.engineProfile!==context.engineProfile||value.engineReleaseId!==context.engineReleaseId)throw Error('E_ARTIFACT_RELEASE_MISMATCH');
 assertSameRelease(context,value.releaseContext as ReleaseContext);
}
/** A project may use the engine alone or require its sealed React extension. */
export function assertArtifactTarget(release:{engineId?:string;extensionId?:string},manifest:unknown):void {
 const project=manifest as {engineId?:string;extensionId?:string};
 if(release.engineId===undefined){
  if(project?.engineId!==undefined||project?.extensionId!==undefined)throw Error('E_RUNTIME_TARGET_IDENTITY: Release has no sealed target');
  return;
 }
 assertRuntimeTargetIdentity({engineId:release.engineId,...(release.extensionId!==undefined?{extensionId:release.extensionId}:{})},project as {engineId:string;extensionId?:string});
}
export function nativeAudioEnabled(profile:string):boolean {
 return isEngineProfile(profile)&&getEngineProfile(profile).audio===true;
}
