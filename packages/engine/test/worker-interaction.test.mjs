import assert from 'node:assert/strict';
import test from 'node:test';
import {interactionNow, inputStatus} from '../dist/browser/dedicated/worker-interaction.js';
import {createWorkerCapture, createWorkerGesture} from '../dist/browser/dedicated/worker-observation.js';

const space = {kind: 'key_tap', code: 'Space'};
const enter = () => interactionNow() + 1000;

test('gesture has one result and preserves evidence when native exit reenters dispatch', () => {
  const receipts = [], dispatched = [];
  const controller = createWorkerGesture((id, evidence) => receipts.push({id, evidence}), () => undefined, (_, down) => {
    dispatched.push(down);
    controller.exit();
    return true;
  });
  controller.perform('first', 1, enter(), space);
  controller.perform('duplicate', 1, enter(), space);
  assert.deepEqual(dispatched, [true]);
  assert.deepEqual(receipts, [{id: 'first', evidence: {down: 'unconfirmed', up: 'not_dispatched', reason: 'run_ended'}}]);
  assert.equal(inputStatus(receipts[0].evidence), 'unconfirmed');
});

test('a Worker closing during down retains the completed edge and suppresses up', () => {
  let closed = false;
  const receipts = [], dispatched = [];
  const controller = createWorkerGesture((_, evidence) => receipts.push(evidence), () => closed ? 'run_ended' : undefined, (_, down) => {
    dispatched.push(down); closed = true; return true;
  });
  controller.perform('expired', 1, interactionNow() - 1, space);
  controller.perform('active', 2, enter(), space);
  assert.deepEqual(dispatched, [true]);
  assert.deepEqual(receipts, [
    {down: 'not_dispatched', up: 'not_dispatched', reason: 'expired'},
    {down: 'dispatched', up: 'not_dispatched', reason: 'run_ended'},
  ]);
  assert.equal(inputStatus(receipts[1]), 'partial');
});

test('capture cancellation settles after encoding returns its single physical credit', async t => {
  let resolveEncoding;
  const ready = new Promise(resolve => { resolveEncoding = resolve; });
  let copies = 0;
  class Scratch {
    getContext() { return {drawImage: () => copies++}; }
    convertToBlob() { return ready; }
  }
  const original = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = Scratch;
  t.after(() => { globalThis.OffscreenCanvas = original; });
  const canvas = {width: 200, height: 100, GLctxObject: {GLctx: {isContextLost: () => false}}};
  const results = [];
  const geometry = {width: 200, height: 100, dpr: 1, epoch: 2};
  const capture = createWorkerCapture(canvas, () => true, (id, frame, error) => results.push({id, frame, error}));
  capture.frame(1, 1, geometry);
  capture.request('a', enter());
  capture.frame(1, 1, geometry);
  assert.equal(copies, 0);
  capture.frame(2, 2, geometry);
  await Promise.resolve();
  capture.cancel('a');
  capture.request('b', enter());
  assert.deepEqual(results, [{id: 'b', frame: undefined, error: 'busy'}]);
  assert.equal(copies, 1);
  resolveEncoding(new Blob(['png'], {type: 'image/png'}));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(results.at(-1), {id: 'a', frame: undefined, error: 'cancelled'});
  canvas.GLctxObject.GLctx.isContextLost = () => true;
  capture.request('c', enter());
  capture.frame(3, 3, geometry);
  assert.deepEqual(results.at(-1), {id: 'c', frame: undefined, error: 'capture_failed'});
  assert.equal(copies, 1);
});
