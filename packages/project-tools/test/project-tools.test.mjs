import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createSourceSnapshot,createBuildPlan,adaptLegacyLaunch,prepareBuildPlan,packBuildPlan,snapshotFiles} from '../dist/build-plan.js';
import {prepareEngineProject} from '../dist/engine-project.js';
import {hashBytes,hashJson,canonicalJson} from '../dist/hash.js';
import {createEngineProjectDocument,readProjectDocument,writeProjectDocument,exportOriginalDocument} from '../dist/project-document.js';
import {createImportReceipt,assessImportReceipt,requireFreshImports} from '../dist/import-receipts.js';
const enc=new TextEncoder(),dec=new TextDecoder();
const scene='[gd_scene format=3 uid="uid://bb"]\n[node name="Main" type="Node"]\n';
const files=()=>({'/project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\nconfig/name="untouched"\n','/main.tscn':scene,'/other.tscn':'[gd_scene format=3]\n[node name="Other" type="Node"]\n','/src/main.ts':'export function start(ctx: any){ return () => {}; }','/asset.bin':[0,255,64]});

test('snapshots own immutable bytes and content identity ignores input ordering',async()=>{
 const input=files(),snapshot=await createSourceSnapshot(input);input['/asset.bin'][0]=99;
 assert.deepEqual(snapshotFiles(snapshot)['res://asset.bin'],[0,255,64]);
 assert.throws(()=>snapshot.files[0].bytes.push(3),TypeError);
 assert.equal(snapshot.sourceHash,(await createSourceSnapshot(Object.fromEntries(Object.entries(files()).reverse()))).sourceHash);
 await assert.rejects(createSourceSnapshot({'/A.ts':'','/a.ts':''}),/collide/);
 await assert.rejects(createSourceSnapshot({'../escape':'x'}),/Invalid path/);
 for(const value of [undefined,{x:undefined},NaN,()=>{},new Date(),{get x(){return 1;}}])assert.throws(()=>canonicalJson(value),/JSON/);
 assert.equal(await hashJson({b:2,a:1}),await hashJson({a:1,b:2}));
});

test('scene and script launches are explicit and source/UID/packed bytes retain their meaning',async()=>{
 const input=files(),snapshot=await createSourceSnapshot(input),inputs={engineId:'e'.repeat(64),options:{mode:'production'}};
 const scenePlan=await createBuildPlan(snapshot,{kind:'scene',source:'project'},{inputs});
 assert.throws(()=>scenePlan.inputs.options.mode='development',TypeError);
 const original=await prepareBuildPlan(scenePlan);assert.equal(dec.decode(original.prepared.files.get('res://project.godot')),input['/project.godot']);
 const override=await createBuildPlan(snapshot,{kind:'scene',source:'override',path:'res://other.tscn'},{inputs});
 const packed=await packBuildPlan(override);
 assert.match(dec.decode(packed.prepared.files.get('res://project.godot')),/other.tscn/);
 assert.equal(snapshotFiles(snapshot)['res://project.godot'],input['/project.godot']);
 assert(packed.overlay.entries.some(value=>value.path==='res://project.godot'&&value.disposition==='replaced'&&value.inputHash&&value.outputHash));
 assert(packed.overlay.entries.some(value=>value.path==='res://main.tscn'&&value.disposition==='unchanged'));
 const binary=packed.index['res://asset.bin'];assert.deepEqual([...packed.pack.slice(binary.offset,binary.offset+binary.size)],[0,255,64]);
 assert.equal(packed.receipt.packSha256,await hashBytes(packed.pack));assert(!packed.prepared.files.has('artifactId'));
 const script=await prepareBuildPlan(await createBuildPlan(snapshot,{kind:'script',module:'/src/main.ts'}));
 assert.match(dec.decode(script.prepared.files.get('res://.playground/engine-bootstrap.ts')),/Script entry must export a start function/);
 assert.match(dec.decode(script.prepared.files.get('res://project.godot')),/engine-bootstrap.tscn/);
 assert.equal(script.plan.launch.export,'start');
 const uidInput={...input,'/project.godot':'[application]\nrun/main_scene="uid://bb"\n'};
 const uidPlan=await createBuildPlan(await createSourceSnapshot(uidInput),{kind:'scene',source:'project'});
 const uidResult=await prepareBuildPlan(uidPlan);
 assert.equal(dec.decode(uidResult.prepared.files.get('res://main.tscn')),scene);
 assert.equal(dec.decode(uidResult.prepared.files.get('res://project.godot')),uidInput['/project.godot']);
 await assert.rejects(createBuildPlan(snapshot,{kind:'scene',source:'override',path:'res://missing.tscn'}),/missing/);
});

test('legacy launch adapters retain React component priority and native scene priority',async()=>{
 const input=files();input['/src/App.tsx']='export default function App(){return null}';
 const react=await adaptLegacyLaunch({schemaVersion:3,runtime:'react',entry:'/src/App.tsx',mainScene:'res://other.tscn',files:input});
 assert.deepEqual(react.launch,{kind:'script',module:'res://src/App.tsx',export:'default'});
 assert.equal(react.compatibility.runtime,'react');await assert.rejects(prepareBuildPlan(react),/adapter/);
 const native=await adaptLegacyLaunch({schemaVersion:3,runtime:'godot',entry:'/src/main.ts',files:input});
 assert.deepEqual(native.launch,{kind:'scene',source:'project'});
 const override=await adaptLegacyLaunch({schemaVersion:2,runtime:'godot',entry:'/src/main.ts',mainScene:'res://other.tscn',files:input});
 assert.deepEqual(override.launch,{kind:'scene',source:'override',path:'res://other.tscn'});
 const binary=await adaptLegacyLaunch({schemaVersion:3,runtime:'godot',files:{'/project.binary':[1,2,3],'/native.scn':[4,5,6]}});
 const result=await prepareBuildPlan(binary);assert.equal(result.prepared.manifest.projectSettings,'binary');assert.deepEqual([...result.prepared.files.get('res://project.binary')],[1,2,3]);
});

