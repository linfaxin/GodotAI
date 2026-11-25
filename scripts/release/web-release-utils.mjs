import {GAME_PROBE_PATCH,GAME_PROBE_PATHS} from './patch-web-game-probe.mjs';
import {INPUT_SCRIPT_PATCH,INPUT_SCRIPT_PATHS,INPUT_SCRIPT_EXPORTS,INPUT_SCRIPT_WASM_MARKER} from './patch-web-input-script.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, dirname, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertGame2dCertification } from './game-2d-evidence.mjs';
import {isEngineProfile,getEngineProfile,validateEngineProfile} from './engine-profiles.mjs';
import {executionFromReport,assertExecutionAssets,legacyExecution} from './execution-contract.mjs';
import {assertExecutionCertification} from './execution-evidence.mjs';
import {assertFullEngineIdentities} from './release-identities.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
export const OBSERVATION_READER_SOURCE = 'bridge/jsb_runtime_observation.cpp';
export const OBSERVATION_SOURCE_PATHS = [
  OBSERVATION_READER_SOURCE,
  'bridge/jsb_runtime_observation.h',
  'SCsub',
];
export const OBSERVATION_EXPORTS = [
  '_godotjs_runtime_observation_abi',
  '_godotjs_runtime_observation_buffer',
  '_godotjs_runtime_observation_sample',
];
export const RUNTIME_WRITE_EXPORTS = [
  '_godotjs_runtime_write_abi',
  '_godotjs_runtime_write_execute',
];


