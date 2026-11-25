import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildRelease } from '../build-web-release.mjs';
import { verifyRelease } from '../verify-web-release.mjs';
import { publishRelease, verifyCDN } from '../publish-web-release.mjs';
import { pinRelease } from '../pin-web-release.mjs';
import { collectBrowserEvidence } from '../collect-browser-evidence.mjs';
import { buildBrowserEngine, snapshotBrowserSources } from '../../test/build-browser-engine.mjs';
import { inspectBrowserEngineArtifact, packageBrowserEngineArtifact, publishBrowserEngineArtifact } from '../../test/package-browser-engine-artifact.mjs';
import { resolvePlaygroundEngine } from '../browser-engine-artifacts.mjs';
import { canonical, digest, inspectRelease, json, writeJson, identity, hashSiteRuntimeFiles, assertSourcePatchChains, assertInputScriptBuildProof, assertInputScriptRuntimeExports,
  GAME_PROBE_EXPORTS, OBSERVATION_EXPORTS, OBSERVATION_SOURCE_PATHS, RUNTIME_WRITE_EXPORTS } from '../web-release-utils.mjs';
import { patchAudioLifecycle } from '../patch-web-audio-lifecycle.mjs';
import { webLifecycleBuildProof } from '../patch-web-lifecycle.mjs';
import { executionFromReport } from '../execution-contract.mjs';
import { artifactSetMountBuildProof } from '../patch-artifact-set-mount.mjs';
import { managedShutdownBuildProof } from '../patch-managed-shutdown-queue.mjs';
import { GAME_PROBE_PATCH, GAME_PROBE_PATHS } from '../patch-web-game-probe.mjs';
import { INPUT_SCRIPT_EXPORTS, INPUT_SCRIPT_PATCH, INPUT_SCRIPT_PATHS, INPUT_SCRIPT_WASM_MARKER } from '../patch-web-input-script.mjs';
import {getEngineProfile} from '../engine-profiles.mjs';
import {workerBuildReportFixture} from '../../../apps/playground/scripts/fixtures/worker-build-report.mjs';
import {propertiesProofFixture,runtimeCallProofFixture} from '../../../apps/playground/scripts/fixtures/runtime-properties-build-report.mjs';

test('composed native source patches require a continuous chain ending at the compiled snapshot',()=>{
 const first=digest('upstream'),middle=digest('lifecycle'),last=digest('worker imports');
 const report={recipe:{patches:[{patchId:'lifecycle',path:'audio.js',beforeSha256:first,afterSha256:middle},{patchId:'worker',path:'audio.js',beforeSha256:middle,afterSha256:last}]},godotSource:{inputs:{'audio.js':last}}};
 assert.equal(assertSourcePatchChains(report).get('audio.js').patchId,'worker');
 const broken=structuredClone(report);broken.recipe.patches[1].beforeSha256=first;assert.throws(()=>assertSourcePatchChains(broken),/Broken source patch chain/);
 const stale=structuredClone(report);stale.godotSource.inputs['audio.js']=middle;assert.throws(()=>assertSourcePatchChains(stale),/not in the attested snapshot/);
});

