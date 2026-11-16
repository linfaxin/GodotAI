import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {proveWorkerSdkBuild} from './worker-sdk-proof.mjs';

test('SDK proof compares emitted code, so fresh source maps cannot disguise a stale shared SDK build',async t=>{
 const repository=await mkdtemp(path.join(tmpdir(),'worker-sdk-proof-')),directory=path.join(repository,'scripts/sdk');t.after(()=>rm(repository,{recursive:true,force:true}));
 await mkdir(path.join(directory,'src'),{recursive:true});await mkdir(path.join(directory,'dist'));
 await writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'}));
 const config={compilerOptions:{target:'ES2022',module:'ESNext',types:[],declaration:true,sourceMap:true,rootDir:'src',outDir:'dist',noEmitOnError:true},include:['src/**/*.ts']};
 await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify(config));await writeFile(path.join(directory,'src/index.ts'),'export const version:number=1;\n');
 const parsed=ts.parseJsonConfigFileContent(config,ts.sys,directory),result=ts.createProgram(parsed.fileNames,parsed.options).emit();assert.equal(result.emitSkipped,false);
 const proof=await proveWorkerSdkBuild(repository,{packages:['scripts/sdk'],verifyReactGenerated:false});assert(Object.keys(proof.outputs).length>=3);
 await writeFile(path.join(directory,'src/index.ts'),'export const version:number=2;\n');
 await assert.rejects(proveWorkerSdkBuild(repository,{packages:['scripts/sdk'],verifyReactGenerated:false}),/E_WORKER_SDK_STALE/);
});

test('SDK proof follows real subpath exports and freezes build producers and inherited config',async t=>{
 const repository=await mkdtemp(path.join(tmpdir(),'worker-sdk-exports-')),directory=path.join(repository,'packages/sdk');t.after(()=>rm(repository,{recursive:true,force:true}));
 await mkdir(path.join(directory,'src'),{recursive:true});await mkdir(path.join(directory,'scripts'));await mkdir(path.join(repository,'configs'));
 await writeFile(path.join(repository,'configs/base.json'),JSON.stringify({compilerOptions:{strict:true}}));
 await writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module',exports:{'./runtime':{types:'./dist/runtime.d.ts',import:'./dist/runtime.js'}}}));
 const config={extends:'../../configs/base.json',compilerOptions:{target:'ES2022',module:'ESNext',types:[],declaration:true,sourceMap:true,rootDir:'src',outDir:'dist',noEmitOnError:true},include:['src/**/*.ts']};
 await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify(config));await writeFile(path.join(directory,'src/runtime.ts'),'export const runtime=1;\n');await writeFile(path.join(directory,'scripts/generate.mjs'),'export const producer=1;\n');
 const parsed=ts.parseJsonConfigFileContent(config,ts.sys,directory);assert.equal(ts.createProgram(parsed.fileNames,parsed.options).emit().emitSkipped,false);
 const first=await proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false});
 assert.deepEqual(first.entrypoints['packages/sdk'],['packages/sdk/dist/runtime.d.ts','packages/sdk/dist/runtime.js']);
 assert(first.sourceInputs['configs/base.json']);assert(first.sourceInputs['packages/sdk/scripts/generate.mjs']);assert(!first.sourceInputs['packages/sdk/src/index.ts']);
 await writeFile(path.join(directory,'scripts/generate.mjs'),'export const producer=2;\n');
 const second=await proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false});assert.notEqual(first.sourceSnapshotHash,second.sourceSnapshotHash);
});

test('SDK proof freezes and re-emits ordered neutral/Node configs, including import-only exports and CLI bins',async t=>{
 const repository=await mkdtemp(path.join(tmpdir(),'worker-sdk-node-')),directory=path.join(repository,'packages/sdk');t.after(()=>rm(repository,{recursive:true,force:true}));
 await mkdir(path.join(directory,'src/node'),{recursive:true});
 const manifest={type:'module',scripts:{build:'tsc -p tsconfig.json && tsc --project tsconfig.node.json'},exports:{
  './runtime':{types:'./dist/runtime.d.ts',import:'./dist/runtime.js'},'./node':{types:'./dist/node/cli.d.ts',import:'./dist/node/cli.js'}},bin:{'test-sdk':'dist/node/cli.js'}};
 await writeFile(path.join(directory,'package.json'),JSON.stringify(manifest));
 const config={compilerOptions:{target:'ES2022',module:'ESNext',types:[],declaration:true,sourceMap:true,rootDir:'src',outDir:'dist',noEmitOnError:true},include:['src/**/*.ts'],exclude:['src/node']};
 const nodeConfig={extends:'./tsconfig.json',compilerOptions:{removeComments:true},include:['src/node/**/*.ts'],exclude:[]};
 await writeFile(path.join(directory,'tsconfig.json'),JSON.stringify(config));await writeFile(path.join(directory,'tsconfig.node.json'),JSON.stringify(nodeConfig));
 await writeFile(path.join(directory,'src/runtime.ts'),'/** producer comment */\nexport const runtime=1;\n');
 await writeFile(path.join(directory,'src/node/cli.ts'),'import {runtime} from "../runtime.js";\nexport const cli=runtime;\n');
 const emit=()=>{for(const name of ['tsconfig.json','tsconfig.node.json']){const read=ts.readConfigFile(path.join(directory,name),ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,directory);assert.equal(ts.createProgram(parsed.fileNames,parsed.options).emit().emitSkipped,false);}};
 emit();
 const proof=await proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false});
 assert(proof.sourceInputs['packages/sdk/tsconfig.node.json']);assert(proof.outputs['packages/sdk/dist/node/cli.js']);assert(proof.outputs['packages/sdk/dist/node/cli.d.ts']);
 assert(proof.entrypoints['packages/sdk'].includes('packages/sdk/dist/node/cli.js'));
 // Node's second emit also replaces runtime.js. Proof must compare final output,
 // rather than incorrectly comparing dist against the first neutral pass.
 assert(proof.outputs['packages/sdk/dist/runtime.js']);
 await writeFile(path.join(directory,'src/node/cli.ts'),'import {runtime} from "../runtime.js";\nexport const cli=runtime+1;\n');
 await assert.rejects(proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false}),/E_WORKER_SDK_STALE/);
 emit();await proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false});
 await writeFile(path.join(directory,'tsconfig.node.json'),JSON.stringify({...nodeConfig,compilerOptions:{removeComments:false}}));
 await assert.rejects(proveWorkerSdkBuild(repository,{packages:['packages/sdk'],verifyReactGenerated:false}),/E_WORKER_SDK_STALE/);
});
