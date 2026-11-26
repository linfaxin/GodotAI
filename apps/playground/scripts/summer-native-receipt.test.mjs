import assert from 'node:assert/strict';
import test from 'node:test';
import {operationResult, checkUnknownAction, checkProbeImageFrame, parseProbePosition} from './summer-native-receipt.mjs';

test('a completed CLI command also needs an applied tool result', () => {
  const leaf = {op: 'SimulateInputScript', ok: true, completed: true, applied: 2};
  const tool = {status: 'ok', terminalState: 'applied', results: [leaf]};
  const reply = {ok: true, status: 'done', result: tool};
  assert.equal(operationResult(reply, leaf.op), leaf);
  tool.terminalState = 'failed';
  assert.throws(() => operationResult(reply, leaf.op), /terminal state/);
});

test('a rejected script accounts for each unknown action and applies none', () => {
  const rejected = [0, 1].map(index => ({index, failure_reason: 'unknown_action'}));
  const receipt = {op: 'SimulateInputScript', ok: false, failure_reason: 'all_rejected', applied: 0, rejected};
  const reply = {ok: false, error: {details: {tool: {status: 'error', terminalState: 'failed', results: [receipt]}}}};
  const result = operationResult(reply, receipt.op, false);
  checkUnknownAction(result, [{}, {}]);
  assert.throws(() => checkUnknownAction({...result, applied: 1}, [{}, {}]), /applied input/);
});

test('the captured image belongs to the sampled process frame', () => {
  const sample = {frame: {process_frames: 15, frames_drawn: 16}, image_frame: 15};
  checkProbeImageFrame(sample);
  assert.throws(() => checkProbeImageFrame({...sample, image_frame: 14}), /different frames/);
});

test('GameProbe positions use the same coordinates with or without the Vector2 prefix', () => {
  const position = {x: -64.5, y: 256};
  assert.deepEqual(parseProbePosition('Vector2(-64.5, 256)'), position);
  assert.deepEqual(parseProbePosition('( -64.5 , 256 )'), position);
  assert.throws(() => parseProbePosition('(64, )'), /Vector2 position/);
});