async function fixture(t, certifiedSource = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'web-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(path, contents) { const target = resolve(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, contents); return target; }
  const engine = resolve(root, 'engine'); await mkdir(engine);
  const audioFixture = await readFile(new URL('../../jsb.react-browser/test/fixtures/godot-4.6.1-audio.js',import.meta.url),'utf8');
  await file('engine/godot.js', patchAudioLifecycle(audioFixture).code+'\nnavigator.serviceWorker.getRegistration().then(GodotPWA.updateState.bind(null, cb));');
  for (const name of ['godot.audio.worklet.js', 'godot.audio.position.worklet.js']) await file(`engine/${name}`, '/* fixture engine */');
  await file('engine/godot.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const archive = resolve(root, 'engine.zip');
  const zipped = spawnSync('zip', ['-q', archive, 'godot.js', 'godot.wasm', 'godot.audio.worklet.js', 'godot.audio.position.worklet.js'], { cwd: engine });
  assert.equal(zipped.status, 0, 'zip is available');
  const source = { commit: 'a'.repeat(40), inputs: { 'source.cpp': digest('fixture source') } }; source.snapshotHash = digest(canonical(source.inputs));
  const recipe = { command: 'scons', args: ['threads=no', 'dlink_enabled=no', 'platform=web', 'use_quickjs_ng=no'] };
  const report = { schemaVersion: 1, kind: 'godot-js-browser-engine-build', status: certifiedSource ? 'built' : 'existing-development', source, godotSource: source, recipe, recipeSha256: digest(canonical(recipe)), builder: { sha256: digest('fixture builder') }, toolchains: { emscripten: 'fixture only' }, versionEvidence: { sha256: digest('fixture header') }, godotVersion: '4.6.1.fixture', engineTarget: 'template_debug', template: { path: archive, sha256: digest(await readFile(archive)) } };
  await writeJson(resolve(root, 'engine-report.json'), report);
  const config = {
    sdk: { development: await file('sdk-development.js', 'exports.sdk="development";'), production: await file('sdk-production.js', 'exports.sdk="production";') },
    types: resolve(root, 'types'), contracts: await file('contracts.mjs', 'export const fixture=true;'), bootstrap: await file('bootstrap.json', '{}'),
    compiler: { js: await file('esbuild.js', '/* compiler fixture */'), wasm: await file('esbuild.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), typescript: await file('typescript.js', 'var ts={version:"fixture"};') },
    metadata: { runtimeAbi: 'godot-react/1', nativeBridgeAbi: 'godot-react-native/1', react: { react: '19.3.1', reconciler: '0.34.0', scheduler: '0.28.0' }, profiles: [{ id: 'core-ui-v1', version: 1, hash: digest('fixture profile') }], specifiers: { react: 'res://vendor/react.js' } },
  };
  await file('types/node_modules/@godot-js/react/dist/index.d.ts', 'export declare const fixture:true;');
  await writeJson(resolve(root, 'assets.json'), config);
  return { root, config, report, dir: resolve(root, 'release'), configuration: { 'engine-report': resolve(root, 'engine-report.json'), assets: resolve(root, 'assets.json'), out: resolve(root, 'release'), development: !certifiedSource } };
}

test('existing template stays development and cannot become certified by a flag', async t => {
  const f = await fixture(t);
  const recorded = resolve(f.root, 'recorded.json');
  await buildBrowserEngine({ 'existing-template': f.report.template.path, out: recorded, development: true, 'godot-version': '4.6.1', target: 'template_debug' });
  const result = await buildRelease({ ...f.configuration, 'engine-report': recorded });
  assert.equal(result.sourceCertified, false); assert.equal(result.certified, false);
  assert.equal((await inspectRelease(f.dir)).engine.target, 'template_debug');
  await assert.rejects(buildRelease({ ...f.configuration, development: false }), /E_RELEASE_SOURCE/);
  await assert.rejects(buildBrowserEngine({ 'existing-template': f.report.template.path, out: recorded }), /E_BROWSER_UNCERTIFIED/);
});

test('static release verification requires the evidence for an advertised observation ABI', async t => {
  const f = await fixture(t, true);
  await buildRelease(f.configuration);
  const descriptorPath = resolve(f.dir, 'release.json');
  const descriptor = await json(descriptorPath);
  const attestationPath = resolve(f.dir, descriptor.attestation);
  const attestation = await json(attestationPath);
  attestation.runtimeAbi = {protocolVersion: 2, host: 1, audio: 1, presentation: 1, lifecycle: 1, observation: 1};
  await writeJson(attestationPath, attestation);
  const bytes = await readFile(attestationPath);
  const file = descriptor.files.find(item => item.path === descriptor.attestation);
  Object.assign(file, {bytes: bytes.length, sha256: digest(bytes)});
  descriptor.id = descriptor.runtimeRelease = identity(descriptor);
  await writeJson(descriptorPath, descriptor);
  await assert.rejects(inspectRelease(f.dir), /E_RUNTIME_OBSERVATION_BUILD_PROOF/);
});

test('development release can retain Input Script patches with the capability disabled', async t => {
  const f = await fixture(t);
  await buildRelease(f.configuration);
  const descriptorPath = resolve(f.dir, 'release.json');
  const descriptor = await json(descriptorPath);
  const attestationPath = resolve(f.dir, descriptor.attestation);
  const attestation = await json(attestationPath);
  const path = 'scene/main/scene_tree.cpp';
  const afterSha256 = digest('compiled Input Script fixture');
  attestation.recipe.patches = [{patchId:INPUT_SCRIPT_PATCH,path,beforeSha256:digest('upstream scene tree'),afterSha256}];
  attestation.recipeSha256 = digest(canonical(attestation.recipe));
  attestation.godotSource.inputs[path] = afterSha256;
  attestation.godotSource.snapshotHash = digest(canonical(attestation.godotSource.inputs));

  async function seal(next) {
    await writeJson(attestationPath, next);
    const bytes = await readFile(attestationPath);
    Object.assign(descriptor.files.find(item => item.path === descriptor.attestation), {bytes:bytes.length,sha256:digest(bytes)});
    descriptor.id = descriptor.runtimeRelease = identity(descriptor);
    await writeJson(descriptorPath, descriptor);
  }

  assert.throws(() => assertInputScriptBuildProof(attestation), /E_INPUT_SCRIPT_BUILD_PROOF/);
  await seal(attestation);
  assert.equal((await inspectRelease(f.dir)).sourceCertified, false);
  await seal({...attestation,runtimeAbi:{inputScript:1}});
  await assert.rejects(inspectRelease(f.dir), /E_INPUT_SCRIPT_BUILD_PROOF/);
  await seal({...attestation,godotSource:{...attestation.godotSource,inputs:{}}});
  await assert.rejects(inspectRelease(f.dir), /E_RELEASE_RECIPE/);
});

test('portable runtime write evidence must match the WASM inside the ZIP', async t => {
  const f = await fixture(t, true);
  const report = {...f.report, ...workerBuildReportFixture(), sourceCertified: true, runtimeProfile: 'full-engine-v1'};
  const sources = Object.fromEntries(OBSERVATION_SOURCE_PATHS.map(path => [path, digest(path)]));
  Object.assign(report.source.inputs, sources);
  report.source.snapshotHash = digest(canonical(report.source.inputs));
  Object.assign(report.runtimeAbi, {observation: 1, runtimeWrite: 1});
  const wasm = await readFile(resolve(f.root, 'engine/godot.wasm'));
  const wasmSha256 = digest(wasm);
  report.template.assets = [{path: 'godot.wasm', sha256: wasmSha256, bytes: wasm.length}];
  report.runtimeObservation = {abi: 1, exports: OBSERVATION_EXPORTS, sources, wasmSha256};
  report.runtimeWrite = {abi: 1, exports: RUNTIME_WRITE_EXPORTS, sources, wasmSha256};
  const reportPath = f.configuration['engine-report'];
  await writeJson(reportPath, report);
  const out = resolve(f.root, 'portable');
  const {manifest} = await packageBrowserEngineArtifact({report: reportPath, out});
  assert.equal((await inspectBrowserEngineArtifact(out)).status, 'verified');

  const wrongTarget = structuredClone(report);
  wrongTarget.recipe.args[wrongTarget.recipe.args.indexOf('target=template_debug')] = 'target=template_release';
  wrongTarget.recipeSha256 = digest(canonical(wrongTarget.recipe));
  wrongTarget.resolvedBuildOptions.target = 'template_release';
  await writeJson(reportPath, wrongTarget);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'invalid-target')}),
    /E_RUNTIME_WRITE_BUILD_PROOF/);

  const wrongSha256 = digest('different WASM');
  report.template.assets[0].sha256 = wrongSha256;
  report.runtimeObservation.wasmSha256 = wrongSha256;
  report.runtimeWrite.wasmSha256 = wrongSha256;
  await writeJson(reportPath, report);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'invalid-portable')}),
    /E_RUNTIME_WRITE_BUILD_PROOF/);
  await assert.rejects(publishBrowserEngineArtifact({report: reportPath, publish: resolve(f.root, 'current.json'),
    templateOut: resolve(f.root, 'current.zip')}), /E_RUNTIME_WRITE_BUILD_PROOF/);

  // Even when all report and manifest hashes agree, the original ZIP remains authoritative.
  for (const [name, value] of [['engine-report.original.json', report],
    ['engine-report.json', {...report, template: {...report.template, path: 'engine-template.zip'}}]]) {
    const filename = resolve(out, name);
    await writeJson(filename, value);
    const bytes = await readFile(filename);
    manifest.files[name] = {sha256: digest(bytes), bytes: bytes.length};
  }
  manifest.sourceReportSha256 = manifest.files['engine-report.original.json'].sha256;
  await writeJson(resolve(out, 'artifact.json'), manifest);
  await assert.rejects(inspectBrowserEngineArtifact(out), /E_RUNTIME_WRITE_BUILD_PROOF/);
});

