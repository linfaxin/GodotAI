import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {canonical,digest} from './site-evidence.mjs';

export const WORKER_SDK_PACKAGES=Object.freeze(['scripts/jsb.react','scripts/jsb.react-build','scripts/jsb.react-browser']);
export async function describeWorkerSdkSources(repository,packages=WORKER_SDK_PACKAGES){
 const inputs={};
 async function walk(directory){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(directory,entry.name);if(entry.isDirectory())await walk(filename);else if(entry.isFile())inputs[path.relative(repository,filename).split(path.sep).join('/')]=digest(await readFile(filename));}}
 for(const directory of packages){
  for(const filename of ['package.json','tsconfig.json'])inputs[directory+'/'+filename]=digest(await readFile(path.join(repository,directory,filename)));
  await walk(path.join(repository,directory,'src'));
 }
 return inputs;
}
/** Re-emit to memory and compare against the frozen SDK. No shared dist writes,
 * and source maps that read current TS cannot disguise stale generated JS. */
export async function proveWorkerSdkBuild(repository,{packages=WORKER_SDK_PACKAGES,verifyReactGenerated=true}={}){
 const sources=await describeWorkerSdkSources(repository,packages),outputs={};
 const compare=async(filename,expected)=>{
  const relative=path.relative(repository,filename).split(path.sep).join('/'),actual=await readFile(filename);
  if(!actual.equals(Buffer.from(expected)))throw Error('E_WORKER_SDK_STALE: '+relative+'; rebuild and freeze the shared SDK');
  outputs[relative]={sha256:digest(actual),bytes:actual.length};
 };
 for(const directory of packages){
  const configPath=path.join(repository,directory,'tsconfig.json'),config=ts.readConfigFile(configPath,ts.sys.readFile);
  if(config.error)throw Error('E_WORKER_SDK_CONFIG: '+directory);
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath)),emitted=[];
  const program=ts.createProgram(parsed.fileNames,parsed.options),result=program.emit(undefined,(filename,text)=>emitted.push([filename,text]));
  if(result.emitSkipped||parsed.errors.length)throw Error('E_WORKER_SDK_EMIT: '+directory+' '+ts.formatDiagnosticsWithColorAndContext([...parsed.errors,...ts.getPreEmitDiagnostics(program)].slice(0,5),{getCanonicalFileName:value=>value,getCurrentDirectory:()=>repository,getNewLine:()=> '\n'}));
  for(const [filename,text]of emitted){
   // This one entry is deliberately replaced by the package build script.
   if(directory==='scripts/jsb.react'&&filename===path.join(repository,directory,'dist/reconciler.js'))continue;
   await compare(filename,text);
  }
 }
 if(verifyReactGenerated&&packages.includes('scripts/jsb.react')){
  const {build}=await import('esbuild'),sdk=path.join(repository,'scripts/jsb.react');
  await compare(path.join(sdk,'dist/reconciler.js'),'if (process.env.NODE_ENV === "production") { module.exports = require("./reconciler.production.js"); } else { module.exports = require("./reconciler.development.js"); }\n');
  const performance=await build({absWorkingDir:sdk,entryPoints:[path.join(sdk,'src/internal/performance.ts')],outfile:path.join(sdk,'dist/internal/performance.mjs'),format:'esm',platform:'neutral',target:'es2022',sourcemap:true,write:false});
  for(const output of performance.outputFiles)await compare(output.path,output.contents);
  for(const mode of ['development','production']){
   const compiled=await build({absWorkingDir:sdk,entryPoints:[path.join(sdk,'src/reconciler.ts')],outfile:path.join(sdk,'dist/reconciler.'+mode+'.js'),bundle:true,platform:'neutral',format:'cjs',target:'es2022',sourcemap:true,external:['react'],inject:[path.join(sdk,'dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':JSON.stringify(mode)},plugins:[{name:'godot-private-scheduler',setup(builder){builder.onResolve({filter:/^(?:scheduler|\.\.\/scheduler)$/},()=>({path:'./scheduler.js',external:true}));}}],write:false});
   for(const output of compiled.outputFiles)await compare(output.path,output.contents);
  }
 }
 if(canonical(await describeWorkerSdkSources(repository,packages))!==canonical(sources))throw Error('E_WORKER_SDK_SOURCE_DRIFT');
 return {schemaVersion:1,kind:'worker-sdk-source-build-proof',typescript:ts.version,packages:[...packages],sourceInputs:sources,sourceSnapshotHash:digest(canonical(sources)),outputs,outputSnapshotHash:digest(canonical(outputs))};
}
export function assertWorkerSdkProof(proof){
 if(proof?.schemaVersion!==1||proof.kind!=='worker-sdk-source-build-proof'||canonical(proof.packages)!==canonical(WORKER_SDK_PACKAGES)||digest(canonical(proof.sourceInputs))!==proof.sourceSnapshotHash||digest(canonical(proof.outputs))!==proof.outputSnapshotHash||!Object.keys(proof.outputs??{}).length)throw Error('E_WORKER_SDK_PROOF');
 for(const directory of WORKER_SDK_PACKAGES)if(!proof.sourceInputs?.[directory+'/src/index.ts']||!proof.outputs?.[directory+'/dist/index.js'])throw Error('E_WORKER_SDK_PROOF_PACKAGE');
}
export async function assertWorkerSdkSources(repository,proof){
 assertWorkerSdkProof(proof);
 if(canonical(await describeWorkerSdkSources(repository,proof.packages))!==canonical(proof.sourceInputs))throw Error('E_WORKER_SDK_SOURCE_DRIFT');
}
export async function assertWorkerSdkBuildFrozen(repository,proof){
 await assertWorkerSdkSources(repository,proof);
 for(const [name,asset]of Object.entries(proof.outputs)){
  if(!WORKER_SDK_PACKAGES.some(directory=>name.startsWith(directory+'/dist/'))||name.includes('..')||name.includes('\\'))throw Error('E_WORKER_SDK_OUTPUT_PATH');
  const bytes=await readFile(path.join(repository,name));if(digest(bytes)!==asset.sha256||bytes.length!==asset.bytes)throw Error('E_WORKER_SDK_OUTPUT_DRIFT: '+name);
 }
}
