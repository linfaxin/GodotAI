import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {siteIdentity} from './site-evidence.mjs';
import {verifyBrowser, verifyBrowserPreflight, verifyBrowserReportIdentity} from './verify-summer-compat.mjs';
import {verifyInputScriptG0} from './verify-input-script-g0.mjs';

if (process.argv.length !== 3) throw Error('Usage: node verify-replay.mjs <extracted replay directory>');
const root = await realpath(path.resolve(process.argv[2]));
const readJson = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const [site, release, identity, preflight, report, g0, pixels] = await Promise.all([
  readJson('site/manifest.json'),
  readJson('site/engine-release.json'),
  siteIdentity(path.join(root, 'site')),
  readJson('reports/new/site-start.json'),
  readJson('reports/new/report.json'),
  readJson('reports/g0/input-script-g0.json'),
  readJson('reports/pixels.json'),
]);
assert.equal(site.runtimeProfile, 'full-engine-v1');
assert.equal(release.runtimeProfile, site.runtimeProfile);
assert.equal(site.engineTarget, 'template_debug');
assert.equal(site.runtime.executionBackend, 'worker');
assert.equal(site.engineReleaseId, release.id);
assert.equal(release.execution.executionModel, 'window');
assert.equal(release.execution.wasmThreads, false);
assert.equal(release.runtimeAbi.gameProbe, 1);
assert.equal(release.runtimeAbi.inputScript, 1);
assert.equal(release.build.sourceCertified, true);
for (const asset of [release.engine.javascript, release.engine.wasm])
  assert.deepEqual(identity.payloads[asset.path], {sha256: asset.sha256, bytes: asset.bytes});

verifyBrowserPreflight(identity, preflight);
verifyBrowserReportIdentity(identity, preflight, report);
const {positions} = verifyBrowser(report, true);
verifyInputScriptG0(g0, {reportHash: release.build.engineReportSha256, sha256: release.build.engineTemplateSha256});

const pixelScript = fileURLToPath(new URL('./verify-summer-pixels.py', import.meta.url));
const {stdout} = await promisify(execFile)(process.env.PYTHON ?? 'python3', [pixelScript, root, '--replay']);
assert.deepEqual(JSON.parse(stdout), pixels, 'Pixel measurements differ from the archived report');
console.log(`Playground replay verified (${positions.map(({x}) => x).join(' → ')}, ${g0.cases.length} G0 cases)`);
