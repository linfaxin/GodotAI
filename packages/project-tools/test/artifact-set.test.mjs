import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtifactSet} from '../dist/artifact-set.js';
import {packProject,readPckIndex} from '../dist/pck.js';
import {ARTIFACT_SET_INDEX,assertArtifactSet,artifactBytesHash,createArtifactSetIdentity} from '@godot-js/engine/artifact-set';
import {captureBrowserArtifact,browserArtifactTransfers} from '../../engine/dist/browser/artifact-input.js';
import {ProjectBuildCache} from '../dist/build-cache.js';
const text=value=>new TextEncoder().encode(value);
const input=()=>new Map([['res://project.godot',text('[application]\nrun/main_scene="res://main.tscn"\n')],['res://main.tscn',text('[gd_scene format=3]\n[node name="Root" type="Node"]\n')],['res://.godot/uid_cache.bin',new Uint8Array(4)],['res://src/start.ts',text('export const n=1;')],['res://assets/data.bin',new Uint8Array([1,2,3,4])]]);
test('artifact set owns input/output bytes, describes actual directories and reuses resource identities across script edits',async()=>{
 const files=input(),first=await createArtifactSet(files,{target:{engine:'fixture'}});
 assert.equal(first.manifest.resources.length,1);assert(await assertArtifactSet(first));
 const bootstrap=readPckIndex(first.packs.get(first.manifest.bootstrap.sha256));
 assert(bootstrap.entries.some(e=>e.path===ARTIFACT_SET_INDEX));assert(bootstrap.entries.some(e=>e.path==='res://.godot/uid_cache.bin'));
 const resource=readPckIndex(first.packs.get(first.manifest.resources[0].sha256));assert(!resource.entries.some(e=>e.path==='res://project.godot'));
 files.get('res://assets/data.bin')[0]=99;
 assert.equal(first.packs.get(first.manifest.resources[0].sha256)[112],1);
 const edited=input();edited.set('res://src/start.ts',text('export const n=2;'));
 const second=await createArtifactSet(edited,{target:{engine:'fixture'}});
 assert.deepEqual(second.manifest.resources,first.manifest.resources);assert.notEqual(second.manifest.artifactSetId,first.manifest.artifactSetId);
 const captured=await assertArtifactSet(first);captured.packs.get(captured.manifest.bootstrap.sha256).fill(0);await assertArtifactSet(first);
});
test('actual PCK v3 reader rejects checksums, directory flags and truncated data',()=>{
 const {pack}=packProject(input()),entries=readPckIndex(pack).entries;
 const broken=pack.slice();broken[entries.find(e=>e.bytes>0).offset]^=1;assert.throws(()=>readPckIndex(broken),/checksum/);
 assert.throws(()=>readPckIndex(pack.subarray(0,pack.length-1)),/Truncated|bounds|directory/);
 const flags=pack.slice(),v=new DataView(flags.buffer);v.setUint32(flags.length-4,1,true);assert.throws(()=>readPckIndex(flags),/flags/);
});
test('resource packs cannot smuggle bootstrap metadata through a false union declaration',async()=>{
 const original=await createArtifactSet(input()),manifest=structuredClone(original.manifest),packs=new Map(original.packs);
 const forbidden=packProject(new Map([['res://project.godot',text('malicious')]])).pack,sha256=await artifactBytesHash(forbidden);
 packs.delete(manifest.resources[0].sha256);manifest.resources[0]={path:`packs/${sha256}.pck`,sha256,bytes:forbidden.length};packs.set(sha256,forbidden);
 const {artifactSetId,...inputs}=manifest;manifest.artifactSetId=await createArtifactSetIdentity(inputs);
 await assert.rejects(assertArtifactSet({schemaVersion:1,manifest,packs}),/Union context|global metadata/);
});
test('explicit groups reject control metadata and missing or duplicate paths',async()=>{
 await assert.rejects(createArtifactSet(input(),{groups:{bad:['res://project.godot']}}),/assignment/);
 await assert.rejects(createArtifactSet(input(),{groups:{bad:['res://missing']}}),/assignment/);
 await assert.rejects(createArtifactSet(input(),{groups:{a:['res://assets/data.bin'],b:['res://assets/data.bin']}}),/assignment/);
});
test('native exported mesh/material data stays reusable while global caches remain bootstrap-owned',async()=>{
 const files=input();files.set('res://.godot/exported/12/export-mesh.res',new Uint8Array([5,6,7]));
 files.set('res://.godot/editor/script_editor_cache.cfg',text('editor cache'));
 const first=await createArtifactSet(files),bootstrap=readPckIndex(first.packs.get(first.manifest.bootstrap.sha256));
 assert(bootstrap.entries.some(entry=>entry.path==='res://.godot/editor/script_editor_cache.cfg'));
 const resource=readPckIndex(first.packs.get(first.manifest.resources[0].sha256));assert(resource.entries.some(entry=>entry.path==='res://.godot/exported/12/export-mesh.res'));await assertArtifactSet(first);
 files.set('res://src/start.ts',text('export const n=4;'));const next=await createArtifactSet(files);assert.deepEqual(next.manifest.resources,first.manifest.resources);
 await assert.rejects(createArtifactSet(files,{groups:{bad:['res://.godot/editor/script_editor_cache.cfg']}}),/assignment/);
});
test('pack sets launch without a redundant full PCK or its receipt and capture identity before awaiting',async()=>{
 const release={releaseId:'fixture-release',profile:'full-engine-v1',execution:{artifactSetAbi:1}};
 const artifactSet=await createArtifactSet(input(),{target:{engineReleaseId:release.releaseId,engineProfile:release.profile}});
 const artifact={variant:'pack-set',artifactSet,revision:1,generation:1,buildKey:'project-input',artifactId:artifactSet.manifest.artifactSetId,manifest:{generation:1,artifactReceipt:{singlePack:'not-this-set'},packSha256:'old-single-pack'}};
 const pending=captureBrowserArtifact(artifact,release);artifact.artifactId='late-mutation';
 const captured=await pending;assert.equal(captured.pack,undefined);assert.equal(captured.artifactId,artifactSet.manifest.artifactSetId);assert.equal(browserArtifactTransfers(captured).length,artifactSet.packs.size);
 assert.equal(captured.manifest.artifactReceipt,undefined);assert.equal(captured.manifest.packSha256,undefined);
 await assert.rejects(captureBrowserArtifact({...artifact,artifactId:undefined}, {...release,execution:{}}),/E_ARTIFACT_SET_ABI/);
 await assert.rejects(captureBrowserArtifact({...artifact,artifactId:undefined}, {...release,releaseId:'other'}),/E_ARTIFACT_ENGINE_RELEASE/);
});
test('resource pack cache is independent of project build keys and cold/warm artifacts are byte identical',async()=>{
 const cache=new ProjectBuildCache(),first=await createArtifactSet(input(),{cache}),cold=await createArtifactSet(input());
 const before=cache.metrics,second=await createArtifactSet(input(),{cache});
 assert.equal(second.manifest.artifactSetId,cold.manifest.artifactSetId);assert.equal(cache.metrics.packBytesWritten,before.packBytesWritten);assert.equal(cache.metrics.packHits-before.packHits,3);
 assert.equal(cache.metrics.packBytesVerified,before.packBytesVerified,'warm verified descriptors do not hash or MD5 unchanged packages');
 assert.equal(cache.metrics.packBytesCopied-before.packBytesCopied,[...second.packs.values()].reduce((sum,bytes)=>sum+bytes.length,0),'only the public transferable output copies package bytes');
 const edited=input();edited.set('res://src/start.ts',text('export const n=3;'));
 const next=await createArtifactSet(edited,{cache});assert.deepEqual(next.manifest.resources,first.manifest.resources);
 const resource=next.manifest.resources[0];next.packs.get(resource.sha256).fill(0);
 const again=await createArtifactSet(edited,{cache});await assertArtifactSet(again);
});
