#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, required, fail, inspectRelease, json, digest, canonical, within, writeJson, hashSiteRuntimeFiles } from './web-release-utils.mjs';
import { hasGame2dProfile, assertGame2dCoverage, assertLegacyProfileCoverage, assertGame2dLifecycle, assertGame2dCertification } from './game-2d-evidence.mjs';

function ensure(value, message) { if (!value) fail('E_BROWSER_EVIDENCE', message); }
function passed(report, name) {
  ensure(report.status === 'passed' && Array.isArray(report.checks) && report.checks.length > 0 && report.checks.every(check => check.status === 'passed'), `${name} report did not pass every check`);
}
export async function collectBrowserEvidence(configuration) {
  const site = resolve(required(configuration.site, '--site'));
  const release = await inspectRelease(resolve(site, 'release'));
  ensure(release.sourceCertified === true, 'Aggregate release certification requires a source-certified candidate');
  const inputs = {};
  for (const name of ['integration', 'stress', 'source-maps', 'engine-report']) {
    const path = resolve(required(configuration[name], `--${name}`));
    inputs[name] = { bytes: await readFile(path), report: await json(path) };
  }
  if (configuration['authenticated-report']) {
    const path = resolve(configuration['authenticated-report']);
    inputs['authenticated-assets'] = { bytes: await readFile(path), report: await json(path) };
  }
  for (const family of ['firefox', 'webkit']) {
    const path = configuration[`${family}-report`];
    if (path) inputs[family] = { bytes: await readFile(resolve(path)), report: await json(resolve(path)) };
  }
  const integration = inputs.integration.report, stress = inputs.stress.report, maps = inputs['source-maps'].report, build = inputs['engine-report'].report;
  passed(integration, 'Integration'); passed(stress, 'Stress'); passed(maps, 'Native source-map');
  ensure(integration.runtimeRelease === release.id && stress.runtimeRelease === release.id, 'Integration/stress reports must name this exact runtimeRelease');
  ensure(integration.browser === stress.browser && maps.browser === integration.browser, 'Reports must exercise the same actual browser version');
  if (hasGame2dProfile(release)) {
    assertGame2dCoverage(integration, 'chromium');
    assertLegacyProfileCoverage(integration, 'chromium');
    assertGame2dLifecycle(stress);
    for (const family of ['firefox', 'webkit']) {
      ensure(inputs[family], `Missing ${family} combination report`);
      passed(inputs[family].report, family);
      assertGame2dCoverage(inputs[family].report, family);
      assertLegacyProfileCoverage(inputs[family].report, family);
    }
  }
  ensure(build.status === 'built' && build.template?.sha256 === release.engine.archiveSha256, 'Build report must identify this candidate engine archive');
  ensure(digest(await readFile(build.template.path)) === build.template.sha256, 'Actual engine archive changed after its build report');
  const attestation = await json(within(resolve(site, 'release'), release.attestation));
  ensure(attestation.engineReportSha256 === digest(inputs['engine-report'].bytes), 'Build report must match the candidate attestation');
  ensure(maps.engine?.archiveSha256 === build.template.sha256 && maps.engine?.sourceSnapshotHash === build.source.snapshotHash
    && maps.engine?.godotSourceSnapshotHash === build.godotSource.snapshotHash && maps.engine?.recipeSha256 === build.recipeSha256,
  'Native map probe must attest the exact built archive, source snapshots and recipe');
  const wasm = release.files.find(file => file.kind === 'engine-wasm'), js = release.files.find(file => file.kind === 'engine-js');
  ensure(maps.engine?.assets?.['godot.wasm'] === (wasm.decodedSha256 ?? wasm.sha256), 'Native map probe ran different WASM bytes');
  let mappedGlue = maps.engine?.assets?.['godot.js'];
  for (const patch of release.jsGluePatches ?? []) {
    ensure(mappedGlue === patch.beforeSha256, 'Native map probe JS must match the tracked glue transformation chain');
    mappedGlue = patch.afterSha256;
  }
  ensure(mappedGlue === js.sha256, 'Native map probe JS is not the candidate glue or a recorded source transform');
  for (const name of ['caught', 'compressed', 'uncaught']) ensure(maps.checks.some(check => check.name === name && check.status === 'passed'), `Missing native source-map scenario ${name}`);
  ensure(stress.cycles?.length >= 100 && stress.failureCycles?.length >= 20, 'Lifecycle evidence requires at least 100 engine cycles and 20 failure/cancellation cases');
  ensure(stress.cycles.every(cycle => cycle.exit?.runId === cycle.runId && cycle.exit?.reason === 'clean-exit' && cycle.exit?.code === 0), 'Every normal stress engine must exit cleanly with its own identity');
  ensure(new Set(stress.cycles.map(cycle => cycle.runId)).size === stress.cycles.length, 'Repeated stress cycles must use fresh native runs');
  ensure(stress.failureCycles.some(cycle => cycle.kind === 'semantic-build-refused') && stress.failureCycles.some(cycle => cycle.kind === 'cancel-engine-startup'), 'Both semantic failure retention and engine cancellation must be covered');
  ensure(stress.failureCycles.every(cycle => cycle.kind === 'semantic-build-refused'
    ? cycle.exit?.runId === cycle.activeRunId && cycle.exit?.reason === 'clean-exit' && cycle.exit?.code === 0 && cycle.rejected?.accepted === false
    : cycle.kind === 'cancel-engine-startup' && cycle.exit?.runId === cycle.runId && ['clean-exit', 'forced-frame-disposal', 'unresponsive'].includes(cycle.exit?.reason)), 'Failure and cancellation exits must retain the correct identities and classifications');
  const actualHashes = {};
  for (const file of release.files) {
    actualHashes[file.path] = digest(await readFile(within(resolve(site, 'release'), file.path)));
    ensure(integration.artifactHashes?.[file.path] === actualHashes[file.path], `Integration report did not observe these actual bytes: ${file.path}`);
  }
  const templates = await hashSiteRuntimeFiles(site);
  ensure(canonical(templates) === canonical(integration.siteArtifactHashes), 'Static app/preview/worker templates changed after integration validation');
  ensure(canonical(templates) === canonical(stress.siteArtifactHashes), 'Static app/preview/worker templates changed after lifecycle validation');
  for (const family of ['firefox', 'webkit']) if (inputs[family]) {
    const additional = inputs[family].report;
    passed(additional, family);
    ensure(additional.runtimeRelease === release.id, `${family} report must name this exact runtimeRelease`);
    ensure(canonical(additional.siteArtifactHashes) === canonical(templates) && canonical(additional.artifactHashes) === canonical(actualHashes), `${family} evidence must bind identical release and static template bytes`);
  }
  const authenticated = inputs['authenticated-assets']?.report;
  if (authenticated) {
    passed(authenticated, 'Authenticated asset');
    if (hasGame2dProfile(release)) {
      assertGame2dCoverage(authenticated, 'chromium');
      assertLegacyProfileCoverage(authenticated, 'chromium');
    }
    ensure(authenticated.runtimeRelease === release.id && authenticated.browser === integration.browser, 'Authenticated assets must use the same release and actual browser');
    ensure(canonical(authenticated.siteArtifactHashes) === canonical(templates) && canonical(authenticated.artifactHashes) === canonical(actualHashes), 'Authenticated asset evidence must match current static templates and release bytes');
    for (const name of ['http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', 'cross-origin-cdn-does-not-receive-site-cookie']) ensure(authenticated.checks.some(check => check.name === name && check.status === 'passed'), `Missing authenticated asset check ${name}`);
  }
  const generated = integration.generatedArtifacts;
  ensure(generated?.maps?.length >= 2 && generated.maps.every(map => map.sha256 === map.sealedSha256 && map.version === 3 && map.mappings), 'Generated source-map bytes must match their sealed manifest artifacts');
  const evidenceHashes = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, digest(input.bytes)]));
  const groups = [['integration', integration], ['stress', stress], ['native-source-maps', maps], ...(authenticated ? [['authenticated-assets', authenticated]] : []), ...['firefox', 'webkit'].filter(family => inputs[family]).map(family => [family, inputs[family].report])];
  const checks = groups.flatMap(([group, report]) => report.checks.map(check => ({ ...check, name: `${group}:${check.name}`, sourceReport: group })));
  const coverage = groups.flatMap(([group, report]) => (report.coverage ?? []).map(tuple => ({ ...tuple, checks: tuple.checks.map(name => `${group}:${name}`), sourceReport: group })));
  const result = { status: 'passed', runtimeRelease: release.id, checks, coverage, artifactHashes: actualHashes, siteArtifactHashes: templates, generatedArtifacts: generated,
    scope: { ...integration.scope, lifecycle: { iterations: stress.cycles.length, failureCases: stress.failureCycles.length, scope: stress.scope, nativeMemoryConclusion: stress.nativeMemoryConclusion },
      nativeSourceMaps: { browser: maps.browser, scenarios: ['caught', 'compressed', 'uncaught'], expectedLocation: maps.expectedLocation } },
    evidenceHashes, engineArchiveSha256: build.template.sha256, collectedAt: new Date().toISOString() };
  if (authenticated) result.scope.authenticatedAssets = { fixtureCookie: 'HttpOnly/Lax', topology: 'same-site separate origins', sameOriginCredentials: true, crossOriginCredentialsOmitted: true };
  result.scope.additionalBrowsers = ['firefox', 'webkit'].filter(family => inputs[family]).map(family => ({ browserFamily: family, browserVersion: inputs[family].report.browser, evidenceSha256: digest(inputs[family].bytes), scope: inputs[family].report.scope }));
  assertGame2dCertification(release, result);
  if (configuration.out) await writeJson(resolve(configuration.out), result);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = options(process.argv.slice(2)); required(config.out, '--out');
    const result = await collectBrowserEvidence(config);
    console.log(JSON.stringify({ status: result.status, runtimeRelease: result.runtimeRelease, checks: result.checks.length, out: resolve(config.out) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