test('new schema has one launch; legacy reads never become new writes or lose original JSON',async()=>{
 const doc=await createEngineProjectDocument({files:files(),launch:{kind:'scene',source:'project'},editor:{selected:'/src/main.ts'}});
 const text=await writeProjectDocument(doc),parsed=await readProjectDocument(text);
 assert.equal(parsed.schemaVersion,4);assert.deepEqual(parsed.document,doc);assert.equal(exportOriginalDocument(parsed),text);
 const legacy='  '+JSON.stringify({schemaVersion:3,runtime:'godot',entry:'/src/main.ts',files:files()})+'\n';
 const old=await readProjectDocument(legacy);assert.equal(exportOriginalDocument(old),legacy);assert.equal(old.document,undefined);
 await assert.rejects(writeProjectDocument(old.originalDocument),/automatic migration is disabled/);
 await assert.rejects(readProjectDocument({...doc,launch:{kind:'script',module:'/src/main.ts',path:'res://main.tscn'}}),/mutually exclusive/);
 await assert.rejects(readProjectDocument({...doc,mainScene:'res://other.tscn'}),/explicit launch/);
});

test('supplied multi-source maps preserve source indices and source contents',()=>{
 const map={version:3,file:'input.js',sourceRoot:'../sources/',sources:['first.ts','second.ts'],sourcesContent:['export const a=1','export const b=2'],names:[],mappings:'AAAA;ACAA'};
 const result=prepareEngineProject({runtime:'engine',files:files(),generatedJs:{'/src/main.ts':'exports.start=()=>{};','/src/main.ts.map':JSON.stringify(map)}});
 const supplied=JSON.parse(dec.decode(result.files.get('res://.godot/GodotJS/src/main.js.map')));
 assert.deepEqual(supplied.sources,['res://sources/first.ts','res://sources/second.ts']);
 assert.deepEqual(supplied.sourcesContent,map.sourcesContent);assert.equal(supplied.mappings,map.mappings);
});

test('resource receipts track conversion inputs, target, parameters, dependencies and outputs',async()=>{
 const sources=new Map([['res://image.png',enc.encode('png')],['res://palette.json',enc.encode('palette')]]),outputs=new Map([['res://.godot/imported/image.ctex',enc.encode('converted')]]);
 const inspection={resource:'res://image.png',uid:'uid://bb',files:sources,converter:{id:'png-to-ctex',version:'1'},target:{resourceAbi:'godot/4.6',features:{compression:'lossless'}},parameters:{scale:1},sourcePaths:[...sources.keys()]};
 const receipt=await createImportReceipt({...inspection,outputFiles:outputs,outputPaths:[...outputs.keys()]});
 const document=await createEngineProjectDocument({files:files(),launch:{kind:'scene',source:'project'},importReceipts:[receipt]});
 assert.deepEqual((await readProjectDocument(await writeProjectDocument(document))).document.importReceipts,[receipt]);
 const current={...inspection,outputFiles:outputs};assert.equal((await assessImportReceipt(receipt,current)).status,'fresh');
 assert.equal((await assessImportReceipt(undefined,current)).status,'unverified');
 for(const changed of [
  {...current,converter:{...inspection.converter,version:'2'}},
  {...current,target:{...inspection.target,resourceAbi:'godot/next'}},
  {...current,parameters:{scale:2}},
  {...current,sourcePaths:['res://image.png']},
  {...current,files:new Map([...sources,['res://palette.json',enc.encode('changed')]])},
  {...current,files:new Map([...sources,['res://image.png',enc.encode('changed')]])},
  {...current,outputFiles:new Map()},
 ]){
  const status=await assessImportReceipt(receipt,changed);assert.equal(status.status,'stale');assert.throws(()=>requireFreshImports([status]),/reimport/);
 }
 const snapshot=await createSourceSnapshot({...files(),'/image.png':[...sources.get('res://image.png')],'/palette.json':[...sources.get('res://palette.json')],'/.godot/imported/image.ctex':[...outputs.values()][0]});
 const plan=await createBuildPlan(snapshot,{kind:'scene',source:'project'});
 const {files:_,outputFiles:__,...bound}=current;
 await prepareBuildPlan(plan,{importChecks:[{receipt,inspection:bound}]});
 const unknown=await prepareBuildPlan(plan,{importChecks:[{inspection:bound}]});
 assert.equal(unknown.imports[0].status,'unverified');assert(unknown.prepared.diagnostics.some(value=>value.code==='W_ENGINE_IMPORT_UNVERIFIED'));
 await assert.rejects(prepareBuildPlan(plan,{importChecks:[{receipt,inspection:{...bound,parameters:{scale:2}}}]}),/E_IMPORT_STALE/);
});

test('native project tool bundle contains no React, DOM host or application imports',async()=>{
 const output=await build({entryPoints:[new URL('../dist/build-plan.js',import.meta.url).pathname],bundle:true,write:false,metafile:true,platform:'neutral',format:'esm',external:['typescript','spark-md5']});
 assert(!Object.keys(output.metafile.inputs).some(value=>/scripts\/jsb\.react|apps\/playground/.test(value)));
 assert(!output.outputFiles[0].text.includes("from 'react'"));
 assert(!Object.keys(output.metafile.inputs).some(value=>/verified-loader|runner|preview/.test(value)));
});
