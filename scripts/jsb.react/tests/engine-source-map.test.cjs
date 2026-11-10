const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const {mapEngineStack}=require('../dist/engine-source-map');
test('native React diagnostics resolve emitted frames to authored TypeScript lines',()=>{
 const source='export function Broken():never {\n const value=1;\n throw Error("expected "+value);\n}\n';
 const emitted=ts.transpileModule(source,{fileName:'App.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,sourceMap:true}});
 const map=JSON.parse(emitted.sourceMapText);map.sources=['res://src/App.ts'];
 const prefix=emitted.outputText.slice(0,emitted.outputText.indexOf('throw Error')).split('\n');
 const stack=`Error: expected\n at Broken (res://.godot/GodotJS/src/App.js:${prefix.length}:${prefix.at(-1).length+1})`;
 assert.match(mapEngineStack(stack,()=>JSON.stringify(map)),/res:\/\/src\/App.ts:3:/);
 assert.equal(mapEngineStack(stack,()=>'{broken'),stack);
 assert.equal(mapEngineStack(stack,()=>undefined),stack);
 assert.equal(mapEngineStack('Error: native\n at native_function',()=>{throw Error('Must not read');}),'Error: native\n at native_function');
});
