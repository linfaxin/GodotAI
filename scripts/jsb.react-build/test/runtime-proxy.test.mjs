import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile=(source,fileName)=>ts.transpileModule(source,{fileName,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function evaluate(source,imports){const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,require:name=>{assert.ok(Object.hasOwn(imports,name),name);return imports[name];},console,Object,Reflect,Symbol});return module.exports;}
function runtime(camel){
 const member=name=>camel?name.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()):name;
 const enumValue=name=>camel?name.toLowerCase().split('_').map(s=>s[0].toUpperCase()+s.slice(1)).join(''):name;
 const values=entries=>Object.fromEntries(Object.entries(entries).map(([name,value])=>[enumValue(name),value]));
 class Node{}class Resource{}
 const captured=[];
 const godot={Node,Resource,ProxyTarget:Symbol(),FloatType:Symbol(),IntegerType:Symbol(),Variant:{Type:values({TYPE_OBJECT:24,TYPE_INT:2,TYPE_FLOAT:3,TYPE_STRING:4,TYPE_ARRAY:28})},PropertyHint:values({PROPERTY_HINT_NONE:0,PROPERTY_HINT_RANGE:1,PROPERTY_HINT_FILE:13,PROPERTY_HINT_EXP_EASING:4}),PropertyUsageFlags:values({PROPERTY_USAGE_DEFAULT:6})};
 const jsb={internal:{names:{get_class:name=>name,get_member:member,get_enum:name=>name,get_enum_value:enumValue,get_internal_mapping:name=>name},add_script_property:(prototype,info)=>captured.push(info)}};
 const lib=evaluate(compile(readFileSync(new URL('../../jsb.runtime/src/godot.lib.api.ts',import.meta.url),'utf8'),'godot.lib.api.ts'),{godot,'godot-jsb':jsb});
 const annotations=evaluate(compile(readFileSync(new URL('../../jsb.runtime/src/godot.annotations.ts',import.meta.url),'utf8'),'godot.annotations.ts'),{'godot.lib.api':lib});
 return{lib,annotations,godot,captured};
}

for(const camel of [false,true])test(`key-only proxies resolve real library keys and modern decorator helpers (${camel?'camel':'snake'})`,()=>{
 const{lib,annotations,godot,captured}=runtime(camel),bind=annotations.createClassBinder();
 for(const name of ['range_int','global_file','exp_easing'])assert.equal(typeof bind.export[name],'function');
 if(camel)for(const name of ['rangeInt','globalFile','expEasing'])assert.equal(typeof bind.export[name],'function');
 const mode=camel?'rangeInt':'range_int';
 const source=`const bind=require('godot.annotations').createClassBinder();const Node=require('godot').Node;@bind() class Fixture extends Node{@bind.export.${mode}(0,10,1) accessor health=3;}module.exports=Fixture;`;
 evaluate(compile(source,'Fixture.ts'),{godot,'godot.annotations':annotations});
 assert.equal(captured.length,1);assert.equal(captured[0].name,'health');assert.equal(captured[0].type,2);assert.equal(captured[0].hint,1);assert.equal(captured[0].hint_string,'0,10,1');
});

test('key-only proxies preserve symbols, null, undefined, primitive values and frozen-property invariants',()=>{
 const{lib,godot}=runtime(true),symbol=Symbol('key'),frozen={value:1},target={long_name:7,nil:null,missing:undefined,text:'value',flag:false,[symbol]:9};
 Object.defineProperty(target,'fixed',{value:frozen,writable:false,configurable:false});
 const proxy=lib.proxy.key_only_proxy(target);
 assert.equal(proxy.long_name,7);assert.equal(proxy.longName,7);assert.equal(proxy.nil,null);assert.equal(proxy.missing,undefined);assert.equal(proxy.notDeclared,undefined);assert.equal(proxy.text,'value');assert.equal(proxy.flag,false);assert.equal(proxy[symbol],9);assert.equal(proxy.fixed,frozen);assert.equal(proxy[godot.ProxyTarget],target);
 for(const value of [null,undefined,0,'value',false,symbol])assert.equal(lib.proxy.key_only_proxy(value),value);
});
