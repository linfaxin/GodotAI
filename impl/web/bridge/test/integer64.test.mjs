import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
const librarySource=readFileSync(new URL('../../js/library_godotjs_jsbi.js',import.meta.url),'utf8');
function runtime(){
 const memory=new WebAssembly.Memory({initial:1,maximum:4});
 const context=vm.createContext({console,wasmMemory:memory,updates:0});
 context.updateMemoryViews=()=>{context.HEAP8=new Int8Array(memory.buffer);context.HEAPU8=new Uint8Array(memory.buffer);context.HEAP32=new Int32Array(memory.buffer);context.updates++;};
 context.updateMemoryViews();context.updates=0;vm.runInContext(source,context);
 return {context,memory,run:code=>vm.runInContext(code,context)};
}

test('actual Emscripten library predicates distinguish signed, unsigned and wide integers',()=>{
 const context=vm.createContext({LibraryManager:{library:{}},mergeInto:(target,entries)=>Object.assign(target,entries)});
 context._jsbb_={GetEngine(){return {stack:{GetValue(){return context.value;}}};}};
 vm.runInContext(librarySource,context);
 const functions=context.LibraryManager.library;
 const values=[
  [-2147483649,false,false],[-2147483648,true,false],[-1,true,false],[-0,true,true],[0,true,true],
  [2147483647,true,true],[2147483648,false,true],[4294967295,false,true],[4294967296,false,false],
  [-4294967296,false,false],[Number.MAX_SAFE_INTEGER,false,false],[-Number.MAX_SAFE_INTEGER,false,false],
  [Number.MAX_SAFE_INTEGER+1,false,false],[-Number.MAX_SAFE_INTEGER-1,false,false],
  [3.75,false,false],[NaN,false,false],[Infinity,false,false],[-Infinity,false,false],
  [1n,false,false],['1',false,false],[undefined,false,false],
 ];
 for(const [value,signed,unsigned]of values){context.value=value;assert.equal(functions.jsbi_IsInt32(1,0),signed,'int32 '+String(value));assert.equal(functions.jsbi_IsUint32(1,0),unsigned,'uint32 '+String(value));}
});

test('real bridge creates the int64 view before the first memory growth',()=>{
 const {context,run}=runtime();context.value=9007199254740993n;
 assert.equal(run("jsbb_Engine.prototype.Int64Value.call({_stack:{GetValue(){return value}}},0,8)"),true);
 assert.equal(run('_jsbb_.i64[1]'),9007199254740993n);
 context.value=-9007199254740993n;
 assert.equal(run("jsbb_Engine.prototype.Int64Value.call({_stack:{GetValue(){return value}}},0,8)"),true);
 assert.equal(run("jsbb_Engine.prototype.NewBigInt64.call({_stack:{Push(value){return value}}},8)"),-9007199254740993n);
 assert.equal(context.updates,0);
});

test('int64 view refreshes after growth even if Emscripten already refreshed HEAP8',()=>{
 const {context,memory,run}=runtime();run('_jsbb_.i64[1]=7n;globalThis.original=_jsbb_.i64');
 memory.grow(1);context.updateMemoryViews();context.updates=0;
 assert.equal(run('_jsbb_.i64.buffer===wasmMemory.buffer'),true);
 assert.equal(run('_jsbb_.i64===original'),false);assert.equal(run('_jsbb_.i64[1]'),7n);
 assert.equal(context.updates,0);
});

test('int64 view also updates stale Emscripten views after growth',()=>{
 const {context,memory,run}=runtime();run('_jsbb_.i64[1]=11n');memory.grow(1);
 assert.equal(run('_jsbb_.i64.buffer===wasmMemory.buffer'),true);assert.equal(context.updates,1);
 assert.equal(run('_jsbb_.i64[1]'),11n);
});

test('signed int64 boundaries roundtrip, overflow and non-BigInt input leave memory unchanged',()=>{
 const {context,run}=runtime();
 const write=()=>run('jsbb_Engine.prototype.Int64Value.call({_stack:{GetValue(){return value}}},0,8)');
 for(const value of [-(1n<<63n),(1n<<63n)-1n]){context.value=value;assert.equal(write(),true);assert.equal(run('_jsbb_.i64[1]'),value);}
 run('_jsbb_.i64[1]=42n');
 for(const value of [-(1n<<63n)-1n,1n<<63n,1,NaN,Infinity,'12',undefined]){context.value=value;assert.equal(write(),false);assert.equal(run('_jsbb_.i64[1]'),42n);}
});

