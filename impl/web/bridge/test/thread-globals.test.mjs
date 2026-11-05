import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../js/jsbb.impl.js', import.meta.url), 'utf8');

test('single-thread bridge loads and skips worker hooks with omitted Emscripten globals', () => {
  const errors = [];
  const context = createContext({ console: { ...console, error: (...args) => errors.push(args) } });
  runInContext(source, context);
  assert.equal(runInContext('typeof ENVIRONMENT_IS_PTHREAD', context), 'undefined');
  assert.equal(runInContext('typeof PThread', context), 'undefined');
  runInContext('_jsbb_.install_pthread_worker_listener_hook()', context);
  assert.equal(runInContext('_jsbb_.post_message_to_worker(1, {})', context), false);
  assert.deepEqual(errors, []);
});

test('threaded main realm still wraps new workers once', () => {
  const listeners = [], messages = [];
  const worker = { addEventListener: (...args) => listeners.push(args), postMessage: data => messages.push(data) };
  const context = createContext({ console, ENVIRONMENT_IS_PTHREAD: false, PThread: { getNewWorker() { return worker; }, pthreads: { 7: worker } } });
  runInContext(source, context);
  runInContext('_jsbb_.install_pthread_worker_listener_hook(); _jsbb_.install_pthread_worker_listener_hook(); PThread.getNewWorker()', context);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'message');
  assert.equal(runInContext('_jsbb_.post_message_to_worker(7, "hello", 9)', context), true);
  assert.equal(messages[0].data, 'hello');
  assert.equal(messages[0].transfer_id, 9);
});

test('pthread realm retains its parent-message listener', () => {
  const listeners = [];
  const context = createContext({ console, ENVIRONMENT_IS_PTHREAD: true, addEventListener: (...args) => listeners.push(args) });
  runInContext(source, context);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'message');
  assert.equal(listeners[0][2], true);
  runInContext('_jsbb_.install_pthread_worker_listener_hook()', context);
});

test('registry release unregisters pending finalizers and ignores late callbacks', () => {
  let finalizer;
  const unregistered = [], calls = [];
  class ControlledRegistry {
    constructor(callback) { finalizer = callback; }
    register() {}
    unregister(token) { unregistered.push(token); return true; }
  }
  const context = createContext({ console, FinalizationRegistry: ControlledRegistry });
  runInContext(source, context);
  context._jsbb_.interop = { gc_callback: (engine, data) => calls.push([engine, data]) };
  runInContext('globalThis.registry = new jsbb_Registry(17); registry.Add({}, 101); registry.Add({}, 102);', context);
  finalizer(101);
  assert.deepEqual(calls, [[17, 101]]);
  assert.equal(context.registry.count, 1);
  runInContext('registry.Release(); registry.Release();', context);
  assert.equal(context.registry.count, 0);
  assert.equal(unregistered.length, 1);
  finalizer(102); // A callback already queued by the browser must not enter freed WASM.
  assert.deepEqual(calls, [[17, 101]]);
});
