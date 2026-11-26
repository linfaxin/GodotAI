import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {verifyBrowser} from './verify-summer-compat.mjs';

function previousTemplateReport() {
  const run = {runId: 'previous-run', revision: 1, buildKey: 'build', generation: 1,
    documentId: 'document', workerId: 'worker', runConfigurationHash: 'a'.repeat(64)};
  const frame = {iteration: 10, renderSerial: 8};
  const position = {x: 128, y: 256};
  const releaseId = 'previous-release';
  return {
    status: 'passed',
    engineExecuted: true,
    scriptExecuted: false,
    browser: {name: 'chromium'},
    runConfiguration: {presentationBackend: 'direct'},
    steps: [{name: 'previous-template-uses-existing-input', status: 'passed'}],
    releaseId,
    pngs: [{callId: 'probe', run, frame, position}],
    runs: [{
      run: {...run},
      exit: {
        evidence: 'host-report',
        report: {
          ...run,
          reason: 'clean-exit',
          sessionFacts: {
            schemaVersion: 1, nativeExit: {code: 0}, hostCleanup: 'complete', forcedTerminationIssued: false,
            runtimeSummary: 'sealed', entryCleanup: 'not-applicable',
          },
        },
      },
    }],
    publicCalls: [
      {callId: 'probe', reply: {result: {run, frame, releaseId, image: {...frame}, properties: [{value: position}]}}},
      {callId: 'facade', reply: {error: {code: 'unsupported'}}},
      {callId: 'direct', reply: {error: {code: 'unsupported'}}},
      {callId: 'wait', reply: {result: {operation: {status: 'dispatched'}}}},
    ],
    inputEvidence: {previousTemplate: {scriptDispatchCount: 0, facadeCallId: 'facade', directCallId: 'direct', waitCallId: 'wait'}},
  };
}

test('offline browser verification requires a clean host exit for every sampled run', () => {
  assert.equal(verifyBrowser(previousTemplateReport(), false), null);
  for (const [change, expected] of [
    [run => delete run.exit, /Missing host exit receipt/],
    [run => { run.exit.report.runId = 'different-run'; }, /Exit receipt belongs to a different Worker session/],
    [run => { run.exit.report.workerId = 'different-worker'; }, /Exit receipt belongs to a different Worker session/],
    [run => { run.run.runConfigurationHash = 'b'.repeat(64); }, /Run record belongs to a different Worker session/],
    [run => { run.exit.report.sessionFacts.nativeExit.code = 2; }, /Native exit did not succeed/],
    [run => { run.exit.report.sessionFacts.hostCleanup = 'incomplete'; }, /Host cleanup was incomplete/],
    [run => { run.exit.report.sessionFacts.forcedTerminationIssued = true; }, /cooperative exit/],
    [run => { run.exit.report.sessionFacts.entryCleanup = 'failed'; }, /Entry cleanup was incomplete/],
    [run => { run.exit.report.sessionFacts.runtimeSummary = 'unconfirmed'; }, /Runtime summary was not sealed/],
    [run => { run.exit.report.sessionFacts.failure = {kind: 'runtime', message: 'fatal'}; }, /Runtime reported a failure/],
    [run => { run.exit.report.reason = 'crashed'; }, /Expected a clean exit/],
  ]) {
    const report = previousTemplateReport();
    change(report.runs[0]);
    assert.throws(() => verifyBrowser(report, false), expected);
  }
  const report = previousTemplateReport();
  report.runs = [];
  assert.throws(() => verifyBrowser(report, false), /Exit receipts must cover each probed run/);
});

test('offline browser verification rejects PNGs from a different iteration or render', () => {
  for (const field of ['iteration', 'renderSerial']) {
    const report = previousTemplateReport();
    report.publicCalls[0].reply.result.image[field] += 1;
    assert.throws(() => verifyBrowser(report, false), new RegExp('PNG and state disagree on ' + field));
  }
});

test('invoking the verifier through a symlink still runs the CLI and fails on missing evidence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'verify-summer-compat-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const alias = path.join(root, 'verify.mjs');
  await symlink(fileURLToPath(new URL('./verify-summer-compat.mjs', import.meta.url)), alias);
  const result = spawnSync(process.execPath, [alias, root], {encoding: 'utf8'});
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(await readFile(path.join(root, 'verification-summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /artifact\.json/);
  assert.deepEqual(JSON.parse(result.stdout), summary);
});
