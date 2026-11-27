import assert from 'node:assert/strict';

export const inputModes = Object.freeze(['input-snake', 'input-camel', 'input-zero', 'input-multi', 'input-cancel', 'input-cancel-no-raf',
  'input-replace-action', 'input-change-scene', 'input-restore-scene', 'input-same-scene', 'input-pause', 'input-release', 'input-physical',
  'input-pause-resume', 'input-expiry', 'input-early-cancel', 'input-stop',
  'input-quit', 'input-quit-at-release']);
const interruptedInputReasons = {'input-quit': 'run_ended', 'input-stop': 'run_ended', 'input-replace-action': 'action_changed',
  'input-change-scene': 'scene_changed', 'input-restore-scene': 'scene_changed', 'input-pause': 'paused', 'input-pause-resume': 'paused',
  'input-release': 'action_released'};

export function verifyInputScriptCase(sample) {
  const {name: mode, run, before, input, markers, exit} = sample;
  assert(inputModes.includes(mode), 'Unexpected G0 case: ' + mode);
  assert.equal(run?.generation, mode, 'G0 fixture differs: ' + mode);
  assert(typeof run.runId === 'string' && run.runId && typeof run.workerId === 'string' && run.workerId);
  assert(Array.isArray(markers) && markers.every(marker => typeof marker === 'string'));
  assert.equal(input?.receipt?.run?.runId, run.runId);
  assert.equal(input.receipt.run.workerId, run.workerId);
  assert.equal(input.receipt.releaseId, run.releaseId);
  const exitsDuringInput = mode === 'input-stop' || mode.startsWith('input-quit');
  if (exitsDuringInput) assert.deepEqual([sample.after, sample.settled], [null, null]);
  for (const probe of exitsDuringInput ? [before] : [before, sample.after, sample.settled]) {
    assert.equal(probe?.ok, true);
    assert.equal(probe.result.run.runId, run.runId);
    assert.equal(probe.result.run.workerId, run.workerId);
    assert.equal(probe.result.releaseId, run.releaseId);
  }
  assert.equal(exit?.runId, run.runId);
  assert.equal(exit.workerId, run.workerId);
  assert.equal(sample.before.result?.properties[0]?.value.x, 64, JSON.stringify(sample.before));
  if (mode.startsWith('input-cancel') || mode === 'input-early-cancel') {
    assert.equal(sample.input.outcome, 'outcome_unknown');
    assert.equal(sample.retired.error?.code, 'unknown_action', JSON.stringify(sample.retired));
    if (mode === 'input-cancel-no-raf') assert(markers.includes('G0_PAUSED_RAF'));
    if (mode === 'input-early-cancel') assert.equal(sample.after.result?.properties[0]?.value.x, 64);
    else assert(sample.after.result?.properties[0]?.value.x > 64);
    assert.equal(sample.settled.result?.properties[0]?.value.x, sample.after.result?.properties[0]?.value.x);
  } else if (interruptedInputReasons[mode]) {
    assert.equal(sample.input.outcome, 'interrupted', JSON.stringify(sample.input));
    assert.equal(sample.input.terminal.owner, 'cleared');
    assert.equal(sample.input.terminal.reason, interruptedInputReasons[mode]);
    if (mode.endsWith('-resume')) {
      assert(sample.markers.includes('G0_AFTER_RESUME=false'), JSON.stringify(sample.markers));
      assert.equal(sample.after.result?.properties[0]?.value.x, 64);
    }
    if (mode === 'input-restore-scene') {
      assert.deepEqual(sample.markers, ['G0_SCENE_RESTORED=true', 'G0_AFTER_RESTORE=false']);
      assert.equal(sample.after.result?.properties[0]?.value.x, 64);
      assert.equal(sample.settled.result?.properties[0]?.value.x, 64);
    }
  } else if (mode === 'input-expiry') {
    assert.equal(sample.input.outcome, 'outcome_unknown', JSON.stringify(sample.input));
    assert.equal(sample.input.error.message, 'timeout');
    assert(sample.markers.includes('G0_AFTER_DEADLINE=false'), JSON.stringify(sample.markers));
    assert.equal(sample.retired.error?.code, 'unknown_action', JSON.stringify(sample.retired));
    assert.equal(sample.after.result?.properties[0]?.value.x, 64);
    assert.equal(sample.settled.result?.properties[0]?.value.x, 64);
  } else if (mode === 'input-quit-at-release') {
    assert.equal(sample.input.outcome, 'interrupted', JSON.stringify(sample.input));
    assert.equal(sample.input.terminal.reason, 'run_ended');
    assert.equal(sample.input.terminal.owner, 'released');
    assert.equal(sample.input.terminal.releaseStepCompleted, false);
    assert.equal(BigInt(sample.input.terminal.up.physics) - BigInt(sample.input.terminal.down.physics), 4n);
  } else if (mode === 'input-physical') {
    assert.equal(sample.input.ok, true, JSON.stringify(sample.input));
    assert(sample.after.result?.properties[0]?.value.x >= 144, JSON.stringify(sample.after));
  } else {
    assert.equal(sample.input.ok, true, JSON.stringify(sample.input));
    assert.equal(sample.input.result.releaseStepCompleted, true);
    assert.equal(BigInt(sample.input.result.up.physics) - BigInt(sample.input.result.down.physics), 4n);
    assert.equal(sample.after.result?.properties[0]?.value.x, 128, JSON.stringify(sample.after));
    assert.equal(sample.settled.result?.properties[0]?.value.x, 128);
    if (mode === 'input-snake') assert(sample.markers.includes('G0_NATIVE_INPUT_UNCHANGED'), JSON.stringify(sample));
    if (mode === 'input-same-scene') assert(sample.markers.includes('G0_SAME_SCENE_HELD=true'), JSON.stringify(sample.markers));
    if (mode === 'input-zero') {
      assert(sample.markers.includes('G0_PHYSICS_CADENCE=0'), JSON.stringify(sample));
      assert.equal(BigInt(sample.input.result.down.physics) - BigInt(sample.input.result.base), 2n);
    }
    if (mode === 'input-multi') assert(sample.markers.some(marker => marker.startsWith('G0_PHYSICS_CADENCE=') && Number(marker.split('=')[1]) > 1), JSON.stringify(sample));
  }
  assert.equal(sample.exit?.hostCleanup?.status, 'complete', JSON.stringify(sample.exit));
  assert.equal(sample.exit.engineOutcome?.code, 0, JSON.stringify(sample.exit));
}

export function verifyInputScriptG0(report, {reportHash, sha256}) {
  assert.equal(report.status, 'passed');
  assert.equal(report.engineExecuted, true);
  assert.match(reportHash, /^[a-f0-9]{64}$/);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.engineReportSha256, reportHash);
  assert.equal(report.templateSha256, sha256);
  assert.deepEqual(report.cases.map(sample => sample.name).sort(), [...inputModes].sort(), 'G0 case names differ');
  for (const sample of report.cases) {
    assert.equal(sample.run?.releaseId, report.releaseId, 'G0 case release differs: ' + sample.name);
    verifyInputScriptCase(sample);
  }
}