test('portable Game Probe and Input Script require source proof and Input Script runtime exports', async t => {
  const f = await fixture(t, true);
  const wasmSha256 = digest(await readFile(resolve(f.root, 'engine/godot.wasm')));
  const javascriptSha256 = digest(await readFile(resolve(f.root, 'engine/godot.js')));
  const report = {...f.report, ...propertiesProofFixture(wasmSha256)};
  delete report.runtimeAbi.runtimeProperties;
  delete report.runtimeProperties;
  report.runtimeAbi.gameProbe = 1;
  report.gameProbe = {abi: 1, exports: GAME_PROBE_EXPORTS, wasmSha256, javascriptSha256};
  report.template.assets = [{path: 'godot.wasm', sha256: wasmSha256}, {path: 'godot.js', sha256: javascriptSha256}];
  const implementation = {path: 'scripts/release/patch-web-game-probe.mjs', sha256: digest('game probe patch')};
  report.source.inputs[implementation.path] = implementation.sha256;
  report.source.inputs['bridge/jsb_runtime_game_probe.h'] = digest('game probe header');
  report.source.snapshotHash = digest(canonical(report.source.inputs));
  for (const path of GAME_PROBE_PATHS) {
    const beforeSha256 = report.godotSource.inputs[path] ?? digest('upstream ' + path);
    const afterSha256 = digest('game probe ' + path);
    report.recipe.patches.push({path, patchId: GAME_PROBE_PATCH, beforeSha256, afterSha256, implementation});
    report.godotSource.inputs[path] = afterSha256;
  }
  report.godotSource.snapshotHash = digest(canonical(report.godotSource.inputs));
  report.recipeSha256 = digest(canonical(report.recipe));
  const {patches} = report.recipe;
  Object.assign(report, webLifecycleBuildProof(patches), artifactSetMountBuildProof(patches), managedShutdownBuildProof(patches));
  const reportPath = f.configuration['engine-report'];
  await writeJson(reportPath, report);
  const out = resolve(f.root, 'game-probe');
  const packed = await packageBrowserEngineArtifact({report: reportPath, out});
  assert.equal(packed.manifest.development, false);
  assert.equal(packed.report.runtimeAbi.gameProbe, 1);

  const inputReport = structuredClone(report);
  const inputImplementation = {path: 'scripts/release/patch-web-input-script.mjs', sha256: digest('input script patch')};
  const profile = getEngineProfile(inputReport.runtimeProfile);
  inputReport.modules = profile.requiredModules;
  inputReport.resolvedFeatures = profile.features;
  inputReport.runtimeAbi.inputScript = 1;
  inputReport.inputScript = {abi: 1, exports: INPUT_SCRIPT_EXPORTS, wasmSha256, javascriptSha256};
  inputReport.source.inputs[inputImplementation.path] = inputImplementation.sha256;
  for (const extension of ['cpp', 'h']) inputReport.source.inputs['bridge/jsb_runtime_input_script.' + extension] = digest(extension);
  inputReport.source.snapshotHash = digest(canonical(inputReport.source.inputs));
  for (const path of INPUT_SCRIPT_PATHS) {
    const probeIndex = inputReport.recipe.patches.findIndex(patch => patch.path === path && patch.patchId === GAME_PROBE_PATCH);
    const probe = inputReport.recipe.patches[probeIndex];
    const beforeSha256 = probe?.beforeSha256 ?? inputReport.godotSource.inputs[path] ?? digest('upstream ' + path);
    const afterSha256 = digest('input script ' + path);
    const patch = {path, patchId: INPUT_SCRIPT_PATCH, beforeSha256, afterSha256, implementation: inputImplementation};
    if (probe) {
      probe.beforeSha256 = afterSha256;
      inputReport.recipe.patches.splice(probeIndex, 0, patch);
    } else {
      inputReport.recipe.patches.push(patch);
      inputReport.godotSource.inputs[path] = afterSha256;
    }
  }
  inputReport.godotSource.snapshotHash = digest(canonical(inputReport.godotSource.inputs));
  inputReport.recipeSha256 = digest(canonical(inputReport.recipe));
  Object.assign(inputReport, webLifecycleBuildProof(inputReport.recipe.patches), managedShutdownBuildProof(inputReport.recipe.patches));
  assert.equal(executionFromReport(inputReport).lifecycleAbi, 1);
  assert.doesNotThrow(() => assertInputScriptBuildProof(inputReport));
  const wasmPath = resolve(f.root, 'engine/godot.wasm');
  const javascriptPath = resolve(f.root, 'engine/godot.js');
  const wasmHeader = await readFile(wasmPath);
  const originalGlue = await readFile(javascriptPath, 'utf8');
  const names = [...'abcde'];
  function inputModule({indices = [0, 1, 2, 3, 4], stageType = 1} = {}) {
    const i32 = 0x7f, i64 = 0x7e;
    const types = [5,
      0x60, 0, 1, i32,
      0x60, 3, i32, i32, i32, 1, i32,
      0x60, 2, i32, i32, 0,
      0x60, 1, i32, 1, i32,
      0x60, 3, i64, i32, i32, 1, i32,
    ];
    const functions = [5, 0, 0, stageType, 2, 3];
    const exports = [5, ...names.flatMap((name, index) => [1, name.charCodeAt(0), 0, indices[index]])];
    const returnZero = [4, 0, 0x41, 0, 0x0b];
    const bodies = [5, ...returnZero, ...returnZero, ...returnZero, 2, 0, 0x0b, ...returnZero];
    return Buffer.concat([wasmHeader, Buffer.from([
      1, types.length, ...types, 3, functions.length, ...functions,
      7, exports.length, ...exports, 10, bodies.length, ...bodies,
    ])]);
  }
  const wasm = inputModule();
  const bindings = INPUT_SCRIPT_EXPORTS.map((symbol, index) =>
    `Module["${symbol}"] = ${symbol} = wasmExports["${names[index]}"];`).join('\n');
  const linkedGlue = (exports, linkedWasm, placeholders = '') => `${originalGlue}
var Godot = (() => {
  return async function(moduleArg = {}) {
    var Module = moduleArg;
    function makeInvalidEarlyAccess(name) { return () => { throw Error(name); }; }
    function createExportWrapper(name, nargs) { return (...args) => wasmExports[name](...args.slice(0, nargs)); }
    async function createWasm() {
      function receiveInstance(instance, module) {
        wasmExports = instance.exports;
        assignWasmExports(wasmExports);
        return wasmExports;
      }
      function receiveInstantiationResult(result) { return receiveInstance(result.instance); }
      var result = await instantiateAsync();
      var exports = receiveInstantiationResult(result);
      return exports;
    }
    ${placeholders}
    function assignWasmExports(wasmExports) {
      ${exports}
    }
    var wasmExports = await createWasm();
    return Module;
  };
})();
${INPUT_SCRIPT_WASM_MARKER}${digest(linkedWasm)}\n`;
  async function writeInputTemplate(name, wasm, glue) {
    await writeFile(wasmPath, wasm);
    await writeFile(javascriptPath, glue);
    const archive = resolve(f.root, `${name}.zip`);
    const zipped = spawnSync('zip', ['-q', archive, 'godot.js', 'godot.wasm'], {cwd: resolve(f.root, 'engine')});
    assert.equal(zipped.status, 0);
    const wasmSha256 = digest(wasm), javascriptSha256 = digest(glue);
    inputReport.template = {path: archive, sha256: digest(await readFile(archive)),
      assets: [{path: 'godot.wasm', sha256: wasmSha256}, {path: 'godot.js', sha256: javascriptSha256}]};
    inputReport.runtimeObservation.wasmSha256 = wasmSha256;
    Object.assign(inputReport.gameProbe, {wasmSha256, javascriptSha256});
    Object.assign(inputReport.inputScript, {wasmSha256, javascriptSha256});
    await writeJson(reportPath, inputReport);
  }
  await writeInputTemplate('missing-bindings', wasm, linkedGlue(`var ${INPUT_SCRIPT_EXPORTS.join(', ')};`, wasm));
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'missing-bindings')}),
    /E_INPUT_SCRIPT_EXPORT: Missing JavaScript binding/);
  await assert.rejects(resolvePlaygroundEngine({repository: f.root, reportPath}), /E_INPUT_SCRIPT_EXPORT: Missing JavaScript binding/);
  const stage = bindings.split('\n').find(line => line.startsWith('Module["_godotjs_input_script_stage"]'));
  assert(stage);
  for (const [name, replacement] of [
    ['commented-input-binding', `/*${stage}*/`],
    ['line-comment-input-binding', `//${stage}`],
    ['quoted-input-binding', `const example = \`${stage}\`;`],
    ['conditional-input-binding', `if (false) { ${stage} }`],
    ['foreign-module-input-binding', `other.${stage}`],
    ['unused-function-input-binding', `function unusedBinding() { ${stage} }`],
    ['unreachable-input-binding', `return;\n${stage}`],
  ]) {
    await writeInputTemplate(name, wasm, linkedGlue(bindings.replace(stage, replacement), wasm));
    await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, name)}),
      /E_INPUT_SCRIPT_EXPORT: Missing JavaScript binding for .*_stage/);
    if (name === 'commented-input-binding') {
      await assert.rejects(buildRelease(f.configuration), /E_INPUT_SCRIPT_EXPORT: Missing JavaScript binding for .*_stage/);
    }
  }
  const overwritten = linkedGlue(bindings + '\nModule._godotjs_input_script_stage = undefined;', wasm);
  assert.throws(() => assertInputScriptRuntimeExports(Buffer.from(overwritten), wasm),
    /E_INPUT_SCRIPT_EXPORT: Multiple JavaScript assignments for .*_stage/);
  const disconnected = linkedGlue(bindings, wasm).replace('assignWasmExports(wasmExports);', 'return wasmExports;');
  assert.throws(() => assertInputScriptRuntimeExports(Buffer.from(disconnected), wasm), /Missing Emscripten input script initialization path/);
  const placeholders = INPUT_SCRIPT_EXPORTS.map(symbol =>
    `var ${symbol} = Module['${symbol}'] = makeInvalidEarlyAccess('${symbol}');`).join('\n');
  const wrapped = INPUT_SCRIPT_EXPORTS.map((symbol, index) =>
    `Module.${symbol} = ${symbol} = createExportWrapper('${names[index]}', ${[0, 0, 3, 2, 1][index]});`).join('\n');
  const debugGlue = linkedGlue(wrapped, wasm, placeholders);
  assert.doesNotThrow(() => assertInputScriptRuntimeExports(Buffer.from(debugGlue), wasm));
  assert.throws(() => assertInputScriptRuntimeExports(Buffer.from(debugGlue.replace("createExportWrapper('c', 3)", "createExportWrapper('c', 0)")), wasm),
    /E_INPUT_SCRIPT_EXPORT: Incorrect JavaScript wrapper arity for .*_stage/);
  const stubOnly = linkedGlue(bindings.replace(stage, ''), wasm, placeholders);
  assert.throws(() => assertInputScriptRuntimeExports(Buffer.from(stubOnly), wasm), /Missing JavaScript binding for .*_stage/);
  const stagePlaceholder = placeholders.split('\n').find(line => line.startsWith('var _godotjs_input_script_stage = '));
  assert(stagePlaceholder);
  const latePlaceholder = linkedGlue(bindings, wasm).replace('var wasmExports = await createWasm();',
    'var wasmExports = await createWasm(), ' + stagePlaceholder.slice(4));
  assert.throws(() => assertInputScriptRuntimeExports(Buffer.from(latePlaceholder), wasm), /Multiple JavaScript assignments for .*_stage/);
  await writeInputTemplate('missing-wasm-functions', wasmHeader, linkedGlue(bindings, wasmHeader));
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'missing-wasm-functions')}),
    /E_INPUT_SCRIPT_EXPORT: Missing WebAssembly function/);
  await assert.rejects(buildRelease(f.configuration), /E_INPUT_SCRIPT_EXPORT: Missing WebAssembly function/);
  const aliased = inputModule({indices: [0, 0, 2, 3, 4]});
  await writeInputTemplate('aliased-input-functions', aliased, linkedGlue(bindings, aliased));
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'aliased-input-functions')}),
    /E_INPUT_SCRIPT_EXPORT: Duplicate WebAssembly function for .*_buffer/);
  const wrongType = inputModule({stageType: 4});
  await writeInputTemplate('wrong-input-signature', wrongType, linkedGlue(bindings, wrongType));
  await assert.rejects(resolvePlaygroundEngine({repository: f.root, reportPath}),
    /E_INPUT_SCRIPT_EXPORT: Incorrect WebAssembly function signature for .*_stage/);
  const otherWasm = Buffer.from(wasm);
  otherWasm[otherWasm.length - 2] = 1; // Change the last function's return value without changing exports or types.
  const validGlue = linkedGlue(bindings, wasm);
  await writeInputTemplate('mixed-input-script', otherWasm, validGlue);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'mixed-input-script')}),
    /E_INPUT_SCRIPT_WASM_PAIR/);
  await assert.rejects(resolvePlaygroundEngine({repository: f.root, reportPath}), /E_INPUT_SCRIPT_WASM_PAIR/);
  await assert.rejects(buildRelease(f.configuration), /E_INPUT_SCRIPT_WASM_PAIR/);
  await writeInputTemplate('input-script-without-link-digest', wasm, `${originalGlue}\n${bindings}`);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'input-script-without-link-digest')}),
    /E_INPUT_SCRIPT_WASM_PAIR/);
  await writeInputTemplate('input-script', wasm, validGlue);
  const inputArtifact = await packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'input-script')});
  assert.equal(inputArtifact.report.runtimeAbi.inputScript, 1);
  for (const change of [
    candidate => delete candidate.runtimeAbi.inputScript,
    candidate => {candidate.inputScript.javascriptSha256 = digest('other JavaScript');},
    candidate => {
      const path = GAME_PROBE_PATHS.find(path => INPUT_SCRIPT_PATHS.includes(path));
      const input = candidate.recipe.patches.find(patch => patch.path === path && patch.patchId === INPUT_SCRIPT_PATCH);
      const probe = candidate.recipe.patches.find(patch => patch.path === path && patch.patchId === GAME_PROBE_PATCH);
      [input.patchId, probe.patchId] = [probe.patchId, input.patchId];
      [input.implementation, probe.implementation] = [probe.implementation, input.implementation];
      candidate.recipeSha256 = digest(canonical(candidate.recipe));
    },
  ]) {
    const changed = structuredClone(inputReport);
    change(changed);
    assert.throws(() => assertInputScriptBuildProof(changed), /E_INPUT_SCRIPT_BUILD_PROOF/);
  }

  delete report.runtimeObservation;
  await writeJson(reportPath, report);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'without-observation-proof')}),
    /E_RUNTIME_OBSERVATION_BUILD_PROOF/);
  delete report.runtimeAbi.observation;
  await writeJson(reportPath, report);
  await assert.rejects(packageBrowserEngineArtifact({report: reportPath, out: resolve(f.root, 'without-observation')}),
    /E_GAME_PROBE_BUILD_PROOF/);
});

