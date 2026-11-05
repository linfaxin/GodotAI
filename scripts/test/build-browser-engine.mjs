#!/usr/bin/env node
// Build provenance is collected where SCons actually runs. Merely pointing at
// a source header and an unrelated template is never source certification.
import { readFile, readdir, mkdir, rm, cp, lstat, readlink, writeFile, copyFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, fail, options, required, writeJson } from '../release/web-release-utils.mjs';
import { patchOptionalPwa } from '../release/patch-web-optional-pwa.mjs';
import { patchAudioLifecycle } from '../release/patch-web-audio-lifecycle.mjs';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const excluded = new Set(['.git', 'node_modules', '.godot', '__pycache__', 'bin', 'obj', 'out', 'dist', 'work', '.browser-engine']);
const generated = /(?:\.(?:o|os|obj|a|pdb|ilk|wasm|zip|tgz|pyc)$|\.gen\.(?:h|cpp)$|^\.scons)/;
// SCsub unconditionally reads both runtime/editor preset inputs while producing
// jsb_project_preset.gen.cpp, including skip_js_runtime=yes template builds.
const nativeBundles = ['jsb.runtime.bundle.js', 'jsb.editor.bundle.js', 'jsb.runtime.bundle.d.ts', 'jsb.runtime.bundle.js.map', 'jsb.editor.bundle.d.ts', 'jsb.editor.bundle.js.map'];
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
export async function buildBrowserEngine(configuration) {
  const reportFile = resolve(required(configuration.out, '--out'));
  const builder = { path: 'scripts/test/build-browser-engine.mjs', sha256: digest(await readFile(fileURLToPath(import.meta.url))) };
  if (configuration['existing-template']) {
    if (!configuration.development) fail('E_BROWSER_UNCERTIFIED', '--existing-template requires --development; its source provenance cannot be reconstructed');
    const template = resolve(configuration['existing-template']);
    const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', status: 'existing-development', sourceCertified: false, builder,
      godotVersion: configuration['godot-version'] ?? 'unknown', engineTarget: configuration.target ?? 'unknown', pckVersion: 3,
      source: { commit: 'unknown', snapshotHash: 'unknown', observation: 'An existing template is not bound to the current checkout.' }, godotSource: { commit: 'unknown', snapshotHash: 'unknown' },
      recipe: { command: 'unknown', args: [], observation: 'Original executed build recipe is unavailable.' },
      template: { path: template, sha256: digest(await readFile(template)), bytes: (await lstat(template)).size } };
    report.recipeSha256 = digest(canonical(report.recipe));
    await writeJson(reportFile, report); return { status: report.status, sourceCertified: false, report: reportFile };
  }
  const sourceRoot = resolve(required(configuration['godot-source'], '--godot-source'));
  const destination = resolve(required(configuration['build-dir'], '--build-dir'));
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
    return !godotIgnored(key, basename(path));
  };
  await cp(sourceRoot, destination, { recursive: true, preserveTimestamps: true, filter });
  const destinationModule = resolve(destination, 'modules/GodotJS');
  await rm(destinationModule, { recursive: true, force: true });
  await cp(moduleRoot, destinationModule, { recursive: true, preserveTimestamps: true, filter: path => !excluded.has(basename(path)) && !generated.test(basename(path)) });
  await mkdir(resolve(destinationModule, 'scripts/out'), { recursive: true });
  for (const name of nativeBundles) {
    const input = resolve(moduleRoot, 'scripts/out', name);
    if (!existsSync(input)) fail('E_BROWSER_RUNTIME_BUNDLE', `Run pnpm build first: SCsub requires scripts/out/${name}`);
    await copyFile(input, resolve(destinationModule, 'scripts/out', name));
  }
  if (!existsSync(resolve(destinationModule, 'impl/web/js/jsbb.impl.js'))) fail('E_BROWSER_BRIDGE', 'Build @godot-js/web-bridge first; generated impl/web/js/jsbb.impl.js is a required snapshotted build input');
  const patches = [];
  for (const [patchPath, apply] of [['platform/web/js/libs/library_godot_os.js', patchOptionalPwa], ['platform/web/js/libs/library_godot_audio.js', patchAudioLifecycle]]) {
    const beforePatch = await readFile(resolve(destination, patchPath), 'utf8');
    const patched = apply(beforePatch);
    await writeFile(resolve(destination, patchPath), patched.code);
    patches.push({ patchId: patched.patchId, path: patchPath, beforeSha256: digest(beforePatch), afterSha256: digest(patched.code), changed: patched.changed });
  }
  const source = await snapshotBrowserSources(destinationModule, { module: true });
  source.commit = git(moduleRoot, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown'; source.dirty = git(moduleRoot, ['status', '--porcelain'])?.trim() ?? 'unknown';
  const godotSource = await snapshotBrowserSources(destination);
  godotSource.commit = git(sourceRoot, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown'; godotSource.dirty = git(sourceRoot, ['status', '--porcelain'])?.trim() ?? 'unknown';
  const target = configuration.target ?? 'template_debug';
  if (!['template_debug', 'template_release'].includes(target)) fail('E_BROWSER_TARGET', 'Only template_debug/template_release are supported');
  const scons = configuration.scons ?? 'scons';
  const args = ['platform=web', `target=${target}`, 'arch=wasm32', 'threads=no', 'dlink_enabled=no', 'use_quickjs_ng=no', 'skip_js_runtime=yes',
    'modules_enabled_by_default=no', 'module_GodotJS_enabled=yes', 'module_gdscript_enabled=yes', 'module_regex_enabled=yes', 'module_freetype_enabled=yes', 'module_text_server_fb_enabled=yes',
    'module_svg_enabled=yes', 'module_jpg_enabled=yes', 'module_godot_physics_2d_enabled=yes',
    'opengl3=yes', 'vulkan=no', 'debug_symbols=no', 'lto=none', 'use_closure_compiler=no', 'tests=no', `-j${configuration.jobs ?? 4}`];
  const toolchains = { emscripten: await toolVersion(configuration.emcc ?? 'emcc', ['--version']), scons: await toolVersion(scons, ['--version']), python: await toolVersion(configuration.python ?? 'python3', ['--version']) };
  const recipe = { command: scons, args, cwd: 'independent-build-tree', builderSha256: builder.sha256, patches, generatedNativeInputs: nativeBundles.map(name => `scripts/out/${name}`) };
  const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', status: 'snapshotted', source, godotSource, builder, toolchains, recipe, recipeSha256: digest(canonical(recipe)), engineTarget: target, pckVersion: 3 };
  await writeJson(reportFile, report);
  if (configuration['snapshot-only']) return { status: report.status, report: reportFile };
  try {
    const code = await execute(scons, args, destination, `${reportFile}.log`);
    if (code !== 0) fail('E_BROWSER_BUILD', `SCons exited ${code}`);
    const templates = (await readdir(resolve(destination, 'bin'))).filter(name => name.endsWith('.zip') && name.includes(`web.${target}.wasm32.nothreads`));
    if (templates.length !== 1) fail('E_BROWSER_TEMPLATE', `Expected one matching archive; found ${templates.length}`);
    const template = resolve(destination, 'bin', templates[0]), bytes = await readFile(template);
    Object.assign(report, await version(destination), { status: 'built', template: { path: template, sha256: digest(bytes), bytes: bytes.length }, logSha256: digest(await readFile(`${reportFile}.log`)) });
    // Unknown source archives remain usable locally, never certified by a flag.
    report.sourceCertified = [source.commit, godotSource.commit].every(commit => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit));
    await writeJson(reportFile, report); return { status: 'built', sourceCertified: report.sourceCertified, template, report: reportFile };
  } catch (error) { report.status = 'failed'; report.error = error.message; await writeJson(reportFile, report); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildBrowserEngine(options(process.argv.slice(2), ['--development', '--snapshot-only'])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
