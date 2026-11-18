/** Node I/O adapter. The neutral package root never imports this entry. */
import {readFile, stat, writeFile, mkdir, readdir, rm} from 'node:fs/promises';
import {renameSync,realpathSync} from 'node:fs';
import {basename,dirname, resolve, relative, isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {assertNativeReleaseIdentity} from '@godot-js/engine/identities';
import type {RawAssetReader} from '@godot-js/engine/release-assets';
import {prepareCompilerEnvironmentInput} from '../environment.js';
import {readProjectDocument} from '../project-document.js';
import {createSourceSnapshot, createBuildPlan, type BuildPlan, type PrepareBuildPlanOptions, type ProjectLaunch} from '../build-plan.js';
import {createCompilerEnvironment, compileProject,compileResultMetadata,ProjectBuildCache,ProjectWorkspace,ProjectLanguageService, type CompileBuildPlanOptions} from '../compiler.js';
import {checkProjectTypes, snapshotTextFiles} from '../type-environment.js';
import {createBrowserResourceConverters, parseResourceImports,type ResourceExecutionCache} from '../resource-converters.js';
import {createNodeResourceExecutionCache} from './resource-cache.js';
export {createNodeResourceExecutionCache} from './resource-cache.js';
import {decodeProjectText, readProjectBooleanSetting} from '../project-settings.js';
import {ProjectToolError} from '../errors.js';
import {projectScript, projectDeclaration} from '../project-modules.js';
import {moduleRequireOffsets} from '../script-bindings.js';
import {engineEmitOptions} from '../compiler-policy.js';
import {parseProjectLaunch} from '../launch.js';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const contexts=new Map<string,{cache:ProjectBuildCache;workspace:ProjectWorkspace;languageService:ProjectLanguageService}>();
function projectContext(project:string){
 const key=resolve(project);let context=contexts.get(key);
 if(!context){context={cache:new ProjectBuildCache({maxBytes:32*1024*1024}),workspace:new ProjectWorkspace(),languageService:new ProjectLanguageService()};contexts.set(key,context);}
 else{contexts.delete(key);contexts.set(key,context);}
 while(contexts.size>4){const oldest=contexts.keys().next().value!;contexts.get(oldest)!.languageService.dispose();contexts.delete(oldest);}
 return context;
}
const nativeModules = new Set(['godot', 'godot-jsb', 'godot.annotations', 'godot.lib', 'godot.lib.api', 'godot.typeloader', 'jsb.core', 'jsb.inject', 'godot.worker']);
export interface NodeCompileOptions {
  /** A Schema 1–4 JSON document or a native Godot source directory. */
  project: string;
  /** Matching engine-release.json, with its original relative assets. */
  release: string;
  mode?: 'development' | 'production';
  output?: string;
  /** Directory inputs default to the project's main_scene. */
  launch?: ProjectLaunch;
  /** Explicit optional framework adapter. It exports prepareLegacyBuildPlan. */
  startupAdapter?: string;
  preparePlan?: CompileBuildPlanOptions['preparePlan'];
  cache?:ProjectBuildCache;
  workspace?:ProjectWorkspace;
  languageService?:ProjectLanguageService;
  signal?:AbortSignal;
  resourceCache?:ResourceExecutionCache;
  resourceCacheDirectory?:string;
  /** Export a matching bootstrap plus stable resource packs into this directory. */
  artifactSetDirectory?:string;
}

/** Paths, launch data and option references belong to this invocation before
 * any I/O yields. Services and the AbortSignal retain their intended identity. */
function captureNodeOptions(input:NodeCompileOptions):NodeCompileOptions {
  const {project,release,mode,output,artifactSetDirectory,resourceCacheDirectory,launch,
    startupAdapter,preparePlan,cache,workspace,languageService,signal,resourceCache}=input;
  if(output&&artifactSetDirectory)throw new ProjectToolError('E_COMPILER_OUTPUT','Choose a single PCK output or an ArtifactSet directory');
  if(mode!==undefined&&!['development','production'].includes(mode))throw new ProjectToolError('E_SDK_MODE','Unsupported SDK mode');
  return Object.freeze({project:resolve(project),release:resolve(release),mode,
    startupAdapter,preparePlan,cache,workspace,languageService,signal,resourceCache,
    output:output?resolve(output):output,artifactSetDirectory:artifactSetDirectory?resolve(artifactSetDirectory):artifactSetDirectory,
    resourceCacheDirectory:resourceCacheDirectory===undefined?undefined:resolve(resourceCacheDirectory),
    launch:launch===undefined?undefined:Object.freeze(parseProjectLaunch(launch))});
}

async function projectDocument(options: NodeCompileOptions, manifest: any): Promise<{document: any; directory: boolean}> {
  const filename = resolve(options.project), info = await stat(filename);
  if (!info.isDirectory()) {
    if (options.launch) throw new ProjectToolError('E_PROJECT_LAUNCH', 'Directory launch overrides do not change stored project document semantics');
    return {document: JSON.parse(new TextDecoder().decode(await readBounded(filename, 128 * 1024 * 1024))), directory: false};
  }
  const releaseRoot = dirname(resolve(options.release));
  const excluded = new Set([resolve(options.release), ...Object.keys(manifest.payloads).map(name => resolve(releaseRoot, name)),
    ...(options.output ? [resolve(options.output), resolve(options.output) + '.receipt.json', resolve(options.output) + '.manifest.json'] : []),
    ...(options.artifactSetDirectory?[resolve(options.artifactSetDirectory)]:[])]);
  const files: Record<string, string | Uint8Array> = Object.create(null);
  let bytes = 0, count = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name, absolute = resolve(directory, entry.name);
      if (excluded.has(absolute) || options.output&&absolute.startsWith(resolve(options.output)+'.')&&/\.[a-f0-9-]{36}\.tmp$/.test(absolute) || ['.git', 'node_modules'].includes(entry.name)
          || ['.godot/editor', '.godot/shader_cache', '.godot/GodotJS'].some(part => path === part || path.startsWith(part + '/'))) continue;
      if (entry.isSymbolicLink()) throw new ProjectToolError('E_PROJECT_PATH', `Directory project contains a symlink: ${path}`);
      if (entry.isDirectory()) { await walk(absolute, path + '/'); continue; }
      if (!entry.isFile()) continue;
      if (++count > 10000) throw new ProjectToolError('E_PROJECT_BUDGET', 'Directory project exceeds the source file count budget');
      const value = await readBounded(absolute, MAX_ASSET_BYTES - bytes); bytes += value.byteLength;
      const text = projectScript.test(path) || /(?:^project\.godot$|\.(?:json|tscn|tres|gd|gdshader|cfg|import|uid|txt|md|svg)$)/i.test(path);
      try { files['/' + path] = text ? new TextDecoder('utf-8', {fatal: true,ignoreBOM:true}).decode(value) : value; }
      catch { throw new ProjectToolError('E_PROJECT_TEXT', `Invalid UTF-8 source text: ${path}`); }
    }
  };
  await walk(filename, '');
  return {document: {schemaVersion: 4, runtime: 'engine', engineProfile: manifest.runtimeProfile,
    launch: options.launch ?? {kind: 'scene', source: 'project'}, files}, directory: true};
}