test('portable properties evidence is checked against the actual ZIP and cannot be forged by report hashes',async t=>{
 const f=await fixture(t,true),wasmSha256=digest(await readFile(resolve(f.root,'engine/godot.wasm')));
 const report={...f.report,...propertiesProofFixture(wasmSha256)};
 report.template={...report.template,assets:[{path:'godot.wasm',sha256:wasmSha256}]};
 const reportPath=f.configuration['engine-report'];await writeJson(reportPath,report);
 const out=resolve(f.root,'properties-portable');
 const {manifest}=await packageBrowserEngineArtifact({report:reportPath,out});
 assert.equal((await inspectBrowserEngineArtifact(out)).report.runtimeAbi.runtimeProperties,1);
 const wrong=digest('wrong properties WASM');
 report.runtimeProperties.wasmSha256=wrong;report.runtimeObservation.wasmSha256=wrong;
 report.template.assets=[{path:'godot.wasm',sha256:wrong}];
 await writeJson(reportPath,report);
 await assert.rejects(packageBrowserEngineArtifact({report:reportPath,out:resolve(f.root,'bad-properties')}),/E_RUNTIME_PROPERTIES_BUILD_PROOF|E_RUNTIME_OBSERVATION_BUILD_PROOF/);
 for(const [name,value]of [['engine-report.original.json',report],['engine-report.json',{...report,template:{...report.template,path:'engine-template.zip'}}]]){
  const filename=resolve(out,name);await writeJson(filename,value);const bytes=await readFile(filename);
  manifest.files[name]={sha256:digest(bytes),bytes:bytes.length};
 }
 manifest.sourceReportSha256=manifest.files['engine-report.original.json'].sha256;
 await writeJson(resolve(out,'artifact.json'),manifest);
 await assert.rejects(inspectBrowserEngineArtifact(out),/E_RUNTIME_PROPERTIES_BUILD_PROOF|E_RUNTIME_OBSERVATION_BUILD_PROOF/);
});

test('runtime call rejects old JavaScript in a ZIP with the same WASM and updated archive hashes',async t=>{
  const f=await fixture(t,true),engine=resolve(f.root,'engine');
  const assets=await Promise.all(['godot.wasm','godot.js'].map(async path=>{
    const bytes=await readFile(resolve(engine,path));
    return {path,bytes:bytes.length,sha256:digest(bytes)};
  }));
  const [wasm,javascript]=assets;
  const profile=getEngineProfile('full-engine-v1');
  const report={...f.report,...runtimeCallProofFixture({wasmSha256:wasm.sha256,javascriptSha256:javascript.sha256}),
    modules:[...profile.modules],resolvedFeatures:{...profile.features},
    template:{...f.report.template,assets}};
  const reportPath=f.configuration['engine-report'],out=resolve(f.root,'call-portable');
  await writeJson(reportPath,report);
  const {manifest}=await packageBrowserEngineArtifact({report:reportPath,out});
  assert.equal((await inspectBrowserEngineArtifact(out)).report.runtimeAbi.runtimeCall,1);

  await writeFile(resolve(engine,'godot.js'),'/* stale bridge */');
  const mixedArchive=resolve(f.root,'mixed.zip');
  const zipped=spawnSync('zip',['-q',mixedArchive,'godot.js','godot.wasm','godot.audio.worklet.js','godot.audio.position.worklet.js'],{cwd:engine});
  assert.equal(zipped.status,0);
  const mixedBytes=await readFile(mixedArchive);
  const mixedReport={...report,template:{...report.template,path:mixedArchive,sha256:digest(mixedBytes),bytes:mixedBytes.length}};
  await writeJson(reportPath,mixedReport);
  await assert.rejects(packageBrowserEngineArtifact({report:reportPath,out:resolve(f.root,'mixed-portable')}),/E_RUNTIME_CALL_BUILD_PROOF/);
  await assert.rejects(buildRelease(f.configuration),/E_RUNTIME_CALL_BUILD_PROOF/);

  await writeFile(resolve(out,'engine-template.zip'),mixedBytes);
  manifest.files['engine-template.zip']={sha256:digest(mixedBytes),bytes:mixedBytes.length};
  for(const [name,value] of [['engine-report.original.json',mixedReport],
    ['engine-report.json',{...mixedReport,template:{...mixedReport.template,path:'engine-template.zip'}}]]){
    const filename=resolve(out,name);
    await writeJson(filename,value);
    const bytes=await readFile(filename);
    manifest.files[name]={sha256:digest(bytes),bytes:bytes.length};
  }
  manifest.sourceReportSha256=manifest.files['engine-report.original.json'].sha256;
  await writeJson(resolve(out,'artifact.json'),manifest);
  await assert.rejects(inspectBrowserEngineArtifact(out),/E_RUNTIME_CALL_BUILD_PROOF/);
});

