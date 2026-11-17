import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {newEngineReactProject,defaultProject,demoProject} from '../src/project-templates.ts';
import {parseProject,exportProject,projectCompileRequest} from '../src/project-model.ts';
import {createProjectStorage} from '../src/project-storage.ts';
import {projectRuntimeDependencies} from '../src/project-runtime-dependencies.ts';
import {compileEngineProject} from '../src/engine-project.ts';
import {database} from './project-storage-fixture.mjs';
import {createTypeSnapshot} from './build-shell.mjs';
import {buildEngineVendor,FULL_ENGINE_MODULE_EXPORTS,runtimeModuleSource} from './full-engine-release.mjs';
import {ENGINE_SDK_MODULES} from '@godot-js/react/engine-modules';
import {createSourceSnapshot,createBuildPlan} from '@godot-js/project-tools/build-plan';
import {createCompilerEnvironment,compileProject} from '@godot-js/project-tools/compiler';
import {generateEngineDeclarations} from '@godot-js/engine/api';
import {engineApiFixture} from '../../../packages/engine/test/fixtures/engine-api-fixture.mjs';

const readPacked=(artifact,path)=>{
 const file=artifact.index[path];assert(file,path);
 return new TextDecoder().decode(artifact.pack.subarray(file.offset,file.offset+file.size));
};

test('new React projects export ordinary Schema4 script startup while old component templates retain their contract',()=>{
 for(const profile of ['full-engine-v1','engine-2d-v1']){
  const project=newEngineReactProject(profile),document=exportProject(project),request=projectCompileRequest(project);
  assert.equal(document.schemaVersion,4);assert.equal(document.runtime,'engine');assert.equal(document.engineProfile,profile);
  assert.deepEqual(request,{runtime:'engine',launch:{kind:'script',module:'res://src/start.ts',export:'start'}});
  assert.equal(project.entry,'/src/start.ts');assert.equal(project.selected,'/src/App.tsx');assert.equal(project.mainScene,undefined);
  assert.equal(document.entry,undefined);assert.equal(document.mainScene,undefined);assert.equal(document.editor.selected,'/src/App.tsx');
  assert.match(project.files[project.entry],/createRoot\(ctx.mount, \{entry: ctx.entry, runtimeHost: ctx.host\}\)/);
  assert.match(project.files[project.entry],/entry\?: EngineEntryCapability/);
  assert.match(project.files[project.entry],/return \(\) => root.shutdown\(\)/);
  assert.equal(projectRuntimeDependencies(project.files).react,true);assert.equal(projectRuntimeDependencies(project.files).demo,false);
  assert.deepEqual(projectCompileRequest(parseProject(JSON.parse(JSON.stringify(document)))),request);
  const again=newEngineReactProject(profile);project.files['/src/App.tsx']='edited';assert.notEqual(again.files['/src/App.tsx'],'edited');
 }
 const legacy=defaultProject('react');assert.equal(legacy.engineDocument,undefined);assert.equal(legacy.runtime,'react');
 assert.equal(exportProject(legacy).schemaVersion,3);assert.equal(legacy.entry,'/src/App.tsx');
 const demo=demoProject({id:'old-demo',file:'Demo.tsx',source:'export default function Demo(){return null}',name:'Demo',hint:'kept',controls:[]});
 assert.equal(demo.engineDocument,undefined);assert.equal(projectCompileRequest(demo).runtime,'react');assert.equal(demo.entry,'/src/Demo.tsx');
});

test('React template saves both authored files, reloads explicit startup and restores the original versioned snapshot',async()=>{
 const template=newEngineReactProject('engine-2d-v1'),original=exportProject(template,'original');
 const db=database({projects:[],versions:{}}),storage=createProjectStorage(Promise.resolve(db));
 storage.stage('react',template);assert.deepEqual((await storage.save('react')).conflicts,[]);
 const first=structuredClone(db.records.get('current')),stored=new Map(first.projects).get('react');
 assert.equal(first.versions.react,1);assert.equal(stored.kind,'godotjs-editor-schema4');assert.equal(stored.project.runtime,'engine');
 assert.equal(stored.project.launch.module,'res://src/start.ts');assert.deepEqual(stored.originalDocument,original);
 const loaded=await storage.load();assert.deepEqual(loaded.migrated,[]);assert.equal(loaded.invalid.size,0);
 const edited=new Map(loaded.snapshot.projects).get('react');
 edited.files['/src/App.tsx']=edited.files['/src/App.tsx'].replace('Hello React + Godot','Saved React greeting');
 edited.files['/src/start.ts']+='\nexport const savedEntryRevision = 2;\n';edited.selected='/src/start.ts';
 storage.stage('react',edited);await storage.save('react');const second=structuredClone(db.records.get('current'));
 const fresh=createProjectStorage(Promise.resolve(db)),reloaded=new Map((await fresh.load()).snapshot.projects).get('react');
 assert.equal(reloaded.selected,'/src/start.ts');assert.match(reloaded.files['/src/App.tsx'],/Saved React greeting/);
 assert.match(reloaded.files['/src/start.ts'],/savedEntryRevision = 2/);assert.deepEqual(exportProject(reloaded,'original'),original);
 assert.deepEqual(projectCompileRequest(reloaded),projectCompileRequest(template));
 const restored=await fresh.restore(first);assert.deepEqual(restored.conflicts,[]);assert.equal(restored.snapshot.versions.react,3);
 const recovered=new Map((await fresh.load()).snapshot.projects).get('react');
 assert.equal(recovered.selected,'/src/App.tsx');assert.deepEqual(recovered.files,template.files);
 assert.deepEqual(projectCompileRequest(recovered),projectCompileRequest(template));assert.deepEqual(exportProject(recovered,'original'),original);
 assert.deepEqual(db.records.get('recovery'),second);
});

