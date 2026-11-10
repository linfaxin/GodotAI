#!/usr/bin/env node
import { readFile, writeFile, mkdir, rm, copyFile, mkdtemp, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { canonical, digest, fail, options, required, json, writeJson, filesIn, relativePath, safePath, within, identity, assertCommit, assertHash, inspectRelease } from './web-release-utils.mjs';
import { patchOptionalPwa, OPTIONAL_PWA_PATCH } from './patch-web-optional-pwa.mjs';
import { patchAudioLifecycle, AUDIO_LIFECYCLE_PATCH } from './patch-web-audio-lifecycle.mjs';
import {loadProductionApiProfiles,buildEngineVendor,assembleFullEngineRelease} from '../../apps/playground/scripts/full-engine-release.mjs';
import {createTypeSnapshot} from '../../apps/playground/scripts/build-shell.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 192 * 1024 * 1024, ...extra });
  if (result.error || result.status !== 0) fail('E_RELEASE_COMMAND', `${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
export function isSourceCertified(report) {
  if (report.kind !== 'godot-js-browser-engine-build' || report.status !== 'built') return false;
  try {
    assertCommit(report.source?.commit, 'GodotJS commit'); assertHash(report.source?.snapshotHash, 'GodotJS snapshot');
    assertCommit(report.godotSource?.commit, 'Godot commit'); assertHash(report.godotSource?.snapshotHash, 'Godot snapshot');
    for (const source of [report.source, report.godotSource]) if (digest(canonical(source.inputs)) !== source.snapshotHash) return false;
    if (digest(canonical(report.recipe)) !== report.recipeSha256) return false;
    if (!['threads=no', 'dlink_enabled=no', 'platform=web', 'use_quickjs_ng=no'].every(flag => report.recipe?.args?.includes(flag))) return false;
    return report.builder?.sha256 && report.toolchains?.emscripten && report.versionEvidence?.sha256;
  } catch { return false; }
}
export async function buildRelease(configuration) {
  const reportPath = resolve(required(configuration['engine-report'], '--engine-report'));
  const configPath = resolve(required(configuration.assets, '--assets'));
  const config = await json(configPath), report = await json(reportPath);
  const fullEngine = config.runtimeProfile === 'full-engine-v1' || report.runtimeProfile === 'full-engine-v1' || report.recipe?.args?.includes('modules_enabled_by_default=yes');
  if (fullEngine && report.kind === 'godot-js-browser-engine-build' && report.status === 'built' && !report.recipe?.args?.includes('modules_enabled_by_default=yes')) fail('E_RELEASE_PROFILE', 'Full engine source report must build default modules');
  const root = dirname(configPath), output = resolve(configuration.out ?? 'scripts/jsb.web-engine/dist');
  const sourceCertified = !configuration.development && !!isSourceCertified(report);
  if (configuration['raw-wasm'] && !configuration.development) fail('E_RELEASE_ENCODING', '--raw-wasm is reserved for development compatibility');
  if (!sourceCertified && !configuration.development) fail('E_RELEASE_SOURCE', 'A source-certified engine build report is required; use --development for an explicitly uncertified local template');
  if (!report.template?.path || !report.template?.sha256) fail('E_RELEASE_ENGINE', 'Engine report must identify actual template bytes');
  const archive = resolve(dirname(reportPath), report.template.path), archiveBytes = await readFile(archive);
  for (const input of [reportPath, configPath, archive, ...Object.values(config.sdk ?? {}), ...Object.values(config.compiler ?? {}), config.types, config.contracts, config.bootstrap, config.engineApi?.ir, config.engineApi?.captureReport, ...Object.values(config.engineApi?.namingProfiles ?? {}).flatMap(profile => [profile.ir, profile.captureReport])].filter(Boolean).map(path => resolve(root, path))) {
    if (input === output || input.startsWith(`${output}/`)) fail('E_RELEASE_OUTPUT', 'Output directory must not contain release inputs');
  }
  if (output === repository || repository.startsWith(`${output}/`) || output === '/') fail('E_RELEASE_OUTPUT', 'Output must be a dedicated release directory');
  if (digest(archiveBytes) !== report.template.sha256) fail('E_RELEASE_ENGINE', 'Template archive does not match the engine build report');
  const staging = await mkdtemp(resolve(tmpdir(), 'godot-web-release-'));
  try {
    const files = [], seen = new Set(), jsGluePatches = [];
    async function asset(path, content, kind, extra = {}) {
      safePath(path);
      if (seen.has(path)) fail('E_RELEASE_DUPLICATE', `Duplicate ${path}`);
      seen.add(path); const bytes = Buffer.from(content);
      await mkdir(dirname(within(staging, path)), { recursive: true }); await writeFile(within(staging, path), bytes);
      files.push({ path, sha256: digest(bytes), bytes: bytes.length, kind, ...extra });
    }
    async function input(path, source, kind, extra) { await asset(path, await readFile(resolve(root, source)), kind, extra); }
    const entries = run('unzip', ['-Z1', archive]).trim().split('\n');
    for (const name of ['godot.js', 'godot.wasm', 'godot.audio.worklet.js', 'godot.audio.position.worklet.js']) {
      const matches = entries.filter(path => path === name || path.endsWith(`/${name}`));
      if (matches.length !== 1) fail('E_RELEASE_ENGINE', `Template must contain exactly one ${name}`);
      let bytes = run('unzip', ['-p', archive, matches[0]], { encoding: null });
      if (fullEngine && name === 'godot.wasm') { await mkdir(resolve(staging, '.production-capture'), { recursive: true }); await writeFile(resolve(staging, '.production-capture/godot.wasm'), bytes); }
      if (name === 'godot.wasm' && !Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('E_RELEASE_ENGINE', 'Template does not contain a WebAssembly module');
      if (name === 'godot.js') {
        for (const [apply, patchId] of [[patchOptionalPwa, OPTIONAL_PWA_PATCH], [patchAudioLifecycle, AUDIO_LIFECYCLE_PATCH]]) {
          const beforeSha256 = digest(bytes);
          const sourcePatch = report.recipe?.patches?.find(patch => patch.patchId === patchId && patch.afterSha256 === report.godotSource?.inputs?.[patch.path]);
          // Optimizers may remove the marker comment. A successful source build
          // already binds the patched library bytes to this exact archive.
          const appliedInSource = sourcePatch && report.kind === 'godot-js-browser-engine-build' && report.status === 'built'
            && digest(canonical(report.godotSource.inputs)) === report.godotSource.snapshotHash
            && digest(canonical(report.recipe)) === report.recipeSha256;
          const patch = appliedInSource ? { code: bytes.toString('utf8'), changed: false, patchId } : apply(bytes.toString('utf8'));
          bytes = Buffer.from(patch.code);
          jsGluePatches.push({ patchId: patch.patchId, beforeSha256, afterSha256: digest(bytes), changed: patch.changed, via: appliedInSource ? 'source-recipe' : 'generated-glue', sourcePatches: sourcePatch ? [sourcePatch] : [] });
        }
      }
      if (name === 'godot.wasm' && !configuration['raw-wasm']) {
        await asset('assets/godot.wasm.gz', gzipSync(bytes, { level: 9 }), 'engine-wasm', { encoding: 'gzip', decodedSha256: digest(bytes), decodedBytes: bytes.length });
      } else await asset(`assets/${name}`, bytes, name.endsWith('.wasm') ? 'engine-wasm' : name === 'godot.js' ? 'engine-js' : 'engine-worklet');
    }
    for (const mode of ['development', 'production']) {
      const source = config.sdk?.[mode];
      if (!source && !configuration.development) fail('E_RELEASE_SDK', `Missing ${mode} SDK asset`);
      if (source) await input(`assets/sdk/${mode}${basename(source).endsWith('.json') ? '.json' : '.js'}`, source, 'sdk', { sdkMode: mode });
    }
    if (config.contracts) await input('assets/contracts.mjs', config.contracts, 'contracts');
    if (config.bootstrap) await input('assets/bootstrap.json', config.bootstrap, 'bootstrap');
    if (config.schema) await input('assets/schema.json', config.schema, 'schema');
    if (!configuration.development && (!config.contracts || !config.bootstrap)) fail('E_RELEASE_SDK', 'Official release requires contracts and bootstrap assets');
    const typePaths = [];
    if (config.types) {
      const directory = resolve(root, config.types);
      for (const file of await filesIn(directory)) {
        // Static hosts may filter node_modules and package metadata even when
        // present in the uploaded archive. Preserve TypeScript's virtual path
        // separately from a host-safe, opaque text asset URL.
        const key = relativePath(directory, file), path = `types/${digest(key)}.txt`;
        await asset(path, await readFile(file), 'type', { virtualPath: `/${key}` }); typePaths.push(path);
      }
    }
    if (!typePaths.length && !configuration.development) fail('E_RELEASE_TYPES', 'Official release requires a complete declaration mirror');
    const compiler = {};
    for (const [name, filename] of [['js', 'esbuild-browser.js'], ['wasm', 'esbuild.wasm'], ['typescript', 'typescript.js']]) {
      if (!config.compiler?.[name] && !configuration.development) fail('E_RELEASE_COMPILER', `Missing ${name} compiler input`);
      if (config.compiler?.[name]) { compiler[name] = `compiler/${filename}`; await input(compiler[name], config.compiler[name], name === 'typescript' ? 'typescript' : `compiler-${name}`); }
    }
    if (compiler.typescript) {
      const source = await readFile(within(staging, compiler.typescript), 'utf8');
      compiler.typescriptModule = 'compiler/typescript-browser.mjs';
      await asset(compiler.typescriptModule, `${source}\nexport default ts;\n`, 'typescript-module');
    }
    for (const item of config.extra ?? []) await input(item.path, item.source, item.kind ?? 'extra');
    let metadata = config.metadata;
    if (!metadata) {
      const require = createRequire(resolve(repository, 'scripts/jsb.react/package.json'));
      const { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS } = require('./dist/contracts/index.js');
      const { profileReference } = require('./dist/schema/index.js');
      metadata = { runtimeAbi: RUNTIME_ABI, nativeBridgeAbi: NATIVE_BRIDGE_ABI, react: REACT_VERSIONS, profiles: [profileReference('core-ui-v1')], sdkVersion: require('./package.json').version };
    }
    if (!metadata.runtimeAbi || !metadata.nativeBridgeAbi || !metadata.react || !Array.isArray(metadata.profiles) || !metadata.profiles.length) fail('E_RELEASE_METADATA', 'Metadata must include ABI, React tuple and profiles');
    const dependencies = { react: metadata.react.react, 'react-reconciler': metadata.react.reconciler, scheduler: metadata.react.scheduler };
    for (const [name, version] of Object.entries(dependencies)) if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) fail('E_RELEASE_METADATA', `React tuple must be exact: ${name}`);
    if (metadata.dependencies && canonical(metadata.dependencies) !== canonical(dependencies)) fail('E_RELEASE_METADATA', 'Dependencies and canonical React tuple differ');
    let fullRelease;
    if (fullEngine) {
      const captureDirectory = resolve(staging, '.production-capture');
      const captureInputs = Object.fromEntries(['snake', 'camel'].map(naming => {
        const source = config.engineApi?.namingProfiles?.[naming] ?? (naming === 'snake' ? config.engineApi : undefined);
        return [naming, source?.ir ? { irPath: resolve(root, source.ir), reportPath: source.captureReport && resolve(root, source.captureReport) } : {}];
      }));
      const namingProfiles = await loadProductionApiProfiles({ engineJs: resolve(staging, 'assets/godot.js'), engineWasm: resolve(captureDirectory, 'godot.wasm'), captureDirectory, namingProfiles: captureInputs });
      await Promise.all(Object.values(namingProfiles).map(async profile => { profile.typeSnapshot = await createTypeSnapshot({ engineFiles: profile.declarations.files }); }));
      const api = namingProfiles.snake;
      const engine = { javascript: files.find(file => file.kind === 'engine-js'), wasm: files.find(file => file.kind === 'engine-wasm'), worklets: files.filter(file => file.kind === 'engine-worklet') };
      if (report.modules && canonical([...report.modules].sort()) !== canonical([...api.ir.modules].sort())) fail('E_RELEASE_MODULES', 'Built module header and production native API disagree');
      const [vendor, developmentVendor] = await Promise.all([buildEngineVendor(), buildEngineVendor({ mode: 'development' })]);
      const prepared = assembleFullEngineRelease({ ...api, namingProfiles, engine, sdkVersion: metadata.sdkVersion ?? createRequire(resolve(repository, 'scripts/jsb.react/package.json'))('./package.json').version,
        vendor, developmentVendor, build: { actualAPIHash: api.actualAPIHash, sourceCertified, engineReportSha256: digest(await readFile(reportPath)), engineTemplateSha256: report.template.sha256, recipeSha256: report.recipeSha256 } });
      fullRelease = prepared.manifest;
      for (const [path, bytes] of prepared.outputs) {
        const declaration = Object.entries(fullRelease.api.declarations).find(([, item]) => item.path === path);
        const camelDeclaration = Object.entries(fullRelease.api.namingProfiles.camel.declarations).find(([, item]) => item.path === path);
        await asset(path, bytes, declaration ? 'type' : camelDeclaration ? 'engine-declaration' : path === 'engine-release.json' ? 'full-engine-descriptor' : path.startsWith('.playground/vendor') ? 'engine-sdk' : 'full-engine-asset', declaration ? { virtualPath: declaration[0], naming: 'snake' } : camelDeclaration ? { virtualPath: camelDeclaration[0], naming: 'camel' } : {});
        if (declaration) typePaths.push(path);
      }
      metadata = { ...metadata, profiles: [...metadata.profiles.filter(profile => profile.id !== 'full-engine-v1'), { id: 'full-engine-v1', version: 1, hash: api.actualAPIHash }] };
      await rm(captureDirectory, { recursive: true, force: true });
    }
    const attestation = {
      schemaVersion: 1, kind: 'godot-js-web-release-attestation', status: report.status,
      source: report.source, godotSource: report.godotSource, recipe: report.recipe,
      recipeSha256: report.recipeSha256 ?? digest(canonical(report.recipe)), builder: report.builder,
      toolchains: report.toolchains, versionEvidence: report.versionEvidence,
      engineReportSha256: digest(await readFile(reportPath)), templateSha256: report.template.sha256,
      sourceCertified, jsGluePatches, notes: sourceCertified ? [] : ['Development template; source-to-template provenance was not established.'],
    };
    await asset('attestation.json', `${JSON.stringify(attestation, null, 2)}\n`, 'attestation');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const buildFlags = {};
    for (const argument of report.recipe?.args ?? []) {
      const equals = argument.indexOf('=');
      if (equals > 0) buildFlags[argument.slice(0, equals)] = argument.slice(equals + 1);
    }
    if (sourceCertified) Object.assign(buildFlags, { godot_source_commit: report.godotSource.commit, godot_source_snapshot_sha256: report.godotSource.snapshotHash, godot_build_recipe_sha256: report.recipeSha256 });
    else Object.assign(buildFlags, { threads: false, development_template: true });
    // Schema 1 consumers still interpret target.godotSchemaHash as their legacy
    // React capability schema. Native API identity lives in schema 2's api.
    const defaultProfile = metadata.profiles.find(profile => profile.id === 'core-ui-v1') ?? metadata.profiles[0];
    const descriptor = {
      ...metadata, schemaVersion: 1, version: configuration.version ?? metadata.version ?? '0.1.0', sourceCertified,
      runtimeProfile: fullEngine ? 'full-engine-v1' : 'legacy-profiles-v1', legacy: !fullEngine,
      ...(fullRelease ? { engineRelease: 'engine-release.json', engineReleaseId: fullRelease.id, engineApi: fullRelease.api } : {}),
      engine: { backend: 'browser', godotVersion: report.godotVersion ?? 'unknown', target: report.engineTarget ?? 'unknown', threads: false, dlink: false, pckVersion: report.pckVersion ?? 3, archiveSha256: report.template.sha256, ...(fullRelease ? { modules: fullRelease.modules } : {}) },
      dependencies, sdkPackageRoot: metadata.sdkPackageRoot ?? '/node_modules/@godot-js/react',
      target: { sourceCommit: sourceCertified ? report.source.commit : 'unknown', sourceDiffHash: sourceCertified ? report.source.snapshotHash : '0'.repeat(64), godotVersion: report.godotVersion ?? 'unknown',
        buildFlags, platform: 'web', arch: 'wasm32', engine: 'web', godotSchemaHash: defaultProfile.hash },
      typesRoot: metadata.typesRoot ?? '/node_modules/@types', libRoot: metadata.libRoot ?? '/typescript/lib',
      specifiers: metadata.specifiers ?? {}, types: { root: 'types', files: typePaths }, compiler,
      typescriptUrl: compiler.typescriptModule, jsGluePatches, attestation: 'attestation.json', files,
    };
    // Root metadata may describe virtual paths and aliases but cannot replace
    // content identity, actual files, engine provenance or certification.
    delete descriptor.id; delete descriptor.runtimeRelease; delete descriptor.certification;
    descriptor.id = descriptor.runtimeRelease = identity(descriptor);
    descriptor.certified = false;
    if (configuration['validation-report']) {
      const validation = await json(resolve(configuration['validation-report']));
      const checks = validation.checks ?? validation.browserChecks;
      const covered = files.filter(file => file.kind !== 'attestation').every(file => validation.artifactHashes?.[file.path] === file.sha256);
      if (validation.runtimeRelease !== descriptor.id || validation.status !== 'passed' || !Array.isArray(checks) || !checks.length || checks.some(check => check.status !== 'passed') || !covered) fail('E_RELEASE_VALIDATION', 'Browser validation must match this exact runtimeRelease, pass and bind every engine, SDK, compiler and declaration asset hash');
      for (const [name, hash] of Object.entries(validation.evidenceHashes ?? {})) assertHash(hash, `specialist evidence ${name}`);
      descriptor.certified = sourceCertified;
      descriptor.certification = { status: 'passed', runtimeRelease: validation.runtimeRelease, scope: validation.scope ?? {}, checks, artifactHashes: validation.artifactHashes,
        siteArtifactHashes: validation.siteArtifactHashes, generatedArtifacts: validation.generatedArtifacts,
        evidenceHashes: validation.evidenceHashes,
        evidenceSha256: digest(await readFile(resolve(configuration['validation-report']))) };
    }
    await writeJson(resolve(staging, 'release.json'), descriptor);
    await inspectRelease(staging);
    await mkdir(dirname(output), { recursive: true });
    // A fresh directory prevents stale assets from being accidentally published.
    await rm(output, { recursive: true, force: true });
    try { await rename(staging, output); } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      for (const path of await filesIn(staging)) { const target = within(output, relativePath(staging, path)); await mkdir(dirname(target), { recursive: true }); await copyFile(path, target); }
    }
    return { status: 'prepared', directory: output, id: descriptor.id, sourceCertified, certified: descriptor.certified, files: files.length };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildRelease(options(process.argv.slice(2), ['--development', '--raw-wasm'])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
