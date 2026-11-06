#!/usr/bin/env node
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, inspectRelease, writeJson, fail, verifyCDN } from './web-release-utils.mjs';
export { verifyCDN } from './web-release-utils.mjs';
import { verifyRelease } from './verify-web-release.mjs';

function npm(args, cwd) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('E_RELEASE_NPM', `npm ${args[0]} failed (${result.status}); authenticate a publish-capable npm identity. ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
export async function publishRelease(configuration) {
  const reportPath = resolve(configuration.report ?? 'scripts/jsb.web-engine/out/publish-report.json');
  const report = { status: 'running', phase: 'prepare', published: false, cdnVerified: false };
  let temporary;
  try {
    const directory = resolve(configuration.dir ?? 'scripts/jsb.web-engine/dist');
    const descriptor = await inspectRelease(directory, { requireCertified: true });
    temporary = await mkdtemp(resolve(tmpdir(), 'godot-web-publish-'));
    const prepared = await verifyRelease({ dir: directory, package: configuration.package, 'require-certified': true, 'pack-out': temporary });
    Object.assign(report, { id: descriptor.id, package: prepared.package, version: prepared.version, tarballSha256: prepared.tarballSha256 });
    report.phase = 'credentials'; await writeJson(reportPath, report);
    const registry = configuration.registry ?? 'https://registry.npmjs.org/';
    // npm whoami checks .npmrc, environment-backed tokens and OIDC-provisioned
    // identities without displaying a secret or pretending credentials exist.
    report.npmIdentity = npm(['whoami', '--registry', registry], temporary);
    if (!report.npmIdentity) fail('E_RELEASE_CREDENTIALS', 'npm whoami returned no authenticated identity');
    const probe = spawnSync('npm', ['view', `${prepared.package}@${prepared.version}`, 'version', '--json', '--registry', registry], { cwd: temporary, encoding: 'utf8' });
    if (probe.status === 0) fail('E_RELEASE_VERSION_EXISTS', 'The exact npm version already exists; do not mutate or silently republish it');
    if (!/E404|404 Not Found|is not in this registry/.test(probe.stderr ?? '')) fail('E_RELEASE_REGISTRY', 'Could not establish that the exact npm version is unpublished');
    report.phase = 'publish'; await writeJson(reportPath, report);
    npm(['publish', prepared.tarball, '--access', 'public', '--ignore-scripts', '--registry', registry, ...(configuration.tag ? ['--tag', configuration.tag] : [])], temporary);
    report.published = true; report.phase = 'cdn'; await writeJson(reportPath, report);
    const cdn = configuration['cdn-base'] ?? `https://cdn.jsdelivr.net/npm/${prepared.package}@${prepared.version}/dist/`;
    await verifyCDN({ baseUrl: cdn, descriptor });
    report.cdnVerified = true; report.status = 'published'; report.phase = 'done';
    await writeJson(reportPath, report); return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    await writeJson(reportPath, report);
    throw Object.assign(error, { publishReport: reportPath, published: report.published });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await publishRelease(options(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message, published: error.published ?? false, report: error.publishReport })); process.exitCode = 1; }
}
