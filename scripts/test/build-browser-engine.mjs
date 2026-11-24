#!/usr/bin/env node
// Build provenance is collected where SCons actually runs. Merely pointing at
// a source header and an unrelated template is never source certification.
import { readFile, writeFile, readdir, mkdir, rm, cp, lstat, readlink, symlink } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, fail, options, required, writeJson,
  OBSERVATION_READER_SOURCE, OBSERVATION_SOURCE_PATHS, OBSERVATION_EXPORTS, assertRuntimeObservationBuildProof,
  RUNTIME_WRITE_EXPORTS, assertRuntimeWriteBuildProof, runtimeWriteBuildTarget,
  RUNTIME_PROPERTIES_EXPORTS, RUNTIME_PROPERTIES_SOURCE_PATHS, assertRuntimePropertiesBuildProof,
  assertRuntimeCallBuildProof, GAME_PROBE_EXPORTS, assertGameProbeBuildProof,
} from '../release/web-release-utils.mjs';
import { applyWebEnginePatches } from '../release/patch-web-engine.mjs';
import { GAME_PROBE_PATCH } from '../release/patch-web-game-probe.mjs';
import {getEngineProfile,engineExecution,engineBuildArgs,validateEngineProfile,validateEngineExecution} from '../release/engine-profiles.mjs';
import {workerRuntimeBuildProof} from '../release/patch-web-worker-runtime.mjs';
import {webLifecycleBuildProof} from '../release/patch-web-lifecycle.mjs';
import {artifactSetMountBuildProof} from '../release/patch-artifact-set-mount.mjs';
import {nativeObserverBuildProof} from '../release/patch-native-observer.mjs';
import {hostResourceBuildProof} from '../release/patch-web-resource-owner.mjs';
import {managedShutdownBuildProof} from '../release/patch-managed-shutdown-queue.mjs';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const excluded = new Set(['.git', 'node_modules', '.godot', '__pycache__', 'bin', 'obj', 'out', 'dist', 'dist-conformance', 'dist-2d-debug', 'dist-2d-release', 'dist-full-release', 'work', '.browser-engine']);
const generated = /(?:\.(?:o|os|obj|a|pdb|ilk|wasm|zip|tgz|pyc|tsbuildinfo)$|\.gen\.(?:h|cpp)$|^\.scons)/;
// SCsub unconditionally reads both runtime/editor preset inputs while producing
// jsb_project_preset.gen.cpp, including skip_js_runtime=yes template builds.
const nativeBundles = ['jsb.runtime.bundle.js', 'jsb.editor.bundle.js', 'jsb.runtime.bundle.d.ts',
  'jsb.runtime.bundle.js.map', 'jsb.editor.bundle.d.ts', 'jsb.editor.bundle.js.map'];
