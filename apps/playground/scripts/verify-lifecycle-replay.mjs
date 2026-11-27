import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, digest} from './site-evidence.mjs';

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const readText = name => readFile(path.join(root, name), 'utf8');
const readJson = async name => JSON.parse(await readText(name));
const [checksums, context, manifest, release, originalPixels] = await Promise.all([
  readText('SHA256SUMS'),
  readJson('evidence/site-start.json'),
  readJson('site/manifest.json'),
  readJson('site/engine-release.json'),
  readJson('evidence/pixels.json'),
]);
const files = new Map();
for (const line of checksums.trimEnd().split(/\r?\n/)) {
  const entry = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert(entry, 'Invalid SHA256SUMS entry');
  const [, expected, name] = entry;
  assert(!/[\\:]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'),
    `Invalid archive path: ${name}`);
  const bytes = await readFile(path.join(root, name));
  const sha256 = digest(bytes);
  assert.equal(sha256, expected, `Checksum differs: ${name}`);
  files.set(name, {sha256, bytes: bytes.length});
}

const payloads = Object.fromEntries([...files].filter(([name]) => name.startsWith('site/'))
  .map(([name, asset]) => [name.slice('site/'.length), asset]));
assert.equal(digest(canonical(payloads)), context.siteHash);
assert.equal(payloads['manifest.json'].sha256, context.candidateId);
assert.equal(payloads['engine-release.json'].sha256, context.descriptorHash);
assert.equal(release.id, context.releaseId);
assert.equal(release.runtimeProfile, context.profile);
assert.equal(manifest.engineTarget, 'template_debug');
assert.equal(manifest.runtime.executionBackend, 'worker');
assert.equal(context.profile, 'full-engine-v1');
assert.equal(release.runtimeAbi.gameProbe, 1);
assert.equal(release.runtimeAbi.inputScript, 1);
assert.equal(release.build.sourceCertified, true);
assert.equal(files.get('evidence/engine-report.json')?.sha256, release.build.engineReportSha256);

const pixels = JSON.parse(execFileSync(process.execPath, [
  path.join(root, 'tools/verify-lifecycle-events.mjs'),
  path.join(root, 'evidence/report.json'),
  path.join(root, 'evidence/site-start.json'),
], {encoding: 'utf8'}));
assert.deepEqual(pixels, originalPixels, 'Pixel evidence did not reproduce');
const xs = pixels.observations.map(sample => sample.position.x);
console.log(`Playground replay verified (${xs.join(' → ')}, two clean Worker exits)`);
