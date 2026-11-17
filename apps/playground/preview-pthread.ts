import {PREVIEW_PROTOCOL,isIdentity,normalizedOrigin} from '@godot-js/engine/browser/protocol';
import {startPthreadPreviewHost} from '@godot-js/engine/browser/pthread/preview-host';
import {assertCompiledRelease,nativeAudioEnabled,type ReleaseContext} from './src/release-context';
import {verifyPreviewReleaseContext} from './src/preview-release-context';
import {suppressBrowserSave} from './src/browser-shortcuts';
suppressBrowserSave(window);

const configuredOrigin=new URL(location.href).searchParams.get('editorOrigin');
const editorOrigin=configuredOrigin?normalizedOrigin(configuredOrigin):undefined;
let connected=false;
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.isTrusted&&editorOrigin&&parent!==window)parent.postMessage({type:'godotjs-preview-escape',protocolVersion:PREVIEW_PROTOCOL},editorOrigin);});
addEventListener('message',event=>{
 const data=event.data;
 if(!editorOrigin||connected||event.origin!==editorOrigin||event.source!==parent||!data||data.type!=='connect'||data.protocolVersion!==PREVIEW_PROTOCOL||data.editorOrigin!==editorOrigin||!isIdentity(data)||event.ports.length!==1)return;
 connected=true;document.getElementById('connection-status')!.hidden=true;startPthreadPreviewHost(data,event.ports[0],{
  canvas:document.getElementById('canvas') as HTMLCanvasElement,nativeAudioEnabled,
  async verifyArtifact(release,manifest,artifact,signal){
   const context=(release as typeof release&{releaseContext?:ReleaseContext}).releaseContext;
   if(context){
    if(context.engineReleaseId!==release.releaseId||context.engineProfile!==release.profile)throw Error('E_PREVIEW_RELEASE_CONTEXT');
    assertCompiledRelease(context,manifest);
    await verifyPreviewReleaseContext(context,{signal,artifactManifest:manifest,artifactPack:artifact.pack,artifactSet:artifact.artifactSet,artifactBuildKey:artifact.buildKey,artifactId:artifact.artifactId,allowLegacyArtifacts:artifact.allowLegacyArtifacts});
   }
  },
 });
});
