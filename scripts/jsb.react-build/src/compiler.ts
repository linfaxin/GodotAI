import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as esbuild from "esbuild";
import { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS, canonicalJson, validateRuntimeManifest, type RuntimeManifestV1, type ManifestArtifact, type ManifestModule, type ManifestResource, type TargetCertification } from "@godot-js/react/contracts";
import { profileReference,HOST_SCHEMA,PHYSICS_HOST_SCHEMA,getHostSchema } from "@godot-js/react/schema";
import { loadConfig, entryConfig } from "./config.js";
import { atomicJson, command, exists, fromRes, generationId, readJson, sha256, slash, snapshotProject, toRes, verifySnapshot, within, write, type Snapshot } from "./fs.js";
import { acquirePublisher, generatedRoot, sealManifest, stopManagedApplications } from "./publication.js";
import { importTemplate, ResourceGraph, verifyTemplatesNative,freezeResourceText,rewriteTemplateModule, type ImportedTemplate } from "./template.js";
import { normalizeSourceMap } from "./source-maps.js";
import { bootstrapSource } from "./bootstrap.js";
export { bootstrapSource } from "./bootstrap.js";
import { generateNativeInterface } from "./native-interfaces.js";
import {discoverNativeTarget,discoverNativeReport} from "./native-target.js";
import { fail, type BuildOptions, type BuildResult, type ProjectConfig } from "./types.js";
import {bundleClosedModules} from "./module-loading.js";

export const COMPILER_VERSION = "0.1.0";
interface PreparedProject { config: ProjectConfig; snapshot: Snapshot; templates: ImportedTemplate[]; resources: Map<string, ManifestResource>; runtimeRoot: string; compilerOptions: ts.CompilerOptions; program: ts.Program; }
function packageRoot(filename: string, name: string): string {
  let current = path.dirname(filename);
  while (path.dirname(current) !== current) {
    try { const metadata = JSON.parse(ts.sys.readFile(path.join(current, "package.json")) ?? "null") as { name?: string } | null; if (metadata?.name === name) return current; } catch { /* Search parent. */ }
    current = path.dirname(current);
  }
  return fail("E_RUNTIME_PACKAGE", `Cannot identify package ${name}`);
}
export function resolveRuntimeRoot(config: ProjectConfig): string {
  if (config.runtimePackage) { const root = path.resolve(config.projectRoot, config.runtimePackage); if (!ts.sys.fileExists(path.join(root, "package.json"))) fail("E_RUNTIME_PACKAGE", `Missing ${root}/package.json`); return root; }
  const resolver = createRequire(path.join(config.projectRoot, "package.json"));
  try { return packageRoot(resolver.resolve("@godot-js/react"), "@godot-js/react"); }
  catch { return packageRoot(createRequire(import.meta.url).resolve("@godot-js/react"), "@godot-js/react"); }
}