export const RUNTIME_PROPERTIES_EXPORTS = [
  '_godotjs_runtime_properties_abi',
  '_godotjs_runtime_properties_execute',
];
export const RUNTIME_PROPERTIES_SOURCE_PATHS = Object.freeze([
  'SCsub',
  'bridge/jsb_runtime_observation.cpp', 'bridge/jsb_runtime_observation.h',
  'bridge/jsb_runtime_access_common.cpp', 'bridge/jsb_runtime_access_common.h',
  'bridge/jsb_runtime_properties.cpp', 'bridge/jsb_runtime_properties.h',
  'bridge/jsb_runtime_scalar.cpp', 'bridge/jsb_runtime_script_properties.h',
  'bridge/jsb_environment.cpp', 'bridge/jsb_environment.h',
  'bridge/jsb_class_info.cpp', 'bridge/jsb_class_info.h',
  'bridge/jsb_object_handle.h',
  'bridge/jsb_native_world.cpp', 'bridge/jsb_native_world.h',
  'bridge/jsb_type_convert.cpp', 'bridge/jsb_type_convert.h',
  'bridge/jsb_bridge_module_loader.cpp', 'bridge/jsb_bridge_module_loader.h',
  'weaver/jsb_script.cpp', 'weaver/jsb_script.h',
  'weaver/jsb_script_instance.cpp', 'weaver/jsb_script_instance.h',
  'impl/web/jsb_web_interop.h', 'impl/web/js/library_godotjs_jsbi.js',
  'impl/web/bridge/src/monolith.ts', 'impl/web/js/jsbb.impl.js',
  'scripts/jsb.runtime/src/godot.annotations.ts',
  'scripts/out/jsb.runtime.bundle.js',
  'scripts/release/patch-runtime-properties-quit.mjs',
]);
export function assertRuntimePropertiesBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeProperties;
  if (report.runtimeAbi?.runtimeProperties === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  const quitPath = 'scene/main/scene_tree.h';
  const quit = report.recipe?.patches?.findLast(item => item.path === quitPath && item.patchId === 'godotjs-runtime-properties-quit-v1');
  const latest = report.recipe?.patches?.findLast(item => item.path === quitPath);
  if (report.runtimeAbi?.runtimeProperties !== 1 || report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      report.status !== 'built' || !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      report.resolvedBuildOptions?.threads !== false || report.resolvedBuildOptions?.dlink_enabled !== false ||
      digest(canonical(report.recipe)) !== report.recipeSha256 ||
      proof?.abi !== 1 || !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !Array.isArray(proof.exports) || canonical(proof.exports) !== canonical(RUNTIME_PROPERTIES_EXPORTS) ||
      !report.source?.inputs || digest(canonical(report.source.inputs)) !== report.source.snapshotHash ||
      Object.keys(proof.sources ?? {}).length !== RUNTIME_PROPERTIES_SOURCE_PATHS.length ||
      !RUNTIME_PROPERTIES_SOURCE_PATHS.every(path => hash.test(proof.sources[path]) && proof.sources[path] === report.source.inputs[path]) ||
      !quit || !latest || !hash.test(quit.afterSha256) ||
      quit.implementation?.path !== 'scripts/release/patch-runtime-properties-quit.mjs' ||
      quit.implementation?.sha256 !== report.source.inputs[quit.implementation.path] ||
      latest.afterSha256 !== report.godotSource?.inputs?.[quitPath] ||
      digest(canonical(report.godotSource?.inputs)) !== report.godotSource?.snapshotHash) {
    throw Error('E_RUNTIME_PROPERTIES_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, wasmSha256);
  assertSourcePatchChains(report);
}

export function assertRuntimeCallAssets(runtimeAbi, proof, {wasmSha256, javascriptSha256}) {
  if (runtimeAbi?.runtimeCall === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  if (runtimeAbi?.runtimeCall !== 1 || proof?.abi !== 1 ||
      !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !hash.test(proof.javascriptSha256) || proof.javascriptSha256 !== javascriptSha256) {
    throw Error('E_RUNTIME_CALL_BUILD_PROOF');
  }
}

export function assertRuntimeCallBuildProof(report, assets = {
  wasmSha256: report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256,
  javascriptSha256: report.template?.assets?.find(asset => asset.path === 'godot.js')?.sha256,
}) {
  assertRuntimeCallAssets(report.runtimeAbi, report.runtimeCall, assets);
  if (report.runtimeAbi?.runtimeCall === undefined) return;
  if (report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      report.status !== 'built' || !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      report.resolvedBuildOptions?.threads !== false || report.resolvedBuildOptions?.dlink_enabled !== false) {
    throw Error('E_RUNTIME_CALL_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, assets.wasmSha256);
}

export const GAME_PROBE_EXPORTS = Object.freeze([
  '_godotjs_game_probe_abi', '_godotjs_game_probe_stage', '_godotjs_game_probe_take', '_godotjs_game_probe_clear',
]);
export function assertGameProbeAssets(runtimeAbi, proof, {wasmSha256, javascriptSha256}) {
  if (runtimeAbi?.gameProbe === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  if (runtimeAbi?.gameProbe !== 1 || proof?.abi !== 1 || canonical(proof.exports) !== canonical(GAME_PROBE_EXPORTS) ||
      !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !hash.test(proof.javascriptSha256) || proof.javascriptSha256 !== javascriptSha256)
    throw Error('E_GAME_PROBE_BUILD_PROOF');
}

export function assertGameProbeBuildProof(report, assets = {
  wasmSha256: report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256,
  javascriptSha256: report.template?.assets?.find(asset => asset.path === 'godot.js')?.sha256,
}) {
  assertGameProbeAssets(report.runtimeAbi, report.gameProbe, assets);
  if (report.runtimeAbi?.gameProbe === undefined) return;
  const implementation = 'scripts/release/patch-web-game-probe.mjs';
  const edges = report.recipe?.patches?.filter(patch => patch.patchId === GAME_PROBE_PATCH) ?? [];
  const inputs = report.source?.inputs;
  const latest = assertSourcePatchChains(report);
  if (report.runtimeAbi.observation !== 1 || report.status !== 'built' || !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      report.resolvedBuildOptions?.threads !== false || report.resolvedBuildOptions?.dlink_enabled !== false ||
      !inputs?.['bridge/jsb_runtime_game_probe.h'] || !inputs?.[implementation] ||
      edges.length !== GAME_PROBE_PATHS.length || !GAME_PROBE_PATHS.every(path => edges.some(edge => edge.path === path &&
        edge.implementation?.path === implementation && edge.implementation.sha256 === inputs[implementation] &&
        latest.get(path)?.patchId === GAME_PROBE_PATCH))) throw Error('E_GAME_PROBE_BUILD_PROOF');
  assertRuntimeObservationBuildProof(report, assets.wasmSha256);
}

export function assertInputScriptAssets(runtimeAbi, proof, {wasmSha256, javascriptSha256}) {
  if (runtimeAbi?.inputScript === undefined && proof === undefined) return;
  const hash = /^[a-f0-9]{64}$/;
  if (runtimeAbi?.inputScript !== 1 || proof?.abi !== 1 || canonical(proof.exports) !== canonical(INPUT_SCRIPT_EXPORTS) ||
      !hash.test(proof.wasmSha256) || proof.wasmSha256 !== wasmSha256 ||
      !hash.test(proof.javascriptSha256) || proof.javascriptSha256 !== javascriptSha256)
    throw Error('E_INPUT_SCRIPT_BUILD_PROOF');
}

export function assertInputScriptRuntimeCapture(capture, engine, naming) {
  if (capture?.kind !== 'godotjs-production-engine-api-capture' || capture.status !== 'captured' ||
      capture.naming !== naming || typeof capture.browser !== 'string' || !capture.browser || capture.inputScript?.abi !== 1 ||
      capture.engineJsSha256 !== engine.javascript.sha256 ||
      capture.engineWasmSha256 !== (engine.wasm.decodedSha256 ?? engine.wasm.sha256))
    fail('E_INPUT_SCRIPT_RUNTIME_CAPTURE', `Missing browser ABI capture for the exact ${naming} engine JS/WASM`);
}

export async function assertInputScriptReleaseCaptures(root, release, engine = release.engine) {
  for (const naming of ['snake', 'camel']) {
    const asset = release.api?.namingProfiles?.[naming]?.capture;
    const sealed = asset && release.payloads?.[asset.path];
    if (!sealed || sealed.sha256 !== asset.sha256 || sealed.bytes !== asset.bytes)
      fail('E_INPUT_SCRIPT_RUNTIME_CAPTURE', `Missing sealed ${naming} capture`);
    const bytes = await readFile(within(root, asset.path));
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
      fail('E_INPUT_SCRIPT_RUNTIME_CAPTURE', `${naming} capture bytes differ from the release`);
    assertInputScriptRuntimeCapture(JSON.parse(bytes.toString('utf8')), engine, naming);
  }
}

// The engine targets core Wasm function types. Read the type, function and export
// sections of the already validated module without instantiating the engine.
function readWasmFunctionExports(wasm, module) {
  const types = [], definitions = [], exports = new Map();
  const importedFunctions = WebAssembly.Module.imports(module).filter(entry => entry.kind === 'function').length;
  let offset = 8;
  function readU32() {
    let value = 0, shift = 0, byte;
    do {
      byte = wasm[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value >>> 0;
  }
  function readValueTypes() {
    return Array.from({length: readU32()}, () => {
      const type = wasm[offset++];
      // A typed reference also encodes a heap type as a LEB128 immediate.
      if (type === 0x63 || type === 0x64) readU32();
      return type;
    });
  }
  while (offset < wasm.length) {
    const section = wasm[offset++], size = readU32(), end = offset + size;
    if (section === 1) {
      const count = readU32();
      for (let i = 0; i < count; i++) {
        if (wasm[offset++] !== 0x60) fail('E_INPUT_SCRIPT_EXPORT', 'Unsupported WebAssembly type declaration');
        types.push({parameters: readValueTypes(), results: readValueTypes()});
      }
    } else if (section === 3) {
      const count = readU32();
      for (let i = 0; i < count; i++) definitions.push(readU32());
    } else if (section === 7) {
      const count = readU32();
      for (let i = 0; i < count; i++) {
        const length = readU32();
        const name = Buffer.from(wasm.subarray(offset, offset + length)).toString('utf8');
        offset += length;
        const kind = wasm[offset++], index = readU32();
        if (kind === 0 && index >= importedFunctions)
          exports.set(name, {index, type: types[definitions[index - importedFunctions]]});
      }
      break;
    }
    offset = end;
  }
  return exports;
}

const INPUT_SCRIPT_SIGNATURES = new Map([
  ['_godotjs_input_script_abi', [0, 1]], ['_godotjs_input_script_buffer', [0, 1]],
  ['_godotjs_input_script_stage', [3, 1]], ['_godotjs_input_script_cancel', [2, 0]],
  ['_godotjs_input_script_take', [1, 1]],
]);

function readInputScriptBindings(glue) {
  const ts = createRequire(new URL('../../apps/playground/package.json', import.meta.url))('typescript');
  const source = ts.createSourceFile('godot.js', glue, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length)
    fail('E_INPUT_SCRIPT_EXPORT', 'Invalid JavaScript glue: ' + ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' '));

  const identifier = (node, name) => node && ts.isIdentifier(node) && node.text === name;
  const assignment = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  function property(node, object) {
    if (ts.isPropertyAccessExpression(node) && identifier(node.expression, object)) return node.name.text;
    if (ts.isElementAccessExpression(node) && identifier(node.expression, object) && ts.isStringLiteral(node.argumentExpression))
      return node.argumentExpression.text;
  }
  const call = (node, name, count) => node && ts.isCallExpression(node) &&
    identifier(node.expression, name) && node.arguments.length === count;
  function beforeExit(block) {
    const statements = block?.statements ?? [];
    const exit = statements.findIndex(statement => ts.isReturnStatement(statement) || ts.isThrowStatement(statement));
    return exit === -1 ? statements : statements.slice(0, exit);
  }
  function functionBody(block, name) {
    const declarations = (block?.statements ?? []).filter(statement =>
      ts.isFunctionDeclaration(statement) && identifier(statement.name, name));
    if (declarations.length > 1) fail('E_INPUT_SCRIPT_EXPORT', 'Multiple Emscripten functions named ' + name);
    return declarations[0]?.body;
  }
  function initializer(statements, name) {
    return statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
      .find(declaration => identifier(declaration.name, name))?.initializer;
  }
  function returnedValue(block) {
    const statements = beforeExit(block);
    const exit = block?.statements?.[statements.length];
    if (!exit || !ts.isReturnStatement(exit)) return;
    const value = exit.expression;
    return value && ts.isIdentifier(value) ? initializer(statements, value.text) : value;
  }

  // Follow the emitted Godot factory's synchronous binding path after Wasm
  // instantiation. Keep verification offline and never evaluate the glue.
  const godot = initializer(source.statements, 'Godot');
  const factory = godot && ts.isCallExpression(godot)
    ? returnedValue(ts.skipParentheses(godot.expression).body) : godot;
  const factoryStatements = beforeExit(factory?.body);
  const argument = factory?.parameters?.[0]?.name;
  const start = initializer(factoryStatements, 'wasmExports');
  const createWasm = functionBody(factory?.body, 'createWasm');
  const instantiateResult = returnedValue(createWasm);
  const receiveResult = returnedValue(functionBody(createWasm, 'receiveInstantiationResult'));
  const receiveInstance = beforeExit(functionBody(createWasm, 'receiveInstance'));
  const bindingScope = functionBody(factory?.body, 'assignWasmExports');
  const bindsExports = receiveInstance.findIndex(statement => ts.isExpressionStatement(statement) &&
    call(statement.expression, 'assignWasmExports', 1) && identifier(statement.expression.arguments[0], 'wasmExports'));
  if (!argument || !ts.isIdentifier(argument) || !identifier(initializer(factoryStatements, 'Module'), argument.text) ||
      !start || !ts.isAwaitExpression(start) || !call(start.expression, 'createWasm', 0) ||
      !call(instantiateResult, 'receiveInstantiationResult', 1) || !call(receiveResult, 'receiveInstance', 1) ||
      property(receiveResult.arguments[0], 'result') !== 'instance' ||
      !bindingScope || bindsExports < 0 || !receiveInstance.slice(0, bindsExports).some(statement =>
        ts.isExpressionStatement(statement) && assignment(statement.expression) && identifier(statement.expression.left, 'wasmExports') &&
        property(statement.expression.right, 'instance') === 'exports'))
    fail('E_INPUT_SCRIPT_EXPORT', 'Missing Emscripten input script initialization path');

  const directBindings = new Set();
  for (const statement of bindingScope.statements) {
    if (ts.isEmptyStatement(statement)) continue;
    if (!ts.isExpressionStatement(statement) || !assignment(statement.expression)) break;
    directBindings.add(statement);
  }
  const initializationStatements = new Set(factoryStatements);
  const hasEarlyAccessHelper = Boolean(functionBody(factory?.body, 'makeInvalidEarlyAccess'));
  const hasExportWrapper = Boolean(functionBody(factory?.body, 'createExportWrapper'));
  const bindings = new Map();
  const writes = new Set();
  const placeholders = new Set();
  function visit(node) {
    const symbol = assignment(node) && property(node.left, 'Module');
    if (INPUT_SCRIPT_SIGNATURES.has(symbol)) {
      const parent = node.parent, value = node.right;
      // Assertion builds expose a trapping placeholder before startup, then
      // replace it through the same native binding path as ordinary builds.
      if (hasEarlyAccessHelper && ts.isVariableDeclaration(parent) && parent.initializer === node &&
          identifier(parent.name, symbol) && node.pos < start.pos && initializationStatements.has(parent.parent.parent) &&
          call(value, 'makeInvalidEarlyAccess', 1) && ts.isStringLiteral(value.arguments[0]) && value.arguments[0].text === symbol) {
        if (placeholders.has(symbol)) fail('E_INPUT_SCRIPT_EXPORT', 'Multiple JavaScript placeholders for ' + symbol);
        placeholders.add(symbol);
      } else {
        if (writes.has(symbol)) fail('E_INPUT_SCRIPT_EXPORT', 'Multiple JavaScript assignments for ' + symbol);
        writes.add(symbol);
        if (directBindings.has(parent) && ts.isExpressionStatement(parent) && parent.expression === node &&
            assignment(value) && identifier(value.left, symbol)) {
          const target = value.right;
          let name = property(target, 'wasmExports');
          if (hasExportWrapper && call(target, 'createExportWrapper', 2) && ts.isStringLiteral(target.arguments[0])) {
            const count = target.arguments[1];
            if (!ts.isNumericLiteral(count) || Number(count.text) !== INPUT_SCRIPT_SIGNATURES.get(symbol)[0])
              fail('E_INPUT_SCRIPT_EXPORT', 'Incorrect JavaScript wrapper arity for ' + symbol);
            name = target.arguments[0].text;
          }
          if (name !== undefined) bindings.set(symbol, name);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return bindings;
}

export function assertInputScriptRuntimeExports(javascript, wasm) {
  const glue = javascript.toString('utf8');
  const marks = glue.split('\n').filter(line => line.startsWith(INPUT_SCRIPT_WASM_MARKER));
  if (marks.length !== 1 || marks[0].trimEnd() !== INPUT_SCRIPT_WASM_MARKER + digest(wasm))
    fail('E_INPUT_SCRIPT_WASM_PAIR', 'JavaScript must record the digest of its linked WebAssembly');
  // Emscripten maps the public Module properties to possibly minified Wasm names.
  const bindings = readInputScriptBindings(glue);
  for (const symbol of INPUT_SCRIPT_EXPORTS)
    if (!bindings.has(symbol)) fail('E_INPUT_SCRIPT_EXPORT', 'Missing JavaScript binding for ' + symbol);
  let module;
  try { module = new WebAssembly.Module(wasm); }
  catch (error) { fail('E_INPUT_SCRIPT_EXPORT', 'Invalid WebAssembly module: ' + error.message); }
  const functions = readWasmFunctionExports(wasm, module);
  const bound = new Set();
  for (const [symbol, name] of bindings) {
    const fn = functions.get(name);
    if (!fn) fail('E_INPUT_SCRIPT_EXPORT', 'Missing WebAssembly function for ' + symbol);
    if (bound.has(fn.index)) fail('E_INPUT_SCRIPT_EXPORT', 'Duplicate WebAssembly function for ' + symbol);
    bound.add(fn.index);
    const [inputs, outputs] = INPUT_SCRIPT_SIGNATURES.get(symbol);
    const {parameters, results} = fn.type;
    if (parameters.length !== inputs || results.length !== outputs ||
        parameters.some(type => type !== 0x7f) || results.some(type => type !== 0x7f))
      fail('E_INPUT_SCRIPT_EXPORT', 'Incorrect WebAssembly function signature for ' + symbol);
  }
}

export function assertInputScriptBuildProof(report, assets = {
  wasmSha256: report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256,
  javascriptSha256: report.template?.assets?.find(asset => asset.path === 'godot.js')?.sha256,
}, {developmentRelease = false} = {}) {
  assertInputScriptAssets(report.runtimeAbi, report.inputScript, assets);
  // A development package can retain the compiled patch history with the optional ABI disabled.
  if (developmentRelease && report.runtimeAbi?.inputScript !== undefined) throw Error('E_INPUT_SCRIPT_BUILD_PROOF');
  const patches = report.recipe?.patches ?? [];
  const edges = patches.filter(patch => patch.patchId === INPUT_SCRIPT_PATCH);
  if (report.runtimeAbi?.inputScript === undefined && !edges.length) return;
  assertSourcePatchChains(report);
  if (developmentRelease && report.sourceCertified === false) return;
  const implementation = 'scripts/release/patch-web-input-script.mjs';
  const inputs = report.source?.inputs ?? {};
  const hash = /^[a-f0-9]{64}$/;
  if (report.runtimeAbi?.inputScript !== 1 || report.runtimeAbi.gameProbe !== 1 || report.status !== 'built' ||
      !report.sourceCertified || !runtimeWriteBuildTarget(report) || report.resolvedBuildOptions?.threads !== false ||
      report.resolvedBuildOptions?.dlink_enabled !== false || digest(canonical(report.recipe)) !== report.recipeSha256 ||
      digest(canonical(report.godotSource?.inputs)) !== report.godotSource?.snapshotHash ||
      !hash.test(inputs['bridge/jsb_runtime_input_script.h']) || !hash.test(inputs['bridge/jsb_runtime_input_script.cpp']) ||
      !hash.test(inputs[implementation]) || edges.length !== INPUT_SCRIPT_PATHS.length ||
      !INPUT_SCRIPT_PATHS.every(path => {
        const index = patches.findIndex(edge => edge.patchId === INPUT_SCRIPT_PATCH && edge.path === path &&
          edge.implementation?.path === implementation && edge.implementation.sha256 === inputs[implementation]);
        if (index < 0) return false;
        const successors = patches.slice(index + 1).filter(edge => edge.path === path);
        return GAME_PROBE_PATHS.includes(path) ? successors.length === 1 && successors[0].patchId === GAME_PROBE_PATCH :
          successors.length === 0;
      })) throw Error('E_INPUT_SCRIPT_BUILD_PROOF');
  assertGameProbeBuildProof(report, assets);
}

export function assertRuntimeObservationBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeObservation;
  if (report.runtimeAbi?.observation === undefined && proof === undefined) return;
  if (report.runtimeAbi?.observation !== 1 || report.runtimeAbi?.lifecycle !== 1 ||
      !validRuntimeBridgeProof(report, proof, OBSERVATION_EXPORTS, wasmSha256)) {
    throw Error('E_RUNTIME_OBSERVATION_BUILD_PROOF');
  }
}

export function runtimeWriteBuildTarget(report) {
  const args = report.recipe?.args;
  const targets = Array.isArray(args) && args.filter(arg => typeof arg === 'string' && arg.startsWith('target='));
  return report.runtimeProfile === 'full-engine-v1' && report.engineTarget === 'template_debug' &&
    targets && targets.length === 1 && targets[0] === 'target=template_debug' &&
    report.resolvedBuildOptions?.target === 'template_debug' &&
    report.execution?.executionModel === 'window' && report.execution.wasmThreads === false;
}

export function assertRuntimeWriteBuildProof(report, wasmSha256 = report.template?.assets?.find(asset => asset.path === 'godot.wasm')?.sha256) {
  const proof = report.runtimeWrite;
  if (report.runtimeAbi?.runtimeWrite === undefined && proof === undefined) return;
  if (report.runtimeAbi?.runtimeWrite !== 1 || report.runtimeAbi.observation !== 1 || report.runtimeAbi.lifecycle !== 1 ||
      !report.sourceCertified || !runtimeWriteBuildTarget(report) ||
      !validRuntimeBridgeProof(report, proof, RUNTIME_WRITE_EXPORTS, wasmSha256)) {
    throw Error('E_RUNTIME_WRITE_BUILD_PROOF');
  }
  assertRuntimeObservationBuildProof(report, wasmSha256);
}

function validRuntimeBridgeProof(report, proof, exports, wasmSha256) {
  const hash = /^[a-f0-9]{64}$/;
  return proof?.abi === 1 && hash.test(proof.wasmSha256) && proof.wasmSha256 === wasmSha256 &&
    Array.isArray(proof.exports) && canonical(proof.exports) === canonical(exports) &&
    report.source?.inputs && digest(canonical(report.source.inputs)) === report.source.snapshotHash &&
    Object.keys(proof.sources ?? {}).length === OBSERVATION_SOURCE_PATHS.length &&
    OBSERVATION_SOURCE_PATHS.every(path => hash.test(proof.sources[path]) && proof.sources[path] === report.source.inputs[path]);
}

/** Ordered checked patches may compose on one source file. Only the last
 * output is in the compiled snapshot; every intermediate edge must connect. */
export function assertSourcePatchChains(report) {
  const latest = new Map();
  for (const patch of report.recipe?.patches ?? []) {
    assertHash(patch.beforeSha256, 'source patch input'); assertHash(patch.afterSha256, 'source patch output');
    if (latest.has(patch.path) && latest.get(patch.path).afterSha256 !== patch.beforeSha256) fail('E_RELEASE_RECIPE', `Broken source patch chain: ${patch.path}`);
    latest.set(patch.path, patch);
  }
  for (const [path, patch] of latest) if (report.godotSource?.inputs?.[path] !== patch.afterSha256) fail('E_RELEASE_RECIPE', `Source patch is not in the attested snapshot: ${patch.patchId}`);
  return latest;
}
export function options(args, booleans = []) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name.startsWith('--')) fail('E_OPTION', `Unexpected argument ${name}`);
    if (booleans.includes(name)) { result[name.slice(2)] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('E_OPTION', `Missing value for ${name}`);
    if (result[name.slice(2)] !== undefined) fail('E_OPTION', `Duplicate ${name}`);
    result[name.slice(2)] = value;
  }
  return result;
}
export function required(value, name) { if (!value) fail('E_OPTION', `Missing ${name}`); return value; }
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(value)) fail('E_RELEASE_PATH', `Unsafe release path ${JSON.stringify(value)}`);
  return value;
}
export function within(root, path) {
  const result = resolve(root, safePath(path));
  if (!result.startsWith(`${resolve(root)}${sep}`)) fail('E_RELEASE_PATH', 'Path escaped release root');
  return result;
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
export async function filesIn(directory) {
  const result = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink()) fail('E_RELEASE_SYMLINK', `Release asset may not be a symlink: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  if (!(await lstat(directory)).isDirectory()) fail('E_RELEASE_DIRECTORY', `Expected directory ${directory}`);
  await walk(directory);
  return result;
}
export function relativePath(root, path) { return safePath(relative(root, path).split(sep).join('/')); }
export async function hashSiteRuntimeFiles(directory) {
  const hashes = {};
  for (const path of await filesIn(directory)) {
    const key = relativePath(directory, path);
    if (key.startsWith('release/') || ['app-config.json', 'release-assets.json'].includes(key)) continue;
    hashes[key] = digest(await readFile(path));
  }
  return hashes;
}
export function identity(descriptor) {
  // Certification can be attached after validating this exact candidate. It does
  // not change the identity of the bytes tested by a browser.
  const { id, runtimeRelease, certified, certification, ...content } = descriptor;
  return digest(canonical(content));
}
export function assertHash(value, label) { if (!/^(?!0{64}$)[a-f0-9]{64}$/.test(value ?? '')) fail('E_RELEASE_HASH', `Invalid ${label}`); }
export function assertCommit(value, label) { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '')) fail('E_RELEASE_SOURCE', `Invalid ${label}`); }

export async function verifyCDN({ baseUrl, descriptor, fetcher = fetch }) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const nonce = Date.now().toString(36);
  for (const file of [{ path: 'release.json' }, ...descriptor.files]) {
    const assetUrl = new URL(file.path.split('/').map(encodeURIComponent).join('/'), url);
    assetUrl.searchParams.set('godot_release_verify', nonce);
    const response = await fetcher(assetUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) fail('E_RELEASE_CDN', `CDN returned ${response.status} for ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (file.path === 'release.json') {
      if (canonical(JSON.parse(bytes.toString('utf8'))) !== canonical(descriptor)) fail('E_RELEASE_CDN', 'CDN release descriptor differs');
    } else if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes) fail('E_RELEASE_CDN', `CDN bytes differ: ${file.path}`);
  }
  return true;
}

export async function inspectRelease(directory, { requireCertified = false } = {}) {
  const root = resolve(directory), descriptor = await json(resolve(root, 'release.json'));
  if (descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.files)) fail('E_RELEASE_SCHEMA', 'Expected release schemaVersion 1 and files array');
  if (descriptor.id !== identity(descriptor) || descriptor.runtimeRelease !== descriptor.id) fail('E_RELEASE_IDENTITY', 'runtimeRelease does not match immutable descriptor content');
  if (requireCertified && descriptor.certified !== true) fail('E_RELEASE_UNCERTIFIED', 'Official publication requires source and browser validation certification');
  const paths = new Set();
  const wasm = descriptor.files.find(file => file.kind === 'engine-wasm');
  const javascript = descriptor.files.find(file => file.kind === 'engine-js');
  let wasmBytes, javascriptBytes;
  for (const file of descriptor.files) {
    safePath(file.path);
    if (paths.has(file.path)) fail('E_RELEASE_DUPLICATE', `Duplicate ${file.path}`);
    paths.add(file.path); assertHash(file.sha256, file.path);
    const bytes = await readFile(within(root, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('E_RELEASE_INTEGRITY', `Bytes changed: ${file.path}`);
    if (file === javascript) javascriptBytes = bytes;
    if (file.kind === 'engine-wasm') {
      let decoded = bytes;
      if (file.encoding) {
        if (file.encoding !== 'gzip' || !Number.isSafeInteger(file.decodedBytes) || file.decodedBytes < 8 || file.decodedBytes > 128 * 1024 * 1024) fail('E_RELEASE_ENCODING', 'Unsupported or oversized encoded engine');
        assertHash(file.decodedSha256, 'decoded WASM');
        try { decoded = gunzipSync(bytes, { maxOutputLength: file.decodedBytes }); }
        catch { fail('E_RELEASE_ENCODING', 'Engine gzip is invalid or exceeds its decoded size'); }
        if (decoded.length !== file.decodedBytes || digest(decoded) !== file.decodedSha256) fail('E_RELEASE_INTEGRITY', 'Decoded WASM bytes differ');
      }
      if (!decoded.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('E_RELEASE_ENGINE', 'Invalid decoded WebAssembly module');
      if (file === wasm) wasmBytes = decoded;
    }
  }
  for (const path of await filesIn(root)) {
    const key = relativePath(root, path);
    if (key !== 'release.json' && !paths.has(key)) fail('E_RELEASE_UNSEALED', `Unsealed file ${key}`);
  }
  const attestation = await json(within(root, descriptor.attestation));
  if(attestation.runtimeProfile!==undefined&&attestation.runtimeProfile!==descriptor.runtimeProfile)fail('E_RELEASE_PROFILE','Attestation profile differs from release');
  if (attestation.schemaVersion !== 1 || attestation.kind !== 'godot-js-web-release-attestation') fail('E_RELEASE_ATTESTATION', 'Unsupported release attestation');
  if (digest(canonical(attestation.recipe)) !== attestation.recipeSha256) fail('E_RELEASE_RECIPE', 'Attestation recipe was changed');
  assertSourcePatchChains(attestation);
  const wasmSha256 = wasm?.decodedSha256 ?? wasm?.sha256;
  assertRuntimeObservationBuildProof(attestation, wasmSha256);
  assertRuntimeWriteBuildProof(attestation, wasmSha256);
  assertRuntimePropertiesBuildProof(attestation, wasmSha256);
  assertRuntimeCallBuildProof(attestation, {
    wasmSha256,
    javascriptSha256: javascript?.sha256,
  });
  assertGameProbeBuildProof(attestation, {
    wasmSha256,
    javascriptSha256: javascript?.sha256,
  });
  assertInputScriptBuildProof(attestation, {
    wasmSha256,
    javascriptSha256: javascript?.sha256,
  }, {developmentRelease: descriptor.sourceCertified === false});
  if (attestation.runtimeAbi?.inputScript === 1) assertInputScriptRuntimeExports(javascriptBytes, wasmBytes);
  if (descriptor.sourceCertified) {
    if (attestation.status !== 'built') fail('E_RELEASE_SOURCE', 'Source certification requires an actual successful build');
    assertCommit(attestation.source?.commit, 'GodotJS commit'); assertHash(attestation.source?.snapshotHash, 'GodotJS snapshot');
    assertCommit(attestation.godotSource?.commit, 'Godot commit'); assertHash(attestation.godotSource?.snapshotHash, 'Godot snapshot');
    for (const source of [attestation.source, attestation.godotSource]) if (digest(canonical(source.inputs)) !== source.snapshotHash) fail('E_RELEASE_SOURCE', 'Source snapshot map does not match its hash');
    if (descriptor.target?.sourceCommit !== attestation.source.commit || descriptor.target?.sourceDiffHash !== attestation.source.snapshotHash || descriptor.target?.buildFlags?.godot_build_recipe_sha256 !== attestation.recipeSha256) fail('E_RELEASE_SOURCE', 'Runtime target does not match the actual engine source tuple');
    const actualExecution=executionFromReport(attestation);
    const declaredExecution=descriptor.execution??legacyExecution();
    for(const key of ['executionModel','wasmThreads','proxyToPthread','requiresCrossOriginIsolation','hostProtocolVersion','lifecycleAbi','artifactSetAbi','hostResourceAbi','shutdownQueueAbi'])if(actualExecution[key]!==declaredExecution[key])fail('E_RELEASE_EXECUTION','Execution differs from the source-bound recipe: '+key);
  }
  const releaseExecution=descriptor.execution??legacyExecution();
  assertExecutionAssets(releaseExecution,descriptor.files);
  if(descriptor.engine?.host){const host=descriptor.engine.host,file=descriptor.files.find(item=>item.path===host.path);if(!file||file.sha256!==host.sha256||file.bytes!==host.bytes||!Number.isSafeInteger(host.bytes)||host.bytes<=0)fail('E_RELEASE_HOST','Browser host is outside the sealed release');}
  if(descriptor.engine?.threads!==releaseExecution.wasmThreads)fail('E_RELEASE_EXECUTION','Engine thread metadata differs from execution contract');
  if(descriptor.runtimeProfile!==undefined&&descriptor.runtimeProfile!=='legacy-profiles-v1')getEngineProfile(descriptor.runtimeProfile);
  if(isEngineProfile(descriptor.runtimeProfile)){
    if(descriptor.legacy!==false||!descriptor.engineRelease)fail('E_RELEASE_PROFILE','Native release cannot enter the legacy path');
    const native=await json(within(root,descriptor.engineRelease));
    if(attestation.runtimeAbi?.inputScript===1)await assertInputScriptReleaseCaptures(root,native,{javascript,wasm});
    if(releaseExecution.executionModel!=='window'&&!native.engine?.host)fail('E_RELEASE_HOST','Worker native descriptor has no bound host bundle');
    if(native.engine?.host){
      const host=native.engine.host,file=descriptor.files.find(item=>item.path===host.path),sealed=native.payloads?.[host.path];
      if(!file||!sealed||file.sha256!==host.sha256||file.bytes!==host.bytes||sealed.sha256!==host.sha256||sealed.bytes!==host.bytes)fail('E_RELEASE_HOST','Browser host is outside the exact release closure');
    }
    if(native.engineId!==undefined||native.extensionId!==undefined){
      const target=assertFullEngineIdentities(native);
      if((descriptor.engineId!==undefined&&descriptor.engineId!==target.engineId)||(descriptor.extensionId!==undefined&&descriptor.extensionId!==target.extensionId))fail('E_RELEASE_IDENTITY','Native engine/extension identities differ from release');
    }
    if(native.sdk?.typesHash){
      const types=await json(within(root,native.api.typeSnapshot.path));
      for(const name of Object.keys(native.api.declarations))delete types[name];
      if(digest(canonical(types))!==native.sdk.typesHash)fail('E_RELEASE_IDENTITY','Extension declarations differ from their sealed type identity');
    }
    const nativeIdentity=structuredClone(native);delete nativeIdentity.id;delete nativeIdentity.verifiedRelease?.releaseId;
    if(native.schemaVersion!==2||native.runtimeProfile!==descriptor.runtimeProfile||native.profile!==descriptor.runtimeProfile||native.verifiedRelease?.profile!==descriptor.runtimeProfile||native.id!==digest(canonical(nativeIdentity))||native.id!==descriptor.engineReleaseId||native.verifiedRelease?.releaseId!==native.id)fail('E_RELEASE_PROFILE','Native descriptor identity/profile mismatch');
    const ir=await json(within(root,native.api.ir.path));
    if(attestation.modules&&canonical([...attestation.modules].sort())!==canonical([...ir.modules].sort()))fail('E_RELEASE_MODULES','Attested modules differ from native API');
    try{validateEngineProfile(descriptor.runtimeProfile,{modules:ir.modules,classes:ir.classes,features:attestation.resolvedFeatures||attestation.resolvedBuildOptions?{...attestation.resolvedBuildOptions,...attestation.resolvedFeatures}:undefined});}catch(error){fail('E_RELEASE_PROFILE',error.message);}
    if(canonical([...ir.modules].sort())!==canonical([...(native.modules??[])].sort())||canonical([...ir.modules].sort())!==canonical([...(descriptor.engine.modules??[])].sort()))fail('E_RELEASE_MODULES','Native module evidence does not match the actual API');
    if(descriptor.runtimeProfile==='engine-2d-v1'&&!attestation.resolvedFeatures&&!attestation.resolvedBuildOptions&&descriptor.sourceCertified)fail('E_RELEASE_PROFILE','Certified 2D requires resolved feature evidence');
  }
  if (descriptor.certified) {
    if (!descriptor.sourceCertified || descriptor.certification?.status !== 'passed' || descriptor.certification.runtimeRelease !== descriptor.id) fail('E_RELEASE_CERTIFICATION', 'Missing source or exact-release browser certification');
    const evidence = descriptor.certification;
    assertExecutionCertification(releaseExecution,evidence);
    assertGame2dCertification(descriptor, evidence);
    const requiredKinds = ['engine-js', 'engine-wasm', 'contracts', 'bootstrap', 'compiler-js', 'compiler-wasm', 'typescript', 'typescript-module', 'type'];
    for (const kind of requiredKinds) if (!descriptor.files.some(file => file.kind === kind)) fail('E_RELEASE_CERTIFICATION', `Missing certified ${kind} asset`);
    for (const mode of ['development', 'production']) if (!descriptor.files.some(file => file.kind === 'sdk' && file.sdkMode === mode)) fail('E_RELEASE_CERTIFICATION', `Missing certified ${mode} SDK`);
    if (!Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.some(check => check.status !== 'passed')) fail('E_RELEASE_CERTIFICATION', 'Every recorded browser check must pass');
    for (const file of descriptor.files.filter(file => file.kind !== 'attestation')) {
      if (evidence.artifactHashes?.[file.path] !== file.sha256) fail('E_RELEASE_CERTIFICATION', `Browser evidence does not bind ${file.path}`);
    }
  }
  return descriptor;
}
