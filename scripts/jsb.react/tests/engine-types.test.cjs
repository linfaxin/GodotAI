const test=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const path=require('node:path');
test('constructor and adopted JSX preserve native props, signal payloads and refs',()=>{
  const program=ts.createProgram(['engine-types.fixture.ts','engine-jsx-types.fixture.tsx'].map(name=>path.join(__dirname,name)),{noEmit:true,strict:true,skipLibCheck:false,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.Node16,moduleResolution:ts.ModuleResolutionKind.Node16,esModuleInterop:true});
  const diagnostics=ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>String.fromCharCode(10)}));
});
