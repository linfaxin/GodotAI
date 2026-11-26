import assert from 'node:assert/strict';

// Both live collection and offline replay consume the pinned CLI's operation receipts.
export function operationResult(reply, op, ok = true) {
  assert.equal(reply.ok, ok, op + ' CLI outcome');
  if (ok) assert.equal(reply.status, 'done', op + ' CLI status');
  const tool = ok ? reply.result : reply.error?.details?.tool;
  let result = tool;
  if (tool?.op !== op || tool.results) {
    assert.equal(tool?.status, ok ? 'ok' : 'error', op + ' tool status');
    assert.equal(tool.terminalState, ok ? 'applied' : 'failed', op + ' terminal state');
    result = tool.results?.find(item => item.op === op);
  }
  assert.equal(result?.ok, ok, op + ' result');
  return result;
}

export function checkUnknownAction(receipt, events) {
  assert.equal(receipt.failure_reason, 'all_rejected');
  assert.equal(receipt.applied, 0, 'Unknown action applied input');
  assert.deepEqual(receipt.rejected.map(item => item.index).sort((a, b) => a - b), events.map((_, i) => i));
  assert(receipt.rejected.every(item => item.failure_reason === 'unknown_action'));
}

export function checkProbeImageFrame(sample) {
  assert(Number.isSafeInteger(sample.image_frame) && sample.image_frame >= 0, 'Missing GameProbe image frame');
  assert.equal(sample.image_frame, sample.frame.process_frames, 'GameProbe image and state came from different frames');
}

export function parseProbePosition(text) {
  const match = typeof text === 'string' &&
    text.match(/^(?:Vector2)?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  assert(match, 'GameProbe returned no recognizable Godot Vector2 position');
  return {x: Number(match[1]), y: Number(match[2])};
}
