import test from 'node:test';
import assert from 'node:assert/strict';
import {importProjectAssets} from '../src/project-asset-import.ts';
import {parseProject,newEngineProject,exportProject,projectCompileRequest} from '../src/project-model.ts';
import {defaultProject} from '../src/project-templates.ts';
import {compileEngineProject} from '../src/engine-project.ts';
import {createBrowserResourceConverters,BINARY_RESOURCE_TARGET_ABI} from '@godot-js/project-tools/resource-converters';

function wav(){const bytes=new Uint8Array(46),view=new DataView(bytes.buffer),text=value=>new TextEncoder().encode(value);bytes.set(text('RIFF'));view.setUint32(4,38,true);bytes.set(text('WAVEfmt '),8);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);bytes.set(text('data'),36);view.setUint32(40,2,true);bytes.set([0,128],44);return [...bytes];}

test('new Schema4 imported PNG/JPEG/WAV receive explicit production recipes with source bytes retained',()=>{
 const project=newEngineProject(),original=exportProject(project,'original'),entries=[['/assets/a.png',[1,2]],['/assets/b.jpeg',[3,4]],['/assets/c.wav',wav()],['/assets/a.png.uid','uid://bb'],['/assets/other.ogg',[5,6]]];
 importProjectAssets(project,entries);const request=projectCompileRequest(project),saved=exportProject(project);
 assert.deepEqual(request.resourceImports.map(({resource,converter})=>({resource,converter})),[{resource:'res://assets/a.png',converter:'godotjs/png-ctex'},{resource:'res://assets/b.jpeg',converter:'godotjs/jpeg-ctex'},{resource:'res://assets/c.wav',converter:'godotjs/wav-pcm'}]);
 for(const [name,bytes]of entries)assert.deepEqual(saved.files[name],bytes);assert.deepEqual(exportProject(project,'original'),original);
});

test('legacy project and explicit ImageTexture recipes/sidecars keep their original conversion semantics',()=>{
 const old=defaultProject('godot');assert.equal(old.engineDocument,undefined);importProjectAssets(old,[['/assets/a.png',[1,2]]]);assert.equal(projectCompileRequest(old).resourceImports,undefined);
 const project=parseProject({...exportProject(newEngineProject()),resourceImports:[{resource:'res://assets/legacy.png',converter:'godotjs/image-rgba'}],files:{...exportProject(newEngineProject()).files,'/assets/external.png.import':'[remap]\nuid="uid://bb"\npath="res://.godot/imported/external.ctex"\n'}});
 const metadata=project.files['/assets/external.png.import'];importProjectAssets(project,[['/assets/legacy.png',[1,2]],['/assets/external.png',[3,4]]]);
 assert.deepEqual(exportProject(project).resourceImports,[{resource:'res://assets/legacy.png',converter:'godotjs/image-rgba'}]);assert.equal(project.files['/assets/external.png.import'],metadata);
});

test('asset/recipe publication is atomic when a later file in the batch is invalid',()=>{
 const project=newEngineProject(),before=exportProject(project);
 assert.throws(()=>importProjectAssets(project,[['/assets/a.png',[1]],['/src/start.ts','duplicate']]),/已存在/);assert.deepEqual(exportProject(project),before);
 assert.throws(()=>importProjectAssets(project,[['/assets/a.png',[1]],['/assets/../bad.jpg',[2]]]),/有效/);assert.deepEqual(exportProject(project),before);
});

test('default imported WAV uses v2 binary while explicitly old text targets retain v1 producer receipts',async()=>{
 const project=newEngineProject();importProjectAssets(project,[['/assets/tone.wav',wav()]]);const input={...projectCompileRequest(project),files:project.files,resourceConverters:createBrowserResourceConverters()};
 const binary=await compileEngineProject({...input,resourceTarget:{resourceAbi:BINARY_RESOURCE_TARGET_ABI,features:{engine:'fixture'}}}),legacy=await compileEngineProject({...input,resourceTarget:{resourceAbi:'godot-4-text-resource-v1',features:{engine:'fixture'}}});
 assert.equal(binary.receipt.imports[0].converter.version,'2.0.0-rsrc6');assert.equal(binary.receipt.imports[0].converter.output.extension,'res');assert.equal(legacy.receipt.imports[0].converter.version,'1.1.0-base64');assert(legacy.receipt.imports[0].outputs.some(item=>item.path.endsWith('.tres')));
 assert.deepEqual(exportProject(project).files['/assets/tone.wav'],wav());
});