test('actual read/write helpers use unsigned high-address indices without a 2 GiB allocation',()=>{
 const {context,run}=runtime();context.wasmMemory={buffer:{byteLength:0x100000000}};context.values={};context.value=-17n;
 run("Object.defineProperty(_jsbb_,'i64',{get(){return values}})");
 assert.equal(run('_jsbb_.int64_index(0x80000000)'),0x10000000);
 assert.equal(run('_jsbb_.int64_index(-2147483648)'),0x10000000);
 assert.equal(run('jsbb_Engine.prototype.Int64Value.call({_stack:{GetValue(){return value}}},0,-2147483648)'),true);
 assert.equal(context.values[0x10000000],-17n);
 assert.equal(run('jsbb_Engine.prototype.NewBigInt64.call({_stack:{Push(value){return value}}},0x80000000)'),-17n);
 assert.equal(run('_jsbb_.int64_index(0xfffffff8)'),0x1fffffff);
});

test('bad int64 pointers are rejected rather than silently indexing a typed-array property',()=>{
 const {run}=runtime();
 for(const pointer of [1,4,65536,-1,1.5,NaN,Infinity,-2147483649,4294967296])assert.throws(()=>run(`_jsbb_.int64_index(${String(pointer)})`),/int64 pointer/);
});

test('native shared Number conversion rejects unsafe/nonfinite inputs and preserves truncation',t=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'godotjs-int64-'));
 try{
  const header=fileURLToPath(new URL('../../../shared/jsb_integer.h',import.meta.url));
  const cpp=path.join(directory,'test.cpp'),binary=path.join(directory,'test');
  writeFileSync(cpp,`#include ${JSON.stringify(header)}\n#include <cassert>\n#include <limits>\nint main(){int64_t out=123;const int64_t max=9007199254740991LL;using jsb::impl::number_to_int64;assert(number_to_int64(3.75,out,max)&&out==3);assert(number_to_int64(-3.75,out,max)&&out==-3);assert(number_to_int64(double(max),out,max)&&out==max);assert(number_to_int64(-double(max),out,max)&&out==-max);assert(!number_to_int64(9007199254740992.0,out,max));assert(!number_to_int64(-9007199254740992.0,out,max));assert(!number_to_int64(std::numeric_limits<double>::infinity(),out,max));assert(!number_to_int64(std::numeric_limits<double>::quiet_NaN(),out,max));}\n`);
  const compile=spawnSync(process.env.CXX??'c++',['-std=c++17',cpp,'-o',binary],{encoding:'utf8'});
  if(compile.error?.code==='ENOENT'){t.skip('C++ compiler unavailable');return;}
  assert.equal(compile.status,0,compile.stderr);assert.equal(spawnSync(binary).status,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('generated int64 alias and array element augmentation accept exact bigint indices',()=>{
 const generator=readFileSync(new URL('../../../../scripts/jsb.editor/src/jsb.editor.codegen.ts',import.meta.url),'utf8');
 const mix=readFileSync(new URL('../../../../scripts/typings/godot.mix.d.ts',import.meta.url),'utf8');
 const alias=generator.match(/"(type int64 = [^"]+)"/)[1];
 const element=mix.match(/type GArrayElement<[\s\S]+?: T;/)[0];
 const directory=mkdtempSync(path.join(os.tmpdir(),'godotjs-int64-types-'));
 try{
  const file=path.join(directory,'types.ts');
  writeFileSync(file,`${alias};\ntype GAny=unknown;\n${element}\nconst large:int64=9223372036854775807n;\nconst item:GArrayElement<[number,string],1n>='yes';\n// @ts-expect-error wrong tuple value at bigint index\nconst bad:GArrayElement<[number,string],1n>=1;\n// @ts-expect-error strings are not native integers\nconst notInt:int64='12';\n`);
  const program=ts.createProgram([file],{target:ts.ScriptTarget.ES2022,strict:true,noEmit:true,types:[],skipLibCheck:false});
  const diagnostics=ts.getPreEmitDiagnostics(program);assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
