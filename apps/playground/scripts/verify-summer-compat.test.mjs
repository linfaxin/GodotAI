import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {verifyBrowser, verifyCleanExit} from './verify-summer-compat.mjs';
import {inputModes, verifyInputScriptCase, verifyInputScriptG0} from './verify-input-script-g0.mjs';

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

test('a clean exit from the first run cannot verify the restarted Worker', () => {
  const {run, exit} = previousTemplateReport().runs[0];
  const restart = {...run, runId: 'restart-run', workerId: 'restart-worker'};
  verifyCleanExit(run, exit);
  verifyCleanExit(restart, {...exit, report: {...exit.report, ...restart}});
  assert.throws(() => verifyCleanExit(restart, exit), /Exit receipt belongs to a different Worker session/);
});

test('offline browser verification rejects a restart with a different source hash', () => {
  const report = previousTemplateReport();
  const first = report.runs[0];
  const restart = structuredClone(first);
  restart.run.runId = restart.exit.report.runId = 'restart-run';
  restart.run.workerId = restart.exit.report.workerId = 'restart-worker';
  first.sourceHash = 'a'.repeat(64);
  restart.sourceHash = 'b'.repeat(64);
  report.runs.push(restart);
  report.scriptExecuted = true;
  report.pngs = [first.run, first.run, restart.run].map((run, index) => ({
    ...report.pngs[0], run, callId: 'probe-' + index, position: {x: [64, 128, 64][index], y: 256},
  }));
  report.calls = report.pngs.map(({callId, run, frame, position}) => ({
    callId, replyProjection: {result: {data: {run, frame, releaseId: report.releaseId,
      image: {...frame}, properties: [{value: position}]}}},
  }));
  assert.throws(() => verifyBrowser(report, true), /Restart used a different source hash/);
});

test('offline G0 verification requires the recorded cases and execution evidence', () => {
  const sha256 = 'a'.repeat(64), reportHash = 'b'.repeat(64);
  const report = {status: 'passed', engineExecuted: true, engineReportSha256: reportHash, templateSha256: sha256,
    releaseId: 'fixture-release', cases: inputModes.map(name => ({name, run: {releaseId: 'fixture-release'}}))};
  const replaced = structuredClone(report);
  replaced.cases[0].name = 'input-unexpected';
  assert.throws(() => verifyInputScriptG0(replaced, {reportHash, sha256}), /G0 case names differ/);
  assert.throws(() => verifyInputScriptG0(report, {reportHash, sha256}), /G0 fixture differs: input-snake/);

  const run = {generation: 'input-snake', runId: 'run', workerId: 'worker', releaseId: report.releaseId};
  const probe = x => ({ok: true, result: {run, releaseId: run.releaseId, properties: [{value: {x}}]}});
  const sample = {name: run.generation, run, before: probe(64), after: probe(128), settled: probe(128),
    input: {ok: true, receipt: {run, releaseId: run.releaseId},
      result: {releaseStepCompleted: true, down: {physics: '6'}, up: {physics: '10'}}},
    markers: ['G0_NATIVE_INPUT_UNCHANGED'],
    exit: {runId: run.runId, workerId: run.workerId, engineOutcome: {code: 0}, hostCleanup: {status: 'complete'}}};
  verifyInputScriptCase(sample);
  sample.input.result.up.physics = '9';
  assert.throws(() => verifyInputScriptCase(sample));
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
