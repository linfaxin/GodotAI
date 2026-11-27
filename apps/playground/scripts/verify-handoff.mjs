import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyCleanExit, verifyRestartSource} from './verify-summer-compat.mjs';

const [mode, input, expectedReport, expectedPixels] = process.argv.slice(2);
if (mode !== 'web' || !input || Boolean(expectedReport) !== Boolean(expectedPixels)) {
  throw Error('Usage: node verify-handoff.mjs web <extracted-root> [report.json reports/pixels.json]');
}
const root = path.resolve(input);
const script = fileURLToPath(new URL('./verify-summer-compat.mjs', import.meta.url));
const result = spawnSync(process.execPath, [script, root], {encoding: 'utf8'});
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
const summaryPath = path.join(root, 'verification-summary.json');
const actual = await readFile(summaryPath);
const summary = JSON.parse(actual);
assert.equal(result.stdout, actual.toString());
assert.equal(summary.error, undefined, JSON.stringify(summary));
for (const variant of ['new', 'old', 'replay-new', 'replay-old']) {
  assert.equal(summary.browser[variant].status, 'passed', variant);
  const reportFolder = path.join(root, 'reports', variant);
  assert.equal((await readFile(path.join(reportFolder, 'browser.exit-code.txt'), 'utf8')).trim(), '0');
}
// The R4 handoff uses this pair of archived templates.
const commits = {
  new: '96971df40625541a8f89efed62d313ad18868649',
  old: 'e80c754da76722b2403aabb9ca2ec044a6407bec',
};
for (const [variant, commit] of Object.entries(commits)) {
  const build = JSON.parse(await readFile(path.join(root, 'templates', variant, 'engine-report.json')));
  assert.equal(build.source.commit, commit, `${variant} GodotAI commit`);
  assert.equal(build.source.dirty, '', `${variant} source tree`);
  assert.equal(build.godotSource.commit, '14d19694e0c88a3f9e82d899a0400f27a24c176e');
  assert.match(build.toolchains.emscripten, /\b4\.0\.11\b/);
  assert.equal(build.toolchains.node, 'v24.15.0');
  assert.equal(build.runtimeAbi.gameProbe, 1);
  assert.equal(build.runtimeAbi.inputScript, variant === 'new' ? 1 : undefined);
}
assert.equal(summary.g0.status, 'passed');
assert.equal(summary.g0.cases, 19);
assert.equal(summary.manual.status, 'passed');
const manual = JSON.parse(await readFile(path.join(root, summary.manual.report)));
assert.equal(manual.mode, 'headed-interactive-operator-walkthrough');
assert.equal(manual.browser.headless, false);
assert.equal(manual.candidateId, summary.browser.new.candidateId);
assert.equal(manual.siteHash, summary.browser.new.siteHash);
assert.equal(manual.runs.length, 2);
const [first, restart] = manual.runs;
assert.notEqual(first.run.runId, restart.run.runId);
verifyRestartSource(first, restart);
for (const {run, exit} of manual.runs) {
  assert.equal(run.configuration.presentationBackend, 'direct');
  verifyCleanExit(run, exit);
}
assert.equal(manual.input.releaseStepCompleted, true);
assert.equal(BigInt(manual.input.down.physics), BigInt(manual.input.base));
assert.equal(BigInt(manual.input.up.physics) - BigInt(manual.input.base), 4n);
const evidenceDir = path.join(root, 'reports/manual-archive');
const stages = ['setup', 'before', 'after', 'restart'];
assert.deepEqual(manual.visualChecks.map(check => check.stage), stages);
for (const stage of stages) {
  const view = await readFile(path.join(evidenceDir, `playground-${stage}.png`));
  assert.deepEqual([...view.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
}
assert.deepEqual(manual.unexpectedOrigins, []);
assert(manual.previewLoads.some(load => load.status === 200 &&
  new URL(load.url).origin === manual.servers.preview.origin));
const probeSteps = ['input-before', 'input-after', 'input-reset'];
assert.deepEqual(manual.pngs.map(png => png.position), [64, 128, 64].map(x => ({x, y: 256})));
for (const [index, png] of manual.pngs.entries()) {
  const call = manual.calls.find(call => call.callId === png.callId);
  assert.equal(call.step, probeSteps[index]);
  const probe = call.reply.result.data;
  assert.deepEqual(probe.properties[0].value, png.position);
  assert.deepEqual(probe.frame, png.frame);
  assert.equal(probe.image.iteration, probe.frame.iteration);
  assert.equal(probe.image.renderSerial, probe.frame.renderSerial);
  assert.equal(probe.run.runId, (index < 2 ? first : restart).run.runId);
  const bytes = await readFile(path.join(evidenceDir, png.file));
  assert.equal(bytes.length, png.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), png.sha256);
}
assert(manual.pngs[1].frame.iteration > manual.input.finishedIteration);
const actualPixels = await readFile(path.join(root, summary.pixels));
const pixels = JSON.parse(actualPixels);
assert.equal(pixels.status, 'passed');
assert.equal(pixels.observations['manual-archive'].length, 3);
assert.equal(result.status, 1);
assert.equal(summary.status, 'partial');
assert.equal(summary.summer.status, 'not_run');
if (expectedReport) {
  const archive = await readFile(path.join(path.dirname(expectedReport), 'playground-sites.tar.gz'));
  assert.equal(manual.archiveHash, createHash('sha256').update(archive).digest('hex'));
  assert.ok(actual.equals(await readFile(expectedReport)), 'Summary differs from the archived baseline');
  assert.ok(actualPixels.equals(await readFile(expectedPixels)), 'Pixels differ from the archived baseline');
}
console.log(`${mode} handoff verified`);