test('native source snapshot includes SCsub preset bundles while excluding unrelated generated outputs', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'browser-source-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/out'), { recursive: true });
  await mkdir(resolve(root, 'scripts/jsb.react/dist'), { recursive: true });
  for (const name of ['jsb.runtime.bundle.js', 'jsb.editor.bundle.js', 'jsb.runtime.bundle.d.ts', 'jsb.runtime.bundle.js.map', 'jsb.editor.bundle.d.ts', 'jsb.editor.bundle.js.map']) await writeFile(resolve(root, 'scripts/out', name), `actual preset ${name}`);
  await writeFile(resolve(root, 'scripts/out/unrelated.log'), 'not a native input');
  await writeFile(resolve(root, 'scripts/jsb.react/dist/index.js'), 'not embedded by SCsub');
  await mkdir(resolve(root,'apps/playground/dist-2d-debug'),{recursive:true});
  await writeFile(resolve(root,'apps/playground/dist-2d-debug/main.js'),'generated candidate output');
  const snapshot = await snapshotBrowserSources(root, { module: true });
  assert.equal(Object.keys(snapshot.inputs).length, 6);
  assert(snapshot.inputs['scripts/out/jsb.runtime.bundle.js']);
  assert(snapshot.inputs['scripts/out/jsb.editor.bundle.js.map']);
  assert.equal(snapshot.snapshotHash, digest(canonical(snapshot.inputs)));
});

test('Godot snapshot preserves required misc/dist and nested directories with output-like names', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'godot-source-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['misc/dist/html/full-size.html', 'thirdparty/tool/bin/source.py', 'thirdparty/tool/out/schema.h', 'bin/build.wasm']) {
    await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), 'source fixture');
  }
  const snapshot = await snapshotBrowserSources(root);
  assert(snapshot.inputs['misc/dist/html/full-size.html']);
  assert(snapshot.inputs['thirdparty/tool/bin/source.py']);
  assert(snapshot.inputs['thirdparty/tool/out/schema.h']);
  assert.equal(snapshot.inputs['bin/build.wasm'], undefined);
});

test('release seals all bytes, maps declarations and emits an importable TypeScript module', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  assert.equal(release.id, release.runtimeRelease);
  assert.equal(release.typesRoot, '/node_modules/@types');
  assert.equal(release.jsGluePatches[0].changed, true);
  assert.equal(release.files.find(file => file.kind === 'engine-wasm').encoding, 'gzip');
  assert.equal(release.files.find(file => file.kind === 'engine-wasm').decodedBytes, 8);
  assert(release.files.some(file => file.virtualPath === '/node_modules/@godot-js/react/dist/index.d.ts'));
  for (const file of release.files.filter(file => file.kind === 'type')) {
    assert.match(file.path, /^types\/[a-f0-9]{64}\.txt$/, 'Declaration URLs must survive static-host dependency/source filters');
    assert(!file.path.includes('node_modules'));
    assert.equal(await readFile(resolve(f.dir, file.path), 'utf8'), 'export declare const fixture:true;');
  }
  const typescript = await import(pathToFileURL(resolve(f.dir, release.typescriptUrl)));
  assert.equal(typescript.default.version, 'fixture');
  const original = release.id; await buildRelease(f.configuration);
  assert.equal((await inspectRelease(f.dir)).id, original, 'same immutable inputs have same release identity');
  await writeFile(resolve(f.dir, 'assets/godot.js'), 'changed');
  await assert.rejects(inspectRelease(f.dir), /E_RELEASE_INTEGRITY/);
});

test('descriptor and recipe tampering are rejected', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const release = await json(resolve(f.dir, 'release.json')); release.engine.threads = true;
  await writeJson(resolve(f.dir, 'release.json'), release);
  await assert.rejects(inspectRelease(f.dir), /E_RELEASE_IDENTITY/);
});

test('proxy-pthread release binds resolved switches and the final verified main-worker bytes',async t=>{
  const f=await fixture(t,true),main=await readFile(resolve(f.root,'engine/godot.js'));
  f.report.recipe.args=['platform=web','threads=yes','proxy_to_pthread=yes','dlink_enabled=no','use_quickjs_ng=no'];
  f.report.recipeSha256=digest(canonical(f.report.recipe));
  f.report.resolvedBuildOptions={threads:true,proxy_to_pthread:true,dlink_enabled:false};
  f.report.execution={schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded',workerAssets:[{path:'godot.js',sha256:digest(main),bytes:main.length,role:'engine-main'}]};
  await writeJson(resolve(f.root,'engine-report.json'),f.report);
  await buildRelease(f.configuration);const release=await inspectRelease(f.dir);
  assert.equal(release.engine.threads,true);assert.equal(release.execution.executionModel,'proxy-pthread');
  const sealed=release.files.find(file=>file.kind==='engine-js');
  assert.deepEqual(release.execution.workerAssets,[{path:sealed.path,sha256:sealed.sha256,bytes:sealed.bytes,role:'engine-main'}]);
  release.engine.threads=false;release.id=release.runtimeRelease=identity(release);await writeJson(resolve(f.dir,'release.json'),release);
  await assert.rejects(inspectRelease(f.dir),/E_RELEASE_EXECUTION/);
  f.report.resolvedBuildOptions.proxy_to_pthread=false;await writeJson(resolve(f.root,'engine-report.json'),f.report);
  await assert.rejects(buildRelease(f.configuration),/Resolved proxy|E_RELEASE_SOURCE/);
});

test('encoded WASM verifies decoded bytes and raw mode is development-only', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const path = resolve(f.dir, 'release.json'), release = await json(path);
  release.files.find(file => file.kind === 'engine-wasm').decodedSha256 = digest('different decoded WASM');
  release.id = release.runtimeRelease = identity(release);
  await writeJson(path, release);
  await assert.rejects(inspectRelease(f.dir), /Decoded WASM bytes differ/);
  await buildRelease({ ...f.configuration, 'raw-wasm': true });
  assert.equal((await inspectRelease(f.dir)).files.find(file => file.kind === 'engine-wasm').path, 'assets/godot.wasm');
  const formal = await fixture(t, true);
  await assert.rejects(buildRelease({ ...formal.configuration, 'raw-wasm': true }), /E_RELEASE_ENCODING/);
});

