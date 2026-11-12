import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildShell,createTypeSnapshot} from './build-shell.mjs';
import {collectManifestPayloads} from './profile-resources.mjs';
import {prepareAssets} from './prepare-assets.mjs';
import {buildDemoRuntime} from './build-demo-runtime.mjs';
import {prepareSiteDelivery} from './prepare-site-delivery.mjs';
import {createStaticServer} from './serve.mjs';
import {digest} from './site-evidence.mjs';
import {packProject} from '@godot-js/react-browser/pck';

test('shell contract build succeeds without engine resources and publishes only selected example projects',{timeout:60000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'2d-shell-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await buildShell(root,{runtimeProfile:'engine-2d-v1',shellOnly:true});
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'shell-profile.json'),'utf8')),{schemaVersion:2,runtimeProfile:'engine-2d-v1',shellOnly:true});
 const names=await readdir(root);
 assert(!names.includes('engine'));assert(!names.includes('engine-release.json'));assert(!names.includes('demo-release.json'));assert(!names.includes('demo-resources.pck'));
 const examples=await readdir(path.join(root,'examples'));
 assert.deepEqual(examples.sort(),['dungeon.project.json','lights.project.json','match3.project.json','shader.project.json']);
 for(const name of examples){const project=JSON.parse(await readFile(path.join(root,'examples',name),'utf8'));assert.equal(project.schemaVersion,3);assert.equal(project.engineProfile,'engine-2d-v1');assert.equal(project.demoApiVersion,1);}
 assert.equal(JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8')).length,4);
});

test('product refresh never treats absent resources as a shell fixture and shell mode cannot overwrite a release',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'product-refresh-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(buildShell(root,{shellOnly:false}),/existing engine release/);
 assert.deepEqual(await readdir(root),[]);
 await writeFile(path.join(root,'engine-release.json'),JSON.stringify({schemaVersion:2,runtimeProfile:'engine-2d-v1',id:'unchanged'}));
 await assert.rejects(buildShell(root,{shellOnly:true}),/without an engine release/);
 assert.equal(JSON.parse(await readFile(path.join(root,'engine-release.json'),'utf8')).id,'unchanged');
});

test('candidate payloads bind editor and resource metadata while excluding the entry manifest and transport sidecars',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'candidate-payloads-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [name,body]of Object.entries({'main.js':'editor-v1','preview.js':'preview','index.html':'editor','shell-profile.json':'profile','resource-build.json':'receipt','manifest.json':'entry','main.js.br':'compressed','delivery-manifest.json':'derived delivery','site-acceptance.json':'derived receipt'}))await writeFile(path.join(root,name),body);
 const before=await collectManifestPayloads(root);
 assert.deepEqual(Object.keys(before).sort(),['index.html','main.js','preview.js','resource-build.json','shell-profile.json']);
 await writeFile(path.join(root,'main.js'),'editor-v2');const after=await collectManifestPayloads(root);
 assert.notEqual(before['main.js'].sha256,after['main.js'].sha256);
 await writeFile(path.join(root,'main.js.br'),'changed sidecar');assert.deepEqual(await collectManifestPayloads(root),after);
});

test('prepared product frontend refresh invalidates stale variants and can prepare a consistent new candidate',{timeout:120000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'refresh-delivery-')),site=path.join(root,'site'),project=path.join(root,'project');t.after(()=>rm(root,{recursive:true,force:true}));
 const runtimeProfile='engine-2d-v1',engineReleaseId='fixture-native-2d';
 const assets=await prepareAssets({runtimeProfile,project,workDirectory:path.join(root,'conversion')});
 const resources=new Map();
 for(const asset of Object.values(assets))resources.set(asset.uri,new Uint8Array(await readFile(path.join(project,asset.uri.slice(6)))));
 for(const name of await readdir(path.join(project,'shaders')))resources.set('res://shaders/'+name,new Uint8Array(await readFile(path.join(project,'shaders',name))));
 await mkdir(path.join(site,'engine'),{recursive:true});await mkdir(path.join(site,'resource-inputs/generated'),{recursive:true});
 const pck=packProject(resources).pack;await writeFile(path.join(site,'engine/game.pck'),pck);
 await copyFile(path.join(project,'generated/assets.js'),path.join(site,'resource-inputs/generated/assets.js'));
 const engineFiles={'/godot/index.d.ts':'export class Node2D {}','/godot-jsb/index.d.ts':'export {};','/godot.annotations/index.d.ts':'export {};'};
 const typeSnapshot=await createTypeSnapshot({engineFiles});await writeFile(path.join(site,'declarations.json'),JSON.stringify(engineFiles));
 await writeFile(path.join(site,'engine-release.json'),JSON.stringify({schemaVersion:2,runtimeProfile,id:engineReleaseId,api:{typeSnapshot:{path:'types.json'},typeSnapshotHash:digest(typeSnapshot),declarationsSnapshot:{path:'declarations.json'}}}));
 const demo=await buildDemoRuntime(site,{runtimeProfile,project:path.join(site,'resource-inputs')});
 await writeFile(path.join(site,'resource-build.json'),JSON.stringify({runtimeProfile,engineReleaseId,output:{sha256:digest(pck)},generatedManifest:{sha256:digest(await readFile(path.join(site,'resource-inputs/generated/assets.js')))},demoPack:{sha256:demo.resources.sha256}}));
 await writeFile(path.join(site,'main.js'),'// old editor\n'+('oldEditor();\n'.repeat(1024)));
 await writeFile(path.join(site,'retired.js'),'retired();\n'.repeat(1024));
 await writeFile(path.join(site,'manifest.json'),JSON.stringify({schemaVersion:2,runtimeProfile,engineReleaseId,payloads:await collectManifestPayloads(site)}));
 await prepareSiteDelivery(site,{gzipLevel:1,brotliQuality:1});
 await access(path.join(site,'main.js.br'));await access(path.join(site,'retired.js.gz'));
 await rm(path.join(site,'retired.js')); // The report also identifies orphaned generated variants.
 const previousCandidate=digest(await readFile(path.join(site,'manifest.json')));
 await buildShell(site,{runtimeProfile,shellOnly:false});
 for(const name of ['delivery-manifest.json','main.js.br','main.js.gz','retired.js.br','retired.js.gz'])await assert.rejects(access(path.join(site,name)),{code:'ENOENT'});
 const refreshedBytes=await readFile(path.join(site,'manifest.json')),refreshed=JSON.parse(refreshedBytes);
 assert.notEqual(digest(refreshedBytes),previousCandidate);
 assert.equal(refreshed.payloads['delivery-manifest.json'],undefined);assert.equal(refreshed.payloads['site-acceptance.json'],undefined);
 for(const [name,descriptor]of Object.entries(refreshed.payloads))assert.equal(digest(await readFile(path.join(site,name))),descriptor.sha256,name);
 const server=createStaticServer(site);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url='http://127.0.0.1:'+server.address().port+'/main.js',raw=await readFile(path.join(site,'main.js'));
  const before=await fetch(url,{headers:{'accept-encoding':'br,gzip'}});assert.equal(before.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await before.arrayBuffer()),raw);
  await prepareSiteDelivery(site,{gzipLevel:1,brotliQuality:1});
  assert.deepEqual(await readFile(path.join(site,'manifest.json')),refreshedBytes);
  assert.deepEqual(await collectManifestPayloads(site),refreshed.payloads);
  const after=await fetch(url,{headers:{'accept-encoding':'br,gzip'}});assert.equal(after.headers.get('content-encoding'),'br');assert.deepEqual(Buffer.from(await after.arrayBuffer()),raw);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