async function prepare(config: ProjectConfig, staging: string): Promise<PreparedProject> {
  const snapshot = await snapshotProject(config.projectRoot, path.join(staging, "snapshot", "project"), config.generatedDir);
  if(snapshot.hashes[slash(path.relative(config.projectRoot,config.configFile))]!==config.configHash)fail("E_SOURCE_CHANGED","Configuration changed before the source snapshot was frozen");
  const runtimeRoot = resolveRuntimeRoot(config), templateDir = path.join(snapshot.root, config.generatedDir, "templates"), templates: ImportedTemplate[] = [], resources = new Map<string, ManifestResource>();
  const runtimeResolver=createRequire(path.join(runtimeRoot,"package.json"));
  for(const [specifier,expected] of [["react",REACT_VERSIONS.react],["react-reconciler",REACT_VERSIONS.reconciler],["scheduler",REACT_VERSIONS.scheduler]]){
    let version:unknown;try{version=JSON.parse(await fs.readFile(runtimeResolver.resolve(`${specifier}/package.json`),"utf8")).version;}catch{fail("E_RUNTIME_DEPENDENCY",`Missing certified runtime dependency ${specifier}`);}
    if(version!==expected)fail("E_RUNTIME_VERSION",`${specifier} must be ${expected}, received ${String(version)}`);
  }
  for (const [id, setting] of Object.entries(config.templates ?? {})) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) fail("E_TEMPLATE_ID", `Invalid template id ${id}`);
    const template = await importTemplate(id, typeof setting === "string" ? setting : setting.source, snapshot, templateDir, { profile: typeof setting === "string" ? "template-t0" : setting.profile, hostProfile: config.profileId }); templates.push(template);
    for (const resource of template.plan.resources) resources.set(resource.resourceId, { uri: resource.uri, sha256: resource.sha256, type: resource.type, dependencies: [...resource.dependencies], importedArtifacts: [] });
  }
  const graph = new ResourceGraph(snapshot);
  for (const [id, setting] of Object.entries(config.assets ?? {})) {
    const source = typeof setting === "string" ? setting : setting.source, type = typeof setting === "string" ? "Resource" : setting.type ?? "Resource";
    const resource = await graph.load(`res://${slash(source)}`, type);
    resources.set(id, { uri: resource.uri, sha256: resource.sha256, type: resource.type, dependencies: [...resource.dependencies], importedArtifacts: [] });
  }
  for (const resource of graph.resources.values()) if (![...resources.values()].some(r => r.uri === resource.uri)) resources.set(resource.resourceId, { uri: resource.uri, sha256: resource.sha256, type: resource.type, dependencies: [...resource.dependencies], importedArtifacts: [] });
  // Preserve dependency IDs even when the project gives the root asset a friendly alias.
  for (const resource of graph.resources.values()) for (const dep of resource.dependencies) if (!resources.has(dep)) { const target = [...graph.resources.values()].find(r => r.resourceId === dep)!; resources.set(dep, { uri: target.uri, sha256: target.sha256, type: target.type, dependencies: [...target.dependencies], importedArtifacts: [] }); }
  const configPath = path.join(snapshot.root, config.tsconfig ?? "tsconfig.json");
  let parsed: ts.ParsedCommandLine;
  if (await exists(configPath)) {
    const file = ts.readConfigFile(configPath, ts.sys.readFile); if (file.error) fail("E_TYPESCRIPT_CONFIG", formatDiagnostics([file.error]));
    parsed = ts.parseJsonConfigFileContent(file.config, ts.sys, snapshot.root, undefined, configPath); if (parsed.errors.length) fail("E_TYPESCRIPT_CONFIG", formatDiagnostics(parsed.errors));
  } else parsed = { options: {}, fileNames: [], errors: [] };
  // Installed packages normally hoist @types/react beside the application,
  // rather than placing SDK development dependencies inside the runtime package.
  let reactTypes:string|undefined;
  for(const base of [config.projectRoot,runtimeRoot]){
    try{reactTypes=path.dirname(createRequire(path.join(base,"package.json")).resolve("@types/react/package.json"));break;}catch{/* Try the runtime's dependency layout next. */}
  }
  if(!reactTypes)fail("E_REACT_TYPES","Install @types/react in the application to type-check React components");
  const typeRoot = path.dirname(reactTypes);
  const paths: Record<string, string[]> = {
    ...(parsed.options.paths ?? {}),
    "@godot-js/react": [path.join(runtimeRoot, "dist", "index.d.ts")],
    "@godot-js/react/*": [path.join(runtimeRoot, "dist", "*")],
    "react": [path.join(reactTypes, "index.d.ts")],
    "react/*": [path.join(reactTypes, "*")],
    "@project/react-templates/*": [path.join(templateDir, "*")],
  };
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options, strict: true, skipLibCheck: false, noEmitOnError: true, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
    jsx: config.mode === "development" ? ts.JsxEmit.ReactJSXDev : ts.JsxEmit.ReactJSX, jsxImportSource: "react",
    paths, rootDir: snapshot.root, typeRoots: [...new Set([...(ts.getEffectiveTypeRoots(parsed.options,{getCurrentDirectory:()=>config.projectRoot}) ?? []), typeRoot])],
    types: [...new Set([...(parsed.options.types ?? []), "react"])],
  };
  const roots = [...new Set([...parsed.fileNames, ...Object.keys(config.entries).map(id => within(snapshot.root, entryConfig(config, id).module)), ...templates.map(t => t.module)])];
  for (const id of Object.keys(config.entries)) {
    const entry = entryConfig(config,id), checkFile=path.join(snapshot.root,config.generatedDir,"entry-checks",`${id}.tsx`);
    let relative = slash(path.relative(path.dirname(checkFile),within(snapshot.root,entry.module))).replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.tsx?$/, ".js"); if(!relative.startsWith("."))relative=`./${relative}`;
    await write(checkFile,`import * as Module from ${JSON.stringify(relative)};\nconst Entry = Module[${JSON.stringify(entry.export)}];\nconst configuredProps = ${canonicalJson(entry.props ?? {})} as const;\nexport const entryTypeCheck = <Entry {...configuredProps}/>;\n`);
    roots.push(checkFile);
  }
  if (config.verification?.entry) roots.push(within(snapshot.root, config.verification.entry));
  const program = ts.createProgram(roots, compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program); if (diagnostics.length) fail("E_TYPESCRIPT", formatDiagnostics(diagnostics));
  const checker=program.getTypeChecker(),knownHosts=new Set([...Object.keys(HOST_SCHEMA),...Object.keys(PHYSICS_HOST_SCHEMA)]);
  for(const file of program.getSourceFiles())if(!file.isDeclarationFile&&file.fileName.startsWith(snapshot.root)){
    const visit=(node:ts.Node)=>{if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){let symbol=checker.getSymbolAtLocation(node.tagName);if(symbol?.flags&&symbol.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);if(symbol&&knownHosts.has(symbol.name)&&symbol.declarations?.some(d=>path.resolve(d.getSourceFile().fileName).startsWith(path.join(runtimeRoot,"dist")))){try{getHostSchema(symbol.name,config.profileId);}catch{const point=file.getLineAndCharacterOfPosition(node.getStart(file));fail("E_PROFILE_UNSUPPORTED",`${symbol.name} requires a different capability profile (${slash(path.relative(snapshot.root,file.fileName))}:${point.line+1}:${point.character+1})`);}}}ts.forEachChild(node,visit);};visit(file);
  }
  for (const id of Object.keys(config.entries)) {
    const entry = entryConfig(config, id), file = program.getSourceFile(within(snapshot.root, entry.module));
    if (!file) fail("E_ENTRY", `Entry ${id} is not a program source`);
    const symbol = program.getTypeChecker().getSymbolAtLocation(file);
    if (!symbol || !program.getTypeChecker().getExportsOfModule(symbol).some(s => s.name === entry.export)) fail("E_ENTRY_EXPORT", `Missing ${entry.export} export in ${entry.module}`);
  }
  return { config, snapshot, templates, resources, runtimeRoot, compilerOptions, program };
}
export function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string { return ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }); }
function nativeSourceMap(text:string,source:string,output:string,contents:string):string{const map=JSON.parse(text) as Record<string,unknown>;map.sourceRoot="";map.sources=[source];map.sourcesContent=[contents];map.file=path.posix.basename(output);return `${JSON.stringify(map)}\n`;}