test('release attestation retains modern native ABI receipts and rejects changed source proof',async t=>{
 const f=await fixture(t,true),native=workerBuildReportFixture();Object.assign(f.report,native);
 await writeJson(f.configuration['engine-report'],f.report);await buildRelease(f.configuration);
 const descriptor=await inspectRelease(f.dir),attestation=await json(resolve(f.dir,descriptor.attestation));
 for(const field of ['runtimeAbi','workerPatch','lifecycleAbi','lifecyclePatch','artifactSetAbi','artifactSetPatch','observerAbi','nativeObserverPatch','hostResourceAbi','hostResourcePatch','shutdownQueueAbi','shutdownQueuePatch'])assert.deepEqual(attestation[field],native[field],field);
 for(const [field,mutate]of [
  ['lifecyclePatch',proof=>{proof.files['scene/main/scene_tree.h'].sha256=digest('wrong lifecycle source');}],
  ['artifactSetPatch',proof=>{proof.sha256=digest('wrong mount source');}],
  ['hostResourcePatch',proof=>{proof.files[Object.keys(proof.files)[0]].sha256=digest('wrong resource source');}],
  ['shutdownQueuePatch',proof=>{proof.files['main/main.cpp'].sha256=digest('wrong shutdown source');}],
 ]){
  const changed=structuredClone(attestation),updated=structuredClone(descriptor);mutate(changed[field]);
  await writeJson(resolve(f.dir,descriptor.attestation),changed);
  const bytes=await readFile(resolve(f.dir,descriptor.attestation));Object.assign(updated.files.find(file=>file.path===descriptor.attestation),{sha256:digest(bytes),bytes:bytes.length});
  updated.id=updated.runtimeRelease=identity(updated);await writeJson(resolve(f.dir,'release.json'),updated);
  await assert.rejects(inspectRelease(f.dir),/E_EXECUTION_CONTRACT/,field);
 }
});

test('browser certification binds every candidate asset and cannot certify an old template', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  assert.equal(release.sourceCertified, true); assert.equal(release.certified, false);
  assert.equal(release.target.sourceCommit, f.report.source.commit);
  const evidence = { status: 'passed', runtimeRelease: release.id, checks: [{ name: 'fixture-only-no-real-browser-claim', status: 'passed' }], artifactHashes: Object.fromEntries(release.files.filter(file => file.kind !== 'attestation').map(file => [file.path, file.sha256])) };
  const path = resolve(f.root, 'validation.json'); await writeJson(path, evidence);
  await buildRelease({ ...f.configuration, 'validation-report': path });
  assert.equal((await inspectRelease(f.dir, { requireCertified: true })).id, release.id, 'certification binds the existing candidate identity');
  delete evidence.artifactHashes[release.files.find(file => file.kind === 'engine-wasm').path]; await writeJson(path, evidence);
  await assert.rejects(buildRelease({ ...f.configuration, 'validation-report': path }), /E_RELEASE_VALIDATION/);
});

test('unchanged file hashes cannot certify changed profile or target metadata', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir);
  const validation = { status: 'passed', runtimeRelease: release.id, checks: [{ name: 'fixture-only', status: 'passed' }], artifactHashes: Object.fromEntries(release.files.filter(file => file.kind !== 'attestation').map(file => [file.path, file.sha256])) };
  const validationPath = resolve(f.root, 'validation.json'); await writeJson(validationPath, validation);
  f.config.metadata.profiles[0].hash = digest('changed profile metadata with same artifact files');
  await writeJson(f.configuration.assets, f.config);
  await assert.rejects(buildRelease({ ...f.configuration, 'validation-report': validationPath }), /exact runtimeRelease/);
});

test('npm pack is installed and verified in a real external consumer', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const result = await verifyRelease({ dir: f.dir, 'pack-out': resolve(f.root, 'packs') });
  assert.equal(result.status, 'verified'); assert.equal(result.externalConsumer, true);
  assert.equal(result.cdnVerified, false); assert.equal(result.certified, false);
  assert((await readFile(result.tarball)).length > 0);
});

test('CDN verification detects changed bytes and changed descriptor', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const descriptor = await inspectRelease(f.dir);
  let tamper;
  const fetcher = async url => {
    const path = decodeURIComponent(url.pathname).replace('/candidate/', '');
    let bytes = await readFile(resolve(f.dir, path));
    if (tamper === path) bytes = Buffer.from('changed');
    return new Response(bytes);
  };
  assert.equal(await verifyCDN({ baseUrl: 'https://cdn.invalid/candidate/', descriptor, fetcher }), true);
  tamper = descriptor.files.find(file => file.kind === 'engine-wasm').path; await assert.rejects(verifyCDN({ baseUrl: 'https://cdn.invalid/candidate/', descriptor, fetcher }), /E_RELEASE_CDN/);
});

test('uncertified publish refuses before accessing registry and writes a truthful report', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const path = resolve(f.root, 'publish.json');
  await assert.rejects(publishRelease({ dir: f.dir, report: path, registry: 'https://do-not-contact.invalid/' }), /E_RELEASE_UNCERTIFIED/);
  const report = await json(path); assert.equal(report.status, 'failed'); assert.equal(report.phase, 'prepare'); assert.equal(report.published, false); assert.equal(report.cdnVerified, false);
});

test('static application pins the full final descriptor including evidence', async t => {
  const f = await fixture(t); await buildRelease(f.configuration);
  const site = resolve(f.root, 'site');
  await writeJson(resolve(site, 'app-config.json'), { previewUrl: 'https://preview.invalid/preview.html' });
  const result = await pinRelease({ site, release: f.dir });
  const config = await json(resolve(site, 'app-config.json'));
  assert.equal(config.expectedReleaseId, (await inspectRelease(f.dir)).id);
  assert.equal(config.expectedDescriptorSha256, digest(await readFile(resolve(f.dir, 'release.json'))));
  assert.equal(result.descriptorSha256, config.expectedDescriptorSha256);
  assert.equal(config.previewUrl, 'https://preview.invalid/preview.html');
});

test('aggregate evidence binds exact release, real file bytes, static templates and engine-map provenance', async t => {
  const f = await fixture(t, true); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir), site = resolve(f.root, 'site');
  await cp(f.dir, resolve(site, 'release'), { recursive: true });
  for (const name of ['index.html', 'main.js', 'compiler-worker.js', 'types-worker.js', 'preview.html', 'preview.js']) await writeFile(resolve(site, name), `/* fixture ${name} */`);
  const browser = 'unit-fixture-only', checks = [{ name: 'fixture-not-browser-execution', status: 'passed' }];
  const integration = { status: 'passed', runtimeRelease: release.id, browser, checks,
    artifactHashes: Object.fromEntries(await Promise.all(release.files.map(async file => [file.path, digest(await readFile(resolve(f.dir, file.path)))]))),
    siteArtifactHashes: await hashSiteRuntimeFiles(site), generatedArtifacts: { maps: Array.from({ length: 2 }, () => ({ sha256: digest('fixture map'), sealedSha256: digest('fixture map'), version: 3, mappings: true })) } };
  const stress = { status: 'passed', runtimeRelease: release.id, browser, checks,
    siteArtifactHashes: integration.siteArtifactHashes,
    cycles: Array.from({ length: 100 }, (_, index) => ({ runId: `fixture-${index}`, exit: { runId: `fixture-${index}`, reason: 'clean-exit', code: 0 } })),
    failureCycles: Array.from({ length: 20 }, (_, index) => index % 2
      ? { kind: 'cancel-engine-startup', runId: `cancel-${index}`, exit: { runId: `cancel-${index}`, reason: 'forced-frame-disposal' } }
      : { kind: 'semantic-build-refused', activeRunId: `semantic-${index}`, rejected: { accepted: false }, exit: { runId: `semantic-${index}`, reason: 'clean-exit', code: 0 } }) };
  const maps = { status: 'passed', browser, checks: ['caught', 'compressed', 'uncaught'].map(name => ({ name, status: 'passed' })), engine: {
    archiveSha256: f.report.template.sha256, sourceSnapshotHash: f.report.source.snapshotHash, godotSourceSnapshotHash: f.report.godotSource.snapshotHash, recipeSha256: f.report.recipeSha256,
    assets: { 'godot.js': digest(await readFile(resolve(f.root, 'engine/godot.js'))), 'godot.wasm': digest(await readFile(resolve(f.root, 'engine/godot.wasm'))) } } };
  const configuration = { site, 'engine-report': f.configuration['engine-report'], out: resolve(f.root, 'acceptance.json') };
  for (const [name, report] of [['integration', integration], ['stress', stress], ['source-maps', maps]]) { configuration[name] = resolve(f.root, `${name}.json`); await writeJson(configuration[name], report); }
  assert.equal((await collectBrowserEvidence(configuration)).runtimeRelease, release.id);
  const authenticated = { ...integration, checks: ['http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', 'cross-origin-cdn-does-not-receive-site-cookie'].map(name => ({ name, status: 'passed' })) };
  configuration['authenticated-report'] = resolve(f.root, 'authenticated.json'); await writeJson(configuration['authenticated-report'], authenticated);
  assert.equal((await collectBrowserEvidence(configuration)).scope.authenticatedAssets.crossOriginCredentialsOmitted, true);
  authenticated.runtimeRelease = digest('different authenticated release'); await writeJson(configuration['authenticated-report'], authenticated);
  await assert.rejects(collectBrowserEvidence(configuration), /same release and actual browser/);
  authenticated.runtimeRelease = release.id; await writeJson(configuration['authenticated-report'], authenticated);
  stress.runtimeRelease = digest('different release'); await writeJson(configuration.stress, stress);
  await assert.rejects(collectBrowserEvidence(configuration), /exact runtimeRelease/);
  stress.runtimeRelease = release.id; await writeJson(configuration.stress, stress);
  maps.engine.archiveSha256 = digest('different template'); await writeJson(configuration['source-maps'], maps);
  await assert.rejects(collectBrowserEvidence(configuration), /exact built archive/);
  maps.engine.archiveSha256 = f.report.template.sha256; await writeJson(configuration['source-maps'], maps);
  await writeFile(resolve(site, 'preview.js'), 'changed after passing integration');
  await assert.rejects(collectBrowserEvidence(configuration), /templates changed/);
});

