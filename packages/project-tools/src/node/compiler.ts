/** Node I/O adapter. The neutral package root never imports this entry. */
import {readFile, stat, writeFile, mkdir, readdir} from 'node:fs/promises';
import {dirname, resolve, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import ts from 'typescript';
import {assertNativeReleaseIdentity, assertNativeTypeSnapshot} from '@godot-js/engine/identities';
import {readProjectDocument} from '../project-document.js';
import {createSourceSnapshot, createBuildPlan, type BuildPlan, type PrepareBuildPlanOptions, type ProjectLaunch} from '../build-plan.js';
import {createCompilerEnvironment, compileProject, type CompileBuildPlanOptions} from '../compiler.js';
import {checkProjectTypes, snapshotTextFiles} from '../type-environment.js';
import {createBrowserResourceConverters, parseResourceImports} from '../resource-converters.js';
import {decodeProjectText, readProjectBooleanSetting} from '../project-settings.js';
import {hashBytes} from '../hash.js';
import {ProjectToolError} from '../errors.js';
import {projectScript, projectDeclaration} from '../project-modules.js';
import {moduleRequireOffsets} from '../script-bindings.js';
import {engineEmitOptions} from '../compiler-policy.js';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
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
}

async function projectDocument(options: NodeCompileOptions, manifest: any): Promise<{document: any; directory: boolean}> {
  const filename = resolve(options.project), info = await stat(filename);
  if (!info.isDirectory()) {
    if (options.launch) throw new ProjectToolError('E_PROJECT_LAUNCH', 'Directory launch overrides do not change stored project document semantics');
    return {document: JSON.parse(new TextDecoder().decode(await readBounded(filename, 128 * 1024 * 1024))), directory: false};
  }
  const releaseRoot = dirname(resolve(options.release));
  const excluded = new Set([resolve(options.release), ...Object.keys(manifest.payloads).map(name => resolve(releaseRoot, name)),
    ...(options.output ? [resolve(options.output), resolve(options.output) + '.receipt.json', resolve(options.output) + '.manifest.json'] : [])]);
  const files: Record<string, string | Uint8Array> = Object.create(null);
  let bytes = 0, count = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name, absolute = resolve(directory, entry.name);
      if (excluded.has(absolute) || ['.git', 'node_modules'].includes(entry.name)
          || ['.godot/editor', '.godot/shader_cache', '.godot/GodotJS'].some(part => path === part || path.startsWith(part + '/'))) continue;
      if (entry.isSymbolicLink()) throw new ProjectToolError('E_PROJECT_PATH', `Directory project contains a symlink: ${path}`);
      if (entry.isDirectory()) { await walk(absolute, path + '/'); continue; }
      if (!entry.isFile()) continue;
      if (++count > 10000) throw new ProjectToolError('E_PROJECT_BUDGET', 'Directory project exceeds the source file count budget');
      const value = await readBounded(absolute, MAX_ASSET_BYTES - bytes); bytes += value.byteLength;
      const text = projectScript.test(path) || /(?:^project\.godot$|\.(?:json|tscn|tres|gd|gdshader|cfg|import|uid|txt|md|svg)$)/i.test(path);
      try { files['/' + path] = text ? new TextDecoder('utf-8', {fatal: true}).decode(value) : value; }
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

async function releaseAsset(root: string, asset: any): Promise<Uint8Array> {
  if (!asset || typeof asset.path !== 'string' || !/^[-a-zA-Z0-9_./]+$/.test(asset.path) || asset.path.startsWith('/') || asset.path.split('/').some((part: string) => part === '..' || !part)
      || !/^[a-f0-9]{64}$/i.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_ASSET_BYTES)
    throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', 'Invalid local release asset descriptor');
  const filename = resolve(root, asset.path), path = relative(root, filename);
  if (path.startsWith('..') || isAbsolute(path)) throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', 'Release asset escapes its directory');
  const encoded = await readBounded(filename, MAX_ASSET_BYTES);
  if (encoded.byteLength !== asset.bytes || await hashBytes(encoded) !== asset.sha256.toLowerCase())
    throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', `Release bytes differ: ${asset.path}`);
  if (asset.encoding === undefined) return encoded;
  if (asset.encoding !== 'gzip' || !Number.isSafeInteger(asset.decodedBytes) || asset.decodedBytes < 0 || asset.decodedBytes > MAX_ASSET_BYTES || !/^[a-f0-9]{64}$/i.test(asset.decodedSha256))
    throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', 'Invalid decoded release identity');
  const decoded = new Uint8Array(gunzipSync(encoded, {maxOutputLength: MAX_ASSET_BYTES}));
  if (decoded.byteLength !== asset.decodedBytes || await hashBytes(decoded) !== asset.decodedSha256.toLowerCase())
    throw new ProjectToolError('E_COMPILER_RELEASE_ASSET', `Decoded release bytes differ: ${asset.path}`);
  return decoded;
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
  return adapter.prepareLegacyBuildPlan;
}

/** Local files and release decoding stop at this boundary; all checking and
 * artifact production below use exactly the same neutral compiler as browser. */
export async function prepareNodeProject(options: NodeCompileOptions) {
  if (options.mode !== undefined && !['development', 'production'].includes(options.mode)) throw new ProjectToolError('E_SDK_MODE', 'Unsupported SDK mode');
  const manifest = JSON.parse(new TextDecoder().decode(await readBounded(resolve(options.release), 16 * 1024 * 1024)));
  await assertNativeReleaseIdentity(manifest);
  if (typeof manifest.runtimeProfile !== 'string') throw new ProjectToolError('E_PROJECT_ENGINE_PROFILE', 'Release is missing its engine profile');
  const input = await projectDocument(options, manifest), document = input.document;
  const read = input.directory ? {plan: await createBuildPlan(await createSourceSnapshot(document.files), document.launch,
    {inputs: {engineProfile: manifest.runtimeProfile}})} : await readProjectDocument(document, {inputs: {engineProfile: manifest.runtimeProfile}});
  const files = snapshotTextFiles(read.plan.snapshot);
  if (read.plan.inputs.engineProfile !== manifest.runtimeProfile) throw new ProjectToolError('E_PROJECT_ENGINE_PROFILE', 'Project and release engine profiles differ');
  const configuration = decodeProjectText(read.plan.snapshot.files.find(file => file.path === 'res://project.godot')?.bytes);
  const naming = readProjectBooleanSetting(configuration ?? '', 'GodotJS', 'runtime/core/camel_case_bindings_enabled') ? 'camel' : 'snake';
  const snapshot = manifest.api?.namingProfiles?.[naming]?.typeSnapshot ?? (naming === 'snake' ? manifest.api?.typeSnapshot : undefined);
  if (!snapshot) throw new ProjectToolError('E_COMPILER_NAMING', `Release has no ${naming} declaration snapshot`);
  const root = dirname(resolve(options.release));
  const declarations = JSON.parse(new TextDecoder().decode(await releaseAsset(root, snapshot)));
  await assertNativeTypeSnapshot(manifest, declarations, naming);
  const routes: Record<string, string> = {'godot': '/godot/index.d.ts', 'godot-jsb': '/godot-jsb/index.d.ts', 'godot.annotations': '/godot.annotations/index.d.ts'};
  for (const [specifier, contract] of Object.entries(manifest.sdk?.moduleContract ?? {}) as Array<[string, any]>) routes[specifier] = contract.declaration;
  const needsSdk = read.plan.compatibility?.runtime === 'react' || [...sdkImports(files)].some(name => Object.hasOwn(manifest.sdk?.runtimeModules ?? {}, name));
  const runtimeModules: Record<string, Uint8Array> = Object.create(null);
  let vendor: Uint8Array | undefined;
  if (needsSdk) {
    vendor = await releaseAsset(root, manifest.sdk?.vendors?.[options.mode ?? 'production'] ?? manifest.sdk?.vendor);
    for (const [name, asset] of Object.entries(manifest.sdk?.runtimeModules ?? {})) runtimeModules[name] = await releaseAsset(root, asset);
  }
  const target = {engineId: manifest.engineId ?? manifest.id, engineReleaseId: manifest.id, engineProfile: manifest.runtimeProfile, naming,
    ...(needsSdk && manifest.extensionId ? {extensionId: manifest.extensionId} : {}), bindingVersion: manifest.api?.bindingVersion ?? 'unknown'};
  const environment = await createCompilerEnvironment({target, declarations, moduleDeclarations: routes, runtimeModules, vendor});
  const data = document.project ?? document;
  const converters = createBrowserResourceConverters(), resourceImports = data.resourceImports === undefined ? undefined : parseResourceImports(data.resourceImports);
  for (const request of resourceImports ?? []) if (!converters.ids.has(request.converter))
    throw new ProjectToolError('E_RESOURCE_CONVERTER', `Node has no registered producer ${request.converter}; supply a converter through the shared compiler API`);
  const preparation: PrepareBuildPlanOptions = {
    ...(data.importReceipts ? {storedImportReceipts: data.importReceipts} : {}),
    ...(resourceImports ? {resourceImports, resourceConverters: converters, resourceTarget: {resourceAbi: 'godot-4-text-resource-v1', features: {engineId: target.engineId}}} : {}),
    ...(data.importCacheObservations ? {importCacheObservations: data.importCacheObservations} : {}),
  };
  const preparePlan = await legacyPreparer(options, read.plan);
  return {plan: read.plan, environment, preparation, preparePlan,
    pack: {maxBytes: MAX_ASSET_BYTES, maxFiles: 10000}};
}

export async function checkNodeProject(options: NodeCompileOptions) {
  const request = await prepareNodeProject(options);
  const diagnostics = checkProjectTypes(request.environment.createTypeEnvironment(snapshotTextFiles(request.plan.snapshot)));
  return {ok: !diagnostics.some(item => item.category === 'error'), diagnostics, target: request.environment.identity};
}

export async function compileNodeProject(options: NodeCompileOptions) {
  const request = await prepareNodeProject(options), result = await compileProject(request);
  if (options.output) {
    const filename = resolve(options.output); await mkdir(dirname(filename), {recursive: true});
    await writeFile(filename, result.pack);
    await writeFile(filename + '.receipt.json', JSON.stringify(result.receipt, null, 2) + '\n');
    await writeFile(filename + '.manifest.json', JSON.stringify({...result.manifest, generation: 'build-' + result.buildKey,
      buildKey: result.buildKey, artifactId: result.artifactId, packSha256: result.receipt.packSha256, artifactReceipt: result.receipt}, null, 2) + '\n');
  }
  return result;
}
