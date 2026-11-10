import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEngineApi,canonicalEngineApi,generateEngineDeclarations} from '../dist/engine-api.js';
import {engineApiFixture} from './engine-api-fixture.mjs';
import {verifyEngineTypes} from '../../../apps/playground/scripts/engine-api-typecheck.mjs';
import {readFileSync} from 'node:fs';
import {ENGINE_RUNTIME_DECLARATIONS} from '../dist/engine-api-runtime-types.js';

test('browser-safe runtime declarations match the embedded runtime revision',()=>{
 assert.equal(ENGINE_RUNTIME_DECLARATIONS,readFileSync(new URL('../../out/jsb.runtime.bundle.d.ts',import.meta.url),'utf8').replaceAll('\r\n','\n'));
 const snake=engineApiFixture(),camel=structuredClone(snake);camel.bindingNaming='camel';
 camel.classes.find(value=>value.nativeName==='Object').publicName='GObject';
 assert.doesNotMatch(generateEngineDeclarations(snake).files['/godot.annotations/index.d.ts'],/rangeInt\(/);
 assert.match(generateEngineDeclarations(camel).files['/godot.annotations/index.d.ts'],/rangeInt\(/);
 assert.equal(verifyEngineTypes(camel,generateEngineDeclarations(camel).files).status,'passed');
});

test('API snapshots preserve target data and reject malformed metadata without invoking accessors',()=>{
 const source=engineApiFixture(),parsed=parseEngineApi(source);assert.equal(canonicalEngineApi(source),canonicalEngineApi(parsed));
 source.classes[0].nativeName='mutated';assert.equal(parsed.classes[0].nativeName,'Object');
 for(const change of [a=>a.schemaVersion=2,a=>a.classes.push(a.classes[0]),a=>a.classes[0].methods[0].args=null,a=>a.builtins[0].methods.push({}),a=>a.modules.push(undefined)]){const value=engineApiFixture();change(value);assert.throws(()=>parseEngineApi(value),/E_ENGINE_API/);}
 let invoked=false;const accessor=engineApiFixture();Object.defineProperty(accessor,'unexpected',{enumerable:true,get(){invoked=true;return 1;}});assert.throws(()=>parseEngineApi(accessor),/accessors/);assert.equal(invoked,false);
});

test('API identity and generated declarations ignore set ordering but retain parameter/default ordering',()=>{
 const first=engineApiFixture(),second=structuredClone(first);second.classes.reverse();second.modules.reverse();for(const cls of second.classes)cls.methods.reverse();
 assert.equal(canonicalEngineApi(first),canonicalEngineApi(second));assert.deepEqual(generateEngineDeclarations(first).files,generateEngineDeclarations(second).files);
 const changed=structuredClone(first);changed.classes.find(c=>c.nativeName==='Node').methods.find(m=>m.nativeName==='add_child').args.reverse();assert.notEqual(canonicalEngineApi(first),canonicalEngineApi(changed));
});

test('complete declarations typecheck with libraries enabled and reject wrong native operations',()=>{
 const api=engineApiFixture(),declarations=generateEngineDeclarations(api);const report=verifyEngineTypes(api,declarations.files);
 assert.equal(report.compiler.skipLibCheck,false);assert.equal(report.status,'passed',JSON.stringify(report,null,2));
 assert.ok(report.checks.methodOnlyProperty);assert.ok(report.checks.readonly);assert.ok(report.checks.typedArray);assert.ok(report.checks.typedDictionary);
});

test('native signature replacements preserve exact returns without invalid inheritance or any widening',()=>{
 const api=engineApiFixture(),base=api.classes.find(c=>c.nativeName==='Object');base.methods.push({nativeName:'_iter_init',publicName:'_iter_init',flags:0,args:[],return:{nativeName:'',publicName:'',type:1},hasReturnValue:true,defaultArgs:[]});
 const child=structuredClone(api.classes.find(c=>c.nativeName==='Node2D'));child.nativeName=child.publicName='VariantIterator';child.parent='Object';child.methods=[{nativeName:'_iter_init',publicName:'_iter_init',flags:0,args:[],return:{nativeName:'',publicName:'',type:0,usage:131072},hasReturnValue:true,defaultArgs:[]}];child.properties=[];api.classes.push(child);
 const report=verifyEngineTypes(api,generateEngineDeclarations(api).files);assert.equal(report.status,'passed',JSON.stringify(report,null,2));
});
