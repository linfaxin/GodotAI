import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProject,filePath,addProjectFiles,renameProjectFile} from '../src/project-model.ts';
const input=()=>({schemaVersion:1,demoId:'shader',entry:'/src/App.tsx',selected:'/README.md',files:{'/src/App.tsx':'export default function App(){return null;}','/README.md':'说明','/assets/image.png':[0,128,255]},controls:{speed:1},mode:'development'});
test('project import round-trips text, binary attachments, selection and runtime settings',()=>{
 const source=input(),project=parseProject(JSON.parse(JSON.stringify(source)));assert.deepEqual(project,source);
 project.files['/assets/image.png'][0]=42;assert.equal(source.files['/assets/image.png'][0],0);
 const legacy=parseProject({files:source.files,config:{entry:'/src/App.tsx',mode:'development'}});assert.equal(legacy.entry,'/src/App.tsx');assert.equal(legacy.mode,'development');
});
test('invalid imports cannot introduce path traversal, duplicate files or a missing entry',()=>{
 for(const value of [{...input(),entry:'/missing.tsx'},{...input(),files:{'/src/../App.tsx':'x'}},{...input(),files:{'src/App.tsx':'x','/src/App.tsx':'y'}},{...input(),files:{...input().files,'/assets/bad.png':[-1]}},{...input(),controls:{speed:Infinity}}])assert.throws(()=>parseProject(value));
 assert.equal(filePath('src/组件.tsx'),'/src/组件.tsx');assert.throws(()=>filePath('src/../../outside.tsx'));
});
test('project file limits reject oversized imports before changing caller data',()=>{
 const source=input();source.files={...source.files,...Object.fromEntries(Array.from({length:65},(_,i)=>['/notes/'+i+'.txt','x']))};const before=JSON.stringify(source);assert.throws(()=>parseProject(source),/64/);assert.equal(JSON.stringify(source),before);
});
test('original exported documents retain source, selection and configuration',()=>{
 const source=input();const {files,selected,entry,mode}=source;
 const project=parseProject({schemaVersion:1,runtimeRelease:'original-release',project:{config:{entry,mode,profileId:'core-ui-v1'},files,selected}});
 assert.deepEqual(project.files,files);assert.equal(project.entry,entry);assert.equal(project.selected,selected);assert.equal(project.mode,mode);
});
test('unchanged rename preserves the entry and attachments; invalid renames are atomic',()=>{
 const project=input(),before=structuredClone(project);
 assert.equal(renameProjectFile(project,project.entry,project.entry),false);assert.deepEqual(project,before);
 for(const path of ['/README.md','/src/App.txt']){assert.throws(()=>renameProjectFile(project,project.entry,path));assert.deepEqual(project,before);}
 assert.equal(renameProjectFile(project,project.entry,'src/Renamed.tsx'),true);assert.equal(project.entry,'/src/Renamed.tsx');assert.equal(project.files[project.entry],before.files[before.entry]);assert.ok(!Object.hasOwn(project.files,before.entry));
});
test('asset batches enforce file count, duplicates and total UTF-8 bytes without partial writes',()=>{
 const project=input(),before=structuredClone(project);
 const tooMany=Array.from({length:62},(_,i)=>['/assets/'+i+'.png',[0,128,255]]);
 for(const additions of [tooMany,[['/assets/a.png',[1]],['/assets/a.png',[2]]],[['/assets/a.png',[1]],['/assets/huge.tres','界'.repeat(2796203)]]]){
  assert.throws(()=>addProjectFiles(project,additions));assert.deepEqual(project,before);
 }
 const valid=tooMany.slice(0,61);addProjectFiles(project,valid);assert.equal(Object.keys(project.files).length,64);assert.deepEqual(parseProject(project),project);
});
