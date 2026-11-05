import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** Play the editable demos through real Godot canvas input. No engine mocks. */
export async function verifyDemos(page, out) {
  const checks = [];
  let runId;
  const canvas = () => page.frameLocator('#preview iframe').locator('canvas');
  const click = (x, y) => canvas().click({ position: { x, y } });
  async function latest(tag) {
    return page.evaluate(({ runId, tag }) => {
      const event = playground.events.findLast(event => event.runId === runId && event.text?.startsWith(tag + ' '));
      return event ? JSON.parse(event.text.slice(event.text.indexOf('{'))) : null;
    }, { runId, tag });
  }
  async function wait(tag, values) {
    await page.waitForFunction(({ runId, tag, values }) => {
      const event = playground.events.findLast(event => event.runId === runId && event.text?.startsWith(tag + ' '));
      if (!event) return false;
      const state = JSON.parse(event.text.slice(event.text.indexOf('{')));
      return Object.entries(values).every(([key, value]) => state[key] === value);
    }, { runId, tag, values }, { timeout: 15000 });
    return latest(tag);
  }
  async function start(name) {
    const previousRuns = await page.evaluate(() => playground.runs.length);
    await page.click('#examples-menu > summary');
    await page.click(`[data-example="${name}"]`);
    assert.equal(await page.locator('#examples-menu').getAttribute('open'), null);
    await page.waitForFunction(name => {
      const project = playground.exportProject(), source = project.files['/src/App.tsx'];
      return name === 'starter' ? '/src/game.ts' in project.files
        : source.includes(({ state: 'Theme.Provider', media: 'PIXEL_STUDIO', physics: 'BOUNCE_STATUS' })[name]);
    }, name);
    assert.equal(await page.locator('#focus-preview').getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(previous => playground.runs.length > previous && document.getElementById('status').textContent === '运行中', previousRuns, { timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => playground.diagnostics), [], name + ': automatic build diagnostics');
    runId = await page.evaluate(() => playground.runs.at(-1).runId);
    await page.waitForFunction(id => playground.events.some(event => event.runId === id && event.text?.includes('GODOT_REACT_BOOT_REPORT')), runId, { timeout: 45000 });
  }
  async function finish(name) {
    assert(!await page.evaluate(id => playground.events.some(event => event.runId === id && event.type === 'log' && event.level === 'error'), runId));
    await page.screenshot({ path: resolve(out, 'demo-' + name + '.png'), fullPage: true });
    assert.equal((await page.evaluate(() => playground.stop())).reason, 'clean-exit');
    checks.push({ name, status: 'passed' });
  }

  await start('starter');
  for (let n = 1; n <= 8; n++) { await click(200, 174); await wait('OUTPOST', { mined: n }); }
  await click(110, 212); await wait('OUTPOST', { drill: 2, ore: 0, mined: 8 });
  for (let n = 1; n <= 6; n++) { await click(200, 174); await wait('OUTPOST', { mined: 8 + n * 2 }); }
  await click(315, 212); await wait('OUTPOST', { drones: 1, ore: 0 });
  await wait('OUTPOST', { mined: 21, ore: 1 });
  await click(110, 274); const paused = await wait('OUTPOST', { paused: true });
  await page.waitForTimeout(1250);
  await click(200, 174); assert.deepEqual(await latest('OUTPOST'), paused, 'Pause disables mining and cleans up the automation timer');
  await click(110, 274); await wait('OUTPOST', { paused: false });
  // Finish the full default mission through native input, including automation.
  for (let n = 0; n < 60 && (await latest('OUTPOST')).mined < 120; n++) {
    const before = await latest('OUTPOST'); await click(200, 174);
    await page.waitForFunction(({ id, mined }) => {
      const event = playground.events.findLast(event => event.runId === id && event.text?.startsWith('OUTPOST '));
      return event && JSON.parse(event.text.slice(event.text.indexOf('{'))).mined > mined;
    }, { id: runId, mined: before.mined });
  }
  await wait('OUTPOST', { mined: 120 });
  await page.screenshot({ path: resolve(out, 'demo-starter-complete.png'), fullPage: true });
  await click(315, 274); await wait('OUTPOST', { ore: 0, mined: 0, drill: 1, drones: 0, paused: false });
  await finish('starter');

  await start('state');
  await click(348, 134); await wait('SQUAD', { power: 85, energy: 5 });
  await click(348, 188); assert.equal((await latest('SQUAD')).power, 85, 'Over-budget recruitment is disabled');
  await click(120, 262); await wait('SQUAD', { deployed: true });
  await page.screenshot({ path: resolve(out, 'demo-state-deployed.png'), fullPage: true });
  await click(330, 262); await wait('SQUAD', { power: 35, energy: 2, deployed: false });
  await finish('state');

  await start('media');
  await click(207, 44); await wait('PIXEL_STUDIO', { selected: 1 });
  await click(68, 211); await wait('PIXEL_STUDIO', { flipped: true });
  await click(208, 211); await wait('PIXEL_STUDIO', { large: true });
  await click(347, 211); await wait('PIXEL_STUDIO', { palette: 1 });
  await click(347, 44); await wait('PIXEL_STUDIO', { selected: 2 });
  await finish('media');

  await start('physics');
  await wait('BOUNCE_STATUS', { bounces: 1 });
  const snapshot = await latest('BOUNCE_LAB');
  if (snapshot) assert(snapshot.x >= 40 && snapshot.x <= 416 && snapshot.y >= 130 && snapshot.y <= 298);
  await click(165, 70); await wait('BOUNCE_STATUS', { lowGravity: true });
  await click(55, 70);
  await click(286, 70); await wait('BOUNCE_STATUS', { paused: true });
  const frozen = await latest('BOUNCE_LAB');
  await page.waitForTimeout(1250); assert.deepEqual(await latest('BOUNCE_LAB'), frozen, 'Pause freezes the physics callback');
  await click(286, 70); await wait('BOUNCE_STATUS', { paused: false });
  await click(385, 70); await wait('BOUNCE_STATUS', { round: 1, bounces: 0 });
  await wait('BOUNCE_STATUS', { round: 1, bounces: 1 });
  await finish('physics');
  return checks;
}