const webBridgeBundle = 'impl/web/js/jsbb.impl.js';
function godotIgnored(key, name) {
  // Upstream misc/dist is source, as are nested third-party directories named
  // bin/out/dist. Only root build outputs and universal caches are excluded.
  const first = key.split('/')[0];
  return ['bin', 'obj', '.git', '.scons_cache'].includes(first)
    || ['.git', 'node_modules', '__pycache__', '.godot'].includes(name)
    || /^\.scons/.test(name)
    || /\.(?:o|os|obj|a|pdb|ilk|pyc)$/.test(name)
    || /\.gen\.(?:h|cpp)$/.test(name);
}
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}
export async function snapshotBrowserSources(root, { module = false } = {}) {
  const paths = [], inputs = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name), key = relative(root, path).split(sep).join('/');
      if (module ? (excluded.has(entry.name) && key !== 'scripts/out') || generated.test(entry.name) : godotIgnored(key, entry.name)) continue;
      if (module && key.startsWith('scripts/out/') && !nativeBundles.includes(entry.name)) continue;
      if (!module && key.startsWith('modules/GodotJS')) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else if (entry.isSymbolicLink()) {
        // Inputs outside the snapshot could change without changing the recipe.
        fail('E_BROWSER_SOURCE_SYMLINK', `Use a real source tree, not a linked build cache: ${path} -> ${await readlink(path)}`);
      }
    }
  }
  await walk(root);
  for (const path of paths.sort()) inputs[relative(root, path).split(sep).join('/')] = digest(await readFile(path));
  return { commit: git(root, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown', snapshotHash: digest(canonical(inputs)), inputs, dirty: git(root, ['status', '--porcelain'])?.trim() ?? 'unknown' };
}
async function version(root) {
  // This header is generated inside the exact tree just built by this script.
  const header = resolve(root, 'core/version_generated.gen.h');
  const text = await readFile(header, 'utf8');
  const hashText = await readFile(resolve(root, 'core/version_hash.gen.cpp'), 'utf8');
    const numeric = field => text.match(new RegExp(`#define (?:GODOT_)?VERSION_${field} (\\d+)`))?.[1];
    const quoted = field => text.match(new RegExp(`#define (?:GODOT_)?VERSION_${field} "([^"]*)"`))?.[1];
    if (!numeric('MAJOR') || !numeric('MINOR')) fail('E_BROWSER_VERSION', 'Built version header has an unknown format');
    const patch = numeric('PATCH');
    const hash = hashText.match(/(?:GODOT_)?VERSION_HASH\s*=\s*"([^"]*)"/)?.[1] ?? '';
    return { godotVersion: `${numeric('MAJOR')}.${numeric('MINOR')}${patch && patch !== '0' ? `.${patch}` : ''}.${quoted('STATUS') ?? 'unknown'}.${quoted('BUILD') ?? 'unknown'}${hash ? `.${hash.slice(0, 9)}` : ''}`, versionEvidence: { path: 'core/version_generated.gen.h', sha256: digest(text), hashPath: 'core/version_hash.gen.cpp', hashSha256: digest(hashText) } };
}
async function toolVersion(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail('E_BROWSER_TOOLCHAIN', `Cannot run ${executable}: ${result.error?.message ?? result.stderr}`);
  return (result.stdout || result.stderr).trim();
}
export function resolvedBrowserModules(enabledHeader) {
  const modules = [...enabledHeader.matchAll(/^#define MODULE_([A-Z0-9_]+)_ENABLED\s*$/gm)].map(match => match[1] === 'GODOTJS' ? 'GodotJS' : match[1].toLowerCase()).sort();
  if (!modules.includes('GodotJS') || !modules.includes('text_server_fb') || modules.includes('godotai_api_probe')) fail('E_BROWSER_MODULES', 'Production Web must include GodotJS/fallback text and exclude the API inspector');
  return modules;
}
export function inspectBrowserTemplate(template, {python='python3'}={}) {
  const inspect = spawnSync(python,['-c','import sys,json,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps([{ "path": n, "sha256": hashlib.sha256(z.read(n)).hexdigest(), "bytes": z.getinfo(n).file_size } for n in sorted(z.namelist()) if not n.endswith("/")]))',template],{encoding:'utf8',maxBuffer:8*1024*1024});
  if(inspect.error||inspect.status!==0)fail('E_BROWSER_TEMPLATE',`Cannot inspect template assets: ${inspect.error?.message??inspect.stderr}`);
  const assets=JSON.parse(inspect.stdout);
  if(!assets.some(asset=>asset.path==='godot.js')||!assets.some(asset=>asset.path==='godot.wasm'))fail('E_BROWSER_TEMPLATE','Template must contain godot.js and godot.wasm');
  return assets;
}
function bindRuntimeObservation(report, template, assets, python) {
  if (!report.runtimeAbi || !Object.hasOwn(report.source.inputs, OBSERVATION_READER_SOURCE)) return;
  const includeWrite = report.sourceCertified && runtimeWriteBuildTarget(report);
  const includeProperties = includeWrite && Object.hasOwn(report.source.inputs, 'bridge/jsb_runtime_properties.cpp');
  if (includeProperties && !RUNTIME_PROPERTIES_SOURCE_PATHS.every(path => Object.hasOwn(report.source.inputs, path)))
    fail('E_RUNTIME_PROPERTIES_SOURCE', 'Runtime property source closure is incomplete');
  const includeCall = includeWrite && Object.hasOwn(report.source.inputs, 'bridge/jsb_runtime_call.cpp');
  const probePatched = report.recipe.patches.some(patch => patch.patchId === GAME_PROBE_PATCH);

  const requiredSymbols = [...OBSERVATION_EXPORTS, ...(includeWrite ? RUNTIME_WRITE_EXPORTS : []),
    ...(includeProperties ? RUNTIME_PROPERTIES_EXPORTS : []),
    ...(includeCall ? ['_godotjs_runtime_call_abi', '_godotjs_runtime_call_execute', 'IsRuntimeCallValue'] : []), ...(probePatched ? GAME_PROBE_EXPORTS : [])];
  const inspect = spawnSync(python, ['-c', [
    'import re, sys, zipfile',
    'required, forbidden = sys.argv[2].split(), sys.argv[3].split()',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' data = z.read("godot.js")',
    ' for names, expected in [(required, True), (forbidden, False)]:',
    '  for name in names:',
    '   if bool(re.search(rb"\\b" + name.encode() + rb"\\b", data)) != expected:',
    '    sys.exit(("Missing" if expected else "Unexpected") + " runtime bridge symbol: " + name)',
  ].join('\n'), template, requiredSymbols.join(' '), probePatched ? '' : GAME_PROBE_EXPORTS.join(' ')], {encoding: 'utf8'});
  if (inspect.error || inspect.status !== 0)
    fail('E_RUNTIME_OBSERVATION_EXPORT', inspect.error?.message ?? inspect.stderr.trim());
  report.runtimeAbi = {...report.runtimeAbi, observation: 1};
  report.runtimeObservation = {
    abi: 1,
    sources: Object.fromEntries(OBSERVATION_SOURCE_PATHS.map(path => [path, report.source.inputs[path]])),
    exports: [...OBSERVATION_EXPORTS],
    wasmSha256: assets.find(asset => asset.path === 'godot.wasm').sha256,
  };
  assertRuntimeObservationBuildProof(report, report.runtimeObservation.wasmSha256);
  if (includeWrite) {
    report.runtimeAbi.runtimeWrite = 1;
    report.runtimeWrite = {...report.runtimeObservation, exports: [...RUNTIME_WRITE_EXPORTS]};
    assertRuntimeWriteBuildProof(report, report.runtimeWrite.wasmSha256);
  }
  if (includeProperties) {
    report.runtimeAbi.runtimeProperties = 1;
    report.runtimeProperties = {abi: 1, sources: Object.fromEntries(RUNTIME_PROPERTIES_SOURCE_PATHS.map(path => [path, report.source.inputs[path]])), exports: [...RUNTIME_PROPERTIES_EXPORTS], wasmSha256: report.runtimeObservation.wasmSha256};
    assertRuntimePropertiesBuildProof(report, report.runtimeProperties.wasmSha256);
  }
  if (includeCall) {
    report.runtimeAbi.runtimeCall = 1;
    report.runtimeCall = {abi: 1, wasmSha256: report.runtimeObservation.wasmSha256,
      javascriptSha256: assets.find(asset => asset.path === 'godot.js').sha256};
    assertRuntimeCallBuildProof(report);
  }
  if (includeWrite && probePatched) {
    report.runtimeAbi.gameProbe = 1;
    report.gameProbe = {abi: 1, exports: [...GAME_PROBE_EXPORTS], wasmSha256: report.runtimeObservation.wasmSha256,
      javascriptSha256: assets.find(asset => asset.path === 'godot.js').sha256};
    assertGameProbeBuildProof(report);
  }

}
async function execute(command, args, cwd, logPath) {
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
    child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
    child.once('error', error => { log.end(); reject(error); });
    child.once('close', code => { log.end(() => resolveResult(code)); });
  });
}

