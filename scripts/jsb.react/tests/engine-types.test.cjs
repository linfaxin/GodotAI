const test=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const path=require('node:path');
test('generic constructor sugar preserves native props, signal payloads and ref types',()=>{
  const program=ts.createProgram([path.join(__dirname,'engine-types.fixture.ts')],{noEmit:true,strict:true,skipLibCheck:false,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.Node16,moduleResolution:ts.ModuleResolutionKind.Node16,esModuleInterop:true});
  const diagnostics=ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>String.fromCharCode(10)}));
});
