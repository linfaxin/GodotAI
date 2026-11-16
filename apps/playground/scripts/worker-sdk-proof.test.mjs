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