async function generateEngineJavaScript(destinationModule, reportFile) {
  for (const project of ['scripts/jsb.runtime', 'scripts/jsb.editor', 'impl/web/bridge']) {
    const installed = resolve(moduleRoot, project, 'node_modules');
    const compiler = resolve(installed, 'typescript/bin/tsc');
    if (!existsSync(compiler)) fail('E_BROWSER_TYPESCRIPT', `Run pnpm install --frozen-lockfile first: TypeScript is missing for ${project}`);
    const cwd = resolve(destinationModule, project);
    const dependencies = resolve(cwd, 'node_modules');
    // Resolve installed type dependencies while compiling the copied sources.
    // The dependency link is removed before hashing the native build inputs.
    await symlink(installed, dependencies, 'junction');
    try {
      const log = `${reportFile}.${basename(project)}.log`;
      if (await execute(process.execPath, [compiler, '--project', 'tsconfig.json', '--noEmitOnError'], cwd, log) !== 0)
        fail('E_BROWSER_TYPESCRIPT', `Could not compile ${project}; see ${log}`);
    } finally {
      await rm(dependencies);
    }
  }
}

export async function buildBrowserEngine(configuration) {
  const runtimeProfile=getEngineProfile(configuration.profile??configuration.runtimeProfile??'full-engine-v1').id;
  let execution=engineExecution(configuration['execution-model']??configuration.executionModel??'window');
  const reportFile = resolve(required(configuration.out, '--out'));
  const builder = { path: 'scripts/test/build-browser-engine.mjs', sha256: digest(await readFile(fileURLToPath(import.meta.url))) };
  if (configuration['existing-template']) {
    if (!configuration.development) fail('E_BROWSER_UNCERTIFIED', '--existing-template requires --development; its source provenance cannot be reconstructed');
    const template = resolve(configuration['existing-template']);
    const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', runtimeProfile:configuration.profile??configuration.runtimeProfile??'legacy-profiles-v1', status: 'existing-development', sourceCertified: false, builder,
      godotVersion: configuration['godot-version'] ?? 'unknown', engineTarget: configuration.target ?? 'unknown', pckVersion: 3,
      source: { commit: 'unknown', snapshotHash: 'unknown', observation: 'An existing template is not bound to the current checkout.' }, godotSource: { commit: 'unknown', snapshotHash: 'unknown' },
      recipe: { command: 'unknown', args: [], observation: 'Original executed build recipe is unavailable.' },
      template: { path: template, sha256: digest(await readFile(template)), bytes: (await lstat(template)).size } };
    report.recipeSha256 = digest(canonical(report.recipe));
    await writeJson(reportFile, report); return { status: report.status, sourceCertified: false, report: reportFile };
  }
  const sourceRoot = resolve(required(configuration['godot-source'], '--godot-source'));
  const destination = resolve(required(configuration['build-dir'], '--build-dir'));
  const target = configuration.target ?? 'template_debug';
  if (!['template_debug', 'template_release'].includes(target)) fail('E_BROWSER_TARGET', 'Only template_debug/template_release are supported');
  if (!existsSync(resolve(sourceRoot, 'SConstruct'))) fail('E_BROWSER_SOURCE', 'Godot source must contain SConstruct');
  for (const source of [sourceRoot, moduleRoot]) {
    if (source === destination || destination.startsWith(`${source}${sep}`) || source.startsWith(`${destination}${sep}`)) fail('E_BROWSER_BUILD_DIR', '--build-dir must be independent of both source trees');
  }
  // Copy only when first preparing a build tree. Subsequent builds resync source
  // bytes without copying object files into or out of the developer checkout.
  await mkdir(destination, { recursive: true });
  const filter = (path) => {
    const key = relative(sourceRoot, path).split(sep).join('/');
    if (key === 'modules/GodotJS' || key.startsWith('modules/GodotJS/')) return false;
    if (key === 'modules/godotai_api_probe' || key.startsWith('modules/godotai_api_probe/')) return false;
    return !godotIgnored(key, basename(path));
  };
  await cp(sourceRoot, destination, { recursive: true, preserveTimestamps: true, filter });
  await rm(resolve(destination, 'modules/godotai_api_probe'), { recursive: true, force: true });
  const destinationModule = resolve(destination, 'modules/GodotJS');
  await rm(destinationModule, { recursive: true, force: true });
  await cp(moduleRoot, destinationModule, { recursive: true, preserveTimestamps: true, filter: path =>
    !excluded.has(basename(path)) && !generated.test(basename(path)) &&
    relative(moduleRoot, path).split(sep).join('/') !== webBridgeBundle });
  await generateEngineJavaScript(destinationModule, reportFile);
  const patches = await applyWebEnginePatches(destination, { python: configuration.python ?? 'python3', executionModel: execution.executionModel,
    gameProbe: runtimeProfile === 'full-engine-v1' && target === 'template_debug' });
  const lifecycleProof=webLifecycleBuildProof(patches);
  const artifactSetProof={...artifactSetMountBuildProof(patches),...nativeObserverBuildProof(patches),...hostResourceBuildProof(patches),...managedShutdownBuildProof(patches)};
  execution={...execution,lifecycleAbi:lifecycleProof.lifecycleAbi,artifactSetAbi:artifactSetProof.artifactSetAbi,hostResourceAbi:artifactSetProof.hostResourceAbi,shutdownQueueAbi:artifactSetProof.shutdownQueueAbi};
  // Capture SCons' final environment after target/platform/module resolution.
  // This hook is part of the attested SConstruct bytes and never touches upstream.
  const featureEvidencePath='bin/godotjs-web-build-features.json';
  const featureKeys=['disable_3d','disable_physics_3d','disable_navigation_3d','disable_xr','disable_advanced_gui','disable_physics_2d','disable_navigation_2d','threads','proxy_to_pthread','dlink_enabled','opengl3','vulkan','debug_symbols','lto','optimize','target','modules_enabled_by_default','linkflags'];
  const hook='\n# GodotJS: record the resolved environment, not just requested CLI flags.\nimport json as _godotjs_json\nimport os as _godotjs_os\n_godotjs_os.makedirs("bin", exist_ok=True)\nwith open('+JSON.stringify(featureEvidencePath)+', "w", encoding="utf-8") as _godotjs_report:\n    _godotjs_values = {key: env.get(key) for key in '+JSON.stringify(featureKeys)+'}\n    _godotjs_values["resolvedLinkFlags"] = [str(flag) for flag in env.get("LINKFLAGS", [])]\n    _godotjs_json.dump(_godotjs_values, _godotjs_report, sort_keys=True)\n';
  const sconstructPath=resolve(destination,'SConstruct');
  const sconstruct=await readFile(sconstructPath,'utf8');
  await writeFile(sconstructPath,sconstruct+hook);
  const source = await snapshotBrowserSources(destinationModule, { module: true });
  source.commit = git(moduleRoot, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown'; source.dirty = git(moduleRoot, ['status', '--porcelain'])?.trim() ?? 'unknown';
  const godotSource = await snapshotBrowserSources(destination);
  godotSource.commit = git(sourceRoot, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown'; godotSource.dirty = git(sourceRoot, ['status', '--porcelain'])?.trim() ?? 'unknown';
  const scons = configuration.scons ?? 'scons';
  const args=engineBuildArgs({profile:runtimeProfile,target,jobs:configuration.jobs??4,lto:configuration.lto??'none',moduleMode:configuration['module-mode']??'baseline',executionModel:execution.executionModel});
  const environment=Object.fromEntries(['EMCC_CORES','BINARYEN_CORES'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
  const toolchains = { environment, node:process.version, ...(process.env.EMSDK_NODE?{emsdkNode:await toolVersion(process.env.EMSDK_NODE,['--version'])}:{}), emscripten: await toolVersion(configuration.emcc ?? 'emcc', ['--version']), scons: await toolVersion(scons, ['--version']), python: await toolVersion(configuration.python ?? 'python3', ['--version']) };
  const recipe = { command: scons, args, environment, cwd: 'independent-build-tree', builderSha256: builder.sha256, patches, generatedNativeInputs: nativeBundles.map(name => `scripts/out/${name}`), featureCapture:{path:featureEvidencePath,hookSha256:digest(hook)} };
  const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', runtimeProfile, execution, requestedArgs:[...args], status: 'snapshotted', source, godotSource, builder, toolchains, recipe, recipeSha256: digest(canonical(recipe)), engineTarget: target, pckVersion: 3, ...lifecycleProof, ...artifactSetProof, ...(execution.executionModel==='window'?workerRuntimeBuildProof(patches):{}) };
  await writeJson(reportFile, report);
  if (configuration['snapshot-only']) return { status: report.status, report: reportFile };
  try {
    const code = await execute(scons, args, destination, `${reportFile}.log`);
    if (code !== 0) fail('E_BROWSER_BUILD', `SCons exited ${code}`);
    const templateStem=`godot.web.${target}.wasm32${execution.wasmThreads?'':'.nothreads'}`;
    const templates = (await readdir(resolve(destination, 'bin'))).filter(name => name===`${templateStem}.zip`);
    if (templates.length !== 1) fail('E_BROWSER_TEMPLATE', `Expected one matching archive; found ${templates.length}`);
    const template = resolve(destination, 'bin', templates[0]), bytes = await readFile(template);
    const modulesHeader = await readFile(resolve(destination, 'modules/modules_enabled.gen.h'), 'utf8');
    const modules=resolvedBrowserModules(modulesHeader);
    const resolvedOptionsBytes=await readFile(resolve(destination,featureEvidencePath));
    const resolvedBuildOptions=JSON.parse(resolvedOptionsBytes.toString('utf8'));
    if(resolvedBuildOptions.target!==target)fail('E_BROWSER_TARGET','Resolved SCons target differs from the build recipe');
    validateEngineExecution(execution.executionModel,{resolvedBuildOptions});
    const resolvedFeatures=Object.fromEntries(Object.keys(getEngineProfile(runtimeProfile).features).map(key=>[key,resolvedBuildOptions[key]]));
    validateEngineProfile(runtimeProfile,{modules,features:resolvedFeatures,forBuild:true});
    const assets=inspectBrowserTemplate(template,{python:configuration.python??'python3'});
    // Unknown source archives remain usable locally, never certified by a flag.
    report.sourceCertified = [source.commit, godotSource.commit].every(commit => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit));
    // Modern Emscripten embeds pthread bootstrap code and uses the engine JS
    // URL for workers. Bind that actual file, plus separate workers if emitted.
    const workerAssets=execution.wasmThreads?assets.filter(asset=>asset.path==='godot.js'||(/worker.*\.js$/.test(asset.path)&&!asset.path.includes('service.worker'))).map(asset=>({...asset,role:'pthread-runtime',...(asset.path==='godot.js'?{embedded:true}:{})})):[];
    const workerBootstrap=execution.wasmThreads?(workerAssets.some(asset=>!asset.embedded)?'separate':'embedded'):undefined;
    Object.assign(report, await version(destination), { status: 'built', execution:{...execution,workerAssets,...(workerBootstrap?{workerBootstrap}:{})}, modules, resolvedFeatures, resolvedBuildOptions, featuresEvidence:{path:featureEvidencePath,sha256:digest(resolvedOptionsBytes)}, modulesEvidence: { path: 'modules/modules_enabled.gen.h', sha256: digest(modulesHeader) }, template: { path: template, sha256: digest(bytes), bytes: bytes.length,assets }, logSha256: digest(await readFile(`${reportFile}.log`)) });
    bindRuntimeObservation(report, template, assets, configuration.python ?? 'python3');
    await writeJson(reportFile, report); return { status: 'built', sourceCertified: report.sourceCertified, template, report: reportFile };
  } catch (error) { report.status = 'failed'; report.error = error.message; await writeJson(reportFile, report); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildBrowserEngine(options(process.argv.slice(2), ['--development', '--snapshot-only'])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
