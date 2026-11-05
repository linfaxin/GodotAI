import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { patchAudioLifecycle } from '../../release/patch-web-audio-lifecycle.mjs';

// The relevant original Godot 4.6.1 glue shape, including both start branches.
const fixture = `var GodotAudioWorklet={promise:null,worklet:null,ring_buffer:null,
 create:function(channels){const path=GodotConfig.locate_file('godot.audio.worklet.js');GodotAudioWorklet.promise=GodotAudio.ctx.audioWorklet.addModule(path).then(function(){GodotAudioWorklet.worklet=new AudioWorkletNode(GodotAudio.ctx,'godot-processor',{outputChannelCount:[channels]});return Promise.resolve()});GodotAudio.driver=GodotAudioWorklet},
 start:function(){GodotAudioWorklet.promise.then(function(){const node=GodotAudioWorklet.worklet;node.connect(GodotAudio.ctx.destination)})},
 start_no_threads:function(){GodotAudioWorklet.promise.then(function(){const node=GodotAudioWorklet.worklet;node.connect(GodotAudio.ctx.destination)})},
 close:function(){return new Promise(function(resolve,reject){if(GodotAudioWorklet.promise===null)return;GodotAudioWorklet.promise.then(function(){GodotAudioWorklet.worklet.disconnect();GodotAudioWorklet.worklet=null;resolve()}).catch(function(error){GodotRuntime.error(error)})})}};
 GodotAudio.audioPositionWorkletPromise=ctx.audioWorklet.addModule(path);globalThis.driver=GodotAudioWorklet;`;
function setup() {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const stats = { constructed: 0, connected: 0, disconnected: 0, portsClosed: 0, errors: [] };
  const ctx = { state: 'running', destination: {}, audioWorklet: { addModule: () => pending } };
  const scope = { ctx, path: 'position', GodotAudio: { ctx }, GodotConfig: { locate_file: path => path }, GodotRuntime: { error: (...args) => stats.errors.push(args) },
    AudioWorkletNode: class { constructor(context) { assert.equal(context, ctx); stats.constructed++; this.port = { postMessage() {}, close() { stats.portsClosed++; } }; } connect() { stats.connected++; } disconnect() { stats.disconnected++; } },
  };
  runInNewContext(patchAudioLifecycle(fixture).code, scope);
  return { scope, stats, ctx, resolve, reject, driver: scope.driver };
}
test('retiring the context before addModule resolves skips all late constructors and starts', async () => {
  const s = setup();
  s.driver.create(2); s.driver.start(); s.driver.start_no_threads();
  s.scope.GodotAudio.ctx = null;
  const closing = s.driver.close();
  s.resolve(); await closing;
  assert.equal(s.stats.constructed, 0);
  assert.equal(s.stats.connected, 0);
  assert.equal(s.driver.promise, null);
  assert.equal(s.driver.ring_buffer, null);
  assert.equal(s.driver.context, null);
  assert.equal(s.stats.errors.length, 0);
});
test('normal worklet startup disconnects and closes its port on shutdown', async () => {
  const s = setup(); s.driver.create(2); s.driver.start(); s.resolve();
  await s.driver.promise;
  assert.equal(s.stats.constructed, 1); assert.equal(s.stats.connected, 1);
  await s.driver.close();
  assert.equal(s.stats.disconnected, 1); assert.equal(s.stats.portsClosed, 1);
  await s.driver.close();
  assert.equal(s.stats.disconnected, 1, 'second shutdown is idempotent');
});
test('unexpected addModule failure remains observable and shutdown still completes', async () => {
  const s = setup(); s.driver.create(2);
  const original = s.driver.promise;
  const closing = s.driver.close();
  const failure = new Error('HTTP 403');
  // The separate position-worklet branch also preserves non-cancellation errors.
  const position = assert.rejects(s.scope.GodotAudio.audioPositionWorkletPromise, /HTTP 403/);
  s.reject(failure);
  await assert.rejects(original, /HTTP 403/);
  await position; await closing;
  assert.equal(s.stats.errors.length, 1);
  assert.equal(s.driver.promise, null);
});
test('patch is idempotent and rejects unsupported generated-code layouts', () => {
  const result = patchAudioLifecycle(fixture);
  assert.equal(result.changed, true);
  assert.equal(patchAudioLifecycle(result.code).changed, false);
  assert.throws(() => patchAudioLifecycle('unknown'), /E_AUDIO_PATCH_UNSUPPORTED/);
  assert.throws(() => patchAudioLifecycle(fixture.replace('const node=GodotAudioWorklet.worklet;', 'var other=GodotAudioWorklet.worklet;')), /both start continuations/);
});
