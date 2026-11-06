/** Required evidence for releases advertising the combined 2D profile. */
export const GAME_2D_PROFILE = 'game-2d-v1';
export const GAME_2D_CHECK = 'game-2d-native-composition';
export const LEGACY_PROFILE_CHECKS = Object.freeze({
  'core-ui-v1': 'real-cross-origin-godot-counter-click',
  'ui-media-v1': 'png-ui-media-native-controls-and-controlled-baseline',
  'behavior-physics-v1': 'real-web-physics-collision-and-stale-command-rejection',
});
const reject = message => { throw Error(`E_GAME2D_EVIDENCE: ${message}`); };
const checkName = (report, name) => report.sourceReport ? `${report.sourceReport}:${name}` : name;
function matchingChecks(report, tuple, name) {
  return (report.checks ?? []).filter(check => check.name === name && check.status === 'passed'
    && check.profileId === tuple.profileId && check.sdkMode === tuple.sdkMode
    && check.browserFamily === tuple.browserFamily && check.browserVersion === tuple.browserVersion
    && check.sourceReport === tuple.sourceReport);
}
export function hasGame2dProfile(release) {
  return Array.isArray(release.profiles)
    ? release.profiles.some(profile => profile.id === GAME_2D_PROFILE)
    : Object.hasOwn(release.profiles ?? {}, GAME_2D_PROFILE);
}
export function assertGame2dCoverage(report, browserFamily) {
  if (report.status !== 'passed') reject('Combination report must pass');
  if (report.browserFamily !== browserFamily) reject(`Combination report must identify ${browserFamily}`);
  for (const sdkMode of ['production', 'development']) {
    const tuples = (report.coverage ?? []).filter(item => item.profileId === GAME_2D_PROFILE && item.sdkMode === sdkMode && item.browserFamily === browserFamily && item.sourceReport === report.sourceReport);
    if (tuples.length !== 1) reject(`Missing or ambiguous ${browserFamily}/${sdkMode} combination coverage`);
    const tuple = tuples[0];
    if (!tuple || tuple.status !== 'passed' || !tuple.browserVersion || tuple.browserVersion !== report.browser) reject(`Missing ${browserFamily}/${sdkMode} combination coverage`);
    if (!Array.isArray(tuple.checks) || !tuple.checks.includes(checkName(report, GAME_2D_CHECK))) reject('Combination coverage must include its own native composition check');
    if (!tuple.checks.every(name => matchingChecks(report, tuple, name).length === 1)) reject('Coverage must reference one passed check with matching profile, mode, browser version and source report');
  }
}
export function assertLegacyProfileCoverage(report, browserFamily) {
  if (report.status !== 'passed' || report.browserFamily !== browserFamily || !report.browser) reject('Legacy regression report must identify its actual browser');
  for (const [profileId, name] of Object.entries(LEGACY_PROFILE_CHECKS)) {
    const tuple = { profileId, sdkMode: 'production', browserFamily, browserVersion: report.browser, sourceReport: report.sourceReport };
    if (matchingChecks(report, tuple, checkName(report, name)).length !== 1) reject(`Missing ${browserFamily} legacy regression for ${profileId}`);
  }
}
export function assertGame2dLifecycle(stress) {
  const scope = stress.scope;
  if (scope?.fixture !== 'game2d' || scope.profileId !== GAME_2D_PROFILE || scope.sdkMode !== 'production' || scope.browserFamily !== 'chromium') reject('Lifecycle must exercise Chromium production game2d');
  if (stress.cycles?.length < 100 || stress.failureCycles?.length < 20 || !Array.isArray(stress.cycles) || !Array.isArray(stress.failureCycles)) reject('Combination lifecycle requires 100 normal and 20 failure cycles');
  if (!scope.buildKey || !scope.generation || !stress.cycles.every(cycle => cycle.nativeReady === true)) reject('Combination lifecycle must observe native readiness for every normal run');
  for (const cycle of [...stress.cycles, ...stress.failureCycles]) {
    if (cycle.fixture !== scope.fixture || cycle.profileId !== scope.profileId || cycle.sdkMode !== scope.sdkMode || cycle.buildKey !== scope.buildKey || cycle.generation !== scope.generation) reject('Lifecycle cycle is missing its combination artifact identity');
  }
}
export function assertGame2dCertification(release, evidence) {
  if (!hasGame2dProfile(release)) return;
  for (const browserFamily of ['chromium', 'firefox', 'webkit']) {
    const sourceReport = browserFamily === 'chromium' ? 'integration' : browserFamily;
    const tuples = (evidence.coverage ?? []).filter(tuple => tuple.browserFamily === browserFamily && tuple.sourceReport === sourceReport);
    const versions = new Set(tuples.map(tuple => tuple.browserVersion));
    if (versions.size !== 1) reject(`Missing or ambiguous ${browserFamily} browser version`);
    const report = { ...evidence, coverage: tuples, browser: tuples[0]?.browserVersion, browserFamily, sourceReport };
    assertGame2dCoverage(report, browserFamily);
    assertLegacyProfileCoverage(report, browserFamily);
  }
  if (evidence.scope?.authenticatedAssets || Object.hasOwn(evidence.evidenceHashes ?? {}, 'authenticated-assets')) {
    const sourceReport = 'authenticated-assets';
    const tuples = (evidence.coverage ?? []).filter(tuple => tuple.sourceReport === sourceReport);
    const browser = (evidence.coverage ?? []).find(tuple => tuple.sourceReport === 'integration')?.browserVersion;
    const report = { ...evidence, coverage: tuples, sourceReport, browserFamily: 'chromium', browser };
    assertGame2dCoverage(report, 'chromium');
    assertLegacyProfileCoverage(report, 'chromium');
    for (const name of ['http-only-cookie-gated-same-origin-release-js-and-gzip-wasm', 'cross-origin-cdn-does-not-receive-site-cookie', 'game-2d-indexeddb-restores-and-automatically-runs', 'game-2d-shared-project-manually-runs']) {
      if (!(evidence.checks ?? []).some(check => check.sourceReport === sourceReport && check.name === checkName(report, name) && check.status === 'passed' && check.browserFamily === 'chromium' && check.browserVersion === browser)) reject(`Missing authenticated full-suite check ${name}`);
    }
  }
  const lifecycle = evidence.scope?.lifecycle;
  if (!Number.isSafeInteger(lifecycle?.iterations) || lifecycle.iterations < 100 || !Number.isSafeInteger(lifecycle.failureCases) || lifecycle.failureCases < 20 || lifecycle.scope?.fixture !== 'game2d' || lifecycle.scope.profileId !== GAME_2D_PROFILE || lifecycle.scope.sdkMode !== 'production' || lifecycle.scope.browserFamily !== 'chromium') reject('Missing certified combination lifecycle scope');
}