export async function checkProject(options: BuildOptions = {}): Promise<{ ok: true; files: number; templates: number }> {
  const config = await loadConfig(options), staging = path.join(generatedRoot(config), "checks", generationId());
  try { const prepared = await prepare(config, staging); return { ok: true, files: prepared.program.getSourceFiles().length, templates: prepared.templates.length }; }
  finally { await fs.rm(staging, { recursive: true, force: true }); }
}
export async function generateProjectTypes(options: BuildOptions = {}): Promise<{ files: string[] }> {
  const config = await loadConfig(options), staging = path.join(generatedRoot(config), "checks", generationId());
  try {
    const p = await prepare(config, staging), files: string[] = [];
    for (const template of p.templates) { const target = path.join(generatedRoot(config), "templates", `${template.id}.d.ts`); await write(target, await fs.readFile(template.declaration)); files.push(target); }
    await atomicJson(path.join(generatedRoot(config), "tsconfig.paths.json"), { compilerOptions: { paths: { "@project/react-templates/*": [`./templates/*`] } } });
    return { files };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

function externalNative(): esbuild.Plugin {
  return { name: "godot-native-builtins", setup(build) { build.onResolve({ filter: /^(?:godot(?:[./]|$)|godot-jsb$|jsb\.)/ }, args => ({ path: args.path, external: true })); } };
}
async function bundleRuntime(prepared: PreparedProject, generation: string): Promise<{ uri: string; outputs: Record<string, string>; shims: Record<string, string> }> {
  const { config, runtimeRoot, snapshot, templates } = prepared;
  const resolver = createRequire(path.join(runtimeRoot, "package.json"));
  const runtimeMain = resolver.resolve("@godot-js/react"), godot = resolver.resolve("@godot-js/react/godot"), scheduler = resolver.resolve("@godot-js/react/scheduler"), nativeInterfaces = resolver.resolve("@godot-js/react/native-interfaces"),contracts=resolver.resolve("@godot-js/react/contracts"),schema=resolver.resolve("@godot-js/react/schema");
  const nodePaths = [path.join(runtimeRoot, "node_modules"), path.join(config.projectRoot, "node_modules")];
  const outfile = within(config.projectRoot, `.godot/GodotJS/react-build/${generation}/runtime/runtime.js`);
  const bundle = await esbuild.build({ stdin: { contents: `exports.React=require("react");exports.jsxRuntime=require("react/jsx-runtime");exports.jsxDevRuntime=require("react/jsx-dev-runtime");exports.sdk=require(${JSON.stringify(runtimeMain)});exports.godot=require(${JSON.stringify(godot)});exports.nativeInterfaces=require(${JSON.stringify(nativeInterfaces)});exports.scheduler=require(${JSON.stringify(scheduler)});exports.contracts=require(${JSON.stringify(contracts)});exports.schema=require(${JSON.stringify(schema)});`, resolveDir: runtimeRoot, sourcefile: "godot-react-runtime-entry.js", loader: "js" },
    bundle: true, write: false, platform: "neutral", format: "cjs", mainFields: ["main", "module"], target: "es2022", outfile, sourcemap: "external", sourcesContent: true, nodePaths,inject:[path.join(runtimeRoot,"dist","internal","performance.mjs")],
    define: { "process.env.NODE_ENV": JSON.stringify(config.mode) }, plugins: [externalNative(), { name: "godot-scheduler", setup(b) { b.onResolve({ filter: /^scheduler$/ }, () => ({ path: scheduler })); } }],
  });
  const outputs: Record<string, string> = {};
  for (const file of bundle.outputFiles!) outputs[toRes(config.projectRoot, file.path)] = file.path.endsWith(".map") ? normalizeSourceMap(file.text, outfile, snapshot.root, runtimeRoot, templates) : `${file.text}\n//# sourceMappingURL=runtime.js.map\n`;
  const uri = toRes(config.projectRoot, outfile), shims: Record<string, string> = {};
  for (const [specifier, member] of Object.entries({ react: "React", "react/jsx-runtime": "jsxRuntime", "react/jsx-dev-runtime": "jsxDevRuntime", "@godot-js/react": "sdk", "@godot-js/react/godot": "godot", "@godot-js/react/native-interfaces": "nativeInterfaces",scheduler:"scheduler","@godot-js/react/scheduler":"scheduler","@godot-js/react/contracts":"contracts","@godot-js/react/schema":"schema" })) {
    const shimUri = `res://.godot/GodotJS/react-build/${generation}/runtime/shim-${Object.keys(shims).length}.js`;
    outputs[shimUri] = `module.exports=require(${JSON.stringify(uri)}).${member};\n`; shims[specifier] = shimUri;
  }
  return { uri, outputs, shims };
}


export async function buildProject(options: BuildOptions = {}): Promise<BuildResult> {
  const config = await loadConfig(options), generation = generationId();
  await stopManagedApplications(config);
  const publication = await acquirePublisher(config, generation,options.waitPublisherMs);
  const staging = path.join(generatedRoot(config), "staging", generation), artifactBytes = new Map<string, string>();
  try {
    const p = await prepare(config, staging); await publication.state("SNAPSHOTTED");
    artifactBytes.set(`res://.godot/GodotJS/react-build/${generation}/source-snapshot.json`,`${canonicalJson({schemaVersion:1,hash:p.snapshot.hash,files:p.snapshot.hashes})}\n`);
    const certification=config.godot?await discoverNativeReport(config.godot,config.projectRoot,config.nativeReport):undefined;
    if(certification){
      for(const [key,value] of Object.entries(config.target??{}))if(key in certification.target){const actual=(certification.target as Record<string,unknown>)[key];if(key==="buildFlags"){for(const [flag,setting]of Object.entries(value as Record<string,unknown>))if((actual as Record<string,unknown>)[flag]!==setting)fail("E_NATIVE_TARGET",`Configured build flag conflicts with native report: ${flag}`);}else if(canonicalJson(value)!==canonicalJson(actual))fail("E_NATIVE_TARGET",`Configured ${key} conflicts with native report`);}
      artifactBytes.set(`res://.godot/GodotJS/react-build/${generation}/native-build-report.json`,certification.bytes);
    }
    if (config.godot && options.importResources !== false) await verifyTemplatesNative(config, p.snapshot, p.templates, config.godot,publication.command);
    const resourceUris=new Map([...p.resources.values()].map(resource=>[resource.uri,`res://${config.generatedDir}/resources/${generation}/${resource.uri.slice(6)}`]));
    const frozenResources=new Map<string,{uri:string;sha256:string}>();
    for(const [source,uri]of resourceUris){const bytes=freezeResourceText(await fs.readFile(fromRes(p.snapshot.root,source),"utf8"),resourceUris);artifactBytes.set(uri,bytes);frozenResources.set(source,{uri,sha256:sha256(bytes)});}
    for(const [id,resource]of p.resources)p.resources.set(id,{...resource,...frozenResources.get(resource.uri)!});
    for(const template of p.templates){template.plan={...template.plan,resources:template.plan.resources.map(resource=>({...resource,...frozenResources.get(resource.uri)!}))};await rewriteTemplateModule(template);}
    const vendor = await bundleRuntime(p, generation); for (const [uri, bytes] of Object.entries(vendor.outputs)) artifactBytes.set(uri, bytes);
    const modules: Record<string, ManifestModule> = {}, origins: RuntimeManifestV1["sourceOrigins"] extends Readonly<infer T> ? T : never = {};
    for(const [source,uri]of resourceUris)origins[uri]={source,line:0,column:0};
    modules.runtime = { uri: vendor.uri, sha256: sha256(vendor.outputs[vendor.uri]), dependencies: [], kind: "vendor" };
    let shimIndex = 0;
    for (const uri of Object.values(vendor.shims)) modules[`shim-${shimIndex++}`] = { uri, sha256: sha256(vendor.outputs[uri]), dependencies: ["runtime"], kind: "vendor" };
    const sdkPlugin: esbuild.Plugin = { name: "godot-canonical-modules", setup(b) {
      b.onResolve({ filter: /^(?:react(?:\/.*)?|scheduler(?:\/.*)?|@godot-js\/react(?:\/.*)?)$/ }, args => { const uri = vendor.shims[args.path]; if (!uri) fail("E_SDK_SUBPATH", `Unsupported SDK/runtime import ${args.path}`); return { path: uri, external: true }; });
      b.onResolve({filter:/^(?:react-dom|react-native|react-reconciler)(?:\/|$)/},args=>fail("E_RENDERER_IMPORT",`A second renderer is outside the Godot React profile: ${args.path}`));
      b.onResolve({ filter: /^@project\/react-templates\// }, args => { const id = args.path.slice("@project/react-templates/".length), template = p.templates.find(t => t.id === id); if (!template) fail("E_TEMPLATE_ID", `Unknown template ${id}`); return { path: template.module }; });
      b.onResolve({ filter: /\.tscn$/ }, args => fail("E_TEMPLATE_IMPORT_FORM", `Use @project/react-templates/<id>, not ${args.path}`));
      b.onResolve({ filter: /^node:/ }, args => fail("E_NODE_DEPENDENCY", `Node builtin in client component: ${args.path}`));
    } };
    const entryModules = new Map<string, string>();
    const bundleEntry = async (id: string, file: string, kind: "view" | "model") => {
      const outfile = within(config.projectRoot, `.godot/GodotJS/react-build/${generation}/modules/${id}.js`);
      const result = await bundleClosedModules({ entryPoints: [within(p.snapshot.root, file)], absWorkingDir: p.snapshot.root, bundle: true, write: false, platform: "neutral", mainFields: ["main", "module"], format: "cjs", target: "es2022", jsx: "automatic", jsxDev: config.mode === "development", sourcemap: "external", sourcesContent: true, outfile, nodePaths: [path.join(config.projectRoot, "node_modules"), path.join(p.runtimeRoot, "node_modules")], define: { "process.env.NODE_ENV": JSON.stringify(config.mode) }, plugins: [sdkPlugin, externalNative()] },Object.values(vendor.shims));
      for (const output of result.outputFiles!) artifactBytes.set(toRes(config.projectRoot, output.path), output.path.endsWith(".map") ? normalizeSourceMap(output.text, outfile, p.snapshot.root, p.runtimeRoot, p.templates) : `${output.text}\n//# sourceMappingURL=${path.basename(outfile)}.map\n`);
      const uri = toRes(config.projectRoot, outfile); modules[id] = { uri, sha256: sha256(artifactBytes.get(uri)!), dependencies: [...Object.keys(modules).filter(x => x === "runtime" || x.startsWith("shim-"))], kind }; origins[uri] = { source: `res://${slash(file)}`, line: 0, column: 0 }; entryModules.set(id, uri);
    };
    for (const id of Object.keys(config.entries)) await bundleEntry(`entry-${id}`, entryConfig(config, id).module, "view");
    if (config.verification?.entry) await bundleEntry("verification", config.verification.entry, "model");
    const entries: RuntimeManifestV1["entries"] extends Readonly<infer T> ? T : never = {}, nativeScripts: RuntimeManifestV1["nativeScripts"] extends Readonly<infer T> ? T : never = {};
    const nativeScriptProfiles: Record<string, {type:string;script:string;schemaHash:string}> = {};
    for (const [profile, schema] of Object.entries(config.nativeInterfaces ?? {})) {
      const generated = generateNativeInterface(schema, { profile, generatedDir: `${config.generatedDir}/interfaces/${generation}` });
      const source = `res://${generated.relativeSource}`, output = `res://.godot/GodotJS/${generated.relativeSource.replace(/\.ts$/, ".js")}`;
      // Native script identity stays a separate module; only its framework import is canonicalized.
      const emitted = ts.transpileModule(generated.source.replace('"@godot-js/react/native-interfaces"', JSON.stringify(vendor.shims["@godot-js/react/native-interfaces"])), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true, experimentalDecorators: false, newLine: ts.NewLineKind.LineFeed }, fileName: generated.relativeSource, reportDiagnostics: true });
      if (emitted.diagnostics?.length) fail("E_NATIVE_INTERFACE", formatDiagnostics(emitted.diagnostics));
      const sourceText=generated.source.replace('"@godot-js/react/native-interfaces"', JSON.stringify(vendor.shims["@godot-js/react/native-interfaces"]));
      artifactBytes.set(source, sourceText); artifactBytes.set(output, emitted.outputText); if (emitted.sourceMapText) artifactBytes.set(`${output}.map`, nativeSourceMap(emitted.sourceMapText,source,output,sourceText));
      nativeScripts[`profile-${profile}`] = { source, output, sha256: sha256(emitted.outputText), dependencies: [] };
      origins[source] = {source:toRes(config.projectRoot,config.configFile),line:0,column:0};
      nativeScriptProfiles[profile] = { type: generated.nativeLeaf, script: source, schemaHash: generated.schemaHash };
    }
    const allResources = [...p.resources.entries()], profileScripts=Object.values(nativeScriptProfiles);
    for (const id of Object.keys(config.entries)) {
      const entry = entryConfig(config, id), source = `res://${config.generatedDir}/entries/${id}.ts`, output = `res://.godot/GodotJS/${config.generatedDir}/entries/${id}.js`, scene = `res://${config.generatedDir}/scenes/${id}.tscn`, resourceHub = `res://${config.generatedDir}/resource-hubs/${id}.tres`, exportHub = `res://${config.generatedDir}/export-hubs/${id}.tscn`;
      const script = bootstrapSource(id, config.generatedDir), emitted = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true, newLine: ts.NewLineKind.LineFeed }, fileName: `${id}.ts`, reportDiagnostics: true });
      if (emitted.diagnostics?.length) fail("E_BOOTSTRAP", formatDiagnostics(emitted.diagnostics));
      artifactBytes.set(source, script); artifactBytes.set(output, emitted.outputText); if (emitted.sourceMapText) artifactBytes.set(`${output}.map`, nativeSourceMap(emitted.sourceMapText,source,output,script));
      nativeScripts[id] = { source, output, sha256: sha256(emitted.outputText), dependencies: Object.keys(nativeScriptProfiles).map(profile => `profile-${profile}`) };
      const startupAssets = entry.startupAssets ?? []; for (const asset of startupAssets) if (!p.resources.has(asset)) fail("E_ASSET", `Unknown startup asset ${asset}`);
      entries[id] = { id, module: `entry-${id}`, exportName: entry.export ?? "default", script: source, scene, resourceHub, exportHub, startupAssets };
      artifactBytes.set(scene, `[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path=${JSON.stringify(source)} id="1"]\n[node name=${JSON.stringify(id)} type="Node"]\nscript = ExtResource("1")\nmetadata/_react_generation = ${JSON.stringify(generation)}\nmetadata/_react_props = ${JSON.stringify(canonicalJson(entry.props ?? {}))}\n`);
      artifactBytes.set(resourceHub, `[gd_resource type="Resource" load_steps=${allResources.length + profileScripts.length + 1} format=3]\n${allResources.map(([_, r], i) => `[ext_resource type=${JSON.stringify(r.type)} path=${JSON.stringify(r.uri)} id=${JSON.stringify(String(i + 1))}]`).join("\n")}\n${profileScripts.map((script,i)=>`[ext_resource type="Script" path=${JSON.stringify(script.script)} id="native_${i+1}"]`).join("\n")}\n[resource]\nmetadata/assets = [${allResources.map((_, i) => `ExtResource(${JSON.stringify(String(i + 1))})`).join(", ")}]\nmetadata/native_scripts = [${profileScripts.map((_,i)=>`ExtResource("native_${i+1}")`).join(", ")}]\n`);
      artifactBytes.set(exportHub, `[gd_scene load_steps=2 format=3]\n[ext_resource type="Resource" path=${JSON.stringify(resourceHub)} id="1"]\n[node name="ReactExportOnly" type="Node"]\nmetadata/assets = ExtResource("1")\n`);
    }
    await publication.state("EMITTED", [...artifactBytes.keys()]);
    for (const [uri, contents] of artifactBytes) await write(fromRes(config.projectRoot, uri), contents);
    await publication.state("MATERIALIZED");
    const artifacts: Record<string, ManifestArtifact> = {};
    for (const [uri, bytes] of artifactBytes) artifacts[uri] = { sha256: sha256(bytes), owner: "compiler", kind: uri.startsWith(`res://${config.generatedDir}/resources/${generation}/`) ? "frozen-resource" : uri.endsWith("native-build-report.json") ? "native-build-report" : uri.endsWith("source-snapshot.json") ? "source-snapshot" : uri.endsWith(".ts") ? "native-script-source" : uri.endsWith(".js") ? "javascript" : uri.endsWith(".map") ? "source-map" : uri.endsWith(".tscn") ? "scene" : "resource-hub" };
    const nativeTarget=config.godot?await discoverNativeTarget(config.godot,path.join(staging,"snapshot","binary-descriptor"),publication.command):{godotVersion:"unknown",engine:"quickjs" as const};
    if(config.godot&&(config.target?.engine&&config.target.engine!==nativeTarget.engine||config.target?.godotVersion&&config.target.godotVersion!==nativeTarget.godotVersion))fail("E_NATIVE_TARGET","Configured native engine/version differs from the selected binary",{configured:config.target,actual:nativeTarget});
    const profile = profileReference(config.profileId), zero = "0".repeat(64), target: TargetCertification = { sourceCommit: "unknown", sourceDiffHash: zero, godotVersion: nativeTarget.godotVersion, platform: process.platform, arch: process.arch, engine: nativeTarget.engine, godotSchemaHash: profile.hash, ...certification?.target,...config.target,buildFlags:{...certification?.target.buildFlags,...config.target?.buildFlags} };
    const manifest: RuntimeManifestV1 = { schemaVersion: 1, generation, sourceSnapshotHash: p.snapshot.hash, compilerVersion: COMPILER_VERSION, runtimeAbi: RUNTIME_ABI, nativeBridgeAbi: NATIVE_BRIDGE_ABI, entryInterfaceHash: sha256(canonicalJson(Object.entries(entries).map(([id, e]) => [id, e.exportName, e.script]))), mode: config.mode, target, react: { ...REACT_VERSIONS }, profile, entries, modules, resources: Object.fromEntries(p.resources), nativeScripts, ...(Object.keys(nativeScriptProfiles).length ? {nativeScriptProfiles} : {}), artifacts, sourceOrigins: origins };
    validateRuntimeManifest(manifest); await atomicJson(path.join(staging, "manifest.json"), manifest);
    await publication.state("SCAN_IMPORT_PENDING");
    if (config.godot && options.importResources !== false) {
      const result = await publication.command(config.godot, ["--headless", "--editor", "--path", config.projectRoot, "--import"], { cwd: config.projectRoot });
      await write(path.join(staging, "import.log"), result.stdout + result.stderr);
      if (result.code !== 0 || /SCRIPT ERROR|Parse Error|^ERROR:|\[jsb\]\[Error\]/im.test(result.stdout + result.stderr)) fail("E_GODOT_IMPORT", "Godot import failed", result);
    } else if (p.resources.size || p.templates.length) fail("E_IMPORT_REQUIRED", "Set config.godot (or --godot) to verify native resources/templates before publication");
    for (const resource of Object.values(manifest.resources)) {
      const remap = `${fromRes(config.projectRoot, resource.uri)}.remap`;
      if (await exists(remap)) { const uri = toRes(config.projectRoot, remap); artifacts[uri] = { owner: "native-importer", kind: "resource-remap", sha256: sha256(await fs.readFile(remap)) }; (resource.importedArtifacts as string[]).push(uri); }
      const imported = `${fromRes(config.projectRoot, resource.uri)}.import`;
      if (await exists(imported)) { const uri = toRes(config.projectRoot, imported); artifacts[uri] = { owner: "native-importer", kind: "resource-import", sha256: sha256(await fs.readFile(imported)) }; (resource.importedArtifacts as string[]).push(uri); }
      for (const descriptor of [remap, imported]) if (await exists(descriptor)) {
        const contents = await fs.readFile(descriptor, "utf8");
        for (const match of contents.matchAll(/"(res:\/\/\.godot\/imported\/[^"\r\n]+)"/g)) {
          const uri = match[1], bytes = await fs.readFile(fromRes(config.projectRoot, uri)).catch(() => fail("E_IMPORT_ARTIFACT", `Missing native import artifact ${uri}`));
          artifacts[uri] = { owner:"native-importer",kind:"imported-resource",sha256:sha256(bytes) };
          if (!resource.importedArtifacts.includes(uri)) (resource.importedArtifacts as string[]).push(uri);
        }
      }
    }
    await verifySnapshot(config.projectRoot, p.snapshot); await publication.state("IMPORTS_VERIFIED");
    if(certification&&sha256(await fs.readFile(config.godot!))!==certification.report.binarySha256)fail("E_NATIVE_REPORT","Native binary changed during compilation/import");
    const sealed = await sealManifest(config, manifest); await publication.state("MANIFEST_SEALED");
    await atomicJson(path.join(generatedRoot(config), "active.json"), sealed.active); await publication.state("ACTIVE_COMMITTED"); await publication.state("READY");
    await fs.rm(path.join(staging, "snapshot"), {recursive:true,force:true});
    return { generation, manifest, manifestPath: sealed.manifestFile, activePath: path.join(generatedRoot(config), "active.json"), diagnostics: [] };
  } catch (error) {
    publication.journal.error = String(error); await publication.state("FAILED").catch(() => {}); throw error;
  } finally { await publication.release(); }
}