const typings=new URL('../../../tests/project/typings/',import.meta.url);
const nativeFiles=(await readdir(typings).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).filter(name=>/^godot\d+\.gen\.d\.ts$/.test(name)).sort();
async function rendererEnvironment(actual=false){
 let engineFiles;
 if(actual){
  // Native integration uses the exact declarations generated by the engine.
  assert(nativeFiles.length>0);
  engineFiles={
   '/godot/index.d.ts':(await Promise.all(nativeFiles.map(name=>readFile(new URL(name,typings),'utf8')))).join('\n'),
   '/godot-jsb/index.d.ts':await readFile(new URL('godot.minimal.d.ts',typings),'utf8'),
   '/godot.annotations/index.d.ts':await readFile(new URL('jsb.runtime.gen.d.ts',typings),'utf8'),
  };
 }else{
  // Clean-checkout contracts generate their own declarations through the
  // production code generator; they do not depend on ignored native outputs.
  const ir=engineApiFixture(),node=ir.classes.find(item=>item.nativeName==='Node');
  ir.classes.push({...structuredClone(node),nativeName:'Label',publicName:'Label',parent:'Node',methods:[],signals:[],enums:[],constants:[],
   properties:[{nativeName:'text',publicName:'text',type:4,class_name:'',hint:0,hint_string:'',usage:6,binding:'property',getter:'get_text',setter:'set_text'}]});
  const generated=generateEngineDeclarations(ir);assert.deepEqual(generated.diagnostics,[]);engineFiles=generated.files;
 }
  const declarations=JSON.parse(await createTypeSnapshot({engineFiles}));
  const moduleDeclarations={godot:'/godot/index.d.ts','godot-jsb':'/godot-jsb/index.d.ts','godot.annotations':'/godot.annotations/index.d.ts',
   ...Object.fromEntries(Object.entries(ENGINE_SDK_MODULES).map(([name,value])=>[name,value.declaration]))};
  const runtimeModules=Object.fromEntries(Object.entries(FULL_ENGINE_MODULE_EXPORTS).map(([name,key])=>[name,new TextEncoder().encode(runtimeModuleSource(key))]));
  return createCompilerEnvironment({target:{engineProfile:'engine-2d-v1',naming:'snake'},declarations,moduleDeclarations,runtimeModules,vendor:await buildEngineVendor()});
}

async function checkReactTemplate(actual){
 const project=newEngineReactProject('engine-2d-v1'),source=structuredClone(project.files),request=projectCompileRequest(project),environment=await rendererEnvironment(actual);
 const plan=await createBuildPlan(await createSourceSnapshot(project.files),request.launch);
 const checked=await compileProject({plan,environment,pack:{maxBytes:64*1024*1024,maxFiles:10000}});assert.deepEqual(checked.diagnostics,[]);assert.equal(checked.plan.compatibility,undefined);
 const browser=await compileEngineProject({...request,files:project.files,compilerEnvironment:environment});
 assert.equal(browser.buildKey,checked.buildKey);assert.equal(browser.artifactId,checked.artifactId);assert.deepEqual(browser.pack,checked.pack);
 assert.match(readPacked(checked,'res://.playground/engine-bootstrap.ts'),/Script entry must export a start function/);
 assert.doesNotMatch(readPacked(checked,'res://.playground/engine-bootstrap.ts'),/EngineReact\.createRoot/);
 assert.match(readPacked(checked,'res://.godot/GodotJS/src/start.js'),/exports.start = start/);
 assert.match(readPacked(checked,'res://.godot/GodotJS/src/start.js'),/node_modules\/@godot-js\/react\/engine\/index.js/);
 assert.match(readPacked(checked,'res://.godot/GodotJS/src/App.js'),/Hello React \+ Godot/);
 for(const [path,text]of Object.entries(source))if(path!=='/project.godot')assert.equal(readPacked(checked,'res:/'+path),text);
 assert.match(readPacked(checked,'res://project.godot'),/run\/main_scene="res:\/\/\.playground\/engine-bootstrap.tscn"/);
 assert.deepEqual(project.files,source);assert(checked.receipt.packSha256);assert(checked.index['res://.playground/vendor.js']);
 const badFiles={...source,'/src/App.tsx':source['/src/App.tsx'].replace('text: "Hello React + Godot"','text: 42')};
 const invalid=await createBuildPlan(await createSourceSnapshot(badFiles),request.launch);
 await assert.rejects(compileProject({plan:invalid,environment}),error=>error.diagnostics?.some(item=>item.category==='error'&&item.file==='/src/App.tsx'&&/number/.test(item.message)));
}
test('React Schema4 template passes the shared checked compiler with production renderer modules and generated fixture types',{timeout:45000},()=>checkReactTemplate(false));
test('React Schema4 template also compiles against actual generated native declarations',{timeout:45000,skip:nativeFiles.length?false:'Native declarations require a matching engine build'},()=>checkReactTemplate(true));