function combinationCoverage(browserFamily, browserVersion, sourceReport) {
  const name = sourceReport ? `${sourceReport}:game-2d-native-composition` : 'game-2d-native-composition';
  return ['production', 'development'].map(sdkMode => ({ profileId: 'game-2d-v1', sdkMode, browserFamily, browserVersion, sourceReport, status: 'passed', checks: [name] }));
}
function browserValidation(browserFamily, browserVersion, sourceReport) {
  const native = ['production', 'development'].map(sdkMode => ({ name: 'game-2d-native-composition', profileId: 'game-2d-v1', sdkMode }));
  const legacy = [
    { name: 'real-cross-origin-godot-counter-click', profileId: 'core-ui-v1', sdkMode: 'production' },
    { name: 'png-ui-media-native-controls-and-controlled-baseline', profileId: 'ui-media-v1', sdkMode: 'production' },
    { name: 'real-web-physics-collision-and-stale-command-rejection', profileId: 'behavior-physics-v1', sdkMode: 'production' },
  ];
  return { browser: browserVersion, browserFamily,
    checks: [...native, ...legacy].map(check => ({ ...check, name: sourceReport ? `${sourceReport}:${check.name}` : check.name,
      status: 'passed', browserFamily, browserVersion, sourceReport })),
    coverage: combinationCoverage(browserFamily, browserVersion, sourceReport) };
}
function combinationValidation(release) {
  const reports = ['chromium', 'firefox', 'webkit'].map(family => browserValidation(family, `fixture-${family}`, family === 'chromium' ? 'integration' : family));
  return { status: 'passed', runtimeRelease: release.id,
    checks: reports.flatMap(report => report.checks),
    coverage: reports.flatMap(report => report.coverage),
    artifactHashes: Object.fromEntries(release.files.filter(file => file.kind !== 'attestation').map(file => [file.path, file.sha256])),
    scope: { lifecycle: { iterations: 100, failureCases: 20, scope: { fixture: 'game2d', profileId: 'game-2d-v1', sdkMode: 'production', browserFamily: 'chromium' } } } };
}

test('combined profile certification requires exact browser/mode tuples and combination lifecycle', async t => {
  const f = await fixture(t, true);
  f.config.metadata.profiles.push({ id: 'game-2d-v1', version: 1, hash: digest('fixture combined profile') });
  await writeJson(f.configuration.assets, f.config); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir), evidence = combinationValidation(release), path = resolve(f.root, 'combined-validation.json');
  const seal = async value => { await writeJson(path, value); return buildRelease({ ...f.configuration, 'validation-report': path }); };
  for (const mutate of [
    value => { value.coverage = []; },
    value => { value.checks = value.checks.filter(check => check.sdkMode !== 'development'); },
    value => { delete value.scope.lifecycle.iterations; },
    value => { value.coverage = value.coverage.filter(tuple => !(tuple.browserFamily === 'webkit' && tuple.sdkMode === 'development')); },
    value => { value.coverage[0].checks = ['not-a-passed-native-check']; },
    value => { value.checks = value.checks.filter(check => check.profileId === 'game-2d-v1'); },
    value => { value.checks = value.checks.filter(check => check.profileId !== 'ui-media-v1'); },
    value => { value.checks.find(check => check.profileId === 'core-ui-v1').browserVersion = 'wrong-version'; },
    value => { value.checks.find(check => check.profileId === 'game-2d-v1').browserFamily = 'firefox'; },
    value => { value.checks.find(check => check.profileId === 'game-2d-v1').browserVersion = 'wrong-version'; },
    value => { value.checks.find(check => check.profileId === 'game-2d-v1').sourceReport = 'firefox'; },
    value => { value.coverage.push(structuredClone(value.coverage[0])); },
    value => { value.checks.push(structuredClone(value.checks[0])); },
    value => {
      value.checks = value.checks.filter(check => check.sourceReport === 'integration');
      for (const tuple of value.coverage) tuple.checks = ['integration:game-2d-native-composition'];
    },
    value => { value.scope.lifecycle.scope.fixture = 'counter'; },
    value => { value.scope.lifecycle.iterations = 99; },
    value => { value.scope.lifecycle.failureCases = 19; },
  ]) { const invalid = structuredClone(evidence); mutate(invalid); await assert.rejects(seal(invalid), /E_GAME2D_EVIDENCE/); }
  await seal(evidence);
  assert.equal((await inspectRelease(f.dir, { requireCertified: true })).id, release.id);
  const descriptor = await json(resolve(f.dir, 'release.json'));
  for (const mutate of [
    value => { value.coverage = value.coverage.filter(tuple => tuple.browserFamily !== 'firefox'); },
    value => { value.checks = value.checks.filter(check => check.profileId === 'game-2d-v1'); },
    value => {
      value.checks = value.checks.filter(check => check.sourceReport === 'integration');
      for (const tuple of value.coverage) tuple.checks = ['integration:game-2d-native-composition'];
    },
  ]) {
    const invalid = structuredClone(descriptor); mutate(invalid.certification);
    await writeJson(resolve(f.dir, 'release.json'), invalid);
    await assert.rejects(inspectRelease(f.dir, { requireCertified: true }), /E_GAME2D_EVIDENCE/);
  }
});

