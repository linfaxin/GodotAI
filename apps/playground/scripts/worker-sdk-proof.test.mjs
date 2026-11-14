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
