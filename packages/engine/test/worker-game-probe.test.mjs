import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareGameProbe, readGameProbeSequence, readGameProbeWireResult, supportsGameProbe} from '../dist/browser/dedicated/worker-game-probe.js';
import {validateRelease} from '../dist/browser/verified-loader.js';

const position = {path: '/root/Main/Player', property: 'position'};
test('probe validates and owns a bounded query before dispatch', () => {
  const input = {runId: 'run', props: [{...position}], screenshot: false, maxDimension: 64};
  const prepared = prepareGameProbe(input);
  assert.equal(prepared.ok, true);
  input.props[0].path = '/root/Other';
  assert.deepEqual(prepared.result.query.props, [position]);
  assert.equal(prepareGameProbe({runId: 'run', props: [position, position]}).error.code, 'invalid_input');
  assert.equal(prepareGameProbe({runId: 'run', timeoutMs: 30001}).error.code, 'invalid_input');
  assert.equal(prepareGameProbe({runId: 'run', screenshot: false}, AbortSignal.abort()).error.code, 'cancelled');
});

test('probe replies bind the actual state and PNG to one accepted frame and geometry', () => {
  const {query} = prepareGameProbe({runId: 'run', props: [position], maxDimension: 64}).result;
  // A 64 × 32 RGBA capture with IHDR, zlib-compressed IDAT, and terminal IEND.
  const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAXElEQVR4nO3QMREAIBDAsJeCFKThHGRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0BQs7402pwU04AAAAASUVORK5CYII=', 'base64'));
  const png = new DataView(bytes.buffer);
  const image = {iteration: 10, renderSerial: 9, geometry: {epoch: 3, dpr: 1, width: 128, height: 64},
    sourceWidth: 128, sourceHeight: 64, width: 64, height: 32, mimeType: 'image/png', bytes: bytes.buffer};
  const result = {ok: true, result: {mode: 'rendered', frame: {iteration: 10, renderSerial: 9}, image,
    tree: {status: 'not_requested'}, properties: [{...position, status: 'value', instanceId: '13', value: {x: 42, y: 9}}]}};
  assert.deepEqual(readGameProbeWireResult(query, result, 3), result);
  assert.equal(readGameProbeWireResult(query, result, 4), undefined);
  const missingFrame = {...result.result, ...result.result.frame, frame: {}};
  assert.equal(readGameProbeWireResult(query, {ok: true, result: missingFrame}), undefined);
  const state = {...missingFrame, mode: 'state', image: null, renderSerial: undefined};
  assert.equal(readGameProbeWireResult({...query, screenshot: false}, {ok: true, result: state}), undefined);
  for (const truncated of [bytes.slice(0, 33), bytes.slice(0, -12), bytes.slice(0, -1)]) {
    const incomplete = {...result.result, image: {...image, bytes: truncated.buffer}};
    assert.equal(readGameProbeWireResult(query, {ok: true, result: incomplete}), undefined);
  }
  bytes[41] ^= 1;
  assert.equal(readGameProbeWireResult(query, result), undefined, 'the IDAT checksum must match');
  bytes[41] ^= 1;
  image.renderSerial--;
  assert.equal(readGameProbeWireResult(query, result), undefined);
  image.renderSerial++;
  image.geometry.dpr = 2;
  assert.equal(readGameProbeWireResult(query, result), undefined);
  image.geometry.dpr = 1;
  png.setUint32(20, 33);
  assert.equal(readGameProbeWireResult(query, result), undefined);
});

test('probe sequence is bound to a canonical request ID in the exact run', () => {
  assert.equal(readGameProbeSequence('run:probe:23', 'run'), 23);
  for (const id of ['other:probe:23', 'run:probe:023', 'run:probe:2e1', 'run:probe:0', 'run:probe:9007199254740992'])
    assert.equal(readGameProbeSequence(id, 'run'), undefined);
});

test('only the single-threaded Full debug engine can declare the probe ABI', () => {
  const asset = {url: 'https://preview.example/engine.js', bytes: 12, sha256: 'a'.repeat(64)};
  const execution = {schemaVersion: 1, executionModel: 'window', wasmThreads: false, proxyToPthread: false,
    requiresCrossOriginIsolation: false, hostProtocolVersion: 2, lifecycleAbi: 1};
  const release = {releaseId: 'test', profile: 'full-engine-v1', engineTarget: 'template_debug', execution,
    runtimeAbi: {protocolVersion: 2, host: 1, audio: 1, presentation: 1, lifecycle: 1, observation: 1, gameProbe: 1},
    engineJs: asset, engineWasm: {...asset, url: 'https://preview.example/engine.wasm'}};
  assert.doesNotThrow(() => validateRelease(release));
  assert.equal(supportsGameProbe(release, 'direct'), true);
  assert.equal(supportsGameProbe(release, 'bitmap'), false);
  for (const rejected of [
    {...release, execution: {...execution, wasmThreads: true, requiresCrossOriginIsolation: true}},
    {...release, execution: {...execution, executionModel: 'proxy-pthread', proxyToPthread: true,
      wasmThreads: true, requiresCrossOriginIsolation: true, workerBootstrap: 'embedded'}},
    {...release, profile: 'engine-2d-v1'},
    {...release, engineTarget: 'template_release'},
  ]) {
    assert.throws(() => validateRelease(rejected), /E_GAME_PROBE_ABI/);
    assert.equal(supportsGameProbe(rejected, 'direct'), false);
  }
});