test('combined aggregate rejects counter pressure, missing browsers, changed bytes and stale reports', async t => {
  const f = await fixture(t, true);
  f.config.metadata.profiles.push({ id: 'game-2d-v1', version: 1, hash: digest('fixture combined profile') });
  await writeJson(f.configuration.assets, f.config); await buildRelease(f.configuration);
  const release = await inspectRelease(f.dir), site = resolve(f.root, 'site');
  await cp(f.dir, resolve(site, 'release'), { recursive: true });
  for (const name of ['index.html', 'main.js', 'compiler-worker.js', 'types-worker.js', 'preview.html', 'preview.js']) await writeFile(resolve(site, name), `/* fixture ${name} */`);
  const integration = { ...combinationValidation(release), ...browserValidation('chromium', 'fixture-chromium'),
    artifactHashes: Object.fromEntries(release.files.map(file => [file.path, file.sha256])),
    siteArtifactHashes: await hashSiteRuntimeFiles(site), generatedArtifacts: { maps: Array.from({ length: 2 }, () => ({ sha256: digest('fixture map'), sealedSha256: digest('fixture map'), version: 3, mappings: true })) } };
  const scope = { fixture: 'game2d', profileId: 'game-2d-v1', sdkMode: 'production', browserFamily: 'chromium', buildKey: digest('fixture build'), generation: 'fixture-generation' };
  const cycleIdentity = { fixture: 'game2d', profileId: 'game-2d-v1', sdkMode: 'production', buildKey: digest('fixture build'), generation: 'fixture-generation' };
  const stress = { status: 'passed', runtimeRelease: release.id, browser: integration.browser, checks: [{ name: 'fixture-lifecycle', status: 'passed' }], scope,
    siteArtifactHashes: integration.siteArtifactHashes,
    cycles: Array.from({ length: 100 }, (_, index) => ({ ...cycleIdentity, nativeReady: true, runId: `run-${index}`, exit: { runId: `run-${index}`, reason: 'clean-exit', code: 0 } })),
    failureCycles: Array.from({ length: 20 }, (_, index) => index % 2
      ? { ...cycleIdentity, kind: 'cancel-engine-startup', runId: `cancel-${index}`, exit: { runId: `cancel-${index}`, reason: 'forced-frame-disposal' } }
      : { ...cycleIdentity, kind: 'semantic-build-refused', activeRunId: `semantic-${index}`, rejected: { accepted: false }, exit: { runId: `semantic-${index}`, reason: 'clean-exit', code: 0 } }) };
  const maps = { status: 'passed', browser: integration.browser, checks: ['caught', 'compressed', 'uncaught'].map(name => ({ name, status: 'passed' })), engine: {
    archiveSha256: f.report.template.sha256, sourceSnapshotHash: f.report.source.snapshotHash, godotSourceSnapshotHash: f.report.godotSource.snapshotHash, recipeSha256: f.report.recipeSha256,
    assets: { 'godot.js': digest(await readFile(resolve(f.root, 'engine/godot.js'))), 'godot.wasm': digest(await readFile(resolve(f.root, 'engine/godot.wasm'))) } } };
  const firefox = { ...structuredClone(integration), ...browserValidation('firefox', 'fixture-firefox') };
  const webkit = { ...structuredClone(integration), ...browserValidation('webkit', 'fixture-webkit') };
  const config = { site, 'engine-report': f.configuration['engine-report'] };
  for (const [name, report] of [['integration', integration], ['stress', stress], ['source-maps', maps], ['firefox-report', firefox], ['webkit-report', webkit]]) { config[name] = resolve(f.root, `${name}.json`); await writeJson(config[name], report); }
  const accepted = await collectBrowserEvidence(config);
  assert.equal(accepted.coverage.length, 6);
  assert.equal(accepted.scope.additionalBrowsers.length, 2);
  const completeChecks = structuredClone(integration.checks);
  integration.checks = integration.checks.filter(check => check.profileId === 'game-2d-v1'); await writeJson(config.integration, integration);
  await assert.rejects(collectBrowserEvidence(config), /legacy regression/);
  integration.checks = completeChecks; await writeJson(config.integration, integration);
  const firefoxChecks = structuredClone(firefox.checks);
  firefox.checks = structuredClone(integration.checks); await writeJson(config['firefox-report'], firefox);
  await assert.rejects(collectBrowserEvidence(config), /matching profile, mode, browser version and source/);
  firefox.checks = firefoxChecks; await writeJson(config['firefox-report'], firefox);
  await assert.rejects(collectBrowserEvidence({ ...config, 'webkit-report': undefined }), /Missing webkit/);
  stress.scope.fixture = 'counter'; await writeJson(config.stress, stress);
  await assert.rejects(collectBrowserEvidence(config), /Lifecycle must exercise/);
  stress.scope.fixture = 'game2d'; stress.cycles[3].profileId = 'core-ui-v1'; await writeJson(config.stress, stress);
  await assert.rejects(collectBrowserEvidence(config), /artifact identity/);
  stress.cycles[3].profileId = 'game-2d-v1'; await writeJson(config.stress, stress);
  firefox.runtimeRelease = digest('stale additional report'); await writeJson(config['firefox-report'], firefox);
  await assert.rejects(collectBrowserEvidence(config), /exact runtimeRelease/);
  firefox.runtimeRelease = release.id; firefox.artifactHashes['assets/godot.js'] = digest('changed bytes'); await writeJson(config['firefox-report'], firefox);
  await assert.rejects(collectBrowserEvidence(config), /identical release and static/);
  firefox.artifactHashes = structuredClone(integration.artifactHashes); await writeJson(config['firefox-report'], firefox);
  const authenticated = structuredClone(integration);
  for (const name of ['http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', 'cross-origin-cdn-does-not-receive-site-cookie', 'game-2d-indexeddb-restores-and-automatically-runs', 'game-2d-shared-project-manually-runs']) {
    authenticated.checks.push({ name, status: 'passed', browserFamily: 'chromium', browserVersion: integration.browser });
  }
  config['authenticated-report'] = resolve(f.root, 'authenticated.json'); await writeJson(config['authenticated-report'], authenticated);
  assert.equal((await collectBrowserEvidence(config)).coverage.length, 8);
  const fullAuthenticated = structuredClone(authenticated);
  authenticated.coverage = []; authenticated.checks = authenticated.checks.filter(check => !check.profileId || check.profileId === 'core-ui-v1');
  await writeJson(config['authenticated-report'], authenticated);
  await assert.rejects(collectBrowserEvidence(config), /combination coverage/);
  for (const name of ['game-2d-indexeddb-restores-and-automatically-runs', 'game-2d-shared-project-manually-runs']) {
    const invalid = structuredClone(fullAuthenticated); invalid.checks = invalid.checks.filter(check => check.name !== name);
    await writeJson(config['authenticated-report'], invalid);
    await assert.rejects(collectBrowserEvidence(config), /Missing authenticated full-suite check/);
  }
});


test('release profile classification is explicit and refuses unknown or mismatched identities',async t=>{
 const f=await fixture(t);
 // Having default modules enabled does not turn a compatibility fixture native.
 f.report.recipe.args.push('modules_enabled_by_default=yes');f.report.recipeSha256=digest(canonical(f.report.recipe));
 await writeJson(resolve(f.root,'engine-report.json'),f.report);
 await buildRelease(f.configuration);assert.equal((await inspectRelease(f.dir)).runtimeProfile,'legacy-profiles-v1');
 await writeJson(resolve(f.root,'assets.json'),{...f.config,runtimeProfile:'not-an-official-profile'});
 await assert.rejects(buildRelease(f.configuration),/E_ENGINE_PROFILE/);
 await writeJson(resolve(f.root,'assets.json'),{...f.config,runtimeProfile:'engine-2d-v1'});
 await writeJson(resolve(f.root,'engine-report.json'),{...f.report,runtimeProfile:'full-engine-v1'});
 await assert.rejects(buildRelease(f.configuration),/E_RELEASE_PROFILE/);
});

test('sealed release rejects an attestation from a different profile',async t=>{
 const f=await fixture(t);await buildRelease(f.configuration);
 const descriptor=await json(resolve(f.dir,'release.json'));
 const attestation=await json(resolve(f.dir,descriptor.attestation));
 await writeJson(resolve(f.dir,descriptor.attestation),{...attestation,runtimeProfile:'engine-2d-v1'});
 const bytes=await readFile(resolve(f.dir,descriptor.attestation));
 Object.assign(descriptor.files.find(file=>file.path===descriptor.attestation),{sha256:digest(bytes),bytes:bytes.length});
 descriptor.id=descriptor.runtimeRelease=identity(descriptor);await writeJson(resolve(f.dir,'release.json'),descriptor);
 await assert.rejects(inspectRelease(f.dir),/E_RELEASE_PROFILE/);
});
