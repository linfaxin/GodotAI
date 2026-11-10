import { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS, validateRuntimeManifest, type RuntimeManifestV1, type ManifestModule } from '@godot-js/react/contracts';
import { profileReference, getProfileSchema } from '@godot-js/react/schema';
import { bootstrapSource } from '@godot-js/react-build/bootstrap';
import { CANONICAL_IMPORTS } from '@godot-js/react-build/imports';
import { bundleClosedModulesWith } from '@godot-js/react-build/module-loading';
import type * as Esbuild from 'esbuild';
import type * as TS from 'typescript';
import { BrowserBuildError, type ProjectSnapshot, type RuntimeRelease, type BuildArtifact, type Diagnostic } from './contracts.js';
import { sha256, canonicalJson, utf8, text, buildKey, COMPILER_VERSION, selectMainEntry } from './snapshot.js';
import { packProject } from './pck.js';
import type { ModuleGraph } from './resolve.js';
import { checkProjectTypes, type TypecheckInput, type TypecheckResult, type TypeProject } from './typecheck.js';
import { compileAssets, type ImageDecoder } from './assets.js';

export interface CompilerProject extends TypeProject {
  hash: string;
  files: Record<string, Uint8Array>;
  runtimeGraph: ModuleGraph;
  policyId?: string;
  lock?: { policyId: string };
}
export interface CompilerCoreEnvironment<Resolved extends CompilerProject = CompilerProject> {
  bundler: Pick<typeof Esbuild, 'build' | 'transform' | 'formatMessages'>;
  typescript: typeof TS;
  release: RuntimeRelease;
  /** Verified release bytes, indexed by descriptor path. */
  releaseFiles: ReadonlyMap<string, Uint8Array>;
  resolveProject(snapshot: ProjectSnapshot, release: RuntimeRelease, options: { signal?: AbortSignal }): Promise<Resolved>;
  resolveModule?(specifier: string, importer: string, kind: string, project: Resolved): string;
  check?: (input: TypecheckInput) => Promise<TypecheckResult>;
  progress?: (stage: string) => void;
  /** Optional image adapter for non-browser hosts; browsers use the native decoder. */
  decodeImage?: ImageDecoder;
}
const aborted = (signal?: AbortSignal) => signal?.throwIfAborted();
export function createBrowserCompilerCore<Resolved extends CompilerProject>(environment: CompilerCoreEnvironment<Resolved>) {
  const { bundler, typescript: ts, release, releaseFiles } = environment;
  if (release.runtimeAbi !== RUNTIME_ABI || release.nativeBridgeAbi !== NATIVE_BRIDGE_ABI || canonicalJson(release.react) !== canonicalJson(REACT_VERSIONS)) throw new BrowserBuildError('E_RELEASE_TUPLE', 'Release SDK/React tuple is incompatible with this compiler');
  const bytesFor = (predicate: (file: RuntimeRelease['files'][number]) => boolean): Uint8Array => {
    const file = release.files.find(predicate);
    const bytes = file && releaseFiles.get(file.path);
    if (!file || !bytes) throw new BrowserBuildError('E_RELEASE_ASSET', 'Required release asset is missing');
    return bytes;
  };
  async function prepare(snapshot: ProjectSnapshot, signal?: AbortSignal) {
    aborted(signal); environment.progress?.('resolving');
    const files = new Map(snapshot.files);
    for (const file of release.files) if (file.virtualPath) {
      const bytes = releaseFiles.get(file.path);
      if (!bytes) throw new BrowserBuildError('E_RELEASE_TYPES', `Missing declaration ${file.path}`);
      if (files.has(file.virtualPath)) throw new BrowserBuildError('E_PROJECT_PATH', 'Project shadows a release declaration');
      files.set(file.virtualPath, bytes);
    }
    const project = await environment.resolveProject({ ...snapshot, files }, release, { signal });
    aborted(signal);
    const profile = profileReference(snapshot.config.profileId);
    const publishedProfile = release.profiles[snapshot.config.profileId];
    if (!publishedProfile || publishedProfile.hash !== profile.hash) throw new BrowserBuildError('E_PROFILE_UNSUPPORTED', `Release does not support ${snapshot.config.profileId}`);
    const key = await buildKey({ sourceHash: snapshot.sourceHash, resolutionHash: project.hash, runtimeRelease: release.id,
      sdkMode: snapshot.config.mode, profileId: snapshot.config.profileId, compilerVersion: COMPILER_VERSION,
      typescriptVersion: ts.version, typeOptionsHash: await sha256(canonicalJson({ strict: true, skipLibCheck: false, jsx: snapshot.config.mode, policy: project.policyId ?? project.lock?.policyId })) });
    const entries = snapshot.config.entries ?? { app: { module: snapshot.config.entry, export: 'default', props: snapshot.config.props ?? {} } };
    const checkInput: TypecheckInput = { project, entries, mode: snapshot.config.mode, profileId: snapshot.config.profileId,
      sdkPackageRoot: release.sdkPackageRoot, typesRoot: release.typesRoot, libRoot: release.libRoot,
      projectKey: key, revision: snapshot.revision };
    return { project, key, entries, profile, checkInput };
  }
  async function check(snapshot: ProjectSnapshot, options: { signal?: AbortSignal } = {}) {
    const prepared = await prepare(snapshot, options.signal);
    environment.progress?.('checking');
    const result = environment.check ? await environment.check(prepared.checkInput) : checkProjectTypes(ts, prepared.checkInput);
    aborted(options.signal);
    if (result.projectKey !== prepared.key || result.revision !== snapshot.revision) throw new BrowserBuildError('E_STALE_CHECK', 'Type results belong to a different frozen build');
    return { ...result, buildKey: prepared.key, resolution: prepared.project };
  }
  async function build(snapshot: ProjectSnapshot, options: { signal?: AbortSignal } = {}): Promise<BuildArtifact> {
    const signal = options.signal, prepared = await prepare(snapshot, signal);
    const { project, key, entries, profile } = prepared;
    const generation = `browser-${key}`, base = `res://.godot/GodotJS/react-build/${generation}`;
    environment.progress?.('checking');
    const checked = environment.check ? await environment.check(prepared.checkInput) : checkProjectTypes(ts, prepared.checkInput);
    aborted(signal);
    if (checked.projectKey !== key || checked.revision !== snapshot.revision) throw new BrowserBuildError('E_STALE_CHECK', 'Type results belong to a different frozen build');
    if (!checked.ok) throw new BrowserBuildError('E_TYPESCRIPT', 'Project has semantic type errors', checked.diagnostics);
    environment.progress?.('bundling');
    const files = new Map<string, Uint8Array>(), modules: Record<string, ManifestModule> = {};
    const compiledAssets = await compileAssets(snapshot, { generation, signal, decodeImage: environment.decodeImage });
    for (const resource of Object.values(compiledAssets.resources)) if (!getProfileSchema(snapshot.config.profileId).profile.resources.includes(resource.type))
      throw new BrowserBuildError('E_PROFILE_RESOURCE', `Resource ${resource.type} requires a different capability profile`);
    for (const [uri, bytes] of compiledAssets.files) files.set(uri, bytes);
    const runtimeUri = `${base}/runtime/runtime.js`;
    const runtime = bytesFor(file => file.kind === 'sdk' && file.sdkMode === snapshot.config.mode);
    files.set(runtimeUri, runtime);
    modules.runtime = { uri: runtimeUri, sha256: await sha256(runtime), dependencies: [], kind: 'vendor' };
    const shims: Record<string, string> = {};
    for (const [specifier, member] of Object.entries(CANONICAL_IMPORTS)) {
      const id = `shim-${Object.keys(shims).length}`, uri = `${base}/runtime/${id}.js`;
      const contents = utf8.encode(`module.exports=require(${JSON.stringify(runtimeUri)}).${member};\n`);
      shims[specifier] = uri; files.set(uri, contents);
      modules[id] = { uri, sha256: await sha256(contents), dependencies: ['runtime'], kind: 'vendor' };
    }
    const sourceOrigins: RuntimeManifestV1['sourceOrigins'] extends Readonly<infer O> ? O : never = { ...compiledAssets.sourceOrigins };
    const edgeIndex = new Map(project.runtimeGraph.edges.map(edge => [edge.importer + '\0' + edge.specifier + '\0' + edge.mode, edge]));
    const plugin: Esbuild.Plugin = { name: 'frozen-godot-project', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (Object.hasOwn(shims, args.path)) return { path: shims[args.path], external: true };
        if (/^(?:react(?:\/|$)|scheduler(?:\/|$)|@godot-js\/react(?:\/|$))/.test(args.path)) throw new BrowserBuildError('E_SDK_SUBPATH', `Unsupported canonical import ${args.path}`);
        if (args.kind === 'entry-point') {
          if (!project.files[args.path]) throw new BrowserBuildError('E_ENTRY', `Missing entry ${args.path}`);
          return { path: args.path, namespace: 'project' };
        }
        if (environment.resolveModule) {
          const resolved = environment.resolveModule(args.path, args.importer, args.kind, project);
          if (!project.files[resolved]) throw new BrowserBuildError('E_UNRESOLVED_MODULE', `Missing module ${resolved}`);
          return { path: resolved, namespace: 'project' };
        }
        const mode = args.kind === 'require-call' || args.kind === 'require-resolve' ? 'require' : 'import';
        const edge = edgeIndex.get(args.importer + '\0' + args.path + '\0' + mode);
        if (!edge || edge.external || !project.files[edge.resolved]) throw new BrowserBuildError('E_UNRESOLVED_MODULE', `Import is not in the frozen runtime graph: ${args.path} from ${args.importer}`);
        return { path: edge.resolved, namespace: 'project' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'project' }, args => {
        const bytes = project.files[args.path];
        const extension = args.path.split('.').pop();
        const loader: Esbuild.Loader = extension === 'tsx' ? 'tsx' : ['ts', 'mts', 'cts'].includes(extension!) ? 'ts' : extension === 'json' ? 'json' : extension === 'jsx' ? 'jsx' : 'js';
        return { contents: bytes, loader };
      });
    } };
    const manifests: RuntimeManifestV1['entries'] extends Readonly<infer O> ? O : never = {};
    const scripts: RuntimeManifestV1['nativeScripts'] extends Readonly<infer O> ? O : never = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^[a-z][a-z0-9_-]*$/i.test(id)) throw new BrowserBuildError('E_ENTRY_ID', `Invalid entry id ${id}`);
      aborted(signal);
      const moduleUri = `${base}/modules/${id}.js`, outfile = `/modules/${id}.js`;
      const result = await bundleClosedModulesWith(bundler, { entryPoints: [entry.module], bundle: true, write: false,
        platform: 'neutral', mainFields: ['main', 'module'], format: 'cjs', target: 'es2022', jsx: 'automatic',
        jsxDev: snapshot.config.mode === 'development', sourcemap: 'external', sourcesContent: true, outfile,
        define: { 'process.env.NODE_ENV': JSON.stringify(snapshot.config.mode) }, plugins: [plugin] }, Object.values(shims), shims);
      for (const output of result.outputFiles!) {
        if (output.path.endsWith('.map')) {
          const map = JSON.parse(output.text);
          map.sourceRoot = ''; map.file = `${id}.js`;
          map.sources = map.sources.map((source: string) => source.startsWith('project:') ? 'res://' + source.slice('project:'.length).replace(/^\//, '') : source);
          files.set(moduleUri + '.map', utf8.encode(JSON.stringify(map)));
        } else files.set(moduleUri, utf8.encode(output.text + `\n//# sourceMappingURL=${id}.js.map\n`));
      }
      modules[`entry-${id}`] = { uri: moduleUri, sha256: await sha256(files.get(moduleUri)!), dependencies: Object.keys(modules).filter(name => name === 'runtime' || name.startsWith('shim-')), kind: 'view' };
      sourceOrigins[moduleUri] = { source: 'res://' + entry.module.replace(/^\//, ''), line: 0, column: 0 };
      const script = `res://generated/react/entries/${id}.ts`, output = `res://.godot/GodotJS/generated/react/entries/${id}.js`, scene = `res://generated/react/scenes/${id}.tscn`;
      const bootstrap = bootstrapSource(id, 'generated/react');
      const emitted = await bundler.transform(bootstrap, { loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: script, sourcemap: 'external' });
      const map = JSON.parse(emitted.map); map.sources = [script]; map.sourceRoot = ''; map.file = `${id}.js`;
      files.set(script, utf8.encode(bootstrap)); files.set(output, utf8.encode(emitted.code + `\n//# sourceMappingURL=${id}.js.map\n`)); files.set(output + '.map', utf8.encode(JSON.stringify(map)));
      files.set(scene, utf8.encode(`[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="${script}" id="1"]\n[node name="${id}" type="Node"]\nscript=ExtResource("1")\nmetadata/_react_generation="${generation}"\nmetadata/_react_props=${JSON.stringify(canonicalJson(entry.props ?? {}))}\n`));
      scripts[id] = { source: script, output, sha256: await sha256(files.get(output)!), dependencies: [] };
      manifests[id] = { id, module: `entry-${id}`, exportName: entry.export ?? 'default', script, scene, startupAssets: [] };
    }
    const artifacts: RuntimeManifestV1['artifacts'] extends Readonly<infer O> ? O : never = {};
    for (const [uri, bytes] of files) artifacts[uri] = { owner: 'compiler', sha256: await sha256(bytes), kind: uri.endsWith('.ts') ? 'native-script-source' : uri.endsWith('.map') ? 'source-map' : uri.endsWith('.tscn') ? 'scene' : 'javascript' };
    const manifest: RuntimeManifestV1 = { schemaVersion: 1, generation, sourceSnapshotHash: snapshot.sourceHash,
      compilerVersion: COMPILER_VERSION, runtimeAbi: RUNTIME_ABI, nativeBridgeAbi: NATIVE_BRIDGE_ABI,
      entryInterfaceHash: await sha256(canonicalJson(Object.entries(manifests).map(([id, e]) => [id, e.exportName, e.script, entries[id].props ?? {}]))),
      mode: snapshot.config.mode, target: { ...(release.target ?? { sourceCommit: 'unknown', sourceDiffHash: '0'.repeat(64),
        godotVersion: release.engine.godotVersion, engine: 'web', platform: 'web', arch: 'wasm32', buildFlags: { threads: false } }), godotSchemaHash: profile.hash },
      react: { ...REACT_VERSIONS }, profile, entries: manifests, modules, resources: compiledAssets.resources, nativeScripts: scripts, artifacts, sourceOrigins };
    validateRuntimeManifest(manifest);
    const path = `res://generated/react/manifests/${generation}.json`, manifestBytes = utf8.encode(canonicalJson(manifest));
    files.set(path, manifestBytes); files.set('res://generated/react/active.json', utf8.encode(canonicalJson({ schemaVersion: 1, generation, manifestPath: path, manifestSha256: await sha256(manifestBytes), state: 'READY' })));
    files.set('res://project.godot', utf8.encode(`config_version=5\n[application]\nconfig/name="GodotJS Playground"\nrun/main_scene="${manifests[selectMainEntry(snapshot.config)].scene}"\n[display]\nwindow/size/viewport_width=640\nwindow/size/viewport_height=360\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.06, 0.08, 0.11, 1)\n[physics]\n2d/physics_engine="${getProfileSchema(snapshot.config.profileId).profile.features.physics ? 'GodotPhysics2D' : 'Dummy'}"\n3d/physics_engine="Dummy"\n[godotjs]\nreact/enabled=true\n[GodotJS]\nruntime/debugger/debugger_port=0\n`));
    files.set('res://.godot/global_script_class_cache.cfg', utf8.encode('list=Array[Dictionary]([])\n'));
    aborted(signal); environment.progress?.('packing');
    const version = release.engine.godotVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    const packed = packProject(files, { engineVersion: version ? [Number(version[1]), Number(version[2]), Number(version[3] ?? 0)] : undefined });
    return { revision: snapshot.revision, buildKey: key, generation, runtimeRelease: release.id, manifest, files, pack: packed.pack,
      diagnostics: checked.diagnostics as Diagnostic[], resolutionHash: project.hash };
  }
  return { build, check };
}
