const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ts=require('typescript');
test('typed physics queries and event callbacks share direct-renderer handles',()=>{
 const root=path.resolve(__dirname,'..'),file=path.join(__dirname,'engine-component-types.fixture.ts');
 const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
 const program=ts.createProgram([...parsed.fileNames,file],{...parsed.options,rootDir:root,noEmit:true});
 const diagnostics=ts.getPreEmitDiagnostics(program);
 assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));
});