async function readBounded(filename: string, limit: number): Promise<Uint8Array> {
  const info = await stat(filename);
  if (!info.isFile() || info.size > limit) throw new ProjectToolError('E_COMPILER_INPUT_BUDGET', `Input exceeds its byte budget: ${filename}`);
  const bytes = new Uint8Array(await readFile(filename));
  if (bytes.byteLength > limit) throw new ProjectToolError('E_COMPILER_INPUT_BUDGET', `Input exceeds its byte budget: ${filename}`);
  return bytes;
}

function localRawAssets(root: string): RawAssetReader {
  return async (asset, options) => {
    options.signal?.throwIfAborted();
    if (!asset || typeof asset.path !== 'string' || !/^[-a-zA-Z0-9_./]+$/.test(asset.path) || asset.path.startsWith('/') || asset.path.split('/').some(part => part === '..' || !part))
      throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', 'Invalid local release asset path');
    const filename = resolve(root, asset.path), path = relative(root, filename);
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', 'Release asset escapes its directory');
    // Only transport belongs here. Shared environment assembly verifies the
    // stored bytes, decodes once and checks the decoded identity and budget.
    const bytes = await readBounded(filename, Math.min(options.maxStoredBytes, MAX_ASSET_BYTES));
    options.signal?.throwIfAborted();
    return bytes;
  };
}

