import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function verifyRuntimeRecoveryReport(reportFile, contextFile) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const context = JSON.parse(readFileSync(contextFile, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.scope, 'playground-runtime-recovery');
  assert.equal(report.engineExecuted, true);
  assert(report.steps.length && report.steps.every(step => step.status === 'passed'));
  assert.equal(report.profile, 'full-engine-v1');
  assert.equal(report.testMode, 'real-engine');
  assert.equal(report.browser.name, 'chromium');
  assert.equal(report.runConfiguration.presentationBackend, 'direct');
  for (const field of ['candidateId', 'descriptorHash', 'releaseId', 'siteHash', 'acceptanceBatchId']) {
    assert(typeof context[field] === 'string' && context[field].length > 0);
    assert.equal(report[field], context[field]);
  }
  assert.deepEqual(report.pngs.map(({file, position}) => [file, position.x, position.y]), [
    ['before.png', 64, 256], ['after.png', 128, 256], ['restart.png', 64, 256],
  ]);
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', [
    fileURLToPath(new URL('./verify-summer-pixels.py', import.meta.url)), '--playground-report', reportFile,
  ], {encoding: 'utf8'}));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportFile, contextFile] = process.argv.slice(2);
  assert(reportFile && contextFile, 'Usage: node verify-runtime-recovery.mjs REPORT SITE_START');
  console.log(JSON.stringify(verifyRuntimeRecoveryReport(path.resolve(reportFile), path.resolve(contextFile)), null, 2));
}
