import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {canonical,digest} from './site-evidence.mjs';

export const WORKER_SDK_PACKAGES=Object.freeze(['packages/engine','packages/project-tools','scripts/jsb.react','scripts/jsb.react-build','scripts/jsb.react-browser']);
/** Ordered tsc producers in the actual package build. Later passes may replace
 * declarations emitted by an earlier pass (neutral plus Node, for example). */
function buildConfigs(manifest){
 const configs=[...String(manifest.scripts?.build??'').matchAll(/\btsc\b[^;&|]*?\s(?:-p|--project)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  .map(match=>match[1].replace(/^['"]|['"]$/g,''));
 return configs.length?configs:['tsconfig.json'];
}
export async function describeWorkerSdkEntrypoints(repository,packages=WORKER_SDK_PACKAGES){
 const result={};
 for(const directory of packages){
  const manifest=JSON.parse(await readFile(path.join(repository,directory,'package.json'),'utf8')),targets=new Set();
  const visit=value=>{if(typeof value==='string'){const target=value.replace(/^\.\//,'');if(target.startsWith('dist/')&&!target.includes('*'))targets.add(directory+'/'+target);}else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);};
  visit(manifest.exports);visit(manifest.main);visit(manifest.types);visit(manifest.bin);
  result[directory]=[...targets].sort();
 }
 return result;
}
export async function describeWorkerSdkSources(repository,packages=WORKER_SDK_PACKAGES){
 const inputs={},seen=new Set();
 const add=async filename=>{const relative=path.relative(repository,filename).split(path.sep).join('/');if(relative.startsWith('../')||path.isAbsolute(relative))throw Error('E_WORKER_SDK_SOURCE_PATH');inputs[relative]=digest(await readFile(filename));};
 async function walk(directory,optional=false){let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(optional&&error.code==='ENOENT')return;throw error;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(directory,entry.name);if(entry.isDirectory())await walk(filename);else if(entry.isFile())await add(filename);else throw Error('E_WORKER_SDK_SOURCE_SYMLINK: '+filename);}}
 async function config(filename){filename=path.resolve(filename);if(seen.has(filename))return;seen.add(filename);await add(filename);const data=ts.readConfigFile(filename,ts.sys.readFile);if(data.error)throw Error('E_WORKER_SDK_CONFIG: '+filename);for(const parent of [data.config.extends??[]].flat())if(typeof parent==='string'&&parent.startsWith('.'))await config(path.resolve(path.dirname(filename),parent.endsWith('.json')?parent:parent+'.json'));}
 for(const directory of packages){
  const root=path.join(repository,directory),manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  await add(path.join(root,'package.json'));await config(path.join(root,'tsconfig.json'));
  for(const filename of buildConfigs(manifest))await config(path.resolve(root,filename));
  await walk(path.join(root,'src'));await walk(path.join(root,'scripts'),true);
  for(const filename of ['build.mjs','engine-modules.cjs'])try{await add(path.join(root,filename));}catch(error){if(error.code!=='ENOENT')throw error;}
  // Root export adapters can be producer inputs even when they are not TS.
  const visit=async value=>{if(typeof value==='string'){if(value.startsWith('./')&&!value.startsWith('./dist/')&&!value.includes('*'))await add(path.join(root,value));}else if(value&&typeof value==='object')for(const child of Object.values(value))await visit(child);};
  await visit(manifest.exports);
 }
 if(packages.includes('packages/engine'))await add(path.join(repository,'scripts/out/jsb.runtime.bundle.d.ts'));
 return inputs;
}
/** Re-emit to memory and compare against the frozen SDK. No shared dist writes,
 * and source maps that read current TS cannot disguise stale generated JS. */
export async function proveWorkerSdkBuild(repository,{packages=WORKER_SDK_PACKAGES,verifyReactGenerated=true}={}){
 const sources=await describeWorkerSdkSources(repository,packages),entrypoints=await describeWorkerSdkEntrypoints(repository,packages),outputs={};
 if(packages.includes('packages/engine')){
  const declarations=(await readFile(path.join(repository,'scripts/out/jsb.runtime.bundle.d.ts'),'utf8')).replaceAll('\r\n','\n');
  const source=ts.createSourceFile('engine-api-runtime-types.ts',await readFile(path.join(repository,'packages/engine/src/engine-api-runtime-types.ts'),'utf8'),ts.ScriptTarget.ES2022,true);
  const declaration=source.statements.flatMap(statement=>ts.isVariableStatement(statement)?[...statement.declarationList.declarations]:[]).find(item=>ts.isIdentifier(item.name)&&item.name.text==='ENGINE_RUNTIME_DECLARATIONS');
  if(!declaration?.initializer||!ts.isStringLiteral(declaration.initializer)||declaration.initializer.text!==declarations)throw Error('E_WORKER_SDK_STALE: runtime declaration snapshot; rebuild engine package');
 }
 const compare=async(filename,expected)=>{
  const relative=path.relative(repository,filename).split(path.sep).join('/'),actual=await readFile(filename);
  if(!actual.equals(Buffer.from(expected)))throw Error('E_WORKER_SDK_STALE: '+relative+'; rebuild and freeze the shared SDK');
  outputs[relative]={sha256:digest(actual),bytes:actual.length};
 };
 for(const directory of packages){
  const manifest=JSON.parse(await readFile(path.join(repository,directory,'package.json'),'utf8')),emitted=new Map();
  for(const filename of buildConfigs(manifest)){
   const configPath=path.resolve(repository,directory,filename),config=ts.readConfigFile(configPath,ts.sys.readFile);
   if(config.error)throw Error('E_WORKER_SDK_CONFIG: '+directory+'/'+filename);
   const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
   const program=ts.createProgram(parsed.fileNames,parsed.options),result=program.emit(undefined,(output,text)=>emitted.set(output,text));
   if(result.emitSkipped||parsed.errors.length)throw Error('E_WORKER_SDK_EMIT: '+directory+'/'+filename+' '+ts.formatDiagnosticsWithColorAndContext([...parsed.errors,...ts.getPreEmitDiagnostics(program)].slice(0,5),{getCanonicalFileName:value=>value,getCurrentDirectory:()=>repository,getNewLine:()=> '\n'}));
  }
  for(const [filename,text]of emitted){
   await compare(filename,text);
  }
  if(directory==='packages/project-tools'){
   const {nativeNamespaceSourceOutput}=await import(pathToFileURL(path.join(repository,directory,'scripts/build-native-namespace-source.mjs')).href);
   const namespace=await nativeNamespaceSourceOutput(path.join(repository,directory));
   if(await readFile(namespace.filename,'utf8')!==namespace.source)throw Error('E_WORKER_SDK_STALE: native namespace source differs from its producer; rebuild project-tools');
  }
  if(directory==='packages/engine'){
   const {runtimeBindingSourceOutput}=await import(pathToFileURL(path.join(repository,directory,'scripts/build-runtime-binding-source.mjs')).href);
   const binding=await runtimeBindingSourceOutput(path.join(repository,directory));
   if(await readFile(binding.filename,'utf8')!==binding.source)throw Error('E_WORKER_SDK_STALE: runtime binding source differs from its producer; rebuild engine');
   const {runtimeBootstrapOutputs}=await import(pathToFileURL(path.join(repository,directory,'scripts/build-runtime-bootstrap.mjs')).href);
   for(const [filename,bytes]of await runtimeBootstrapOutputs(path.join(repository,directory))){
    if(filename.endsWith('/src/browser/pthread/runtime-bootstrap-source.ts')){
     if(!(await readFile(filename)).equals(Buffer.from(bytes)))throw Error('E_WORKER_SDK_STALE: prebuilt pthread bootstrap source; rebuild engine');
    }else await compare(filename,bytes);
   }
  }
 }
 if(verifyReactGenerated&&packages.includes('scripts/jsb.react')){
  const {build}=await import('esbuild'),sdk=path.join(repository,'scripts/jsb.react');
  const performance=await build({absWorkingDir:sdk,entryPoints:[path.join(sdk,'src/internal/performance.ts')],outfile:path.join(sdk,'dist/internal/performance.mjs'),format:'esm',platform:'neutral',target:'es2022',sourcemap:true,write:false});
  for(const output of performance.outputFiles)await compare(output.path,output.contents);
  for(const mode of ['development','production']){
   const compiled=await build({absWorkingDir:sdk,entryPoints:[path.join(sdk,'src/internal/reconciler-vendor.ts')],outfile:path.join(sdk,'dist/reconciler.'+mode+'.js'),bundle:true,platform:'neutral',format:'cjs',target:'es2022',sourcemap:true,external:['react'],inject:[path.join(sdk,'dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':JSON.stringify(mode)},plugins:[{name:'godot-private-scheduler',setup(builder){builder.onResolve({filter:/^(?:scheduler|\.\.\/scheduler)$/},()=>({path:'./scheduler.js',external:true}));}}],write:false});
   for(const output of compiled.outputFiles)await compare(output.path,output.contents);
  }
 }
 for(const entries of Object.values(entrypoints))for(const filename of entries)if(!outputs[filename])throw Error('E_WORKER_SDK_EXPORT_EMIT: '+filename);
 if(canonical(await describeWorkerSdkSources(repository,packages))!==canonical(sources))throw Error('E_WORKER_SDK_SOURCE_DRIFT');
 return {schemaVersion:1,kind:'worker-sdk-source-build-proof',typescript:ts.version,packages:[...packages],entrypoints,sourceInputs:sources,sourceSnapshotHash:digest(canonical(sources)),outputs,outputSnapshotHash:digest(canonical(outputs))};
}
export function assertWorkerSdkProof(proof){
 if(proof?.schemaVersion!==1||proof.kind!=='worker-sdk-source-build-proof'||canonical(proof.packages)!==canonical(WORKER_SDK_PACKAGES)||digest(canonical(proof.sourceInputs))!==proof.sourceSnapshotHash||digest(canonical(proof.outputs))!==proof.outputSnapshotHash||!Object.keys(proof.outputs??{}).length)throw Error('E_WORKER_SDK_PROOF');
 for(const directory of WORKER_SDK_PACKAGES){
  const entries=proof.entrypoints?.[directory];
  if(!proof.sourceInputs?.[directory+'/package.json']||!proof.sourceInputs?.[directory+'/tsconfig.json']||!Array.isArray(entries)||!entries.length||!entries.some(name=>name.endsWith('.js'))||entries.some(name=>typeof name!=='string'||!name.startsWith(directory+'/dist/')||name.includes('..')||name.includes('\\')||!proof.outputs?.[name]))throw Error('E_WORKER_SDK_PROOF_PACKAGE');
 }
}
export async function assertWorkerSdkSources(repository,proof){
 assertWorkerSdkProof(proof);
 if(canonical(await describeWorkerSdkEntrypoints(repository,proof.packages))!==canonical(proof.entrypoints))throw Error('E_WORKER_SDK_EXPORT_DRIFT');
 if(canonical(await describeWorkerSdkSources(repository,proof.packages))!==canonical(proof.sourceInputs))throw Error('E_WORKER_SDK_SOURCE_DRIFT');
}
export async function assertWorkerSdkBuildFrozen(repository,proof){
 await assertWorkerSdkSources(repository,proof);
 for(const [name,asset]of Object.entries(proof.outputs)){
  if(!WORKER_SDK_PACKAGES.some(directory=>name.startsWith(directory+'/dist/'))||name.includes('..')||name.includes('\\'))throw Error('E_WORKER_SDK_OUTPUT_PATH');
  const bytes=await readFile(path.join(repository,name));if(digest(bytes)!==asset.sha256||bytes.length!==asset.bytes)throw Error('E_WORKER_SDK_OUTPUT_DRIFT: '+name);
 }
}
