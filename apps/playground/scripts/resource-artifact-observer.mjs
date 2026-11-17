// Read-only test observer. Capture before the product transfers its received
// buffers, then verify the actual artifact; no compiler/runtime is replaced.
import {assertArtifactSet,ARTIFACT_SET_INDEX} from '../../../packages/engine/dist/artifact-set.js';
import {readPckIndex} from '../../../packages/engine/dist/pck-index.js';
import {assertArtifactReceipt} from '../../../packages/engine/dist/identities.js';
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export async function observeResourceArtifact(data){
 const manifest=structuredClone(data.manifest),files=[],packs=[];let packBytes=0,setManifest;
 const inspect=async(bytes,descriptor)=>{
  const sha256=await sha(bytes);if(descriptor&&sha256!==descriptor.sha256)throw Error('Observed package hash differs');
  packs.push({path:descriptor?.path??'application.pck',sha256,bytes:bytes.length});packBytes+=bytes.length;
  for(const entry of readPckIndex(bytes).entries)files.push({path:entry.path,bytes:entry.bytes,md5:entry.md5,sha256:await sha(bytes.slice(entry.offset,entry.offset+entry.bytes)),source:descriptor?.sha256??sha256});
 };
 if(data.variant==='pack-set'){
  const captured=await assertArtifactSet(data.artifactSet);setManifest=captured.manifest;
  for(const descriptor of [setManifest.bootstrap,...setManifest.resources])await inspect(captured.packs.get(descriptor.sha256),descriptor);
 }else if(data.variant==='single-pack'){
  const bytes=new Uint8Array(data.pack);await assertArtifactReceipt(manifest.artifactReceipt,{pack:bytes,buildKey:manifest.buildKey});await inspect(bytes);
 }else throw Error('Unknown compiled artifact variant');
 const outputs=new Map(files.filter(entry=>entry.path!==ARTIFACT_SET_INDEX).map(entry=>[entry.path,entry]));
 for(const output of manifest.outputOverlay??[]){
  const actual=outputs.get(output.path);
  if(output.outputHash!==undefined){if(!actual||actual.sha256!==output.outputHash)throw Error('Overlay differs from actual packed output '+output.path);outputs.delete(output.path);}
  else if(actual)throw Error('Omitted source appears in the artifact '+output.path);
 }
 if(outputs.size)throw Error('Actual artifact contains outputs absent from its overlay');
 const members=new Map(files.map(entry=>[entry.path,entry]));
 for(const receipt of manifest.importReceipts??manifest.artifactReceipt?.imports??[]){
  for(const output of receipt.outputs)if(members.get(output.path)?.sha256!==output.sha256)throw Error('Converter receipt differs from actual packed output '+output.path);
  for(const source of receipt.sources)if(manifest.outputOverlay.find(entry=>entry.path===source.path)?.inputHash!==source.sha256)throw Error('Converter receipt differs from captured source '+source.path);
 }
 return {variant:data.variant,manifest,setManifest,packBytes,packs,files};
}