function sdkImports(files: Readonly<Record<string, string | number[]>>): Set<string> {
  const imports = new Set<string>();
  for (const [name, source] of Object.entries(files)) {
    if (typeof source !== 'string' || !projectScript.test(name) || projectDeclaration.test(name)) continue;
    const output = ts.transpileModule(source, {fileName: name.replace(/\.(?:mts|mjs)$/i, '.ts'), compilerOptions: engineEmitOptions()}).outputText;
    const ast = ts.createSourceFile(name + '.js', output, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), requires = moduleRequireOffsets(ast);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && requires.has(node.getStart(ast)) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
        const specifier = node.arguments[0].text;
        if (!nativeModules.has(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('res://')) imports.add(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return imports;
}

interface HistoricalModuleAdapter {id:string;apply(input:{moduleDeclarations:Readonly<Record<string,string>>;runtimeModules?:Readonly<Record<string,Uint8Array>>;runtimeImports?:Iterable<string>}):{moduleDeclarations:Record<string,string>;runtimeModules?:Record<string,Uint8Array>}}
const historicalModuleAdapters=new WeakMap<NonNullable<CompileBuildPlanOptions['preparePlan']>,HistoricalModuleAdapter>();
async function legacyPreparer(options: NodeCompileOptions, plan: BuildPlan): Promise<CompileBuildPlanOptions['preparePlan']> {
  if (options.preparePlan) return options.preparePlan;
  if (plan.compatibility?.runtime !== 'react') return undefined;
  const specifier = options.startupAdapter ?? '@godot-js/react-build/core';
  let adapter: any;
  try {
    const project = resolve(options.project), info = await stat(project);
    const anchor = info.isDirectory() ? resolve(project, 'package.json') : project, require = createRequire(anchor);
    let filename: string;
    if (isAbsolute(specifier) || specifier.startsWith('.')) filename = resolve(info.isDirectory() ? project : dirname(project), specifier);
    else {
      try { filename = require.resolve(specifier); }
      catch (error) {
        // Optional framework packages may expose import-only ESM subpaths.
        // Use Node's package locator, then the explicit import export; this
        // does not add the framework to neutral/package runtime dependencies.
        const {findPackageJSON} = await import('node:module');
        const packageFile = typeof findPackageJSON === 'function' ? findPackageJSON(specifier, pathToFileURL(anchor)) : undefined;
        if (!packageFile) throw error;
        const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
        const parts = specifier.split('/'), packageParts = specifier.startsWith('@') ? 2 : 1;
        const subpath = parts.length > packageParts ? './' + parts.slice(packageParts).join('/') : '.';
        const exported = metadata.exports?.[subpath] ?? (subpath === '.' ? metadata.exports : undefined);
        const entry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
        if (typeof entry !== 'string' || !entry.startsWith('./')) throw error;
        filename = resolve(dirname(packageFile), entry);
        if (relative(dirname(packageFile), filename).startsWith('..')) throw error;
      }
    }
    adapter = await import(pathToFileURL(filename).href);
  } catch (error) {
    throw new ProjectToolError('E_PROJECT_ADAPTER_REQUIRED', 'This component project needs @godot-js/react-build/core or an explicit --startup-adapter module', String(error));
  }
  if (typeof adapter.prepareLegacyBuildPlan !== 'function') throw new ProjectToolError('E_PROJECT_ADAPTER_REQUIRED', 'Startup adapter must export prepareLegacyBuildPlan');
  const preparePlan=adapter.prepareLegacyBuildPlan as NonNullable<CompileBuildPlanOptions['preparePlan']>;
  const historical=adapter.HISTORICAL_REACT_MODULE_ADAPTER;
  if(historical!==undefined){if(!historical||typeof historical.id!=='string'||typeof historical.apply!=='function')throw new ProjectToolError('E_PROJECT_ADAPTER_REQUIRED','Invalid historical module adapter');historicalModuleAdapters.set(preparePlan,{id:historical.id,apply:historical.apply.bind(historical)});}
  return preparePlan;
}

/** Local files and release decoding stop at this boundary; all checking and
 * artifact production below use exactly the same neutral compiler as browser. */
export async function prepareNodeProject(options: NodeCompileOptions) {
  return prepareNodeProjectInput(options, 'build');
}

async function prepareNodeProjectInput(options: NodeCompileOptions, scope: 'build' | 'typecheck') {
  options=captureNodeOptions(options);
  const descriptorBytes = await readBounded(resolve(options.release), 16 * 1024 * 1024);
  const manifest = JSON.parse(new TextDecoder().decode(descriptorBytes));
  await assertNativeReleaseIdentity(manifest);
  if(scope==='build'&&options.artifactSetDirectory&&(manifest.execution??manifest.engine?.execution)?.artifactSetAbi!==1)
    throw new ProjectToolError('E_ARTIFACT_SET_TARGET','The matched engine does not support ArtifactSet startup');
  if (typeof manifest.runtimeProfile !== 'string') throw new ProjectToolError('E_PROJECT_ENGINE_PROFILE', 'Release is missing its engine profile');
  const input = await projectDocument(options, manifest), document = input.document;
  const context=projectContext(options.project),workspace=options.workspace??context.workspace;
  const inputFiles=(document.project??document)?.files;
  if(!inputFiles||typeof inputFiles!=='object')throw new ProjectToolError('E_PROJECT_SCHEMA','Project must contain files');
  const captured=await workspace.capture(inputFiles,{maxBytes:MAX_ASSET_BYTES,maxFiles:10000});
  try{
  const read = input.directory ? {plan: await createBuildPlan(captured.source, document.launch,
    {inputs: {engineProfile: manifest.runtimeProfile}})} : await readProjectDocument(document, {inputs: {engineProfile: manifest.runtimeProfile},sourceSnapshot:captured.source});
  const files = snapshotTextFiles(read.plan.snapshot),preparePlan=await legacyPreparer(options,read.plan);
  const historical=preparePlan&&historicalModuleAdapters.get(preparePlan);
  if (read.plan.inputs.engineProfile !== manifest.runtimeProfile) throw new ProjectToolError('E_PROJECT_ENGINE_PROFILE', 'Project and release engine profiles differ');
  const configuration = decodeProjectText(read.plan.snapshot.files.find(file => file.path === 'res://project.godot')?.bytes);
  const naming = readProjectBooleanSetting(configuration ?? '', 'GodotJS', 'runtime/core/camel_case_bindings_enabled') ? 'camel' : 'snake';
  const imports = sdkImports(files);
  const needsSdk = read.plan.compatibility?.runtime === 'react' || [...imports].some(name => Object.hasOwn(manifest.sdk?.runtimeModules ?? {}, name));
  const prepared = await prepareCompilerEnvironmentInput({descriptorBytes, naming,
    selection: needsSdk ? {kind: 'sdk', mode: options.mode ?? 'production'} : {kind: 'engine'},
    readRawAsset: localRawAssets(dirname(options.release)), signal: options.signal});
  let compilerInput = prepared.input;
  if (historical) {
    const adapted = historical.apply({moduleDeclarations: compilerInput.moduleDeclarations ?? {},
      runtimeModules: compilerInput.runtimeModules, runtimeImports: imports});
    compilerInput = {...compilerInput, target: {...compilerInput.target, compatibilityAdapter: historical.id},
      moduleDeclarations: adapted.moduleDeclarations, runtimeModules: adapted.runtimeModules};
  }
  const environment = await createCompilerEnvironment(compilerInput);
  const data = document.project ?? document;
  const preparation: PrepareBuildPlanOptions = {};
  // Typechecking needs source and declarations. Resource recipes and target
  // support are build prerequisites, and cannot suppress type diagnostics.
  if (scope === 'build') {
    // Downloaded projects cannot bring their own records into the trusted cache.
    // Default storage belongs to the host tool, outside every project directory.
    const defaultCache=resolve(tmpdir(),'godotjs-owned-resource-cache-v2',String(process.getuid?.()??'user'),createHash('sha256').update(resolve(options.project)).digest('hex'));
    const resourceCache=options.resourceCache??createNodeResourceExecutionCache(options.resourceCacheDirectory??defaultCache);
    const converters = createBrowserResourceConverters(undefined,{cache:resourceCache}), resourceImports = data.resourceImports === undefined ? undefined : parseResourceImports(data.resourceImports);
    for (const request of resourceImports ?? []) if (!converters.ids.has(request.converter))
      throw new ProjectToolError('E_RESOURCE_CONVERTER', `Node has no registered producer ${request.converter}; supply a converter through the shared compiler API`);
    if (resourceImports?.length && prepared.facts.resources.status !== 'available')
      throw new ProjectToolError('E_RESOURCE_CONVERTER', prepared.facts.resources.reason);
    Object.assign(preparation, {
      ...(data.importReceipts ? {storedImportReceipts: data.importReceipts} : {}),
      ...(resourceImports ? {resourceImports, resourceConverters: converters,
        ...(prepared.facts.resources.status === 'available' ? {resourceTarget: prepared.facts.resources.target} : {})} : {}),
      ...(data.importCacheObservations ? {importCacheObservations: data.importCacheObservations} : {}),
    });
  }
  return {plan: read.plan, environment, preparation, preparePlan,cache:options.cache??context.cache,languageService:options.languageService??context.languageService,signal:options.signal,releaseSnapshot:captured.release,artifactSet:options.artifactSetDirectory?true:undefined,
    pack: {maxBytes: MAX_ASSET_BYTES, maxFiles: 10000}};
  }catch(error){captured.release();throw error;}
}

export async function checkNodeProject(options: NodeCompileOptions) {
  const request = await prepareNodeProjectInput(options, 'typecheck');
  try{
  const environment=request.environment.createTypeEnvironment(snapshotTextFiles(request.plan.snapshot));
  const diagnostics = checkProjectTypes(environment,request.languageService.use(environment));
  return {scope: 'typecheck' as const, sourceHash: request.plan.snapshot.sourceHash,
    ok: !diagnostics.some(item => item.category === 'error'), diagnostics, target: request.environment.identity};
  }finally{request.releaseSnapshot();}
}

interface OutputClaim {paths:readonly string[];directory:boolean;superseded:boolean}
const outputClaims=new Set<OutputClaim>();
/** Resolve existing directory aliases without following the final file: rename
 * replaces a file symlink, while a directory symlink redirects publication. */
function publicationDirectory(directory:string):string {
 const suffix:string[]=[];let current=directory;
 for(;;){
  try{return resolve(realpathSync(current),...suffix.reverse());}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(current);if(parent===current)throw error;suffix.push(basename(current));current=parent;}
 }
}
function containsOutput(directory:string,filename:string):boolean {
 const path=relative(directory,filename);
 return path===''||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);
}
function claimOutput(options:NodeCompileOptions):OutputClaim|undefined {
 const directory=options.artifactSetDirectory?publicationDirectory(options.artifactSetDirectory):undefined;
 const filename=options.output?resolve(publicationDirectory(dirname(options.output)),basename(options.output)):undefined;
 const claim:OutputClaim|undefined=directory?{paths:[directory],directory:true,superseded:false}:
  filename?{paths:[filename,filename+'.receipt.json',filename+'.manifest.json'],directory:false,superseded:false}:undefined;
 if(claim){
  for(const previous of outputClaims)if(previous.paths.some(a=>claim.paths.some(b=>a===b||previous.directory&&containsOutput(a,b)||claim.directory&&containsOutput(b,a))))previous.superseded=true;
  outputClaims.add(claim);
 }
 return claim;
}
export async function compileNodeProject(options: NodeCompileOptions) {
  options=captureNodeOptions(options);
  const destination=options.output||options.artifactSetDirectory||undefined;
  const claim=claimOutput(options);
  const active=()=>{options.signal?.throwIfAborted();if(claim?.superseded)throw new ProjectToolError('E_BUILD_SUPERSEDED','A newer build owns this output');};
  const temporary:string[]=[];
  try{
   const request = await prepareNodeProject(options), result = await compileProject(request);active();
   const writes:Array<{filename:string;bytes:string|Uint8Array}>=[];
   if(options.artifactSetDirectory&&result.variant==='pack-set'){
    const root=destination!,set=result.artifactSet;
    // Stable content-addressed resource files are ready before the root pack changes.
    for(const descriptor of set.manifest.resources)writes.push({filename:resolve(root,descriptor.path),bytes:set.packs.get(descriptor.sha256)!});
    writes.push({filename:resolve(root,'artifact-set.json'),bytes:JSON.stringify(set.manifest,null,2)+'\n'});
    writes.push({filename:resolve(root,set.manifest.bootstrap.path+'.manifest.json'),bytes:JSON.stringify({...compileResultMetadata(result),generation:'build-'+result.buildKey},null,2)+'\n'});
    writes.push({filename:resolve(root,set.manifest.bootstrap.path),bytes:set.packs.get(set.manifest.bootstrap.sha256)!});
   }
   if(options.output&&result.variant==='single-pack'){
    const filename=destination!;
    writes.push({filename:filename+'.receipt.json',bytes:JSON.stringify(result.receipt,null,2)+'\n'},
     {filename:filename+'.manifest.json',bytes:JSON.stringify({...compileResultMetadata(result),generation:'build-'+result.buildKey},null,2)+'\n'},
     {filename,bytes:result.pack});
   }
   const candidates:Array<{temporary:string;filename:string}>=[];
   for(const write of writes){active();await mkdir(dirname(write.filename),{recursive:true});const candidate=write.filename+'.'+randomUUID()+'.tmp';temporary.push(candidate);await writeFile(candidate,write.bytes,{flag:'wx'});candidates.push({temporary:candidate,filename:write.filename});}
   // No asynchronous boundary between the final admission and publication. An
   // aborted/superseded build may populate caches, never replace an active root.
   active();for(const candidate of candidates)renameSync(candidate.temporary,candidate.filename);
   return result;
  }finally{
   if(claim)outputClaims.delete(claim);
   await Promise.all(temporary.map(filename=>rm(filename,{force:true}).catch(()=>{})));
  }
}
